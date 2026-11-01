import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent } from '../utils/bridge';
import type { ClaudeContentBlock, ClaudeMessage } from '../types';
import {
  isReplyTranslatable,
  maskMarkdown,
  restoreMarkdown,
  sha256Hex,
  translationWaitMs,
} from '../components/ChatInputBox/utils/localTranslate';
import {
  subscribeLocalTranslateStatus,
  getLocalTranslateStatus,
} from '../components/ChatInputBox/utils/localTranslateStatus';

export interface ReplyTranslationEntry {
  russian: string;
  shown: boolean;
}

export interface RegisteredBlock {
  hash: string;
  text: string;
  getElement?: () => HTMLElement | null;
}

export interface ReplyTranslationContextValue {
  /** Whether localTranslate is enabled in settings */
  enabled: boolean;
  /** In-memory cache of translations keyed by sha256Hex(text) */
  cache: Record<string, ReplyTranslationEntry>;
  /** Hash currently being translated (single-lane) */
  inFlightHash: string | null;
  /** Check if a block's translation is currently shown */
  isBlockShown: (text: string) => boolean;
  /** Whether a block is currently in-flight */
  isBlockLoading: (text: string) => boolean;
  /** Get translated Russian text if shown */
  getDisplayText: (text: string) => string | undefined;
  /** Toggle translation visibility for a block */
  toggleBlock: (text: string) => void;
  /** Toggle all eligible blocks in session */
  toggleAll: () => void;
  /** Whether every currently eligible block is showing Russian */
  isAllShown: () => boolean;
  /** Register an eligible block that is currently mounted */
  registerBlock: (hash: string, text: string, getElement?: () => HTMLElement | null) => () => void;
}

const DEFAULT_VALUE: ReplyTranslationContextValue = {
  enabled: false,
  cache: {},
  inFlightHash: null,
  isBlockShown: () => false,
  isBlockLoading: () => false,
  getDisplayText: () => undefined,
  toggleBlock: () => {},
  toggleAll: () => {},
  isAllShown: () => false,
  registerBlock: () => () => {},
};

const ReplyTranslationContext = createContext<ReplyTranslationContextValue>(DEFAULT_VALUE);

interface QueueItem {
  hash: string;
  text: string;
  masked: string;
  code: Map<string, string>;
  provider: string;
}

function blockElement(hash: string, getElement?: () => HTMLElement | null): HTMLElement | null {
  const fromRef = getElement?.() ?? null;
  if (fromRef) return fromRef;
  if (typeof document === 'undefined') return null;
  const found = document.querySelector(`[data-reply-hash="${hash}"]`);
  return found instanceof HTMLElement ? found : null;
}

function intersectsMessageList(el: HTMLElement): boolean {
  const closest = el.closest('.messages-container');
  const view = closest instanceof HTMLElement ? closest : document.querySelector('.messages-container');
  if (!(view instanceof HTMLElement)) {
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  }
  const viewRect = view.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  return rect.bottom > viewRect.top && rect.top < viewRect.bottom;
}

function compareDocumentOrder(a: HTMLElement | null, b: HTMLElement | null): number {
  if (a && b && a !== b) {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  }
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}

function entryIsShown(entry: ReplyTranslationEntry | undefined): boolean {
  return Boolean(entry?.shown && entry.russian);
}

/** Loaded assistant texts, in document order. Null when the caller did not pass the message list. */
function eligibleReplyTexts(
  messages: readonly ClaudeMessage[] | undefined,
  getContentBlocks: ((message: ClaudeMessage) => ClaudeContentBlock[]) | undefined,
): string[] | null {
  if (!messages || !getContentBlocks) {
    return null;
  }
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'assistant') {
      continue;
    }
    const blocks = getContentBlocks(message) ?? [];
    blocks.forEach((block, index) => {
      if (block?.type !== 'text') {
        return;
      }
      const text = block.text ?? '';
      const streamingTail = Boolean(message.isStreaming) && index === blocks.length - 1;
      if (streamingTail || !isReplyTranslatable(text) || seen.has(text)) {
        return;
      }
      seen.add(text);
      texts.push(text);
    });
  }
  return texts;
}

