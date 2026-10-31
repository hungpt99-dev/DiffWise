import type { CandidateFinding, Rule } from './types';
import { draftFinding } from './types';
import { addedLines, codeEvidence, diffEvidence, enclosingFunction, functionBodyFor, linesOf } from './util';
import { isTestFile } from '../analysis/languages';

/** Swallowed errors: empty catch blocks, catches that only log in a write path. */
function swallowedErrors(): Rule {
  return {
    id: 'error-handling.swallowed',
    category: 'error-handling',
    run(ctx) {
      const out: CandidateFinding[] = [];
      const emptyCatch = /catch\s*(\([^)]*\))?\s*\{\s*(\/\*[^*]*\*\/|\/\/[^\n]*)?\s*\}/;
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        const lines = linesOf(content);
        for (const added of addedLines(change)) {
          if (!/catch\s*[({]/.test(added.text)) continue;
          const window = lines.slice(added.line - 1, Math.min(lines.length, added.line + 2)).join('\n');
          if (!emptyCatch.test(window)) continue;
          const fn = enclosingFunction(change.path, content, added.line);
          out.push(draftFinding({
            ruleId: 'error-handling.swallowed',
            title: `Error swallowed in ${fn?.name ?? 'changed code'}`,
            description: 'An exception is caught and discarded without logging, rethrowing, or returning a failure result.',
            severity: 'high',
            category: 'error-handling',
            kind: 'problem',
            confidence: 'verified',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'Empty catch block.'),
              codeEvidence(change.path, added.line, content, 'Catch block in context.'),
            ],
            whyItMatters: 'A swallowed error makes the operation look successful while its side effect never happened; callers commit state that the failed step never produced.',
            consequences: ['Silent data loss', 'Retries that never happen', 'Incidents without a stack trace'],
            recommendation: 'Handle the specific error you expect, and rethrow or wrap everything else preserving `cause`. If the failure is intentionally ignorable, log it with enough context to debug.',
            tags: ['silent-failure'],
          }));
        }
      }
      return out;
    },
  };
}

/** `throw "string"` instead of an Error instance. */
function throwString(): Rule {
  return {
    id: 'error-handling.throw-string',
    category: 'error-handling',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          if (!/throw\s+['"`]/.test(added.text)) continue;
          out.push(draftFinding({
            ruleId: 'error-handling.throw-string',
            title: 'String thrown instead of an Error',
            description: '`throw` receives a string literal. The value has no stack trace and cannot carry a `cause` or an error code.',
            severity: 'low',
            category: 'error-handling',
            kind: 'recommendation',
            confidence: 'verified',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'String throw.')],
            whyItMatters: 'Every `catch` block that reads `err.message` or `err.stack` receives `undefined`, which turns a specific failure into an opaque one.',
            consequences: ['Unhelpful production logs', 'Error-mapping layers that cannot classify the failure'],
            recommendation: 'Throw an `Error` subclass with a stable `code` field, and preserve the original error with `{ cause }`.',
            tags: ['error-model'],
          }));
        }
      }
      return out;
    },
  };
}

/** JSON.parse on request/queue data without protection. */
function unguardedParse(): Rule {
  return {
    id: 'error-handling.unguarded-parse',
    category: 'error-handling',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          if (!/JSON\.parse\s*\(/.test(added.text)) continue;
          if (/try\s*\{/.test(added.text)) continue;
          const fn = enclosingFunction(change.path, content, added.line);
          if (!fn) continue;
          const body = linesOf(content).slice(fn.start - 1, fn.end).join('\n');
          if (/try\s*\{/.test(body) && /catch/.test(body)) continue;
          out.push(draftFinding({
            ruleId: 'error-handling.unguarded-parse',
            title: 'JSON parsed without a failure path',
            description: '`JSON.parse` is called in a function with no surrounding `try`/`catch`, so malformed input throws out of the handler.',
            severity: 'medium',
            category: 'error-handling',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'Unprotected JSON.parse.')],
            whyItMatters: 'Parsing throws `SyntaxError` on malformed input; without a guard the whole request fails as a 500 instead of a 400, and queue consumers retry forever.',
            consequences: ['500 responses for client mistakes', 'Poison messages that block a queue partition'],
            recommendation: 'Parse inside a guard and validate the shape with a schema before using it; return a typed validation error.',
            tags: ['input-validation'],
          }));
        }
      }
      return out;
    },
  };
}

