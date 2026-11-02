import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BashToolBlock from './BashToolBlock';
import BashToolGroupBlock from './BashToolGroupBlock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../hooks/useIsToolDenied', () => ({
  useIsToolDenied: () => false,
}));

describe('BashToolBlock', () => {
  it('keeps command summaries and approval reasons in expanded batch entries', () => {
    const { container } = render(<BashToolGroupBlock items={[
      { toolId: 'one', input: { cmd: 'pwd', summary: 'Inspect workspace', justification: 'Read protected directory' } },
      { toolId: 'two', input: { command: 'git status', title: 'Check pending changes' } },
    ]} />);
    const rows = container.querySelectorAll('.bash-group-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.bash-group-row-desc')?.textContent).toBe('Inspect workspace');
    expect(rows[1].querySelector('.bash-group-row-desc')?.textContent).toBe('Check pending changes');
    fireEvent.click(rows[0].querySelector('.bash-group-row-toggle')!);
    expect(container.querySelector('.bash-group-detail-reason')?.textContent).toContain('Read protected directory');
  });
  it('hides empty placeholders until command details arrive', () => {
    const { container, rerender } = render(<BashToolBlock input={{}} />);

    expect(container.firstChild).toBeNull();

    rerender(<BashToolBlock input={{ command: 'npm test' }} />);
    expect(container.querySelector('.bash-tool-header')).not.toBeNull();

    rerender(<BashToolBlock input={{ command: '  ', description: '\n' }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders command and stdout text in code-font-targeted nodes', () => {
    const { container } = render(
      <BashToolBlock
        input={{
          command: 'node --version',
        }}
        result={{
          type: 'tool_result',
          content: 'v22.0.0',
        }}
      />,
    );

    fireEvent.click(container.querySelector('.bash-tool-header') as HTMLElement);

    expect(container.querySelector('.bash-command-block')?.textContent).toBe('node --version');
    expect(container.querySelector('.bash-output-text')?.textContent).toBe('v22.0.0');
  });

  it('auto-expands and displays live [SPARC-AUTO] stage progress while streaming', () => {
    const { container } = render(
      <BashToolBlock
        input={{
          command: 'python3 -u /Users/afanasyev/.agents/skills/sparc-router.py run --phase deliver --args "SMEVDEV-25500-041"',
        }}
        result={{
          type: 'tool_result',
          is_streaming: true,
          content:
            '[SPARC-AUTO] 📦 BATCH START | phase=deliver | stories=1 (SMEVDEV-25500-041)\n' +
            '[SPARC-AUTO] ▶ STAGE START | story [1/1] STORY-SMEVDEV-25500-041 | stage=tdd | executor=claude | model=Claude Opus 4.7 (claude-opus-4-7) | attempt=#1',
        }}
      />,
    );

    expect(container.querySelector('.bash-output-text')?.textContent).toContain('STAGE START | story [1/1] STORY-SMEVDEV-25500-041');
    expect(container.querySelector('.bash-tool-header')?.textContent).toContain('STAGE START | story [1/1] STORY-SMEVDEV-25500-041');
    expect(container.querySelector('.tool-status-indicator.pending')).not.toBeNull();
  });
});
