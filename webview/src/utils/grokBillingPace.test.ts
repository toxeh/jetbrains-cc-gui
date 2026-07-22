import { describe, expect, it } from 'vitest';
import {
  capacityUrlFromBase,
  clampPercent,
  computeTimeBudgetPercent,
  derivePeriodStart,
  formatShortReset,
  nextWindowId,
  paceColor,
  parseCapacityPayload,
  parseCliUsagePayload,
  resolveDisplayWindow,
  resolveTimeBudget,
  windowShortLabel,
  worsePace,
  worstPaceColor,
} from './grokBillingPace';

describe('clampPercent', () => {
  it('clamps to 0–100', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(47.2)).toBe(47.2);
  });
});

describe('derivePeriodStart', () => {
  it('WEEKLY is end − 7d', () => {
    const end = new Date('2026-07-28T00:00:00Z');
    const start = derivePeriodStart(end, 'WEEKLY');
    expect(start?.toISOString()).toBe('2026-07-21T00:00:00.000Z');
  });

  it('accepts USAGE_PERIOD_TYPE_WEEKLY enum', () => {
    const end = new Date('2026-07-28T00:00:00Z');
    const start = derivePeriodStart(end, 'USAGE_PERIOD_TYPE_WEEKLY');
    expect(start?.toISOString()).toBe('2026-07-21T00:00:00.000Z');
  });

  it('monthly is end − 30d', () => {
    const end = new Date('2026-08-01T00:00:00Z');
    const start = derivePeriodStart(end, 'monthly');
    expect(start?.toISOString()).toBe('2026-07-02T00:00:00.000Z');
  });

  it('unknown type → null', () => {
    expect(derivePeriodStart(new Date(), 'DAILY')).toBeNull();
  });
});

describe('computeTimeBudgetPercent / resolveTimeBudget', () => {
  it('mid-window → TT 50', () => {
    const start = new Date('2026-07-01T00:00:00Z');
    const end = new Date('2026-07-11T00:00:00Z');
    const now = new Date('2026-07-06T00:00:00Z');
    expect(computeTimeBudgetPercent(now, start, end)).toBe(50);
  });

  it('resolve from period_type WEEKLY', () => {
    // end 2026-07-28, start = 07-21, now mid → ~50
    const now = new Date('2026-07-24T12:00:00Z');
    const tt = resolveTimeBudget(
      { resetAt: '2026-07-28T00:00:00Z', periodType: 'WEEKLY' },
      now,
    );
    expect(tt).not.toBeNull();
    expect(tt!).toBeGreaterThan(40);
    expect(tt!).toBeLessThan(60);
  });
});

describe('paceColor matrix', () => {
  it('green when TP < TT', () => {
    expect(paceColor(40, 50)).toBe('green');
  });

  it('yellow when TT ≤ TP ≤ TT+5', () => {
    expect(paceColor(50, 50)).toBe('yellow');
    expect(paceColor(52, 50)).toBe('yellow');
    expect(paceColor(55, 50)).toBe('yellow');
  });

  it('red when TP > TT+5', () => {
    expect(paceColor(56, 50)).toBe('red');
    expect(paceColor(90, 50)).toBe('red');
  });

  it('neutral without TT', () => {
    expect(paceColor(40, null)).toBe('neutral');
  });
});

describe('parseCapacityPayload', () => {
  it('happy path', () => {
    const s = parseCapacityPayload({
      ok: true,
      present: true,
      capacity_pct: 47.5,
      reset_at: '2026-07-28T00:00:00Z',
      period_type: 'WEEKLY',
      source: 'local-agent',
    });
    expect(s.present).toBe(true);
    expect(s.capacityPct).toBe(47.5);
    expect(s.resetAt).toBe('2026-07-28T00:00:00Z');
    expect(s.periodType).toBe('WEEKLY');
  });

  it('parses windows[] and allows weekly selection', () => {
    const s = parseCapacityPayload({
      ok: true,
      present: true,
      used_pct: 12,
      capacity_pct: 12,
      reset_at: '2026-07-22T15:21:57Z',
      period_type: 'weekly',
      windows: [
        { id: 'weekly', used_pct: 12, reset_at: '2026-07-22T15:21:57Z', period_type: 'weekly' },
        { id: 'monthly', used_pct: 4.57, reset_at: '2026-08-01T00:00:00Z', period_type: 'monthly' },
      ],
      source: 'gateway',
    });
    expect(s.windows).toHaveLength(2);
    const weekly = resolveDisplayWindow(s, 'weekly');
    expect(weekly.capacityPct).toBe(12);
    expect(weekly.resetAt).toBe('2026-07-22T15:21:57Z');
    const monthly = resolveDisplayWindow(s, 'monthly');
    expect(monthly.capacityPct).toBe(4.57);
    expect(monthly.resetAt).toBe('2026-08-01T00:00:00Z');
  });

  it('unavailable', () => {
    const s = parseCapacityPayload({ ok: true, present: false, message: 'down' });
    expect(s.present).toBe(false);
    expect(s.message).toBe('down');
  });
});