/** Resource acquisition without release. */
function resourceLeak(): Rule {
  return {
    id: 'resources.unreleased',
    category: 'resources',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          const acquire = /(createReadStream|createWriteStream|openSync|open\(|getConnection|connect\(|acquire\(|new PoolClient|checkout\()/.exec(added.text);
          if (!acquire) continue;
          const fn = functionBodyFor(change.path, content, added.line);
          if (/\b(finally|release\(|close\(|destroy\(|end\(\))/.test(fn.body)) continue;
          out.push(draftFinding({
            ruleId: 'resources.unreleased',
            title: `Resource acquired in ${fn.name} without a release path`,
            description: `\`${acquire[1]}\` is called but the function contains no \`finally\`, \`close\`, \`release\` or \`destroy\` call.`,
            severity: 'medium',
            category: 'resources',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'Resource acquisition.'),
              codeEvidence(change.path, fn.start, content, `Function \`${fn.name}\` (${fn.start}-${fn.end}).`, 2),
            ],
            whyItMatters: 'File descriptors and pooled connections are finite. A single thrown exception in the middle of the function permanently consumes one.',
            consequences: ['File-descriptor exhaustion', 'Connection-pool starvation after a few errors', 'Processes that stop accepting traffic without crashing'],
            recommendation: 'Use `try/finally` (or `using`) so release runs on every path, and keep the acquisition and release in the same function.',
            tags: ['leak'],
          }));
        }
      }
      return out;
    },
  };
}

/** Blocking synchronous I/O on a request path. */
function syncIo(): Rule {
  return {
    id: 'performance.sync-io',
    category: 'performance',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary || isTestFile(change.path)) continue;
        for (const added of addedLines(change)) {
          const m = /\b(readFileSync|writeFileSync|execSync|readdirSync|statSync)\s*\(/.exec(added.text);
          if (!m) continue;
          out.push(draftFinding({
            ruleId: 'performance.sync-io',
            title: `Synchronous I/O (${m[1]}) added`,
            description: `\`${m[1]}\` blocks the event loop for the duration of the filesystem or process call.`,
            severity: 'medium',
            category: 'performance',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'Synchronous I/O call.')],
            whyItMatters: 'Node.js serves all concurrent requests on one thread; every millisecond blocked here is added to every in-flight request.',
            consequences: ['Latency spikes under concurrent traffic', 'Health-check timeouts during cold disk or large files'],
            recommendation: 'Use the promise API (`fs/promises`) or stream the file; keep synchronous calls for CLI startup and tests.',
            tags: ['blocking'],
          }));
        }
      }
      return out;
    },
  };
}

/** Await sequentially inside a loop. */
function sequentialAwait(): Rule {
  return {
    id: 'performance.sequential-await',
    category: 'performance',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          if (!/\b(for|while)\s*\(/.test(added.text)) continue;
          const fn = functionBodyFor(change.path, content, added.line);
          if (!/\bawait\b/.test(fn.body)) continue;
          if (/\bPromise\.(all|allSettled|race)\b/.test(fn.body)) continue;
          out.push(draftFinding({
            ruleId: 'performance.sequential-await',
            title: `Independent awaits executed sequentially in ${fn.name}`,
            description: 'A loop awaits one operation per iteration; total latency is the sum of every round-trip rather than the slowest one.',
            severity: 'low',
            category: 'performance',
            kind: 'recommendation',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'Loop containing awaits.'),
              codeEvidence(change.path, added.line, content, 'Loop context.'),
            ],
            whyItMatters: 'Sequential I/O multiplies latency by the number of items; with 50 items at 20 ms each, a request takes one second instead of about 20 ms.',
            consequences: ['Latency that grows with data size', 'Request timeouts under load'],
            recommendation: 'Collect the promises and use `Promise.allSettled` (or a bounded-concurrency pool) when the iterations are independent.',
            tags: ['latency'],
          }));
        }
      }
      return out;
    },
  };
}

