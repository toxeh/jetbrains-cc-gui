package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class GeminiMessageHandlerTest {

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        int streamStartCount = 0;
        int streamEndCount = 0;
        int stateChangeCount = 0;
        int messageUpdateCount = 0;
        String lastSessionId = null;
        String lastError = null;
        boolean lastLoading = false;
        boolean lastBusy = false;
        final List<String> contentDeltas = new ArrayList<>();
        final List<String> thinkingDeltas = new ArrayList<>();
        final List<Message> lastMessages = new ArrayList<>();
        final List<String> callOrder = new ArrayList<>();

        @Override
        public void onMessageUpdate(List<Message> messages) {
            messageUpdateCount++;
            callOrder.add("messageUpdate");
            lastMessages.clear();
            lastMessages.addAll(messages);
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
            stateChangeCount++;
            lastBusy = busy;
            lastLoading = loading;
            lastError = error;
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
            lastSessionId = sessionId;
        }

        @Override
        public void onPermissionRequested(PermissionRequest request) {
        }

        @Override
        public void onThinkingStatusChanged(boolean isThinking) {
        }

        @Override
        public void onSlashCommandsReceived(List<String> slashCommands) {
        }

        @Override
        public void onNodeLog(String log) {
        }

        @Override
        public void onSummaryReceived(String summary) {
        }

        @Override
        public void onStreamStart() {
            streamStartCount++;
            callOrder.add("streamStart");
        }

        @Override
        public void onStreamEnd() {
            streamEndCount++;
            callOrder.add("streamEnd");
        }

        @Override
        public void onContentDelta(String delta) {
            contentDeltas.add(delta);
        }

        @Override
        public void onThinkingDelta(String delta) {
            thinkingDeltas.add(delta);
        }
    }

    private static GeminiMessageHandler newHandler(SessionState state, RecordingCallback callback) {
        CallbackHandler callbackHandler = new CallbackHandler();
        callbackHandler.setCallback(callback);
        return new GeminiMessageHandler(state, callbackHandler);
    }

    @Test
    public void streamMarkersDriveStandardStreamingLifecycle() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        RecordingCallback callback = new RecordingCallback();
        GeminiMessageHandler handler = newHandler(state, callback);

        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "done");
        handler.onMessage("stream_end", "");

        assertEquals(1, callback.streamStartCount);
        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertTrue(callback.messageUpdateCount >= 1);
        assertFalse(callback.lastMessages.isEmpty());
        assertEquals("done", callback.lastMessages.get(callback.lastMessages.size() - 1).content);
        assertEquals(List.of("done"), callback.contentDeltas);
    }

    @Test
    public void sessionIdIsCapturedAndNotified() {
        SessionState state = new SessionState();
        RecordingCallback callback = new RecordingCallback();
        GeminiMessageHandler handler = newHandler(state, callback);

        handler.onMessage("session_id", "conv-xyz");

        assertEquals("conv-xyz", state.getSessionId());
        assertEquals("conv-xyz", callback.lastSessionId);
    }

    @Test
    public void assistantMessageJsonUpdatesBubble() {
        SessionState state = new SessionState();
        RecordingCallback callback = new RecordingCallback();
        GeminiMessageHandler handler = newHandler(state, callback);

        handler.onMessage("stream_start", "");
        handler.onMessage("assistant",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Hello gemini\"}]}}");
        handler.onMessage("stream_end", "");

        assertFalse(callback.lastMessages.isEmpty());
        Message last = callback.lastMessages.get(callback.lastMessages.size() - 1);
        assertEquals(Message.Type.ASSISTANT, last.type);
        assertEquals("Hello gemini", last.content);
    }

    @Test
    public void thinkingDeltaIsForwarded() {
        SessionState state = new SessionState();
        RecordingCallback callback = new RecordingCallback();
        GeminiMessageHandler handler = newHandler(state, callback);

        handler.onMessage("stream_start", "");
        handler.onMessage("thinking_delta", "reason");
        assertEquals(List.of("reason"), callback.thinkingDeltas);
    }

    @Test
    public void onErrorClearsBusyAndAddsErrorMessage() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);
        RecordingCallback callback = new RecordingCallback();
        GeminiMessageHandler handler = newHandler(state, callback);

        handler.onMessage("stream_start", "");
        handler.onError("agy failed");

        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertEquals("agy failed", state.getError());
        assertEquals(1, callback.streamEndCount);
        assertTrue(callback.lastMessages.stream().anyMatch(m -> m.type == Message.Type.ERROR));
    }

    @Test
    public void onCompleteWithoutStreamEndForcesCleanup() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);
        RecordingCallback callback = new RecordingCallback();
        GeminiMessageHandler handler = newHandler(state, callback);

        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "partial");
        handler.onComplete(new SDKResult());

        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertEquals(1, callback.streamEndCount);
    }

    @Test
    public void blankSessionIdIsIgnored() {
        SessionState state = new SessionState();
        RecordingCallback callback = new RecordingCallback();
        GeminiMessageHandler handler = newHandler(state, callback);

        handler.onMessage("session_id", "   ");
        assertNull(state.getSessionId());
        assertNull(callback.lastSessionId);
    }
}
