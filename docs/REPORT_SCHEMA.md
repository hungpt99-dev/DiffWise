# Report contract

Every interface renders the same artefact: the canonical `ReviewReport` written
by the analysis engine. This document describes that model, the JSON envelope
built for machine consumers, and the rules that keep evidence traceable.

- **Canonical report** — `schemaVersion: 2`, stored at
  `.diffwise/reviews/<reviewId>.json`. Full fidelity: diffs, symbols, graph
  edges, findings, evidence, fixes, verification records.
- **JSON envelope** — `schemaVersion: "1.0"`, emitted by `--json` and by MCP.
  A stable projection for agents and CI that does not change when internal
  fields are added.
- **SARIF 2.1.0** — for code scanning dashboards.

## Lifecycle

```
collect → parse → graph → context → rules → AI → correlate → risk → persist
```

Each stage records `status` (`pending|running|completed|failed|skipped|cancelled`),
timing, a human detail line and optional metrics. A failed stage marks the
report `partial` and is surfaced in `summary.completenessNote`; a review is never
presented as complete when a stage failed.

Reports are written as one JSON file per review plus `reviews/index.json`.
`.diffwise/` is git-ignored by default (`diffwise init` adds the entries).

Retention: DiffWise does not delete reports. Remove
`.diffwise/reviews/*.json` (and the matching index entries via the CLI) to prune.

## Top-level shape (schemaVersion 2)

```jsonc
{
  "schemaVersion": 2,
  "id": "20261031-173530-60d0d5",
  "createdAt": "2026-10-31T16:35:30.000Z",
  "durationMs": 4210,
  "target": { "mode": "branch", "base": "main", "head": "feature/x", "label": "main..feature/x" },
  "repository": { "root": "/repo", "name": "payments", "branch": "feature/x", "headCommit": "…", "languages": [] },
  "summary": {
    "changedFiles": 8,
    "changedSymbols": 15,
    "affectedComponents": 3,
    "findingsBySeverity": { "critical": 2, "high": 7, "medium": 6, "low": 6, "info": 4 },
    "findingsByCategory": { "security": 3 },
    "documentationFindings": 7,
    "testsExecuted": false,
    "aiUsed": true,
    "completeness": "complete",
    "completenessNote": "…"
  },
  "risk": { "score": 92, "level": "severe", "summary": "…", "method": "…", "factors": [] },
  "stages": [],
  "changes": [],
  "changeGroups": [],
  "symbols": [],
  "architecture": { "graph": {}, "conventions": [], "violations": [] },
  "documentation": { "files": [], "findings": [] },
  "findings": [],
  "tests": { "files": [], "uncoveredChanges": [], "execution": null },
  "agent": { "events": [], "intentAlignment": [] },
  "fixes": [],
  "appliedFixes": [],
  "provider": { "state": "ok", "providerId": "openai-compatible", "model": "…" },
  "knowledge": [],
  "settings": {},
  "execution": {
    "tool": "diffwise", "toolVersion": "0.2.0", "command": "diffwise review",
    "cwd": "/repo", "nodeVersion": "v24.22.1", "platform": "linux-x64", "indexedFiles": 19
  },
  "verification": [],
  "ai": { "model": "…", "provider": "…", "requests": 2, "promptTokens": 0, "completionTokens": 0,
          "failures": [], "redactions": 0, "evidenceRejected": 0 }
}
```

### Findings and evidence

```jsonc
{
  "id": "DW-1a2b3c4d5e",          // stable hash of rule + file + line + title
  "severity": "critical",
  "category": "security",
  "kind": "problem",               // problem | risk | recommendation | question
  "confidence": "high",            // verified | high | medium | low
  "title": "SQL statement built by string interpolation",
  "file": "src/payments/PaymentService.ts",
  "range": { "start": 106, "end": 106 },
  "whyItMatters": "…",
  "consequences": ["…"],
  "recommendation": "…",
  "ruleId": "security.sql-injection",
  "source": "deterministic",       // deterministic | ai
  "validated": true,               // set for model findings whose evidence resolved
  "tags": ["CWE-89"],
  "evidence": [
    {
      "kind": "code", "file": "src/payments/PaymentService.ts", "line": 106, "endLine": 106,
      "snippet": "  `UPDATE refund_stats … '${paymentId}'`,",
      "note": "Interpolated SQL statement.",
      "source": "deterministic"
    }
  ]
}
```

Invariants enforced by `validateReport` (and asserted by the test suite):

1. `schemaVersion` is the current one; older reports are migrated on load,
   newer ones are refused with a clear error.
2. Every finding has ≥1 evidence entry, a repository-relative `file`, and a
   1-based `range` with `end >= start`.
3. Finding ids are unique within a report.
4. Every `fixes[].findingId` and `appliedFixes[].findingId` exists in
   `findings`.
5. Change paths are repository-relative (no absolute paths, no traversal).
6. `execution` records the real tool and runtime, so a report can be traced to
   the binary that produced it.

