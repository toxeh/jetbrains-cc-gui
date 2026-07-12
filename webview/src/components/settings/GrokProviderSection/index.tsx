import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

export type GrokAuthMethod = 'oauth' | 'api_key' | 'auto';

interface GrokAuthConfig {
  authMethod: GrokAuthMethod;
  apiKey: string;
  hasApiKey: boolean;
  apiBaseUrl: string;
  oauthBaseUrl: string;
  gatewayOrigin: string;
}

const DEFAULT_CONFIG: GrokAuthConfig = {
  authMethod: 'oauth',
  apiKey: '',
  hasApiKey: false,
  apiBaseUrl: '',
  oauthBaseUrl: '',
  gatewayOrigin: '',
};

function trimSlash(s: string): string {
  return String(s || '').trim().replace(/\/+$/, '');
}

function isBareGatewayV1(url: string): boolean {
  const u = trimSlash(url);
  if (!u) return false;
  if (!/\/v1$/i.test(u)) return false;
  if (/\/(xai|grok)\/v1$/i.test(u)) return false;
  return true;
}

function expandGatewayOrigin(origin: string): { apiBaseUrl: string; oauthBaseUrl: string } {
  const o = trimSlash(origin);
  if (!o) return { apiBaseUrl: '', oauthBaseUrl: '' };
  return {
    apiBaseUrl: `${o}/xai/v1`,
    oauthBaseUrl: `${o}/grok/v1`,
  };
}

/**
 * Grok provider management panel.
 * Auth (OAuth vs API key) + ai-proxy gateway base URLs.
 */
