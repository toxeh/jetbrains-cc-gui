# Handoff: `run_terminal_command` exit 127 (`/bin/bash -lc '…': No such file or directory`)

Use this doc in a **new Grok/Cursor session with a working terminal** to verify fixes and finish any follow-up.

## Symptom

Any `run_terminal_command` returns:

```text
exit: 127
/bin/bash: /bin/bash -lc '…actual command…': No such file or directory
```

## Root cause (mechanics)

`bash` **is present** — it prints the error. The wrapper invokes bash **without `-c`**, passing the **entire** string `/bin/bash -lc '…'` as a **single argv** (script path):

```text
# Broken (exit 127):
/bin/bash  "/bin/bash -lc 'echo hi'"

# Correct:
/bin/bash -lc 'echo hi'
# or: spawn('/bin/bash', ['-lc', 'echo hi'])
```

**127** = command/file not found (here: the bogus “file” is the full wrapper line).

## Two different surfaces

| Surface | Who runs the command | Fix location |
|--------|----------------------|--------------|
| **Grok Build TUI** (this IDE chat `run_terminal_command`) | Grok/Cursor backend sandbox | **Not in this repo** — new session / app restart; report to Grok if persistent |
| **JetBrains plugin → Grok ACP** | `ai-bridge/services/grok/acp-terminal-host.js` | **Fixed in repo** (unwrap outer `/bin/bash -lc`) |

Do not confuse them: a broken Grok Build session cannot run `node --test` here even if the plugin fix is correct.

## Already changed on branch `wip/all-our-fixes`

1. **`ai-bridge/services/grok/acp-terminal-host.js`**
   - Added `unwrapShellWrapperCommand(command, args)`:
     - `command=/bin/bash`, `args=['-lc', '<inner>']` → spawn uses **only `<inner>`** with `loginShell -l -c`.
     - `command="/bin/bash -lc '<inner>'"`, `args=[]` → same.
   - Empty inner command → JSON-RPC error `-32602`.
   - Still uses `spawn(loginShell, ['-l', '-c', commandLine], { env: cleanEnv, … })` (array form — **never** pass wrapper as a single executable path).

2. **`ai-bridge/services/grok/acp-terminal-host.test.js`**
   - Unit tests for unwrap + integration test `create` with `/bin/bash` + `-lc`.

Reference parsing (UI): `webview/src/utils/toolCommandPath.ts` (`unwrapShellCommand`), `ai-bridge/services/codex/codex-command-utils.js` (`extractActualCommand`).

## Checklist for the next session (copy into prompt)

### A. Confirm local shell is healthy

```bash
ls -la /bin/bash
/bin/bash -lc 'echo bash-ok'
echo "SHELL=$SHELL"
```

### B. Run ACP terminal host tests

```bash
cd /Volumes/dx/dev/_home/jetbrains-cc-gui/ai-bridge
node --test services/grok/acp-terminal-host.test.js
```

Expect **9 tests**, all pass.

### C. Optional: align login-shell flags with `daemon.js`

`ai-bridge/daemon.js` probes env with `bash -lc` (single flag). `acp-terminal-host` uses `['-l', '-c', script]`. If anything still fails only on bash-as-`$SHELL`, consider:

```javascript
const shellBase = path.basename(loginShell);
const spawnArgs =
  shellBase === 'fish'
    ? ['-c', commandLine]
    : shellBase === 'bash'
      ? ['-lc', commandLine]
      : ['-l', '-c', commandLine];
spawn(loginShell, spawnArgs, { … });
```

Only change if tests or manual Grok-in-IDEA runs show a real failure.

### D. Manual Grok-in-IDEA smoke (if plugin is runnable)

1. Open project in IDEA with this plugin build.
2. Send a Grok message that runs `echo acp-terminal-ok`.
3. In bridge logs, confirm `terminal/create` does not double-wrap (output contains `acp-terminal-ok`, exit 0).

### E. If Grok Build TUI terminal is still broken (not IDEA)

- New chat session / restart Grok Build.
- If `run_terminal_command` still shows the **same** error with the wrapper string as the “file”, escalate to Grok — backend is calling `bash <one-arg-wrapper>` instead of `bash -lc <script>`.
- Plugin changes in this repo **do not** fix that path.

## Suggested prompt for a fresh agent session

```markdown
Read docs/grok/RUN-TERMINAL-EXIT-127-HANDOFF.md in jetbrains-cc-gui.

1. Run the tests in section B; fix any failures.
2. If all pass, consider section C only if justified.
3. `git diff` — summarize changes; commit with message like:
   fix(grok): unwrap /bin/bash -lc in ACP terminal host (exit 127)
4. Do not spend time “fixing” Grok Build’s own run_terminal_command wrapper unless we find code for it in this repo (we shouldn’t).
```

## Follow-up fix (2026-07-27): bare command single-quoted -> exit 127

### Symptom

"'```text
/bin/bash: echo hello && echo world: command not found
exit 127
```

or the entire pipeline shown as one "command not found" name.

Simple commands that Grok wraps as `/bin/bash` + `args: ['"'-lc', '...']"'` still worked.
Bare `command: '"'echo foo && bar'"'` with empty `args` failed.

### Root cause (plugin)

In `ai-bridge/services/grok/acp-terminal-host.js`, `unwrapShellWrapperCommand`:

- For argv form (`printf` + args) it correctly `escapeForShell`s each token.
- For **bare shell script** (`args` empty) it also ran the whole string through `escapeForShell`, producing:

```text
spawn(loginShell, ['"'-lc', "'echo hello && echo world'"])
"'```

Bash then treats the quoted string as a **single binary name** -> exit 127.

This is **idea-claude-code-gui ACP terminal host**, not Grok Build TUI sandbox and not agent "wrong quoting style".

Process tree for this chat shell:

```text
idea -> ai-bridge/daemon.js -> (terminal/create) -> $SHELL -lc <script>
                         '"\\-> grok agent stdio
"'```

### Fix

When `args.length === 0`, return `command` as the `-c` script unchanged.
Keep per-arg escaping only for executable+args form.

Tests added in `acp-terminal-host.test.js` (must assert `exitCode === 0` and no `command not found` — matching `/shell-ok/` alone is a false green because that text appears in the error too).

### Deploy note

Copying the file into the installed plugin dir is not enough if `daemon.js` already loaded the module.
Restart the Grok/ai-bridge daemon (or IDEA) to pick up the fix.

### Separate issue: double-quote mangling

Tool payloads that contain `"` often arrive with backslash-escaped quotes (`'"\\""'`), so commands like:

```bash
printf '"'%s\\n' "a|b|c"
"'```

can still break **before** or **outside** the bare-script fix. Prefer single-quoted scripts, Write tool for multi-line, or argv form without nested doubles until that path is cleaned up.

'"
## Quick verification of unwrap (no spawn)

```bash
cd ai-bridge
node -e "
import { unwrapShellWrapperCommand } from './services/grok/acp-terminal-host.js';
console.log(unwrapShellWrapperCommand('/bin/bash', ['-lc', 'echo hi']));
console.log(unwrapShellWrapperCommand(\"/bin/bash -lc 'echo hi'\", []));
"
```

Expected output:

```text
echo hi
echo hi
```