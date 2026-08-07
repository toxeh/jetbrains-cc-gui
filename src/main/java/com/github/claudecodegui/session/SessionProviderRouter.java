package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.gemini.GeminiSDKBridge;
import com.github.claudecodegui.provider.grok.GrokSDKBridge;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Centralizes provider-specific bridge routing for session operations.
 * Grok prefers ACP ({@link GrokSDKBridge}) when present; other headless CLIs
 * use the MarkerCliBridge map; Gemini uses {@link GeminiSDKBridge}.
 */
public class SessionProviderRouter {

    /**
     * Headless CLI provider ids (kimi/opencode/pi). Grok is ACP when
     * GrokSDKBridge is wired, so it is not listed here.
     */
    private static final Set<String> CLI_PROVIDER_IDS = Set.of("kimi", "opencode", "pi");

    public static boolean isCliProvider(String provider) {
        return provider != null && CLI_PROVIDER_IDS.contains(provider);
    }

    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final Map<String, MarkerCliBridge> cliBridges;
    private final GrokSDKBridge grokSDKBridge;
    private final GeminiSDKBridge geminiSDKBridge;

    public SessionProviderRouter(
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            Map<String, MarkerCliBridge> cliBridges
    ) {
        this(claudeSDKBridge, codexSDKBridge, cliBridges, null, null);
    }

    public SessionProviderRouter(
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            Map<String, MarkerCliBridge> cliBridges,
            GeminiSDKBridge geminiSDKBridge
    ) {
        this(claudeSDKBridge, codexSDKBridge, cliBridges, null, geminiSDKBridge);
    }

    public SessionProviderRouter(
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            Map<String, MarkerCliBridge> cliBridges,
            GrokSDKBridge grokSDKBridge,
            GeminiSDKBridge geminiSDKBridge
    ) {
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
        this.cliBridges = cliBridges != null
                ? Collections.unmodifiableMap(new LinkedHashMap<>(cliBridges))
                : Collections.emptyMap();
        this.grokSDKBridge = grokSDKBridge;
        this.geminiSDKBridge = geminiSDKBridge;
    }

    public static Map<String, MarkerCliBridge> registerCliBridges(MarkerCliBridge... bridges) {
        Map<String, MarkerCliBridge> map = new LinkedHashMap<>();
        if (bridges == null) {
            return map;
        }
        for (MarkerCliBridge bridge : bridges) {
            if (bridge != null) {
                map.put(bridge.providerId(), bridge);
            }
        }
        return map;
    }

    private MarkerCliBridge cli(String provider) {
        return provider != null ? cliBridges.get(provider) : null;
    }

    public JsonObject launchChannel(String provider, String channelId, String sessionId, String cwd) {
        if ("codex".equals(provider)) {
            return codexSDKBridge.launchChannel(channelId, sessionId, cwd);
        }
        if ("grok".equals(provider) && grokSDKBridge != null) {
            return grokSDKBridge.launchChannel(channelId, sessionId, cwd);
        }
        if ("gemini".equals(provider) && geminiSDKBridge != null) {
            return geminiSDKBridge.launchChannel(channelId, sessionId, cwd);
        }
        MarkerCliBridge bridge = cli(provider);
        if (bridge != null) {
            return bridge.launchChannel(channelId, sessionId, cwd);
        }
        return claudeSDKBridge.launchChannel(channelId, sessionId, cwd);
    }

    public void interruptChannel(String provider, String channelId) {
        if ("codex".equals(provider)) {
            codexSDKBridge.interruptChannel(channelId);
            return;
        }
        if ("grok".equals(provider) && grokSDKBridge != null) {
            grokSDKBridge.interruptChannel(channelId);
            return;
        }
        if ("gemini".equals(provider) && geminiSDKBridge != null) {
            geminiSDKBridge.interruptChannel(channelId);
            return;
        }
        MarkerCliBridge bridge = cli(provider);
        if (bridge != null) {
            bridge.interruptChannel(channelId);
            return;
        }
        claudeSDKBridge.interruptChannel(channelId);
    }

    public List<JsonObject> getSessionMessages(String provider, String sessionId, String cwd) {
        if ("codex".equals(provider)) {
            return codexSDKBridge.getSessionMessages(sessionId, cwd);
        }
        if ("grok".equals(provider) && grokSDKBridge != null) {
            return grokSDKBridge.getSessionMessages(sessionId, cwd);
        }
        if ("gemini".equals(provider) && geminiSDKBridge != null) {
            return geminiSDKBridge.getSessionMessages(sessionId, cwd);
        }
        MarkerCliBridge bridge = cli(provider);
        if (bridge != null) {
            return bridge.getSessionMessages(sessionId, cwd);
        }
        return claudeSDKBridge.getSessionMessages(sessionId, cwd);
    }

    public Map<String, MarkerCliBridge> getCliBridges() {
        return cliBridges;
    }

    public GrokSDKBridge getGrokSDKBridge() {
        return grokSDKBridge;
    }

    public GeminiSDKBridge getGeminiSDKBridge() {
        return geminiSDKBridge;
    }
}
