package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/** Reads Grok CLI session history from {@code ~/.grok/sessions}. */
public class GrokHistoryReader {

    private static final Logger LOG = Logger.getInstance(GrokHistoryReader.class);
    private final Gson gson;
    private final Path sessionsRoot;

    public GrokHistoryReader() {
        this(Paths.get(NodeDetector.resolveHomeForFileOps(), ".grok", "sessions"), new Gson());
    }

    GrokHistoryReader(Path sessionsRoot, Gson gson) {
        this.sessionsRoot = sessionsRoot;
        this.gson = gson;
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
    }

    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = listSessionsForProject(projectPath);
            int totalMessages = sessions.stream().mapToInt(s -> s.messageCount).sum();
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("total", totalMessages);
            result.put("sessionCount", sessions.size());
            result.put("currentProject", projectPath);
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[GrokHistoryReader] list failed: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Grok sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    public String getSessionMessagesAsJson(String sessionId) {
        return gson.toJson(getSessionMessages(sessionId));
    }

    public List<JsonObject> getSessionMessages(String sessionId) {
        List<JsonObject> out = new ArrayList<>();
        Path sessionDir = findSessionDir(sessionId);
        if (sessionDir == null) {
            return out;
        }
        Path chatHistory = sessionDir.resolve("chat_history.jsonl");
        if (!Files.isRegularFile(chatHistory)) {
            return out;
        }
        try (BufferedReader reader = Files.newBufferedReader(chatHistory, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                try {
                    JsonObject envelope = toFrontendEnvelope(JsonParser.parseString(line).getAsJsonObject());
                    if (envelope != null) {
                        out.add(envelope);
                    }
                } catch (Exception ignored) {
                    // skip bad line
                }
            }
        } catch (IOException e) {
            LOG.error("[GrokHistoryReader] read failed: " + e.getMessage(), e);
        }
        return out;
    }