/** Retry without backoff. */
function retryWithoutBackoff(): Rule {
  return {
    id: 'reliability.retry-no-backoff',
    category: 'reliability',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          if (!/\b(retry|attempt|maxRetries|while\s*\([^)]*attempt)/i.test(added.text)) continue;
          const fn = functionBodyFor(change.path, content, added.line);
          if (!/await|\.catch/.test(fn.body)) continue;
          if (/backoff|jitter|delay\s*[*=]\s*2|Math\.pow\(2|exponential/i.test(fn.body)) continue;
          out.push(draftFinding({
            ruleId: 'reliability.retry-no-backoff',
            title: 'Retry loop without backoff or jitter',
            description: 'A retry mechanism retries immediately or at a fixed interval, with no exponential backoff and no jitter.',
            severity: 'medium',
            category: 'reliability',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'Retry loop.')],
            whyItMatters: 'Immediate retries turn a brief dependency failure into a self-inflicted load spike, and synchronised clients retry in lockstep.',
            consequences: ['Retry storms that prevent the dependency from recovering', 'Cascading timeouts'],
            recommendation: 'Use exponential backoff with jitter, a maximum attempt count, and retry only idempotent operations or ones guarded by an idempotency key.',
            tags: ['resilience'],
          }));
        }
      }
      return out;
    },
  };
}

/** Payment-like side effect without an idempotency guard. */
function missingIdempotency(): Rule {
  return {
    id: 'reliability.missing-idempotency',
    category: 'reliability',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        if (!/\.(ts|tsx|js|jsx|py|go|java|kt|rb|php|cs)$/.test(change.path)) continue;
        for (const added of addedLines(change)) {
          const trimmed = added.text.trim();
          if (/^(\/\/|\*|\/\*|#|--)/.test(trimmed)) continue;
          if (/^(async\s+)?(export\s+)?(function|def|class|public|private|protected|static)\b/.test(trimmed)) continue;
          if (!/\.(charge|refund|capture|transfer|settle|withdraw)\w*\s*\(|=\s*(charge|refund|capture|transfer|settle|withdraw)\w*\s*\(/.test(added.text)) continue;
          const fn = functionBodyFor(change.path, content, added.line);
          if (/idempoten|requestId|idempotencyKey|dedupe|unique\s+constraint/i.test(fn.body)) continue;
          out.push(draftFinding({
            ruleId: 'reliability.missing-idempotency',
            title: `Payment operation in ${fn.name} has no idempotency guard`,
            description: 'A money-moving call is performed without an idempotency key or a deduplication check visible in the same function.',
            severity: 'high',
            category: 'reliability',
            kind: 'risk',
            confidence: 'medium',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [
              diffEvidence(change.path, added.line, added.text, 'Money-moving operation.'),
              codeEvidence(change.path, fn.start, content, 'Function performing the operation.', 2),
            ],
            whyItMatters: 'Clients and gateways retry on timeout. Without a key, a retry is indistinguishable from a new instruction and the customer is charged twice.',
            consequences: ['Duplicate charges', 'Refund reconciliation work', 'Loss of customer trust'],
            recommendation: 'Accept a client-supplied idempotency key, persist it with a unique constraint before calling the provider, and return the stored result for repeats.',
            tags: ['payments', 'idempotency'],
          }));
        }
      }
      return out;
    },
  };
}

/** Added TODO / FIXME / disabled tests / debug output. */
function maintainabilityMarkers(): Rule {
  return {
    id: 'maintainability.markers',
    category: 'maintainability',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        for (const added of addedLines(change)) {
          if (!/\b(TODO|FIXME|HACK|XXX)\b/.test(added.text)) continue;
          if (/TODO\(.*\):\s*(issue|ticket)\s*#?\d+/i.test(added.text)) continue;
          out.push(draftFinding({
            ruleId: 'maintainability.markers',
            title: 'Unresolved TODO/FIXME added to changed code',
            description: `A marker was added: \`${added.text.trim().slice(0, 140)}\`.`,
            severity: 'info',
            category: 'maintainability',
            kind: 'recommendation',
            confidence: 'verified',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, 'Task marker in added code.')],
            whyItMatters: 'Markers without an owner or ticket accumulate silently; readers cannot tell whether the gap is intentional.',
            consequences: ['Incomplete work shipped without a tracking item'],
            recommendation: 'Link the marker to a tracked issue, or resolve it before merge.',
            tags: ['debt'],
          }));
        }
      }
      return out;
    },
  };
}

