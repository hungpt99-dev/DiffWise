# Migration guide

## From 0.2.x (report schema v2) to 0.3.0 (schema v3)

Nothing you do today breaks. The JSON envelope keeps its `1.0` shape, MCP interface v1 tools keep their names and
arguments, and the CLI keeps every existing command and exit code.

### What changed in the report

Schema v3 adds fields; it does not rename or remove any.

| Added | Where | Notes |
|---|---|---|
| `review.plan` | report | reviewer selection with the signals that produced it |
| `review.reviewerRuns[]` | report | per-reviewer status, findings, tokens, duration, error |
| `review.ruleRuns[]` | report | per-rule status, findings, duration, error |
| `review.verification` | report | confirmed / likely / disputed / unverified / rejected counts |
| `findings[].verification` | report | verdict, method, checks, verifiers, evidence classes, severity adjustment |
| `findings[].reviewerId` | report | which reviewer produced an AI finding |
| `withheldFindings[]` | report | findings below the published verification floor, kept for audit |
| `decisions[]` | report | human and AI decisions, with `actorKind` |
| `approvals` | report | computed requirement and whether it was met |
| `state` | report | `PENDING` … `SUPERSEDED` |
| `policy` | report | effective policy with per-field provenance |
| `requirements[]`, `contextSources[]` | report | reserved; populated when integrations are configured |

### Reading a v2 report

`migrateReport()` upgrades a stored v2 report on load:

- `schemaVersion` becomes 3;
- `review` is created with an explicit `skippedReason` saying the report predates the reviewer pipeline, and a
  verification summary of `performed: false`;
- `decisions`, `requirements`, `contextSources` become `[]`, `state` becomes `PENDING`;
- **findings keep `verification: undefined`.** Claiming a verdict for a review that never verified anything would be a
  fabrication, so the UI shows "no verification record" instead.

A v1 report is upgraded through the v2 step first, so 0.1.x reviews still open.

### Reading a v3 report with an older build

`migrateReport()` refuses to read a report whose `schemaVersion` is newer than the running build, with an explicit
message. Upgrade the tool rather than guessing at fields.

### Behaviour changes to be aware of

1. **Verification runs on every review**, with or without a provider. A finding now has a verdict where it previously
   had none. `diffwise review --no-ai` on the demo repository reports 25 published findings: 7 `CONFIRMED`, 18 `LIKELY`.
2. **Severity can be capped.** A `critical` finding supported only by model interpretation is published at `high` with
   the reason attached, and `severityAssessed` records the original value.
3. **Some findings are withheld.** Anything below `verification.minimumStatus` (default `UNVERIFIED`) moves to
   `withheldFindings`. The default publishes everything except `REJECTED`, so the visible list is unchanged unless you
   raise the floor.
4. **The pipeline has two new stages**, `verify` inserted after `correlate`. Anything that rendered a fixed list of
   stage ids should render the array it is given.
5. **Reviewer findings carry `ruleId: reviewer:<id>`** instead of the single `ai-review` id, so per-reviewer metrics are
   possible.
6. **MCP server version is 0.3.0 / interface v2.** 24 tools were added; none were renamed.
7. **`diffwise version --json` reports `reportSchemaVersion: 3`.**

### If you have automation on the report

- Prefer the envelope (`buildReviewEnvelope`, `schemaVersion: "1.0"`) over the raw report for agent/CI consumption: it
  is the contract that is meant to stay stable.
- If you parse findings, treat `verification` as optional and `withheldFindings` as a separate list.
- If you assert on severity, read `severity` (effective) and `severityAssessed` (original) rather than assuming they
  are equal.

### Policy files are new, and optional

`.diffwise/config.json` still works exactly as before. Policy files (`.diffwise/policy.json`) are an additional layer;
with no policy files present, the engine runs on built-in defaults and `diffwise policy effective` shows `default`
provenance for every value.
