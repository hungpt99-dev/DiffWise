/**
 * Reviewer scope assembly.
 *
 * A reviewer gets a bounded, attributed slice of the repository: the diff, the
 * changed files, a few related files that explain them, the deterministic
 * findings, the recorded intent and any imported requirements. Secrets are
 * redacted before anything leaves the process.
 *
 * Scoping is a cost control and a quality control: an unscoped prompt produces
 * vague findings that cannot be verified.
 */
import { changedLineNumbers, clipToTokens, codeWindows, estimateTokens, redactSecrets } from '@diffwise/core';
import type {
  ChangedSymbol, FileChange, Language, RequirementRecord, ReviewReport, ReviewerScopeInput, ReviewerSpec,
} from '@diffwise/core';

export interface ScopeBuildInput {
  report: ReviewReport;
  repoFiles: Map<string, string>;
  spec: ReviewerSpec;
  requirements?: RequirementRecord[];
  skill?: { id: string; version: string; instructions: string };
  /** Extra characters allowed for the diff, independent of file content. */
  maxDiffChars?: number;
}

export interface BuiltScope extends ReviewerScopeInput {
  /** Number of secret values redacted before the prompt was assembled. */
  redactions: number;
  /** True when any section was cut to fit the budget. */
  truncated: boolean;
  /** Estimated prompt tokens for everything in this scope. */
  tokens: number;
  /** Changed files sent as an excerpt around the changed lines, not in full. */
  excerpted: string[];
}

function clip(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.2));
  return { text: `${head}\n…[${max - head.length - tail.length} characters omitted from the middle]…\n${tail}`, cut: true };
}

function symbolsFor(symbols: ChangedSymbol[], path: string): string[] {
  return symbols.filter((s) => s.file === path).map((s) => `${s.kind} ${s.name}`).slice(0, 12);
}

function diffFor(changes: FileChange[], budget: number): { text: string; cut: boolean } {
  const parts: string[] = [];
  let used = 0;
  let cut = false;
  for (const change of changes) {
    if (used + change.patch.length > budget) {
      cut = true;
      parts.push(`--- ${change.path} (diff omitted: budget reached) ---`);
      continue;
    }
    parts.push(change.patch);
    used += change.patch.length;
  }
  return { text: parts.join('\n'), cut };
}

/** Rank related files so the most explanatory ones survive the budget. */
function relatedFiles(report: ReviewReport, repoFiles: Map<string, string>, changed: Set<string>): Array<{ path: string; reason: string }> {
  const reasons = new Map<string, string>();
  const graph = report.architecture.graph;
  for (const importer of graph.directlyImpacted) {
    if (changed.has(importer)) continue;
    if (!reasons.has(importer)) reasons.set(importer, 'imports or depends on a changed file');
  }
  for (const change of report.changes) {
    for (const symbol of symbolsFor(report.symbols, change.path)) {
      const name = symbol.split(' ').pop() ?? '';
      if (name.length < 4) continue;
      let seen = 0;
      for (const [path, content] of repoFiles) {
        if (changed.has(path) || reasons.has(path)) continue;
        if (!content.includes(name)) continue;
        reasons.set(path, `references ${name}, changed in ${change.path}`);
        seen += 1;
        if (seen >= 2) break;
      }
    }
  }
  return [...reasons.entries()]
    .filter(([path]) => repoFiles.has(path))
    .slice(0, 8)
    .map(([path, reason]) => ({ path, reason }));
}

