package com.github.claudecodegui.provider.grok;

import com.google.gson.Gson;
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