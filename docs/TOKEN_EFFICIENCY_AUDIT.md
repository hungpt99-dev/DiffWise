# Token-efficiency audit and design

Token cost is a product property of DiffWise, not an implementation detail: review latency, the price of a CI run and
whether a team can afford to review every pull request all depend on it. This document records where tokens went in
0.3.0, what changed, and what the change is worth — measured, not estimated, except where it says "estimated".

Nothing in this cycle removes context to save tokens. The rule applied throughout: **spend tokens on the change, and
stop spending them on what the change already implies.**

## 1. The estimator (the budget everything else depends on)

0.3.0 budgeted in **characters** and approximated tokens as `length / 4`. That is wrong by a large and variable margin,
and every budget built on it inherits the error.

New: `packages/core/src/tokens/estimate.ts` — a family-aware estimator that splits identifiers at camelCase/snake_case
boundaries, prices digits in groups of three, treats punctuation and whitespace separately, prices CJK per character,
and applies a per-family correction (`openai`, `anthropic`, `gemini`, `deepseek`, `qwen`, `llama`).

Calibration (`tools/bench/token-calibration.mjs`, 6 synthetic samples — prose, code, JSON, mixed, Vietnamese, minified —
against `deepseek-v4.1-flash` provider-reported `prompt_tokens`, recorded in `docs/evidence/token-calibration.json`):

| Sample | chars | actual tokens | estimator | chars/4 | estimator error | **chars/4 error** |
|---|---:|---:|---:|---:|---:|---:|
| prose | 176 | 73 | 74 | 54 | +1 % | −26 % |
| code | 285 | 115 | 137 | 81 | +19 % | −30 % |
| json | 251 | 118 | 125 | 73 | +6 % | −38 % |
| mixed | 141 | 82 | 81 | 45 | −1 % | −45 % |
| Vietnamese | 130 | 93 | 106 | 42 | +14 % | −55 % |
| minified | 109 | 83 | 98 | 37 | +18 % | −55 % |

**MAPE 10.0 % for the estimator, 41.5 % for `chars/4`.** Bias is **+9.5 %**, i.e. it over-counts: a budget built on it
can over-reserve, never silently overrun. A 55 % under-count (the old method on minified code) is how a "60 000
character" prompt ends up 90 000 tokens.

Honest limit: this is an estimator calibrated on one tokenizer family, not a tokenizer. The report never presents an
estimated count as a measurement — `usage.source` is `provider` only when the API returned usage.

## 2. Where the tokens actually went in 0.3.0

Three prompt builders existed, each with its own ad-hoc limit:

| Prompt | Builder | Budget | What it contained |
|---|---|---|---|
| Review (enricher) | `contextPack.ts` | 60 000 **chars** | diff (first 3 hunks × 40 lines per file), symbols, findings, docs, agent events, knowledge, full changed files |
| Reviewer (8 agents) | `reviewers/scope.ts` | 20–22 000 **chars** | diff (45 % cap, whole files dropped when exceeded), **whole changed files** (50 %), related files (25 %) |
| Fix | `prompts.ts#fixUserPrompt` | 16 000 chars **per file** | complete changed files |

Concrete waste, in order of size:

1. **Whole changed files next to the diff.** The diff already carries every changed line; the file carries the other
   95 % of it. On the 2,100-line fixture this was 61–64 % of the reviewer prompt (measured in §4).
2. **Arbitrary truncation of the thing being reviewed.** `hunks.slice(0, 3)` and `lines.slice(0, 40)` cut the review
   subject mid-hunk while still paying for unchanged file content. Measured coverage of added lines: **77 %**.
3. **A character budget that stops appending.** `buildContextPack` halts at the first section that does not fit, which
   drops *later* sections regardless of value.
4. **Retry escalation.** A truncated answer was retried with 2×, then 32k output tokens, re-sending the entire prompt
   each time (fixed; see `PRODUCT_AUDIT.md` D4).
