# Handoff: Context Usage Ring / Bar для Claude

**Дата:** 2026-07-28  
**Цель:** Реализовать такой же визуальный индикатор использованных токенов (кольцо + /context диалог) для Claude, как уже сделан для Grok.

---

## 1. Что уже есть для Grok (референс)

### 1.1 Java (backend)

**GrokContextUsageBuilder.java** — единственный класс, который:
- `build(used, max, model)` — синтезирует `ContextUsageData` JSON:
  - `totalTokens`, `maxTokens`, `percentage`, `model`
  - `categories[]` — `Conversation` + `Free space`
  - `gridRows[][]` — минимальная heatmap (1 ряд)
  - `memoryFiles`, `mcpTools`, `agents` — пустые массивы
- `normalizeUsageToSnakeCase(usage)` — приводит camelCase / snake_case к `total_tokens` / `input_tokens`
- `extractUsedTokens(usage)` — главный метод извлечения used tokens

**GrokMessageHandler.java** (ключевые точки):
- `pushContextUsageFromCurrentAssistant()` — после `turn_completed` / `STREAM_END`
- `GrokContextUsageBuilder.extractUsedTokens(...)` + `build(...)`
- `sendContextUsageToFrontend(json)` — IPC на webview
- `GrokUsageLedger.record(...)` — отдельная статистика usage (не контекстное кольцо)

**GrokSDKBridge.java**:
- `GrokContextUsageBuilder.build(...)` после `getContextUsage` и после `normalizeUsageToSnakeCase`

**TokenUsageUtils.java**:
- `extractUsedTokens(usage, provider)` — делегирует на `GrokContextUsageBuilder` когда `provider == "grok"`

### 1.2 Bridge (Node)

**ai-bridge/channels/grok-channel.js**:
- `buildGrokContextUsagePayload({used, max, model})` — зеркало Java builder
- `case 'getContextUsage'` — вызывает `buildGrokContextUsagePayload`

**ai-bridge/services/grok/grok-utils.js**:
- `buildGrokContextUsagePayload(...)` — чистая JS-версия

### 1.3 Frontend

**TokenIndicator.tsx** (в `ChatInputBox/`):
- SVG dual-circle (background + progress arc)
- `percentage`, `usedTokens`, `maxTokens`
- Tooltip: `XX.X% · 123k / 200k context`
- Label: `47%`

**ContextUsageDialog.tsx**:
- `ContextUsageData` interface
- Heatmap grid, категории, memoryFiles / mcpTools / agents
- Цвета через `COLOR_MAP`

**App.tsx + useWindowCallbacks.ts + useDialogManagement.ts**:
- `openContextUsageDialog(requestId, loading)`
- `updateContextUsageData(requestId, data)`
- `closeContextUsageDialog(requestId)`

**useMessageSender.ts**:
- Вызывает `openContextUsageDialog` при клике на `TokenIndicator`

---

## 2. Что нужно сделать для Claude

### 2.1 Минимальный набор (MVP)

1. **Java**
   - Создать `ClaudeContextUsageBuilder.java` (или переиспользовать `TokenUsageUtils` + `ClaudeUsageAggregator`)
   - Метод `build(used, max, model)` — аналог Grok
   - Метод `extractUsedTokens(usage)` — уже есть в `TokenUsageUtils`, нужно убедиться, что он возвращает `input + cache + output`

2. **MessageHandler**
   - В `ClaudeMessageHandler.java` добавить `pushContextUsageFromCurrentAssistant()` (или аналог)
   - Вызывать после `message_stop` / `STREAM_END` / `result` usage

3. **Frontend**
   - `TokenIndicator` уже универсальный (не привязан к провайдеру)
   - `ContextUsageDialog` уже универсальный
   - Нужно только гарантировать, что `provider === 'claude'` шлёт `ContextUsageData` того же формата

### 2.2 Ключевые различия Claude vs Grok

