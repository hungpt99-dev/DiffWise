/**
 * Repository plumbing shared by every application surface.
 *
 * Root discovery, the store location and "which repository files may the model
 * or a chat see" all live here so the CLI, MCP and the report server cannot
 * disagree about the workspace boundary.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative as relativePath, resolve } from 'node:path';
import { openStore, type ReviewStore, type ReviewReport } from '@diffwise/core';

const execFileAsync = promisify(execFile);

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** Absolute repository root for `cwd`, or an actionable error. */
export async function findRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = stdout.trim();
    if (!root) throw new Error('git returned an empty root');
    return root;
  } catch (err) {
    throw new WorkspaceError(
      `Not inside a git repository (${cwd}). Run "git init" first, or pass --repo <path>. (${(err as Error).message.split('\n')[0]})`,
    );
  }
}

export function storeDir(root: string): string {
  return join(root, '.diffwise');
}

export async function openRepoStore(root: string): Promise<ReviewStore> {
  return openStore(root);
}

/**
 * Resolve a repository-relative path, refusing anything that escapes the
 * workspace. Used by the report server before touching the filesystem.
 */
export function resolveInside(root: string, relative: string): string | null {
  if (!relative || relative.includes('\0')) return null;
  const base = resolve(root);
  const abs = resolve(base, relative);
  // `relative` rather than a string prefix: git reports repository roots with
  // forward slashes on Windows, and resolve() returns backslashes. Comparing
  // the two prefixes rejected every path on that platform.
  const inside = relativePath(base, abs);
  if (inside.startsWith('..') || isAbsolute(inside)) return null;
  return abs;
}

/**
 * Files a chat or fix request may read: the changed files, cited evidence,
 * documentation and test files the report already references. Nothing else.
 */
export async function loadReportFiles(root: string, report: ReviewReport, limit = 250): Promise<Map<string, string>> {
  const paths = new Set<string>();
  for (const change of report.changes) {
    paths.add(change.path);
    if (change.oldPath) paths.add(change.oldPath);
  }
  for (const finding of report.findings) {
    paths.add(finding.file);
    for (const e of finding.evidence) if (e.file) paths.add(e.file);
  }
  for (const doc of report.documentation.files) paths.add(doc.path);
  for (const d of report.documentation.findings) {
    paths.add(d.document);
    for (const e of [...d.codeEvidence, ...d.docEvidence]) if (e.file) paths.add(e.file);
  }
  for (const symbol of report.symbols) paths.add(symbol.file);
  for (const test of report.tests.files) paths.add(test.path);
  for (const item of report.knowledge) if (item.path) paths.add(item.path);

  const files = new Map<string, string>();
  for (const path of paths) {
    if (files.size >= limit) break;
    const abs = resolveInside(root, path);
    if (!abs) continue;
    try {
      const content = await readFile(abs, 'utf8');
      if (content.length > 400_000) continue;
      files.set(path, content);
    } catch {
      // Deleted or unreadable: leave it out rather than inventing content.
    }
  }
  return files;
}

/** Files changed in the working tree, for caching keys. */
export async function fileSignatures(root: string, paths: string[]): Promise<Record<string, string>> {
  const { createHash } = await import('node:crypto');
  const out: Record<string, string> = {};
  for (const path of paths) {
    const abs = resolveInside(root, path);
    if (!abs) continue;
    try {
      const content = await readFile(abs);
      out[path] = createHash('sha256').update(content).digest('hex');
    } catch {
      out[path] = 'missing';
    }
  }
  return out;
}
