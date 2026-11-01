# Platform architecture

Status: describes the repository **after** the 0.5.0 interface unification. The pre-unification state and the defects
that motivated it are in `docs/INTERFACE_STRATEGY.md` §2 and `docs/MIGRATION_ROADMAP.md`.

## 1. One engine, four interfaces

```
                        DiffWise platform
   ┌──────────┬──────────────┬──────────────┬──────────────┐
   │ VS Code  │     CLI      │     MCP      │    CI/CD     │
   │ product  │  execution   │ agent tools  │ quality gate │
   └────┬─────┴──────┬───────┴──────┬───────┴──────┬───────┘
        │            │              │              │
        └────────────┴───────┬──────┴──────────────┘
                             │
                  packages/app  (DiffWiseService)
                  orchestration, persistence, policy, fixes,
                  verification, chat, artefacts, quality gate
                             │
        ┌────────────────────┴────────────────────┐
        │                                         │
  packages/core                             packages/ai
  deterministic engine                      provider layer
  git · diff · symbols · graph · rules      reviewers · verifiers · chat
  docs · tests · risk · verification        fixes · cache · usage meter
  policy · rule packs · report schema       (only package with network I/O)
  tokens · context · cache
```

Rules that hold today, and are enforced by dependency direction:

1. `core` never imports `ai`, `app`, or any interface.
2. `ai` depends on `core` and is the only package that performs network I/O.
3. `app` depends on both and is the only package that orchestrates a review.
4. Interfaces depend on `app`; none of them contains analysis, severity, finding, risk or verification logic.
5. AI is optional at every level: without a provider the same pipeline runs deterministically.

## 2. `DiffWiseService` — the single execution surface

Every review, whatever started it, is a call to one method:

```ts
service.review({ target, settings?, signal?, onProgress?, reportId?, disableAi? })
  → { report, path?, aiReason? }
```

What that call does, once, for all interfaces:

| Stage | Module | Guarantee |
|---|---|---|
| Resolve target | `core/git` | working tree, staged, branch, commits, paths |
| Collect + parse | `core/analysis/pipeline` | symbols, graph, docs, tests, risk, deterministic rules |
| Policy + rule packs | `core/policy`, `core/rules/loader` | org → repo → dir → file precedence, validated packs |
| Reviewer selection | `core/review/select` | ≤ cap, explained per reviewer |
| AI reviewers | `ai/reviewers/agent` | evidence-validated proposals only |
| Deterministic + AI verification | `core/verification`, `app/orchestrate` | five evidence classes, explicit verdicts |
| Findings, risk, report | `core/report/schema` | schema v3, validation |
| Usage, cache, cost | `core/tokens`, `core/cache`, `ai/instrument` | per-task, provider-labelled |
| Persistence | `core/store` | one review identity, one index |

The service is also the only place that applies fixes, runs verification, answers chat and computes artefacts:

```
previewFix · applyFix · rollback · registerPatch
verify · recordDecision · chat · fixOptions
envelope · sarif · qualityGate · writeArtefact
loadReview · latestReview · listReviews · compare
```

## 3. Interface responsibilities

### VS Code — the product

Owns **presentation and editor integration only**:

- webview panel and its message protocol (`apps/vscode/src/panel.ts`, `protocol.ts`)
- tree views, diagnostics, CodeLens, status bar (`views.ts`, `support.ts`)
- commands and keybindings, plus the consent dialogs for destructive actions
- mapping VS Code settings onto `ReviewRunOptions.settings` (no config parsing of its own)

It calls `DiffWiseService` for every operation. It does not call `runReview`, `applyPatch`, `revertPatch`,
`runVerificationCommand` or `openStore` directly any more — those imports are gone from the extension.

### CLI — the execution engine

17 commands over the same service: `init`, `doctor`, `review`, `findings`, `show`, `chat`, `fix`, `verify`, `report`,
`history`, `compare`, `config`, `rules`, `reviewers`, `policy`, `evaluate`, `version`. Responsibilities the service does
not have: argument parsing, human formatting, exit codes, progress on stderr, and the JSON envelope.

Exit codes are a CLI contract, not an engine one: `0` ok, `1` quality gate hit, `2` usage, `3` not a repository,
`4` unknown id, `5` AI required but unavailable, `6` verification not run or failed, `7` fix refused, `8` cancelled,
`9` internal, `10` cost limit exceeded.

