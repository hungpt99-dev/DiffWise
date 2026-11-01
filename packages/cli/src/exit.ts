/**
 * Exit codes.
 *
 * Stable and documented (docs/CLI.md): CI pipelines branch on these, so they
 * must not change without a major version. `0` is success, `1` is the quality
 * gate, and every other code names one specific failure class.
 */
export const EXIT = {
  OK: 0,
  /** Findings at or above the configured threshold (CI gate). */
  GATE_FAILED: 1,
  /** Bad command line, unknown flag, invalid value. */
  USAGE: 2,
  /** Not a git repository, unreadable config, unwritable report directory. */
  WORKSPACE: 3,
  /** Review or finding id does not exist. */
  NOT_FOUND: 4,
  /** AI provider missing, unreachable, or returned an unusable response. */
  PROVIDER: 5,
  /** Verification command exists and failed, timed out, or was refused. */
  VERIFICATION_FAILED: 6,
  /** Fix refused: not approved, stale patch, fuzzy context, unsafe path. */
  FIX_REJECTED: 7,
  /** Operator cancelled (SIGINT / answer "no"). */
  CANCELLED: 8,
  /** Unhandled internal error — always a bug. */
  INTERNAL: 9,
} as const;

export type ExitCode = typeof EXIT[keyof typeof EXIT];

export const EXIT_DESCRIPTIONS: Array<{ code: number; meaning: string }> = [
  { code: EXIT.OK, meaning: 'Success.' },
  { code: EXIT.GATE_FAILED, meaning: 'Quality gate failed: findings at or above the configured threshold.' },
  { code: EXIT.USAGE, meaning: 'Usage error: unknown command, flag or value.' },
  { code: EXIT.WORKSPACE, meaning: 'Workspace error: not a git repository, bad config, unwritable report directory.' },
  { code: EXIT.NOT_FOUND, meaning: 'Review or finding not found.' },
  { code: EXIT.PROVIDER, meaning: 'AI provider missing, unreachable or returned an unusable response.' },
  { code: EXIT.VERIFICATION_FAILED, meaning: 'Verification did not pass (failed, timed out, or not run).' },
  { code: EXIT.FIX_REJECTED, meaning: 'Fix refused: not approved, stale, fuzzy, or unsafe.' },
  { code: EXIT.CANCELLED, meaning: 'Cancelled by the operator.' },
  { code: EXIT.INTERNAL, meaning: 'Internal error (please report).' },
];

/** Documented exit codes, in one place (help + docs). */
export function exitCodesText(): string {
  return EXIT_DESCRIPTIONS.map((d) => `  ${String(d.code).padEnd(3)} ${d.meaning}`).join('\n');
}
