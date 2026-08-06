package com.github.claudecodegui.handler.provider;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ModelProviderHandlerGeminiTest {

    @Test
    public void geminiCatalogModelsHaveOneMillionContext() {
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.5-flash-medium"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.6-flash-high"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.1-pro-high"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.1-pro-low"));
    }

    @Test
    public void genericGeminiFallbackIsOneMillion() {
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-unknown-future-model"));
    }

    @Test
    public void agyClaudeCatalogModelsKeepTwoHundredK() {
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-6"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-6-thinking"));
    }

    @Test
    public void switchingFromClaudeToGeminiShutsDownDaemon() {
        assertTrue(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", "gemini"));
    }
}
