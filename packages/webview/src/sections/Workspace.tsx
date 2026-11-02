import { useEffect, useMemo, useState } from 'react';
import type {
  RuleTestPayload, WorkspacePayload, WorkspaceProvider, WorkspaceRule, WorkspaceRuleDescriptor,
} from '../protocol';
import { Banner, Chip, Field, SectionHeader } from '../ui';

type Action = (action: string, payload?: unknown) => void;

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const CONFIDENCES = ['verified', 'high', 'medium', 'low'];

interface DraftState {
  id: string;
  name: string;
  category: string;
  severity: string;
  confidence: string;
  description: string;
  recommendation: string;
  detectionType: 'pattern' | 'absence' | 'forbidden-import';
  pattern: string;
  absenceMessage: string;
  files: string;
  exclude: string;
  languages: string;
  priority: number;
  enforcement: 'mandatory' | 'advisory';
  blocksGate: boolean;
  enabled: boolean;
}

function emptyDraft(categories: WorkspacePayload['rules']['categories']): DraftState {
  return {
    id: '', name: '', category: categories[0]?.id ?? 'architecture', severity: 'medium', confidence: 'medium',
    description: '', recommendation: '', detectionType: 'pattern', pattern: '', absenceMessage: '',
    files: '', exclude: '', languages: '', priority: 100, enforcement: 'mandatory', blocksGate: false, enabled: true,
  };
}

function draftFromRule(rule: WorkspaceRule): DraftState {
  const detectionType = rule.detection.type === 'absence' ? 'absence' : rule.detection.type === 'forbidden-import' ? 'forbidden-import' : 'pattern';
  return {
    id: rule.id, name: rule.name, category: rule.category, severity: rule.severity, confidence: rule.confidence,
    description: rule.description, recommendation: rule.recommendation, detectionType,
    pattern: rule.detection.pattern ?? rule.detection.required ?? rule.detection.from ?? '',
    absenceMessage: rule.detection.message ?? '',
    files: rule.files.join(', '), exclude: rule.exclude.join(', '),
    languages: rule.languages === 'any' ? '' : rule.languages.join(','),
    priority: rule.priority, enforcement: rule.enforcement === 'advisory' ? 'advisory' : 'mandatory',
    blocksGate: rule.blocksGate, enabled: rule.enabled,
  };
}

function draftPayload(draft: DraftState): Record<string, unknown> {
  const list = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);
  const detection = draft.detectionType === 'pattern'
    ? { type: 'pattern', pattern: draft.pattern, scope: 'added' }
    : draft.detectionType === 'absence'
      ? { type: 'absence', required: draft.pattern, message: draft.absenceMessage || `Required pattern is missing: ${draft.pattern}` }
      : { type: 'forbidden-import', from: draft.pattern };
  return {
    id: draft.id, name: draft.name, category: draft.category, severity: draft.severity,
    confidence: draft.confidence, description: draft.description, recommendation: draft.recommendation,
    detection,
    ...(list(draft.files).length ? { files: list(draft.files) } : {}),
    ...(list(draft.exclude).length ? { exclude: list(draft.exclude) } : {}),
    ...(list(draft.languages).length ? { languages: list(draft.languages) } : { languages: 'any' }),
    priority: draft.priority, enforcement: draft.enforcement, blocksGate: draft.blocksGate, enabled: draft.enabled,
  };
}

