# Configuration

DiffWise has one project configuration file, `.diffwise/config.json`, shared by the CLI, the report server, MCP and
the VS Code extension. The VS Code extension additionally maps the same values onto `diffwise.*` settings for
workspace convenience; the file wins when both are present because it is what the CLI and CI read.

```bash
diffwise init                     # write a starter config
diffwise config list              # show the effective values
diffwise config set verification.command "npm test"
```

## Project file

```json
{
  "schemaVersion": 1,
  "provider": {
    "id": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKeyEnvVar": "DIFFWISE_API_KEY",
    "fastModel": "",
    "maxTokens": 8000,
    "temperature": 0.1,
    "timeoutMs": 180000,
    "extraHeaders": {}
  },
  "ai": { "enabled": true, "required": false, "sendRepositoryContent": false },
  "models": { "review": "claude-sonnet-5", "verify": "deepseek-v4.1-flash" },
  "analysis": {
    "maxFiles": 200,
    "maxFileBytes": 400000,
    "ignoreGlobs": ["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.min.js", "**/package-lock.json", "**/.diffwise/**"]
  },
  "verification": { "command": "", "timeoutMs": 300000 },
  "qualityGate": { "failOn": "high" },
  "cache": { "enabled": true, "maxEntries": 500, "ttlDays": 14 },
  "review": { "timeoutMs": 180000 }
}
```

| Key | Default | Meaning |
|---|---|---|
| `provider.id` | `openai-compatible` | Wire protocol/vendor: `openai`, `anthropic`, `google`, `deepseek`, `mistral`, `openrouter`, `groq`, `together`, `fireworks`, `azure-openai`, `aws-bedrock`, `google-vertex`, `ollama`, `lmstudio`, `vllm`, `openai-compatible`, `custom`, `none` |
| `provider.baseUrl` | `https://api.openai.com/v1` | Endpoint base URL |
| `provider.model` | `gpt-4o-mini` | Model used for review, chat and fixes |
| `provider.fastModel` | empty | Optional faster model for chat and fix generation |
| `provider.apiKeyEnvVar` | `DIFFWISE_API_KEY` | **Name** of the environment variable holding the key |
| `provider.extraHeaders` | `{}` | Extra HTTP headers (gateway routing, session ids) |
| `provider.maxTokens` | `8000` | Completion budget |
| `provider.temperature` | `0.1` | Sampling temperature |
| `provider.timeoutMs` | `180000` | Hard timeout per request (raise it for large reasoning models) |
| `ai.enabled` | `true` | Run the AI stage. Deterministic analysis always runs |
| `ai.required` | `false` | A review without a completed AI stage is `partial`, and the CLI exits `11` |
| `ai.sendRepositoryContent` | `false` | Send related repository files, not only the diff |
| `models.review` | `provider.model` | Model for specialised reviewers |
| `models.verify` | `provider.fastModel` or `provider.model` | Model for verification opinions |
| `models.fix` | `provider.fastModel` or `provider.model` | Model for fix generation |
| `models.chat` | `provider.fastModel` or `provider.model` | Model for report chat |
| `analysis.maxFiles` | `200` | Maximum changed files analysed |
| `analysis.maxFileBytes` | `400000` | Skip larger files |
| `analysis.ignoreGlobs` | build/vendor globs | Files excluded from analysis |
| `verification.command` | empty | Command run by `diffwise verify` and the UI, only after approval |
| `verification.timeoutMs` | `300000` | Verification timeout |
| `qualityGate.failOn` | `high` | Minimum severity that makes `diffwise review` exit `1`; `none` disables the gate |
| `cache.enabled` | `true` | Reuse model answers for identical prompts. Entries live in `.diffwise/cache/` |
| `cache.maxEntries` | `500` | Maximum cached answers on disk |
| `cache.ttlDays` | `14` | Age after which an entry is ignored and pruned |
| `review.timeoutMs` | `180000` | Wall-clock limit for one reviewer. Reasoning models need more than the historical 120 s |
| `pricing` | absent | Optional `{ "model-or-prefix*": { inputPerMTok, outputPerMTok, cachedInputPerMTok?, source, asOf? } }`. Without it the report says **cost unknown**; it never invents a price |

Rules the loader enforces:

- **Credentials are refused.** A `provider.apiKey` value in the file triggers a warning and is ignored; only the
  environment-variable *name* is stored. The file is therefore safe to commit.
- Unknown keys are ignored with a warning; invalid types fall back to defaults.
- `provider.id` is a wire protocol, not a vendor: `openai-compatible` covers OpenAI, Azure-style gateways, vLLM,
  LM Studio, Ollama and most relays.
