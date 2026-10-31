import { describe, expect, it } from 'vitest';
import type { ChangedSymbol, RuleContext, TestAnalysis } from '../src/index';
import { DEFAULT_ANALYSIS_SETTINGS } from '../src/types';
import { makeUntracked } from '../src/git/diff';
import { securityRules } from '../src/rules/security';
import { concurrencyRules } from '../src/rules/concurrency';
import { databaseRules } from '../src/rules/database';
import { qualityRules } from '../src/rules/quality';
import { apiRules } from '../src/rules/api';

const emptyTests: TestAnalysis = { files: [], uncoveredChanges: [], uncoveredSymbols: [], deletedTests: [], suggestions: [] };

function makeContext(path: string, content: string, extra: Partial<RuleContext> = {}): RuleContext {
  const change = makeUntracked(path, content);
  return {
    changes: [change],
    contents: new Map([[path, content]]),
    oldContents: new Map([[path, null]]),
    repoFiles: new Map([[path, content]]),
    symbols: [],
    docs: [],
    docTexts: new Map(),
    tests: emptyTests,
    graph: {
      edges: [], importers: {}, changedFiles: [path], directlyImpacted: [], indirectlyImpacted: [],
      impactDepth: {}, cycles: [], newCoupling: [], removedCoupling: [], boundaryChanges: [],
      modules: [], fileCount: 1, edgeCount: 0,
    },
    settings: DEFAULT_ANALYSIS_SETTINGS,
    now: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  };
}

const run = (rules: typeof securityRules, ctx: RuleContext): string[] =>
  rules.flatMap((r) => r.run(ctx)).map((f) => f.ruleId);

describe('security rules', () => {
  it('flags a hardcoded credential', () => {
    const ctx = makeContext('src/config.ts', 'export const apiKey = "sk_live_abcdef1234567890";\n');
    expect(run(securityRules, ctx)).toContain('security.hardcoded-secret');
  });

  it('does not flag environment lookups or placeholders', () => {
    const ctx = makeContext('src/config.ts', 'export const apiKey = process.env.API_KEY!;\nexport const other = "changeme-placeholder";\n');
    expect(run(securityRules, ctx)).not.toContain('security.hardcoded-secret');
  });

  it('flags interpolated SQL through a query call', () => {
    const content = 'async function find(id: string) {\n  return db.query(`SELECT * FROM users WHERE id = ${id}`);\n}\n';
    expect(run(securityRules, makeContext('src/db.ts', content))).toContain('security.sql-injection');
  });

  it('does not flag parameterised SQL', () => {
    const content = 'async function find(id: string) {\n  return db.query("SELECT * FROM users WHERE id = $1", [id]);\n}\n';
    expect(run(securityRules, makeContext('src/db.ts', content))).not.toContain('security.sql-injection');
  });

  it('flags a shell command built from a variable', () => {
    const content = 'import { exec } from "node:child_process";\nexport function run(file: string) {\n  exec(`rm -rf ${file}`);\n}\n';
    expect(run(securityRules, makeContext('src/cleanup.ts', content))).toContain('security.command-injection');
  });

  it('flags Math.random used for a token', () => {
    const ctx = makeContext('src/token.ts', 'export const refundToken = Math.random().toString(36).slice(2);\n');
    expect(run(securityRules, ctx)).toContain('security.insecure-random');
  });

  it('ignores secrets mentioned only in a comment', () => {
    const ctx = makeContext('src/config.ts', '// apiKey = "sk_live_abcdef1234567890" was removed\nexport const ok = 1;\n');
    expect(run(securityRules, ctx)).not.toContain('security.hardcoded-secret');
  });
});

