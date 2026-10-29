package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.provider.grok.GrokHistoryReader;
import com.github.claudecodegui.provider.kimi.KimiHistoryReader;
import com.github.claudecodegui.provider.minimax.MiniMaxHistoryReader;
import com.github.claudecodegui.provider.omp.OmpHistoryReader;
import com.github.claudecodegui.provider.opencode.OpenCodeHistoryReader;
import com.github.claudecodegui.provider.pi.PiHistoryReader;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Persists and loads reply translation cache files.
 *
 * <p>The cache is stored per-session at {@code {sessionId}.translated.json} in the directory of
 * that session's transcript. The format is a JSON object mapping SHA-256 hashes of the original
 * English text blocks to objects with {@code russian} and {@code shown} fields.
 *
 * <p>File writes are atomic and serialized per path. Corrupt JSON is renamed to
 * {@code {sessionId}.translated.json.bak} and treated as empty.
 */
public class ReplyTranslationStore {

    private static final Logger LOG = Logger.getInstance(ReplyTranslationStore.class);
    private static final Gson GSON = new Gson();
    private static final Pattern SAFE_SESSION_ID = Pattern.compile("^[A-Za-z0-9._-]+$");

    @FunctionalInterface
    public interface DirectoryResolver {
        Path resolve(String provider, String sessionId);
    }

    private final HandlerContext context;
    private final DirectoryResolver directoryResolver;
    private final OpenCodeHistoryReader openCodeReader;
    private final MiniMaxHistoryReader miniMaxReader;
    private final PiHistoryReader piReader;
    private final OmpHistoryReader ompReader;
    private static final ConcurrentHashMap<Path, Object> FILE_LOCKS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, Object> SESSION_LOCKS = new ConcurrentHashMap<>();

    public ReplyTranslationStore(HandlerContext context) {
        this(context, null);
    }

    ReplyTranslationStore(HandlerContext context, DirectoryResolver customResolver) {
        this(context, customResolver,
                new OpenCodeHistoryReader(),
                new MiniMaxHistoryReader(),
                new PiHistoryReader(),
                new OmpHistoryReader());
    }

    ReplyTranslationStore(HandlerContext context, DirectoryResolver customResolver,
            OpenCodeHistoryReader openCodeReader,
            MiniMaxHistoryReader miniMaxReader, PiHistoryReader piReader, OmpHistoryReader ompReader) {
        this.context = context;
        this.directoryResolver = customResolver != null ? customResolver : this::resolveTranscriptDirectory;
        this.openCodeReader = openCodeReader;
        this.miniMaxReader = miniMaxReader;
        this.piReader = piReader;
        this.ompReader = ompReader;
    }

    public JsonObject load(String provider, String sessionId) {
        if (sessionId != null) {
            sessionId = sessionId.trim();
        }
        if (!isSafeSessionId(sessionId)) {
            return new JsonObject();
        }
        Path transcriptDir = directoryResolver.resolve(provider, sessionId);
        if (transcriptDir == null) {
            return new JsonObject();
        }
        Path cacheFile = transcriptDir.resolve(sessionId + ".translated.json");
        Object lock = lockFor(cacheFile);
        synchronized (lock) {
            return readCacheFile(transcriptDir, cacheFile, sessionId);
        }
    }

    /** Caller holds {@link #lockFor} for {@code cacheFile}. Does not resolve the directory again. */
    private JsonObject readCacheFile(Path transcriptDir, Path cacheFile, String sessionId) {
        if (!Files.exists(cacheFile)) {
            return new JsonObject();
        }
        String content;
        try {
            content = Files.readString(cacheFile, StandardCharsets.UTF_8);
        } catch (IOException e) {
            LOG.warn("[ReplyTranslationStore] Failed to read translation cache for " + sessionId + ": " + e.getMessage());
            return null;
        }
        try {
            JsonElement parsed = JsonParser.parseString(content);
            if (parsed != null && parsed.isJsonObject()) {
                return parsed.getAsJsonObject();
            }
            if (!handleCorruptJson(cacheFile, sessionId, transcriptDir)) {
                return null;
            }
            return new JsonObject();
        } catch (Exception e) {
            LOG.warn("[ReplyTranslationStore] Failed to parse translation cache for " + sessionId + ": " + e.getMessage());
            if (!handleCorruptJson(cacheFile, sessionId, transcriptDir)) {
                return null;
            }
            return new JsonObject();
        }
    }