- `--config <file>` uses an explicit file instead of `.diffwise/config.json`.

## Provider profiles and task routing

`provider` remains the primary profile. Additional profiles are named and referenced from `routing`:

```jsonc
{
  "provider": { "id": "openai", "model": "gpt-4o-mini", "apiKeyEnvVar": "OPENAI_API_KEY" },
  "providers": [
    { "name": "strong", "id": "anthropic", "model": "claude-sonnet-5", "apiKeyEnvVar": "ANTHROPIC_API_KEY" },
    { "name": "local", "id": "ollama", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen2.5-coder:7b", "apiKeyEnvVar": "" }
  ],
  "routing": {
    "security": { "provider": "strong", "model": "claude-sonnet-5" },
    "performance": { "provider": "local", "model": "qwen2.5-coder:7b" },
    "verify": { "provider": "primary", "model": "gpt-4o-mini", "fallback": "local" }
  }
}
```

Route tasks: `review`, every reviewer id (`security`, `architecture`, `performance`, `database`, `business-logic`,
`api-contract`, `reliability`, `documentation`, `tests`, `maintainability`), `verify`, `fix`, `chat`, `docs`.

- A route's `provider` is a profile name; `primary` is the primary block.
- `model` overrides `models.<task>` for that task.
- `fallback` is explicit. A cross-provider fallback is refused while `ai.sendRepositoryContent` is true unless the
  route sets `allowCrossProviderFallback: true`. A fallback that answers is recorded; it is never silent.
- A profile with a missing key is reported with the variable name; other profiles still work.
- `diffwise providers list|add|update|remove|route` edits this structure. The VS Code AI Providers section edits the
  same file through the same application functions.

## Documentation sources

```jsonc
{
  "documentation": {
    "sources": [
      { "path": "README.md", "category": "readme", "priority": 10 },
      { "path": "docs/adr/**", "category": "adr", "priority": 20 },
      { "path": "docs/architecture/**", "category": "architecture", "modules": ["billing"] },
      { "path": "api/openapi.yaml", "category": "openapi", "priority": 30 }
    ],
    "maxSections": 6,
    "maxChars": 6000
  }
}
```

A configured source list is a **scope**: documentation outside it is not reviewed. With no sources, every
documentation file in the repository index is considered. Documents are indexed by content hash, split at headings,
deduplicated, and only sections that match the changed files/symbols are retrieved. `maxSections` and `maxChars` bound
what a review can consult (and therefore what a model can be sent). Duplicate and conflicting documents are surfaced,
never silently resolved in favour of one.

## External MCP connections

MCP connections live in `.diffwise/mcp.json`, not `config.json`, so credentials and per-server permissions can stay
local while the project configuration stays reviewable:

```jsonc
{
  "schemaVersion": 1,
  "servers": [{
    "name": "jira",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "jira-mcp"],
    "env": { "JIRA_TOKEN": "${JIRA_TOKEN}" },
    "enabled": true,
    "permissions": {
      "readOnly": true,
      "allowedTools": ["search_tickets"],
      "contextTools": ["search_tickets"],
      "maxOutputBytes": 24000,
      "timeoutMs": 20000,
      "allowWrite": false
    },
    "context": {
      "tool": "search_tickets",
      "arguments": { "query": "{{terms}}", "files": "{{files}}" },
      "label": "Jira requirement"
    }
  }]
}
```

Literal credentials in `env`/`headers` are rejected with a warning; use `${ENV_VAR}`. Review never calls a tool that is
not read-only, not allow-listed, or not explicitly configured as a context tool. See [MCP.md](MCP.md).

## Cost and cache

Token and cost controls are documented in [TOKEN_OPTIMIZATION.md](TOKEN_OPTIMIZATION.md): what is sent per tier, how the
budget is derived, what the cache keys on, and how to configure prices so the report can show a cost instead of
`cost unknown`.

## What leaves the machine

| `sendRepositoryContent` | Payload |
|---|---|
| `false` (default) | Diff hunks of changed files, file paths, findings, symbols, documentation findings, agent events |
| `true` | The above plus related source and documentation excerpts (bounded, attributed) |

Credential patterns (API keys, tokens, passwords, private keys, JWTs) are replaced with `[REDACTED]` before any
payload is sent; the count is recorded in `report.ai.redactions`. Nothing is uploaded unless you configure a remote
provider and run with AI enabled. A local provider (Ollama, LM Studio, vLLM) keeps content on the machine.

## Provider examples

### OpenAI

