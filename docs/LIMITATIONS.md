# Limitations

DiffWise 0.3.0 is a working review platform with a deliberately bounded scope. This file lists what it does not do, so
the documentation never implies more than the implementation provides. "Not supported" here means exactly that: there
is no hidden half-implementation behind it.

## Integrations

- **No pull-request ingestion.** GitHub/GitLab PR and MR reviews are not implemented: no check runs, no inline comments,
  no review submission, no webhooks. Targets are local git refs, which a CI job sets up.
- **No Jira, Confluence, ADR synchronisation or CI result ingestion.** `ReviewReport.requirements` and
  `contextSources` exist and are validated, but no live adapter populates them. See `docs/INTEGRATIONS.md`.
- **No external MCP client.** DiffWise exposes an MCP server; it does not connect to third-party MCP servers, and there
  is no per-server tool permission model to configure.
- **No merge, ever.** DiffWise cannot approve or merge, and no setting enables it.

## Review targets

- **Single repository.** Multi-root workspaces and cross-repository analysis are not supported.
- **Git only.** No Mercurial, SVN or Jujutsu.
- **No history-rewriting awareness.** Force-pushed or rebased branches are reviewed as they are now.

## Reviewer pipeline

- **Selection is heuristic, not learned.** Reviewer scoring is a deterministic signal table. It is explainable and
  testable, and it will occasionally pick a less useful reviewer than a human would.
- **The reviewer cap is a hard default of 3.** Raising `reviewers.maxReviewers` costs tokens roughly linearly.
- **"Independent" verifiers are procedurally independent, not model-independent.** They are separate calls with
  different lenses and no shared conversation. Three calls to the same model are not three opinions; the report labels
  them accordingly and the engine never lets them confirm a finding.
- **Nothing is streamed.** Reviewer and verifier calls are single-shot with a hard timeout.
- **Cost is only reported when you configure prices.** Token counts come from the provider when it reports them and are
  labelled `estimated` when it does not. DiffWise ships no price table, so a run without `pricing` in the config reports
  `cost unknown` rather than a number.
- **No token cap on verification.** The cap is a call count (`maxVerificationCalls`); a review with many findings pays
  proportionally. Verification was 63 % of input tokens in a recorded 34-finding run.
- **No incremental review.** Every run re-analyses every changed file. Only model answers are reused, through a
  content-addressed cache whose key includes the exact prompt.
- **No automatic model routing.** `provider.fastModel` is a manual choice for fixes and verification; there is no
  capability-based router.

## Verification

- **Static evidence dominates.** Most `CONFIRMED` verdicts come from resolved quotations plus a structural fact. That
  proves the quoted code exists and has the shape the rule describes; it does not prove runtime behaviour.
- **A passing test never confirms a defect.** `test.execution` supports a verdict only when a recorded run failed.
- **The test-verification link depends on a real run.** `test.execution` is only reachable through `diffwise verify`; a
  review with no verification run has no test evidence.
- **Reproduction is planned, not generated.** `buildReproductionPlan()` selects the narrowest existing test command; it
  does not write a new test. Generating a regression test is not implemented.
- **Heuristic checks cannot confirm.** N+1, shared-write-without-lock and covering-test checks raise a finding to
  `LIKELY` at most, by design.
- **Grouping is conservative.** Two findings on adjacent lines with different categories stay separate; duplicates are
  preferred over a merge that hides a defect.

## Verification execution

- **One command per level.** Discovery picks the best command for a level from the manifests; it does not run every
  candidate.
- **Sandbox adapters are declared, not implemented.** `verification.sandbox` accepts `none | docker | nsjail | custom`;
  only `none` has an executor. The plan marks a command that needs network or external services as `sandboxable: false`
  and says so, rather than implying isolation it does not have.
- **Cancellation is between stages**; a command already running is killed by timeout or explicit abort.
- **A passing command is a passing command.** It is never reported as proof that a finding is fixed.

## Rule packs

- **`ai-assisted` and `hybrid` rules run, but not in the deterministic stage.** Their interpretive half is evaluated by
  the AI stage; the deterministic engine records them as skipped with that reason.
- **`ast` detection supports TypeScript/JavaScript only.** Other languages use `pattern`, `absence` or
  `forbidden-import`.
- **ReDoS screening is heuristic.** Patterns longer than 600 characters and nested quantifiers such as `(a+)+` are
  rejected; a determined author can still write a slow pattern that is not catastrophic.
- **No rule inheritance beyond a single `extends` hop chain.** Cycles are not detected explicitly; a rule that extends
  itself will not resolve and is reported as unknown.

## Risk and approvals

- **Risk is an additive heuristic, not a probability.** Every point is attributable, and the factor list is the useful
  part. On a change with two critical findings it saturates at 100/severe.
- **Approval requirements are recommendations plus a gate.** They are not an authorisation, and DiffWise cannot enforce
  them without branch protection.
