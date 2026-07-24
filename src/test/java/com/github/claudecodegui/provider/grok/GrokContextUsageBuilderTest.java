package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.*;

public class GrokContextUsageBuilderTest {

    @Test
    public void buildSynthesizesConversationAndFreeSpace() {
        JsonObject data = GrokContextUsageBuilder.build(50_000, 200_000, "grok-2");

        assertTrue(data.get("success").getAsBoolean());
        assertEquals(50_000, data.get("totalTokens").getAsInt());
        assertEquals(200_000, data.get("maxTokens").getAsInt());
        assertEquals(200_000, data.get("rawMaxTokens").getAsInt());
        assertEquals(25.0, data.get("percentage").getAsDouble(), 0.01);
        assertEquals("grok-2", data.get("model").getAsString());
        assertEquals(2, data.getAsJsonArray("categories").size());
        assertEquals("Conversation", data.getAsJsonArray("categories").get(0).getAsJsonObject().get("name").getAsString());
        assertEquals(50_000, data.getAsJsonArray("categories").get(0).getAsJsonObject().get("tokens").getAsInt());
        assertEquals(150_000, data.getAsJsonArray("categories").get(1).getAsJsonObject().get("tokens").getAsInt());
        assertFalse(data.get("isAutoCompactEnabled").getAsBoolean());
        assertTrue(data.getAsJsonArray("mcpTools").isEmpty());
    }

    @Test
    public void buildClampsUsedAboveMax() {
        JsonObject data = GrokContextUsageBuilder.build(999_999, 100_000, "grok");
        assertEquals(100_000, data.get("totalTokens").getAsInt());
        assertEquals(0, data.getAsJsonArray("categories").get(1).getAsJsonObject().get("tokens").getAsInt());
        assertEquals(100.0, data.get("percentage").getAsDouble(), 0.01);
    }

    @Test
    public void buildHandlesZeroUsage() {
        JsonObject data = GrokContextUsageBuilder.build(0, 500_000, "grok-4.5");
        assertEquals(0, data.get("totalTokens").getAsInt());
        assertEquals(0.0, data.get("percentage").getAsDouble(), 0.01);
        assertEquals(500_000, data.getAsJsonArray("categories").get(1).getAsJsonObject().get("tokens").getAsInt());
    }

    @Test
    public void extractUsedTokensPrefersTotal() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 10);
        usage.addProperty("output_tokens", 5);
        usage.addProperty("total_tokens", 99);
        assertEquals(99, GrokContextUsageBuilder.extractUsedTokens(usage));
    }

    @Test
    public void extractUsedTokensSumsPartsWhenNoTotal() {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 10);
        usage.addProperty("output_tokens", 5);
        assertEquals(15, GrokContextUsageBuilder.extractUsedTokens(usage));
    }

    @Test
    public void extractUsedTokensNullSafe() {
        assertEquals(0, GrokContextUsageBuilder.extractUsedTokens(null));
        assertEquals(0, GrokContextUsageBuilder.extractUsedTokens(new JsonObject()));
    }

    @Test
    public void extractUsedTokensAcceptsAcpCamelCase() {
        JsonObject usage = new JsonObject();
        usage.addProperty("totalTokens", 12_345);
        usage.addProperty("inputTokens", 1);
        assertEquals(12_345, GrokContextUsageBuilder.extractUsedTokens(usage));
    }

    @Test
    public void extractUsedTokensSumsAcpPartsWithoutTotal() {
        JsonObject usage = new JsonObject();
        usage.addProperty("inputTokens", 100);
        usage.addProperty("outputTokens", 20);
        usage.addProperty("thoughtTokens", 5);
        assertEquals(125, GrokContextUsageBuilder.extractUsedTokens(usage));
    }

    @Test
    public void normalizeUsageToSnakeCaseMapsCamelCase() {
        JsonObject usage = new JsonObject();
        usage.addProperty("totalTokens", 50);
        usage.addProperty("inputTokens", 40);
        usage.addProperty("outputTokens", 10);
        JsonObject out = GrokContextUsageBuilder.normalizeUsageToSnakeCase(usage);
        assertNotNull(out);
        assertEquals(50, out.get("total_tokens").getAsInt());
        assertEquals(40, out.get("input_tokens").getAsInt());
        assertEquals(10, out.get("output_tokens").getAsInt());
        assertFalse(out.has("totalTokens"));
    }

    @Test
    public void normalizeUsagePrefersSnakeCaseWhenBothPresent() {
        JsonObject usage = new JsonObject();
        usage.addProperty("total_tokens", 99);
        usage.addProperty("totalTokens", 1);
        usage.addProperty("input_tokens", 80);
        usage.addProperty("inputTokens", 2);
        JsonObject out = GrokContextUsageBuilder.normalizeUsageToSnakeCase(usage);
        assertNotNull(out);
        assertEquals(99, out.get("total_tokens").getAsInt());
        assertEquals(80, out.get("input_tokens").getAsInt());
    }
}
