import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import {
  handleGeminiCommand,
  getGeminiCommandList,
} from './gemini-channel.js';

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(String(chunk));
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stdout.write = original;
    })
    .then(() => chunks.join(''));
}

test('getGeminiCommandList returns expected commands', () => {
  const list = getGeminiCommandList();
  assert.deepEqual(list.sort(), ['checkCli', 'getContextUsage', 'getUsage', 'listModels', 'send'].sort());
});

test('getContextUsage prints percentage payload', async () => {
  const out = await captureStdout(() =>
    handleGeminiCommand('getContextUsage', [], { usedTokens: 25, maxTokens: 100, model: 'm1' }),
  );
  const line = out.trim().split('\n').filter(Boolean).pop();
  const json = JSON.parse(line);
  assert.equal(json.success, true);
  assert.equal(json.data.percentage, 25);
  assert.equal(json.data.model, 'm1');
  assert.equal(json.data.source, 'gemini-bridge');
});

test('getUsage prints unavailable billing stub', async () => {
  const out = await captureStdout(() => handleGeminiCommand('getUsage', [], {}));
  const json = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
  assert.equal(json.success, true);
  assert.equal(json.data.unavailable, true);
  assert.equal(json.data.source, 'channel-fallback');
});

test('checkCli reports availability shape', async () => {
  const out = await captureStdout(() => handleGeminiCommand('checkCli', [], {}));
  const json = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
  assert.equal(json.success, true);
  assert.equal(typeof json.available, 'boolean');
  assert.equal(typeof json.binary, 'string');
});

test('listModels prints success envelope', async () => {
  const out = await captureStdout(() => handleGeminiCommand('listModels', [], {}));
  const json = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
  assert.equal(json.success, true);
  assert.ok(Array.isArray(json.models));
});

test('unknown command throws', async () => {
  await assert.rejects(
    () => handleGeminiCommand('nope', [], {}),
    /Unknown Gemini/,
  );
});
