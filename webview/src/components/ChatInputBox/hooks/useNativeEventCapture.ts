import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import type { SendShortcut } from '../types.js';
import {
  catchStrayEnter,
  claimEnterPress,
  isEnterKey,
  isSendKey,
  isTranslateKey,
  releaseEnterKeyUp,
  releaseEnterPress,
  triageEnterKeyDown,
} from '../utils/enterKeyGuard.js';
import type { EnterKeyRefs } from '../utils/enterKeyGuard.js';
import type { TranslateShortcut } from '../utils/localTranslate.js';

interface CompletionOpenLike {
  isOpen: boolean;
}

export interface UseNativeEventCaptureOptions extends EnterKeyRefs {
  editableRef: React.RefObject<HTMLDivElement | null>;
  sendShortcut: SendShortcut;
  fileCompletion: CompletionOpenLike;
  commandCompletion: CompletionOpenLike;
  agentCompletion: CompletionOpenLike;
  promptCompletion: CompletionOpenLike;
  dollarCommandCompletion: CompletionOpenLike;
  handleSubmit: () => void;
  handleEnhancePrompt: () => void;
  handleCompositionEnd: () => void;
  /** Local translate chord owner (null when the feature is off). */
  translateShortcut?: TranslateShortcut | null;
  /** Rewrite the draft through the local model; never sends. */
  handleTranslate?: () => void;
}

function isAnyCompletionOpen(options: UseNativeEventCaptureOptions): boolean {
  return (
    options.fileCompletion.isOpen ||
    options.commandCompletion.isOpen ||
    options.agentCompletion.isOpen ||
    options.promptCompletion.isOpen ||
    options.dollarCommandCompletion.isOpen
  );
}

/**
 * useNativeEventCapture - Native event capture for JCEF/IME edge cases
 *
 * Capturing listeners run before React's delegated handlers, so this layer
 * speaks for Enter first and useKeyboardHandler skips anything already
 * `defaultPrevented`. It also covers:
 * - beforeinput insertParagraph that JCEF delivers without a keydown (Enter-to-send mode)
 * - prompt enhancer shortcut (Cmd+/)
 * - local translate chord and the IDE `ideaTranslate` event
 */