const GrokProviderSection = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<GrokAuthConfig>(DEFAULT_CONFIG);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiBaseDraft, setApiBaseDraft] = useState('');
  const [oauthBaseDraft, setOauthBaseDraft] = useState('');
  const [gatewayOriginDraft, setGatewayOriginDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handler = (jsonStr: string) => {
      try {
        const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        const next: GrokAuthConfig = {
          authMethod: (data?.authMethod as GrokAuthMethod) || 'oauth',
          apiKey: data?.apiKey || '',
          hasApiKey: !!data?.hasApiKey,
          apiBaseUrl: data?.apiBaseUrl || '',
          oauthBaseUrl: data?.oauthBaseUrl || '',
          gatewayOrigin: data?.gatewayOrigin || '',
        };
        setConfig(next);
        setApiKeyDraft(next.apiKey);
        setApiBaseDraft(next.apiBaseUrl);
        setOauthBaseDraft(next.oauthBaseUrl);
        setGatewayOriginDraft(next.gatewayOrigin);
      } catch {
        // ignore parse errors
      }
    };
    window.updateGrokAuthConfig = handler;
    window.sendToJava?.('get_grok_auth_config:');
    return () => {
      if (window.updateGrokAuthConfig === handler) {
        delete window.updateGrokAuthConfig;
      }
    };
  }, []);

  const bareWarn = useMemo(() => {
    return isBareGatewayV1(apiBaseDraft) || isBareGatewayV1(oauthBaseDraft);
  }, [apiBaseDraft, oauthBaseDraft]);

  const save = useCallback((patch: Partial<GrokAuthConfig> & { apiKey?: string } = {}) => {
    setSaving(true);
    const next = {
      authMethod: patch.authMethod ?? config.authMethod,
      apiKey: patch.apiKey !== undefined ? patch.apiKey : apiKeyDraft,
      apiBaseUrl: patch.apiBaseUrl !== undefined ? patch.apiBaseUrl : apiBaseDraft,
      oauthBaseUrl: patch.oauthBaseUrl !== undefined ? patch.oauthBaseUrl : oauthBaseDraft,
      gatewayOrigin: patch.gatewayOrigin !== undefined ? patch.gatewayOrigin : gatewayOriginDraft,
    };
    window.sendToJava?.(
      `set_grok_auth_config:${JSON.stringify(next)}`
    );
    setConfig((prev) => ({
      ...prev,
      authMethod: next.authMethod as GrokAuthMethod,
      apiKey: next.apiKey,
      hasApiKey: !!(next.apiKey && next.apiKey.trim()),
      apiBaseUrl: next.apiBaseUrl,
      oauthBaseUrl: next.oauthBaseUrl,
      gatewayOrigin: next.gatewayOrigin,
    }));
    setTimeout(() => setSaving(false), 400);
  }, [config.authMethod, apiKeyDraft, apiBaseDraft, oauthBaseDraft, gatewayOriginDraft]);

  const onAuthChange = (method: GrokAuthMethod) => {
    save({ authMethod: method });
  };

  const applyGatewayDefaults = () => {
    const expanded = expandGatewayOrigin(gatewayOriginDraft);
    setApiBaseDraft(expanded.apiBaseUrl);
    setOauthBaseDraft(expanded.oauthBaseUrl);
    save({
      gatewayOrigin: gatewayOriginDraft,
      apiBaseUrl: expanded.apiBaseUrl,
      oauthBaseUrl: expanded.oauthBaseUrl,
    });
  };

  return (
    <div className={styles.grokSection}>
      <div className={styles.header}>
        <h4 className={styles.title}>{t('settings.grokProvider.title')}</h4>
        <p className={styles.desc}>{t('settings.grokProvider.desc')}</p>
      </div>

      <div className={styles.card}>
        <div className={styles.cardBody}>
          <div className={styles.cardTitle}>{t('settings.grokProvider.authMethodLabel')}</div>
          <div className={styles.cardText}>{t('settings.grokProvider.authMethodHint')}</div>
          <div className={styles.radioGroup} role="radiogroup" aria-label={t('settings.grokProvider.authMethodLabel')}>
            {([
              { id: 'oauth', labelKey: 'settings.grokProvider.authOauth' },
              { id: 'api_key', labelKey: 'settings.grokProvider.authApiKey' },
              { id: 'auto', labelKey: 'settings.grokProvider.authAuto' },
            ] as const).map((opt) => (
              <label key={opt.id} className={styles.radioRow}>
                <input
                  type="radio"
                  name="grok-auth-method"
                  value={opt.id}
                  checked={config.authMethod === opt.id}
                  onChange={() => onAuthChange(opt.id)}
                  disabled={saving}
                />
                <span>{t(opt.labelKey)}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {config.authMethod === 'api_key' || config.authMethod === 'auto' ? (
        <div className={styles.card}>
          <div className={styles.cardBody}>
            <div className={styles.cardTitle}>{t('settings.grokProvider.apiKeyLabel')}</div>
            <div className={styles.cardText}>{t('settings.grokProvider.apiKeyHint')}</div>
            <div className={styles.apiKeyRow}>
              <input
                type="password"
                className={styles.apiKeyInput}
                value={apiKeyDraft}
                placeholder={config.hasApiKey ? '••••••••' : 'xai-...'}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label={t('settings.grokProvider.apiKeyLabel')}
              />
              <button
                type="button"
                className={styles.saveBtn}
                onClick={() => save({ apiKey: apiKeyDraft })}
                disabled={saving}
              >
                {t('settings.grokProvider.saveApiKey')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className={styles.card}>
        <div className={styles.cardBody}>
          <div className={styles.cardTitle}>{t('settings.grokProvider.gatewayLabel')}</div>
          <div className={styles.cardText}>{t('settings.grokProvider.gatewayHint')}</div>

          <div className={styles.fieldLabel}>{t('settings.grokProvider.gatewayOriginLabel')}</div>
          <div className={styles.apiKeyRow}>
            <input
              type="text"
              className={styles.apiKeyInput}
              value={gatewayOriginDraft}
              placeholder="http://127.0.0.1:18789"
              onChange={(e) => setGatewayOriginDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label={t('settings.grokProvider.gatewayOriginLabel')}
            />
            <button
              type="button"
              className={styles.saveBtn}
              onClick={applyGatewayDefaults}
              disabled={saving || !trimSlash(gatewayOriginDraft)}
            >
              {t('settings.grokProvider.applyGatewayDefaults')}
            </button>
          </div>

          <div className={styles.fieldLabel}>{t('settings.grokProvider.apiBaseUrlLabel')}</div>
          <input
            type="text"
            className={styles.apiKeyInput}
            value={apiBaseDraft}
            placeholder="https://gw.example.com/xai/v1"
            onChange={(e) => setApiBaseDraft(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('settings.grokProvider.apiBaseUrlLabel')}
          />

          <div className={styles.fieldLabel}>{t('settings.grokProvider.oauthBaseUrlLabel')}</div>
          <input
            type="text"
            className={styles.apiKeyInput}
            value={oauthBaseDraft}
            placeholder="https://gw.example.com/grok/v1"
            onChange={(e) => setOauthBaseDraft(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('settings.grokProvider.oauthBaseUrlLabel')}
          />

          {bareWarn ? (
            <div className={styles.warnText} role="alert">
              {t('settings.grokProvider.bareV1Warn')}
            </div>
          ) : null}

          <div className={styles.apiKeyRow} style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={() => save({
                apiBaseUrl: apiBaseDraft,
                oauthBaseUrl: oauthBaseDraft,
                gatewayOrigin: gatewayOriginDraft,
              })}
              disabled={saving}
            >
              {t('settings.grokProvider.saveBaseUrls')}
            </button>
          </div>

          <div className={styles.cardText} style={{ marginTop: 8 }}>
            {t('settings.grokProvider.tokenHint')}
          </div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardRow}>
          <span className="codicon codicon-key" aria-hidden="true" />
          <div className={styles.cardBody}>
            <div className={styles.cardTitle}>OAuth</div>
            <div className={styles.cardText}>{t('settings.grokProvider.oauthHint')}</div>
          </div>
        </div>
        <div className={styles.cardRow}>
          <span className="codicon codicon-terminal" aria-hidden="true" />
          <div className={styles.cardBody}>
            <div className={styles.cardTitle}>CLI</div>
            <div className={styles.cardText}>{t('settings.grokProvider.cliHint')}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GrokProviderSection;
