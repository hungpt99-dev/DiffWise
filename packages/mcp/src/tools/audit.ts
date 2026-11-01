/**
 * MCP audit trail.
 *
 * Every tool invocation is appended to `.diffwise/mcp-audit.jsonl` with the tool
 * name, a hash of the arguments (never the arguments themselves, which may
 * contain paths or code), the outcome and the duration. An agent-driven review
 * must be reconstructable after the fact.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface AuditEntry {
  at: string;
  tool: string;
  /** sha256 of the serialised arguments, truncated. Arguments are not logged. */
  argsHash: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** Reviewer or agent identity, when the client supplies one. */
  actor?: string;
}

export function hashArgs(args: unknown): string {
  let serialised = '';
  try {
    serialised = JSON.stringify(args ?? {});
  } catch {
    serialised = String(args);
  }
  return createHash('sha256').update(serialised).digest('hex').slice(0, 16);
}

export class AuditLog {
  private readonly dir: string;
  private readonly file: string;

  constructor(root: string) {
    this.dir = join(root, '.diffwise');
    this.file = join(this.dir, 'mcp-audit.jsonl');
  }

  async append(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      // An audit failure must never break a tool call, but it must be visible.
      process.stderr.write(`diffwise-mcp: audit write failed: ${(err as Error).message}\n`);
    }
  }
}

/** Wrap a tool handler so every call is timed, audited and cannot leak a stack. */
export function withAudit<T>(
  audit: AuditLog,
  tool: string,
  handler: (args: T) => Promise<unknown>,
): (args: T) => Promise<unknown> {
  return async (args: T) => {
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      await audit.append({
        at: new Date(startedAt).toISOString(),
        tool,
        argsHash: hashArgs(args),
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      await audit.append({
        at: new Date(startedAt).toISOString(),
        tool,
        argsHash: hashArgs(args),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: (err as Error).message,
      });
      throw err;
    }
  };
}
