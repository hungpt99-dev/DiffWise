/**
 * Terminal output.
 *
 * Rules the whole CLI follows:
 *   - results go to stdout, everything else (progress, hints, diagnostics) to
 *     stderr, so `diffwise ... --json | jq` is always safe;
 *   - colour is only emitted when stdout is a TTY and NO_COLOR/--no-color is
 *     not set;
 *   - no box-drawing characters beyond simple rules, so output stays readable
 *     in CI logs and in narrow terminals.
 */
import type { Finding, ReviewReport, Severity } from '@diffwise/core';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  white: '\u001b[97m',
  bgRed: '\u001b[41m',
  bgYellow: '\u001b[43m',
};

export interface OutputOptions {
  color: boolean;
  quiet: boolean;
  verbose: boolean;
}

export class Output {
  constructor(readonly options: OutputOptions) {}

  get color(): boolean { return this.options.color; }

  private paint(code: string, text: string): string {
    return this.options.color ? `${code}${text}${ANSI.reset}` : text;
  }

  bold(text: string): string { return this.paint(ANSI.bold, text); }
  dim(text: string): string { return this.paint(ANSI.dim, text); }
  red(text: string): string { return this.paint(ANSI.red, text); }
  green(text: string): string { return this.paint(ANSI.green, text); }
  yellow(text: string): string { return this.paint(ANSI.yellow, text); }
  blue(text: string): string { return this.paint(ANSI.blue, text); }
  cyan(text: string): string { return this.paint(ANSI.cyan, text); }
  magenta(text: string): string { return this.paint(ANSI.magenta, text); }
  gray(text: string): string { return this.paint(ANSI.gray, text); }

  /** Machine output: exactly one write, never decorated. */
  stdout(text: string): void {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** Progress and diagnostics. Never part of a piped result. */
  info(text: string): void {
    if (this.options.quiet) return;
    process.stderr.write(`${text}\n`);
  }

  debug(text: string): void {
    if (!this.options.verbose) return;
    process.stderr.write(`${this.gray(text)}\n`);
  }

  warn(text: string): void {
    process.stderr.write(`${this.yellow('warning')} ${text}\n`);
  }

  error(text: string, hint?: string): void {
    process.stderr.write(`${this.red('error')} ${text}\n`);
    if (hint) process.stderr.write(`${this.gray('hint')} ${hint}\n`);
  }

  rule(width = 72): string {
    return this.gray('─'.repeat(width));
  }

  severityTag(severity: Severity): string {
    const labels: Record<Severity, string> = {
      critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'INFO',
    };
    const text = labels[severity].padEnd(8);
    switch (severity) {
      case 'critical': return this.paint(ANSI.bgRed, this.bold(this.paint(ANSI.white, text)));
      case 'high': return this.red(this.bold(text));
      case 'medium': return this.yellow(text);
      case 'low': return this.blue(text);
      default: return this.gray(text);
    }
  }

  riskLabel(level: string, score: number): string {
    const text = `${score}/100 ${level.toUpperCase()}`;
    switch (level) {
      case 'severe': return this.red(this.bold(text));
      case 'high': return this.red(text);
      case 'moderate': return this.yellow(text);
      default: return this.green(text);
    }
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
}

export function shouldUseColor(options: { noColorFlag?: boolean; env?: NodeJS.ProcessEnv; stream?: NodeJS.WriteStream }): boolean {
  const env = options.env ?? process.env;
  if (options.noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean((options.stream ?? process.stdout).isTTY);
}

export function width(max = 100): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(60, Math.min(max, cols));
}

/**
 * Wrap a paragraph under a label, hanging the continuation under `indent`.
 *
 * Terminals hard-wrap at the last column, which turns a long sentence into a
 * ragged block with no indication that it continues. Wrapping here keeps the
 * label column intact and the sentence readable on a narrow terminal.
 */
export function wrapLabeled(head: string, indent: number, text: string, maxWidth = width()): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let limit = Math.max(20, maxWidth - visibleLength(head));
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
      limit = Math.max(20, maxWidth - indent);
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) lines.push('');

  return lines.map((line, i) => (i === 0 ? `${head}${line}` : `${' '.repeat(indent)}${line}`));
}

/** Visible length, ignoring ANSI sequences. */
export function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

