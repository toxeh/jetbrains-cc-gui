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

/** Effort suffixes baked into agy model slugs (longest first). */
export const AGY_EFFORT_SUFFIXES = ['thinking', 'xhigh', 'medium', 'high', 'low'];

/**
 * Parse one `agy models` line: "id   Human Label (Effort)".
 * @returns {{ id: string, label: string } | null}
 */
export function parseAgyModelLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('Usage') || raw.startsWith('CLI') || raw.startsWith('Flags')) {
    return null;
  }
  const m = raw.match(/^(\S+)\s+(.*)$/);
  if (m) {
    const id = m[1].trim();
    const label = m[2].trim() || id;
    if (!id) return null;
    return { id, label };
  }
  // id-only line
  if (/^\S+$/.test(raw)) {
    return { id: raw, label: raw };
  }
  return null;
}

/**
 * Parse full `agy models` stdout into [{ id, label }, ...].
 */
export function parseAgyModelsOutput(text) {
  const out = String(text || '');
  const entries = [];
  const seen = new Set();
  for (const line of out.split(/\r?\n/)) {
    const parsed = parseAgyModelLine(line);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    entries.push(parsed);
  }
  return entries;
}

/**
 * Split an agy model slug into base family + effort suffix.
 * e.g. gemini-3.6-flash-high → { baseId, effort: 'high' }
 *      claude-opus-4-6-thinking → { baseId: 'claude-opus-4-6', effort: 'thinking' }
 *      claude-sonnet-4-6 → { baseId: 'claude-sonnet-4-6', effort: '' }
 */
export function splitAgyModelId(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return { baseId: '', effort: '' };
  for (const effort of AGY_EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (id.endsWith(suffix) && id.length > suffix.length) {
      return { baseId: id.slice(0, -suffix.length), effort };
    }
  }
  return { baseId: id, effort: '' };
}

/**
 * Compose full agy model slug from family base + effort.
 * If effort is empty, returns baseId. If baseId already ends with an effort, replaces it.
 */
export function composeAgyModelId(baseId, effort) {
  const base = String(baseId || '').trim();
  if (!base) return '';
  const { baseId: stripped } = splitAgyModelId(base);
  const family = stripped || base;
  const e = String(effort || '').trim().toLowerCase();
  if (!e) return family;
  return `${family}-${e}`;
}

/**
 * Strip trailing " (High|Medium|Low|Thinking)" style effort from display labels.
 */
export function stripEffortFromLabel(label) {
  const s = String(label || '').trim();
  if (!s) return s;
  return s
    .replace(/\s*\((?:Very\s+)?(?:High|Medium|Low|XHigh|Max|Thinking)\)\s*$/i, '')
    .trim() || s;
}

/**
 * Group flat agy catalog into UI families with subordinate effort options.
 * @param {Array<{id:string,label:string}>} entries
 * @returns {Array<{id:string,label:string,description:string,efforts:Array<{id:string,label:string,modelId:string}>,defaultEffort:string,defaultModelId:string}>}
 */
export function groupAgyModelFamilies(entries) {
  const list = Array.isArray(entries) ? entries : [];
  /** @type {Map<string, { id: string, label: string, efforts: Array<{id:string,label:string,modelId:string}>, order: number }>} */
  const families = new Map();
  let order = 0;

  for (const entry of list) {
    if (!entry || !entry.id) continue;
    const { baseId, effort } = splitAgyModelId(entry.id);
    const familyId = baseId || entry.id;
    let fam = families.get(familyId);
    if (!fam) {
      fam = {
        id: familyId,
        label: stripEffortFromLabel(entry.label) || familyId,
        efforts: [],
        order: order++,
      };
      families.set(familyId, fam);
    } else if (effort) {
      // Prefer non-effort label when we already have a bare entry, else strip
      const stripped = stripEffortFromLabel(entry.label);
      if (stripped && stripped.length < fam.label.length) {
        fam.label = stripped;
      }
    } else if (entry.label) {
      fam.label = stripEffortFromLabel(entry.label) || fam.label;
    }

    if (effort) {
      if (!fam.efforts.some((e) => e.id === effort)) {
        fam.efforts.push({
          id: effort,
          label: effortLabel(effort),
          modelId: entry.id,
        });
      }
    } else {
      // Bare slug (no effort suffix) — treat as sole "default" option
      if (!fam.efforts.some((e) => e.modelId === entry.id)) {
        fam.efforts.push({
          id: '',
          label: 'Default',
          modelId: entry.id,
        });
      }
    }
  }

  const EFFORT_RANK = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5, thinking: 6, '': 0 };
  const result = [];
  for (const fam of [...families.values()].sort((a, b) => a.order - b.order)) {
    fam.efforts.sort((a, b) => (EFFORT_RANK[a.id] ?? 50) - (EFFORT_RANK[b.id] ?? 50));
    const defaultEffort =
      fam.efforts.find((e) => e.id === 'medium')?.id
      ?? fam.efforts.find((e) => e.id === 'high')?.id
      ?? fam.efforts.find((e) => e.id === 'thinking')?.id
      ?? fam.efforts[0]?.id
      ?? '';
    const defaultModelId =
      fam.efforts.find((e) => e.id === defaultEffort)?.modelId
      ?? fam.efforts[0]?.modelId
      ?? fam.id;
    result.push({
      id: fam.id,
      label: fam.label,
      description: fam.efforts.length > 1
        ? `${fam.efforts.length} effort levels`
        : (fam.efforts[0]?.label || ''),
      efforts: fam.efforts,
      defaultEffort,
      defaultModelId,
    });
  }
  return result;
}

function effortLabel(effort) {
  const e = String(effort || '').toLowerCase();
  if (e === 'low') return 'Low';
  if (e === 'medium') return 'Medium';
  if (e === 'high') return 'High';
  if (e === 'xhigh') return 'XHigh';
  if (e === 'max') return 'Max';
  if (e === 'thinking') return 'Thinking';
  if (!e) return 'Default';
  return e.charAt(0).toUpperCase() + e.slice(1);
}

/**
 * List models via `agy models` (id + human label per line).
 * @returns {Array<{id:string,label:string}>}
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
    return parseAgyModelsOutput(String(r.stdout || ''));
  } catch {
    return [];
  }
}

/**
 * Full catalog for the plugin UI: flat models + grouped families.
 */
export function buildAgyModelsCatalog() {
  const models = listAgyModels();
  const families = groupAgyModelFamilies(models);
  return {
    models,
    families,
    binary: resolveAgyBinary() || '',
  };
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
