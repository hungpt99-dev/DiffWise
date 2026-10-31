# Limitations

DiffWise 0.1.0 is a working product with a deliberately bounded scope. This file lists what it does not do, so the
documentation never implies more than the implementation provides.

## Review targets

- **No pull-request ingestion.** GitHub/GitLab PR and MR reviews are not implemented. Targets are local: working
  tree, staged, branch comparison, commit range, selected files.
- **Single repository.** Multi-root workspaces and cross-repository analysis are not supported.
- **Git only.** No Mercurial, SVN or Jujutsu.

## Language analysis

- **TypeScript/JavaScript** use the TypeScript compiler front-end: symbols, class members, imports, call expressions,
  signature changes.
- **Python, Java, Kotlin, Go, Rust, C#, Ruby, PHP** use regex-level symbol extraction. Imports are not resolved into
  the graph for these languages, so architecture impact is limited.
- **No type inference or cross-file type checking.** A signature change is detected, but whether every caller still
  compiles is not proven.
- **Minified, generated and very large files** are skipped by configuration.

## AI behaviour

- Output quality depends on the configured model. Small models produce fewer, weaker findings and less reliable
  patches.
- Reasoning models can exhaust `maxTokens` on hidden reasoning. DiffWise retries, salvages complete findings and marks
  the report partial, but a larger budget is the real fix.
- Fix diffs sometimes do not apply. They are discarded by validation and counted; they are never shown as applicable.
- The chat cannot see files outside the report context and the bounded excerpt set.
- No streaming responses. Requests are single-shot with a hard timeout.

## Architecture and risk

- The import graph covers resolved relative imports in JS/TS. Package imports, path aliases that are not relative,
  dynamic imports computed at runtime, and dependency injection wiring are not resolved.
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

## Fixes

- Fix generation targets the top few actionable findings, not every finding.
- Patches are unified diffs with context matching; there is no three-way merge.
- Applying a patch does not compile or test automatically. Verification is a separate, explicit step.
- Reverting restores the backup written at apply time. Changes made after the patch are not merged.

## Platform and packaging

- The extension is verified on Linux (VS Code 1.144.0, Xvfb). macOS and Windows are expected to work through theme
  tokens and standard APIs but were not separately verified.
- The VSIX is built locally and is not signed or published to a marketplace. Installation requires
  `code --install-extension`.
- The extension bundle is 9.8 MB because it embeds the TypeScript compiler; the VSIX is 1.73 MB compressed.
- No telemetry. No automatic update check.

## Integrations

- No Jira, Confluence, Slack, CI provider, observability or runtime context integration.
- MCP interface v1 covers agent events and read-only context; it does not expose a review-run tool.
- Knowledge retrieval is lexical; there are no embeddings or vector store.
