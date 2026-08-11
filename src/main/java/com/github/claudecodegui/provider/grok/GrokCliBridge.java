package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Grok CLI bridge.
 *
 * <p>Grok has no official SDK. This bridge launches {@code channel-manager.js}
 * with provider {@code grok}, which spawns the local Grok CLI and maps
 * streaming-json NDJSON onto the shared marker protocol.
 */
public class GrokCliBridge extends MarkerCliBridge {

    private final CodemossSettingsService settingsService = new CodemossSettingsService();

    public GrokCliBridge() {
        super(GrokCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "grok";
    }

    @Override
    protected String getStdinEnvKey() {
        return "GROK_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        env.put("GROK_DISABLE_AUTOUPDATER", "1");
        env.put("GROK_NO_AUTO_UPDATE", "1");
        env.put("CI", "1");

        try {
            JsonObject grokEnv = settingsService.getGrokEnv();
            if (grokEnv != null && grokEnv.size() > 0) {
                for (String key : grokEnv.keySet()) {
                    if (grokEnv.get(key) != null && !grokEnv.get(key).isJsonNull()) {
                        env.put(key, grokEnv.get(key).getAsString());
                    }
                }
            }

            String authMethod = settingsService.getGrokAuthMethod();
            String apiKey = settingsService.getGrokApiKey();
            String apiBaseUrl = settingsService.getGrokApiBaseUrl();

            GrokLocalAuthResolver.ResolvedAuth resolved = GrokLocalAuthResolver.resolve(
                    authMethod,
                    apiKey,
                    apiBaseUrl
            );

            env.put("GROK_AUTH_METHOD", resolved.authMethod);

            if (CodemossSettingsService.GROK_AUTH_METHOD_OAUTH.equals(resolved.authMethod)) {
                env.remove("XAI_API_KEY");
                env.remove("GROK_API_KEY");
            } else {
                if (resolved.apiKey != null && !resolved.apiKey.isEmpty()) {
                    env.put("XAI_API_KEY", resolved.apiKey);
                    env.put("GROK_API_KEY", resolved.apiKey);
                }
            }

            if (resolved.baseUrl != null && !resolved.baseUrl.isEmpty()) {
                String effectiveBase = resolved.baseUrl;
                String modelsList = effectiveBase.replaceAll("/+$", "") + "/models";
                env.put("GROK_MODELS_BASE_URL", effectiveBase);
                env.put("GROK_MODELS_LIST_URL", modelsList);
                env.put("GROK_BASE_URL", effectiveBase);

                if (CodemossSettingsService.GROK_AUTH_METHOD_API_KEY.equals(resolved.authMethod)) {
                    env.put("XAI_API_BASE_URL", effectiveBase);
                    env.put("GROK_CLI_CHAT_PROXY_BASE_URL", effectiveBase);
                } else if (CodemossSettingsService.GROK_AUTH_METHOD_OAUTH.equals(resolved.authMethod)) {
                    env.put("GROK_CLI_CHAT_PROXY_BASE_URL", effectiveBase);
                    env.remove("XAI_API_BASE_URL");
                } else {
                    env.put("XAI_API_BASE_URL", effectiveBase);
                    env.put("GROK_CLI_CHAT_PROXY_BASE_URL", effectiveBase);
                }
            }

            LOG.info("[GrokCliBridge] Configured Grok environment: authMethod=" + resolved.authMethod
                    + ", baseUrl=" + resolved.baseUrl
                    + ", apiKeySet=" + (resolved.apiKey != null && !resolved.apiKey.isEmpty()));

        } catch (Exception e) {
            LOG.warn("[GrokCliBridge] Failed to configure Grok environment: " + e.getMessage());
        }
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new GrokHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[Grok] Failed to load session messages: " + e.getMessage());
            return Collections.emptyList();
        }
    }
}
