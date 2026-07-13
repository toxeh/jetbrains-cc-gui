package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Grok SDK bridge (Claude-template architecture).
 *
 * Java contract mirrors {@code ClaudeSDKBridge} send shape:
 * session/epoch/cwd/attachments/permissionMode/model/openedFiles/agentPrompt/streaming/reasoning.
 *
 * Node transport is ACP primary ({@code grok agent stdio}) which emits Claude-compatible tags.
 */
public class GrokSDKBridge extends BaseSDKBridge {

    private String baseUrl = null;
    private String apiKey = null;
    private final CodemossSettingsService settingsService = new CodemossSettingsService();

    private final GrokDaemonCoordinator daemonCoordinator;
    private final GrokDaemonRequestExecutor daemonRequestExecutor;

    public GrokSDKBridge() {
        super(GrokSDKBridge.class);

        this.daemonCoordinator = new GrokDaemonCoordinator(
                LOG,
                nodeDetector,
                this::getDirectoryResolver,
                envConfigurator
        );
        this.daemonRequestExecutor = new GrokDaemonRequestExecutor(LOG, this);
    }

    // ============================================================================
    // Abstract method implementations
    // ============================================================================

    @Override
    protected String getProviderName() {
        return "grok";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("GROK_USE_STDIN", "true");
        env.put("GROK_NO_AUTO_UPDATE", "1");
        env.put("CI", "1");

        String authMethod = resolveAuthMethod();
        env.put("GROK_AUTH_METHOD", authMethod);

        // OAuth mode must not inherit a team API key from the host environment —
        // that forces Grok CLI onto xai.api_key and yields 403 "no credits".
        if (CodemossSettingsService.GROK_AUTH_METHOD_OAUTH.equals(authMethod)) {
            env.remove("XAI_API_KEY");
            env.remove("GROK_API_KEY");
        } else {
            String effectiveKey = resolveApiKeyForAuth(authMethod);
            if (effectiveKey != null && !effectiveKey.isEmpty()) {
                env.put("XAI_API_KEY", effectiveKey);
                env.put("GROK_API_KEY", effectiveKey);
            } else {
                env.remove("XAI_API_KEY");
                env.remove("GROK_API_KEY");
            }
        }

        String effectiveBase = resolveEffectiveBaseUrl(authMethod);
        applyBaseUrlEnv(env, authMethod, effectiveBase);
    }

    /**
     * Apply gateway / direct base URL env vars for the given auth method.
     * Empty base leaves defaults (direct xAI / cli-chat-proxy).
     */
    private void applyBaseUrlEnv(Map<String, String> env, String authMethod, String effectiveBase) {
        if (effectiveBase == null || effectiveBase.isEmpty()) {
            return;
        }
        if (CodemossSettingsService.GROK_AUTH_METHOD_API_KEY.equals(authMethod)) {
            env.put("XAI_API_BASE_URL", effectiveBase);
            env.put("GROK_BASE_URL", effectiveBase);
            // Do not point OAuth chat proxy at /xai/v1
            env.remove("GROK_CLI_CHAT_PROXY_BASE_URL");
        } else if (CodemossSettingsService.GROK_AUTH_METHOD_OAUTH.equals(authMethod)) {
            env.put("GROK_CLI_CHAT_PROXY_BASE_URL", effectiveBase);
            env.put("GROK_BASE_URL", effectiveBase);
            // Avoid forcing API base onto xai path when using SuperGrok OAuth
            env.remove("XAI_API_BASE_URL");
        } else {
            // auto: set both so whichever auth path the CLI picks works
            env.put("GROK_BASE_URL", effectiveBase);
            env.put("XAI_API_BASE_URL", effectiveBase);
            env.put("GROK_CLI_CHAT_PROXY_BASE_URL", effectiveBase);
        }
    }

