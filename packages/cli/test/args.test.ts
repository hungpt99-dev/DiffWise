import { describe, expect, it } from 'vitest';
import { parseArgs, flagString, flagBool, flagFalse, flagNumber, assertKnownFlags, UsageError } from '../src/args';
import { resolveTarget } from '../src/target';
import { EXIT, exitCodesText } from '../src/exit';
import { COMMANDS } from '../src/registry';
import { Help } from '../src/help';

describe('argument parsing', () => {
  it('parses a command, positionals and value flags', () => {
    const args = parseArgs(['review', 'main..HEAD', '--format', 'json', '--out=report.json']);
    expect(args.command).toBe('review');
    expect(args.positionals).toEqual(['main..HEAD']);
    expect(flagString(args.flags, 'format')).toBe('json');
    expect(flagString(args.flags, 'out')).toBe('report.json');
  });

  it('supports short flags and --flag=value', () => {
    const args = parseArgs(['findings', '-j', '--severity=high']);
    expect(flagBool(args.flags, 'json')).toBe(true);
    expect(flagString(args.flags, 'severity')).toBe('high');
  });

  it('treats --no-color as color=false without inventing a flag', () => {
    const args = parseArgs(['review', '--no-color']);
    expect(flagFalse(args.flags, 'color')).toBe(true);
    expect(args.flags['no-color']).toBeUndefined();
    expect(() => assertKnownFlags(args.flags, ['format'])).not.toThrow();
  });

  it('rejects a value flag without a value', () => {
    expect(() => parseArgs(['review', '--format'])).toThrow(UsageError);
  });

  it('rejects unknown flags when a command allow-list is applied', () => {
    const args = parseArgs(['findings', '--nope']);
    expect(() => assertKnownFlags(args.flags, ['severity'])).toThrow(/Unknown flag --nope/);
  });

  it('parses numbers and rejects non-numeric values', () => {
    expect(flagNumber({ limit: '10' }, 'limit')).toBe(10);
    expect(() => flagNumber({ limit: 'ten' }, 'limit')).toThrow(/expects a number/);
  });

  it('keeps everything after -- as positional', () => {
    const args = parseArgs(['chat', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['--not-a-flag']);
  });
});

describe('review target resolution', () => {
  const root = '/repo';

  it('defaults to the working tree', () => {
    expect(resolveTarget({ positionals: [], flags: {}, root }).mode).toBe('working');
  });

  it('resolves --staged, --commit and ranges', () => {
    expect(resolveTarget({ positionals: [], flags: { staged: true }, root }).mode).toBe('staged');
    const commit = resolveTarget({ positionals: [], flags: { commit: 'HEAD' }, root });
    expect(commit.mode).toBe('commits');
    expect(commit.base).toBe('HEAD^');
    const range = resolveTarget({ positionals: ['main..feature/x'], flags: {}, root });
    expect(range).toMatchObject({ mode: 'branch', base: 'main', head: 'feature/x' });
    const open = resolveTarget({ positionals: ['main..'], flags: {}, root });
    expect(open.head).toBe('HEAD');
  });

  it('resolves explicit base/head and paths', () => {
    const explicit = resolveTarget({ positionals: [], flags: { base: 'origin/main', head: 'HEAD' }, root });
    expect(explicit).toMatchObject({ mode: 'branch', base: 'origin/main', head: 'HEAD' });
    const paths = resolveTarget({ positionals: ['src/payments/'], flags: {}, root });
    expect(paths.mode).toBe('files');
    expect(paths.paths).toEqual(['src/payments']);
  });

  it('refuses contradictory combinations', () => {
    expect(() => resolveTarget({ positionals: ['main..HEAD'], flags: { staged: true }, root })).toThrow(UsageError);
    expect(() => resolveTarget({ positionals: [], flags: { base: 'main' }, root })).toThrow(/Both --base and --head/);
    expect(() => resolveTarget({ positionals: ['main..HEAD', 'src/'], flags: {}, root })).toThrow(UsageError);
  });

  it('refuses paths outside the repository', () => {
    expect(() => resolveTarget({ positionals: ['../outside'], flags: {}, root })).toThrow(/outside the repository/);
  });
});

describe('exit code contract', () => {
  it('documents every exit code', () => {
    const text = exitCodesText();
    for (const code of Object.values(EXIT)) {
      expect(text).toContain(String(code));
    }
    expect(text).toMatch(/Quality gate failed/);
    expect(text).toMatch(/Internal error/);
  });

  it('keeps the command registry free of duplicate names', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('documents every declared flag in help output', () => {
    for (const command of COMMANDS) {
      const help = Help.forCommand(command.name);
      for (const flag of command.flags) {
        expect(help, `${command.name} help is missing --${flag}`).toContain(`--${flag}`);
      }
    }
  });
});
