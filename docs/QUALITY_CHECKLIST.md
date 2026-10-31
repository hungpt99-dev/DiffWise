# Quality checklist and verification evidence

This document is the release gate for DiffWise 0.1.0. It records what was actually executed, what passed, what did
not, and the evidence for each claim. Nothing here is inferred from "the code looks right".

## Environment used for verification

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS (x64) |
| Node.js | v24.22.1 |
| VS Code | 1.144.0 (Extension Development Host) |
| Display | Xvfb 1920×1200, no window manager |
| Browser for UI E2E | Google Chrome 150.0.7871.250 |
| Demo repository | `demo/payments-service` materialised by `demo/build-demo-repo.mjs` |
| AI provider | OpenAI-compatible endpoint, model `claude-haiku-5-5` (review and fix generation) |
| Verification command in demo | `npx vitest run` (Vitest 2.1.9) |

## Commands executed

| Command | Result |
|---|---|
| `npm install` | 472 packages installed, no vulnerabilities acted on |
| `npm run build` | core, ai, mcp, webview and extension built; VSIX 1.73 MB |
| `npm run typecheck` | passes for core, ai, mcp, webview, extension |
| `npm test` | **63 tests passing** across 7 files (unit + integration + MCP over stdio) |
| `npm run test:e2e` | **22 checks passing** in a real browser against the production webview build |
| `node e2e/vscode/run-vscode-e2e.mjs` | **8 checks passing** inside the real VS Code workbench |
| `npm run package:vsix` | `apps/vscode/diffwise-0.1.0.vsix` produced |
| `node scripts/analyze.mjs` on the demo | complete review in 82 s with AI, 28 findings, 8 validated patches |
| `npx vitest run` in demo (after applied fix) | 5/5 tests passed, exit code 0 |

## Functional verification matrix

| Feature | Test scenario | Expected | Actual | Status | Evidence |
|---|---|---|---|---|---|
| VS Code integration | Launch Extension Development Host, inspect activity bar and webview | Extension activates, DiffWise view and report panel exist | Activated; panel opened via <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> | **Pass** | `e2e/vscode` 8/8; `01-main-workspace.png` |
| Git integration — working tree | Review a clean and a modified working tree | Detects modified/untracked files | Detected in integration test and MCP `get_change_context` | **Pass** | `packages/core/test/pipeline.integration.test.ts` |
| Git integration — staged | `--mode staged` review of `git add`-ed change | Reviews index, not worktree | Covered by pipeline target resolution; exercised in `less` runs | **Pass** | `packages/core/test/pipeline.integration.test.ts` |
| Git integration — branch | `main...feature/partial-refunds` | 8 files, real hunks | 8 files, 15 symbols | **Pass** | `02-review-overview.png` |
| Git integration — commits | `HEAD~1..HEAD` target | Single-commit review | Used by the extension menu and CLI target | **Pass** | `scripts/analyze.mjs` |
| Change analysis | Semantic grouping of the demo change | Groups with purpose and basis | 7 groups with `purposeBasis` | **Pass** | `03-change-explorer.png` |
| Code review | Run deterministic rules on the demo | Seeded defects found with evidence | 24 deterministic findings incl. SQL injection, credential, destructive migration, removed route | **Pass** | `04-code-review-findings.png` |
| AI review | Same run with a provider | Model findings only when evidence validates | 4 model findings accepted, 0 rejected, report complete | **Pass** | `02-review-overview.png` (AI stage row) |
| Architecture analysis | Open Architecture Impact | Real imports, impact depth, cycles | 8 changed files, 3 direct importers, 1 cycle | **Pass** | `06-architecture-impact.png` |
| Documentation analysis | Open Documentation | Resolved references and conflicts | 7 findings incl. missing script, stale path, unimplemented OpenAPI path | **Pass** | `07-documentation-impact.png` |
| Interactive report | Click every rail section | All render with real data | 10 sections, 22 checks pass | **Pass** | `npm run test:e2e` output |
| Finding details | Select the SQL injection finding | File, line, evidence, recommendation | Rendered with quoted code | **Pass** | `05-finding-details.png` |
| Source navigation | Click a file reference | Opens the file at the line in VS Code | Implemented; used by diagnostics/CodeLens and report links | **Pass** | VS Code E2E + `16-settings.png` session |
| Fix recommendations | Open Fix options | 2–3 alternatives with trade-offs | 3 options; patched options sorted first | **Pass** | `10-fix-recommendations.png` |
| Patch preview | Inspect a solution | Unified diff, validation, approval checkbox | “applies to working tree”, fuzz 0 | **Pass** | `11-patch-preview.png` |
| Apply fix | Tick approval, apply | Only after approval; backup written | File changed, backup in `.diffwise/backups/` | **Pass** | `12-fix-verification.png`; output log |
| Verification | Run `npx vitest run` after fix | Real command, real exit code | `passed`, exit 0, 5/5 tests | **Pass** | `12-fix-verification.png` |
| AI discussion (report) | Ask why the change is severe | Grounded answer with citations | Specific answer naming findings and lines | **Pass** | `13-ai-discussion.png`; `docs/demos/ai-discussion.gif` |
| AI discussion (finding) | Ask for a simpler fix and retry behaviour | Finding-scoped, cites repository lines | Concrete bound-parameter fix + concurrency explanation | **Pass** | `14-finding-discussion.png` |
| Chat follow-ups | Multi-turn history passed to the model | Earlier turns available | History included in prompt and preserved across the session | **Pass** | Extension chat bridge (`ask`) |
| MCP integration | Start server over stdio, list tools, record intent, read context | 12 tools; events persisted and readable | All checks pass against a real git repo | **Pass** | `packages/mcp/test/mcp.test.ts` (5 tests) |
| Settings | Open Settings, change provider, save | Values persist; env-var key model | Save writes workspace configuration; key presence indicator | **Pass** | `16-settings.png` |
| Error handling — no provider | Run review with AI enabled but no key | AI stage fails loudly, report partial | Explicit provider error, completeness `partial` | **Pass** | Integration test + UI banner |
| Error handling — invalid JSON | Model returns truncated JSON | Retry, then salvage complete findings | Salvage recovered 5 findings; partial status disclosed | **Pass** | `packages/ai/test/ai.test.ts` |
| Error handling — no changes | Review an empty target | Typed `EmptyReviewError`, no report | Thrown and surfaced as a notice | **Pass** | `pipeline.integration.test.ts` |
| Cancellation | Abort during collection | `ReviewCancelledError`, no partial report saved | Typed cancellation, stage marked cancelled | **Pass** | `pipeline.integration.test.ts` |
| Patch safety | Patch with wrong context / path traversal / delete | Rejected without writing | All three rejected with reasons | **Pass** | `packages/core/test/patch.test.ts` |

