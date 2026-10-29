import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownBlock from '../../MarkdownBlock';
import CollapsibleTextBlock from '../../CollapsibleTextBlock';
import type { ClaudeContentBlock } from '../../../types';
import { isReplyTranslatable, sha256Hex } from '../../ChatInputBox/utils/localTranslate';
import { useReplyTranslation } from '../../../contexts/ReplyTranslationContext';

export interface TextBlockProps {
  block: Extract<ClaudeContentBlock, { type: 'text' }>;
  messageType: string;
  isStreaming: boolean;
  displayText?: string;
}

export function TextBlock({ block, messageType, isStreaming, displayText }: TextBlockProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const text = block.text ?? '';

  const {
    enabled,
    isBlockShown,
    isBlockLoading,
    getDisplayText,
    toggleBlock,
    registerBlock,
  } = useReplyTranslation();

  const isEligible = messageType === 'assistant' && !isStreaming && isReplyTranslatable(text);
  const hash = useMemo(() => (isEligible ? sha256Hex(text) : ''), [isEligible, text]);

  useEffect(() => {
    if (isEligible && hash) {
      return registerBlock(hash, text, () => containerRef.current);
    }
  }, [isEligible, hash, text, registerBlock]);

  if (messageType === 'user') {
    return <CollapsibleTextBlock content={text} />;
  }

  if (!enabled || !isEligible) {
    return <MarkdownBlock content={displayText ?? text} isStreaming={isStreaming} />;
  }

  const isShown = isBlockShown(text);
  const isLoading = isBlockLoading(text);
  const effectiveContent = displayText ?? (isShown ? (getDisplayText(text) ?? text) : text);

  const renderGlobe = (pos: 'top' | 'bottom') => (
    <div
      className={`reply-translate-bar reply-translate-bar-${pos}`}
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        ...(pos === 'top' ? { marginBottom: '4px' } : { marginTop: '4px' }),
        paddingRight: '4px',
      }}
    >
      <button
        type="button"
        className="reply-translate-globe-btn"
        aria-pressed={isShown}
        aria-label={t(isShown ? 'localTranslate.replyHide' : 'localTranslate.replyShow')}
        title={t(isShown ? 'localTranslate.replyHide' : 'localTranslate.replyShow')}
        disabled={isLoading}
        onClick={(e) => {
          e.stopPropagation();
          if (!isLoading) {
            toggleBlock(text);
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          cursor: isLoading ? 'default' : 'pointer',
          padding: '2px 4px',
          borderRadius: '4px',
          color: isShown ? 'var(--vscode-button-background, #0e639c)' : 'var(--text-muted)',
        }}
      >
        <span
          className={`codicon ${isLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-globe'}`}
        />
      </button>
    </div>
  );

  return (
    <div className="assistant-text-block-wrapper" ref={containerRef} data-reply-hash={hash}>
      {renderGlobe('top')}
      <MarkdownBlock content={effectiveContent} isStreaming={isStreaming} />
      {renderGlobe('bottom')}
    </div>
  );
}