| Аспект | Grok | Claude |
|--------|------|--------|
| Usage формат | `total_tokens` / camelCase | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` |
| Max tokens | model context window (фиксировано) | model context window (фиксировано) |
| Breakdown | Conversation + Free space | Prompt / Cached / Output + Free space (опционально) |
| Cache | нет | `cache_creation_*` + `cache_read_*` |
| Ledger | `GrokUsageLedger` | `ClaudeUsageAggregator` (уже есть) |

### 2.3 Что уже частично готово для Claude

- `TokenUsageUtils.extractUsedTokens(usage, "claude")` — считает `input + cache + output`
- `ClaudeUsageAggregator` — агрегирует usage по проектам/сессиям (не ring)
- `UsagePushService.sendUsageUpdate(...)` — шлёт `percentage / totalTokens / limit`
- `ContextBar` + `TokenIndicator` уже рендерятся для всех провайдеров

### 2.4 Что отсутствует

- Нет `ClaudeContextUsageBuilder.build(...)` → нет полной `ContextUsageData` (категории, grid, memoryFiles)
- Нет `pushContextUsageFromCurrentAssistant()` в `ClaudeMessageHandler`
- `getContextUsage` в `claude-channel.js` пока не реализован (только заглушка с ошибкой)

---

## 3. План реализации (рекомендуемый порядок)

### Шаг 1 — Java builder
- Создать `ClaudeContextUsageBuilder.java` (копия Grok + адаптация категорий)
- `build(used, max, model)` → `ContextUsageData`
- `extractUsedTokens(usage)` — делегировать на `TokenUsageUtils` или дублировать

### Шаг 2 — MessageHandler
- В `ClaudeMessageHandler` добавить:
  - `private void pushContextUsageFromCurrentAssistant()`
  - Вызывать из `handleClaudeStreamEnd(...)` / после получения `result.usage`
  - Использовать `ClaudeContextUsageBuilder.build(...)`

### Шаг 3 — Bridge (опционально, если нужен `getContextUsage`)
- В `claude-channel.js` реализовать `case 'getContextUsage'`:
  - Берёт `lastUsage` из persistent runtime
  - Вызывает `buildClaudeContextUsagePayload(...)` (зеркало Grok)

### Шаг 4 — Frontend (минимально)
- Ничего нового — `TokenIndicator` и `ContextUsageDialog` уже generic
- Проверить, что `provider === 'claude'` корректно обновляет кольцо

### Шаг 5 — Тесты
- `ClaudeContextUsageBuilderTest.java`
- Обновить `ClaudeMessageHandlerResultUsageTest` — проверить, что `pushContextUsage` вызывается

---

## 4. Файлы, которые нужно создать / изменить

**Создать:**
- `src/main/java/com/github/claudecodegui/provider/claude/ClaudeContextUsageBuilder.java`
- `src/test/java/com/github/claudecodegui/provider/claude/ClaudeContextUsageBuilderTest.java`

**Изменить:**
- `src/main/java/com/github/claudecodegui/session/ClaudeMessageHandler.java`
- `ai-bridge/channels/claude-channel.js` (опционально)
- `ai-bridge/services/claude/...` (опционально)

**Не трогать (уже универсальные):**
- `webview/src/components/ChatInputBox/TokenIndicator.tsx`
- `webview/src/components/ContextUsageDialog.tsx`
- `webview/src/hooks/useDialogManagement.ts`
- `src/main/java/com/github/claudecodegui/util/TokenUsageUtils.java`

---

## 5. Acceptance criteria

- При переключении модели или окончании turn у Claude в статус-баре появляется `TokenIndicator` с процентом
- Клик по индикатору открывает `ContextUsageDialog` с категориями и heatmap
- Данные приходят в формате `ContextUsageData` (тот же, что у Grok)
- Нет регрессии существующих Claude usage flows (`UsageStatistics`, `ClaudeUsageAggregator`)

---

## 6. Ссылки на код

- Grok builder: `src/main/java/com/github/claudecodegui/provider/grok/GrokContextUsageBuilder.java`
- Grok handler push: `src/main/java/com/github/claudecodegui/session/GrokMessageHandler.java:592`
- TokenIndicator: `webview/src/components/ChatInputBox/TokenIndicator.tsx`
- ContextUsageDialog: `webview/src/components/ContextUsageDialog.tsx`
- TokenUsageUtils: `src/main/java/com/github/claudecodegui/util/TokenUsageUtils.java`
