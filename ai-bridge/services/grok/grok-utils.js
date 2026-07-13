/**
 * Grok utilities — binary resolution, env handling, error formatting.
 * ACP primary (`grok agent stdio`); headless remains secondary fallback option.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function resolveGrokBinary() {
  const explicit = process.env.GROK_CLI_PATH;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  // Common install locations
  const candidates = [
    join(homedir(), '.grok', 'bin', 'grok'),
    join(homedir(), '.local', 'bin', 'grok'),
    '/usr/local/bin/grok',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Fall back to PATH
  return explicit || 'grok';
}

export function buildGrokEnv(baseEnv = process.env, apiKey, baseUrl, authMethod = '') {
  const env = { ...baseEnv };

  // Clean up potentially conflicting vars
  delete env.CLAUDE_API_KEY;
  delete env.CODEX_API_KEY;

  const method = normalizeAuthMethod(authMethod || env.GROK_AUTH_METHOD || '');

  if (method === 'oauth') {
    // Do not let host/process API keys force xai.api_key over cached OAuth token.
    delete env.XAI_API_KEY;
    delete env.GROK_API_KEY;
  } else if (apiKey) {
    env.XAI_API_KEY = apiKey;
    env.GROK_API_KEY = apiKey;
  } else if (method === 'api_key') {
    // keep existing env keys if present
  }

  if (method) {
    env.GROK_AUTH_METHOD = method;
  }

  applyGrokBaseUrlEnv(env, method, baseUrl);

  // Force non-interactive / no update noise on ACP stdio
  env.GROK_NO_AUTO_UPDATE = '1';
  env.CI = env.CI || '1';

  return env;
}

/**
 * Apply gateway base URL overrides per auth method.
 * Empty baseUrl leaves CLI defaults (direct xAI / cli-chat-proxy.grok.com).
 *
 * - api_key → XAI_API_BASE_URL + GROK_BASE_URL (…/xai/v1)
 * - oauth   → GROK_CLI_CHAT_PROXY_BASE_URL + GROK_BASE_URL (…/grok/v1)
 * - auto    → all three (host already resolved single effective base)
 */
export function applyGrokBaseUrlEnv(env, authMethod, baseUrl) {
  const url = String(baseUrl || '').trim();
  if (!url) return env;
  const method = normalizeAuthMethod(authMethod) || 'oauth';

  if (method === 'api_key') {
    env.XAI_API_BASE_URL = url;
    env.GROK_BASE_URL = url;
    delete env.GROK_CLI_CHAT_PROXY_BASE_URL;
  } else if (method === 'oauth') {
    env.GROK_CLI_CHAT_PROXY_BASE_URL = url;
    env.GROK_BASE_URL = url;
    delete env.XAI_API_BASE_URL;
  } else {
    env.GROK_BASE_URL = url;
    env.XAI_API_BASE_URL = url;
    env.GROK_CLI_CHAT_PROXY_BASE_URL = url;
  }
  return env;
}

/** True when URL looks like gateway root /v1 without /xai or /grok namespace. */
export function isBareGatewayV1Base(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return false;
  // …/v1 but not …/xai/v1 or …/grok/v1
  if (!/\/v1$/i.test(u)) return false;
  if (/\/(xai|grok)\/v1$/i.test(u)) return false;
  return true;
}

export function normalizeAuthMethod(method) {
  const m = String(method || '').trim().toLowerCase();
  if (m === 'api_key' || m === 'xai.api_key' || m === 'apikey') return 'api_key';
  if (m === 'auto') return 'auto';
  if (m === 'oauth' || m === 'cached_token' || m === 'cli_login' || m === 'grok.com') return 'oauth';
  return m || '';
}

/**
 * Select ACP authenticate methodId given agent authMethods + plugin preference.
 * Priority when preferred=oauth: cached_token > grok.com > (never api_key unless only option)
 * preferred=api_key: xai.api_key if key present
 * preferred=auto: cached_token/oauth first, then api_key
 */
