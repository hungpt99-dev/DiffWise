# Changelog

All notable changes to DiffWise are documented here. The format follows Keep a Changelog, and the project adheres to
Semantic Versioning.

## [0.4.0] — 2026-11-01

Token efficiency, usage accounting and the defects that a real provider run exposed. No feature was added to look more
complete; every change below is traceable to a measurement or a reproduced failure in `docs/PRODUCT_AUDIT.md`.

### Added

- **Token budgeting** (`packages/core/src/tokens`): family-aware estimator (measured 10.0 % MAPE vs 41.5 % for
  `chars/4`), `TokenBudget` derived from the model window (window − reserved output − margin), and a priority packer that
  drops the least valuable section first and records every drop.
- **Change-first, tiered context** (`buildChangeFirstContext`): T1 diff/symbols/findings/intent, T2 code windows and
  references, T3 opt-in deep files. Replaces "append until the character budget runs out".
- **Code windows** around changed lines (`context/windows.ts`), with absolute line numbers where a model must cite.
- **Content-addressed cache** for model answers (`cache/contentCache.ts`, `ai/src/instrument.ts`), keyed by provider,
  model, prompt version and the exact messages; bounded by entries and bytes, TTL, atomic writes, no path traversal.
- **Usage and cost accounting** (`tokens/usage.ts`): per-task attribution (review, verify, fix, chat), reasoning and
  provider-cached tokens, cache hits and avoided tokens, optional list-price cost with an explicit `cost unknown` state.
- **Observability surfaces**: `report.ai.byTask` and cost fields, `envelope.aiUsage` for agents/CI, usage lines in the
  CLI summary, and an AI usage panel in the report overview.
- **Configuration**: `cache.{enabled,maxEntries,ttlDays}`, `review.timeoutMs`, optional `pricing` table;
  `DIFFWISE_CACHE`, `DIFFWISE_CACHE_MAX_ENTRIES`, `DIFFWISE_CACHE_TTL_DAYS`, `DIFFWISE_REVIEWER_TIMEOUT_MS`.
- **Benchmarks**: `tools/bench/token-bench.ts` (before/after prompts with changed-line coverage, no model needed) and
  `tools/bench/token-calibration.mjs` (estimator accuracy against provider usage).
- **Evidence tooling**: `tools/evidence/ui-shots.mjs`, `narrow-probe.mjs`, `a11y-probe.mjs`.

### Changed

- Reviewer prompts send **windows around the changed lines** instead of whole changed files, and the diff gets 70 % of
  the budget instead of 45 %. Measured: −64 %/−61 % prompt tokens on a 2,100-line fixture at identical changed-line
  coverage; −15 % on the demo repository with coverage rising from 77 % to 100 %.
- Fix generation sends a ±40-line window (whole file under 140 lines) instead of up to 16 000 characters per file:
  −43 % prompt tokens on the demo repository.
- Token-count and cost labels always state their source (`provider` / `estimated` / `mixed`); a failed call is counted
  as a failure with an estimated prompt instead of disappearing.
- The webview reports the real tool version, the real AI state and an honest cost line.

### Fixed

- A reviewer whose provider call aborted was reported as `completed`; it is now `failed` (it inflated "reviewers: N/M").
- `summary.aiUsed` was false for reviewer-driven runs, printing "AI: not used" for a review with three reviewers.
- Truncated-output recovery retried with 2×, then 32 k output tokens, re-sending the whole prompt each time; now one
  bounded escalation.
- Reviewer timeout was a hard 120 s; now configurable, default 180 s (reasoning models exceed 120 s).
- The diff could be dropped while unchanged file content was kept.
- Usage aggregation reported `mixed` for uniformly estimated runs.
- CLI printed `est. $0.0000` on a fully cached run; it now says what was charged and what was avoided.
- `.diffwise/cache` is git-ignored.

### Measured

| What | Before | After |
|---|---:|---:|
| Estimator error (MAPE) | 41.5 % (`chars/4`) | **10.0 %** |
| Review context, equal budget | 7 969 tok / 77 % coverage | 6 769 tok / **100 %** |
| Reviewer prompt, 2 × ~1 050-line files | 3 568 / 3 257 tok | **1 275 / 1 275 tok** |
| Fix prompt (3 findings) | 5 106 tok | **2 934 tok** |
| Repeat review of identical inputs | 62 261 in / 197 s | **0 in / 1.5 s** (27/27 cache hits) |

