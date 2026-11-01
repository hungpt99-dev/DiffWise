# Architecture

DiffWise is a CLI-first, local-first engineering review platform. The analysis engine has no dependency on an editor,
a network or a model; AI is an optional layer that must prove its claims against repository text. Every interface —
CLI, web report, MCP, CI, VS Code — is an adapter over the same application services and the same report contract.

## Packages

```
packages/core     Analysis engine: git, diff, symbols, graph, rules (builtin + declarative packs), documentation,
                  tests, risk, patches, store, reviewer selection, verification engine, policy resolution,
                  approval policy, verification planning, evaluation, report contract (schema v3), envelope, SARIF
packages/ai       Provider adapters, eight specialised reviewers, scoped context assembly, independent verifiers,
                  fix generation, report chat
packages/app      Application services: one implementation of review, chat, fix, verify, export and the local
                  report server. Depends on core + ai, never on an interface.
packages/cli      `diffwise` command line: 12 commands, output contract, exit codes
packages/mcp      MCP server over stdio: 8 recorders + 7 workflow tools, sharing @diffwise/app
packages/webview  React report workspace (Vite): server mode, standalone export, VS Code webview
apps/vscode       Optional extension host: commands, views, diagnostics, CodeLens
```

Dependency direction is strictly one-way:

```
cli ─────▶ app ─────▶ core
mcp ─────▶ app ─────▶ ai ─────▶ core
vscode ──▶ core, ai
webview ─ types ────▶ core
core ────▶ node stdlib + typescript
```

`core` imports neither a UI nor the AI package. `ai` imports no interface. `app` is the only place where a review is
run, persisted, discussed, applied or served — so a behaviour cannot exist in the CLI but be missing from MCP.

## Delivery surfaces

| Surface | Entry point | Live backend needed |
|---|---|---|
| CLI | `diffwise …` (12 commands) | No (except chat, which needs a model provider) |
| Report server | `diffwise report --serve` | Yes — chat, apply, verify |
| Standalone HTML | `diffwise report --format html` | No; read-only by design |
| MCP | `diffwise-mcp` over stdio | No; chat is not exposed as a tool |
| CI | `diffwise review --format sarif\|json` | No |
| VS Code | extension host | Yes, via the host |

The web UI is one React application used in four modes. `createBridge()` in `packages/webview/src/protocol.ts`
selects the transport:

| Mode | Detection | Transport |
|---|---|---|
| `vscode` | `acquireVsCodeApi()` present | postMessage to the extension host |
| `server` | `window.__DIFFWISE_SERVER__` injected by the server | HTTP to `/api/*` |
| `static` | `window.__DIFFWISE_STATIC__` embedded by the HTML export | in-memory report; mutations answered with the export's capability statement |
| `standalone` | neither | UI harness used by tests; actions are explicit no-ops |

Because the message shapes are identical, a section cannot "work only in VS Code": it either works through the
shared bridge contract or it does not work at all.

## Data flow

```
git diff → parse → symbols → graph → docs/tests → agent records → rules (builtin + packs)
        → reviewers (selected, parallel) → correlate → verify (deterministic + independent)
        → risk → report (schema v3) → store → envelope / SARIF / HTML / server → UI
```

Two stages are new in schema v3 and both always run:

- **reviewers** replaces the single "AI enricher". A deterministic selector picks the smallest set of specialised
  reviewers that covers the change (default cap 3, `correctness` pinned), and they run concurrently under a bounded
  pool with per-reviewer budgets.
- **verify** runs the verification engine. Without a provider it is the deterministic half alone — grouping, static
  checks, verdict policy — which is still a real verdict. With a provider it adds independent verifier opinions as one
  evidence class among five.

Every stage is tracked with `pending | running | completed | failed | skipped | cancelled`, timing, a detail line and
metrics. A failed stage — or a stage that completed with an error — forces `summary.completeness = 'partial'`. The
report never claims completeness it did not achieve, and SARIF carries the same warning.

## Core engine

