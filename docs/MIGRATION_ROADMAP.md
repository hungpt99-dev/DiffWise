# Migration and delivery roadmap

This is the ordered plan for the interface unification, with what has actually landed. Status values: **done**
(implemented, tested, evidence recorded), **partial**, **not started**.

## 0. What changed for users (0.4.x → 0.5.0)

Nothing breaks, but two behaviours change on purpose:

1. **A VS Code review is now the same review CI runs.** It applies `.diffwise/policy.json`, rule packs, reviewer
   selection and independent verification, and records usage. With a provider configured this is more thorough and
   slower than the old single-prompt review; with AI off it is the same deterministic report as before plus policy and
   approvals. To keep editor reviews quick: set `reviewers.maxReviewers: 1` in policy, or let the answer cache serve
   repeated reviews.
2. **Two CLI capabilities are new:** `diffwise config validate` and `diffwise review --max-cost <usd>` (exit code `10`).
   Exit codes were not renumbered; `10` was appended.

`storage.directory` in VS Code settings is now honoured by the service itself, so a custom store directory and a
standard `.diffwise` cannot silently diverge.

## P0 — Shared execution path (VS Code)

| Step | Status | Evidence |
|---|---|---|
| Audit: prove the extension ran its own pipeline | **done** | `INTERFACE_STRATEGY.md` §2; `interface-parity.test.ts` |
| `ReviewRunOptions.settings` as an override layer, recorded in the report | **done** | `packages/app/src/service.ts`; parity tests |
| `DiffWiseService.setProviders` for settings changes | **done** | service method; used by `saveSettings` |
| `DiffWiseService.verify({command, timeoutMs, approvedBy})` | **done** | service; parity test records `approvedBy: 'web'` |
| Extension: review, apply, revert, verify, chat, fix generation, history through the service | **done** | `apps/vscode/src/extension.ts`; `grep` shows no `runReview`/`applyPatch`/`openStore` |
| Delete the duplicated verification executor and file loader from the extension (76 lines) | **done** | `apps/vscode/src/support.ts` |
| Storage directory shared instead of duplicated | **done** | `ServiceOptions.storageDir` + parity test |
| Typecheck, build, webview E2E after the change | **done** | see `QUALITY_CHECKLIST.md` |

| Extension-host E2E executed on Xvfb (8 checks) and a review triggered from the palette | **done** | `npm run e2e:vscode`, `npm run e2e:vscode:trigger`; `QUALITY_CHECKLIST.md` §cross-interface |

Not done in P0: a decision/approval UI. The extension-host E2E is executed but not part of `npm test` (it needs a
display and a launched host).

## P1 — CLI as a first-class execution interface

| Step | Status | Evidence |
|---|---|---|
| `config validate` (human + `--json`, exit `3` on errors) | **done** | `packages/cli/src/commands/project.ts`; `interface-contracts.test.ts` |
| `--max-cost <usd>` with exit `10`, refusing when no prices are configured | **done** | `commands/review.ts`; `interface-contracts.test.ts`; real run recorded at $34.9150 > $0.01 |
| `config set` accepts JSON objects and optional keys (`pricing`) | **done** | `coerce`/`setPath`; the documented pricing workflow was previously impossible |
| Value-flag parsing for new numeric flags | **done** | `args.ts` (`max-cost`), regression covered by tests |
| Token budgets as CLI flags (`--max-input-tokens`) | **not started** | budget is configured (provider/context), not per-flag; no measured need yet |
| Progress reporting, cancellation, JSON envelope, SARIF | already existed | `cli.e2e.test.ts` (23) |

## P2 — MCP as an agent interface

| Step | Status | Evidence |
|---|---|---|
| 42 tools over the service, v1 surface preserved | already existed | `mcp/test/*` (34 tests) |
| `run_review.maxCostUsd` with a structured `costLimit` result | **done** | `server.ts`; `interface-parity.test.ts` |
| Correct tool annotations (`run_review` is not read-only: it writes a report) | **done** | same |
| Bounded responses, audit log, explicit destructive arguments | already existed | `audit.ts`, `platform-tools.test.ts` |
| Per-tool permission model | **not started** | documented limitation |
| Tool-level token/time bounds advertised to agents | **not started** | next: expose the reviewer/verification budget in the tool description |

## P3 — CI/CD automation

| Step | Status | Evidence |
|---|---|---|
| GitHub workflow: merge-base checkout, deterministic review, SARIF, artefact, gate | already existed | `.github/workflows/diffwise-review.yml` |
| Copyable GitHub Actions example | **done** | `docs/examples/github-actions.yml` (YAML validated) |
| Copyable GitLab CI job with cache, artefacts, exit-code handling | **done** | `docs/examples/gitlab-ci.yml` (YAML validated) |
| Cost limits in CI | **done** | `docs/CI_CD.md` §cost limits; workflow comment |
| Executed on a real GitLab runner | **not started** | YAML only |
| PR inline comments / check-run publishing | **not started** | roadmap P4 |

## P4 — Cross-interface history and team workflows

| Step | Status | Evidence |
|---|---|---|
| One review identity and index for every interface | **done** | shared store; `diffwise history`; VS Code history tree |
| Stable finding ids across interfaces and runs | **done** | CLI vs MCP parity test; id stability test |
| Configuration differences recorded per report | **done** | `report.settings` snapshot + override tests |
| Approvals/decisions surfaced in the editor | **not started** | service records them; panel has no controls |
| Multi-root workspaces / cross-repository reviews | **not started** | service is per-root by design |

## Compatibility notes

- **Report schema**: unchanged (v3). New fields are additive (`ai.byTask`, `ai.cost*`, envelope `aiUsage`/`costLimit`).
- **Exit codes**: appended `10`; `0–9` keep their meaning.
- **MCP surface**: no tool removed or renamed; `run_review` gained an optional argument.
- **VS Code settings**: unchanged names; `storage.directory` now also governs the service store.
- **Config**: `cache`, `review.timeoutMs`, `pricing` remain optional; `config validate` reports rather than rewrites.

## Ordered next five

1. **Approvals in the editor** — the service computes them; the panel shows policy state but no decision controls.
2. **Editor latency profile** — a documented policy preset (fewer reviewers, verification depth) for interactive use,
   recorded in the report so parity differences are explicit.
3. **MCP tool budgets** — advertise and enforce token/time ceilings per tool so agents can plan.
4. **GitLab verification on a real runner** — the template is unexecuted.
5. **Put the extension-host E2E in CI** — it runs (`npm run e2e:vscode`) but is not wired into a workflow yet.
