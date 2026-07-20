import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrokContextUsagePayload } from './grok-utils.js';
import {
  getContextUsagePersistent,
  getUsagePersistent,
  __testing,
} from './persistent-acp-service.js';

const { resetRegistry, createTestRuntime, forceSetActiveTurn } = __testing;

test('buildGrokContextUsagePayload synthesizes conversation + free space', () => {
  const payload = buildGrokContextUsagePayload({
    usedTokens: 50_000,
    maxTokens: 200_000,
    model: 'grok-2',
  });
  assert.equal(payload.success, true);
  assert.equal(payload.totalTokens, 50_000);
  assert.equal(payload.maxTokens, 200_000);
  assert.equal(payload.percentage, 25);
  assert.equal(payload.categories.length, 2);
  assert.equal(payload.categories[0].name, 'Conversation');
  assert.equal(payload.categories[1].tokens, 150_000);
  assert.equal(payload.source, 'grok-synthesized');
});

test('buildGrokContextUsagePayload clamps over-max usage', () => {
  const payload = buildGrokContextUsagePayload({ usedTokens: 999_999, maxTokens: 100 });
  assert.equal(payload.totalTokens, 100);
  assert.equal(payload.percentage, 100);
  assert.equal(payload.categories[1].tokens, 0);
});

test('getContextUsagePersistent uses Java-supplied used/max', async () => {
  resetRegistry();
  const payload = await getContextUsagePersistent({
    usedTokens: 1000,
    maxTokens: 10_000,
    model: 'grok-build',
  });
  assert.equal(payload.success, true);
  assert.equal(payload.totalTokens, 1000);
  assert.equal(payload.maxTokens, 10_000);
  assert.equal(payload.model, 'grok-build');
});

test('getContextUsagePersistent falls back to active runtime lastUsedTokens', async () => {
  resetRegistry();
  const rt = createTestRuntime('ctx-rt', { model: 'grok-2', permissionMode: 'default' });
  rt.lastUsedTokens = 777;
  forceSetActiveTurn(rt);

  const payload = await getContextUsagePersistent({ maxTokens: 500_000 });
  assert.equal(payload.totalTokens, 777);
  assert.equal(payload.model, 'grok-2');
});

test('getUsagePersistent returns structured unavailable on failure (does not throw)', async () => {
  resetRegistry();
  // Force failure path by using impossible cwd / no network expectations —
  // spawn may fail quickly without credentials.
  const payload = await getUsagePersistent({
    cwd: '/tmp',
    apiKey: '',
    authMethod: 'oauth',
  });
  assert.equal(payload.success, true);
  assert.ok(payload.data);
  // Either real CLI output or unavailable fallback
  if (payload.data.unavailable) {
    assert.equal(typeof payload.data.message, 'string');
    assert.ok(payload.data.message.length > 0);
  } else {
    assert.ok(payload.data.raw || payload.output || payload.data.config);
  }
});
