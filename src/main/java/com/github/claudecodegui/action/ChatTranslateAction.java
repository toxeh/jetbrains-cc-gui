package com.github.claudecodegui.action;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

/**
 * IDEA Action that asks the chat composer to rewrite the draft through the local
 * OpenAI-compatible model. It never sends the message.
 * Shortcut is dynamically managed by {@link SendShortcutSync}: Cmd/Ctrl+Enter or Shift+Enter
 * depending on {@code localTranslate.shortcut} and the send mode; none when the feature is off.
 */
public class ChatTranslateAction extends ChatToolWindowAction {

    public static final String ACTION_ID = "ClaudeCodeGUI.ChatTranslateAction";

    @Override
    protected void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow) {
        chatWindow.executeJavaScriptCode("if(window.execContextAction) window.execContextAction('translate')");
    }
}
