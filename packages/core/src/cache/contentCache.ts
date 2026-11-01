/**
 * Content-addressed cache.
 *
 * The identity of a cached value is a hash of **everything that can change it**,
 * so a key can never outlive its inputs:
 *
 *   provider + model + prompt version + exact prompt bytes → same key
 *
 * That is what makes caching a model response safe: if any part of the context
 * changes, the prompt changes, the hash changes, and the old entry is simply
 * never read again. There is no invalidation heuristic to get wrong.
 *
 * Storage is one JSON file per entry under a directory the caller owns
 * (`.diffwise/cache` in practice). Writes are atomic (temp file + rename), the
 * cache is bounded by entry count and bytes, entries expire, and pruning is
 * explicit — a cache that grows without limit is a bug, not a feature.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CacheOptions {
  /** Directory for on-disk entries. Omit for an in-memory-only cache. */
  dir?: string;
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  /** Injectable clock, for tests. */
  now?(): number;
}

export interface CacheRecord<T = unknown> {
  key: string;
  createdAt: number;
  accessedAt: number;
  bytes: number;
  meta?: Record<string, string | number | boolean>;
  value: T;
}

export interface CacheStats {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  expired: number;
  entries: number;
  bytes: number;
}

const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Stable key for a tuple of inputs. Order matters; null/undefined are distinct. */
export function contentKey(...parts: Array<string | number | boolean | undefined | null>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part === undefined ? '\u0000u' : part === null ? '\u0000n' : String(part));
    hash.update('\u0001');
  }
  return hash.digest('hex').slice(0, 32);
}

export class ContentCache {
  private readonly dir?: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly memory = new Map<string, CacheRecord>();
  private counters = { hits: 0, misses: 0, writes: 0, evictions: 0, expired: 0 };


  constructor(opts: CacheOptions = {}) {
    if (opts.dir) this.dir = opts.dir;
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxBytes = Math.max(1024, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    this.ttlMs = Math.max(0, opts.ttlMs ?? DEFAULT_TTL_MS);
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  async get<T = unknown>(key: string): Promise<CacheRecord<T> | undefined> {
    if (!this.isKey(key) || !this.enabled) return undefined;
    const cached = this.memory.get(key);
    if (cached) {
      if (this.isExpired(cached)) {
        this.memory.delete(key);
        this.counters.expired += 1;
        this.counters.misses += 1;
        return undefined;
      }
      cached.accessedAt = this.now();
      this.counters.hits += 1;
      return cached as CacheRecord<T>;
    }
    if (!this.dir) {
      this.counters.misses += 1;
      return undefined;
    }
    try {
      const raw = await readFile(join(this.dir, `${key}.json`), 'utf8');
      const record = JSON.parse(raw) as CacheRecord<T>;
      if (this.isExpired(record)) {
        await rm(join(this.dir, `${key}.json`), { force: true });
        this.counters.expired += 1;
        this.counters.misses += 1;
        return undefined;
      }
      record.accessedAt = this.now();
      this.memory.set(key, record as CacheRecord);
      this.counters.hits += 1;
      return record;
    } catch {
      this.counters.misses += 1;
      return undefined;
    }
  }

  async set<T>(key: string, value: T, meta?: CacheRecord<T>['meta']): Promise<void> {
    if (!this.isKey(key) || !this.enabled) return;
    const serialised = JSON.stringify({ key, value, meta });
    const bytes = Buffer.byteLength(serialised, 'utf8');
    const record: CacheRecord<T> = { key, createdAt: this.now(), accessedAt: this.now(), bytes, value, ...(meta ? { meta } : {}) };
    this.memory.set(key, record as CacheRecord);
    this.counters.writes += 1;
    if (!this.dir) {
      this.evictMemory();
      return;
    }
    try {
      await mkdir(this.dir, { recursive: true });
      const target = join(this.dir, `${key}.json`);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(record), 'utf8');
      await rename(temp, target);
    } catch {
      // A cache that cannot write must not fail the review it was meant to
      // accelerate. The in-memory copy still serves this process.
    }
    await this.evictDisk();
  }

  async delete(key: string): Promise<void> {
    this.memory.delete(key);
    if (!this.dir || !this.isKey(key)) return;
    await rm(join(this.dir, `${key}.json`), { force: true });
  }

  /** Remove expired entries and enforce the caps. Returns what was freed. */
  async prune(): Promise<{ removed: number; bytesFreed: number }> {
    let removed = 0;
    let bytesFreed = 0;
    for (const [key, record] of [...this.memory]) {
      if (this.isExpired(record)) {
        this.memory.delete(key);
        removed += 1;
        bytesFreed += record.bytes;
        this.counters.expired += 1;
      }
    }
    const files = await this.listDisk();
    for (const file of files) {
      if (this.isExpired({ createdAt: file.mtime } as CacheRecord)) {
        await rm(join(this.dir!, file.name), { force: true });
        removed += 1;
        bytesFreed += file.bytes;
        this.counters.expired += 1;
      }
    }
    await this.evictDisk();
    return { removed, bytesFreed };
  }

  async stats(): Promise<CacheStats> {
    const files = await this.listDisk();
    return {
      ...this.counters,
      entries: this.dir ? files.length : this.memory.size,
      bytes: this.dir ? files.reduce((sum, f) => sum + f.bytes, 0) : [...this.memory.values()].reduce((sum, r) => sum + r.bytes, 0),
    };
  }

  /** Synchronous counters for a request path that cannot await. */
  snapshot(): { hits: number; misses: number; writes: number } {
    return { hits: this.counters.hits, misses: this.counters.misses, writes: this.counters.writes };
  }

  private isKey(key: string): boolean {
    return KEY_RE.test(key);
  }

  private isExpired(record: Pick<CacheRecord, 'createdAt'>): boolean {
    return this.ttlMs > 0 && this.now() - record.createdAt > this.ttlMs;
  }

  private evictMemory(): void {
    if (this.memory.size <= this.maxEntries) return;
    const ordered = [...this.memory.values()].sort((a, b) => a.accessedAt - b.accessedAt);
    while (this.memory.size > this.maxEntries && ordered.length) {
      const victim = ordered.shift()!;
      this.memory.delete(victim.key);
      this.counters.evictions += 1;
    }
  }

  private async listDisk(): Promise<Array<{ name: string; bytes: number; mtime: number }>> {
    if (!this.dir) return [];
    try {
      const names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
      const out: Array<{ name: string; bytes: number; mtime: number }> = [];
      for (const name of names) {
        try {
          const info = await stat(join(this.dir, name));
          out.push({ name, bytes: info.size, mtime: info.mtimeMs });
        } catch {
          // Entry vanished between readdir and stat: ignore.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async evictDisk(): Promise<void> {
    if (!this.dir) return;
    const files = await this.listDisk();
    let total = files.reduce((sum, f) => sum + f.bytes, 0);
    if (files.length <= this.maxEntries && total <= this.maxBytes) return;
    const ordered = files.sort((a, b) => a.mtime - b.mtime);
    for (const file of ordered) {
      if (files.length <= this.maxEntries && total <= this.maxBytes) break;
      if (this.memory.has(file.name.replace(/\.json$/, ''))) continue; // keep this run's entries
      await rm(join(this.dir, file.name), { force: true });
      total -= file.bytes;
      this.counters.evictions += 1;
    }
  }
}
