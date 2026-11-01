# Interface strategy

This document is the interface audit that preceded the 0.5.0 changes. It records what each interface actually did,
what it duplicated, and the decisions that follow. Numbers and file references are from the repository at commit
`7b941fd` (0.4.0), before the unification.

**Implementation status:** decisions D1 and D2 are implemented (the extension runs on `DiffWiseService`), D3 is
implemented (`--max-cost`, exit `10`), D4 is implemented (`run_review.maxCostUsd`, corrected annotations), D5 is
delivered as copyable workflows, D6 holds by construction. Details and evidence: `docs/MIGRATION_ROADMAP.md`,
`docs/INTEGRATION_MATRIX.md`.

## 1. What each interface was

### VS Code — `apps/vscode` (5 files, ~1,700 lines)

Presented a complete product surface: 20 commands, four tree views (status, findings, changes, history), diagnostics,
CodeLens, status bar, a 12-section webview panel, fix apply/revert, verification, chat, history restore.

Its execution, however, was its own:

```ts
// apps/vscode/src/extension.ts (before)
const report = await runReview({ root, target, settings: {...}, enrichers: [new AiReviewer(provider, {...})] });
```

No policy resolution, no rule packs, no reviewer selection, no independent verification, no usage accounting, no answer
cache. Patch application and verification were re-implemented in the extension (`applyPatch`, `revertPatch`,
`runVerificationCommand`, `openStore`), and configuration came from VS Code settings only — `.diffwise/config.json`,
`.diffwise/policy.json` and `.diffwise/rules/**` were never read.

### CLI — `packages/cli`

17 commands over `DiffWiseService`: `init`, `doctor`, `review`, `findings`, `show`, `chat`, `fix`, `verify`, `report`,
`history`, `compare`, `config`, `rules`, `reviewers`, `policy`, `evaluate`, `version`. Human output, `--format
text|json|html|sarif`, `--out`, `--serve`, `--fail-on`, `--ai/--no-ai`, `--allow-public`, stable exit codes, JSON
envelope. This was already the reference implementation of "execute a review".

### MCP — `packages/mcp`

42 tools over the same service: nine recording tools (intent, plan, decision, constraint, alternative, activity,
unresolved issue, verification, human decision), review/status/context/risk/coverage/history, findings and feedback,
investigation (change context, affected components, related tests/decisions/docs, knowledge search, verification plan
and result, per-finding verification), remediation (`suggest_fixes`, `apply_fix`, `verify_review`), and platform
introspection (rule packs, rules, reviewer plan, policy, test command discovery, review comparison, `run_verification`).
stdio transport, append-only hashed audit log.

### CI/CD — `.github/workflows/diffwise-review.yml`

A real gate: full-history checkout, deterministic review (`DIFFWISE_AI=off` by default), SARIF upload to code scanning,
JSON artefact, exit code from `--fail-on`. No GitLab equivalent, no cost cap, no reuse across runs.

## 2. The divergence, measured

Same repository, same commit, two interfaces:

| Capability | CLI / MCP (service) | VS Code (own pipeline) |
|---|---|---|
| Policy + rule packs | yes (`report.policy`, rule pack sources) | **no** — `.diffwise/policy.json` and `.diffwise/rules/**` were never read |
| Reviewer selection | yes, ≤ cap, explained | **no** (one general reviewer prompt instead) |
| AI verification (independent opinions) | yes, five evidence classes | **no** — only the deterministic checks ran |
| Deterministic verification | yes | yes (the same core stage, so this part was shared) |
| Finding dedup across sources | yes (`finalizeFindings` + grouping) | partial (single source, no cross-source dedup) |
| Usage/cost accounting | yes (`report.ai.byTask`, cache) | **no** |
| Answer cache | yes | **no** (its own provider instance, no cache) |
| Approval requirements | evaluated (`report.approvals`) | **no** |
| Verification execution | journal + record in report | re-implemented (`spawn` in `support.ts`), no journal |
| Config source | `.diffwise/*` | VS Code settings only |

Measured with a scripted provider on the demo repository (`ai/test` style fake provider, no network): the enricher path
made **2 provider calls** and produced no reviewer plan, no policy, no per-task usage; the service path made **27**
(3 reviewers + 24 verifiers), recorded `plan.reviewers = 3`, `policy`, and `ai.byTask = [review, verify]`. The
deterministic verification stage ran in both — that part was never the divergence.

Consequence: a review of the same change could differ between the editor and CI — different findings, different
severities after verification, no policy state, no cost. That is the architectural defect this cycle removes.

Verified in `packages/app/test/interface-parity.test.ts`: a service review attaches `review.plan`,
`review.verification`, `policy` and `approvals`; the core-only path used by the extension produced none of them.

