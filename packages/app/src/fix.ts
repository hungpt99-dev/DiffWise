/**
 * Safe patch application.
 *
 * The core patch engine parses and applies unified diffs; this layer adds the
 * guarantees a product needs before touching a developer's working tree:
 *
 *   - the patch is validated against the *current* files, never a cached copy;
 *   - every file that will change is hash-pinned when the preview is produced,
 *     and re-checked at apply time, so edits made in between are detected
 *     instead of overwritten;
 *   - writes are atomic (temp file + rename), so an interrupted apply cannot
 *     leave a half-written source file;
 *   - a transaction journal records the before/after hash and the backup
 *     location for every file, which makes rollback exact.
 *
 * Applying always requires `approved: true` from a caller that obtained it from
 * the developer. There is no code path here that applies silently.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  applyPatchToContents, isSafeRelativePath, parsePatch, validatePatch,
} from '@diffwise/core';
import { resolveInside } from './repo';

export interface FixPreview {
  applies: boolean;
  reason?: string;
  files: string[];
  fuzz: number;
  stats: { files: number; additions: number; deletions: number };
  /** sha256 of each file as it was when the preview was produced. */
  hashes: Record<string, string>;
  /** Files whose current content differs from the preview snapshot. */
  stale: string[];
}

export interface ApplyFixOptions {
  root: string;
  diff: string;
  /** Directory that receives a copy of every file before it is written. */
  backupDir: string;
  /** Hashes captured by `previewFix`; mismatches abort the apply. */
  expectedHashes?: Record<string, string>;
  approved: boolean;
  findingId: string;
  solutionId: string;
  reviewId: string;
  allowDelete?: boolean;
  /** Allow a patch that needed fuzzy context matching. Off by default. */
  allowFuzz?: boolean;
}

export interface TransactionEntry {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  backupPath: string | null;
  action: 'update' | 'create' | 'delete';
}

export interface ApplyFixResult {
  applied: boolean;
  files: string[];
  backupDir: string;
  journalPath?: string;
  fuzz: number;
  errors: string[];
  entries: TransactionEntry[];
}

export interface TransactionJournal {
  id: string;
  reviewId: string;
  findingId: string;
  solutionId: string;
  createdAt: string;
  status: 'applied' | 'rolled-back';
  entries: TransactionEntry[];
}

async function hashFile(root: string, path: string): Promise<string | null> {
  const abs = resolveInside(root, path);
  if (!abs) return null;
  try {
    return createHash('sha256').update(await readFile(abs)).digest('hex');
  } catch {
    return null;
  }
}

function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/** Validate a patch against the working tree and pin the files it touches. */
export async function previewFix(root: string, diff: string): Promise<FixPreview> {
  const result = await validatePatch(root, diff);
  const hashes: Record<string, string> = {};
  for (const file of result.files) {
    const hash = await hashFile(root, file);
    if (hash) hashes[file] = hash;
  }
  const stats = diffStats(diff);
  return {
    applies: result.applies,
    ...(result.reason ? { reason: result.reason } : {}),
    files: result.files,
    fuzz: result.fuzz ?? 0,
    stats: { files: result.files.length, ...stats },
    hashes,
    stale: [],
  };
}

/** Detect files that changed between preview and apply. */
export async function staleFiles(root: string, expected: Record<string, string>): Promise<string[]> {
  const stale: string[] = [];
  for (const [path, hash] of Object.entries(expected)) {
    const current = await hashFile(root, path);
    if (current !== hash) stale.push(path);
  }
  return stale;
}