    private String resolveEffectiveBaseUrl(String authMethod) {
        try {
            return settingsService.resolveGrokBaseUrlForAuth(authMethod, this.baseUrl);
        } catch (Exception e) {
            LOG.warn("[Grok] Failed to resolve base URL: " + e.getMessage());
            return this.baseUrl != null ? this.baseUrl : "";
        }
    }

    private String resolveAuthMethod() {
        try {
            return settingsService.getGrokAuthMethod();
        } catch (Exception e) {
            LOG.warn("[Grok] Failed to read grok.authMethod, defaulting to oauth: " + e.getMessage());
            return CodemossSettingsService.DEFAULT_GROK_AUTH_METHOD;
        }
    }

    private String resolveApiKeyForAuth(String authMethod) {
        // Explicit bridge key wins when set by host
        if (apiKey != null && !apiKey.isEmpty()) {
            return apiKey;
        }
        try {
            String stored = settingsService.getGrokApiKey();
            if (stored != null && !stored.isEmpty()) {
                return stored;
            }
        } catch (Exception e) {
            LOG.debug("[Grok] Failed to read stored grok.apiKey: " + e.getMessage());
        }
        if (CodemossSettingsService.GROK_AUTH_METHOD_API_KEY.equals(authMethod)
                || CodemossSettingsService.GROK_AUTH_METHOD_AUTO.equals(authMethod)) {
            String envKey = System.getenv("XAI_API_KEY");
            if (envKey == null || envKey.isEmpty()) {
                envKey = System.getenv("GROK_API_KEY");
            }
            return envKey;
        }
        return null;
    }

