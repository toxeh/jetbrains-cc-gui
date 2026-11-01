import { act, cleanup, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { LOCAL_TRANSLATE_PROBE_RETRY_MS, useLocalTranslate } from './useLocalTranslate.js';

const sendBridgeEvent = vi.fn((_event: string, _content?: string) => true);
vi.mock('../../../utils/bridge.js', () => ({
  sendBridgeEvent: (event: string, content?: string) => sendBridgeEvent(event, content),
}));

const t = ((key: string) => key) as unknown as TFunction;

function setup(
  html: string | ((el: HTMLDivElement) => void),
  opts: { disabled?: boolean; currentProvider?: string; t?: TFunction } = {},
) {
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  if (typeof html === 'string') editable.textContent = html;
  else html(editable);
  document.body.appendChild(editable);
  const editableRef = { current: editable };
  const getTextContent = () => editable.textContent ?? '';
  const addToast = vi.fn();
  const notifyInput = vi.fn();
  const setHasContent = vi.fn();
  const translator = opts.t ?? t;
  const hook = renderHook(
    ({ disabled, currentProvider }: { disabled?: boolean; currentProvider?: string }) =>
      useLocalTranslate({
        editableRef,
        getTextContent,
        invalidateCache: () => {},
        adjustHeight: () => {},
        setHasContent,
        notifyInput,
        sendShortcut: 'enter',
        currentProvider,
        disabled: disabled ?? false,
        addToast,
        t: translator,
      }),
    { initialProps: { disabled: opts.disabled ?? false, currentProvider: opts.currentProvider } },
  );
  return { editable, hook, addToast, notifyInput, setHasContent };
}

function pushStatus(status: object) {
  act(() => window.updateLocalTranslateStatus?.(JSON.stringify(status)));
}

function translateCalls() {
  return sendBridgeEvent.mock.calls.filter(([event]) => event === 'translate_prompt');
}

/** Id of the most recent translate_prompt request. */
function lastRequestId(): number {
  const calls = translateCalls();
  return (JSON.parse(calls[calls.length - 1][1] as string) as { id: number }).id;
}

/** Answer the most recent request (or the given id) as the Java handler would. */
function reply(payload: object, id = lastRequestId()) {
  act(() => window.updateLocalTranslateResult?.(JSON.stringify({ id, ...payload })));
}

describe('useLocalTranslate', () => {
  beforeEach(() => sendBridgeEvent.mockClear());
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('probes when the composer mounts and hides the button until reachable', () => {
    const { hook } = setup('привет');
    expect(sendBridgeEvent).toHaveBeenCalledWith('probe_local_translate', '{}');
    expect(hook.result.current.reachable).toBe(false);
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    expect(hook.result.current.reachable).toBe(true);
    expect(hook.result.current.translateShortcut).toBe('cmdEnter');
  });

  it('re-probes every 30s while enabled but unreachable', () => {
    vi.useFakeTimers();
    try {
      setup('привет');
      pushStatus({ enabled: true, reachable: false, shortcut: 'cmdEnter' });
      sendBridgeEvent.mockClear();
      act(() => vi.advanceTimersByTime(30_000));
      expect(sendBridgeEvent).toHaveBeenCalledWith('probe_local_translate', '{}');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-probes every 30s while the feature status is off', () => {
    vi.useFakeTimers();
    try {
      setup('привет');
      pushStatus({ enabled: false, reachable: false, shortcut: 'cmdEnter' });
      sendBridgeEvent.mockClear();
      act(() => vi.advanceTimersByTime(30_000));
      expect(sendBridgeEvent).toHaveBeenCalledWith('probe_local_translate', '{}');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the masked draft once and ignores a second request in flight', () => {
    const { hook } = setup('почини это');
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    act(() => hook.result.current.handleTranslate());
    expect(translateCalls()).toHaveLength(1);
    expect(JSON.parse(translateCalls()[0][1] as string)).toEqual({ id: expect.any(Number), text: 'почини это' });
    expect(hook.result.current.isTranslating).toBe(true);
  });

  it('replaces the draft without sending when the result arrives', () => {
    const { editable, hook, notifyInput } = setup('почини это');
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    reply({ success: true, text: 'fix this' });
    expect(editable.textContent).toBe('fix this');
    expect(notifyInput).toHaveBeenCalledWith('fix this');
    expect(hook.result.current.isTranslating).toBe(false);
    expect(sendBridgeEvent.mock.calls.some(([event]) => event === 'send_message')).toBe(false);
  });

  it('leaves the draft unchanged and shows a failure on error', () => {
    const { editable, hook, addToast } = setup('почини это');
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    reply({ success: false, text: '', error: 'http_500' });
    expect(editable.textContent).toBe('почини это');
    expect(addToast).toHaveBeenCalledWith('localTranslate.httpError', 'error');
  });

  it('makes no HTTP call for a draft of only chips and code', () => {
    const { hook, editable } = setup((el) => {
      const chip = document.createElement('span');
      chip.className = 'file-tag';
      chip.setAttribute('data-file-path', 'src/A.java');
      chip.textContent = 'A.java';
      el.append(chip, document.createTextNode(' `run()`'));
    });
    const before = editable.innerHTML;
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    expect(translateCalls()).toHaveLength(0);
    expect(editable.innerHTML).toBe(before);
  });

  it.each(['/clear', '/resume', '/plan', '/context'])('makes no HTTP call for local command %s', (cmd) => {
    const { hook, editable } = setup(cmd);
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    expect(translateCalls()).toHaveLength(0);
    expect(editable.textContent).toBe(cmd);
  });

  it('does nothing for an empty draft or when disabled in config', () => {
    const empty = setup('   ');
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => empty.hook.result.current.handleTranslate());
    expect(translateCalls()).toHaveLength(0);
    cleanup();

    const off = setup('привет');
    pushStatus({ enabled: false, reachable: false, shortcut: 'cmdEnter' });
    act(() => off.hook.result.current.handleTranslate());
    expect(translateCalls()).toHaveLength(0);
    expect(off.hook.result.current.translateShortcut).toBeNull();
  });

  it('reports Shift+Enter as the active chord when send mode keeps Cmd/Ctrl+Enter', () => {
    const editable = document.createElement('div');
    const { result } = renderHook(() =>
      useLocalTranslate({
        editableRef: { current: editable },
        getTextContent: () => '',
        invalidateCache: () => {},
        adjustHeight: () => {},
        setHasContent: () => {},
        notifyInput: () => {},
        sendShortcut: 'cmdEnter',
        disabled: false,
        t,
      }),
    );
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    expect(result.current.shortcutLabel).toBe('localTranslate.shortcutShiftEnter');
    pushStatus({ enabled: true, reachable: true, shortcut: 'shiftEnter' });
    expect(result.current.shortcutLabel).toBe('localTranslate.shortcutShiftEnter');
  });

  it('discards the result with a warning when the draft changed meanwhile', () => {
    const { editable, hook, addToast, notifyInput } = setup('почини это');
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    editable.textContent = 'почини это и то';
    reply({ success: true, text: 'fix this' });
    expect(editable.textContent).toBe('почини это и то');
    expect(addToast).toHaveBeenCalledWith('localTranslate.draftChanged', 'warning');
    expect(notifyInput).not.toHaveBeenCalled();
    expect(hook.result.current.isTranslating).toBe(false);
  });

  it('discards the result when a chip left the editor meanwhile', () => {
    let chip!: HTMLElement;
    const { editable, hook, addToast } = setup((el) => {
      chip = document.createElement('span');
      chip.className = 'file-tag';
      chip.textContent = 'A.java';
      el.append(document.createTextNode('почини '), chip);
    });
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    // Same text, but the chip node was replaced (e.g. re-rendered by another edit).
    const replacement = chip.cloneNode(true);
    chip.replaceWith(replacement);
    reply({ success: true, text: 'fix ⟦LTc0⟧' });
    expect(editable.contains(replacement)).toBe(true);
    expect(editable.textContent).toBe('почини A.java');
    expect(addToast).toHaveBeenCalledWith('localTranslate.draftChanged', 'warning');
  });

  it('discards the result when the input became disabled meanwhile', () => {
    const { editable, hook, addToast } = setup('почини это');
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    hook.rerender({ disabled: true, currentProvider: undefined });
    reply({ success: true, text: 'fix this' });
    expect(editable.textContent).toBe('почини это');
    expect(addToast).toHaveBeenCalledWith('localTranslate.draftChanged', 'warning');
  });

  it('keeps the DOM and shows an error when the model drops a placeholder', () => {
    const { editable, hook, addToast } = setup((el) => {
      const chip = document.createElement('span');
      chip.className = 'file-tag';
      chip.textContent = 'A.java';
      el.append(document.createTextNode('почини '), chip);
    });
    const before = editable.innerHTML;
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    reply({ success: true, text: 'fix the file' });
    expect(editable.innerHTML).toBe(before);
    expect(addToast).toHaveBeenCalledWith('localTranslate.placeholderMismatch', 'error');
    expect(hook.result.current.isTranslating).toBe(false);
  });

  it('sends no translate_prompt while the input is disabled', () => {
    const { hook } = setup('почини это', { disabled: true });
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    expect(translateCalls()).toHaveLength(0);
    expect(hook.result.current.isTranslating).toBe(false);
  });

  it('toasts and re-probes instead of translating while unreachable', () => {
    const { hook, addToast } = setup('почини это');
    pushStatus({ enabled: true, reachable: false, shortcut: 'cmdEnter' });
    sendBridgeEvent.mockClear();
    act(() => hook.result.current.handleTranslate());
    expect(translateCalls()).toHaveLength(0);
    expect(sendBridgeEvent).toHaveBeenCalledWith('probe_local_translate', '{}');
    expect(addToast).toHaveBeenCalledWith('localTranslate.unreachable', 'warning');
  });

  it('resets after the 25s client safety timeout with the generic failure text', () => {
    vi.useFakeTimers();
    try {
      const { hook, addToast } = setup('почини это');
      pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
      act(() => hook.result.current.handleTranslate());
      expect(hook.result.current.isTranslating).toBe(true);
      act(() => vi.advanceTimersByTime(25_000));
      expect(hook.result.current.isTranslating).toBe(false);
      expect(addToast).toHaveBeenCalledWith('localTranslate.failed', 'error');
      expect(addToast).not.toHaveBeenCalledWith('localTranslate.timeout', 'error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps result error codes onto locale keys', () => {
    const recorded: Array<[string, Record<string, string>?]> = [];
    const recordingT = ((key: string, vars?: Record<string, string>) => {
      recorded.push(vars === undefined ? [key] : [key, vars]);
      return key;
    }) as unknown as TFunction;
    const cases: Array<{ error: string; expected: [string, Record<string, string>?] }> = [
      { error: 'timeout', expected: ['localTranslate.timeout'] },
      { error: 'disabled', expected: ['localTranslate.disabled'] },
      { error: 'invalid_response', expected: ['localTranslate.invalidResponse'] },
      { error: 'empty_response', expected: ['localTranslate.invalidResponse'] },
      { error: 'unreachable', expected: ['localTranslate.unreachable'] },
      { error: 'http_500', expected: ['localTranslate.httpError', { status: '500' }] },
    ];

    for (const { error, expected } of cases) {
      recorded.length = 0;
      const { hook } = setup('почини это', { t: recordingT });
      pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
      act(() => hook.result.current.handleTranslate());
      reply({ success: false, text: '', error });
      const errors = recorded.filter(([key]) => !key.startsWith('localTranslate.shortcut'));
      expect(errors).toEqual([expected]);
      cleanup();
      document.body.innerHTML = '';
    }
  });

  it('skips any leading slash command draft across providers', () => {
    const claude = setup('/review the login flow');
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => claude.hook.result.current.handleTranslate());
    expect(translateCalls()).toHaveLength(0);
    expect(claude.editable.textContent).toBe('/review the login flow');
    cleanup();
    document.body.innerHTML = '';
    sendBridgeEvent.mockClear();

    const explain = setup('/explain this');
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => explain.hook.result.current.handleTranslate());
    expect(translateCalls()).toHaveLength(0);
    expect(explain.editable.textContent).toBe('/explain this');
  });

  it('finishes the spinner when the result payload is not JSON', () => {
    const { editable, hook, addToast } = setup('почини это');
    pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    act(() => hook.result.current.handleTranslate());
    expect(hook.result.current.isTranslating).toBe(true);
    act(() => window.updateLocalTranslateResult?.('{'));
    expect(hook.result.current.isTranslating).toBe(false);
    expect(addToast).toHaveBeenCalledWith('localTranslate.invalidResponse', 'error');
    expect(editable.textContent).toBe('почини это');
  });

  it('retries a probe that left before the bridge existed', () => {
    vi.useFakeTimers();
    try {
      sendBridgeEvent.mockReturnValueOnce(false);
      setup('привет');
      expect(sendBridgeEvent).toHaveBeenCalledTimes(1);
      expect(sendBridgeEvent).toHaveBeenCalledWith('probe_local_translate', '{}');
      act(() => vi.advanceTimersByTime(LOCAL_TRANSLATE_PROBE_RETRY_MS));
      expect(sendBridgeEvent).toHaveBeenCalledTimes(2);
      pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
      const afterStatus = sendBridgeEvent.mock.calls.length;
      act(() => vi.advanceTimersByTime(LOCAL_TRANSLATE_PROBE_RETRY_MS * 5));
      expect(sendBridgeEvent).toHaveBeenCalledTimes(afterStatus);
    } finally {
      vi.useRealTimers();
    }
  });

  it('toasts once when the same unreachable chord is handled twice', () => {
    const { hook, addToast } = setup('почини это');
    pushStatus({ enabled: true, reachable: false, shortcut: 'cmdEnter' });
    sendBridgeEvent.mockClear();
    act(() => {
      hook.result.current.handleTranslate();
      hook.result.current.handleTranslate();
    });
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith('localTranslate.unreachable', 'warning');
    expect(sendBridgeEvent).toHaveBeenCalledTimes(1);
    expect(sendBridgeEvent).toHaveBeenCalledWith('probe_local_translate', '{}');
  });

  it('ignores a stale reply for an earlier request', () => {
    vi.useFakeTimers();
    try {
      const { editable, hook } = setup('почини это');
      pushStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
      act(() => hook.result.current.handleTranslate());
      const firstId = lastRequestId();
      act(() => vi.advanceTimersByTime(25_000)); // first request given up on
      act(() => hook.result.current.handleTranslate());
      const secondId = lastRequestId();
      expect(secondId).not.toBe(firstId);

      reply({ success: true, text: 'stale' }, firstId);
      expect(editable.textContent).toBe('почини это');
      expect(hook.result.current.isTranslating).toBe(true);

      reply({ success: true, text: 'fresh' }, secondId);
      expect(editable.textContent).toBe('fresh');
      expect(hook.result.current.isTranslating).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
