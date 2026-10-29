package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Reader for the optional {@code localTranslate} block.
 * Reads a temp {@code config.json} the same way {@link CodemossSettingsServiceCommitAiConfigTest} does.
 */
public class CodemossSettingsServiceLocalTranslateConfigTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void absentBlockReturnsDisabledDefaultsAndDoesNotWriteFile() throws Exception {
        Path tempHome = Files.createTempDirectory("local-translate-absent-home");
        useTemporaryHomeDirectory(tempHome);
        Path configPath = tempHome.resolve(".codemoss").resolve("config.json");
        String original = "{\"version\":2,\"claude\":{\"current\":\"\",\"providers\":{}}}";
        Files.writeString(configPath, original);
        long mtime = Files.getLastModifiedTime(configPath).toMillis();

        JsonObject cfg = new CodemossSettingsService().getLocalTranslateConfig();

        assertFalse(cfg.get("enabled").getAsBoolean());
        assertEquals("http://127.0.0.1:11434/v1", cfg.get("baseUrl").getAsString());
        assertEquals("qwen2.5:3b", cfg.get("model").getAsString());
        assertEquals("cmdEnter", cfg.get("shortcut").getAsString());
        assertEquals("Translate the prose into English. Do not change code or paths.",
                cfg.get("instruction").getAsString());
        assertFalse(cfg.has("apiKey"));
        // Reading must not create the block or touch the file.
        assertEquals(original, Files.readString(configPath));
        assertEquals(mtime, Files.getLastModifiedTime(configPath).toMillis());
        assertFalse(Files.exists(tempHome.resolve(".codemoss").resolve("config.json.bak")));
    }

    @Test
    public void missingConfigFileIsNotCreatedOnRead() throws Exception {
        Path tempHome = Files.createTempDirectory("local-translate-missing-home");
        useTemporaryHomeDirectory(tempHome);
        Path configPath = tempHome.resolve(".codemoss").resolve("config.json");

        JsonObject cfg = new CodemossSettingsService().getLocalTranslateConfig();

        assertFalse(cfg.get("enabled").getAsBoolean());
        assertFalse(Files.exists(configPath));
    }

    @Test
    public void enabledBlockFillsMissingFieldsWithDefaults() throws Exception {
        Path tempHome = Files.createTempDirectory("local-translate-enabled-home");
        useTemporaryHomeDirectory(tempHome);
        Files.writeString(tempHome.resolve(".codemoss").resolve("config.json"),
                "{\"localTranslate\":{\"enabled\":true}}");

        JsonObject cfg = new CodemossSettingsService().getLocalTranslateConfig();

        assertTrue(cfg.get("enabled").getAsBoolean());
        assertEquals("http://127.0.0.1:11434/v1", cfg.get("baseUrl").getAsString());
        assertEquals("qwen2.5:3b", cfg.get("model").getAsString());
        assertEquals("cmdEnter", cfg.get("shortcut").getAsString());
        assertEquals(CodemossSettingsService.DEFAULT_LOCAL_TRANSLATE_INSTRUCTION, cfg.get("instruction").getAsString());
        assertFalse(cfg.has("apiKey"));
    }

    @Test
    public void fullBlockIsReadAsWritten() throws Exception {
        Path tempHome = Files.createTempDirectory("local-translate-full-home");
        useTemporaryHomeDirectory(tempHome);
        Files.writeString(tempHome.resolve(".codemoss").resolve("config.json"),
                "{\"localTranslate\":{\"enabled\":true,\"baseUrl\":\"http://127.0.0.1:8080/v1/\","
                        + "\"model\":\"mlx-community/Qwen\",\"shortcut\":\"shiftEnter\","
                        + "\"instruction\":\"  прозу на английский,  код и пути не трогать. отвечать на русском \","
                        + "\"apiKey\":\"sk-local\"}}");

        JsonObject cfg = new CodemossSettingsService().getLocalTranslateConfig();

        assertTrue(cfg.get("enabled").getAsBoolean());
        assertEquals("http://127.0.0.1:8080/v1", cfg.get("baseUrl").getAsString());
        assertEquals("mlx-community/Qwen", cfg.get("model").getAsString());
        assertEquals("shiftEnter", cfg.get("shortcut").getAsString());
        // Ends trimmed, inner double space kept.
        assertEquals("прозу на английский,  код и пути не трогать. отвечать на русском",
                cfg.get("instruction").getAsString());
        assertEquals("sk-local", cfg.get("apiKey").getAsString());
    }

    @Test
    public void unknownShortcutFallsBackToCmdEnter() {
        JsonObject raw = new JsonObject();
        raw.addProperty("enabled", true);
        raw.addProperty("shortcut", "altEnter");
        assertEquals("cmdEnter", CodemossSettingsService.normalizeLocalTranslateConfig(raw).get("shortcut").getAsString());

        raw.addProperty("shortcut", 5);
        assertEquals("cmdEnter", CodemossSettingsService.normalizeLocalTranslateConfig(raw).get("shortcut").getAsString());
    }

    @Test
    public void blankInstructionFallsBackToDefaultSentence() {
        JsonObject raw = new JsonObject();
        raw.addProperty("enabled", true);
        raw.addProperty("instruction", "   \n ");
        assertEquals(CodemossSettingsService.DEFAULT_LOCAL_TRANSLATE_INSTRUCTION,
                CodemossSettingsService.normalizeLocalTranslateConfig(raw).get("instruction").getAsString());
    }

    @Test
    public void blankOrNonStringApiKeyIsOmitted() {
        JsonObject raw = new JsonObject();
        raw.addProperty("apiKey", "  ");
        assertFalse(CodemossSettingsService.normalizeLocalTranslateConfig(raw).has("apiKey"));
        raw.addProperty("apiKey", 42);
        assertFalse(CodemossSettingsService.normalizeLocalTranslateConfig(raw).has("apiKey"));
    }

    @Test
    public void nonBooleanEnabledIsTreatedAsDisabled() {
        JsonObject raw = new JsonObject();
        raw.addProperty("enabled", "true");
        assertFalse(CodemossSettingsService.normalizeLocalTranslateConfig(raw).get("enabled").getAsBoolean());
    }

    @Test
    public void baseUrlNormalization() {
        assertEquals("http://127.0.0.1:11434/v1",
                CodemossSettingsService.normalizeLocalTranslateBaseUrl("http://127.0.0.1:11434/v1/"));
        assertEquals("http://127.0.0.1:11434/v1",
                CodemossSettingsService.normalizeLocalTranslateBaseUrl("http://127.0.0.1:11434/v1///"));
        assertEquals("http://localhost:1234/v1",
                CodemossSettingsService.normalizeLocalTranslateBaseUrl("http://localhost:1234/v1/chat/completions"));
        assertEquals("http://localhost:1234/v1",
                CodemossSettingsService.normalizeLocalTranslateBaseUrl("http://localhost:1234/v1/chat/completions/"));
        assertEquals("http://127.0.0.1:11434/v1",
                CodemossSettingsService.normalizeLocalTranslateBaseUrl("   "));
        assertEquals("http://127.0.0.1:11434/v1",
                CodemossSettingsService.normalizeLocalTranslateBaseUrl(null));
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
        Files.createDirectories(tempHome.resolve(".codemoss"));
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