describe('parseCliUsagePayload', () => {
  it('nested config creditUsagePercent', () => {
    const s = parseCliUsagePayload({
      success: true,
      data: {
        config: {
          creditUsagePercent: 33,
          currentPeriod: { type: 'WEEKLY', start: '2026-07-21T00:00:00Z', end: '2026-07-28T00:00:00Z' },
        },
      },
    });
    expect(s.present).toBe(true);
    expect(s.capacityPct).toBe(33);
    expect(s.resetAt).toBe('2026-07-28T00:00:00Z');
    expect(s.periodStart).toBe('2026-07-21T00:00:00Z');
  });
});

describe('capacityUrlFromBase', () => {
  it('strips path to origin + /capacity', () => {
    expect(capacityUrlFromBase('http://127.0.0.1:18790/v1')).toBe(
      'http://127.0.0.1:18790/capacity',
    );
    expect(capacityUrlFromBase('http://127.0.0.1:18790/grok/v1')).toBe(
      'http://127.0.0.1:18790/capacity',
    );
  });

  it('empty → null', () => {
    expect(capacityUrlFromBase('')).toBeNull();
    expect(capacityUrlFromBase(null)).toBeNull();
  });
});

describe('formatShortReset', () => {
  it('includes day, month, and 24h time (local TZ) with trailing period', () => {
    // Fixed ISO midnight UTC — local hours depend on TZ, but shape is stable.
    const s = formatShortReset('2026-08-01T00:00:00Z', 'en-GB');
    expect(s).toMatch(/\d/);
    expect(s).toMatch(/:/);
    // 24h: hour part 00–23, not am/pm
    expect(s.toLowerCase()).not.toMatch(/\bam\b|\bpm\b/);
    expect(s.endsWith('.')).toBe(true);
  });
});

describe('window helpers', () => {
  it('windowShortLabel maps weekly/monthly', () => {
    expect(windowShortLabel('weekly')).toBe('7d');
    expect(windowShortLabel('monthly')).toBe('mo');
    expect(windowShortLabel('5h')).toBe('5h');
  });

  it('nextWindowId cycles', () => {
    const wins = [
      { id: 'weekly', usedPct: 12 },
      { id: 'monthly', usedPct: 4 },
    ];
    expect(nextWindowId(wins, 'weekly')).toBe('monthly');
    expect(nextWindowId(wins, 'monthly')).toBe('weekly');
  });
});

describe('worstPaceColor', () => {
  it('worsePace ranks red highest', () => {
    expect(worsePace('green', 'yellow')).toBe('yellow');
    expect(worsePace('yellow', 'red')).toBe('red');
    expect(worsePace('green', 'neutral')).toBe('green');
  });

  it('dot is red if any window is red even when selected is green', () => {
    // weekly: TP 10, mid-window → green; monthly: TP 95, mid-window → red-ish
    const now = new Date('2026-07-25T12:00:00Z');
    const snap = parseCapacityPayload({
      present: true,
      capacity_pct: 10,
      reset_at: '2026-07-28T00:00:00Z',
      period_type: 'weekly',
      windows: [
        {
          id: 'weekly',
          used_pct: 10,
          reset_at: '2026-07-28T00:00:00Z',
          period_type: 'weekly',
        },
        {
          id: 'monthly',
          used_pct: 95,
          reset_at: '2026-08-01T00:00:00Z',
          period_type: 'monthly',
        },
      ],
    });
    expect(worstPaceColor(snap, now)).toBe('red');
    // selected weekly alone would be green
    const weeklyTt = resolveTimeBudget(
      { resetAt: '2026-07-28T00:00:00Z', periodType: 'weekly' },
      now,
    );
    expect(paceColor(10, weeklyTt)).toBe('green');
  });
});
