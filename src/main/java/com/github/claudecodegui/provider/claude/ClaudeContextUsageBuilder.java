package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.util.TokenUsageUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Builds a {@code ContextUsageData}-compatible payload for the Claude provider.
 * Claude only exposes aggregate token usage, so we synthesize: used conversation
 * tokens + free space within the model limit, analogous to {@link com.github.claudecodegui.provider.grok.GrokContextUsageBuilder}.
 */
public final class ClaudeContextUsageBuilder {

    private ClaudeContextUsageBuilder() {
    }

    /**
     * Build a ContextUsageData JSON payload for the /context dialog.
     *
     * @param usedTokens tokens used in the current/last turn (0 if unknown)
     * @param maxTokens  model context window limit
     * @param model      model id for display
     */
    public static JsonObject build(int usedTokens, int maxTokens, String model) {
        int rawMaxTokens = maxTokens; // capture before clamping
        int used = Math.max(0, usedTokens);
        int max = Math.max(1, maxTokens);
        if (used > max) {
            used = max;
        }
        int free = Math.max(0, max - used);
        double percentage = Math.round((100.0 * used / max) * 10.0) / 10.0;

        JsonObject root = new JsonObject();
        root.addProperty("success", true);
        root.addProperty("totalTokens", used);
        root.addProperty("maxTokens", max);
        root.addProperty("rawMaxTokens", rawMaxTokens);
        root.addProperty("percentage", percentage);
        root.addProperty("model", model != null ? model : "");
        root.addProperty("isAutoCompactEnabled", false);
        root.addProperty("source", "claude-synthesized");

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
        row.add(gridCell("claude", used > 0, "Conversation", used, percentage, used > 0 ? (double) used / max : 0.0));
        double freePct = Math.round((100.0 * free / max) * 10.0) / 10.0;
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
        cell.addProperty("percentage", percentage);
        cell.addProperty("squareFullness", squareFullness);
        return cell;
    }

    /**
     * Extract used-token total from a Claude usage JSON object.
     * Delegates to {@link TokenUsageUtils#extractUsedTokens(JsonObject, String)} with provider="claude".
     */
    public static int extractUsedTokens(JsonObject usage) {
        if (usage == null) {
            return 0;
        }
        return TokenUsageUtils.extractUsedTokens(usage, "claude");
    }
}
