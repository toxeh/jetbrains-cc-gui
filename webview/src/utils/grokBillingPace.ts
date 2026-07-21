/**
 * Grok plan-usage pace coloring for ContextBar.
 * TP = actual usage %, TT = linear time budget through the reset window.
 */

export type GrokPaceColor = 'green' | 'yellow' | 'red' | 'neutral';

export interface GrokPlanUsageSnapshot {
  present: boolean;
  /** Usage percent 0–100 (TP). */
  capacityPct?: number;
  /** Period end / next reset (ISO or parseable date string). */
  resetAt?: string | null;
  /** Period start when known. */
  periodStart?: string | null;
  /** WEEKLY | monthly | MONTHLY | … */
  periodType?: string | null;
  source?: string;
  message?: string;
}

const YELLOW_BAND = 5;

/** Clamp number to [0, 100]. */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Derive period start from end + period_type when start is missing.
 * WEEKLY → end − 7d; monthly/MONTHLY → end − 30d.
 */
export function derivePeriodStart(
  resetAt: Date,
  periodType?: string | null,
): Date | null {
  // Accept raw enums too, e.g. USAGE_PERIOD_TYPE_WEEKLY from xAI billing.
  const t = (periodType || '').toUpperCase();
  if (t === 'WEEKLY' || t === 'WEEK' || t.includes('WEEK')) {
    return new Date(resetAt.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  if (t === 'MONTHLY' || t === 'MONTH' || t.includes('MONTH')) {
    return new Date(resetAt.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return null;
}

export function parseDate(value?: string | null): Date | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * TT = linear time progress through [start, end], 0–100.
 * Returns null when window cannot be determined.
 */
export function computeTimeBudgetPercent(
  now: Date,
  periodStart?: Date | null,
  periodEnd?: Date | null,
): number | null {
  if (!periodStart || !periodEnd) return null;
  const start = periodStart.getTime();
  const end = periodEnd.getTime();
  if (!(end > start)) return null;
  const t = now.getTime();
  return clampPercent(((t - start) / (end - start)) * 100);
}

/**
 * Resolve TT from snapshot fields (explicit start or period_type).
 */
export function resolveTimeBudget(
  snapshot: Pick<GrokPlanUsageSnapshot, 'resetAt' | 'periodStart' | 'periodType'>,
  now: Date = new Date(),
): number | null {
  const end = parseDate(snapshot.resetAt ?? null);
  if (!end) return null;
  let start = parseDate(snapshot.periodStart ?? null);
  if (!start) {
    start = derivePeriodStart(end, snapshot.periodType);
  }
  return computeTimeBudgetPercent(now, start, end);
}

/**
 * Pace color: TP < TT green; TT ≤ TP ≤ TT+5 yellow; TP > TT+5 red; no TT → neutral.
 */
export function paceColor(tp: number, tt: number | null): GrokPaceColor {
  if (tt === null || !Number.isFinite(tt)) return 'neutral';
  const usage = clampPercent(tp);
  const budget = clampPercent(tt);
  if (usage < budget) return 'green';
  if (usage <= budget + YELLOW_BAND) return 'yellow';
  return 'red';
}

/** Short date for the bar label (locale-aware). */
export function formatShortReset(resetAt?: string | null, locale?: string): string {
  const d = parseDate(resetAt ?? null);
  if (!d) return '';
  try {
    return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Full datetime for tooltip. */
export function formatFullReset(resetAt?: string | null, locale?: string): string {
  const d = parseDate(resetAt ?? null);
  if (!d) return '';
  try {
    return d.toLocaleString(locale);
  } catch {
    return d.toISOString();
  }
}

/**
 * Build capacity URL from configured base (oauth/api) origin.
 * e.g. http://127.0.0.1:18790/v1 → http://127.0.0.1:18790/capacity
 */
export function capacityUrlFromBase(baseUrl?: string | null): string | null {
  const raw = String(baseUrl || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.protocol.startsWith('http')) return null;
    return `${u.protocol}//${u.host}/capacity`;
  } catch {
    return null;
  }
}

/** Normalize local-agent / gateway capacity JSON into a snapshot. */
export function parseCapacityPayload(data: unknown): GrokPlanUsageSnapshot {
  if (!data || typeof data !== 'object') {
    return { present: false, message: 'invalid capacity payload' };
  }
  const o = data as Record<string, unknown>;
  if (o.present === false || o.unavailable === true) {
    return {
      present: false,
      message: typeof o.message === 'string' ? o.message : 'capacity unavailable',
      source: typeof o.source === 'string' ? o.source : undefined,
    };
  }
  const pctRaw = o.capacity_pct ?? o.used_pct ?? o.capacityPct;
  const pct = typeof pctRaw === 'number' ? pctRaw : Number(pctRaw);
  if (!Number.isFinite(pct)) {
    return {
      present: false,
      message: 'capacity missing capacity_pct',
      source: typeof o.source === 'string' ? o.source : undefined,
    };
  }
  return {
    present: true,
    capacityPct: clampPercent(pct),
    resetAt: typeof o.reset_at === 'string' ? o.reset_at : typeof o.resetAt === 'string' ? o.resetAt : null,
    periodType: typeof o.period_type === 'string' ? o.period_type : typeof o.periodType === 'string' ? o.periodType : null,
    periodStart: typeof o.period_start === 'string' ? o.period_start : null,
    source: typeof o.source === 'string' ? o.source : 'gateway',
  };
}

/** Normalize CLI /usage (or Settings flatten) into a snapshot. */
export function parseCliUsagePayload(data: unknown): GrokPlanUsageSnapshot {
  if (!data || typeof data !== 'object') {
    return { present: false, message: 'invalid usage payload' };
  }
  let o = data as Record<string, unknown>;
  // Bridge envelope { success, data }
  if (o.data && typeof o.data === 'object') {
    o = o.data as Record<string, unknown>;
  }
  if (o.unavailable === true) {
    return {
      present: false,
      message: typeof o.message === 'string' ? o.message : 'usage unavailable',
      source: 'cli',
    };
  }
  // Nested config shape from grok /usage
  const config = (o.config && typeof o.config === 'object' ? o.config : o) as Record<string, unknown>;
  const pctRaw =
    config.creditUsagePercent ??
    o.creditUsagePercent ??
    config.weeklyLimitPercent ??
    o.capacity_pct;
  const pct = typeof pctRaw === 'number' ? pctRaw : Number(pctRaw);
  if (!Number.isFinite(pct)) {
    return { present: false, message: 'usage missing creditUsagePercent', source: 'cli' };
  }
  const period = (config.currentPeriod && typeof config.currentPeriod === 'object'
    ? config.currentPeriod
    : o.currentPeriod && typeof o.currentPeriod === 'object'
      ? o.currentPeriod
      : null) as Record<string, unknown> | null;
  const resetAt =
    (typeof o.nextReset === 'string' && o.nextReset) ||
    (period && typeof period.end === 'string' ? period.end : null);
  const periodStart = period && typeof period.start === 'string' ? period.start : null;
  const periodType = period && typeof period.type === 'string' ? period.type : null;
  return {
    present: true,
    capacityPct: clampPercent(pct),
    resetAt,
    periodStart,
    periodType,
    source: 'cli',
  };
}
