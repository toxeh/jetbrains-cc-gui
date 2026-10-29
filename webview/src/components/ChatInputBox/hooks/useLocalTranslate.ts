import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { SendShortcut } from '../types.js';
import { sendBridgeEvent } from '../../../utils/bridge.js';
import {
  applyTranslation,
  isLocalCommandDraft,
  maskDraft,
  placeCaretAtEnd,
  translationWaitMs,
} from '../utils/localTranslate.js';
import type { MaskedDraft, TranslateShortcut } from '../utils/localTranslate.js';
import { setLocalTranslateStatus } from '../utils/localTranslateStatus.js';

declare global {
  interface Window {
    updateLocalTranslateStatus?: (json: string) => void;
    updateLocalTranslateResult?: (json: string) => void;
  }
}

/** Re-probe interval while the feature is enabled but the server did not answer. */
export const LOCAL_TRANSLATE_PROBE_INTERVAL_MS = 30_000;
/** Retry until the first status, including a probe sent before sendToJava exists. */
export const LOCAL_TRANSLATE_PROBE_RETRY_MS = 1_000;
export interface LocalTranslateStatus {
  enabled: boolean;
  reachable: boolean;
  shortcut: TranslateShortcut;
}

interface LocalTranslateResultPayload {
  /** Echo of the request id sent with translate_prompt. */
  id?: number;
  success?: boolean;
  text?: string;
  error?: string;
}

interface UseLocalTranslateOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  getTextContent: () => string;
  invalidateCache: () => void;
  adjustHeight: () => void;
  setHasContent: (hasContent: boolean) => void;
  notifyInput: (text: string) => void;
  sendShortcut: SendShortcut;
  /** Active chat provider. Decides which slash drafts handleSubmit would swallow. */
  currentProvider?: string;
  disabled: boolean;
  addToast?: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

export interface UseLocalTranslateReturn {
  /** Server answered the probe and the feature is enabled: the button is shown. */
  reachable: boolean;
  isTranslating: boolean;
  /** Chord the keymap gives to translate (null when off or when send keeps it). */
  translateShortcut: TranslateShortcut | null;
  /** Label of the active chord for the tooltip, or null when no chord translates. */
  shortcutLabel: string | null;
  handleTranslate: () => void;
}

function parseStatus(json: string): LocalTranslateStatus | null {
  try {
    const data = JSON.parse(json) as Partial<LocalTranslateStatus>;
    return {
      enabled: data.enabled === true,
      reachable: data.enabled === true && data.reachable === true,
      shortcut: data.shortcut === 'shiftEnter' ? 'shiftEnter' : 'cmdEnter',
    };
  } catch {
    return null;
  }
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
}

/**
 * Chord that actually translates, mirroring SendShortcutDecision: in Cmd/Ctrl+Enter send
 * mode, a `cmdEnter` translate shortcut falls back to Shift+Enter so send keeps Cmd/Ctrl+Enter.
 */
export function resolveActiveTranslateChord(
  sendShortcut: SendShortcut,
  status: Pick<LocalTranslateStatus, 'enabled' | 'shortcut'>,
): TranslateShortcut | null {
  if (!status.enabled) return null;
  if (status.shortcut === 'cmdEnter' && sendShortcut === 'cmdEnter') return 'shiftEnter';
  return status.shortcut;
}

export function formatTranslateChord(chord: TranslateShortcut | null, t: TFunction, mac = isMacPlatform()): string | null {
  if (chord === 'shiftEnter') return t('localTranslate.shortcutShiftEnter');
  if (chord === 'cmdEnter') return t(mac ? 'localTranslate.shortcutCmdEnterMac' : 'localTranslate.shortcutCmdEnter');
  return null;
}

function errorMessage(error: string | undefined, t: TFunction): string {
  if (error === 'unreachable') return t('localTranslate.unreachable');
  if (error === 'timeout') return t('localTranslate.timeout');
  if (error === 'disabled') return t('localTranslate.disabled');
  if (error === 'invalid_response' || error === 'empty_response') return t('localTranslate.invalidResponse');
  if (error && error.startsWith('http_')) {
    return t('localTranslate.httpError', { status: error.slice('http_'.length) });
  }
  return t('localTranslate.failed');
}

/**
 * useLocalTranslate - rewrite the draft through the local OpenAI-compatible model.
 *
 * Probes on mount, again every second until the first status, and every 30s while the
 * feature is enabled but unreachable. A translate call masks chips and code, sends one
 * string, and on success replaces the draft in place. The message is never sent from here.
 */
