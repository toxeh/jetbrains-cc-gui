import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPermissionToolInfo,
  resolveAcpPermissionDecision,
  isAutoApproveMode,
  applyPermissionModeToSession,
  applyAutoApproveIfNeeded,
} from './grok-acp-client.js';

// ---------------------------------------------------------------------------
// Tool info mapping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// isAutoApproveMode — default must NOT auto-approve
// ---------------------------------------------------------------------------

test('isAutoApproveMode is false for default, empty, null, plan', () => {
  assert.equal(isAutoApproveMode('default'), false);
  assert.equal(isAutoApproveMode(''), false);
  assert.equal(isAutoApproveMode(null), false);
  assert.equal(isAutoApproveMode(undefined), false);
  assert.equal(isAutoApproveMode('plan'), false);
  assert.equal(isAutoApproveMode('acceptEdits'), false);
});

test('isAutoApproveMode is true only for explicit bypass-style modes', () => {
  assert.equal(isAutoApproveMode('bypassPermissions'), true);
  assert.equal(isAutoApproveMode('yolo'), true);
  assert.equal(isAutoApproveMode('auto'), true);
  assert.equal(isAutoApproveMode('always-approve'), true);
  assert.equal(isAutoApproveMode('dontAsk'), true);
});

// ---------------------------------------------------------------------------
// resolveAcpPermissionDecision — default must hit UI path
// ---------------------------------------------------------------------------

test('resolveAcpPermissionDecision auto-approves in bypass mode without UI', async () => {
  let uiCalled = false;
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: { kind: 'execute', rawInput: { command: 'echo hi' } },
      options: [
        { optionId: 'allow-always', kind: 'allow_always' },
        { optionId: 'allow-once', kind: 'allow_once' },
      ],
    },
    'bypassPermissions',
    {
      autoApprove: true,
      requestPermission: async () => {
        uiCalled = true;
        return false;
      },
    }
  );
  assert.equal(uiCalled, false, 'bypass must not open permission UI');
  assert.equal(result.allowed, true);
  assert.equal(result.optionId, 'allow-always');
  assert.equal(result.source, 'auto-approve');
  assert.equal(result.response.outcome.outcome, 'selected');
});

test('resolveAcpPermissionDecision acceptEdits auto-allows non-exec tools', async () => {
  let uiCalled = false;
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: { kind: 'edit', rawInput: { path: 'a.ts' } },
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
    },
    'acceptEdits',
    {
      autoApprove: false,
      requestPermission: async () => {
        uiCalled = true;
        return false;
      },
    }
  );
  assert.equal(uiCalled, false, 'acceptEdits non-exec should not open UI');
  assert.equal(result.allowed, true);
  assert.equal(result.source, 'accept-edits');
  assert.equal(result.optionId, 'allow-once');
});

test('resolveAcpPermissionDecision acceptEdits still asks UI for execute tools', async () => {
  let called = false;
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: { kind: 'execute', rawInput: { command: 'npm test' } },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    },
    'acceptEdits',
    {
      autoApprove: false,
      requestPermission: async (toolName) => {
        called = true;
        assert.equal(toolName, 'run_terminal_command');
        return true;
      },
    }
  );
  assert.equal(called, true, 'acceptEdits + execute must ask UI');
  assert.equal(result.source, 'ui');
  assert.equal(result.allowed, true);
});

test('resolveAcpPermissionDecision default mode asks UI (not silent auto-approve)', async () => {
  let called = false;
  let calledTool = null;
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: {
        kind: 'execute',
        title: 'Run ls',
        rawInput: { command: 'ls -la' },
      },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    },
    'default',
    {
      autoApprove: false,
      requestPermission: async (toolName, input) => {
        called = true;
        calledTool = toolName;
        assert.equal(input.command, 'ls -la');
        return true;
      },
    }
  );
  assert.equal(called, true, 'default mode must call requestPermission (UI path)');
  assert.equal(calledTool, 'run_terminal_command');
  assert.equal(result.allowed, true);
  assert.equal(result.source, 'ui');
  assert.equal(result.optionId, 'allow-once');
});

