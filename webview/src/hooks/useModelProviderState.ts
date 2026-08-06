import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../utils/bridge';
import {
  apply1MContextSuffix,
  normalizeClaudeModelId,
  strip1MContextSuffix,
} from '../components/ChatInputBox/types';
import type { PermissionMode, ReasoningEffort } from '../components/ChatInputBox/types';
import { isSpecialProviderId } from '../types/provider';
import { useClaudeProvider } from './providers/useClaudeProvider';
import { useCodexProvider } from './providers/useCodexProvider';
import { useGeminiProvider } from './providers/useGeminiProvider';
import { useGrokProvider } from './providers/useGrokProvider';
import { useKimiProvider } from './providers/useKimiProvider';
import { useOpenCodeProvider } from './providers/useOpenCodeProvider';
import { usePiProvider } from './providers/usePiProvider';
import { isCliOnlyProvider, normalizeCliPermissionMode } from './providers/cliProviders';
import { useUsageTracking } from './providers/useUsageTracking';
import { useProviderSettings } from './providers/useProviderSettings';
import { useModelStatePersistence } from './providers/useModelStatePersistence';

export type ViewMode = 'chat' | 'history' | 'settings';

export interface UseModelProviderStateOptions {
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

/**
 * Orchestrates provider/model/permission state. Composes four single-purpose
 * sub-hooks (Claude / Codex / usage tracking / provider settings) plus a
 * persistence hook, then wires the cross-slice state (currentProvider +
 * permissionMode) and the cross-provider handlers (mode/model/provider switch,
 * long-context toggle, always-thinking toggle).
 *
 * The flat return shape is preserved as the public API: callers (App,
 * ChatScreen, AppDialogs, useMessageSender) destructure individual fields.
 *
 * `currentProviderRef` is exposed for window callbacks registered with stable
 * identity that must read the current provider when fired by the JCEF bridge.
 * The ref is updated via render-time assignment (no useEffect mirror).
 */
export function useModelProviderState({ addToast, t }: UseModelProviderStateOptions) {
  // ── Cross-slice state owned by the orchestrator ──
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  // External-facing ref so window callbacks can read the latest provider
  // without re-binding. Render-time assignment avoids the useRef + useEffect
  // mirror anti-pattern (rule 5.15).
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;

  // ── Provider-specific sub-hooks ──
  const claude = useClaudeProvider();
  const codex = useCodexProvider();
  const grok = useGrokProvider();
  const kimi = useKimiProvider();
  const openCode = useOpenCodeProvider();
  const pi = usePiProvider();
  const gemini = useGeminiProvider();
  const { isSdkInstalled, isSdkStatusKnown, sdkStatus, ...usage } = useUsageTracking();
  const settings = useProviderSettings({ addToast, t });

  const {
    selectedClaudeModel, setSelectedClaudeModel,
    claudePermissionMode, setClaudePermissionMode,
    longContextEnabled, setLongContextEnabled,
    setClaudeSettingsAlwaysThinkingEnabled,
  } = claude;
  const {
    selectedCodexModel, setSelectedCodexModel,
    codexPermissionMode, setCodexPermissionMode,
    reasoningEffort, setReasoningEffort,
    codexFastMode, setCodexFastMode,
    handleReasoningChange: codexHandleReasoningChange,
    handleCodexFastModeChange,
  } = codex;
  const {
    selectedGrokModel, setSelectedGrokModel,
    grokPermissionMode, setGrokPermissionMode,
  } = grok;
  const {
    selectedKimiModel, setSelectedKimiModel,
    kimiPermissionMode, setKimiPermissionMode,
  } = kimi;
  const {
    selectedOpenCodeModel, setSelectedOpenCodeModel,
    openCodePermissionMode, setOpenCodePermissionMode,
  } = openCode;
  const {
    selectedPiModel, setSelectedPiModel,
    piPermissionMode, setPiPermissionMode,
  } = pi;

  const {
    selectedGeminiModel, setSelectedGeminiModel,
    geminiPermissionMode, setGeminiPermissionMode,
    geminiFamilies,
    geminiModels,
    geminiCatalogLoaded,
    fetchGeminiModels,
    resolveGeminiAgyModelId,
    resolveDefaultEffortForFamily,
  } = gemini;

  // Pull live agy catalog when Gemini is active (new tab / provider switch).
  useEffect(() => {
    if (currentProvider === 'gemini') {
      fetchGeminiModels();
    }
  }, [currentProvider, fetchGeminiModels]);

  // After catalog arrives, re-push full agy slug so session state is never left
  // on a bare family id that agy rejects without --effort.
  useEffect(() => {
    if (currentProvider !== 'gemini' || !geminiCatalogLoaded) {
      return;
    }
    const fullSlug = resolveGeminiAgyModelId(selectedGeminiModel, reasoningEffort);
    if (fullSlug) {
      sendBridgeEvent('set_model', fullSlug);
    }
  }, [
    currentProvider,
    geminiCatalogLoaded,
    reasoningEffort,
    resolveGeminiAgyModelId,
    selectedGeminiModel,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const prev = window.onTabActivated;
    window.onTabActivated = () => {
      if (currentProviderRef.current === 'gemini') {
        fetchGeminiModels();
      }
      if (typeof prev === 'function') {
        try {
          prev();
        } catch {
          // ignore
        }
      }
    };
    return () => {
      window.onTabActivated = prev;
    };
  }, [fetchGeminiModels]);

  const grok = useGrokProvider();
  const {
    selectedGrokModel, setSelectedGrokModel,
    grokPermissionMode, setGrokPermissionMode,
  } = grok;

  const gemini = useGeminiProvider();
  const {
    selectedGeminiModel, setSelectedGeminiModel,
    geminiPermissionMode, setGeminiPermissionMode,
  } = gemini;

  // ── Persistence: load on mount + save on change ──
  useModelStatePersistence({
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGeminiModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setGeminiPermissionMode,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    selectedGeminiModel,
    claudePermissionMode,
    codexPermissionMode,
    geminiPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedOpenCodeModel,
    selectedPiModel,
    grokPermissionMode,
    kimiPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
  });

  // ── Computed values ──
  const selectedModel = currentProvider === 'codex'
    ? selectedCodexModel
    : currentProvider === 'gemini'
      ? selectedGeminiModel
      : currentProvider === 'grok'
        ? selectedGrokModel
        : currentProvider === 'kimi'
          ? selectedKimiModel
          : currentProvider === 'opencode'
            ? selectedOpenCodeModel
            : currentProvider === 'pi'
              ? selectedPiModel
              : selectedClaudeModel;
  const currentSdkInstalled = useMemo(
    () => isSdkInstalled(currentProvider),
    [isSdkInstalled, currentProvider],
  );
  const currentSdkStatusError = useMemo(
    () => usage.sdkStatusError !== null && !isSdkStatusKnown(currentProvider)
      ? usage.sdkStatusError
      : null,
    [currentProvider, isSdkStatusKnown, usage.sdkStatusError],
  );
  // Whether the installed Claude SDK meets the minimum version required for the
  // selected model's tier (Fable needs >= 0.3.182). `undefined` means the backend
  // hasn't reported it (SDK not installed, or an old plugin version without the
  // field) — callers must only warn on an explicit `false` to avoid false positives.
  const claudeSdkMeetsMinimum = sdkStatus?.['claude-sdk']?.meetsMinimumVersion;

  // ── Cross-provider handlers ──
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    if (currentProvider === 'codex') {
      const codexMode: PermissionMode = mode === 'plan' ? 'default' : mode;
      setPermissionMode(codexMode);
      setCodexPermissionMode(codexMode);
      sendBridgeEvent('set_mode', codexMode);
      return;
    }
    if (currentProvider === 'gemini') {
      setPermissionMode(mode);
      setGeminiPermissionMode(mode);
      sendBridgeEvent('set_mode', mode);
      return;
    }
    if (isCliOnlyProvider(currentProvider)) {
      const cliMode = normalizeCliPermissionMode(mode);
      setPermissionMode(cliMode);
      if (currentProvider === 'grok') setGrokPermissionMode(cliMode);
      if (currentProvider === 'kimi') setKimiPermissionMode(cliMode);
      if (currentProvider === 'opencode') setOpenCodePermissionMode(cliMode);
      if (currentProvider === 'pi') setPiPermissionMode(cliMode);
      sendBridgeEvent('set_mode', cliMode);
      return;
    }
    setPermissionMode(mode);
    setClaudePermissionMode(mode);
    sendBridgeEvent('set_mode', mode);
  }, [
    currentProvider,
    setCodexPermissionMode,
    setClaudePermissionMode,
    setGeminiPermissionMode,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
  ]);

  const handleModelSelect = useCallback((modelId: string) => {
    if (currentProvider === 'claude') {
      const strippedModelId = strip1MContextSuffix(modelId);
      const normalizedModelId = normalizeClaudeModelId(strippedModelId);
      setSelectedClaudeModel(normalizedModelId);
      sendBridgeEvent('set_model', apply1MContextSuffix(normalizedModelId, longContextEnabled));
    } else if (currentProvider === 'codex') {
      setSelectedCodexModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'gemini') {
      setSelectedGeminiModel(modelId);
      const effort = resolveDefaultEffortForFamily(modelId);
      setReasoningEffort(effort);
      sendBridgeEvent('set_reasoning_effort', effort);
      const fullSlug = resolveGeminiAgyModelId(modelId, effort);
      sendBridgeEvent('set_model', fullSlug);
    } else if (currentProvider === 'grok') {
      setSelectedGrokModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'kimi') {
      setSelectedKimiModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'opencode') {
      setSelectedOpenCodeModel(modelId);
      sendBridgeEvent('set_model', modelId);
    } else if (currentProvider === 'pi') {
      setSelectedPiModel(modelId);
      sendBridgeEvent('set_model', modelId);
    }
  }, [
    currentProvider,
    longContextEnabled,
    resolveDefaultEffortForFamily,
    resolveGeminiAgyModelId,
    setReasoningEffort,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setSelectedGeminiModel,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
  ]);

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    if (currentProvider === 'gemini') {
      setReasoningEffort(effort);
      sendBridgeEvent('set_reasoning_effort', effort);
      const fullSlug = resolveGeminiAgyModelId(selectedGeminiModel, effort);
      sendBridgeEvent('set_model', fullSlug);
      return;
    }
    codexHandleReasoningChange(effort);
  }, [
    codexHandleReasoningChange,
    currentProvider,
    resolveGeminiAgyModelId,
    selectedGeminiModel,
    setReasoningEffort,
  ]);

    const handleProviderSelect = useCallback((providerId: string) => {
    setCurrentProvider(providerId);
    sendBridgeEvent('set_provider', providerId);

    let modeToSet: PermissionMode = claudePermissionMode;
    if (providerId === 'codex') {
      modeToSet = normalizeCliPermissionMode(codexPermissionMode);
    } else if (providerId === 'gemini') {
      modeToSet = geminiPermissionMode;
      fetchGeminiModels();
    } else if (providerId === 'grok') {
      modeToSet = normalizeCliPermissionMode(grokPermissionMode);
    } else if (providerId === 'kimi') {
      modeToSet = normalizeCliPermissionMode(kimiPermissionMode);
    } else if (providerId === 'opencode') {
      modeToSet = normalizeCliPermissionMode(openCodePermissionMode);
    } else if (providerId === 'pi') {
      modeToSet = normalizeCliPermissionMode(piPermissionMode);
    }
    setPermissionMode(modeToSet);
    sendBridgeEvent('set_mode', modeToSet);

    let newModel = apply1MContextSuffix(selectedClaudeModel, longContextEnabled);
    if (providerId === 'codex') newModel = selectedCodexModel;
    else if (providerId === 'gemini') newModel = resolveGeminiAgyModelId(selectedGeminiModel, reasoningEffort);
    else if (providerId === 'grok') newModel = selectedGrokModel;
    else if (providerId === 'kimi') newModel = selectedKimiModel;
    else if (providerId === 'opencode') newModel = selectedOpenCodeModel;
    else if (providerId === 'pi') newModel = selectedPiModel;
    sendBridgeEvent('set_model', newModel);
  }, [
    claudePermissionMode,
    codexPermissionMode,
    fetchGeminiModels,
    geminiPermissionMode,
    grokPermissionMode,
    kimiPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    longContextEnabled,
    reasoningEffort,
    resolveGeminiAgyModelId,
    selectedCodexModel,
    selectedClaudeModel,
    selectedGeminiModel,
    selectedGrokModel,
    selectedKimiModel,
    selectedOpenCodeModel,
    selectedPiModel,
  ]);

  const handleLongContextChange = useCallback((enabled: boolean) => {
    setLongContextEnabled(enabled);
    if (currentProvider === 'claude') {
      sendBridgeEvent('set_model', apply1MContextSuffix(selectedClaudeModel, enabled));
    }
    // Grok and Codex do not use the 1M suffix toggle for now
  }, [currentProvider, selectedClaudeModel, setLongContextEnabled]);

  const handleToggleThinking = useCallback((enabled: boolean) => {
    const config = settings.activeProviderConfig;
    const isSpecialProvider = isSpecialProviderId(config?.id || '');

    setClaudeSettingsAlwaysThinkingEnabled(enabled);

    if (!config || isSpecialProvider) {
      settings.setActiveProviderConfig(prev => prev ? {
        ...prev,
        settingsConfig: {
          ...prev.settingsConfig,
          alwaysThinkingEnabled: enabled,
        },
      } : prev);
      sendBridgeEvent('set_thinking_enabled', JSON.stringify({ enabled }));
      addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
      return;
    }

    settings.setActiveProviderConfig(prev => prev ? {
      ...prev,
      settingsConfig: {
        ...prev.settingsConfig,
        alwaysThinkingEnabled: enabled,
      },
    } : null);

    sendBridgeEvent('update_provider', JSON.stringify({
      id: config.id,
      updates: {
        settingsConfig: {
          ...(config.settingsConfig || {}),
          alwaysThinkingEnabled: enabled,
        },
      },
    }));
    addToast(enabled ? t('toast.thinkingEnabled') : t('toast.thinkingDisabled'), 'success');
  }, [settings, setClaudeSettingsAlwaysThinkingEnabled, addToast, t]);

  return {
    ...claude,
    ...codex,
    ...gemini,
    ...grok,
    ...kimi,
    ...openCode,
    ...pi,
    ...usage,
    ...settings,
    sdkStatus,
    sdkStatusError: currentSdkStatusError,
    currentProvider, setCurrentProvider,
    permissionMode, setPermissionMode,
    selectedModel,
    geminiFamilies,
    geminiModels,
    geminiCatalogLoaded,
    currentSdkInstalled,
    claudeSdkMeetsMinimum,
    currentProviderRef,
    handleModeSelect,
    handleModelSelect,
    handleProviderSelect,
    handleReasoningChange,
    handleCodexFastModeChange,
    handleLongContextChange,
    handleToggleThinking,
    fetchGeminiModels,
    resolveGeminiAgyModelId,
  };
}