export function useLocalTranslate({
  editableRef,
  getTextContent,
  invalidateCache,
  adjustHeight,
  setHasContent,
  notifyInput,
  sendShortcut,
  currentProvider = 'claude',
  disabled,
  addToast,
  t,
}: UseLocalTranslateOptions): UseLocalTranslateReturn {
  const [status, setStatus] = useState<LocalTranslateStatus>({
    enabled: false,
    reachable: false,
    shortcut: 'cmdEnter',
  });
  const [statusReady, setStatusReady] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<{ id: number; masked: MaskedDraft; snapshot: string } | null>(null);
  const nextRequestIdRef = useRef(1);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef(status);
  const statusReadyRef = useRef(false);
  const unreachableAnnouncedRef = useRef(false);
  const disabledRef = useRef(disabled);

  const probe = useCallback(() => sendBridgeEvent('probe_local_translate', '{}'), []);

  const finishRequest = useCallback(() => {
    inFlightRef.current = false;
    pendingRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsTranslating(false);
  }, []);

  // Callbacks from Java. Registered once; they read refs so a late reply never sees stale state.
  const applyResultRef = useRef<(payload: LocalTranslateResultPayload) => void>(() => {});
  const applyResult = (payload: LocalTranslateResultPayload) => {
    const pending = pendingRef.current;
    // A reply for an earlier (timed-out) request must not finish or touch the current one.
    if (!pending || payload.id !== pending.id) return;
    finishRequest();
    if (!payload.success || typeof payload.text !== 'string' || !payload.text) {
      addToast?.(errorMessage(payload.error, t), 'error');
      return;
    }
    const editable = editableRef.current;
    if (!editable) return;
    invalidateCache();
    const chipsGone = Array.from(pending.masked.chips.values()).some((chip) => !editable.contains(chip));
    if (disabledRef.current || chipsGone || getTextContent() !== pending.snapshot) {
      addToast?.(t('localTranslate.draftChanged'), 'warning');
      return;
    }
    const applied = applyTranslation(editable, pending.masked, payload.text);
    if (!applied.ok) {
      addToast?.(t('localTranslate.placeholderMismatch'), 'error');
      return;
    }
    invalidateCache();
    adjustHeight();
    const text = getTextContent();
    setHasContent(text.trim().length > 0 || pending.masked.chips.size > 0);
    notifyInput(text);
    editable.focus();
    placeCaretAtEnd(editable);
  };
  useLayoutEffect(() => {
    statusRef.current = status;
    disabledRef.current = disabled;
    applyResultRef.current = applyResult;
  });

  useEffect(() => {
    window.updateLocalTranslateStatus = (json: string) => {
      const next = parseStatus(json);
      if (!next) return;
      statusReadyRef.current = true;
      unreachableAnnouncedRef.current = false;
      setStatusReady(true);
      setStatus(next);
      setLocalTranslateStatus(next);
    };
    window.updateLocalTranslateResult = (json: string) => {
      let payload: LocalTranslateResultPayload;
      try {
        payload = JSON.parse(json) as LocalTranslateResultPayload;
      } catch {
        // No id in a broken payload would leave the spinner up until the 25s fallback.
        payload = { id: pendingRef.current?.id, success: false, error: 'invalid_response' };
      }
      applyResultRef.current(payload);
    };
    // The chat window just opened: ask the backend to read config and probe.
    probe();
    return () => {
      delete window.updateLocalTranslateStatus;
      delete window.updateLocalTranslateResult;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [probe]);

  // The composer can mount before sendToJava exists. Keep asking until any status arrives.
  useEffect(() => {
    if (statusReady) return;
    const timer = setInterval(() => {
      if (statusReadyRef.current) return;
      probe();
    }, LOCAL_TRANSLATE_PROBE_RETRY_MS);
    return () => clearInterval(timer);
  }, [probe, statusReady]);

  // Re-probe every 30s until the server is reachable. A status of enabled:false
  // is included, so a failed read cannot leave reply globes off for the page lifetime.
  useEffect(() => {
    if (status.reachable) return;
    const timer = setInterval(probe, LOCAL_TRANSLATE_PROBE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status.reachable, probe]);

  const handleTranslate = useCallback(() => {
    const current = statusRef.current;
    if (!current.enabled) return;
    if (inFlightRef.current) return; // a second request while one is in flight is ignored
    if (disabled) return;
    const editable = editableRef.current;
    if (!editable) return;

    invalidateCache();
    const snapshot = getTextContent();
    if (!snapshot.trim()) return;
    if (isLocalCommandDraft(snapshot, currentProvider)) return;

    const masked = maskDraft(editable);
    if (!masked.hasProse) return; // only chips and code: nothing for the model

    if (!current.reachable) {
      // Native capture and the IDE action both call this for one chord.
      if (unreachableAnnouncedRef.current) return;
      unreachableAnnouncedRef.current = true;
      addToast?.(t('localTranslate.unreachable'), 'warning');
      if (!probe()) unreachableAnnouncedRef.current = false;
      return;
    }

    const id = nextRequestIdRef.current++;
    inFlightRef.current = true;
    pendingRef.current = { id, masked, snapshot };
    setIsTranslating(true);
    timeoutRef.current = setTimeout(() => {
      if (!inFlightRef.current) return;
      finishRequest();
      // The backend's own 15s timeout would have answered; this is the "no reply at all" case.
      addToast?.(t('localTranslate.failed'), 'error');
    }, translationWaitMs(masked.text.length));

    if (!sendBridgeEvent('translate_prompt', JSON.stringify({ id, text: masked.text }))) {
      finishRequest();
      addToast?.(t('localTranslate.failed'), 'error');
    }
  }, [disabled, editableRef, getTextContent, invalidateCache, addToast, t, probe, finishRequest, currentProvider]);

  const translateShortcut = status.enabled ? status.shortcut : null;
  const activeChord = resolveActiveTranslateChord(sendShortcut, status);

  return {
    reachable: status.enabled && status.reachable,
    isTranslating,
    translateShortcut,
    shortcutLabel: formatTranslateChord(activeChord, t),
    handleTranslate,
  };
}
