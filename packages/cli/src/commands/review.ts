/**
 * `diffwise review` — the primary command.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildSarif, buildReviewEnvelope, EmptyReviewError, ReviewCancelledError, type AnalysisStage } from '@diffwise/core';
import { ServiceError, TOOL_VERSION, writeStandaloneHtml } from '@diffwise/app';
import { flagBool, flagNumber, flagString, UsageError } from '../args';
import type { CommandContext } from '../context';
import { EXIT } from '../exit';
import { renderReviewSummary, renderStages, visibleLength } from '../output';
import { resolveTarget, describeTarget } from '../target';
import { openInBrowser, serveReport } from './report';
import { interactiveAfterReview } from './interactive';

export async function reviewCommand(ctx: CommandContext): Promise<number> {
  const target = resolveTarget({ positionals: ctx.argv.positionals, flags: ctx.argv.flags, root: ctx.root });
  const format = flagString(ctx.argv.flags, 'format') ?? (ctx.json ? 'json' : 'text');
  if (!['text', 'json', 'html', 'sarif'].includes(format)) {
    throw new UsageError(`Unknown format "${format}".`, 'Supported: text, json, html, sarif.');
  }

  // A cost limit is checked against the report's list-price estimate. It needs a
  // configured price: without one the number would be invented, so the run is
  // refused rather than silently unprotected.
  const maxCost = flagNumber(ctx.argv.flags, 'max-cost');
  if (maxCost !== undefined && maxCost < 0) throw new UsageError('--max-cost expects a non-negative amount in USD.');
  if (maxCost !== undefined && Object.keys(ctx.service.config.pricing ?? {}).length === 0) {
    throw new UsageError(
      '--max-cost needs configured prices.',
      'Add a "pricing" table to .diffwise/config.json (see docs/TOKEN_OPTIMIZATION.md); token counts alone cannot be converted to money.',
    );
  }

  // --ai-required turns the AI stage into a contract: a review that could not run
  // AI is partial, and this command refuses to exit 0 for it.
  const aiRequired = flagBool(ctx.argv.flags, 'ai-required');

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);

  const progress = new Progress(ctx, !ctx.json && format === 'text');
  progress.start(describeTarget(target));

  let result;
  try {
    result = await ctx.service.review({
      target,
      signal: controller.signal,
      onProgress: (stages) => progress.update(stages),
      ...(flagBool(ctx.argv.flags, 'no-ai') ? { disableAi: true } : {}),
      ...(flagBool(ctx.argv.flags, 'ai') ? { enableAi: true } : {}),
      ...(aiRequired ? { aiRequired: true } : {}),
      ...(flagString(ctx.argv.flags, 'report') ? { reportId: flagString(ctx.argv.flags, 'report') as string } : {}),
    });
  } catch (err) {
    progress.stop();
    process.removeListener('SIGINT', onSigint);
    if (err instanceof EmptyReviewError) {
      ctx.out.info(ctx.out.yellow(`Nothing to review: ${describeTarget(target)} is empty.`));
      if (ctx.json) {
        ctx.out.stdout(JSON.stringify({ schemaVersion: '1.0', status: 'empty', target }, null, 2));
      }
      return EXIT.OK;
    }
    if (err instanceof ReviewCancelledError) {
      ctx.out.error('Review cancelled.');
      if (ctx.json) ctx.out.stdout(JSON.stringify({ schemaVersion: '1.0', status: 'cancelled', stages: err.stages }, null, 2));
      return EXIT.CANCELLED;
    }
    throw err;
  }
  process.removeListener('SIGINT', onSigint);
  progress.stop();

  const { report, path } = result;
  const failOn = flagString(ctx.argv.flags, 'fail-on') ?? ctx.service.config.qualityGate.failOn;
  const gate = failOn === 'none'
    ? { failed: false, threshold: 'none', offending: [] }
    : ctx.service.qualityGate({ ...report });
  // An explicit --fail-on overrides the configured threshold for this run.
  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  const threshold = failOn === 'none' ? null : rank[failOn as keyof typeof rank];
  const offending = threshold === null ? [] : report.findings.filter((f) => rank[f.severity] <= threshold);
  const failed = threshold !== null && offending.length > 0;
  void gate;

  const outPath = flagString(ctx.argv.flags, 'out');
  let written: string | undefined;

  if (format === 'json') {
    const payload = JSON.stringify(buildReviewEnvelope(report), null, 2);
    if (outPath) {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, `${payload}\n`, 'utf8');
      written = outPath;
      ctx.out.info(`${ctx.out.green('wrote')} ${outPath}`);
      ctx.out.stdout(outPath);
    } else {
      ctx.out.stdout(payload);
    }
  } else if (format === 'sarif') {
    const payload = JSON.stringify(buildSarif(report, { toolVersion: TOOL_VERSION, command: 'diffwise review' }), null, 2);
    if (outPath) {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, `${payload}\n`, 'utf8');
      written = outPath;
      ctx.out.info(`${ctx.out.green('wrote')} ${outPath}`);
      ctx.out.stdout(outPath);
    } else {
      ctx.out.stdout(payload);
    }
  } else if (format === 'html') {
    const htmlPath = outPath ?? join(ctx.root, '.diffwise', 'artefacts', `${report.id}.html`);
    await mkdir(dirname(htmlPath), { recursive: true });
    try {
      await writeStandaloneHtml({ report, path: htmlPath });
    } catch (err) {
      ctx.out.error(`Could not build the HTML report: ${(err as Error).message}`);
      return EXIT.INTERNAL;
    }
    written = htmlPath;
    ctx.out.info(`${ctx.out.green('wrote')} ${htmlPath}`);
    ctx.out.stdout(htmlPath);
    if (flagBool(ctx.argv.flags, 'open')) openInBrowser(htmlPath, ctx.out);
  } else {
    ctx.out.stdout(renderReviewSummary(report, ctx.out));
    if (path) ctx.out.info(ctx.out.gray(`report saved  ${path}`));
    if (report.stages.some((s) => s.status !== 'completed' && s.status !== 'skipped')) {
      ctx.out.info(renderStages(report.stages.filter((s) => s.status === 'failed' || s.status === 'cancelled'), ctx.out));
    }
  }

  if (maxCost !== undefined) {
    const spent = report.ai?.estimatedCostUsd;
    if (spent === undefined) {
      ctx.out.warn('Cost limit not evaluated: this run reported no priced usage (no model calls, or no provider).');
    } else if (spent > maxCost) {
      const message = `Cost limit exceeded: $${spent.toFixed(4)} > $${maxCost.toFixed(4)} (list-price estimate, ${report.ai?.usageSource ?? 'provider'} token counts).`;
      if (ctx.json) {
        ctx.out.stdout(JSON.stringify({
          schemaVersion: '1.0', status: 'cost-limit', costUsd: spent, maxCost, reportId: report.id,
          usage: report.ai ?? null, message,
        }, null, 2));
      } else {
        ctx.out.error(message);
        ctx.out.info(ctx.out.gray('The report is still saved; raise --max-cost or lower the reviewer/verification budget.'));
      }
      return EXIT.COST_LIMIT;
    } else {
      ctx.out.info(ctx.out.gray(`cost        $${spent.toFixed(4)} of $${maxCost.toFixed(4)} allowed`));
    }
  }

  if (flagBool(ctx.argv.flags, 'serve')) {
    return serveReport(ctx, report.id);
  }
  if (flagBool(ctx.argv.flags, 'open') && format !== 'html') {
    const htmlPath = join(ctx.root, '.diffwise', 'artefacts', `${report.id}.html`);
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeStandaloneHtml({ report, path: htmlPath });
    openInBrowser(htmlPath, ctx.out);
  }
  if (flagBool(ctx.argv.flags, 'interactive') && !ctx.noInput) {
    await interactiveAfterReview(ctx, report);
  }

  if (failed) {
    ctx.out.info(ctx.out.red(`Quality gate failed: ${offending.length} finding(s) at or above "${failOn}".`));
    return EXIT.GATE_FAILED;
  }
  const aiStatus = report.review?.ai;
  if (aiRequired && aiStatus && aiStatus.status !== 'complete') {
    ctx.out.info(ctx.out.red(`AI was required but the AI review is ${aiStatus.status}${aiStatus.reason ? `: ${aiStatus.reason}` : ''}.`));
    return EXIT.AI_REQUIRED;
  }
  if (report.summary.completeness === 'failed') return EXIT.INTERNAL;
  return EXIT.OK;
}

/**
 * Stage progress. On a TTY it rewrites one line; everywhere else it stays
 * silent unless --verbose is set, so piped output and CI logs stay clean.
 */
