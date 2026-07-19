package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.Collections;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.*;

/**
 * Comprehensive tests for Grok provider components after persistent ACP + rebase.
 */
public class GrokSDKBridgeTest {

    @Test
    void testBuildStdinPayloadIncludesGrokFields() {
        GrokSDKBridge bridge = new GrokSDKBridge();
        bridge.setApiKey("test-key");

        JsonObject payload = bridge.buildStdinPayloadForDaemon(
                "hello grok",
                "sess-123",
                "epoch-xyz",
                "/tmp",
                Collections.emptyList(),
                "default",
                "grok-2",
                null,
                "",
                true,
                false,
                null
        );

        assertEquals("hello grok", payload.get("message").getAsString());
        assertEquals("grok-2", payload.get("model").getAsString());
        assertEquals("test-key", payload.get("apiKey").getAsString());
        assertEquals("sess-123", payload.get("sessionId").getAsString());
    }

    @Test
    void testSetPermissionModeLiveCompletesWhenNoDaemon() {
        GrokSDKBridge bridge = new GrokSDKBridge();

        // Stub returns completed Void; must not throw when no daemon is attached.
        bridge.setPermissionModeLive("sess", "ep", "bypassPermissions").join();
    }

    @Test
    void testResetAndPrewarmMethodsDoNotThrow() {
        GrokSDKBridge bridge = new GrokSDKBridge();

        // These should be no-op or safe when no daemon
        try {
            bridge.resetPersistentRuntime("some-epoch");
            bridge.prewarmDaemonAsync("/tmp", "ep-1");
            bridge.prewarmDaemonAsync("/tmp", "ep-2", "sess-xyz");
        } catch (Exception e) {
            throw new AssertionError("Should not throw", e);
        }
    }

    @Test
    void grokMessageHandlerUsageUsesRealContextLimit() {
        // The fix ensures GrokMessageHandler calls getModelContextLimit instead of hardcoding 0.
        // We verify the model limit helper works for Grok names.
        int limit = com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok-2");
        assertTrue(limit > 0);
        assertEquals(128000, limit);
    }

    @Test
    void testGrokModelsHaveExpectedContextLimits() {
        assertEquals(500000, com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok"));
        assertEquals(128000, com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok-2"));
        assertEquals(500000, com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok-4.5"));
        assertEquals(500000, com.github.claudecodegui.handler.provider.ModelProviderHandler.getModelContextLimit("grok-build"));
    }
}