    @Override
    protected void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError
    ) {
        if (line.contains("[DEBUG]") || line.startsWith("[GROK-ACP]") || line.startsWith("[DIAG-")) {
            LOG.debug("[Grok] " + line);
            return;
        }

        if (line.startsWith("[STDIN_ERROR]")
                || line.startsWith("[STDIN_PARSE_ERROR]")
                || line.startsWith("[COMMAND_ERROR]")
                || line.startsWith("[UNCAUGHT_ERROR]")
                || line.startsWith("[UNHANDLED_REJECTION]")) {
            lastNodeError.set(line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
            return;
        }
        if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
            return;
        }
        if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
            return;
        }
        if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
            return;
        }
        if (line.startsWith("[BLOCK_RESET]")) {
            callback.onMessage("block_reset", "");
            return;
        }
        if (line.startsWith("[SESSION_ID]")) {
            String id = line.substring("[SESSION_ID]".length()).trim();
            if (!id.isEmpty()) {
                callback.onMessage("session_id", id);
            }
            return;
        }
        if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    result.messages.add(msg);
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "assistant";
                    callback.onMessage(msgType, jsonStr);

                    if ("assistant".equals(msgType)) {
                        String text = extractAssistantText(msg);
                        if (text != null && !text.isEmpty() && assistantContent.indexOf(text) < 0) {
                            // Prefer full message text when longer than deltas
                            if (text.length() >= assistantContent.length()) {
                                assistantContent.setLength(0);
                                assistantContent.append(text);
                            }
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            return;
        }
        if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
            return;
        }
        if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            assistantContent.append(content);
            callback.onMessage("content", content);
            return;
        }
        if (line.startsWith("[THINKING_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", delta);
            return;
        }
        if (line.startsWith("[THINKING]")) {
            callback.onMessage("thinking", line.substring("[THINKING]".length()).trim());
            return;
        }
        if (line.startsWith("[TOOL_RESULT]")) {
            callback.onMessage("tool_result", line.substring("[TOOL_RESULT]".length()).trim());
            return;
        }
        if (line.startsWith("[USAGE]")) {
            callback.onMessage("usage", line.substring("[USAGE]".length()).trim());
            return;
        }
        if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj != null && obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
            return;
        }

        // Final JSON result line from Node (success envelope)
        if (line.startsWith("{") && line.contains("\"success\"")) {
            try {
                JsonObject obj = gson.fromJson(line, JsonObject.class);
                if (obj != null && obj.has("success") && !obj.get("success").getAsBoolean()) {
                    String err = obj.has("error") ? obj.get("error").getAsString() : line;
                    hadSendError.set(true);
                    result.success = false;
                    result.error = err;
                    callback.onError(err);
                } else if (obj != null && obj.has("sessionId") && !obj.get("sessionId").isJsonNull()) {
                    String sid = obj.get("sessionId").getAsString();
                    if (sid != null && !sid.isEmpty()) {
                        callback.onMessage("session_id", sid);
                    }
                }
            } catch (Exception ignored) {
            }
        }
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            String decoded = gson.fromJson(jsonStr, String.class);
            return decoded != null ? decoded : "";
        } catch (Exception e) {
            return jsonStr;
        }
    }

    private String extractAssistantText(JsonObject msg) {
        if (msg == null || !msg.has("message")) {
            return null;
        }
        try {
            JsonObject message = msg.getAsJsonObject("message");
            if (message == null || !message.has("content")) {
                return null;
            }
            com.google.gson.JsonElement contentEl = message.get("content");
            if (contentEl.isJsonArray()) {
                StringBuilder sb = new StringBuilder();
                for (com.google.gson.JsonElement el : contentEl.getAsJsonArray()) {
                    if (el.isJsonObject()) {
                        JsonObject block = el.getAsJsonObject();
                        if (block.has("text")) {
                            sb.append(block.get("text").getAsString());
                        }
                    }
                }
                return sb.toString();
            } else if (contentEl.isJsonPrimitive()) {
                return contentEl.getAsString();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    // ============================================================================
    // Grok-specific configuration
    // ============================================================================

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public String getBaseUrl() {
        return this.baseUrl;
    }

    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    public String getApiKey() {
        return this.apiKey;
    }

    // ============================================================================
    // Daemon lifecycle (parity with Claude)
    // ============================================================================

    public void addDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        this.daemonCoordinator.addDaemonEventListener(listener);
    }

    public void removeDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        this.daemonCoordinator.removeDaemonEventListener(listener);
    }

    public void shutdownDaemon() {
        daemonCoordinator.shutdownDaemon();
    }

    public DaemonBridge getCurrentDaemonBridgeForInspection() {
        return daemonCoordinator.getCurrentDaemonBridge();
    }

    public void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch) {
        daemonCoordinator.prewarmDaemonAsync(cwd, runtimeSessionEpoch);
    }

    public void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch, String sessionId) {
        daemonCoordinator.prewarmDaemonAsync(cwd, runtimeSessionEpoch, sessionId);
    }

    public void resetPersistentRuntime(String runtimeSessionEpoch) {
        daemonCoordinator.resetPersistentRuntime(runtimeSessionEpoch);
    }

    /**
     * Push permission mode change live to the current Grok runtime (if any).
     * Mirrors Claude's setPermissionModeLive for hot-swap mid-turn.
     */
    public CompletableFuture<JsonObject> setPermissionModeLive(
            String sessionId, String runtimeSessionEpoch, String permissionMode) {
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db == null || !db.isAlive()) {
            JsonObject skipped = new JsonObject();
            skipped.addProperty("success", true);
            skipped.addProperty("applied", false);
            skipped.addProperty("reason", "no-daemon");
            return CompletableFuture.completedFuture(skipped);
        }

        JsonObject params = new JsonObject();
        if (sessionId != null && !sessionId.isEmpty()) {
            params.addProperty("sessionId", sessionId);
        }
        if (runtimeSessionEpoch != null && !runtimeSessionEpoch.isEmpty()) {
            params.addProperty("runtimeSessionEpoch", runtimeSessionEpoch);
        }
        params.addProperty("permissionMode", permissionMode != null ? permissionMode : "");

        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) { }

            @Override
            public void onStderr(String text) {
                if (text != null && !text.isBlank()) {
                    LOG.debug("[GrokSDKBridge] setPermissionModeLive stderr: " + text);
                }
            }

            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", error);
                    resultFuture.complete(err);
                }
            }

            @Override
            public void onComplete(boolean success) {
                if (!resultFuture.isDone()) {
                    JsonObject ok = new JsonObject();
                    ok.addProperty("success", success);
                    resultFuture.complete(ok);
                }
            }
        };

        try {
            CompletableFuture<Boolean> commandFuture = db.sendCommand("grok.setPermissionMode", params, callback);
            commandFuture.exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", ex.getMessage());
                    resultFuture.complete(err);
                }
                return false;
            });
        } catch (Exception e) {
            LOG.error("[GrokSDKBridge] setPermissionModeLive failed: " + e.getMessage(), e);
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", e.getMessage());
            return CompletableFuture.completedFuture(err);
        }

        return resultFuture.orTimeout(10, TimeUnit.SECONDS).exceptionally(ex -> {
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", "setPermissionMode timed out after 10 seconds");
            return err;
        });
    }

    /**
     * Get context window usage breakdown for Grok.
     * In persistent mode, delegates to the daemon which synthesizes basic usage
     * from last prompt usage + model context limit (Grok ACP does not provide
     * the rich category breakdown that Claude does).
     * NOTE: "correct" way to compute current context size for Grok persistent agent is unclear
     * (last input_tokens is used as proxy for context fed).
     */
    public CompletableFuture<JsonObject> getContextUsage(String sessionId, String cwd, String model) {
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db == null || !db.isAlive()) {
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", "Daemon not available. Grok context usage requires persistent daemon mode.");
            return CompletableFuture.completedFuture(error);
        }

        JsonObject params = new JsonObject();
        if (sessionId != null && !sessionId.isEmpty()) {
            params.addProperty("sessionId", sessionId);
        }
        if (cwd != null && !cwd.isEmpty()) {
            params.addProperty("cwd", cwd);
        }
        if (model != null && !model.isEmpty()) {
            params.addProperty("model", model);
        }

        AtomicReference<JsonObject> resultRef = new AtomicReference<>();
        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                try {
                    JsonObject parsed = GrokSDKBridge.this.gson.fromJson(line, JsonObject.class);
                    if (parsed != null) {
                        resultRef.set(parsed);
                    }
                } catch (Exception ignored) {
                }
            }
            @Override
            public void onStderr(String text) { }
            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", error);
                    resultFuture.complete(err);
                }
            }
            @Override
            public void onComplete(boolean success) {
                if (!resultFuture.isDone()) {
                    if (success) {
                        JsonObject result = resultRef.get();
                        if (result != null) {
                            resultFuture.complete(result);
                        } else {
                            JsonObject err = new JsonObject();
                            err.addProperty("success", false);
                            err.addProperty("error", "No response received for Grok getContextUsage");
                            resultFuture.complete(err);
                        }
                    } else {
                        JsonObject err = new JsonObject();
                        err.addProperty("success", false);
                        err.addProperty("error", "grok.getContextUsage command failed");
                        resultFuture.complete(err);
                    }
                }
            }
        };

        try {
            CompletableFuture<Boolean> commandFuture = db.sendCommand("grok.getContextUsage", params, callback);
            commandFuture.exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", ex.getMessage());
                    resultFuture.complete(err);
                }
                return false;
            });
        } catch (Exception e) {
            LOG.error("[GrokSDKBridge] getContextUsage failed: " + e.getMessage(), e);
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", e.getMessage());
            return CompletableFuture.completedFuture(err);
        }

        return resultFuture.orTimeout(60, TimeUnit.SECONDS).exceptionally(ex -> {
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", "Grok getContextUsage timed out after 60 seconds");
            return err;
        });
    }

    /**
     * Get current Grok billing/usage information (credits, weekly limit, reset time).
     * Delegates to daemon which runs `grok /usage` CLI command.
     * Returns {success, output} where output is the human-readable text from the CLI.
     */
    public CompletableFuture<JsonObject> getUsage(String cwd) {
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db == null || !db.isAlive()) {
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", "Daemon not available. Grok usage requires persistent daemon mode.");
            return CompletableFuture.completedFuture(error);
        }

        JsonObject params = new JsonObject();
        if (cwd != null && !cwd.isEmpty()) {
            params.addProperty("cwd", cwd);
        }

        AtomicReference<JsonObject> resultRef = new AtomicReference<>();
        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                try {
                    JsonObject parsed = GrokSDKBridge.this.gson.fromJson(line, JsonObject.class);
                    if (parsed != null) {
                        resultRef.set(parsed);
                    }
                } catch (Exception ignored) {
                }
            }
            @Override
            public void onStderr(String text) { }
            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", error);
                    resultFuture.complete(err);
                }
            }
            @Override
            public void onComplete(boolean success) {
                if (!resultFuture.isDone()) {
                    if (success) {
                        JsonObject result = resultRef.get();
                        if (result != null) {
                            resultFuture.complete(result);
                        } else {
                            JsonObject err = new JsonObject();
                            err.addProperty("success", false);
                            err.addProperty("error", "No response received for Grok getUsage");
                            resultFuture.complete(err);
                        }
                    } else {
                        JsonObject err = new JsonObject();
                        err.addProperty("success", false);
                        err.addProperty("error", "grok.getUsage command failed");
                        resultFuture.complete(err);
                    }
                }
            }
        };

        try {
            CompletableFuture<Boolean> commandFuture = db.sendCommand("grok.getUsage", params, callback);
            commandFuture.exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", ex.getMessage());
                    resultFuture.complete(err);
                }
                return false;
            });
        } catch (Exception e) {
            LOG.error("[GrokSDKBridge] getUsage failed: " + e.getMessage(), e);
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", e.getMessage());
            return CompletableFuture.completedFuture(err);
        }

        return resultFuture.orTimeout(30, TimeUnit.SECONDS).exceptionally(ex -> {
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", "Grok getUsage timed out after 30 seconds");
            return err;
        });
    }

    /**
     * Interrupt a channel. In daemon mode, sends an abort command to cancel the
     * active Grok ACP turn. Also delegates to ProcessManager for fallback.
     */
    @Override
    public void interruptChannel(String channelId) {
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db != null && db.isAlive()) {
            LOG.info("[GrokSDKBridge] Sending daemon abort for channel: " + channelId);
            try {
                db.sendAbort();
            } catch (Exception e) {
                LOG.error("[GrokSDKBridge] Daemon abort failed: " + e.getMessage());
            }
        }
        // Also try per-process interrupt (covers one-shot fallback)
        super.interruptChannel(channelId);
    }

    @Override
    public void cleanupAllProcesses() {
        shutdownDaemon();
        super.cleanupAllProcesses();
    }

    // ============================================================================
    // Message sending (Claude-shaped)
    // ============================================================================

    /**
     * Full Claude-shaped send entry (preferred). Tries daemon first for persistent ACP.
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        String normalizedCwd = normalizeCwdForNode(cwd);

        DaemonBridge db = daemonCoordinator.getDaemonBridge();
        if (db != null) {
            return sendMessageViaDaemon(db, channelId, message, sessionId, runtimeSessionEpoch,
                    normalizedCwd, attachments, permissionMode, model, openedFiles,
                    agentPrompt, streaming, disableThinking, reasoningEffort, callback);
        }

        LOG.info("[GrokSDKBridge] Using per-process (channel-manager) mode (daemon unavailable)");
        // Fallback to one-shot
        JsonObject stdinInput = buildStdinPayloadForDaemon(
                message, sessionId, runtimeSessionEpoch, normalizedCwd, attachments,
                permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort
        );
        String stdinJson = gson.toJson(stdinInput);
        List<String> command = buildBaseCommand("send");
        LOG.info("[Grok] sendMessage (fallback) sessionId=" + (sessionId != null ? sessionId : "(new)")
                + ", epoch=" + (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)")
                + ", model=" + (model != null ? model : "(default)"));

        return executeStreamingCommand(channelId, command, stdinJson, normalizedCwd, callback);
    }

    private String normalizeCwdForNode(String cwd) {
        if (cwd == null || cwd.isEmpty()) {
            return cwd;
        }
        String nodePath = nodeDetector.getCachedNodePath();
        boolean isWsl = nodePath != null && NodeDetector.isWslPath(nodePath);
        return isWsl ? NodeDetector.convertToWslPath(cwd) : cwd;
    }

    private CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        return daemonRequestExecutor.sendMessageViaDaemon(
                daemon, channelId, message, sessionId, runtimeSessionEpoch, cwd,
                attachments, permissionMode, model, openedFiles, agentPrompt,
                streaming, disableThinking, reasoningEffort, callback
        );
    }

    /**
     * Compatibility overload used by older call sites.
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agentPrompt,
            MessageCallback callback
    ) {
        return sendMessage(
                channelId,
                message,
                sessionId,
                null,
                cwd,
                attachments,
                permissionMode,
                model,
                null,
                agentPrompt,
                true,
                false,
                null,
                callback
        );
    }

    // Package-visible for GrokDaemonRequestExecutor
    JsonObject buildStdinPayloadForDaemon(
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            boolean disableThinking,
            String reasoningEffort
    ) {
        return buildStdinPayload(
                message, sessionId, runtimeSessionEpoch, cwd, attachments,
                permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort
        );
    }

    private JsonObject buildStdinPayload(
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            boolean disableThinking,
            String reasoningEffort
    ) {
        JsonObject stdinInput = new JsonObject();
        stdinInput.addProperty("message", message != null ? message : "");
        stdinInput.addProperty("sessionId", sessionId != null ? sessionId : "");
        if (runtimeSessionEpoch != null && !runtimeSessionEpoch.isEmpty()) {
            stdinInput.addProperty("runtimeSessionEpoch", runtimeSessionEpoch);
        }
        stdinInput.addProperty("cwd", cwd != null ? cwd : "");
        stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        stdinInput.addProperty("model", model != null ? model : "");
        String authMethod = resolveAuthMethod();
        String effectiveBase = resolveEffectiveBaseUrl(authMethod);
        stdinInput.addProperty("baseUrl", effectiveBase != null ? effectiveBase : "");
        stdinInput.addProperty("authMethod", authMethod);
        String effectiveKey = "";
        if (!CodemossSettingsService.GROK_AUTH_METHOD_OAUTH.equals(authMethod)) {
            String k = resolveApiKeyForAuth(authMethod);
            effectiveKey = k != null ? k : "";
        }
        stdinInput.addProperty("apiKey", effectiveKey);
        stdinInput.addProperty("agentPrompt", agentPrompt != null ? agentPrompt : "");
        stdinInput.addProperty("streaming", streaming == null || streaming);
        stdinInput.addProperty("disableThinking", disableThinking);
        if (reasoningEffort != null && !reasoningEffort.isEmpty()) {
            stdinInput.addProperty("reasoningEffort", reasoningEffort);
        }
        if (openedFiles != null) {
            stdinInput.add("openedFiles", openedFiles);
        }
        if (attachments != null && !attachments.isEmpty()) {
            JsonArray attArr = new JsonArray();
            for (ClaudeSession.Attachment a : attachments) {
                JsonObject o = new JsonObject();
                o.addProperty("fileName", a.fileName);
                o.addProperty("mediaType", a.mediaType);
                o.addProperty("data", a.data);
                attArr.add(o);
            }
            stdinInput.add("attachments", attArr);
        }
        return stdinInput;
    }

    /**
     * Session messages from Grok CLI on-disk history ({@code ~/.grok/sessions}).
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        return new GrokHistoryReader().getSessionMessages(sessionId);
    }
}
