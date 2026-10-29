import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ButtonArea } from './ButtonArea.js';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('./selectors', () => ({
  ConfigSelect: () => null,
  ModeSelect: () => null,
  ModelConfigSelect: () => null,
  ProviderSelect: () => null,
}));

vi.mock('../../hooks/providers/useCliModels', () => ({
  useCliModels: () => ({
    cliModels: [],
    cliModelsLoading: false,
    cliModelsError: null,
    cliDefaultModel: null,
    cliCatalogHasEntries: false,
    refreshCliModels: vi.fn(),
  }),
  useOmpRoles: () => [],
}));

vi.mock('./hooks/useToolbarSelectorCompact', () => ({
  useToolbarSelectorCompact: () => false,
}));

function translateButton() {
  return screen.queryByRole('button', { name: 'localTranslate.tooltip' });
}

describe('ButtonArea local translate button', () => {
  afterEach(() => cleanup());

  it('is absent when the local server is not reachable', () => {
    render(<ButtonArea hasInputContent hasTextContent translateReachable={false} onTranslate={vi.fn()} />);
    expect(translateButton()).toBeNull();
  });

  it('sits between the enhancer and the send button when reachable', () => {
    render(<ButtonArea hasInputContent hasTextContent translateReachable onTranslate={vi.fn()} />);
    const button = translateButton();
    expect(button).not.toBeNull();
    const enhancer = screen.getByRole('button', { name: 'promptEnhancer.tooltip' });
    expect(enhancer.nextElementSibling).toBe(button);
    expect(button?.nextElementSibling?.classList.contains('submit-button')).toBe(true);
    expect(button?.querySelector('.codicon-globe')).not.toBeNull();
  });

  it('translates on click and never submits', () => {
    const onTranslate = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ButtonArea hasInputContent hasTextContent translateReachable onTranslate={onTranslate} onSubmit={onSubmit} />,
    );
    fireEvent.click(translateButton()!);
    expect(onTranslate).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is disabled without text, while in flight, or when the input is disabled', () => {
    const { rerender } = render(<ButtonArea hasInputContent hasTextContent={false} translateReachable />);
    expect(translateButton()).toHaveProperty('disabled', true);
    rerender(<ButtonArea hasInputContent hasTextContent translateReachable isTranslating />);
    expect(translateButton()).toHaveProperty('disabled', true);
    rerender(<ButtonArea hasInputContent hasTextContent translateReachable translateDisabled />);
    expect(translateButton()).toHaveProperty('disabled', true);
    rerender(<ButtonArea hasInputContent hasTextContent translateReachable />);
    expect(translateButton()).toHaveProperty('disabled', false);
  });

  it('shows the active chord in the tooltip', () => {
    render(<ButtonArea hasInputContent hasTextContent translateReachable translateShortcutLabel="Shift+Enter" />);
    expect(translateButton()?.getAttribute('data-tooltip')).toBe('localTranslate.tooltip (Shift+Enter)');
  });
});
