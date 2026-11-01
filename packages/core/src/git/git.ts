import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseUnifiedDiff, makeUntracked, type RawFileDiff } from './diff';
import { detectLanguage, isTestFile } from '../analysis/languages';
import type { FileChange, RepositoryInfo, ReviewTarget } from '../types';

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Thin, shell-free git adapter.
 *
 * All commands are executed with `execFile` and an explicit argument array so
 * that file names controlled by the repository can never be interpreted by a
 * shell.
 */
export class GitClient {
  readonly root: string;
  private readonly maxFileBytes: number;

  constructor(root: string, opts: { maxFileBytes?: number } = {}) {
    this.root = resolve(root);
    this.maxFileBytes = opts.maxFileBytes ?? 400_000;
  }

  run(args: string[], opts: { maxBuffer?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<GitRunResult> {
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        'git',
        args,
        {
          cwd: this.root,
          maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
          timeout: opts.timeoutMs ?? 60_000,
          encoding: 'utf8',
          signal: opts.signal,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
        },
        (err, stdout, stderr) => {
          if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
            reject(new GitError((err as Error).message, args, String(stderr ?? '')));
            return;
          }
          const code = err ? Number((err as { code?: number }).code ?? 1) : 0;
          resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
        },
      );
      child.stdin?.end();
    });
  }

  async assertRepo(): Promise<void> {
    const r = await this.run(['rev-parse', '--show-toplevel']);
    if (r.code !== 0) throw new GitError('Not a git repository', ['rev-parse'], r.stderr);
  }

  async info(): Promise<RepositoryInfo> {
    const [branch, head, remote, ls, pkg] = await Promise.all([
      this.run(['rev-parse', '--abbrev-ref', 'HEAD']),
      this.run(['log', '-1', '--pretty=format:%H%x00%s']),
      this.run(['config', '--get', 'remote.origin.url']),
      this.run(['ls-files']),
      this.run(['rev-parse', '--show-prefix']),
    ]);
    const [headCommit = '', headSubject = ''] = head.stdout.split('\u0000');
    const files = ls.stdout.split('\n').filter(Boolean);
    const counts = new Map<string, number>();
    for (const f of files) {
      const lang = detectLanguage(f);
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    const languages = [...counts.entries()]
      .map(([language, n]) => ({ language: language as RepositoryInfo['languages'][number]['language'], files: n }))
      .sort((a, b) => b.files - a.files);
    const name = this.root.split('/').filter(Boolean).pop() ?? 'repository';
    const hints: string[] = [];
    if (files.some((f) => /(^|\/)src\/.*\.tsx?$/.test(f))) hints.push('TypeScript');
    if (files.some((f) => /(^|\/)(routes|controllers|handlers)\//.test(f))) hints.push('HTTP routing layer');
    if (files.some((f) => /(^|\/)migrations?\//.test(f))) hints.push('SQL migrations');
    if (files.some((f) => /\.test\.|\.spec\./.test(f))) hints.push('Automated tests');
    if (files.some((f) => /(^|\/)(docker-compose\.ya?ml|Dockerfile)$/.test(f))) hints.push('Containers');
    if (files.some((f) => /kafka|rabbit|amqp/i.test(f))) hints.push('Async messaging');
    if (pkg.stdout.trim()) hints.push('Subdirectory workspace');
    return {
      root: this.root,
      name,
      branch: branch.stdout.trim() || 'HEAD',
      headCommit,
      headSubject,
      remoteUrl: remote.stdout.trim() || undefined,
      languages,
      packageManager: files.includes('package-lock.json') ? 'npm'
        : files.includes('pnpm-lock.yaml') ? 'pnpm'
        : files.includes('yarn.lock') ? 'yarn'
        : files.includes('poetry.lock') ? 'poetry'
        : files.includes('go.mod') ? 'go modules'
        : undefined,
      frameworkHints: hints,
      fileCount: files.length,
    };
  }

  /**
   * Resolve which git refs bound the review, so old content can be fetched with
   * `git show <baseRef>:<path>`.
   */
  async resolveTarget(target: ReviewTarget): Promise<{ baseRef: string; headRef: 'WORKTREE' | 'INDEX' | string; baseLabel: string; headLabel: string }> {
    switch (target.mode) {
      case 'working':
        return { baseRef: 'HEAD', headRef: 'WORKTREE', baseLabel: 'HEAD', headLabel: 'working tree' };
      case 'staged':
        return { baseRef: 'HEAD', headRef: 'INDEX', baseLabel: 'HEAD', headLabel: 'index' };
      case 'branch': {
        const base = target.base ?? 'main';
        const head = target.head ?? 'HEAD';
        const mb = await this.run(['merge-base', base, head]);
        const baseRef = mb.code === 0 ? mb.stdout.trim() : base;
        return { baseRef, headRef: head, baseLabel: base, headLabel: head };
      }
      case 'commits': {
        const base = target.base ?? 'HEAD~1';
        const head = target.head ?? 'HEAD';
        return { baseRef: base, headRef: head, baseLabel: base, headLabel: head };
      }
      case 'files':
        return { baseRef: 'HEAD', headRef: 'WORKTREE', baseLabel: 'HEAD', headLabel: 'working tree' };
    }
  }

  async diff(target: ReviewTarget, opts: { signal?: AbortSignal } = {}): Promise<{ changes: FileChange[]; baseRef: string }> {
    const resolved = await this.resolveTarget(target);
    const args = ['diff', '--find-renames', '--unified=3', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
    let revisions: string[];
    switch (target.mode) {
      case 'staged':
        args.push('--cached');
        revisions = ['HEAD'];
        break;
      case 'branch':
        // Triple-dot diffs against the merge base, which is what a reviewer
        // expects when comparing a feature branch with main.
        revisions = [`${target.base ?? 'main'}...${target.head ?? 'HEAD'}`];
        break;
      case 'commits':
        revisions = [`${target.base ?? 'HEAD~1'}..${target.head ?? 'HEAD'}`];
        break;
      case 'working':
      case 'files':
      default:
        revisions = ['HEAD'];
        break;
    }
    const pathFilter = target.mode === 'files' && target.paths?.length ? ['--', ...target.paths] : [];
    const r = await this.run([...args, ...revisions, ...pathFilter], { signal: opts.signal });
    if (r.code !== 0) throw new GitError('git diff failed', args, r.stderr);

    const raw: RawFileDiff[] = parseUnifiedDiff(r.stdout);
    const changes: FileChange[] = raw.map((d) => ({
      path: d.path,
      ...(d.oldPath ? { oldPath: d.oldPath } : {}),
      status: d.status,
      additions: d.additions,
      deletions: d.deletions,
      binary: d.binary,
      hunks: d.hunks,
      patch: d.patch,
      language: detectLanguage(d.path),
    }));

    // Untracked files never appear in `git diff`; add them explicitly so a new
    // module is reviewed instead of silently ignored. Only for worktree-based
    // targets: a staged or committed review must not widen its scope with
    // files that are not part of the change being reviewed.
    if (target.mode === 'working' || target.mode === 'files') {
      const status = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { signal: opts.signal });
      const entries = status.stdout.split('\u0000');
      for (const entry of entries) {
        if (!entry.startsWith('?? ')) continue;
        const path = entry.slice(3);
        if (target.mode === 'files' && target.paths?.length && !target.paths.some((p) => path === p)) continue;
        if (changes.some((c) => c.path === path)) continue;
        const content = await this.readWorktreeFile(path);
        if (content === null) continue;
        changes.push(makeUntracked(path, content));
      }
    }

    return { changes, baseRef: resolved.baseRef };
  }

  async readWorktreeFile(path: string): Promise<string | null> {
    try {
      const abs = join(this.root, path);
      const s = await stat(abs);
      if (!s.isFile()) return null;
      if (s.size > this.maxFileBytes) return null;
      const buf = await readFile(abs);
      if (buf.includes(0)) return null; // binary
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }

  async readFileAt(ref: string, path: string): Promise<string | null> {
    try {
      const r = await this.run(['show', `${ref}:${path}`], { maxBuffer: 16 * 1024 * 1024 });
      if (r.code !== 0) return null;
      if (r.stdout.length > this.maxFileBytes) return r.stdout.slice(0, this.maxFileBytes);
      if (r.stdout.includes('\u0000')) return null;
      return r.stdout;
    } catch {
      return null;
    }
  }

  /** Content of the analysed version of a file (new side of the diff). */
  async readHeadContent(change: FileChange, target: ReviewTarget): Promise<string | null> {
    if (change.status === 'deleted') return null;
    if (target.mode === 'staged') {
      const staged = await this.run(['show', `:${change.path}`]);
      if (staged.code === 0 && !staged.stdout.includes('\u0000')) return staged.stdout;
    }
    if (target.mode === 'branch' || target.mode === 'commits') {
      const r = await this.readFileAt(target.head ?? 'HEAD', change.path);
      if (r !== null) return r;
    }
    return this.readWorktreeFile(change.path);
  }

  async listTrackedFiles(): Promise<string[]> {
    const r = await this.run(['ls-files']);
    return r.stdout.split('\n').filter(Boolean);
  }

  /** All files including untracked-but-not-ignored ones, for graph building. */
  async listWorktreeFiles(): Promise<string[]> {
    const r = await this.run(['ls-files', '--cached', '--others', '--exclude-standard']);
    return [...new Set(r.stdout.split('\n').filter(Boolean))].sort();
  }

  async recentCommits(limit = 20): Promise<Array<{ hash: string; subject: string; date: string; author: string }>> {
    const r = await this.run(['log', `-${limit}`, '--pretty=format:%H%x00%s%x00%aI%x00%an%x00']);
    return r.stdout.split('\u0000\n').filter(Boolean).map((chunk) => {
      const [hash = '', subject = '', date = '', author = ''] = chunk.split('\u0000');
      return { hash, subject, date, author };
    });
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const r = await this.run(['status', '--porcelain']);
    return r.stdout.trim().length > 0;
  }
}

/** Detects whether a path is inside the repository (defends against `../` in model output). */
export function isInsideRepo(root: string, candidate: string): boolean {
  const abs = resolve(root, candidate);
  return abs === root || abs.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export function isTestOrFixture(path: string): boolean {
  return isTestFile(path) || /(^|\/)(fixtures?|mocks?|examples?|samples?)\//.test(path);
}