- **Roles are strings matched against policy.** There is no identity provider integration, so a decision's `role` is
  self-declared.

## Language analysis

- **TypeScript/JavaScript** use the TypeScript compiler front-end: symbols, class members, imports, call expressions,
  signature changes.
- **Python, Java, Kotlin, Go, Rust, C#, Ruby, PHP** use regex-level symbol extraction. Imports are not resolved into the
  graph for these languages, so architecture impact is limited to changed files.
- **No type inference or cross-file type checking.**
- **Spring-specific modelling** (bean graph, `@Transactional` propagation, Kafka topology) is not implemented; route and
  annotation extraction is textual.

## Documentation analysis

- Resolution is reference-based: symbols, file paths, commands, routes, environment variables. Prose that is merely
  wrong without a resolvable reference is not detected.
- OpenAPI checks compare paths with route declarations; schema-level compatibility is not analysed.

## Testing of DiffWise itself

- **Verified on Linux only** (Ubuntu 24.04, Node 24). macOS and Windows code paths exist but were not executed.
- **The VS Code extension's E2E run needs a display**; the webview E2E runs headless in Chromium. The extension host E2E
  script is present but was not executed in this environment (no Xvfb session).
- **The evaluation corpus is small** (8 fixtures, 13 labelled findings) and was refined alongside the tool. A perfect
  score on it is weak evidence; see `docs/EVALUATION.md`.

## Interfaces

- **The VS Code extension is a presentation layer.** It calls `DiffWiseService` for review, fixes, verification, chat
  and history. It therefore runs the same policy, reviewers and verification as CI — which is slower with AI than the
  pre-0.5 single-prompt review. Lower `reviewers.maxReviewers` in policy (it then applies to every interface) or rely
  on the answer cache.
- **No decision/approval UI in the editor.** Approvals are computed and stored by the service; the panel shows policy
  state but has no control to record a human decision.
- **No per-tool permissions in MCP.** Every registered tool is available to any client that can connect.
- **GitLab CI is a template, not an executed pipeline.** The YAML parses and the commands it runs are covered by the
  CLI tests; it has not run on a real GitLab runner here.
- **The VS Code extension-host E2E needs a display.** It runs under Xvfb (`npm run e2e:vscode` with the Extension
  Development Host on `--remote-debugging-port`), and it was executed for 0.5.0; it is still not part of `npm test`.
- **No PR inline comments.** CI publishes SARIF and a JSON report; findings are not posted as review comments.

## Web report and local server

- **Single user, single session.** One token per run, no multi-user auth, no TLS, loopback by default.
- **Chat history is in memory**, not persisted with the review.
- **The standalone HTML export is read-only.** Chat, apply and verify are answered with an explicit capability
  statement.
- **No light theme.**
- **No side-by-side diff of two reviews in the UI.** `diffwise compare` prints it.

## CLI

- **No shell completion generation.**
- **`--serve` is a foreground process.** No daemon mode.
- **No progress bar for the AI stage.** Stage names stream to stderr.
- **A fully cached review finishes in about a second**, so progress output is not meaningful for it; this is expected,
  not a bug.
- **Windows is not verified.**

## MCP

- **stdio only.** No HTTP/SSE transport for the server.
- **No push notifications.** An agent polls `get_review_status`.
- **Audit log is append-only JSONL** with hashed arguments; there is no log rotation or retention policy.
- **No per-tool permission model.** Every tool the server registers is available to any client that can connect; there
  is no allow-list to restrict a subset.

## AI review

- **Two AI paths still exist.** `ReviewSession` (specialised reviewers, verification opinions, fix generation) and the
  older `AiReviewer` enricher both call models. `review.ai` reports whichever one ran, but they are not yet one
  implementation; unifying them is the prerequisite for per-reviewer routing and for a single cost model.
- **`ai.required` is enforced by exit code, not by the editor.** `diffwise review --ai-required` exits `11`; the VS Code
  panel shows a banner and marks the review partial but does not block the workspace.
- **No incremental analysis.** Every run re-parses, re-graphs and re-rules the changed files. Model answers are cached
  by exact prompt, but the deterministic half is recomputed each time.
- **No semantic cache.** Only exact-prompt reuse is implemented. A near-duplicate prompt is a cache miss, which is the
  conservative choice: replaying an answer against different context is how review systems start lying.
- **No retrieval beyond the first hop.** Reviewer context includes the diff, the changed files' changed regions,
  directly impacted files, deterministic findings and intent. Related tests and documentation passages are referenced
  but not included wholesale.
- **Verification depth is bounded by call count** (`maxVerificationCalls`), not by a token or cost ceiling. A review
  with many findings can still spend most of its input tokens on verification opinions; `--max-cost` catches it after
  the fact rather than trading depth for budget in advance.
