import React, { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  clampPercent,
  formatFullReset,
  formatShortReset,
  paceColor,
  resolveTimeBudget,
  type GrokPlanUsageSnapshot,
} from '../../utils/grokBillingPace';

export interface GrokPlanUsageIndicatorProps {
  snapshot: GrokPlanUsageSnapshot | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
}

/**
 * Layout D: mini progress bar + % + short reset date.
 * Shown only by parent when provider === grok.
 */
export const GrokPlanUsageIndicator: React.FC<GrokPlanUsageIndicatorProps> = memo(({
  snapshot,
  status,
}) => {
  const { t, i18n } = useTranslation();

  const present = !!snapshot?.present && typeof snapshot.capacityPct === 'number';
  const tp = present ? clampPercent(snapshot!.capacityPct!) : 0;
  const tt = present ? resolveTimeBudget(snapshot!) : null;
  const color = present ? paceColor(tp, tt) : 'neutral';
  const shortReset = present ? formatShortReset(snapshot!.resetAt, i18n.language) : '';
  const fullReset = present ? formatFullReset(snapshot!.resetAt, i18n.language) : '';

  const tooltip = useMemo(() => {
    if (!present) {
      return snapshot?.message
        || t('chat.grokPlanUsage.unavailable', { defaultValue: 'Usage unavailable' });
    }
    const pct = Math.round(tp);
    if (fullReset) {
      return t('chat.grokPlanUsage.tooltipWithReset', {
        percent: pct,
        value: fullReset,
        defaultValue: 'Weekly limit {{percent}}% · Resets {{value}}',
      });
    }
    return t('chat.grokPlanUsage.tooltip', {
      percent: pct,
      defaultValue: 'Weekly limit {{percent}}%',
    });
  }, [present, snapshot?.message, tp, fullReset, t]);

  if (status === 'idle') return null;

  // First load: do not flash "Usage —" as if hard-failed.
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
      {shortReset ? (
        <span className="grok-plan-usage-reset">
          {t('chat.grokPlanUsage.resetShort', {
            value: shortReset,
            defaultValue: 'Reset {{value}}',
          })}
        </span>
      ) : null}
    </div>
  );
});

GrokPlanUsageIndicator.displayName = 'GrokPlanUsageIndicator';