export function pad(text: string, length: number): string {
  const visible = visibleLength(text);
  return visible >= length ? text : text + ' '.repeat(length - visible);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return iso;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

const CATEGORY_ORDER = [
  'correctness', 'security', 'reliability', 'concurrency', 'database', 'api-contract',
  'error-handling', 'resources', 'performance', 'architecture', 'tests', 'documentation',
  'configuration', 'maintainability',
];

export function sortFindings(findings: Finding[], mode: 'severity' | 'file' | 'category' = 'severity'): Finding[] {
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const copy = [...findings];
  if (mode === 'file') return copy.sort((a, b) => a.file.localeCompare(b.file) || a.range.start - b.range.start);
  if (mode === 'category') {
    return copy.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
      || order[a.severity] - order[b.severity]);
  }
  return copy.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.range.start - b.range.start);
}

/** Columns with a header, no borders: survives narrow terminals and CI logs. */
export function table(rows: string[][], headers: string[], out: Output, maxWidth = width()): string {
  if (rows.length === 0) return '';
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))));
  const total = widths.reduce((n, w) => n + w, 0) + (headers.length - 1) * 2;
  if (total > maxWidth) {
    // Shrink the widest column instead of wrapping the table.
    const overflow = total - maxWidth;
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] = Math.max(10, (widths[widest] ?? 10) - overflow);
  }
  const line = (cells: string[]): string => cells
    .map((cell, i) => pad(truncate(cell, widths[i] ?? 10), widths[i] ?? 10))
    .join('  ')
    .trimEnd();
  const header = out.dim(line(headers));
  return [header, ...rows.map((r) => line(r))].join('\n');
}

export function renderReviewSummary(report: ReviewReport, out: Output): string {
  const s = report.summary.findingsBySeverity;
  const added = report.changes.reduce((n, c) => n + c.additions, 0);
  const deleted = report.changes.reduce((n, c) => n + c.deletions, 0);
  const lines: string[] = [];
  lines.push(out.rule());
  lines.push(`${out.bold('DiffWise review')} ${out.gray(report.id)}`);
  lines.push(`${report.repository.name} ${out.gray('·')} ${report.repository.branch} ${out.gray('·')} ${report.target.label}`);
  lines.push(out.rule());
  const riskHead = `risk        ${out.riskLabel(report.risk.level, report.risk.score)}   `;
  // The summary repeats the level and score ("SEVERE (100/100).") that the
  // label already shows; drop that prefix rather than print it twice.
  const riskText = report.risk.summary.replace(/^[A-Z]+ \([\d/]+\)\.\s*/, '');
  wrapLabeled(riskHead, 12, riskText).forEach((line, i) => {
    lines.push(i === 0 ? `${riskHead}${out.gray(line.slice(riskHead.length))}` : out.gray(line));
  });
  lines.push(`changes     ${plural(report.changes.length, 'file')}  ${out.green(`+${added}`)} ${out.red(`-${deleted}`)}  ${plural(report.symbols.length, 'symbol')}`);
  lines.push(`findings    ${out.severityTag('critical')} ${s.critical}   ${out.severityTag('high')} ${s.high}   ${out.severityTag('medium')} ${s.medium}   ${out.severityTag('low')} ${s.low}   ${out.severityTag('info')} ${s.info}`);
  lines.push(`impact      ${plural(report.summary.affectedComponents, 'affected component')}  ${plural(report.documentation.findings.length, 'documentation issue')}`);
  const tests = report.tests;
  const executed = tests.execution
    ? `${tests.execution.status}${tests.execution.exitCode !== null ? ` (exit ${tests.execution.exitCode})` : ''}`
    : 'not run';
  lines.push(`tests       ${plural(tests.files.length, 'test file')}  ·  execution: ${executed}  ·  ${plural(tests.uncoveredChanges.length, 'uncovered change')}`);
  const ai = report.summary.aiUsed
    ? `${report.provider.providerId}/${report.provider.model ?? '?'}`
    : 'not used';
  const verification = report.review?.verification;
  if (verification?.performed) {
    const total = verification.confirmed + verification.likely + verification.unverified
      + verification.disputed + verification.rejected;
    lines.push(`verified    ${verification.confirmed} confirmed  ·  ${verification.likely} likely  ·  `
      + `${verification.disputed} disputed  ·  ${verification.rejected} rejected  ${out.gray(`of ${total}`)}`);
  }
  const reviewers = report.review?.reviewerRuns.filter((r) => r.status === 'completed').length ?? 0;
  const selected = report.review?.plan.reviewers.length ?? 0;
  lines.push(`analysis    ${report.summary.completeness}  ·  AI: ${ai}${selected ? `  ·  reviewers: ${reviewers}/${selected}` : ''}  ·  ${formatDuration(report.durationMs)}`);
  if (report.ai && report.ai.requests > 0) {
    lines.push(`ai usage    ${plural(report.ai.requests, 'request')}  ·  ${report.ai.promptTokens.toLocaleString('en-US')} in / ${report.ai.completionTokens.toLocaleString('en-US')} out tokens  ·  ${report.ai.usageSource ?? 'provider'} counts`);
    const cacheLine = [`${report.ai.cacheHits ?? 0} cache hit(s)`];
    if (report.ai.tokensSavedByCache) cacheLine.push(`${report.ai.tokensSavedByCache.toLocaleString('en-US')} tokens avoided`);
    if (report.ai.estimatedCostUsd !== undefined) cacheLine.push(`est. $${report.ai.estimatedCostUsd.toFixed(4)} charged this run at the configured list price`);
    else cacheLine.push('cost unknown (no price configured)');
    lines.push(`ai cost     ${cacheLine.join('  ·  ')}`);
  }
  if (report.summary.completenessNote) {
    lines.push(...wrapLabeled('note        ', 12, report.summary.completenessNote).map((line) => out.yellow(line)));
  }
  const top = sortFindings(report.findings).slice(0, 5);
  if (top.length > 0) {
    lines.push(out.rule());
    lines.push(out.bold('Top findings'));
    for (const f of top) {
      lines.push(`  ${out.severityTag(f.severity)} ${out.cyan(f.id)}  ${truncate(f.title, Math.max(30, width() - 30))}`);
      lines.push(`  ${' '.repeat(9)} ${out.gray(`${f.file}:${f.range.start}`)}`);
    }
    if (report.findings.length > top.length) {
      lines.push(out.gray(`  … ${report.findings.length - top.length} more · run "diffwise findings"`));
    }
  } else {
    lines.push(out.green('No findings. The change looks clean to the configured rules.'));
  }
  lines.push(out.rule());
  return lines.join('\n');
}

