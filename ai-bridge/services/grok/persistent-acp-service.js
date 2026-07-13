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
import { buildGrokEnv, spawnGrok, getGrokChatProxyToken, getGrokChatProxyBaseUrl, fetchGrokBilling, fetchGrokAutoTopupRule } from './grok-utils.js';
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
      console.log('[GROK] server request during prompt:', method);
      if (isPermissionRequestMethod(method)) {
        // Read live from runtime so setPermissionModePersistent mid-turn takes effect
        const liveMode = runtime.permissionMode || params.permissionMode || '';
        const liveAuto = isAutoApproveMode(liveMode);
        const decision = await resolveAcpPermissionDecision(paramsReq, liveMode, {
          autoApprove: liveAuto,
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

    const sessInfo = await ensureSession(client, {
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
      lastUsage: null,
      contextLimit: extractGrokContextLimit(sessInfo && sessInfo.sessionMeta, params.model),
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
      // Capture usage updates so /context can report current context stats for Grok
      const upd = (p && (p.update || p.params && p.params.update)) || p;
      if (upd && (
        upd.usage || upd.type === 'usage' || upd.sessionUpdate === 'usage_update' || upd.kind === 'usage' ||
        // Broader: any object that carries token counts (different ACP variants)
        (typeof upd === 'object' && (upd.prompt_tokens != null || upd.input_tokens != null || upd.total_tokens != null ||
          upd.promptTokenCount != null || upd.inputTokenCount != null || upd.totalTokenCount != null))
      )) {
        const rawU = upd.usage || upd;
        // Store normalized so getContextUsagePersistent and bar see standard keys
        runtime.lastUsage = normalizeUsageForGrok(rawU);
      }
      if (typeof originalOnNotif === 'function') {
        try { originalOnNotif(method, p); } catch {}
      }
    };

    // Watchdog for long prompts (option 5): periodically verify the agent process is alive.
    let watchdog = null;
    const startWatchdog = () => {
      watchdog = setInterval(() => {
        const c = runtime.client;
        if (!c || c.closed || !c.proc || c.proc.killed) {
          console.error('[GROK-DAEMON] watchdog: agent process died during prompt');
          c?.abortActiveRequests('agent process died (watchdog)');
        } else {
          const idle = Date.now() - (c.lastActivity || 0);
          if (idle > 10 * 60 * 1000) {
            console.warn(`[GROK-DAEMON] watchdog: no activity for ${Math.round(idle / 1000)}s during prompt`);
          }
        }
      }, 30_000);
    };
    startWatchdog();

    try {
      const result = await runtime.client.prompt(sid, promptBlocks);  // no hard timeout (option 2)

      // restore notification handler
      runtime.client.onNotification = originalOnNotif;

      emit('prompt_result', result);
      const usageFromResult = result && result.usage ? result.usage : null;
      if (usageFromResult) {
        runtime.lastUsage = normalizeUsageForGrok(usageFromResult);
      }
      // Force [USAGE] emission (via normalizer) so the live context bar always gets updated
      // after the turn, using whatever the ACP surfaced (or was captured from notifications).
      // This ensures 0/500k does not stick when usage arrives under non-standard timing/shape.
      const usageToReport = runtime.lastUsage || (usageFromResult ? normalizeUsageForGrok(usageFromResult) : null);
      if (usageToReport) {
        runtime.lastUsage = normalizeUsageForGrok(usageToReport);
        emit('usage', usageToReport);
      }
      normalizer.finishSuccess(sid || runtime.sessionId, normalizer.assistantText);

      runtime.sessionId = sid || runtime.client.activeSessionId;
      return { sessionId: runtime.sessionId, success: true };
    } finally {
      if (watchdog) clearInterval(watchdog);
    }
  } catch (err) {
    normalizer.finishError(err);

    // On any error (incl. previous timeout cases), dispose so next message gets fresh agent (option 2+5).
    console.error('[GROK-DAEMON] turn failed — disposing runtime for recovery:', err?.message || err);
    disposeRuntime(runtime).catch(() => {});

    throw err;
  } finally {
    runtime.activeTurnCount = Math.max((runtime.activeTurnCount || 1) - 1, 0);
    clearActiveIf(runtime);
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

  // Swallow previous turn errors (e.g. timeout) so the queue can start the next turn.
  // Prevents "can't recover after ACP timeout" for Grok persistent mode.
  runtime._turnQueue = runtime._turnQueue
    .catch((prevErr) => {
      console.error('[GROK-DAEMON] previous turn failed, continuing queue:', prevErr?.message || prevErr);
    })
    .then(async () => {
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

export async function setPermissionModePersistent(params = {}) {
  let runtime = getActiveTurnRuntime();
  if (!runtime) {
    // fallback for tests that force via __testing
    runtime = activeTurnRuntime;
  }
  if (runtime && !runtime.closed) {
    const newMode = params.permissionMode || params.mode || params.permission_mode || 'default';
    runtime.permissionMode = newMode;
    console.log('[GROK-DAEMON] live permissionMode updated to ' + newMode + ' for epoch=' + (runtime.epoch || '(none)'));
  }
  // Note: since permission decisions read from runtime.permissionMode in the onServerRequest closure (see createRuntime),
  // the next tool permission request in the current turn will see the new mode.
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

/**
 * Best-effort getContextUsage for Grok (to support /context slash command).
 * Grok ACP does not expose a rich getContextUsage like Claude's SDK.
 * We synthesize a basic ContextUsageData using last prompt usage (if any) + model limit.
 * NOTE: exact "context window" accounting for Grok persistent sessions is not well defined in ACP.
 * Using last input as "used" is best effort approximation.
 * This allows the rich dialog to at least show total / max context after a response.
 */
export async function getContextUsagePersistent(params = {}) {
  const safeParams = params || {};
  const sessionId = safeParams.sessionId || null;
  const model = safeParams.model || 'grok-4.5';

  let runtime = null;
  // Find by sessionId if possible (scan current runtimes)
  if (sessionId) {
    for (const rt of getAllRuntimes()) {
      if (rt && !rt.closed && (rt.sessionId === sessionId || rt.client?.activeSessionId === sessionId)) {
        runtime = rt;
        break;
      }
    }
  }
  if (!runtime || runtime.closed) {
    // fallback to active turn runtime
    runtime = activeTurnRuntime;
  }

  if (!runtime || runtime.closed) {
    // Try to pre-warm a runtime so /context can work even without prior turn
    try {
      await preconnectPersistent({ ...safeParams, model });
      runtime = activeTurnRuntime;
      if (sessionId && !runtime) {
        for (const rt of getAllRuntimes()) {
          if (rt && !rt.closed && (rt.sessionId === sessionId || rt.client?.activeSessionId === sessionId)) {
            runtime = rt;
            break;
          }
        }
      }
    } catch (e) {
      console.warn('[GROK-DAEMON] getContextUsage preconnect failed (will report 0 used):', e.message);
    }
  }

  let used = 0;
  const rawUsage = runtime && runtime.lastUsage ? runtime.lastUsage : null;
  const usage = rawUsage ? normalizeUsageForGrok(rawUsage) : null;
  if (usage) {
    // Prefer input/prompt tokens as the current context window usage (what was fed for the call).
    // NOTE: For Grok persistent ACP it's unclear if this is full cumulative context or just the turn's input.
    // We use last reported as approximation. Max from catalog (500k for modern Grok).
    if (typeof usage.input_tokens === 'number') used = usage.input_tokens;
    else if (typeof usage.prompt_tokens === 'number') used = usage.prompt_tokens;
    else if (typeof usage.total_tokens === 'number') used = usage.total_tokens;
  }

  const maxTokens = (runtime && runtime.contextLimit) || getGrokModelContextLimit(model);
  const percentage = maxTokens > 0 ? Math.round((used / maxTokens) * 100) : 0;

  const data = {
    totalTokens: used,
    maxTokens,
    rawMaxTokens: maxTokens,
    percentage,
    model,
    categories: [
      { name: 'Messages', tokens: used, color: '#7c6ff7' },
      { name: 'Free space', tokens: Math.max(0, maxTokens - used), color: '#6b7280' }
    ],
    gridRows: [],
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    skills: { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: [] },
    isAutoCompactEnabled: false,
  };

  console.log(JSON.stringify({ success: true, data }));
}

/** Small helper mirroring main Java limits for Grok models (used only for /context dialog). */
function getGrokModelContextLimit(model) {
  if (!model) return 500000;
  const m = String(model).toLowerCase();
  if (m.includes('grok-2') || m.includes('grok-1.5') || m.includes('beta')) return 128000;
  // grok-4.5, grok-4, grok-build etc. use 500k
  return 500000;
}

/**
 * Try to extract actual context limit from sessionMeta returned by ensureSession / ACP.
 * Falls back to hardcoded if not present in meta (Grok ACP may or may not report it).
 */
function extractGrokContextLimit(meta, model) {
  if (meta && typeof meta === 'object') {
    const candidates = [
      meta.context_window_size,
      meta.contextWindow,
      meta.context_window,
      meta.max_tokens,
      meta.maxTokens,
      meta.model && meta.model.context_window,
      meta.model && meta.model.contextWindow,
      meta.session && meta.session.context_limit,
    ].filter(v => v != null);
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 1000) {
        return n;
      }
    }
  }
  return getGrokModelContextLimit(model);
}

/**
 * Normalize Grok usage object keys so both the live bar ([USAGE] -> Java) and
 * getContextUsagePersistent see prompt_tokens / input_tokens / total_tokens.
 * Accepts many variants the ACP / xAI response may use.
 */
function normalizeUsageForGrok(u) {
  if (!u || typeof u !== 'object') return u || {};
  const out = { ...u };
  const num = (v) => (typeof v === 'number' ? v : (typeof v === 'string' ? parseInt(v, 10) || null : null));
  // prompt/input for context window size (what the bar and dialog care about)
  if (out.prompt_tokens == null && out.input_tokens == null) {
    const p = num(out.promptTokenCount) ?? num(out.prompt_tokens) ??
              num(out.input_tokens) ?? num(out.inputTokens) ?? num(out.input) ?? num(out.prompt);
    if (p != null) {
      out.prompt_tokens = p;
      out.input_tokens = p;
    }
  }
  if (out.input_tokens == null && out.prompt_tokens != null) out.input_tokens = out.prompt_tokens;
  if (out.prompt_tokens == null && out.input_tokens != null) out.prompt_tokens = out.input_tokens;
  // totals
  if (out.total_tokens == null) {
    const t = num(out.total_tokens) ?? num(out.totalTokenCount) ?? num(out.totalTokens) ??
              (out.prompt_tokens != null && out.completion_tokens != null ? out.prompt_tokens + out.completion_tokens : null);
    if (t != null) out.total_tokens = t;
  }
  // also normalize completion for completeness (used by some consumers)
  if (out.completion_tokens == null) {
    out.completion_tokens = num(out.completion_tokens) ?? num(out.completionTokenCount) ??
                            num(out.output_tokens) ?? num(out.outputTokens) ?? num(out.output);
  }
  return out;
}

/**
 * Get current Grok billing/usage info by running the CLI `grok /usage`.
 * This provides weekly limit, credits, reset time etc. (analog of /usage command).
 */
export async function getUsagePersistent(params = {}) {
  try {
    // Prefer direct HTTP to the same endpoint the CLI uses (structured data, no CLI spawn)
    const token = getGrokChatProxyToken();
    if (token) {
      const base = params.baseUrl || getGrokChatProxyBaseUrl();
      const billing = await fetchGrokBilling({ baseUrl: base, token });
      let autoTopup = null;
      try {
        autoTopup = await fetchGrokAutoTopupRule({ baseUrl: base, token });
      } catch (_) {}
      console.log(JSON.stringify({
        success: true,
        data: billing,
        autoTopup,
        source: 'direct'
      }));
      return;
    }

    // Fallback: use the CLI (works for api_key too)
    const env = buildGrokEnv(process.env, params.apiKey || '', params.baseUrl || '', params.authMethod || params.auth || '');
    const { stdout, stderr } = await spawnGrok(['/usage'], env, params.cwd || process.cwd());
    const output = (stdout || '').trim();
    if (!output) {
      console.log(JSON.stringify({ success: false, error: stderr || 'No output from grok /usage' }));
      return;
    }
    const data = parseGrokUsageOutput(output);
    console.log(JSON.stringify({ success: true, output, data, source: 'cli' }));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.log(JSON.stringify({ success: false, error: msg }));
  }
}

function parseGrokUsageOutput(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = { raw: text };
  for (const line of lines) {
    if (/weekly limit/i.test(line)) {
      const m = line.match(/(\d+)%/i);
      if (m) result.weeklyLimitPercent = parseInt(m[1], 10);
      result.weeklyLimitLine = line;
    } else if (/next reset/i.test(line)) {
      const m = line.match(/Next reset:\s*(.+)/i);
      if (m) result.nextReset = m[1].trim();
    } else if (/^credits:/i.test(line)) {
      const m = line.match(/Credits:\s*\$?([\d.]+)/i);
      if (m) result.credits = parseFloat(m[1]);
      result.creditsLine = line;
    } else if (/auto topup/i.test(line)) {
      const m = line.match(/Auto topup:\s*(.+)/i);
      if (m) result.autoTopup = m[1].trim().toLowerCase() === 'enabled';
    }
  }
  return result;
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
  // expose internal for tests
  getActiveTurnRuntimeInternal: () => activeTurnRuntime,
  // Test helpers for more coverage
  createTestRuntime: (key, overrides = {}) => {
    const rt = {
      key,
      client: { activeSessionId: 'test-sess', prompt: async () => ({}), close: async () => {}, abortActiveRequests: () => {} },
      sessionId: 'test-sess',
      epoch: 'test-epoch',
      cwd: '/tmp',
      model: '',
      permissionMode: 'default',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      activeTurnCount: 0,
      closed: false,
      lastUsage: null,
      ...overrides
    };
    runtimes.set(key, rt);
    return rt;
  },
  forceSetActiveTurn: (rt) => { activeTurnRuntime = rt; },
  triggerCleanup: () => {
    // Manually trigger the logic from the interval for tests
    const now = Date.now();
    for (const [key, rt] of runtimes.entries()) {
      if (!rt || rt.closed) { runtimes.delete(key); continue; }
      const last = rt.lastUsedAt || rt.createdAt || 0;
      const idleMs = now - last;
      const maxIdleMs = rt.sessionId ? 30 * 60 * 1000 : 10 * 60 * 1000;
      if ((rt.activeTurnCount || 0) === 0 && idleMs > maxIdleMs) {
        disposeRuntime(rt).catch(() => {});
      }
    }
  }
};

// More aggressive runtime cleanup for Grok (periodic idle disposal)
const GROK_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
setInterval(() => {
  const now = Date.now();
  for (const [key, rt] of runtimes.entries()) {
    if (!rt || rt.closed) {
      runtimes.delete(key);
      continue;
    }
    const last = rt.lastUsedAt || rt.createdAt || 0;
    const idleMs = now - last;
    const maxIdleMs = rt.sessionId ? 30 * 60 * 1000 : 10 * 60 * 1000; // session 30m, anon 10m
    if ((rt.activeTurnCount || 0) === 0 && idleMs > maxIdleMs) {
      console.log('[GROK-DAEMON] aggressive cleanup of idle runtime key=' + key);
      disposeRuntime(rt).catch(() => {});
    }
  }
}, GROK_CLEANUP_INTERVAL_MS);
