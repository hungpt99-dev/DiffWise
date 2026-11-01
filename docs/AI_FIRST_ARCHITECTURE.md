# AI-first architecture — gap analysis and migration plan

Status: analysis written before implementation, against the repository at `33eafc3` (0.5.0). Every claim below was
checked against the code; file references are real. The phased plan at the end is what this cycle implements and what
it deliberately leaves out.

## 1. What the product actually is today

The pipeline (`core/src/analysis/pipeline.ts`) runs twelve stages in this order:

```
collect → project → parse → graph → context (docs+tests) → agent → rules
        → [ai] → correlate → verify → risk → persist
```

AI is stage 8 of 12. It runs **after** every deterministic stage has produced findings, and it receives those findings
as input. Reviewer selection, reviewer prompts, verification opinions and fix proposals all live behind
`packages/ai`, which `core` never imports. That part of the layering is sound and should be kept.

What that arrangement means in practice:

| Question | Answer in 0.5.0 | Evidence |
|---|---|---|
| Does a review without a provider still succeed? | Yes, and it is labelled `completeness: complete` | `summarize()` in `pipeline.ts`; only a note is added |
| Can a caller tell "AI ran and found nothing" from "AI never ran"? | Only by reading `summary.aiUsed` and the stage list | no dedicated status object |
| Is AI required for any part of the product? | No | `resolveProvider()` returns a reason instead of a provider |
| Which model reviewed the code? | One model for all reviewers, unless `fastModel` is set | `ReviewSessionOptions.models` exists but is never populated |
| Is model choice per task? | Verify/fix can use `fastModel`; review and chat use the main model | `config.ts#resolveProvider`, `service.providers()` |
| Is there incremental analysis? | No | every run re-parses and re-rules every changed file |
| Is AI output attributed per finding? | `source: 'ai'` and `ruleId: reviewer:<id>` | `Finding` type |
| Is reasoning surfaced? | `whyItMatters` (the consequence), not the model's reasoning | `Finding` type |

### 1.1 The specific failure the mission names

> Never silently describe a deterministic-only review as a completed AI review.

Today that can happen. With no provider, the `ai` stage is marked `skipped` with a reason, `summary.aiUsed` is false,
and a note is appended — but `summary.completeness` stays `complete`, the severity chip in the report reads
`complete`, and the CI exit code is driven only by findings. A reader who does not open the stage list sees a
complete review of an AI-first product that never ran AI.

## 2. Gap analysis

Severity is about the mission, not about code quality: **critical** means the product cannot honestly be called
AI-first, **high** means the AI layer is materially weaker than it should be, **medium** is a cost or scale gap.

### G1 — AI's absence does not change the verdict (critical)

`completeness` is computed from failed/degraded stages only (`summarize()`), so `ai.skipped` leaves it `complete`.
The AI stage reason lives in `stages[]`, which the CLI prints only for failed stages and the UI shows in one card.

Impact: a deterministic-only run is presented with the same "complete" signal as a fully AI-reviewed one. This is
precisely the behaviour the mission forbids, and it is the first thing to fix.

### G2 — No AI review status object (critical)

There is no field that answers, in one place: did AI run, how much of it ran, with which models, and why not.
Consumers reconstruct it from `summary.aiUsed` (a boolean), `review.reviewerRuns[].status` and `provider.state` — three
sources that can disagree (they did in 0.4.0, see `PRODUCT_AUDIT.md` D2/D9).

Impact: CLI, CI, MCP and the editor each invent their own interpretation; an agent cannot decide whether to trust a
report's AI coverage.

### G3 — No way to require AI (critical for an AI-first product)

A team that decides every merged review must be AI-reviewed has no contract to enforce. `ai.enabled` only says the
provider may be called; a missing key degrades silently to deterministic-only, and CI stays green.

Impact: the "AI-first" claim is unenforceable where it matters — the merge gate.

### G4 — One model for every task (high)

`ReviewSessionOptions.models` exists and is never populated by `config` or `service`. Reviewer work (security,
concurrency, business logic) runs on the same model as trivial classification, chat and fix generation. `fastModel`
is a single escape hatch for verification and fixes, and it is not recorded per reviewer run.

Impact: either the cheap model is too weak for the hard reviewers, or the strong model is paid for chat and
summarisation. There is no way to say "use the strong model for concurrency and security, a fast one for chat".

### G5 — No routing record (high)

Even where a faster model is configured, `ReviewerRun` does not record which model produced a given run (it records
`model` from the agent result, but verification opinions and fix calls do not carry it into the report). Cost
attribution exists per task (`ai.byTask[].model`) but not per reviewer.

Impact: you cannot answer "what did the security reviewer cost?" or "was this finding produced by the strong model?".

### G6 — AI findings are not presented as the primary output (high)

