# Contributing to DiffWise

Thanks for considering a contribution. DiffWise is a review tool, so the bar for its own changes is the same bar it
applies to code: evidence, tests and honest documentation.

## Setup

```bash
git clone https://github.com/hungpt99-dev/DiffWise.git
cd DiffWise
npm ci
npm run build           # required first: workspaces type against built declarations
npm run typecheck       # 7 workspaces
npm test                # 343 tests, 28 files
npm run test:e2e        # 32 browser checks against the built report UI
npm run demo            # materialises /tmp/diffwise-demo
npm run verify          # build + typecheck + tests, the same order CI uses
```

The VS Code E2E needs a real Extension Development Host with remote debugging; see
[`e2e/vscode/run-vscode-e2e.mjs`](e2e/vscode/run-vscode-e2e.mjs) for the exact launch command, and
`npm run e2e:vscode` / `npm run e2e:vscode:trigger` once it is running (Xvfb works).

## Ground rules

1. **Do not break the evidence contract.** A finding without a file, a line and repository text is not acceptable.
2. **Do not add fake functionality.** A button that cannot work must be removed or clearly marked. A failed stage
   must be reported as failed or partial.
3. **Keep the deterministic engine independent.** `packages/core` must not import VS Code or the AI package.
4. **Preserve the provider abstraction.** New model features go behind `LlmProvider`.
5. **Tests come with behaviour.** A rule, a parser, a patch operation or a protocol change needs a test.
6. **Never commit secrets.** `.env`, keys and tokens are ignored; reports are generated locally.

## Adding a rule

1. Pick the family in `packages/core/src/rules/` (security, concurrency, database, api, quality, architecture).
2. Implement the `Rule` interface: `id`, `category`, `run(ctx)` returning `CandidateFinding[]`.
3. Fire only on added lines (or on symbol/contract deltas), and attach `codeEvidence` or `diffEvidence`.
4. Avoid duplicate reporting: one finding per defect, with the most specific location.
5. Add a positive test and a negative test in `packages/core/test/rules.test.ts`.
6. If the rule needs a new category, add it to `FindingCategory` and `CATEGORY_LABEL`.

## Adding a provider

1. Implement `LlmProvider` in `packages/ai/src/providers.ts` (or a new file).
2. Set honest capabilities (`jsonMode`, `streaming`, `maxContextTokens`).
3. Apply the timeout, retry and scrubbed-error pattern used by the existing adapters.
4. Register it in `createProvider` and document it in `docs/CONFIGURATION.md`.
5. Add a test with a stubbed `fetch`; never call a real endpoint in tests.

## Adding an MCP tool

1. Register it in `packages/mcp/src/server.ts` with a zod schema and a clear description ending in the interface
   version.
2. Return `jsonResult` or `errorResult`; never throw across the protocol boundary.
3. Add an integration test in `packages/mcp/test/mcp.test.ts`.

## UI changes

- Reuse the design tokens in `packages/webview/src/styles.css`; do not introduce one-off colors.
- Every new state needs a loading, empty, error and partial variant where applicable.
- Sections must remain readable at 1100 px and usable at 760 px.
- Update the relevant screenshot in `docs/screenshots/` if the UI changes materially, and re-run `npm run test:e2e`.

## Commit and PR

- Small, focused commits with an imperative subject (`Fix cancellation error type`).
- Describe **what changed, why, and how it was verified**.
- Include the commands you ran and their results.
- UI changes: attach a before/after screenshot captured from the running extension.
- Do not include generated reports, `.diffwise/` contents, keys or VSIX files.

## Code style

- Strict TypeScript; no `any` unless unavoidable and justified.
- Prefer small modules and explicit interfaces over clever abstractions.
- Comment the *why* for non-obvious decisions; do not narrate the code.
- No new runtime dependency without a paragraph in the PR explaining the trade-off.

## Reporting bugs

Use the issue template. Include: VS Code version, OS, provider/model, the review target, the report id
(`.diffwise/reviews/<id>.json`), and what you expected versus what happened. Redact keys and proprietary code.

Security issues: see [SECURITY.md](SECURITY.md).
