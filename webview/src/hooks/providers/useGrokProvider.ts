import { useState } from 'react';
import { GROK_MODELS } from '../../components/ChatInputBox/types';
import type { PermissionMode } from '../../components/ChatInputBox/types';

/**
 * Grok (xAI) provider-specific selectable state.
 *
 * For the initial integration (headless CLI via grok-channel.js):
 * - Only model selection is exposed.
 * - Permission mode is forced to 'default' (Grok channel currently doesn't use the Claude-style permission modes).
 * - Reasoning / fast-mode can be added later when the Grok agent protocol surfaces them.
 *
 * The handler simply forwards set_model to the Java bridge (SessionSendService will see currentProvider === 'grok').
 */
export function useGrokProvider() {
  const [selectedGrokModel, setSelectedGrokModel] = useState(GROK_MODELS[0].id);
  const [grokPermissionMode, setGrokPermissionMode] = useState<PermissionMode>('default');

  // Grok currently has no dedicated reasoning/fastspeed UI in v1.
  // We keep the setters for symmetry in the orchestrator and persistence.

  return {
    selectedGrokModel,
    setSelectedGrokModel,
    grokPermissionMode,
    setGrokPermissionMode,
  };
}

export type UseGrokProviderReturn = ReturnType<typeof useGrokProvider>;
