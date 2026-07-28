import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeContextUsagePayload } from './claude-channel.js';

test('buildClaudeContextUsagePayload synthesizes conversation + free space', () => {
  const payload = buildClaudeContextUsagePayload({
    usedTokens: 50_000,
    maxTokens: 200_000,
    model: 'claude-opus-4-5',
  });
  assert.equal(payload.success, true);
  assert.equal(payload.source, 'claude-synthesized');
  assert.equal(payload.totalTokens, 50_000);
  assert.equal(payload.maxTokens, 200_000);
  assert.equal(payload.percentage, 25);
  assert.equal(payload.model, 'claude-opus-4-5');
  assert.equal(payload.isAutoCompactEnabled, false);
  assert.equal(payload.categories.length, 2);
  assert.equal(payload.categories[0].name, 'Conversation');
  assert.equal(payload.categories[0].tokens, 50_000);
  assert.equal(payload.categories[0].color, 'claude');
  assert.equal(payload.categories[1].name, 'Free space');
  assert.equal(payload.categories[1].tokens, 150_000);
  assert.equal(payload.categories[1].color, 'inactive');
  assert.deepEqual(payload.memoryFiles, []);
  assert.deepEqual(payload.mcpTools, []);
  assert.deepEqual(payload.agents, []);
});

test('buildClaudeContextUsagePayload clamps over-max usage', () => {
  const payload = buildClaudeContextUsagePayload({ usedTokens: 999_999, maxTokens: 100_000 });
  assert.equal(payload.totalTokens, 100_000);
  assert.equal(payload.percentage, 100);
  assert.equal(payload.categories[1].tokens, 0);
});

test('buildClaudeContextUsagePayload handles zero usage', () => {
  const payload = buildClaudeContextUsagePayload({ usedTokens: 0, maxTokens: 200_000, model: 'claude-haiku-4-5' });
  assert.equal(payload.totalTokens, 0);
  assert.equal(payload.percentage, 0);
  assert.equal(payload.categories[1].tokens, 200_000);
});

test('buildClaudeContextUsagePayload uses 200k default when maxTokens absent or zero', () => {
  const noMax = buildClaudeContextUsagePayload({ usedTokens: 0 });
  assert.equal(noMax.maxTokens, 200_000);

  const zeroMax = buildClaudeContextUsagePayload({ usedTokens: 0, maxTokens: 0 });
  assert.equal(zeroMax.maxTokens, 200_000);
});

test('buildClaudeContextUsagePayload handles negative maxTokens sentinel', () => {
  const payload = buildClaudeContextUsagePayload({ usedTokens: 1_000, maxTokens: -1 });
  assert.equal(payload.maxTokens, 200_000);
  assert.ok(payload.percentage < 1, 'should not show 100% for negative sentinel');
});

test('buildClaudeContextUsagePayload handles undefined/null inputs', () => {
  const payload = buildClaudeContextUsagePayload({});
  assert.equal(payload.success, true);
  assert.equal(payload.totalTokens, 0);

  const noArgs = buildClaudeContextUsagePayload();
  assert.equal(noArgs.success, true);
});

test('buildClaudeContextUsagePayload gridRows has 1 row with 2 cells', () => {
  const payload = buildClaudeContextUsagePayload({ usedTokens: 50_000, maxTokens: 200_000 });
  assert.equal(payload.gridRows.length, 1);
  assert.equal(payload.gridRows[0].length, 2);

  const usedCell = payload.gridRows[0][0];
  assert.equal(usedCell.color, 'claude');
  assert.equal(usedCell.isFilled, true);
  assert.equal(usedCell.categoryName, 'Conversation');

  const freeCell = payload.gridRows[0][1];
  assert.equal(freeCell.color, 'inactive');
  assert.equal(freeCell.isFilled, false);
  assert.equal(freeCell.categoryName, 'Free space');
});

test('buildClaudeContextUsagePayload squareFullness is proportional', () => {
  const payload = buildClaudeContextUsagePayload({ usedTokens: 10_000, maxTokens: 200_000 });
  const usedCell = payload.gridRows[0][0];
  assert.ok(
    Math.abs(usedCell.squareFullness - 0.05) < 0.001,
    `expected 0.05, got ${usedCell.squareFullness}`
  );
});

test('buildClaudeContextUsagePayload rawMaxTokens is unclamped', () => {
  const normal = buildClaudeContextUsagePayload({ usedTokens: 50_000, maxTokens: 200_000 });
  assert.equal(normal.rawMaxTokens, 200_000);
});
