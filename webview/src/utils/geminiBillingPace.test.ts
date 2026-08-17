import { describe, expect, it } from 'vitest';
import {
  parseCapacityPayload,
  resolveGeminiQuotaFamily,
  selectGeminiPlanFamily,
  windowShortLabel,
} from './geminiBillingPace';

const dualFamilyPayload = {
  ok: true,
  present: true,
  provider: 'gemini',
  source: 'agy-usage-probe',
  default_family: 'gemini',
  capacity_pct: 25,
  reset_at: '2026-08-05T18:15:50Z',
  period_type: '5h',
  windows: [
    { id: '5h', used_pct: 25, reset_at: '2026-08-05T18:15:50Z', period_type: '5h' },
    { id: '7d', used_pct: 10, reset_at: '2026-08-11T23:37:11Z', period_type: '7d' },
  ],
  families: {
    gemini: {
      capacity_pct: 25,
      reset_at: '2026-08-05T18:15:50Z',
      period_type: '5h',
      windows: [
        { id: '5h', used_pct: 25, reset_at: '2026-08-05T18:15:50Z', period_type: '5h' },
        { id: '7d', used_pct: 10, reset_at: '2026-08-11T23:37:11Z', period_type: '7d' },
      ],
    },
    third_party: {
      capacity_pct: 75,
      reset_at: '2026-08-05T18:55:52Z',
      period_type: '5h',
      windows: [
        { id: '5h', used_pct: 75, reset_at: '2026-08-05T18:55:52Z', period_type: '5h' },
        { id: '7d', used_pct: 50, reset_at: '2026-08-06T02:22:27Z', period_type: '7d' },
      ],
    },
  },
};

describe('resolveGeminiQuotaFamily', () => {
  it('maps gemini slugs to gemini family', () => {
    expect(resolveGeminiQuotaFamily('gemini-3.5-flash-medium')).toBe('gemini');
    expect(resolveGeminiQuotaFamily('gemini-3.1-pro-high')).toBe('gemini');
  });

  it('maps claude/gpt slugs to third_party', () => {
    expect(resolveGeminiQuotaFamily('claude-sonnet-4-6')).toBe('third_party');
    expect(resolveGeminiQuotaFamily('claude-opus-4-6-thinking')).toBe('third_party');
    expect(resolveGeminiQuotaFamily('gpt-oss-120b-medium')).toBe('third_party');
  });
});

describe('selectGeminiPlanFamily', () => {
  it('binds gemini family for gemini models — only 5h/7d windows', () => {
    const snap = parseCapacityPayload(dualFamilyPayload);
    const bound = selectGeminiPlanFamily(snap, 'gemini-3.6-flash-high');
    expect(bound?.present).toBe(true);
    expect(bound?.capacityPct).toBe(25);
    expect(bound?.windows?.map((w) => w.id)).toEqual(['5h', '7d']);
    expect(bound?.windows?.[0].usedPct).toBe(25);
    expect(windowShortLabel(bound?.windows?.[0].id)).toBe('5h');
    expect(windowShortLabel(bound?.windows?.[1].id)).toBe('7d');
  });

  it('binds third_party family for claude/gpt models', () => {
    const snap = parseCapacityPayload(dualFamilyPayload);
    const bound = selectGeminiPlanFamily(snap, 'claude-sonnet-4-6');
    expect(bound?.capacityPct).toBe(75);
    expect(bound?.windows?.map((w) => w.id)).toEqual(['5h', '7d']);
    expect(bound?.windows?.[0].usedPct).toBe(75);
    expect(bound?.windows?.[1].usedPct).toBe(50);
  });
});
