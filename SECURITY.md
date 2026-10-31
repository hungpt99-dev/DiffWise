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
