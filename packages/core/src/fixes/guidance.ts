import type { Finding, FixSolution } from '../types';
import { stableId } from '../util/text';

/**
 * Deterministic, guidance-only remediation options.
 *
 * These are produced without a model so the fix section is never empty and never
 * fabricates a patch. They explain approaches a reviewer can choose between;
 * only AI-generated solutions carry a diff, and every diff is validated before
 * it can be applied.
 */
export function buildGuidanceFixes(findings: Finding[], maxFindings = 8): FixSolution[] {
  const actionable = findings
    .filter((f) => f.kind !== 'recommendation' || f.severity === 'high' || f.severity === 'critical')
    .slice(0, maxFindings);
  const out: FixSolution[] = [];
  for (const f of actionable) {
    const options = guidanceFor(f);
    options.forEach((opt, idx) => {
      out.push({
        id: stableId('fix', f.id, 'guidance', idx),
        findingId: f.id,
        label: `Option ${String.fromCharCode(65 + idx)} — ${opt.label}`,
        approach: opt.label,
        description: opt.description,
        filesAffected: [f.file],
        advantages: opt.advantages,
        disadvantages: opt.disadvantages,
        performance: opt.performance,
        sideEffects: opt.sideEffects,
        complexity: opt.complexity,
        testing: opt.testing,
        compatibility: opt.compatibility,
        source: 'deterministic-guidance',
      });
    });
  }
  return out;
}

interface GuidanceOption {
  label: string;
  description: string;
  advantages: string[];
  disadvantages: string[];
  performance: string;
  sideEffects: string[];
  complexity: FixSolution['complexity'];
  testing: string[];
  compatibility: string;
}

function guidanceFor(f: Finding): GuidanceOption[] {
  const rec = f.recommendation;
  switch (f.ruleId) {
    case 'concurrency.read-modify-write':
    case 'concurrency.multi-write-no-transaction':
      return [
        {
          label: 'Pessimistic locking',
          description: `${rec} Select the affected row with \`SELECT ... FOR UPDATE\` inside one transaction so concurrent callers serialise before reading.`,
          advantages: ['Simple to reason about', 'No retry loop in application code'],
          disadvantages: ['Holds row locks for the duration of the transaction', 'Throughput limited by lock contention on hot rows'],
          performance: 'Serialises writers to the same row; read throughput is unaffected.',
          sideEffects: ['Long transactions can block other writers', 'Requires a connection per transaction'],
          complexity: 'low',
          testing: ['Two concurrent transactions on the same row', 'Transaction rollback leaves no partial write'],
          compatibility: 'Requires a database that supports row-level locks (PostgreSQL, MySQL/InnoDB).',
        },
        {
          label: 'Atomic update',
          description: 'Express the mutation as a single statement (`UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance`) and validate the returned value.',
          advantages: ['No lock held in application code', 'One round-trip', 'Correct under any concurrency level'],
          disadvantages: ['Business rules must fit in SQL', 'Harder to unit test without a database'],
          performance: 'Best write throughput of the three options; one statement per operation.',
          sideEffects: ['Triggers and constraints must be understood before changing the statement'],
          complexity: 'medium',
          testing: ['Concurrent increments produce the exact expected total', 'Insufficient-funds path returns a typed error'],
          compatibility: 'Portable across SQL databases with minor syntax differences (`RETURNING` is PostgreSQL-specific).',
        },
        {
          label: 'Optimistic versioning',
          description: 'Add a `version` column, read it with the row, and write with `WHERE version = $n`; retry when zero rows are affected.',
          advantages: ['No long-lived locks', 'Detects concurrent modification explicitly'],
          disadvantages: ['Retry loop and backoff required', 'Schema change on the affected table'],
          performance: 'Fast under low contention, retries under high contention.',
          sideEffects: ['Migration to add the column', 'Callers must handle a conflict error'],
          complexity: 'medium',
          testing: ['Second writer with a stale version is rejected', 'Retry succeeds and increments exactly once'],
          compatibility: 'Requires a migration and an updated write path in every caller.',
        },
      ];
    case 'security.hardcoded-secret':
      return [
        {
          label: 'Environment variable with startup validation',
          description: 'Read the credential from an environment variable validated in the configuration module, and fail fast when it is missing.',
          advantages: ['No secret in source or history', 'Different values per environment'],
          disadvantages: ['The leaked value must still be rotated manually'],
          performance: 'No runtime cost.',
          sideEffects: ['Deployments must set the variable'],
          complexity: 'low',
          testing: ['Startup fails with a clear error when the variable is absent'],
          compatibility: 'No API change.',
        },
        {
          label: 'Secret manager reference',
          description: 'Load the credential at runtime from the platform secret store (Vault, AWS Secrets Manager, SOPS) with a short-lived lease.',
          advantages: ['Central rotation and audit', 'No long-lived credential in the environment'],
          disadvantages: ['Adds a runtime dependency and availability requirement'],
          performance: 'One extra network call at startup or on cache expiry.',
          sideEffects: ['Local development needs a documented fallback'],
          complexity: 'high',
          testing: ['Value is fetched and cached', 'Provider outage produces a clear startup error'],
          compatibility: 'Requires infrastructure that the target environment may not have.',
        },
      ];
    case 'security.sql-injection':
      return [{
        label: 'Bound parameters',
        description: rec,
        advantages: ['Removes the injection class entirely', 'Enables statement caching by the driver'],
        disadvantages: ['Query shape must be static; dynamic filters need composition'],
        performance: 'Same or better: the driver can reuse the prepared plan.',
        sideEffects: ['Parameter types must be explicit for some drivers'],
        complexity: 'low',
        testing: ['Payload such as `\' OR 1=1 --` is stored/compared as data', 'Existing queries return identical results'],
        compatibility: 'Portable across drivers; only placeholder syntax differs.',
      }];
    case 'api.signature-change':
    case 'api.required-parameter':
      return [
        {
          label: 'Backward-compatible overload',
          description: 'Keep the existing signature and add an optional parameter (or a new overload) so existing callers keep working.',
          advantages: ['No breaking change', 'Consumers upgrade on their own schedule'],
          disadvantages: ['Two code paths until the old form is removed'],
          performance: 'Negligible.',
          sideEffects: ['Deprecation window must be documented'],
          complexity: 'low',
          testing: ['Old call shape still passes', 'New call shape behaves as documented'],
          compatibility: 'Fully backward compatible.',
        },
        {
          label: 'Explicit breaking change with migration',
          description: 'Update every call site in this change, bump the package version, and document the migration.',
          advantages: ['Single clean API', 'No legacy path'],
          disadvantages: ['All consumers must upgrade together'],
          performance: 'Negligible.',
          sideEffects: ['Downstream packages fail to compile until updated'],
          complexity: 'medium',
          testing: ['Repository-wide typecheck passes', 'Integration tests use the new signature'],
          compatibility: 'Breaking; requires a major version.',
        },
      ];
    default:
      return [{
        label: 'Apply the recommended remediation',
        description: rec,
        advantages: ['Directly addresses the evidence cited in the finding'],
        disadvantages: ['Requires the author to validate the change against surrounding code'],
        performance: 'Depends on the chosen implementation.',
        sideEffects: ['Review the affected call sites listed in the architecture section'],
        complexity: f.severity === 'critical' || f.severity === 'high' ? 'medium' : 'low',
        testing: ['Add a regression test that fails before the change and passes after it'],
        compatibility: 'No change to public behaviour unless stated in the finding.',
      }];
  }
}
