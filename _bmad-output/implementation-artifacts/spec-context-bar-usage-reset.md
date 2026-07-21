---
title: 'ContextBar: Grok % Usage + дата reset'
type: 'feature'
created: '2026-07-21'
status: 'done'
baseline_commit: 'c6301ec8'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** У Grok нет постоянного индикатора лимита плана (% usage) и даты reset в зоне ввода. В gateway-режиме (ai-proxy / grok-local-agent) CLI `/usage` часто бесполезен, хотя fleet/worker уже знает `capacity_pct` + `reset_at`.

**Approach:** ContextBar (между File Context и Collapse), только Grok, макет **D**: mini-bar + `TP%` + short reset.  
**Источник (режим настройки как сейчас):**
1. **Primary (gateway mode):** loopback **`GET /capacity` на grok-local-agent** (обычно `http://127.0.0.1:18790/capacity`) → `capacity_pct`/`used_pct` → TP, `reset_at` → reset, `period_type` → окно TT. Без новых settings.
2. **Fallback (direct mode):** CLI `/usage` → `creditUsagePercent` + `currentPeriod`.  
Цвет pace TP vs TT; tooltip полный; нет данных → `Usage —`.

## Boundaries & Constraints

**Always:**
- Только `currentProvider === 'grok'`.
- Макет **D**: `[████░░ 47%] Reset 21 Apr`.
- **Не** менять `TokenIndicator` (context window).
- **Gateway path = option A:** расширить **grok-local-agent** loopback `GET /capacity` (Grok capacity, не Anthropic `/ratelimit`). Plugin читает origin из текущих base URL (`oauthBaseUrl` / local-agent host, default `127.0.0.1:18790`) — **без новых обязательных settings**.
- local-agent тянет capacity upstream (gateway/worker fleet numbers) используя **уже имеющийся** gateway token в своём toml; loopback `/capacity` без client auth.
- Если gateway ещё не отдаёт capacity по user-token: **минимальный companion** на ai-proxy (user-facing capacity для local-agent), **не** operator-only `/status` + register token в plugin.
- **Приоритет TP/reset:** (1) local-agent `/capacity` (2) CLI `/usage`.
- **TP** 0–100; **TT** linear budget:
  - start+end → `(now−start)/(end−start)×100` clamp 0–100
  - только `reset_at` + `period_type`: `WEEKLY` → start = end−7d; `monthly`/`MONTHLY` → start = end−30d (зафиксировать в pure-helper + tests)
  - иначе TT undefined → **neutral** color
- Цвет: `TP < TT` green; `TT ≤ TP ≤ TT+5` yellow; `TP > TT+5` red.
- Нет данных → **`Usage —`**.
- Tooltip (C): e.g. `Weekly limit 47% · Resets 21 Apr 2026, 12:00`.
- Ветка plugin: **`feat/context-bar-usage-reset`** ← **`grok-support`**. ai-proxy/local-agent changes — отдельный коммит/ветка в ai-proxy repo по необходимости.
- i18n по паттерну проекта.

**Ask First:**
- Codex/Claude в ContextBar.
- Клик → Settings/refresh (v1: **нет**).
- Новые обязательные plugin settings (register token и т.п.).

**Never:**
- Non-grok providers.
- Смешивать plan % с context-window `usagePercentage`.
- Cold-start Grok daemon только ради CLI path (gateway `/capacity` не зависит от daemon).
- Требовать `x-register-token` в plugin settings.
- Untracked BMAD/skills в feature commits.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Gateway happy | grok + local-agent UP, `/capacity` → 47% + reset_at, TT≈50 | bar 47%, date, **green**, tooltip | N/A |
| CLI fallback | no local-agent/gateway, CLI `/usage` ok | same UI from credit % | N/A |
| Yellow / red | TP=TT+3 / TP=TT+10 | yellow / red | N/A |
| local-agent down | gateway mode, `/capacity` fail, CLI also fail | `Usage —` | no throw |
| Gateway only | `/capacity` ok, CLI fail | use capacity | N/A |
| Non-Grok | claude\|codex | hidden | N/A |
| Partial period | % ok, no TT inputs | % (+ reset); **neutral** | N/A |
| Narrow width | long file chip | shrink bar group; Collapse ok | CSS |
| Provider → grok | switch | show + refresh `/capacity` | fail → `Usage —` |

</frozen-after-approval>

## Code Map

**Plugin (`jetbrains-cc-gui`):**
- `webview/src/components/ChatInputBox/ContextBar.tsx` + `styles/context-bar.css` -- UI D, first child `.context-tools-right`
- `ChatInputBoxHeader.tsx` / `ChatInputBox.tsx` / `types.ts` / App -- props ≠ `usagePercentage`
- `webview/src/utils/grokBillingPace.ts` -- TT/TP color + period_type windows
- Hook/state -- dual source: poll local-agent `/capacity` when gateway/local bases set; else CLI
- Derive capacity URL from existing `oauthBaseUrl` / gateway local-agent host (e.g. strip path → `http://127.0.0.1:18790/capacity`)
- Java bridge optional for HTTP from IDE if webview CORS/loopback policy requires it
- `GrokSDKBridge.getUsage` / `get_grok_usage` -- CLI fallback only
- `webview/src/i18n/locales/*`
- `TokenIndicator.tsx` -- **no change**

