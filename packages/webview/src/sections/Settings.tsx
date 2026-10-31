import { useEffect, useState } from 'react';
import type { UiSettings } from '../protocol';
import { Banner, Chip, Field, SectionHeader } from '../ui';

export function Settings({ settings, onSave, onTest, testResult, testing, onOpenSettingsFile }: {
  settings: UiSettings;
  onSave: (s: UiSettings) => void;
  onTest: (s: UiSettings) => void;
  testResult?: { ok: boolean; message: string; latencyMs: number; model: string };
  testing: boolean;
  onOpenSettingsFile: () => void;
}) {
  const [form, setForm] = useState<UiSettings>(settings);
  const [headersText, setHeadersText] = useState(JSON.stringify(settings.extraHeaders ?? {}, null, 2));
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setForm(settings); setHeadersText(JSON.stringify(settings.extraHeaders ?? {}, null, 2)); }, [settings]);

  const update = <K extends keyof UiSettings>(key: K, value: UiSettings[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  const commit = () => {
    let headers: Record<string, string> = {};
    try {
      const parsed = JSON.parse(headersText || '{}') as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Expected a JSON object');
      headers = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      setHeadersError(null);
    } catch (err) {
      setHeadersError((err as Error).message);
      return;
    }
    const next = { ...form, extraHeaders: headers };
    onSave(next);
    setSaved(true);
  };

  const testWithCurrent = () => {
    let headers: Record<string, string> = {};
    try { headers = JSON.parse(headersText || '{}') as Record<string, string>; } catch { setHeadersError('Invalid JSON'); return; }
    setHeadersError(null);
    onTest({ ...form, extraHeaders: headers });
  };

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="Configuration"
        title="Model provider and analysis settings"
        description="DiffWise is provider-independent. Keys are read from an environment variable and are never stored in settings, reports or logs."
        actions={<button className="btn ghost" onClick={onOpenSettingsFile}>Open settings.json</button>}
      />

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2>AI provider</h2><Chip tone={settings.apiKeyPresent ? 'good' : 'warn'}>{settings.apiKeyPresent ? 'key present' : 'no key detected'}</Chip></div>
          <div className="form-grid">
            <label>Provider
              <select value={form.providerId} onChange={(e) => update('providerId', e.target.value as UiSettings['providerId'])}>
                <option value="openai-compatible">OpenAI-compatible API</option>
                <option value="anthropic">Anthropic Messages API</option>
                <option value="ollama">Ollama / local server</option>
                <option value="none">None (deterministic only)</option>
              </select>
            </label>
            <label>Base URL
              <input value={form.baseUrl} onChange={(e) => update('baseUrl', e.target.value)} placeholder="https://api.openai.com/v1" />
            </label>
            <label>Model
              <input value={form.model} onChange={(e) => update('model', e.target.value)} placeholder="gpt-4o-mini" />
            </label>
            <label>API key environment variable
              <input value={form.apiKeyEnvVar} onChange={(e) => update('apiKeyEnvVar', e.target.value)} placeholder="DIFFWISE_API_KEY" />
            </label>
            <label>Max tokens
              <input type="number" min={256} max={32000} value={form.maxTokens} onChange={(e) => update('maxTokens', Number(e.target.value))} />
              <span className="hint">Reasoning models spend part of this budget on hidden reasoning; 4000 is often too low.</span>
            </label>
            <label>Temperature
              <input type="number" min={0} max={2} step={0.1} value={form.temperature} onChange={(e) => update('temperature', Number(e.target.value))} />
            </label>
            <label>Timeout (ms)
              <input type="number" min={5000} max={600000} step={1000} value={form.timeoutMs} onChange={(e) => update('timeoutMs', Number(e.target.value))} />
            </label>
            <label>Extra headers (JSON)
              <textarea rows={3} value={headersText} onChange={(e) => setHeadersText(e.target.value)} className="mono" />
              {headersError && <span className="hint error">{headersError}</span>}
            </label>
          </div>

          <div className="toggle-row">
            <label className="check"><input type="checkbox" checked={form.aiEnabled} onChange={(e) => update('aiEnabled', e.target.checked)} /><span>Enable AI interpretation (deterministic analysis always runs)</span></label>
            <label className="check"><input type="checkbox" checked={form.sendRepositoryContent} onChange={(e) => update('sendRepositoryContent', e.target.checked)} /><span>Send related repository files to the provider (off by default)</span></label>
          </div>
          <p className="muted small">With repository content off, only the diff of the changed files, finding metadata and file names leave the machine. Credential patterns are redacted from every payload before it is sent.</p>

          <div className="form-actions">
            <button className="btn primary" onClick={commit}>{saved ? 'Saved' : 'Save settings'}</button>
            <button className="btn" onClick={testWithCurrent} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</button>
          </div>
          {testResult && (
            <Banner level={testResult.ok ? 'success' : 'error'} title={testResult.ok ? `Connected · ${testResult.latencyMs}ms` : 'Connection failed'}>
              {testResult.message}{testResult.ok ? ` Model: ${testResult.model}` : ''}
            </Banner>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h2>Analysis and verification</h2></div>
          <div className="form-grid">
            <label>Max changed files
              <input type="number" min={1} max={2000} value={form.maxFiles} onChange={(e) => update('maxFiles', Number(e.target.value))} />
            </label>
            <label>Verification command
              <input value={form.verificationCommand} onChange={(e) => update('verificationCommand', e.target.value)} placeholder="npm test -- --run" />
              <span className="hint">Run only when you press "Run verification command", on this repository.</span>
            </label>
          </div>

          <div className="divider" />
          <h3>Privacy and safety</h3>
          <ul className="tight">
            <li>Repository files are treated as untrusted data; instructions inside them are never followed.</li>
            <li>Generated patches are validated against the working tree and require explicit approval.</li>
            <li>Applied patches are backed up under <code>.diffwise/backups/</code> and can be reverted.</li>
            <li>DiffWise never executes repository scripts automatically.</li>
            <li>API keys are read from the environment and never written to disk by DiffWise.</li>
          </ul>

          <div className="divider" />
          <h3>Current configuration</h3>
          <Field label="Provider" value={`${settings.providerId}${settings.model ? ` · ${settings.model}` : ''}`} />
          <Field label="AI" value={settings.aiEnabled ? 'enabled' : 'disabled'} />
          <Field label="Repository content" value={settings.sendRepositoryContent ? 'sent with consent' : 'diff only'} />
          <Field label="Verification" value={settings.verificationCommand || 'not configured'} mono />
        </section>
      </div>
    </div>
  );
}