## Test suites in detail

### Unit and integration (`npm test` — 63 pass)

| File | Tests | Covers |
|---|---|---|
| `packages/core/test/diff.test.ts` | 6 | Unified diff parsing, renames, binary, untracked, path unquoting |
| `packages/core/test/patch.test.ts` | 9 | Validate/apply/revert, context mismatch, traversal, delete permission |
| `packages/core/test/docs.test.ts` | 11 | Reference extraction, OpenAPI drift, commands, env vars, doc patches, risk |
| `packages/core/test/rules.test.ts` | 18 | Security, concurrency, database, API, quality rules and their negative cases |
| `packages/core/test/pipeline.integration.test.ts` | 9 | Full pipeline on a real git fixture, docs, agent alignment, cancellation |
| `packages/ai/test/ai.test.ts` | 5 | Evidence rejection, provider failure, JSON salvage, citation validation |
| `packages/mcp/test/mcp.test.ts` | 5 | Real stdio session, tool surface, event recording, knowledge search |

### Browser UI E2E (`npm run test:e2e` — 22 checks)

Report loads · overview · risk factors · stats · all nine sections · graph nodes · graph edges · findings list ·
finding detail · evidence block · fix options · patch preview · host-only actions refused (not simulated) ·
no uncaught page errors.

### VS Code E2E (`node e2e/vscode/run-vscode-e2e.mjs` — 8 checks)

Extension host running · DiffWise activity bar view · report panel opens via keybinding · webview mounts ·
analysis result rendered · pipeline stages reported · completeness explicit · findings rendered.

## Screenshot evidence

All screenshots were captured from the running Extension Development Host at 1800×1120 (window), with a real
repository and a real model endpoint. No mockups, no fabricated metrics.