    public boolean deleteSession(String sessionId) {
        Path sessionDir = findSessionDir(sessionId);
        if (sessionDir == null) {
            return false;
        }
        try (Stream<Path> walk = Files.walk(sessionDir)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    List<SessionInfo> listSessionsForProject(String projectPath) throws IOException {
        String normalizedProject = normalizePath(projectPath);
        if (!Files.isDirectory(sessionsRoot)) {
            return List.of();
        }
        List<SessionInfo> sessions = new ArrayList<>();
        try (Stream<Path> cwdGroups = Files.list(sessionsRoot)) {
            for (Path cwdGroup : cwdGroups.filter(Files::isDirectory).toList()) {
                try (Stream<Path> sessionDirs = Files.list(cwdGroup)) {
                    for (Path sessionDir : sessionDirs.filter(Files::isDirectory).toList()) {
                        SessionInfo info = readSessionInfo(sessionDir);
                        if (info == null || info.cwd == null || info.cwd.isEmpty()) {
                            continue;
                        }
                        String normalizedCwd = normalizePath(info.cwd);
                        if (normalizedCwd.equals(normalizedProject)
                                || normalizedCwd.startsWith(normalizedProject + "/")) {
                            sessions.add(info);
                        }
                    }
                }
            }
        }
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    private SessionInfo readSessionInfo(Path sessionDir) {
        Path summaryFile = sessionDir.resolve("summary.json");
        if (!Files.isRegularFile(summaryFile)) {
            return null;
        }
        try {
            JsonObject summary = JsonParser.parseString(
                    Files.readString(summaryFile, StandardCharsets.UTF_8)).getAsJsonObject();
            SessionInfo info = new SessionInfo();
            if (summary.has("info") && summary.get("info").isJsonObject()) {
                JsonObject meta = summary.getAsJsonObject("info");
                if (meta.has("id")) {
                    info.sessionId = meta.get("id").getAsString();
                }
                if (meta.has("cwd")) {
                    info.cwd = meta.get("cwd").getAsString();
                }
            }
            if (info.sessionId == null || info.sessionId.isEmpty()) {
                info.sessionId = sessionDir.getFileName().toString();
            }
            if (summary.has("generated_title")) {
                info.title = summary.get("generated_title").getAsString();
            }
            if ((info.title == null || info.title.isBlank()) && summary.has("session_summary")) {
                info.title = summary.get("session_summary").getAsString();
            }
            if (info.title == null || info.title.isBlank()) {
                info.title = info.sessionId;
            }
            info.title = formatSessionTitlePreview(stripUserQueryWrapper(info.title), 40);
            if (info.title.isBlank()) {
                info.title = info.sessionId;
            }
            if (summary.has("num_chat_messages")) {
                info.messageCount = summary.get("num_chat_messages").getAsInt();
            } else if (summary.has("num_messages")) {
                info.messageCount = summary.get("num_messages").getAsInt();
            }
            info.firstTimestamp = parseIsoMillis(summary, "created_at");
            info.lastTimestamp = parseIsoMillis(summary, "updated_at");
            if (info.lastTimestamp == 0) {
                info.lastTimestamp = parseIsoMillis(summary, "last_active_at");
            }
            try {
                info.fileSize = Files.size(summaryFile);
            } catch (IOException ignored) {
                info.fileSize = 0;
            }
            return info;
        } catch (Exception e) {
            return null;
        }
    }

    Path findSessionDir(String sessionId) {
        if (sessionId == null || sessionId.isBlank() || !Files.isDirectory(sessionsRoot)) {
            return null;
        }
        try (Stream<Path> dirs = Files.walk(sessionsRoot, 2)) {
            return dirs.filter(Files::isDirectory)
                    .filter(p -> p.getFileName().toString().equals(sessionId))
                    .filter(p -> Files.isRegularFile(p.resolve("summary.json")))
                    .findFirst()
                    .orElse(null);
        } catch (IOException e) {
            return null;
        }
    }

    private static long parseIsoMillis(JsonObject summary, String field) {
        if (!summary.has(field)) {
            return 0;
        }
        try {
            return Instant.parse(summary.get(field).getAsString()).toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }

    static String normalizePath(String path) {
        if (path == null) {
            return "";
        }
        String normalized = path.replace('\\', '/');
        while (normalized.endsWith("/") && normalized.length() > 1) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    static JsonObject toFrontendEnvelope(JsonObject row) {
        if (row == null || !row.has("type")) {
            return null;
        }
        String type = row.get("type").getAsString();
        if ("system".equals(type) || "reasoning".equals(type)) {
            return null;
        }
        if ("user".equals(type)) {
            String text = stripUserQueryWrapper(extractUserText(row));
            if (text == null || text.isBlank() || shouldSkipUserText(text)) {
                return null;
            }
            return textEnvelope("user", text);
        }
        if ("assistant".equals(type)) {
            return assistantEnvelope(row);
        }
        if ("tool_result".equals(type)) {
            JsonObject envelope = new JsonObject();
            envelope.addProperty("type", "user");
            JsonObject message = new JsonObject();
            message.addProperty("role", "user");
            JsonArray content = new JsonArray();
            JsonObject block = new JsonObject();
            block.addProperty("type", "tool_result");
            if (row.has("tool_call_id")) {
                block.addProperty("tool_use_id", row.get("tool_call_id").getAsString());
            }
            if (row.has("content")) {
                block.addProperty("content", elementToString(row.get("content")));
            }
            content.add(block);
            message.add("content", content);
            envelope.add("message", message);
            return envelope;
        }
        return null;
    }

    private static JsonObject textEnvelope(String role, String text) {
        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", role);
        JsonObject message = new JsonObject();
        message.addProperty("role", role);
        JsonArray content = new JsonArray();
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", text);
        content.add(textBlock);
        message.add("content", content);
        envelope.add("message", message);
        return envelope;
    }

    static JsonObject assistantEnvelope(JsonObject row) {
        if (row == null) {
            return null;
        }
        JsonArray contentBlocks = new JsonArray();
        String text = extractAssistantPlainText(row);
        if (!text.isBlank() && !isSyntheticToolSummary(text)) {
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", text);
            contentBlocks.add(textBlock);
        }
        if (row.has("tool_calls") && row.get("tool_calls").isJsonArray()) {
            appendToolUseBlocks(contentBlocks, row.getAsJsonArray("tool_calls"));
        }
        if (contentBlocks.isEmpty()) {
            // Legacy rows stored only "Tool: foo, bar" with no structured tool_calls — hide from UI.
            if (!text.isBlank() && isSyntheticToolSummary(text)) {
                return null;
            }
            return null;
        }
        JsonObject envelope = new JsonObject();
        envelope.addProperty("type", "assistant");
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        message.add("content", contentBlocks);
        envelope.add("message", message);
        return envelope;
    }

    private static String extractAssistantPlainText(JsonObject row) {
        if (!row.has("content")) {
            return "";
        }
        JsonElement contentEl = row.get("content");
        if (contentEl.isJsonPrimitive()) {
            return contentEl.getAsString();
        }
        if (contentEl.isJsonArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonElement el : contentEl.getAsJsonArray()) {
                if (el.isJsonObject()) {
                    JsonObject block = el.getAsJsonObject();
                    if (block.has("type") && "text".equals(block.get("type").getAsString()) && block.has("text")) {
                        if (!sb.isEmpty()) {
                            sb.append("\n");
                        }
                        sb.append(block.get("text").getAsString());
                    }
                }
            }
            return sb.toString();
        }
        return "";
    }

    static boolean isSyntheticToolSummary(String text) {
        if (text == null || text.isBlank()) {
            return false;
        }
        for (String line : text.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            if (!trimmed.startsWith("Tool:")) {
                return false;
            }
        }
        return true;
    }

    private static void appendToolUseBlocks(JsonArray contentBlocks, JsonArray toolCalls) {
        for (JsonElement el : toolCalls) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject call = el.getAsJsonObject();
            if (!call.has("name")) {
                continue;
            }
            JsonObject toolUse = new JsonObject();
            toolUse.addProperty("type", "tool_use");
            String id = call.has("id") && !call.get("id").isJsonNull()
                    ? call.get("id").getAsString()
                    : (call.has("tool_call_id") && !call.get("tool_call_id").isJsonNull()
                    ? call.get("tool_call_id").getAsString()
                    : "tool-" + contentBlocks.size());
            toolUse.addProperty("id", id);
            toolUse.addProperty("name", call.get("name").getAsString());
            toolUse.add("input", parseToolCallArguments(call));
            contentBlocks.add(toolUse);
        }
    }

    private static JsonObject parseToolCallArguments(JsonObject call) {
        JsonObject input = new JsonObject();
        if (!call.has("arguments")) {
            return input;
        }
        JsonElement argsEl = call.get("arguments");
        if (argsEl.isJsonObject()) {
            return argsEl.getAsJsonObject();
        }
        if (argsEl.isJsonPrimitive()) {
            String raw = argsEl.getAsString();
            if (raw == null || raw.isBlank()) {
                return input;
            }
            try {
                JsonElement parsed = JsonParser.parseString(raw);
                if (parsed.isJsonObject()) {
                    return parsed.getAsJsonObject();
                }
            } catch (Exception ignored) {
                input.addProperty("value", raw);
            }
        }
        return input;
    }

    private static String extractUserText(JsonObject row) {
        if (!row.has("content")) {
            return "";
        }
        JsonElement contentEl = row.get("content");
        if (contentEl.isJsonPrimitive()) {
            return contentEl.getAsString();
        }
        if (!contentEl.isJsonArray()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (JsonElement el : contentEl.getAsJsonArray()) {
            if (el.isJsonObject()) {
                JsonObject block = el.getAsJsonObject();
                if (block.has("type") && "text".equals(block.get("type").getAsString()) && block.has("text")) {
                    if (!sb.isEmpty()) {
                        sb.append("\n");
                    }
                    sb.append(block.get("text").getAsString());
                }
            }
        }
        return sb.toString();
    }

    private static boolean shouldSkipUserText(String text) {
        String trimmed = text.trim();
        if (trimmed.isEmpty()) {
            return true;
        }
        if (trimmed.contains("<user_query>")) {
            return false;
        }
        return trimmed.startsWith("<system-reminder>")
                || trimmed.startsWith("<user_info>")
                || trimmed.startsWith("<task-notification>");
    }

    private static String elementToString(JsonElement el) {
        if (el == null || el.isJsonNull()) {
            return "";
        }
        return el.isJsonPrimitive() ? el.getAsString() : el.toString();
    }

    private static final Pattern USER_QUERY_PATTERN =
            Pattern.compile("<user_query>([\\s\\S]*?)</user_query>", Pattern.CASE_INSENSITIVE);

    static String stripUserQueryWrapper(String text) {
        if (text == null) {
            return "";
        }
        String trimmed = text.trim();
        Matcher matcher = USER_QUERY_PATTERN.matcher(trimmed);
        if (matcher.find()) {
            return matcher.group(1).trim();
        }
        if (trimmed.toLowerCase().startsWith("<user_query>")) {
            String inner = trimmed.substring("<user_query>".length()).trim();
            if (inner.toLowerCase().endsWith("</user_query>")) {
                inner = inner.substring(0, inner.length() - "</user_query>".length()).trim();
            }
            return inner;
        }
        return text;
    }

    static String formatSessionTitlePreview(String text, int maxLen) {
        if (text == null) {
            return "";
        }
        String cleaned = stripUserQueryWrapper(text).replaceAll("\\s+", " ").trim();
        if (cleaned.isEmpty()) {
            return "";
        }
        if (cleaned.length() <= maxLen) {
            return cleaned;
        }
        return cleaned.substring(0, maxLen) + "...";
    }
}