**ai-proxy / local-agent (`/Volumes/dx/dev/_home/ai-proxy`):**
- `claude-firewall/local-agent/proxy.go` -- add **`GET /capacity`** (loopback JSON); keep `GET /ratelimit` for Claude
- local-agent upstream fetch using `cfg.Token` + `cfg.Remote` → capacity fields
- Companion if needed: gateway thin user capacity (x-gateway-token) feeding local-agent — **not** plugin→register `/status`
- `cmd/grok-worker` / `fleet.go` -- existing `capacity_pct`, `reset_at`, `period_type`, `used_pct`
- Go tests for `/capacity` present/unavailable shapes

## Tasks & Acceptance

**Execution:**
- [x] ai-proxy: local-agent `GET /capacity` + tests; gateway user `GET /capacity` (x-gateway-token companion)
- [x] plugin git: branch `feat/context-bar-usage-reset` from `grok-support`
- [x] `grokBillingPace.ts` + unit tests (WEEKLY/monthly/explicit + color bands)
- [x] dual-source snapshot (primary `/capacity`, fallback CLI `/usage`) via `useGrokPlanUsage`
- [x] ContextBar UI D + css + tooltip + `Usage —` (`GrokPlanUsageIndicator`)
- [x] indicator wired in ContextBar (first child of `.context-tools-right`, provider gate)
- [x] i18n (`chat.grokPlanUsage.*` all locales)
- [x] vitest: `grokBillingPace` + `GrokPlanUsageIndicator` (19 tests pass)

**Acceptance Criteria:**
- Given grok + local-agent with valid `/capacity`, when chat open, then bar shows TP% + reset **without** CLI/daemon.
- Given no gateway, when CLI `/usage` ok, then same UI from credit percent.
- Given TP/TT rules, when render, then green/yellow/red/neutral correct.
- Given no data, then `Usage —`.
- Given non-grok, indicator hidden; TokenIndicator ok.
- Given hover, full tooltip with % and Resets datetime.

## Spec Change Log

## Design Notes

**Endpoint contract (local-agent `GET /capacity`):**
```json
{
  "ok": true,
  "present": true,
  "capacity_pct": 50.3,
  "reset_at": "2026-07-17T00:00:00Z",
  "period_type": "WEEKLY",
  "source": "gateway",
  "updated_at": "2026-07-21T12:00:00Z"
}
```
Unavailable:
```json
{ "ok": true, "present": false, "message": "…" }
```

**Plugin URL:** origin of configured Grok OAuth/local base (e.g. `http://127.0.0.1:18790`) + `/capacity`. If bases empty → skip gateway path, use CLI only.

**Aggregation (multi-worker):** prefer **min eligible grok `used_pct`** (same bias as fleet pick) when upstream returns fleet list; single-worker health is fine as-is.

**DOM:** first child `.context-tools-right`.

**Props:** `grokPlanUsagePercent`, `grokPlanResetAt`, `grokPlanPeriodStart`, `grokPlanStatus`.

**Pace:** TT=50 → TP40 green, TP52 yellow, TP56 red.

## Verification

**Commands:**
- ai-proxy: `go test ./claude-firewall/local-agent/...` (capacity tests) -- pass
- `cd webview && npm test -- grokBillingPace` -- pass
- `cd webview && npx tsc -p tsconfig.test.json --noEmit` -- clean touched
- Java only if touched

**Manual:**
- `curl -s http://127.0.0.1:18790/capacity` → present + %
- Plugin gateway mode: bar from capacity
- Direct mode: CLI path
- Non-grok / unavailable / narrow width

## Suggested Review Order

**Entry — UI placement**

- Grok indicator as first child of right tools (before Collapse)
  [`ContextBar.tsx`](../../../webview/src/components/ChatInputBox/ContextBar.tsx)

**Bridge dual-source**

- Java: local-agent /capacity then CLI /usage to updateGrokPlanUsage
  [`ProjectConfigHandler.java`](../../../src/main/java/com/github/claudecodegui/handler/ProjectConfigHandler.java)

- Webview hook polls get_grok_plan_usage without Settings hijack
  [`useGrokPlanUsage.ts`](../../../webview/src/hooks/useGrokPlanUsage.ts)

**Pace math**

- TT from period window; TP color green / yellow+5 / red
  [`grokBillingPace.ts`](../../../webview/src/utils/grokBillingPace.ts)

**Layout D + styles**

- Mini-bar, %, short reset, loading vs Usage dash
  [`GrokPlanUsageIndicator.tsx`](../../../webview/src/components/ChatInputBox/GrokPlanUsageIndicator.tsx)

- Context bar CSS for pace colors
  [`context-bar.css`](../../../webview/src/components/ChatInputBox/styles/context-bar.css)

**ai-proxy capacity path**

- Gateway user GET /capacity with x-gateway-token
  [`main.go`](../../../../ai-proxy/main.go)

- Min eligible used_pct pick
  [`fleet.go`](../../../../ai-proxy/fleet.go)

- local-agent loopback /capacity proxy and cache
  [`proxy.go`](../../../../ai-proxy/claude-firewall/local-agent/proxy.go)

**Tests**

- Pace and indicator unit tests
  [`grokBillingPace.test.ts`](../../../webview/src/utils/grokBillingPace.test.ts)