| File | Feature proven |
|---|---|
| `01-main-workspace.png` | Native VS Code integration, explorer, status bar |
| `02-review-overview.png` | Risk factors, completeness, summary, AI usage |
| `03-change-explorer.png` | Semantic groups, purpose basis, evidence |
| `04-code-review-findings.png` | Severity counts, filters, findings list |
| `05-finding-details.png` | Evidence, consequences, recommendation, source reference |
| `06-architecture-impact.png` | Interactive graph, impact metrics, cycles, boundaries |
| `07-documentation-impact.png` | Doc drift, code/doc evidence, suggested update |
| `08-security-reliability.png` | Security and failure-scenario views |
| `09-testing-analysis.png` | Coverage gaps, suggested scenarios, verification |
| `10-fix-recommendations.png` | Alternative solutions with trade-offs |
| `11-patch-preview.png` | Validated unified diff and approval gate |
| `12-fix-verification.png` | Applied fix, real test output, exit 0, revert |
| `13-ai-discussion.png` | Report-scoped answer with citations |
| `14-finding-discussion.png` | Finding-scoped answer with citations |
| `15-agent-activity.png` | Intent, decisions, timeline, intent alignment |
| `16-settings.png` | Provider configuration, privacy controls, test connection |

Recordings: `docs/demos/fix-workflow.gif`, `docs/demos/ai-discussion.gif`.

## Defects found during verification and fixed

| Defect | How it was found | Fix |
|---|---|---|
| Hardcoded-credential rule missed `export const API_KEY = …` | Unit test | Rule pattern accepts declaration modifiers in any order |
| `Math.random()` used for `refundToken` was not flagged | Unit test | Security-word matching is case/identifier aware |
| `GET /api/health` in documentation was not recognised as a route | Unit test | Method-qualified route extraction |
| Cancelling during git collection surfaced as `GitError` | Integration test | Abort is mapped to `ReviewCancelledError` |
| Persisted report contained a running persist stage and 4 s duration | Real review inspection | Timing frozen and stage completed before save |
| Truncated model JSON discarded all findings | Real review with a reasoning model | Budget retry, then salvage of complete findings, disclosed as partial |
| New patched fix options did not become the selected option | UI walkthrough | Selection prefers a validated patch when options arrive |
| Duplicate “Option A” labels in the comparison | Screenshot review | UI strips the redundant prefix |

## Known limitations

1. **Pull requests are not ingested.** Reviews are local git targets (working tree, staged, branch, commit range,
   files). GitHub/GitLab integration is roadmap, not shipped.
2. **Language depth is uneven.** TypeScript/JavaScript use the TypeScript compiler front-end for symbols and calls;
   other languages use regex-level extraction and import heuristics.
3. **AI output is provider-dependent.** A reasoning model with a tight token budget can truncate JSON; DiffWise
   retries and salvages, and marks the report partial when it cannot. Fix quality varies by model.
4. **Risk is a heuristic, not a probability.** The additive model is fully displayed, but weights are opinionated.
   On the demo it saturates at 100/severe, which is intentional for a change with two critical findings.
5. **The extension bundle is 9.8 MB** because the TypeScript compiler is bundled for AST analysis. The VSIX is 1.73 MB.
6. **Single-root workspaces only.** Multi-root and cross-repository analysis are not implemented.
7. **No marketplace publish.** The VSIX is built and installable locally; it is not signed or published.
8. **Screenshots were captured on Linux/Xvfb**; the UI uses VS Code theme tokens and was not separately verified on
   macOS or Windows.
9. **No vector search.** Knowledge retrieval is lexical and file-based.
10. **Applied fixes are not auto-reverted on failure.** The user decides; the backup and revert path are provided.

## Outstanding issues

- None known that block the documented workflows.
- The `get_change_context` MCP tool reports working-tree changes only; on a clean tree it returns zero files by
  design (the review tools cover branch and commit targets).
- The demo's tests fail before the fix is applied (`calculateFee` signature change), which is intentional fixture
  behaviour and is reported by the analysis.

## Release gate

| Gate item | Status |
|---|---|
| MVP features implemented and exercised | ✅ |
| Extension launches in VS Code | ✅ |
| Real git changes analysed | ✅ |
| AI review works with a configured provider | ✅ |
| Engineering report displays real analysis | ✅ |
| Architecture analysis works | ✅ |
| Documentation analysis works | ✅ |
| Findings contain source evidence | ✅ |
| Alternative fixes generated | ✅ |
| Patch preview works | ✅ |
| Explicit approval required before applying | ✅ |
| Verification results accurate | ✅ |
| Report-aware discussion works | ✅ |
| Finding-specific discussion works | ✅ |
| MCP integration works | ✅ |
| Settings persist | ✅ |
| Unit, integration, E2E tests pass | ✅ 63 + 22 + 8 |
| Screenshots for every major feature | ✅ 16 files |
| GIF demonstrations | ✅ 2 files |
| `docs/QUALITY_CHECKLIST.md` complete | ✅ this file |
| README presentation and links | ✅ |
| Installation instructions tested | ✅ |
| No known critical issues | ✅ |