/** New `any` in TypeScript. */
function addedAny(): Rule {
  return {
    id: 'maintainability.implicit-any',
    category: 'maintainability',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        if (!/\.(ts|tsx)$/.test(change.path)) continue;
        const content = ctx.contents.get(change.path);
        if (!content) continue;
        for (const added of addedLines(change)) {
          if (!/:\s*any\b|\bas\s+any\b|<any>/.test(added.text)) continue;
          out.push(draftFinding({
            ruleId: 'maintainability.implicit-any',
            title: '`any` added to a typed codebase',
            description: 'The change introduces `any`, which disables type checking for the value at every use site.',
            severity: 'low',
            category: 'maintainability',
            kind: 'recommendation',
            confidence: 'verified',
            file: change.path,
            range: { start: added.line, end: added.line },
            evidence: [diffEvidence(change.path, added.line, added.text, '`any` type annotation.')],
            whyItMatters: '`any` propagates: one annotation removes checking from every expression it touches, including call arguments in unrelated code.',
            consequences: ['Type errors deferred to runtime', 'Refactors that silently break call sites'],
            recommendation: 'Use `unknown` and narrow it, or declare the actual shape. If a third-party type is wrong, wrap it once behind a typed adapter.',
            tags: ['typing'],
          }));
        }
      }
      return out;
    },
  };
}

/** New environment variable that no documentation or example file mentions. */
function undocumentedEnv(): Rule {
  return {
    id: 'configuration.undocumented-env',
    category: 'configuration',
    run(ctx) {
      const out: CandidateFinding[] = [];
      const docCorpus = [...ctx.repoFiles.entries()]
        .filter(([p]) => /\.(md|ya?ml|example|env|sample)$/.test(p) || /(^|\/)\.env/.test(p))
        .map(([, c]) => c)
        .join('\n');
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content || change.binary) continue;
        const addedText = addedLines(change).map((l) => l.text).join('\n');
        const names = new Set<string>();
        for (const m of addedText.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) names.add(m[1]!);
        for (const m of addedText.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g)) names.add(m[1]!);
        for (const name of names) {
          if (docCorpus.includes(name)) continue;
          const line = addedLines(change).find((l) => l.text.includes(name))?.line ?? 1;
          out.push(draftFinding({
            ruleId: 'configuration.undocumented-env',
            title: `Undocumented environment variable: ${name}`,
            description: `\`${name}\` is read by the change but does not appear in any README, .env example, or deployment manifest in the repository.`,
            severity: 'medium',
            category: 'configuration',
            kind: 'problem',
            confidence: 'high',
            file: change.path,
            range: { start: line, end: line },
            evidence: [
              diffEvidence(change.path, line, addedLines(change).find((l) => l.text.includes(name))?.text ?? '', 'New environment dependency.'),
              { kind: 'doc', note: `Searched ${ctx.repoFiles.size} repository files for "${name}"; no documentation match.`, source: 'deterministic' },
            ],
            whyItMatters: 'A required variable that exists only in the author\'s shell fails the first deploy to a clean environment, usually at startup or on the first request.',
            consequences: ['Failed deploys', 'Runtime errors only in environments the author never tested'],
            recommendation: 'Document the variable with a safe default in the README and .env.example, and fail fast at startup with a clear message when it is missing.',
            tags: ['deployment'],
          }));
        }
      }
      return out;
    },
  };
}

export const qualityRules: Rule[] = [
  swallowedErrors(), throwString(), unguardedParse(), resourceLeak(), syncIo(),
  sequentialAwait(), retryWithoutBackoff(), missingIdempotency(), maintainabilityMarkers(),
  addedAny(), undocumentedEnv(),
];
export type { CandidateFinding };
export { codeEvidence };
