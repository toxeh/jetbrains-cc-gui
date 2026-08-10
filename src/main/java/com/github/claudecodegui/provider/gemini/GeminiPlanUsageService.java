package com.github.claudecodegui.provider.gemini;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/**
 * Token-free Gemini / Antigravity account quota for ContextBar.
 *
 * <p>Spawns a short-lived {@code agy} TUI process with a temporary statusLine hook.
 * agy authenticates itself; the plugin never reads keychain or OAuth tokens.
 * Statusline JSON {@code quota} map is normalized into the same capacity shape
 * used by Grok/Claude plan-usage UI ({@code capacity_pct} + {@code windows[]}).
 */
public final class GeminiPlanUsageService {

    private static final Logger LOG = Logger.getInstance(GeminiPlanUsageService.class);
    private static final Gson GSON = new Gson();

    private static final long DEFAULT_TIMEOUT_MS = 40_000L;
    private static final long CACHE_TTL_MS = 90_000L;

    private static final AtomicReference<CacheEntry> CACHE = new AtomicReference<>();

    private GeminiPlanUsageService() {
    }

    /**
     * Resolve plan-usage payload. Uses a short in-memory cache to avoid spawning agy
     * on every 2-minute poll when the previous snapshot is still fresh.
     */
    public static JsonObject resolvePlanUsagePayload() {
        CacheEntry cached = CACHE.get();
        long now = System.currentTimeMillis();
        if (cached != null && now - cached.atMs < CACHE_TTL_MS && cached.payload != null) {
            JsonObject copy = cached.payload.deepCopy();
            copy.addProperty("cached", true);
            return copy;
        }
        JsonObject fresh = fetchViaStatusline(DEFAULT_TIMEOUT_MS);
        if (fresh != null && isPresent(fresh)) {
            CACHE.set(new CacheEntry(now, fresh));
            return fresh.deepCopy();
        }
        if (cached != null && cached.payload != null && isPresent(cached.payload)) {
            JsonObject copy = cached.payload.deepCopy();
            copy.addProperty("cached", true);
            copy.addProperty("stale", true);
            return copy;
        }
        if (fresh != null) {
            return fresh;
        }
        return unavailable("Usage unavailable");
    }

    /**
     * Normalize statusline quota buckets into capacity shape.
     *
     * <p>Antigravity exposes two billing families (same as TUI /usage):
     * <ul>
     *   <li>{@code gemini} — "Gemini Models"</li>
     *   <li>{@code third_party} — "Claude and GPT models" (bucket ids {@code 3p-*})</li>
     * </ul>
     * Each family carries only {@code 5h}/{@code 7d} windows so the ContextBar switcher
     * matches Claude (period only). The webview picks a family from the selected model.
     */
    static JsonObject normalizeQuotaMap(JsonObject quota, String email) {
        if (quota == null || quota.entrySet().isEmpty()) {
            return unavailable("No quota in statusline payload");
        }

        Map<String, List<Window>> byFamily = new LinkedHashMap<>();
        byFamily.put("gemini", new ArrayList<>());
        byFamily.put("third_party", new ArrayList<>());

        for (Map.Entry<String, JsonElement> e : quota.entrySet()) {
            if (e.getValue() == null || !e.getValue().isJsonObject()) {
                continue;
            }
            JsonObject q = e.getValue().getAsJsonObject();
            Double remaining = asDouble(q, "remaining_fraction", "remainingFraction");
            if (remaining == null || !Double.isFinite(remaining)) {
                continue;
            }
            double usedPct = clampPct((1.0 - remaining) * 100.0);
            String resetAt = asString(q, "reset_time", "resetTime");
            String bucketId = e.getKey();
            String periodType = periodTypeFromBucketId(bucketId);
            String family = familyFromBucketId(bucketId);
            String windowId = windowIdFromPeriod(periodType);
            if (windowId == null) {
                continue;
            }
            byFamily.computeIfAbsent(family, k -> new ArrayList<>())
                    .add(new Window(windowId, usedPct, resetAt, periodType));
        }

        // Collapse duplicate period keys within a family (keep first = sorted later)
        JsonObject families = new JsonObject();
        JsonObject defaultFamily = null;
        for (Map.Entry<String, List<Window>> fe : byFamily.entrySet()) {
            List<Window> list = fe.getValue();
            if (list.isEmpty()) {
                continue;
            }
            list.sort(Comparator.comparingInt(w -> windowRank(w.periodType)));
            Map<String, Window> unique = new LinkedHashMap<>();
            for (Window w : list) {
                unique.putIfAbsent(w.id, w);
            }
            List<Window> ordered = new ArrayList<>(unique.values());
            JsonObject fam = familyPayload(ordered);
            families.add(fe.getKey(), fam);
            if (defaultFamily == null && "gemini".equals(fe.getKey())) {
                defaultFamily = fam;
            }
            if (defaultFamily == null) {
                defaultFamily = fam;
            }
        }
        if (families.size() == 0 || defaultFamily == null) {
            return unavailable("Quota buckets empty");
        }

        // Top-level mirrors default (gemini) family so parseCapacityPayload works
        // without model context; webview re-binds via families + selected model.
        JsonObject out = defaultFamily.deepCopy();
        out.addProperty("ok", true);
        out.addProperty("present", true);
        out.addProperty("provider", "gemini");
        out.addProperty("source", "agy-statusline");
        out.addProperty("default_family", families.has("gemini") ? "gemini" : families.entrySet().iterator().next().getKey());
        out.add("families", families);
        if (email != null && !email.isBlank()) {
            out.addProperty("worker_id", email.trim());
        }
        return out;
    }