export function buildReviewerScope(input: ScopeBuildInput): BuiltScope {
  const { report, repoFiles, spec } = input;
  const scope = spec.budget.scope;
  const changed = new Set(report.changes.map((c) => c.path));
  let redactions = 0;
  let truncated = false;

  // The diff is the subject of the review; file excerpts only explain it. If
  // the budget cannot hold both, the diff must survive intact — dropping a
  // changed file from the prompt while keeping its (unchanged) surroundings is
  // how a reviewer ends up reviewing the wrong lines.
  const maxDiffChars = input.maxDiffChars ?? Math.floor(scope.maxContextChars * 0.7);
  const diff = diffFor(report.changes, maxDiffChars);
  truncated = truncated || diff.cut;
  const diffRedacted = redactSecrets(diff.text);
  redactions += diffRedacted.redactions;

  // Changed files are sent as code windows around the changed lines. Sending
  // the whole file duplicates the diff (which is already above), and on large
  // files most of it is unrelated to the change: that was the single largest
  // avoidable token cost in the reviewer prompt.
  const perFileTokens = Math.max(300, Math.floor((scope.maxContextChars / 4) * 0.3 / Math.max(1, Math.min(scope.maxFiles, report.changes.length))));
  const files: ReviewerScopeInput['files'] = [];
  const excerpted: string[] = [];
  for (const change of report.changes.slice(0, scope.maxFiles)) {
    if (change.status === 'deleted') continue;
    const content = repoFiles.get(change.path);
    if (content === undefined) continue;
    const { added } = changedLineNumbers(change);
    const symbolRanges = report.symbols.filter((s) => s.file === change.path).flatMap((s) => s.changeRanges);
    const ranges = [
      ...added.map((line) => ({ start: line, end: line })),
      ...symbolRanges.map((r) => ({ start: r.start, end: r.end })),
    ];
    let excerpt = ranges.length > 0
      ? codeWindows(content, ranges, { radius: 14, mergeGap: 8, maxWindows: 3, maxLines: 220, numbered: false }).text
      : clip(content, perFileTokens * 4).text;
    const header = ranges.length > 0
      ? `// excerpt around the changed lines of ${change.path}; unchanged regions are omitted, line numbers refer to the file`
      : `// ${change.path} (changed line numbers unavailable; excerpt from the start of the file)`;
    let body = `${header}\n${excerpt}`;
    const clipped = clipToTokens(body, perFileTokens, { marker: '\n// …[remainder of the excerpt omitted to fit the reviewer budget]' });
    truncated = truncated || clipped.clipped;
    body = clipped.text;
    if (clipped.clipped) excerpted.push(change.path);
    const redacted = redactSecrets(body);
    redactions += redacted.redactions;
    files.push({ path: change.path, language: change.language as Language, content: redacted.text });
  }

  const related: ReviewerScopeInput['related'] = [];
  if (scope.includeRelated) {
    const budget = Math.max(1_200, Math.floor(scope.maxContextChars * 0.2 / 4));
    for (const candidate of relatedFiles(report, repoFiles, changed)) {
      const content = repoFiles.get(candidate.path);
      if (content === undefined) continue;
      const clipped = clip(content, budget);
      truncated = truncated || clipped.cut;
      const redacted = redactSecrets(clipped.text);
      redactions += redacted.redactions;
      related.push({ path: candidate.path, reason: candidate.reason, content: redacted.text });
    }
  }

  const deterministicFindings = scope.includeDeterministic
    ? report.findings
      .filter((f) => f.source === 'deterministic')
      .slice(0, 24)
      .map((f) => ({ id: f.id, title: f.title, category: f.category, severity: f.severity, file: f.file, range: f.range }))
    : [];

  const intentSource = report.agent.intents[0];
  const intent = scope.includeIntent && intentSource
    ? `${intentSource.title}\n${intentSource.detail}`.slice(0, 1_500)
    : undefined;

  return {
    diff: diffRedacted.text,
    files,
    related,
    deterministicFindings,
    ...(intent ? { intent } : {}),
    ...(input.requirements?.length
      ? { requirements: input.requirements.slice(0, 6).map((r) => ({ id: r.id, title: r.title, body: r.body.slice(0, 1_200), source: r.source })) }
      : {}),
    ...(input.skill ? { skill: input.skill } : {}),
    redactions,
    truncated,
    tokens: estimateTokens(
      [diffRedacted.text, intent ?? '', ...files.map((f) => f.content), ...related.map((r) => r.content)].join('\n'),
    ),
    excerpted,
  };
}
