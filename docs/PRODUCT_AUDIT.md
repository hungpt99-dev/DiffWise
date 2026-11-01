# Product audit — DiffWise 0.3.0 → 0.4.0

This audit was performed on the working tree at commit `e7a3da0` (`docs(readme): rewrite for CLI-first focus`),
before any change in this cycle. Every number below was produced by running the command shown; nothing is inferred
from the code looking correct. Where something was not executed, it says so.

## 1. Method

Read in full: `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/*.md` (18 files), all package
manifests and tsconfigs, and the source of `packages/{core,ai,app,mcp,cli,webview}` and `apps/vscode` (32.8k lines of
TypeScript/TSX excluding `dist`). Then ran the release gate, then exercised the product end-to-end against a real
model provider, which is where most of the defects below surfaced.

## 2. Measured baseline

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` | exit 0, 56.6 s (7 workspaces; webview 3.5 s, extension bundle 10.2 MB) |
| Typecheck | `npm run typecheck` | exit 0, 7 workspaces, 0 errors |
| Unit/integration | `npx vitest run` | **284 passed / 22 files**, 68.4 s |
| Webview E2E | `npm run test:e2e` | 25 checks passed (headless Chromium, production build) |
| Evaluation corpus | `npm run eval:build && npm run eval` | 8 cases, 13/13 findings, precision 1.0, recall 1.0, 0 forbidden |
| Packaging | `npm run package:vsix` | `diffwise-0.3.0.vsix`, 9 files, 1.81 MB |
| Dependency audit | `npm audit --omit=dev` | 0 advisories (0 low/moderate/high/critical) |
| Extension host E2E | `node e2e/vscode/run-vscode-e2e.mjs` | **not executed** (needs a display; unchanged from 0.3.0) |

Artefacts: `docs/evidence/baseline.md` (0.3.0), `tmp/baseline/gate.log`, `tmp/baseline/gate2.log`.

## 3. Architecture as implemented

The package boundaries are real, not aspirational:

| Package | Responsibility | Provider-aware? | Evidence |
|---|---|---|---|
| `packages/core` | git, diff, AST symbols, graph, rules, docs/tests analysis, risk, verification engine, policy, rule packs, report schema + SARIF, patch apply/validate, **token budgeting and context assembly** | no | no import of `@diffwise/ai` anywhere |
| `packages/ai` | providers (OpenAI-compatible, Anthropic, Ollama), reviewers, verifiers, chat, fix proposals, **content cache and usage metering** | yes | only package that performs network I/O |
| `packages/app` | orchestration: policy + rule packs → pipeline → reviewers → verification; persistence; fixes; verification runs | wires them | `service.ts` is the single entry point |
| `packages/{cli,mcp,webview}` + `apps/vscode` | adapters over `packages/app` | no | no duplicated pipeline |

Two AI paths exist and both are live: the legacy `ReviewEnricher` (`AiReviewer`) used by the VS Code extension, and
the reviewer/verifier `ReviewSession` used by CLI, MCP and the report server. That duplication is the single largest
architectural liability in the repository and is why several fixes below had to be applied twice.

## 4. Capability matrix

`Shipped` means implemented and exercised by a test or a recorded run. `Partial` means the happy path exists and a
documented contract does not. `Missing` means no implementation.

| Capability | State | Notes |
|---|---|---|
| Git targets, diff parsing, renames/binary/untracked | Shipped | `core/src/git` |
| Symbol extraction (TS/JS AST, regex for 7 other languages) | Shipped | `core/src/analysis/symbols.ts` |
| Import graph, impact depth, cycles | TS/JS only | documented in `LIMITATIONS.md` |
| Deterministic rules (6 families) + declarative packs | Shipped | `core/src/rules` |
| Documentation drift (reference-based) | Shipped | `core/src/analysis/docAnalysis.ts` |
| Risk model (additive, attributable) | Shipped | `core/src/analysis/risk.ts` |
| Reviewer selection + parallel execution + per-reviewer budgets | Shipped | `core/src/review` |
| Independent verification with 5 evidence classes | Shipped | `core/src/verification` |
| Patch preview / approval / apply / revert | Shipped | `core/src/fixes/patch.ts`, `app/src/fix.ts` |
| Report schema v3 + v1→v3 migration + SARIF | Shipped | `core/src/report` |
| MCP server (42 tools, v1 surface preserved) | Shipped | `mcp/src` |
| CLI (12 commands, JSON envelope, CI exit codes) | Shipped | `cli/src` |
| Web report (12 sections, standalone export) | Shipped | `webview/src` |
| **Token budget manager (window-aware, per-section)** | **was Missing** → Shipped | `core/src/tokens` |
| **Content-addressed cache for model answers** | **was Missing** → Shipped | `core/src/cache`, `ai/src/instrument.ts` |
| **Per-task usage + cost accounting** | **was Partial** (two aggregate integers) → Shipped | `core/src/tokens/usage.ts` |
| **Model routing by task** | Partial | `fastModel` picks a cheaper model for fixes/verification only; no policy-driven router |
| **Incremental review (unchanged files/symbols)** | Missing | designed in `TOKEN_EFFICIENCY_AUDIT.md` §7, not implemented |
| Embedding / semantic retrieval | Missing | not implemented, and not recommended yet (see roadmap) |
| PR/MR integrations, Jira, webhooks | Missing | documented as out of scope in `LIMITATIONS.md` |
| External MCP client, per-tool permissions | Missing | documented |
| Light theme | Missing | `LIMITATIONS.md` |

## 5. Defects found, with evidence

All of these were reproduced by running the product, not by reading it. Each one is fixed in this cycle unless stated.

### D1 — A reviewer with an aborted provider call was reported as `completed`
`core/src/review/orchestrator.ts` had `if (result.warning) { run.status = 'completed' } else { run.status = 'completed' }`
— both branches identical, with a comment claiming the opposite. In the recorded real run
(`/tmp/diffwise-bench-demo/.diffwise/reviews/20261101-130622-0c6c0a.json`) two reviewers were marked `completed`
while carrying `provider error: This operation was aborted`, and the summary printed `reviewers: 2/3` for a review
where only one reviewer produced anything.
**Fixed:** a reviewer with a warning and zero proposals is `failed`. Regression test:
`core/test/orchestrator-status.test.ts`.

### D2 — Summary said `AI: not used` while AI ran
`aiUsed: Boolean(report.ai)` in `pipeline.ts#summarize`. The reviewer path records usage in `report.review`, never in
`report.ai`, so a completed three-reviewer run printed `AI: not used`.
**Fixed:** `aiUsed` is true when an enricher reported usage, when any reviewer completed, or when requests > 0.