5. **No reuse at all.** Two identical runs paid twice. Measured: identical review, 62 261 input tokens cold.

## 3. The design now in place

```
provider window ─ reserved output ─ safety margin = input budget   (TokenBudget)
        │
        ├── sections with tier + priority ──► packSections()  ──► prompt text + provenance
        │       T1 diff / symbols / changes / findings / intent / focus
        │       T2 code windows, callers, tests, docs, knowledge
        │       T3 deep related files (opt-in only)
        │
        ├── provider call wrapped once: InstrumentedProvider
        │       content-addressed cache (provider+model+prompt version+exact messages)
        │       usage meter per task (review | verify | fix | chat)
        │
        └── report.ai: totals, per-task split, cache hits, cost (only when priced), source label
```

Why the cache key is safe by construction: it is the hash of the provider id, the model, the prompt-template version and
the **exact message bytes**. Any change to the repository, the report, the deterministic findings, the prompt text or
the model produces a different key, so a cached answer can never be replayed against context it was not written for.
No invalidation heuristic is involved, so none can be wrong.

## 4. Measured results

Method: `tools/bench/token-bench.ts` builds the deterministic report with the real engine, then assembles each prompt
with the **old builder frozen from git** (`tools/ai/legacy-scope.ts`, `buildContextPack`) and the new one, on identical
inputs, and counts tokens with the estimator. No model is called, so the run is deterministic and free. Coverage is the
share of added lines whose text appears in the assembled prompt — a smaller prompt that drops the change is not an
optimisation.

### 4.1 Demo repository — 8 small files, 25 findings

| Prompt | before | after | change | coverage before | coverage after |
|---|---:|---:|---:|---:|---:|
| Review context, same budget | 7 969 | 6 769 | **−15 %** | 77 % | **100 %** |
| Review context, smallest budget with full coverage | 7 969 (at 77 %) | 7 062 | **−11 %** | 77 % | 100 % |
| Reviewer scope, minimal budget for full coverage | 6 273 | 6 444 | +3 % | 100 % | 100 % |
| Fix prompt (top 3 findings) | 5 106 | 2 934 | **−43 %** | 100 % | 100 % |

The reviewer result is stated as it is: on **small files a window and the whole file cost about the same**, because the
window radius (14 lines) plus the enclosing symbols covers most of a 120-line file. Sending the whole file was never
wrong there, only wasteful in principle.

### 4.2 Large-file fixture — 2 files, ~2,100 lines, 8 changed lines

| Prompt | before | after | change | coverage before | coverage after |
|---|---:|---:|---:|---:|---:|
| Review context, same budget | 882 | 756 | **−14 %** | 100 % | 100 % |
| Reviewer `correctness` | 3 568 | 1 275 | **−64 %** | 100 % | 100 % |
| Reviewer `architecture` | 3 257 | 1 275 | **−61 %** | 100 % | 100 % |

This is the case that motivated the change: a change of eight lines in two long files. Reviewer prompts drop by about
two thirds with no loss of changed-line coverage.

### 4.3 Real provider run — end-to-end, and cache behaviour

Synthetic demo repository, `deepseek-v4.1-flash` via an OpenAI-compatible gateway, `sendRepositoryContent` enabled,
3 reviewers + independent verification. Recorded reports:
`/tmp/diffwise-bench-demo/.diffwise/reviews/20261101-131205-2adf1f.json` (cold) and the run immediately after (warm).

| Run | Requests | Input tokens | Output tokens | Reasoning tokens | Cache | Wall time |
|---|---:|---:|---:|---:|---|---:|
| Cold | 27 | 62 261 | 58 934 | 19 665 | 0/27 | 197 s |
| Warm (identical inputs) | 27 | **0** | **0** | 0 | **27/27** | 1.5 s |

Per task on the cold run:

