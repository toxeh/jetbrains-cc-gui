package com.github.claudecodegui.handler;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import java.io.IOException;
import java.net.Authenticator;
import java.net.ConnectException;
import java.net.CookieHandler;
import java.net.NoRouteToHostException;
import java.net.PortUnreachableException;
import java.net.ProxySelector;
import java.net.URI;
import java.net.UnknownHostException;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * HTTP client behavior of {@link LocalTranslateHandler} with an injected {@link HttpClient}.
 * No live server is contacted.
 */
public class LocalTranslateHandlerTest {

    // ---------- request shape ----------

    @Test
    public void translateSendsChatCompletionsRequestWithGuardAndInstruction() throws Exception {
        FakeHttpClient client = FakeHttpClient.responding(200,
                "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Fix ⟦LTc0⟧ please\"}}]}");
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);
        JsonObject cfg = config("http://127.0.0.1:11434/v1", "отвечать на русском", null);

        LocalTranslateHandler.TranslateOutcome outcome = handler.translate(cfg, "Почини ⟦LTc0⟧");

        assertTrue(outcome.success);
        assertEquals("Fix ⟦LTc0⟧ please", outcome.text);
        HttpRequest request = client.requests.get(0);
        assertEquals("POST", request.method());
        assertEquals(URI.create("http://127.0.0.1:11434/v1/chat/completions"), request.uri());
        assertEquals(Optional.of(Duration.ofSeconds(15)), request.timeout());
        assertFalse(request.headers().firstValue("Authorization").isPresent());

