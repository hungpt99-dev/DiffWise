import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, AppliedFix, ReviewReport } from '../types';
import { parseReport } from '../report/schema';

export interface ReviewIndexEntry {
  id: string;
  createdAt: string;
  targetLabel: string;
  branch: string;
  riskLevel: string;
  riskScore: number;
  changedFiles: number;
  findings: number;
  completeness: ReviewReport['summary']['completeness'];
  aiUsed: boolean;
}

export interface ReviewStore {
  saveReport(report: ReviewReport): Promise<void>;
  loadReport(id: string): Promise<ReviewReport | null>;
  listReviews(limit?: number): Promise<ReviewIndexEntry[]>;
  deleteReport(id: string): Promise<void>;
  appendAgentEvent(event: AgentEvent): Promise<void>;
  readAgentEvents(): Promise<AgentEvent[]>;
  recordAppliedFix(fix: AppliedFix): Promise<void>;
}

/** File-system store. One JSON report per review plus an append-only agent log. */
export class JsonReviewStore implements ReviewStore {
  constructor(private readonly dir: string) {}

  private reviewsDir(): string { return join(this.dir, 'reviews'); }
  private indexPath(): string { return join(this.reviewsDir(), 'index.json'); }
  private agentPath(): string { return join(this.dir, 'agent-events.jsonl'); }

  async saveReport(report: ReviewReport): Promise<void> {
    await mkdir(this.reviewsDir(), { recursive: true });
    await writeFile(join(this.reviewsDir(), `${report.id}.json`), JSON.stringify(report, null, 2), 'utf8');
    const index = await this.readIndex();
    const entry: ReviewIndexEntry = {
      id: report.id,
      createdAt: report.createdAt,
      targetLabel: report.target.label,
      branch: report.repository.branch,
      riskLevel: report.risk.level,
      riskScore: report.risk.score,
      changedFiles: report.changes.length,
      findings: report.findings.length,
      completeness: report.summary.completeness,
      aiUsed: report.summary.aiUsed,
    };
    const next = [entry, ...index.filter((e) => e.id !== report.id)].slice(0, 100);
    await writeFile(this.indexPath(), JSON.stringify(next, null, 2), 'utf8');
  }

  async loadReport(id: string): Promise<ReviewReport | null> {
    try {
      const raw = await readFile(join(this.reviewsDir(), `${id}.json`), 'utf8');
      return parseReport(raw);
    } catch {
      return null;
    }
  }

  async listReviews(limit = 30): Promise<ReviewIndexEntry[]> {
    const index = await this.readIndex();
    return index.slice(0, limit);
  }

  async deleteReport(id: string): Promise<void> {
    await unlink(join(this.reviewsDir(), `${id}.json`)).catch(() => undefined);
    const index = await this.readIndex();
    await writeFile(this.indexPath(), JSON.stringify(index.filter((e) => e.id !== id), null, 2), 'utf8');
  }

  async appendAgentEvent(event: AgentEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const existing = await readFile(this.agentPath(), 'utf8').catch(() => '');
    await writeFile(this.agentPath(), `${existing}${JSON.stringify(event)}\n`, 'utf8');
  }

  async readAgentEvents(): Promise<AgentEvent[]> {
    try {
      const raw = await readFile(this.agentPath(), 'utf8');
      return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentEvent).slice(-500);
    } catch {
      return [];
    }
  }

  async recordAppliedFix(fix: AppliedFix): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, 'applied-fixes.jsonl');
    const existing = await readFile(path, 'utf8').catch(() => '');
    await writeFile(path, `${existing}${JSON.stringify(fix)}\n`, 'utf8');
  }

  private async readIndex(): Promise<ReviewIndexEntry[]> {
    try {
      const raw = await readFile(this.indexPath(), 'utf8');
      return JSON.parse(raw) as ReviewIndexEntry[];
    } catch {
      return [];
    }
  }
}

interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
}

/**
 * SQLite-backed store used when the runtime exposes `node:sqlite` (Node >= 22.5).
 * The full report is still written as JSON so exports and bug reports stay readable.
 */
export class SqliteReviewStore extends JsonReviewStore {
  private db: SqliteLike | null = null;

  constructor(dir: string) {
    super(dir);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteLike };
      this.db = new sqlite.DatabaseSync(join(dir, 'diffwise.db'));
      this.db.exec(`CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL,
        risk_level TEXT, risk_score INTEGER, changed_files INTEGER, findings INTEGER
      )`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL
      )`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS applied_fixes (
        id TEXT PRIMARY KEY, review_id TEXT NOT NULL, applied_at TEXT NOT NULL, payload TEXT NOT NULL
      )`);
    } catch {
      this.db = null;
    }
  }

  override async saveReport(report: ReviewReport): Promise<void> {
    await super.saveReport(report);
    this.db?.prepare(
      `INSERT INTO reviews (id, created_at, payload, risk_level, risk_score, changed_files, findings)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
    ).run(report.id, report.createdAt, JSON.stringify(report), report.risk.level, report.risk.score, report.changes.length, report.findings.length);
  }

  override async appendAgentEvent(event: AgentEvent): Promise<void> {
    await super.appendAgentEvent(event);
    this.db?.prepare(
      'INSERT OR REPLACE INTO agent_events (id, type, created_at, payload) VALUES (?, ?, ?, ?)',
    ).run(event.id, event.type, event.createdAt, JSON.stringify(event));
  }

  override async recordAppliedFix(fix: AppliedFix): Promise<void> {
    await super.recordAppliedFix(fix);
    this.db?.prepare(
      'INSERT OR REPLACE INTO applied_fixes (id, review_id, applied_at, payload) VALUES (?, ?, ?, ?)',
    ).run(fix.id, fix.reviewId, fix.appliedAt, JSON.stringify(fix));
  }

  get sqliteAvailable(): boolean { return this.db !== null; }
}

export async function openStore(root: string, dirName = '.diffwise'): Promise<ReviewStore> {
  const dir = join(root, dirName);
  await mkdir(dir, { recursive: true });
  return new SqliteReviewStore(dir);
}

export async function listReviewFiles(root: string, dirName = '.diffwise'): Promise<string[]> {
  try {
    return (await readdir(join(root, dirName, 'reviews'))).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}
