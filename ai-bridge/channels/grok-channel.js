/**
 * Grok channel command handler.
 * Claude-shaped stdin contract; ACP primary via services/grok.
 */

import { sendMessage as grokSendMessage } from '../services/grok/message-service.js';

export async function handleGrokCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && (stdinData.message !== undefined || stdinData.prompt !== undefined)) {
        const options = {
          message: stdinData.message ?? stdinData.prompt ?? '',
          sessionId: stdinData.sessionId || '',
          cwd: stdinData.cwd || '',
          permissionMode: stdinData.permissionMode || '',
          model: stdinData.model || '',
          baseUrl: stdinData.baseUrl || '',
          apiKey: stdinData.apiKey || '',
          authMethod: stdinData.authMethod || '',
          attachments: stdinData.attachments || [],
          // Claude-shaped fields
          openedFiles: stdinData.openedFiles ?? null,
          agentPrompt: stdinData.agentPrompt || '',
          streaming: stdinData.streaming !== undefined ? stdinData.streaming : true,
          reasoningEffort: stdinData.reasoningEffort || '',
        };
        await grokSendMessage(options);
      } else {
        // Legacy positional fallback
        await grokSendMessage(
          args[0],
          args[1],
          args[2],
          args[3],
          args[4],
          args[5],
          args[6]
        );
      }
      break;
    }

    case 'getContextUsage': {
      // Requires persistent daemon mode (like Claude), for rich /context dialog.
      console.log(JSON.stringify({
        success: false,
        error: 'getContextUsage requires daemon/persistent runtime for Grok. Use persistent mode.'
      }));
      break;
    }
    case 'getUsage': {
      // For /usage billing info, prefer persistent but allow direct in fallback.
      // Will be handled by daemon in main path.
      console.log(JSON.stringify({
        success: false,
        error: 'getUsage requires daemon for consistent auth. Use persistent Grok mode.'
      }));
      break;
    }
    default:
      throw new Error(`Unknown Grok command: ${command}`);
  }
}

export function getGrokCommandList() {
  return ['send', 'getContextUsage', 'getUsage'];
}
