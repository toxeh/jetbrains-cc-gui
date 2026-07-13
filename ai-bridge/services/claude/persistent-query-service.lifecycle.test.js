// Redirect HOME to a temp CLI-login config BEFORE importing modules that call
// setupApiKey(), so buildRequestContext() does not throw on a credential-less CI
// runner. Must stay the first import (see testing/cli-login-home.js).
import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from './persistent-query-service.js';
import {
  createScriptedQuery,
  assistantText,
  RESULT_OK,
} from './testing/scripted-query.js';

/**
 * Runtime lifecycle tests (epoch isolation, idle cleanup, abort) against the
 * perpetual-reader architecture.
 *
 * Successor of persistent-query-service.test.mjs, which predated the
 * perpetual reader and mocked query.next() with plain functions. Under the
 * reader those mocks broke down: an immediately-done iterator makes the
 * reader dispose the runtime at creation, and an infinitely-yielding one
 * makes it spin. The scripted query used here keeps the iterator pending
 * between deliveries — the real SDK's behavior — and is a native async
 * generator, so iterator-consumer bugs surface instead of hiding in the mock
 * (see testing/scripted-query.js). The .mjs suite also never ran in CI, whose
 * glob only matches *.test.js.
 */

const OVERRIDES = { settings: { env: {} } };

function trackingFactory(turnScripts = []) {
  const queries = [];
  return {
    queries,
    queryFn(args) {
      const query = createScriptedQuery(args, turnScripts);
      queries.push(query);
      return query;
    },
  };
}

test.beforeEach(async () => {
  await __testing.resetState();
});

test.after(async () => {
  await __testing.resetState();
});

test('reasoningEffort is passed as SDK effort and disables fixed thinking tokens', async () => {
  const context = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-effort',
    cwd: process.cwd(),
    message: 'use adaptive effort',
    reasoningEffort: 'xhigh'
  }, false, OVERRIDES);

  assert.equal(context.options.effort, 'xhigh');
  assert.equal(Object.hasOwn(context.options, 'maxThinkingTokens'), false);
  assert.equal(context.maxThinkingTokens, undefined);
  assert.match(context.runtimeSignature, /"effort":"xhigh"/);
});

test('fixed thinking tokens remain configured when no reasoningEffort is provided', async () => {
  const context = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-thinking',
    cwd: process.cwd(),
    message: 'use default thinking config'
  }, false, OVERRIDES);

  assert.equal(context.options.effort, undefined);
  assert.equal(context.options.maxThinkingTokens, 10000);
  assert.equal(context.maxThinkingTokens, 10000);
});

test('anonymous runtime is isolated by runtimeSessionEpoch', async () => {
  const factory = trackingFactory();
  __testing.setQueryFn((args) => factory.queryFn(args));

  const firstContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-1',
    cwd: process.cwd(),
    message: 'hello'
  }, false, OVERRIDES);

  const runtime1 = await __testing.acquireRuntime(firstContext);
  const runtime1Again = await __testing.acquireRuntime(firstContext);
  assert.equal(runtime1, runtime1Again);
  assert.equal(factory.queries.length, 1);

  const secondContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-2',
    cwd: process.cwd(),
    message: 'hello again'
  }, false, OVERRIDES);

  const runtime2 = await __testing.acquireRuntime(secondContext);
  assert.notEqual(runtime1, runtime2);
  assert.equal(factory.queries.length, 2);
});

test('same-tab new-session isolation matches fresh runtime isolation expectations', async () => {
  const factory = trackingFactory();
  __testing.setQueryFn((args) => factory.queryFn(args));

  const firstContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-a',
    cwd: process.cwd(),
    message: 'first turn'
  }, false, OVERRIDES);
  const runtimeA = await __testing.acquireRuntime(firstContext);

  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-a' });

  const secondContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-b',
    cwd: process.cwd(),
    message: 'new session turn'
  }, false, OVERRIDES);
  const runtimeB = await __testing.acquireRuntime(secondContext);

  assert.notEqual(runtimeA, runtimeB);
  assert.equal(runtimeA.closed, true);
  assert.equal(factory.queries.length, 2);
  assert.equal(__testing.getSnapshot().anonymousRuntimeCount, 1);
});

test('resetRuntimePersistent disposes active turn runtime for interrupted old epoch before next first send', async () => {
  const factory = trackingFactory();
  __testing.setQueryFn((args) => factory.queryFn(args));

  const oldContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-old',
    cwd: process.cwd(),
    message: 'streaming turn'
  }, false, OVERRIDES);
  const oldRuntime = await __testing.acquireRuntime(oldContext);
  __testing.setActiveTurnRuntime(oldRuntime);

  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-old' });

  const nextContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-new',
    cwd: process.cwd(),
    message: 'first send after interrupt'
  }, false, OVERRIDES);
  const nextRuntime = await __testing.acquireRuntime(nextContext);

  assert.equal(oldRuntime.closed, true);
  assert.notEqual(oldRuntime, nextRuntime);
  assert.equal(__testing.getSnapshot().activeTurnEpoch, null);
});

