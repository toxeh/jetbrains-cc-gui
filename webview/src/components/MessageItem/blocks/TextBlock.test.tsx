import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TextBlock } from './TextBlock';
import { ReplyTranslationProvider } from '../../../contexts/ReplyTranslationContext';
import { setLocalTranslateStatus } from '../../ChatInputBox/utils/localTranslateStatus';
import { sha256Hex } from '../../ChatInputBox/utils/localTranslate';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('../../MarkdownBlock', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-block">{content}</div>,
}));

vi.mock('../../CollapsibleTextBlock', () => ({
  default: ({ content }: { content: string }) => <div data-testid="collapsible-text-block">{content}</div>,
}));

describe('TextBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLocalTranslateStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
  });

  it('renders CollapsibleTextBlock without globes for user messages', () => {
    render(
      <ReplyTranslationProvider currentSessionId="sess" currentProvider="claude">
        <TextBlock
          block={{ type: 'text', text: 'User question here' }}
          messageType="user"
          isStreaming={false}
        />
      </ReplyTranslationProvider>
    );

    expect(screen.getByTestId('collapsible-text-block')).toBeDefined();
    expect(screen.queryByRole('button', { name: /localTranslate.reply/ })).toBeNull();
  });

  it('shows globes after a later enabled publish', () => {
    setLocalTranslateStatus({ enabled: false, reachable: false, shortcut: 'cmdEnter' });
    render(
      <ReplyTranslationProvider currentSessionId="sess" currentProvider="claude">
        <TextBlock
          block={{ type: 'text', text: 'Finished assistant prose' }}
          messageType="assistant"
          isStreaming={false}
        />
      </ReplyTranslationProvider>
    );

    expect(screen.queryByRole('button', { name: /localTranslate.reply/ })).toBeNull();

    act(() => {
      setLocalTranslateStatus({ enabled: true, reachable: true, shortcut: 'cmdEnter' });
    });

    expect(screen.getAllByRole('button', { name: 'localTranslate.replyShow' })).toHaveLength(2);
  });

  it('renders MarkdownBlock without globes when block is streaming tail', () => {
    render(
      <ReplyTranslationProvider currentSessionId="sess" currentProvider="claude">
        <TextBlock
          block={{ type: 'text', text: 'Streaming assistant answer' }}
          messageType="assistant"
          isStreaming={true}
        />
      </ReplyTranslationProvider>
    );

    expect(screen.getByTestId('markdown-block').textContent).toBe('Streaming assistant answer');
    expect(screen.queryByRole('button', { name: /localTranslate.reply/ })).toBeNull();
  });

  it('renders MarkdownBlock without globes when text is code-only or mostly Cyrillic', () => {
    // Code only
    const { unmount } = render(
      <ReplyTranslationProvider currentSessionId="sess" currentProvider="claude">
        <TextBlock
          block={{ type: 'text', text: '```js\nconsole.log(1);\n```' }}
          messageType="assistant"
          isStreaming={false}
        />
      </ReplyTranslationProvider>
    );
    expect(screen.queryByRole('button', { name: /localTranslate.reply/ })).toBeNull();
    unmount();

    // Mostly Cyrillic
    render(
      <ReplyTranslationProvider currentSessionId="sess" currentProvider="claude">
        <TextBlock
          block={{ type: 'text', text: 'Привет, как твои дела сегодня?' }}
          messageType="assistant"
          isStreaming={false}
        />
      </ReplyTranslationProvider>
    );
    expect(screen.queryByRole('button', { name: /localTranslate.reply/ })).toBeNull();
  });

  it('renders MarkdownBlock without globes when localTranslate is disabled', () => {
    setLocalTranslateStatus({ enabled: false, reachable: false, shortcut: 'cmdEnter' });

    render(
      <ReplyTranslationProvider currentSessionId="sess" currentProvider="claude">
        <TextBlock
          block={{ type: 'text', text: 'Eligible English assistant prose.' }}
          messageType="assistant"
          isStreaming={false}
        />
      </ReplyTranslationProvider>
    );

    expect(screen.queryByRole('button', { name: /localTranslate.reply/ })).toBeNull();
  });

  it('renders twin globes for the reported English answer when the server is unreachable', () => {
    const sentence = 'Per persistent project facts, changes remain uncommitted on branch gemini-agy-provider-0.6.0.1 and will not be pushed or committed unless you request it. Let me know if you would like me to commit these changes!';
    setLocalTranslateStatus({ enabled: true, reachable: false, shortcut: 'cmdEnter' });
    const { unmount } = render(
      <ReplyTranslationProvider currentSessionId="sess" currentProvider="gemini">
        <TextBlock
          block={{ type: 'text', text: sentence }}
          messageType="assistant"
          isStreaming={false}
        />
      </ReplyTranslationProvider>
    );
    expect(screen.getAllByRole('button', { name: 'localTranslate.replyShow' })).toHaveLength(2);
    unmount();

    setLocalTranslateStatus({ enabled: false, reachable: false, shortcut: 'cmdEnter' });
    render(
      <ReplyTranslationProvider currentSessionId="sess" currentProvider="gemini">
        <TextBlock
          block={{ type: 'text', text: sentence }}
          messageType="assistant"
          isStreaming={false}
        />
      </ReplyTranslationProvider>
    );
    expect(screen.queryByRole('button', { name: /localTranslate.reply/ })).toBeNull();
  });

  it('renders twin globes (top and bottom) for eligible assistant text block', () => {
    render(
      <ReplyTranslationProvider currentSessionId="sess" currentProvider="claude">
        <TextBlock
          block={{ type: 'text', text: 'Eligible English assistant answer.' }}
          messageType="assistant"
          isStreaming={false}
        />
      </ReplyTranslationProvider>
    );

    const globes = screen.getAllByRole('button', { name: 'localTranslate.replyShow' });
    expect(globes).toHaveLength(2);
    expect(globes[0].getAttribute('aria-pressed')).toBe('false');
    expect(globes[1].getAttribute('aria-pressed')).toBe('false');
    expect(globes[0].querySelector('.codicon-globe')).toBeDefined();
    expect(globes[1].querySelector('.codicon-globe')).toBeDefined();
  });

  it('toggling either globe updates visible text and pressed state on both globes', () => {
    const text = 'This is an assistant explanation.';
    const hash = sha256Hex(text);

    render(
      <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
        <TextBlock
          block={{ type: 'text', text }}
          messageType="assistant"
          isStreaming={false}
        />
      </ReplyTranslationProvider>
    );

    const [topGlobe, bottomGlobe] = screen.getAllByRole('button', { name: 'localTranslate.replyShow' });
    expect(topGlobe).toBeDefined();
    expect(bottomGlobe).toBeDefined();
    expect(screen.getByTestId('markdown-block').textContent).toBe(text);

    // Simulate clicking top globe
    act(() => {
      fireEvent.click(topGlobe);
    });

    // Simulate backend translation result
    act(() => {
      window.updateReplyTranslation?.({
        id: 1,
        success: true,
        hash,
        text: 'Это объяснение ассистента.',
      });
    });

    // Content is now Russian!
    expect(screen.getByTestId('markdown-block').textContent).toBe('Это объяснение ассистента.');

    // Both globes are pressed and show replyHide tooltip
    const pressedGlobes = screen.getAllByRole('button', { name: 'localTranslate.replyHide' });
    expect(pressedGlobes).toHaveLength(2);
    expect(pressedGlobes[0].getAttribute('aria-pressed')).toBe('true');
    expect(pressedGlobes[1].getAttribute('aria-pressed')).toBe('true');

    // Clicking bottom globe unpresses and returns to English
    act(() => {
      fireEvent.click(pressedGlobes[1]);
    });
    expect(screen.getByTestId('markdown-block').textContent).toBe(text);
    const unpressedGlobes = screen.getAllByRole('button', { name: 'localTranslate.replyShow' });
    expect(unpressedGlobes).toHaveLength(2);
    expect(unpressedGlobes[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('respects optional displayText override', () => {
    render(
      <ReplyTranslationProvider currentSessionId="sess-1" currentProvider="claude">
        <TextBlock
          block={{ type: 'text', text: 'Original English' }}
          messageType="assistant"
          isStreaming={false}
          displayText="Explicit override text"
        />
      </ReplyTranslationProvider>
    );

    expect(screen.getByTestId('markdown-block').textContent).toBe('Explicit override text');
  });
});
