package com.github.claudecodegui.provider.grok;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class GrokHistoryReaderTest {

    @Test
    public void listsSessionsForProjectAndConvertsChatHistory() throws Exception {
        Path root = Files.createTempDirectory("grok-history-test");
        Path projectKey = root.resolve("encoded-cwd");
        Path sessionDir = projectKey.resolve("019f503f-858d-7ec0-bf57-209926c427bd");
        Files.createDirectories(sessionDir);

        String summary = """
                {
                  "info": {
                    "id": "019f503f-858d-7ec0-bf57-209926c427bd",
                    "cwd": "/tmp/grok-test-project"
                  },
                  "generated_title": "Test Grok session",
                  "current_model_id": "grok-build",
                  "created_at": "2026-07-11T08:16:08.194019Z",
                  "updated_at": "2026-07-11T08:38:31.631666Z",
                  "num_chat_messages": 2
                }
                """;
        Files.writeString(sessionDir.resolve("summary.json"), summary, StandardCharsets.UTF_8);

        String chat = """
                {"type":"system","content":"hidden"}
                {"type":"user","content":[{"type":"text","text":"<user_query>\\nhello\\n</user_query>"}]}
                {"type":"assistant","content":"Hi there"}
                """;
        Files.writeString(sessionDir.resolve("chat_history.jsonl"), chat, StandardCharsets.UTF_8);

        GrokHistoryReader reader = new GrokHistoryReader(root, new Gson());
        List<GrokHistoryReader.SessionInfo> sessions =
                reader.listSessionsForProject("/tmp/grok-test-project");

        assertEquals(1, sessions.size());
        assertEquals("019f503f-858d-7ec0-bf57-209926c427bd", sessions.get(0).sessionId);
        assertEquals("Test Grok session", sessions.get(0).title);
        assertEquals("grok-build", sessions.get(0).model);

        assertEquals(1, reader.listAllSessions().size());

        List<JsonObject> messages = reader.getSessionMessages("019f503f-858d-7ec0-bf57-209926c427bd");
        assertEquals(2, messages.size());
        assertEquals("user", messages.get(0).get("type").getAsString());
        assertEquals("assistant", messages.get(1).get("type").getAsString());
    }

    @Test
    public void toFrontendEnvelopeSkipsSystemReminderOnlyUser() {
        JsonObject row = JsonParser.parseString(
                "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<system-reminder>only</system-reminder>\"}]}")
                .getAsJsonObject();
        assertTrue(GrokHistoryReader.toFrontendEnvelope(row) == null);
    }

    @Test
    public void assistantEnvelopeBuildsToolUseBlocksFromToolCalls() {
        JsonObject row = JsonParser.parseString("""
                {
                  "type":"assistant",
                  "content":"",
                  "tool_calls":[
                    {"id":"call-1","name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"},
                    {"id":"call-2","name":"grep","arguments":{"pattern":"foo"}}
                  ]
                }
                """).getAsJsonObject();

        JsonObject envelope = GrokHistoryReader.assistantEnvelope(row);
        assertTrue(envelope != null);
        JsonArray blocks = envelope.getAsJsonObject("message").getAsJsonArray("content");
        assertEquals(2, blocks.size());
        assertEquals("tool_use", blocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("read_file", blocks.get(0).getAsJsonObject().get("name").getAsString());
        assertEquals("a.txt", blocks.get(0).getAsJsonObject().getAsJsonObject("input").get("path").getAsString());
    }

    @Test
    public void assistantEnvelopeSkipsLegacySyntheticToolTextOnlyRows() {
        JsonObject row = JsonParser.parseString(
                "{\"type\":\"assistant\",\"content\":\"Tool: run_terminal_command, read_file\"}")
                .getAsJsonObject();
        assertTrue(GrokHistoryReader.assistantEnvelope(row) == null);
    }

    @Test
    public void stripUserQueryWrapperExtractsInnerPrompt() {
        assertEquals("hello world",
                GrokHistoryReader.stripUserQueryWrapper("<user_query>\nhello world\n</user_query>"));
        // maxLen=15 truncates with ellipsis (full stripped title is longer)
        assertEquals("javadoc fix for...",
                GrokHistoryReader.formatSessionTitlePreview(
                        "<user_query>javadoc fix for module</user_query>", 15));
        assertEquals("short",
                GrokHistoryReader.formatSessionTitlePreview("short", 40));
    }

    @Test
    public void assistantEnvelopeKeepsRealAssistantText() {
        JsonObject row = JsonParser.parseString(
                "{\"type\":\"assistant\",\"content\":\"ToxeH — коммичу 2.1\"}")
                .getAsJsonObject();
        JsonObject envelope = GrokHistoryReader.assistantEnvelope(row);
        assertTrue(envelope != null);
        assertEquals("ToxeH — коммичу 2.1",
                envelope.getAsJsonObject("message").getAsJsonArray("content").get(0).getAsJsonObject()
                        .get("text").getAsString());
    }

    @Test
    public void deleteSessionRemovesDirectory() throws Exception {
        Path root = Files.createTempDirectory("grok-delete-test");
        Path sessionDir = root.resolve("cwd").resolve("sess-1");
        Files.createDirectories(sessionDir);
        Files.writeString(sessionDir.resolve("summary.json"), "{\"info\":{\"id\":\"sess-1\",\"cwd\":\"/x\"}}",
                StandardCharsets.UTF_8);

        GrokHistoryReader reader = new GrokHistoryReader(root, new Gson());
        assertTrue(reader.deleteSession("sess-1"));
        assertFalse(Files.exists(sessionDir));
    }
}