/**
 * `diffwise chat`, `diffwise fix` and `diffwise verify`.
 *
 * The fix workflow is the one place DiffWise can modify source, so it is also
 * the most explicit: analyse → suggest → compare → preview → approval → apply →
 * verify. Nothing is written without an affirmative answer or `--yes`.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { ChatTurn, FixSolution } from '@diffwise/core';
import type { ChatAnswer } from '@diffwise/ai';
import { ServiceError } from '@diffwise/app';
import { flagBool, flagString, UsageError } from '../args';
import type { CommandContext } from '../context';
import { EXIT } from '../exit';
import { renderFinding, truncate, width } from '../output';

/* ------------------------------------------------------------------ chat -- */

export async function chatCommand(ctx: CommandContext): Promise<number> {
  const question = ctx.argv.positionals.join(' ').trim();
  const findingId = flagString(ctx.argv.flags, 'finding');
  const reviewRef = flagString(ctx.argv.flags, 'report');

  if (question) {
    return askOnce(ctx, question, findingId, reviewRef);
  }
  if (ctx.noInput || !ctx.interactive) {
    throw new UsageError('chat needs a question when stdin is not a terminal.', 'Example: diffwise chat --finding DW-001 "why does this matter?"');
  }
  return chatLoop(ctx, findingId, reviewRef);
}

async function askOnce(ctx: CommandContext, question: string, findingId?: string, reviewRef?: string): Promise<number> {
  try {
    const result = await ctx.service.chat({ question, ...(findingId ? { findingId } : {}), ...(reviewRef ? { reviewRef } : {}) });
    if (ctx.json) {
      ctx.out.stdout(JSON.stringify({
        ok: true,
        reviewId: result.reportId,
        model: result.model,
        provider: result.provider,
        answer: result.answer,
      }, null, 2));
      return EXIT.OK;
    }
    ctx.out.stdout(renderAnswer(result.answer, ctx));
    return EXIT.OK;
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'NO_PROVIDER') {
      ctx.out.error(err.message, 'Set the API key environment variable named in .diffwise/config.json.');
      return EXIT.PROVIDER;
    }
    throw err;
  }
}

async function chatLoop(ctx: CommandContext, findingId?: string, reviewRef?: string): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const history: ChatTurn[] = [];
  ctx.out.info(`${ctx.out.bold('DiffWise chat')} ${ctx.out.gray('— report-aware. "exit" to leave, "/finding DW-001" to focus a finding.')}`);
  let focus = findingId;
  if (focus) ctx.out.info(ctx.out.gray(`focused on ${focus}`));
  try {
    for (;;) {
      const line = (await rl.question(ctx.out.cyan('› '))).trim();
      if (!line) continue;
      if (['exit', 'quit', ':q'].includes(line.toLowerCase())) break;
      if (line.startsWith('/finding ')) {
        focus = line.slice('/finding '.length).trim();
        ctx.out.info(ctx.out.gray(`focused on ${focus}`));
        continue;
      }
      if (line === '/clear') {
        history.length = 0;
        ctx.out.info(ctx.out.gray('conversation cleared'));
        continue;
      }
      const started = Date.now();
      try {
        const result = await ctx.service.chat({
          question: line,
          ...(focus ? { findingId: focus } : {}),
          ...(reviewRef ? { reviewRef } : {}),
          history,
        });
        history.push({ role: 'user', content: line, createdAt: new Date().toISOString() });
        history.push({ role: 'assistant', content: result.answer.answer, createdAt: new Date().toISOString(), citations: result.answer.citations });
        ctx.out.stdout('');
        ctx.out.stdout(renderAnswer(result.answer, ctx));
        ctx.out.info(ctx.out.gray(`${result.answer.usage.promptTokens + result.answer.usage.completionTokens} tokens · ${Date.now() - started}ms · ${result.model}`));
      } catch (err) {
        if (err instanceof ServiceError && err.code === 'NO_PROVIDER') {
          ctx.out.error(err.message);
          break;
        }
        ctx.out.error((err as Error).message);
      }
    }
  } finally {
    rl.close();
  }
  return EXIT.OK;
}

