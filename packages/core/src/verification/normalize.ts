/**
 * Finding normalization, grouping and deduplication.
 *
 * Deterministic rules, reviewers and (later) integrations all describe the same
 * defect in different words. Verification must therefore operate on groups, not
 * on raw producers: verifying the same bug four times wastes budget and makes
 * the report look worse than the code.
 */
import type { Evidence, Severity } from '../types';
import { SEVERITY_ORDER } from '../types';
import type { VerificationCandidate } from './types';

export interface NormalizedFinding extends VerificationCandidate {
  /** Stable key across producers for the same defect. */
  groupKey: string;
  /** Tokens used for similarity, pre-computed once. */
  titleTokens: Set<string>;
  lineBudget: number;
}

export interface FindingGroup {
  key: string;
  file: string;
  range: { start: number; end: number };
  category: string;
  canonical: NormalizedFinding;
  members: NormalizedFinding[];
  /** Merged evidence, de-duplicated by file/line/note. */
  evidence: Evidence[];
  /** Producer ids that described this defect. */
  producers: string[];
  /** True when more than one independent producer agreed. */
  corroborated: boolean;
  severity: Severity;
  /** Highest severity among members, before verification adjusts it. */
  proposedSeverity: Severity;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'that', 'this', 'it', 'as', 'be', 'by', 'from']);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Categories that describe the same underlying defect for grouping purposes. */
const CATEGORY_FAMILY: Record<string, string> = {
  correctness: 'behaviour',
  'error-handling': 'behaviour',
  reliability: 'behaviour',
  security: 'security',
  concurrency: 'concurrency',
  database: 'data',
  'api-contract': 'api',
  architecture: 'structure',
  maintainability: 'structure',
  performance: 'performance',
  resources: 'performance',
  tests: 'tests',
  documentation: 'docs',
  configuration: 'config',
};

function family(category: string): string {
  return CATEGORY_FAMILY[category] ?? category;
}

export function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }, slack = 0): boolean {
  return a.start - slack <= b.end && b.start - slack <= a.end;
}

export function normalizeCandidate(candidate: VerificationCandidate): NormalizedFinding {
  const file = candidate.finding.file.replace(/^\.\//, '').replace(/\\/g, '/');
  const start = Math.max(1, Math.trunc(candidate.finding.range.start));
  const end = Math.max(start, Math.trunc(candidate.finding.range.end));
  return {
    ...candidate,
    finding: { ...candidate.finding, file, range: { start, end } },
    groupKey: `${file}::${family(candidate.finding.category)}::${Math.floor(start / 5)}`,
    titleTokens: tokenize(`${candidate.finding.title} ${candidate.finding.description.slice(0, 160)}`),
    lineBudget: end - start + 1,
  };
}

function mergeEvidence(into: Evidence[], additions: Evidence[]): void {
  for (const e of additions) {
    const duplicate = into.some((existing) =>
      existing.file === e.file
      && (existing.line ?? 0) === (e.line ?? 0)
      && existing.note === e.note
      && (existing.snippet ?? '') === (e.snippet ?? ''));
    if (!duplicate) into.push(e);
  }
}

/**
 * Group candidates that describe the same defect.
 *
 * Similarity threshold is deliberately conservative: two findings on adjacent
 * lines with different categories stay separate. Over-merging hides real
 * defects, which is a worse failure than a duplicate.
 */
export function groupCandidates(candidates: NormalizedFinding[], options: { lineSlack?: number; similarityThreshold?: number } = {}): FindingGroup[] {
  const slack = options.lineSlack ?? 2;
  const threshold = options.similarityThreshold ?? 0.34;
  const groups: FindingGroup[] = [];

  for (const candidate of candidates) {
    const match = groups.find((g) => {
      if (g.file !== candidate.finding.file) return false;
      if (family(g.category) !== family(candidate.finding.category)) return false;
      if (!rangesOverlap(g.range, candidate.finding.range, slack)) return false;
      if (g.canonical.finding.ruleId && g.canonical.finding.ruleId === candidate.finding.ruleId) return true;
      return jaccard(g.canonical.titleTokens, candidate.titleTokens) >= threshold;
    });
    if (match) {
      match.members.push(candidate);
      mergeEvidence(match.evidence, candidate.finding.evidence);
      if (!match.producers.includes(candidate.producer)) match.producers.push(candidate.producer);
      match.range = {
        start: Math.min(match.range.start, candidate.finding.range.start),
        end: Math.max(match.range.end, candidate.finding.range.end),
      };
      if (SEVERITY_ORDER[candidate.finding.severity] < SEVERITY_ORDER[match.proposedSeverity]) {
        match.proposedSeverity = candidate.finding.severity;
      }
      match.canonical = pickCanonical(match.members);
      continue;
    }
    groups.push({
      key: candidate.groupKey,
      file: candidate.finding.file,
      range: { ...candidate.finding.range },
      category: candidate.finding.category,
      canonical: candidate,
      members: [candidate],
      evidence: [...candidate.finding.evidence],
      producers: [candidate.producer],
      corroborated: false,
      severity: candidate.finding.severity,
      proposedSeverity: candidate.finding.severity,
    });
  }

  for (const group of groups) {
    group.canonical = pickCanonical(group.members);
    group.proposedSeverity = group.members.reduce<Severity>(
      (worst, m) => (SEVERITY_ORDER[m.finding.severity] < SEVERITY_ORDER[worst] ? m.finding.severity : worst),
      group.members[0]?.finding.severity ?? 'low',
    );
    group.severity = group.proposedSeverity;
    // "Corroborated" means a deterministic rule and a reviewer independently
    // described the same defect. Two reviewers agreeing is not corroboration
    // of a *defect*, only of an interpretation.
    group.corroborated = group.producers.some((p) => p.startsWith('rule:'))
      && group.producers.some((p) => p.startsWith('reviewer:'));
  }

  return groups.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
      || a.file.localeCompare(b.file)
      || a.range.start - b.range.start,
  );
}

/**
 * Canonical member: deterministic producer first (it carries reproducible
 * evidence), then the highest severity, then the most evidence.
 */
function pickCanonical(members: NormalizedFinding[]): NormalizedFinding {
  const sorted = [...members].sort((a, b) => {
    const sourceRank = (c: NormalizedFinding): number => (c.finding.source === 'deterministic' ? 0 : 1);
    return sourceRank(a) - sourceRank(b)
      || SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
      || b.finding.evidence.length - a.finding.evidence.length
      || a.finding.id.localeCompare(b.finding.id);
  });
  return sorted[0] as NormalizedFinding;
}
