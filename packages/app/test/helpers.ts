/**
 * Test helpers: real repositories, never mocks of the analyser.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runReview, type ReviewReport } from '@diffwise/core';

export const repoRoot = resolve(__dirname, '../../..');

export async function makeDemoRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'diffwise-app-'));
  execFileSync(process.execPath, [join(repoRoot, 'demo/build-demo-repo.mjs'), '--target', dir], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  return dir;
}

export async function demoReport(root: string): Promise<ReviewReport> {
  return runReview({
    root,
    target: { mode: 'branch', base: 'main', head: 'feature/partial-refunds', label: 'main..feature/partial-refunds' },
    settings: { aiEnabled: false },
    persist: false,
  });
}

/** A tiny repository with one commit and an uncommitted change. */
export async function makeSmallRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'diffwise-small-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@diffwise.local');
  git('config', 'user.name', 'DiffWise Test');
  git('config', 'commit.gpgsign', 'false');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n', 'utf8');
  await writeFile(join(dir, 'README.md'), '# Small fixture\n\nAdds numbers.\n', 'utf8');
  git('add', '-A');
  git('commit', '-m', 'initial');
  return dir;
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export { cp };