export function RulesPanel({ workspace, onAction, ruleTest, notice, error }: {
  workspace: WorkspacePayload;
  onAction: Action;
  ruleTest?: RuleTestPayload;
  notice?: string;
  error?: string;
}) {
  const [filter, setFilter] = useState('');
  const [importPath, setImportPath] = useState('');
  const [editing, setEditing] = useState<DraftState | null>(null);
  const [mode, setMode] = useState<'create' | 'update'>('create');

  useEffect(() => {
    if (!editing && workspace.rules.custom.length === 0) setEditing(emptyDraft(workspace.rules.categories));
  }, [workspace.rules.custom.length, workspace.rules.categories, editing]);

  const all = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const custom = workspace.rules.custom;
    const builtin = workspace.rules.builtin;
    if (!needle) return { custom, builtin };
    const match = (item: { id: string; name: string; category: string }) =>
      item.id.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle) || item.category.toLowerCase().includes(needle);
    return { custom: custom.filter(match), builtin: builtin.filter(match) };
  }, [workspace.rules.custom, workspace.rules.builtin, filter]);

  const startCreate = () => { setMode('create'); setEditing(emptyDraft(workspace.rules.categories)); };
  const startEdit = (rule: WorkspaceRule) => { setMode('update'); setEditing(draftFromRule(rule)); };
  const update = <K extends keyof DraftState>(key: K, value: DraftState[K]) => setEditing((current) => current ? { ...current, [key]: value } : current);

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="Engineering standards"
        title="Rules & policies"
        description="Rules are data. Every rule here is loaded by the same validator the review engine uses; a rule the editor accepts is a rule the review can run."
        actions={<button className="btn primary" onClick={startCreate}>New rule</button>}
      />
      {notice && <Banner level="success" title="Saved">{notice}</Banner>}
      {error && <Banner level="error" title="Rule action failed">{error}</Banner>}
      {workspace.rules.issues.length > 0 && (
        <Banner level="warn" title={`${workspace.rules.issues.length} rule problem(s)`}>
          {workspace.rules.issues.slice(0, 6).map((issue) => <div key={`${issue.path}:${issue.message}`}><span className="mono">{issue.path}</span> — {issue.message}</div>)}
        </Banner>
      )}
      {workspace.rules.conflicts.length > 0 && (
        <Banner level="warn" title={`${workspace.rules.conflicts.length} configuration conflict(s)`}>
          {workspace.rules.conflicts.slice(0, 6).map((conflict) => <div key={`${conflict.id}:${conflict.message}`}><span className="mono">{conflict.id}</span> — {conflict.message}</div>)}
        </Banner>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Effective policy</h2>
          <Chip tone="neutral">{workspace.rules.policy.layers.filter((layer) => layer.loaded).length} layer(s)</Chip>
        </div>
        <p className="muted small">
          Precedence is organisation → repository → directory → file. The nearest layer that sets a value wins; every
          review records this snapshot. Minimum severity <span className="mono">{workspace.rules.policy.minSeverity}</span>,
          {' '}{workspace.rules.policy.ruleOverrides} rule override(s).
        </p>
        <div className="rule-list">
          {workspace.rules.policy.layers.map((layer) => (
            <div className="rule-row" key={`${layer.kind}:${layer.source}:${layer.appliesTo}`}>
              <div className="rule-main">
                <strong>{layer.kind}</strong>
                <span className="mono small">{layer.source}</span>
                <span className="muted small">applies to {layer.appliesTo}</span>
              </div>
              <Chip tone={layer.loaded ? 'good' : 'bad'}>{layer.loaded ? 'loaded' : 'not loaded'}</Chip>
              {layer.error && <span className="muted small">{layer.error}</span>}
            </div>
          ))}
          {workspace.rules.policy.layers.length === 0 && <p className="muted">No policy layer found; defaults apply.</p>}
        </div>
        {workspace.rules.policy.warnings.length > 0 && (
          <p className="method">{workspace.rules.policy.warnings.slice(0, 4).join(' · ')}</p>
        )}
      </section>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Custom rules ({workspace.rules.custom.length})</h2>
            <input className="search" placeholder="Filter rules…" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </div>
          {all.custom.length === 0 && <p className="muted">No custom rule matches. Rules you create live in <span className="mono">.diffwise/rules/custom</span>.</p>}
          {all.custom.map((rule) => (
            <div className="rule-row" key={rule.id}>
              <div className="rule-main">
                <div className="rule-title">
                  <strong>{rule.name}</strong>
                  <Chip tone={rule.severity === 'critical' || rule.severity === 'high' ? 'bad' : rule.severity === 'medium' ? 'warn' : 'neutral'}>{rule.severity}</Chip>
                  <Chip tone="neutral">{rule.category}</Chip>
                  {rule.blocksGate && <Chip tone="bad">gate</Chip>}
                  {rule.enforcement === 'advisory' && <Chip tone="neutral">advisory</Chip>}
                </div>
                <div className="muted small mono">{rule.id} · priority {rule.priority} · {rule.detection.type}{rule.files.length ? ` · ${rule.files.join(', ')}` : ''}</div>
              </div>
              <div className="rule-actions">
                <label className="check compact"><input type="checkbox" checked={rule.enabled} onChange={(event) => onAction('rule.toggle', { id: rule.id, enabled: event.target.checked })} /><span>{rule.enabled ? 'on' : 'off'}</span></label>
                <button className="btn ghost small" onClick={() => startEdit(rule)}>Edit</button>
                <button className="btn ghost small" onClick={() => onAction('rule.test', { draft: draftPayload(draftFromRule(rule)) })}>Test</button>
                <button className="btn ghost small danger" onClick={() => onAction('rule.delete', { id: rule.id })}>Delete</button>
              </div>
            </div>
          ))}
          <div className="form-actions">
            <button className="btn" onClick={() => onAction('rule.export', {})}>Export custom rules</button>
          </div>
          <div className="form-grid">
            <label className="wide">Import a rule file (path relative to the repository)
              <input className="mono" value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder=".diffwise/rules-export.yaml" />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn" disabled={!importPath.trim()} onClick={() => onAction('rule.import', { path: importPath.trim() })}>Import rules</button>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>{mode === 'update' ? `Edit ${editing?.id ?? ''}` : 'New rule'}</h2></div>
          {!editing ? <p className="muted">Select a rule to edit, or create a new one.</p> : (
            <>
              <div className="form-grid">
                <label>Rule id
                  <input value={editing.id} disabled={mode === 'update'} onChange={(event) => update('id', event.target.value)} placeholder="java.transaction.self-invocation" />
                  <span className="hint">Lower-case, dot/dash separated. Immutable after creation.</span>
                </label>
                <label>Name
                  <input value={editing.name} onChange={(event) => update('name', event.target.value)} placeholder="Spring transaction self invocation" />
                </label>
                <label>Category
                  <select value={editing.category} onChange={(event) => update('category', event.target.value)}>
                    {workspace.rules.categories.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}
                  </select>
                </label>
                <label>Severity
                  <select value={editing.severity} onChange={(event) => update('severity', event.target.value)}>
                    {SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
                  </select>
                </label>
                <label>Confidence
                  <select value={editing.confidence} onChange={(event) => update('confidence', event.target.value)}>
                    {CONFIDENCES.map((confidence) => <option key={confidence} value={confidence}>{confidence}</option>)}
                  </select>
                </label>
                <label>Priority
                  <input type="number" value={editing.priority} onChange={(event) => update('priority', Number(event.target.value))} />
                  <span className="hint">Lower runs and reports first.</span>
                </label>
                <label>Enforcement
                  <select value={editing.enforcement} onChange={(event) => update('enforcement', event.target.value as DraftState['enforcement'])}>
                    <option value="mandatory">Mandatory</option>
                    <option value="advisory">Advisory</option>
                  </select>
                </label>
                <label>Detection
                  <select value={editing.detectionType} onChange={(event) => update('detectionType', event.target.value as DraftState['detectionType'])}>
                    <option value="pattern">Regex on added lines</option>
                    <option value="absence">Required pattern missing</option>
                    <option value="forbidden-import">Forbidden import</option>
                  </select>
                </label>
                <label className="wide">{editing.detectionType === 'forbidden-import' ? 'Module specifier regex' : editing.detectionType === 'absence' ? 'Required regex' : 'Pattern (regex)'}
                  <input className="mono" value={editing.pattern} onChange={(event) => update('pattern', event.target.value)} placeholder="\\bthis\\.chargeCard\\(" />
                </label>
                {editing.detectionType === 'absence' && (
                  <label className="wide">Message when missing
                    <input value={editing.absenceMessage} onChange={(event) => update('absenceMessage', event.target.value)} placeholder="Every route must declare an authorization guard." />
                  </label>
                )}
                <label>File scope (globs)
                  <input value={editing.files} onChange={(event) => update('files', event.target.value)} placeholder="src/**/*.java, services/billing/**" />
                </label>
                <label>Exclusions
                  <input value={editing.exclude} onChange={(event) => update('exclude', event.target.value)} placeholder="**/fixtures/**" />
                </label>
                <label>Languages
                  <input value={editing.languages} onChange={(event) => update('languages', event.target.value)} placeholder="java, kotlin (empty = any)" />
                </label>
                <label className="wide">Description
                  <textarea rows={2} value={editing.description} onChange={(event) => update('description', event.target.value)} />
                </label>
                <label className="wide">Recommendation
                  <textarea rows={2} value={editing.recommendation} onChange={(event) => update('recommendation', event.target.value)} />
                </label>
              </div>
              <div className="toggle-row">
                <label className="check"><input type="checkbox" checked={editing.blocksGate} onChange={(event) => update('blocksGate', event.target.checked)} /><span>Blocks the quality gate</span></label>
                <label className="check"><input type="checkbox" checked={editing.enabled} onChange={(event) => update('enabled', event.target.checked)} /><span>Enabled</span></label>
              </div>
              <div className="form-actions">
                <button className="btn primary" onClick={() => onAction(mode === 'update' ? 'rule.update' : 'rule.create', { draft: draftPayload(editing) })}>{mode === 'update' ? 'Save rule' : 'Create rule'}</button>
                <button className="btn" onClick={() => onAction('rule.test', { draft: draftPayload(editing) })}>Test against repository</button>
                <button className="btn ghost" onClick={() => { setEditing(null); setMode('create'); }}>Clear</button>
              </div>
            </>
          )}
        </section>
      </div>

      {ruleTest && (
        <section className="card">
          <div className="card-head"><h2>Test result: {ruleTest.ruleId}</h2><Chip tone={ruleTest.valid ? 'good' : 'bad'}>{ruleTest.valid ? 'valid' : 'invalid'}</Chip></div>
          <p className="muted small">Scanned {ruleTest.filesScanned} file(s), matched {ruleTest.filesMatched}, skipped {ruleTest.skipped} by scope. A rule that matches nothing is usually a scope problem, not a clean repository.</p>
          {ruleTest.issues.map((issue) => <div key={issue.message} className={issue.level === 'error' ? 'error' : 'warn'}>{issue.level}: {issue.message}</div>)}
          {ruleTest.matches.slice(0, 12).map((match) => (
            <div key={`${match.file}:${match.line}`} className="mono small match-row">
              {match.file}:{match.line} — {match.snippet.trim().slice(0, 160)}
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <div className="card-head"><h2>Built-in and pack rules ({workspace.rules.builtin.length})</h2><span className="muted small">Configured through policy; edit in `.diffwise/policy.json`.</span></div>
        {all.builtin.slice(0, 80).map((rule: WorkspaceRuleDescriptor) => (
          <div className="rule-row" key={rule.id}>
            <div className="rule-main">
              <div className="rule-title"><strong>{rule.name}</strong><Chip tone="neutral">{rule.category}</Chip><Chip tone={rule.enabled ? 'good' : 'neutral'}>{rule.enabled ? 'enabled' : 'disabled'}</Chip></div>
              <div className="muted small mono">{rule.id} · {rule.pack} · {rule.mode}{rule.path ? ` · ${rule.path}` : ''}</div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

export function DocumentationSources({ workspace, onAction, notice, error }: {
  workspace: WorkspacePayload;
  onAction: Action;
  notice?: string;
  error?: string;
}) {
  const [path, setPath] = useState('');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('');
  const [modules, setModules] = useState('');
  const [maxSections, setMaxSections] = useState(workspace.documentation.maxSections);
  const [maxChars, setMaxChars] = useState(workspace.documentation.maxChars);

  const add = () => {
    if (!path.trim()) return;
    const sources = [
      ...workspace.documentation.sources.filter((source) => source.path !== path.trim()),
      {
        path: path.trim(),
        ...(category ? { category } : {}),
        ...(priority ? { priority: Number(priority) } : {}),
        ...(modules.trim() ? { modules: modules.split(',').map((item) => item.trim()).filter(Boolean) } : {}),
        enabled: true,
      },
    ];
    onAction('docs.save', { sources, maxSections, maxChars });
    setPath('');
  };

  return (
    <section className="card">
      <div className="card-head"><h2>Documentation sources</h2><Chip tone="neutral">{workspace.documentation.sources.length} connected</Chip></div>
      <p className="muted small">A source list is a scope, not a hint: documentation outside it is not reviewed. Retrieval is bounded per change.</p>
      {notice && <Banner level="success" title="Documentation updated">{notice}</Banner>}
      {error && <Banner level="error" title="Documentation update failed">{error}</Banner>}
      {workspace.documentation.sources.length === 0
        ? <p className="muted">No source configured. Every documentation file in the repository is currently considered.</p>
        : workspace.documentation.sources.map((source) => (
          <div className="rule-row" key={source.path}>
            <div className="rule-main">
              <div className="rule-title"><strong className="mono">{source.path}</strong><Chip tone={source.enabled === false ? 'neutral' : 'good'}>{source.enabled === false ? 'disabled' : 'enabled'}</Chip><Chip tone="neutral">{source.category ?? 'auto'}</Chip></div>
              <div className="muted small">priority {source.priority ?? 'auto'}{source.modules?.length ? ` · modules ${source.modules.join(', ')}` : ''}</div>
            </div>
            <div className="rule-actions">
              <button className="btn ghost small" onClick={() => onAction('docs.toggle', { path: source.path, enabled: source.enabled === false })}>{source.enabled === false ? 'Enable' : 'Disable'}</button>
              <button className="btn ghost small danger" onClick={() => onAction('docs.remove', { path: source.path })}>Remove</button>
            </div>
          </div>
        ))}
      <div className="form-grid">
        <label>Path or glob<input value={path} onChange={(event) => setPath(event.target.value)} placeholder="docs/**, docs/adr/**" /></label>
        <label>Category
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">auto-detect</option>
            {['readme', 'architecture', 'adr', 'openapi', 'asyncapi', 'protobuf', 'sql', 'business', 'technical', 'standards', 'contract', 'other'].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label>Priority<input type="number" value={priority} onChange={(event) => setPriority(event.target.value)} placeholder="auto" /></label>
        <label>Modules (comma separated)<input value={modules} onChange={(event) => setModules(event.target.value)} placeholder="billing, payments" /></label>
        <label>Max sections per review<input type="number" min={1} max={20} value={maxSections} onChange={(event) => setMaxSections(Number(event.target.value))} /></label>
        <label>Max characters per review<input type="number" min={400} max={40000} value={maxChars} onChange={(event) => setMaxChars(Number(event.target.value))} /></label>
      </div>
      <div className="form-actions"><button className="btn primary" onClick={add}>Add source</button></div>
      {workspace.documentation.indexed && (
        <div className="stats-strip">
          <Field label="Documents" value={workspace.documentation.indexed.documents} />
          <Field label="Sections" value={workspace.documentation.indexed.sections} />
          <Field label="Duplicates" value={workspace.documentation.indexed.duplicates} />
          <Field label="Indexed" value={workspace.documentation.indexedAt ? new Date(workspace.documentation.indexedAt).toLocaleString() : 'now'} />
        </div>
      )}
    </section>
  );
}

export function ProvidersPanel({ workspace, onAction, notice, error }: {
  workspace: WorkspacePayload;
  onAction: Action;
  notice?: string;
  error?: string;
}) {
  const [selected, setSelected] = useState<WorkspaceProvider | null>(null);
  const [draft, setDraft] = useState({
    name: '', id: 'openai', baseUrl: '', model: '', apiKeyEnvVar: '', fastModel: '', apiVersion: '', deployment: '',
  });
  useEffect(() => {
    if (selected) {
      setDraft({
        name: selected.name, id: selected.id, baseUrl: selected.baseUrl, model: selected.model,
        apiKeyEnvVar: selected.apiKeyEnvVar, fastModel: selected.fastModel ?? '', apiVersion: '', deployment: '',
      });
    }
  }, [selected]);

  const tasks = workspace.providers.tasks;
  const route = (task: string, key: 'provider' | 'model' | 'fallback', value: string) => {
    const existing = workspace.providers.routing?.[task] ?? {};
    onAction('provider.route', { task, route: { ...existing, [key]: value || undefined } });
  };

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="Model routing"
        title="AI providers"
        description="A provider profile is a wire protocol plus credentials by environment variable. No key is ever stored here or in the report."
        actions={<button className="btn primary" onClick={() => { setSelected(null); setDraft({ name: '', id: 'openai', baseUrl: '', model: '', apiKeyEnvVar: '', fastModel: '', apiVersion: '', deployment: '' }); }}>Add profile</button>}
      />
      {notice && <Banner level="success" title="Provider configuration updated">{notice}</Banner>}
      {error && <Banner level="error" title="Provider update failed">{error}</Banner>}
      {workspace.providers.warnings.length > 0 && (
        <Banner level="warn" title="Configuration warnings">{workspace.providers.warnings.slice(0, 5).join(' ')}</Banner>
      )}
      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2>Profiles</h2><Chip tone="neutral">{workspace.providers.profiles.length}</Chip></div>
          {workspace.providers.profiles.map((profile) => (
            <div className="rule-row" key={profile.name}>
              <div className="rule-main">
                <div className="rule-title">
                  <strong>{profile.label}</strong>
                  <Chip tone={profile.primary ? 'accent' : 'neutral'}>{profile.name}</Chip>
                  <Chip tone={profile.apiKeyPresent ? 'good' : 'warn'}>{profile.apiKeyPresent ? 'key present' : 'key missing'}</Chip>
                  {!profile.enabled && <Chip tone="neutral">disabled</Chip>}
                </div>
                <div className="muted small mono">{profile.id} · {profile.model} · {profile.apiKeyEnvVar || 'no key needed'}</div>
              </div>
              <div className="rule-actions">
                <button className="btn ghost small" onClick={() => setSelected(profile)}>Edit</button>
                <button className="btn ghost small" onClick={() => onAction('provider.test', { name: profile.name })}>Test</button>
                {!profile.primary && <button className="btn ghost small danger" onClick={() => onAction('provider.remove', { name: profile.name })}>Remove</button>}
              </div>
            </div>
          ))}
        </section>

        <section className="card">
          <div className="card-head"><h2>{selected ? `Edit ${selected.name}` : 'New provider profile'}</h2></div>
          <div className="form-grid">
            <label>Profile name<input value={draft.name} disabled={Boolean(selected)} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="primary or fast-local" /></label>
            <label>Provider
              <input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="openai | anthropic | google | ollama | azure-openai" />
              <span className="hint">openai, anthropic, google, deepseek, mistral, openrouter, groq, together, fireworks, azure-openai, aws-bedrock, google-vertex, ollama, lmstudio, vllm, openai-compatible, custom.</span>
            </label>
            <label>Base URL<input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>
            <label>Model<input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="gpt-4o-mini" /></label>
            <label>Key environment variable<input value={draft.apiKeyEnvVar} onChange={(event) => setDraft({ ...draft, apiKeyEnvVar: event.target.value })} placeholder="OPENAI_API_KEY" /></label>
            <label>Fast model<input value={draft.fastModel} onChange={(event) => setDraft({ ...draft, fastModel: event.target.value })} placeholder="optional" /></label>
            <label>API version (Azure)<input value={draft.apiVersion} onChange={(event) => setDraft({ ...draft, apiVersion: event.target.value })} /></label>
            <label>Deployment (Azure)<input value={draft.deployment} onChange={(event) => setDraft({ ...draft, deployment: event.target.value })} /></label>
          </div>
          <div className="form-actions">
            <button className="btn primary" onClick={() => onAction('provider.save', { profile: { ...draft, ...(draft.fastModel ? {} : { fastModel: undefined }), ...(draft.apiVersion ? {} : { apiVersion: undefined }), ...(draft.deployment ? {} : { deployment: undefined }) }, primary: selected?.primary ?? draft.name === 'primary' })}>Save profile</button>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Task-based routing</h2><span className="muted small">An empty row uses the primary provider and its model.</span></div>
        <div className="routing-table">
          {tasks.map((task) => {
            const current = workspace.providers.routing?.[task] ?? {};
            return (
              <div className="routing-row" key={task}>
                <span className="routing-task">{task}</span>
                <input list="provider-names" value={current.provider ?? ''} placeholder="primary" onChange={(event) => route(task, 'provider', event.target.value)} />
                <input value={current.model ?? ''} placeholder={workspace.providers.models?.[task] ?? 'default model'} onChange={(event) => route(task, 'model', event.target.value)} />
                <input list="provider-names" value={current.fallback ?? ''} placeholder="no fallback" onChange={(event) => route(task, 'fallback', event.target.value)} />
              </div>
            );
          })}
        </div>
        <datalist id="provider-names">{workspace.providers.profiles.map((profile) => <option key={profile.name} value={profile.name} />)}</datalist>
        <p className="muted small">Fallback is explicit and recorded. A cross-provider fallback is refused while repository content is being sent unless the route allows it.</p>
      </section>
    </div>
  );
}

export function McpPanel({ workspace, onAction, notice, error }: {
  workspace: WorkspacePayload;
  onAction: Action;
  notice?: string;
  error?: string;
}) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [allowedResources, setAllowedResources] = useState('');
  const [contextTool, setContextTool] = useState('');
  const [contextResource, setContextResource] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [allowWrite, setAllowWrite] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const startEdit = (server: WorkspacePayload['mcp']['servers'][number]) => {
    setEditing(server.name);
    setName(server.name);
    setTransport(server.transport);
    setCommand(server.command ?? '');
    setArgs((server.args ?? []).join(' '));
    setUrl(server.url ?? '');
    setAllowedTools(server.permissions.allowedTools.join(', '));
    setAllowedResources(server.permissions.allowedResources.join(', '));
    setContextTool(server.context?.tool ?? '');
    setContextResource(server.context?.resource ?? '');
    setReadOnly(server.permissions.readOnly);
    setAllowWrite(server.permissions.allowWrite);
  };

  const add = () => {
    if (!name.trim()) return;
    const resources = allowedResources.split(',').map((item) => item.trim()).filter(Boolean);
    const existing = workspace.mcp.servers.find((server) => server.name === editing);
    onAction('mcp.save', {
      server: {
        name: name.trim(), transport, enabled: existing?.enabled ?? true,
        ...(transport === 'stdio' ? { command: command.trim(), args: args.split(' ').map((part) => part.trim()).filter(Boolean), url: undefined } : { url: url.trim(), command: undefined, args: undefined }),
        permissions: {
          readOnly, allowWrite,
          allowedTools: allowedTools.split(',').map((item) => item.trim()).filter(Boolean),
          allowedResources: resources, contextTools: contextTool ? [contextTool] : [],
          maxOutputBytes: 24000, timeoutMs: 20000,
        },
        ...(contextTool || contextResource
          ? {
            context: {
              ...(contextTool ? { tool: contextTool } : {}),
              ...(contextResource ? { resource: contextResource } : {}),
              arguments: { query: '{{terms}}', files: '{{files}}' }, label: `${name} context`,
            },
          }
          : {}),
      },
    });
    setName('');
  };

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="External context"
        title="MCP connections"
        description="DiffWise acts as an MCP client here. Review defaults to read-only tools; external output is data, never instructions."
        actions={<button className="btn" onClick={() => onAction('mcp.status', {})}>Check connections</button>}
      />
      {notice && <Banner level="success" title="MCP configuration updated">{notice}</Banner>}
      {error && <Banner level="error" title="MCP action failed">{error}</Banner>}
      {!workspace.mcp.exists && <Banner level="info" title="No external MCP connection configured">DiffWise exposes its own MCP server; connecting to another server is opt-in and lives in <span className="mono">{workspace.mcp.path}</span>.</Banner>}
      {workspace.mcp.warnings.map((warning) => <Banner key={warning} level="warn" title="MCP warning">{warning}</Banner>)}

      <section className="card">
        <div className="card-head"><h2>Connections ({workspace.mcp.servers.length})</h2></div>
        {workspace.mcp.servers.length === 0 && <p className="muted">No connection. Add one below; nothing is contacted until you test it or run a review with a context tool configured.</p>}
        {workspace.mcp.servers.map((server) => {
          const status = workspace.mcp.statuses?.find((entry) => entry.name === server.name);
          return (
            <div className="rule-row" key={server.name}>
              <div className="rule-main">
                <div className="rule-title">
                  <strong>{server.name}</strong>
                  <Chip tone="neutral">{server.transport}</Chip>
                  <Chip tone={status?.state === 'ok' ? 'good' : status?.state === 'error' ? 'bad' : server.enabled ? 'neutral' : 'neutral'}>{status?.state ?? (server.enabled ? 'configured' : 'disabled')}</Chip>
                  <Chip tone={server.permissions.allowWrite ? 'warn' : 'good'}>{server.permissions.readOnly ? 'read-only' : 'write allowed'}</Chip>
                </div>
                <div className="muted small mono">{server.transport === 'stdio' ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}` : server.url}</div>
                {status?.message && <div className={`small ${status.state === 'error' ? 'error' : 'muted'}`}>{status.message}</div>}
                <div className="muted small">context: {server.context?.tool ? `tool ${server.context.tool}` : ''}{server.context?.tool && server.context?.resource ? ' + ' : ''}{server.context?.resource ? `resource ${server.context.resource}` : ''}{!server.context?.tool && !server.context?.resource ? 'none' : ''} · allowed: {server.permissions.allowedTools.length ? server.permissions.allowedTools.join(', ') : 'all read-only tools'}</div>
              </div>
              <div className="rule-actions">
                <button className="btn ghost small" onClick={() => onAction('mcp.test', { name: server.name })}>Test</button>
                <button className="btn ghost small" onClick={() => onAction('mcp.tools', { name: server.name })}>Tools</button>
                <button className="btn ghost small" onClick={() => startEdit(server)}>Edit</button>
                <button className="btn ghost small" onClick={() => onAction('mcp.toggle', { name: server.name, enabled: !server.enabled })}>{server.enabled ? 'Disable' : 'Enable'}</button>
                <button className="btn ghost small danger" onClick={() => onAction('mcp.remove', { name: server.name })}>Remove</button>
              </div>
            </div>
          );
        })}
        {workspace.mcp.tools && workspace.mcp.tools.length > 0 && (
          <div className="tool-list">
            {workspace.mcp.tools.map((tool) => (
              <div key={`${tool.server}:${tool.name}`} className="mono small">
                {tool.server}/{tool.name} · {tool.readOnly ? 'read-only' : 'write'}{tool.destructive ? ' · destructive' : ''} — {tool.description?.slice(0, 120)}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h2>{editing ? `Edit ${editing}` : 'Add a connection'}</h2></div>
        <div className="form-grid">
          <label>Name<input value={name} disabled={Boolean(editing)} onChange={(event) => setName(event.target.value)} placeholder="jira" /></label>
          <label>Transport
            <select value={transport} onChange={(event) => setTransport(event.target.value as 'stdio' | 'http')}>
              <option value="stdio">stdio</option>
              <option value="http">Streamable HTTP</option>
            </select>
          </label>
          {transport === 'stdio' ? (
            <>
              <label>Command<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></label>
              <label>Arguments<input value={args} onChange={(event) => setArgs(event.target.value)} placeholder="-y @scope/server" /></label>
            </>
          ) : (
            <label className="wide">URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.internal.example/mcp" /></label>
          )}
          <label>Allowed tools (comma separated)<input value={allowedTools} onChange={(event) => setAllowedTools(event.target.value)} placeholder="search_tickets, get_issue" /></label>
          <label>Allowed resources (URIs, comma separated)<input value={allowedResources} onChange={(event) => setAllowedResources(event.target.value)} placeholder="jira://projects/PAY" /></label>
          <label>Context tool<input value={contextTool} onChange={(event) => setContextTool(event.target.value)} placeholder="search_tickets" /><span className="hint">Called once per review, read-only, with {'{{files}}'} and {'{{terms}}'} substituted.</span></label>
          <label>Context resource<input value={contextResource} onChange={(event) => setContextResource(event.target.value)} placeholder="jira://projects/PAY/requirements" /><span className="hint">Read once per review; must be listed under allowed resources.</span></label>
        </div>
        <div className="toggle-row">
          <label className="check"><input type="checkbox" checked={readOnly} onChange={(event) => { setReadOnly(event.target.checked); if (event.target.checked) setAllowWrite(false); }} /><span>Read-only review access</span></label>
          <label className="check"><input type="checkbox" checked={allowWrite} onChange={(event) => { setAllowWrite(event.target.checked); if (event.target.checked) setReadOnly(false); }} /><span>Allow write-capable tools (explicit approval still required)</span></label>
        </div>
        <div className="form-actions">
          <button className="btn primary" onClick={add}>{editing ? 'Save connection' : 'Add connection'}</button>
          {editing && <button className="btn ghost" onClick={() => { setEditing(null); setName(''); }}>Cancel</button>}
        </div>
      </section>
    </div>
  );
}