A finding records `source: 'ai'` and `ruleId: reviewer:<id>`, but not which model produced it, nor a bounded statement
of *why the model concluded this* beyond `whyItMatters` (which is the consequence). The report UI shows a small
"ai" marker; the CLI shows nothing. In an AI-first product the AI's reasoning summary is part of the finding.

Impact: a reader cannot weigh an AI finding by model, confidence and reasoning; the deterministic and AI halves of a
review look interchangeable.

### G7 — Context retrieval stops at the first hop (medium)

`buildReviewerScope` uses the diff, whole-file excerpts around the change, directly impacted files, deterministic
findings and intent. It does not use: related tests' content, documentation passages that mention a changed symbol,
or the recorded agent plan beyond the first intent. Chat has the same shape via `buildChangeFirstContext`.

Impact: an AI asked "what breaks?" sees callers by path but not their contracts or their tests, so cross-file
reasoning is weaker than the graph already allows.

### G8 — No incremental analysis (medium)

Model answers are cached by exact prompt, but analysis is not: every run re-parses, re-graphs and re-rules every
changed file. On a large branch the deterministic half dominates wall time; on a re-review of one file the engine
recomputes everything.

Impact: cost and latency at scale, and it blocks the "review every push" workflow an AI-first product implies.

### G9 — Verification depth is a call count, not a budget (medium)

`maxVerificationCalls` bounds how many groups get opinions, not how much the review may spend. A 34-finding review
spent 63 % of its input tokens on verification (recorded in `TOKEN_EFFICIENCY_AUDIT.md` §4.3).

Impact: an AI-first default (verify everything) is unaffordable without a token or cost ceiling per review.

### What is already right, and must not be rebuilt

- `core` is provider-free; `ai` is the only network boundary; `app` is the only orchestrator. Keep it.
- Evidence validation (quote must exist at a real line) and the verdict policy (a model-only opinion cannot confirm)
  are the product's credibility. Keep them exactly.
- Reviewer selection with recorded reasons, per-reviewer budgets, bounded concurrency, cancellation.
- Content-addressed answer cache, per-task usage, change-first context, cost only when priced.
- The four interfaces already share one service (0.5.0) — an AI status object belongs in that service, not in each UI.

## 3. Target architecture

AI becomes the stage that *interprets*, with deterministic analysis as the tool layer that supplies facts. The
ordering of data collection stays; what changes is the contract around the AI stage.

```text
facts (deterministic, always)                interpretation (AI, tracked)
────────────────────────────                 ────────────────────────────
diff · symbols · graph · docs · tests   →    reviewers (selected by signal)
rules → candidate findings              →    model per task (routed, recorded)
evidence index (file:line + quotes)     →    AI findings with model + reasoning
verification checks (static/test)       →    independent opinions, capped
                                            ↓
                                    one AI review status:
                                    complete | partial | unavailable | disabled | failed
                                    + per-task models + reasons + token/cost
```

Three rules hold the design together:

1. **One source of truth for AI state.** `report.review.ai` (status, counts, models, reasons) is computed once, in
   the pipeline, and every interface reads it. No interface re-derives "did AI run" from stage lists.
2. **AI state drives the report verdict.** `completeness` cannot be `complete` when AI was requested and did not
   fully run. A deterministic-only review stays legitimate and useful — it is simply labelled as such, and CI can
   choose to reject it.
3. **AI work is attributed.** Every AI-produced finding names its reviewer and model; every task's spend is already
   attributed; routing decisions are recorded rather than implied.

### 3.1 Contract shapes

```ts
// additive to ReviewReport (schema v3 keeps validating)
review.ai?: {
  status: 'complete' | 'partial' | 'unavailable' | 'disabled' | 'failed';
  requested: boolean;            // ai.enabled && provider configured
  required: boolean;             // ai.required in config
  reviewers: { planned: number; completed: number; failed: number; skipped: number };
  verification: { opinions: number; groups: number; deferred: number };
  models: { review?: string; verify?: string; fix?: string; chat?: string };
  reason?: string;               // why it is not complete
}
```

```jsonc
// .diffwise/config.json
"ai": { "enabled": true, "required": true, "sendRepositoryContent": false },
"models": { "review": "claude-sonnet-5", "verify": "deepseek-v4.1-flash", "fix": "claude-sonnet-5", "chat": "deepseek-v4.1-flash" }
```

`ai.required: true` means: a review that could not run its AI stage is `partial`, the CLI exits `11`, and the editor
shows a blocking banner. It never means "invent findings" — the deterministic report is still produced and stored.

## 4. Phased migration

Each phase is independently shippable and reversible. "Done" means implemented, tested, and recorded — the same rule
the rest of this repository follows.

### P0 — AI state and the required-AI contract (this cycle)

