import { useTranslation } from 'react-i18next';
import { useUsageStatistics } from './UsageStatistics/useUsageStatistics.js';
import { UsageOverviewTab } from './UsageStatistics/UsageOverviewTab.js';
import { UsageModelsTab } from './UsageStatistics/UsageModelsTab.js';
import { UsageSessionsTab } from './UsageStatistics/UsageSessionsTab.js';
import { UsageTimelineTab } from './UsageStatistics/UsageTimelineTab.js';

const UsageStatisticsSection = ({ currentProvider }: { currentProvider?: string }) => {
  const { t } = useTranslation();
  const {
    statistics, loading, activeTab, projectScope, dateRange,
    sessionPage, sessionSortBy, tooltip, sessionsPerPage,
    filteredSessions, paginatedSessions, totalPages, filteredDailyUsage,
    grokBilling, activityNote, billingUnavailable, tokensFromLedger,
    setActiveTab, setDateRange, setSessionPage, setSessionSortBy, setTooltip,
    handleRefresh, handleScopeChange,
    formatNumber, formatCost, formatDate, formatChineseDate,
    formatRelativeTime, renderTrend, getTokenPercentage,
  } = useUsageStatistics(currentProvider);

  const isGrok = currentProvider === 'grok';

  if (loading && !statistics) {
    return (
      <div className="usage-statistics-section">
        <div className="loading-container">
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <p>{t('usage.loading')}</p>
        </div>
      </div>
    );
  }

  if (!statistics) {
    return (
      <div className="usage-statistics-section">
        <div className="empty-container">
          <span className="codicon codicon-graph" />
          <p>{t('usage.noData')}</p>
          <button onClick={handleRefresh} className="btn-primary">
            <span className="codicon codicon-refresh" />
            {t('usage.loadData')}
          </button>
        </div>
      </div>
    );
  }

  const hasBilling =
    isGrok &&
    grokBilling &&
    typeof grokBilling === 'object' &&
    !(grokBilling as { unavailable?: boolean }).unavailable;

  return (
    <div className="usage-statistics-section">
      {/* Honest notices */}
      {isGrok ? (
        <div className="notice-box notice-box--info">
          <span className="codicon codicon-info" />
          {activityNote ||
            t('usage.grokActivityNotice', {
              defaultValue:
                'Grok stats are local session activity. Token totals only for turns through this plugin. Not an xAI invoice.',
            })}
        </div>
      ) : (
        <div className="notice-box notice-box--warning">
          <span className="codicon codicon-warning" />
          {t('usage.estimateNotice')}
        </div>
      )}

      {isGrok && billingUnavailable && (
        <div className="notice-box notice-box--warning" style={{ marginTop: 8 }}>
          <span className="codicon codicon-warning" />
          {t('usage.grokBillingUnavailable', {
            defaultValue: 'Live billing unavailable',
          })}
          {': '}
          {billingUnavailable}
        </div>
      )}

      {isGrok && statistics.totalSessions === 0 && (
        <div className="empty-container" style={{ marginBottom: 12 }}>
          <span className="codicon codicon-inbox" />
          <p>
            {t('usage.grokNoSessions', {
              defaultValue:
                'No Grok sessions for this scope yet. Chat with Grok in the plugin or CLI, then refresh.',
            })}
          </p>
        </div>
      )}

      {/* Optional live billing panel (does not replace activity tabs) */}
      {hasBilling && (
        <div className="grok-billing-panel" style={{ marginBottom: 12 }}>
          <h3>
            {t('usage.grokBilling', { defaultValue: 'Grok live billing' })}
          </h3>
          <div className="billing-cards">
            {(grokBilling as any).creditUsagePercent !== undefined && (
              <div className="billing-card">
                <div className="label">Weekly limit</div>
                <div className="value">{(grokBilling as any).creditUsagePercent}%</div>
              </div>
            )}
            {(grokBilling as any).credits !== undefined && (
              <div className="billing-card">
                <div className="label">Credits</div>
                <div className="value">${(grokBilling as any).credits}</div>
              </div>
            )}
            {(grokBilling as any).prepaidBalance?.val !== undefined && (
              <div className="billing-card">
                <div className="label">Prepaid</div>
                <div className="value">${(grokBilling as any).prepaidBalance.val}</div>
              </div>
            )}
            {(grokBilling as any).nextReset && (
              <div className="billing-card">
                <div className="label">Next reset</div>
                <div className="value">{(grokBilling as any).nextReset}</div>
              </div>
            )}
            {(grokBilling as any).autoTopup !== undefined && (
              <div className="billing-card">
                <div className="label">Auto topup</div>
                <div className="value">{(grokBilling as any).autoTopup ? 'enabled' : 'disabled'}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Controls bar */}
      <div className="usage-controls">
        <div className="controls-left">
          <div className="scope-selector">
            <button
              className={`scope-btn ${projectScope === 'current' ? 'active' : ''}`}
              onClick={() => handleScopeChange('current')}
            >
              <span className="codicon codicon-folder" />
              {t('usage.currentProject')}
            </button>
            <button
              className={`scope-btn ${projectScope === 'all' ? 'active' : ''}`}
              onClick={() => handleScopeChange('all')}
            >
              <span className="codicon codicon-folder-library" />
              {t('usage.allProjects')}
            </button>
          </div>

          <div className="date-range-selector">
            <button
              className={`range-btn ${dateRange === '7d' ? 'active' : ''}`}
              onClick={() => setDateRange('7d')}
            >
              {t('usage.last7Days')}
            </button>
            <button
              className={`range-btn ${dateRange === '30d' ? 'active' : ''}`}
              onClick={() => setDateRange('30d')}
            >
              {t('usage.last30Days')}
            </button>
            <button
              className={`range-btn ${dateRange === 'all' ? 'active' : ''}`}
              onClick={() => setDateRange('all')}
            >
              {t('usage.allTime')}
            </button>
          </div>
        </div>

        <button onClick={handleRefresh} className="refresh-btn icon-only" disabled={loading} title={t('usage.refreshData')}>
          <span className={`codicon codicon-refresh ${loading ? 'codicon-modifier-spin' : ''}`} />
        </button>
      </div>

      {isGrok && statistics.totalSessions > 0 && !tokensFromLedger && (
        <div className="notice-box notice-box--info" style={{ marginBottom: 8 }}>
          <span className="codicon codicon-info" />
          {t('usage.grokTokensPending', {
            defaultValue:
              'Session list is ready; token totals fill in after new Grok turns run through this plugin.',
          })}
        </div>
      )}

      {/* Always show activity tabs (including Grok) */}
      <div className="usage-tabs">
        <button className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
          <span className="codicon codicon-dashboard" />
          {t('usage.overview')}
        </button>
        <button className={`tab-btn ${activeTab === 'models' ? 'active' : ''}`} onClick={() => setActiveTab('models')}>
          <span className="codicon codicon-symbol-class" />
          {t('usage.models')}
        </button>
        <button className={`tab-btn ${activeTab === 'sessions' ? 'active' : ''}`} onClick={() => setActiveTab('sessions')}>
          <span className="codicon codicon-list-unordered" />
          {t('usage.sessions')}
        </button>
        <button className={`tab-btn ${activeTab === 'timeline' ? 'active' : ''}`} onClick={() => setActiveTab('timeline')}>
          <span className="codicon codicon-graph-line" />
          {t('usage.timeline')}
        </button>
      </div>

      <div className="usage-content">
        {activeTab === 'overview' && (
          <UsageOverviewTab
            statistics={statistics}
            formatCost={formatCost}
            formatNumber={formatNumber}
            renderTrend={renderTrend}
            getTokenPercentage={getTokenPercentage}
          />
        )}

        {activeTab === 'models' && (
          <UsageModelsTab
            models={statistics.byModel}
            formatCost={formatCost}
            formatNumber={formatNumber}
          />
        )}

        {activeTab === 'sessions' && (
          <UsageSessionsTab
            filteredSessions={filteredSessions}
            paginatedSessions={paginatedSessions}
            sessionPage={sessionPage}
            totalPages={totalPages}
            sessionsPerPage={sessionsPerPage}
            sessionSortBy={sessionSortBy}
            setSessionPage={setSessionPage}
            setSessionSortBy={setSessionSortBy}
            formatDate={formatDate}
            formatCost={formatCost}
            formatNumber={formatNumber}
          />
        )}

        {activeTab === 'timeline' && (
          <UsageTimelineTab
            filteredDailyUsage={filteredDailyUsage}
            tooltip={tooltip}
            setTooltip={setTooltip}
            formatCost={formatCost}
            formatChineseDate={formatChineseDate}
          />
        )}
      </div>

      {statistics.lastUpdated && (
        <div className="last-updated">
          <span className="codicon codicon-sync" />
          <span>{t('usage.lastUpdated')}: {formatRelativeTime(statistics.lastUpdated)}</span>
        </div>
      )}
    </div>
  );
};

export default UsageStatisticsSection;
