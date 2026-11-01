/**
 * Deterministic verification entry point.
 *
 * This runs on every review, with or without a model. It normalises and groups
 * the findings, runs the static checks and applies the verdict policy. When a
 * provider is configured, the AI opinions are added to the same policy — they
 * never replace it.
 */
import type { Finding, ReviewReport } from '../types';
import { finalizeVerification, prepareVerification, verificationSummary, type VerificationOutcome } from './engine';
import type { VerificationContext, VerificationPolicy, EvidenceClass } from './types';

export interface DeterministicVerificationResult {
  findings: Finding[];
  withheld: Finding[];
  outcomes: VerificationOutcome[];
  summary: {
    performed: boolean;
    policy: string;
    confirmed: number;
    likely: number;
    unverified: number;
    rejected: number;
    disputed: number;
    corroborated: number;
    reproducible: number;
    durationMs?: number;
  };
  verdicts: Array<{ findingId: string; status: VerificationOutcome['verification']['status'] }>;
  durationMs: number;
}

function candidateFor(finding: Finding): { producer: string; finding: Parameters<typeof prepareVerification>[0][number]['finding'] } {
  return {
    producer: finding.source === 'deterministic' ? `rule:${finding.ruleId}` : `reviewer:${finding.reviewerId ?? 'unknown'}`,
    finding: {
      id: finding.id,
      title: finding.title,
      description: finding.description,
      severity: finding.severity,
      category: finding.category,
      kind: finding.kind,
      confidence: finding.confidence,
      file: finding.file,
      range: finding.range,
      evidence: finding.evidence,
      recommendation: finding.recommendation,
      ruleId: finding.ruleId,
      source: finding.source,
      tags: finding.tags,
    },
  };
}

/** Attach outcomes to findings; uncovered findings become explicit UNVERIFIED. */
export function applyOutcomes(findings: Finding[], outcomes: VerificationOutcome[], now: Date): Finding[] {
  const byMember = new Map<string, VerificationOutcome>();
  for (const outcome of outcomes) {
    for (const member of outcome.group.members) byMember.set(member.finding.id, outcome);
  }
  return findings.map((finding) => {
    let outcome = byMember.get(finding.id);
    if (!outcome) {
      outcome = outcomes.find((o) =>
        o.group.file === finding.file
        && o.group.range.start <= finding.range.end
        && finding.range.start <= o.group.range.end
        && o.group.category === finding.category);
    }
    if (!outcome) {
      const classes: Record<EvidenceClass, number> = { static: 0, model: 0, test: 0, runtime: 0, human: 0 };
      return {
        ...finding,
        verification: {
          status: 'UNVERIFIED' as const,
          method: 'No verification group covered this finding; nothing was checked.',
          policy: 'default/v1',
          checks: [],
          verifiers: [],
          evidenceClasses: classes,
          confidence: 'low' as const,
          severity: { original: finding.severity, effective: finding.severity, reason: 'Not verified; severity unchanged.' },
          history: [{ at: now.toISOString(), status: 'UNVERIFIED' as const, trigger: 'review' as const, note: 'no verification group' }],
          notes: ['This finding was produced but never verified. Treat it as a lead, not a defect.'],
          reproducible: true,
        },
      };
    }
    const verification = outcome.verification;
    const adjusted = verification.severity.effective !== finding.severity;
    return {
      ...finding,
      severity: verification.severity.effective,
      ...(adjusted ? { severityAssessed: finding.severity } : {}),
      confidence: verification.confidence,
      verification,
    };
  });
}

const RANK: Record<string, number> = { CONFIRMED: 0, LIKELY: 1, DISPUTED: 2, UNVERIFIED: 3, REJECTED: 4 };

/** Split findings into published and withheld according to the policy floor. */
export function splitByPolicy(findings: Finding[], minimum: 'CONFIRMED' | 'LIKELY' | 'UNVERIFIED'): { published: Finding[]; withheld: Finding[] } {
  const published: Finding[] = [];
  const withheld: Finding[] = [];
  for (const finding of findings) {
    const status = finding.verification?.status;
    if (!status) { published.push(finding); continue; }
    if ((RANK[status] ?? 4) <= (RANK[minimum] ?? 3)) published.push(finding);
    else withheld.push(finding);
  }
  return { published, withheld };
}

export function contextFromReport(
  report: Pick<ReviewReport, 'verification' | 'decisions'>,
  files: Map<string, string>,
  oldFiles: Map<string, string | null> | undefined,
  addedLines: Map<string, Set<number>>,
  changedFiles: Set<string>,
): VerificationContext {
  return {
    files,
    ...(oldFiles ? { oldFiles } : {}),
    addedLines,
    changedFiles,
    executions: report.verification.map((record) => ({
      id: record.id,
      ...(record.findingId ? { findingId: record.findingId } : {}),
      command: record.execution.command,
      status: record.execution.status,
      exitCode: record.execution.exitCode,
      at: record.at,
    })),
    ...(report.decisions?.length
      ? {
        humanDecisions: report.decisions.map((d) => ({
          findingId: d.findingId ?? '', action: d.action, actor: d.actor, at: d.at, rationale: d.rationale,
        })),
      }
      : {}),
  };
}

export function runDeterministicVerification(input: {
  findings: Finding[];
  context: VerificationContext;
  policy?: Partial<VerificationPolicy>;
  minimumStatus: 'CONFIRMED' | 'LIKELY' | 'UNVERIFIED';
  now?: Date;
}): DeterministicVerificationResult {
  const t0 = Date.now();
  const now = input.now ?? new Date();
  const prepared = prepareVerification(input.findings.map(candidateFor), input.context);
  const outcomes = finalizeVerification(prepared, input.context, {
    policy: { aiVerification: false, ...input.policy, minimumStatus: input.minimumStatus },
  });
  const withVerification = applyOutcomes(input.findings, outcomes, now);
  const { published, withheld } = splitByPolicy(withVerification, input.minimumStatus);
  const summary = verificationSummary(outcomes);
  return {
    findings: published,
    withheld,
    outcomes,
    summary: {
      performed: true,
      policy: 'deterministic/v1',
      ...summary,
      durationMs: Date.now() - t0,
    },
    verdicts: outcomes.map((o) => ({ findingId: o.findingId, status: o.verification.status })),
    durationMs: Date.now() - t0,
  };
}
