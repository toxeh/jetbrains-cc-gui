package com.github.claudecodegui.action;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * All six rows of the chord-ownership table, plus input normalization.
 */
public class SendShortcutDecisionTest {

    @Test
    public void enterModeTranslateOffKeepsNewlineOnBothChords() {
        SendShortcutDecision d = SendShortcutDecision.decide("enter", null);
        assertEquals(SendShortcutDecision.CmdEnterOwner.NEWLINE, d.getCmdEnterOwner());
        assertTrue(d.isShiftEnterOnNewline());
    }

    @Test
    public void enterModeTranslateCmdEnterGivesCmdEnterToTranslate() {
        SendShortcutDecision d = SendShortcutDecision.decide("enter", "cmdEnter");
        assertEquals(SendShortcutDecision.CmdEnterOwner.TRANSLATE, d.getCmdEnterOwner());
        assertTrue(d.isShiftEnterOnNewline());
    }

    @Test
    public void enterModeTranslateShiftEnterGivesShiftEnterToTranslate() {
        SendShortcutDecision d = SendShortcutDecision.decide("enter", "shiftEnter");
        assertEquals(SendShortcutDecision.CmdEnterOwner.NEWLINE, d.getCmdEnterOwner());
        assertFalse(d.isShiftEnterOnNewline());
    }

    @Test
    public void cmdEnterModeTranslateOffSendsOnCmdEnter() {
        SendShortcutDecision d = SendShortcutDecision.decide("cmdEnter", null);
        assertEquals(SendShortcutDecision.CmdEnterOwner.SEND, d.getCmdEnterOwner());
        assertTrue(d.isShiftEnterOnNewline());
    }

    @Test
    public void cmdEnterModeTranslateCmdEnterSendsAndTranslatesOnShift() {
        SendShortcutDecision d = SendShortcutDecision.decide("cmdEnter", "cmdEnter");
        assertEquals(SendShortcutDecision.CmdEnterOwner.SEND, d.getCmdEnterOwner());
        assertFalse(d.isShiftEnterOnNewline());
    }

    @Test
    public void cmdEnterModeTranslateShiftEnterSendsAndTranslatesOnShift() {
        SendShortcutDecision d = SendShortcutDecision.decide("cmdEnter", "shiftEnter");
        assertEquals(SendShortcutDecision.CmdEnterOwner.SEND, d.getCmdEnterOwner());
        assertFalse(d.isShiftEnterOnNewline());
    }

    @Test
    public void unknownModeFallsBackToEnterModeAndUnknownShortcutDisablesTranslate() {
        SendShortcutDecision d = SendShortcutDecision.decide("bogus", "altEnter");
        assertEquals(SendShortcutDecision.CmdEnterOwner.NEWLINE, d.getCmdEnterOwner());
        assertTrue(d.isShiftEnterOnNewline());

        SendShortcutDecision nullMode = SendShortcutDecision.decide(null, "cmdEnter");
        assertEquals(SendShortcutDecision.CmdEnterOwner.TRANSLATE, nullMode.getCmdEnterOwner());
    }
}
