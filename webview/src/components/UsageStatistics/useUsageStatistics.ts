/**
 * Hook for usage statistics data loading, filtering, and formatting.
 */
import { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { sendToJava } from '../../utils/bridge.js';
import { debugLog } from '../../utils/debug';
import type { ProjectStatistics, DailyUsage } from '../../types/usage';

export type TabType = 'overview' | 'models' | 'sessions' | 'timeline';
export type ScopeType = 'current' | 'all';
export type DateRangeType = '7d' | '30d' | 'all';

/** Ensure partial backend payloads never leave required arrays/objects undefined. */
function normalizeProjectStatistics(data: Partial<ProjectStatistics> | null | undefined): ProjectStatistics | null {
  if (!data || typeof data !== 'object') return null;
  return {
    ...data,
    sessions: data.sessions ?? [],
    totalSessions: data.totalSessions ?? 0,
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      ...(data.totalUsage ?? {}),
    },
    estimatedCost: data.estimatedCost ?? 0,
    dailyUsage: data.dailyUsage ?? [],
    byModel: data.byModel ?? [],
    weeklyComparison: data.weeklyComparison ?? {
      currentWeek: { sessions: 0, cost: 0, tokens: 0 },
      lastWeek: { sessions: 0, cost: 0, tokens: 0 },
      trends: { sessions: 0, cost: 0, tokens: 0 },
    },
    provider: data.provider,
    source: data.source,
    activityNote: data.activityNote,
    tokensFromLedger: data.tokensFromLedger,
    grokBilling: data.grokBilling ?? null,
    billingUnavailable: data.billingUnavailable,
  } as ProjectStatistics;
}