test('resolveAcpPermissionDecision empty mode still asks UI (not auto-approve)', async () => {
  let called = false;
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: { kind: 'edit', rawInput: { path: '/tmp/x' } },
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
    },
    '',
    {
      autoApprove: false,
      requestPermission: async () => {
        called = true;
        return false;
      },
    }
  );
  assert.equal(called, true, 'empty permissionMode must still ask UI, not auto-approve');
  assert.equal(result.allowed, false);
  assert.equal(result.source, 'ui');
});

test('resolveAcpPermissionDecision default mode denies when user rejects', async () => {
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: { kind: 'execute', rawInput: { command: 'rm -rf /' } },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    },
    'default',
    {
      requestPermission: async () => false,
    }
  );
  assert.equal(result.allowed, false);
  assert.equal(result.source, 'ui');
  assert.equal(result.optionId, 'reject-once');
});

test('resolveAcpPermissionDecision default mode never uses auto-approve source', async () => {
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: { kind: 'read', rawInput: { path: 'a.ts' } },
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
    },
    'default',
    {
      // Even if caller wrongly sets autoApprove=false, default must still ask
      autoApprove: false,
      requestPermission: async () => true,
    }
  );
  assert.notEqual(result.source, 'auto-approve');
  assert.equal(result.source, 'ui');
});

test('resolveAcpPermissionDecision plan mode asks UI like default', async () => {
  let called = false;
  const result = await resolveAcpPermissionDecision(
    {
      toolCall: { kind: 'execute', rawInput: { command: 'pwd' } },
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
    },
    'plan',
    {
      requestPermission: async () => {
        called = true;
        return true;
      },
    }
  );
  assert.equal(called, true);
  assert.equal(result.source, 'ui');
});

// ---------------------------------------------------------------------------
// applyPermissionModeToSession — always-approve on/off (silence root cause)
// ---------------------------------------------------------------------------

function fakeClientCapturingPrompts() {
  const prompts = [];
  return {
    prompts,
    request: async (method, params) => {
      prompts.push({ method, params });
      return {};
    },
  };
}

test('applyPermissionModeToSession sends /always-approve off for default', async () => {
  const client = fakeClientCapturingPrompts();
  await applyPermissionModeToSession(client, 'sess-1', 'default');
  assert.equal(client.prompts.length, 1);
  assert.equal(client.prompts[0].method, 'session/prompt');
  const text = client.prompts[0].params.prompt[0].text;
  assert.equal(text, '/always-approve off');
});

test('applyPermissionModeToSession sends /always-approve off for empty mode', async () => {
  const client = fakeClientCapturingPrompts();
  await applyPermissionModeToSession(client, 'sess-1', '');
  assert.equal(client.prompts[0].params.prompt[0].text, '/always-approve off');
});

test('applyPermissionModeToSession sends /always-approve on for bypass', async () => {
  const client = fakeClientCapturingPrompts();
  await applyPermissionModeToSession(client, 'sess-1', 'bypassPermissions');
  assert.equal(client.prompts[0].params.prompt[0].text, '/always-approve on');
});

test('applyAutoApproveIfNeeded only acts for auto modes (does not turn off for default)', async () => {
  const client = fakeClientCapturingPrompts();
  await applyAutoApproveIfNeeded(client, 'sess-1', 'default');
  assert.equal(client.prompts.length, 0, 'legacy helper must not send anything for default');

  await applyAutoApproveIfNeeded(client, 'sess-1', 'bypassPermissions');
  assert.equal(client.prompts.length, 1);
  assert.equal(client.prompts[0].params.prompt[0].text, '/always-approve on');
});

test('applyPermissionModeToSession is no-op without sessionId', async () => {
  const client = fakeClientCapturingPrompts();
  await applyPermissionModeToSession(client, '', 'default');
  await applyPermissionModeToSession(client, null, 'default');
  assert.equal(client.prompts.length, 0);
});

test('applyPermissionModeToSession swallows CLI errors (best effort)', async () => {
  const client = {
    request: async () => {
      throw new Error('CLI does not support always-approve off');
    },
  };
  await assert.doesNotReject(() => applyPermissionModeToSession(client, 's', 'default'));
});
