# Implementation plan — engineering review platform

This plan was written after auditing the repository at commit `603cdea` plus the uncommitted 0.2.0 work in the working
tree. It records what exists, what is missing, and the order in which the missing pieces are being built. It is a
working document: the status column is updated as each slice lands with evidence.

## Baseline (measured, not assumed)

| Command | Result |
|---|---|
| `npm run build` | passes — core, ai, app, mcp, cli, webview, extension |
| `npm run typecheck` | passes for all seven workspaces |
| `npx vitest run` | see `docs/evidence/baseline.md` for the recorded run |

## Audit matrix

`Shipped` = implemented and exercised by a test or a recorded run. `Partial` = the happy path exists but the contract
the review platform needs does not. `Missing` = no implementation.

| Capability | State before this work | Evidence |
|---|---|---|
| Git targets (working, staged, branch, commits, files) | Shipped | `packages/core/src/git`, `pipeline.integration.test.ts` |
| Diff parsing, rename/binary/untracked | Shipped | `diff.test.ts` |
| Symbol-level change analysis (TS AST + regex fallback) | Shipped | `analysis/symbols.ts` |
| Import graph, impact depth, cycles, boundary changes | Shipped | `analysis/graph.ts` |
| Documentation drift (reference resolution, OpenAPI paths) | Shipped | `docAnalysis.ts` |
| Test discovery and coverage gaps | Shipped | `testAnalysis.ts` |
| Deterministic rules — 6 compiled families | Shipped | `rules/{security,concurrency,database,api,quality,architecture}.ts` |
| Rule metadata contract (id/version/mode/applicability/evidence requirement) | **Missing** — rules are functions with an id | `rules/types.ts` |
| External rule packs loadable without recompiling | **Missing** | — |
| Rule validation, provenance, severity override, suppression with expiry | **Missing** | — |
| Review policy resolution org → repo → directory → file | **Missing** — one flat config file | `app/src/config.ts` |
| Reviewer registry and intelligent reviewer selection | **Missing** — one monolithic AI reviewer | `ai/src/reviewer.ts` |
| Parallel reviewer execution with per-reviewer budgets and metrics | **Missing** | — |
| Independent finding verification with explicit verdicts | **Missing** — only "quote appears in file" validation | `ai/src/reviewer.ts#toFinding` |
| Finding grouping/deduplication across sources | **Partial** — title-similarity merge inside `finalizeFindings` | `pipeline.ts#finalizeFindings` |
| Verification-command discovery and planning | **Partial** — one configured command, no discovery | `app/src/verify.ts` |
| Targeted verification (tests related to the change) | **Missing** | — |
| Finding reproduction / before-after regression runs | **Missing** | — |
| Risk factor model (additive, attributable) | Shipped | `analysis/risk.ts` |
| Risk → approval requirement policy | **Missing** | — |
| Human decision record, review state machine, audit history | **Missing** | — |
| Report schema versioning + migration | Shipped (v2) | `report/schema.ts` |
| JSON envelope for agents, SARIF export | Shipped | `report/envelope.ts`, `report/sarif.ts` |
| MCP server — 11 tools | Shipped | `mcp/src/server.ts` |
| External MCP client (stdio/HTTP), per-tool permissions, audit | **Missing** | — |
| CLI — 12 commands | Shipped | `cli/src/registry.ts` |
| GitHub/GitLab PR review, webhooks, inline comments | **Missing** | — |
| Jira/Confluence/CI ingestion | **Missing** | — |
| Evaluation fixtures and measured metrics | **Missing** | — |
| Web report — 10 sections | Shipped | `webview/src/sections` |
| Web report — pipeline/verification/decision sections | **Missing** | — |

## Design constraints honoured

1. `packages/core` stays deterministic, headless and provider-free. Every new engine (verification, policy, reviewer
   selection, verification planning, integrations parsing) lands there and is unit-testable without a model.
2. `packages/ai` implements reviewer and verifier *agents* against core contracts. It is the only package that knows a
   provider exists.
3. `packages/app` owns orchestration: it wires core engines and AI agents together, nothing else may.
4. Interfaces (MCP, CLI, webview, VS Code) stay adapters. No interface gains a capability the others lack.
5. Report schema moves to v3 with a migration from v2 and v1; the envelope keeps its `1.0` shape and gains fields
   additively.

## Phases

| Phase | Deliverable | Status | Evidence |
|---|---|---|---|
| 0 | Audit + baseline + this plan | **complete** | `docs/evidence/baseline.md` (149 tests green) |
| 1 | Review orchestration contracts, reviewer registry, selection, parallel execution, stage metrics | **complete** | `review.test.ts` (14), `platform.test.ts` (15) |
| 2 | Finding verification: normalization, grouping, verdicts, evidence classes, consensus policy | **complete** | `verification.test.ts` (12), schema validation |
| 3 | Verification planning: discovery, targeted selection, approval gate, execution records | **complete** | `testplan.test.ts` (13); sandbox executor **not** implemented |
| 4 | Rule/policy platform: declarative packs, validation, overrides, suppression, precedence | **complete** | `rulepacks.test.ts` (19), `policy.test.ts` (21) |
| 5 | Risk-based approval policy, human decisions, review state machine | **complete** | `policy.test.ts`, `platform-tools.test.ts` |
| 6 | MCP additions with audit | **complete** (server side) | `platform-tools.test.ts` (21), 42 tools |
| 6b | External MCP client with per-tool permissions | **not implemented** | documented in `docs/INTEGRATIONS.md` |
| 7 | PR review layer (GitHub/GitLab) + issue/doc/CI adapters | **not implemented** | interfaces + rules of engagement documented only |
| 8 | Evaluation fixtures, metrics, evaluation report | **complete** | `evals/`, `docs/EVALUATION.md`, `docs/evidence/evaluation-run.json` |
| 9 | Report schema v3, UI sections, documentation, evidence | **complete** | schema v3 + 2 UI sections + 8 new guides |

### What was deliberately not built

Phase 7 (GitHub/GitLab PR review, Jira, Confluence, CI ingestion) and the external MCP client are the remaining work.
They were not started because a review platform that posts unverified comments at scale is worse than no review at all:
the evidence pipeline that decides whether a comment is worth posting had to exist and be measured first. The
interfaces those adapters must implement, and the seven rules they must obey, are written down in
`docs/INTEGRATIONS.md` so the next slice is a design decision rather than a debate.

`verification.sandbox` accepts `docker`/`nsjail`/`custom` but only `none` has an executor. The plan marks a command that
cannot be isolated as `sandboxable: false` and says so, instead of implying isolation it does not have.

## 0.4.0 addendum — token efficiency

The 0.3.0 phases above are closed. The 0.4.0 cycle took the token-efficiency work that was listed as *not implemented*
(`docs/LIMITATIONS.md` of 0.3.0: "no token/cost accounting", "no incremental caching") and did the part that could be
measured: a token budget, change-first context, code windows, a content-addressed answer cache, and per-task usage with
honest cost labelling. Incremental review, a verification token cap and capability-based model routing remain open.

Authoritative ordering and status now live in `docs/PRODUCT_ROADMAP.md`; measurements live in
`docs/TOKEN_EFFICIENCY_AUDIT.md`.

## Rules for this work

- A phase is only `complete` when its implementation, tests and a recorded command run exist.
- No mock data in a shipped path. Fixtures are inputs to tests, never to production code.
- A finding is never `CONFIRMED` because models agree. Agreement is recorded as `corroborating`, not `confirming`.
