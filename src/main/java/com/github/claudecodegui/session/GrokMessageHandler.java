package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.handler.SettingsHandler;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Grok message callback handler (Claude-template protocol surface).
 *
 * Grows toward ClaudeMessageHandler event types without reusing Claude-specific
 * Anthropic assumptions wholesale (handler strategy A).
 *
 * Protocol tags from ai-bridge Grok ACP normalizer:
 *   message_start / message_end / stream_start / stream_end / block_reset
 *   content_delta / content / thinking / thinking_delta
 *   assistant / user / result / session_id / tool_result / usage
 */
public class GrokMessageHandler implements MessageCallback {
    private static final Logger LOG = Logger.getInstance(GrokMessageHandler.class);

    private final SessionState state;
    private final CallbackHandler callbackHandler;
    private final Gson gson = new Gson();

    private final StringBuilder assistantContent = new StringBuilder();
    private Message currentAssistantMessage = null;

    private boolean isStreaming = false;
    private boolean streamEndedThisTurn = false;
    private boolean isThinking = false;

    public GrokMessageHandler(SessionState state, CallbackHandler callbackHandler) {
        this.state = state;
        this.callbackHandler = callbackHandler;
    }

    @Override
    public void onMessage(String type, String content) {
        LOG.debug("GrokMessageHandler.onMessage: type=" + type);

        switch (type) {
            case "assistant":
            case "message":
                handleAssistantMessage(content);
                break;
            case "user":
                handleUserMessage(content);
                break;
            case "result":
                handleResultMessage(content);
                break;
            case "session_id":
            case "thread_id":
                handleSessionId(content);
                break;
            case "stream_start":
                handleStreamStart();
                break;
            case "stream_end":
                handleStreamEnd();
                break;
            case "block_reset":
                handleBlockReset();
                break;
            case "content_delta":
            case "content":
                handleContentDelta(content);
                break;
            case "thinking":
                handleThinking();
                break;
            case "thinking_delta":
                handleThinkingDelta(content);
                break;
            case "tool_result":
                handleToolResult(content);
                break;
            case "usage":
                handleUsage(content);
                break;
            case "status":
                if (content != null && !content.trim().isEmpty()) {
                    callbackHandler.notifyStatusMessage(content);
                }
                break;
            case "message_start":
                // lifecycle marker; stream_start drives UI
                break;
            case "message_end":
                handleMessageEnd();
                break;
            default:
                LOG.debug("GrokMessageHandler: Unhandled message type: " + type);
        }
    }

