import type { CandidateFinding, Rule } from './types';
import { draftFinding } from './types';
import { addedLines, codeEvidence, diffEvidence, enclosingFunction, functionBodyFor } from './util';
import { isMigrationFile, isTestFile } from '../analysis/languages';

/** UPDATE / DELETE without a WHERE clause. */
function destructiveStatement(): Rule {
  return {
    id: 'database.unbounded-mutation',
    category: 'database',
    run(ctx) {
      const out: CandidateFinding[] = [];
      const re = /\b(UPDATE\s+["`\w.]+|DELETE\s+FROM\s+["`\w.]+)([^;'"`]*)/i;
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        const fileLines = content.split(/\r?\n/);
        for (const added of addedLines(change)) {
          const trimmed = added.text.trim();
          if (/^(\/\/|\*|\/\*|#|--)/.test(trimmed)) continue;
          if (!/['"`]/.test(added.text)) continue; // SQL lives in a string literal
          const m = re.exec(added.text);
          if (!m) continue;
          // Look ahead in the same statement for a WHERE clause (multi-line SQL).
          const statement = fileLines.slice(added.line - 1, added.line + 6).join('\n').split(';')[0] ?? '';
          if (/\bWHERE\b/i.test(statement)) continue;
          out.push(draftFinding({
            ruleId: 'database.unbounded-mutation',
            title: 'Statement mutates every row in the table',
            description: `\`${m[1]?.trim()}\` has no \`WHERE\` clause, so the statement applies to the whole table.`,
            severity: 'critical',
            category: 'database',
            kind: 'problem',
            confidence: 'verified',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'Mutation without a row filter.')],
            whyItMatters: 'A single accidental invocation rewrites or removes production data; there is no per-row guard to stop it.',
            consequences: ['Total table data loss', 'Irreversible state change in production'],
            recommendation: 'Add a `WHERE` predicate on the primary key or a verified filter, and run the statement inside a transaction with a `RETURNING`/row-count check.',
            tags: ['data-loss'],
          }));
        }
      }
      return out;
    },
  };
}

/** Destructive schema change in a migration. */
function destructiveMigration(): Rule {
  return {
    id: 'database.destructive-migration',
    category: 'database',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        if (!isMigrationFile(change.path)) continue;
        const content = ctx.contents.get(change.path);
        if (!content) continue;
        for (const added of addedLines(change)) {
          if (!/\b(DROP\s+(TABLE|COLUMN|CONSTRAINT)|TRUNCATE|ALTER\s+COLUMN\s+\w+\s+TYPE|RENAME\s+COLUMN)\b/i.test(added.text)) continue;
          out.push(draftFinding({
            ruleId: 'database.destructive-migration',
            title: 'Destructive schema change in migration',
            description: `The migration executes \`${added.text.trim()}\`. Existing rows and any deploy that still runs the previous schema version are affected.`,
            severity: 'high',
            category: 'database',
            kind: 'problem',
            confidence: 'high',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'Destructive DDL statement.')],
            whyItMatters: 'Migrations run before or during a rolling deploy; destructive DDL breaks old instances that are still serving traffic and cannot be undone by rolling back the application.',
            consequences: ['Data loss', 'Failed requests during the deploy window', 'Irreversible rollback'],
            recommendation: 'Use expand/contract: add the new column, dual-write, backfill, switch reads, then drop in a later release after a backup.',
            tags: ['migration', 'rollout'],
          }));
        }
      }
      return out;
    },
  };
}

