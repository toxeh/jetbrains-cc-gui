import fs from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

/**
 * Extract the command string from a tool input object or raw string.
 * @param {unknown} commandOrInput
 * @returns {string}
 */
export function extractToolCommandString(commandOrInput) {
  if (typeof commandOrInput === 'string') {
    return commandOrInput;
  }
  if (!commandOrInput || typeof commandOrInput !== 'object') {
    return '';
  }
  for (const key of ['command', 'CommandLine', 'cmd', 'script', 'commandLine']) {
    if (typeof commandOrInput[key] === 'string' && commandOrInput[key].trim()) {
      return commandOrInput[key].trim();
    }
  }
  return '';
}

/**
 * Return true when a tool command launches sparc-router.py.
 * @param {unknown} commandOrInput
 * @returns {boolean}
 */
export function isSparcRouterCommand(commandOrInput) {
  const cmd = extractToolCommandString(commandOrInput);
  if (!cmd) return false;
  return /sparc-router\.py\b/i.test(cmd);
}

/**
 * Extract the latest human-readable stage/story status line from sparc-router output.
 * @param {string} text
 * @returns {string}
 */
export function extractLatestSparcStageSummary(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const lines = text.split(/\r?\n/);
  let fallbackLine = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw.startsWith('[SPARC-AUTO]')) continue;
    const body = raw.slice('[SPARC-AUTO]'.length).trim();
    if (!body) continue;
    if (!fallbackLine) fallbackLine = body;
    if (
      body.startsWith('▶ STAGE START')
      || body.startsWith('⏳ STAGE RUNNING')
      || body.startsWith('✔ STAGE END')
      || body.startsWith('⚠ STAGE FAIL')
      || body.startsWith('📖 STORY')
      || body.startsWith('🏁 STORY')
      || body.startsWith('🔍 REVIEW VERDICT')
      || body.startsWith('📦 BATCH START')
      || body.startsWith('🎉 BATCH DONE')
      || body.startsWith('Attempt #')
      || body.startsWith('Completed by ')
      || body.startsWith('DELIVER ')
      || body.startsWith('DELIVER-ALL ')
    ) {
      return body;
    }
  }
  return fallbackLine;
}

function normalizeComparablePath(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  try {
    return resolve(p.trim());
  } catch {
    return p.trim();
  }
}

/**
 * Resolve the active sparc-router state & log files in runsDir created around or after startedAtMs.
 * @param {{ runsDir: string, cwd?: string, startedAtMs: number }} options
 * @returns {{ statePath: string, logPath: string, state: Record<string, unknown> | null } | null}
 */
export function findActiveSparcRouterRun({ runsDir, cwd = '', startedAtMs = 0 }) {
  if (!runsDir) return null;
  let entries;
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return null;
  }
  const targetCwd = normalizeComparablePath(cwd);
  const minMtime = Math.max(0, startedAtMs - 3000);

  // 1) Check latest.json pointer first
  const latestPath = join(runsDir, 'latest.json');
  try {
    const stat = fs.statSync(latestPath);
    if (stat.mtimeMs >= minMtime) {
      const latest = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
      const latestCwd = normalizeComparablePath(latest?.cwd || '');
      if (!targetCwd || !latestCwd || latestCwd === targetCwd) {
        const statePath = typeof latest?.state_path === 'string' ? latest.state_path : '';
        const logPath = typeof latest?.log_path === 'string'
          ? latest.log_path
          : (statePath ? statePath.replace(/\.json$/i, '.log') : '');
        let state = null;
        if (statePath) {
          try {
            state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
          } catch {
            state = latest;
          }
        }
        if (statePath || logPath) {
          return { statePath, logPath, state };
        }
      }
    }
  } catch {
    // fall through to directory scan
  }

  // 2) Scan runsDir for newest .json state file
  let best = null;
  let bestMtime = -1;
  for (const name of entries) {
    if (!name.endsWith('.json') || name === 'latest.json') continue;
    // Skip CLI model stdout logs; only router state JSONs match <stamp>-<phase>-<slug>.json
    const statePath = join(runsDir, name);
    let stat;
    try {
      stat = fs.statSync(statePath);
    } catch {
      continue;
    }
    if (stat.mtimeMs < minMtime) continue;
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch {
      continue;
    }
    const stateCwd = normalizeComparablePath(state?.cwd || '');
    if (targetCwd && stateCwd && stateCwd !== targetCwd) {
      continue;
    }
    const logPath = typeof state?.log === 'string' && state.log
      ? state.log
      : statePath.replace(/\.json$/i, '.log');
    let effectiveMtime = stat.mtimeMs;
    try {
      const logStat = fs.statSync(logPath);
      if (logStat.mtimeMs > effectiveMtime) effectiveMtime = logStat.mtimeMs;
    } catch {
      // ignore missing log file
    }
    if (effectiveMtime > bestMtime) {
      bestMtime = effectiveMtime;
      best = { statePath, logPath, state };
    }
  }
  return best;
}

