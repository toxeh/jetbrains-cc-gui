import { useCallback, useEffect, useState } from 'react';
import styles from './style.module.less';

export type GrokAuthMethod = 'oauth' | 'api_key' | 'auto';

const GrokProviderSection = () => {
  const [jsonConfig, setJsonConfig] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handler = (jsonStr: string) => {
      try {
        const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        const configObj = {
          env: data?.env || {
            GROK_API_KEY: data?.apiKey || '',
            GROK_MODELS_BASE_URL: data?.apiBaseUrl || '',
            GROK_CLI_CHAT_PROXY_BASE_URL: data?.oauthBaseUrl || '',
          },
          authMethod: data?.authMethod || 'oauth'
        };
        setJsonConfig(JSON.stringify(configObj, null, 2));
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

  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJsonConfig(e.target.value);
    setJsonError('');
  };

  const handleSave = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonConfig);
      const env = parsed.env || {};
      const next = {
        authMethod: parsed.authMethod || 'oauth',
        apiKey: env.GROK_API_KEY || env.XAI_API_KEY || '',
        apiBaseUrl: env.GROK_MODELS_BASE_URL || env.XAI_API_BASE_URL || env.GROK_XAI_API_BASE_URL || '',
        oauthBaseUrl: env.GROK_CLI_CHAT_PROXY_BASE_URL || '',
        gatewayOrigin: '',
        env: env // send custom env down to backend
      };
      
      setSaving(true);
      window.sendToJava?.(`set_grok_auth_config:${JSON.stringify(next)}`);
      setTimeout(() => setSaving(false), 400);
      setJsonError('');
    } catch (err) {
      setJsonError('Invalid JSON format');
    }
  }, [jsonConfig]);

  return (
    <div className={styles.grokSection}>
      <div className={styles.header}>
        <h4 className={styles.title}>Grok JSON Configuration</h4>
        <p className={styles.desc}>Configure Grok settings using JSON format.</p>
      </div>

      <div className={styles.card}>
        <div className={styles.cardBody}>
          <div style={{ marginBottom: '12px', fontSize: '12px', color: '#999' }}>
            Edit your configuration below.
          </div>
          <div className="json-editor-wrapper">
            <textarea
              style={{
                width: '100%',
                height: '250px',
                fontFamily: 'monospace',
                fontSize: '13px',
                padding: '12px',
                backgroundColor: 'var(--vscode-input-background, #1e1e1e)',
                color: 'var(--vscode-input-foreground, #cccccc)',
                border: '1px solid var(--vscode-input-border, #3c3c3c)',
                borderRadius: '4px',
                resize: 'vertical'
              }}
              value={jsonConfig}
              onChange={handleJsonChange}
              placeholder={`{
  "env": {
    "GROK_API_KEY": "",
    "GROK_MODELS_BASE_URL": "",
    "GROK_CLI_CHAT_PROXY_BASE_URL": ""
  },
  "authMethod": "oauth"
}`}
            />
            {jsonError && (
              <p style={{ color: 'var(--vscode-errorForeground, #f48771)', marginTop: '8px', fontSize: '13px' }}>
                <span className="codicon codicon-error" style={{ marginRight: '4px' }} />
                {jsonError}
              </p>
            )}
          </div>
          
          <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: '6px 14px',
                backgroundColor: 'var(--vscode-button-background, #0e639c)',
                color: 'var(--vscode-button-foreground, #ffffff)',
                border: 'none',
                borderRadius: '2px',
                cursor: 'pointer'
              }}
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GrokProviderSection;