### Fixes and verification

```jsonc
{
  "fixes": [{
    "id": "fix-…", "findingId": "DW-…", "label": "…", "approach": "…",
    "filesAffected": ["…"], "advantages": [], "disadvantages": [], "sideEffects": [],
    "complexity": "low", "testing": [], "compatibility": "…",
    "patch": {
      "diff": "--- a/…\n+++ b/…\n@@ …",
      "files": ["…"],
      "validation": { "applies": true, "fuzz": 0 },
      "destructive": false
    },
    "source": "ai"                 // ai | deterministic-guidance | developer-patch
  }],
  "appliedFixes": [{
    "id": "fix-…", "reviewId": "…", "findingId": "DW-…", "solutionId": "fix-…",
    "appliedAt": "…", "files": ["…"], "diff": "…", "backupDir": ".diffwise/backups/…",
    "revertedAt": "…", "verification": { "status": "passed" }
  }],
  "verification": [{
    "id": "verify-…", "at": "…", "findingId": "DW-…",
    "execution": { "command": "npm test", "status": "passed", "exitCode": 0, "durationMs": 2100, "outputTail": "…" },
    "approvedBy": "cli"
  }]
}
```

`validation.applies` comes from applying the patch in memory against the current
files. It is a statement about applicability, not about correctness.

## JSON envelope (`schemaVersion: "1.0"`)

Emitted by `diffwise review --json`, `diffwise report --format json`,
`diffwise findings --json` (a subset) and the MCP tools.

```jsonc
{
  "schemaVersion": "1.0",
  "reviewId": "20261031-173530-60d0d5",
  "status": "completed",                 // completed | partial | failed
  "createdAt": "…",
  "durationMs": 4210,
  "target": { "mode": "branch", "label": "main..feature/x", "base": "main", "head": "feature/x" },
  "repository": { "name": "payments", "branch": "feature/x", "headCommit": "…", "root": "/repo", "languages": [] },
  "summary": {
    "filesChanged": 8, "linesAdded": 142, "linesDeleted": 21,
    "findings": 25, "critical": 2, "high": 7, "medium": 6, "low": 6, "info": 4,
    "changedSymbols": 15, "affectedComponents": 3, "documentationFindings": 7,
    "testsExecuted": false, "aiUsed": true
  },
  "risk": { "score": 92, "level": "severe", "summary": "…", "method": "…", "factors": [] },
  "findings": [],
  "architectureImpact": { "changedFiles": [], "directlyImpacted": [], "indirectlyImpacted": [], "edgeCount": 25, "edges": [], "cycles": [], "modules": [], "conventions": [] },
  "documentationImpact": { "changed": [], "findings": [] },
  "testImpact": { "related": [], "uncoveredChanges": [], "uncoveredSymbols": [], "deletedTests": [], "suggested": [], "execution": null, "verificationRuns": [] },
  "recommendations": [{ "findingId": "DW-…", "title": "…", "severity": "critical", "action": "…", "file": "…", "line": 106 }],
  "fixes": [{ "id": "fix-…", "findingId": "DW-…", "label": "…", "complexity": "low", "applies": true, "files": [], "source": "ai" }],
  "provider": { "state": "ok", "providerId": "openai-compatible", "model": "…" },
  "execution": { "tool": "diffwise", "toolVersion": "0.2.0", "nodeVersion": "…", "platform": "…" },
  "stages": [{ "id": "rules", "label": "Run deterministic analysis", "status": "completed", "durationMs": 120 }],
  "completenessNote": "…"
}
```

Field guarantees:

- `summary.findings` always equals `critical + high + medium + low + info` and
  `findings.length`.
- `risk.factors` is never empty, so a score is always explainable.
- `findings[]` are the full canonical findings (with evidence), not a summary.
- `status` reflects `summary.completeness`; `partial` carries a reason.

## SARIF mapping

| DiffWise | SARIF |
|---|---|
| finding | `result` + one `rule` per `ruleId` |
| severity critical/high | `level: error` |
| severity medium | `level: warning` |
| severity low/info | `level: note` |
| `finding.range` | `region.startLine/endLine` |
| `finding.file` | `artifactLocation.uri` with `uriBaseId: %SRCROOT%` |
| other evidence files | `relatedLocations` |
| `finding.id` | `partialFingerprints.diffwiseFindingId/v1` |
| failed stages / partial analysis | `invocations[0].toolExecutionNotifications` |

Validate with `node tools/evidence/validate-sarif.mjs <file>` or
`diffwise report latest --format sarif --out out.sarif` (the CLI writes only
validated structures; the test suite asserts it).

## Versioning policy

- **Report schema** increments when the persisted shape changes. `migrateReport`
  upgrades older versions on load; a newer version is refused rather than
  silently mis-read.
- **JSON envelope** stays at `"1.0"` while fields are additive. Removing or
  renaming a field would require `"2.0"`.
- Both versions are printed by `diffwise version`.
