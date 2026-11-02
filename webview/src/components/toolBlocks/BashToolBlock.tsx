import { memo, useEffect, useState } from 'react';
import type { ToolInput, ToolResultBlock } from '../../types';
import BashToolHeader from './BashToolHeader';
import BashToolDetails from './BashToolDetails';
import { useBashToolState } from './useBashToolState';

interface BashToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** Unique ID of the tool call, used to determine if the user denied permission */
  toolId?: string;
}

const BashToolBlock = memo(function BashToolBlock({ input, result, toolId }: BashToolBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const { command, description, justification, isCompleted, isStreaming, isError, output, liveStatus } =
    useBashToolState({ input, result, toolId });

  useEffect(() => {
    if (!userToggled && !expanded && (isStreaming || output.includes('[SPARC-AUTO]')) && output.trim().length > 0) {
      setExpanded(true);
    }
  }, [userToggled, expanded, isStreaming, output]);

  if (!input) {
    return null;
  }

  if (!command.trim() && !description.trim()) return null;

  const headerDescription = liveStatus
    ? (description ? `${description} — ${liveStatus}` : liveStatus)
    : description;

  return (
    <div className="task-container">
      <BashToolHeader
        expanded={expanded}
        onToggle={() => {
          setUserToggled(true);
          setExpanded((prev) => !prev);
        }}
        description={headerDescription}
        isError={isError}
        isCompleted={isCompleted}
      />

      {expanded && (
        <BashToolDetails command={command} description={description} justification={justification} output={output} isError={isError} />
      )}
    </div>
  );
});

export default BashToolBlock;
