package com.github.claudecodegui.handler;

import com.github.claudecodegui.provider.minimax.MiniMaxHistoryReader;
import com.github.claudecodegui.provider.omp.OmpHistoryReader;
import com.github.claudecodegui.provider.opencode.OpenCodeHistoryReader;
import com.github.claudecodegui.provider.pi.PiHistoryReader;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public class ReplyTranslationStoreTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    @Test
    public void loadMissingFileReturnsEmptyObject() {
        Path dir = tempFolder.getRoot().toPath();
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> dir);

        JsonObject entries = store.load("claude", "session-123");
        assertNotNull(entries);
        assertTrue(entries.isEmpty());
    }

    @Test
    public void saveAndLoadRoundTrip() {
        Path dir = tempFolder.getRoot().toPath();
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> dir);

        store.save("claude", "session-123", "hash1", "Привет, мир!", true);

        JsonObject loaded = store.load("claude", "session-123");
        assertEquals(1, loaded.size());
        assertTrue(loaded.has("hash1"));
        JsonObject entry = loaded.getAsJsonObject("hash1");
        assertEquals("Привет, мир!", entry.get("russian").getAsString());
        assertTrue(entry.get("shown").getAsBoolean());

        // Update entry with shown: false
        store.save("claude", "session-123", "hash1", "Привет, мир!", false);
        JsonObject reloaded = store.load("claude", "session-123");
        assertEquals(1, reloaded.size());
        assertEquals("Привет, мир!", reloaded.getAsJsonObject("hash1").get("russian").getAsString());
        assertFalse(reloaded.getAsJsonObject("hash1").get("shown").getAsBoolean());

        // Add second entry
        store.save("claude", "session-123", "hash2", "Второй блок", true);
        JsonObject twoEntries = store.load("claude", "session-123");
        assertEquals(2, twoEntries.size());
        assertEquals("Второй блок", twoEntries.getAsJsonObject("hash2").get("russian").getAsString());
    }

    @Test
    public void setShownAllUpdatesEveryEntryWithoutDeletingRussian() {
        Path dir = tempFolder.getRoot().toPath();
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> dir);

        store.save("claude", "session-1", "h1", "Русский 1", true);
        store.save("claude", "session-1", "h2", "Русский 2", true);

        store.setShownAll("claude", "session-1", false);

        JsonObject allFalse = store.load("claude", "session-1");
        assertEquals(2, allFalse.size());
        assertEquals("Русский 1", allFalse.getAsJsonObject("h1").get("russian").getAsString());
        assertFalse(allFalse.getAsJsonObject("h1").get("shown").getAsBoolean());
        assertEquals("Русский 2", allFalse.getAsJsonObject("h2").get("russian").getAsString());
        assertFalse(allFalse.getAsJsonObject("h2").get("shown").getAsBoolean());

        store.setShownAll("claude", "session-1", true);

        JsonObject allTrue = store.load("claude", "session-1");
        assertTrue(allTrue.getAsJsonObject("h1").get("shown").getAsBoolean());
        assertTrue(allTrue.getAsJsonObject("h2").get("shown").getAsBoolean());
    }

    @Test
    public void corruptJsonIsRenamedToBakAndTreatedAsEmpty() throws IOException {
        Path dir = tempFolder.getRoot().toPath();
        Path cacheFile = dir.resolve("corrupt-session.translated.json");
        Path bakFile = dir.resolve("corrupt-session.translated.json.bak");
        Files.writeString(cacheFile, "INVALID JSON DATA {{{", StandardCharsets.UTF_8);

        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> dir);

        JsonObject entries = store.load("claude", "corrupt-session");
        assertNotNull(entries);
        assertTrue(entries.isEmpty());

        assertFalse("Original corrupt file should have been moved", Files.exists(cacheFile));
        assertTrue("Corrupt file should be renamed to .bak", Files.exists(bakFile));
        assertEquals("INVALID JSON DATA {{{", Files.readString(bakFile, StandardCharsets.UTF_8));
    }

    @Test
    public void nonJsonObjectContentIsRenamedToBak() throws IOException {
        Path dir = tempFolder.getRoot().toPath();
        Path cacheFile = dir.resolve("array-session.translated.json");
        Path bakFile = dir.resolve("array-session.translated.json.bak");
        Files.writeString(cacheFile, "[\"not\", \"a\", \"json\", \"object\"]", StandardCharsets.UTF_8);

        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> dir);

        JsonObject entries = store.load("claude", "array-session");
        assertNotNull(entries);
        assertTrue(entries.isEmpty());
        assertTrue("Array cache file should be renamed to .bak", Files.exists(bakFile));
    }

    @Test
    public void unsafeSessionIdIsRejected() {
        Path dir = tempFolder.getRoot().toPath();
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> dir);

        assertTrue(store.load("claude", "../../etc/passwd").isEmpty());
        store.save("claude", "../../etc/passwd", "h", "ru", true);
        assertFalse(Files.exists(dir.resolve("../../etc/passwd.translated.json")));
    }

    @Test
    public void nullDirectoryResolverReturnsEmpty() {
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> null);
        assertTrue(store.load("claude", "session-1").isEmpty());
        store.save("claude", "session-1", "h", "ru", true);
        store.setShownAll("claude", "session-1", false);
    }

    @Test
    public void sessionIdWithWhitespaceIsTrimmed() {
        Path dir = tempFolder.getRoot().toPath();
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> dir);

        store.save("claude", "  session-trim  ", "h1", "Привет", true);
        JsonObject loaded = store.load("claude", "session-trim");
        assertEquals(1, loaded.size());
        assertTrue(loaded.has("h1"));
        assertEquals("Привет", loaded.getAsJsonObject("h1").get("russian").getAsString());

        store.setShownAll("claude", "  session-trim  ", false);
        JsonObject afterSetShown = store.load("claude", "session-trim");
        assertFalse(afterSetShown.getAsJsonObject("h1").get("shown").getAsBoolean());
    }

    @Test
    public void resolveTranscriptDirectoryRejectsUnsafeSessionId() {
        ReplyTranslationStore store = new ReplyTranslationStore(null);
        org.junit.Assert.assertNull(store.resolveTranscriptDirectory("claude", "../../../etc/passwd"));
        org.junit.Assert.assertNull(store.resolveTranscriptDirectory("claude", ""));
        org.junit.Assert.assertNull(store.resolveTranscriptDirectory("claude", "   "));
        org.junit.Assert.assertNull(store.resolveTranscriptDirectory("claude", null));
        org.junit.Assert.assertNull(store.resolveTranscriptDirectory("codex", "bad session id!"));
    }

    @Test
    public void saveKeepsExistingEntriesWhenALaterResolveWouldReturnNull() throws IOException {
        Path dir = tempFolder.getRoot().toPath();
        Path cacheFile = dir.resolve("session-123.translated.json");
        Files.writeString(cacheFile, "{\"old\":{\"russian\":\"keep\",\"shown\":true}}", StandardCharsets.UTF_8);
        AtomicInteger calls = new AtomicInteger();
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> calls.incrementAndGet() == 1 ? dir : null);

        store.save("claude", "session-123", "newhash", "Новый", true);

        assertEquals(1, calls.get());
        JsonObject saved = JsonParser.parseString(Files.readString(cacheFile, StandardCharsets.UTF_8)).getAsJsonObject();
        assertEquals("keep", saved.getAsJsonObject("old").get("russian").getAsString());
        assertTrue(saved.getAsJsonObject("old").get("shown").getAsBoolean());
        assertEquals("Новый", saved.getAsJsonObject("newhash").get("russian").getAsString());
        assertTrue(saved.getAsJsonObject("newhash").get("shown").getAsBoolean());
    }

    @Test
    public void unreadableCacheLoadReturnsNull() throws IOException {
        Path dir = tempFolder.getRoot().toPath();
        Path cacheFile = dir.resolve("session-123.translated.json");
        Files.createDirectory(cacheFile);
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> dir);

        assertNull(store.load("claude", "session-123"));
        store.save("claude", "session-123", "h", "Новый", true);
        assertTrue(Files.isDirectory(cacheFile));
    }

    @Test
    public void locksAreSharedAcrossStoreInstancesForTheSameFile() throws IOException {
        Path dir = tempFolder.getRoot().toPath();
        Path cacheFile = dir.resolve("session-123.translated.json");
        assertSame(ReplyTranslationStore.lockFor(cacheFile), ReplyTranslationStore.lockFor(cacheFile));

        ReplyTranslationStore first = new ReplyTranslationStore(null, (p, s) -> dir);
        ReplyTranslationStore second = new ReplyTranslationStore(null, (p, s) -> dir);
        first.save("claude", "session-123", "h1", "Раз", true);
        second.save("claude", "session-123", "h2", "Два", true);

        JsonObject loaded = first.load("claude", "session-123");
        assertEquals(2, loaded.size());
        assertEquals("Раз", loaded.getAsJsonObject("h1").get("russian").getAsString());
        assertEquals("Два", loaded.getAsJsonObject("h2").get("russian").getAsString());
    }

    @Test
    public void codexMissDoesNotFallBackToSessionsRoot() {
        ReplyTranslationStore store = new ReplyTranslationStore(null);
        assertNull(store.resolveTranscriptDirectory("codex", "reply-review-missing-3-2-9f3a"));
    }

    @Test
    public void transcriptDirectoriesFollowTheSessionFileOnly() throws IOException {
        Path codexFile = tempFolder.newFolder("codex", "2026", "10").toPath().resolve("sess.jsonl");
        Files.writeString(codexFile, "{}\n", StandardCharsets.UTF_8);
        assertEquals(codexFile.getParent(), ReplyTranslationStore.codexTranscriptDirectory(codexFile));
        assertNull(ReplyTranslationStore.codexTranscriptDirectory(null));

        Path grokDir = tempFolder.newFolder("grok-session").toPath();
        assertEquals(grokDir, ReplyTranslationStore.grokTranscriptDirectory(grokDir));
        assertNull(ReplyTranslationStore.grokTranscriptDirectory(grokDir.resolve("missing")));

        Path kimiSession = tempFolder.newFolder("kimi-session").toPath();
        assertNull(ReplyTranslationStore.kimiTranscriptDirectory(kimiSession));
        Path wire = kimiSession.resolve("agents").resolve("main");
        Files.createDirectories(wire);
        assertEquals(wire, ReplyTranslationStore.kimiTranscriptDirectory(kimiSession));

        Path projects = tempFolder.newFolder("projects").toPath();
        assertNull(ReplyTranslationStore.claudeTranscriptDirectory(projects, "sess-1", null));
        Path one = projects.resolve("one");
        Path two = projects.resolve("two");
        Files.createDirectories(one);
        Files.createDirectories(two);
        Files.writeString(one.resolve("sess-1.jsonl"), "", StandardCharsets.UTF_8);
        assertEquals(one, ReplyTranslationStore.claudeTranscriptDirectory(projects, "sess-1", null));
        Files.writeString(two.resolve("sess-1.jsonl"), "", StandardCharsets.UTF_8);
        assertNull(ReplyTranslationStore.claudeTranscriptDirectory(projects, "sess-1", null));
    }

    @Test
    public void setShownAllWaitsOutASaveThatStartsWhileTheDirectoryIsStillResolving() throws Exception {
        Path dir = tempFolder.getRoot().toPath();
        Path cacheFile = dir.resolve("session-123.translated.json");
        Files.writeString(cacheFile,
                "{\"h1\":{\"russian\":\"one\",\"shown\":false},\"h2\":{\"russian\":\"two\",\"shown\":false}}",
                StandardCharsets.UTF_8);
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        AtomicBoolean saveFinished = new AtomicBoolean(false);
        ReplyTranslationStore store = new ReplyTranslationStore(null, (p, s) -> {
            if (calls.incrementAndGet() == 1) {
                entered.countDown();
                try {
                    if (!release.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("release timed out");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(e);
                }
            }
            return dir;
        });

        Thread blanket = new Thread(() -> store.setShownAll("claude", "session-123", true));
        blanket.start();
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        Thread perBlock = new Thread(() -> {
            store.save("claude", "session-123", "h2", "two", false);
            saveFinished.set(true);
        });
        perBlock.start();

        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (System.nanoTime() < deadline && calls.get() < 2 && !saveFinished.get()) {
            Thread.sleep(20);
        }
        assertFalse(saveFinished.get());
        release.countDown();
        blanket.join(5000);
        perBlock.join(5000);
        assertFalse(blanket.isAlive());
        assertFalse(perBlock.isAlive());

        JsonObject saved = JsonParser.parseString(Files.readString(cacheFile, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue(saved.getAsJsonObject("h1").get("shown").getAsBoolean());
        assertFalse(saved.getAsJsonObject("h2").get("shown").getAsBoolean());
    }

    @Test
    public void unknownProvidersReturnNull() {
        String id = "2309dc0c-4326-4e78-a027-0a3b349299e1";
        ReplyTranslationStore store = new ReplyTranslationStore(null, null,
                null, null, null, null);

        assertNull(store.resolveTranscriptDirectory("zcode", id));
        assertNull(store.resolveTranscriptDirectory("dsh", id));
        assertNull(store.resolveTranscriptDirectory("nope", id));
    }

    @Test
    public void openCodeSqliteSaveWritesBesideDatabaseNotLegacyJson() throws IOException {
        Path root = tempFolder.newFolder("opencode-sqlite-fixture").toPath();
        Path dbFile = root.resolve("opencode.db");
        Files.writeString(dbFile, "", StandardCharsets.UTF_8);
        Path storage = root.resolve("storage");
        Path legacyJson = storage.resolve("session").resolve("hash").resolve("ses_test123abc.json");
        Files.createDirectories(legacyJson.getParent());
        Files.writeString(legacyJson, "{}", StandardCharsets.UTF_8);

        OpenCodeHistoryReader reader = new OpenCodeHistoryReader(storage, dbFile, new Gson());
        ReplyTranslationStore store = new ReplyTranslationStore(null, null,
                reader, null, null, null);

        store.save("opencode", "ses_test123abc", "hash1", "Привет OpenCode", true);

        Path rootCache = root.resolve("ses_test123abc.translated.json");
        Path legacyCache = legacyJson.getParent().resolve("ses_test123abc.translated.json");
        assertTrue("Cache must be written beside opencode.db", Files.isRegularFile(rootCache));
        assertFalse("Cache must not be written next to legacy json", Files.exists(legacyCache));
        assertEquals("", Files.readString(dbFile, StandardCharsets.UTF_8));
    }

    @Test
    public void openCodeLegacyOnlySaveWritesSiblingCacheAndDuplicateReturnsNull() throws IOException {
        Path root = tempFolder.newFolder("opencode-legacy-fixture").toPath();
        Path storage = root.resolve("storage");
        Path legacyJson = storage.resolve("session").resolve("hash").resolve("ses_test123abc.json");
        Files.createDirectories(legacyJson.getParent());
        Files.writeString(legacyJson, "{}", StandardCharsets.UTF_8);

        Path missingDb = root.resolve("nonexistent-opencode.db");
        OpenCodeHistoryReader reader = new OpenCodeHistoryReader(storage, missingDb, new Gson());
        ReplyTranslationStore store = new ReplyTranslationStore(null, null,
                reader, null, null, null);

        store.save("opencode", "ses_test123abc", "hash1", "Привет legacy", true);

        Path siblingCache = legacyJson.getParent().resolve("ses_test123abc.translated.json");
        assertTrue("Cache must be written beside legacy json", Files.isRegularFile(siblingCache));

        // Two json files with the same name under two hashes: resolve returns null and save creates nothing
        String dupId = "ses_dup123";
        Path dup1 = storage.resolve("session").resolve("hash1").resolve(dupId + ".json");
        Path dup2 = storage.resolve("session").resolve("hash2").resolve(dupId + ".json");
        Files.createDirectories(dup1.getParent());
        Files.createDirectories(dup2.getParent());
        Files.writeString(dup1, "{}", StandardCharsets.UTF_8);
        Files.writeString(dup2, "{}", StandardCharsets.UTF_8);

        assertNull(store.resolveTranscriptDirectory("opencode", dupId));
        store.save("opencode", dupId, "h", "ru", true);
        assertFalse(Files.exists(dup1.getParent().resolve(dupId + ".translated.json")));
        assertFalse(Files.exists(dup2.getParent().resolve(dupId + ".translated.json")));
    }

    @Test
    public void miniMaxSaveWritesInsideSessionDirectoryAndPreservesSnapshot() throws IOException {
        Path home = tempFolder.newFolder("minimax-fixture").toPath();
        Path sessionDir = home.resolve("v2").resolve("sessions").resolve("2026").resolve("08").resolve("26")
                .resolve("any-session_mvs_abc");
        Files.createDirectories(sessionDir);
        Path snapshotPath = sessionDir.resolve("snapshot.json");
        String snapshotContent = "{\"record\":{\"sessionId\":\"mvs_abc\"}}";
        Files.writeString(snapshotPath, snapshotContent, StandardCharsets.UTF_8);

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());
        ReplyTranslationStore store = new ReplyTranslationStore(null, null,
                null, reader, null, null);

        store.save("minimax", "mvs_abc", "hash1", "Привет MiniMax", true);

        Path cacheFile = sessionDir.resolve("mvs_abc.translated.json");
        assertTrue("Cache must be inside session directory", Files.isRegularFile(cacheFile));
        assertEquals(snapshotContent, Files.readString(snapshotPath, StandardCharsets.UTF_8));
    }

    @Test
    public void piAndOmpSaveWritesSiblingCacheAndPreservesJsonlBytes() throws IOException {
        Path piRoot = tempFolder.newFolder("pi-fixture").toPath();
        String piId = "019fe705-27fd-712e-a1be-f972ef3773f3";
        Path piCwdDir = piRoot.resolve("cwdkey");
        Files.createDirectories(piCwdDir);
        Path piFile = piCwdDir.resolve("2026-01-01T00-00-00-000Z_" + piId + ".jsonl");
        String piContent = "{\"type\":\"session\",\"id\":\"" + piId + "\",\"cwd\":\"/tmp/proj\"}\n";
        Files.writeString(piFile, piContent, StandardCharsets.UTF_8);

        Path ompRoot = tempFolder.newFolder("omp-fixture").toPath();
        String ompId = "019fe705-27fd-712e-a1be-f972ef3773f4";
        Path ompCwdDir = ompRoot.resolve("cwdkey");
        Files.createDirectories(ompCwdDir);
        Path ompFile = ompCwdDir.resolve("2026-01-01T00-00-00-000Z_" + ompId + ".jsonl");
        String ompContent = "{\"type\":\"session\",\"id\":\"" + ompId + "\",\"cwd\":\"/tmp/proj\"}\n";
        Files.writeString(ompFile, ompContent, StandardCharsets.UTF_8);

        PiHistoryReader piReader = new PiHistoryReader(piRoot, new Gson());
        OmpHistoryReader ompReader = new OmpHistoryReader(ompRoot, new Gson());
        ReplyTranslationStore store = new ReplyTranslationStore(null, null,
                null, null, piReader, ompReader);

        store.save("pi", piId, "h_pi", "Привет Pi", true);
        Path piCache = piCwdDir.resolve(piId + ".translated.json");
        assertTrue(Files.isRegularFile(piCache));
        assertEquals(piContent, Files.readString(piFile, StandardCharsets.UTF_8));

        store.save("omp", ompId, "h_omp", "Привет Omp", true);
        Path ompCache = ompCwdDir.resolve(ompId + ".translated.json");
        assertTrue(Files.isRegularFile(ompCache));
        assertEquals(ompContent, Files.readString(ompFile, StandardCharsets.UTF_8));
    }
}
