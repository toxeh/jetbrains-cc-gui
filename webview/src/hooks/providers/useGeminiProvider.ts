import { useState } from 'react';
import { DEFAULT_GEMINI_MODEL_ID } from '../../components/ChatInputBox/types';
import type { PermissionMode } from '../../components/ChatInputBox/types';

/**
 * Gemini / Antigravity CLI selectable state.
 * Cross-provider handlers live in useModelProviderState.
 */
export function useGeminiProvider() {
  const [selectedGeminiModel, setSelectedGeminiModel] = useState(DEFAULT_GEMINI_MODEL_ID);
  const [geminiPermissionMode, setGeminiPermissionMode] = useState<PermissionMode>('default');

  return {
    selectedGeminiModel,
    setSelectedGeminiModel,
    geminiPermissionMode,
    setGeminiPermissionMode,
  };
}

export type UseGeminiProviderReturn = ReturnType<typeof useGeminiProvider>;
