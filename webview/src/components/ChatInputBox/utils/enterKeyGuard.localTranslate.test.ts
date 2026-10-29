import {
  isExplicitNewlineKey,
  isSendKey,
  isTranslateKey,
  releaseEnterKeyUp,
  triageEnterKeyDown,
} from './enterKeyGuard.js';
import type { EnterKeyEvent, EnterKeyRefs } from './enterKeyGuard.js';

const plain = { shiftKey: false, metaKey: false, ctrlKey: false };
const cmd = { shiftKey: false, metaKey: true, ctrlKey: false };
const ctrl = { shiftKey: false, metaKey: false, ctrlKey: true };
const shift = { shiftKey: true, metaKey: false, ctrlKey: false };

function makeRefs(): EnterKeyRefs {
  return {
    submittedOnEnterRef: { current: false },
    completionSelectedRef: { current: false },
    isComposingRef: { current: false },
    lastCompositionEndTimeRef: { current: Date.now() - 1000 },
  };
}

function keyEvent(overrides: Partial<EnterKeyEvent> = {}) {
  return { ...plain, repeat: false, preventDefault: vi.fn(), ...overrides };
}

describe('enterKeyGuard with local translate off', () => {
  it('keeps the existing enter-mode cases', () => {
    expect(isSendKey('enter', plain)).toBe(true);
    expect(isSendKey('enter', cmd)).toBe(true);
    expect(isSendKey('enter', ctrl)).toBe(true);
    expect(isSendKey('enter', shift)).toBe(false);
    expect(isSendKey('enter', cmd, null)).toBe(true);
    expect(isExplicitNewlineKey('enter', shift)).toBe(true);
    expect(isTranslateKey('enter', null, cmd)).toBe(false);
  });

  it('keeps the existing cmdEnter-mode cases', () => {
    expect(isSendKey('cmdEnter', plain)).toBe(false);
    expect(isSendKey('cmdEnter', cmd)).toBe(true);
    expect(isSendKey('cmdEnter', ctrl)).toBe(true);
    expect(isSendKey('cmdEnter', shift)).toBe(false);
    expect(isExplicitNewlineKey('cmdEnter', shift)).toBe(true);
  });
});

describe('enterKeyGuard with local translate owning Cmd/Ctrl+Enter', () => {
  it('is not a send key in enter mode; plain Enter still sends', () => {
    expect(isTranslateKey('enter', 'cmdEnter', cmd)).toBe(true);
    expect(isTranslateKey('enter', 'cmdEnter', ctrl)).toBe(true);
    expect(isSendKey('enter', cmd, 'cmdEnter')).toBe(false);
    expect(isSendKey('enter', ctrl, 'cmdEnter')).toBe(false);
    expect(isSendKey('enter', plain, 'cmdEnter')).toBe(true);
    expect(isExplicitNewlineKey('enter', shift, 'cmdEnter')).toBe(true);
  });

  it('leaves Cmd/Ctrl+Enter to send and translates on Shift+Enter in cmdEnter mode', () => {
    expect(isTranslateKey('cmdEnter', 'cmdEnter', cmd)).toBe(false);
    expect(isTranslateKey('cmdEnter', 'cmdEnter', shift)).toBe(true);
    expect(isExplicitNewlineKey('cmdEnter', shift, 'cmdEnter')).toBe(false);
    expect(isSendKey('cmdEnter', cmd, 'cmdEnter')).toBe(true);
    expect(isSendKey('cmdEnter', shift, 'cmdEnter')).toBe(false);
  });
});

describe('enterKeyGuard with local translate owning Shift+Enter', () => {
  it('Shift+Enter is not a newline and not a send key in either mode', () => {
    for (const mode of ['enter', 'cmdEnter'] as const) {
      expect(isTranslateKey(mode, 'shiftEnter', shift)).toBe(true);
      expect(isExplicitNewlineKey(mode, shift, 'shiftEnter')).toBe(false);
      expect(isSendKey(mode, shift, 'shiftEnter')).toBe(false);
    }
  });

  it('Cmd/Ctrl+Enter keeps its mode meaning', () => {
    expect(isTranslateKey('enter', 'shiftEnter', cmd)).toBe(false);
    expect(isSendKey('cmdEnter', cmd, 'shiftEnter')).toBe(true);
  });

  it('keeps Alt+Shift+Enter as a newline', () => {
    const altShift = { shiftKey: true, metaKey: false, ctrlKey: false, altKey: true };
    expect(isTranslateKey('enter', 'shiftEnter', altShift)).toBe(false);
    expect(isTranslateKey('cmdEnter', 'shiftEnter', altShift)).toBe(false);
    expect(isExplicitNewlineKey('enter', altShift, 'shiftEnter')).toBe(true);
    expect(isSendKey('enter', altShift, 'shiftEnter')).toBe(false);
  });

  it('does not treat Alt+Cmd+Enter as translate', () => {
    const altCmd = { shiftKey: false, metaKey: true, ctrlKey: false, altKey: true };
    expect(isTranslateKey('enter', 'cmdEnter', altCmd)).toBe(false);
    expect(isSendKey('enter', altCmd, 'cmdEnter')).toBe(true);
  });
});

describe('triage of the translate chord', () => {
  it('swallows a repeated translate chord like a repeated send key', () => {
    const refs = makeRefs();
    const e = keyEvent({ ...shift, repeat: true });
    expect(triageEnterKeyDown(e, false, 'enter', refs, 'shiftEnter')).toBe('swallowed');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(refs.submittedOnEnterRef.current).toBe(true);
  });

  it('lets a held Shift+Enter newline keep repeating when the feature is off', () => {
    const refs = makeRefs();
    expect(triageEnterKeyDown(keyEvent({ ...shift, repeat: true }), false, 'enter', refs)).toBe('open');
  });

  it('cancels the keyup default of a translate chord', () => {
    const e = keyEvent(cmd);
    releaseEnterKeyUp(e, 'enter', makeRefs(), 'cmdEnter');
    expect(e.preventDefault).toHaveBeenCalled();
  });
});
