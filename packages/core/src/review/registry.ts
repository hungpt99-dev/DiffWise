/**
 * Built-in reviewer specifications.
 *
 * A spec is data: it declares what a reviewer looks for, what it must not do,
 * how much it may spend and which languages it understands. Implementations
 * live in `@diffwise/ai`; this file must stay importable without a provider.
 */
import type { ReviewerId, ReviewerSpec } from './types';

const baseScope = {
  maxContextChars: 18_000,
  maxFiles: 12,
  includeRelated: true,
  includeIntent: true,
  includeDeterministic: true,
};

function spec(input: Omit<ReviewerSpec, 'requiresEvidence' | 'defaultEnabled'> & { defaultEnabled?: boolean }): ReviewerSpec {
  return { ...input, requiresEvidence: true, defaultEnabled: input.defaultEnabled ?? true };
}

export const REVIEWER_SPECS: Record<ReviewerId, ReviewerSpec> = {
  correctness: spec({
    id: 'correctness',
    name: 'Correctness reviewer',
    version: '1.0.0',
    description: 'Looks for defects that make the program do the wrong thing, independent of style.',
    focus: [
      'Inverted or incomplete conditions (off-by-one, wrong operator, missing else).',
      'Null/undefined handling on values that can be absent at runtime.',
      'State that is updated in one path but read in another (inconsistent invariants).',
      'Missing edge cases: empty collections, zero, negative numbers, duplicate input.',
      'Assumptions about input that the caller does not guarantee.',
    ],
    avoid: [
      'Style, naming and formatting opinions.',
      'Restating what the diff does without stating what is wrong.',
      'Speculation about code the reviewer was not shown.',
    ],
    capabilities: {
      produces: ['correctness', 'error-handling'],
      languages: 'any',
      needsRepositoryIndex: true,
    },
    pinned: true,
    budget: {
      maxTokens: 9_000,
      maxFindings: 6,
      timeoutMs: 120_000,
      scope: { ...baseScope, maxContextChars: 20_000, maxFiles: 14 },
    },
  }),

  security: spec({
    id: 'security',
    name: 'Security reviewer',
    version: '1.0.0',
    description: 'Looks for exploitable weaknesses introduced by the change.',
    focus: [
      'Authentication bypass and missing authorization checks on new entry points.',
      'Injection: SQL, command, template, header, log injection.',
      'Sensitive data exposure in responses, logs, errors or telemetry.',
      'Insecure cryptography: weak hashes, static IVs, predictable randomness.',
      'SSRF, path traversal and unsafe deserialization of untrusted input.',
      'Secrets and credentials in code, configuration or fixtures.',
    ],
    avoid: [
      'Generic "validate all input" advice without naming the sink.',
      'Claiming an exploit without showing the untrusted source and the sink.',
      'Reporting a finding for a file the reviewer was not shown.',
    ],
    capabilities: {
      produces: ['security'],
      languages: 'any',
      frameworks: ['express', 'fastify', 'spring', 'django', 'rails', 'laravel'],
      needsRepositoryIndex: true,
    },
    budget: {
      maxTokens: 9_000,
      maxFindings: 6,
      timeoutMs: 120_000,
      scope: { ...baseScope, maxContextChars: 22_000 },
    },
  }),

  concurrency: spec({
    id: 'concurrency',
    name: 'Concurrency reviewer',
    version: '1.0.0',
    description: 'Looks for interleavings and shared-state defects that only appear under load.',
    focus: [
      'Race conditions on shared mutable state without a lock or atomic operation.',
      'Deadlocks: inconsistent lock ordering, lock held across an await/IO.',
      'Lost updates: read-modify-write without optimistic or pessimistic control.',
      'Duplicate processing: no idempotency key on a retryable consumer.',
      'Distributed locking: lock expiry shorter than work, missing fencing token.',
      'Transaction isolation assumptions across concurrent writers.',
    ],
    avoid: [
      'Flagging every `async` function.',
      'Claiming a race without two concrete interleaved operations and the shared state.',
      'Suggesting a lock without naming what it protects.',
    ],
    capabilities: {
      produces: ['concurrency', 'reliability'],
      languages: ['typescript', 'javascript', 'java', 'kotlin', 'go', 'rust', 'csharp', 'python'],
      needsRepositoryIndex: true,
    },
    budget: {
      maxTokens: 9_000,
      maxFindings: 6,
      timeoutMs: 120_000,
      scope: { ...baseScope, maxContextChars: 20_000 },
    },
    defaultEnabled: false,
  }),

  database: spec({
    id: 'database',
    name: 'Database reviewer',
    version: '1.0.0',
    description: 'Looks for query, transaction and migration defects.',
    focus: [
      'N+1 queries: a query executed per element of a collection.',
      'Missing index on a new filter/join column, or a query that cannot use one.',
      'Expensive queries: unbounded SELECT, missing LIMIT, full table scan on a hot path.',
      'Incorrect transaction boundaries (work outside the transaction, nested commits).',
      'Data consistency: partial writes, missing constraints, nullable mismatch.',
      'Migration safety: destructive DDL, long locks, non-reversible steps, backfill without batching.',
    ],
    avoid: [
      'Index advice without naming the query and the predicate.',
      'Migration warnings that only restate the SQL.',
      'Performance claims without a plan, a row estimate or a measurement.',
    ],
    capabilities: {
      produces: ['database', 'performance'],
      languages: ['typescript', 'javascript', 'java', 'kotlin', 'python', 'go', 'csharp', 'ruby', 'php', 'sql'],
      frameworks: ['typeorm', 'prisma', 'sequelize', 'knex', 'jpa', 'hibernate', 'sqlalchemy', 'activerecord'],
      needsRepositoryIndex: true,
    },
    budget: {
      maxTokens: 9_000,
      maxFindings: 6,
      timeoutMs: 120_000,
      scope: { ...baseScope, maxContextChars: 20_000 },
    },
    defaultEnabled: false,
  }),

  architecture: spec({
    id: 'architecture',
    name: 'Architecture reviewer',
    version: '1.0.0',
    description: 'Looks for structural regressions: layering, boundaries and coupling.',
    focus: [
      'Dependency violations: a lower layer importing a higher one.',
      'New or reintroduced circular dependencies.',
      'Service-boundary leaks: a module reaching into another module’s internals.',
      'Coupling and cohesion changes that make the module harder to change.',
      'Inconsistent design patterns against repository convention.',
    ],
    avoid: [
      'Naming preferences dressed up as architecture.',
      'Claims that contradict the measured import graph.',
      'Recommending a new abstraction without a concrete boundary it protects.',
    ],
    capabilities: {
      produces: ['architecture'],
      languages: 'any',
      needsRepositoryIndex: true,
    },
    budget: {
      maxTokens: 8_000,
      maxFindings: 5,
      timeoutMs: 120_000,
      scope: { ...baseScope, maxContextChars: 18_000 },
    },
    defaultEnabled: false,
  }),

  performance: spec({
    id: 'performance',
    name: 'Performance reviewer',
    version: '1.0.0',
    description: 'Looks for cost that grows faster than the input, or blocks a shared resource.',
    focus: [
      'Memory growth: retained references, unbounded caches, listeners never removed.',
      'Unnecessary allocation or copying in a hot path.',
      'Blocking calls on an event-loop thread (sync IO, CPU-heavy work in a request).',
      'Excessive network or database round-trips inside a loop.',
      'Inefficient algorithms on input that can grow (O(n²) membership tests).',
      'Connection-pool misuse: acquired but not released, or a pool smaller than concurrency.',
    ],
    avoid: [
      'Micro-optimisations with no measurable effect.',
      'Benchmark claims without a benchmark.',
      'Flagging a loop as slow without the operation inside it.',
    ],
    capabilities: {
      produces: ['performance', 'resources'],
      languages: 'any',
      needsRepositoryIndex: true,
    },
    budget: {
      maxTokens: 8_000,
      maxFindings: 5,
      timeoutMs: 120_000,
      scope: { ...baseScope, maxContextChars: 18_000 },
    },
    defaultEnabled: false,
  }),

  tests: spec({
    id: 'tests',
    name: 'Test reviewer',
    version: '1.0.0',
    description: 'Looks for regression risk that the change does not cover.',
    focus: [
      'A behaviour change with no corresponding test change.',
      'Assertions that cannot fail (asserting on a value the test itself sets).',
      'Missing edge cases in an existing test that the new branch requires.',
      'Test assumptions that no longer hold after the change.',
      'Test isolation: shared mutable state, order dependence, real network or clock.',
      'Integration coverage missing for a newly introduced boundary.',
    ],
    avoid: [
      'Demanding a test for a pure rename.',
      'Suggesting a test that already exists under another name.',
      'Treating line coverage as proof of correctness.',
    ],
    capabilities: {
      produces: ['tests'],
      languages: 'any',
      needsRepositoryIndex: true,
    },
    budget: {
      maxTokens: 8_000,
      maxFindings: 5,
      timeoutMs: 120_000,
      scope: { ...baseScope, maxContextChars: 18_000, includeRelated: true },
    },
    defaultEnabled: false,
  }),

  'business-logic': spec({
    id: 'business-logic',
    name: 'Business logic reviewer',
    version: '1.0.0',
    description: 'Looks for violations of domain rules rather than language rules.',
    focus: [
      'A domain invariant that the new code can break (money, quantity, ownership).',
      'An illegal state transition in a documented lifecycle.',
      'Missing validation at a trust boundary the domain requires.',
      'A mismatch between the stated requirement and what the code does.',
      'Incorrect calculation: rounding, currency, tax, proration, time zones.',
      'Unexpected side effects on a read path (email, charge, event emitted).',
    ],
    avoid: [
      'Inventing a business rule that no document or code states.',
      'Confusing a technical bug with a domain-rule violation.',
      'Requirement claims without citing the requirement text.',
    ],
    capabilities: {
      produces: ['correctness', 'configuration'],
      languages: 'any',
      needsRepositoryIndex: true,
    },
    budget: {
      maxTokens: 9_000,
      maxFindings: 6,
      timeoutMs: 120_000,
      scope: { ...baseScope, maxContextChars: 20_000, includeIntent: true },
    },
    defaultEnabled: false,
  }),
};

export const DEFAULT_MAX_REVIEWERS = 3;

export function reviewerSpec(id: ReviewerId): ReviewerSpec {
  return REVIEWER_SPECS[id];
}

export function allReviewerSpecs(): ReviewerSpec[] {
  return Object.values(REVIEWER_SPECS);
}
