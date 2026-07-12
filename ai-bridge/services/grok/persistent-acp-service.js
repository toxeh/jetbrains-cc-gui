/**
 * Persistent ACP service for Grok daemon mode.
 *
 * Mirrors the spirit of claude/persistent-query-service but for ACP `grok agent stdio`.
 * Keeps GrokAcpClient (and its authenticated ACP session) warm across turns
 * for the same runtime key (epoch + session + cwd + model + permissionMode).
 *
 * Commands exposed to daemon:
 *   grok.send
 *   grok.preconnect
 *   grok.resetRuntime
 *   (abort handled at daemon level)
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  GrokAcpClient,
  initializeAndAuthenticate,
  ensureSession,
  applyAutoApproveIfNeeded,
  buildPromptBlocks,
  isAutoApproveMode,
  resolveAcpPermissionDecision,
  isPermissionRequestMethod,
} from './grok-acp-client.js';
import { GrokEventNormalizer } from './grok-event-normalizer.js';
import { buildGrokEnv } from './grok-utils.js';
import { requestPermissionFromJava } from '../../permission-ipc.js';
import { AcpTerminalHost } from './acp-terminal-host.js';

// =============================================================================
// Runtime registry (lightweight, Grok-specific)
// =============================================================================

const runtimes = new Map(); // runtimeKey -> runtime
let activeTurnRuntime = null;

function makeRuntimeKey(params) {
  const epoch = params.runtimeSessionEpoch || params.epoch || 'default';
  const sid = (params.sessionId || '').trim() || 'new';
  const cwd = (params.cwd || process.cwd()).trim();
  const model = (params.model || '').trim();
  const perm = (params.permissionMode || '').trim().toLowerCase();
  // authFingerprint: presence only (never secrets)
  const authMethod = String(params.authMethod || process.env.GROK_AUTH_METHOD || 'oauth').toLowerCase();
  const hasKey = !!(params.apiKey || process.env.XAI_API_KEY || process.env.GROK_API_KEY);
  const authFp = authMethod + ':' + (hasKey ? 'key' : 'nokey');
  const baseFp = String(params.baseUrl || '').trim() || 'direct';
  return [epoch, sid, cwd, model, perm, authFp + '|' + baseFp].join('|');
}

function getRuntime(key) {
  return runtimes.get(key) || null;
}

function rememberRuntime(key, runtime) {
  runtimes.set(key, runtime);
}

function removeRuntime(keyOrRuntime) {
  if (typeof keyOrRuntime === 'string') {
    const rt = runtimes.get(keyOrRuntime);
    if (rt) {
      runtimes.delete(keyOrRuntime);
      if (activeTurnRuntime === rt) activeTurnRuntime = null;
    }
  } else {
    for (const [k, rt] of runtimes.entries()) {
      if (rt === keyOrRuntime) {
        runtimes.delete(k);
      }
    }
    if (activeTurnRuntime === keyOrRuntime) activeTurnRuntime = null;
  }
}

function getAllRuntimes() {
  return Array.from(runtimes.values());
}

function setActive(runtime) {
  activeTurnRuntime = runtime || null;
}

function clearActiveIf(runtime) {
  if (activeTurnRuntime === runtime) activeTurnRuntime = null;
}

// =============================================================================
// Runtime lifecycle
// =============================================================================

async function createRuntime(params, { log } = {}) {
  const key = makeRuntimeKey(params);
  const existing = getRuntime(key);
  if (existing && !existing.closed) {
    return existing;
  }

  const workCwd = (params.cwd || '').trim() || process.cwd();
  const env = buildGrokEnv(process.env, params.apiKey, params.baseUrl, params.authMethod || process.env.GROK_AUTH_METHOD || '');
  if (params.reasoningEffort) {
    env.GROK_REASONING_EFFORT = String(params.reasoningEffort);
  }
  env.GROK_NO_AUTO_UPDATE = '1';
  env.CI = env.CI || '1';

  const autoApprove = isAutoApproveMode(params.permissionMode);

  const terminalHost = new AcpTerminalHost({
    defaultCwd: workCwd,
    env,
    onEvent: (event, data) => {
      // terminal events can be logged; not emitted as tags for UI in v1
      if (log) log('[GROK-TERM]', event);
    },
    authorizeCreate: async (info) => {
      if (autoApprove) return true;
      try {
        return await requestPermissionFromJava('run_terminal_command', {
          command: info.commandLine || info.command,
          cwd: info.cwd,
        });
      } catch {
        return false;
      }
    },
  });

  const client = new GrokAcpClient({
    env,
    cwd: workCwd,
    terminalHost,
    onStderr: (s) => {
      const t = String(s || '').trim();
      if (t) console.error('[GROK-ACP]', t.slice(0, 400));
    },
    onNotification: () => {
      // notifications are handled per-turn via the turn's normalizer
    },
    onServerRequest: async (method, paramsReq, id, acp) => {
      if (isPermissionRequestMethod(method)) {
        const decision = await resolveAcpPermissionDecision(paramsReq, params.permissionMode || '', {
          autoApprove,
        });
        acp.respond(id, decision.response);
        return true;
      }
      return false;
    },
  });

  client.start();

  try {
    const preferredAuth = String(params.authMethod || env.GROK_AUTH_METHOD || 'oauth').toLowerCase();
    const hasApiKeyFromEnv =
      preferredAuth === 'oauth'
        ? false
        : !!(params.apiKey || env.XAI_API_KEY || env.GROK_API_KEY);
    const { init } = await initializeAndAuthenticate(client, {
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      hasApiKeyFromEnv,
      authMethod: params.authMethod || env.GROK_AUTH_METHOD || '',
    });

    await ensureSession(client, {
      sessionId: params.sessionId || '',
      cwd: workCwd,
      model: params.model || '',
    });

    const auto = isAutoApproveMode(params.permissionMode);
    if (auto && client.activeSessionId) {
      await applyAutoApproveIfNeeded(client, client.activeSessionId, params.permissionMode);
    }

    const runtime = {
      key,
      client,
      sessionId: client.activeSessionId,
      epoch: params.runtimeSessionEpoch || params.epoch || 'default',
      cwd: workCwd,
      model: params.model || '',
      permissionMode: params.permissionMode || '',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      activeTurnCount: 0,
      closed: false,
      initResult: init,
    };

    rememberRuntime(key, runtime);
    console.log('[GROK-DAEMON] runtime created key=' + key.slice(0, 80) + ' sessionId=' + runtime.sessionId);
    return runtime;
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}

async function disposeRuntime(runtime) {
  if (!runtime || runtime.closed) return;
  runtime.closed = true;
  clearActiveIf(runtime);
  try {
    await runtime.client?.close();
  } catch {}
  removeRuntime(runtime);
  console.log('[GROK-DAEMON] runtime disposed');
}

async function resetRuntimesByFilter(filterFn) {
  const toDispose = [];
  for (const [k, rt] of runtimes.entries()) {
    if (filterFn(rt, k)) {
      toDispose.push(rt);
    }
  }
  for (const rt of toDispose) {
    await disposeRuntime(rt);
  }
}

// =============================================================================
// Turn execution (serialized per runtime via simple lock)
// =============================================================================

async function executeTurn(runtime, params, normalizer) {
  if (!runtime || runtime.closed) {
    throw new Error('Grok runtime is closed');
  }

  runtime.activeTurnCount = (runtime.activeTurnCount || 0) + 1;
  setActive(runtime);
  runtime.lastUsedAt = Date.now();

  const emit = (type, payload) => normalizer.handleAcpEvent(type, payload);

  try {
    normalizer.begin();

    // Ensure we have a live session id (in case previous was recreated)
    let sid = runtime.sessionId || params.sessionId || runtime.client?.activeSessionId || '';
    if (!sid || runtime.client.closed) {
      // re-ensure
      const sess = await ensureSession(runtime.client, {
        sessionId: sid,
        cwd: runtime.cwd,
        model: runtime.model,
      });
      sid = sess.sessionId;
      runtime.sessionId = sid;
    }

    emit('session_id', sid);

    const promptBlocks = buildPromptBlocks({
      message: params.message || '',
      agentPrompt: params.agentPrompt || '',
      openedFiles: params.openedFiles || null,
      attachments: params.attachments || [],
    });

    // Wire notifications for this turn into the normalizer
    const originalOnNotif = runtime.client.onNotification;
    runtime.client.onNotification = (method, p) => {
      emit('notification', { method, params: p });
      if (typeof originalOnNotif === 'function') {
        try { originalOnNotif(method, p); } catch {}
      }
    };

    const result = await runtime.client.prompt(sid, promptBlocks, 300_000);

    // restore
    runtime.client.onNotification = originalOnNotif;

    emit('prompt_result', result);
    normalizer.finishSuccess(sid || runtime.sessionId, normalizer.assistantText);

    runtime.sessionId = sid || runtime.client.activeSessionId;
    return { sessionId: runtime.sessionId, success: true };
  } catch (err) {
    normalizer.finishError(err);
    throw err;
  } finally {
    runtime.activeTurnCount = Math.max((runtime.activeTurnCount || 1) - 1, 0);
    clearActiveIf(runtime);
    // If client died during turn, drop runtime
    if (runtime.client && runtime.client.closed) {
      await disposeRuntime(runtime);
    }
  }
}

// =============================================================================
// Public API (called by daemon and fallback paths)
// =============================================================================

export async function sendMessagePersistent(params = {}) {
  const key = makeRuntimeKey(params);
  let runtime;
  try {
    runtime = await createRuntime(params);
  } catch (e) {
    console.error('[GROK-DAEMON] failed to create runtime, will rely on fallback:', e.message);
    throw e; // caller (daemon) will let Java fallback
  }

  // Simple per-runtime serialization: attach to runtime
  if (!runtime._turnQueue) runtime._turnQueue = Promise.resolve();

  const normalizer = new GrokEventNormalizer({
    log: (...a) => console.log(...a),
    error: (...a) => console.error(...a),
  });

  runtime._turnQueue = runtime._turnQueue.then(async () => {
    return executeTurn(runtime, params, normalizer);
  });

  try {
    const r = await runtime._turnQueue;
    // Note: the success JSON is already emitted by normalizer.finishSuccess()
    // Do not emit again to avoid duplicate processing on Java side.
    return r;
  } catch (e) {
    // error already emitted via [SEND_ERROR] + json by normalizer.finishError()
    throw e;
  }
}

export async function preconnectPersistent(params = {}) {
  try {
    const runtime = await createRuntime(params);
    console.log('[GROK-DAEMON] preconnect ok for key=' + runtime.key?.slice(0, 60));
    console.log(JSON.stringify({ success: true, sessionId: runtime.sessionId }));
    return { success: true, sessionId: runtime.sessionId };
  } catch (e) {
    console.warn('[GROK-DAEMON] preconnect failed (non-fatal):', e.message);
    // Do not throw — preconnect is best-effort
    return { success: false, error: e.message };
  }
}

export async function resetRuntimePersistent(params = {}) {
  const epoch = params.runtimeSessionEpoch || params.epoch;
  const key = params.runtimeKey || null;

  if (key) {
    const rt = getRuntime(key);
    if (rt) await disposeRuntime(rt);
    console.log('[GROK-DAEMON] reset by key');
  } else if (epoch) {
    await resetRuntimesByFilter((rt) => rt.epoch === epoch);
    console.log('[GROK-DAEMON] reset by epoch=' + epoch);
  } else {
    // reset all Grok
    const all = getAllRuntimes();
    for (const rt of all) await disposeRuntime(rt);
    console.log('[GROK-DAEMON] reset all');
  }

  console.log(JSON.stringify({ success: true }));
  return { success: true };
}

export async function abortCurrentTurn() {
  const runtime = activeTurnRuntime;
  if (!runtime) return;

  console.log('[GROK-DAEMON] abortCurrentTurn epoch=' + (runtime.epoch || '(none)'));

  clearActiveIf(runtime);

  try {
    runtime.client?.abortActiveRequests('user aborted');
  } catch {}

  // For safety and to match Claude behavior for abort, dispose the runtime.
  // Next send will recreate (cold start once).
  await disposeRuntime(runtime).catch(() => {});
}

export async function shutdownPersistentRuntimes() {
  const all = getAllRuntimes();
  for (const rt of all) {
    await disposeRuntime(rt).catch(() => {});
  }
  runtimes.clear();
  activeTurnRuntime = null;
  console.log('[GROK-DAEMON] shutdown all Grok runtimes');
}

// For daemon introspection / tests
export const __testing = {
  getRuntimes: () => getAllRuntimes(),
  getActiveTurnRuntime: () => activeTurnRuntime,
  makeRuntimeKey,
  resetRegistry: () => {
    runtimes.clear();
    activeTurnRuntime = null;
  },
};
