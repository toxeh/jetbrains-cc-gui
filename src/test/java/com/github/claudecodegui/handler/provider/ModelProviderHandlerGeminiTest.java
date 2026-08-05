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
    public void genericGeminiFallbackIsTwoHundredK() {
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("gemini"));
    }

    @Test
    public void switchingFromClaudeToGeminiShutsDownDaemon() {
        assertTrue(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", "gemini"));
    }
}
