/**
 * Antigravity CLI (agy) helpers for the Gemini provider bridge.
 * Docs: https://antigravity.google/docs/cli/headless
 */

import { existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_MAX_TOKENS = 200_000;

export function getAgyHome() {
  return process.env.AGY_HOME
    || process.env.ANTIGRAVITY_CLI_HOME
    || join(homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Resolve agy binary.
 * Prefer AGY_PATH / GEMINI_CLI_PATH, then ~/.local/bin/agy (user-facing CLI),
 * then ~/.gemini/antigravity-cli, PATH. Prefer `agy` over `agy.real` —
 * `agy.real` is an internal install artifact and is not the preferred entrypoint.
 */
function isExecutableBinary(path) {
  if (!path || !existsSync(path)) return false;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgyBinary() {
  // Explicit override: honor it strictly (no silent fallback) so misconfigured
  // AGY_PATH / GEMINI_CLI_PATH fails loudly instead of picking another binary.
  const explicit = (process.env.AGY_PATH || process.env.GEMINI_CLI_PATH || process.env.AGY_CLI_PATH || '').trim();
  if (explicit) {
    return isExecutableBinary(explicit) ? explicit : null;
  }

  const candidates = [];
  const home = homedir();
  const agyHome = getAgyHome();
  candidates.push(
    join(home, '.local', 'bin', 'agy'),
    join(agyHome, 'bin', 'agy'),
    join(home, 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
    // Fallback only if the user-facing `agy` shim is missing
    join(home, '.local', 'bin', 'agy.real'),
    join(agyHome, 'bin', 'agy.real'),
  );

  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    candidates.push(join(dir, 'agy'), join(dir, 'agy.real'));
  }

  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (isExecutableBinary(c)) return c;
  }
  return null;
}

export function isAgyAvailable() {
  return !!resolveAgyBinary();
}

/**
 * Map unified plugin permission modes onto agy CLI flags.
 * Headless has no interactive Ask UI — default is soft-deny for Ask tools.
 *
 * @returns {{ skipPermissions: boolean, modeFlag: string, sandbox: boolean }}
 */
export function mapPermissionMode(permissionMode) {
  const m = String(permissionMode || 'default').trim().toLowerCase();
  const out = { skipPermissions: false, modeFlag: '', sandbox: false };

  if (m === 'plan') {
    out.modeFlag = 'plan';
  } else if (m === 'acceptedits' || m === 'accept-edits' || m === 'accept_edits') {
    out.modeFlag = 'accept-edits';
  }

  if (
    m === 'bypasspermissions'
    || m === 'bypass'
    || m === 'yolo'
    || m === 'dontask'
    || m === 'dont_ask'
    || m === 'auto'
    || m === 'always-proceed'
    || m === 'always_proceed'
  ) {
    out.skipPermissions = true;
  }

  if (m === 'sandbox') {
    out.sandbox = true;
  }

  return out;
}

/**
 * Build argv for one headless turn.
 */
export function buildAgyArgs(options = {}) {
  const {
    message = '',
    conversationId = '',
    model = '',
    effort = '',
    agent = '',
    permissionMode = '',
    continueRecent = false,
    printTimeout = '',
    addDirs = [],
  } = options;

  const perm = mapPermissionMode(permissionMode);
  const args = [
    '-p', String(message ?? ''),
    '--output-format', 'stream-json',
  ];

  if (conversationId && String(conversationId).trim()) {
    args.push('--conversation', String(conversationId).trim());
  } else if (continueRecent) {
    args.push('--continue');
  }

  if (model && String(model).trim()) {
    args.push('--model', String(model).trim());
  }
  if (effort && String(effort).trim()) {
    args.push('--effort', String(effort).trim().toLowerCase());
  }
  if (agent && String(agent).trim()) {
    args.push('--agent', String(agent).trim());
  }
  if (perm.modeFlag) {
    args.push('--mode', perm.modeFlag);
  }
  if (perm.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (perm.sandbox) {
    args.push('--sandbox');
  }
  if (printTimeout && String(printTimeout).trim()) {
    args.push('--print-timeout', String(printTimeout).trim());
  }

  if (Array.isArray(addDirs)) {
    for (const d of addDirs) {
      if (d && String(d).trim()) {
        args.push('--add-dir', String(d).trim());
      }
    }
  }

  return args;
}

export function buildAgyEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  env.CI = env.CI || '1';
  env.NO_COLOR = env.NO_COLOR || '1';
  env.TERM = env.TERM || 'dumb';
  if (!env.AGY_PATH) {
    const resolved = resolveAgyBinary();
    if (resolved) env.AGY_PATH = resolved;
  }
  return env;
}

/**
 * List models via `agy models` (one line per slug).
 */
export function listAgyModels() {
  const bin = resolveAgyBinary();
  if (!bin) return [];
  try {
    const r = spawnSync(bin, ['models'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: buildAgyEnv(),
    });
    const out = String(r.stdout || '');
    return out
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((s) => s && !s.startsWith('Usage') && !s.startsWith('CLI'));
  } catch {
    return [];
  }
}

export function normalizeUsageToSnakeCase(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = num(usage.input_tokens ?? usage.inputTokens);
  const output = num(usage.output_tokens ?? usage.outputTokens);
  const thinking = num(usage.thinking_tokens ?? usage.thinkingTokens);
  const cacheRead = num(usage.cache_read_tokens ?? usage.cacheReadTokens);
  const total = num(usage.total_tokens ?? usage.totalTokens)
    || (input + output + thinking);
  if (input === 0 && output === 0 && thinking === 0 && total === 0 && cacheRead === 0) {
    return null;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    thinking_tokens: thinking,
    cache_read_tokens: cacheRead,
    total_tokens: total,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function buildGeminiContextUsagePayload({ usedTokens = 0, maxTokens = DEFAULT_MAX_TOKENS, model = '' } = {}) {
  const used = Math.max(0, Number(usedTokens) || 0);
  const max = Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS);
  const percentage = Math.min(100, Math.round((used / max) * 1000) / 10);
  return {
    success: true,
    data: {
      usedTokens: used,
      maxTokens: max,
      percentage,
      model: model || '',
      source: 'gemini-bridge',
    },
  };
}

export function buildErrorPayload(error, extras = {}) {
  const message = error?.message || String(error || 'Unknown error');
  return {
    success: false,
    error: message,
    ...extras,
  };
}

export { DEFAULT_MAX_TOKENS };
