# Architecture

DiffWise is a CLI-first, local-first engineering review platform. The analysis engine has no dependency on an editor,
a network or a model; AI is an optional layer that must prove its claims against repository text. Every interface —
CLI, web report, MCP, CI, VS Code — is an adapter over the same application services and the same report contract.

## Packages

```
packages/core     Analysis engine: git, diff, symbols, graph, rules, documentation, tests, risk, patches, store,
                  report contract (schema v2), JSON envelope, SARIF
packages/ai       Provider adapters, context assembly, evidence-validated review, fix generation, report chat
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
git diff → parse → symbols → graph → docs/tests → agent records → rules → AI enricher
        → correlate → risk → report (schema v2) → store → envelope / SARIF / HTML / server → UI
```

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
| `rules/*.ts` | Deterministic rules in six families | Rules fire on added lines and must attach evidence |
| `analysis/risk.ts` | Additive, capped factor model | Every point is attributable; the method is printed with the score |
| `fixes/patch.ts` | Parse/validate/apply/revert unified diffs | Path traversal, context mismatch and deletion are rejected |
| `report/schema.ts` | Validation, migrations, versioning | Referential integrity (fixes → findings, evidence → lines) is enforced |
| `report/envelope.ts` | Stable JSON projection (`1.0`) | Agents get a contract that does not churn with internals |
| `report/sarif.ts` | SARIF 2.1.0 export + structural validator | Fingerprints keep a defect's identity across reviews |
| `store/store.ts` | JSON review store + append-only agent events | Portable, diff-able files; SQLite behind the same interface |

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

**Truncation handling.** Request 12k tokens; on an empty or unparsable answer retry once with 24k and a stricter
shape; salvage the longest valid JSON prefix (complete findings only); mark the report `partial` when truncation
occurred.

**Chat.** `ReportChat` receives the report, the selected finding, the change, applied fixes and history. Every
citation is resolved against repository content; unresolved citations are dropped, counted and disclosed.

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
