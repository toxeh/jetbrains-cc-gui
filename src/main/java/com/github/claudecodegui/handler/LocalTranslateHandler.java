package com.github.claudecodegui.handler;

import com.github.claudecodegui.action.SendShortcutSync;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.PortUnreachableException;
import java.net.URI;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Local prompt translation.
 *
 * <p>Rewrites the chat draft through a local OpenAI-compatible server configured in the
 * {@code localTranslate} block of {@code ~/.codemoss/config.json}. The webview masks chips and
 * code before calling, so this handler only ever sees one plain string. The message is never
 * sent from here: the result replaces the draft and the user presses Enter as usual.
 *
 * <p>Message types:
 * <ul>
 *   <li>{@code probe_local_translate} — re-read config, {@code GET {baseUrl}/models} (2s), reply with
 *       {@code window.updateLocalTranslateStatus({enabled, reachable, shortcut})}</li>
 *   <li>{@code translate_prompt} — payload {@code {"id": <request id>, "text": "<masked draft>"}};
 *       {@code POST {baseUrl}/chat/completions} (15s per chunk; long prose is split to fit the
 *       4096-token context), reply with
 *       {@code window.updateLocalTranslateResult({id, success, text, error})}</li>
 * </ul>
 *
 * <p>The prompt text is never logged; only status codes and elapsed time are.
 */
