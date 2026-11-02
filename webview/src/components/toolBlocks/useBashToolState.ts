import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { stripAnsi } from '../../utils/stripAnsi';
import { useTranslation } from 'react-i18next';
import { presentCommand } from '../../utils/commandPresentation';

interface UseBashToolStateArgs {
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
}

function extractLatestSparcProgress(output: string): string {
  if (!output || !output.includes('[SPARC-AUTO]')) return '';
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[SPARC-AUTO]')) {
      return trimmed.replace(/^\[SPARC-AUTO\]\s*/, '');
    }
  }
  return '';
}

export function useBashToolState({ input, result, toolId }: UseBashToolStateArgs) {
  const isDenied = useIsToolDenied(toolId);
  const { t } = useTranslation();
  const { command, description, justification } = presentCommand(input, t);

  const isStreaming = result?.is_streaming === true;
  // Determine tool call status based on result
  // If denied, treat as completed (show error state)
  const isCompleted = ((result !== undefined && result !== null) && !isStreaming) || isDenied;
  // If denied, show as error state
  const isError = isDenied || (isCompleted && result?.is_error === true);

  let output = '';

  if (result) {
    const content = result.content;
    if (typeof content === 'string') {
      output = content;
    } else if (Array.isArray(content)) {
      output = content.map((block) => block.text ?? '').join('\n');
    }
    output = stripAnsi(output);
  }

  const liveStatus = extractLatestSparcProgress(output);

  return { command, description, justification, isCompleted, isStreaming, isError, output, liveStatus };
}