export function renderFinding(finding: Finding, out: Output, options: { evidence?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`${out.severityTag(finding.severity)} ${out.cyan(finding.id)}  ${out.bold(finding.title)}`);
  lines.push(out.gray(`${finding.file}:${finding.range.start}${finding.range.end !== finding.range.start ? `-${finding.range.end}` : ''}  ·  ${finding.category}  ·  ${finding.kind}  ·  confidence ${finding.confidence}  ·  ${finding.source}`));
  lines.push('');
  lines.push(...wrapLabeled('', 0, finding.description));
  lines.push('');
  lines.push(...wrapLabeled(`${out.bold('Why it matters')}  `, 16, finding.whyItMatters));
  if (finding.consequences.length > 0) {
    lines.push(...wrapLabeled(`${out.bold('Consequences')}   `, 15, finding.consequences.join(' ')));
  }
  lines.push(...wrapLabeled(`${out.bold('Recommendation')} `, 15, finding.recommendation));
  if (options.evidence !== false && finding.evidence.length > 0) {
    lines.push('');
    lines.push(out.bold('Evidence'));
    for (const e of finding.evidence) {
      const where = e.file ? `${e.file}${e.line ? `:${e.line}${e.endLine && e.endLine !== e.line ? `-${e.endLine}` : ''}` : ''}` : '(repository)';
      lines.push(`  ${out.gray('·')} ${out.gray(where)} ${e.note}`);
      if (e.snippet) {
        for (const line of e.snippet.split('\n').slice(0, 12)) {
          lines.push(`      ${out.gray('│')} ${line}`);
        }
      }
    }
  }
  if (finding.tags.length > 0) {
    lines.push('');
    lines.push(out.gray(`tags: ${finding.tags.join(', ')}   rule: ${finding.ruleId}`));
  }
  return lines.join('\n');
}

export function renderFindingList(findings: Finding[], out: Output, sort: 'severity' | 'file' | 'category' = 'severity'): string {
  const sorted = sortFindings(findings, sort);
  const rows = sorted.map((f) => [
    f.severity.toUpperCase(),
    f.id,
    truncate(f.title, Math.max(24, width() - 46)),
    `${f.file}:${f.range.start}`,
  ]);
  return table(rows, ['SEVERITY', 'ID', 'TITLE', 'LOCATION'], out);
}

export function renderStages(stages: ReviewReport['stages'], out: Output): string {
  const icon: Record<string, string> = {
    completed: out.green('✔'), running: out.cyan('›'), pending: out.gray('·'),
    failed: out.red('✖'), skipped: out.gray('–'), cancelled: out.yellow('✖'),
  };
  return stages
    .map((s) => `  ${icon[s.status] ?? '·'} ${pad(s.label, 38)} ${out.gray(s.status)}${s.detail ? `  ${out.gray(truncate(s.detail, 60))}` : ''}`)
    .join('\n');
}
