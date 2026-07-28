---
title: 'Context Usage Ring для Claude'
type: 'feature'
created: '2026-07-28'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'a043ddb0d83c5d4360ba40a1c4a39fb259b0af16'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Для Claude не реализован полный цикл индикатора контекста: кольцо в статус-баре сбрасывается в 0% после завершения turn, а клик по кольцу открывает диалог `ContextUsageDialog` с ошибкой — `getContextUsage` в `claude-channel.js` возвращает заглушку.

**Approach:** Создать `ClaudeContextUsageBuilder` (аналог `GrokContextUsageBuilder`), добавить `pushContextUsageFromCurrentAssistant()` в `ClaudeMessageHandler.handleStreamEnd()` для защиты кольца от сброса, и заменить заглушку `getContextUsage` в `claude-channel.js` на реальный payload-builder.

## Boundaries & Constraints

**Always:**
- Формат JSON `ContextUsageData` идентичен Grok: поля `success`, `totalTokens`, `maxTokens`, `rawMaxTokens`, `percentage`, `model`, `isAutoCompactEnabled`, `source`, `categories[]`, `gridRows[][]`, `memoryFiles[]`, `mcpTools[]`, `agents[]`
- Для Claude: `source = "claude-synthesized"`, categories — минимум `"Conversation"` + `"Free space"` (как у Grok)
- Используем `TokenUsageUtils.extractUsedTokens(usage, "claude")` для извлечения токенов — не дублируем логику
- Контекстный лимит: `SettingsHandler.getModelContextLimit(state.getModel())` — существующий метод
- Нет регрессии в `ClaudeUsageAggregator`, `handleAssistantMessage`, `handleUsage` — их `notifyUsageUpdate`-вызовы не трогаем

**Ask First:**
- Нужна ли разбивка категорий (Prompt / Cached / Output / Free) вместо упрощённой двухкатегорийной схемы Grok?

**Never:**
- Не трогать `TokenIndicator.tsx`, `ContextUsageDialog.tsx`, `useDialogManagement.ts`, `TokenUsageUtils.java`
- Не изменять `ClaudeUsageAggregator`

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Нормальный turn end | `currentAssistantMessage.raw.message.usage` содержит `input_tokens=50000`, `maxTokens=200000` | кольцо показывает 25%, `notifyUsageUpdate(50000, 200000)` вызван в `handleStreamEnd` | — |
| Cache-heavy | `cache_creation_input_tokens=30k`, `cache_read_input_tokens=10k`, `input_tokens=5k`, `output_tokens=5k` | `used = 50000`, кольцо 25% | — |
| Нет usage на ассистенте | `currentAssistantMessage.raw.message.usage == null` | `pushContextUsageFromCurrentAssistant()` возвращает без push | early return |
| used > max | `input_tokens=250000`, `max=200000` | `percentage` зажат до 100.0 | — |
| getContextUsage из claude-channel.js | `stdinData = {usedTokens: 100000, maxTokens: 200000, model: "claude-opus-4-5"}` | валидный `ContextUsageData` JSON | — |

</frozen-after-approval>

## Code Map

- `src/main/java/com/github/claudecodegui/provider/grok/GrokContextUsageBuilder.java` -- эталонная реализация: `build()`, `extractUsedTokens()`, `normalizeUsageToSnakeCase()`
- `src/main/java/com/github/claudecodegui/provider/claude/ClaudeContextUsageBuilder.java` -- NEW: Claude-версия builder
- `src/main/java/com/github/claudecodegui/session/ClaudeMessageHandler.java:697-724` -- `handleStreamEnd()` — добавить вызов `pushContextUsageFromCurrentAssistant()` перед `notifyStreamEnd`
- `src/main/java/com/github/claudecodegui/util/TokenUsageUtils.java:33-57` -- `extractUsedTokens(usage, "claude")` — делегировать из builder
- `src/main/java/com/github/claudecodegui/session/GrokMessageHandler.java:592-611` -- эталонный `pushContextUsageFromCurrentAssistant()` 
- `ai-bridge/channels/claude-channel.js:109-117` -- заглушка `getContextUsage` — заменить
- `ai-bridge/channels/grok-channel.js:48-57` -- эталонный `case 'getContextUsage'`
- `src/test/java/com/github/claudecodegui/provider/grok/GrokContextUsageBuilderTest.java` -- JUnit 4 паттерны для тестов
- `src/test/java/com/github/claudecodegui/provider/claude/ClaudeContextUsageBuilderTest.java` -- NEW: тесты

## Tasks & Acceptance

