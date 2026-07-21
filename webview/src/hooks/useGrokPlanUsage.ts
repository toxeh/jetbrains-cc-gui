import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseCapacityPayload,
  type GrokPlanUsageSnapshot,
} from '../utils/grokBillingPace';

export type GrokPlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: GrokPlanUsageSnapshot | null;
};

const EMPTY: GrokPlanUsageState = { status: 'idle', snapshot: null };

/**
 * Dual-source Grok plan usage for ContextBar via Java bridge
 * ({@code get_grok_plan_usage} → local-agent /capacity, else CLI /usage).
 * Does not hijack Settings {@code updateUsageStatistics} / auth handlers.
 */
export function useGrokPlanUsage(currentProvider: string) {
  const [state, setState] = useState<GrokPlanUsageState>(EMPTY);
  const genRef = useRef(0);
  const handlerRef = useRef<((json: string) => void) | null>(null);

  const refresh = useCallback(() => {
    if (currentProvider !== 'grok') {
      setState(EMPTY);
      return;
    }
    const gen = ++genRef.current;
    setState((prev) => ({
      status: prev.snapshot?.present ? 'ready' : 'loading',
      snapshot: prev.snapshot,
    }));

    const w = window as unknown as {
      updateGrokPlanUsage?: (json: string) => void;
      sendToJava?: (cmd: string) => void;
    };

    const handler = (jsonStr: string) => {
      if (gen !== genRef.current) return;
      try {
        const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        const snap = parseCapacityPayload(data);
        if (snap.present) {
          setState({ status: 'ready', snapshot: snap });
        } else {
          setState({
            status: 'unavailable',
            snapshot: snap,
          });
        }
      } catch {
        setState({
          status: 'unavailable',
          snapshot: { present: false, message: 'Usage unavailable' },
        });
      }
    };

    handlerRef.current = handler;
    w.updateGrokPlanUsage = (json: string) => {
      // Only the latest refresh generation should apply; keep the callback installed
      // for subsequent polls (no temporary hijack of other features).
      if (handlerRef.current) {
        handlerRef.current(json);
      }
    };

    try {
      w.sendToJava?.('get_grok_plan_usage:');
    } catch {
      if (gen === genRef.current) {
        setState({
          status: 'unavailable',
          snapshot: { present: false, message: 'Usage unavailable' },
        });
      }
    }
  }, [currentProvider]);

  useEffect(() => {
    void refresh();
    if (currentProvider !== 'grok') {
      return () => {
        genRef.current += 1;
      };
    }
    const id = window.setInterval(() => {
      void refresh();
    }, 60_000);
    return () => {
      window.clearInterval(id);
      genRef.current += 1;
    };
  }, [currentProvider, refresh]);

  return { ...state, refresh };
}

export type UseGrokPlanUsageReturn = ReturnType<typeof useGrokPlanUsage>;
