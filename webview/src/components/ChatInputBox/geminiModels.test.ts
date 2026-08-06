import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_PROVIDERS,
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_MODELS,
} from './types';

describe('Gemini provider catalog', () => {
  it('enables gemini in AVAILABLE_PROVIDERS', () => {
    const gemini = AVAILABLE_PROVIDERS.find((p) => p.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini?.enabled).toBe(true);
  });

  it('lists default model and agy catalog slugs', () => {
    expect(DEFAULT_GEMINI_MODEL_ID).toBe('gemini-3.5-flash-medium');
    const ids = GEMINI_MODELS.map((m) => m.id);
    expect(ids).toContain(DEFAULT_GEMINI_MODEL_ID);
    expect(ids).toContain('gemini-3.6-flash-high');
    expect(ids).toContain('gemini-3.1-pro-high');
    expect(GEMINI_MODELS.every((m) => m.label && m.id)).toBe(true);
  });
});