/**
 * Read the current console progress text from an active sparc-router run.
 * @param {{ statePath: string, logPath: string, state: Record<string, unknown> | null }} run
 * @returns {string}
 */
export function readSparcRouterRunText(run) {
  if (!run) return '';
  if (run.logPath) {
    try {
      const logText = fs.readFileSync(run.logPath, 'utf-8');
      if (logText && logText.trim()) {
        return logText;
      }
    } catch {
      // fall back to state JSON events
    }
  }
  const state = run.state;
  if (!state || typeof state !== 'object') return '';
  if (Array.isArray(state.events) && state.events.length > 0) {
    return state.events.join('\n') + '\n';
  }
  const lines = [];
  if (run.statePath) {
    lines.push(`[SPARC-AUTO] ${(state.phase || 'DELIVER').toString().toUpperCase()} state=${run.statePath}`);
  }
  if (state.story) {
    const idxPart = state.story_index && state.story_total
      ? `[${state.story_index}/${state.story_total}] `
      : '';
    lines.push(
      `[SPARC-AUTO] ▶ STAGE | story ${idxPart}STORY-${state.story} | stage=${state.phase || 'deliver'} | `
      + `executor=${state.cli || 'pending'} | model=${state.label || state.model || 'selecting...'} | status=${state.status || 'running'}`
    );
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Start polling `~/.grok/sparc-router-runs` for live stage/story progress while a
 * `sparc-router.py` command is executing.
 *
 * @param {{
 *   cwd?: string,
 *   startedAtMs?: number,
 *   runsDir?: string,
 *   pollIntervalMs?: number,
 *   onUpdate?: (update: { content: string, latestSummary: string, state: Record<string, unknown> | null }) => void
 * }} options
 */
export function startSparcRouterLiveTail({
  cwd = '',
  startedAtMs = Date.now(),
  runsDir = '',
  pollIntervalMs = 750,
  onUpdate,
} = {}) {
  const effectiveRunsDir = runsDir
    || process.env.SPARC_ROUTER_RUNS_DIR
    || join(homedir(), '.grok', 'sparc-router-runs');

  let lastEmittedContent = '';
  let stopped = false;

  const pollNow = () => {
    const run = findActiveSparcRouterRun({
      runsDir: effectiveRunsDir,
      cwd,
      startedAtMs,
    });
    if (!run) return lastEmittedContent;
    const content = readSparcRouterRunText(run);
    if (content && content !== lastEmittedContent) {
      lastEmittedContent = content;
      if (typeof onUpdate === 'function') {
        try {
          onUpdate({
            content,
            latestSummary: extractLatestSparcStageSummary(content),
            state: run.state,
          });
        } catch {
          // ignore callback errors
        }
      }
    }
    return lastEmittedContent;
  };

  pollNow();
  const timer = setInterval(() => {
    if (stopped) return;
    pollNow();
  }, pollIntervalMs);
  timer.unref?.();

  return {
    pollNow,
    getLatestContent: () => lastEmittedContent,
    stop: () => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        pollNow();
      }
      return lastEmittedContent;
    },
  };
}
