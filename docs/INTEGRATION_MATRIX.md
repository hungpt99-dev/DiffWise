# Integration matrix

What each interface can do, what it delegates, and how it is verified. `native` means the interface implements it (UI,
formatting, transport); `delegated` means it calls `DiffWiseService`; `absent` means it does not exist and is not
pretended.

## 1. Capability matrix

| Capability | VS Code | CLI | MCP | CI (workflow) |
|---|---|---|---|---|
| Run a review | delegated (`service.review`) | delegated (`review`) | delegated (`run_review`) | delegated (`diffwise review`) |
| Target selection | native UI (working, staged, branch, commits, files) | native flags/positionals | tool arguments | workflow inputs (base/head) |
| Policy + rule packs | delegated | delegated | delegated | delegated |
| Reviewer selection / AI verification | delegated | delegated | delegated | delegated |
| Usage + cost reporting | native panel | native summary + `--max-cost` | envelope `aiUsage` + `costLimit` | artefact + exit code 10 |
| Answer cache | delegated (shared store dir) | delegated | delegated | reused via runner cache |
| Findings browsing | native (tree view, diagnostics, CodeLens) | `findings`, `show`, `--json` | `get_findings`, `get_finding`, … | SARIF in code scanning |
| Architecture / impact | native (interactive graph) | `--format json` envelope | `get_affected_components` | — |
| Fix preview / apply / revert | native dialogs + delegated apply | `fix` (with `--apply --yes`) | `suggest_fixes`, `apply_fix` | — (deliberately) |
| Verification execution | native consent + delegated run | `verify` | `run_verification` | `verification.command` |
| Chat | native panel + delegated | `chat` | — | — |
| History | native tree + quick pick | `history`, `report <id>` | `get_review_history` | artefacts |
| Configuration | VS Code settings as override layer; files read by the service | `config list/get/set/validate` | reads only | file written by the workflow |
| Quality gate | shown in report, not enforced | enforced (`--fail-on`, exit 1) | not enforced | enforced (step fails) |
| Cancellation | native (SIGINT-like abort) | SIGINT | per-request abort in the server | job timeout |
| SARIF | — | `--format sarif` | envelope only | uploaded |
| Human decisions / approvals | recorded by the service, no UI yet | `policy`/decision commands | `record_human_decision` | — |

## 2. Contracts shared by all interfaces

| Contract | Producer | Consumers | Stability |
|---|---|---|---|
| `ReviewReport` schema v3 | `core/report/schema` | all | migrations v1→v3 provided |
| Envelope `1.0` (+`aiUsage`, +`costLimit` where applicable) | `core/report/envelope` | MCP, CLI `--format json`, agents | additive only |
| Finding identity (`stableId`) | `core/util/text` | all | stable for the same file/line/title |
| Review identity + index | `core/store` | VS Code history, CLI, MCP | stable |
| Exit codes | `cli/src/exit.ts` | CI, scripts | append-only (`10` added; no renumbering) |
| SARIF 2.1.0 | `core/report/sarif` | code scanning | validated by `validateSarif` |
| MCP tool schemas | `mcp/src/server.ts` + `tools/*` | agents | v1 surface preserved |

## 3. Configuration resolution per interface

| Interface | Provider/key | Analysis limits | Policy/rules | Verification command |
|---|---|---|---|---|
| CLI | `config.json` + env | `config.json` + flags | files | `config.json` |
| MCP | `config.json` + env | `config.json` | files | `config.json` |
| CI | env secrets | `config.json` written by the job | files | `config.json` |
| VS Code | VS Code settings (machine-local, secret-adjacent) | settings **override** the file; only explicitly set values are passed | files | settings override |

Every review records the merged `settings` snapshot, so a report always states which configuration produced it.

## 4. Where the same change was reviewed four ways

| Check | Result | Evidence |
|---|---|---|
| CLI vs MCP: same finding ids, severities, locations, verdicts | identical | `packages/mcp/test/interface-parity.test.ts` |
| Service path vs core-only path (what the extension used to run) | core path had no policy, no reviewer selection, no per-task usage | `packages/app/test/interface-parity.test.ts` |
| Settings override is applied and recorded, and does not leak between runs | verified | same file |
| Custom storage directory honoured end to end (write + list + read) | verified | same file |
| VS Code executes through the service | enforced by construction: `runReview`/`applyPatch`/`runVerificationCommand`/`openStore` no longer appear in `apps/vscode/src` | `grep` + typecheck |
| VS Code renders a review created by the CLI | 8 extension-host checks on Xvfb, screenshot recorded | `npm run e2e:vscode`, `docs/screenshots/vscode-e2e.png` |
| A review started in VS Code is readable by the CLI, with policy/verification/AI usage | editor-initiated review `20261101-145116-954664` listed by `diffwise history` | `npm run e2e:vscode:trigger` + recorded report |
| Webview still renders every section after the change | 32 E2E checks | `npm run test:e2e` |

## 5. Known interface gaps (stated, not hidden)

| Gap | Interface | Why it exists | Next step |
|---|---|---|---|
| Extension-host E2E is not part of `npm test` | VS Code | it needs a display and a running Extension Development Host | add Xvfb + host launch to CI (`npm run e2e:vscode`) |
| No decision/approval UI | VS Code | approvals are computed and stored, no panel controls | roadmap P4 |
| GitLab job not executed on a real runner | CI | YAML validated only | try in a real project |
| No PR inline comments | CI | findings are published as SARIF/artefacts, not review comments | roadmap P4 |
| No per-tool permissions | MCP | documented limitation; all registered tools are available to any client | roadmap P2 |
| Editor reviews now run the full policy pipeline | VS Code | parity was the goal; with AI this is slower than the old single prompt | lower `reviewers.maxReviewers` in policy, or rely on the cache |