function renderAnswer(answer: ChatAnswer, ctx: CommandContext): string {
  const lines = [answer.answer.trim()];
  if (answer.citations.length > 0) {
    lines.push('', ctx.out.bold('References'));
    for (const c of answer.citations) {
      const where = c.line ? `${c.file}:${c.line}${c.endLine && c.endLine !== c.line ? `-${c.endLine}` : ''}` : c.file;
      lines.push(`  ${c.valid ? ctx.out.cyan('·') : ctx.out.yellow('?')} ${where}${c.note ? ctx.out.gray(` — ${c.note}`) : ''}${c.valid ? '' : ctx.out.yellow(' (not found in the repository)')}`);
    }
  }
  if (answer.caveats.length > 0) {
    lines.push('', ctx.out.gray(`Caveats: ${answer.caveats.join(' ')}`));
  }
  if (answer.invalidCitations > 0) {
    lines.push(ctx.out.yellow(`${answer.invalidCitations} citation(s) could not be verified and were dropped.`));
  }
  lines.push(ctx.out.gray(`confidence: ${answer.confidence}`));
  return lines.join('\n');
}

/* ------------------------------------------------------------------- fix -- */

export async function fixCommand(ctx: CommandContext): Promise<number> {
  const rollbackId = flagString(ctx.argv.flags, 'rollback');
  if (rollbackId) {
    const result = await ctx.service.rollback(rollbackId);
    if (ctx.json) {
      ctx.out.stdout(JSON.stringify({ ok: result.errors.length === 0, ...result, report: undefined }, null, 2));
      return result.errors.length === 0 ? EXIT.OK : EXIT.FIX_REJECTED;
    }
    if (result.errors.length > 0) {
      ctx.out.error(`Rollback incomplete: ${result.errors.join('; ')}`);
      return EXIT.FIX_REJECTED;
    }
    ctx.out.stdout(ctx.out.green(`Restored ${result.reverted.length} file(s): ${result.reverted.join(', ')}`));
    return EXIT.OK;
  }

  const findingRef = ctx.argv.positionals[0];
  if (!findingRef) throw new UsageError('fix needs a finding id.', 'Example: diffwise fix DW-001 --preview');
  const { report, finding } = await ctx.service.findByFinding(findingRef);

  // A developer-supplied patch is validated and registered before the normal
  // preview/approval flow, so it goes through exactly the same safety checks.
  const patchFile = flagString(ctx.argv.flags, 'patch-file');
  let registeredId: string | undefined;
  if (patchFile) {
    const diff = await readFile(resolve(process.cwd(), patchFile), 'utf8');
    const registered = await ctx.service.registerPatch({
      findingId: finding.id,
      diff,
      ...(flagString(ctx.argv.flags, 'title') ? { label: flagString(ctx.argv.flags, 'title') as string } : {}),
    });
    registeredId = registered.fix.id;
    ctx.out.info(`${ctx.out.gray('registered')} ${registered.fix.id} ${registered.preview.applies ? ctx.out.green('(applies)') : ctx.out.red('(does not apply)')}`);
  }

  ctx.out.info(ctx.out.gray(`generating fix options for ${finding.id}…`));
  const { fixes, warnings } = await ctx.service.fixOptions(finding.id, { generate: flagBool(ctx.argv.flags, 'compare') || flagBool(ctx.argv.flags, 'preview') || flagBool(ctx.argv.flags, 'apply') });
  for (const warning of warnings) ctx.out.warn(warning);

  if (fixes.length === 0) {
    if (ctx.json) {
      ctx.out.stdout(JSON.stringify({ ok: false, findingId: finding.id, fixes: [], warnings }, null, 2));
      return EXIT.NOT_FOUND;
    }
    ctx.out.stdout([
      renderFinding(finding, ctx.out),
      '',
      ctx.out.yellow('No patch-based fix is available for this finding.'),
      ctx.out.gray(`Recommendation: ${finding.recommendation}`),
    ].join('\n'));
    return EXIT.OK;
  }

  if (flagBool(ctx.argv.flags, 'compare')) {
    return compareFixes(ctx, fixes);
  }

  const solutionId = flagString(ctx.argv.flags, 'solution') ?? registeredId;
  // Without an explicit solution, prefer an option that actually carries a patch
  // so `--preview`/`--apply` never select guidance-only text by accident.
  const selected = solutionId
    ? fixes.find((f) => f.id === solutionId)
    : (fixes.find((f) => Boolean(f.patch?.diff)) ?? fixes[0]);
  if (!selected) {
    throw new UsageError(`No fix option "${solutionId}" for ${finding.id}.`, `Available: ${fixes.map((f) => f.id).join(', ')}`);
  }

  if (flagBool(ctx.argv.flags, 'preview') || flagBool(ctx.argv.flags, 'apply')) {
    const { preview } = await ctx.service.previewFix(finding.id, selected.id);
    if (ctx.json && !flagBool(ctx.argv.flags, 'apply')) {
      ctx.out.stdout(JSON.stringify({
        ok: preview.applies,
        findingId: finding.id,
        fix: { id: selected.id, label: selected.label, description: selected.description, approach: selected.approach },
        preview,
      }, null, 2));
      return preview.applies ? EXIT.OK : EXIT.FIX_REJECTED;
    }
    ctx.out.stdout(renderPreview(ctx, selected, preview));
    if (!preview.applies) {
      ctx.out.error(preview.reason ?? 'The patch does not apply to the current working tree.');
      return EXIT.FIX_REJECTED;
    }
    if (preview.stale.length > 0) {
      ctx.out.error(`The working tree changed since preview: ${preview.stale.join(', ')}`);
      return EXIT.FIX_REJECTED;
    }
    if (!flagBool(ctx.argv.flags, 'apply')) {
      ctx.out.info(ctx.out.gray(`apply with: diffwise fix ${finding.id} --solution ${selected.id} --apply`));
      return EXIT.OK;
    }

    const approved = flagBool(ctx.argv.flags, 'yes')
      ? true
      : ctx.interactive && !ctx.noInput
        ? await confirm(ctx, `Apply this patch to ${preview.files.length} file(s)?`)
        : false;
    if (!approved) {
      ctx.out.info(ctx.out.yellow('Not applied. Nothing was written.'));
      return EXIT.CANCELLED;
    }

    const result = await ctx.service.applyFix({
      findingId: finding.id,
      solutionId: selected.id,
      approved: true,
      ...(flagBool(ctx.argv.flags, 'allow-delete') ? { allowDelete: true } : {}),
    });
    if (ctx.json) {
      ctx.out.stdout(JSON.stringify({
        ok: result.applied.applied,
        applied: { files: result.applied.files, backupDir: result.applied.backupDir, errors: result.applied.errors },
        reportId: result.report.id,
      }, null, 2));
      return result.applied.applied ? EXIT.OK : EXIT.FIX_REJECTED;
    }
    if (!result.applied.applied) {
      ctx.out.error(result.applied.errors.join('; ') || 'The patch was not applied.');
      return EXIT.FIX_REJECTED;
    }
    ctx.out.stdout([
      ctx.out.green(`Applied ${selected.label}`),
      ...result.applied.files.map((f) => `  ${ctx.out.cyan('mod')} ${f}`),
      ctx.out.gray(`backup ${result.applied.backupDir}`),
      '',
      ctx.out.bold('Next'),
      `  diffwise verify --finding ${finding.id}   run the configured verification command`,
      `  diffwise review                           re-review the change`,
    ].join('\n'));
    return EXIT.OK;
  }

  // Default: list the options.
  if (ctx.json) {
    ctx.out.stdout(JSON.stringify({
      ok: true, reviewId: report.id, findingId: finding.id, warnings,
      fixes: fixes.map(briefFix),
    }, null, 2));
    return EXIT.OK;
  }
  const lines = [ctx.out.bold(`Fix options for ${finding.id}`), ''];
  for (const fix of fixes) {
    lines.push(`  ${ctx.out.cyan(fix.id)}  ${ctx.out.bold(fix.label)} ${ctx.out.gray(`· ${fix.complexity} complexity · ${fix.source}`)}`);
    lines.push(`    ${truncate(fix.description, Math.max(40, width() - 6))}`);
    if (fix.filesAffected.length) lines.push(`    ${ctx.out.gray(`files: ${fix.filesAffected.join(', ')}`)}`);
    const patch = fix.patch ? (fix.patch.validation.applies ? ctx.out.green('patch applies') : ctx.out.yellow('patch does not apply')) : ctx.out.gray('guidance only');
    lines.push(`    ${patch}`);
    lines.push('');
  }
  lines.push(ctx.out.gray(`preview: diffwise fix ${finding.id} --preview      compare: diffwise fix ${finding.id} --compare`));
  ctx.out.stdout(lines.join('\n'));
  return EXIT.OK;
}

