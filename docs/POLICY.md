# Review policy

A repository's review policy decides which rules run, which reviewers may run, how findings are verified, what risk
means and how many humans must approve. Policy is data, layered, and every effective value carries the layer that
supplied it.

## Where policy files live

| Layer | Location | Applies to |
|---|---|---|
| organization | `$DIFFWISE_ORG_POLICY`, or `~/.config/diffwise/org-policy.{json,yaml}` | every repository |
| repository | `.diffwise/policy.{json,yaml}` | everything |
| directory | `.diffwise/policies/*.{json,yaml}`, or `<dir>/.diffwise/policy.json` | the `appliesTo` glob |
| file | `.diffwise/policies/files/*.{json,yaml}` | the `appliesTo` file glob |

Precedence is organization → repository → directory → file. Objects merge deeply; arrays append in layer order
(suppressions, forbidden patterns, owner paths, verification commands); scalars are replaced by the last layer.

A directory layer whose glob matches no changed file is skipped and reported as `loaded: false` with the reason, so a
monorepo policy for `services/billing/**` cannot silently govern an unrelated package.

```bash
diffwise policy effective                 # resolved values with provenance
diffwise policy effective src/payments    # include directory layers for these paths
diffwise policy effective --json          # machine-readable, includes warnings
```

## Fields

```json
{
  "schemaVersion": 1,
  "rulePacks": { "require": ["security@^1.0.0"], "disable": ["legacy"] },
  "rules": {
    "enable": { "security.hardcoded-secret": false },
    "severityOverride": { "database.n-plus-one": "high" },
    "suppress": [
      { "ruleId": "security.sql-injection", "files": ["legacy/**"], "reason": "removal scheduled", "approvedBy": "hung", "expiresAt": "2026-06-30T00:00:00.000Z" }
    ],
    "minSeverity": "low"
  },
  "reviewers": {
    "enabled": ["business-logic"],
    "disabled": ["performance"],
    "maxReviewers": 3,
    "fullSweep": false,
    "skills": ["security:spring-boot@1.2.0"]
  },
  "verification": {
    "minimumStatus": "LIKELY",
    "aiVerification": true,
    "independentVerifiers": 2,
    "commands": [
      { "id": "unit", "label": "Vitest unit tests", "level": "unit", "command": "npm test", "timeoutMs": 300000, "runAfterFix": true, "requiresNetwork": false }
    ],
    "requireApproval": true,
    "sandbox": "none",
    "defaultTimeoutMs": 300000
  },
  "risk": { "weights": { "security-surface": 1.5 }, "thresholds": { "moderate": 30, "high": 55, "severe": 80 } },
  "approvals": {
    "requiredApprovals": { "low": 0, "moderate": 1, "high": 2, "severe": 2 },
    "requiredRoles": { "severe": ["security", "owner"] },
    "ownerPaths": [{ "glob": "src/payments/**", "role": "billing-owner", "reason": "payments changes need their owner" }]
  },
  "security": {
    "blockingSeverity": "high",
    "forbiddenPatterns": [
      { "id": "no-direct-db", "pattern": "from 'pg'", "files": ["src/api/**"], "message": "The API layer must not import a driver directly.", "severity": "high" }
    ]
  },
  "qualityGate": { "failOn": "high" },
  "documentation": { "requireUpdatedDocs": false, "requiredPaths": ["docs/"] },
  "tests": { "requireCoverageFor": ["src/**"], "requiredCommands": ["unit"] },
  "exclude": { "globs": ["**/fixtures/**"] },
  "integrations": { "enabled": [] }
}
```

## Invariants a policy cannot break

These are enforced after every layer has been applied, regardless of what a layer asks for:

| Invariant | Why |
|---|---|
| `verification.requireApproval` is always `true` | a verification command never runs without an explicit approval |
| `approvals.requiredApprovals.severe >= 1` | a severe-risk change always needs a human |
| A suppression without a valid future `expiresAt` is dropped | suppressions cannot become permanent by accident |
| AI and CI decisions never count toward an approval | an approval requirement is a human requirement |

Each of these emits a warning when it overrides a layer, so the report can say what the policy asked for and what
actually happened.

## Validation

Unknown top-level fields, unknown field names inside sections, invalid severities and invalid regexes are reported as
warnings or dropped values with a message — never silently ignored. A typo in a policy file that quietly disables a
control is a security problem, so `diffwise policy effective` prints the warnings section verbatim.

## Risk and approvals

Risk is additive and every point is attributable to a factor with an explanation and its evidence. The thresholds above
map the score to `low` / `moderate` / `high` / `severe`, and the approval requirement follows from the level, the roles
required by policy, and any owner path that matches a changed file.

The output is a **recommendation plus a gate**. DiffWise does not merge, does not authorise a merge, and cannot be
configured to let an AI approve. Branch protection and organisation policy remain authoritative.

## Review state

| State | Meaning |
|---|---|
| `PENDING` | no human decision has been recorded |
| `IN_REVIEW` | a human decision exists but the approval requirement is not satisfied |
| `CHANGES_REQUESTED` | a human asked for changes, or a blocking finding is unresolved |
| `APPROVED` | approvals satisfied and no blocking finding remains |
| `BLOCKED` | a human blocked the review |
| `SUPERSEDED` | a newer review replaced this one |

`computeState()` derives the state from decisions and findings; it is never set directly by a model.

## Versioning and history

Every review records the resolved policy it ran with (`report.policy`: policy, provenance and layer states) and appends
a version to `.diffwise/policy-history.jsonl` when the effective policy differs from the last recorded one. The version
hash covers the resolved values and their provenance, not raw file text: a comment-only edit does not create a new
version, and two checkouts with the same effective rules agree.

```bash
diffwise policy history            # newest first: timestamp, hash, review id, layers
diffwise policy history --json
```

The history is bounded (200 entries). A review's stored snapshot remains the authoritative answer to "what policy
produced this finding"; the history answers "when did the policy change, and to what".
