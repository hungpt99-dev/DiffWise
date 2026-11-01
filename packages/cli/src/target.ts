/**
 * Turning command-line arguments into an explicit review target.
 *
 * The target is part of the report contract: it records what was compared, so
 * a finding can always be traced back to a revision pair or a path filter.
 */
import { resolve } from 'node:path';
import type { ReviewTarget } from '@diffwise/core';
import { flagBool, flagString, UsageError, type ParsedArgs } from './args';

export interface TargetInput {
  positionals: string[];
  flags: ParsedArgs['flags'];
  root: string;
}

const REF_RANGE = /^([^.\s]+)\.\.([^.\s]*)$/;

export function resolveTarget(input: TargetInput): ReviewTarget {
  const { positionals, flags, root } = input;

  if (flagBool(flags, 'staged')) {
    if (positionals.length > 0) throw new UsageError('--staged cannot be combined with a revision or path.');
    return { mode: 'staged', label: 'Staged changes' };
  }

  const commit = flagString(flags, 'commit');
  if (commit) {
    if (positionals.length > 0) throw new UsageError('--commit cannot be combined with paths.');
    return { mode: 'commits', base: `${commit}^`, head: commit, label: `commit ${commit}` };
  }

  const base = flagString(flags, 'base');
  const head = flagString(flags, 'head');
  if (base || head) {
    if (!base || !head) throw new UsageError('Both --base and --head are required when comparing revisions.');
    if (positionals.length > 0) throw new UsageError('--base/--head cannot be combined with paths.');
    return { mode: 'branch', base, head, label: `${base}...${head}` };
  }

  // Paths: "diffwise review src/payment/" analyses only those files.
  const paths = positionals.filter((p) => !REF_RANGE.test(p));
  const ranges = positionals.filter((p) => REF_RANGE.test(p));
  if (ranges.length > 1) throw new UsageError('Only one revision range can be reviewed at a time.');
  const range = ranges[0];
  if (range) {
    if (paths.length > 0) throw new UsageError('A revision range cannot be combined with paths.');
    const match = REF_RANGE.exec(range);
    const from = match?.[1] ?? '';
    const to = match?.[2] || 'HEAD';
    return { mode: 'branch', base: from, head: to, label: `${from}..${to}` };
  }

  if (paths.length > 0) {
    return {
      mode: 'files',
      paths: paths.map((p) => normalisePath(p, root)),
      head: 'HEAD',
      label: paths.length === 1 ? paths[0] as string : `${paths.length} paths`,
    };
  }

  return { mode: 'working', label: 'Working tree' };
}

function normalisePath(path: string, root: string): string {
  const abs = resolve(root, path);
  if (!abs.startsWith(root)) throw new UsageError(`Path is outside the repository: ${path}`);
  return abs === root ? '.' : abs.slice(root.length + 1).replace(/\\/g, '/');
}

export function describeTarget(target: ReviewTarget): string {
  switch (target.mode) {
    case 'working': return 'working tree changes';
    case 'staged': return 'staged changes';
    case 'branch': return `${target.base}..${target.head}`;
    case 'commits': return target.label;
    case 'files': return `paths: ${(target.paths ?? []).join(', ')}`;
    default: return target.label;
  }
}
