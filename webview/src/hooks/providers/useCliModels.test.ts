import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCliModels } from './useCliModels';
import { KIMI_MODELS } from '../../components/ChatInputBox/types';
import { installRuntimeProviderDispatchers } from '../../utils/runtimeProviderCapabilities';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

function emitCliModels(payload: unknown) {
  act(() => {
    window.setCliModels?.(JSON.stringify(payload));
  });
}

describe('useCliModels', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
    installRuntimeProviderDispatchers();
  });

  afterEach(() => {
    delete window.setCliModels;
    vi.useRealTimers();
  });

  it('fetches the kimi catalog when the kimi provider is active', () => {
    renderHook(() => useCliModels('kimi'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'kimi');
  });

  it('fetches the grok catalog when the grok provider is active', () => {
    renderHook(() => useCliModels('grok'));
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'grok');
  });

  it('does not fetch for claude', () => {
    renderHook(() => useCliModels('claude'));
    expect(sendBridgeEventMock).not.toHaveBeenCalled();
  });

  it('falls back to the static KIMI_MODELS list before the catalog arrives', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    expect(result.current.cliModels).toEqual(KIMI_MODELS);
    expect(result.current.cliModelsLoading).toBe(true);
  });

  it('stores the kimi catalog and defaultModel from the backend payload', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    emitCliModels({
      success: true,
      provider: 'kimi',
      defaultModel: 'kimi-k3',
      models: [{ id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' }],
    });
    expect(result.current.cliModels).toEqual([
      { id: 'kimi-k3', label: 'kimi-k3', description: 'kimi-k3' },
    ]);
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBeNull();
  });

  it('falls back to KIMI_MODELS when the kimi payload has no models', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    emitCliModels({
      success: true,
      provider: 'kimi',
      models: [],
    });
    expect(result.current.cliModels).toEqual(KIMI_MODELS);
  });

  it('records backend errors and supports manual retry for kimi', () => {
    const { result } = renderHook(() => useCliModels('kimi'));
    emitCliModels({ success: false, provider: 'kimi', error: 'node missing', models: [] });
    expect(result.current.cliModelsError).toBe('node missing');
    expect(result.current.cliModels).toEqual(KIMI_MODELS);

    sendBridgeEventMock.mockClear();
    act(() => {
      result.current.refreshCliModels('kimi');
    });
    expect(sendBridgeEventMock).toHaveBeenCalledWith('get_cli_models', 'kimi');
  });

  it('times out into an error state and falls back to static models', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCliModels('kimi'));
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(result.current.cliModelsLoading).toBe(false);
    expect(result.current.cliModelsError).toBe('timeout');
    expect(result.current.cliModels).toEqual(KIMI_MODELS);
  });
});