### D3 — Failed and aborted model calls were invisible in usage
`InstrumentedProvider` recorded usage after the call resolved. An aborted call (the common case under timeout) spent
its prompt and recorded nothing: the 13:12 run showed 24 verification requests and zero reviewer tokens, although three
reviewer prompts had been sent.
**Fixed:** failures are recorded with an estimated prompt size and `failure: true`, and the summary labels the run
`estimated` rather than pretending the numbers are complete.

### D4 — Truncated-output recovery tripled the output budget
`providers.ts` retried empty/truncated completions with `[base, 2×base, 32k]`. Every retry re-sends the full prompt, so
a provider that keeps returning empty content costs 3× the input and up to 32k output for nothing.
**Fixed:** one bounded escalation (`min(32k, max(1.5×base, base+2000))`).

### D5 — Reviewer timeout (120 s) was too tight for reasoning models and not configurable
Recorded run: `correctness: reviewer timed out after 120000ms`; the model reported 19,665 reasoning tokens across the
run, i.e. it spends most of its budget thinking. There was no way to raise the limit.
**Fixed:** `review.timeoutMs` in `.diffwise/config.json` (default 180 s) and `DiffWiseService` passes it to
`ReviewSession`; with it, the same review completed 3/3 reviewers (recorded below).

### D6 — Reviewer context sent whole changed files *and* the diff, then truncated the diff
`ai/src/reviewers/scope.ts` sent up to 70 % of the budget as whole changed files (head+tail clipped) while capping the
diff at 45 % and dropping whole files from it. On a large file this spends most of the prompt on unchanged code and can
drop the hunk that matters.
**Fixed:** changed files are sent as windows around the changed lines (absolute line numbers preserved for citation),
the diff gets 70 % of the budget, and every omission is reported. Measured on a 2,100-line fixture: **−61 % to −64 %
reviewer prompt tokens at identical changed-line coverage** (`docs/TOKEN_EFFICIENCY_AUDIT.md`).

### D7 — `est. $0.0000` on a fully cached run
The CLI printed the cost of the current run, which is zero when every answer came from cache, next to "62,261 tokens
avoided". Read together, that looks like a pricing bug.
**Fixed:** the label says `charged this run`, and the avoided tokens are reported separately.

### D8 — Webview footer hard-coded `DiffWise 0.1.0`
`App.tsx` printed `DiffWise 0.1.0`; the report carries `execution.toolVersion`.
**Fixed:** the footer reads the report's tool version (`unknown version` when absent).

### D9 — Sidebar showed `AI off` on a report produced with AI
The rail keyed only on `report.provider.state`, which the reviewer path leaves at `disabled`. The same report showed
"27 model request(s)" in the status bar.
**Fixed:** when `report.ai.requests > 0` the rail shows `AI · N req` with the provider/model in the tooltip.

### D10 — The usage UI was unverifiable
`webview/public/sample-report.json` had no `ai` block, so the new panel could have shipped invisible or broken.
**Fixed:** the fixture now carries the usage block of a real recorded run (real counts, cost intentionally
unconfigured), and four E2E checks assert the panel, its per-task rows, its source label and the `cost unknown` state.

### D11 — Usage aggregation turned `estimated` into `mixed`
Found by the new unit test: a record created with the default source `provider` merged with an `estimated` entry
produced `mixed` even when every entry was estimated.
**Fixed:** the source is seeded from the first entry and the total is `mixed` only when tasks genuinely differ.

### D12 — `.diffwise/cache` was not ignored
The new cache directory would have been committed by any user who ran a review in their repository.
**Fixed:** `.gitignore`.

## 6. What this cycle did **not** do

- No incremental review: every review still re-analyses every changed file. The design and its cache keys are written
  down in `TOKEN_EFFICIENCY_AUDIT.md` §7; the code is not there, so it is not claimed.
- No model router with capability detection: only `fastModel` exists.
- No PR/MR integration, no light theme, no external MCP client, no semantic retrieval.
- The VS Code extension host E2E still needs a display and was not executed here.
- The extension bundle is still 10.2 MB; shrinking it is on the roadmap, not done.

## 7. Where the risk actually is

| Risk | Why it matters | Mitigation in place |
|---|---|---|
| Two AI paths (`AiReviewer` vs `ReviewSession`) | every AI fix must be written twice; they drift | both now share the context builder, the cache and the meter; consolidation is roadmap item R2 |
| Evidence validation is structural | proves the quote exists and has the shape the rule describes, not runtime behaviour | verdict policy caps severity when only a model opined; `CONFIRMED` requires static/test evidence |
| Regex-language adapters | architecture impact for Python/Java/Go is limited to changed files | `LIMITATIONS.md` states the boundary; MCP/CLI report capabilities |
| Verification cost | 24 verification calls were 63 % of input tokens in the recorded run | bounded by `maxVerificationCalls`; now visible per task in usage |
