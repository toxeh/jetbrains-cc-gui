import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseCapacityPayload,
  type GrokPlanUsageSnapshot,
} from '../utils/grokBillingPace';

export type ClaudePlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: GrokPlanUsageSnapshot | null;
};

const EMPTY: ClaudePlanUsageState = { status: 'idle', snapshot: null };

/**
 * Claude plan usage for ContextBar via Java bridge
 * ({@code get_claude_plan_usage} → local-agent /capacity).
 * Claude plan-usage for ContextBar (ANTHROPIC_BASE_URL /capacity).
 */
export function useClaudePlanUsage(currentProvider: string) {
  const [state, setState] = useState<ClaudePlanUsageState>(EMPTY);
  const genRef = useRef(0);
  const handlerRef = useRef<((json: string) => void) | null>(null);

  const refresh = useCallback(() => {
    if (currentProvider !== 'claude') {
      setState(EMPTY);
      return;
    }
    const gen = ++genRef.current;
    setState((prev) => ({
      status: prev.snapshot?.present ? 'ready' : 'loading',
      snapshot: prev.snapshot,
    }));

    const w = window as unknown as {
      updateClaudePlanUsage?: (json: string) => void;
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
          setState({ status: 'unavailable', snapshot: snap });
        }
      } catch {
        setState({
          status: 'unavailable',
          snapshot: { present: false, message: 'Usage unavailable' },
        });
      }
    };

    handlerRef.current = handler;
    w.updateClaudePlanUsage = (json: string) => {
      if (handlerRef.current) {
        handlerRef.current(json);
      }
    };

    try {
      w.sendToJava?.('get_claude_plan_usage:');
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
    if (currentProvider !== 'claude') {
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

export type UseClaudePlanUsageReturn = ReturnType<typeof useClaudePlanUsage>;