| Task | Calls | Input tokens | Share of input |
|---|---:|---:|---:|
| Review (`review`) | 3 | 22 959 | 37 % |
| Verification (`verify`) | 24 | 39 302 | **63 %** |

Consequences worth acting on:

1. **Re-running a review of unchanged inputs is free and instant.** This matters for CI retries, for `diffwise show`
   on an existing report, and for chat on the same finding.
2. **Verification dominates input cost (63 %).** 24 calls for 34 findings, two lenses per group. The cap exists
   (`maxVerificationCalls`), but it is a call count, not a token budget, and the report could not show the split
   before this cycle.
3. **Reasoning tokens are 33 % of output.** They are counted by the provider against `max_tokens`, which is why a
   reviewer with a 9 000-token budget and heavy reasoning can return nothing. The bounded escalation in
   `providers.ts` handles it once instead of three times.

## 5. What is exposed, and how honestly

`report.ai` gained additive fields: `cachedPromptTokens`, `reasoningTokens`, `cacheHits`, `cacheMisses`,
`tokensSavedByCache`, `byTask[]`, `estimatedCostUsd`, `costBasis`, `costCaveat`, `usageSource`.

- Token counts are labelled `provider` / `estimated` / `mixed`; a failed call contributes an **estimated** prompt with
  `failure: true` rather than disappearing.
- **Cost is never invented.** DiffWise ships no price table. `pricing` in `.diffwise/config.json` is optional; without
  it the report says `cost unknown` and explains why, including in the UI (`cost unknown` stat, not `$0.00`).
- The UI panel shows totals, per-task rows, cache hits/requests, provider-side cached tokens (a different thing from
  DiffWise's cache, and labelled as such) and reasoning tokens.

## 6. Verification of the claims

| Claim | How it was verified |
|---|---|
| Estimator within ~10 % | calibration against provider usage, 6 samples, recorded JSON |
| Review context −15 % at equal budget with 77 %→100 % coverage | `tools/bench/token-bench.ts`, printed table |
| Reviewer −61/−64 % on large files at equal coverage | same bench, large-file fixture |
| Fix prompt −43 % | same bench, real findings from the demo repo |
| Cache hits avoid all input tokens | two recorded provider runs, 62 261 → 0 |
| Failed calls are counted | `packages/ai/test/instrument.test.ts` (5 cases) |
| Budget never exceeds its limit | `packages/core/test/tokens.test.ts` (32 cases) |

## 7. Not done, with the design that would be required

1. **Incremental review.** The honest design: key each stage on `contentKey(fileContentHash, configVersion,
   rulePackVersion)`; store per-file symbol and rule results; on a change, invalidate the changed files **and every
   importer reachable through `architecture.graph`** (the graph already knows direct and transitive impact). AI answers
   need no invalidation logic at all — their key already contains the exact prompt. This is not implemented, so no
   saving is claimed.
2. **Model routing by task.** Today `fastModel` can point verification/fixes at a cheaper model. A real router needs
   capability data per model (context, JSON mode, reasoning) and an explicit "never leave this provider" invariant for
   privacy; only the former exists.
3. **Semantic retrieval.** Lexical/symbol search plus the dependency graph already selects related files. Embeddings
   would add an index, a second cache and a privacy surface; there is no measurement yet showing it improves context
   selection on this corpus. Not added.
4. **`AiReviewer` / `ReviewSession` consolidation.** Two AI paths mean two places to fix. Both now share the context
   builder, cache and meter, which removed the drift that mattered for tokens; the structural duplication remains.

## 8. Reproducing all of it

```bash
npm run build
npx tsx tools/bench/token-bench.ts                    # before/after tables, no model needed
OPENCODE_GO_API_KEY=… node tools/bench/token-calibration.mjs   # estimator accuracy
diffwise review main..HEAD --ai                       # cold run (real provider)
diffwise review main..HEAD --ai                        # warm: 27/27 cache hits
```
