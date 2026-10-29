package com.github.claudecodegui.action;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.actionSystem.KeyboardShortcut;
import com.intellij.openapi.actionSystem.Shortcut;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.keymap.Keymap;
import com.intellij.openapi.keymap.KeymapManager;
import com.intellij.openapi.util.SystemInfo;

import javax.swing.*;
import java.util.Objects;

/**
 * Utility to sync ChatSendAction, ChatNewlineAction and ChatTranslateAction keyboard shortcuts
 * with the user's sendShortcut setting and the optional local-translate shortcut.
 *
 * <ul>
 *   <li>"enter" mode: Enter sends (WebView native), Ctrl+Enter → newline</li>
 *   <li>"cmdEnter" mode: Ctrl+Enter → send, Enter → newline (WebView native)</li>
 *   <li>Local translate (when enabled) may take Ctrl+Enter or Shift+Enter; see
 *       {@link SendShortcutDecision} for the full table.</li>
 * </ul>
 *
 * Shortcuts are managed at runtime only (not persisted to keymap files).
 * They are re-applied on each plugin initialization via {@link #syncFromSettings()}.
 */
public final class SendShortcutSync {

    private static final Logger LOG = Logger.getInstance(SendShortcutSync.class);
    private static final String SEND_SHORTCUT_PROPERTY_KEY = "claude.code.send.shortcut";

    /** Resolved translate shortcut: null when the feature is off, else cmdEnter / shiftEnter. */
    private static volatile String translateShortcut;

    private SendShortcutSync() {}

    /**
     * Read the current sendShortcut setting and the local-translate block, then sync the
     * IDEA keymap accordingly. Should be called once during plugin initialization.
     */
    public static synchronized void syncFromSettings() {
        translateShortcut = readResolvedTranslateShortcut();
        sync(currentSendMode());
    }

    /**
     * Record a freshly read local-translate shortcut ({@code null} when disabled) and re-run
     * the keymap sync when it changed. Returns {@code true} when a re-sync happened.
     */
    public static synchronized boolean updateTranslateShortcut(String resolvedShortcut) {
        String normalized = normalizeTranslateShortcut(resolvedShortcut);
        if (Objects.equals(normalized, translateShortcut)) {
            return false;
        }
        translateShortcut = normalized;
        try {
            // currentSendMode reads PropertiesComponent, which needs an Application.
            // sync already swallows keymap failures; keep the same contract here.
            sync(currentSendMode());
        } catch (Exception e) {
            LOG.warn("Failed to sync send shortcut keymap: " + e.getMessage(), e);
        }
        return true;
    }

    /** Resolve the translate shortcut from a normalized local-translate config object. */
    public static String resolveTranslateShortcut(JsonObject localTranslateConfig) {
        if (localTranslateConfig == null
                || !localTranslateConfig.has("enabled")
                || !localTranslateConfig.get("enabled").getAsBoolean()) {
            return null;
        }
        String shortcut = localTranslateConfig.has("shortcut")
                ? localTranslateConfig.get("shortcut").getAsString()
                : null;
        String normalized = normalizeTranslateShortcut(shortcut);
        return normalized != null ? normalized : SendShortcutDecision.TRANSLATE_CMD_ENTER;
    }

    private static String normalizeTranslateShortcut(String shortcut) {
        if (SendShortcutDecision.TRANSLATE_CMD_ENTER.equals(shortcut)
                || SendShortcutDecision.TRANSLATE_SHIFT_ENTER.equals(shortcut)) {
            return shortcut;
        }
        return null;
    }

    private static String readResolvedTranslateShortcut() {
        try {
            return resolveTranslateShortcut(new CodemossSettingsService().getLocalTranslateConfig());
        } catch (Exception e) {
            LOG.warn("Failed to read localTranslate config for keymap sync: " + e.getMessage());
            return null;
        }
    }

    private static String currentSendMode() {
        return PropertiesComponent.getInstance().getValue(SEND_SHORTCUT_PROPERTY_KEY, SendShortcutDecision.MODE_ENTER);
    }