```json
{
  "provider": { "id": "openai-compatible", "baseUrl": "https://api.openai.com/v1",
                "model": "gpt-4.1-mini", "fastModel": "gpt-4.1-nano",
                "apiKeyEnvVar": "OPENAI_API_KEY" }
}
```

### Anthropic

```json
{
  "provider": { "id": "anthropic", "baseUrl": "https://api.anthropic.com",
                "model": "claude-sonnet-4-5", "apiKeyEnvVar": "ANTHROPIC_API_KEY" }
}
```

### Ollama (fully local)

```json
{
  "provider": { "id": "ollama", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen2.5-coder:14b" },
  "ai": { "sendRepositoryContent": true }
}
```

### Gateway that requires a session header

```json
{
  "provider": {
    "id": "openai-compatible",
    "baseUrl": "https://gateway.example.com/v1",
    "model": "glm-5.3-flash",
    "extraHeaders": { "x-session-id": "diffwise" },
    "maxTokens": 12000,
    "timeoutMs": 300000
  }
}
```

### Deterministic only

```json
{ "provider": { "id": "none" }, "ai": { "enabled": false } }
```

Deterministic analysis is still complete; the AI stage is recorded as `skipped`, never as `completed`.

## Environment variables

The CLI, MCP and server read these; the VS Code host inherits its environment at launch.

| Variable | Meaning |
|---|---|
| `DIFFWISE_API_KEY` (or the configured name) | Provider key |
| `DIFFWISE_PROVIDER_ID` | Adapter id |
| `DIFFWISE_BASE_URL` | Endpoint |
| `DIFFWISE_MODEL` | Review model |
| `DIFFWISE_FAST_MODEL` | Optional fix/chat model |
| `DIFFWISE_API_KEY_ENV_VAR` | Read the key from a different variable |
| `DIFFWISE_AI=off` | Disable AI for this process |
| `DIFFWISE_SEND_CONTENT=1` | Include related files |
| `DIFFWISE_VERIFY_COMMAND` | Override `verification.command` |
| `DIFFWISE_FAIL_ON` | Override the quality gate |
| `DIFFWISE_MAX_FILES` | Override `analysis.maxFiles` |
| `DIFFWISE_CACHE=off` | Disable the model-answer cache for this process |
| `DIFFWISE_CACHE_MAX_ENTRIES` | Override `cache.maxEntries` |
| `DIFFWISE_CACHE_TTL_DAYS` | Override `cache.ttlDays` |
| `DIFFWISE_REVIEWER_TIMEOUT_MS` | Override `review.timeoutMs` |
| `NO_COLOR`, `FORCE_COLOR` | Standard colour control |

```bash
DIFFWISE_MODEL=gpt-4.1-mini DIFFWISE_FAIL_ON=critical \
  diffwise review main..HEAD --json
```

## VS Code settings

The extension exposes the same values as `diffwise.*` settings for workspace-level configuration:
`provider.id`, `provider.baseUrl`, `provider.model`, `provider.fastModel`, `provider.apiKeyEnvVar`,
`provider.maxTokens`, `provider.temperature`, `provider.timeoutMs`, `provider.extraHeaders`, `ai.enabled`,
`ai.sendRepositoryContent`, `verification.command`, `analysis.maxFiles`. Saving them from the report's Settings page
writes the workspace configuration; the CLI reads `.diffwise/config.json`. Keep them in sync or set the file only.

## Model selection guidance

| Task | Model characteristics |
|---|---|
| Review | Strong reasoning; 8k–24k completion budget; JSON mode |
| Fix generation | Fast, code-fluent, low hidden reasoning (`fastModel`) |
| Chat | Fast; 4k–8k budget |

Reasoning models count hidden reasoning toward `maxTokens`. If a review finishes `partial` with a truncation note,
raise `provider.maxTokens` (12000 is a practical floor for a reasoning model on this prompt size) and
`provider.timeoutMs` for slow endpoints.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `AI provider configuration … missing` (doctor, exit 0 with a warning) | The env var named in the config is not set. Deterministic review still works |
| `No AI provider is configured` (exit 5) | Same, for `chat`/fix generation. Export the variable and retry |
| Report is `partial` with an AI stage error | Provider error or unparsable output twice. The deterministic part is intact; read `stages[].error` |
| Review says no changes | The target is empty. Use a range/commit, or stage work (untracked files count for working-tree reviews) |
| Fix button disabled | The patch does not apply to the current tree. Re-generate the fix |
| Verification says `not-run` (exit 6) | No `verification.command`, or approval was not given |
| `Report server port in use` | `--port 4800` |
