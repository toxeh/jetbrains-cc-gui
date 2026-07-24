package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class GrokUsageLedgerTest {

    @Test
    public void recordsAndAggregatesBySession() throws Exception {
        Path ledgerFile = Files.createTempDirectory("ledger-test").resolve("usage.jsonl");
        GrokUsageLedger ledger = new GrokUsageLedger(ledgerFile);

        JsonObject u1 = new JsonObject();
        u1.addProperty("input_tokens", 20);
        u1.addProperty("output_tokens", 10);
        ledger.record("s1", "grok-4.5", "/p", u1);

        JsonObject u2 = new JsonObject();
        u2.addProperty("prompt_tokens", 5);
        u2.addProperty("completion_tokens", 3);
        ledger.record("s1", "grok-4.5", "/p", u2);

        Map<String, GrokUsageLedger.SessionTotals> map = ledger.aggregateBySession();
        assertTrue(map.containsKey("s1"));
        assertEquals(25, map.get("s1").inputTokens);
        assertEquals(13, map.get("s1").outputTokens);
        assertEquals(2, map.get("s1").turnCount);
        assertEquals(2, ledger.readAllEntriesForTest().size());
    }

    @Test
    public void ignoresEmptyUsage() throws Exception {
        Path ledgerFile = Files.createTempDirectory("ledger-empty").resolve("usage.jsonl");
        GrokUsageLedger ledger = new GrokUsageLedger(ledgerFile);
        ledger.record("s", "m", "/c", new JsonObject());
        assertTrue(ledger.aggregateBySession().isEmpty());
    }

    @Test
    public void recordsAcpCamelCaseUsage() throws Exception {
        Path ledgerFile = Files.createTempDirectory("ledger-camel").resolve("usage.jsonl");
        GrokUsageLedger ledger = new GrokUsageLedger(ledgerFile);

        JsonObject usage = new JsonObject();
        usage.addProperty("inputTokens", 40);
        usage.addProperty("outputTokens", 10);
        usage.addProperty("totalTokens", 50);
        ledger.record("s-camel", "grok-4.5", "/p", usage);

        Map<String, GrokUsageLedger.SessionTotals> map = ledger.aggregateBySession();
        assertTrue(map.containsKey("s-camel"));
        assertEquals(40, map.get("s-camel").inputTokens);
        assertEquals(10, map.get("s-camel").outputTokens);
        assertEquals(50, map.get("s-camel").totalTokens);
    }
}
