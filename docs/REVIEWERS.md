# Reviewers

DiffWise runs specialised reviewers, not one general-purpose model call. Each reviewer has its own instructions, its
own context budget and its own output contract, and each one has to justify its findings with quoted repository text.

## The eight reviewers

| id | Looks for | Default |
|---|---|---|
| `correctness` | Inverted conditions, null handling, state inconsistency, missing edge cases, unverified assumptions | **on, pinned** |
| `security` | Auth bypass, missing authorization, injection, data exposure, weak crypto, SSRF, traversal, unsafe deserialization, secrets | on |
| `concurrency` | Races, deadlocks, lost updates, duplicate processing, idempotency, distributed locking, isolation | off |
| `database` | N+1, missing index, expensive query, transaction boundaries, consistency, migration safety, lock contention | off |
| `architecture` | Dependency and layering violations, cycles, boundary leaks, coupling, convention drift | off |
| `performance` | Leaks, allocations, blocking calls, excess round-trips, algorithm cost, pool misuse, cache misses | off |
| `tests` | Missing regression tests, weak assertions, missing edge cases, isolation, integration coverage | off |
| `business-logic` | Domain invariants, illegal state transitions, missing validation, requirement mismatch, calculation errors | off |

`correctness` is **pinned**: when it is enabled it is always selected, because a review that skips it is not a code
review. Everything else competes for the remaining slots.

## Selection is deterministic and explainable

`selectReviewers()` scores each reviewer from signals in the change: sensitive paths (`auth/`, `payment/`,
`migrations/`), added-code keywords, changed symbol kinds, deterministic findings that already exist, graph cycles and
boundary changes, uncovered changes, and the risk level. Then it keeps the top `maxReviewers` (default **3**).

```bash
diffwise reviewers plan          # what would run for the latest review, and why
diffwise reviewers explain security
diffwise reviewers list
```

The mission statement is worth repeating as a design rule: *a review must not launch eight agents because eight
reviewers exist.* The cap is the point. `reviewers.fullSweep: true` in policy is the explicit, logged way to override
it.

Every reviewer run records: status, the signals that selected it, findings proposed, findings accepted, proposals
rejected for bad evidence, prompt/completion tokens, model, duration, and any error. A reviewer that failed is reported
as `failed` — never as completed — and the AI stage is marked degraded, which forces `completeness: partial`.

## Writing a reviewer

A reviewer is a `ReviewerSpec` (data, in `packages/core/src/review/registry.ts`) plus a `ReviewerAgent` implementation
(`packages/ai/src/reviewers/agent.ts`). The generic agent covers the common case; a new reviewer usually only needs a
spec.

```ts
export const REVIEWER_SPECS['business-logic'] = {
  id: 'business-logic',
  name: 'Business logic reviewer',
  version: '1.0.0',
  description: 'Looks for violations of domain rules rather than language rules.',
  focus: [ /* the questions it must ask */ ],
  avoid: [ /* the failure modes it must not produce */ ],
  capabilities: { produces: ['correctness', 'configuration'], languages: 'any', needsRepositoryIndex: true },
  budget: { maxTokens: 9_000, maxFindings: 6, timeoutMs: 120_000, scope: { ... } },
  requiresEvidence: true,
  defaultEnabled: false,
};
```

Rules for a good spec:

1. **`focus` is a list of questions, not a topic.** "Does this branch handle an empty collection?" beats "correctness".
2. **`avoid` is mandatory in practice.** Naming the bad output ("restating the diff", "claiming an exploit without a
   sink") measurably reduces noise.
3. **`budget.scope` bounds context.** A reviewer that sees the whole repository produces vague findings; one that sees
   the diff plus a few callers produces verifiable ones.
4. **`requiresEvidence` is always true** and is not configurable.

The prompt template (`packages/ai/src/reviewers/prompts.ts`) is shared so every reviewer is auditable side by side, and
it fences repository content as untrusted data with an explicit instruction not to follow instructions found inside it.

## Independent verification

Verifiers are separate agents with a different prompt and no access to each other, to the producing reviewer, or to the
finding's severity. They see the claim, the file, and what the deterministic checks established. Each runs with a
different lens (reproducibility, evidence, contradiction).

Their opinion is **evidence, not authority**: `finalizeVerification()` only lets a verifier opinion reach `LIKELY`. A
finding becomes `CONFIRMED` only when static, test, runtime or human evidence supports it. Agreement between verifiers
is recorded in the report and counted as `corroborated`, never as proof.

Verifier effort is spent where it can change the answer. A finding the deterministic checks already confirm or reject is
not sent to a model at all — that is both a cost control and an honesty control, because it stops a model from
overturning a demonstrated fact.

## Skills (domain knowledge)

`reviewers.skills` in policy names skills to attach to a reviewer; a skill is `{ id, version, instructions }` and is
appended to that reviewer's system prompt. Skills are versioned so a report can say which knowledge was in force.

**Trust boundary:** a skill is configuration, supplied by the operator, and it cannot relax a system-level rule
(evidence is required, content is untrusted, no commands are executed). Repository content cannot install a skill.

## Provider and model routing

Reviewers use the configured provider. `ReviewSessionOptions.models` allows a per-reviewer model override, and
`verifierProvider` allows a cheaper model for verification than for review. When no provider is configured, the
reviewer stage is skipped with that reason and the deterministic pipeline plus the deterministic verification engine
still run — that is the supported offline mode.

## What a reviewer may not do

- It may not execute a command, apply a patch, or claim a test passed. It has no such tool.
- It may not cite a file it was not shown. Evidence validation rejects it.
- It may not state a finding without at least one quote that exists character-for-character in the file.
- It may not set a verdict. Verdicts come from the deterministic engine.