    public void save(String provider, String sessionId, String hash, String russian, boolean shown) {
        if (sessionId != null) {
            sessionId = sessionId.trim();
        }
        if (!isSafeSessionId(sessionId) || hash == null || hash.isBlank()) {
            return;
        }
        synchronized (sessionLock(provider, sessionId)) {
            Path transcriptDir = directoryResolver.resolve(provider, sessionId);
            if (transcriptDir == null) {
                return;
            }
            Path cacheFile = transcriptDir.resolve(sessionId + ".translated.json");
            Object lock = lockFor(cacheFile);
            synchronized (lock) {
                JsonObject root = readCacheFile(transcriptDir, cacheFile, sessionId);
                if (root == null) {
                    LOG.warn("[ReplyTranslationStore] Refusing to overwrite unreadable cache for " + sessionId);
                    return;
                }
                JsonObject entry = new JsonObject();
                entry.addProperty("russian", russian != null ? russian : "");
                entry.addProperty("shown", shown);
                root.add(hash, entry);
                writeAtomically(transcriptDir, cacheFile, sessionId, root);
            }
        }
    }

    public void setShownAll(String provider, String sessionId, boolean shown) {
        if (sessionId != null) {
            sessionId = sessionId.trim();
        }
        if (!isSafeSessionId(sessionId)) {
            return;
        }
        synchronized (sessionLock(provider, sessionId)) {
            Path transcriptDir = directoryResolver.resolve(provider, sessionId);
            if (transcriptDir == null) {
                return;
            }
            Path cacheFile = transcriptDir.resolve(sessionId + ".translated.json");
            Object lock = lockFor(cacheFile);
            synchronized (lock) {
                JsonObject root = readCacheFile(transcriptDir, cacheFile, sessionId);
                if (root == null || root.isEmpty()) {
                    return;
                }
                for (String key : root.keySet()) {
                    JsonElement elem = root.get(key);
                    if (elem != null && elem.isJsonObject()) {
                        elem.getAsJsonObject().addProperty("shown", shown);
                    }
                }
                writeAtomically(transcriptDir, cacheFile, sessionId, root);
            }
        }
    }