| Module | Responsibility | Key decision |
|---|---|---|
| `git/git.ts` | Shell-free git adapter (`execFile`, explicit argv) | Repository paths never reach a shell |
| `git/diff.ts` | Unified diff parsing | Renames, binary, quoted paths, untracked files |
| `analysis/symbols.ts` | Symbol extraction and symbol-level diffs | TypeScript compiler front-end for JS/TS; documented regex fallback elsewhere |
| `analysis/graph.ts` | Import graph, impact depth, cycles, coupling delta, conventions | Only resolved imports count as verified edges; inferred calls are labelled |
| `analysis/docAnalysis.ts` | Documentation reference resolution and drift | A finding requires a resolved reference, not a prose opinion |
| `analysis/testAnalysis.ts` | Test discovery, target resolution, coverage gaps | Targets resolved by path, basename and import graph |
| `rules/*.ts` | Deterministic rules in six families (32 rules) | Rules fire on added lines and must attach evidence |
| `rules/definition.ts` | Declarative rule schema, validation, ReDoS screening | A rule that could be silently wrong is rejected with its file |
| `rules/loader.ts` | Rule pack discovery, `extends` inheritance, dependency blocking | Packs are untrusted input: paths are contained, symlink escapes refused |
| `rules/registry.ts` | Rule enable/disable, severity override, suppression, per-rule records | A throwing rule fails alone; the run continues and the stage is degraded |
| `review/select.ts` | Reviewer scoring and selection | The cap is the point: eight reviewers exist, a review runs the smallest covering set |
| `review/orchestrator.ts` | Parallel reviewer execution | Per-reviewer timeout, token budget, evidence validation before acceptance |
| `verification/checks.ts` | Deterministic verification checks | `evidence`/`structural` checks can confirm; `heuristic` never can |
| `verification/engine.ts` | Verdict policy and severity recalculation | CONFIRMED requires a non-model evidence class, by construction |
| `policy/resolve.ts` | Policy precedence org → repo → dir → file | Every effective value records the layer that supplied it |
| `policy/approval.ts` | Risk → approval requirement, review state machine | AI and CI decisions never satisfy a human approval |
| `testplan/*` | Command discovery, targeted narrowing, verification planning | Commands come from manifests or policy, never from a model |
| `evaluation/*` | Labelled corpus runner and metrics | Recall is only reported with the dataset that produced it |
| `analysis/risk.ts` | Additive, capped factor model | Every point is attributable; the method is printed with the score |
| `fixes/patch.ts` | Parse/validate/apply/revert unified diffs | Path traversal, context mismatch and deletion are rejected |
| `report/schema.ts` | Validation, migrations, versioning | Referential integrity (fixes → findings, evidence → lines) is enforced; a CONFIRMED finding must carry non-model evidence |
| `report/envelope.ts` | Stable JSON projection (`1.0`) | Agents get a contract that does not churn with internals |
| `report/sarif.ts` | SARIF 2.1.0 export + structural validator | Fingerprints keep a defect's identity across reviews |
| `store/store.ts` | JSON review store + append-only agent events | Portable, diff-able files; SQLite behind the same interface |
| `verification/run.ts` | Deterministic verification entry point | Runs on every review, so a report can never imply verification it did not perform |

### Why JSON files rather than a database server

Reviews are documents, not rows. One JSON file per review is inspectable, portable and trivially backed up. The
store interface is small (`saveReport`, `loadReport`, `listReviews`, `deleteReport`, `appendAgentEvent`,
`recordAppliedFix`) and a `node:sqlite` implementation exists behind it.

### Why the TypeScript compiler for JS/TS

Symbol granularity, class members, import specifiers and call expressions are exactly what the review needs, and the
parser is already a dependency of any TS project. Malformed files return `null` instead of throwing. The cost is a
larger extension bundle; the CLI and server pay it once per process.

## Application services (`packages/app`)

```ts
class DiffWiseService {
  review(options): Promise<{ report, path?, aiReason? }>
  latestReview(), listReviews(), loadReview(ref), findByFinding(id)
  chat({ question, findingId, history }): Promise<ChatAnswer>
  fixOptions(findingId), previewFix(findingId, solutionId)
  registerPatch({ findingId, diff })         // developer-supplied patch, validated
  applyFix({ findingId, solutionId, approved: true })
  rollback(appliedFixId)
  verify({ findingId?, approved? })
  compare(leftRef, rightRef)
  envelope(report), sarif(report), qualityGate(report)
}
```

Everything an interface can do is a method here. The CLI parses arguments and formats; MCP validates schemas and
serialises; the server authenticates and routes; the extension maps messages.

## Safe patch application

`packages/app/src/fix.ts` wraps the core patch engine:

1. **Preview** validates the diff against the current files and hashes every file it would touch.
2. **Apply** re-hashes those files; a mismatch aborts with "the working tree changed since this patch was previewed".
3. **Write** happens file-by-file: write to a temp file in the same directory, then `rename`. A crash cannot leave a
   half-written source file.
