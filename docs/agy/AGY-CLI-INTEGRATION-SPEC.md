# Antigravity CLI (agy) → plugin provider `gemini`

## Goal

First-class provider id **`gemini`** in jetbrains-cc-gui, backed by **Antigravity CLI** headless NDJSON (`agy -p … --output-format stream-json`), not Claude Agent SDK and not ACP.

## Transport

```
UI provider=gemini
  → SessionSendService.sendToGemini
  → GeminiSDKBridge.sendMessage (one-shot channel-manager)
  → node channel-manager.js gemini send  (stdin JSON, GEMINI_USE_STDIN=true)
  → services/gemini/message-service.js
  → agy-runner.js spawn: agy -p <msg> --output-format stream-json [--conversation id] …
  → agy-event-normalizer.js → Claude-compatible stdout tags
  → GeminiMessageHandler → webview
```

## Multi-turn

`conversation_id` from agy `init` / `result` is stored as plugin `sessionId` and passed back as `--conversation` on later turns.

## Permissions

Headless has no Ask UI. Default: soft-deny. Plugin modes map via `mapPermissionMode`:

| Plugin mode | agy |
|-------------|-----|
| plan | `--mode plan` |
| acceptEdits | `--mode accept-edits` |
| bypass / yolo / dontAsk | `--dangerously-skip-permissions` |
| sandbox | `--sandbox` |

## Auth

User runs `agy` once in a terminal (Google Sign-In). Binary resolution: `AGY_PATH` / `GEMINI_CLI_PATH`, then common install paths, then `PATH`.

## Out of scope (v1)

- On-disk history browser for agy conversations
- Interactive permission dialogs for agy tools
- Persistent daemon ACP session (one-shot per turn is enough)