test('restore-history continuation keeps runtime bound to restored session after reset of prior epoch', async () => {
  const factory = trackingFactory();
  __testing.setQueryFn((args) => factory.queryFn(args));

  const oldAnonymousContext = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-stale',
    cwd: process.cwd(),
    message: 'stale anonymous'
  }, false, OVERRIDES);
  await __testing.acquireRuntime(oldAnonymousContext);
  await __testing.resetRuntimePersistent({ runtimeSessionEpoch: 'epoch-stale' });

  const restoredContext = await __testing.buildRequestContext({
    sessionId: 'hist-restore',
    runtimeSessionEpoch: 'epoch-restore',
    cwd: process.cwd(),
    message: 'restored continuation'
  }, false, OVERRIDES);
  const restoredRuntime = await __testing.acquireRuntime(restoredContext);
  const restoredRuntimeAgain = await __testing.acquireRuntime(restoredContext);

  assert.equal(restoredRuntime, restoredRuntimeAgain);
  assert.equal(__testing.getRuntimeForSession('hist-restore'), restoredRuntime);
});

test('active session runtime is not disposed by idle cleanup while a turn is executing', async () => {
  // First user message produces no events yet — the turn blocks on take()
  // until the test delivers the finishing messages through the channel.
  const factory = trackingFactory([[]]);
  __testing.setQueryFn((args) => factory.queryFn(args));

  const context = await __testing.buildRequestContext({
    sessionId: 'session-active',
    runtimeSessionEpoch: 'epoch-active',
    cwd: process.cwd(),
    message: 'long running turn'
  }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = Date.now() - (31 * 60 * 1000);

  const turnPromise = __testing.executeTurn(runtime, context, { state: null });
  const query = factory.queries[0];
  await query.waitForInput();

  await __testing.cleanupSessionRuntimes();

  assert.equal(runtime.closed, false);
  assert.equal(__testing.getRuntimeForSession('session-active'), runtime);

  query.channel.enqueue(assistantText('done'));
  query.channel.enqueue(RESULT_OK);
  await turnPromise;
});

test('idle session runtime is still disposed by idle cleanup', async () => {
  const factory = trackingFactory();
  __testing.setQueryFn((args) => factory.queryFn(args));

  const context = await __testing.buildRequestContext({
    sessionId: 'session-idle',
    runtimeSessionEpoch: 'epoch-idle',
    cwd: process.cwd(),
    message: 'idle turn'
  }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = Date.now() - (31 * 60 * 1000);

  await __testing.cleanupSessionRuntimes();

  assert.equal(runtime.closed, true);
  assert.equal(__testing.getRuntimeForSession('session-idle'), null);
});

test('active anonymous runtime is not disposed by idle cleanup while a turn is executing', async () => {
  const factory = trackingFactory([[]]);
  __testing.setQueryFn((args) => factory.queryFn(args));

  const context = await __testing.buildRequestContext({
    sessionId: '',
    runtimeSessionEpoch: 'epoch-anon-active',
    cwd: process.cwd(),
    message: 'anonymous long running turn'
  }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = Date.now() - (11 * 60 * 1000);

  const turnPromise = __testing.executeTurn(runtime, context, { state: null });
  const query = factory.queries[0];
  await query.waitForInput();

  await __testing.cleanupAnonymousRuntimes();

  assert.equal(runtime.closed, false);
  assert.equal(__testing.getSnapshot().anonymousRuntimeCount, 1);

  query.channel.enqueue(assistantText('done'));
  query.channel.enqueue(RESULT_OK);
  await turnPromise;
});

test('executeTurn refreshes lastUsedAt while processing query events', async () => {
  const factory = trackingFactory([[
    assistantText('partial'),
    RESULT_OK,
  ]]);
  __testing.setQueryFn((args) => factory.queryFn(args));

  const context = await __testing.buildRequestContext({
    sessionId: 'session-refresh',
    runtimeSessionEpoch: 'epoch-refresh',
    cwd: process.cwd(),
    message: 'refresh lastUsedAt'
  }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(context);
  runtime.lastUsedAt = 1;

  await __testing.executeTurn(runtime, context, { state: null });

  assert.ok(runtime.lastUsedAt > 1);
});

test('abortCurrentTurn fails the pending take() and disposes the runtime', async () => {
  const factory = trackingFactory([[]]);
  __testing.setQueryFn((args) => factory.queryFn(args));

  const context = await __testing.buildRequestContext({
    sessionId: 'session-abort',
    runtimeSessionEpoch: 'epoch-abort',
    cwd: process.cwd(),
    message: 'abort me'
  }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(context);
  const turnPromise = __testing.executeTurn(runtime, context, { state: null });
  await factory.queries[0].waitForInput();

  __testing.setActiveTurnRuntime(runtime);
  await __testing.abortCurrentTurn();

  // The abort fails the turnSink; executeTurn wraps that as a terminated turn.
  await assert.rejects(turnPromise, /Turn aborted/);
  assert.equal(runtime.closed, true);
});