    private void writeAtomically(Path transcriptDir, Path cacheFile, String sessionId, JsonObject root) {
        Path tempFile = null;
        try {
            if (!Files.exists(transcriptDir)) {
                Files.createDirectories(transcriptDir);
            }
            tempFile = Files.createTempFile(transcriptDir, sessionId + "-", ".tmp");
            Files.writeString(tempFile, GSON.toJson(root), StandardCharsets.UTF_8);
            try {
                Files.move(tempFile, cacheFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (Exception atomicEx) {
                Files.move(tempFile, cacheFile, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception e) {
            LOG.warn("[ReplyTranslationStore] Failed to atomically save translation file for " + sessionId + ": " + e.getMessage());
            if (tempFile != null) {
                try {
                    Files.deleteIfExists(tempFile);
                } catch (Exception ignored) {
                }
            }
        }
    }

    private boolean handleCorruptJson(Path cacheFile, String sessionId, Path transcriptDir) {
        try {
            Path bakFile = transcriptDir.resolve(sessionId + ".translated.json.bak");
            Files.move(cacheFile, bakFile, StandardCopyOption.REPLACE_EXISTING);
            LOG.warn("[ReplyTranslationStore] Renamed corrupt cache file to " + bakFile.getFileName());
            return true;
        } catch (Exception e) {
            LOG.warn("[ReplyTranslationStore] Failed to rename corrupt cache file: " + e.getMessage());
            return false;
        }
    }

    static Object lockFor(Path cacheFile) {
        return FILE_LOCKS.computeIfAbsent(cacheFile.toAbsolutePath().normalize(), p -> new Object());
    }

    /** Held for the whole resolve-and-write so a later per-block save cannot land before a blanket write. */
    static Object sessionLock(String provider, String sessionId) {
        String prov = provider == null ? "" : provider.trim().toLowerCase();
        return SESSION_LOCKS.computeIfAbsent(prov + "\0" + sessionId, key -> new Object());
    }

    private static boolean isSafeSessionId(String sessionId) {
        return sessionId != null && SAFE_SESSION_ID.matcher(sessionId.trim()).matches();
    }

    Path resolveTranscriptDirectory(String provider, String sessionId) {
        if (!isSafeSessionId(sessionId)) {
            return null;
        }
        String prov = (provider != null && !provider.trim().isEmpty()) ? provider.trim().toLowerCase() : "claude";
        String sid = sessionId.trim();
        Path result;
        try {
            result = resolveByProvider(prov, sid);
        } catch (Exception e) {
            LOG.warn("[ReplyTranslationStore] Failed to resolve transcript dir for " + prov + "/" + sid + ": " + e.getMessage());
            return null;
        }
        if (result == null) {
            LOG.warn("[ReplyTranslationStore] Could not resolve transcript directory for " + prov + "/" + sid);
        }
        return result;
    }

    private Path resolveByProvider(String prov, String sessionId) throws Exception {
        if ("codex".equals(prov)) {
            try {
                CodexHistoryReader codexReader = new CodexHistoryReader();
                return codexTranscriptDirectory(codexReader.resolveSessionFile(sessionId));
            } catch (Exception ignored) {
                return null;
            }
        }

        if ("grok".equals(prov)) {
            String projectPath = resolveProjectPath();
            GrokHistoryReader grokReader = new GrokHistoryReader();
            return grokTranscriptDirectory(grokReader.resolveSessionDir(sessionId, projectPath));
        }

        if ("kimi".equals(prov)) {
            String projectPath = resolveProjectPath();
            KimiHistoryReader kimiReader = new KimiHistoryReader();
            return kimiTranscriptDirectory(kimiReader.resolveSessionDir(sessionId, projectPath));
        }

        if ("opencode".equals(prov)) {
            if (openCodeReader == null) {
                return null;
            }
            return parentDirectory(openCodeReader.cacheAnchor(sessionId));
        }

        if ("minimax".equals(prov)) {
            if (miniMaxReader == null) {
                return null;
            }
            return miniMaxReader.sessionDirectory(sessionId, resolveProjectPath());
        }

        if ("pi".equals(prov)) {
            if (piReader == null) {
                return null;
            }
            return parentDirectory(piReader.sessionFile(sessionId, resolveProjectPath()));
        }

        if ("omp".equals(prov)) {
            if (ompReader == null) {
                return null;
            }
            return parentDirectory(ompReader.sessionFile(sessionId, resolveProjectPath()));
        }

        if ("claude".equals(prov)) {
            return resolveClaudeTranscriptDirectory(sessionId);
        }

        return null;
    }

    private Path resolveClaudeTranscriptDirectory(String sessionId) {
        String homeDir = NodeDetector.resolveHomeForFileOps();
        Path projectsDir = Paths.get(homeDir, ".claude", "projects");
        return claudeTranscriptDirectory(projectsDir, sessionId, resolveProjectPath());
    }

    private static Path parentDirectory(Path path) {
        return path != null ? path.getParent() : null;
    }

    static Path codexTranscriptDirectory(Path sessionFile) {
        if (sessionFile == null) {
            return null;
        }
        return sessionFile.getParent();
    }

    static Path grokTranscriptDirectory(Path sessionDir) {
        if (sessionDir != null && Files.isDirectory(sessionDir)) {
            return sessionDir;
        }
        return null;
    }

    static Path kimiTranscriptDirectory(Path sessionDir) {
        if (sessionDir == null || !Files.isDirectory(sessionDir)) {
            return null;
        }
        Path wireDir = sessionDir.resolve("agents").resolve("main");
        if (Files.isDirectory(wireDir)) {
            return wireDir;
        }
        return null;
    }

    static Path claudeTranscriptDirectory(Path projectsDir, String sessionId, String projectPath) {
        if (projectsDir == null || !Files.isDirectory(projectsDir) || !isSafeSessionId(sessionId)) {
            return null;
        }
        String trimmed = sessionId.trim();
        if (projectPath != null) {
            for (String projectKey : PathUtils.getSanitizedPathCandidates(projectPath)) {
                Path candidate = projectsDir.resolve(projectKey);
                if (Files.isRegularFile(candidate.resolve(trimmed + ".jsonl"))) {
                    return candidate;
                }
            }
        }
        List<Path> matches = new ArrayList<>();
        try (Stream<Path> stream = Files.walk(projectsDir, 2)) {
            stream.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().equals(trimmed + ".jsonl"))
                    .forEach(matches::add);
        } catch (Exception ignored) {
            return null;
        }
        if (matches.size() == 1) {
            return matches.get(0).getParent();
        }
        return null;
    }

    private String resolveProjectPath() {
        if (context == null) {
            return null;
        }
        try {
            String rawPath = context.resolveEffectiveWorkingDirectory();
            String nodePath = NodeDetector.getInstance().getCachedNodePath();
            return NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        } catch (Exception e) {
            return null;
        }
    }
}
