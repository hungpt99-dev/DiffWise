# CLI reference

The CLI is DiffWise's primary interface: it is what developers run locally and
what scripts, CI jobs and coding agents call. Everything it does goes through
the same application services as the web report and the MCP server.

```bash
diffwise <command> [options]
```

Run `diffwise help` for the command overview, `diffwise help <command>` for flags
and examples, and `diffwise help exit-codes` for the CI contract.

## Install

From a checkout:

```bash
npm install
npm run build
node packages/cli/bin/diffwise.js version

# optional: put it on PATH
npm link -w @diffwise/cli
```

Requirements: Node.js 20.11+ and git. No global service, no daemon, no account.

## Global flags

| Flag | Meaning |
|---|---|
| `--json` | Machine-readable output on stdout (JSON envelope, schema `1.0`). |
| `--format <fmt>` | `text`, `json`, `sarif`, `html` where the command supports it. |
| `--quiet` | Suppress progress and diagnostics on stderr. |
| `--verbose` | Extra diagnostics and stack traces on stderr. |
| `--no-color` | Disable ANSI colour (also honours `NO_COLOR`). |
| `--no-input` | Never prompt; fail or refuse instead of waiting. |
| `--config <file>` | Use an explicit config file instead of `.diffwise/config.json`. |
| `--repo <path>` | Run against another repository. |
| `--help`, `--version` | Help / version. |

Colour is emitted only when stdout is a TTY. When any machine format is
requested, DiffWise behaves as if `--no-input` was passed: agents never get a
prompt they cannot answer.

## Commands

### `diffwise init`

Writes `.diffwise/config.json`, adds local reports to `.gitignore`, and (with
`--mcp`) registers `diffwise-mcp` in `.mcp.json`.

```bash
diffwise init
diffwise init --mcp
diffwise init --force          # rewrite an existing config
```

### `diffwise doctor`

Validates Node, git, the repository, the working tree, configuration, report
directory permissions, provider configuration, MCP wiring and the verification
command. `--connect` additionally sends one small request to the model.

```bash
diffwise doctor
diffwise doctor --connect --json
```

Exit `0` when no check fails, `3` otherwise (warnings do not fail).

### `diffwise review`

Reviews a change and persists a report.

```bash
diffwise review                                  # working tree (incl. untracked)
diffwise review --staged                         # index only
diffwise review main..HEAD                       # branch comparison
diffwise review --commit HEAD                    # single commit
diffwise review --base origin/main --head HEAD   # explicit revisions
diffwise review src/payments/                    # only these paths
diffwise review --interactive                    # TTY menu after the summary
diffwise review --json                           # envelope on stdout
diffwise review --format sarif --out diffwise.sarif
diffwise review --format html --open
diffwise review --serve                          # start the interactive report
diffwise review --fail-on critical               # override the quality gate
diffwise review --no-ai                          # deterministic analysis only
```

Behaviour worth knowing:

- A staged or committed review contains **only** that change. Untracked files
  are included for worktree-based targets only.
- `--json` never fails on findings unless the gate is hit; the report is
  complete either way.
- Empty target: prints `status: "empty"` (JSON) and exits `0`.
- Findings at or above `qualityGate.failOn` (config) or `--fail-on` make the
  command exit `1` after writing the report — the report is always produced
  first.
- `Ctrl+C` cancels; the stage that was interrupted is recorded as `cancelled`
  and the exit code is `8`.

### `diffwise findings`

```bash
diffwise findings
diffwise findings --severity high
diffwise findings --category security --sort file
diffwise findings --search refund --limit 20 --json
```

Severity is a *minimum* (`--severity medium` includes critical/high/medium).

### `diffwise show`

```bash
diffwise show DW-1a2b3c4d5e
diffwise show DW-1a2b3c4d5e --json
```

Prints description, why it matters, consequences, recommendation, the exact
evidence excerpts, fix options and related findings. Finding ids are stable
hashes of rule + file + line + title, so the same defect keeps its id across
reviews.

### `diffwise chat`

Report-aware discussion. Answers cite file/line; citations that do not resolve
in the repository are dropped and counted.

```bash
diffwise chat "which services are affected by this change?"
diffwise chat --finding DW-1a2b3c4d5e "what is the safest fix?"
diffwise chat                       # interactive session (/finding, /clear, exit)
```

Without a configured provider the command exits `5` and explains which
environment variable to set. It never answers from a fabricated context.

### `diffwise fix`