**Execution:**
- [x] `src/main/java/com/github/claudecodegui/provider/claude/ClaudeContextUsageBuilder.java` -- CREATE: `build(int usedTokens, int maxTokens, String model)` возвращает `JsonObject` в формате `ContextUsageData`; `extractUsedTokens(JsonObject usage)` делегирует на `TokenUsageUtils.extractUsedTokens(usage, "claude")`; зажим `percentage` до [0,100]; `source = "claude-synthesized"`; категории: `Conversation` (cyan/claude-цвет) + `Free space` (inactive)
- [x] `src/main/java/com/github/claudecodegui/session/ClaudeMessageHandler.java` -- MODIFY: добавить `private void pushContextUsageFromCurrentAssistant()` (читает `currentAssistantMessage.raw.message.usage`, вызывает `ClaudeContextUsageBuilder.extractUsedTokens`, при `<= 0` возвращает; берёт `SettingsHandler.getModelContextLimit(state.getModel())`; вызывает `callbackHandler.notifyUsageUpdate(used, maxTokens)`); вызвать метод из `handleStreamEnd()` до `notifyStreamEnd()`
- [x] `ai-bridge/channels/claude-channel.js` -- MODIFY: заменить заглушку `getContextUsage` (L109–117) на `buildClaudeContextUsagePayload({ usedTokens, maxTokens, model })` аналогично grok-channel.js; реализовать `buildClaudeContextUsagePayload` в этом же файле или в `ai-bridge/services/claude/claude-context-usage.js`
- [x] `src/test/java/com/github/claudecodegui/provider/claude/ClaudeContextUsageBuilderTest.java` -- CREATE: JUnit 4 тесты, зеркалящие `GrokContextUsageBuilderTest` для claude-специфичных полей (поля usage, `source = "claude-synthesized"`, clamping, null-safety)

**Acceptance Criteria:**
- Given claude turn завершился (`stream_end`), when у `currentAssistantMessage` есть usage, then `callbackHandler.notifyUsageUpdate(used, maxTokens)` вызывается в `handleStreamEnd()` и кольцо не сбрасывается
- Given `notifyUsageUpdate` вызван с `used=0`, when `extractUsedTokens` вернул 0, then метод выходит без push (нет zombie-0%-обновления)
- Given frontend кликает на `TokenIndicator`, when `getContextUsage` вызывается в `claude-channel.js`, then возвращается валидный `ContextUsageData` JSON (`success: true`, `categories` не пустой)
- Given `used > max`, when `build()` вычисляет `percentage`, then значение зажато до 100.0
- Given `currentAssistantMessage == null`, when `pushContextUsageFromCurrentAssistant()` вызывается, then нет NPE (метод содержит guard `if (currentAssistantMessage == null) return;`)



### Review Findings

- [x] [Review][Decision] Порядок вызовов notifyUsageUpdate — добавлять условие «только если значение изменилось» (resolved: добавить `lastPushedUsed/Max` + guard в Design Notes)
- [x] [Review][Patch] Отсутствует guard на currentAssistantMessage == null в pushContextUsageFromCurrentAssistant() [ClaudeMessageHandler.java] — guard уже присутствует (L1012)
- [x] [Review][Patch] Локация buildClaudeContextUsagePayload — ок (оставляем как в спеке)
- [x] [Review][Patch] Тесты не покрывают maxTokens == 0 и model == null [ClaudeContextUsageBuilderTest.java] — тесты `buildHandlesZeroMaxTokens` и `buildHandlesNullModel` уже существуют (L123, L58)

## Spec Change Log

## Design Notes

В `ClaudeMessageHandler.handleStreamEnd()` уже есть вызовы `notifyUsageUpdate` выше по стеку (`handleAssistantMessage` L360, `handleUsage` L923). Финальный push в `handleStreamEnd` нужен как страховка — по аналогии с Grok (тот же паттерн решил сброс кольца в 0%). Не удалять существующие вызовы. **Условие:** вызывать `notifyUsageUpdate` только если `used != lastPushedUsed || maxTokens != lastPushedMax` (хранить в поле `lastPushedUsed/Max` в handler).

`claude-channel.js` работает в per-process режиме без persistent runtime. `stdinData` передаётся Java-стороной при вызове `GrokSDKBridge`-аналога. Реализация аналогична Grok: Java уже умеет передавать `usedTokens/maxTokens/model` (смотри `grok-channel.js:48-57`).

## Verification

**Commands:**
- `./gradlew test --tests "com.github.claudecodegui.provider.claude.ClaudeContextUsageBuilderTest"` -- expected: BUILD SUCCESSFUL, все тесты зелёные
- `./gradlew checkstyleMain` -- expected: no violations
