# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately to the maintainer:

- GitHub Security Advisory: <https://github.com/hungpt99-dev/DiffWise/security/advisories/new>
- Email: the address listed on the maintainer's GitHub profile

Include a description, reproduction steps, affected version, and any proof of concept. You can expect an
acknowledgement within 72 hours and a remediation plan within 7 days for confirmed issues.

## Threat model

DiffWise reads untrusted repository content and sends bounded excerpts to a model provider that the user configures.
The relevant threats and controls:

| Threat | Control |
|---|---|
| Prompt injection in a source file or document | Content is fenced as untrusted, the system prompt forbids following it, findings must quote real text, and chat citations are validated against the repository |
| Fabricated findings or file paths from a model | A model finding is discarded unless its file exists and its quoted evidence appears in that file; rejections are counted |
| Fabricated chat citations | Every citation is resolved to a real file and line; invalid ones are dropped and disclosed |
| Credential leakage into prompts, reports or logs | Credential patterns are redacted before payloads are sent; API keys are read from the environment and never written by DiffWise |
| Patch path traversal | Paths are resolved inside the repository; `..`, absolute paths and null bytes are rejected |
| Destructive patch | Deletions, migrations and workflow changes are flagged and require a second confirmation; files are backed up first |
| Arbitrary command execution | The only command executed is the developer-configured verification command, and only after explicit approval in the report or a modal |
| Automatic code modification | No patch is applied without an explicit approval checkbox; revert is always available |
| Cross-workspace data leakage | Storage is per repository (`.diffwise/`); the extension does not read other workspaces |
| Secret exposure in screenshots or issues | The settings UI never renders key values; templates ask contributors to redact |

## Non-goals

- DiffWise is not a sandbox. A configured verification command runs with the developer's privileges, by design.
- DiffWise does not audit the model provider's retention or logging. Choose a provider whose data policy you accept,
  or use a local provider.
- The VSIX is not signed or published through a marketplace in 0.1.0.

## Hardening recommendations

- Prefer a local provider (Ollama, LM Studio, vLLM) for proprietary code.
- Leave `diffwise.ai.sendRepositoryContent` off unless you need cross-file reasoning.
- Keep `diffwise.analysis.maxFiles` and `maxFileBytes` bounded on very large repositories.
- Review generated patches line by line; validation proves that a patch applies, not that it is correct.
- Treat a `partial` analysis as incomplete, especially when the AI stage failed.

## Threat model (0.3.0)

DiffWise reads a repository, optionally sends bounded excerpts to a model provider, and can apply a patch the developer
approved. Those three facts define the threats.

### Assets

| Asset | Why it matters |
|---|---|
| Provider credential | a leaked key is a direct financial and reputational cost |
| Repository source | often confidential; a review must not exfiltrate it |
| The developer's working tree | an unapproved write destroys work |
| The integrity of a verdict | a false `CONFIRMED` is worse than no review |
| The audit trail | decisions must be reconstructable |

### Threats and controls

| Threat | Control | Where | Test |
|---|---|---|---|
| Prompt injection in a file or document | Repository content is fenced as `<untrusted-file>` with an explicit instruction not to follow instructions inside it; findings must quote real text; a quote that does not exist rejects the finding | `ai/src/reviewers/prompts.ts`, `core/review/orchestrator.ts` | `security.test.ts` — "prompt injection in repository content" |
| Secret leakage to a provider | `redactSecrets()` runs over the diff and every file excerpt before assembly; the count of redactions is recorded | `ai/src/reviewers/scope.ts` | `security.test.ts` — "secret redaction before a model call" |
| Secret leakage into a report | Credentials are never part of a `ReviewReport`; provider config stores only the *name* of the environment variable | `app/src/config.ts`, `core/types.ts` | `config.test.ts` |
| Model invents a file, line or quote | Evidence validation requires the file to be in the review, the line to exist, and at least one quote to resolve | `core/review/orchestrator.ts` | `review.test.ts`, `platform.test.ts` |
| Model-only agreement treated as proof | `CONFIRMED` requires static, test, runtime or human evidence; the report validator rejects a model-only `CONFIRMED` | `core/verification/engine.ts`, `core/report/schema.ts` | `verification.test.ts`, `report/schema.ts` validation |
| Unsafe command execution | Commands come from repository manifests or policy, never from a model; execution requires explicit approval; the plan marks commands that cannot be isolated | `core/testplan/*` | `security.test.ts` — "command execution safety" |
| Path traversal in a patch | `isSafeRelativePath` + workspace resolution reject any path outside the repository; deletion needs an extra flag | `core/fixes/patch.ts` | `patch.test.ts` |
| Malicious rule pack | Paths are contained (symlinks that escape are refused), regexes are screened for catastrophic backtracking, packs are data and never executed | `core/rules/loader.ts`, `core/rules/definition.ts` | `security.test.ts` — "malicious rule packs" |
| Pack escapes its directory | `safeResolve()` realpaths the target and refuses anything outside the pack root | `core/rules/loader.ts` | `security.test.ts` |
| AI approves a change | Decisions carry `actorKind`; only `human` counts toward an approval; the state machine cannot reach `APPROVED` from an AI decision | `core/policy/approval.ts` | `policy.test.ts`, `platform-tools.test.ts` |
| Silent permission grant | A duplicate MCP tool name fails server startup; there is no path by which a tool registers a permission for another | `mcp/src/server.ts` | `platform-tools.test.ts` |
| Unaudited agent actions | Every MCP call appends to `.diffwise/mcp-audit.jsonl` with a hashed argument digest | `mcp/src/tools/audit.ts` | `platform-tools.test.ts` |
| Webhook spoofing | Not applicable yet: no webhook receiver is implemented | — | — (documented in `docs/INTEGRATIONS.md`) |
| Report server exposure | Loopback by default, one token per run, `HttpOnly; SameSite=Strict` cookie, CSRF header, strict CSP, workspace-confined file serving | `app/src/server.ts` | `delivery.test.ts` |

### Explicit non-goals

- **No sandbox for test execution.** `verification.sandbox` is declared; only `none` has an executor. A command that
  needs the network is marked `sandboxable: false` and the plan says so rather than pretending otherwise.
- **No multi-user authorisation.** The report server is single-session and loopback by default.
- **No protection against a malicious provider.** A model provider sees the excerpts it is sent; the redaction layer
  limits what that includes, and `sendRepositoryContent` defaults to `false`.
- **No integrity checking of imported documents.** When integrations exist, imported content is untrusted input by
  contract (`trusted: false`, enforced by report validation), not verified content.
