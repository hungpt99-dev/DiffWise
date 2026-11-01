/**
 * Shared command context.
 *
 * Commands receive one object rather than a dozen parameters, which keeps the
 * dispatcher small and makes the behaviour of `--json`, `--quiet` and TTY
 * detection uniform across the CLI.
 */
import type { DiffWiseService } from '@diffwise/app';
import { flagBool, type ParsedArgs } from './args';
import { Output } from './output';

export interface CommandContext {
  argv: ParsedArgs;
  out: Output;
  /** Parsed lazily: `version` and `help` never touch git or config. */
  service: DiffWiseService;
  root: string;
  json: boolean;
  interactive: boolean;
  noInput: boolean;
  configPath?: string;
}

export function wantsJson(argv: ParsedArgs): boolean {
  if (flagBool(argv.flags, 'json')) return true;
  const format = argv.flags.format;
  return format === 'json' || format === 'sarif';
}

export function formatOf(argv: ParsedArgs): string {
  const format = argv.flags.format;
  return typeof format === 'string' ? format : (flagBool(argv.flags, 'json') ? 'json' : 'text');
}
