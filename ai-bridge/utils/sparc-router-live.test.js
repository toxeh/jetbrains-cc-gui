import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractLatestSparcStageSummary,
  extractToolCommandString,
  isSparcRouterCommand,
  readSparcRouterRunText,
  startSparcRouterLiveTail,
} from './sparc-router-live.js';
import { GrokEventNormalizer } from '../services/grok/grok-event-normalizer.js';

describe('sparc-router-live utilities', () => {
  it('detects sparc-router.py commands across tool input shapes', () => {
    const cmd =
      'SPARC_ROUTER_DETACHED=1 SPARC_HOST_CLI=external python3 -u /Users/afanasyev/.agents/skills/sparc-router.py run --phase deliver --args "SMEVDEV-25500-041" --root "$(pwd)"';
    assert.equal(extractToolCommandString({ command: cmd }), cmd);
    assert.equal(extractToolCommandString({ CommandLine: cmd }), cmd);
    assert.equal(isSparcRouterCommand({ command: cmd }), true);
    assert.equal(isSparcRouterCommand({ command: 'ls -la' }), false);
  });

  it('extracts latest [SPARC-AUTO] stage summary from output', () => {
    const text = [
      '[SPARC-AUTO] 📦 BATCH START | phase=deliver | stories=2 (SMEVDEV-25500-041, SMEVDEV-25500-042)',
      '[SPARC-AUTO] ▶ STAGE START | story [1/2] STORY-SMEVDEV-25500-041 | stage=tdd | executor=claude | model=Claude Opus 4.7 (claude-opus-4-7) | attempt=#1',
      '[SPARC-AUTO] ✔ STAGE END | story [1/2] STORY-SMEVDEV-25500-041 | stage=tdd | status=OK (RED_TESTS_WRITTEN) | executor=claude | model=Claude Opus 4.7 (claude-opus-4-7) | elapsed=4s',
    ].join('\n');
    assert.equal(
      extractLatestSparcStageSummary(text),
      '✔ STAGE END | story [1/2] STORY-SMEVDEV-25500-041 | stage=tdd | status=OK (RED_TESTS_WRITTEN) | executor=claude | model=Claude Opus 4.7 (claude-opus-4-7) | elapsed=4s',
    );
  });

  it('tails active sparc-router run log and json state in real time', async () => {
    const tmpRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparc-live-test-'));
    try {
      const jsonPath = path.join(tmpRunsDir, '20261102-213000-deliver-12345.json');
      const logPath = path.join(tmpRunsDir, '20261102-213000-deliver-12345.log');

      fs.writeFileSync(
        jsonPath,
        JSON.stringify({
          pid: process.pid,
          phase: 'deliver',
          story_id: 'SMEVDEV-25500-041',
          story_index: 1,
          total_stories: 2,
          status: 'running',
          stage: 'tdd',
          executor_cli: 'claude',
          model_label: 'Claude Opus 4.7',
          model: 'claude-opus-4-7',
          started_at: '2026-11-02T21:30:00Z',
        }),
      );
      fs.writeFileSync(
        logPath,
        '[SPARC-AUTO] 📦 BATCH START | phase=deliver | stories=2 (SMEVDEV-25500-041, SMEVDEV-25500-042)\n' +
          '[SPARC-AUTO] ▶ STAGE START | story [1/2] STORY-SMEVDEV-25500-041 | stage=tdd | executor=claude | model=Claude Opus 4.7 (claude-opus-4-7) | attempt=#1\n',
      );

      const updates = [];
      const handle = startSparcRouterLiveTail({
        runsDir: tmpRunsDir,
        startedAtMs: Date.now() - 1000,
        pollIntervalMs: 40,
        onUpdate: ({ content, latestSummary }) => {
          updates.push({ text: content, summary: latestSummary });
        },
      });

      assert.ok(handle, 'live tail handle should be created');
      assert.ok(updates.length >= 1, 'initial poll should emit immediately');
      assert.match(updates[0].text, /STAGE START \| story \[1\/2\] STORY-SMEVDEV-25500-041 \| stage=tdd/);
      assert.match(updates[0].summary, /STAGE START \| story \[1\/2\] STORY-SMEVDEV-25500-041/);

      // Append stage completion and next stage start
      fs.appendFileSync(
        logPath,
        '[SPARC-AUTO] ✔ STAGE END | story [1/2] STORY-SMEVDEV-25500-041 | stage=tdd | status=OK (RED_TESTS_WRITTEN) | executor=claude | model=Claude Opus 4.7 (claude-opus-4-7) | elapsed=2s\n' +
          '[SPARC-AUTO] ▶ STAGE START | story [1/2] STORY-SMEVDEV-25500-041 | stage=dev | executor=agy | model=Claude Opus 4.6 (claude-opus-4-6-thinking) | attempt=#1\n',
      );

      await new Promise((r) => setTimeout(r, 120));
      handle.stop();

      assert.ok(updates.length >= 2, 'subsequent log update should be emitted');
      const last = updates[updates.length - 1];
      assert.match(last.text, /stage=dev \| executor=agy/);
      assert.match(last.summary, /stage=dev \| executor=agy/);
    } finally {
      fs.rmSync(tmpRunsDir, { recursive: true, force: true });
    }
  });

  it('synthesizes readable progress from state json when log file is absent', () => {
    const tmpRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparc-live-json-'));
    try {
      const jsonPath = path.join(tmpRunsDir, '20261102-213100-deliver-12346.json');
      const state = {
        pid: process.pid,
        phase: 'review',
        story: 'SMEVDEV-25500-041',
        story_index: 1,
        story_total: 1,
        status: 'running',
        cli: 'grok',
        label: 'Grok 4.20',
        model: 'grok-4.20-0309-reasoning',
      };
      fs.writeFileSync(jsonPath, JSON.stringify(state));

      const text = readSparcRouterRunText({
        statePath: jsonPath,
        logPath: path.join(tmpRunsDir, 'missing.log'),
        state,
      });
      assert.match(text, /stage=review.*executor=grok/);
    } finally {
      fs.rmSync(tmpRunsDir, { recursive: true, force: true });
    }
  });

  it('GrokEventNormalizer emits tool_use on Bash start and streams terminal output with is_streaming=true', () => {
    const lines = [];
    const normalizer = new GrokEventNormalizer({
      log: (line) => lines.push(String(line)),
      error: () => {},
    });
    normalizer.begin();

    normalizer.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'bash-sparc-1',
          name: 'Bash',
          status: 'in_progress',
          input: {
            command: 'python3 -u /Users/afanasyev/.agents/skills/sparc-router.py run --phase deliver --args "SMEVDEV-25500-041"',
          },
        },
      },
    });

    // Mid-turn: tool_use must already be emitted even before completion
    const useLines = lines.filter((l) => l.startsWith('[MESSAGE]') && l.includes('bash-sparc-1'));
    assert.equal(useLines.length, 1, 'Bash tool_use should be emitted immediately on start');

    // Terminal output arrives while command is still running
    normalizer.handleAcpEvent('terminal', {
      event: 'output',
      terminalId: 'term-1',
      output: '[SPARC-AUTO] ▶ STAGE START | story [1/1] STORY-SMEVDEV-25500-041 | stage=tdd | executor=claude | model=Claude Opus 4.7\n',
    });

    const streamingResults = lines
      .filter((l) => l.startsWith('[TOOL_RESULT] '))
      .map((l) => JSON.parse(l.slice('[TOOL_RESULT] '.length)));
    assert.equal(streamingResults.length, 1);
    assert.equal(streamingResults[0].tool_use_id, 'bash-sparc-1');
    assert.equal(streamingResults[0].is_streaming, true);
    assert.match(streamingResults[0].content, /STAGE START/);

    // Final tool completion
    normalizer.handleAcpEvent('notification', {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'bash-sparc-1',
          name: 'Bash',
          status: 'completed',
          output: '[SPARC-AUTO] 🎉 BATCH DONE | completed=1/1\nDONE',
        },
      },
    });
    normalizer.finishSuccess('sess-sparc', 'All stages completed.');

    const allResults = lines
      .filter((l) => l.startsWith('[TOOL_RESULT] '))
      .map((l) => JSON.parse(l.slice('[TOOL_RESULT] '.length)));
    const finalResult = allResults[allResults.length - 1];
    assert.equal(finalResult.tool_use_id, 'bash-sparc-1');
    assert.equal(Boolean(finalResult.is_streaming), false);
    assert.match(finalResult.content, /BATCH DONE/);
  });
});
