package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.grok.GrokSDKBridge;
import com.google.gson.JsonObject;

import java.util.List;

/**
 * Centralizes provider-specific bridge routing for session operations.
 */
public class SessionProviderRouter {

    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final GrokSDKBridge grokSDKBridge;

    public SessionProviderRouter(ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge, GrokSDKBridge grokSDKBridge) {
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
        this.grokSDKBridge = grokSDKBridge;
    }

    public JsonObject launchChannel(String provider, String channelId, String sessionId, String cwd) {
        if ("codex".equals(provider)) {
            return codexSDKBridge.launchChannel(channelId, sessionId, cwd);
        }
        if ("grok".equals(provider)) {
            return grokSDKBridge.launchChannel(channelId, sessionId, cwd);
        }
        return claudeSDKBridge.launchChannel(channelId, sessionId, cwd);
    }

    public void interruptChannel(String provider, String channelId) {
        if ("codex".equals(provider)) {
            codexSDKBridge.interruptChannel(channelId);
            return;
        }
        if ("grok".equals(provider)) {
            grokSDKBridge.interruptChannel(channelId);
            return;
        }
        claudeSDKBridge.interruptChannel(channelId);
    }

    public List<JsonObject> getSessionMessages(String provider, String sessionId, String cwd) {
        if ("codex".equals(provider)) {
            return codexSDKBridge.getSessionMessages(sessionId, cwd);
        }
        if ("grok".equals(provider)) {
            return grokSDKBridge.getSessionMessages(sessionId, cwd);
        }
        return claudeSDKBridge.getSessionMessages(sessionId, cwd);
    }
}