```bash
diffwise fix DW-1a2b3c4d5e                       # list options
diffwise fix DW-1a2b3c4d5e --compare             # trade-offs side by side
diffwise fix DW-1a2b3c4d5e --preview             # validate a patch, write nothing
diffwise fix DW-1a2b3c4d5e --apply               # asks for confirmation
diffwise fix DW-1a2b3c4d5e --apply --yes         # explicit non-interactive approval
diffwise fix DW-1a2b3c4d5e --patch-file fix.patch --preview
diffwise fix --rollback fix-1a2b3c4d            # restore from the journal
```

Safety properties:

- `--apply` without `--yes` prompts when stdin is a TTY; otherwise it refuses
  and exits `8`, writing nothing.
- The patch is validated against the current files immediately before applying.
- File hashes captured at preview time are re-checked; if the working tree
  changed in between, the apply is refused.
- Writes are atomic (temp file + rename); every touched file is backed up to
  `.diffwise/backups/<transaction>/…​.bak` and recorded in
  `.diffwise/transactions/<transaction>.json`.
- Deletions need `--allow-delete`; paths outside the repository are refused;
  fuzzy matches are refused unless explicitly allowed by the API.

### `diffwise verify`

Runs `verification.command` from the config, records the real result in the
report, and exits `6` unless it passed. `not-run` is a first-class result: a fix
is never reported as verified without an execution.

```bash
diffwise verify
diffwise verify --finding DW-1a2b3c4d5e --json
```

### `diffwise report`

```bash
diffwise report                              # text summary of the latest review
diffwise report latest --format json --out review.json
diffwise report latest --format json --full  # full canonical report, not the envelope
diffwise report latest --format sarif --out diffwise.sarif
diffwise report latest --format html --out report.html
diffwise report latest --serve --open        # local server + browser
diffwise report 20261031-173530-60d0d5 --serve --port 4800
```

`--serve` binds `127.0.0.1` by default and prints a URL containing a one-time
token. The token is exchanged for an HttpOnly, SameSite=Strict cookie; the URL
is then clean. Non-loopback binding needs `--allow-public` and prints a warning.

### `diffwise history`

```bash
diffwise history --limit 10
diffwise history --json
```

### `diffwise compare`

```bash
diffwise compare latest previous
diffwise compare 20261031-173530-60d0d5 20261031-172955-bb94c8 --json
```

Reports risk/finding/file deltas plus resolved, introduced and still-present
findings.

### `diffwise config`

```bash
diffwise config list
diffwise config validate [--json]   # what a review would use, with warnings and errors
diffwise review --max-cost 0.50     # cost ceiling in USD; needs a `pricing` table
diffwise config get provider.model
diffwise config set provider.model "gpt-4o-mini"
diffwise config set verification.command "npm test"
diffwise config set qualityGate.failOn medium
```

Credentials are refused: `provider.apiKey` cannot be set here. Only the *name*
of the environment variable that holds the key is stored.

### `diffwise rules`

Introspect the rule catalogue and validate external packs.

```bash
diffwise rules list [--category security] [--json]
diffwise rules explain security.sql-injection [--json]
diffwise rules validate .diffwise/rules/security
diffwise rules install ./vendor/rule-pack [--force]
```

`list` prints every built-in and installed rule with category, severity and pack. `explain` shows the detection mode,
languages, evidence policy, provenance and any policy override or active suppression. `validate` exits `2` when any rule
has an error and prints every issue with the file that caused it. `install` records pack ids in
`.diffwise/rule-packs.json`; it refuses when validation fails unless `--force`.

### `diffwise reviewers`

```bash
diffwise reviewers list
diffwise reviewers explain security
diffwise reviewers plan [--json]
```

`plan` shows the reviewer selection for the latest review without calling a model: the score for each reviewer, the
signals behind it, and why the others were not run. This is the command to reach for when a review felt too quiet.

### `diffwise policy`

```bash
diffwise policy effective [path...] [--json]
```

Prints the resolved policy and, for each key setting, the layer that supplied it (organization, repository, directory,
file or default), plus the warnings produced while loading — an unknown field, an expired suppression, or an invariant
that had to be enforced.

### `diffwise evaluate`

```bash
diffwise evaluate [--dataset ./evals] [--json]
```

Runs a labelled evaluation dataset through the real pipeline and prints precision, recall, F1, severity accuracy,
verification rate and forbidden-finding violations, with the scope statement that says what the numbers do and do not
mean. Exits `1` when a forbidden finding is produced or a case fails to run. Missing fixtures are built automatically
from the dataset's `build-fixtures.mjs`.

### `diffwise version`