describe('database and concurrency rules', () => {
  it('flags an UPDATE without WHERE', () => {
    const ctx = makeContext('src/repo.ts', 'export async function reset() {\n  await db.query("UPDATE accounts SET balance = 0");\n}\n');
    expect(run(databaseRules, ctx)).toContain('database.unbounded-mutation');
  });

  it('does not flag an UPDATE with WHERE on a later line', () => {
    const ctx = makeContext('src/repo.ts', 'export async function reset(id: string) {\n  await db.query("UPDATE accounts SET balance = 0\\n    WHERE id = $1", [id]);\n}\n');
    expect(run(databaseRules, ctx)).not.toContain('database.unbounded-mutation');
  });

  it('flags a read-modify-write on a balance without a transaction', () => {
    const content = `export async function credit(id: string, delta: number) {
  const account = await repo.findById(id);
  account.balance += delta;
  await repo.update(account);
}
`;
    expect(run(concurrencyRules, makeContext('src/accounts.ts', content))).toContain('concurrency.read-modify-write');
  });

  it('does not flag the same code when it runs in a transaction', () => {
    const content = `export async function credit(id: string, delta: number) {
  return repo.withTransaction(async (tx) => {
    const account = await tx.findById(id);
    account.balance += delta;
    await tx.update(account);
  });
}
`;
    expect(run(concurrencyRules, makeContext('src/accounts.ts', content))).not.toContain('concurrency.read-modify-write');
  });

  it('flags a new migration without a rollback', () => {
    const ctx = makeContext('migrations/003_x.sql', 'CREATE TABLE things (id INT);\n');
    expect(run(databaseRules, ctx)).toContain('database.missing-rollback');
  });
});

describe('api contract rules', () => {
  it('reports a signature change of a referenced export', () => {
    const sym: ChangedSymbol = {
      id: 'sym-1', name: 'calculateFee', kind: 'method', file: 'src/payments.ts',
      range: { start: 10, end: 14 }, container: 'PaymentService', exported: true,
      change: 'modified', changeRanges: [{ start: 10, end: 10 }],
      signature: 'calculateFee(amount: number, currency: string): number',
      signatureChanged: true, referenceCount: 4,
    };
    const ctx = makeContext('src/payments.ts', 'export class PaymentService {\n  calculateFee(amount: number, currency: string): number {\n    return 0;\n  }\n}\n', {
      symbols: [sym],
      oldContents: new Map([['src/payments.ts', 'export class PaymentService {\n  calculateFee(amount: number): number {\n    return 0;\n  }\n}\n']]),
    });
    const findings = apiRules.flatMap((r) => r.run(ctx));
    expect(findings.map((f) => f.ruleId)).toContain('api.signature-change');
    const f = findings.find((x) => x.ruleId === 'api.signature-change')!;
    expect(f.severity).toBe('high');
    expect(f.description).toContain('calculateFee(amount: number): number');
  });
});

describe('quality rules', () => {
  it('flags an empty catch block', () => {
    const content = 'export async function go() {\n  try {\n    await send();\n  } catch (err) {\n  }\n}\n';
    expect(run(qualityRules, makeContext('src/go.ts', content))).toContain('error-handling.swallowed');
  });

  it('does not flag a catch that rethrows', () => {
    const content = 'export async function go() {\n  try {\n    await send();\n  } catch (err) {\n    throw err;\n  }\n}\n';
    expect(run(qualityRules, makeContext('src/go.ts', content))).not.toContain('error-handling.swallowed');
  });

  it('flags a payment call without an idempotency key', () => {
    const content = 'export async function handler(req: Request) {\n  const receipt = await gateway.refund(req.body.id, req.body.amount);\n  return receipt;\n}\n';
    expect(run(qualityRules, makeContext('src/handler.ts', content))).toContain('reliability.missing-idempotency');
  });

  it('does not flag the declaration of a payment method', () => {
    const content = 'export class Gateway {\n  async refund(id: string, amount: number) {\n    return { id, amount };\n  }\n}\n';
    expect(run(qualityRules, makeContext('src/gateway.ts', content))).not.toContain('reliability.missing-idempotency');
  });

  it('flags a documented environment variable that does not exist', () => {
    const ctx = makeContext('src/policy.ts', 'export const limit = Number(process.env.REFUND_LIMIT ?? 100);\n');
    const ids = run(qualityRules, ctx);
    expect(ids).toContain('configuration.undocumented-env');
    const f = qualityRules.flatMap((r) => r.run(ctx)).find((x) => x.ruleId === 'configuration.undocumented-env')!;
    expect(f.description).toContain('REFUND_LIMIT');
  });
});
