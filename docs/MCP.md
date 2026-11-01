# MCP integration

DiffWise exposes a Model Context Protocol server so coding agents can record *why* a change was made **and run the
same review, fix and verification services as the CLI**. Interface version: **2** (server 0.3.0). Transport:
**stdio**. It never reads or exposes hidden model reasoning; only explicit, structured statements the agent chooses to
record.

Interface v2 is additive: every v1 tool keeps its name, arguments and response shape. 42 tools are registered — 19
from v1 (8 recorders, 11 workflow tools) and 23 added in v2.

The review, fix and verification tools call `@diffwise/app`, so an agent gets exactly the behaviour a developer gets
from `diffwise review`, `diffwise fix` and `diffwise verify` — same rules, same report contract, same approval gate.

## Run it

```bash
node packages/mcp/bin/diffwise-mcp.js --root /path/to/repository
# or
DIFFWISE_REPO_ROOT=/path/to/repository node packages/mcp/bin/diffwise-mcp.js
```

`--root` wins, then `DIFFWISE_REPO_ROOT`, then the working directory. stdout is reserved for the protocol; diagnostics
go to stderr. The process exits with a clear error if the directory is not a git repository.

## Interface v2 tools

Added in 0.3.0. None of them replace a v1 tool.

### Review state

| Tool | Arguments | Returns |
|---|---|---|
| `get_review_status` | `reviewId?` | every pipeline stage with status, duration, detail, metrics; reviewer runs with tokens and errors; verification summary; reviewer plan |
| `get_review_findings` | `reviewId?`, `severity?`, `category?`, `verification?`, `file?`, `limit?` | findings with their verdict, plus the count of withheld findings |
| `get_finding_details` | `findingId` | the full finding: evidence with file/line/snippet, verification checks and verifier opinions, fix options |
| `get_review_risk` | `reviewId?` | risk score with every factor, the approval requirement, and the review state |
| `get_review_coverage` | `reviewId?` | rules that ran/failed/skipped, reviewers selected, indexing and truncation facts |

### Verification

| Tool | Arguments | Returns |
|---|---|---|
| `verify_finding` | `findingId` | re-runs the deterministic checks against the working tree and returns the new verdict |
| `verify_review` | `reviewId?` | re-verifies every finding and returns the verdict distribution |
| `discover_test_commands` | — | commands the repository declares, from manifests only; nothing is executed |
| `get_verification_plan` | `reviewId?`, `levels?`, `findingId?` | the plan: command, level, timeout, approval requirement, sandbox verdict |
| `get_verification_result` | `reviewId?`, `findingId?` | every run that actually happened, with exit code and duration |

### Context

| Tool | Arguments | Returns |
|---|---|---|
| `get_affected_components` | `reviewId?` | modules, direct and indirect impact, cycles, boundary changes |
| `get_related_tests` | `reviewId?` | covering test files, uncovered files and symbols, deleted tests |
| `get_relevant_documentation` | `reviewId?` | documents whose references the change invalidates, with evidence |

### Rules and policy

| Tool | Arguments | Returns |
|---|---|---|
| `list_rule_packs` | — | installed packs with version, rule count, blocked state |
| `get_rule_details` | `ruleId` | definition, provenance, severity override, suppression |
| `validate_rule` | `directory?` or `definition?` | every error and warning with its file |
| `explain_rule` | `ruleId`, `reviewId?` | the rule's execution record from a review |
| `get_effective_policy` | `paths?` | resolved policy with per-field provenance and problems |

### Reviewers and humans

| Tool | Arguments | Returns |
|---|---|---|
| `get_reviewer_plan` | `reviewId?` | which reviewers run, with the signals that selected them |
| `explain_reviewer` | `reviewerId` | focus, avoid list, languages, budget |
| `record_human_decision` | `reviewId`, `action`, `actor`, `actorKind`, `role?`, `rationale?`, `findingId?` | the stored decision, recomputed state and approval status |
| `get_review_history` | `limit?`, `reviewId?` | stored reviews and the decisions recorded against one |
| `submit_finding_feedback` | `findingId`, `outcome`, `note?`, `actor?` | recorded as an agent event; it never changes a rule or threshold |

## Permissions and trust

- **Read tools are side-effect free** and safe to call in a loop: they are annotated `readOnlyHint: true`.
- **Mutating tools are explicit.** `apply_fix` requires `approved: true` **and** a matching `confirmFindingId`.
  `record_human_decision` records what the caller says a human decided — it does not verify the human.
- **AI and CI decisions never satisfy an approval requirement.** `actorKind` is stored and counted separately.
- **Arguments are never logged.** Every call appends to `.diffwise/mcp-audit.jsonl` with the tool name, a truncated
  sha256 of the arguments, the outcome and the duration.
- **A duplicate tool name fails startup.** An interface contract collision is loud, not silent.
- **Secrets are never returned.** Tool responses contain file paths, code excerpts and verdicts; provider credentials are
  not part of any response.

## Client configuration

```json
{
  "mcpServers": {
    "diffwise": {
      "command": "node",
      "args": ["/absolute/path/to/DiffWise/packages/mcp/bin/diffwise-mcp.js"],
      "env": { "DIFFWISE_REPO_ROOT": "/absolute/path/to/repository" }
    }
  }
}
```

## Tools

### Recording

