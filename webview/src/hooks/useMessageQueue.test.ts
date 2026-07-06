import { describe, it, expect } from 'vitest';
import { queueItemsNeedingChip } from './useMessageQueue';
import type { QueuedMessage } from './useMessageQueue';

/**
 * Tests for queueItemsNeedingChip — decides which queued messages still need the
 * queue chip above the input. A queued message WITH text is already shown as an
 * optimistic "queued" bubble in the transcript, so a chip would duplicate it;
 * only attachment-only (empty-text) queued messages need the chip.
 */

const item = (content: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: `q-${content}`,
  content,
  queuedAt: 0,
  ...extra,
});

describe('queueItemsNeedingChip', () => {
  it('excludes queued messages with text (already shown as a bubble)', () => {
    const queue = [item('run tests'), item('статус?')];
    expect(queueItemsNeedingChip(queue)).toEqual([]);
  });

  it('keeps attachment-only queued messages (empty text, no bubble)', () => {
    const attachmentOnly = item('', { attachments: [{ fileName: 'a.png', mediaType: 'image/png' } as never] });
    const queue = [item('has text'), attachmentOnly];
    const result = queueItemsNeedingChip(queue);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(attachmentOnly);
  });

  it('treats whitespace-only text as no bubble (keeps the chip)', () => {
    const queue = [item('   ')];
    expect(queueItemsNeedingChip(queue)).toHaveLength(1);
  });

  it('returns empty for an empty queue', () => {
    expect(queueItemsNeedingChip([])).toEqual([]);
  });

  it('preserves order and only drops the text items', () => {
    const a = item('');
    const b = item('typed');
    const c = item('  ');
    expect(queueItemsNeedingChip([a, b, c])).toEqual([a, c]);
  });
});
