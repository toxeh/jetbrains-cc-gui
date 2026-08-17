import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseCapacityPayload,
  type GeminiPlanUsageSnapshot,
} from '../utils/geminiBillingPace';

export type GeminiPlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: GeminiPlanUsageSnapshot | null;
};

const EMPTY: GeminiPlanUsageState = { status: 'idle', snapshot: null };

/**
 * Gemini / Antigravity plan usage for ContextBar via Java bridge
 * ({@code get_gemini_plan_usage} → one-shot `agy -p "/usage"` probe, no token parsing).
 * Same snapshot shape as Gemini/Claude so GeminiPlanUsageIndicator can render it.
 */
export function useGeminiPlanUsage(currentProvider: string) {
  const [state, setState] = useState<GeminiPlanUsageState>(EMPTY);
  const genRef = useRef(0);
  const handlerRef = useRef<((json: string) => void) | null>(null);

  const refresh = useCallback(() => {
    if (currentProvider !== 'gemini') {
      setState(EMPTY);
      return;
    }
    const gen = ++genRef.current;
    setState((prev) => ({
      status: prev.snapshot?.present ? 'ready' : 'loading',
      snapshot: prev.snapshot,
    }));

    const w = window as unknown as {
      updateGeminiPlanUsage?: (json: string) => void;
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
    w.updateGeminiPlanUsage = (json: string) => {
      if (handlerRef.current) {
        handlerRef.current(json);
      }
    };

    try {
      w.sendToJava?.('get_gemini_plan_usage:');
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
    if (currentProvider !== 'gemini') {
      return () => {
        genRef.current += 1;
      };
    }
    // agy /usage probe spawn is heavier than HTTP capacity — poll less often
    const id = window.setInterval(() => {
      void refresh();
    }, 120_000);
    return () => {
      window.clearInterval(id);
      genRef.current += 1;
    };
  }, [currentProvider, refresh]);

  return { ...state, refresh };
}

export type UseGeminiPlanUsageReturn = ReturnType<typeof useGeminiPlanUsage>;
