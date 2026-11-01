/**
 * SARIF 2.1.0 export.
 *
 * SARIF is the only interchange format GitHub code scanning, Azure DevOps and
 * most CI dashboards accept, so DiffWise treats it as a first-class output —
 * not a formatting afterthought. Each finding becomes one rule + one result,
 * with the exact region and the finding id as a partial fingerprint so a
 * re-review of the same defect keeps a stable identity in the code-scanning UI.
 */
import type { Finding, ReviewReport, Severity } from '../types';

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';

export interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: SarifTool };
  automationDetails: { id: string };
  invocations: Array<{
    executionSuccessful: boolean;
    startTimeUtc: string;
    endTimeUtc: string;
    workingDirectory: { uri: string };
    toolExecutionNotifications: Array<{ level: 'warning' | 'error'; message: { text: string } }>;
  }>;
  originalUriBaseIds: Record<string, { uri: string }>;
  results: SarifResult[];
  properties: Record<string, unknown>;
}

interface SarifTool {
  name: string;
  informationUri: string;
  version: string;
  semanticVersion: string;
  rules: SarifRule[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription?: { text: string };
  defaultConfiguration: { level: SarifLevel };
  help: { text: string; markdown: string };
  properties: Record<string, unknown>;
}

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string; markdown?: string };
  locations: SarifLocation[];
  relatedLocations?: SarifLocation[];
  partialFingerprints: Record<string, string>;
  properties: Record<string, unknown>;
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId?: string };
    region: { startLine: number; endLine: number; startColumn?: number };
  };
  message?: { text: string };
}

type SarifLevel = 'error' | 'warning' | 'note' | 'none';

export interface SarifOptions {
  /** Tool version recorded in the driver. */
  toolVersion?: string;
  /** Include findings below this severity. Defaults to all. */
  minSeverity?: Severity;
  /** Record the command that produced the report. */
  command?: string;
}

const LEVEL: Record<Severity, SarifLevel> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function slug(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'finding';
}

function ruleIdFor(finding: Finding): string {
  // The rule id is already namespaced (e.g. security.sql-injection); fall back
  // to the finding id when a rule did not provide one.
  return finding.ruleId && finding.ruleId !== 'unknown' ? finding.ruleId : `diffwise.${slug(finding.id)}`;
}

function regionOf(finding: Finding): { startLine: number; endLine: number } {
  return { startLine: finding.range.start, endLine: Math.max(finding.range.start, finding.range.end) };
}

function resultOf(finding: Finding, ruleIndex: number): SarifResult {
  const location: SarifLocation = {
    physicalLocation: {
      artifactLocation: { uri: finding.file, uriBaseId: '%SRCROOT%' },
      region: regionOf(finding),
    },
    message: { text: finding.title },
  };
  const related: SarifLocation[] = [];
  for (const evidence of finding.evidence) {
    if (!evidence.file || evidence.file === finding.file) continue;
    related.push({
      physicalLocation: {
        artifactLocation: { uri: evidence.file, uriBaseId: '%SRCROOT%' },
        region: { startLine: evidence.line ?? 1, endLine: evidence.endLine ?? evidence.line ?? 1 },
      },
      message: { text: evidence.note.slice(0, 500) },
    });
  }
  return {
    ruleId: ruleIdFor(finding),
    ruleIndex,
    level: LEVEL[finding.severity],
    message: {
      text: `${finding.title} — ${finding.description}`.slice(0, 2000),
      markdown: `**${finding.title}**\n\n${finding.description}\n\n**Why it matters:** ${finding.whyItMatters}\n\n**Recommendation:** ${finding.recommendation}`,
    },
    locations: [location],
    ...(related.length ? { relatedLocations: related.slice(0, 10) } : {}),
    partialFingerprints: {
      'diffwiseFindingId/v1': finding.id,
      'diffwiseRule/v1': ruleIdFor(finding),
    },
    properties: {
      severity: finding.severity,
      category: finding.category,
      kind: finding.kind,
      confidence: finding.confidence,
      source: finding.source,
      evidenceCount: finding.evidence.length,
      tags: finding.tags,
    },
  };
}