function briefFix(fix: FixSolution): unknown {
  return {
    id: fix.id, label: fix.label, approach: fix.approach, description: fix.description,
    complexity: fix.complexity, filesAffected: fix.filesAffected, source: fix.source,
    applies: fix.patch?.validation.applies ?? null, hasPatch: Boolean(fix.patch?.diff),
  };
}

function compareFixes(ctx: CommandContext, fixes: FixSolution[]): number {
  if (ctx.json) {
    ctx.out.stdout(JSON.stringify({ ok: true, fixes: fixes.map(briefFix) }, null, 2));
    return EXIT.OK;
  }
  const lines: string[] = [ctx.out.bold(`Comparing ${fixes.length} fix strategies`), ''];
  for (const fix of fixes) {
    lines.push(`${ctx.out.cyan(fix.id)} ${ctx.out.bold(fix.label)} ${ctx.out.gray(`(${fix.complexity} complexity)`)}`);
    lines.push(`  ${ctx.out.bold('Approach')}     ${fix.approach}`);
    lines.push(`  ${ctx.out.bold('Trade-offs')}   ${fix.advantages.join(' ') || '—'}`);
    if (fix.disadvantages.length) lines.push(`  ${ctx.out.bold('Risks')}        ${fix.disadvantages.join(' ')}`);
    if (fix.sideEffects.length) lines.push(`  ${ctx.out.bold('Side effects')} ${fix.sideEffects.join(' ')}`);
    lines.push(`  ${ctx.out.bold('Files')}        ${fix.filesAffected.join(', ') || '—'}`);
    lines.push(`  ${ctx.out.bold('Testing')}      ${fix.testing.join(' ') || '—'}`);
    lines.push(`  ${ctx.out.bold('Patch')}        ${fix.patch ? (fix.patch.validation.applies ? ctx.out.green('applies') : ctx.out.yellow('does not apply')) : ctx.out.gray('none')}`);
    lines.push('');
  }
  ctx.out.stdout(lines.join('\n'));
  return EXIT.OK;
}