### Tests

284 → **329** unit/integration tests (25 files), 25 → **32** browser E2E checks, build, typecheck, evaluation corpus and
VSIX packaging re-run. See `docs/QUALITY_CHECKLIST.md`.

## [0.3.0] — 2026-11-01

- **MCP interface v2**: 42 tools (review status, verification, rules, policy, human decisions), v1 surface preserved.
- **CLI platform commands**: rules, policy, reviewers plan, evaluate; SARIF and JSON envelopes; CI exit codes.
- **Reviewer orchestration**: selection with explained signals, parallel execution, per-reviewer budgets and metrics.
- **Independent verification**: finding grouping, five evidence classes, explicit verdicts with severity caps.
- **Rule packs and policy**: declarative packs with validation, suppression with expiry, org → repo → dir → file
  precedence, risk-based approval requirements, review state machine.
- **Evaluation corpus**: 8 labelled fixtures, 13 findings, recorded metrics.
- Documentation set for architecture, CLI, MCP, policy, rule packs, verification, integrations and limitations.

## [0.2.0] — 2026-11-01

- Checkpoint before the platform work: 149 tests green, reviewer/verification types in place.

## [0.1.0] — 2026-10-31

First working release: a local-first engineering review workspace for VS Code, verified end to end on a real
repository with a real model endpoint.

### Added

- **Review targets**: working tree, staged changes, branch comparison, commit range, selected files.
- **Change intelligence**: unified diff parsing (renames, binary, untracked), symbol extraction and symbol-level
  diffs, semantic change groups with recorded purpose basis.
- **Architecture impact**: resolved import graph, direct and transitive impact, cycles, coupling delta, boundary
  detection, measured repository conventions, interactive graph with before/after coupling.
- **Deterministic review**: 30 rules across security, concurrency, database, API contract, reliability, error
  handling, resources, configuration, maintainability, architecture and tests. Every finding carries evidence.
- **Documentation intelligence**: README/docs/ADR/OpenAPI analysis with resolved references, conflict detection,
  suggested updates and documentation patch previews.
- **Testing analysis**: test discovery, target resolution by path/import, coverage gaps, suggested scenarios with a
  copyable skeleton, real command execution with captured output.
- **AI interpretation**: provider-independent review with evidence validation, duplicate suppression and counted
  rejections; truncation retry and JSON salvage.
- **Fix recommendations**: 2–3 alternative solutions with trade-offs, machine-validated unified diffs, explicit
  approval, file backups, one-click revert.
- **Report-aware discussion**: whole-report and finding-scoped chat with structured citations validated against the
  repository.
- **Coding-agent context**: MCP server (interface v1) with eight recording tools and four read tools; intent-versus-
  implementation alignment.
- **VS Code integration**: activity bar views (status, findings, changed files, history), diagnostics, CodeLens,
  status bar, ten report sections, history restore, keybindings.
- **Storage**: local JSON reviews, append-only agent events, applied-fix log, backups.
- **Quality**: 63 unit/integration tests, 22 browser UI checks, 8 VS Code E2E checks, 16 screenshots, 2 GIF
  recordings, VSIX packaging.

### Fixed during verification

- Hardcoded-credential rule missed declarations with `export`/`static` modifiers.
- `Math.random()` used in camelCase token identifiers was not flagged.
- Method-qualified routes in documentation (`GET /api/health`) were not extracted.
- Cancellation during git collection surfaced as a git error instead of `ReviewCancelledError`.
- Persisted reports recorded a running persist stage and a truncated duration.
- Truncated model JSON discarded all findings instead of retrying and salvaging.
- Newly generated patched fixes did not become the selected option in the UI.
- Duplicate “Option A” prefixes in fix option labels.

### Known limitations

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md). Highlights: no pull-request ingestion, regex-level analysis for
non-TS/JS languages, provider-dependent AI quality, single-root workspaces, unsigned local VSIX.
