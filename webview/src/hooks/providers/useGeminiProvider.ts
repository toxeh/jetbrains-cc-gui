import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_MODELS,
  composeGeminiAgyModelId,
  splitGeminiAgyModelId,
  toGeminiFamilyId,
  type GeminiModelFamily,
  type ModelInfo,
  type PermissionMode,
  type ReasoningEffort,
} from '../../components/ChatInputBox/types';
import { sendBridgeEvent } from '../../utils/bridge';

/**
 * Gemini / Antigravity CLI selectable state + live model catalog from `agy models`.
 */
export function useGeminiProvider() {
  const [selectedGeminiModel, setSelectedGeminiModel] = useState(DEFAULT_GEMINI_MODEL_ID);
  const [geminiPermissionMode, setGeminiPermissionMode] = useState<PermissionMode>('default');
  const [geminiFamilies, setGeminiFamilies] = useState<GeminiModelFamily[]>([]);
  const [geminiModels, setGeminiModels] = useState<ModelInfo[]>(GEMINI_MODELS);
  const [geminiCatalogLoaded, setGeminiCatalogLoaded] = useState(false);

  const applyGeminiCatalog = useCallback((payload: {
    success?: boolean;
    families?: GeminiModelFamily[];
    models?: Array<{ id: string; label: string }>;
  }) => {
    if (!payload || payload.success === false) {
      return;
    }
    const families = Array.isArray(payload.families) ? payload.families : [];
    if (families.length > 0) {
      setGeminiFamilies(families);
      setGeminiModels(
        families.map((f) => ({
          id: f.id,
          label: f.label,
          description: f.description || '',
        })),
      );
      setGeminiCatalogLoaded(true);

      setSelectedGeminiModel((prev) => {
        const familyId = toGeminiFamilyId(prev);
        if (families.some((f) => f.id === familyId)) {
          return familyId;
        }
        if (families.some((f) => f.id === prev)) {
          return prev;
        }
        const preferred =
          families.find((f) => f.id === DEFAULT_GEMINI_MODEL_ID)
          || families[0];
        return preferred?.id || prev;
      });
      return;
    }

    const flat = Array.isArray(payload.models) ? payload.models : [];
    if (flat.length === 0) return;
    const byBase = new Map<string, ModelInfo>();
    for (const m of flat) {
      if (!m?.id) continue;
      const { baseId } = splitGeminiAgyModelId(m.id);
      const id = baseId || m.id;
      if (!byBase.has(id)) {
        byBase.set(id, {
          id,
          label: m.label || id,
          description: '',
        });
      }
    }
    const models = [...byBase.values()];
    if (models.length > 0) {
      setGeminiModels(models);
      setGeminiCatalogLoaded(true);
    }
  }, []);

  const fetchGeminiModels = useCallback(() => {
    sendBridgeEvent('get_gemini_models', '');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prev = window.updateGeminiModels;
    window.updateGeminiModels = (json: string) => {
      try {
        const payload = typeof json === 'string' ? JSON.parse(json) : json;
        applyGeminiCatalog(payload || {});
      } catch (e) {
        console.warn('[useGeminiProvider] Failed to parse gemini models', e);
      }
      if (typeof prev === 'function' && prev !== window.updateGeminiModels) {
        try {
          prev(json);
        } catch {
          // ignore
        }
      }
    };
    return () => {
      if (window.updateGeminiModels) {
        delete window.updateGeminiModels;
      }
      if (typeof prev === 'function') {
        window.updateGeminiModels = prev;
      }
    };
  }, [applyGeminiCatalog]);

  const resolveGeminiAgyModelId = useCallback(
    (familyId: string, effort: string): string => {
      const fam = geminiFamilies.find((f) => f.id === familyId);
      if (fam) {
        const match = fam.efforts.find((e) => e.id === (effort || ''))
          || fam.efforts.find((e) => e.id === fam.defaultEffort)
          || fam.efforts[0];
        if (match?.modelId) return match.modelId;
        return fam.defaultModelId || composeGeminiAgyModelId(familyId, effort);
      }
      return composeGeminiAgyModelId(familyId, effort);
    },
    [geminiFamilies],
  );

  const resolveDefaultEffortForFamily = useCallback(
    (familyId: string): ReasoningEffort => {
      const fam = geminiFamilies.find((f) => f.id === familyId);
      if (fam?.defaultEffort) {
        return fam.defaultEffort as ReasoningEffort;
      }
      return 'medium';
    },
    [geminiFamilies],
  );

  return {
    selectedGeminiModel,
    setSelectedGeminiModel,
    geminiPermissionMode,
    setGeminiPermissionMode,
    geminiFamilies,
    geminiModels,
    geminiCatalogLoaded,
    fetchGeminiModels,
    resolveGeminiAgyModelId,
    resolveDefaultEffortForFamily,
    applyGeminiCatalog,
  };
}

export type UseGeminiProviderReturn = ReturnType<typeof useGeminiProvider>;