function renderPreview(ctx: CommandContext, fix: FixSolution, preview: {
  applies: boolean; reason?: string; files: string[]; fuzz: number;
  stats: { files: number; additions: number; deletions: number };
  stale: string[];
}): string {
  const lines: string[] = [
    ctx.out.bold(`Patch preview — ${fix.label}`),
    ctx.out.gray(`${preview.stats.files} file(s) · ${ctx.out.green(`+${preview.stats.additions}`)} ${ctx.out.red(`-${preview.stats.deletions}`)} · ${preview.applies ? ctx.out.green('applies cleanly') : ctx.out.red('does not apply')}${preview.fuzz ? ` · fuzz ${preview.fuzz}` : ''}`),
    '',
  ];
  const diff = fix.patch?.diff ?? '';
  for (const line of diff.split('\n').slice(0, 200)) {
    if (line.startsWith('+++') || line.startsWith('---')) lines.push(ctx.out.bold(line));
    else if (line.startsWith('@@')) lines.push(ctx.out.cyan(line));
    else if (line.startsWith('+')) lines.push(ctx.out.green(line));
    else if (line.startsWith('-')) lines.push(ctx.out.red(line));
    else lines.push(ctx.out.gray(line));
  }
  if (diff.split('\n').length > 200) lines.push(ctx.out.gray('… patch truncated in the terminal; the full patch is used for apply'));
  if (preview.reason) lines.push('', ctx.out.red(preview.reason));
  return lines.join('\n');
}

async function confirm(ctx: CommandContext, question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/* ---------------------------------------------------------------- verify -- */

export async function verifyCommand(ctx: CommandContext): Promise<number> {
  const findingId = flagString(ctx.argv.flags, 'finding');
  const command = ctx.service.config.verification.command;
  if (!command) {
    if (ctx.json) {
      ctx.out.stdout(JSON.stringify({
        ok: false,
        status: 'not-run',
        error: 'No verification command configured.',
        hint: 'Set verification.command in .diffwise/config.json, e.g. "npm test".',
      }, null, 2));
      return EXIT.VERIFICATION_FAILED;
    }
    ctx.out.error('No verification command is configured.', 'Set verification.command in .diffwise/config.json, for example "npm test".');
    return EXIT.VERIFICATION_FAILED;
  }

  ctx.out.info(`${ctx.out.gray('running')} ${command}`);
  const result = await ctx.service.verify({ ...(findingId ? { findingId } : {}) });

  if (ctx.json) {
    ctx.out.stdout(JSON.stringify({
      ok: result.execution.status === 'passed',
      reviewId: result.report.id,
      execution: result.execution,
      record: result.record,
    }, null, 2));
    return result.execution.status === 'passed' ? EXIT.OK : EXIT.VERIFICATION_FAILED;
  }

  const tone = (text: string): string => (result.execution.status === 'passed'
    ? ctx.out.green(text)
    : result.execution.status === 'not-run' ? ctx.out.yellow(text) : ctx.out.red(text));
  ctx.out.stdout([
    `${ctx.out.bold('Verification')} ${tone(result.execution.status.toUpperCase())}${result.execution.exitCode !== null ? ctx.out.gray(` · exit ${result.execution.exitCode}`) : ''} ${ctx.out.gray(`· ${result.execution.durationMs}ms`)}`,
    ctx.out.gray(`$ ${command}`),
    '',
    ...result.execution.outputTail.split('\n').slice(-25),
    '',
    ctx.out.gray(`recorded in ${result.report.id}`),
  ].join('\n'));
  return result.execution.status === 'passed' ? EXIT.OK : EXIT.VERIFICATION_FAILED;
}