```bash
diffwise version --json
# { "version": "0.2.0", "reportSchemaVersion": 2, "jsonSchemaVersion": "1.0", … }
```

## Output contract

- **stdout** carries the result: text summary, JSON, SARIF, or the path to a
  written artefact.
- **stderr** carries progress, warnings, hints and errors.
- `--json` output is a single JSON document. Nothing else is written to stdout,
  so `diffwise review --json | jq` is always valid.
- Interactive prompts only appear when stdin *and* stdout are TTYs and no
  machine format was requested.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Quality gate failed: findings at or above the threshold. |
| 2 | Usage error: unknown command, flag or value. |
| 3 | Workspace error: not a git repository, bad config, unwritable report directory. |
| 4 | Review or finding not found. |
| 5 | AI provider missing, unreachable, or returned an unusable response. |
| 6 | Verification did not pass (failed, timed out, or not run). |
| 7 | Fix refused: not approved, stale, fuzzy, or unsafe. |
| 8 | Cancelled by the operator. |
| 9 | Internal error (a bug). |
| 10 | Model cost for this run exceeded `--max-cost` (the report is still written). |
| 11 | AI was required (`--ai-required` or `ai.required`) and the AI stage did not complete (the report is still written). |

### `--ai-required`

Turns the AI stage into a contract. The review still runs, is still written, and its deterministic findings are still
reported — but if the AI stage could not complete (no key, provider down, every reviewer lost), the command exits `11`
and the report records `review.ai.status` (`unavailable`, `disabled`, `partial` or `failed`) with the reason.

```bash
# The merge gate an AI-first team actually wants
diffwise review --base origin/main --head HEAD --ai-required --fail-on high
```

Without the flag, the same review exits `0`/`1` as usual and the report says `AI review unavailable:
Environment variable DIFFWISE_API_KEY is not set`. That is a legitimate outcome, not a silent one.

## Configuration file

`.diffwise/config.json`:

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
  "ai": { "enabled": true, "sendRepositoryContent": false },
  "analysis": { "maxFiles": 200, "maxFileBytes": 400000, "ignoreGlobs": ["**/node_modules/**"] },
  "verification": { "command": "npm test", "timeoutMs": 300000 },
  "qualityGate": { "failOn": "high" }
}
```

`provider.id` is a wire protocol, not a vendor: `openai-compatible` covers
OpenAI, Azure-style gateways, Ollama, LM Studio and most relays; `anthropic`
uses the Messages API. Unknown keys are ignored with a warning, invalid values
fall back to defaults, and a key placed in the file is rejected with an
explanation.

## Environment variables

| Variable | Effect |
|---|---|
| `DIFFWISE_API_KEY` (or the name in `provider.apiKeyEnvVar`) | Provider key. |
| `DIFFWISE_PROVIDER_ID`, `DIFFWISE_BASE_URL`, `DIFFWISE_MODEL`, `DIFFWISE_FAST_MODEL` | Override provider settings. |
| `DIFFWISE_API_KEY_ENV_VAR` | Use a different variable for the key. |
| `DIFFWISE_AI=off` | Disable AI for this process. |
| `DIFFWISE_SEND_CONTENT=1` | Allow sending related repository files (not just the diff). |
| `DIFFWISE_VERIFY_COMMAND` | Override `verification.command`. |
| `DIFFWISE_FAIL_ON` | Override the quality gate. |
| `DIFFWISE_MAX_FILES` | Override `analysis.maxFiles`. |
| `NO_COLOR`, `FORCE_COLOR` | Standard colour control. |

## CI usage

```bash
diffwise review --base "origin/${GITHUB_BASE_REF}" --head HEAD \
  --format sarif --out diffwise.sarif --no-input
diffwise review --base origin/main --head HEAD --json --fail-on high
```

Both forms are non-interactive, write to stderr only for diagnostics, and use
the documented exit codes. See `.github/workflows/diffwise-review.yml` for a
GitHub Actions example that uploads the SARIF file to code scanning.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `error Not inside a git repository` (exit 3) | Run inside a work tree or pass `--repo`. |
| `No AI provider is configured` (exit 5) | Export the variable named by `provider.apiKeyEnvVar`. Deterministic review still works. |
| `Quality gate failed` (exit 1) | Expected in CI. Adjust `qualityGate.failOn` or pass `--fail-on`. |
| `No verification command configured` (exit 6) | `diffwise config set verification.command "npm test"`. |
| Fix refused: "working tree changed" | The file changed after the preview. Re-generate or re-preview. |
| `report server` port in use | `--port 4800`. |
