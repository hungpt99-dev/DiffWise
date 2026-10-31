# Changelog

All notable changes to DiffWise are documented here. The format follows Keep a Changelog, and the project adheres to
Semantic Versioning.

## [0.1.0] — 2026-10-31

First working release: a local-first engineering review workspace for VS Code, verified end to end on a real
repository with a real model endpoint.

### Added

- **Review targets**: working tree, staged changes, branch comparison, commit range, selected files.
- **Change intelligence**: unified diff parsing (renames, binary, untracked), symbol extraction and symbol-level
  diffs, semantic change groups with recorded purpose basis.
- **Architecture impact**: resolved import graph, direct and transitive impact, cycles, coupling delta, boundary
  detection, measured repository conventions, interactive graph with before/after coupling.
- **Deterministic review**: 30 rules across security, concurrency, database, API contract, reliability, error
  handling, resources, configuration, maintainability, architecture and tests. Every finding carries evidence.
- **Documentation intelligence**: README/docs/ADR/OpenAPI analysis with resolved references, conflict detection,
  suggested updates and documentation patch previews.
- **Testing analysis**: test discovery, target resolution by path/import, coverage gaps, suggested scenarios with a
  copyable skeleton, real command execution with captured output.
- **AI interpretation**: provider-independent review with evidence validation, duplicate suppression and counted
  rejections; truncation retry and JSON salvage.
- **Fix recommendations**: 2–3 alternative solutions with trade-offs, machine-validated unified diffs, explicit
  approval, file backups, one-click revert.
- **Report-aware discussion**: whole-report and finding-scoped chat with structured citations validated against the
  repository.
- **Coding-agent context**: MCP server (interface v1) with eight recording tools and four read tools; intent-versus-
  implementation alignment.
- **VS Code integration**: activity bar views (status, findings, changed files, history), diagnostics, CodeLens,
  status bar, ten report sections, history restore, keybindings.
- **Storage**: local JSON reviews, append-only agent events, applied-fix log, backups.
- **Quality**: 63 unit/integration tests, 22 browser UI checks, 8 VS Code E2E checks, 16 screenshots, 2 GIF
  recordings, VSIX packaging.

### Fixed during verification

- Hardcoded-credential rule missed declarations with `export`/`static` modifiers.
- `Math.random()` used in camelCase token identifiers was not flagged.
- Method-qualified routes in documentation (`GET /api/health`) were not extracted.
- Cancellation during git collection surfaced as a git error instead of `ReviewCancelledError`.
- Persisted reports recorded a running persist stage and a truncated duration.
- Truncated model JSON discarded all findings instead of retrying and salvaging.
- Newly generated patched fixes did not become the selected option in the UI.
- Duplicate “Option A” prefixes in fix option labels.

### Known limitations

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md). Highlights: no pull-request ingestion, regex-level analysis for
non-TS/JS languages, provider-dependent AI quality, single-root workspaces, unsigned local VSIX.
