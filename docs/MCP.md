# MCP integration

DiffWise exposes a Model Context Protocol server so coding agents can record *why* a change was made and read the
review context back. Interface version: **1**. Transport: **stdio**. It never reads or exposes hidden model reasoning;
only explicit, structured statements the agent chooses to record.

## Run it

```bash
node packages/mcp/bin/diffwise-mcp.js --root /path/to/repository
# or
DIFFWISE_REPO_ROOT=/path/to/repository node packages/mcp/bin/diffwise-mcp.js
```

`--root` wins, then `DIFFWISE_REPO_ROOT`, then the working directory. stdout is reserved for the protocol; diagnostics
go to stderr. The process exits with a clear error if the directory is not a git repository.

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

- Working-tree context only for `get_change_context`; branch and commit targets are review features.
- Lexical knowledge search, no embeddings.
- The server does not write reviews; it records events and reads what the extension produced.
- One repository per server process.
