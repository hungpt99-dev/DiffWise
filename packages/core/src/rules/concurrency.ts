import type { CandidateFinding, Rule } from './types';
import { draftFinding } from './types';
import { addedLines, codeEvidence, diffEvidence, functionBodyFor, linesOf } from './util';
import { isTestFile } from '../analysis/languages';

const READ_RE = /\b(findOne|findUnique|findById|findFirst|select|getById|load|fetchOne|first)\s*\(/;
const WRITE_RE = /\b(save|update|updateOne|updateMany|increment|decrement|setBalance|write|commit)\s*\(/;
const TX_RE = /\b(transaction|withTransaction|BEGIN|FOR\s+UPDATE|SELECT\s+.*\s+FOR\s+UPDATE|lock|mutex|version)\b/i;

/**
 * Read-modify-write on shared state without a lock, transaction or version
 * guard. Reported as a risk: whether it races depends on traffic, but the code
 * contains no mechanism that would prevent it.
 */
function readModifyWrite(): Rule {
  return {
    id: 'concurrency.read-modify-write',
    category: 'concurrency',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary || isTestFile(change.path)) continue;
        for (const added of addedLines(change)) {
          if (!WRITE_RE.test(added.text)) continue;
          const fn = functionBodyFor(change.path, content, added.line);
          if (fn.body.length > 8000) continue;
          if (!READ_RE.test(fn.body) || TX_RE.test(fn.body)) continue;
          if (!/balance|amount|count|stock|inventory|credit|debit|quota|sequence/i.test(fn.body)) continue;
          out.push(draftFinding({
            ruleId: 'concurrency.read-modify-write',
            title: `Unserialised read-modify-write in ${fn.name}`,
            description: `\`${fn.name}\` reads a value, computes a new value in application code and writes it back (lines ${fn.start}-${fn.end}). No transaction, row lock, atomic update or version check appears in this function.`,
            severity: 'high',
            category: 'concurrency',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'Write inside a read-modify-write sequence.'),
              codeEvidence(change.path, fn.start, content, `Analysed function \`${fn.name}\` (${fn.start}-${fn.end}).`, 2),
            ],
            whyItMatters: 'Two concurrent requests can both read the same starting value and both write a result derived from it, so one update is silently lost. The window is the time between the read and the write, which includes every `await`.',
            consequences: ['Lost updates under concurrent traffic', 'Balances or counters that drift from the ledger', 'Reconciliation failures that are hard to reproduce'],
            reproduction: `Send two requests for the same record concurrently: both read value V, both write V+d, and the result is V+d instead of V+2d.`,
            recommendation: 'Make the mutation atomic: `UPDATE ... SET balance = balance + $1 ... RETURNING`, a `SELECT ... FOR UPDATE` inside a transaction, or an optimistic version column with a retry on conflict.',
            tags: ['race-condition', 'lost-update'],
          }));
        }
      }
      return out;
    },
  };
}

/** Multiple writes without a transaction boundary. */
function multipleWritesWithoutTransaction(): Rule {
  return {
    id: 'concurrency.multi-write-no-transaction',
    category: 'concurrency',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary || isTestFile(change.path)) continue;
        for (const added of addedLines(change)) {
          if (!WRITE_RE.test(added.text)) continue;
          const fn = functionBodyFor(change.path, content, added.line);
          if (TX_RE.test(fn.body)) continue;
          const writes = fn.body.match(/\b(?:save|update|updateOne|insert|insertOne|create|delete|deleteOne|deleteMany)\s*\(/g) ?? [];
          if (writes.length < 2) continue;
          out.push(draftFinding({
            ruleId: 'concurrency.multi-write-no-transaction',
            title: `${writes.length} related writes in ${fn.name} without a transaction`,
            description: `\`${fn.name}\` performs ${writes.length} mutations but no transaction, unit-of-work or compensating action is visible in the function.`,
            severity: 'high',
            category: 'concurrency',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: fn.start, end: fn.end },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'One of several mutations in the same function.'),
              codeEvidence(change.path, fn.start, content, `Function body containing ${writes.length} writes.`, 3),
            ],
            whyItMatters: 'Without an atomic boundary, a failure between the first and last write leaves persisted state that no code path expects.',
            consequences: ['Partial records after a mid-function failure', 'Ledger and balance tables that disagree', 'Duplicate side effects on retry'],
            recommendation: 'Wrap the writes in one database transaction (or a saga with explicit compensation) and make the operation idempotent using a request key.',
            tags: ['transaction', 'consistency'],
          }));
        }
      }
      return out;
    },
  };
}

/** Check-then-act on shared state. */
function checkThenAct(): Rule {
  return {
    id: 'concurrency.check-then-act',
    category: 'concurrency',
    run(ctx) {
      const out: CandidateFinding[] = [];
      const pattern = /if\s*\(\s*!?\s*([A-Za-z_$][\w$]*)\.(has|get)\s*\(([^)]*)\)/;
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          const m = pattern.exec(added.text);
          if (!m) continue;
          const fn = functionBodyFor(change.path, content, added.line);
          if (/\b(lock|mutex|atomic|transaction|compareAndSet|updateOrCreate|upsert)\b/i.test(fn.body)) continue;
          out.push(draftFinding({
            ruleId: 'concurrency.check-then-act',
            title: `Unprotected check-then-act on \`${m[1]}\``,
            description: `The code inspects \`${m[1]}\` and then acts on that observation without an atomic primitive. Between the check and the action, another task can change the map or collection.`,
            severity: 'medium',
            category: 'concurrency',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'Non-atomic existence check.'),
              codeEvidence(change.path, added.line, content, 'Check-then-act in context.'),
            ],
            whyItMatters: 'Node.js is single-threaded per event loop but interleaves at `await`; a second worker or process makes the window larger. The check does not reserve the key.',
            consequences: ['Duplicate inserts or double processing', 'Thundering-herd re-computation'],
            recommendation: 'Use an atomic primitive: `Map` with synchronous check-and-set, `upsert` with a unique constraint, or a distributed lock for cross-process coordination.',
            tags: ['race-condition', 'idempotency'],
          }));
        }
      }
      return out;
    },
  };
}

/** Timers and listeners created on a changed line without cleanup. */
function timerCleanup(): Rule {
  return {
    id: 'concurrency.timer-cleanup',
    category: 'resources',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        const file = linesOf(content).join('\n');
        for (const added of addedLines(change)) {
          if (!/\bsetInterval\s*\(/.test(added.text)) continue;
          if (/\bclearInterval\s*\(/.test(file)) continue;
          out.push(draftFinding({
            ruleId: 'concurrency.timer-cleanup',
            title: 'Interval started without a matching clear',
            description: '`setInterval` is created in this file and no `clearInterval` call exists anywhere in it, so the timer survives module disposal, tests and hot reloads.',
            severity: 'medium',
            category: 'resources',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'Interval creation.')],
            whyItMatters: 'Leaked intervals keep the event loop alive, duplicate work after every reload, and prevent clean shutdown of the extension host or process.',
            consequences: ['Duplicate background work', 'Processes that never exit', 'Test suites that hang'],
            recommendation: 'Store the handle and clear it in a `dispose`/`finally`/`SIGTERM` path; prefer a cancellable scheduler tied to the owning object.',
            tags: ['leak', 'lifecycle'],
          }));
        }
      }
      return out;
    },
  };
}

export const concurrencyRules: Rule[] = [
  readModifyWrite(),
  multipleWritesWithoutTransaction(),
  checkThenAct(),
  timerCleanup(),
];
