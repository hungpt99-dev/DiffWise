# Configuration

## Provider

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `diffwise.provider.id` | enum | `openai-compatible` | `openai-compatible`, `anthropic`, `ollama`, `none` |
| `diffwise.provider.baseUrl` | string | `https://api.openai.com/v1` | Endpoint base URL |
| `diffwise.provider.model` | string | `gpt-4o-mini` | Model for review |
| `diffwise.provider.fastModel` | string | empty | Optional faster model for fix generation |
| `diffwise.provider.apiKeyEnvVar` | string | `DIFFWISE_API_KEY` | Environment variable holding the key |
| `diffwise.provider.extraHeaders` | object | `{}` | Additional HTTP headers (gateway routing, sessions) |
| `diffwise.provider.maxTokens` | number | `4000` | Completion budget per request |
| `diffwise.provider.temperature` | number | `0.1` | Sampling temperature |
| `diffwise.provider.timeoutMs` | number | `120000` | Hard timeout per request |

The API key is **never** stored in settings. DiffWise reads it from the process environment of the extension host:

```bash
# Linux/macOS
export DIFFWISE_API_KEY="…"
code /path/to/repository
```

```powershell
# Windows PowerShell
$env:DIFFWISE_API_KEY = "…"
code C:\path\to\repository
```

If VS Code was already running before the variable was set, restart it: the extension host inherits its environment
at launch.

## Analysis

| Setting | Default | Meaning |
|---|---|---|
| `diffwise.ai.enabled` | `true` | Run the AI stage. Deterministic analysis always runs |
| `diffwise.ai.sendRepositoryContent` | `false` | Send related repository files, not only the diff |
| `diffwise.analysis.maxFiles` | `200` | Maximum changed files analysed |
| `diffwise.analysis.maxFileBytes` | `400000` | Skip larger files |
| `diffwise.analysis.maxEvidenceSnippets` | `40` | Evidence budget |
| `diffwise.analysis.ignoreGlobs` | build/vendor globs | Files excluded from analysis |
| `diffwise.storage.directory` | `.diffwise` | Repository-relative review storage |
| `diffwise.verification.command` | empty | Command run only after explicit approval |
| `diffwise.verification.timeoutMs` | `300000` | Verification timeout |

### What leaves the machine

| `sendRepositoryContent` | Payload |
|---|---|
| `false` (default) | Diff hunks of changed files, file paths, findings, symbols, documentation findings, agent events |
| `true` | The above plus related source and documentation excerpts (bounded, attributed, redacted) |

Credential patterns (API keys, tokens, passwords, private keys, JWTs) are replaced with `[REDACTED]` before any
payload is sent, and the count is recorded in the report. DiffWise does not upload anything unless you configure a
remote provider and run a review with AI enabled. A local provider (Ollama, LM Studio, vLLM) keeps content on the
machine.

## Provider examples

### OpenAI

```jsonc
{
  "diffwise.provider.id": "openai-compatible",
  "diffwise.provider.baseUrl": "https://api.openai.com/v1",
  "diffwise.provider.model": "gpt-4.1-mini",
  "diffwise.provider.fastModel": "gpt-4.1-nano",
  "diffwise.provider.apiKeyEnvVar": "OPENAI_API_KEY"
}
```

### Anthropic

```jsonc
{
  "diffwise.provider.id": "anthropic",
  "diffwise.provider.baseUrl": "https://api.anthropic.com",
  "diffwise.provider.model": "claude-sonnet-4-5",
  "diffwise.provider.apiKeyEnvVar": "ANTHROPIC_API_KEY"
}
```

### Ollama (fully local)

```jsonc
{
  "diffwise.provider.id": "ollama",
  "diffwise.provider.baseUrl": "http://127.0.0.1:11434/v1",
  "diffwise.provider.model": "qwen2.5-coder:14b",
  "diffwise.ai.sendRepositoryContent": true
}
```

### Gateway that requires a session header

```jsonc
{
  "diffwise.provider.id": "openai-compatible",
  "diffwise.provider.baseUrl": "https://gateway.example.com/v1",
  "diffwise.provider.model": "claude-haiku-5-5",
  "diffwise.provider.extraHeaders": { "x-session-id": "diffwise" },
  "diffwise.provider.maxTokens": 12000
}
```

### Deterministic only

```jsonc
{
  "diffwise.provider.id": "none",
  "diffwise.ai.enabled": false
}
```

The report is still complete for deterministic analysis; the AI stage is marked `skipped`, not `completed`.

## Model selection guidance

| Task | Model characteristics |
|---|---|
| Review | Strong reasoning; 8k–24k completion budget; JSON mode |
| Fix generation | Fast, code-fluent, no long hidden reasoning; `fastModel` |
| Chat | Fast; 4k–8k budget |

Reasoning models count hidden reasoning toward `maxTokens`. If a review fails with "model returned no content", raise
`diffwise.provider.maxTokens` (12000 is a practical floor for a reasoning model on this prompt size).

## Headless usage

The CLI reads `DIFFWISE_*` variables and never stores them:

```bash
DIFFWISE_PROVIDER_ID=openai-compatible \
DIFFWISE_BASE_URL=https://api.openai.com/v1 \
DIFFWISE_MODEL=gpt-4.1-mini \
DIFFWISE_API_KEY="$OPENAI_API_KEY" \
DIFFWISE_SEND_CONTENT=1 \
DIFFWISE_MAX_TOKENS=12000 \
node scripts/analyze.mjs --repo . --mode branch --base main --head HEAD --out report.json
```

| Variable | Meaning |
|---|---|
| `DIFFWISE_PROVIDER_ID` | Adapter id |
| `DIFFWISE_BASE_URL` | Endpoint |
| `DIFFWISE_MODEL` | Review model |
| `DIFFWISE_FAST_MODEL` | Optional fix/chat model |
| `DIFFWISE_API_KEY` | Key (required for remote providers) |
| `DIFFWISE_SEND_CONTENT` | `1` to include related files |
| `DIFFWISE_MAX_FIXES` | Findings that receive fix options (default 3) |
| `DIFFWISE_EXTRA_HEADERS` | JSON object of extra headers |
| `DIFFWISE_DEBUG` | `1` to log model diagnostics to stderr |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| “No AI provider key is available” | The env var named in settings is missing in the extension host. Set it and restart VS Code |
| “Model returned no content … max_tokens” | Reasoning tokens exhausted the budget. Raise `maxTokens` |
| Report is `partial` with “AI interpretation” | Provider error, unparsable output twice, or fix generation failed. Read the stage error; deterministic results remain |
| Review says no changes | The selected target is empty. Use branch or commit range, or stage/commit work |
| Extension inactive | Workspace is in Restricted Mode. Trust the folder |
| Fix button disabled | The patch does not apply to the current tree. Re-run the analysis |
| Verification says not-run | No command configured, or the approval checkbox was not ticked |
