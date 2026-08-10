import React, { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  clampPercent,
  formatFullReset,
  formatShortReset,
  nextWindowId,
  paceColor,
  readStoredWindowId,
  resolveDisplayWindow,
  resolveTimeBudget,
  windowShortLabel,
  worstPaceColor,
  writeStoredWindowId,
  type GeminiPlanUsageSnapshot,
} from '../../utils/geminiBillingPace';

export interface GeminiPlanUsageIndicatorProps {
  snapshot: GeminiPlanUsageSnapshot | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
}

/**
 * Layout D: mini progress bar + % + window switcher + short reset.
 * Click the window chip (7d / mo) to cycle weekly ↔ monthly (or 5h ↔ 7d).
 */
export const GeminiPlanUsageIndicator: React.FC<GeminiPlanUsageIndicatorProps> = memo(({
  snapshot,
  status,
}) => {
  const { t, i18n } = useTranslation();
  const [windowId, setWindowId] = useState<string | null>(() => readStoredWindowId());

  const display = useMemo(() => {
    if (!snapshot?.present) return null;
    return resolveDisplayWindow(snapshot, windowId);
  }, [snapshot, windowId]);

  const windows = snapshot?.windows ?? [];
  const canSwitch = windows.length > 1;

  const onCycleWindow = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canSwitch) return;
    const next = nextWindowId(windows, display?.windowId ?? windowId);
    if (!next) return;
    setWindowId(next);
    writeStoredWindowId(next);
  }, [canSwitch, windows, display?.windowId, windowId]);

  const present = !!display && typeof display.capacityPct === 'number' && !!snapshot?.present;
  const tp = present ? clampPercent(display!.capacityPct) : 0;
  const tt = present
    ? resolveTimeBudget({
      resetAt: display!.resetAt,
      periodStart: snapshot?.periodStart,
      periodType: display!.periodType,
    })
    : null;
  // Bar/% = selected window; leading dot = worst across all windows.
  const color = present ? paceColor(tp, tt) : 'neutral';
  const worstColor = present && snapshot ? worstPaceColor(snapshot) : 'neutral';
  const shortReset = present ? formatShortReset(display!.resetAt, i18n.language) : '';
  const fullReset = present ? formatFullReset(display!.resetAt, i18n.language) : '';
  const winLabel = windowShortLabel(display?.windowId || display?.periodType);

  const tooltip = useMemo(() => {
    if (!present) {
      return snapshot?.message
        || t('chat.geminiPlanUsage.unavailable', { defaultValue: 'Usage unavailable' });
    }
    const pct = Math.round(tp);
    const period = display?.periodType || display?.windowId || 'limit';
    const lines: string[] = [];
    if (fullReset) {
      lines.push(
        t('chat.geminiPlanUsage.tooltipWindowWithReset', {
          period,
          percent: pct,
          value: fullReset,
          defaultValue: '{{period}} {{percent}}% · Resets {{value}}',
        }),
      );
    } else {
      lines.push(
        t('chat.geminiPlanUsage.tooltipWindow', {
          period,
          percent: pct,
          defaultValue: '{{period}} {{percent}}%',
        }),
      );
    }
    if (windows.length > 1) {
      const others = windows
        .map((w) => `${w.id} ${Math.round(w.usedPct)}%`)
        .join(' · ');
      lines.push(others);
      if (worstColor !== color && worstColor !== 'neutral' && worstColor !== 'green') {
        lines.push(
          t('chat.geminiPlanUsage.worstHint', {
            color: worstColor,
            defaultValue: 'Dot shows worst window ({{color}})',
          }),
        );
      }
      lines.push(
        t('chat.geminiPlanUsage.clickToSwitch', {
          defaultValue: 'Click period label to switch window',
        }),
      );
    }
    if (snapshot?.workerId) {
      lines.push(snapshot.workerId);
    }
    return lines.join('\n');
  }, [present, snapshot?.message, snapshot?.workerId, tp, fullReset, display, windows, worstColor, color, t]);

  if (status === 'idle') return null;

  if (!present && status === 'loading') {
    return (
      <div
        className="gemini-plan-usage loading has-tooltip"
        data-tooltip={t('chat.geminiPlanUsage.loading', { defaultValue: 'Loading usage…' })}
        aria-label={t('chat.geminiPlanUsage.loading', { defaultValue: 'Loading usage…' })}
      >
        <span className="gemini-plan-usage-label">…</span>
      </div>
    );
  }

  if (!present) {
    return (
      <div
        className="gemini-plan-usage unavailable has-tooltip"
        data-tooltip={tooltip}
        aria-label={tooltip}
      >
        <span className="gemini-plan-usage-label">
          {t('chat.geminiPlanUsage.dash', { defaultValue: 'Usage —' })}
        </span>
      </div>
    );
  }

  const fillWidth = `${tp}%`;
  const rounded = Math.round(tp);
  const labelPct = tp > 0 && rounded === 0 ? '<1%' : `${rounded}%`;

  return (
    <div
      className={`gemini-plan-usage pace-${color} has-tooltip`}
      data-tooltip={tooltip}
      aria-label={tooltip}
    >
      <div className="gemini-plan-usage-bar" aria-hidden>
        <div className="gemini-plan-usage-fill" style={{ width: fillWidth }} />
      </div>
      <span className="gemini-plan-usage-pct">{labelPct}</span>
      {canSwitch || winLabel !== '·' ? (
        <button
          type="button"
          className={`gemini-plan-usage-window${canSwitch ? ' switchable' : ''}`}
          onClick={onCycleWindow}
          disabled={!canSwitch}
          title={
            canSwitch
              ? t('chat.geminiPlanUsage.clickToSwitch', {
                defaultValue: 'Click to switch weekly / monthly',
              })
              : undefined
          }
        >
          {winLabel}
        </button>
      ) : null}
      {shortReset ? (
        <span className="gemini-plan-usage-reset">{shortReset}</span>
      ) : null}
      {/* Worst pace across all windows — after reset date */}
      <span
        className={`gemini-plan-usage-worst-dot pace-${worstColor}`}
        aria-hidden
        title={
          worstColor !== 'neutral'
            ? t('chat.geminiPlanUsage.worstDot', {
              color: worstColor,
              defaultValue: 'Worst window: {{color}}',
            })
            : undefined
        }
      />
    </div>
  );
});

GeminiPlanUsageIndicator.displayName = 'GeminiPlanUsageIndicator';
