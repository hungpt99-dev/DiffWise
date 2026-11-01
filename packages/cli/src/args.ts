/**
 * Argument parsing.
 *
 * Deliberately dependency-free: the CLI is the interface agents and CI call, so
 * its parsing rules must be obvious and stable. Unknown flags are an error, not
 * a silent no-op, because a typo that silently changes review scope is worse
 * than a failed run.
 */

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export class UsageError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Flags that consume the next token (or use --flag=value). */
const VALUE_FLAGS = new Set([
  'format', 'out', 'severity', 'category', 'search', 'limit', 'finding', 'report', 'solution',
  'base', 'head', 'commit', 'port', 'host', 'fail-on', 'config', 'repo', 'patch-file',
  'rollback', 'title', 'max-files', 'kind', 'source', 'target', 'sort', 'severity-min',
  'provider', 'model', 'base-url',
]);

const SHORT: Record<string, string> = {
  h: 'help',
  v: 'version',
  q: 'quiet',
  f: 'format',
  o: 'out',
  j: 'json',
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command = '';
  let i = 0;

  while (i < argv.length) {
    const token = argv[i] as string;
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const raw = token.slice(2);
      const eq = raw.indexOf('=');
      const name = eq >= 0 ? raw.slice(0, eq) : raw;
      if (!name) throw new UsageError('Empty flag.');
      if (eq >= 0) {
        flags[name] = raw.slice(eq + 1);
        i += 1;
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('-') && !/^-\d/.test(next))) {
          throw new UsageError(`Flag --${name} needs a value.`, `Example: --${name} <value>`);
        }
        flags[name] = next;
        i += 2;
        continue;
      }
      if (name.startsWith('no-') && !VALUE_FLAGS.has(name.slice(3))) {
        // --no-color is recorded as color=false; the negated spelling itself is
        // not a separate flag, so allow-lists stay small.
        flags[name.slice(3)] = false;
        i += 1;
        continue;
      }
      flags[name] = true;
      i += 1;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const letters = token.slice(1).split('');
      for (const letter of letters) {
        const long = SHORT[letter] ?? letter;
        if (VALUE_FLAGS.has(long)) {
          const next = argv[i + 1];
          if (next === undefined) throw new UsageError(`Flag -${letter} needs a value.`);
          flags[long] = next;
          i += 2;
          continue;
        }
        flags[long] = true;
      }
      i += 1;
      continue;
    }
    if (!command) command = token;
    else positionals.push(token);
    i += 1;
  }

  return { command, positionals, flags };
}

export function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true;
}

/** `--no-x` is parsed as `x=false`; this answers "was it explicitly turned off". */
export function flagFalse(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === false;
}

export function flagNumber(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} expects a number, got "${value}".`);
  return n;
}

/** Any flag the parser accepted but no command understands is a usage error. */
export function assertKnownFlags(flags: ParsedArgs['flags'], allowed: string[]): void {
  const known = new Set([...allowed, 'help', 'json', 'quiet', 'verbose', 'color', 'no-input', 'config', 'repo']);
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) throw new UsageError(`Unknown flag --${key}.`, 'Run "diffwise help" to see supported flags.');
  }
}