export interface ReplyTranslationProviderProps {
  children: ReactNode;
  currentSessionId?: string | null;
  currentProvider?: string;
  /** Messages already loaded into the session, including turns the list has collapsed. */
  messages?: readonly ClaudeMessage[];
  getContentBlocks?: (message: ClaudeMessage) => ClaudeContentBlock[];
}

function getReplyErrorMessage(error: string | undefined, t: (key: string, options?: any) => string): string {
  if (error === 'unreachable') return t('localTranslate.unreachable');
  if (error === 'timeout') return t('localTranslate.timeout');
  if (error === 'disabled') return t('localTranslate.disabled');
  if (error === 'invalid_response' || error === 'empty_response') return t('localTranslate.invalidResponse');
  if (error && error.startsWith('http_')) {
    return t('localTranslate.httpError', { status: error.slice('http_'.length) });
  }
  return t('localTranslate.failed');
}

export function ReplyTranslationProvider({
  children,
  currentSessionId,
  currentProvider = 'claude',
  messages,
  getContentBlocks,
}: ReplyTranslationProviderProps) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean>(() => getLocalTranslateStatus().enabled);
  const [cache, setCache] = useState<Record<string, ReplyTranslationEntry>>({});
  const [inFlightHash, setInFlightHash] = useState<string | null>(null);

  // References for queue, generation, and active requests
  const cacheRef = useRef<Record<string, ReplyTranslationEntry>>({});
  cacheRef.current = cache;

  const currentSessionIdRef = useRef<string | null>(currentSessionId ?? null);
  currentSessionIdRef.current = currentSessionId ?? null;

  const currentProviderRef = useRef<string>(currentProvider);
  currentProviderRef.current = currentProvider;

  const generationRef = useRef<number>(0);
  const requestIdRef = useRef<number>(0);
  const queueRef = useRef<QueueItem[]>([]);
  const inFlightHashRef = useRef<string | null>(null);
  const inFlightIdRef = useRef<number | null>(null);
  const inFlightGenRef = useRef<number>(0);
  const inFlightItemRef = useRef<QueueItem | null>(null);
  const inFlightSessionRef = useRef<string | null>(null);
  const fallbackTimeoutRef = useRef<number | null>(null);
  const wantedShownRef = useRef<Map<string, boolean>>(new Map());
  const loadGenRef = useRef<number>(0);
  const showAllPendingRef = useRef(false);
  const eligibleTexts = useMemo(
    () => eligibleReplyTexts(messages, getContentBlocks),
    [messages, getContentBlocks],
  );
  const eligibleTextsRef = useRef(eligibleTexts);
  eligibleTextsRef.current = eligibleTexts;

  // Track mounted eligible blocks for session globe status & order
  const registeredBlocksRef = useRef<Map<string, { text: string; count: number; getElement?: () => HTMLElement | null }>>(
    new Map()
  );
  // Force re-evaluation of isAllShown when blocks register/unregister
  const [registrationCount, setRegistrationCount] = useState<number>(0);

  // Subscribe to localTranslate enabled status
  useEffect(() => {
    return subscribeLocalTranslateStatus((status) => {
      setEnabled(Boolean(status.enabled));
    });
  }, []);

  const toast = useCallback((msg: string, type: 'error' | 'info' = 'error') => {
    if (typeof window !== 'undefined' && window.addToast) {
      window.addToast(msg, type);
    } else if (typeof window !== 'undefined') {
      const event = new CustomEvent('show-toast', { detail: { message: msg, type } });
      window.dispatchEvent(event);
    }
  }, []);

  const processNextQueueItem = useCallback(() => {
    if (inFlightHashRef.current !== null) {
      return;
    }
    const item = queueRef.current.shift();
    if (!item) {
      return;
    }
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    const provider = item.provider || currentProviderRef.current || 'claude';
    const queued: QueueItem = { ...item, provider };
    const reqId = ++requestIdRef.current;
    const reqGen = generationRef.current;
    inFlightHashRef.current = queued.hash;
    inFlightIdRef.current = reqId;
    inFlightGenRef.current = reqGen;
    inFlightItemRef.current = queued;
    inFlightSessionRef.current = sessionId;
    setInFlightHash(queued.hash);

    const dispatched = sendBridgeEvent('translate_reply', {
      id: reqId,
      sessionId,
      provider,
      hash: queued.hash,
      text: queued.masked,
    });
    if (dispatched === false) {
      if (inFlightIdRef.current === reqId) {
        inFlightHashRef.current = null;
        inFlightIdRef.current = null;
        inFlightItemRef.current = null;
        inFlightSessionRef.current = null;
        setInFlightHash(null);
        wantedShownRef.current.delete(queued.hash);
        toast(t('localTranslate.failed'));
      }
      return;
    }

    if (inFlightIdRef.current === reqId) {
      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
      }
      fallbackTimeoutRef.current = window.setTimeout(() => {
        if (inFlightIdRef.current === reqId) {
          handleTranslationComplete(reqId, false, queued.hash, '', 'timeout');
        }
      }, translationWaitMs(queued.masked.length));
    }
  }, [t, toast]);

  const handleTranslationComplete = useCallback(
    (id: number | string | undefined, success: boolean, hash: string, text: string, error?: string) => {
      if (inFlightIdRef.current !== id) {
        return;
      }
      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
        fallbackTimeoutRef.current = null;
      }

      const reqGen = inFlightGenRef.current;
      const currentGen = generationRef.current;
      const item = inFlightItemRef.current;
      const reqSession = inFlightSessionRef.current;

      inFlightHashRef.current = null;
      inFlightIdRef.current = null;
      inFlightItemRef.current = null;
      inFlightSessionRef.current = null;
      setInFlightHash(null);

      const blockHash = item?.hash || hash;
      if (success && text && item) {
        const res = restoreMarkdown(text, item.code);
        if (res.ok) {
          const restored = res.text;
          const isStillWanted = currentGen === reqGen && wantedShownRef.current.get(blockHash) !== false;
          const sessionId = reqSession || currentSessionIdRef.current;
          if (sessionId) {
            setCache((prev) => ({
              ...prev,
              [blockHash]: { russian: restored, shown: isStillWanted },
            }));
            sendBridgeEvent('save_reply_translation', {
              sessionId,
              provider: item.provider || 'claude',
              hash: blockHash,
              russian: restored,
              shown: isStillWanted,
            });
          }
        } else {
          if (blockHash) wantedShownRef.current.delete(blockHash);
          toast(t('localTranslate.failed'));
        }
      } else if (!success) {
        if (blockHash) wantedShownRef.current.delete(blockHash);
        toast(getReplyErrorMessage(error, t));
      } else if (blockHash) {
        wantedShownRef.current.delete(blockHash);
      }

      // If generation hasn't changed or there are pending items, continue processing queue
      if (currentGen === reqGen || queueRef.current.length > 0) {
        processNextQueueItem();
      }
    },
    [t, toast, processNextQueueItem]
  );

  // Load cache when session changes
  useEffect(() => {
    generationRef.current++;
    queueRef.current = [];
    if (fallbackTimeoutRef.current) {
      clearTimeout(fallbackTimeoutRef.current);
      fallbackTimeoutRef.current = null;
    }
    inFlightHashRef.current = null;
    inFlightIdRef.current = null;
    inFlightItemRef.current = null;
    inFlightSessionRef.current = null;
    setInFlightHash(null);
    setCache({});
    wantedShownRef.current.clear();
    showAllPendingRef.current = false;
    loadGenRef.current = generationRef.current;

    if (currentSessionId) {
      sendBridgeEvent('load_reply_translations', {
        sessionId: currentSessionId,
        provider: currentProvider || 'claude',
      });
    }

    return () => {
      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
        fallbackTimeoutRef.current = null;
      }
      queueRef.current = [];
      inFlightHashRef.current = null;
      inFlightIdRef.current = null;
      inFlightItemRef.current = null;
      inFlightSessionRef.current = null;
    };
  }, [currentSessionId, currentProvider]);

  // Register window callbacks
  useEffect(() => {
    window.updateReplyTranslationFile = (payload: any) => {
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        if (data && data.sessionId === currentSessionIdRef.current) {
          if (data.unreadable) {
            toast(t('localTranslate.cacheUnreadable'));
            return;
          }
          const entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
          const generationMoved = generationRef.current !== loadGenRef.current;
          // Show-all after hide-all still wants rows from a load that has not arrived yet.
          const showAllPending = showAllPendingRef.current;
          const filledMisses = Object.keys(entries).filter((key) => {
            const incoming = entries[key];
            return Boolean(incoming && incoming.russian && !cacheRef.current[key]?.russian);
          });
          if (filledMisses.length > 0) {
            const filled = new Set(filledMisses);
            queueRef.current = queueRef.current.filter((item) => !filled.has(item.hash));
            if (inFlightHashRef.current && filled.has(inFlightHashRef.current)) {
              if (fallbackTimeoutRef.current) {
                clearTimeout(fallbackTimeoutRef.current);
                fallbackTimeoutRef.current = null;
              }
              inFlightHashRef.current = null;
              inFlightIdRef.current = null;
              inFlightItemRef.current = null;
              inFlightSessionRef.current = null;
              setInFlightHash(null);
              processNextQueueItem();
            }
            const sessionId = currentSessionIdRef.current;
            if (sessionId && !showAllPending) {
              for (const key of filledMisses) {
                if (wantedShownRef.current.get(key) !== true || generationMoved) {
                  continue;
                }
                sendBridgeEvent('save_reply_translation', {
                  sessionId,
                  provider: currentProviderRef.current || 'claude',
                  hash: key,
                  russian: entries[key].russian,
                  shown: true,
                });
              }
            }
          }
          setCache((prev) => {
            const next: Record<string, ReplyTranslationEntry> = { ...entries, ...prev };
            for (const key of Object.keys(entries)) {
              const incoming = entries[key];
              if (!incoming?.russian || prev[key]?.russian) {
                continue;
              }
              const wantShown = showAllPending || wantedShownRef.current.get(key) === true;
              next[key] = {
                ...incoming,
                shown: wantShown ? true : generationMoved ? false : Boolean(incoming.shown),
              };
            }
            return next;
          });
        }
      } catch (e) {
        console.warn('[ReplyTranslation] failed to parse updateReplyTranslationFile', e);
      }
    };

    window.updateReplyTranslation = (payload: any) => {
      try {
        const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        if (data) {
          handleTranslationComplete(data.id, Boolean(data.success), data.hash || '', data.text || '', data.error);
        }
      } catch (e) {
        console.warn('[ReplyTranslation] failed to parse updateReplyTranslation', e);
      }
    };

    return () => {
      delete window.updateReplyTranslationFile;
      delete window.updateReplyTranslation;
    };
  }, [handleTranslationComplete, processNextQueueItem, t, toast]);

  const registerBlock = useCallback((hash: string, text: string, getElement?: () => HTMLElement | null) => {
    const map = registeredBlocksRef.current;
    const existing = map.get(hash);
    if (existing) {
      existing.count++;
      existing.getElement = getElement;
    } else {
      map.set(hash, { text, count: 1, getElement });
    }
    setRegistrationCount((c) => c + 1);

    return () => {
      const cur = map.get(hash);
      if (cur) {
        cur.count--;
        if (cur.count <= 0) {
          map.delete(hash);
        }
      }
      setRegistrationCount((c) => c + 1);
    };
  }, []);

  const isBlockShown = useCallback(
    (text: string): boolean => {
      const hash = sha256Hex(text);
      return entryIsShown(cache[hash]);
    },
    [cache]
  );

  const isBlockLoading = useCallback(
    (text: string): boolean => {
      const hash = sha256Hex(text);
      return inFlightHash === hash;
    },
    [inFlightHash]
  );

  const getDisplayText = useCallback(
    (text: string): string | undefined => {
      const hash = sha256Hex(text);
      const entry = cache[hash];
      if (entry && entry.shown && entry.russian) {
        return entry.russian;
      }
      return undefined;
    },
    [cache]
  );

  const toggleBlock = useCallback(
    (text: string) => {
      const hash = sha256Hex(text);
      const entry = cacheRef.current[hash];
      const sessionId = currentSessionIdRef.current;
      if (!sessionId) return;

      const pending = inFlightHashRef.current === hash || queueRef.current.some((q) => q.hash === hash);
      if (pending && !entryIsShown(entry)) {
        return;
      }
      if (entryIsShown(entry)) {
        wantedShownRef.current.set(hash, false);
        setCache((prev) => ({
          ...prev,
          [hash]: { ...(prev[hash] || { russian: '' }), shown: false },
        }));
        if (entry?.russian) {
          sendBridgeEvent('save_reply_translation', {
            sessionId,
            provider: currentProviderRef.current || 'claude',
            hash,
            russian: entry.russian,
            shown: false,
          });
        }
      } else if (entry?.russian) {
        // Cached hit -> press
        wantedShownRef.current.set(hash, true);
        setCache((prev) => ({
          ...prev,
          [hash]: { ...prev[hash], shown: true },
        }));
        sendBridgeEvent('save_reply_translation', {
          sessionId,
          provider: currentProviderRef.current || 'claude',
          hash,
          russian: entry.russian,
          shown: true,
        });
      } else {
        // Miss -> enqueue translation
        if (inFlightHashRef.current === hash || queueRef.current.some((q) => q.hash === hash)) {
          return;
        }
        wantedShownRef.current.set(hash, true);
        const { text: masked, code } = maskMarkdown(text);
        queueRef.current.push({
          hash,
          text,
          masked,
          code,
          provider: currentProviderRef.current || 'claude',
        });
        processNextQueueItem();
      }
    },
    [processNextQueueItem]
  );

  const isAllShown = useCallback((): boolean => {
    if (eligibleTexts) {
      if (eligibleTexts.length === 0) return false;
      for (const text of eligibleTexts) {
        if (!entryIsShown(cache[sha256Hex(text)])) {
          return false;
        }
      }
      return true;
    }
    const map = registeredBlocksRef.current;
    if (map.size === 0) return false;
    for (const hash of map.keys()) {
      if (!entryIsShown(cache[hash])) {
        return false;
      }
    }
    return true;
  }, [cache, registrationCount, eligibleTexts]);

  const toggleAll = useCallback(() => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return;
    const allShown = isAllShown();

    if (allShown) {
      // Drop the in-flight id so a late success does not write the cache.
      showAllPendingRef.current = false;
      generationRef.current++;
      queueRef.current = [];
      wantedShownRef.current.clear();
      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
        fallbackTimeoutRef.current = null;
      }
      inFlightHashRef.current = null;
      inFlightIdRef.current = null;
      inFlightItemRef.current = null;
      inFlightSessionRef.current = null;
      setInFlightHash(null);
      setCache((prev) => {
        const next: Record<string, ReplyTranslationEntry> = {};
        for (const [k, v] of Object.entries(prev)) {
          next[k] = { ...v, shown: false };
        }
        return next;
      });
      sendBridgeEvent('set_reply_shown_all', {
        sessionId,
        provider: currentProviderRef.current || 'claude',
        shown: false,
      });
    } else {
      showAllPendingRef.current = true;
      sendBridgeEvent('set_reply_shown_all', {
        sessionId,
        provider: currentProviderRef.current || 'claude',
        shown: true,
      });
      // Set shown: true on all existing entries
      setCache((prev) => {
        const next: Record<string, ReplyTranslationEntry> = {};
        for (const [k, v] of Object.entries(prev)) {
          next[k] = v.russian ? { ...v, shown: true } : { ...v, shown: false };
        }
        return next;
      });

      // Loaded messages include turns the list has collapsed. Mounted blocks supply elements.
      const misses: Array<{
        hash: string;
        text: string;
        getElement?: () => HTMLElement | null;
        sourceIndex: number;
      }> = [];
      const currentEntries = cacheRef.current;
      const loaded = eligibleTextsRef.current;
      const source = loaded
        ? loaded.map((text) => {
            const hash = sha256Hex(text);
            return { hash, text, getElement: registeredBlocksRef.current.get(hash)?.getElement };
          })
        : [...registeredBlocksRef.current.entries()].map(([hash, info]) => ({
            hash,
            text: info.text,
            getElement: info.getElement,
          }));
      const seen = new Set<string>();
      for (const item of source) {
        if (seen.has(item.hash)) {
          continue;
        }
        seen.add(item.hash);
        wantedShownRef.current.set(item.hash, true);
        if (!currentEntries[item.hash]?.russian) {
          misses.push({ ...item, sourceIndex: misses.length });
        }
      }

      // Viewport first. The rest stay in loaded document order when a node is missing.
      const viewportMisses: typeof misses = [];
      const otherMisses: typeof misses = [];
      const elements = new Map<string, HTMLElement | null>();

      for (const miss of misses) {
        const el = blockElement(miss.hash, miss.getElement);
        elements.set(miss.hash, el);
        if (el && intersectsMessageList(el)) {
          viewportMisses.push(miss);
        } else {
          otherMisses.push(miss);
        }
      }

      const byDocument = (a: (typeof misses)[number], b: (typeof misses)[number]) => {
        const elA = elements.get(a.hash) ?? null;
        const elB = elements.get(b.hash) ?? null;
        if (elA && elB) {
          return compareDocumentOrder(elA, elB);
        }
        return a.sourceIndex - b.sourceIndex;
      };
      viewportMisses.sort(byDocument);
      otherMisses.sort(byDocument);

      const orderedMisses = [...viewportMisses, ...otherMisses];
      const provider = currentProviderRef.current || 'claude';
      for (const miss of orderedMisses) {
        if (inFlightHashRef.current !== miss.hash && !queueRef.current.some((q) => q.hash === miss.hash)) {
          const { text: masked, code } = maskMarkdown(miss.text);
          queueRef.current.push({ hash: miss.hash, text: miss.text, masked, code, provider });
        }
      }
      processNextQueueItem();
    }
  }, [isAllShown, processNextQueueItem, eligibleTexts]);

  const value = useMemo<ReplyTranslationContextValue>(
    () => ({
      enabled,
      cache,
      inFlightHash,
      isBlockShown,
      isBlockLoading,
      getDisplayText,
      toggleBlock,
      toggleAll,
      isAllShown,
      registerBlock,
    }),
    [
      enabled,
      cache,
      inFlightHash,
      isBlockShown,
      isBlockLoading,
      getDisplayText,
      toggleBlock,
      toggleAll,
      isAllShown,
      registerBlock,
      registrationCount,
    ]
  );

  return <ReplyTranslationContext.Provider value={value}>{children}</ReplyTranslationContext.Provider>;
}

export function useReplyTranslation(): ReplyTranslationContextValue {
  return useContext(ReplyTranslationContext);
}
