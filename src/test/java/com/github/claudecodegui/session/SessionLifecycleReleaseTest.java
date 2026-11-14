package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.model.SessionTemplate;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.ui.jcef.JBCefBrowser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.Map;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/** Verifies history switching waits for the previous native writer to finish releasing. */
public class SessionLifecycleReleaseTest {

    private Application previousApplication;

    @Before
    public void setUpApplication() {
        previousApplication = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(
                Application.class.getClassLoader(),
                new Class<?>[]{Application.class},
                (proxy, method, arguments) -> {
                    String name = method.getName();
                    if ("invokeLater".equals(name) && arguments != null
                            && arguments.length > 0 && arguments[0] instanceof Runnable) {
                        try {
                            ((Runnable) arguments[0]).run();
                        } catch (Exception ignored) {
                            // UI notifications like status bar widgets are optional in unit tests
                        }
                        return null;
                    }
                    if (method.getReturnType() == boolean.class) {
                        return false;
                    }
                    return null;
                }
        );
        ApplicationManager.setApplication(application);
    }

    @After
    public void restoreApplication() {
        ApplicationManager.setApplication(previousApplication);
    }

    /** Restored chats share a default channel only after the preceding writer has drained. */
    @Test
    public void historyRestoreDoesNotReuseTheChannelDuringAnUnfinishedRelease() {
        HoldingReleaseBridge bridge = new HoldingReleaseBridge();
        Host host = new Host(bridge);
        ClaudeSession previous = host.session;
        try {
            new SessionLifecycleManager(host).loadHistorySession("next-root", "/fixture", "codex", "test-model");
            assertTrue("the existing writer is being released", bridge.releaseRequested);
            assertFalse(bridge.release.isDone());
            assertSame("new history cannot bind to the releasing channel", previous, host.session);
        } finally {
            host.coalescer.dispose();
            bridge.cleanupAllProcesses();
        }
    }

    /** A confirmed release allows the selected history to take over the shared channel. */
    @Test
    public void historyRestoreContinuesAfterTheWriterHasReleased() {
        HoldingReleaseBridge bridge = new HoldingReleaseBridge();
        Host host = new Host(bridge);
        ClaudeSession previous = host.session;
        try {
            new SessionLifecycleManager(host).loadHistorySession("next-root", "/fixture", "codex", "test-model");
            assertSame(previous, host.session);
            bridge.release.complete(new JsonObject());
            assertNotSame(previous, host.session);
            assertEquals("next-root", host.session.getSessionId());
            assertEquals(previous.getChannelId(), host.session.getChannelId());
        } finally {
            host.coalescer.dispose();
            bridge.cleanupAllProcesses();
        }
    }

    /** A failed release leaves the old logical owner in place instead of opening another writer. */
    @Test
    public void failedWriterReleaseDoesNotCreateTheNextHistorySession() {
        HoldingReleaseBridge bridge = new HoldingReleaseBridge();
        Host host = new Host(bridge);
        ClaudeSession previous = host.session;
        try {
            new SessionLifecycleManager(host).loadHistorySession("next-root", "/fixture", "codex", "test-model");
            JsonObject failure = new JsonObject();
            failure.addProperty("error", "Native writer release failed");
            bridge.release.complete(failure);
            assertSame(previous, host.session);
            assertEquals("previous-root", host.session.getSessionId());
        } finally {
            host.coalescer.dispose();
            bridge.cleanupAllProcesses();
        }
    }

    /** AC-1: createNewSession sets provider before permissionMode to preserve Gemini sandbox mode. */
    @Test
    public void createNewSessionPreservesGeminiSandboxMode() {
        HoldingReleaseBridge bridge = new HoldingReleaseBridge();
        Host host = new Host(bridge);
        host.session.setProvider("gemini");
        host.session.setPermissionMode("sandbox");
        try {
            SessionLifecycleManager manager = new SessionLifecycleManager(host);
            manager.createNewSession();
            assertEquals("gemini", host.session.getProvider());
            assertEquals("sandbox", host.session.getPermissionMode());
        } finally {
            host.coalescer.dispose();
            bridge.cleanupAllProcesses();
        }
    }

    /** AC-2: createNewSessionFromTemplate sets provider before permissionMode to preserve Gemini sandbox mode. */
    @Test
    public void createNewSessionFromTemplatePreservesGeminiSandboxMode() {
        HoldingReleaseBridge bridge = new HoldingReleaseBridge();
        Host host = new Host(bridge);
        host.session.setProvider("gemini");
        try {
            SessionTemplate template = new SessionTemplate();
            template.setName("gemini-template");
            template.setProvider("gemini");
            template.setPermissionMode("sandbox");
            template.setModel("auto");

            SessionLifecycleManager manager = new SessionLifecycleManager(host);
            manager.createNewSessionFromTemplate(template);

            assertEquals("gemini", host.session.getProvider());
            assertEquals("sandbox", host.session.getPermissionMode());
        } finally {
            host.coalescer.dispose();
            bridge.cleanupAllProcesses();
        }
    }

    /** AC-3: loadHistorySession sets provider before permissionMode to preserve Gemini sandbox mode. */
    @Test
    public void loadHistorySessionPreservesGeminiSandboxMode() {
        HoldingReleaseBridge bridge = new HoldingReleaseBridge();
        Host host = new Host(bridge);
        host.session.setProvider("gemini");
        host.session.setPermissionMode("sandbox");
        try {
            SessionLifecycleManager manager = new SessionLifecycleManager(host);
            manager.loadHistorySession("history-conv-1", "/fixture", "gemini", "auto");

            assertEquals("gemini", host.session.getProvider());
            assertEquals("sandbox", host.session.getPermissionMode());
        } finally {
            host.coalescer.dispose();
            bridge.cleanupAllProcesses();
        }
    }