    @Override
    public void onError(String error) {
        boolean wasStreaming = isStreaming;
        isStreaming = false;
        streamEndedThisTurn = false;
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        state.setError(error);
        state.setBusy(false);
        state.setLoading(false);

        Message errorMessage = new Message(Message.Type.ERROR, error);
        state.addMessage(errorMessage);

        // Always end stream so tool cards / loading state finalize
        callbackHandler.notifyStreamEnd();
        callbackHandler.notifyMessageUpdate(state.getMessages());
        resetStreamingAccumulator();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    @Override
    public void onComplete(SDKResult result) {
        boolean streamEndedBeforeComplete = streamEndedThisTurn;
        boolean wasStreaming = isStreaming;

        isStreaming = false;
        streamEndedThisTurn = false;
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();

        if (wasStreaming && !streamEndedBeforeComplete) {
            LOG.warn("Grok onComplete called without prior stream_end; forcing stream cleanup");
            callbackHandler.notifyMessageUpdate(state.getMessages());
            callbackHandler.notifyStreamEnd();
        }

        resetStreamingAccumulator();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    // ===== Private handlers =====

    private void handleAssistantMessage(String jsonContent) {
        try {
            JsonObject msgJson = gson.fromJson(jsonContent, JsonObject.class);
            if (msgJson == null) {
                return;
            }

            // tool_use blocks: keep raw structure for UI tool cards
            boolean hasToolUse = hasToolUseBlocks(msgJson);

            Message parsed = parseAssistantMessage(msgJson);
            if (parsed == null) {
                return;
            }

            if (currentAssistantMessage != null) {
                // Merge raw when possible
                if (hasToolUse && currentAssistantMessage.raw != null) {
                    currentAssistantMessage.raw = mergeAssistantRaw(currentAssistantMessage.raw, msgJson);
                } else {
                    currentAssistantMessage.raw = parsed.raw;
                }
                if (parsed.content != null && !parsed.content.isEmpty()) {
                    if (!isStreaming || parsed.content.length() >= assistantContent.length()) {
                        currentAssistantMessage.content = parsed.content;
                        assistantContent.setLength(0);
                        assistantContent.append(parsed.content);
                    }
                }
            } else {
                if (!isLastMessageAssistant()) {
                    state.addMessage(parsed);
                    currentAssistantMessage = parsed;
                } else {
                    currentAssistantMessage = state.getMessages().get(state.getMessages().size() - 1);
                    currentAssistantMessage.raw = parsed.raw;
                    if (parsed.content != null && !parsed.content.isEmpty()) {
                        currentAssistantMessage.content = parsed.content;
                    }
                }
                if (parsed.content != null) {
                    assistantContent.setLength(0);
                    assistantContent.append(parsed.content);
                }
            }
            // Structural changes (tool_use) must refresh UI even during streaming
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } catch (Exception e) {
            LOG.warn("Failed to parse Grok assistant message: " + e.getMessage());
        }
    }

    private void handleUserMessage(String jsonContent) {
        try {
            JsonObject msgJson = gson.fromJson(jsonContent, JsonObject.class);
            if (msgJson == null) {
                return;
            }

            if (hasToolResult(msgJson)) {
                Message toolResultMessage = new Message(Message.Type.USER, "[tool_result]", msgJson);
                state.addMessage(toolResultMessage);
                callbackHandler.notifyMessageUpdate(state.getMessages());
                return;
            }

            Message parsed = new Message(Message.Type.USER, extractText(msgJson));
            parsed.raw = msgJson;
            state.addMessage(parsed);
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } catch (Exception e) {
            LOG.warn("Failed to parse Grok user message: " + e.getMessage());
        }
    }

    private void handleResultMessage(String jsonContent) {
        if (jsonContent == null || !jsonContent.startsWith("{")) {
            return;
        }
        try {
            JsonObject resultJson = gson.fromJson(jsonContent, JsonObject.class);
            if (resultJson != null && resultJson.has("usage") && currentAssistantMessage != null) {
                if (currentAssistantMessage.raw == null) {
                    currentAssistantMessage.raw = new JsonObject();
                }
                JsonElement usageEl = resultJson.get("usage");
                currentAssistantMessage.raw.add("turnUsage", usageEl.deepCopy());
                callbackHandler.notifyMessageUpdate(state.getMessages());

                // Also drive the context bar from result.usage if we got here (defensive for Grok)
                try {
                    JsonObject u = usageEl != null && usageEl.isJsonObject() ? usageEl.getAsJsonObject() : null;
                    if (u != null && u.has("usage") && u.get("usage").isJsonObject()) {
                        u = u.getAsJsonObject("usage");
                    }
                    if (u != null) {
                        int used = 0;
                        if (u.has("input_tokens")) {
                            used = u.get("input_tokens").getAsInt();
                        } else if (u.has("prompt_tokens")) {
                            used = u.get("prompt_tokens").getAsInt();
                        } else if (u.has("total_tokens")) {
                            used = u.get("total_tokens").getAsInt();
                        } else if (u.has("promptTokenCount")) {
                            used = u.get("promptTokenCount").getAsInt();
                        } else if (u.has("inputTokenCount")) {
                            used = u.get("inputTokenCount").getAsInt();
                        }
                        int maxTokens = SettingsHandler.getModelContextLimit(state.getModel());
                        if (used > 0 || maxTokens > 0) {
                            callbackHandler.notifyUsageUpdate(used, maxTokens);
                        }
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            LOG.debug("Grok result parse skipped: " + e.getMessage());
        }
    }

    private void handleSessionId(String id) {
        if (id != null && !id.trim().isEmpty()) {
            state.setSessionId(id.trim());
            callbackHandler.notifySessionIdReceived(id.trim());
            LOG.info("Captured Grok session ID: " + id.trim());
        }
    }

    private void handleStreamStart() {
        isStreaming = true;
        streamEndedThisTurn = false;
        resetStreamingAccumulator();
        callbackHandler.notifyStreamStart();

        // Do not force notifyUsageUpdate(0, max) here.
        // Forcing 0 made the context indicator drop to 0% at the start of every Grok turn.
        // The max (and a reasonable used value) is populated by:
        //  - model/provider change -> UsagePushService
        //  - [USAGE] events in handleUsage (which always include real max)
        // This keeps the previous context size visible during generation for the current turn.
    }

    private void handleStreamEnd() {
        streamEndedThisTurn = true;
        isStreaming = false;
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        callbackHandler.notifyMessageUpdate(state.getMessages());
        callbackHandler.notifyStreamEnd();
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    private void handleBlockReset() {
        // New structural segment after tools — clear delta accumulator for next text block
        assistantContent.setLength(0);
        currentAssistantMessage = null;
        try {
            callbackHandler.notifyBlockReset();
        } catch (Exception e) {
            LOG.debug("notifyBlockReset not available or failed: " + e.getMessage());
        }
    }

    private void handleContentDelta(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        assistantContent.append(content);

        if (currentAssistantMessage == null) {
            if (!isLastMessageAssistant()) {
                currentAssistantMessage = new Message(Message.Type.ASSISTANT, assistantContent.toString());
                state.addMessage(currentAssistantMessage);
            } else {
                // Reuse last if it was already added (defensive)
                currentAssistantMessage = state.getMessages().get(state.getMessages().size() - 1);
                currentAssistantMessage.content = assistantContent.toString();
            }
        } else {
            currentAssistantMessage.content = assistantContent.toString();
        }
        callbackHandler.notifyContentDelta(content);
        if (!isStreaming) {
            callbackHandler.notifyMessageUpdate(state.getMessages());
        }
    }

    private void handleThinking() {
        if (!isThinking) {
            isThinking = true;
            callbackHandler.notifyThinkingStatusChanged(true);
        }
    }

    private void handleThinkingDelta(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }
        if (!isThinking) {
            isThinking = true;
            callbackHandler.notifyThinkingStatusChanged(true);
        }
        ensureAssistantRaw();
        appendThinkingToRaw(content);
        try {
            callbackHandler.notifyThinkingDelta(content);
        } catch (Exception e) {
            LOG.debug("notifyThinkingDelta failed: " + e.getMessage());
        }
        callbackHandler.notifyMessageUpdate(state.getMessages());
    }

    private void handleToolResult(String content) {
        if (content == null || !content.startsWith("{")) {
            return;
        }
        try {
            JsonObject toolResultBlock = gson.fromJson(content, JsonObject.class);
            String toolUseId = toolResultBlock.has("tool_use_id")
                    ? toolResultBlock.get("tool_use_id").getAsString()
                    : null;
            if (toolUseId == null) {
                return;
            }

            JsonArray contentArray = new JsonArray();
            contentArray.add(toolResultBlock);
            JsonObject messageObj = new JsonObject();
            messageObj.add("content", contentArray);
            JsonObject rawUser = new JsonObject();
            rawUser.addProperty("type", "user");
            rawUser.add("message", messageObj);

            Message toolResultMessage = new Message(Message.Type.USER, "[tool_result]", rawUser);
            state.addMessage(toolResultMessage);
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } catch (Exception e) {
            LOG.warn("Failed to parse Grok tool_result: " + e.getMessage());
        }
    }

    private void handleUsage(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }
        try {
            JsonObject usage = gson.fromJson(content, JsonObject.class);
            if (usage == null) {
                return;
            }
            ensureAssistantRaw();
            JsonObject message = currentAssistantMessage.raw.has("message")
                    && currentAssistantMessage.raw.get("message").isJsonObject()
                    ? currentAssistantMessage.raw.getAsJsonObject("message")
                    : new JsonObject();
            message.add("usage", usage);
            currentAssistantMessage.raw.add("message", message);

            // For the context window bar, use the *input/prompt* size (the context fed to the model for this call).
            // This is the current context window usage. Do not add output (generated after).
            // NOTE for Grok: the exact semantics of "usage" from ACP are not fully documented like Claude's context_window.
            // We take the last reported input/prompt size as best approximation of current context fed (history + new).
            // Max is from model catalog (500k for grok-4.x). May not be 100% precise.
            // Unwrap if the JSON was { "usage": { ... } }
            JsonObject u = usage;
            if (u.has("usage") && u.get("usage").isJsonObject()) {
                u = u.getAsJsonObject("usage");
            }
            int used = 0;
            if (u.has("input_tokens")) {
                used = u.get("input_tokens").getAsInt();
            } else if (u.has("prompt_tokens")) {
                used = u.get("prompt_tokens").getAsInt();
            } else if (u.has("total_tokens")) {
                used = u.get("total_tokens").getAsInt();
            } else if (u.has("promptTokenCount")) {
                used = u.get("promptTokenCount").getAsInt();
            } else if (u.has("inputTokenCount")) {
                used = u.get("inputTokenCount").getAsInt();
            } else if (u.has("totalTokenCount")) {
                used = u.get("totalTokenCount").getAsInt();
            } else if (!u.has("prompt_tokens") && u.has("input") && u.get("input").isJsonPrimitive()) {
                // rare fallback
                try { used = u.get("input").getAsInt(); } catch (Exception ignored) {}
            }
            int maxTokens = SettingsHandler.getModelContextLimit(state.getModel());
            // Always include real maxTokens (from model limits) so the context bar
            // shows "X / Y Context" (e.g. 12k / 500k) instead of just % with no limit.
            callbackHandler.notifyUsageUpdate(used, maxTokens);
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } catch (Exception e) {
            LOG.debug("Grok usage parse skipped: " + e.getMessage());
        }
    }

    private void handleMessageEnd() {
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
    }

    private Message parseAssistantMessage(JsonObject msg) {
        String text = extractText(msg);
        Message m = new Message(Message.Type.ASSISTANT, text != null ? text : "");
        m.raw = msg;
        return m;
    }

    private String extractText(JsonObject msg) {
        if (msg == null) {
            return "";
        }
        try {
            if (msg.has("message") && msg.get("message").isJsonObject()) {
                JsonObject message = msg.getAsJsonObject("message");
                if (message.has("content")) {
                    com.google.gson.JsonElement c = message.get("content");
                    if (c.isJsonArray()) {
                        StringBuilder sb = new StringBuilder();
                        for (com.google.gson.JsonElement el : c.getAsJsonArray()) {
                            if (el.isJsonObject()) {
                                JsonObject b = el.getAsJsonObject();
                                if (b.has("text")) {
                                    sb.append(b.get("text").getAsString());
                                }
                            }
                        }
                        return sb.toString();
                    } else if (c.isJsonPrimitive()) {
                        return c.getAsString();
                    }
                }
            }
            if (msg.has("content") && msg.get("content").isJsonPrimitive()) {
                return msg.get("content").getAsString();
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    private boolean hasToolUseBlocks(JsonObject msg) {
        try {
            if (msg != null && msg.has("message") && msg.get("message").isJsonObject()) {
                JsonObject message = msg.getAsJsonObject("message");
                if (message.has("content") && message.get("content").isJsonArray()) {
                    for (com.google.gson.JsonElement el : message.getAsJsonArray("content")) {
                        if (el.isJsonObject() && el.getAsJsonObject().has("type")) {
                            if ("tool_use".equals(el.getAsJsonObject().get("type").getAsString())) {
                                return true;
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private boolean hasToolResult(JsonObject msg) {
        try {
            if (msg != null && msg.has("message") && msg.get("message").isJsonObject()) {
                JsonObject message = msg.getAsJsonObject("message");
                if (message.has("content") && message.get("content").isJsonArray()) {
                    for (com.google.gson.JsonElement el : message.getAsJsonArray("content")) {
                        if (el.isJsonObject() && el.getAsJsonObject().has("type")) {
                            if ("tool_result".equals(el.getAsJsonObject().get("type").getAsString())) {
                                return true;
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private JsonObject mergeAssistantRaw(JsonObject previous, JsonObject incoming) {
        // Minimal merge: append content blocks from incoming into previous
        try {
            JsonObject prevMsg = previous.has("message") && previous.get("message").isJsonObject()
                    ? previous.getAsJsonObject("message")
                    : new JsonObject();
            JsonArray prevContent = prevMsg.has("content") && prevMsg.get("content").isJsonArray()
                    ? prevMsg.getAsJsonArray("content")
                    : new JsonArray();

            if (incoming.has("message") && incoming.get("message").isJsonObject()) {
                JsonObject inMsg = incoming.getAsJsonObject("message");
                if (inMsg.has("content") && inMsg.get("content").isJsonArray()) {
                    for (com.google.gson.JsonElement el : inMsg.getAsJsonArray("content")) {
                        prevContent.add(el.deepCopy());
                    }
                }
            }
            prevMsg.add("content", prevContent);
            previous.add("message", prevMsg);
            return previous;
        } catch (Exception e) {
            return incoming;
        }
    }

    private void ensureAssistantRaw() {
        if (currentAssistantMessage == null) {
            if (!isLastMessageAssistant()) {
                JsonObject raw = new JsonObject();
                raw.addProperty("type", "assistant");
                JsonObject messageObj = new JsonObject();
                messageObj.add("content", new JsonArray());
                raw.add("message", messageObj);
                currentAssistantMessage = new Message(Message.Type.ASSISTANT, "", raw);
                state.addMessage(currentAssistantMessage);
            } else {
                currentAssistantMessage = state.getMessages().get(state.getMessages().size() - 1);
            }
        }
        if (currentAssistantMessage.raw == null) {
            JsonObject raw = new JsonObject();
            raw.addProperty("type", "assistant");
            JsonObject messageObj = new JsonObject();
            messageObj.add("content", new JsonArray());
            raw.add("message", messageObj);
            currentAssistantMessage.raw = raw;
        }
    }

    private void appendThinkingToRaw(String delta) {
        ensureAssistantRaw();
        JsonObject raw = currentAssistantMessage.raw;
        JsonObject message = raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message")
                : new JsonObject();
        JsonArray content = message.has("content") && message.get("content").isJsonArray()
                ? message.getAsJsonArray("content")
                : new JsonArray();

        JsonObject thinkingBlock = null;
        for (int i = content.size() - 1; i >= 0; i--) {
            com.google.gson.JsonElement el = content.get(i);
            if (el.isJsonObject() && el.getAsJsonObject().has("type")
                    && "thinking".equals(el.getAsJsonObject().get("type").getAsString())) {
                thinkingBlock = el.getAsJsonObject();
                break;
            }
        }
        if (thinkingBlock == null) {
            thinkingBlock = new JsonObject();
            thinkingBlock.addProperty("type", "thinking");
            thinkingBlock.addProperty("thinking", delta);
            content.add(thinkingBlock);
        } else {
            String prev = thinkingBlock.has("thinking") ? thinkingBlock.get("thinking").getAsString() : "";
            thinkingBlock.addProperty("thinking", prev + delta);
        }
        message.add("content", content);
        raw.add("message", message);
    }

    private void resetStreamingAccumulator() {
        assistantContent.setLength(0);
        currentAssistantMessage = null;
    }

    /**
     * Guard against duplicate assistant messages (observed in some first-turn / persistent flows).
     */
    private boolean isLastMessageAssistant() {
        if (state.getMessages().isEmpty()) {
            return false;
        }
        Message last = state.getMessages().get(state.getMessages().size() - 1);
        return last != null && last.type == Message.Type.ASSISTANT;
    }
}