| Tool | Required | Optional | Purpose |
|---|---|---|---|
| `record_task_intent` | `title`, `detail` | `files`, `actor`, `status` | What the developer asked for, before implementation |
| `record_plan` | `title`, `detail` | `files`, `actor` | Planned steps and expected files |
| `record_decision` | `title`, `detail` | `files`, `actor` | A design decision and what it rules out |
| `record_alternative` | `title`, `detail` | `files`, `actor` | A rejected option and why |
| `record_constraint` | `title`, `detail` | `files`, `actor` | Compatibility, dependency, performance or policy constraint |
| `record_activity` | `title`, `detail` | `files`, `actor`, `status` | A tool, command or action with its outcome |
| `record_verification` | `title`, `detail` | `status` (`passed`, `failed`, `partial`) | What actually ran and what did not |
| `record_unresolved_issue` | `title`, `detail` | `files`, `actor` | Known incomplete or unverified work |

Each returns `{ ok: true, id, createdAt, type }`. Events append to `.diffwise/agent-events.jsonl`.

### Reading

| Tool | Input | Returns |
|---|---|---|
| `get_change_context` | `includeContent?`, `maxFiles?` | Repository info, working-tree change summary, recent agent events and intents |
| `get_review_context` | `reviewId?`, `includeFindings?` | Compact latest (or named) review: completeness, risk factors, findings, docs, tests, agent alignment, fixes |
| `get_related_decisions` | `files?`, `query?`, `limit?` | Decisions, alternatives, constraints and unresolved issues scored by relevance |
| `search_project_knowledge` | `query`, `limit?` | Snippets from documentation, agent records and review knowledge with paths and scores |

### Review, fix and verification

| Tool | Input | Returns |
|---|---|---|
| `run_review` | `mode?` (`working`\|`staged`\|`branch`\|`commits`), `base?`, `head?`, `paths?`, `ai?` | The full versioned envelope (`schemaVersion: "1.0"`) and persists the report. The envelope carries `aiUsage` (requests, input/output tokens, cache hits, avoided tokens, per-task split, optional `costUsd` + `costBasis`) so an agent can budget a review before and after running it. It also carries `aiReview` (`status`, `requested`, `required`, reviewer counts, model opinions, models, reason) — an agent must read this before deciding how much weight the findings deserve |
| `get_findings` | `reviewId?`, `severity?` (minimum), `category?`, `max?` | Findings with stable ids, locations, evidence counts and recommendations |
| `get_finding` | `findingId` | One finding with its complete evidence and fix options |
| `suggest_fixes` | `findingId`, `generate?` | Fix options; every patch carries `validation.applies` |
| `apply_fix` | `findingId`, `solutionId`, `approved: true`, `confirmFindingId` | Applies after re-validating and hash-pinning the patch; returns files, backup dir and journal entry |
| `run_verification` | `findingId?` | Runs the configured command and returns the real exit code, duration and output (`not-run` when unconfigured) |
| `compare_reviews` | `left`, `right?` | Risk/finding deltas plus resolved, introduced and still-present findings |

Approval contract for `apply_fix`: `approved` must literally be `true` **and** `confirmFindingId` must equal
`findingId`. A mismatch is rejected before any validation happens, so an agent cannot apply a patch it was not
explicitly asked to apply, and cannot re-purpose one finding's approval for another.

A typical agent loop:

```
run_review --json → get_findings → get_finding (evidence) → suggest_fixes
        → apply_fix (approved + confirmed) → run_verification → run_review → compare_reviews
```

Resource: `diffwise://review/latest` returns the compact latest review as JSON.

## Event schema

```json
{
  "id": "evt-…",
  "type": "decision",
  "title": "Settlement batch made atomic",
  "detail": "Wrapped ledger writes in withTransaction so a mid-batch failure cannot leave the ledger ahead.",
  "createdAt": "2026-10-29T10:02:00.000Z",
  "actor": "claude-code",
  "files": ["src/payments/SettlementService.ts"],
  "status": "passed",
  "metadata": { "recordedVia": "mcp", "interfaceVersion": 1 }
}
```

Types: `task_intent`, `plan`, `decision`, `alternative`, `constraint`, `activity`, `verification`, `unresolved_issue`.

## How the review uses it

- **Change groups** use the recorded intent as their title and purpose, with `purposeBasis: "agent-intent"`.
- **Intent alignment** deterministically compares the files named in the intent with the files actually changed:
  `aligned`, `partially-aligned`, `divergent` or `not-verifiable`, with the untouched and unplanned files listed.
- **Risk** subtracts points when passing verification evidence was recorded.
- **Discussion** includes decisions, alternatives and unresolved issues in its context.
- **Knowledge search** merges documentation, events and review knowledge.

## Protocol example

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"2025-06-18","capabilities":{},
  "clientInfo":{"name":"my-agent","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"record_task_intent",
  "arguments":{"title":"Add partial refunds","detail":"Support partial refunds without breaking settlement totals.","files":["src/payments/PaymentService.ts"]}}}
```

## Versioning

Tool names and input schemas are stable within interface version 1. Additive fields are allowed; removing or
renaming a tool requires a new interface version, reported in `SERVER_INFO.version` and the `annotations` text of
each tool.

## Limitations

- `get_change_context` reports the working tree; use `run_review` for branch or commit targets.
- Lexical knowledge search plus graph traversal; no embeddings.
- No chat tool: discussion is a CLI/web feature because it is conversational and cost-bearing.
- One repository per server process.
- Applying a fix blocks the tool call while files are written (milliseconds); verification can take as long as the
  configured command, so agents should set their own client timeout accordingly.
- `run_verification` executes developer-configured commands. Agents must not treat a `not-run` result as a pass.