| Item | Gap | Acceptance |
|---|---|---|
| `review.ai` status object, computed once in the pipeline | G1, G2 | a no-provider review has `status: 'unavailable'`, an AI-disabled review `disabled`, a full run `complete`, a lost reviewer `partial` |
| `completeness` follows AI state when AI was requested | G1 | `ai.enabled` + configured provider + skipped stage ⇒ `completeness: partial` with the reason |
| `ai.required` config + CLI exit `11` + envelope flag | G3 | `--ai-required`/config makes a deterministic-only run fail the gate, with a message naming the missing key |
| Surface the status in CLI summary, envelope (`aiReview`), MCP `get_review_status`, webview Overview | G1, G2 | every interface prints the same status and reason |
| Model routing per task (`models.{review,verify,fix,chat}`) with `fastModel` as fallback | G4 | a configured per-task model appears in `byTask[].model` and in `review.ai.models` |
| Per-run model attribution on reviewer runs | G5 | `reviewerRuns[].model` matches the routed review model |

### P1 — Findings as AI output (next)

- `Finding.model` and `Finding.reasoning` (bounded, ≤400 chars) for AI findings; render both in the report and
  `diffwise show`.
- Sort/annotate the findings list by producer, with a filter for "AI only" and "deterministic only".
- Confidence calibration: compare model-reported confidence with the verification verdict and report disagreement.

### P2 — Retrieval depth (next)

- Add related tests' content (not just paths) and documentation passages that mention a changed symbol to the
  reviewer scope, behind the existing budget.
- Use the recorded agent plan (all intents, not the first) as an explicit "why" section for the reviewers.
- Measure: does token spend per accepted finding improve, or at least not regress? Same bench harness.

### P3 — Incremental analysis and budgets (later)

- Content-hash keyed per-file analysis with dependency-aware invalidation through the impact graph.
- A token/cost ceiling per review (`review.maxCostUsd`) that degrades verification before reviewers.
- Only then consider training-free "semantic caching" (reuse of near-identical prompts). It is deliberately last:
  the exact-prompt cache is correct by construction, and a similarity cache is not.

## 5. What this plan refuses to do

- **No agent swarm.** Reviewer selection already bounds the work; adding a planner/executor/critic loop would multiply
  cost without evidence it improves precision.
- **No LLM where deterministic code is sufficient.** Parsing, symbol extraction, severity arithmetic, evidence
  validation and risk stay deterministic. Sending them to a model would make the product less trustworthy.
- **No AI required to install or open the product.** VS Code activates, history renders and the deterministic review
  works with no key. Only *AI-powered review* requires configuration — and now says so.
- **No silent fallback.** A deterministic-only review is a legitimate product outcome that is *labelled*, never an
  AI review that quietly skipped its AI.
- **No provider lock-in.** Routing is by task, and any OpenAI-compatible endpoint, Anthropic, or local Ollama can fill
  any slot.

## 6. Implementation status

P0 is implemented in this cycle. What exists, and where the evidence is:

| Item | Where | Verified by |
|---|---|---|
| `review.ai` status object, computed once in the pipeline | `core/src/analysis/pipeline.ts` (`assessAi`) | `core/test/ai-status.test.ts` (6 cases: unavailable, disabled, failed, partial, complete, required-without-AI) |
| Completeness follows AI state when AI was requested or required | `summarize()` | same file, assertions on `summary.completeness` and `completenessNote` |
| `ai.required` in config and `--ai-required` in the CLI, exit `11` | `app/src/config.ts`, `cli/src/commands/review.ts`, `cli/src/exit.ts` | `cli/test/cli.e2e.test.ts` ("exits 11 when AI is required…") |
| Status in the envelope, CLI summary, MCP and the webview | `core/src/report/envelope.ts` (`aiReview`), `cli/src/output.ts`, `mcp/src/server.ts` (`compactReport.aiReview`), `webview/src/sections/Overview.tsx` | webview E2E reads `sample-report.json` and asserts the card |
| Per-task model routing (`models.*`), `fastModel` fallback | `app/src/config.ts` (`resolveProvider`) | `app/test/config.test.ts` (routing + `ai.required`) |
| Per-run model attribution | `reviewerRuns[].model`, `review.ai.models` | `ai-status` test asserts `models.review` |

Two defects were found while implementing and are fixed:

1. **`--ai` and `--no-ai` never reached provider resolution.** The flag changed `settings.aiEnabled`, which was
   recorded in the report, but `resolveProvider()` was called with the unmodified config — so `--ai` on a project with
   `ai.enabled: false` still produced a deterministic-only review that *looked* like it had been asked for AI.
2. **The two AI paths disagreed.** `assessAi` originally counted only reviewer sessions, so a successful run through
   the enricher path (`AiReviewer`, which records usage but no reviewer runs) was reported as
   "no reviewer produced a usable result" — a false accusation against a review that had in fact used a model. Both
   paths now produce a status, and the model is attributed from whichever path ran.

Not done, and deliberately so (see §4): retrieval depth (P2), incremental analysis (P3), semantic caching (P3).
`AiReviewer` and `ReviewSession` still coexist; unifying them is a P2 prerequisite, not something to fake now.






