package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Builds a {@code ContextUsageData}-compatible payload for the Grok provider.
 * Grok ACP only exposes aggregate token usage (not Claude's category breakdown),
 * so we synthesize: used conversation tokens + free space within the model limit.
 */
public final class GrokContextUsageBuilder {

    private GrokContextUsageBuilder() {
    }

    /**
     * @param usedTokens tokens used in the current/last turn (0 if unknown)
     * @param maxTokens  model context window limit
     * @param model      model id for display
     */
    public static JsonObject build(int usedTokens, int maxTokens, String model) {
        int used = Math.max(0, usedTokens);
        int max = Math.max(1, maxTokens);
        if (used > max) {
            used = max;
        }
        int free = Math.max(0, max - used);
        double percentage = (100.0 * used) / max;

        JsonObject root = new JsonObject();
        root.addProperty("success", true);
        root.addProperty("totalTokens", used);
        root.addProperty("maxTokens", max);
        root.addProperty("rawMaxTokens", max);
        root.addProperty("percentage", Math.round(percentage * 10.0) / 10.0);
        root.addProperty("model", model != null ? model : "");
        root.addProperty("isAutoCompactEnabled", false);
        root.addProperty("source", "grok-synthesized");

        JsonArray categories = new JsonArray();
        JsonObject usedCat = new JsonObject();
        usedCat.addProperty("name", "Conversation");
        usedCat.addProperty("tokens", used);
        usedCat.addProperty("color", "claude");
        categories.add(usedCat);

        JsonObject freeCat = new JsonObject();
        freeCat.addProperty("name", "Free space");
        freeCat.addProperty("tokens", free);
        freeCat.addProperty("color", "inactive");
        categories.add(freeCat);
        root.add("categories", categories);

        // Minimal 1-row grid for the dialog heatmap.
        JsonArray gridRows = new JsonArray();
        JsonArray row = new JsonArray();
        row.add(gridCell("claude", used > 0, "Conversation", used, percentage, used > 0 ? 1.0 : 0.0));
        double freePct = 100.0 - percentage;
        row.add(gridCell("inactive", false, "Free space", free, freePct, free > 0 ? Math.min(1.0, free / (double) max) : 0.0));
        gridRows.add(row);
        root.add("gridRows", gridRows);

        root.add("memoryFiles", new JsonArray());
        root.add("mcpTools", new JsonArray());
        root.add("agents", new JsonArray());

        return root;
    }

    private static JsonObject gridCell(
            String color,
            boolean isFilled,
            String categoryName,
            int tokens,
            double percentage,
            double squareFullness
    ) {
        JsonObject cell = new JsonObject();
        cell.addProperty("color", color);
        cell.addProperty("isFilled", isFilled);
        cell.addProperty("categoryName", categoryName);
        cell.addProperty("tokens", tokens);
        cell.addProperty("percentage", Math.round(percentage * 10.0) / 10.0);
        cell.addProperty("squareFullness", squareFullness);
        return cell;
    }

    /**
     * Extract used-token total from a Grok/ACP usage JSON object.
     */
    public static int extractUsedTokens(JsonObject usage) {
        if (usage == null) {
            return 0;
        }
        if (usage.has("total_tokens") && !usage.get("total_tokens").isJsonNull()) {
            return Math.max(0, usage.get("total_tokens").getAsInt());
        }
        int used = 0;
        if (usage.has("input_tokens") && !usage.get("input_tokens").isJsonNull()) {
            used += usage.get("input_tokens").getAsInt();
        }
        if (usage.has("output_tokens") && !usage.get("output_tokens").isJsonNull()) {
            used += usage.get("output_tokens").getAsInt();
        }
        if (usage.has("prompt_tokens") && !usage.get("prompt_tokens").isJsonNull()) {
            used += usage.get("prompt_tokens").getAsInt();
        }
        if (usage.has("completion_tokens") && !usage.get("completion_tokens").isJsonNull()) {
            used += usage.get("completion_tokens").getAsInt();
        }
        return Math.max(0, used);
    }
}
