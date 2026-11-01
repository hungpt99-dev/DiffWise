/**
 * Read-only inspection commands: findings, show, history, compare.
 */
import {
  JSON_SCHEMA_VERSION, type Finding, type Severity,
} from '@diffwise/core';
import { flagBool, flagNumber, flagString, UsageError } from '../args';
import type { CommandContext } from '../context';
import { EXIT } from '../exit';
import { renderFinding, renderFindingList, sortFindings, table, timeAgo, truncate, width } from '../output';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export async function findingsCommand(ctx: CommandContext): Promise<number> {
  const report = await ctx.service.loadReview(flagString(ctx.argv.flags, 'report') ?? 'latest');
  const severity = flagString(ctx.argv.flags, 'severity');
  if (severity && !SEVERITIES.includes(severity as Severity)) {
    throw new UsageError(`Unknown severity "${severity}".`, `Use one of: ${SEVERITIES.join(', ')}.`);
  }
  const category = flagString(ctx.argv.flags, 'category');
  const kind = flagString(ctx.argv.flags, 'kind');
  const search = flagString(ctx.argv.flags, 'search')?.toLowerCase();
  const sort = (flagString(ctx.argv.flags, 'sort') ?? 'severity') as 'severity' | 'file' | 'category';
  const limit = flagNumber(ctx.argv.flags, 'limit') ?? 50;

  let findings = report.findings;
  if (severity) findings = findings.filter((f) => RANK[f.severity] <= RANK[severity as Severity]);
  if (category) findings = findings.filter((f) => f.category === category);
  if (kind) findings = findings.filter((f) => f.kind === kind);
  if (search) {
    findings = findings.filter((f) => `${f.id} ${f.title} ${f.description} ${f.file} ${f.category} ${f.tags.join(' ')}`
      .toLowerCase().includes(search));
  }
  findings = sortFindings(findings, sort).slice(0, limit);

  if (ctx.json) {
    ctx.out.stdout(JSON.stringify({
      schemaVersion: JSON_SCHEMA_VERSION,
      reviewId: report.id,
      count: findings.length,
      total: report.findings.length,
      filters: { severity, category, kind, search, sort, limit },
      findings,
    }, null, 2));
    return EXIT.OK;
  }

  if (findings.length === 0) {
    ctx.out.stdout(ctx.out.green(`No findings${report.findings.length ? ` match those filters (${report.findings.length} total).` : '.'}`));
    return EXIT.OK;
  }
  ctx.out.stdout([
    `${ctx.out.bold(plural(report.findings.length, 'finding'))} in review ${ctx.out.gray(report.id)}${findings.length !== report.findings.length ? ctx.out.gray(` · showing ${findings.length}`) : ''}`,
    '',
    renderFindingList(findings, ctx.out, sort),
  ].join('\n'));
  return EXIT.OK;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export async function showCommand(ctx: CommandContext): Promise<number> {
  const ref = ctx.argv.positionals[0];
  if (!ref) throw new UsageError('show needs a finding id, e.g. "diffwise show DW-001".');
  const { report, finding } = await ctx.service.findByFinding(ref);

  if (ctx.json) {
    ctx.out.stdout(JSON.stringify({
      schemaVersion: JSON_SCHEMA_VERSION,
      reviewId: report.id,
      finding,
      fixes: report.fixes.filter((f) => f.findingId === finding.id).map((f) => ({
        id: f.id, label: f.label, complexity: f.complexity, applies: f.patch?.validation.applies ?? false,
        files: f.filesAffected, source: f.source,
      })),
      related: report.findings
        .filter((f) => f.id !== finding.id && (f.file === finding.file || f.category === finding.category))
        .slice(0, 5)
        .map((f) => ({ id: f.id, title: f.title, severity: f.severity, file: f.file, line: f.range.start })),
    }, null, 2));
    return EXIT.OK;
  }

  const lines = [renderFinding(finding, ctx.out, { evidence: true })];
  const fixes = report.fixes.filter((f) => f.findingId === finding.id);
  if (fixes.length > 0) {
    lines.push('', ctx.out.bold('Fix options'));
    for (const fix of fixes) {
      const applies = fix.patch ? (fix.patch.validation.applies ? ctx.out.green('applies') : ctx.out.yellow('does not apply')) : ctx.out.gray('guidance only');
      lines.push(`  ${ctx.out.cyan(fix.id)}  ${fix.label}  ${ctx.out.gray(`· ${fix.complexity} complexity · ${applies}`)}`);
    }
    lines.push(ctx.out.gray(`  preview with: diffwise fix ${finding.id} --preview`));
  } else {
    lines.push('', ctx.out.gray(`No fix options yet: run "diffwise fix ${finding.id}" to generate them.`));
  }
  const related = report.findings.filter((f) => f.id !== finding.id && (f.file === finding.file || f.category === finding.category)).slice(0, 3);
  if (related.length > 0) {
    lines.push('', ctx.out.bold('Related findings'));
    for (const r of related) lines.push(`  ${ctx.out.cyan(r.id)} ${truncate(r.title, Math.max(30, width() - 24))} ${ctx.out.gray(r.file)}`);
  }
  lines.push('', ctx.out.gray(`review ${report.id} · ${report.target.label}`));
  ctx.out.stdout(lines.join('\n'));
  return EXIT.OK;
}

export async function historyCommand(ctx: CommandContext): Promise<number> {
  const limit = flagNumber(ctx.argv.flags, 'limit') ?? 20;
  const entries = await ctx.service.listReviews(limit);

  if (ctx.json) {
    ctx.out.stdout(JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, count: entries.length, reviews: entries }, null, 2));
    return EXIT.OK;
  }
  if (entries.length === 0) {
    ctx.out.stdout('No reviews recorded yet. Run "diffwise review".');
    return EXIT.OK;
  }
  const rows = entries.map((e) => [
    e.id,
    timeAgo(e.createdAt),
    truncate(e.targetLabel, 24),
    `${e.riskLevel} ${e.riskScore}`,
    String(e.findings),
    String(e.changedFiles),
    e.aiUsed ? 'ai' : 'det',
    e.completeness,
  ]);
  ctx.out.stdout([
    ctx.out.bold(`Review history (${entries.length})`),
    '',
    table(rows, ['REVIEW', 'WHEN', 'TARGET', 'RISK', 'FINDINGS', 'FILES', 'MODE', 'STATE'], ctx.out),
    '',
    ctx.out.gray('open one with: diffwise report <review-id> --serve'),
  ].join('\n'));
  return EXIT.OK;
}

