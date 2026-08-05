import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgyArgs,
  mapPermissionMode,
  normalizeUsageToSnakeCase,
  buildGeminiContextUsagePayload,
  buildErrorPayload,
  buildAgyEnv,
  resolveAgyBinary,
} from './agy-utils.js';

test('resolveAgyBinary honors explicit AGY_PATH without fallback', () => {
  const prev = process.env.AGY_PATH;
  const prevG = process.env.GEMINI_CLI_PATH;
  const prevA = process.env.AGY_CLI_PATH;
  process.env.AGY_PATH = '/nonexistent/agy-binary-xyz';
  process.env.GEMINI_CLI_PATH = '';
  process.env.AGY_CLI_PATH = '';
  try {
    assert.equal(resolveAgyBinary(), null);
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevG === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = prevG;
    if (prevA === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = prevA;
  }
});

test('mapPermissionMode default does not skip permissions', () => {
  const m = mapPermissionMode('default');
  assert.equal(m.skipPermissions, false);
  assert.equal(m.modeFlag, '');
  assert.equal(m.sandbox, false);
});

test('mapPermissionMode bypass/yolo/dontAsk/auto skips permissions', () => {
  assert.equal(mapPermissionMode('bypassPermissions').skipPermissions, true);
  assert.equal(mapPermissionMode('bypass').skipPermissions, true);
  assert.equal(mapPermissionMode('yolo').skipPermissions, true);
  assert.equal(mapPermissionMode('dontAsk').skipPermissions, true);
  assert.equal(mapPermissionMode('dont_ask').skipPermissions, true);
  assert.equal(mapPermissionMode('auto').skipPermissions, true);
  assert.equal(mapPermissionMode('always-proceed').skipPermissions, true);
});

test('mapPermissionMode plan and accept-edits set mode flags', () => {
  assert.equal(mapPermissionMode('plan').modeFlag, 'plan');
  assert.equal(mapPermissionMode('acceptEdits').modeFlag, 'accept-edits');
  assert.equal(mapPermissionMode('accept-edits').modeFlag, 'accept-edits');
  assert.equal(mapPermissionMode('accept_edits').modeFlag, 'accept-edits');
});

test('mapPermissionMode sandbox sets sandbox flag', () => {
  assert.equal(mapPermissionMode('sandbox').sandbox, true);
  assert.equal(mapPermissionMode('sandbox').skipPermissions, false);
});

test('buildAgyArgs includes stream-json and conversation resume', () => {
  const args = buildAgyArgs({
    message: 'hello',
    conversationId: 'cid-1',
    model: 'gemini-3.5-flash-medium',
    effort: 'high',
    permissionMode: 'bypassPermissions',
  });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('hello'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--conversation'));
  assert.ok(args.includes('cid-1'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('gemini-3.5-flash-medium'));
  assert.ok(args.includes('--effort'));
  assert.ok(args.includes('high'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--continue'));
});

test('buildAgyArgs uses --continue when no conversation id', () => {
  const args = buildAgyArgs({
    message: 'hi',
    continueRecent: true,
  });
  assert.ok(args.includes('--continue'));
  assert.ok(!args.includes('--conversation'));
});

test('buildAgyArgs plan mode and add-dir and agent and print-timeout', () => {
  const args = buildAgyArgs({
    message: 'x',
    permissionMode: 'plan',
    agent: 'explorer',
    printTimeout: '30s',
    addDirs: ['/tmp/a', '', '/tmp/b'],
  });
  assert.ok(args.includes('--mode'));
  assert.ok(args.includes('plan'));
  assert.ok(args.includes('--agent'));
  assert.ok(args.includes('explorer'));
  assert.ok(args.includes('--print-timeout'));
  assert.ok(args.includes('30s'));
  assert.ok(args.includes('--add-dir'));
  assert.ok(args.includes('/tmp/a'));
  assert.ok(args.includes('/tmp/b'));
});

test('buildAgyArgs effort is lowercased', () => {
  const args = buildAgyArgs({ message: 'm', effort: 'HIGH' });
  const i = args.indexOf('--effort');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'high');
});

test('normalizeUsageToSnakeCase maps fields and camelCase', () => {
  const u = normalizeUsageToSnakeCase({
    input_tokens: 10,
    output_tokens: 5,
    thinking_tokens: 2,
    cache_read_tokens: 3,
    total_tokens: 17,
  });
  assert.deepEqual(u, {
    input_tokens: 10,
    output_tokens: 5,
    thinking_tokens: 2,
    cache_read_tokens: 3,
    total_tokens: 17,
  });

  const camel = normalizeUsageToSnakeCase({
    inputTokens: 1,
    outputTokens: 2,
    thinkingTokens: 3,
  });
  assert.equal(camel.input_tokens, 1);
  assert.equal(camel.output_tokens, 2);
  assert.equal(camel.thinking_tokens, 3);
  assert.equal(camel.total_tokens, 6);
});

test('normalizeUsageToSnakeCase returns null for empty usage', () => {
  assert.equal(normalizeUsageToSnakeCase(null), null);
  assert.equal(normalizeUsageToSnakeCase({}), null);
  assert.equal(normalizeUsageToSnakeCase({ input_tokens: 0, output_tokens: 0 }), null);
});

test('buildGeminiContextUsagePayload percentage', () => {
  const p = buildGeminiContextUsagePayload({ usedTokens: 50, maxTokens: 200, model: 'm' });
  assert.equal(p.success, true);
  assert.equal(p.data.percentage, 25);
  assert.equal(p.data.model, 'm');
  assert.equal(p.data.source, 'gemini-bridge');
});

test('buildGeminiContextUsagePayload clamps percentage at 100', () => {
  const p = buildGeminiContextUsagePayload({ usedTokens: 9999, maxTokens: 100 });
  assert.equal(p.data.percentage, 100);
});

test('buildErrorPayload extracts message', () => {
  const p = buildErrorPayload(new Error('boom'), { code: 1 });
  assert.equal(p.success, false);
  assert.equal(p.error, 'boom');
  assert.equal(p.code, 1);
});

test('buildAgyEnv sets non-interactive defaults', () => {
  const env = buildAgyEnv({ PATH: '/bin', HOME: '/tmp' });
  assert.equal(env.CI, '1');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.TERM, 'dumb');
});
