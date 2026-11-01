# Quality checklist and verification evidence

This document is the release gate for DiffWise 0.3.0. It records what was actually executed, what passed, what did
not, and the evidence for each claim. Nothing here is inferred from "the code looks right".

## Environment used for verification

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS (x64), kernel 6.8.0-147 |
| Node.js | v24.22.1, npm 11.19.1 |
| git | 2.43.0 |
| Browser for webview E2E | Google Chrome, headless via Playwright |
| Demo repository | `demo/payments-service` materialised by `demo/build-demo-repo.mjs` |
| Evaluation corpus | `evals/` — 8 generated fixtures, 13 labelled findings |
| AI provider | none configured for the recorded runs (all results are deterministic-only) |

## Commands executed

| Command | Result |
|---|---|
| `npm run build` | exit 0 — core, ai, app, mcp, cli, webview and extension all built |
| `npm run typecheck` | exit 0 — 7 workspaces, 0 errors |
| `npm test` | exit 0 — **284 tests in 22 files** |
| `npm run test:e2e` | exit 0 — **25 checks** in headless Chromium against the production webview build |
| `npm run package:vsix` | exit 0 — `apps/vscode/diffwise-0.3.0.vsix` (9 files, 1.81 MB) |
| `npm run eval:build && npm run eval` | exit 0 — 8 cases, 13/13 findings, 0 forbidden |
| `node e2e/vscode/run-vscode-e2e.mjs` | **not executed** — needs a display; recorded below as unverified |

## Functional verification matrix

| Feature | Test / command | Expected | Actual | Status |
|---|---|---|---|---|
| Deterministic review | `packages/core/test/pipeline.integration.test.ts` | findings with evidence on a real repo | 25 findings on the demo branch | **Pass** |
| Rule packs: loading | `rulepacks.test.ts` | pack loads with provenance | id/version/path recorded | **Pass** |
| Rule packs: validation | `rulepacks.test.ts` | invalid regex/version rejected with file | errors name the file and field | **Pass** |
| Rule packs: ReDoS | `rulepacks.test.ts` | `(a+)+` rejected | rejected as nested quantifier | **Pass** |
| Rule packs: `extends` | `rulepacks.test.ts` | child inherits parent detection | detection inherited, severity overridden | **Pass** |
| Rule packs: dependency | `rulepacks.test.ts` | missing dep blocks the pack | `required pack "security" is not installed` | **Pass** |
| Declarative execution | `rulepacks.test.ts` | pattern/AST/absence/forbidden-import all fire | 4 detection types verified, negatives included | **Pass** |
| Policy precedence | `policy.test.ts` | org → repo → dir → file | last layer wins, provenance recorded | **Pass** |
| Policy suppression | `policy.test.ts` | expired suppression ignored | warning names the expiry date | **Pass** |
| Policy invariants | `policy.test.ts` | severe approval cannot be zero | forced to 1 with a warning | **Pass** |
| Reviewer selection | `review.test.ts` | ≤ cap, security for auth paths | pinned correctness + top signals | **Pass** |
| Reviewer selection cap | `review.test.ts` | never runs 8 reviewers by default | cap enforced, "ranked out" recorded | **Pass** |
| Reviewer orchestration | `review.test.ts` | parallel, per-reviewer metrics | durations and token counts recorded | **Pass** |
| Reviewer failure isolation | `review.test.ts` | one failure does not stop the rest | `failed` + others `completed` | **Pass** |
| Evidence validation | `review.test.ts`, `platform.test.ts` | fabricated quote rejected | rejected; `evidenceRejected` counted | **Pass** |
| Verification: confirm | `verification.test.ts` | static demonstration → CONFIRMED | CONFIRMED, `confidence: verified` | **Pass** |
| Verification: model-only | `verification.test.ts` | 2 agreeing models → LIKELY at most | LIKELY, method states why | **Pass** |
| Verification: fabricated | `verification.test.ts` | invented quote → REJECTED | REJECTED via `evidence.quotes` | **Pass** |
| Verification: disagreement | `verification.test.ts` | split verdict → DISPUTED | DISPUTED, both opinions kept | **Pass** |
| Verification: severity cap | `verification.test.ts` | critical + unverified → medium | capped with a printed reason | **Pass** |
| Verification: human | `verification.test.ts` | human accept beats model reject | CONFIRMED | **Pass** |
| Verification: failing test | `verification.test.ts` | recorded failure → CONFIRMED | CONFIRMED, `test` class counted | **Pass** |
| End-to-end platform | `platform.test.ts` | reviewers + verification on a real repo | 8 reviewer runs, verdicts attached | **Pass** |
| Report schema v3 | `platform.test.ts`, `contract.test.ts` | validates with no issues | 0 issues | **Pass** |
| CONFIRMED invariant | `report/schema.ts` validation | model-only CONFIRMED is invalid | validator rejects it | **Pass** |
| MCP v2 tool surface | `platform-tools.test.ts` | 42 tools, v1 preserved | all 24 added names present | **Pass** |
| MCP human decision | `platform-tools.test.ts` | state recomputed, rationale required | CHANGES_REQUESTED; missing rationale refused | **Pass** |
| MCP audit trail | `platform-tools.test.ts` | every call logged, args hashed | `.diffwise/mcp-audit.jsonl`, 16-hex hashes | **Pass** |
| CLI introspection | `diffwise rules/reviewers/policy` | explain the plan and policy | see `docs/screenshots` and CLI output | **Pass** |
| CLI evaluation | `diffwise evaluate` | measured metrics, exit 0/1 | 13/13, exit 0 | **Pass** |
| Web report sections | `npm run test:e2e` | 12 rail entries render | all 12 render | **Pass** |
| Pipeline section | `npm run test:e2e` | stages, reviewers, rules | renders with real data | **Pass** |
| Verification section | `npm run test:e2e` | verdicts, checks, evidence classes | renders with real data | **Pass** |
| Standalone actions refused | `npm run test:e2e` | host-only chat not simulated | "requires a host" banner | **Pass** |
| VS Code extension E2E | `node e2e/vscode/run-vscode-e2e.mjs` | extension host launches | **not run: no display in this environment** | **Unverified** |

