/**
 * Change-first, tiered context assembly.
 *
 * The rule this file implements: **the change is the context**. A model
 * reviewing a diff needs the diff, the symbols it touches, what the
 * deterministic engine already found, and the intent behind it — first, always.
 * Repository material that merely *might* help is added only while the budget
 * allows, in priority order, and every inclusion is recorded.
 *
 * Three tiers (from the product's token policy):
 *
 *   T1 essential   diff, changed symbols, changed files, deterministic findings, intent
 *   T2 targeted    code windows around changed lines, caller files, related tests, docs
 *   T3 deep        full contents of related files — never on by default
 *
 * Differences from `buildContextPack` (kept for compatibility and for A/B
 * measurement in `tools/bench`):
 *
 *  - budgets are token-based and split per section, not one character limit
 *    that silently stops appending;
 *  - changed files are sent as windows around the changed lines, not as
 *    "first three hunks, first forty lines each", which truncated real changes;
 *  - the diff is not truncated at an arbitrary hunk count — whole files are
 *    dropped in low-risk order and the drop is reported;
 *  - the result carries a context fingerprint and per-section provenance, so
 *    the report can state exactly what the model saw.
 */
import { createHash } from 'node:crypto';
import { changedLineNumbers } from '../git/diff';
import { SEVERITY_ORDER } from '../types';
import type { Finding, ReviewReport } from '../types';
import { truncate } from '../util/text';
import { estimateTokens } from '../tokens/estimate';
import { TokenBudget, packSections, type PackResult, type PackableSection, type TokenBudgetPlan } from '../tokens/budget';
import { redactSecrets } from './contextPack';
import { codeWindows, type CodeWindow } from './windows';

export interface ChangeFirstOptions extends TokenBudgetPlan {
  /** Include repository code at all (requires consent for remote providers). */
  includeCode?: boolean;
  /** Allow T3 (full related files). Off by default. */
  includeDeep?: boolean;
  /** Add the detailed block for one finding (chat/fix flows). */
  focusFinding?: Finding;
  /** Change groups are usually redundant with the diff; they are opt-in. */
  includeGroups?: boolean;
}

export interface ContextSectionSummary {
  id: string;
  tier: 1 | 2 | 3;
  tokens: number;
  clipped: boolean;
}

export interface ChangeFirstPack {
  text: string;
  /** Estimator tokens for `text` (kept under the old name for compatibility). */
  approxTokens: number;
  tokens: number;
  truncated: boolean;
  redactions: number;
  filesIncluded: string[];
  sections: ContextSectionSummary[];
  dropped: string[];
  clipped: string[];
  tier: 1 | 2 | 3;
  /** sha256 over section ids and text: a stable identity for caching. */
  fingerprint: string;
  budget: string;
}

const MAX_FILE_LINES = 220;
const MAX_WINDOW_RADIUS = 16;

function changesSection(report: ReviewReport): string {
  const lines: string[] = ['## Changed files'];
  const cap = 80;
  for (const change of report.changes.slice(0, cap)) {
    const parts = [`- ${change.status} ${change.path} (+${change.additions}/-${change.deletions})`];
    if (change.binary) parts.push('[binary]');
    if (change.untracked) parts.push('[untracked]');
    if (change.language) parts.push(`[${change.language}]`);
    const symbols = report.symbols.filter((s) => s.file === change.path);
    if (symbols.length) parts.push(`symbols: ${symbols.slice(0, 6).map((s) => s.name).join(', ')}`);
    lines.push(parts.join(' '));
  }
  if (report.changes.length > cap) lines.push(`- … ${report.changes.length - cap} more file(s) not listed`);
  return lines.join('\n');
}

/**
 * The diff, in change-first form.
 *
 * Hunk bodies are kept intact (a hunk without its surrounding lines is not a
 * diff), but each file is added whole or not at all. Files are ordered by the
 * severity of the findings anchored in them, so if the budget forces a cut, the
 * model keeps the files where something was actually reported.
 */
