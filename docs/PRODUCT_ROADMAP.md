# Product roadmap

Written after `docs/PRODUCT_AUDIT.md`. Each item states the problem, the evidence that it is real, what "done" means,
and its status. Ordering is by value ÷ risk, not by ambition: correctness and honesty first, cost second, surface third.

Status values: **done** (implemented, tested, measured), **partial**, **not started**.

## P0 — Correctness and truthfulness

| # | Item | Why | Status | Evidence |
|---|---|---|---|---|
| P0-1 | A reviewer with no result and a warning is `failed`, not `completed` | a lost reviewer inflated "reviewers: 2/3" and read as a complete run | **done** | `core/test/orchestrator-status.test.ts`; `PRODUCT_AUDIT.md` D1 |
| P0-2 | `summary.aiUsed` reflects reviewer runs | a three-reviewer run printed "AI: not used" | **done** | `pipeline.ts#summarize`; D2 |
| P0-3 | Failed/aborted model calls appear in usage as failures with an estimated prompt | the expensive half of a run was invisible | **done** | `ai/test/instrument.test.ts`; D3 |
| P0-4 | Truncated-output recovery is bounded to one escalation | every retry re-sends the whole prompt | **done** | `PRODUCT_AUDIT.md` D4 |
| P0-5 | Reviewer timeout configurable; default 180 s | a 120 s cap lost a reviewer to a reasoning model | **done** | `review.timeoutMs`, `DIFFWISE_REVIEWER_TIMEOUT_MS`; recorded 3/3 run |
| P0-6 | The diff is never dropped while unchanged file content is kept | reviewers were sent the surroundings and not the change | **done** | −61/−64 % prompts at 100 % coverage on the large fixture |
| P0-7 | UI/CLI never present a fabricated cost or a stale version | `$0.0000`, `DiffWise 0.1.0`, `AI off` on an AI run | **done** | `UI_UX_AUDIT.md` U1, U2, U8 |
| P0-8 | Security regression tests for the token/cache layer | cache keys must not leak across context or provider | **done** | `instrument.test.ts` (key changes with prompt, model, version), `tokens.test.ts` (key path traversal refused) |

## P1 — Token efficiency

| # | Item | Why | Status | Evidence |
|---|---|---|---|---|
| P1-1 | Family-aware token estimator, no `chars/4` | old budget was 41.5 % MAPE, always under-counting | **done** | calibration: 10.0 % MAPE, +9.5 % bias (`docs/evidence/token-calibration.json`) |
| P1-2 | Central `TokenBudget` (window − reserved output − margin), per-task limits | budgets were ad-hoc character caps | **done** | `core/src/tokens/budget.ts`, 32 tests |
| P1-3 | Tiered, change-first context with per-section provenance and explicit drops | arbitrary hunk/line truncation hid 23 % of added lines | **done** | 77 %→100 % coverage at −15 % tokens |
| P1-4 | Code windows around changed lines instead of whole changed files | the largest single avoidable cost | **done** | −64 % reviewer prompt on long files |
| P1-5 | Content-addressed cache for model answers | identical runs paid twice | **done** | 62 261 → 0 input tokens, 27/27 hits |
| P1-6 | Per-task usage, cache and cost observability in report, CLI, UI and JSON envelope | the split (verification = 63 % of input) was invisible | **done** | `report.ai.byTask`, `envelope.aiUsage`, usage panel, CLI lines |
| P1-7 | Configurable cost with an explicit "unknown" state | any shipped price table would be wrong and dated | **done** | `pricing` config; `docs/TOKEN_OPTIMIZATION.md` |
| P1-8 | Incremental review with dependency-aware invalidation | unchanged files are re-parsed and re-reviewed | **not started** | design in `TOKEN_EFFICIENCY_AUDIT.md` §7.1 |
| P1-9 | Cap verification by token budget, not only by call count | 24 verifier calls = 63 % of input | **partial** — call cap exists, cost is now visible, no token cap | `review.totals`, usage panel |
| P1-10 | Model routing by task and capability with an explicit privacy invariant | only `fastModel` exists | **partial** | `provider.fastModel` |
| P1-11 | Two-pass review measured rather than assumed | the second pass exists (verifiers) and now has a price; whether it pays is untested | **partial** | per-task usage; no A/B on finding precision yet |

