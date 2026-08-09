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
  type GrokPlanUsageSnapshot,
} from '../../utils/grokBillingPace';

export interface GrokPlanUsageIndicatorProps {
  snapshot: GrokPlanUsageSnapshot | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
}

/**
 * Layout D: mini progress bar + % + window switcher + short reset.
 * Click the window chip (7d / mo) to cycle weekly ↔ monthly (or 5h ↔ 7d).
 */
export const GrokPlanUsageIndicator: React.FC<GrokPlanUsageIndicatorProps> = memo(({
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
        || t('chat.grokPlanUsage.unavailable', { defaultValue: 'Usage unavailable' });
    }
    const pct = Math.round(tp);
    const period = display?.periodType || display?.windowId || 'limit';
    const lines: string[] = [];
    if (fullReset) {
      lines.push(
        t('chat.grokPlanUsage.tooltipWindowWithReset', {
          period,
          percent: pct,
          value: fullReset,
          defaultValue: '{{period}} {{percent}}% · Resets {{value}}',
        }),
      );
    } else {
      lines.push(
        t('chat.grokPlanUsage.tooltipWindow', {
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
          t('chat.grokPlanUsage.worstHint', {
            color: worstColor,
            defaultValue: 'Dot shows worst window ({{color}})',
          }),
        );
      }
      lines.push(
        t('chat.grokPlanUsage.clickToSwitch', {
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
        className="grok-plan-usage loading has-tooltip"
        data-tooltip={t('chat.grokPlanUsage.loading', { defaultValue: 'Loading usage…' })}
        aria-label={t('chat.grokPlanUsage.loading', { defaultValue: 'Loading usage…' })}
      >
        <span className="grok-plan-usage-label">…</span>
      </div>
    );
  }

  if (!present) {
    return (
      <div
        className="grok-plan-usage unavailable has-tooltip"
        data-tooltip={tooltip}
        aria-label={tooltip}
      >
        <span className="grok-plan-usage-label">
          {t('chat.grokPlanUsage.dash', { defaultValue: 'Usage —' })}
        </span>
      </div>
    );
  }

  const fillWidth = `${tp}%`;
  const rounded = Math.round(tp);
  const labelPct = tp > 0 && rounded === 0 ? '<1%' : `${rounded}%`;

  return (
    <div
      className={`grok-plan-usage pace-${color} has-tooltip`}
      data-tooltip={tooltip}
      aria-label={tooltip}
    >
      <div className="grok-plan-usage-bar" aria-hidden>
        <div className="grok-plan-usage-fill" style={{ width: fillWidth }} />
      </div>
      <span className="grok-plan-usage-pct">{labelPct}</span>
      {canSwitch || winLabel !== '·' ? (
        <button
          type="button"
          className={`grok-plan-usage-window${canSwitch ? ' switchable' : ''}`}
          onClick={onCycleWindow}
          disabled={!canSwitch}
          title={
            canSwitch
              ? t('chat.grokPlanUsage.clickToSwitch', {
                defaultValue: 'Click to switch weekly / monthly',
              })
              : undefined
          }
        >
          {winLabel}
        </button>
      ) : null}
      {shortReset ? (
        <span className="grok-plan-usage-reset">{shortReset}</span>
      ) : null}
      {/* Worst pace across all windows — after reset date */}
      <span
        className={`grok-plan-usage-worst-dot pace-${worstColor}`}
        aria-hidden
        title={
          worstColor !== 'neutral'
            ? t('chat.grokPlanUsage.worstDot', {
              color: worstColor,
              defaultValue: 'Worst window: {{color}}',
            })
            : undefined
        }
      />
    </div>
  );
});

GrokPlanUsageIndicator.displayName = 'GrokPlanUsageIndicator';
