package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.settings.TabStateService;

final class TabSessionRestorePolicy {

    private TabSessionRestorePolicy() {
    }

    static boolean shouldLoadHistory(TabStateService.TabSessionState savedState) {
        if (savedState == null || !isNonEmpty(savedState.sessionId)) {
            return false;
        }
        // Gemini/agy has no on-disk history import yet — loading would be a no-op
        // while still risking resume via a restored sessionId elsewhere.
        if ("gemini".equalsIgnoreCase(savedState.provider)) {
            return false;
        }
        return true;
    }

    static boolean shouldLoadImmediately(TabStateService.TabSessionState savedState, boolean selectedTab) {
        return selectedTab && shouldLoadHistory(savedState);
    }

    static boolean shouldStartHistoryLoad(TabStateService.TabSessionState savedState, boolean frontendReady) {
        return frontendReady && shouldLoadHistory(savedState);
    }

    private static boolean isNonEmpty(String value) {
        return value != null && !value.trim().isEmpty();
    }
}