## P2 — UI/UX

| # | Item | Status | Evidence |
|---|---|---|---|
| P2-1 | Usage panel with totals, per-task rows, cache and honest cost | **done** | `UI_UX_AUDIT.md` §4 |
| P2-2 | Fix the state contradictions (AI off / version / $0.0000 / cache wording) | **done** | §3 U1, U2, U7, U8 |
| P2-3 | Visible keyboard focus + `aria-current`; E2E asserts computed style | **done** | §3 U9, U10; 32 E2E checks |
| P2-4 | Narrow-panel behaviour (600 px) without clipped cells | **done** | §3 U12 |
| P2-5 | Design tokens that match the code (spacing scale, table alignment) | **done** | §3 U3, U11 |
| P2-6 | `danger` button variant for apply/revert; destructive action review | **not started** | §7 |
| P2-7 | Light theme with measured contrast | **not started** | §6.1 |
| P2-8 | Long-list virtualisation; architecture graph progressive expansion | **not started** | §6.2, §6.3 |
| P2-9 | Screen-reader and contrast pass per theme | **not started** | §6.4 |

## P3 — Platform capabilities

| # | Item | Status |
|---|---|---|
| P3-1 | MCP review execution, status, findings, verification and usage in structured responses | **partial** — 42 tools shipped, `aiUsage` added to the envelope, no token/time bounds advertised per tool |
| P3-2 | First-class CLI (review, rules, policy, evaluate, JSON, exit codes) | **done** — 12 commands; usage lines added |
| P3-3 | Extensible declarative rules with validation and suppression | **done** |
| P3-4 | Deeper language intelligence (Tree-sitter / compiler front-ends) | **not started** — regex adapters for 7 languages, documented |
| P3-5 | Testing intelligence (discovery, targeted plans, real execution records) | **partial** — planning and execution exist; coverage ingestion does not |
| P3-6 | Knowledge retrieval (lexical/symbol/hybrid) | **partial** — symbol and keyword selection exists; no embeddings, deliberately |

## P4 — Ecosystem

| # | Item | Status |
|---|---|---|
| P4-1 | GitHub/GitLab PR review, inline findings, status checks | **not started** (interfaces documented in `docs/INTEGRATIONS.md`) |
| P4-2 | SARIF output | **done** (`core/src/report/sarif.ts`, CLI `--format sarif`) |
| P4-3 | CI quality gates and exit codes | **done** (`qualityGate.failOn`) |
| P4-4 | Multi-root / cross-repository analysis | **not started** (single repository, documented) |
| P4-5 | Org policies, audit trails, team history | **partial** — policy layering org→repo→dir→file and append-only decisions exist; no identity provider |

## Recommended next five, in order

1. **P1-8 incremental review.** The cache layer and content keys now make it a contained change: per-file symbol and
   rule results keyed by content hash, invalidated through `architecture.graph` importers. Payoff is large on repeated
   CI runs, which is exactly the workload the 27/27 cache hit demonstrated for model calls.
2. **P1-9 token cap for verification.** The recorded run spent 63 % of its input on verification. A per-review token
   budget that degrades verification (fewer lenses, then no second opinion) is a small, safe change with a measurable
   effect.
3. **P2-6 destructive-action affordance.** Apply/revert are the only operations that change a working tree; they are
   currently distinguished by copy, not by design.
4. **P3-1 MCP bounds.** Advertise token/time cost per tool and support cancellation, so an agent can budget a review.
5. **P0-9 consolidate `AiReviewer` into `ReviewSession`.** Two AI paths already caused one drift (context size, cache,
   usage); keeping both means every future fix is written twice.

## What this roadmap deliberately refuses to do

- No vector database: no measurement shows retrieval is the current bottleneck, and it adds an index, a cache and a
  privacy surface.
- No rewrite of the webview or the core: both are load-bearing and already tested.
- No price table shipped in the binary: a stale price presented as a measurement is worse than no price.
- No new UI sections to look more complete.
