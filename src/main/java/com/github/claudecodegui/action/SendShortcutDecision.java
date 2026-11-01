package com.github.claudecodegui.action;

/**
 * Pure decision of which chat action owns the Command/Ctrl+Enter and Shift+Enter chords.
 *
 * <p>Inputs are the IDE send mode ({@code claude.code.send.shortcut}: {@code enter} or
 * {@code cmdEnter}) and the resolved local-translate shortcut ({@code null} when the feature
 * is off, otherwise {@code cmdEnter} or {@code shiftEnter}). Kept free of
 * {@code KeymapManager} so every row of the table can be unit tested.
 *
 * <pre>
 * | send mode | translate  | Cmd/Ctrl+Enter | Shift+Enter |
 * |-----------|------------|----------------|-------------|
 * | enter     | off        | newline        | newline     |
 * | enter     | cmdEnter   | translate      | newline     |
 * | enter     | shiftEnter | newline        | translate   |
 * | cmdEnter  | off        | send           | newline     |
 * | cmdEnter  | cmdEnter   | send           | translate   |
 * | cmdEnter  | shiftEnter | send           | translate   |
 * </pre>
 */
public final class SendShortcutDecision {

    public static final String MODE_ENTER = "enter";
    public static final String MODE_CMD_ENTER = "cmdEnter";
    public static final String TRANSLATE_CMD_ENTER = "cmdEnter";
    public static final String TRANSLATE_SHIFT_ENTER = "shiftEnter";

    /** Action that receives the Command/Ctrl+Enter chord. */
    public enum CmdEnterOwner { NEWLINE, SEND, TRANSLATE }

    private final CmdEnterOwner cmdEnterOwner;
    private final boolean shiftEnterOnNewline;

    private SendShortcutDecision(CmdEnterOwner cmdEnterOwner, boolean shiftEnterOnNewline) {
        this.cmdEnterOwner = cmdEnterOwner;
        this.shiftEnterOnNewline = shiftEnterOnNewline;
    }

    public CmdEnterOwner getCmdEnterOwner() {
        return cmdEnterOwner;
    }

    /** {@code true} when Shift+Enter stays a newline; {@code false} when translate owns it. */
    public boolean isShiftEnterOnNewline() {
        return shiftEnterOnNewline;
    }

    /**
     * @param sendMode           {@code enter} or {@code cmdEnter}; anything else is treated as {@code enter}
     * @param translateShortcut  {@code null} (feature off), {@code cmdEnter} or {@code shiftEnter};
     *                           any other value is treated as off
     */
    public static SendShortcutDecision decide(String sendMode, String translateShortcut) {
        boolean sendOnCmdEnter = MODE_CMD_ENTER.equals(sendMode);
        boolean translateCmd = TRANSLATE_CMD_ENTER.equals(translateShortcut);
        boolean translateShift = TRANSLATE_SHIFT_ENTER.equals(translateShortcut);

        CmdEnterOwner owner;
        if (sendOnCmdEnter) {
            // Send keeps Cmd/Ctrl+Enter; when translate also asked for cmdEnter, Shift+Enter translates.
            owner = CmdEnterOwner.SEND;
        } else if (translateCmd) {
            owner = CmdEnterOwner.TRANSLATE;
        } else {
            owner = CmdEnterOwner.NEWLINE;
        }
        boolean shiftTranslates = translateShift || (sendOnCmdEnter && translateCmd);
        return new SendShortcutDecision(owner, !shiftTranslates);
    }

    @Override
    public String toString() {
        return "cmdEnter=" + cmdEnterOwner + ", shiftEnter=" + (shiftEnterOnNewline ? "NEWLINE" : "TRANSLATE");
    }
}