export function selectGrokAuthMethodId({
  authMethods = new Set(),
  defaultAuth = null,
  preferred = 'oauth',
  hasApiKey = false,
} = {}) {
  const methods = authMethods instanceof Set
    ? authMethods
    : new Set((authMethods || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean));

  const pref = normalizeAuthMethod(preferred) || 'oauth';

  const pickOAuth = () => {
    if (methods.has('cached_token')) return 'cached_token';
    if (methods.has('grok.com')) return 'grok.com';
    return null;
  };
  const pickApiKey = () => (hasApiKey && methods.has('xai.api_key') ? 'xai.api_key' : null);

  if (pref === 'oauth') {
    return pickOAuth() || (methods.has('xai.api_key') && hasApiKey ? 'xai.api_key' : null);
  }
  if (pref === 'api_key') {
    return pickApiKey() || pickOAuth();
  }
  // auto: honor agent default only if not forcing api without key; prefer oauth when present
  const oauth = pickOAuth();
  if (oauth) return oauth;
  if (defaultAuth && methods.has(defaultAuth)) {
    if (defaultAuth !== 'xai.api_key' || hasApiKey) return defaultAuth;
  }
  return pickApiKey();
}

export function buildErrorPayload(error) {
  return {
    success: false,
    error: error?.message || String(error),
    stack: error?.stack,
  };
}

/**
 * Simple spawn wrapper (headless secondary path / diagnostics).
 */
export function spawnGrok(args, env, cwd, onData) {
  return new Promise((resolve, reject) => {
    const bin = resolveGrokBinary();
    console.error('[DEBUG] Spawning', bin, args.join(' '));

    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      if (onData) onData(s);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const err = new Error(`grok exited with code ${code}: ${stderr || stdout}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

/**
 * Read OIDC access JWT from ~/.grok/auth.json "key" field (used for Bearer auth to cli-chat-proxy).
 * This allows direct calls to /billing and /auto-topup-rule without spawning the CLI.
 */
export function getGrokChatProxyToken() {
  try {
    const authPath = join(homedir(), '.grok', 'auth.json');
    if (!existsSync(authPath)) return null;
    const content = readFileSync(authPath, 'utf8');
    const auth = JSON.parse(content);
    if (auth && typeof auth.key === 'string' && auth.key.length > 0) {
      return auth.key;
    }
    // Common alternative structures
    if (auth && auth.tokens && typeof auth.tokens.access_token === 'string') return auth.tokens.access_token;
    if (auth && typeof auth.access_token === 'string') return auth.access_token;
    if (auth && typeof auth.token === 'string') return auth.token;
    return null;
  } catch (e) {
    console.error('[Grok] Failed to read chat proxy token from ~/.grok/auth.json:', e.message);
    return null;
  }
}

/** Get the base URL for cli-chat-proxy billing calls (OAuth path). */
export function getGrokChatProxyBaseUrl() {
  return (process.env.GROK_CLI_CHAT_PROXY_BASE_URL || 'https://cli-chat-proxy.grok.com/v1').replace(/\/+$/, '');
}

/**
 * Direct fetch to Grok billing endpoint (the one behind `grok /usage`).
 * Returns the raw config object from ?format=credits .
 */
export async function fetchGrokBilling(options = {}) {
  const base = options.baseUrl || getGrokChatProxyBaseUrl();
  const token = options.token || getGrokChatProxyToken();
  if (!token) {
    throw new Error('No Grok OAuth token found. Run `grok login` or ensure ~/.grok/auth.json has a "key".');
  }
  const url = `${base}/billing?format=credits`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Grok billing request failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Fetch auto top-up rule (sometimes shown alongside billing).
 */
export async function fetchGrokAutoTopupRule(options = {}) {
  const base = options.baseUrl || getGrokChatProxyBaseUrl();
  const token = options.token || getGrokChatProxyToken();
  if (!token) {
    throw new Error('No Grok OAuth token for auto-topup-rule');
  }
  const url = `${base}/auto-topup-rule`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    // Some accounts may not have it; don't hard fail
    return null;
  }
  return res.json();
}