export function useNativeEventCapture(options: UseNativeEventCaptureOptions): void {
  const { editableRef, sendShortcut, handleSubmit, handleEnhancePrompt } = options;
  const enterWasComposingRef = useRef(false);
  // useEffectEvent keeps the first committed submit in JCEF. Enter would then
  // still see the initial Claude frame, where SDK status is loading and the
  // provider is not installed, and toast instead of sending.
  const handleSubmitRef = useRef(handleSubmit);
  // Same JCEF limit as handleSubmit: the effect-event callback can stay on the
  // first committed frame, where every menu is closed. Enter would then send
  // the draft ("/cle") instead of letting the open menu take the highlighted
  // command. The ref follows committed renders only, so a suspended render
  // cannot flip the menu open before that render commits.
  const completionOpenRef = useRef(false);
  // Same JCEF limit again: sendShortcut and the translate shortcut can change
  // after mount (when settings or the first probe arrive), so a first-frame
  // effect event would still see the initial 'enter' / off defaults.
  const sendShortcutRef = useRef<SendShortcut>(sendShortcut);
  const handleTranslateRef = useRef(options.handleTranslate);
  const translateShortcutRef = useRef<TranslateShortcut | null>(options.translateShortcut ?? null);
  useLayoutEffect(() => {
    handleSubmitRef.current = handleSubmit;
    completionOpenRef.current = isAnyCompletionOpen(options);
    sendShortcutRef.current = sendShortcut;
    handleTranslateRef.current = options.handleTranslate;
    translateShortcutRef.current = options.translateShortcut ?? null;
  });

  // Effect Events only swap their implementation on commit, so the listeners
  // below stay subscribed for the element's lifetime yet never act on props
  // from a render that was interrupted or suspended.
  const onNativeKeyDown = useEffectEvent((ev: KeyboardEvent) => {
    if (ev.key === '/' && ev.metaKey && !ev.shiftKey && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      handleEnhancePrompt();
      return;
    }

    // NOTE: We intentionally do NOT set isComposingRef here based on keyCode 229.
    // IME composing state is managed exclusively by compositionStart/End events.
    // In JCEF, keyCode 229 is reported for ALL keys while the Korean IME is active,
    // including space, which is not an actual composition. Setting isComposingRef=true
    // here without a corresponding compositionEnd to clear it causes the ref to get
    // stuck, blocking handleInput and causing cursor jumping on space key.
    if (!isEnterKey(ev.key, ev.keyCode)) return;
    if (!ev.repeat) enterWasComposingRef.current = ev.isComposing;

    const currentSendShortcut = sendShortcutRef.current;
    const translateShortcut = translateShortcutRef.current;
    const verdict = triageEnterKeyDown(ev, ev.isComposing, currentSendShortcut, options, translateShortcut);
    if (verdict === 'awaitingIme') {
      // Keep the native candidate confirmation, but don't let React reclassify
      // this same press if the composition guard expires during propagation.
      ev.stopPropagation();
      return;
    }
    if (verdict === 'swallowed') return;
    // Open completion menus read Enter through the React handler.
    // completionOpenRef, not the effect-event options: JCEF can keep this
    // callback on the first frame, where every menu is still closed.
    if (completionOpenRef.current) return;

    if (isTranslateKey(currentSendShortcut, translateShortcut, ev)) {
      claimEnterPress(ev, options);
      handleTranslateRef.current?.();
      return;
    }
    if (!isSendKey(currentSendShortcut, ev, translateShortcut)) return;

    claimEnterPress(ev, options);
    handleSubmitRef.current();
  });

  const onNativeKeyUp = useEffectEvent((ev: KeyboardEvent) => {
    if (!isEnterKey(ev.key, ev.keyCode)) return;
    enterWasComposingRef.current = false;
    releaseEnterKeyUp(ev, sendShortcutRef.current, options, translateShortcutRef.current);
  });

  const onNativeBeforeInput = useEffectEvent((ev: InputEvent) => {
    catchStrayEnter(ev, sendShortcutRef.current, options, completionOpenRef.current, () => {
      handleSubmitRef.current();
    });
    if (
      ev.inputType === 'insertParagraph' &&
      options.isComposingRef.current &&
      !ev.isComposing &&
      !enterWasComposingRef.current
    ) {
      // Chromium can emit a non-composing paragraph during an IME-owned Enter.
      // Only recover a lost compositionend when neither event signals composition.
      options.handleCompositionEnd();
    }
  });

  // Focus can leave the editor before Enter's keyup arrives (a dialog opened by
  // the send, an IDE shortcut); the press must not stay spoken for.
  const onBlur = useEffectEvent(() => {
    enterWasComposingRef.current = false;
    releaseEnterPress(options);
  });

  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;

    el.addEventListener('keydown', onNativeKeyDown, { capture: true });
    el.addEventListener('keyup', onNativeKeyUp, { capture: true });
    el.addEventListener('beforeinput', onNativeBeforeInput as EventListener, { capture: true });
    el.addEventListener('blur', onBlur);

    return () => {
      el.removeEventListener('keydown', onNativeKeyDown, { capture: true });
      el.removeEventListener('keyup', onNativeKeyUp, { capture: true });
      el.removeEventListener('beforeinput', onNativeBeforeInput as EventListener, { capture: true });
      el.removeEventListener('blur', onBlur);
    };
  }, [editableRef]);

  // ChatTranslateAction (IDE keymap) → execContextAction('translate') → ideaTranslate.
  // Reads refs only, never an effect event: JCEF would keep the first commit.
  // An open completion menu keeps the chord, and a live IME composition owns Enter.
  // Like the 'newline' action, it only acts when focus is in the composer: a keymap
  // chord pressed in another webview field must not rewrite the draft.
  const isComposingRef = options.isComposingRef;
  useEffect(() => {
    const onIdeaTranslate = () => {
      const el = editableRef.current;
      const active = document.activeElement;
      if (!el || !active || (active !== el && !el.contains(active))) return;
      if (completionOpenRef.current || isComposingRef.current) return;
      handleTranslateRef.current?.();
    };
    document.addEventListener('ideaTranslate', onIdeaTranslate);
    return () => document.removeEventListener('ideaTranslate', onIdeaTranslate);
  }, [editableRef, isComposingRef]);
}