        JsonObject body = JsonParser.parseString(client.bodies.get(0)).getAsJsonObject();
        assertEquals("qwen2.5:3b", body.get("model").getAsString());
        assertEquals(0, body.get("temperature").getAsInt());
        assertFalse(body.get("stream").getAsBoolean());
        assertFalse(body.has("tools"));
        assertFalse(body.has("response_format"));
        assertFalse(body.has("n"));
        JsonArray messages = body.getAsJsonArray("messages");
        assertEquals(6, messages.size());
        JsonObject system = messages.get(0).getAsJsonObject();
        assertEquals("system", system.get("role").getAsString());
        assertEquals(LocalTranslateHandler.FIXED_GUARD + "\n\nотвечать на русском", system.get("content").getAsString());
        assertTrue(system.get("content").getAsString().startsWith(
                "Keep every placeholder of the form ⟦LT…⟧ exactly as written, including its order.\n"
                        + "Output only the rewritten text. Do not add quotes, labels, or explanations."));
        assertEquals("user", messages.get(1).getAsJsonObject().get("role").getAsString());
        assertEquals(LocalTranslateHandler.PERSON_EXAMPLES[0][0], messages.get(1).getAsJsonObject().get("content").getAsString());
        assertEquals("assistant", messages.get(2).getAsJsonObject().get("role").getAsString());
        assertEquals(LocalTranslateHandler.PERSON_EXAMPLES[0][1], messages.get(2).getAsJsonObject().get("content").getAsString());
        assertEquals(LocalTranslateHandler.PERSON_EXAMPLES[1][0], messages.get(3).getAsJsonObject().get("content").getAsString());
        assertEquals(LocalTranslateHandler.PERSON_EXAMPLES[1][1], messages.get(4).getAsJsonObject().get("content").getAsString());
        JsonObject user = messages.get(5).getAsJsonObject();
        assertEquals("user", user.get("role").getAsString());
        assertEquals("Почини ⟦LTc0⟧", user.get("content").getAsString());
    }

    @Test
    public void apiKeyIsSentAsBearerOnTranslateAndProbe() {
        FakeHttpClient client = FakeHttpClient.responding(200,
                "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}");
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);
        JsonObject cfg = config("http://localhost:1234/v1", "x", "sk-test");

        handler.translate(cfg, "draft");
        handler.probe(cfg);

        assertEquals(Optional.of("Bearer sk-test"), client.requests.get(0).headers().firstValue("Authorization"));
        assertEquals(Optional.of("Bearer sk-test"), client.requests.get(1).headers().firstValue("Authorization"));
    }

    // ---------- response parser ----------

    @Test
    public void parserReadsContentAndIgnoresReasoning() {
        LocalTranslateHandler.TranslateOutcome outcome = LocalTranslateHandler.parseResponse(
                "{\"choices\":[{\"message\":{\"content\":\"\\n Hello world \\n\",\"reasoning_content\":\"thinking...\"}}]}");
        assertTrue(outcome.success);
        assertEquals("Hello world", outcome.text);
        assertNull(outcome.error);
    }

    @Test
    public void parserRejectsEmptyContent() {
        LocalTranslateHandler.TranslateOutcome outcome = LocalTranslateHandler.parseResponse(
                "{\"choices\":[{\"message\":{\"content\":\"   \"}}]}");
        assertFalse(outcome.success);
        assertEquals(LocalTranslateHandler.ERROR_EMPTY_RESPONSE, outcome.error);
    }

    @Test
    public void parserRejectsMissingChoicesAndNonStringContent() {
        assertEquals(LocalTranslateHandler.ERROR_INVALID_RESPONSE,
                LocalTranslateHandler.parseResponse("{\"id\":\"x\"}").error);
        assertEquals(LocalTranslateHandler.ERROR_INVALID_RESPONSE,
                LocalTranslateHandler.parseResponse("{\"choices\":[]}").error);
        assertEquals(LocalTranslateHandler.ERROR_INVALID_RESPONSE,
                LocalTranslateHandler.parseResponse("{\"choices\":[{\"message\":{\"content\":null}}]}").error);
        assertEquals(LocalTranslateHandler.ERROR_INVALID_RESPONSE,
                LocalTranslateHandler.parseResponse("{\"choices\":[{\"message\":{\"content\":[1]}}]}").error);
        assertEquals(LocalTranslateHandler.ERROR_INVALID_RESPONSE,
                LocalTranslateHandler.parseResponse("not json").error);
    }

    @Test
    public void non2xxStatusIsAFailure() {
        FakeHttpClient client = FakeHttpClient.responding(404, "{\"error\":\"model not found\"}");
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);

        LocalTranslateHandler.TranslateOutcome outcome = handler.translate(config("http://x/v1", "i", null), "draft");

        assertFalse(outcome.success);
        assertEquals("http_404", outcome.error);
        assertFalse(outcome.connectionFailed);
    }

    @Test
    public void connectionRefusedMarksServerUnreachable() {
        FakeHttpClient client = FakeHttpClient.throwing(new ConnectException("refused"));
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);

        LocalTranslateHandler.TranslateOutcome outcome = handler.translate(config("http://x/v1", "i", null), "draft");

        assertFalse(outcome.success);
        assertEquals(LocalTranslateHandler.ERROR_UNREACHABLE, outcome.error);
        assertTrue(outcome.connectionFailed);
    }

    @Test
    public void translateTimeoutIsAFailureWithoutHidingTheButton() {
        FakeHttpClient client = FakeHttpClient.throwing(new HttpTimeoutException("request timed out"));
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);

        LocalTranslateHandler.TranslateOutcome outcome = handler.translate(config("http://x/v1", "i", null), "draft");

        assertFalse(outcome.success);
        assertEquals(LocalTranslateHandler.ERROR_TIMEOUT, outcome.error);
        assertFalse(outcome.connectionFailed);
    }

    // ---------- probe ----------

    @Test
    public void probeGetsModelsWithTwoSecondTimeout() {
        FakeHttpClient client = FakeHttpClient.responding(200, "{\"data\":[]}");
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);

        assertTrue(handler.probe(config("http://127.0.0.1:11434/v1", "i", null)));

        HttpRequest request = client.requests.get(0);
        assertEquals("GET", request.method());
        assertEquals(URI.create("http://127.0.0.1:11434/v1/models"), request.uri());
        assertEquals(Optional.of(Duration.ofSeconds(2)), request.timeout());
    }

    @Test
    public void probeTimeoutMeansUnreachable() {
        FakeHttpClient client = FakeHttpClient.throwing(new HttpTimeoutException("timed out"));
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);
        assertFalse(handler.probe(config("http://127.0.0.1:11434/v1", "i", null)));
    }

    @Test
    public void probeNon2xxMeansUnreachable() {
        FakeHttpClient client = FakeHttpClient.responding(500, "");
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);
        assertFalse(handler.probe(config("http://127.0.0.1:11434/v1", "i", null)));
    }

    // ---------- whole-exchange deadline ----------

    @Test
    public void slowBodyHitsTheTranslateDeadlineAndCancelsTheRequest() {
        FakeHttpClient client = FakeHttpClient.responding(200,
                "{\"choices\":[{\"message\":{\"content\":\"late\"}}]}").withAsyncDelay(5_000);
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);
        handler.translateDeadline = Duration.ofMillis(100);

        LocalTranslateHandler.TranslateOutcome outcome = handler.translate(config("http://x/v1", "i", null), "draft");

        assertFalse(outcome.success);
        assertEquals(LocalTranslateHandler.ERROR_TIMEOUT, outcome.error);
        assertFalse(outcome.connectionFailed);
        assertTrue(client.asyncFutures.get(0).isCancelled());
    }

    @Test
    public void dnsAndNoRouteMarkServerUnreachable() {
        for (IOException failure : new IOException[] {
                new UnknownHostException("ollama.local"),
                new NoRouteToHostException("no route"),
                new PortUnreachableException("port closed"),
        }) {
            FakeHttpClient client = FakeHttpClient.throwing(failure);
            LocalTranslateHandler handler = new LocalTranslateHandler(null, client);
            LocalTranslateHandler.TranslateOutcome outcome = handler.translate(config("http://x/v1", "i", null), "draft");
            assertFalse(failure.toString(), outcome.success);
            assertEquals(failure.toString(), LocalTranslateHandler.ERROR_UNREACHABLE, outcome.error);
            assertTrue(failure.toString(), outcome.connectionFailed);
        }
    }

    @Test
    public void connectTimeoutMarksServerUnreachable() {
        FakeHttpClient client = FakeHttpClient.throwing(new HttpConnectTimeoutException("connect timed out"));
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);

        LocalTranslateHandler.TranslateOutcome outcome = handler.translate(config("http://x/v1", "i", null), "draft");

        assertFalse(outcome.success);
        assertEquals(LocalTranslateHandler.ERROR_UNREACHABLE, outcome.error);
        assertTrue(outcome.connectionFailed);
    }

    // ---------- reasoning inside content ----------

    @Test
    public void parserDropsLeadingThinkBlock() {
        LocalTranslateHandler.TranslateOutcome outcome = LocalTranslateHandler.parseResponse(
                "{\"choices\":[{\"message\":{\"content\":\"<think>\\nlet me think\\n</think>\\n\\nHello world\"}}]}");
        assertTrue(outcome.success);
        assertEquals("Hello world", outcome.text);
    }

    @Test
    public void parserDropsLeadingThinkBlockCaseInsensitively() {
        LocalTranslateHandler.TranslateOutcome outcome = LocalTranslateHandler.parseResponse(
                "{\"choices\":[{\"message\":{\"content\":\"  <THINK>a\\nb</Think>Fix ⟦LTc0⟧\"}}]}");
        assertTrue(outcome.success);
        assertEquals("Fix ⟦LTc0⟧", outcome.text);
    }

    @Test
    public void thinkOnlyContentIsAnEmptyResponse() {
        LocalTranslateHandler.TranslateOutcome outcome = LocalTranslateHandler.parseResponse(
                "{\"choices\":[{\"message\":{\"content\":\"<think>only reasoning</think>\\n  \"}}]}");
        assertFalse(outcome.success);
        assertEquals(LocalTranslateHandler.ERROR_EMPTY_RESPONSE, outcome.error);
    }

    @Test
    public void parserDropsRepeatedAndUnclosedLeadingThinkBlocks() {
        LocalTranslateHandler.TranslateOutcome repeated = LocalTranslateHandler.parseResponse(
                "{\"choices\":[{\"message\":{\"content\":\"<think>a</think><think>b</think>\\nHello\"}}]}");
        assertTrue(repeated.success);
        assertEquals("Hello", repeated.text);

        LocalTranslateHandler.TranslateOutcome unclosed = LocalTranslateHandler.parseResponse(
                "{\"choices\":[{\"message\":{\"content\":\"<think>still thinking\"}}]}");
        assertFalse(unclosed.success);
        assertEquals(LocalTranslateHandler.ERROR_EMPTY_RESPONSE, unclosed.error);
    }

    @Test
    public void thinkTagLaterInTheTextIsKept() {
        LocalTranslateHandler.TranslateOutcome outcome = LocalTranslateHandler.parseResponse(
                "{\"choices\":[{\"message\":{\"content\":\"Explain the <think></think> tag\"}}]}");
        assertTrue(outcome.success);
        assertEquals("Explain the <think></think> tag", outcome.text);
    }

    // ---------- orchestration ----------

    @Test
    public void refusedTranslateReportsUnreachableAndPushesStatusNotReachable() {
        CapturingHandler handler = new CapturingHandler(
                FakeHttpClient.throwing(new ConnectException("refused")), config("http://x/v1", "i", null));

        handler.runTranslate("{\"id\":7,\"text\":\"draft\"}");

        JsonObject result = handler.only(LocalTranslateHandler.FN_RESULT);
        assertEquals(7, result.get("id").getAsInt());
        assertFalse(result.get("success").getAsBoolean());
        assertEquals(LocalTranslateHandler.ERROR_UNREACHABLE, result.get("error").getAsString());
        JsonObject status = handler.only(LocalTranslateHandler.FN_STATUS);
        assertTrue(status.get("enabled").getAsBoolean());
        assertFalse(status.get("reachable").getAsBoolean());
        assertEquals(List.of("cmdEnter"), handler.keymapSyncs);
    }

    @Test
    public void disabledConfigRepliesDisabledAndPushesStatusDisabledWithoutHttp() {
        JsonObject cfg = config("http://x/v1", "i", null);
        cfg.addProperty("enabled", false);
        FakeHttpClient client = FakeHttpClient.responding(200, "{}");
        CapturingHandler handler = new CapturingHandler(client, cfg);

        handler.runTranslate("{\"id\":1,\"text\":\"draft\"}");

        JsonObject result = handler.only(LocalTranslateHandler.FN_RESULT);
        assertEquals(LocalTranslateHandler.ERROR_DISABLED, result.get("error").getAsString());
        JsonObject status = handler.only(LocalTranslateHandler.FN_STATUS);
        assertFalse(status.get("enabled").getAsBoolean());
        assertFalse(status.get("reachable").getAsBoolean());
        assertTrue(client.requests.isEmpty());
        assertEquals(Collections.singletonList((String) null), handler.keymapSyncs);
    }

    @Test
    public void blankPayloadRepliesEmptyPromptWithoutHttp() {
        FakeHttpClient client = FakeHttpClient.responding(200, "{}");
        CapturingHandler handler = new CapturingHandler(client, config("http://x/v1", "i", null));

        handler.runTranslate("{\"id\":3,\"text\":\"   \"}");
        handler.runTranslate("");

        assertEquals(2, handler.calls.size());
        for (String[] call : handler.calls) {
            assertEquals(LocalTranslateHandler.FN_RESULT, call[0]);
            assertEquals(LocalTranslateHandler.ERROR_EMPTY_PROMPT,
                    JsonParser.parseString(call[1]).getAsJsonObject().get("error").getAsString());
        }
        assertEquals(3, JsonParser.parseString(handler.calls.get(0)[1]).getAsJsonObject().get("id").getAsInt());
        assertTrue(client.requests.isEmpty());
    }

    @Test
    public void successfulTranslateEchoesTheRequestId() {
        CapturingHandler handler = new CapturingHandler(
                FakeHttpClient.responding(200, "{\"choices\":[{\"message\":{\"content\":\"Hi\"}}]}"),
                config("http://x/v1", "i", null));

        handler.runTranslate("{\"id\":42,\"text\":\"Привет\"}");

        JsonObject result = handler.calls.stream()
                .filter(c -> c[0].equals(LocalTranslateHandler.FN_RESULT))
                .map(c -> JsonParser.parseString(c[1]).getAsJsonObject())
                .findFirst().orElseThrow();
        assertEquals(42, result.get("id").getAsInt());
        assertTrue(result.get("success").getAsBoolean());
        assertEquals("Hi", result.get("text").getAsString());
    }

    @Test
    public void unexpectedTranslateExceptionStillRepliesFailed() {
        JsonObject broken = new JsonObject(); // no enabled/shortcut keys → handler throws internally
        CapturingHandler handler = new CapturingHandler(FakeHttpClient.responding(200, "{}"), broken);

        handler.runTranslate("{\"id\":5,\"text\":\"draft\"}");

        JsonObject result = handler.only(LocalTranslateHandler.FN_RESULT);
        assertEquals(5, result.get("id").getAsInt());
        assertEquals(LocalTranslateHandler.ERROR_FAILED, result.get("error").getAsString());
    }

    @Test
    public void unexpectedProbeExceptionDoesNotPushStatus() {
        CapturingHandler handler = new CapturingHandler(FakeHttpClient.responding(200, "{}"), new JsonObject());

        handler.runProbe();

        assertTrue(handler.calls.stream().noneMatch(c -> LocalTranslateHandler.FN_STATUS.equals(c[0])));
    }

    @Test
    public void unreadableConfigDoesNotPushStatus() {
        CapturingHandler handler = new CapturingHandler(FakeHttpClient.responding(200, "{}"), null);
        handler.throwOnRead = true;

        handler.runProbe();

        assertTrue(handler.calls.stream().noneMatch(c -> LocalTranslateHandler.FN_STATUS.equals(c[0])));
    }

    @Test
    public void probeOfDisabledConfigStillPushesEnabledFalse() {
        JsonObject cfg = config("http://x/v1", "i", null);
        cfg.addProperty("enabled", false);
        CapturingHandler handler = new CapturingHandler(FakeHttpClient.responding(200, "{}"), cfg);

        handler.runProbe();

        assertFalse(handler.only(LocalTranslateHandler.FN_STATUS).get("enabled").getAsBoolean());
    }

    @Test
    public void translateWithoutConfigTurnsTheKeymapOffAndReportsFailed() {
        FakeHttpClient client = FakeHttpClient.responding(200, "{}");
        CapturingHandler handler = new CapturingHandler(client, null);

        handler.runTranslate("{\"id\":9,\"text\":\"draft\"}");

        JsonObject result = handler.only(LocalTranslateHandler.FN_RESULT);
        assertEquals(LocalTranslateHandler.ERROR_FAILED, result.get("error").getAsString());
        assertEquals(Collections.singletonList((String) null), handler.keymapSyncs);
        assertFalse(handler.only(LocalTranslateHandler.FN_STATUS).get("enabled").getAsBoolean());
        assertTrue(client.requests.isEmpty());
    }

    @Test
    public void successfulTranslateReprobesWhenTheShortcutChanges() {
        FakeHttpClient client = FakeHttpClient.responding(200,
                "{\"choices\":[{\"message\":{\"content\":\"Hi\"}}]}");
        CapturingHandler handler = new CapturingHandler(client, config("http://x/v1", "i", null));
        handler.runProbe();
        handler.calls.clear();
        client.requests.clear();

        JsonObject shifted = config("http://x/v1", "i", null);
        shifted.addProperty("shortcut", "shiftEnter");
        handler.cfg = shifted;
        handler.runTranslate("{\"id\":1,\"text\":\"Привет\"}");

        JsonObject status = handler.only(LocalTranslateHandler.FN_STATUS);
        assertEquals("shiftEnter", status.get("shortcut").getAsString());
        assertTrue(status.get("reachable").getAsBoolean());
        assertEquals("POST", client.requests.get(0).method());
        assertEquals("GET", client.requests.get(1).method());
        assertTrue(client.requests.get(1).uri().getPath().endsWith("/models"));
    }

    @Test
    public void slowerProbeDoesNotOverwriteANewerStatus() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        FakeHttpClient client = FakeHttpClient.responding(200, "{}").blockFirstSend(entered, release);
        CapturingHandler handler = new CapturingHandler(client, config("http://x/v1", "i", null));

        Thread slow = new Thread(handler::runProbe, "slow-probe");
        slow.start();
        assertTrue(entered.await(2, TimeUnit.SECONDS));

        JsonObject shifted = config("http://x/v1", "i", null);
        shifted.addProperty("shortcut", "shiftEnter");
        handler.cfg = shifted;
        handler.runProbe();

        release.countDown();
        slow.join(2000);
        assertFalse(slow.isAlive());

        assertEquals(Collections.singletonList("shiftEnter"), handler.keymapSyncs);
        JsonObject status = handler.only(LocalTranslateHandler.FN_STATUS);
        assertEquals("shiftEnter", status.get("shortcut").getAsString());
    }

    @Test
    public void probeWithoutConfigTurnsTheKeymapChordOff() {
        CapturingHandler handler = new CapturingHandler(FakeHttpClient.responding(200, "{}"), null);

        handler.runProbe();

        assertEquals(Collections.singletonList((String) null), handler.keymapSyncs);
        assertTrue(handler.calls.stream().noneMatch(c -> LocalTranslateHandler.FN_STATUS.equals(c[0])));
    }

    // ---------- reply translation ----------

    @Test
    public void translateReplySendsChatCompletionsRequestWithSixMessagesFixedInstructionAndTemperatureZero() throws Exception {
        FakeHttpClient client = FakeHttpClient.responding(200,
                "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"Привет, мир!\"}}]}");
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);
        // instruction in config is ignored for reply translation
        JsonObject cfg = config("http://127.0.0.1:11434/v1", "custom config instruction", null);

        LocalTranslateHandler.TranslateOutcome outcome = handler.translateReply(cfg, "Hello world! ⟦LTk0⟧");

        assertTrue(outcome.success);
        assertEquals("Привет, мир!", outcome.text);
        HttpRequest request = client.requests.get(0);
        assertEquals("POST", request.method());
        assertEquals(URI.create("http://127.0.0.1:11434/v1/chat/completions"), request.uri());
        assertEquals(Optional.of(Duration.ofSeconds(15)), request.timeout());

        JsonObject body = JsonParser.parseString(client.bodies.get(0)).getAsJsonObject();
        assertEquals("qwen2.5:3b", body.get("model").getAsString());
        assertEquals(0, body.get("temperature").getAsInt());
        assertFalse(body.get("stream").getAsBoolean());
        assertFalse(body.has("top_p"));
        assertFalse(body.has("top_k"));
        assertFalse(body.has("tools"));

        JsonArray messages = body.getAsJsonArray("messages");
        assertEquals(6, messages.size());

        JsonObject system = messages.get(0).getAsJsonObject();
        assertEquals("system", system.get("role").getAsString());
        assertEquals(LocalTranslateHandler.FIXED_GUARD + "\n\n" + LocalTranslateHandler.REPLY_INSTRUCTION,
                system.get("content").getAsString());
        assertFalse("Config instruction must NOT be present in reply prompt",
                system.get("content").getAsString().contains("custom config instruction"));

        assertEquals("user", messages.get(1).getAsJsonObject().get("role").getAsString());
        assertEquals("I am writing you a letter.", messages.get(1).getAsJsonObject().get("content").getAsString());
        assertEquals("assistant", messages.get(2).getAsJsonObject().get("role").getAsString());
        assertEquals("Я пишу тебе письмо.", messages.get(2).getAsJsonObject().get("content").getAsString());
        assertEquals("user", messages.get(3).getAsJsonObject().get("role").getAsString());
        assertEquals("Tell me, do I save tokens when I write to you?", messages.get(3).getAsJsonObject().get("content").getAsString());
        assertEquals("assistant", messages.get(4).getAsJsonObject().get("role").getAsString());
        assertEquals("Скажи, я экономлю токены, когда пишу тебе?", messages.get(4).getAsJsonObject().get("content").getAsString());
        assertEquals("user", messages.get(5).getAsJsonObject().get("role").getAsString());
        assertEquals("Hello world! ⟦LTk0⟧", messages.get(5).getAsJsonObject().get("content").getAsString());
        assertTrue(body.get("max_tokens").getAsInt() > 0);
    }

    @Test
    public void translateReplySplitsALongAnswerAndJoinsThePieces() {
        FakeHttpClient client = FakeHttpClient.responding(200,
                "{\"choices\":[{\"message\":{\"content\":\"Часть.\"}}]}");
        LocalTranslateHandler handler = new LocalTranslateHandler(null, client);
        int budget = TranslationChunker.maxSourceTokens(TranslationChunker.REPLY_OUTPUT_PER_SOURCE);
        String paragraph = "A".repeat(1000);
        String text = paragraph + "\n\n" + paragraph;

        LocalTranslateHandler.TranslateOutcome outcome = handler.translateReply(config("http://127.0.0.1:9/v1", "ignored", null), text);

        assertTrue(outcome.success);
        assertEquals("Часть.\n\nЧасть.", outcome.text);
        assertEquals(2, client.requests.size());
        for (String body : client.bodies) {
            String sent = JsonParser.parseString(body).getAsJsonObject()
                    .getAsJsonArray("messages").get(5).getAsJsonObject().get("content").getAsString();
            assertTrue(TranslationChunker.estimateTokens(sent) <= budget);
            assertFalse(sent.contains("\n\n"));
        }
    }

    @Test
    public void truncatedChunkIsNotReturnedAsATranslation() {
        LocalTranslateHandler.TranslateOutcome outcome = LocalTranslateHandler.parseResponse(
                "{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"content\":\"Обре\"}}]}");

        assertFalse(outcome.success);
        assertEquals(LocalTranslateHandler.ERROR_FAILED, outcome.error);
    }

    @Test
    public void translateReplyHandlesSuccessWithIdAndHash() {
        CapturingHandler handler = new CapturingHandler(
                FakeHttpClient.responding(200, "{\"choices\":[{\"message\":{\"content\":\"Ответ ⟦LTk0⟧\"}}]}"),
                config("http://x/v1", "ignored", null));

        handler.runTranslateReply("{\"id\":99,\"sessionId\":\"s1\",\"provider\":\"claude\",\"hash\":\"abc123hash\",\"text\":\"Answer ⟦LTk0⟧\"}");

        JsonObject result = handler.only(LocalTranslateHandler.FN_REPLY_RESULT);
        assertEquals(99, result.get("id").getAsInt());
        assertTrue(result.get("success").getAsBoolean());
        assertEquals("abc123hash", result.get("hash").getAsString());
        assertEquals("Ответ ⟦LTk0⟧", result.get("text").getAsString());
    }

    @Test
    public void translateReplyDisabledConfigRepliesDisabledWithoutHttp() {
        JsonObject cfg = config("http://x/v1", "ignored", null);
        cfg.addProperty("enabled", false);
        FakeHttpClient client = FakeHttpClient.responding(200, "{}");
        CapturingHandler handler = new CapturingHandler(client, cfg);

        handler.runTranslateReply("{\"id\":10,\"sessionId\":\"s1\",\"hash\":\"h1\",\"text\":\"draft\"}");

        JsonObject result = handler.only(LocalTranslateHandler.FN_REPLY_RESULT);
        assertEquals(10, result.get("id").getAsInt());
        assertFalse(result.get("success").getAsBoolean());
        assertEquals(LocalTranslateHandler.ERROR_DISABLED, result.get("error").getAsString());
        assertTrue(client.requests.isEmpty());
    }

    @Test
    public void translateReplyBlankPayloadRepliesEmptyPrompt() {
        FakeHttpClient client = FakeHttpClient.responding(200, "{}");
        CapturingHandler handler = new CapturingHandler(client, config("http://x/v1", "ignored", null));

        handler.runTranslateReply("{\"id\":11,\"hash\":\"h2\",\"text\":\"   \"}");

        JsonObject result = handler.only(LocalTranslateHandler.FN_REPLY_RESULT);
        assertEquals(11, result.get("id").getAsInt());
        assertFalse(result.get("success").getAsBoolean());
        assertEquals(LocalTranslateHandler.ERROR_EMPTY_PROMPT, result.get("error").getAsString());
        assertTrue(client.requests.isEmpty());
    }

    @Test
    public void loadReplyTranslationsDispatchesFileContent() {
        java.util.concurrent.atomic.AtomicReference<JsonObject> storeRef = new java.util.concurrent.atomic.AtomicReference<>(new JsonObject());
        JsonObject entry = new JsonObject();
        entry.addProperty("russian", "Тест");
        entry.addProperty("shown", true);
        storeRef.get().add("h1", entry);

        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> null) {
            @Override
            public JsonObject load(String provider, String sessionId) {
                return storeRef.get();
            }
        };

        CapturingHandler handler = new CapturingHandler(FakeHttpClient.responding(200, "{}"),
                config("http://x/v1", "ignored", null), store);

        handler.runLoadReply("{\"sessionId\":\"sess-1\",\"provider\":\"claude\"}");

        JsonObject response = handler.only(LocalTranslateHandler.FN_REPLY_FILE);
        assertEquals("sess-1", response.get("sessionId").getAsString());
        JsonObject entries = response.getAsJsonObject("entries");
        assertTrue(entries.has("h1"));
        assertEquals("Тест", entries.getAsJsonObject("h1").get("russian").getAsString());
        assertFalse(response.has("unreadable"));
    }

    @Test
    public void loadReplyTranslationsReportsAnUnreadableCache() {
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> null) {
            @Override
            public JsonObject load(String provider, String sessionId) {
                return null;
            }
        };
        CapturingHandler handler = new CapturingHandler(FakeHttpClient.responding(200, "{}"),
                config("http://x/v1", "ignored", null), store);

        handler.runLoadReply("{\"sessionId\":\"sess-1\",\"provider\":\"claude\"}");

        JsonObject response = handler.only(LocalTranslateHandler.FN_REPLY_FILE);
        assertEquals("sess-1", response.get("sessionId").getAsString());
        assertTrue(response.get("unreadable").getAsBoolean());
        assertFalse(response.has("entries"));
    }

    @Test
    public void saveReplyTranslationPersistsEntry() {
        final List<String> saved = new ArrayList<>();
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> null) {
            @Override
            public void save(String provider, String sessionId, String hash, String russian, boolean shown) {
                saved.add(provider + "|" + sessionId + "|" + hash + "|" + russian + "|" + shown);
            }
        };

        CapturingHandler handler = new CapturingHandler(FakeHttpClient.responding(200, "{}"),
                config("http://x/v1", "ignored", null), store);

        handler.runSaveReply("{\"sessionId\":\"s1\",\"provider\":\"claude\",\"hash\":\"h1\",\"russian\":\"Русский\",\"shown\":true}");

        assertEquals(1, saved.size());
        assertEquals("claude|s1|h1|Русский|true", saved.get(0));
    }

    @Test
    public void setReplyShownAllUpdatesAllEntries() {
        final List<String> updated = new ArrayList<>();
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> null) {
            @Override
            public void setShownAll(String provider, String sessionId, boolean shown) {
                updated.add(provider + "|" + sessionId + "|" + shown);
            }
        };

        CapturingHandler handler = new CapturingHandler(FakeHttpClient.responding(200, "{}"),
                config("http://x/v1", "ignored", null), store);

        handler.runSetReplyShownAll("{\"sessionId\":\"s1\",\"provider\":\"claude\",\"shown\":false}");

        assertEquals(1, updated.size());
        assertEquals("claude|s1|false", updated.get(0));
    }

    @Test
    public void handleRoutesAllSupportedTypes() throws Exception {
        final java.util.List<String> saved = new java.util.ArrayList<>();
        final java.util.List<String> shown = new java.util.ArrayList<>();
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> null) {
            @Override
            public void save(String provider, String sessionId, String hash, String russian, boolean shownFlag) {
                saved.add(provider + "|" + sessionId + "|" + hash + "|" + russian + "|" + shownFlag);
            }

            @Override
            public void setShownAll(String provider, String sessionId, boolean shownFlag) {
                shown.add(provider + "|" + sessionId + "|" + shownFlag);
            }

            @Override
            public JsonObject load(String provider, String sessionId) {
                JsonObject entries = new JsonObject();
                entries.add("h", new JsonObject());
                return entries;
            }
        };
        JsonObject cfg = config("http://x/v1", "ignored", null);
        cfg.addProperty("enabled", true);
        CapturingHandler handler = new CapturingHandler(
                FakeHttpClient.responding(200, "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}"),
                cfg, store);

        assertTrue(handler.handle(LocalTranslateHandler.TYPE_PROBE, ""));
        assertTrue(handler.handle(LocalTranslateHandler.TYPE_TRANSLATE, "{\"text\":\"x\"}"));
        assertTrue(handler.handle(LocalTranslateHandler.TYPE_LOAD_REPLY, "{\"sessionId\":\"s\"}"));
        assertTrue(handler.handle(LocalTranslateHandler.TYPE_TRANSLATE_REPLY, "{\"id\":7,\"hash\":\"h\",\"text\":\"x\"}"));
        assertTrue(handler.handle(LocalTranslateHandler.TYPE_SAVE_REPLY,
                "{\"sessionId\":\"s1\",\"provider\":\"claude\",\"hash\":\"h1\",\"russian\":\"Русский\",\"shown\":true}"));
        assertTrue(handler.handle(LocalTranslateHandler.TYPE_SET_REPLY_SHOWN_ALL,
                "{\"sessionId\":\"s1\",\"provider\":\"claude\",\"shown\":false}"));
        assertFalse(handler.handle("unknown_type", "{}"));

        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline
                && (handler.calls.size() < 4 || saved.isEmpty() || shown.isEmpty())) {
            Thread.sleep(20);
        }

        assertTrue(handler.calls.stream().anyMatch(c -> LocalTranslateHandler.FN_STATUS.equals(c[0])));
        JsonObject translated = handler.calls.stream()
                .filter(c -> LocalTranslateHandler.FN_RESULT.equals(c[0]))
                .map(c -> JsonParser.parseString(c[1]).getAsJsonObject())
                .filter(body -> body.has("text") && "ok".equals(body.get("text").getAsString()))
                .findFirst()
                .orElseThrow();
        assertTrue(translated.get("success").getAsBoolean());
        JsonObject reply = handler.calls.stream()
                .filter(c -> LocalTranslateHandler.FN_REPLY_RESULT.equals(c[0]))
                .map(c -> JsonParser.parseString(c[1]).getAsJsonObject())
                .findFirst()
                .orElseThrow();
        assertEquals(7, reply.get("id").getAsInt());
        assertEquals("h", reply.get("hash").getAsString());
        assertEquals("ok", reply.get("text").getAsString());
        JsonObject loaded = handler.only(LocalTranslateHandler.FN_REPLY_FILE);
        assertEquals("s", loaded.get("sessionId").getAsString());
        assertTrue(loaded.getAsJsonObject("entries").has("h"));
        assertEquals(1, saved.size());
        assertEquals("claude|s1|h1|Русский|true", saved.get(0));
        assertEquals(1, shown.size());
        assertEquals("claude|s1|false", shown.get(0));
    }

    // ---------- helpers ----------

    /** Handler with injected config that captures webview replies and keymap syncs. */
    private static final class CapturingHandler extends LocalTranslateHandler {
        final List<String[]> calls = new ArrayList<>();
        final List<String> keymapSyncs = new ArrayList<>();
        volatile JsonObject cfg;
        boolean throwOnRead;

        CapturingHandler(HttpClient client, JsonObject cfg) {
            this(client, cfg, null);
        }

        CapturingHandler(HttpClient client, JsonObject cfg, ReplyTranslationStore store) {
            super(null, client, store != null ? store : new ReplyTranslationStore(null, (p, s) -> null));
            this.cfg = cfg;
        }

        @Override
        JsonObject readLocalTranslateConfig() throws java.io.IOException {
            if (throwOnRead) {
                throw new java.io.IOException("locked");
            }
            return cfg;
        }

        @Override
        synchronized void scheduleKeymapSync(String resolvedShortcut) {
            keymapSyncs.add(resolvedShortcut);
        }

        @Override
        synchronized void dispatchToWebview(String functionName, String json) {
            calls.add(new String[]{functionName, json});
        }

        JsonObject only(String functionName) {
            List<String[]> matching = calls.stream().filter(c -> c[0].equals(functionName)).toList();
            assertEquals("calls to " + functionName, 1, matching.size());
            return JsonParser.parseString(matching.get(0)[1]).getAsJsonObject();
        }
    }

    private static JsonObject config(String baseUrl, String instruction, String apiKey) {
        JsonObject cfg = new JsonObject();
        cfg.addProperty("enabled", true);
        cfg.addProperty("baseUrl", baseUrl);
        cfg.addProperty("model", "qwen2.5:3b");
        cfg.addProperty("shortcut", "cmdEnter");
        cfg.addProperty("instruction", instruction);
        if (apiKey != null) {
            cfg.addProperty("apiKey", apiKey);
        }
        return cfg;
    }

    /** Minimal in-memory HttpClient: records requests and returns a canned response or throws. */
    private static final class FakeHttpClient extends HttpClient {
        final List<HttpRequest> requests = new ArrayList<>();
        final List<String> bodies = new ArrayList<>();
        final List<CompletableFuture<?>> asyncFutures = new ArrayList<>();
        private final int status;
        private final String responseBody;
        private final IOException failure;
        private long asyncDelayMs;
        private CountDownLatch blockEntered;
        private CountDownLatch blockRelease;

        private FakeHttpClient(int status, String responseBody, IOException failure) {
            this.status = status;
            this.responseBody = responseBody;
            this.failure = failure;
        }

        static FakeHttpClient responding(int status, String body) {
            return new FakeHttpClient(status, body, null);
        }

        static FakeHttpClient throwing(IOException failure) {
            return new FakeHttpClient(0, null, failure);
        }

        /** Make {@code sendAsync} complete only after the given delay (a slow body). */
        FakeHttpClient withAsyncDelay(long delayMs) {
            this.asyncDelayMs = delayMs;
            return this;
        }

        /** The next {@code send} waits on {@code release} after counting {@code entered} down. */
        FakeHttpClient blockFirstSend(CountDownLatch entered, CountDownLatch release) {
            this.blockEntered = entered;
            this.blockRelease = release;
            return this;
        }

        @Override
        public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> handler) throws IOException {
            CountDownLatch release = blockRelease;
            if (release != null) {
                blockRelease = null;
                if (blockEntered != null) {
                    blockEntered.countDown();
                }
                try {
                    if (!release.await(2, TimeUnit.SECONDS)) {
                        throw new IOException("blocked send was not released");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException(e);
                }
            }
            requests.add(request);
            bodies.add(readBody(request));
            if (failure != null) {
                throw failure;
            }
            HttpResponse.ResponseInfo info = new HttpResponse.ResponseInfo() {
                @Override public int statusCode() { return status; }
                @Override public HttpHeaders headers() { return HttpHeaders.of(Map.of(), (a, b) -> true); }
                @Override public Version version() { return Version.HTTP_1_1; }
            };
            HttpResponse.BodySubscriber<T> subscriber = handler.apply(info);
            byte[] bytes = responseBody == null ? new byte[0] : responseBody.getBytes(StandardCharsets.UTF_8);
            subscriber.onSubscribe(new Flow.Subscription() {
                @Override public void request(long n) { }
                @Override public void cancel() { }
            });
            subscriber.onNext(List.of(ByteBuffer.wrap(bytes)));
            subscriber.onComplete();
            T body = subscriber.getBody().toCompletableFuture().join();
            return new SimpleResponse<>(request, status, body);
        }

        private static String readBody(HttpRequest request) {
            if (request.bodyPublisher().isEmpty()) {
                return null;
            }
            StringBuilder sb = new StringBuilder();
            CompletableFuture<Void> done = new CompletableFuture<>();
            request.bodyPublisher().get().subscribe(new Flow.Subscriber<>() {
                @Override public void onSubscribe(Flow.Subscription s) { s.request(Long.MAX_VALUE); }
                @Override public void onNext(ByteBuffer item) {
                    byte[] b = new byte[item.remaining()];
                    item.get(b);
                    sb.append(new String(b, StandardCharsets.UTF_8));
                }
                @Override public void onError(Throwable t) { done.completeExceptionally(t); }
                @Override public void onComplete() { done.complete(null); }
            });
            done.join();
            return sb.toString();
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest r, HttpResponse.BodyHandler<T> h) {
            CompletableFuture<HttpResponse<T>> future;
            if (asyncDelayMs > 0) {
                future = new CompletableFuture<>();
                CompletableFuture<HttpResponse<T>> target = future;
                CompletableFuture.delayedExecutor(asyncDelayMs, TimeUnit.MILLISECONDS).execute(() -> {
                    try {
                        target.complete(send(r, h));
                    } catch (IOException e) {
                        target.completeExceptionally(e);
                    }
                });
            } else {
                try {
                    future = CompletableFuture.completedFuture(send(r, h));
                } catch (IOException e) {
                    future = CompletableFuture.failedFuture(e);
                }
            }
            asyncFutures.add(future);
            return future;
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest r, HttpResponse.BodyHandler<T> h,
                                                                HttpResponse.PushPromiseHandler<T> p) {
            return sendAsync(r, h);
        }

        @Override public Optional<CookieHandler> cookieHandler() { return Optional.empty(); }
        @Override public Optional<Duration> connectTimeout() { return Optional.of(Duration.ofSeconds(2)); }
        @Override public Redirect followRedirects() { return Redirect.NEVER; }
        @Override public Optional<ProxySelector> proxy() { return Optional.empty(); }
        @Override public SSLContext sslContext() { return null; }
        @Override public SSLParameters sslParameters() { return null; }
        @Override public Optional<Authenticator> authenticator() { return Optional.empty(); }
        @Override public Version version() { return Version.HTTP_1_1; }
        @Override public Optional<Executor> executor() { return Optional.empty(); }
    }

    private record SimpleResponse<T>(HttpRequest request, int statusCode, T body) implements HttpResponse<T> {
        @Override public Optional<HttpResponse<T>> previousResponse() { return Optional.empty(); }
        @Override public HttpHeaders headers() { return HttpHeaders.of(Map.of(), (a, b) -> true); }
        @Override public Optional<SSLSession> sslSession() { return Optional.empty(); }
        @Override public URI uri() { return request.uri(); }
        @Override public HttpClient.Version version() { return HttpClient.Version.HTTP_1_1; }
    }
}
