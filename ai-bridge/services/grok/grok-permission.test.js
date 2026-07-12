import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPermissionToolInfo,
  resolveAcpPermissionDecision,
} from './grok-acp-client.js';

// Mock permission-ipc by monkeypatching module is hard with static import.
// resolveAcpPermissionDecision calls requestPermissionFromJava — for auto paths we don't need it.

test('extractPermissionToolInfo maps execute toolCall to run_terminal_command', () => {
  const info = extractPermissionToolInfo({
    sessionId: 's1',
    toolCall: {
      toolCallId: 'tc1',
      title: 'Run ls',
      kind: 'execute',
      rawInput: { command: 'ls -la' },
    },
    options: [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ],
  });
  assert.equal(info.toolName, 'run_terminal_command');
  assert.equal(info.input.command, 'ls -la');
  assert.equal(info.input._acp.toolCallId, 'tc1');
});

test('extractPermissionToolInfo maps edit kind to Edit', () => {
  const info = extractPermissionToolInfo({
    toolCall: {
      kind: 'edit',
      title: 'Update file',
      rawInput: { path: '/tmp/a.txt' },
    },
  });
  assert.equal(info.toolName, 'Edit');
  assert.equal(info.input.path, '/tmp/a.txt');
});

test('resolveAcpPermissionDecision auto-approves in bypass mode without UI', async () => {
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: { kind: 'execute', rawInput: { command: 'echo hi' } },
      options: [
        { optionId: 'allow-always', kind: 'allow_always' },
        { optionId: 'allow-once', kind: 'allow_once' },
      ],
    },
    'bypassPermissions',
    { autoApprove: true }
  );
  assert.equal(result.allowed, true);
  assert.equal(result.optionId, 'allow-always');
  assert.equal(result.source, 'auto-approve');
  assert.equal(result.response.outcome.outcome, 'selected');
});

test('resolveAcpPermissionDecision acceptEdits auto-allows non-exec tools', async () => {
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: { kind: 'edit', rawInput: { path: 'a.ts' } },
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
    },
    'acceptEdits',
    { autoApprove: false }
  );
  assert.equal(result.allowed, true);
  assert.equal(result.source, 'accept-edits');
  assert.equal(result.optionId, 'allow-once');
});


test('extractPermissionToolInfo normalizes Bash alias to run_terminal_command', () => {
  const info = extractPermissionToolInfo({
    toolCall: {
      name: 'Bash',
      kind: 'execute',
      rawInput: { command: 'pwd' },
    },
  });
  assert.equal(info.toolName, 'run_terminal_command');
  assert.equal(info.input.command, 'pwd');
});