export function useUsageStatistics(currentProvider?: string) {
  const { t } = useTranslation();
  const [statistics, setStatistics] = useState<ProjectStatistics | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [projectScope, setProjectScope] = useState<ScopeType>('current');
  const [dateRange, setDateRange] = useState<DateRangeType>('7d');
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionSortBy, setSessionSortBy] = useState<'cost' | 'time'>('cost');
  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    content: { date: string; cost: number; sessions: number };
  }>({
    visible: false,
    x: 0,
    y: 0,
    content: { date: '', cost: 0, sessions: 0 }
  });
  const sessionsPerPage = 20;
  const isFirstMount = useRef(true);

  const loadStatistics = useCallback(() => {
    setLoading(true);
    sendToJava('get_usage_statistics', {
      scope: projectScope,
      provider: currentProvider || 'claude',
      dateRange: dateRange
    });
  }, [projectScope, currentProvider, dateRange]);

  useEffect(() => {
    window.updateUsageStatistics = (jsonStr: string) => {
      try {
        const data: any = JSON.parse(jsonStr);

        // Billing-only enrichment patch (after activity stats already loaded).
        if (data && data.billingEnrichment) {
          setStatistics((prev) => {
            if (!prev) {
              return normalizeProjectStatistics({
                sessions: [],
                totalSessions: 0,
                totalUsage: { totalTokens: 0 } as ProjectStatistics['totalUsage'],
                estimatedCost: 0,
                dailyUsage: [],
                provider: 'grok',
                grokBilling: data.grokBilling ?? null,
                billingUnavailable: data.billingUnavailable,
              } as Partial<ProjectStatistics>);
            }
            return {
              ...prev,
              grokBilling: data.grokBilling ?? prev.grokBilling ?? null,
              billingUnavailable: data.billingUnavailable ?? prev.billingUnavailable,
            };
          });
          setLoading(false);
          return;
        }

        // Legacy pure /usage CLI payload (no sessions array) — treat as billing attach.
        const looksLikeActivity =
          Array.isArray(data?.sessions) ||
          typeof data?.totalSessions === 'number' ||
          data?.source === 'local-activity';
        if (data && (data.data || data.output) && !looksLikeActivity) {
          let grokData = data.data || { raw: data.output };
          if (grokData && grokData.config) {
            const c = grokData.config;
            grokData = {
              ...grokData,
              creditUsagePercent: c.creditUsagePercent,
              currentPeriod: c.currentPeriod,
              prepaidBalance: c.prepaidBalance,
              productUsage: c.productUsage,
              onDemandCap: c.onDemandCap,
              onDemandUsed: c.onDemandUsed,
              isUnifiedBillingUser: c.isUnifiedBillingUser,
              topUpMethod: c.topUpMethod,
              weeklyLimitPercent: c.creditUsagePercent,
              credits: c.prepaidBalance?.val,
              nextReset: c.currentPeriod?.end,
              autoTopup: grokData.autoTopup,
            };
          }
          console.log('[Grok /usage]', grokData);
          setStatistics((prev) => {
            const base = prev ?? normalizeProjectStatistics({
              sessions: [],
              totalSessions: 0,
              totalUsage: { totalTokens: 0 } as ProjectStatistics['totalUsage'],
              estimatedCost: 0,
              dailyUsage: [],
              provider: 'grok',
            } as Partial<ProjectStatistics>);
            if (!base) return null;
            if (grokData && grokData.unavailable) {
              return {
                ...base,
                provider: 'grok',
                billingUnavailable: grokData.message || 'Grok billing unavailable',
                grokBilling: null,
              };
            }
            return {
              ...base,
              provider: 'grok',
              grokBilling: grokData,
              billingUnavailable: undefined,
            };
          });
          setLoading(false);
          return;
        }

        // Normalize nested billing if backend embedded config shape
        if (data?.grokBilling?.config) {
          const c = data.grokBilling.config;
          data.grokBilling = {
            ...data.grokBilling,
            creditUsagePercent: c.creditUsagePercent,
            credits: c.prepaidBalance?.val,
            nextReset: c.currentPeriod?.end,
            prepaidBalance: c.prepaidBalance,
            productUsage: c.productUsage,
            weeklyLimitPercent: c.creditUsagePercent,
          };
        }

        setStatistics(normalizeProjectStatistics(data));
        setLoading(false);
      } catch (error) {
        console.error('Failed to parse usage statistics:', error);
        setLoading(false);
      }
    };

    if (isFirstMount.current && window.__pendingUsageStatistics) {
      debugLog('[UsageStatisticsSection] Found pending usage statistics, applying...');
      try {
        const data = JSON.parse(window.__pendingUsageStatistics);
        setStatistics(normalizeProjectStatistics(data));
        setLoading(false);
      } catch (error) {
        console.error('Failed to parse pending usage statistics:', error);
        loadStatistics();
      }
      window.__pendingUsageStatistics = undefined;
    } else {
      loadStatistics();
    }

    isFirstMount.current = false;
  }, [loadStatistics]);

  const handleRefresh = () => { loadStatistics(); };

  const handleScopeChange = (scope: ScopeType) => {
    setProjectScope(scope);
    setSessionPage(1);
  };

  // ---- Formatting utilities ----

  const formatNumber = (num: number): string => {
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toString();
  };

  const formatCost = (cost: number): string => `$${cost.toFixed(4)}`;

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t('usage.today');
    if (diffDays === 1) return t('usage.yesterday');
    if (diffDays < 7) return `${diffDays}${t('usage.daysAgo')}`;

    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  const formatChineseDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  };

  const formatRelativeTime = (timestamp: number): string => {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffSec < 60) return t('usage.justNow');
    if (diffMin < 60) return `${diffMin}${t('usage.minutesAgo')}`;
    if (diffHour < 24) return `${diffHour}${t('usage.hoursAgo')}`;

    return formatDate(timestamp);
  };

  const renderTrend = (value: number) => {
    if (value === 0) return { className: 'trend neutral', text: `→ 0% ${t('usage.comparedToLastWeek')}` };
    const isUp = value > 0;
    return {
      className: `trend ${isUp ? 'up' : 'down'}`,
      text: `${isUp ? '↑' : '↓'} ${Math.abs(value).toFixed(1)}% ${t('usage.comparedToLastWeek')}`
    };
  };

  const getTokenPercentage = (value: number): number => {
    const totalTokens = statistics?.totalUsage?.totalTokens ?? 0;
    if (!statistics || totalTokens === 0) return 0;
    return (value / totalTokens) * 100;
  };

  // ---- Filtering ----

  const filterByDateRange = <T extends { timestamp?: number; date?: string }>(
    items: T[] | undefined | null,
    range: DateRangeType
  ): T[] => {
    const list = items ?? [];
    if (range === 'all') return list;
    const now = Date.now();
    const cutoff = range === '7d'
      ? now - 7 * 24 * 60 * 60 * 1000
      : now - 30 * 24 * 60 * 60 * 1000;
    return list.filter(item => {
      const time = item.timestamp || new Date(item.date!).getTime();
      return time >= cutoff;
    });
  };

  const filteredSessions = filterByDateRange(statistics?.sessions, dateRange).slice().sort((a, b) => {
    if (sessionSortBy === 'cost') return b.cost - a.cost;
    return b.timestamp - a.timestamp;
  });

  const paginatedSessions = filteredSessions.slice(
    (sessionPage - 1) * sessionsPerPage,
    sessionPage * sessionsPerPage
  );

  const totalPages = Math.ceil(filteredSessions.length / sessionsPerPage);

  const getFilteredDailyUsage = (): DailyUsage[] => {
    if (!statistics) return [];
    const dailyUsage = statistics.dailyUsage ?? [];
    if (dateRange === 'all') return dailyUsage;

    const now = Date.now();
    const cutoffDate = dateRange === '7d'
      ? now - 7 * 24 * 60 * 60 * 1000
      : now - 30 * 24 * 60 * 60 * 1000;

    return dailyUsage.filter(day => new Date(day.date).getTime() >= cutoffDate);
  };

  const filteredDailyUsage = getFilteredDailyUsage();

  const grokBilling = statistics?.grokBilling ?? null;
  const activityNote = statistics?.activityNote;
  const billingUnavailable = statistics?.billingUnavailable;
  const tokensFromLedger = !!statistics?.tokensFromLedger;

  return {
    // State
    statistics, loading, activeTab, projectScope, dateRange,
    sessionPage, sessionSortBy, tooltip, sessionsPerPage,
    // Derived
    filteredSessions, paginatedSessions, totalPages, filteredDailyUsage,
    grokBilling, activityNote, billingUnavailable, tokensFromLedger,
    // Actions
    setActiveTab, setDateRange, setSessionPage, setSessionSortBy, setTooltip,
    handleRefresh, handleScopeChange,
    // Formatters
    formatNumber, formatCost, formatDate, formatChineseDate,
    formatRelativeTime, renderTrend, getTokenPercentage,
  };
}