## 3. Decisions

### D1 — VS Code becomes a presentation layer over `DiffWiseService` (P0)

The extension keeps everything that is genuinely editor work: panel protocol, tree views, diagnostics, CodeLens, status
bar, commands, consent dialogs, settings mapping. Everything else delegates:

| Extension operation | Before | After |
|---|---|---|
| `run(target)` | `runReview` + `AiReviewer` | `service.review({target, settings, signal, onProgress})` ✅ |
| `applyFix` | `applyPatch` + backup + store write | `service.applyFix({approved: true})` ✅ |
| `revertFix` | `revertPatch` + store write | `service.rollback(id)` ✅ |
| `verify` | `runVerificationCommand` + store write | `service.verify({command, approvedBy: 'web'})` ✅ |
| `generateFix` | `new AiReviewer().generateFixesFor` | `service.fixOptions(id, {generate: true})` ✅ |
| `ask` | `new ReportChat(...).ask` | `service.chat({question, findingId, history})` ✅ |
| history restore | `openStore` + `loadReport` | `service.loadReview` / `listReviews` ✅ |

Rationale: the CLI and MCP already prove the service is sufficient for every operation the extension needs; the
dependency is one import, not a rewrite. Rejected alternative: keeping two pipelines and "syncing" them — that is what
created the divergence.

### D2 — VS Code settings become an override layer, not a second source of truth (P0)

`service.review({settings})` accepts partial `AnalysisSettings`; the merged result is recorded in `report.settings`.
Provider/API-key/consent settings stay in VS Code settings because they are machine-local and secret-adjacent, and are
injected as a provider instance.

### D3 — Exit codes and cost limits belong to the CLI (P1)

`--max-cost <usd>` evaluates `report.ai.estimatedCostUsd` after the review and exits `7` with a machine-readable reason.
It is a gate on the run, not a hard kill: the review is already computed and persisted, and the CLI says so. A hard
mid-run budget stop would need provider-level token accounting that most gateways do not expose; pretending otherwise
would be a false guarantee.

### D4 — MCP stays a thin, read-biased surface (P2)

No new pipeline. Additions are limited to consistency: the envelope carries `aiUsage`, and mutating tools keep their
explicit arguments and audit entries. No per-tool permission model (documented limitation, unchanged).

### D5 — CI is a workflow, not a fifth engine (P3)

The GitHub workflow and the GitLab template both shell out to `diffwise review`. Cost limits apply there through
`--max-cost` (a failed job with a clear message is better than a surprise invoice). Caching across CI runs uses the
existing answer cache plus the runner's cache action; there is no CI-specific storage.

### D6 — One review identity everywhere (P4 groundwork)

Reviews are persisted by the service into `.diffwise/reviews` with a single index, so a review started in VS Code is
visible to `diffwise history`, `diffwise show`, MCP status tools and `report --serve`. Finding IDs are produced by
`stableId` from file, line and title, so they are stable across interfaces for the same underlying finding. Fields that
depend on configuration (policy, approvals, reviewers, usage) are recorded per report, never assumed.

## 4. What each interface is *not* allowed to do

| Interface | Forbidden |
|---|---|
| VS Code | call `runReview`/`applyPatch`/`runVerificationCommand` directly; parse `.diffwise/*` itself; compute severity |
| CLI | contain analysis logic; invent finding fields; fabricate exit codes |
| MCP | run its own AI pipeline; return unbounded payloads; perform destructive actions without explicit arguments |
| CI | maintain a forked review engine; publish findings the engine did not produce |

## 5. Testing strategy per interface

| Interface | Tests |
|---|---|
| Shared core/service | unit + integration (`packages/{core,app}/test`), evaluation corpus |
| VS Code | webview E2E (35 checks); extension logic exercised through the service in `interface-parity.test.ts`; extension-host E2E exists but needs a display (unchanged limitation) |
| CLI | `packages/cli/test/cli.e2e.test.ts` (23 tests) + `args.test.ts` (15) — real subprocesses, real git repos |
| MCP | `packages/mcp/test/*` (32 tests) — protocol, tools, audit |
| CI | workflow files are static; the commands they run are the ones covered by CLI tests |

## 6. Open questions recorded, not answered by code

1. Should VS Code run the *same* reviewer set as CI by default, or a cheaper subset for editor latency? Today it runs
   the same pipeline with the same policy; a latency-sensitive profile would be an explicit config, not a hidden
   difference.
2. Should the extension surface approvals/decisions (human-in-the-loop) in the panel, now that the service computes
   them? They are recorded in the report; the panel shows policy state but has no decision UI.
3. Multi-root workspaces: the service is per-root; a workspace-level review would need an aggregation contract. Not
   attempted.
