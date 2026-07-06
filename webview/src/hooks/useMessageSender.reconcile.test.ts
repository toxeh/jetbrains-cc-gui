import { describe, it, expect } from 'vitest';
import { reconcileOptimisticUserMessage } from './useMessageSender';
import type { ClaudeContentBlock, ClaudeMessage } from '../types';

/**
 * Tests for reconcileOptimisticUserMessage — the dedup that lets a message
 * queued while a turn is loading (shown immediately as an optimistic bubble so
 * the user sees it, not just a chip) be activated in place when the queue
 * drains, instead of appearing twice.
 */

const blocks = (text: string): ClaudeContentBlock[] => [{ type: 'text', text }];

function queuedUser(text: string, extra: Partial<ClaudeMessage> = {}): ClaudeMessage {
  return {
    type: 'user',
    content: text,
    isOptimistic: true,
    isQueued: true,
    timestamp: '2026-01-01T00:00:00.000Z',
    raw: { message: { content: blocks(text) } },
    ...extra,
  };
}

function sentUser(text: string): ClaudeMessage {
  return {
    type: 'user',
    content: text,
    isOptimistic: true,
    timestamp: '2026-01-01T00:05:00.000Z',
    raw: { message: { content: blocks(text) } },
  };
}

describe('reconcileOptimisticUserMessage', () => {
  it('appends normally when there is no queued bubble (immediate send)', () => {
    const prev: ClaudeMessage[] = [{ type: 'assistant', content: 'hi' }];
    const msg = sentUser('hello');

    const result = reconcileOptimisticUserMessage(prev, msg, 'hello', blocks('hello'));

    expect(result).toHaveLength(2);
    expect(result[1]).toBe(msg);
  });

  it('activates the queued bubble in place instead of duplicating on drain', () => {
    const queued = queuedUser('run the tests');
    const prev: ClaudeMessage[] = [{ type: 'assistant', content: 'working' }, queued];
    const msg = sentUser('run the tests');

    const result = reconcileOptimisticUserMessage(prev, msg, 'run the tests', blocks('run the tests'));

    // No duplicate: still 2 messages, the queued one activated (isQueued cleared).
    expect(result).toHaveLength(2);
    expect(result[1].type).toBe('user');
    expect(result[1].content).toBe('run the tests');
    expect((result[1] as { isQueued?: boolean }).isQueued).toBe(false);
    expect(result[1].isOptimistic).toBe(true);
    expect(result[1].timestamp).toBe(msg.timestamp); // refreshed to send time
  });

  it('activates the EARLIEST queued bubble with matching text (FIFO drain)', () => {
    const first = queuedUser('статус?', { timestamp: 't1' });
    const second = queuedUser('статус?', { timestamp: 't2' });
    const prev: ClaudeMessage[] = [first, second];
    const msg = sentUser('статус?');

    const result = reconcileOptimisticUserMessage(prev, msg, 'статус?', blocks('статус?'));

    // Only the first is activated; the second stays queued for its own drain.
    expect(result).toHaveLength(2);
    expect((result[0] as { isQueued?: boolean }).isQueued).toBe(false);
    expect((result[1] as { isQueued?: boolean }).isQueued).toBe(true);
  });

  it('does not touch a queued bubble with different text; appends the new send', () => {
    const queued = queuedUser('other question');
    const prev: ClaudeMessage[] = [queued];
    const msg = sentUser('new question');

    const result = reconcileOptimisticUserMessage(prev, msg, 'new question', blocks('new question'));

    expect(result).toHaveLength(2);
    expect((result[0] as { isQueued?: boolean }).isQueued).toBe(true); // untouched
    expect(result[1]).toBe(msg); // appended
  });

  it('matches by trimmed content (queued bubble text vs trimmed send text)', () => {
    const queued = queuedUser('  spaced  '); // rendered with surrounding space
    const prev: ClaudeMessage[] = [queued];
    const msg = sentUser('spaced');

    const result = reconcileOptimisticUserMessage(prev, msg, 'spaced', blocks('spaced'));

    expect(result).toHaveLength(1);
    expect((result[0] as { isQueued?: boolean }).isQueued).toBe(false);
  });

  it('ignores an already-activated (non-queued) optimistic bubble', () => {
    // A prior optimistic user bubble that is NOT queued must not be re-used.
    const activated = sentUser('done earlier');
    const prev: ClaudeMessage[] = [activated];
    const msg = sentUser('done earlier');

    const result = reconcileOptimisticUserMessage(prev, msg, 'done earlier', blocks('done earlier'));

    expect(result).toHaveLength(2); // appended, not merged
  });
});
