/**
 * Interactive follow-up after a review.
 *
 * Only reached when both stdin and stdout are TTYs and `--interactive` was
 * passed: scripts, pipes and agents never see a prompt.
 */
import { createInterface } from 'node:readline/promises';
import type { ReviewReport } from '@diffwise/core';
import type { CommandContext } from '../context';
import { renderFinding, sortFindings } from '../output';
import { serveReport } from './report';

export async function interactiveAfterReview(ctx: CommandContext, report: ReviewReport): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    for (;;) {
      const reply = (await rl.question(ctx.out.cyan('[f]indings  [s]erve report  [d]iscuss  [q]uit › '))).trim().toLowerCase();
      if (!reply || reply === 'q' || reply === 'quit') return;
      if (reply === 'f' || reply === 'findings') {
        const findings = sortFindings(report.findings).slice(0, 10);
        for (const f of findings) {
          ctx.out.stdout('');
          ctx.out.stdout(renderFinding(f, ctx.out, { evidence: false }));
        }
        if (report.findings.length > findings.length) ctx.out.info(ctx.out.gray(`… ${report.findings.length - findings.length} more (diffwise findings)`));
        continue;
      }
      if (reply === 's' || reply === 'serve') {
        await serveReport(ctx, report.id);
        return;
      }
      if (reply === 'd' || reply === 'discuss') {
        ctx.out.info(ctx.out.gray('Open the report with [s] and use the Discussion tab, or run "diffwise chat --finding <id>".'));
        continue;
      }
      ctx.out.info(ctx.out.gray('Unknown action.'));
    }
  } finally {
    rl.close();
  }
}