/** Migration without a down/rollback path. */
function missingRollback(): Rule {
  return {
    id: 'database.missing-rollback',
    category: 'database',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        if (change.status !== 'added' || !isMigrationFile(change.path)) continue;
        const content = ctx.contents.get(change.path);
        if (!content) continue;
        const hasDdl = /\b(CREATE|ALTER|DROP|INSERT|UPDATE)\b/i.test(content);
        const hasDown = /\b(down|rollback|revert)\b/i.test(content);
        if (!hasDdl || hasDown) continue;
        out.push(draftFinding({
          ruleId: 'database.missing-rollback',
          title: 'New migration has no rollback path',
          description: 'The migration defines a forward step but no `down`/rollback step, so reverting the release leaves the schema ahead of the code.',
          severity: 'medium',
          category: 'database',
          kind: 'recommendation',
          confidence: 'medium',
          file: change.path,
          range: { start: 1, end: Math.min(5, content.split('\n').length) },
          evidence: [codeEvidence(change.path, 1, content, 'Migration entry point.')],
          whyItMatters: 'Rollback is the only fast recovery path when a deploy fails after the schema change has been applied.',
          consequences: ['Schema/code mismatch after rollback', 'Manual database surgery during an incident'],
          recommendation: 'Add an explicit `down` migration, or document why the change is intentionally irreversible and how to recover from a backup.',
          tags: ['migration'],
        }));
      }
      return out;
    },
  };
}

/** Query inside a loop (N+1). */
function nPlusOne(): Rule {
  return {
    id: 'database.n-plus-one',
    category: 'database',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary || isTestFile(change.path)) continue;
        for (const added of addedLines(change)) {
          if (!/\b(for|while)\s*\(|\.(forEach|map)\s*\(\s*(async\s*)?\(/.test(added.text)) continue;
          const fn = enclosingFunction(change.path, content, added.line);
          const body = functionBodyFor(change.path, content, added.line);
          // Only a database-ish call counts. A plain `await fetch(url)` inside a
          // loop is an HTTP call, not an N+1 query, and reporting it as one was a
          // real false positive caught by the evaluation corpus.
          const DB_CALL = /\bawait\s+[^;\n]*(?:(?:repository|repo|db|database|client|prisma|knex|sequelize|entityManager|em|tx|conn|connection)\.\w+|\.(?:query|findOne|findMany|findUnique|findById|findAll|select|load|getOne)\s*\()/i;
          if (!DB_CALL.test(body.body)) continue;
          out.push(draftFinding({
            ruleId: 'database.n-plus-one',
            title: `Query awaited inside a loop${fn ? ` in \`${fn.name}\`` : ''}`,
            description: 'Each loop iteration performs its own database round-trip instead of fetching the set once.',
            severity: 'medium',
            category: 'performance',
            kind: 'problem',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'Loop that contains a database call.'),
              codeEvidence(change.path, added.line, content, 'Loop and query in context.'),
            ],
            whyItMatters: 'Latency grows linearly with the number of rows and the connection pool becomes the bottleneck under load.',
            consequences: ['p95 latency proportional to row count', 'Connection-pool exhaustion', 'Timeout cascades'],
            recommendation: 'Fetch the related rows in one query with `WHERE id IN (...)`, or use a join/batch loader, then map in memory.',
            tags: ['N+1', 'performance'],
          }));
        }
      }
      return out;
    },
  };
}

/** SELECT * without LIMIT. */
function unboundedSelect(): Rule {
  return {
    id: 'database.unbounded-select',
    category: 'performance',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          if (!/\bSELECT\s+\*/i.test(added.text)) continue;
          if (/\bLIMIT\b|\bFETCH\s+FIRST\b|\btop\s+\d+/i.test(added.text)) continue;
          out.push(draftFinding({
            ruleId: 'database.unbounded-select',
            title: 'Unbounded `SELECT *` added',
            description: 'The new query selects every column of every matching row with no `LIMIT`.',
            severity: 'low',
            category: 'performance',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'Unbounded select.')],
            whyItMatters: 'Result size is controlled by data growth, not by the code, so a table that is small today can exhaust memory later.',
            consequences: ['Memory spikes on large tables', 'Slow API responses once data grows'],
            recommendation: 'Select the columns you use and add an explicit `LIMIT` (or pagination) on any query reachable from a request.',
            tags: ['performance'],
          }));
        }
      }
      return out;
    },
  };
}

export const databaseRules: Rule[] = [
  destructiveStatement(),
  destructiveMigration(),
  missingRollback(),
  nPlusOne(),
  unboundedSelect(),
];
