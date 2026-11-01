/**
 * `diffwise report` and report delivery: text, JSON, SARIF, standalone HTML,
 * and the optional local interactive server.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  buildSarif, buildReviewEnvelope, type ReviewReport,
} from '@diffwise/core';
import { describeListenError, startReportServer, TOOL_VERSION, writeStandaloneHtml } from '@diffwise/app';
import { flagBool, flagNumber, flagString, UsageError } from '../args';
import type { CommandContext } from '../context';
import { EXIT } from '../exit';
import { renderFindingList, renderReviewSummary, sortFindings } from '../output';

export function openInBrowser(target: string, out: CommandContext['out']): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  execFile(command, args, (err) => {
    if (err) {
      out.info(out.yellow(`Could not open a browser automatically: ${err.message.split('\n')[0]}`));
      out.info(`${out.gray('path')} ${target}`);
    }
  });
}

export async function reportCommand(ctx: CommandContext): Promise<number> {
  const ref = ctx.argv.positionals[0] ?? 'latest';
  const format = flagString(ctx.argv.flags, 'format') ?? (ctx.json ? 'json' : 'text');
  if (!['text', 'json', 'sarif', 'html'].includes(format)) {
    throw new UsageError(`Unknown format "${format}".`, 'Supported: text, json, sarif, html.');
  }

  if (flagBool(ctx.argv.flags, 'serve')) {
    if (format !== 'text') throw new UsageError('--serve cannot be combined with --format; it serves the interactive report.');
    return serveReport(ctx, ref);
  }

  const report = await ctx.service.loadReview(ref);
  const outPath = flagString(ctx.argv.flags, 'out');

  if (format === 'json') {
    const payload = JSON.stringify(flagBool(ctx.argv.flags, 'full') ? report : buildReviewEnvelope(report), null, 2);
    if (outPath) {
      await writeArtifact(outPath, payload);
      ctx.out.info(`${ctx.out.green('wrote')} ${outPath}`);
      ctx.out.stdout(resolve(outPath));
      return EXIT.OK;
    }
    ctx.out.stdout(payload);
    return EXIT.OK;
  }

  if (format === 'sarif') {
    const min = flagString(ctx.argv.flags, 'severity');
    const payload = JSON.stringify(buildSarif(report, {
      toolVersion: TOOL_VERSION,
      ...(min ? { minSeverity: min as ReviewReport['findings'][number]['severity'] } : {}),
    }), null, 2);
    if (outPath) {
      await writeArtifact(outPath, payload);
      ctx.out.info(`${ctx.out.green('wrote')} ${outPath}`);
      ctx.out.stdout(resolve(outPath));
      return EXIT.OK;
    }
    ctx.out.stdout(payload);
    return EXIT.OK;
  }

  if (format === 'html') {
    const htmlPath = outPath ?? join(ctx.root, '.diffwise', 'artefacts', `${report.id}.html`);
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeStandaloneHtml({
      report,
      path: htmlPath,
      ...(flagString(ctx.argv.flags, 'title') ? { title: flagString(ctx.argv.flags, 'title') as string } : {}),
    });
    ctx.out.info(`${ctx.out.green('wrote')} ${htmlPath}`);
    ctx.out.stdout(resolve(htmlPath));
    if (flagBool(ctx.argv.flags, 'open')) openInBrowser(resolve(htmlPath), ctx.out);
    return EXIT.OK;
  }

  // Text.
  const lines = [renderReviewSummary(report, ctx.out)];
  const docFindings = report.documentation.findings;
  if (docFindings.length > 0) {
    lines.push('', ctx.out.bold('Documentation impact'));
    for (const d of docFindings.slice(0, 8)) {
      lines.push(`  ${ctx.out.yellow(d.status.padEnd(9))} ${d.document} — ${d.title}`);
    }
  }
  if (report.changes.length > 0) {
    lines.push('', ctx.out.bold('Changed files'));
    for (const change of report.changes.slice(0, 15)) {
      const counts = `${ctx.out.green(`+${change.additions}`)} ${ctx.out.red(`-${change.deletions}`)}`;
      const linked = report.findings.filter((f) => f.file === change.path).length;
      lines.push(`  ${change.status.padEnd(8)} ${change.path}  ${counts}${linked ? `  ${ctx.out.cyan(`${linked} finding${linked === 1 ? '' : 's'}`)}` : ''}`);
    }
    if (report.changes.length > 15) lines.push(ctx.out.gray(`  … ${report.changes.length - 15} more`));
  }
  const all = sortFindings(report.findings);
  if (all.length > 0) {
    lines.push('', ctx.out.bold('Findings'));
    lines.push(renderFindingList(all, ctx.out));
  }
  if (report.summary.completenessNote) {
    lines.push('', ctx.out.gray(report.summary.completenessNote));
  }
  lines.push('', ctx.out.gray(`full report: ${join('.diffwise', 'reviews', `${report.id}.json`)}`));
  ctx.out.stdout(lines.join('\n'));
  if (flagBool(ctx.argv.flags, 'open')) {
    const htmlPath = join(ctx.root, '.diffwise', 'artefacts', `${report.id}.html`);
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeStandaloneHtml({ report, path: htmlPath });
    openInBrowser(resolve(htmlPath), ctx.out);
  }
  return EXIT.OK;
}

async function writeArtifact(path: string, payload: string): Promise<void> {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${payload}\n`, 'utf8');
}

/**
 * Start the local report server and keep it alive until cancelled.
 *
 * The URL (including the one-time token) is printed to stdout so it can be
 * piped into a browser launcher; diagnostics go to stderr.
 */
export async function serveReport(ctx: CommandContext, ref = 'latest'): Promise<number> {
  const report = await ctx.service.loadReview(ref);
  const port = flagNumber(ctx.argv.flags, 'port') ?? 4700;
  const host = flagString(ctx.argv.flags, 'host') ?? '127.0.0.1';

  let server;
  try {
    server = await startReportServer({
      service: ctx.service,
      host,
      port,
      allowPublic: flagBool(ctx.argv.flags, 'allow-public'),
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    ctx.out.error(describeListenError(err as NodeJS.ErrnoException));
    void code;
    return EXIT.WORKSPACE;
  }

  if (ctx.json) {
    ctx.out.stdout(JSON.stringify({ ok: true, url: server.url, port: server.port, host: server.host, reviewId: report.id }, null, 2));
  } else {
    ctx.out.stdout(server.url);
    ctx.out.info('');
    ctx.out.info(`${ctx.out.bold('DiffWise report server')} ${ctx.out.gray(`· ${report.id}`)}`);
    ctx.out.info(`${ctx.out.gray('url')}   ${server.url}`);
    ctx.out.info(`${ctx.out.gray('bound')} ${server.host}:${server.port} ${host === '127.0.0.1' ? ctx.out.gray('(loopback only)') : ctx.out.yellow('(non-loopback — data is reachable from the network)')}`);
    ctx.out.info(`${ctx.out.gray('stop')}  Ctrl+C`);
  }

  if (flagBool(ctx.argv.flags, 'open')) openInBrowser(server.url, ctx.out);

  await new Promise<void>((resolvePromise) => {
    const shutdown = (): void => { resolvePromise(); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  await server.close();
  ctx.out.info(ctx.out.gray('report server stopped'));
  return EXIT.OK;
}

/** Shared by review --serve: keep the exact report the run produced. */
export async function serveReviewReport(ctx: CommandContext, report: ReviewReport): Promise<number> {
  void report;
  return serveReport(ctx, report.id);
}

export { sortFindings };