4. **Journal**: before/after hashes, backup path and action are written to
   `.diffwise/transactions/<id>.json`; backups are stored with a `.bak` suffix so test runners and linters never
   collect a copied test file.
5. **Rollback** restores from the journal and marks it `rolled-back`.
6. **Approval** is a required argument. There is no code path that applies without it, and the HTTP/MCP layers both
   refuse requests that do not carry an explicit approval.

## Local report server

`packages/app/src/server.ts` — Node's `http`, no framework.

- Binds `127.0.0.1` unless `host` is set **and** `allowPublic` is true.
- A random per-run token is accepted once on `/` and exchanged for an `HttpOnly; SameSite=Strict` cookie.
- API requests require the cookie; mutating requests additionally require `X-DiffWise-Request: 1` and, when an
  `Origin` header is present, a matching origin — a cross-site page cannot send the custom header without a
  preflight this server never grants.
- Static assets resolve inside the built asset directory only.
- `/api/source` and `/source` only serve files referenced by the current review, resolved inside the workspace.
- Strict CSP (`default-src 'self'`, `frame-ancestors 'none'`), `nosniff`, no-store, no referrer.
- No response contains a provider credential; `/api/health` reports only whether the key is present.
- Graceful shutdown on SIGINT/SIGTERM.

## AI layer

```ts
interface LlmProvider {
  id: string; label: string; model: string;
  capabilities: { chat: boolean; jsonMode: boolean; streaming: boolean; maxContextTokens?: number };
  complete(request: CompletionRequest): Promise<CompletionResult>;
  ping(): Promise<PingResult>;
}
```

Three wire formats: OpenAI-compatible `/chat/completions`, Anthropic `/v1/messages`, Ollama `/v1`. Every call has a
hard timeout, retries transient failures with exponential backoff, degrades when `response_format` is rejected, and
raises a scrubbed `ProviderError`.

**Evidence validation.** A model finding is accepted only when the named file exists, the quoted evidence actually
appears in that file (whitespace-normalised), and the finding has a title, description and recommendation.
Rejections are counted (`ai.evidenceRejected`) and never shown as findings.

**Truncation handling.** Request the task budget; on an empty or unparsable answer escalate **once** (1.5×, capped at
32k) and ask for a stricter, smaller shape; salvage the longest valid JSON prefix (complete findings only); mark the
report `partial` when truncation occurred. The escalation is bounded because every retry re-sends the whole prompt, and
reasoning models bill hidden reasoning inside the completion budget.

**Chat.** `ReportChat` receives the report, the selected finding, the change, applied fixes and history. Every
citation is resolved against repository content; unresolved citations are dropped, counted and disclosed.

## Token budget, context assembly and caching

Four modules decide what a model is allowed to see and what it costs.

```
core/tokens/estimate.ts   family-aware token estimation (no tokenizer shipped)
core/tokens/budget.ts     TokenBudget = window − reserved output − margin; packSections()
core/context/changeFirst  tiered assembly: T1 change, T2 targeted context, T3 opt-in deep
core/context/windows.ts   code windows around changed lines, absolute line numbers
core/cache/contentCache   content-addressed, bounded, TTL, atomic writes
ai/instrument.ts          one decorator: cache + usage meter on every call
core/tokens/usage.ts      per-task usage aggregation; cost only when a price is configured
```

**Budget.** `inputLimit = (window − reservedOutput) × (1 − safetyMargin)` unless an explicit limit is given. Sections
carry a tier and a priority; required sections are placed first, the rest by priority, and a section that cannot be
included at least half-size is dropped rather than clipped into noise. Every drop is reported, so a truncated context
never renders as a complete review.

**Why the cache is safe.** The key is the hash of provider, model, prompt-template version and the exact messages. A
change to any file, finding or instruction changes the key, so an answer cannot be replayed against context it was not
written for. There is no separate invalidation rule to get wrong.

**Usage.** `report.ai` records totals, the per-task split, provider-reported cached and reasoning tokens, cache hits and
avoided tokens, and a list-price cost only when `pricing` is configured. Counts are labelled `provider` or `estimated`;
a failed call is recorded (with an estimated prompt) instead of vanishing. The same summary is exposed to agents as
`envelope.aiUsage`.

## Extension host (optional)

| Surface | Behaviour |
|---|---|
| Commands | Review working tree/staged/branch/commits/files, reanalyse, cancel, history, explain, generate fix, discuss, revert, verify, test provider |
| Views | Status, findings, changed files, review history |
| Diagnostics | One per finding with related evidence locations, cleared on every new report |
| CodeLens | One per file with findings, pointing at the highest severity |
| Panel | Webview with strict CSP + nonce, assets from the Vite build |