function diffSections(report: ReviewReport, includeCode: boolean): Array<{ path: string; text: string; value: number }> {
  const riskByFile = new Map<string, number>();
  for (const finding of report.findings) {
    const weight = 10 - SEVERITY_ORDER[finding.severity];
    riskByFile.set(finding.file, Math.max(riskByFile.get(finding.file) ?? 0, weight));
  }
  const out: Array<{ path: string; text: string; value: number }> = [];
  for (const change of report.changes) {
    if (change.binary) continue;
    const body = includeCode
      ? change.hunks.map((h) => {
        const header = `@@ ${h.header}`;
        const lines = h.lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`).join('\n');
        return `${header}\n${lines}`;
      }).join('\n')
      // Without code consent the diff itself is still repository content, so it
      // is reduced to its shape: which lines changed, not their text.
      : change.hunks.map((h) => `@@ ${h.header}\n${h.lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}[${l.kind === 'context' ? '…' : 'line'}]`).join('\n')}`).join('\n');
    const value = (riskByFile.get(change.path) ?? 0) + Math.min(6, change.additions + change.deletions) / 10;
    out.push({ path: change.path, text: `### FILE ${change.path}${change.status !== 'modified' ? ` (${change.status})` : ''}\n${body}`, value });
  }
  return out.sort((a, b) => b.value - a.value);
}

function findingsSection(findings: Finding[], cap: number): string {
  if (findings.length === 0) return '## Deterministic findings\n(none)';
  const ordered = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const lines = ordered.slice(0, cap).map((f) =>
    `- [${f.id}] ${f.severity}/${f.confidence} ${f.category}/${f.kind} ${f.file}:${f.range.start} — ${truncate(f.title, 110)}`);
  if (findings.length > cap) lines.push(`- … ${findings.length - cap} more finding(s), omitted from context`);
  return `## Deterministic findings (already reported; do not restate)\n${lines.join('\n')}`;
}

function symbolsSection(report: ReviewReport): string {
  const symbols = report.symbols.slice(0, 60);
  if (symbols.length === 0) return '## Changed symbols\n(none detected)';
  const lines = symbols.map((s) => {
    const bits = [`- ${s.change} ${s.kind} ${s.file}:${s.range.start}`, s.container ? `${s.container}.${s.name}` : s.name];
    if (s.exported) bits.push('(exported)');
    if (s.signatureChanged) bits.push('[signature changed]');
    if (s.referenceCount > 0) bits.push(`refs:${s.referenceCount}`);
    return bits.join(' ');
  });
  if (report.symbols.length > symbols.length) lines.push(`- … ${report.symbols.length - symbols.length} more symbol(s)`);
  return `## Changed symbols\n${lines.join('\n')}`;
}

function headerSection(report: ReviewReport, tiers: string): string {
  const factors = report.risk.factors.slice(0, 4).map((f) => `${f.label} +${f.points}`).join(', ');
  return [
    '# DiffWise review context (change-first v2)',
    `Repository: ${report.repository.name} (branch ${report.repository.branch})`,
    `Target: ${report.target.label}`,
    `Risk: ${report.risk.level} ${report.risk.score}/100${factors ? ` — ${factors}` : ''}`,
    `Changed files: ${report.changes.length}; changed symbols: ${report.symbols.length}; deterministic findings: ${report.findings.length}`,
    `Context tiers: ${tiers}`,
  ].join('\n');
}

function testsSection(report: ReviewReport): string | undefined {
  const parts: string[] = [];
  if (report.tests.files.length) parts.push(`related test files: ${report.tests.files.slice(0, 12).map((t) => t.path).join(', ')}`);
  if (report.tests.uncoveredChanges.length) parts.push(`changed files with no related test: ${report.tests.uncoveredChanges.slice(0, 12).join(', ')}`);
  if (parts.length === 0) return undefined;
  return `## Test impact\n${parts.map((p) => `- ${p}`).join('\n')}`;
}

function callersSection(report: ReviewReport): string | undefined {
  const impacted = report.architecture.graph.directlyImpacted.slice(0, 20);
  if (impacted.length === 0) return undefined;
  const examples = [...new Set(report.symbols.flatMap((s) => s.referenceExamples ?? []))].slice(0, 12);
  const lines = [`- depends on a changed file: ${impacted.join(', ')}`];
  if (examples.length) lines.push(`- references a changed symbol: ${examples.join(', ')}`);
  return `## Callers and dependents (paths only)\n${lines.join('\n')}`;
}

function docsSection(report: ReviewReport): string | undefined {
  if (report.documentation.findings.length === 0 && report.documentation.files.length === 0) return undefined;
  const lines: string[] = [];
  for (const finding of report.documentation.findings.slice(0, 10)) {
    lines.push(`- ${finding.status} ${finding.document}: ${truncate(finding.title, 100)}`);
  }
  if (report.documentation.files.length) {
    lines.push(`- documents in scope: ${report.documentation.files.slice(0, 8).map((d) => d.path).join(', ')}`);
  }
  return `## Documentation\n${lines.join('\n')}`;
}

function intentSection(report: ReviewReport): string | undefined {
  const intents = report.agent.intents.slice(0, 2);
  const requirements = (report.requirements ?? []).slice(0, 5);
  if (intents.length === 0 && requirements.length === 0) return undefined;
  const lines: string[] = [];
  for (const intent of intents) lines.push(`- intent: ${truncate(`${intent.title}: ${intent.detail}`, 400)}`);
  for (const requirement of requirements) lines.push(`- requirement (${requirement.source}): ${truncate(`${requirement.title}: ${requirement.body}`, 300)}`);
  return `## Recorded intent and requirements\n${lines.join('\n')}`;
}

function knowledgeSection(report: ReviewReport): string | undefined {
  if (report.knowledge.length === 0) return undefined;
  const lines = report.knowledge.slice(0, 12).map((k) => `- (${k.kind}) ${k.title}${k.path ? ` @ ${k.path}` : ''}: ${truncate(k.text, 160)}`);
  return `## Project knowledge\n${lines.join('\n')}`;
}

function groupsSection(report: ReviewReport): string | undefined {
  if (report.changeGroups.length === 0) return undefined;
  const lines = report.changeGroups.slice(0, 10).map((g) =>
    `- ${g.id} ${g.title} (${g.module}): ${g.files.length} file(s), +${g.additions}/-${g.deletions}${g.symbols.length ? `, symbols: ${g.symbols.slice(0, 4).join(', ')}` : ''}`);
  return `## Semantic change groups\n${lines.join('\n')}`;
}

function focusSection(finding: Finding): string {
  return [
    '## Focus finding',
    `id: ${finding.id}`,
    `title: ${finding.title}`,
    `severity: ${finding.severity}; category: ${finding.category}; kind: ${finding.kind}; confidence: ${finding.confidence}`,
    `file: ${finding.file}:${finding.range.start}-${finding.range.end}`,
    `description: ${finding.description}`,
    `why it matters: ${finding.whyItMatters}`,
    `recommendation: ${finding.recommendation}`,
    `evidence:\n${finding.evidence.map((e) => `- ${e.file ?? '(graph)'}${e.line ? `:${e.line}` : ''} ${e.note}${e.snippet ? `\n  ${truncate(e.snippet, 300)}` : ''}`).join('\n')}`,
  ].join('\n');
}

/** Windows of real code around the changed lines of each changed file. */
function windowSections(report: ReviewReport, repoFiles: Map<string, string>, maxTotalLines: number): Array<{ path: string; text: string; lines: number }> {
  const out: Array<{ path: string; text: string; lines: number }> = [];
  let budgetLines = maxTotalLines;
  for (const change of report.changes) {
    if (change.binary || change.status === 'deleted') continue;
    const content = repoFiles.get(change.path);
    if (!content) continue;
    const { added } = changedLineNumbers(change);
    const symbolRanges = report.symbols.filter((s) => s.file === change.path).flatMap((s) => s.changeRanges);
    const ranges: CodeWindow[] = [
      ...added.map((line) => ({ start: line, end: line })),
      ...symbolRanges.map((r) => ({ start: r.start, end: r.end })),
    ];
    if (ranges.length === 0) continue;
    const result = codeWindows(content, ranges, { radius: Math.min(MAX_WINDOW_RADIUS, 10), mergeGap: 8, maxWindows: 4, maxLines: Math.min(budgetLines, MAX_FILE_LINES) });
    if (!result.text) continue;
    const text = `### ${change.path} (changed regions)\n<untrusted_repository_content>\n${result.text}\n</untrusted_repository_content>`;
    budgetLines -= result.lines;
    out.push({ path: change.path, text, lines: result.lines });
    if (budgetLines <= 20) break;
  }
  return out;
}

function deepSection(report: ReviewReport, repoFiles: Map<string, string>): string | undefined {
  const changed = new Set(report.changes.map((c) => c.path));
  const candidates = report.architecture.graph.directlyImpacted.filter((p) => !changed.has(p)).slice(0, 3);
  if (candidates.length === 0) return undefined;
  const parts: string[] = [];
  for (const path of candidates) {
    const content = repoFiles.get(path);
    if (!content) continue;
    parts.push(`### ${path} (related implementation)\n<untrusted_repository_content>\n${truncate(content, 6_000)}\n</untrusted_repository_content>`);
  }
  return parts.length ? `## Deep investigation context (T3)\n${parts.join('\n\n')}` : undefined;
}

export function buildChangeFirstContext(
  report: ReviewReport,
  repoFiles: Map<string, string>,
  opts: ChangeFirstOptions = {},
): ChangeFirstPack {
  const includeCode = opts.includeCode ?? false;
  const budget = new TokenBudget({
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.contextLimit !== undefined ? { contextLimit: opts.contextLimit } : {}),
    ...(opts.inputLimit !== undefined ? { inputLimit: opts.inputLimit } : {}),
    ...(opts.reservedOutput !== undefined ? { reservedOutput: opts.reservedOutput } : {}),
    ...(opts.safetyMargin !== undefined ? { safetyMargin: opts.safetyMargin } : {}),
  });

  const sections: PackableSection[] = [];
  const filesIncluded: string[] = [];
  const tiers = ['T1 essential'];

  sections.push({ id: 'header', tier: 1, priority: 100, required: true, text: headerSection(report, 'T1 always; T2 as budget allows'), maxTokens: 400 });
  sections.push({ id: 'changes', tier: 1, priority: 96, text: changesSection(report), maxTokens: 2_000 });
  sections.push({ id: 'symbols', tier: 1, priority: 92, text: symbolsSection(report), maxTokens: 2_000 });
  sections.push({ id: 'findings', tier: 1, priority: 90, text: findingsSection(report.findings, 40), maxTokens: 2_500 });

  const intent = intentSection(report);
  if (intent) sections.push({ id: 'intent', tier: 1, priority: 74, text: intent, maxTokens: 1_200 });

  // The diff is the reason the request exists: it is required, but bounded so a
  // single enormous migration cannot crowd out everything else. Files beyond
  // the bound are listed as dropped, never silently truncated mid-hunk.
  const diffParts = diffSections(report, includeCode);
  const diffText: string[] = ['## Diff (change-first)'];
  const diffBudgetTokens = Math.floor(budget.inputLimit * 0.55);
  let diffUsed = 0;
  let diffDropped = 0;
  for (const part of diffParts) {
    const tokens = estimateTokens(part.text, budget.model);
    if (diffUsed + tokens > diffBudgetTokens) { diffDropped += 1; continue; }
    diffText.push(part.text);
    diffUsed += tokens;
    filesIncluded.push(part.path);
  }
  if (diffDropped > 0) {
    diffText.push(`… ${diffDropped} changed file(s) omitted from the diff to stay inside the budget: ${diffParts.slice(-diffDropped).map((p) => p.path).join(', ')}`);
  }
  sections.push({ id: 'diff', tier: 1, priority: 99, required: true, text: diffText.join('\n\n'), maxTokens: diffBudgetTokens + 200 });

  if (opts.includeGroups) {
    const groups = groupsSection(report);
    if (groups) sections.push({ id: 'groups', tier: 2, priority: 70, text: groups, maxTokens: 800 });
  }

  if (includeCode) {
    const windows = windowSections(report, repoFiles, Math.min(600, Math.floor(budget.inputLimit * 0.25)));
    if (windows.length) {
      tiers.push('T2 code windows');
      for (const w of windows) filesIncluded.push(w.path);
      sections.push({
        id: 'windows', tier: 2, priority: 78,
        text: `## Code around the changes (untrusted content)\n${windows.map((w) => w.text).join('\n\n')}`,
        maxTokens: Math.floor(budget.inputLimit * 0.3),
      });
    }
  }

  const callers = callersSection(report);
  if (callers) { tiers.push('T2 callers'); sections.push({ id: 'callers', tier: 2, priority: 58, text: callers, maxTokens: 700 }); }
  const tests = testsSection(report);
  if (tests) { tiers.push('T2 tests'); sections.push({ id: 'tests', tier: 2, priority: 52, text: tests, maxTokens: 500 }); }
  const docs = docsSection(report);
  if (docs) sections.push({ id: 'documentation', tier: 2, priority: 48, text: docs, maxTokens: 900 });
  const knowledge = knowledgeSection(report);
  if (knowledge) sections.push({ id: 'knowledge', tier: 2, priority: 40, text: knowledge, maxTokens: 900 });

  if (opts.focusFinding) {
    sections.push({ id: 'focus', tier: 1, priority: 98, required: true, text: focusSection(opts.focusFinding), maxTokens: 1_600 });
  }

  if (opts.includeDeep) {
    const deep = deepSection(report, repoFiles);
    if (deep) { tiers.push('T3 deep'); sections.push({ id: 'deep', tier: 3, priority: 20, text: deep, maxTokens: 4_000 }); }
  }

  const packed: PackResult = packSections(sections, budget);
  const text = packed.sections.map((s) => s.text).join('\n\n');
  const redacted = redactSecrets(text);
  const fingerprint = createHash('sha256')
    .update(packed.sections.map((s) => `${s.id}\u0000${s.text}`).join('\u0001'))
    .digest('hex')
    .slice(0, 32);

  return {
    text: redacted.text,
    approxTokens: estimateTokens(redacted.text, budget.model),
    tokens: estimateTokens(redacted.text, budget.model),
    truncated: packed.truncated,
    redactions: redacted.redactions,
    filesIncluded: [...new Set(filesIncluded)],
    sections: packed.sections.map((s) => ({ id: s.id, tier: s.tier, tokens: s.tokens, clipped: s.clipped })),
    dropped: packed.dropped,
    clipped: packed.clipped,
    tier: packed.dropped.some((id) => id === 'windows' || id === 'callers') ? 1 : 2,
    fingerprint,
    budget: budget.describe(),
  };
}
