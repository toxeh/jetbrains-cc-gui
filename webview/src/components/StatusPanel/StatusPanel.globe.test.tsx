import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import StatusPanel from './StatusPanel';
import { TextBlock } from '../MessageItem/blocks/TextBlock';
import { ReplyTranslationProvider } from '../../contexts/ReplyTranslationContext';
import { setLocalTranslateStatus } from '../ChatInputBox/utils/localTranslateStatus';
import { sendBridgeEvent } from '../../utils/bridge';
import { sha256Hex } from '../ChatInputBox/utils/localTranslate';

vi.mock('../MarkdownBlock', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-block">{content}</div>,
}));

vi.mock('../../utils/bridge', () => ({
  undoFileChanges: vi.fn(),
  sendBridgeEvent: vi.fn(),
  openFile: vi.fn(),
  showEditableDiff: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('StatusPanel globe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the session globe when localTranslate is disabled', () => {
    setLocalTranslateStatus({ enabled: false, reachable: false, shortcut: 'cmdEnter' });

    render(
      <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
        <StatusPanel
          todos={[]}
          fileChanges={[]}
          subagents={[]}
          currentProvider="claude"
          currentSessionId="sess-1"
        />
      </ReplyTranslationProvider>
    );

    expect(screen.queryByRole('button', { name: /localTranslate.replyAll/ })).toBeNull();
  });

  it('renders session globe as last child of status-panel-tabs when enabled', () => {
    setLocalTranslateStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });

    render(
      <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
        <StatusPanel
          todos={[]}
          fileChanges={[]}
          subagents={[]}
          currentProvider="claude"
          currentSessionId="sess-1"
        />
      </ReplyTranslationProvider>
    );

    const globeBtn = screen.getByRole('button', { name: 'localTranslate.replyAllShow' });
    expect(globeBtn).toBeDefined();
    expect(globeBtn.getAttribute('aria-pressed')).toBe('false');
    expect(globeBtn.className).toContain('status-panel-globe-btn');

    // Verify it is the last child of .status-panel-tabs
    const tabsContainer = document.querySelector('.status-panel-tabs');
    expect(tabsContainer).toBeDefined();
    expect(tabsContainer?.lastElementChild).toBe(globeBtn);
  });

  it('clicking unpressed session globe calls set_reply_shown_all with shown: true', () => {
    setLocalTranslateStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });

    render(
      <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
        <StatusPanel
          todos={[]}
          fileChanges={[]}
          subagents={[]}
          currentProvider="claude"
          currentSessionId="sess-1"
        />
      </ReplyTranslationProvider>
    );

    const globeBtn = screen.getByRole('button', { name: 'localTranslate.replyAllShow' });

    act(() => {
      fireEvent.click(globeBtn);
    });

    expect(sendBridgeEvent).toHaveBeenCalledWith('set_reply_shown_all', {
      sessionId: 'sess-1',
      provider: 'claude',
      shown: true,
    });
  });

  it('enqueues a mounted assistant text block when the session globe is pressed', () => {
    setLocalTranslateStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    const text = 'Mounted assistant prose for the session globe';

    render(
      <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
        <div className="messages-container">
          <TextBlock
            block={{ type: 'text', text }}
            messageType="assistant"
            isStreaming={false}
          />
        </div>
        <StatusPanel
          todos={[]}
          fileChanges={[]}
          subagents={[]}
          currentProvider="claude"
          currentSessionId="sess-1"
        />
      </ReplyTranslationProvider>
    );

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'localTranslate.replyAllShow' }));
    });

    expect(sendBridgeEvent).toHaveBeenCalledWith('translate_reply', expect.objectContaining({
      sessionId: 'sess-1',
      hash: sha256Hex(text),
    }));
  });
});