The webview is a pure view: every filesystem, git, model and process action happens in the host after a typed
message, and paths are resolved inside the workspace.

## Security model

Repository content is untrusted input. The design assumes:

- a file may contain instructions aimed at the model → content is fenced and labelled untrusted; findings must quote
  real text;
- a model may invent a path or line → evidence and citation validation reject it;
- a patch may escape the repository → path resolution and `isSafeRelativePath` reject it;
- a command may be suggested by repository content → only the developer-configured command runs, after approval;
- a secret may sit in the diff → payloads are screened and redacted before leaving the process;
- a report may be shared → keys are never written to reports, settings, logs or HTML.

## Performance

- Repository indexing is capped (`analysis.maxFiles`, 4,000 files for the graph) and parallelised with a pool of 12.
- The graph is bounded (400 impacted nodes, depth 4).
- Prompt context is bounded (16k–60k characters depending on task) and announces truncation.
- Analysis is cancellable between stages and inside model calls.
- The CLI writes progress to stderr so piped output is never blocked or polluted.
- The server serves prebuilt static assets and reads reports from disk; no per-request analysis.

## Extensibility

| Extension point | How to add |
|---|---|
| Rule | Implement `Rule` from `packages/core/src/rules/types.ts`, add it to the family export |
| Provider | Implement `LlmProvider` and register it in `createProvider` |
| Documentation format | Extend reference extraction in `docAnalysis.ts` |
| Language | Add an extractor in `symbols.ts` and a test-target resolver |
| MCP tool | Register it in `packages/mcp/src/server.ts` with a zod schema, calling `ctx.service` |
| CLI command | Add a `CommandSpec` in `packages/cli/src/registry.ts` and a handler; document the exit code |
| Report section | Add a component under `packages/webview/src/sections` and a rail entry in `protocol.ts` |

## Review platform internals (schema v3)

### Reviewer selection

`selectReviewers()` is a pure function of the change: sensitive paths, added-code keywords, changed symbol kinds,
existing deterministic findings, graph cycles and boundary changes, uncovered changes and risk level. It scores each of
the eight reviewers, always keeps `correctness` (pinned), then fills the remaining slots up to `maxReviewers`. The
decision object records every signal, so `diffwise reviewers plan` can justify the set and explain why each other
reviewer did not run.

### Orchestration

`runReviewers()` runs the selected reviewers through a bounded pool (default concurrency 3) with a per-reviewer timeout
and token budget. Each proposal is validated against the repository before it becomes a finding: the file must be part
of the review, the line must exist, and at least one quoted excerpt must occur in the file. A reviewer that throws or
times out is recorded as `failed`; the AI stage is then marked degraded and `completeness` becomes `partial`.

### Verification

`prepareVerification()` normalises and groups findings, then runs the deterministic checks. `finalizeVerification()`
combines those checks with verifier opinions and applies the verdict policy. The promotion table is deliberately
narrow: `CONFIRMED` requires human confirmation, a recorded failing execution, or quoted evidence plus a structural
demonstration. Any number of agreeing models lands at `LIKELY`.

`runDeterministicVerification()` is the entry point used when no provider exists; it is the same policy with an empty
opinion set, which is why offline reviews still carry verdicts.

### Policy and approvals

`resolvePolicy()` merges layers with per-field provenance. Post-merge invariants cannot be waived by any layer:
verification commands always require approval, severe risk always needs one human, suppressions must expire, and AI/CI
decisions never count as approvals. `requiredApproval()` and `computeState()` derive the requirement and the state from
the resolved policy, the risk factors and the recorded decisions.

### Extensibility points

| Extension | How to add | Guide |
|---|---|---|
| Deterministic rule in TypeScript | Implement `Rule`, add to the family export | this file, "Core engine" |
| Declarative rule, no recompile | YAML pack in `.diffwise/rules/<pack>/` | `docs/RULE_PACKS.md` |
| Reviewer | `ReviewerSpec` + generic `SpecialisedReviewer` | `docs/REVIEWERS.md` |
| Review policy | `.diffwise/policy.{json,yaml}` or a directory layer | `docs/POLICY.md` |
| Verification command | `verification.commands` in policy | `docs/POLICY.md` |
| Evaluation case | fixture in `evals/build-fixtures.mjs` + dataset entry | `docs/EVALUATION.md` |
| MCP tool | register in `packages/mcp/src/server.ts` or `tools/platform.ts` | `docs/MCP.md` |