export async function compareCommand(ctx: CommandContext): Promise<number> {
  const [left, right] = ctx.argv.positionals;
  if (!left) throw new UsageError('compare needs two review references, e.g. "diffwise compare latest previous".');
  const result = await ctx.service.compare(left, right ?? 'latest');

  if (ctx.json) {
    ctx.out.stdout(JSON.stringify({
      schemaVersion: JSON_SCHEMA_VERSION,
      left: { id: result.left.id, risk: result.left.risk.score, findings: result.left.findings.length, files: result.left.changes.length },
      right: { id: result.right.id, risk: result.right.risk.score, findings: result.right.findings.length, files: result.right.changes.length },
      delta: result.summary,
      resolved: result.resolved.map(brief),
      introduced: result.introduced.map(brief),
      persisted: result.persisted.map(brief),
    }, null, 2));
    return EXIT.OK;
  }

  const arrow = (delta: number): string => delta === 0 ? ctx.out.gray('±0')
    : delta > 0 ? ctx.out.red(`+${delta}`) : ctx.out.green(String(delta));
  const lines = [
    ctx.out.bold('Review comparison'),
    '',
    '               left                   right                  delta',
    `  ${'review'.padEnd(12)} ${result.left.id.padEnd(22)} ${result.right.id.padEnd(22)}`,
    `  ${'risk'.padEnd(12)} ${String(result.left.risk.score).padEnd(22)} ${String(result.right.risk.score).padEnd(22)} ${arrow(result.summary.risk.delta)}`,
    `  ${'findings'.padEnd(12)} ${String(result.left.findings.length).padEnd(22)} ${String(result.right.findings.length).padEnd(22)} ${arrow(result.summary.findings.delta)}`,
    `  ${'files'.padEnd(12)} ${String(result.left.changes.length).padEnd(22)} ${String(result.right.changes.length).padEnd(22)} ${arrow(result.summary.files.delta)}`,
  ];
  const section = (title: string, items: Finding[], tone: (s: string) => string): void => {
    if (items.length === 0) return;
    lines.push('', tone(`${title} (${items.length})`));
    for (const f of items.slice(0, 12)) {
      lines.push(`  ${ctx.out.severityTag(f.severity)} ${ctx.out.cyan(f.id)} ${truncate(f.title, Math.max(30, width() - 30))}`);
    }
  };
  section('Resolved', result.resolved, (s) => ctx.out.green(s));
  section('Introduced', result.introduced, (s) => ctx.out.red(s));
  section('Still present', result.persisted, (s) => ctx.out.yellow(s));
  ctx.out.stdout(lines.join('\n'));
  return EXIT.OK;
}

function brief(f: Finding): { id: string; title: string; severity: string; file: string; line: number } {
  return { id: f.id, title: f.title, severity: f.severity, file: f.file, line: f.range.start };
}

export { flagBool };
