package com.github.claudecodegui.action;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * {@link SendShortcutSync#resolveTranslateShortcut(JsonObject)}: which translate chord, if any,
 * the keymap should bind for a given local-translate config.
 */
public class SendShortcutSyncTest {

    @Test
    public void nullConfigMeansTranslateOff() {
        assertNull(SendShortcutSync.resolveTranslateShortcut(null));
    }

    @Test
    public void disabledConfigMeansTranslateOff() {
        assertNull(SendShortcutSync.resolveTranslateShortcut(config(false, "shiftEnter")));
    }

    @Test
    public void missingEnabledMeansTranslateOff() {
        JsonObject cfg = new JsonObject();
        cfg.addProperty("shortcut", "cmdEnter");
        assertNull(SendShortcutSync.resolveTranslateShortcut(cfg));
    }

    @Test
    public void unknownOrMissingShortcutFallsBackToCmdEnter() {
        assertEquals("cmdEnter", SendShortcutSync.resolveTranslateShortcut(config(true, "altEnter")));
        assertEquals("cmdEnter", SendShortcutSync.resolveTranslateShortcut(config(true, null)));
    }

    @Test
    public void knownShortcutsAreKept() {
        assertEquals("cmdEnter", SendShortcutSync.resolveTranslateShortcut(config(true, "cmdEnter")));
        assertEquals("shiftEnter", SendShortcutSync.resolveTranslateShortcut(config(true, "shiftEnter")));
    }

    @Test
    public void chordAssignmentCoversEveryRow() {
        assertAssignment("enter", null, ChatNewlineAction.ACTION_ID, null);
        assertAssignment("enter", "cmdEnter", ChatTranslateAction.ACTION_ID, null);
        assertAssignment("enter", "shiftEnter", ChatNewlineAction.ACTION_ID, ChatTranslateAction.ACTION_ID);
        assertAssignment("cmdEnter", null, ChatSendAction.ACTION_ID, null);
        assertAssignment("cmdEnter", "cmdEnter", ChatSendAction.ACTION_ID, ChatTranslateAction.ACTION_ID);
        assertAssignment("cmdEnter", "shiftEnter", ChatSendAction.ACTION_ID, ChatTranslateAction.ACTION_ID);
    }

    @Test
    public void updateTranslateShortcutRetargetsShiftEnter() {
        try {
            assertTrue(SendShortcutSync.updateTranslateShortcut("shiftEnter"));
            SendShortcutSync.ChordAssignment assignment = SendShortcutSync.assignChords("cmdEnter");
            assertEquals(ChatSendAction.ACTION_ID, assignment.cmdEnterActionId);
            assertEquals(ChatTranslateAction.ACTION_ID, assignment.shiftEnterActionId);
            assertFalse(SendShortcutSync.updateTranslateShortcut("shiftEnter"));
        } finally {
            SendShortcutSync.updateTranslateShortcut(null);
        }
    }

    private static void assertAssignment(String mode, String shortcut, String cmdEnterAction, String shiftEnterAction) {
        SendShortcutSync.ChordAssignment assignment = SendShortcutSync.assignChords(mode, shortcut);
        assertEquals(cmdEnterAction, assignment.cmdEnterActionId);
        assertEquals(shiftEnterAction, assignment.shiftEnterActionId);
    }

    private static JsonObject config(boolean enabled, String shortcut) {
        JsonObject cfg = new JsonObject();
        cfg.addProperty("enabled", enabled);
        if (shortcut != null) {
            cfg.addProperty("shortcut", shortcut);
        }
        return cfg;
    }
}