### MCP — the agent interface

42 tools, all thin wrappers over the service:

| Group | Tools |
|---|---|
| Record (agent intent) | `record_task_intent`, `record_plan`, `record_decision`, `record_constraint`, `record_alternative`, `record_activity`, `record_unresolved_issue`, `record_verification`, `record_human_decision` |
| Review | `run_review`, `get_review_status`, `get_review_context`, `get_review_coverage`, `get_review_risk`, `get_review_findings`, `get_review_history` |
| Findings | `get_findings`, `get_finding`, `get_finding_details`, `submit_finding_feedback` |
| Investigation | `get_change_context`, `get_affected_components`, `get_related_tests`, `get_related_decisions`, `get_relevant_documentation`, `search_project_knowledge`, `get_verification_plan`, `get_verification_result`, `verify_finding` |
| Remediation | `suggest_fixes`, `apply_fix`, `verify_review` |
| Platform | `list_rule_packs`, `get_rule_details`, `explain_rule`, `validate_rule`, `get_reviewer_plan`, `explain_reviewer`, `get_effective_policy`, `discover_test_commands`, `compare_reviews`, `run_verification` |

Destructive tools (`apply_fix`, `run_verification`, `run_review` with `ai: true`) require explicit arguments; every
invocation is appended to a hashed audit log (`packages/mcp/src/audit.ts`).

### CI/CD — the gate

No code of its own: a workflow checks out with full history, writes `.diffwise/config.json`, runs `diffwise review`,
evaluates the exit code and publishes SARIF + JSON artefacts. The GitHub workflow lives in
`.github/workflows/diffwise-review.yml`; the GitLab equivalent in `docs/examples/gitlab-ci.yml`.

## 4. Configuration: one file, one precedence

| Interface | Reads | Writes |
|---|---|---|
| CLI, MCP, CI | `.diffwise/config.json`, `.diffwise/policy*.json`, `.diffwise/rules/**` | `.diffwise/reviews`, `cache`, `backups`, `agent-events.jsonl` |
| VS Code | the same files, plus VS Code settings as an **override layer** on provider, AI consent, analysis limits and verification command | UI settings only; review artefacts through the service |

The override is recorded: `service.review({settings})` merges into `AnalysisSettings` and the report stores the
resulting `settings` snapshot, so a review can always explain which configuration produced it (§ `report.settings`).

## 5. Shared contracts

| Contract | Version | Consumers |
|---|---|---|
| `ReviewReport` | schema v3 (+ v1/v2 migration) | all four interfaces; persisted JSON |
| Review envelope | `1.0` additive (`aiUsage` added in 0.4.0) | MCP `run_review`, CLI `--format json`, agents |
| SARIF 2.1.0 | `buildSarif` + `validateSarif` | CI code scanning |
| Finding identity | `stableId(prefix, file, line, title)` | stable across runs and interfaces |
| Review identity | `report.id` in `.diffwise/reviews/index.json` | VS Code history, `diffwise history`, MCP status |

## 6. Security boundaries

- Repository content is untrusted data, fenced and labelled in every prompt; injected instructions are not followed.
- Secrets are redacted before anything is serialised for a model (`redactSecrets`), counted in the report.
- Patches are validated against the working tree before they are shown and again before they are applied; applying
  requires explicit approval, writes a backup, and records a journal entry for rollback.
- Full file content leaves the machine only when `ai.sendRepositoryContent` is true.
- API keys live in named environment variables; config refuses to store a key.
- The MCP audit log stores hashed arguments, not payloads.

## 7. Performance boundaries

- The extension host does file I/O through the service, never analysis loops; long work is cancellable and reports
  progress through the pipeline's stage tracker.
- Concurrent model calls are bounded (reviewer concurrency, `maxVerificationCalls`).
- The answer cache is bounded by entries and bytes and keyed by exact prompt, so no stale reuse is possible.
- `packages/core` is deterministic and synchronous-friendly; expensive work happens in `ai` and in `app`'s
  verification execution.

## 8. What is deliberately *not* abstracted

- No plugin system for interfaces: there are four, they are known, and an interface is a directory not a registry.
- No generic "capability bus": interfaces call the service directly.
- No second finding schema and no per-interface severity mapping.
- No vector index: context selection is deterministic (diff, graph, symbols, references) and measured.
