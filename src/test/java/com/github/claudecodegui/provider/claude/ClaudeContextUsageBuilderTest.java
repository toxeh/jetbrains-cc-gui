package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.*;

public class ClaudeContextUsageBuilderTest {

    // -----------------------------------------------------------------------
    // build() tests
    // -----------------------------------------------------------------------

    @Test
    public void buildSynthesizesConversationAndFreeSpace() {
        JsonObject data = ClaudeContextUsageBuilder.build(50_000, 200_000, "claude-opus-4-5");

        assertTrue(data.get("success").getAsBoolean());
        assertEquals(50_000, data.get("totalTokens").getAsInt());
        assertEquals(200_000, data.get("maxTokens").getAsInt());
        assertEquals(200_000, data.get("rawMaxTokens").getAsInt());
        assertEquals(25.0, data.get("percentage").getAsDouble(), 0.01);
        assertEquals("claude-opus-4-5", data.get("model").getAsString());
        assertEquals(2, data.getAsJsonArray("categories").size());
        assertEquals("Conversation", data.getAsJsonArray("categories").get(0).getAsJsonObject().get("name").getAsString());
        assertEquals(50_000, data.getAsJsonArray("categories").get(0).getAsJsonObject().get("tokens").getAsInt());
        assertEquals(150_000, data.getAsJsonArray("categories").get(1).getAsJsonObject().get("tokens").getAsInt());
        assertFalse(data.get("isAutoCompactEnabled").getAsBoolean());
        assertTrue(data.getAsJsonArray("mcpTools").isEmpty());
        assertTrue(data.getAsJsonArray("memoryFiles").isEmpty());
        assertTrue(data.getAsJsonArray("agents").isEmpty());
    }

    @Test
    public void buildHasClaudeSynthesizedSource() {
        JsonObject data = ClaudeContextUsageBuilder.build(10_000, 100_000, "claude-sonnet-4-5");
        assertEquals("claude-synthesized", data.get("source").getAsString());
    }

    @Test
    public void buildClampsUsedAboveMax() {
        JsonObject data = ClaudeContextUsageBuilder.build(999_999, 100_000, "claude");
        assertEquals(100_000, data.get("totalTokens").getAsInt());
        assertEquals(0, data.getAsJsonArray("categories").get(1).getAsJsonObject().get("tokens").getAsInt());
        assertEquals(100.0, data.get("percentage").getAsDouble(), 0.01);
    }

    @Test
    public void buildHandlesZeroUsage() {
        JsonObject data = ClaudeContextUsageBuilder.build(0, 500_000, "claude-haiku-3-5");
        assertEquals(0, data.get("totalTokens").getAsInt());
        assertEquals(0.0, data.get("percentage").getAsDouble(), 0.01);
        assertEquals(500_000, data.getAsJsonArray("categories").get(1).getAsJsonObject().get("tokens").getAsInt());
    }

    @Test
    public void buildHandlesNullModel() {
        JsonObject data = ClaudeContextUsageBuilder.build(1_000, 100_000, null);
        assertEquals("", data.get("model").getAsString());
    }

    @Test
    public void buildGridRowsPopulated() {
        JsonObject data = ClaudeContextUsageBuilder.build(50_000, 200_000, "claude-opus-4-5");
        assertEquals(1, data.getAsJsonArray("gridRows").size());
        assertEquals(2, data.getAsJsonArray("gridRows").get(0).getAsJsonArray().size());
    }

    @Test
    public void buildFreeSpaceCategoryColorIsInactive() {
        JsonObject data = ClaudeContextUsageBuilder.build(50_000, 200_000, "claude-opus-4-5");
        assertEquals("inactive", data.getAsJsonArray("categories").get(1).getAsJsonObject().get("color").getAsString());
    }

    @Test
    public void buildConversationCategoryColorIsClaude() {
        JsonObject data = ClaudeContextUsageBuilder.build(50_000, 200_000, "claude-opus-4-5");
        assertEquals("claude", data.getAsJsonArray("categories").get(0).getAsJsonObject().get("color").getAsString());
    }

    // -----------------------------------------------------------------------
    // extractUsedTokens() tests — Claude usage format
    // -----------------------------------------------------------------------

    @Test
    public void extractUsedTokensSumsClaudeUsageFields() {
        // Claude: input + cache_creation + cache_read + output
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 5_000);
        usage.addProperty("cache_creation_input_tokens", 30_000);
        usage.addProperty("cache_read_input_tokens", 10_000);
        usage.addProperty("output_tokens", 5_000);
        assertEquals(50_000, ClaudeContextUsageBuilder.extractUsedTokens(usage));
    }

    @Test
    public void extractUsedTokensHandlesInputAndOutputOnly() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 10_000);
        usage.addProperty("output_tokens", 2_000);
        assertEquals(12_000, ClaudeContextUsageBuilder.extractUsedTokens(usage));
    }

    @Test
    public void extractUsedTokensNullSafe() {
        assertEquals(0, ClaudeContextUsageBuilder.extractUsedTokens(null));
        assertEquals(0, ClaudeContextUsageBuilder.extractUsedTokens(new JsonObject()));
    }

    @Test
    public void extractUsedTokensCacheOnlyNoOutput() {
        // cache fields present, output_tokens intentionally absent
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 0);
        usage.addProperty("cache_creation_input_tokens", 40_000);
        usage.addProperty("cache_read_input_tokens", 10_000);
        // output_tokens intentionally absent
        assertEquals(50_000, ClaudeContextUsageBuilder.extractUsedTokens(usage));
    }

    @Test
    public void buildClampsZeroMaxToOne() {
        JsonObject data = ClaudeContextUsageBuilder.build(100, 0, "claude");
        assertEquals(1, data.get("maxTokens").getAsInt());
        assertEquals(0, data.get("rawMaxTokens").getAsInt()); // unclamped original
    }

    @Test
    public void buildRawMaxTokensIsUnclamped() {
        JsonObject data = ClaudeContextUsageBuilder.build(50_000, 200_000, "claude");
        assertEquals(200_000, data.get("rawMaxTokens").getAsInt());
        // also verify it's distinct from clamped max when maxTokens was 0
        JsonObject data2 = ClaudeContextUsageBuilder.build(0, 0, "claude");
        assertEquals(0, data2.get("rawMaxTokens").getAsInt());
        assertEquals(1, data2.get("maxTokens").getAsInt());
    }
}