export async function applyFix(options: ApplyFixOptions): Promise<ApplyFixResult> {
  const { root, diff, backupDir } = options;
  const fail = (message: string): ApplyFixResult => ({
    applied: false, files: [], backupDir, fuzz: 0, errors: [message], entries: [],
  });

  if (!options.approved) {
    return fail('A fix can only be applied after explicit developer approval. Re-run with --apply (CLI) or use the Approve button (web report).');
  }
  if (!diff.trim()) return fail('The fix contains no patch.');

  let patch;
  try {
    patch = parsePatch(diff);
  } catch (err) {
    return fail(`Patch could not be parsed: ${(err as Error).message}`);
  }
  if (patch.length === 0) return fail('The patch contains no file sections.');

  const errors: string[] = [];
  for (const file of patch) {
    if (!isSafeRelativePath(file.path)) errors.push(`Refusing path outside the repository: ${file.path}`);
    if (file.isDelete && !options.allowDelete) errors.push(`Deleting ${file.path} requires --allow-delete.`);
  }
  if (errors.length) return { ...fail(''), errors, applied: false, files: [] };

  if (options.expectedHashes && Object.keys(options.expectedHashes).length > 0) {
    const stale = await staleFiles(root, options.expectedHashes);
    if (stale.length) {
      return fail(`The working tree changed since this patch was previewed: ${stale.join(', ')}. Re-generate the fix so newer edits are not overwritten.`);
    }
  }

  let computed: Map<string, string>;
  let fuzz = 0;
  try {
    const applied = applyPatchToContents(patch, (path) => {
      const abs = resolveInside(root, path) as string;
      try {
        return { exists: true, content: require('node:fs').readFileSync(abs, 'utf8') as string };
      } catch {
        return { exists: false, content: '' };
      }
    });
    computed = applied.result;
    fuzz = applied.fuzz;
  } catch (err) {
    return fail(`Patch does not apply: ${(err as Error).message}`);
  }
  if (fuzz > 0 && !options.allowFuzz) {
    return fail(`Patch needed fuzzy context matching (fuzz ${fuzz}); refusing to apply. Re-generate the fix against the current files.`);
  }

  const txId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 6)}`;
  const txBackupDir = join(backupDir, txId);
  await mkdir(txBackupDir, { recursive: true });

  const entries: TransactionEntry[] = [];
  const written: string[] = [];
  try {
    for (const file of patch) {
      const abs = resolveInside(root, file.path);
      if (!abs) throw new Error(`Unsafe path: ${file.path}`);
      const beforeHash = await hashFile(root, file.path);
      let backupPath: string | null = null;
      if (beforeHash) {
        // Suffix the backup so test runners and linters never collect a backed-up
        // source file (a copied `*.test.ts` inside the workspace would be).
        backupPath = join(txBackupDir, `${file.path}.bak`);
        await mkdir(dirname(backupPath), { recursive: true });
        await copyFile(abs, backupPath);
      }
      if (file.isDelete) {
        await rm(abs, { force: true });
        entries.push({ path: file.path, beforeHash, afterHash: null, backupPath, action: 'delete' });
        written.push(file.path);
        continue;
      }
      const next = computed.get(file.path) ?? '';
      await mkdir(dirname(abs), { recursive: true });
      const tmp = `${abs}.diffwise-${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(tmp, next, 'utf8');
      await rename(tmp, abs);
      entries.push({
        path: file.path,
        beforeHash,
        afterHash: createHash('sha256').update(next).digest('hex'),
        backupPath,
        action: beforeHash ? 'update' : 'create',
      });
      written.push(file.path);
    }
  } catch (err) {
    // Best-effort rollback of whatever was already written.
    const restored = await rollbackEntries(root, entries);
    return {
      applied: false,
      files: restored.reverted,
      backupDir: txBackupDir,
      fuzz,
      errors: [`Apply failed after ${entries.length} file(s): ${(err as Error).message}`],
      entries,
    };
  }

  const journal: TransactionJournal = {
    id: txId,
    reviewId: options.reviewId,
    findingId: options.findingId,
    solutionId: options.solutionId,
    createdAt: new Date().toISOString(),
    status: 'applied',
    entries,
  };
  const journalPath = join(root, '.diffwise', 'transactions', `${txId}.json`);
  await mkdir(dirname(journalPath), { recursive: true });
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');

  return { applied: true, files: written, backupDir: txBackupDir, journalPath, fuzz, errors: [], entries };
}

async function rollbackEntries(root: string, entries: TransactionEntry[]): Promise<{ reverted: string[]; errors: string[] }> {
  const reverted: string[] = [];
  const errors: string[] = [];
  for (const entry of [...entries].reverse()) {
    const abs = resolveInside(root, entry.path);
    if (!abs) { errors.push(`Unsafe path: ${entry.path}`); continue; }
    try {
      if (entry.backupPath) {
        await copyFile(entry.backupPath, abs);
        reverted.push(entry.path);
      } else if (entry.action === 'create') {
        await rm(abs, { force: true });
        reverted.push(entry.path);
      }
    } catch (err) {
      errors.push(`${entry.path}: ${(err as Error).message}`);
    }
  }
  return { reverted, errors };
}

/** Roll back a previously applied fix from its journal. */
export async function rollbackFix(root: string, journalPath: string): Promise<{ reverted: string[]; errors: string[] }> {
  const abs = resolveInside(root, journalPath);
  if (!abs) return { reverted: [], errors: [`Unsafe journal path: ${journalPath}`] };
  let journal: TransactionJournal;
  try {
    journal = JSON.parse(await readFile(abs, 'utf8')) as TransactionJournal;
  } catch (err) {
    return { reverted: [], errors: [`Could not read journal: ${(err as Error).message}`] };
  }
  if (journal.status === 'rolled-back') return { reverted: [], errors: ['This fix was already rolled back.'] };
  const result = await rollbackEntries(root, journal.entries);
  journal.status = 'rolled-back';
  await writeFile(abs, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  return result;
}

export async function listJournals(root: string): Promise<TransactionJournal[]> {
  const dir = join(root, '.diffwise', 'transactions');
  try {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    const out: TransactionJournal[] = [];
    for (const file of files) {
      try {
        out.push(JSON.parse(await readFile(join(dir, file), 'utf8')) as TransactionJournal);
      } catch {
        // Skip unreadable journals; they are reported by the fix list command.
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}