class Progress {
  private lastLine = '';
  private started = Date.now();
  constructor(private readonly ctx: CommandContext, private readonly enabled: boolean) {}

  start(label: string): void {
    if (!this.enabled) return;
    if (this.ctx.out.options.verbose || process.stderr.isTTY) {
      process.stderr.write(`${this.ctx.out.gray('reviewing')} ${label}\n`);
    }
  }

  update(stages: AnalysisStage[]): void {
    if (!this.enabled) return;
    const running = stages.find((s) => s.status === 'running');
    if (!running) return;
    if (this.ctx.out.options.verbose) {
      process.stderr.write(`${this.ctx.out.gray('·')} ${running.label}\n`);
      return;
    }
    if (!process.stderr.isTTY) return;
    const line = `  ${this.ctx.out.cyan('›')} ${running.label}…`;
    process.stderr.write(`\r${line}${' '.repeat(Math.max(0, this.lastLine.length - visibleLength(line)))}`);
    this.lastLine = line;
  }

  stop(): void {
    if (!this.enabled) return;
    if (this.lastLine) process.stderr.write('\r\u001b[2K');
    this.lastLine = '';
    this.ctx.out.debug(`analysis finished in ${Date.now() - this.started}ms`);
  }
}

/** Shared error mapping for commands that call the service. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof UsageError) return EXIT.USAGE;
  if (err instanceof EmptyReviewError) return EXIT.OK;
  if (err instanceof ServiceError) {
    switch (err.code) {
      case 'NO_REVIEW':
      case 'NO_FINDING':
      case 'NO_FIX':
      case 'NO_APPLIED_FIX': return EXIT.NOT_FOUND;
      case 'NO_PROVIDER': return EXIT.PROVIDER;
      case 'NO_PATCH': return EXIT.FIX_REJECTED;
      case 'NO_VERIFICATION_COMMAND': return EXIT.VERIFICATION_FAILED;
      default: return EXIT.INTERNAL;
    }
  }
  const message = (err as Error).message ?? '';
  if (/not inside a git repository/i.test(message)) return EXIT.WORKSPACE;
  if (/EACCES|EPERM|ENOENT/.test(message)) return EXIT.WORKSPACE;
  return EXIT.INTERNAL;
}
