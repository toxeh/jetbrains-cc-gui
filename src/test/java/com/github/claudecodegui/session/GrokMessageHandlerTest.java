package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.session.ClaudeSession.Message;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for Grok transcript integrity:
 * - do not double-add send-time user messages from ACP echoes
 * - never reuse a completed previous-turn assistant for a new stream
 */
public class GrokMessageHandlerTest {

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        final List<List<Message>> messageSnapshots = new ArrayList<>();

        @Override
        public void onMessageUpdate(List<Message> messages) {
            messageSnapshots.add(new ArrayList<>(messages));
        }

        @Override public void onStateChange(boolean busy, boolean loading, String error) {}
        @Override public void onSessionIdReceived(String sessionId) {}
        @Override public void onPermissionRequested(PermissionRequest request) {}
        @Override public void onThinkingStatusChanged(boolean isThinking) {}
        @Override public void onSlashCommandsReceived(List<String> slashCommands) {}
        @Override public void onNodeLog(String log) {}
        @Override public void onSummaryReceived(String summary) {}
        @Override public void onStreamStart() {}
        @Override public void onStreamEnd() {}
        @Override public void onContentDelta(String delta) {}
        @Override public void onThinkingDelta(String delta) {}
    }

    private static GrokMessageHandler newHandler(SessionState state) {
        CallbackHandler callbacks = new CallbackHandler();
        callbacks.setCallback(new RecordingCallback());
        return new GrokMessageHandler(state, callbacks);
    }

    @Test
    public void userEchoDoesNotDuplicateSendTimeUserMessage() {
        SessionState state = new SessionState();
        Message sendTimeUser = new Message(Message.Type.USER, "investigate the hang");
        state.addMessage(sendTimeUser);

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("user", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"investigate the hang\"}]}}");

        List<Message> messages = state.getMessages();
        assertEquals("ACP user echo must not add a second user bubble", 1, messages.size());
        assertSame(sendTimeUser, messages.get(0));
        assertEquals("investigate the hang", messages.get(0).content);
    }

    @Test
    public void userEchoAfterAssistantDoesNotAppendTrailingUserBubble() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "first question"));
        state.addMessage(new Message(Message.Type.ASSISTANT, "first answer"));

        GrokMessageHandler handler = newHandler(state);
        // Late echo of the first user message — previously landed AFTER the assistant.
        handler.onMessage("user", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"first question\"}]}}");

        List<Message> messages = state.getMessages();
        assertEquals(2, messages.size());
        assertEquals(Message.Type.USER, messages.get(0).type);
        assertEquals(Message.Type.ASSISTANT, messages.get(1).type);
    }

    @Test
    public void toolResultUserMessagesAreStillAdded() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.ASSISTANT, "calling tool"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage(
                "user",
                "{\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"ok\"}]}}"
        );

        List<Message> messages = state.getMessages();
        assertEquals(2, messages.size());
        assertEquals(Message.Type.USER, messages.get(1).type);
        assertEquals("[tool_result]", messages.get(1).content);
    }

    @Test
    public void newStreamDoesNotReusePreviousTurnAssistantEvenIfLastIsAssistant() {
        SessionState state = new SessionState();
        Message prevAssistant = new Message(Message.Type.ASSISTANT, "previous turn answer with PR links");
        state.addMessage(new Message(Message.Type.USER, "first"));
        state.addMessage(prevAssistant);
        // Simulate missing send-time user for turn 2 (the frontend race case).

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "new turn answer");

        List<Message> messages = state.getMessages();
        assertEquals("must append a new assistant bubble for the new stream", 3, messages.size());
        assertSame(prevAssistant, messages.get(1));
        assertEquals("previous turn answer with PR links", messages.get(1).content);
        assertEquals(Message.Type.ASSISTANT, messages.get(2).type);
        assertEquals("new turn answer", messages.get(2).content);
        assertNotSame(prevAssistant, messages.get(2));
    }

    @Test
    public void contentDeltasAccumulateOnStreamOwnedAssistant() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "q"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Hello");
        handler.onMessage("content_delta", " world");

        List<Message> messages = state.getMessages();
        assertEquals(2, messages.size());
        assertEquals("Hello world", messages.get(1).content);
    }

    @Test
    public void blockResetKeepsSameStreamAssistantForNextTextSegment() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "q"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "before tools");
        handler.onMessage("block_reset", "");
        handler.onMessage("content_delta", " after tools");

        List<Message> messages = state.getMessages();
        assertEquals("block_reset must not create a second assistant for the same stream", 2, messages.size());
        // Accumulator is cleared on block_reset; subsequent deltas start a new text segment
        // on the same stream-owned bubble.
        assertTrue(messages.get(1).content.contains("after tools") || messages.get(1).content.equals(" after tools"));
    }
}
