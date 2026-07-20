package com.github.claudecodegui.provider.grok;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class GrokUsageAggregatorTest {

    @Test
    public void emptyScopeReturnsHonestNoteAndZeroSessions() throws Exception {
        Path root = Files.createTempDirectory("grok-agg-empty");
        Path ledger = Files.createTempDirectory("grok-ledger").resolve("ledger.jsonl");
        GrokHistoryReader reader = new GrokHistoryReader(root, new Gson());
        GrokUsageLedger usageLedger = new GrokUsageLedger(ledger);
        GrokUsageAggregator agg = new GrokUsageAggregator(reader, usageLedger);

        GrokUsageAggregator.ProjectStatistics stats = agg.getProjectStatistics("all", 0);

        assertEquals(0, stats.totalSessions);
        assertEquals("grok", stats.provider);
        assertEquals("local-activity", stats.source);
        assertFalse(stats.tokensFromLedger);
        assertTrue(stats.activityNote != null && stats.activityNote.toLowerCase().contains("no grok sessions"));
    }

    @Test
    public void aggregatesSessionsAndLedgerTokens() throws Exception {
        Path root = Files.createTempDirectory("grok-agg");
        Path projectKey = root.resolve("enc");
        Path sessionDir = projectKey.resolve("sess-abc");
        Files.createDirectories(sessionDir);

        String summary = """
                {
                  "info": { "id": "sess-abc", "cwd": "/proj/demo" },
                  "generated_title": "Demo session",
                  "current_model_id": "grok-4.5",
                  "created_at": "2026-07-11T08:16:08.194019Z",
                  "updated_at": "2026-07-11T09:00:00.000000Z",
                  "num_chat_messages": 4
                }
                """;
        Files.writeString(sessionDir.resolve("summary.json"), summary, StandardCharsets.UTF_8);

        Path ledgerFile = Files.createTempDirectory("grok-ledger2").resolve("l.jsonl");
        GrokUsageLedger ledger = new GrokUsageLedger(ledgerFile);
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 100);
        usage.addProperty("output_tokens", 50);
        usage.addProperty("total_tokens", 150);
        ledger.record("sess-abc", "grok-4.5", "/proj/demo", usage);

        GrokHistoryReader reader = new GrokHistoryReader(root, new Gson());
        GrokUsageAggregator agg = new GrokUsageAggregator(reader, ledger);
        GrokUsageAggregator.ProjectStatistics stats = agg.getProjectStatistics("/proj/demo", 0);

        assertEquals(1, stats.totalSessions);
        assertEquals("grok-4.5", stats.sessions.get(0).model);
        assertEquals("Demo session", stats.sessions.get(0).summary);
        assertEquals(150, stats.totalUsage.totalTokens);
        assertEquals(100, stats.totalUsage.inputTokens);
        assertTrue(stats.tokensFromLedger);
        assertFalse(stats.byModel.isEmpty());
        assertEquals("grok-4.5", stats.byModel.get(0).model);
        assertTrue(stats.activityNote.toLowerCase().contains("ledger"));
    }

    @Test
    public void ledgerOnlySessionAppearsInAllScope() throws Exception {
        Path root = Files.createTempDirectory("grok-agg-ledger-only");
        Path ledgerFile = Files.createTempDirectory("grok-ledger3").resolve("l.jsonl");
        GrokUsageLedger ledger = new GrokUsageLedger(ledgerFile);
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 10);
        usage.addProperty("output_tokens", 5);
        ledger.record("only-in-ledger", "grok-build", "/x", usage);

        GrokHistoryReader reader = new GrokHistoryReader(root, new Gson());
        GrokUsageAggregator agg = new GrokUsageAggregator(reader, ledger);
        GrokUsageAggregator.ProjectStatistics stats = agg.getProjectStatistics("all", 0);

        assertEquals(1, stats.totalSessions);
        assertEquals("only-in-ledger", stats.sessions.get(0).sessionId);
        assertEquals(15, stats.totalUsage.totalTokens);
    }
}
