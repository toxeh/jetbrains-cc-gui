import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ReplyTranslationProvider,
  useReplyTranslation,
} from './ReplyTranslationContext';
import { sendBridgeEvent } from '../utils/bridge';
import { setLocalTranslateStatus } from '../components/ChatInputBox/utils/localTranslateStatus';
import { sha256Hex } from '../components/ChatInputBox/utils/localTranslate';

vi.mock('../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('ReplyTranslationContext', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    delete window.addToast;
    setLocalTranslateStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
  });

  it('loads reply translations on mount or session switch without translating', () => {
    let currentSession = 'session-1';
    const { rerender } = renderHook(
      () => useReplyTranslation(),
      {
        wrapper: ({ children }) => (
          <ReplyTranslationProvider currentSessionId={currentSession} currentProvider="claude">
            {children}
          </ReplyTranslationProvider>
        ),
      }
    );

    expect(sendBridgeEvent).toHaveBeenCalledWith('load_reply_translations', {
      sessionId: 'session-1',
      provider: 'claude',
    });
    // Must NOT call translate on load
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('translate_reply', expect.anything());

    // Switch session
    currentSession = 'session-2';
    rerender();
    expect(sendBridgeEvent).toHaveBeenCalledWith('load_reply_translations', {
      sessionId: 'session-2',
      provider: 'claude',
    });
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('translate_reply', expect.anything());
  });

  it('populates cache when updateReplyTranslationFile arrives for current session', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: {
          hash123: { russian: 'Привет мир', shown: true },
        },
      });
    });

    expect(result.current.cache).toEqual({
      hash123: { russian: 'Привет мир', shown: true },
    });
  });

  it('ignores updateReplyTranslationFile for a different session', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      window.updateReplyTranslationFile?.({
        sessionId: 'old-session',
        entries: {
          hash123: { russian: 'Старый перевод', shown: true },
        },
      });
    });

    expect(result.current.cache).toEqual({});
  });

  it('translates on-demand when block is toggled and not in cache', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      result.current.toggleBlock('Hello world with `code`');
    });

    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      id: 1,
      sessionId: 'sess-1',
      provider: 'claude',
      text: expect.stringContaining('⟦LTk0⟧'),
    }));

    // In flight
    expect(result.current.isBlockLoading('Hello world with `code`')).toBe(true);

    // Mock bridge answer
    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash: sha256Hex('Hello world with `code`'),
        text: 'Привет мир с ⟦LTk0⟧',
      });
    });

    expect(result.current.isBlockLoading('Hello world with `code`')).toBe(false);
    expect(result.current.isBlockShown('Hello world with `code`')).toBe(true);
    expect(result.current.getDisplayText('Hello world with `code`')).toBe('Привет мир с `code`');

    expect(sendBridgeEvent).toHaveBeenCalledWith('save_reply_translation', expect.objectContaining({
      sessionId: 'sess-1',
      provider: 'claude',
      russian: 'Привет мир с `code`',
      shown: true,
    }));
  });

  it('does not make HTTP call when toggling a block already cached', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    const helloHash = sha256Hex('hello');

    act(() => {
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: {
          [helloHash]: {
            russian: 'Привет мир',
            shown: false,
          },
        },
      });
    });

    // Toggle cached block -> shows Russian without calling translate_reply
    act(() => {
      result.current.toggleBlock('hello');
    });

    expect(sendBridgeEvent).not.toHaveBeenCalledWith('translate_reply', expect.anything());
    expect(sendBridgeEvent).toHaveBeenCalledWith('save_reply_translation', expect.objectContaining({
      russian: 'Привет мир',
      shown: true,
    }));
    expect(result.current.isBlockShown('hello')).toBe(true);

    // Toggle again -> shows English
    act(() => {
      result.current.toggleBlock('hello');
    });
    expect(sendBridgeEvent).toHaveBeenCalledWith('save_reply_translation', expect.objectContaining({
      russian: 'Привет мир',
      shown: false,
    }));
    expect(result.current.isBlockShown('hello')).toBe(false);
  });

  it('ignores a second press while the block is in flight and still shows the result', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      result.current.toggleBlock('Wait for this translation');
    });

    expect(result.current.isBlockLoading('Wait for this translation')).toBe(true);

    act(() => {
      result.current.toggleBlock('Wait for this translation');
    });

    const replyCalls = vi.mocked(sendBridgeEvent).mock.calls.filter((call) => call[0] === 'translate_reply');
    expect(replyCalls).toHaveLength(1);

    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash: sha256Hex('Wait for this translation'),
        text: 'Подожди этот перевод',
      });
    });

    expect(result.current.isBlockShown('Wait for this translation')).toBe(true);
    expect(result.current.getDisplayText('Wait for this translation')).toBe('Подожди этот перевод');
    expect(sendBridgeEvent).toHaveBeenCalledWith('save_reply_translation', expect.objectContaining({
      russian: 'Подожди этот перевод',
      shown: true,
      provider: 'claude',
    }));
  });

  it('retries a failed block on the next press', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      result.current.toggleBlock('Please translate this prose');
    });
    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: false,
        hash: sha256Hex('Please translate this prose'),
        error: 'timeout',
      });
    });
    act(() => {
      result.current.toggleBlock('Please translate this prose');
    });

    const replyCalls = vi.mocked(sendBridgeEvent).mock.calls.filter((call) => call[0] === 'translate_reply');
    expect(replyCalls).toHaveLength(2);
    expect(replyCalls[1][1]).toEqual(expect.objectContaining({ id: 2 }));
  });

  it('keeps a newer translation when an older load snapshot arrives', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const text = 'Fresh assistant prose';
    const hash = sha256Hex(text);

    act(() => {
      result.current.toggleBlock(text);
    });
    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash,
        text: 'Свежий ответ',
      });
    });
    act(() => {
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: {
          [hash]: { russian: 'Старый снимок', shown: false },
        },
      });
    });

    expect(result.current.isBlockShown(text)).toBe(true);
    expect(result.current.getDisplayText(text)).toBe('Свежий ответ');
  });

  it('shows cached rows that arrive after translate-all', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const visible = 'Visible prose without a cache row';
    const cached = 'Cached prose that was hidden in the file';
    const cachedHash = sha256Hex(cached);

    act(() => {
      result.current.registerBlock(sha256Hex(visible), visible);
      result.current.toggleAll();
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: {
          [cachedHash]: { russian: 'Скрытый кэш', shown: false },
        },
      });
    });

    expect(result.current.isBlockShown(cached)).toBe(true);
    expect(result.current.getDisplayText(cached)).toBe('Скрытый кэш');
  });

  it('does not show new file rows that arrive after hide-all', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const shownText = 'Already translated prose';
    const shownHash = sha256Hex(shownText);
    const lateText = 'Row that was not in memory';
    const lateHash = sha256Hex(lateText);

    act(() => {
      result.current.registerBlock(shownHash, shownText);
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: { [shownHash]: { russian: 'Уже переведено', shown: true } },
      });
    });
    act(() => {
      result.current.toggleAll();
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: {
          [shownHash]: { russian: 'Уже переведено', shown: true },
          [lateHash]: { russian: 'Поздняя строка', shown: true },
        },
      });
    });

    expect(result.current.isBlockShown(shownText)).toBe(false);
    expect(result.current.isBlockShown(lateText)).toBe(false);
    expect(result.current.getDisplayText(lateText)).toBeUndefined();
  });

  it('shows a file row that arrives after hide-all and show-all', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const shownText = 'Already translated prose';
    const shownHash = sha256Hex(shownText);
    const lateText = 'Row that was not in memory';
    const lateHash = sha256Hex(lateText);

    act(() => {
      result.current.registerBlock(shownHash, shownText);
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: { [shownHash]: { russian: 'Уже переведено', shown: true } },
      });
    });
    act(() => {
      result.current.toggleAll();
    });
    act(() => {
      result.current.toggleAll();
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: {
          [shownHash]: { russian: 'Уже переведено', shown: false },
          [lateHash]: { russian: 'Поздняя строка', shown: false },
        },
      });
    });

    expect(result.current.isBlockShown(shownText)).toBe(true);
    expect(result.current.getDisplayText(lateText)).toBe('Поздняя строка');
  });

  it('keeps the file Russian when a miss requested earlier returns from the model', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const first = 'First prose still waiting';
    const second = 'Second prose still waiting';
    const firstHash = sha256Hex(first);
    const secondHash = sha256Hex(second);

    act(() => {
      result.current.registerBlock(firstHash, first);
      result.current.registerBlock(secondHash, second);
      result.current.toggleAll();
    });
    act(() => {
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: { [firstHash]: { russian: 'Из файла', shown: false } },
      });
    });

    expect(result.current.getDisplayText(first)).toBe('Из файла');
    expect(result.current.isBlockLoading(first)).toBe(false);
    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: secondHash,
      id: 2,
    }));

    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash: firstHash,
        text: 'От модели',
      });
    });

    expect(result.current.getDisplayText(first)).toBe('Из файла');
    expect(sendBridgeEvent).not.toHaveBeenCalledWith(
      'save_reply_translation',
      expect.objectContaining({ russian: 'От модели' }),
    );
  });

  it('drops an in-flight reply on hide-all so the next show-all can translate that block', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const shownText = 'Already translated prose';
    const shownHash = sha256Hex(shownText);
    const flyingText = 'Unmounted block still in flight';
    const flyingHash = sha256Hex(flyingText);

    act(() => {
      result.current.registerBlock(shownHash, shownText);
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: { [shownHash]: { russian: 'Уже переведено', shown: true } },
      });
    });
    expect(result.current.isAllShown()).toBe(true);

    act(() => {
      result.current.toggleBlock(flyingText);
    });
    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: flyingHash,
      id: 1,
    }));

    act(() => {
      result.current.toggleAll();
    });
    expect(result.current.isBlockLoading(flyingText)).toBe(false);

    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash: flyingHash,
        text: 'Поздний ответ',
      });
    });
    expect(result.current.getDisplayText(flyingText)).toBeUndefined();
    expect(sendBridgeEvent).not.toHaveBeenCalledWith(
      'save_reply_translation',
      expect.objectContaining({ hash: flyingHash }),
    );

    act(() => {
      result.current.registerBlock(flyingHash, flyingText);
      result.current.toggleAll();
    });
    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: flyingHash,
      id: 2,
    }));
  });

  it('does not apply an unreadable cache snapshot', () => {
    const addToast = vi.fn();
    window.addToast = addToast;
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const text = 'Fresh assistant prose';
    const hash = sha256Hex(text);
    const other = 'Other cached prose';

    act(() => {
      result.current.toggleBlock(text);
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash,
        text: 'Свежий ответ',
      });
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        unreadable: true,
        entries: {
          [sha256Hex(other)]: { russian: 'Другой', shown: true },
        },
      });
    });

    expect(result.current.getDisplayText(text)).toBe('Свежий ответ');
    expect(result.current.getDisplayText(other)).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith('localTranslate.cacheUnreadable', 'error');
  });

  it('does not treat an empty russian string as shown', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const text = 'Block with an empty cache row';
    const hash = sha256Hex(text);

    act(() => {
      result.current.registerBlock(hash, text);
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: { [hash]: { russian: '', shown: true } },
      });
    });

    expect(result.current.isBlockShown(text)).toBe(false);
    expect(result.current.isAllShown()).toBe(false);

    act(() => {
      result.current.toggleAll();
    });

    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({ hash }));
    expect(result.current.isBlockShown(text)).toBe(false);
  });

  it('translates the next queued block after the first result', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const first = 'First queued prose block';
    const second = 'Second queued prose block';
    const firstHash = sha256Hex(first);
    const secondHash = sha256Hex(second);

    act(() => {
      result.current.registerBlock(firstHash, first);
      result.current.registerBlock(secondHash, second);
      result.current.toggleAll();
    });

    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({ hash: firstHash, id: 1 }));
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('translate_reply', expect.objectContaining({ hash: secondHash }));

    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash: firstHash,
        text: 'Первый блок',
      });
    });

    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({ hash: secondHash, id: 2 }));
  });

  it('orders misses inside the message list before those outside it', () => {
    const container = document.createElement('div');
    container.className = 'messages-container';
    const outside = document.createElement('div');
    const inside = document.createElement('div');
    container.append(outside, inside);
    document.body.append(container);
    const rect = (el: HTMLElement, top: number, bottom: number) => {
      el.getBoundingClientRect = () => ({
        top,
        bottom,
        left: 0,
        right: 40,
        width: 40,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON() { return {}; },
      });
    };
    rect(container, 0, 100);
    rect(outside, 140, 180);
    rect(inside, 10, 40);

    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const outsideText = 'Outside the message viewport';
    const insideText = 'Inside the message viewport';
    const outsideHash = sha256Hex(outsideText);
    const insideHash = sha256Hex(insideText);

    act(() => {
      result.current.registerBlock(outsideHash, outsideText, () => outside);
      result.current.registerBlock(insideHash, insideText, () => inside);
      result.current.toggleAll();
    });

    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: insideHash,
      id: 1,
    }));
    container.remove();
  });

  it('turns every shown block back to English when the session globe is pressed', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });
    const text = 'Already translated prose';
    const hash = sha256Hex(text);

    act(() => {
      result.current.registerBlock(hash, text);
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: { [hash]: { russian: 'Уже переведено', shown: true } },
      });
    });

    expect(result.current.isAllShown()).toBe(true);

    act(() => {
      result.current.toggleAll();
    });

    expect(result.current.isAllShown()).toBe(false);
    expect(result.current.isBlockShown(text)).toBe(false);
    expect(sendBridgeEvent).toHaveBeenCalledWith('set_reply_shown_all', {
      sessionId: 'sess-1',
      provider: 'claude',
      shown: false,
    });
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('translate_reply', expect.anything());
  });

  it('does not toast after unmount when the fallback timer would have fired', () => {
    vi.useFakeTimers();
    const toasts: string[] = [];
    const onToast = (event: Event) => {
      toasts.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener('show-toast', onToast);
    const { result, unmount } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      result.current.toggleBlock('Waiting for a slow model');
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(toasts).toEqual([]);
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('save_reply_translation', expect.anything());
    window.removeEventListener('show-toast', onToast);
    vi.useRealTimers();
  });

  it('invalid placeholder restoration leaves block in English and writes nothing', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      result.current.toggleBlock('Test with `code`');
    });

    // Model dropped placeholder
    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash: sha256Hex('Test with `code`'),
        text: 'Тест без плейсхолдера',
      });
    });

    expect(result.current.isBlockShown('Test with `code`')).toBe(false);
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('save_reply_translation', expect.anything());
    const addToast = vi.fn();
    window.addToast = addToast;
    act(() => {
      result.current.toggleBlock('Test with `code`');
    });
    act(() => {
      window.updateReplyTranslation?.({
        id: 2,
        success: true,
        hash: sha256Hex('Test with `code`'),
        text: 'Снова без плейсхолдера',
      });
    });
    expect(addToast).toHaveBeenCalledWith('localTranslate.failed', 'error');
  });

  it('queues loaded turns that are not mounted and skips the streaming tail', () => {
    const hidden = 'Hidden earlier prose';
    const hiddenHash = sha256Hex(hidden);
    const alsoHidden = 'Another hidden prose block';
    const alsoHash = sha256Hex(alsoHidden);
    const visible = 'Visible later prose';
    const visibleHash = sha256Hex(visible);
    const tail = 'Still streaming tail';
    const messages = [
      {
        type: 'assistant' as const,
        blocks: [
          { type: 'text' as const, text: hidden },
          { type: 'text' as const, text: alsoHidden },
        ],
      },
      {
        type: 'assistant' as const,
        isStreaming: true,
        blocks: [
          { type: 'text' as const, text: visible },
          { type: 'text' as const, text: tail },
        ],
      },
    ];
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider
          currentSessionId="sess-1"
          currentProvider="claude"
          messages={messages}
          getContentBlocks={(message) => (message as { blocks?: Array<{ type: 'text'; text: string }> }).blocks ?? []}
        >
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      result.current.registerBlock(visibleHash, visible);
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: { [visibleHash]: { russian: 'Видимый', shown: true } },
      });
    });
    expect(result.current.isAllShown()).toBe(false);

    act(() => {
      result.current.toggleAll();
    });
    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: hiddenHash,
      id: 1,
    }));

    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash: hiddenHash,
        text: 'Скрытый',
      });
    });
    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: alsoHash,
      id: 2,
    }));
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: sha256Hex(tail),
    }));
    expect(sendBridgeEvent).not.toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: visibleHash,
    }));
  });

  it('does not translate a block that mounts after translate-all', () => {
    const late = 'Finished after the globe was pressed';
    const lateHash = sha256Hex(late);
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider
          currentSessionId="sess-1"
          currentProvider="claude"
          messages={[]}
          getContentBlocks={() => []}
        >
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      result.current.toggleAll();
      result.current.registerBlock(lateHash, late);
    });

    expect(sendBridgeEvent).not.toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: lateHash,
    }));
  });

  it('queues a collapsed earlier turn before a later mounted block outside the viewport', () => {
    const container = document.createElement('div');
    container.className = 'messages-container';
    const laterEl = document.createElement('div');
    container.append(laterEl);
    document.body.append(container);
    laterEl.getBoundingClientRect = () => ({
      top: 140,
      bottom: 180,
      left: 0,
      right: 40,
      width: 40,
      height: 40,
      x: 0,
      y: 140,
      toJSON() { return {}; },
    });
    container.getBoundingClientRect = () => ({
      top: 0,
      bottom: 100,
      left: 0,
      right: 40,
      width: 40,
      height: 100,
      x: 0,
      y: 0,
      toJSON() { return {}; },
    });

    const hidden = 'Hidden earlier prose';
    const later = 'Later mounted prose outside the viewport';
    const hiddenHash = sha256Hex(hidden);
    const laterHash = sha256Hex(later);
    const messages = [
      { type: 'assistant' as const, blocks: [{ type: 'text' as const, text: hidden }] },
      { type: 'assistant' as const, blocks: [{ type: 'text' as const, text: later }] },
    ];
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider
          currentSessionId="sess-1"
          currentProvider="claude"
          messages={messages}
          getContentBlocks={(message) => (message as { blocks?: Array<{ type: 'text'; text: string }> }).blocks ?? []}
        >
          {children}
        </ReplyTranslationProvider>
      ),
    });

    act(() => {
      result.current.registerBlock(laterHash, later, () => laterEl);
      result.current.toggleAll();
    });

    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      hash: hiddenHash,
      id: 1,
    }));
    container.remove();
  });

  it('toggleAll in status panel sets shown: true on existing entries and queues misses', () => {
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    const block1Text = 'Block one prose text';
    const block1Hash = sha256Hex(block1Text);
    const block2Text = 'Block two prose text';
    const block2Hash = sha256Hex(block2Text);

    // Register block 1 and block 2 as eligible blocks
    act(() => {
      result.current.registerBlock(block1Hash, block1Text);
      result.current.registerBlock(block2Hash, block2Text);
    });

    // Suppose block 1 is cached with Russian
    act(() => {
      window.updateReplyTranslationFile?.({
        sessionId: 'sess-1',
        entries: {
          [block1Hash]: { russian: 'Блок один', shown: false },
        },
      });
    });

    // Before toggleAll, not all are shown
    expect(result.current.isAllShown()).toBe(false);

    // Call toggleAll
    act(() => {
      result.current.toggleAll();
    });

    // Should call set_reply_shown_all with shown: true
    expect(sendBridgeEvent).toHaveBeenCalledWith('set_reply_shown_all', {
      sessionId: 'sess-1',
      provider: 'claude',
      shown: true,
    });

    // Block 1 was cached, now shown: true
    expect(result.current.isBlockShown(block1Text)).toBe(true);

    // Block 2 was a miss, so translate_reply is called for block 2
    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      sessionId: 'sess-1',
      hash: block2Hash,
    }));
  });

  it('clears in-flight state immediately and allows retry when sendBridgeEvent returns false', () => {
    const toast = vi.fn();
    window.addToast = toast;
    const { result } = renderHook(() => useReplyTranslation(), {
      wrapper: ({ children }) => (
        <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
          {children}
        </ReplyTranslationProvider>
      ),
    });

    const text = 'Reply prose that fails bridge dispatch';
    const hash = sha256Hex(text);

    vi.mocked(sendBridgeEvent).mockReturnValueOnce(false);
    act(() => {
      result.current.toggleBlock(text);
    });

    expect(result.current.isBlockLoading(text)).toBe(false);
    expect(toast).toHaveBeenCalledWith('localTranslate.failed', 'error');

    // A second click immediately retries because the block is no longer stuck in-flight
    vi.mocked(sendBridgeEvent).mockClear();
    vi.mocked(sendBridgeEvent).mockReturnValue(true);
    act(() => {
      result.current.toggleBlock(text);
    });

    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      sessionId: 'sess-1',
      hash,
    }));
    expect(result.current.isBlockLoading(text)).toBe(true);
  });
});
