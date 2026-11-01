# Token and cost control

DiffWise spends tokens only when a model is configured. This guide explains what it sends, what it reuses, what it
costs and how to change each of those, using only settings that exist.

## 1. What gets sent

Context is assembled in tiers, and the budget is computed from the model's window rather than from a character count:

| Tier | Content | When |
|---|---|---|
| T1 essential | the diff, changed files, changed symbols, deterministic findings, recorded intent | always |
| T2 targeted | code windows around changed lines, caller files, related tests, documentation references | while the budget allows, highest priority first |
| T3 deep | full related-file contents | only with `includeDeep` (chat) — off by default |

If a section does not fit, the **lowest-priority** section is dropped, not the last one written, and the drop is
recorded in the report's AI stage detail. Nothing about repository content is sent unless `ai.sendRepositoryContent`
is `true`.

## 2. Budgets

```
input budget = min(configured input limit, model window − reserved output) × (1 − safety margin)
```

| Setting | Default | Meaning |
|---|---|---|
| `provider.maxTokens` | 8000 | output ceiling per call |
| `review.timeoutMs` | 180000 | per-reviewer wall clock; reasoning models need more than the old 120 s |
| reviewer scope budget | 20–22k characters per reviewer (core spec) | reviewers are deliberately cheaper than the report chat |
| fix prompt | window of ±40 lines around the finding (whole file if it is ≤140 lines) | a patch needs real context, not the whole file |

Token counts are estimated with a family-aware estimator, not `length / 4`. Measured against provider-reported usage it
is within 10 % mean absolute error and biased **above** the true count (+9.5 %), so a budget over-reserves rather than
silently overruns. See `docs/TOKEN_EFFICIENCY_AUDIT.md` §1.

## 3. The cache

Model answers are cached by the hash of **provider + model + prompt-template version + the exact messages**. Nothing
else is part of the key, so:

- a change to any file, finding, symbol or instruction produces a different key and a fresh call;
- the same inputs never pay twice;
- bumping the prompt version invalidates every entry without touching the repository.

Measured on the demo repository: second identical review **27/27 cache hits, 0 input tokens, 1.5 s instead of 197 s**.

```jsonc
// .diffwise/config.json
"cache": { "enabled": true, "maxEntries": 500, "ttlDays": 14 }
```

- Entries live in `.diffwise/cache/` (git-ignored) and are bounded by count and by size (32 MB).
- `cache.enabled: false` disables reads *and* writes; the report then shows no cache figures instead of a fake zero.
- `DIFFWISE_CACHE=off`, `DIFFWISE_CACHE_MAX_ENTRIES`, `DIFFWISE_CACHE_TTL_DAYS` override it for a CI run.
- Manual cleanup: `rm -rf .diffwise/cache`. Nothing else depends on it.

What is **not** cached: provider `ping`, and anything that failed (a failed call is recorded and counted, never stored).

## 4. Cost

DiffWise ships **no price table**. Prices change, contracts differ, and a wrong number in a report is worse than no
number. Configure the prices you actually pay:

```jsonc
"pricing": {
  "deepseek-*":          { "inputPerMTok": 0.27, "outputPerMTok": 1.10, "source": "contract 2026-Q4", "asOf": "2026-10-01" },
  "claude-sonnet-5-*":   { "inputPerMTok": 3.00, "outputPerMTok": 15.00, "cachedInputPerMTok": 0.30, "source": "list price" }
}
```

Rules:

- exact model name wins, then the **longest** matching `prefix*`;
- `estimatedCostUsd` is computed from provider-reported token counts and labelled `list-price`; it is never an invoice;
- without a price the report says `cost unknown` (in the CLI and in the UI) — not `$0.00`.

## 5. Where a review's tokens go

The report's `ai.byTask` splits usage per stage. A recorded real run:

| Task | Calls | Input tokens | Share |
|---|---:|---:|---:|
| review (3 reviewers) | 3 | 22 959 | 37 % |
| verify (independent verifiers) | 24 | 39 302 | 63 % |

Verification is usually the larger half. Levers, in order of effect:

1. **Review less often**: an unchanged review is now free (cache).
2. **Fewer reviewers**: `policy.reviewers.maxReviewers` (default 3). Each reviewer is a full scoped prompt.
3. **Cheaper verification model**: set `provider.fastModel`; verifiers and fix generation use it.
4. **Smaller verification budget**: `policy.verification.maxCalls`-equivalent is the session's `maxVerificationCalls`
   (default 12 groups, two lenses each).

## 6. Reading the numbers honestly

| Label | Meaning |
|---|---|
| `provider-reported` | every count came from the API's `usage` object |
| `estimated` | the provider returned no usage; counts are the local estimator |
| `mixed` | some calls reported usage, some did not |
| `cache 27/27 hit` | DiffWise's own cache served the call; 0 tokens were sent |
| `input tokens billed at the provider's own cached rate` | the *provider's* prompt cache (e.g. `cached_tokens`), unrelated to DiffWise's cache |
| `reasoning tokens` | hidden reasoning billed by the provider inside the completion budget |

Failed calls are counted as requests with `failure: true` and an estimated prompt, because a review that lost half its
calls must not look cheap.

## 7. What is not optimised yet

- No incremental review: every run re-analyses every changed file. Only model answers are reused.
- No token cap on verification; the cap is a call count.
- No automatic model routing by task capability; `fastModel` is a manual choice.
- No semantic retrieval: context comes from the diff, the dependency graph and symbol references.

See `docs/PRODUCT_ROADMAP.md` P1-8, P1-9, P1-10.