    private static JsonObject familyPayload(List<Window> ordered) {
        Window primary = pickPrimary(ordered);
        JsonObject fam = new JsonObject();
        fam.addProperty("capacity_pct", primary.usedPct);
        if (primary.resetAt != null) {
            fam.addProperty("reset_at", primary.resetAt);
        }
        fam.addProperty("period_type", primary.periodType);
        JsonArray arr = new JsonArray();
        for (Window w : ordered) {
            JsonObject o = new JsonObject();
            o.addProperty("id", w.id);
            o.addProperty("used_pct", w.usedPct);
            if (w.resetAt != null) {
                o.addProperty("reset_at", w.resetAt);
            }
            o.addProperty("period_type", w.periodType);
            arr.add(o);
        }
        fam.add("windows", arr);
        return fam;
    }

    private static Window pickPrimary(List<Window> windows) {
        for (Window w : windows) {
            if ("5h".equals(w.periodType) || "5h".equals(w.id)) {
                return w;
            }
        }
        return windows.get(0);
    }

    /** gemini-* → gemini; 3p-* / claude / gpt → third_party. */
    static String familyFromBucketId(String id) {
        String s = id == null ? "" : id.toLowerCase(Locale.ROOT);
        if (s.contains("3p") || s.contains("claude") || s.contains("gpt") || s.contains("opus") || s.contains("sonnet")) {
            return "third_party";
        }
        return "gemini";
    }

    /** Only 5h / 7d are shown in the bar switcher (Claude-style). */
    private static String windowIdFromPeriod(String periodType) {
        if ("5h".equals(periodType)) {
            return "5h";
        }
        if ("7d".equals(periodType) || "weekly".equals(periodType)) {
            return "7d";
        }
        return null;
    }

    private static int windowRank(String periodType) {
        if ("5h".equals(periodType)) {
            return 0;
        }
        if ("7d".equals(periodType) || "weekly".equals(periodType)) {
            return 1;
        }
        return 2;
    }

    private static String periodTypeFromBucketId(String id) {
        String s = id == null ? "" : id.toLowerCase(Locale.ROOT);
        if (s.contains("5h") || s.contains("five")) {
            return "5h";
        }
        if (s.contains("week") || s.contains("7d")) {
            return "7d";
        }
        if (s.contains("month")) {
            return "monthly";
        }
        return s.isEmpty() ? "limit" : s;
    }