export function buildSarif(report: ReviewReport, options: SarifOptions = {}): SarifLog {
  const min = options.minSeverity ? RANK[options.minSeverity] : RANK.info;
  const findings = report.findings.filter((f) => RANK[f.severity] <= min);

  const rules: SarifRule[] = [];
  const ruleIndex = new Map<string, number>();
  for (const finding of findings) {
    const id = ruleIdFor(finding);
    if (ruleIndex.has(id)) continue;
    ruleIndex.set(id, rules.length);
    rules.push({
      id,
      name: slug(id),
      shortDescription: { text: finding.title.slice(0, 200) },
      fullDescription: { text: finding.description.slice(0, 2000) },
      defaultConfiguration: { level: LEVEL[finding.severity] },
      help: {
        text: `Why it matters: ${finding.whyItMatters}\n\nRecommendation: ${finding.recommendation}`,
        markdown: `**Why it matters**\n\n${finding.whyItMatters}\n\n**Recommendation**\n\n${finding.recommendation}`,
      },
      properties: { category: finding.category, kind: finding.kind },
    });
  }

  const failedStages = report.stages.filter((s) => s.status === 'failed');
  const notifications = failedStages.map((s) => ({
    level: 'warning' as const,
    message: { text: `Stage "${s.label}" failed: ${s.error ?? 'unknown error'}. Results may be incomplete.` },
  }));
  if (report.summary.completeness !== 'complete') {
    notifications.push({
      level: 'warning',
      message: { text: `Analysis completeness: ${report.summary.completeness}. ${report.summary.completenessNote ?? ''}`.trim() },
    });
  }

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: 'DiffWise',
            informationUri: 'https://github.com/hungpt99-dev/DiffWise',
            version: options.toolVersion ?? report.execution?.toolVersion ?? '0.1.0',
            semanticVersion: options.toolVersion ?? report.execution?.toolVersion ?? '0.1.0',
            rules,
          },
        },
        automationDetails: { id: `diffwise/${report.id}` },
        invocations: [
          {
            executionSuccessful: report.summary.completeness !== 'failed',
            startTimeUtc: report.createdAt,
            endTimeUtc: new Date(Date.parse(report.createdAt) + report.durationMs).toISOString(),
            workingDirectory: { uri: 'file:///' },
            toolExecutionNotifications: notifications,
          },
        ],
        originalUriBaseIds: { '%SRCROOT%': { uri: pathToUri(report.repository.root) } },
        results: findings.map((f) => resultOf(f, ruleIndex.get(ruleIdFor(f)) ?? 0)),
        properties: {
          reviewId: report.id,
          riskScore: report.risk.score,
          riskLevel: report.risk.level,
          completeness: report.summary.completeness,
          target: report.target.label,
          command: options.command ?? report.execution?.command ?? null,
        },
      },
    ],
  };
}

function pathToUri(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized).replace(/#/g, '%23')}${normalized.endsWith('/') ? '' : '/'}`;
}

/**
 * Minimal structural check for a SARIF log.
 *
 * Used by the CLI (`diffwise report --format sarif --validate`) and by tests so
 * a malformed export fails loudly instead of silently breaking a CI pipeline.
 */
export function validateSarif(value: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const log = value as Partial<SarifLog> | null;
  if (!log || typeof log !== 'object') return { ok: false, issues: ['SARIF log must be an object.'] };
  if (log.version !== SARIF_VERSION) issues.push(`version must be ${SARIF_VERSION}.`);
  if (!Array.isArray(log.runs) || log.runs.length === 0) issues.push('runs must be a non-empty array.');
  for (const [i, run] of (log.runs ?? []).entries()) {
    if (!run?.tool?.driver?.name) issues.push(`runs[${i}].tool.driver.name is required.`);
    if (!Array.isArray(run?.results)) issues.push(`runs[${i}].results must be an array.`);
    for (const [j, result] of (run?.results ?? []).entries()) {
      if (!result.ruleId) issues.push(`runs[${i}].results[${j}].ruleId is required.`);
      if (!result.message?.text) issues.push(`runs[${i}].results[${j}].message.text is required.`);
      const location = result.locations?.[0]?.physicalLocation;
      if (!location?.artifactLocation?.uri) issues.push(`runs[${i}].results[${j}] needs an artifact URI.`);
      if (!location?.region?.startLine) issues.push(`runs[${i}].results[${j}] needs a start line.`);
    }
  }
  return { ok: issues.length === 0, issues };
}