## Defects found during this work and fixed

Each of these was found by executing something, not by reading code.

| Defect | How it was found | Fix |
|---|---|---|
| Verification rejected 23 of 25 valid findings as "quote not found" | Ran a deterministic review and inspected the verdict distribution | Rule evidence keeps diff markers and `NNN: ` prefixes; `cleanQuote()` normalises before matching |
| `locateQuote` failed on multi-line quotes whose first line was a bare `*/` | Unit probe against a real file | Anchor on the longest line of the quote rather than the first |
| Findings about removed code were rejected | Corpus run on `api.removed-route` | Verification now checks the previous revision too (`oldFiles`) |
| Severity cap never applied | `verification.test.ts` | The rank comparison was inverted (`SEVERITY_ORDER` is 0 = most severe) |
| N+1 rule flagged `await fetch(url)` in a loop as a database query | First evaluation run: precision 0.438, a false positive in `swallowed-error` | Rule now requires a database-ish receiver |
| Reviewer selection ranked `correctness` out | `diffwise reviewers plan` on the demo | Correctness is pinned and chosen before the cap |
| Coverage/verification ran only with a provider | Reviewing the pipeline with `--no-ai` | Deterministic verification is the default path, not a fallback |
| Fixes pointed at findings removed by verification | Report validation failure in `platform.test.ts` | Orphaned fixes pruned; withheld findings kept separately |
| `search_project_knowledge` tool registered twice | Server failed to start with "already registered" | Removed from v2; v1 name preserved |
| Fix panel claimed "each with a machine-validated patch" for guidance-only options | E2E probe of the rendered text | Copy is now conditional on whether a patch exists |
| Stale webview E2E expectations (10 rail items, old banner text) | `npm run test:e2e` | Assertions updated to the real UI; two new sections added to the sweep |

## Evaluation

Recorded at `docs/evidence/evaluation-run.json`.

```
precision 1.0   recall 1.0   f1 1.0   severity 1.0   verification 1.0
expected 13   found 13   detected 13   matched 13   forbidden violations 0
```

Pre-tuning baseline, from the first execution of the same corpus: `precision 0.438`, `recall 0.875`, `f1 0.584`.
`docs/EVALUATION.md` explains precisely what changed and why the perfect score is weak evidence.

## Screenshot evidence

| File | Feature proven |
|---|---|
| `docs/screenshots/20-review-pipeline.png` | Stage list with status/duration/metrics, reviewer table, per-rule records |
| `docs/screenshots/21-verified-findings.png` | Verdict badges, evidence-class counts, per-check outcomes, verifier opinions |
| `docs/screenshots/01…19` | Pre-existing report sections, unchanged in this release |

## Known limitations carried forward

See `docs/LIMITATIONS.md`. The ones that matter most for this release:

1. **No pull-request ingestion, Jira, Confluence or external MCP client.** Designed, not implemented, and not claimed.
2. **Sandboxed execution is declared but not implemented.** Only `sandbox: none` has an executor; the plan marks
   commands that cannot be isolated.
3. **The evaluation corpus is small and was tuned alongside the tool.** A perfect score on 13 findings is not a claim
   about real code.
4. **Independent verifiers are procedurally independent, not model-independent.**
5. **AI-authored regression tests are not generated.** Reproduction is planned from existing test commands.
6. **VS Code extension E2E was not executed here** (no display). Packaging and the webview E2E were.

## Release gate

| Gate item | Status |
|---|---|
| Build succeeds | ✅ `npm run build` |
| Typecheck clean | ✅ `npm run typecheck` |
| Unit + integration tests | ✅ 284 in 22 files |
| Webview E2E | ✅ 25 checks |
| VSIX packaged | ✅ 1.81 MB |
| Evaluation corpus runs and is measured | ✅ 13/13, 0 forbidden |
| Report schema v3 validates and migrates | ✅ tests + validator |
| No model-only CONFIRMED finding possible | ✅ enforced in the engine and the validator |
| AI cannot satisfy an approval requirement | ✅ tested |
| Every mutating MCP action is guarded and audited | ✅ tested |
| Documentation matches implementation | ✅ `docs/LIMITATIONS.md` and `docs/INTEGRATIONS.md` say what is missing |
| VS Code extension host E2E | ⚠️ not executed (no display in this environment) |