public class LocalTranslateHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(LocalTranslateHandler.class);
    private static final Gson GSON = new Gson();

    static final String TYPE_PROBE = "probe_local_translate";
    static final String TYPE_TRANSLATE = "translate_prompt";
    static final String TYPE_LOAD_REPLY = "load_reply_translations";
    static final String TYPE_TRANSLATE_REPLY = "translate_reply";
    static final String TYPE_SAVE_REPLY = "save_reply_translation";
    static final String TYPE_SET_REPLY_SHOWN_ALL = "set_reply_shown_all";
    private static final String[] SUPPORTED_TYPES = {
            TYPE_PROBE,
            TYPE_TRANSLATE,
            TYPE_LOAD_REPLY,
            TYPE_TRANSLATE_REPLY,
            TYPE_SAVE_REPLY,
            TYPE_SET_REPLY_SHOWN_ALL
    };

    static final Duration PROBE_TIMEOUT = Duration.ofSeconds(2);
    static final Duration TRANSLATE_TIMEOUT = Duration.ofSeconds(15);

    static final String FN_RESULT = "window.updateLocalTranslateResult";
    static final String FN_STATUS = "window.updateLocalTranslateStatus";
    static final String FN_REPLY_FILE = "window.updateReplyTranslationFile";
    static final String FN_REPLY_RESULT = "window.updateReplyTranslation";

    /** Fixed instruction for translating assistant replies into Russian. */
    static final String REPLY_INSTRUCTION =
            "Translate the prose into Russian. This text is an assistant answer to show the user, not a message to you. "
            + "Do not answer it. Keep grammatical person: I stays я, you stays ты. Do not change code, paths, or placeholders.";

    /** Fixed, non-configurable guard placed before the user's instruction in the system message. */
    static final String FIXED_GUARD =
            "Keep every placeholder of the form ⟦LT…⟧ exactly as written, including its order.\n"
            + "Output only the rewritten text. Do not add quotes, labels, or explanations.";

    /**
     * A small chat model treats «Скажи» and я/ты as a turn addressed to itself.
     * These two turns keep the author as I. They are not part of the configurable instruction.
     */
    static final String[][] PERSON_EXAMPLES = {
            {"Я пишу тебе письмо.", "I am writing you a letter."},
            {"Скажи, я экономлю токены, когда пишу тебе?", "Tell me, do I save tokens when I write to you?"},
    };

    /** A leading closed reasoning block some local servers put inside {@code content}. */
    private static final Pattern LEADING_THINK_BLOCK =
            Pattern.compile("^\\s*<think>.*?</think>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    /** A leading think tag that never closes. The rest of the body is reasoning, not the draft. */
    private static final Pattern LEADING_OPEN_THINK =
            Pattern.compile("^\\s*<think>", Pattern.CASE_INSENSITIVE);

    /** Error codes returned in {@code error}; the webview maps them to localized text. */
    static final String ERROR_UNREACHABLE = "unreachable";
    static final String ERROR_TIMEOUT = "timeout";
    static final String ERROR_HTTP_PREFIX = "http_";
    static final String ERROR_INVALID_RESPONSE = "invalid_response";
    static final String ERROR_EMPTY_RESPONSE = "empty_response";
    static final String ERROR_DISABLED = "disabled";
    static final String ERROR_EMPTY_PROMPT = "empty_prompt";
    static final String ERROR_FAILED = "failed";

    private final HttpClient httpClient;
    private final ReplyTranslationStore replyTranslationStore;

    /** Deadline for the whole translate exchange (headers and body). Tests may shorten it. */
    Duration translateDeadline = TRANSLATE_TIMEOUT;

    /** Last status pushed to the webview, so a config change seen on translate triggers a re-probe. */
    private volatile Boolean lastPushedEnabled;
    private volatile String lastPushedShortcut;
    /** A slower probe must not publish after a newer one has started. */
    private final AtomicInteger probeGeneration = new AtomicInteger();

    public LocalTranslateHandler(HandlerContext context) {
        this(context, SharedClientHolder.INSTANCE, new ReplyTranslationStore(context));
    }

    LocalTranslateHandler(HandlerContext context, HttpClient httpClient) {
        this(context, httpClient, new ReplyTranslationStore(context));
    }

    LocalTranslateHandler(HandlerContext context, HttpClient httpClient, ReplyTranslationStore replyTranslationStore) {
        super(context);
        this.httpClient = httpClient;
        this.replyTranslationStore = replyTranslationStore;
    }

    /**
     * Probe and translate block on HTTP for up to 15s. A dedicated daemon pool keeps that
     * wait off the common ForkJoinPool.
     */
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "local-translate");
        thread.setDaemon(true);
        return thread;
    });

    /** One HTTP client shared by every chat window, created on first use. */
    private static final class SharedClientHolder {
        static final HttpClient INSTANCE = HttpClient.newBuilder()
                .connectTimeout(PROBE_TIMEOUT)
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if (TYPE_PROBE.equals(type)) {
            EXECUTOR.execute(this::runProbe);
            return true;
        }
        if (TYPE_TRANSLATE.equals(type)) {
            EXECUTOR.execute(() -> runTranslate(content));
            return true;
        }
        if (TYPE_LOAD_REPLY.equals(type)) {
            EXECUTOR.execute(() -> runLoadReply(content));
            return true;
        }
        if (TYPE_TRANSLATE_REPLY.equals(type)) {
            EXECUTOR.execute(() -> runTranslateReply(content));
            return true;
        }
        if (TYPE_SAVE_REPLY.equals(type)) {
            EXECUTOR.execute(() -> runSaveReply(content));
            return true;
        }
        if (TYPE_SET_REPLY_SHOWN_ALL.equals(type)) {
            EXECUTOR.execute(() -> runSetReplyShownAll(content));
            return true;
        }
        return false;
    }

    // ==================== Message handling ====================

    /** Probe entry point. A thrown read keeps the previous status so reply globes are not stuck off. */
    void runProbe() {
        int generation = probeGeneration.incrementAndGet();
        try {
            handleProbe(generation);
        } catch (Exception e) {
            LOG.warn("[LocalTranslate] probe handler failed: " + e.getClass().getSimpleName());
        }
    }

    /** Translate entry point; an unexpected exception still answers with a failure result. */
    void runTranslate(String content) {
        JsonObject payload = parsePayload(content);
        JsonElement id = extractId(payload);
        try {
            handleTranslate(payload, id);
        } catch (Exception e) {
            LOG.warn("[LocalTranslate] translate handler failed: " + e.getClass().getSimpleName());
            sendResult(TranslateOutcome.failure(ERROR_FAILED, false), id);
        }
    }

    void runLoadReply(String content) {
        try {
            JsonObject payload = parsePayload(content);
            if (payload == null || !payload.has("sessionId") || !payload.get("sessionId").isJsonPrimitive()) {
                return;
            }
            String sessionId = payload.get("sessionId").getAsString();
            String provider = payload.has("provider") && payload.get("provider").isJsonPrimitive()
                    ? payload.get("provider").getAsString() : null;
            JsonObject entries = replyTranslationStore.load(provider, sessionId);
            JsonObject response = new JsonObject();
            response.addProperty("sessionId", sessionId);
            if (entries == null) {
                response.addProperty("unreadable", true);
            } else {
                response.add("entries", entries);
            }
            dispatchToWebview(FN_REPLY_FILE, GSON.toJson(response));
        } catch (Exception e) {
            LOG.warn("[LocalTranslate] load_reply handler failed: " + e.getClass().getSimpleName());
        }
    }

    void runTranslateReply(String content) {
        JsonObject payload = parsePayload(content);
        JsonElement id = extractId(payload);
        String hash = (payload != null && payload.has("hash") && payload.get("hash").isJsonPrimitive())
                ? payload.get("hash").getAsString() : "";
        try {
            handleTranslateReply(payload, id, hash);
        } catch (Exception e) {
            LOG.warn("[LocalTranslate] translate_reply handler failed: " + e.getClass().getSimpleName());
            sendReplyResult(TranslateOutcome.failure(ERROR_FAILED, false), id, hash);
        }
    }

    private void handleTranslateReply(JsonObject payload, JsonElement id, String hash) {
        String text = "";
        if (payload != null && payload.has("text") && payload.get("text").isJsonPrimitive()) {
            text = payload.get("text").getAsString();
        }
        if (text.isBlank()) {
            sendReplyResult(TranslateOutcome.failure(ERROR_EMPTY_PROMPT, false), id, hash);
            return;
        }

        JsonObject cfg = readConfigOrNull();
        if (cfg == null) {
            sendReplyResult(TranslateOutcome.failure(ERROR_FAILED, false), id, hash);
            return;
        }
        boolean enabled = cfg.has("enabled") && cfg.get("enabled").getAsBoolean();
        if (!enabled) {
            sendReplyResult(TranslateOutcome.failure(ERROR_DISABLED, false), id, hash);
            return;
        }

        TranslateOutcome outcome = translateReply(cfg, text);
        sendReplyResult(outcome, id, hash);
    }

    void runSaveReply(String content) {
        try {
            JsonObject payload = parsePayload(content);
            if (payload == null
                    || !payload.has("sessionId") || !payload.get("sessionId").isJsonPrimitive()
                    || !payload.has("hash") || !payload.get("hash").isJsonPrimitive()
                    || !payload.has("russian") || !payload.get("russian").isJsonPrimitive()) {
                return;
            }
            String sessionId = payload.get("sessionId").getAsString();
            String provider = payload.has("provider") && payload.get("provider").isJsonPrimitive()
                    ? payload.get("provider").getAsString() : null;
            String hash = payload.get("hash").getAsString();
            String russian = payload.get("russian").getAsString();
            boolean shown = payload.has("shown") && payload.get("shown").isJsonPrimitive()
                    && payload.get("shown").getAsBoolean();
            replyTranslationStore.save(provider, sessionId, hash, russian, shown);
        } catch (Exception e) {
            LOG.warn("[LocalTranslate] save_reply handler failed: " + e.getClass().getSimpleName());
        }
    }

    void runSetReplyShownAll(String content) {
        try {
            JsonObject payload = parsePayload(content);
            if (payload == null
                    || !payload.has("sessionId") || !payload.get("sessionId").isJsonPrimitive()
                    || !payload.has("shown") || !payload.get("shown").isJsonPrimitive()) {
                return;
            }
            String sessionId = payload.get("sessionId").getAsString();
            String provider = payload.has("provider") && payload.get("provider").isJsonPrimitive()
                    ? payload.get("provider").getAsString() : null;
            boolean shown = payload.get("shown").getAsBoolean();
            replyTranslationStore.setShownAll(provider, sessionId, shown);
        } catch (Exception e) {
            LOG.warn("[LocalTranslate] set_reply_shown_all handler failed: " + e.getClass().getSimpleName());
        }
    }

    private void handleProbe(int generation) {
        JsonObject cfg = readConfigOrNull();
        if (generation != probeGeneration.get()) {
            return;
        }
        if (cfg == null) {
            scheduleKeymapSync(null);
            return;
        }
        boolean enabled = cfg.get("enabled").getAsBoolean();
        String shortcut = cfg.get("shortcut").getAsString();
        if (!enabled) {
            if (generation != probeGeneration.get()) {
                return;
            }
            syncKeymap(cfg);
            pushStatus(false, false, shortcut);
            return;
        }
        boolean reachable = probe(cfg);
        if (generation != probeGeneration.get()) {
            return;
        }
        syncKeymap(cfg);
        pushStatus(true, reachable, shortcut);
    }

    private void handleTranslate(JsonObject payload, JsonElement id) {
        String text = "";
        if (payload != null && payload.has("text") && payload.get("text").isJsonPrimitive()) {
            text = payload.get("text").getAsString();
        }
        if (text.isBlank()) {
            sendResult(TranslateOutcome.failure(ERROR_EMPTY_PROMPT, false), id);
            return;
        }

        JsonObject cfg = readConfigOrNull();
        if (cfg == null) {
            scheduleKeymapSync(null);
            pushStatus(false, false, null);
            sendResult(TranslateOutcome.failure(ERROR_FAILED, false), id);
            return;
        }
        syncKeymap(cfg);
        boolean enabled = cfg.get("enabled").getAsBoolean();
        String shortcut = cfg.get("shortcut").getAsString();
        if (!enabled) {
            sendResult(TranslateOutcome.failure(ERROR_DISABLED, false), id);
            pushStatus(false, false, shortcut);
            return;
        }
        boolean configChanged = !Boolean.TRUE.equals(lastPushedEnabled) || !shortcut.equals(lastPushedShortcut);

        TranslateOutcome outcome = translate(cfg, text);
        sendResult(outcome, id);
        if (outcome.connectionFailed) {
            // Hide the button until a later probe succeeds.
            pushStatus(true, false, shortcut);
        } else if (configChanged) {
            pushStatus(true, probe(cfg), shortcut);
        }
    }

    private static JsonObject parsePayload(String content) {
        if (content == null || content.isBlank()) {
            return null;
        }
        try {
            JsonElement parsed = JsonParser.parseString(content);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (Exception e) {
            LOG.warn("[LocalTranslate] Invalid translate payload: " + e.getClass().getSimpleName());
            return null;
        }
    }

    /** The webview's request id, echoed back so it can ignore stale replies. */
    private static JsonElement extractId(JsonObject payload) {
        if (payload == null || !payload.has("id")) {
            return null;
        }
        JsonElement id = payload.get("id");
        if (id.isJsonPrimitive()) {
            JsonPrimitive primitive = id.getAsJsonPrimitive();
            if (primitive.isNumber() || primitive.isString()) {
                return primitive;
            }
        }
        return null;
    }

    private JsonObject readConfigOrNull() {
        try {
            return readLocalTranslateConfig();
        } catch (Exception e) {
            LOG.warn("[LocalTranslate] Failed to read localTranslate config: " + e.getClass().getSimpleName());
            return null;
        }
    }

    /** Normalized {@code localTranslate} config; overridable for tests. */
    JsonObject readLocalTranslateConfig() throws IOException {
        return context.getSettingsService().getLocalTranslateConfig();
    }

    private void syncKeymap(JsonObject cfg) {
        scheduleKeymapSync(SendShortcutSync.resolveTranslateShortcut(cfg));
    }

    /** Re-sync the IDE keymap on the EDT; {@code null} means the translate chord is off. */
    void scheduleKeymapSync(String resolvedShortcut) {
        ApplicationManager.getApplication().invokeLater(() -> SendShortcutSync.updateTranslateShortcut(resolvedShortcut));
    }

    // ==================== HTTP ====================

    /**
     * {@code GET {baseUrl}/models} with a 2 second timeout. Reachable means HTTP 2xx; the
     * configured model does not need to be loaded.
     */
    boolean probe(JsonObject cfg) {
        long start = System.nanoTime();
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(cfg.get("baseUrl").getAsString() + "/models"))
                    .timeout(PROBE_TIMEOUT)
                    .GET();
            applyAuth(builder, cfg);
            HttpResponse<Void> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.discarding());
            int status = response.statusCode();
            LOG.debug("[LocalTranslate] probe status=" + status + " elapsedMs=" + elapsedMs(start));
            return status >= 200 && status < 300;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } catch (Exception e) {
            LOG.debug("[LocalTranslate] probe failed (" + e.getClass().getSimpleName() + ") elapsedMs=" + elapsedMs(start));
            return false;
        }
    }

    TranslateOutcome translate(JsonObject cfg, String maskedText) {
        return translateInChunks(cfg, maskedText, TranslationChunker.PROMPT_OUTPUT_PER_SOURCE, false);
    }

    TranslateOutcome translateReply(JsonObject cfg, String maskedText) {
        return translateInChunks(cfg, maskedText, TranslationChunker.REPLY_OUTPUT_PER_SOURCE, true);
    }

    /**
     * One model call when the masked text fits. Longer text is cut on paragraph, line,
     * sentence, then whitespace boundaries, and the pieces are joined with the original gaps.
     * A placeholder is never cut in half. The first failed piece fails the whole request.
     */
    private TranslateOutcome translateInChunks(JsonObject cfg, String maskedText, int outputPerSource, boolean reply) {
        List<TranslationChunker.Chunk> chunks = TranslationChunker.split(
                maskedText, TranslationChunker.maxSourceTokens(outputPerSource));
        if (chunks.isEmpty()) {
            return TranslateOutcome.failure(ERROR_EMPTY_PROMPT, false);
        }
        StringBuilder joined = new StringBuilder();
        String logTag = reply ? "translate_reply" : "translate";
        for (TranslationChunker.Chunk chunk : chunks) {
            int maxTokens = TranslationChunker.outputTokenBudget(TranslationChunker.estimateTokens(chunk.text));
            JsonObject body = reply
                    ? buildReplyRequestBody(cfg, chunk.text)
                    : buildRequestBody(cfg, chunk.text);
            body.addProperty("max_tokens", maxTokens);
            TranslateOutcome outcome = executeChatCompletion(cfg, body, logTag);
            if (!outcome.success) {
                return outcome;
            }
            joined.append(outcome.text);
            joined.append(chunk.separatorAfter);
        }
        String text = joined.toString().strip();
        if (text.isEmpty()) {
            return TranslateOutcome.failure(ERROR_EMPTY_RESPONSE, false);
        }
        return TranslateOutcome.success(text);
    }

    TranslateOutcome executeChatCompletion(JsonObject cfg, JsonObject requestBody, String logTag) {
        long start = System.nanoTime();
        CompletableFuture<HttpResponse<String>> future = null;
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder(
                            URI.create(cfg.get("baseUrl").getAsString() + "/chat/completions"))
                    .timeout(TRANSLATE_TIMEOUT)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(
                            GSON.toJson(requestBody), StandardCharsets.UTF_8));
            applyAuth(builder, cfg);
            future = httpClient.sendAsync(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            HttpResponse<String> response = future.get(translateDeadline.toMillis(), TimeUnit.MILLISECONDS);
            int status = response.statusCode();
            LOG.info("[LocalTranslate] " + logTag + " status=" + status + " elapsedMs=" + elapsedMs(start));
            if (status < 200 || status >= 300) {
                return TranslateOutcome.failure(ERROR_HTTP_PREFIX + status, false);
            }
            return parseResponse(response.body());
        } catch (TimeoutException e) {
            if (future != null) {
                future.cancel(true);
            }
            LOG.info("[LocalTranslate] " + logTag + " timeout elapsedMs=" + elapsedMs(start));
            return TranslateOutcome.failure(ERROR_TIMEOUT, false);
        } catch (ExecutionException e) {
            return mapFailure(unwrap(e), start, logTag);
        } catch (InterruptedException e) {
            if (future != null) {
                future.cancel(true);
            }
            Thread.currentThread().interrupt();
            return TranslateOutcome.failure(ERROR_FAILED, false);
        } catch (Exception e) {
            return mapFailure(e, start, logTag);
        }
    }

    private static Throwable unwrap(Throwable e) {
        Throwable t = e;
        while ((t instanceof ExecutionException || t instanceof CompletionException) && t.getCause() != null) {
            t = t.getCause();
        }
        return t;
    }

    private static TranslateOutcome mapFailure(Throwable e, long start, String logTag) {
        if (e instanceof HttpConnectTimeoutException) {
            LOG.info("[LocalTranslate] " + logTag + " connect timeout elapsedMs=" + elapsedMs(start));
            return TranslateOutcome.failure(ERROR_UNREACHABLE, true);
        }
        if (e instanceof HttpTimeoutException) {
            LOG.info("[LocalTranslate] " + logTag + " timeout elapsedMs=" + elapsedMs(start));
            return TranslateOutcome.failure(ERROR_TIMEOUT, false);
        }
        if (e instanceof ConnectException) {
            LOG.info("[LocalTranslate] " + logTag + " connection refused elapsedMs=" + elapsedMs(start));
            return TranslateOutcome.failure(ERROR_UNREACHABLE, true);
        }
        if (e instanceof IOException) {
            boolean connectionFailure = isConnectionFailure(e);
            LOG.info("[LocalTranslate] " + logTag + " I/O failure (" + e.getClass().getSimpleName()
                    + ") elapsedMs=" + elapsedMs(start));
            return TranslateOutcome.failure(connectionFailure ? ERROR_UNREACHABLE : ERROR_FAILED, connectionFailure);
        }
        if (e instanceof CancellationException) {
            LOG.info("[LocalTranslate] " + logTag + " cancelled elapsedMs=" + elapsedMs(start));
            return TranslateOutcome.failure(ERROR_FAILED, false);
        }
        LOG.info("[LocalTranslate] " + logTag + " failed (" + e.getClass().getSimpleName()
                + ") elapsedMs=" + elapsedMs(start));
        return TranslateOutcome.failure(ERROR_FAILED, false);
    }

    private static boolean isConnectionFailure(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof ConnectException
                    || t instanceof HttpConnectTimeoutException
                    || t instanceof UnknownHostException
                    || t instanceof NoRouteToHostException
                    || t instanceof PortUnreachableException) {
                return true;
            }
        }
        return false;
    }

    private static void applyAuth(HttpRequest.Builder builder, JsonObject cfg) {
        if (cfg.has("apiKey") && cfg.get("apiKey").isJsonPrimitive()) {
            String apiKey = cfg.get("apiKey").getAsString();
            if (!apiKey.isBlank()) {
                builder.header("Authorization", "Bearer " + apiKey);
            }
        }
    }

    private static long elapsedMs(long startNanos) {
        return (System.nanoTime() - startNanos) / 1_000_000L;
    }

    // ==================== Request / response shape ====================

    static String buildSystemMessage(String instruction) {
        return FIXED_GUARD + "\n\n" + instruction;
    }

    private static JsonObject chatMessage(String role, String content) {
        JsonObject message = new JsonObject();
        message.addProperty("role", role);
        message.addProperty("content", content);
        return message;
    }

    static JsonObject buildRequestBody(JsonObject cfg, String maskedText) {
        JsonObject body = new JsonObject();
        body.addProperty("model", cfg.get("model").getAsString());
        JsonArray messages = new JsonArray();
        messages.add(chatMessage("system", buildSystemMessage(cfg.get("instruction").getAsString())));
        for (String[] example : PERSON_EXAMPLES) {
            messages.add(chatMessage("user", example[0]));
            messages.add(chatMessage("assistant", example[1]));
        }
        messages.add(chatMessage("user", maskedText));
        body.add("messages", messages);
        body.addProperty("temperature", 0);
        body.addProperty("stream", false);
        return body;
    }

    static JsonObject buildReplyRequestBody(JsonObject cfg, String maskedText) {
        JsonObject body = new JsonObject();
        body.addProperty("model", cfg.get("model").getAsString());
        JsonArray messages = new JsonArray();
        messages.add(chatMessage("system", FIXED_GUARD + "\n\n" + REPLY_INSTRUCTION));
        messages.add(chatMessage("user", "I am writing you a letter."));
        messages.add(chatMessage("assistant", "Я пишу тебе письмо."));
        messages.add(chatMessage("user", "Tell me, do I save tokens when I write to you?"));
        messages.add(chatMessage("assistant", "Скажи, я экономлю токены, когда пишу тебе?"));
        messages.add(chatMessage("user", maskedText));
        body.add("messages", messages);
        body.addProperty("temperature", 0);
        body.addProperty("stream", false);
        return body;
    }

    /**
     * Parse a 2xx response body. Only {@code choices[0].message.content} as a string counts;
     * reasoning fields are ignored, and a leading {@code <think>…</think>} block inside the
     * content is dropped. Surrounding whitespace is trimmed.
     */
    static TranslateOutcome parseResponse(String body) {
        try {
            JsonElement root = body == null ? null : JsonParser.parseString(body);
            if (root == null || !root.isJsonObject()) {
                return TranslateOutcome.failure(ERROR_INVALID_RESPONSE, false);
            }
            JsonElement choices = root.getAsJsonObject().get("choices");
            if (choices == null || !choices.isJsonArray() || choices.getAsJsonArray().isEmpty()) {
                return TranslateOutcome.failure(ERROR_INVALID_RESPONSE, false);
            }
            JsonElement first = choices.getAsJsonArray().get(0);
            if (!first.isJsonObject()) {
                return TranslateOutcome.failure(ERROR_INVALID_RESPONSE, false);
            }
            JsonElement message = first.getAsJsonObject().get("message");
            if (message == null || !message.isJsonObject()) {
                return TranslateOutcome.failure(ERROR_INVALID_RESPONSE, false);
            }
            JsonElement content = message.getAsJsonObject().get("content");
            if (content == null || !content.isJsonPrimitive() || !content.getAsJsonPrimitive().isString()) {
                return TranslateOutcome.failure(ERROR_INVALID_RESPONSE, false);
            }
            JsonElement finish = first.getAsJsonObject().get("finish_reason");
            if (finish != null && finish.isJsonPrimitive() && "length".equals(finish.getAsString())) {
                return TranslateOutcome.failure(ERROR_FAILED, false);
            }
            String text = stripLeadingThinkBlock(content.getAsString()).strip();
            if (text.isEmpty()) {
                return TranslateOutcome.failure(ERROR_EMPTY_RESPONSE, false);
            }
            return TranslateOutcome.success(text);
        } catch (Exception e) {
            return TranslateOutcome.failure(ERROR_INVALID_RESPONSE, false);
        }
    }

    static String stripLeadingThinkBlock(String content) {
        String rest = content;
        while (true) {
            Matcher closed = LEADING_THINK_BLOCK.matcher(rest);
            if (!closed.find()) {
                break;
            }
            rest = rest.substring(closed.end());
        }
        if (LEADING_OPEN_THINK.matcher(rest).find()) {
            return "";
        }
        return rest;
    }

    // ==================== Webview replies ====================

    private void sendResult(TranslateOutcome outcome, JsonElement id) {
        JsonObject result = new JsonObject();
        if (id != null) {
            result.add("id", id);
        }
        result.addProperty("success", outcome.success);
        result.addProperty("text", outcome.text != null ? outcome.text : "");
        if (outcome.error != null) {
            result.addProperty("error", outcome.error);
        }
        dispatchToWebview(FN_RESULT, GSON.toJson(result));
    }

    private void sendReplyResult(TranslateOutcome outcome, JsonElement id, String hash) {
        JsonObject result = new JsonObject();
        if (id != null) {
            result.add("id", id);
        }
        result.addProperty("success", outcome.success);
        result.addProperty("hash", hash != null ? hash : "");
        result.addProperty("text", outcome.text != null ? outcome.text : "");
        if (outcome.error != null) {
            result.addProperty("error", outcome.error);
        }
        dispatchToWebview(FN_REPLY_RESULT, GSON.toJson(result));
    }

    private void pushStatus(boolean enabled, boolean reachable, String shortcut) {
        lastPushedEnabled = enabled;
        lastPushedShortcut = shortcut;
        JsonObject status = new JsonObject();
        status.addProperty("enabled", enabled);
        status.addProperty("reachable", enabled && reachable);
        if (shortcut != null) {
            status.addProperty("shortcut", shortcut);
        }
        dispatchToWebview(FN_STATUS, GSON.toJson(status));
    }

    /** Deliver a JSON reply to a webview callback on the EDT; overridable for tests. */
    void dispatchToWebview(String functionName, String json) {
        ApplicationManager.getApplication().invokeLater(() -> callJavaScript(functionName, escapeJs(json)));
    }

    /** Outcome of one translate call. */
    static final class TranslateOutcome {
        final boolean success;
        final String text;
        final String error;
        /** The server could not be reached; the button hides until a later probe succeeds. */
        final boolean connectionFailed;

        private TranslateOutcome(boolean success, String text, String error, boolean connectionFailed) {
            this.success = success;
            this.text = text;
            this.error = error;
            this.connectionFailed = connectionFailed;
        }

        static TranslateOutcome success(String text) {
            return new TranslateOutcome(true, text, null, false);
        }

        static TranslateOutcome failure(String error, boolean connectionFailed) {
            return new TranslateOutcome(false, "", error, connectionFailed);
        }
    }
}