    private static JsonObject fetchViaStatusline(long timeoutMs) {
        String agy = resolveAgyBinary();
        if (agy == null) {
            return unavailable("agy CLI not found");
        }

        Path workDir = null;
        Path settingsPath = null;
        Path backupPath = null;
        Path hookPath = null;
        Path dumpPath = null;
        Process process = null;
        boolean restored = false;
        try {
            workDir = Files.createTempDirectory("agy-plan-usage-");
            Path cliDir = Paths.get(PlatformUtils.getHomeDirectory(), ".gemini", "antigravity-cli");
            Files.createDirectories(cliDir);
            settingsPath = cliDir.resolve("settings.json");
            backupPath = cliDir.resolve("settings.json.bak-plan-usage-plugin");
            hookPath = workDir.resolve("statusline-hook.sh");
            dumpPath = workDir.resolve("last.json");

            writeHookScript(hookPath, dumpPath);

            JsonObject prevSettings = readJsonObject(settingsPath);
            if (Files.exists(settingsPath)) {
                Files.copy(settingsPath, backupPath);
            }
            JsonObject next = prevSettings != null ? prevSettings.deepCopy() : new JsonObject();
            JsonObject statusLine = new JsonObject();
            statusLine.addProperty("type", "command");
            statusLine.addProperty("command", hookPath.toAbsolutePath().toString());
            statusLine.addProperty("enabled", true);
            next.add("statusLine", statusLine);
            // Ensure /tmp-like work dirs are trusted if list exists
            writeJson(settingsPath, next);

            // TUI statusline only runs with a PTY. Prefer macOS/BSD `script`.
            ProcessBuilder pb = buildAgyProcess(agy, workDir);
            pb.redirectErrorStream(true);
            mapEnv(pb);
            process = pb.start();

            // Drain stdout so PTY-less process does not block on pipe fill
            Process proc = process;
            Thread drainer = new Thread(() -> drainQuietly(proc), "agy-plan-usage-drain");
            drainer.setDaemon(true);
            drainer.start();

            long deadline = System.currentTimeMillis() + timeoutMs;
            JsonObject payload = null;
            while (System.currentTimeMillis() < deadline) {
                payload = tryReadDump(dumpPath);
                if (payload != null && payload.has("quota") && payload.get("quota").isJsonObject()
                        && payload.getAsJsonObject("quota").size() > 0) {
                    break;
                }
                if (!process.isAlive()) {
                    break;
                }
                try {
                    Thread.sleep(250L);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }

            // best-effort quit
            try {
                if (process.isAlive()) {
                    try (Writer w = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
                        w.write("/quit\n");
                        w.flush();
                    } catch (Exception ignored) {
                    }
                    process.waitFor(2, TimeUnit.SECONDS);
                    if (process.isAlive()) {
                        process.descendants().forEach(ProcessHandle::destroyForcibly);
                        process.destroyForcibly();
                    }
                }
            } catch (Exception ignored) {
            }

            restoreSettings(settingsPath, backupPath);
            restored = true;

            if (payload == null || !payload.has("quota") || !payload.get("quota").isJsonObject()) {
                return unavailable("agy statusline did not report quota (login required?)");
            }
            String email = payload.has("email") && payload.get("email").isJsonPrimitive()
                    ? payload.get("email").getAsString()
                    : null;
            return normalizeQuotaMap(payload.getAsJsonObject("quota"), email);
        } catch (Exception e) {
            LOG.warn("[GeminiPlanUsageService] statusline capture failed: " + e.getMessage());
            return unavailable("Usage unavailable: " + e.getMessage());
        } finally {
            if (!restored && settingsPath != null && backupPath != null) {
                try {
                    restoreSettings(settingsPath, backupPath);
                } catch (Exception ignored) {
                }
            }
            if (process != null && process.isAlive()) {
                try {
                    process.descendants().forEach(ProcessHandle::destroyForcibly);
                } catch (Exception ignored) {
                }
                process.destroyForcibly();
            }
            // leave workDir for debug if dump failed? clean always
            if (workDir != null) {
                deleteRecursiveQuietly(workDir);
            }
            if (backupPath != null) {
                try {
                    Files.deleteIfExists(backupPath);
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static ProcessBuilder buildAgyProcess(String agy, Path workDir) {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        List<String> cmd = new ArrayList<>();
        if (os.contains("mac") || os.contains("darwin") || os.contains("bsd")) {
            // script -q /dev/null <cmd>  → allocate pseudo-TTY
            cmd.add("script");
            cmd.add("-q");
            cmd.add("/dev/null");
            cmd.add(agy);
            cmd.add("--model");
            cmd.add("gemini-3.5-flash-low");
        } else if (os.contains("linux")) {
            cmd.add("script");
            cmd.add("-q");
            cmd.add("-c");
            cmd.add(agy + " --model gemini-3.5-flash-low");
            cmd.add("/dev/null");
        } else {
            cmd.add(agy);
            cmd.add("--model");
            cmd.add("gemini-3.5-flash-low");
        }
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(workDir.toFile());
        return pb;
    }

    private static void mapEnv(ProcessBuilder pb) {
        Map<String, String> env = pb.environment();
        env.put("TERM", "xterm-256color");
        env.put("COLORTERM", "truecolor");
        env.put("CI", "1");
        env.putIfAbsent("NO_COLOR", "1");
    }

    private static void writeHookScript(Path hookPath, Path dumpPath) throws IOException {
        // Dump stdin JSON; emit short stdout for TUI.
        String body = "#!/bin/sh\n"
                + "payload=$(cat)\n"
                + "printf '%s\\n' \"$payload\" > '" + dumpPath.toAbsolutePath() + "'\n";
        Files.writeString(hookPath, body, StandardCharsets.UTF_8);
        hookPath.toFile().setExecutable(true);
    }

    private static JsonObject tryReadDump(Path dumpPath) {
        try {
            if (!Files.isRegularFile(dumpPath) || Files.size(dumpPath) < 2) {
                return null;
            }
            String raw = Files.readString(dumpPath, StandardCharsets.UTF_8).trim();
            if (raw.isEmpty()) {
                return null;
            }
            JsonElement el = JsonParser.parseString(raw);
            return el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static void restoreSettings(Path settingsPath, Path backupPath) throws IOException {
        if (backupPath != null && Files.exists(backupPath)) {
            Files.copy(backupPath, settingsPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            Files.deleteIfExists(backupPath);
            return;
        }
        // No backup: strip statusLine we may have added
        if (settingsPath != null && Files.exists(settingsPath)) {
            JsonObject cur = readJsonObject(settingsPath);
            if (cur != null && cur.has("statusLine")) {
                cur.remove("statusLine");
                writeJson(settingsPath, cur);
            }
        }
    }

    private static JsonObject readJsonObject(Path path) {
        try {
            if (path == null || !Files.isRegularFile(path)) {
                return null;
            }
            String raw = Files.readString(path, StandardCharsets.UTF_8).trim();
            if (raw.isEmpty()) {
                return null;
            }
            JsonElement el = JsonParser.parseString(raw);
            return el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static void writeJson(Path path, JsonObject obj) throws IOException {
        Files.createDirectories(path.getParent());
        Files.writeString(path, GSON.toJson(obj), StandardCharsets.UTF_8);
    }

    private static void drainQuietly(Process proc) {
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
            // Also try writing /quit after a few seconds via stdin if available
            Thread quitter = new Thread(() -> {
                try {
                    Thread.sleep(12_000L);
                    if (proc.isAlive()) {
                        try (Writer w = new OutputStreamWriter(proc.getOutputStream(), StandardCharsets.UTF_8)) {
                            w.write("/quit\n");
                            w.flush();
                        } catch (Exception ignored) {
                        }
                    }
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                }
            }, "agy-plan-usage-quit");
            quitter.setDaemon(true);
            quitter.start();
            while (r.readLine() != null) {
                // discard
            }
        } catch (Exception ignored) {
        }
    }

    private static void deleteRecursiveQuietly(Path root) {
        try {
            if (!Files.exists(root)) {
                return;
            }
            Files.walk(root)
                    .sorted(Comparator.reverseOrder())
                    .forEach(p -> {
                        try {
                            Files.deleteIfExists(p);
                        } catch (Exception ignored) {
                        }
                    });
        } catch (Exception ignored) {
        }
    }

    /**
     * Same discovery rules as {@link com.github.claudecodegui.dependency.DependencyManager}:
     * only {@code agy}, never {@code agy.real}.
     */
    static String resolveAgyBinary() {
        String[] envKeys = {"AGY_PATH", "GEMINI_CLI_PATH", "AGY_CLI_PATH"};
        for (String key : envKeys) {
            String v = System.getenv(key);
            if (v != null && !v.trim().isEmpty()) {
                String path = v.trim();
                if (isForbiddenAgyBinaryName(path)) {
                    break;
                }
                Path p = Paths.get(path);
                if (Files.isExecutable(p)) {
                    return p.toAbsolutePath().toString();
                }
                return null;
            }
        }
        String home = PlatformUtils.getHomeDirectory();
        String[] candidates = {
                home + "/.local/bin/agy",
                home + "/.gemini/antigravity-cli/bin/agy",
                home + "/bin/agy",
                "/usr/local/bin/agy",
                "/opt/homebrew/bin/agy",
        };
        for (String c : candidates) {
            try {
                if (isForbiddenAgyBinaryName(c)) {
                    continue;
                }
                Path p = Paths.get(c);
                if (Files.isExecutable(p)) {
                    return p.toAbsolutePath().toString();
                }
            } catch (Exception ignored) {
            }
        }
        String pathEnv = System.getenv("PATH");
        if (pathEnv != null) {
            for (String dir : pathEnv.split(Pattern.quote(java.io.File.pathSeparator))) {
                if (dir == null || dir.isEmpty()) {
                    continue;
                }
                try {
                    Path p = Paths.get(dir, "agy");
                    if (isForbiddenAgyBinaryName(p.toString())) {
                        continue;
                    }
                    if (Files.isExecutable(p)) {
                        return p.toAbsolutePath().toString();
                    }
                } catch (Exception ignored) {
                }
            }
        }
        return null;
    }

    private static boolean isForbiddenAgyBinaryName(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        String norm = path.replace('\\', '/');
        int slash = norm.lastIndexOf('/');
        String base = slash >= 0 ? norm.substring(slash + 1) : norm;
        return "agy.real".equalsIgnoreCase(base);
    }

    private static JsonObject unavailable(String message) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        o.addProperty("present", false);
        o.addProperty("message", message != null ? message : "Usage unavailable");
        o.addProperty("provider", "gemini");
        o.addProperty("source", "plugin");
        return o;
    }

    private static boolean isPresent(JsonObject o) {
        return o != null
                && o.has("present")
                && o.get("present").isJsonPrimitive()
                && o.get("present").getAsBoolean();
    }

    private static Double asDouble(JsonObject o, String... keys) {
        for (String k : keys) {
            if (o.has(k) && o.get(k).isJsonPrimitive()) {
                try {
                    return o.get(k).getAsDouble();
                } catch (Exception ignored) {
                }
            }
        }
        return null;
    }

    private static String asString(JsonObject o, String... keys) {
        for (String k : keys) {
            if (o.has(k) && o.get(k).isJsonPrimitive()) {
                try {
                    return o.get(k).getAsString();
                } catch (Exception ignored) {
                }
            }
        }
        return null;
    }

    private static double clampPct(double v) {
        if (!Double.isFinite(v)) {
            return 0;
        }
        return Math.max(0, Math.min(100, v));
    }

    private static final class CacheEntry {
        final long atMs;
        final JsonObject payload;

        CacheEntry(long atMs, JsonObject payload) {
            this.atMs = atMs;
            this.payload = payload;
        }
    }

    private static final class Window {
        final String id;
        final double usedPct;
        final String resetAt;
        final String periodType;

        Window(String id, double usedPct, String resetAt, String periodType) {
            this.id = id;
            this.usedPct = usedPct;
            this.resetAt = resetAt;
            this.periodType = periodType;
        }
    }
}
