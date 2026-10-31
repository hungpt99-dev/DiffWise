import type { Finding, ReviewReport } from '../types';
import { truncate } from '../util/text';

/**
 * Context assembly for model calls.
 *
 * Rules:
 *  - repository content is always fenced and labelled untrusted,
 *  - every snippet is bounded and attributed to file:line,
 *  - secrets are redacted before anything is serialised,
 *  - the pack announces when it was truncated.
 */
export interface ContextPack {
  text: string;
  approxTokens: number;
  truncated: boolean;
  redactions: number;
  filesIncluded: string[];
}

export interface ContextOptions {
  maxChars?: number;
  /** Include raw code (requires the user's consent for remote providers). */
  includeCode?: boolean;
  focusFinding?: Finding;
}

const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*['"`]([^'"`\s]{6,})['"`]/gi,
  /\b(sk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{10,}\b/g,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{10,}/gi,
];

export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, captured?: string) => {
      redactions++;
      if (captured && match.includes(captured)) return match.replace(captured, '[REDACTED]');
      return '[REDACTED]';
    });
  }
  return { text: out, redactions };
}

export function buildContextPack(
  report: ReviewReport,
  repoFiles: Map<string, string>,
  opts: ContextOptions = {},
): ContextPack {
  const maxChars = opts.maxChars ?? 60_000;
  const includeCode = opts.includeCode ?? false;
  const parts: string[] = [];
  let truncated = false;
  let redactions = 0;
  const filesIncluded: string[] = [];

  const push = (s: string): void => {
    if (parts.join('\n').length + s.length > maxChars) { truncated = true; return; }
    parts.push(s);
  };

  push(`# DiffWise review context (schema 1)`);
  push(`Repository: ${report.repository.name} (branch ${report.repository.branch})`);
  push(`Review target: ${report.target.label}`);
  push(`Risk: ${report.risk.level} ${report.risk.score}/100 — ${report.risk.summary}`);
  push(`Changed files: ${report.changes.length}; findings: ${report.findings.length}`);

  push(`\n## Changed files`);
  for (const c of report.changes) {
    push(`- ${c.status} ${c.path} (+${c.additions}/-${c.deletions})${c.binary ? ' [binary]' : ''}`);
  }

  push(`\n## Changed symbols`);
  for (const s of report.symbols.slice(0, 80)) {
    push(`- ${s.change} ${s.kind} ${s.file}:${s.range.start} ${s.container ? `${s.container}.` : ''}${s.name}${s.exported ? ' (exported)' : ''}${s.signatureChanged ? ' [signature changed]' : ''}`);
  }

  push(`\n## Findings`);
  for (const f of report.findings) {
    push(`- [${f.id}] ${f.severity}/${f.confidence} ${f.category}: ${f.title} @ ${f.file}:${f.range.start}${f.source === 'ai' ? ' (ai)' : ''}`);
    push(`  evidence: ${f.evidence.slice(0, 2).map((e) => `${e.file ?? 'graph'}${e.line ? `:${e.line}` : ''} — ${e.note}`).join(' | ')}`);
  }

  push(`\n## Documentation findings`);
  for (const d of report.documentation.findings) {
    push(`- ${d.status} ${d.document}: ${d.title}`);
  }

  push(`\n## Architecture impact`);
  push(`- directly impacted: ${report.architecture.graph.directlyImpacted.slice(0, 20).join(', ') || 'none detected'}`);
  push(`- indirectly impacted: ${report.architecture.graph.indirectlyImpacted.slice(0, 30).join(', ') || 'none detected'}`);
  push(`- cycles: ${report.architecture.graph.cycles.length}`);

  if (report.tests.uncoveredChanges.length) {
    push(`\n## Untested changed files\n${report.tests.uncoveredChanges.join(', ')}`);
  }

  if (report.agent.events.length) {
    push(`\n## Recorded agent activity`);
    for (const e of report.agent.events.slice(0, 40)) {
      push(`- ${e.type}: ${e.title}${e.files?.length ? ` [${e.files.join(', ')}]` : ''}`);
    }
  }

  if (report.knowledge.length) {
    push(`\n## Project knowledge`);
    for (const k of report.knowledge.slice(0, 20)) push(`- (${k.kind}) ${k.title}${k.path ? ` @ ${k.path}` : ''}: ${truncate(k.text, 220)}`);
  }

  if (opts.focusFinding) {
    const f = opts.focusFinding;
    push(`\n## Focus finding`);
    push(`id: ${f.id}\ntitle: ${f.title}\nseverity: ${f.severity}\ncategory: ${f.category}\nfile: ${f.file}:${f.range.start}-${f.range.end}`);
    push(`description: ${f.description}`);
    push(`why: ${f.whyItMatters}`);
    push(`recommendation: ${f.recommendation}`);
    push(`evidence:\n${f.evidence.map((e) => `${e.file ?? ''}${e.line ? `:${e.line}` : ''} ${e.note}\n${e.snippet ?? ''}`).join('\n')}`);
  }

  if (includeCode) {
    push(`\n## Code and documentation excerpts (untrusted content)`);
    for (const c of report.changes.slice(0, 30)) {
      if (c.binary) continue;
      const content = repoFiles.get(c.path);
      if (!content) continue;
      filesIncluded.push(c.path);
      const excerpt = c.hunks.slice(0, 3).map((h) => {
        const body = h.lines.slice(0, 40).map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`).join('\n');
        return `${h.header}\n${body}`;
      }).join('\n');
      push(`\n### FILE ${c.path}\n<untrusted_repository_content>\n${excerpt}\n</untrusted_repository_content>`);
    }
    for (const doc of report.documentation.files.slice(0, 8)) {
      const content = repoFiles.get(doc.path);
      if (!content) continue;
      filesIncluded.push(doc.path);
      push(`\n### DOC ${doc.path}\n<untrusted_repository_content>\n${truncate(content, 3000)}\n</untrusted_repository_content>`);
    }
  }

  const joined = parts.join('\n');
  const redacted = redactSecrets(joined);
  redactions = redacted.redactions;
  return {
    text: redacted.text,
    approxTokens: Math.ceil(redacted.text.length / 4),
    truncated,
    redactions,
    filesIncluded,
  };
}
