package com.github.claudecodegui.provider.gemini;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class GeminiPlanUsageServiceTest {

    @Test
    public void normalizeQuotaMap_splitsGeminiAndThirdPartyFamilies() {
        JsonObject quota = JsonParser.parseString("""
                {
                  "gemini-weekly": {
                    "remaining_fraction": 0.90,
                    "reset_time": "2026-08-11T23:37:11Z"
                  },
                  "gemini-5h": {
                    "remaining_fraction": 0.75,
                    "reset_time": "2026-08-05T18:15:50Z"
                  },
                  "3p-weekly": {
                    "remaining_fraction": 0.50,
                    "reset_time": "2026-08-06T02:22:27Z"
                  },
                  "3p-5h": {
                    "remaining_fraction": 0.25,
                    "reset_time": "2026-08-05T18:55:52Z"
                  }
                }
                """).getAsJsonObject();

        JsonObject out = GeminiPlanUsageService.normalizeQuotaMap(quota, "user@example.com");
        assertTrue(out.get("present").getAsBoolean());
        assertEquals("gemini", out.get("provider").getAsString());
        assertEquals("agy-statusline", out.get("source").getAsString());
        assertEquals("gemini", out.get("default_family").getAsString());
        // top-level mirrors default (gemini) family — 5h primary
        assertEquals(25.0, out.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("5h", out.get("period_type").getAsString());
        assertEquals("user@example.com", out.get("worker_id").getAsString());

        JsonObject families = out.getAsJsonObject("families");
        assertTrue(families.has("gemini"));
        assertTrue(families.has("third_party"));

        JsonObject gem = families.getAsJsonObject("gemini");
        assertEquals(25.0, gem.get("capacity_pct").getAsDouble(), 0.01);
        JsonArray gemWindows = gem.getAsJsonArray("windows");
        assertEquals(2, gemWindows.size());
        assertEquals("5h", gemWindows.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals(25.0, gemWindows.get(0).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
        assertEquals("7d", gemWindows.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals(10.0, gemWindows.get(1).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);

        JsonObject tp = families.getAsJsonObject("third_party");
        assertEquals(75.0, tp.get("capacity_pct").getAsDouble(), 0.01);
        JsonArray tpWindows = tp.getAsJsonArray("windows");
        assertEquals(2, tpWindows.size());
        assertEquals("5h", tpWindows.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals(75.0, tpWindows.get(0).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
        assertEquals("7d", tpWindows.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals(50.0, tpWindows.get(1).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);

        // top-level windows also only 5h/7d (gemini family)
        JsonArray topWindows = out.getAsJsonArray("windows");
        assertEquals(2, topWindows.size());
        assertEquals("5h", topWindows.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals("7d", topWindows.get(1).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void familyFromBucketId_classifiesGeminiVsThirdParty() {
        assertEquals("gemini", GeminiPlanUsageService.familyFromBucketId("gemini-5h"));
        assertEquals("gemini", GeminiPlanUsageService.familyFromBucketId("gemini-weekly"));
        assertEquals("third_party", GeminiPlanUsageService.familyFromBucketId("3p-5h"));
        assertEquals("third_party", GeminiPlanUsageService.familyFromBucketId("3p-weekly"));
        assertEquals("third_party", GeminiPlanUsageService.familyFromBucketId("claude-bucket"));
    }

    @Test
    public void normalizeQuotaMap_emptyIsUnavailable() {
        JsonObject out = GeminiPlanUsageService.normalizeQuotaMap(new JsonObject(), null);
        assertFalse(out.get("present").getAsBoolean());
        assertTrue(out.get("message").getAsString().length() > 0);
    }
}