    private static Project projectWithBase(String basePath) {
        return (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> {
                    if ("getBasePath".equals(method.getName()) && method.getParameterCount() == 0) {
                        return basePath;
                    }
                    Class<?> rt = method.getReturnType();
                    if (rt == boolean.class) {
                        return false;
                    }
                    if (rt == int.class) {
                        return 0;
                    }
                    if (rt == long.class) {
                        return 0L;
                    }
                    return null;
                }
        );
    }

    private static final class DummyGeminiCliBridge extends MarkerCliBridge {
        DummyGeminiCliBridge() {
            super(DummyGeminiCliBridge.class);
        }

        @Override
        protected String getProviderName() {
            return "gemini";
        }

        @Override
        protected String getStdinEnvKey() {
            return "GEMINI_STDIN";
        }

        @Override
        public CompletableFuture<SDKResult> sendMessage(
                String channelId,
                String message,
                String sessionId,
                String cwd,
                String model,
                String reasoningEffort,
                List<ClaudeSession.Attachment> attachments,
                String permissionMode,
                String dshPreset,
                Boolean thinking,
                String requestedCwd,
                MessageCallback callback
        ) {
            return CompletableFuture.completedFuture(new SDKResult());
        }
    }

    private static final class HoldingReleaseBridge extends CodexSDKBridge {
        private final CompletableFuture<JsonObject> release = new CompletableFuture<>();
        private boolean releaseRequested;

        /** Avoids starting a real native runtime for this ordering fixture. */
        @Override
        public void interruptChannel(String channelId) {
            // no-op for lifecycle ordering fixture
        }

        /** Holds the writer-drained acknowledgement while the next history selection arrives. */
        @Override
        public CompletableFuture<JsonObject> releaseCodexThread(String channelId, String cwd, String threadId) {
            this.releaseRequested = true;
            return this.release;
        }

        /** Isolates unexpected early history reads from native account configuration. */
        @Override
        public List<JsonObject> getSessionMessages(String sessionId, String cwd, String channelId) { return List.of(); }
    }

    private static final class Host implements SessionLifecycleManager.SessionHost {
        private final HoldingReleaseBridge bridge;
        private final HandlerContext context;
        private final StreamMessageCoalescer coalescer;
        private final Project project;
        private final Map<String, MarkerCliBridge> cliBridges;
        private ClaudeSession session;

        private Host(HoldingReleaseBridge bridge) {
            this.bridge = bridge;
            this.project = projectWithBase(System.getProperty("java.io.tmpdir"));
            this.cliBridges = Map.of("gemini", new DummyGeminiCliBridge());
            this.session = new ClaudeSession(project, null, bridge, cliBridges) {
                /** Holds only release ordering under test; interruption is already acknowledged. */
                @Override
                public CompletableFuture<Void> interrupt() { return CompletableFuture.completedFuture(null); }
            };
            this.session.setProvider("codex");
            this.session.setSessionInfo("previous-root", "/fixture");
            this.context = new HandlerContext(project, null, bridge, null, null);
            this.context.setSession(this.session);
            this.coalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
                @Override public boolean callJavaScript(String name, String... args) { return true; }
                @Override public boolean isDisposed() { return false; }
                @Override public HandlerContext getHandlerContext() { return Host.this.context; }
            });
        }

        /** Keeps the fixture independent of IDE project services. */
        @Override public Project getProject() { return this.project; }
        /** Excludes other providers from the native-release fixture. */
        @Override public ClaudeSDKBridge getClaudeSDKBridge() { return null; }
        /** Routes native teardown to the held acknowledgement. */
        @Override public CodexSDKBridge getCodexSDKBridge() { return this.bridge; }
        /** Excludes unrelated CLI lifecycles from the fixture. */
        @Override public Map<String, MarkerCliBridge> getCliBridges() { return this.cliBridges; }
        /** Exposes the logical session that currently owns the channel. */
        @Override public ClaudeSession getSession() { return this.session; }
        /** Makes premature history replacement observable to the test. */
        @Override public void setSession(ClaudeSession session) { this.session = session; }
        /** Uses the production context to keep session identity consistent. */
        @Override public HandlerContext getHandlerContext() { return this.context; }
        /** Retains the actual snapshot reset path before history selection. */
        @Override public StreamMessageCoalescer getStreamCoalescer() { return this.coalescer; }
        /** Avoids opening permission UI in this lifecycle fixture. */
        @Override public void clearPendingPermissionRequests() {
            // no-op in lifecycle test fixture
        }
        /** Keeps decisions local to the isolated fixture. */
        @Override public void clearPermissionDecisionMemory() {
            // no-op in lifecycle test fixture
        }
        /** Replaces JCEF delivery while exercising the lifecycle manager. */
        @Override public void callJavaScript(String functionName, String... args) {
            // no-op in lifecycle test fixture
        }
        /** Keeps the destination available during release ordering. */
        @Override public boolean isDisposed() { return false; }
        /** Avoids constructing a real JCEF browser. */
        @Override public JBCefBrowser getBrowser() { return null; }
        /** Leaves browser callbacks outside the release-ordering contract. */
        @Override public void setupSessionCallbacks() {
            // no-op in lifecycle test fixture
        }
        /** Leaves page generations outside the release-ordering contract. */
        @Override public void invalidateSessionCallbacks() {
            // no-op in lifecycle test fixture
        }
        /** Avoids unrelated command catalog updates. */
        @Override public void setSlashCommandsFetched(boolean fetched) {
            // no-op in lifecycle test fixture
        }
        /** Avoids unrelated command count updates. */
        @Override public void setFetchedSlashCommandsCount(int count) {
            // no-op in lifecycle test fixture
        }
    }
}
