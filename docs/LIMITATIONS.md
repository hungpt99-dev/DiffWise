# Limitations

DiffWise 0.2.0 is a working product with a deliberately bounded scope. This file lists what it does not do, so the
documentation never implies more than the implementation provides. "Not supported" here means exactly that: there is
no hidden half-implementation behind it.

## Review targets

- **No pull-request ingestion.** GitHub/GitLab PR and MR reviews are not implemented. Targets are local: working
  tree (including untracked files), staged changes, branch comparison, a single commit, selected paths.
- **Single repository.** Multi-root workspaces and cross-repository analysis are not supported.
- **Git only.** No Mercurial, SVN or Jujutsu.
- **No history rewriting awareness.** Force-pushed or rebased branches are reviewed as they are now.

## CLI

- **No shell completion generation** (bash/zsh/fish). `diffwise help` is the discovery mechanism.
- **No plugin commands.** The command set is fixed; `--patch-file` covers "bring your own patch".
- **`--serve` is a foreground process.** There is no daemon mode and no auto-restart; Ctrl+C stops it.
- **Cancellation is between stages.** A model request already in flight is aborted, but a `git` process in a very
  large diff is only interrupted at the next stage boundary.
- **No progress bar for the AI stage.** Stage names stream to stderr; there is no token-level progress (the provider
  API used does not stream).
- **Windows is not verified.** The CLI uses `git`, `xdg-open`/`open`/`cmd start` and PATH lookups; the code paths
  exist, but only Linux was executed for the evidence in this repository.

## Language analysis

- **TypeScript/JavaScript** use the TypeScript compiler front-end: symbols, class members, imports, call expressions,
  signature changes.
- **Python, Java, Kotlin, Go, Rust, C#, Ruby, PHP** use regex-level symbol extraction. Imports are not resolved into
  the graph for these languages, so architecture impact is limited to changed files.
- **No type inference or cross-file type checking.** A signature change is detected, but whether every caller still
  compiles is not proven.
- **Minified, generated and very large files** are skipped by configuration.
- **Spring-specific modelling** (bean graph, `@Transactional` propagation, Kafka topology) is not implemented; route
  and annotation extraction is textual.

## AI behaviour

- Output quality depends on the configured model. Small models produce fewer, weaker findings and less reliable
  patches. Reasoning models can take minutes on a large diff; the run is bounded by `provider.timeoutMs`.
- Reasoning models can exhaust `maxTokens` on hidden reasoning. DiffWise retries, salvages complete findings and marks
  the report partial, but a larger budget is the real fix.
- Fix diffs sometimes do not apply. They are discarded by validation and counted; they are never shown as applicable.
- The chat cannot see files outside the report context and the bounded excerpt set.
- **No streaming responses.** Requests are single-shot with a hard timeout.
- **No token/cost accounting for most providers.** Token counts are recorded when the provider returns them; a price
  is not computed.

## Architecture and risk

- The import graph covers resolved relative imports in JS/TS. Package imports, non-relative path aliases, dynamic
  imports computed at runtime and dependency-injection wiring are not resolved.
- Call edges are inferred only when a name maps to exactly one exported definition; everything else is omitted rather
  than guessed.
- Framework conventions (NestJS modules, Spring beans, Rails autoloading) are not modelled.
- The risk score is an additive heuristic, not a probability. On a change with two critical findings it saturates at
  100/severe; the factor breakdown is the useful part.
- Conventions are measured from file patterns; they are descriptive, not authoritative.

## Documentation analysis

- Resolution is reference-based: symbols, file paths, commands, routes, environment variables. Prose that is merely
  wrong without a resolvable reference is not detected.
- OpenAPI checks compare paths with route declarations; schema-level compatibility is not analysed.
- Documentation patches are previews for simple substitutions; DiffWise does not rewrite prose.

## Testing

- Coverage is resolved by path, basename and imports, not by runtime coverage data.
- No coverage report ingestion (lcov, Istanbul).
- Verification runs exactly one configured command. It does not discover or select related tests.
- A passing command is reported as a passing command, never as proof that a fix is correct.
- **Verification is opt-in.** Without `verification.command`, `diffwise verify` and the UI's run button report
  `not-run` and exit `6`; nothing is executed by default.

## Fixes

- Fix generation targets the top few actionable findings, not every finding.
- Patches are unified diffs with context matching; there is no three-way merge.
- Fuzzy context matches are refused at apply time (the API can allow them, the CLI does not).
- Applying a patch does not compile or test automatically. Verification is a separate, explicit step.
- Reverting restores the backup written at apply time. Changes made after the patch are not merged.
- **No automatic conflict resolution.** A stale patch is refused, not rebased.

## Web report and local server

- **Single user, single session.** The server issues one session per run; there is no multi-user auth, no TLS and no
  remote access by design (non-loopback binding requires `--allow-public` and prints a warning).
- **Chat history is in memory.** It is not persisted with the review, so reloading the page starts a fresh thread.
- **Applying a fix from the UI blocks that request** while the patch is written (milliseconds); verification can take
  as long as the configured command, up to `verification.timeoutMs`.
- **The standalone HTML export is read-only.** Chat, apply and verify are answered with an explicit capability
  statement; they are not emulated.
- **No light theme.** The report is dark-only.
- **No report-level diff of two reviews in the UI.** `diffwise compare` prints it; the UI opens one review at a time.

## MCP

- Interface v1: 8 recorders + 7 workflow tools. There is no chat tool and no report-export tool.
- Tools are stdio-only; no HTTP/SSE transport.
- Applying a fix requires both `approved: true` and a matching `confirmFindingId`; agents cannot batch-apply.
- No push notifications when a review finishes — the agent polls or re-runs.

## Platform and packaging

- Verified on **Linux** only for this release (Node 24, Chromium 1248, git 2.43). macOS and Windows code paths exist
  but were not executed for the evidence in `docs/evidence/`.
- The VS Code extension is verified through its webview build and the shared bridge; the VS Code-specific E2E needs a
  display and is documented separately.
- The VSIX is built locally and is not signed or published to a marketplace.
- No telemetry. No automatic update check.

## Integrations

- No Jira, Confluence, Slack, CI provider, observability or runtime context integration.
- Knowledge retrieval is lexical plus graph traversal; there are no embeddings or vector store, by design.
