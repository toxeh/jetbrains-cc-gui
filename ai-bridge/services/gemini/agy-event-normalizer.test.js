import test from 'node:test';
import assert from 'node:assert/strict';
import { AgyEventNormalizer } from './agy-event-normalizer.js';

function collect() {
  const lines = [];
  const n = new AgyEventNormalizer({
    log: (line) => lines.push(String(line)),
    error: () => {},
  });
  return { n, lines };
}

test('normalizer emits session id, deltas, tools, usage, success envelope', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'init',
    conversation_id: 'conv-abc',
    init: { cwd: '/tmp', tools: ['run_command'], permission_mode: 'request-review' },
  });
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-abc',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Hello ',
    },
  });
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-abc',
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'world',
      usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 110 },
    },
  });
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 4,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'echo hi' },
        output: 'hi\n',
      },
    },
  });
  n.handleStreamEvent({
    event: 'result',
    result: {
      conversation_id: 'conv-abc',
      status: 'SUCCESS',
      response: 'Hello world',
      usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 110 },
    },
  });
  n.finishSuccess('conv-abc', 'Hello world');

  assert.ok(lines.some((l) => l.startsWith('[MESSAGE_START]')));
  assert.ok(lines.some((l) => l.startsWith('[STREAM_START]')));
  assert.ok(lines.some((l) => l === '[SESSION_ID] conv-abc'));
  assert.ok(lines.some((l) => l.startsWith('[CONTENT_DELTA]') && l.includes('Hello')));
  assert.ok(lines.some((l) => l.startsWith('[CONTENT_DELTA]') && l.includes('world')));
  assert.ok(lines.some((l) => l.startsWith('[TOOL_RESULT]') && l.includes('run_command')));
  assert.ok(lines.some((l) => l.startsWith('[USAGE]')));
  assert.ok(lines.some((l) => l.startsWith('[MESSAGE]')));
  assert.ok(lines.some((l) => l.startsWith('[STREAM_END]')));
  assert.ok(lines.some((l) => l.startsWith('[MESSAGE_END]')));
  const ok = lines.find((l) => l.startsWith('{') && l.includes('"success"'));
  assert.ok(ok);
  const env = JSON.parse(ok);
  assert.equal(env.success, true);
  assert.equal(env.sessionId, 'conv-abc');
  assert.equal(env.result, 'Hello world');
});

test('finishError emits SEND_ERROR', () => {
  const { n, lines } = collect();
  n.begin();
  n.finishError(new Error('authentication required'));
  assert.ok(lines.some((l) => l.startsWith('[SEND_ERROR]') && l.includes('authentication required')));
  const env = JSON.parse(lines.find((l) => l.startsWith('{') && l.includes('"success"')));
  assert.equal(env.success, false);
});

test('normalizer emits thinking deltas', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'step_update',
    step_update: {
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'thinking',
      thinking_delta: 'pondering',
    },
  });
  assert.ok(lines.some((l) => l.startsWith('[THINKING_DELTA]') && l.includes('pondering')));
});

test('result without streamed text emits content delta from response', () => {
  const { n, lines } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'result',
    result: {
      conversation_id: 'c1',
      status: 'SUCCESS',
      response: 'final only',
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    },
  });
  n.finishSuccess('c1', 'final only');
  assert.ok(lines.some((l) => l.startsWith('[CONTENT_DELTA]') && l.includes('final only')));
  assert.equal(n.assistantText, 'final only');
  assert.equal(n.conversationId, 'c1');
});

test('result ERROR status records terminal error', () => {
  const { n } = collect();
  n.begin();
  n.handleStreamEvent({
    event: 'result',
    result: {
      conversation_id: 'c-err',
      status: 'ERROR',
      error: 'auth failed',
      response: '',
    },
  });
  assert.equal(n._terminalError, 'auth failed');
  assert.equal(n._terminalStatus, 'ERROR');
});

test('finishSuccess is idempotent for stream/message end tags', () => {
  const { n, lines } = collect();
  n.begin();
  n.finishSuccess('id', 'text');
  n.finishSuccess('id', 'text');
  assert.equal(lines.filter((l) => l === '[STREAM_END]').length, 1);
  assert.equal(lines.filter((l) => l === '[MESSAGE_END]').length, 1);
});

test('ignores null/unknown events', () => {
  const { n, lines } = collect();
  n.begin();
  const before = lines.length;
  n.handleStreamEvent(null);
  n.handleStreamEvent({ event: 'unknown_thing' });
  assert.equal(lines.length, before);
});