    /**
     * Update the IDEA keymap for the chat actions based on the sendShortcut mode and the
     * current translate shortcut.
     *
     * @param mode "cmdEnter" → Ctrl+Enter sends, "enter" → Ctrl+Enter inserts newline (or translates)
     */
    public static synchronized void sync(String mode) {
        try {
            // Validate mode input
            if (mode == null
                    || (!SendShortcutDecision.MODE_ENTER.equals(mode) && !SendShortcutDecision.MODE_CMD_ENTER.equals(mode))) {
                LOG.warn("Invalid sendShortcut mode: " + mode + ", defaulting to '" + SendShortcutDecision.MODE_ENTER + "'");
                mode = SendShortcutDecision.MODE_ENTER;
            }

            KeymapManager manager = KeymapManager.getInstance();
            if (manager == null) {
                LOG.warn("KeymapManager not available");
                return;
            }
            Keymap keymap = manager.getActiveKeymap();
            ChordAssignment assignment = assignChords(mode, translateShortcut);

            // Clear existing runtime shortcuts for all chord-owning actions
            clearShortcuts(keymap, ChatSendAction.ACTION_ID);
            clearShortcuts(keymap, ChatNewlineAction.ACTION_ID);
            clearShortcuts(keymap, ChatTranslateAction.ACTION_ID);

            // Ctrl+Enter on Windows/Linux, Cmd+Enter on Mac
            KeyStroke ctrlEnter = SystemInfo.isMac
                ? KeyStroke.getKeyStroke("meta ENTER")
                : KeyStroke.getKeyStroke("ctrl ENTER");
            KeyboardShortcut shortcut = new KeyboardShortcut(ctrlEnter, null);
            keymap.addShortcut(assignment.cmdEnterActionId, shortcut);
            if (assignment.shiftEnterActionId != null) {
                KeyboardShortcut shiftEnter = new KeyboardShortcut(KeyStroke.getKeyStroke("shift ENTER"), null);
                keymap.addShortcut(assignment.shiftEnterActionId, shiftEnter);
            }
            LOG.info("Synced chat shortcuts: cmdEnter=" + assignment.cmdEnterActionId
                    + ", shiftEnter=" + assignment.shiftEnterActionId);
        } catch (Exception e) {
            LOG.warn("Failed to sync send shortcut keymap: " + e.getMessage(), e);
        }
    }

    /**
     * Which action receives each chord. {@code shiftEnterActionId} is null when Shift+Enter
     * stays a newline. Package-visible so the six rows can be tested without a keymap.
     */
    static ChordAssignment assignChords(String mode, String translateShortcut) {
        String normalizedMode = mode;
        if (normalizedMode == null
                || (!SendShortcutDecision.MODE_ENTER.equals(normalizedMode)
                && !SendShortcutDecision.MODE_CMD_ENTER.equals(normalizedMode))) {
            normalizedMode = SendShortcutDecision.MODE_ENTER;
        }
        SendShortcutDecision decision = SendShortcutDecision.decide(normalizedMode, translateShortcut);
        String cmdEnterActionId;
        switch (decision.getCmdEnterOwner()) {
            case SEND:
                cmdEnterActionId = ChatSendAction.ACTION_ID;
                break;
            case TRANSLATE:
                cmdEnterActionId = ChatTranslateAction.ACTION_ID;
                break;
            case NEWLINE:
            default:
                cmdEnterActionId = ChatNewlineAction.ACTION_ID;
                break;
        }
        String shiftEnterActionId = decision.isShiftEnterOnNewline() ? null : ChatTranslateAction.ACTION_ID;
        return new ChordAssignment(cmdEnterActionId, shiftEnterActionId);
    }

    /** Assignment for the shortcut currently recorded by {@link #updateTranslateShortcut}. */
    static ChordAssignment assignChords(String mode) {
        return assignChords(mode, translateShortcut);
    }

    static final class ChordAssignment {
        final String cmdEnterActionId;
        final String shiftEnterActionId;

        ChordAssignment(String cmdEnterActionId, String shiftEnterActionId) {
            this.cmdEnterActionId = cmdEnterActionId;
            this.shiftEnterActionId = shiftEnterActionId;
        }
    }

    private static void clearShortcuts(Keymap keymap, String actionId) {
        for (Shortcut sc : keymap.getShortcuts(actionId)) {
            keymap.removeShortcut(actionId, sc);
        }
    }
}
