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

    default:
      throw new Error(`Unknown Grok command: ${command}`);
  }
}

export function getGrokCommandList() {
  return ['send'];
}
