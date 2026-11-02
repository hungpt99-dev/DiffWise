# Context-aware evolution — implementation status

Status of the 0.7.0 evolution. This file records what the repository contained before the change, what was added, and
what is deliberately still missing. It is a status report, not a roadmap: every "implemented" line is exercised by a
test or a recorded run in this repository.

## 1. Assessment of the 0.6.0 baseline

| Area | Baseline | Reused rather than replaced |
|---|---|---|
| Review pipeline | `core/analysis/pipeline` stages: collect, parse, graph, context, agent, rules, AI, correlate, verify, risk, persist | The new `impact` stage and documentation index plug into the same tracker and report |
| Rules | Built-in rules + declarative YAML packs with strict validation, ReDoS screening, policy precedence | The manager writes through the same validator; no second schema |
| Policy | org → repository → directory → file, per-field provenance, snapshot on the report | Added policy-history hashing; precedence untouched |
| Documentation | Reference-based drift detection over Markdown/OpenAPI | Added sources, indexing and bounded retrieval; the detectors are unchanged |
| Graph | TypeScript import/call edges, direct/transitive impact, cycles, coupling | Added dimensions the graph cannot express; the graph is reused as code/module evidence |
| Reviewers | 8 specialised reviewers, deterministic selection, budgets, evidence validation | Added 4 roles and documentation context; orchestration unchanged |
| Providers | 3 adapters (`openai-compatible`, `anthropic`, `ollama`) and one model per task | Extended the factory and registry; the AI layer is still the only model I/O |
| MCP | Server with 42 tools (0.6.0); no client | Server untouched; client added in `app`, with its own permission model |
| Persistence | JSON + SQLite store, one index | Added `policy-history.jsonl`, `mcp-audit.jsonl`; report schema stays v3 |
| Interfaces | CLI 17 commands, 42 MCP tools, 12 web sections, VS Code extension | Added commands/sections/tools; all still call `DiffWiseService` |

Baseline defects found and fixed while doing the work:

1. **SQLite handles were never closed.** `runReview` opened a store for agent events and reused it for persistence; the
   service cached one store forever. On Windows the database file stayed locked, so test teardown failed with `EBUSY`
   and a CLI process could not delete or replace `.diffwise/`.
2. **Repository-boundary checks compared path strings.** `resolveInside` (and the CLI's `normalisePath`) compared a
   `path.resolve` result against the git root, which git reports with forward slashes on Windows. Every source read in
   the report server returned 403 (`Path escapes the workspace`) on this platform.
3. **MCP test fixtures were deleted before the server process exited**, which also produced `EBUSY` on Windows.
4. **The default test runner exhausted memory** when several integration files ran in parallel forks; the suite now
   runs in one fork (57 s on this Windows machine).
5. **README/version drift**: the package version, VS Code VSIX name and test/MCP counts are now generated from the
   actual values at the time of writing.

## 2. What was implemented in 0.7.0

### Rules and policy

- Rule model: `priority`, `exclude`, `enforcement`, `blocksGate`; validated, exported and used by the detector.
- `RuleStore` (core): create, update, enable/disable, delete, import (atomic), export, test against a repository.
- CLI: `rules create|update|remove|enable|disable|test|export|import`.
- VS Code: **Rules & Policies** panel with filter, editor, test result, built-ins and conflict warnings.
- Gate: a `gate:blocking` finding fails `qualityGate()` even below the severity threshold.
- Policy: every review records a hash of its effective policy; `policy history` lists versions and layers.

### Documentation intelligence

- `documentation.sources` (path/glob, category, priority, enabled, modules) in `config.json`.
- `core/docs`: heading-section index, content hashing, duplicate detection, incremental update, lexical + path/symbol
  retrieval with `maxSections`/`maxChars`, and index statistics.
- Pipeline: sources are a scope; retrieved sections are attached to the report and passed to reviewers as untrusted,
  attributed context; documentation findings keep document/heading/line evidence.
- CLI: `docs list|index|add|remove|enable|disable`; VS Code: sources UI in the Documentation section.
- Envelope: `documentationImpact.index` and `documentationImpact.retrieval`.

### External MCP client

- JSON-RPC client for stdio and Streamable HTTP (session id, SSE parsing), initialize/tools/resources/prompts/call.
- Per-connection permissions (`readOnly`, allow-lists, context tools, output cap, timeout, `allowWrite`), read-only
  default, explicit approval for write tools, error isolation, per-review context budget, hashed audit log.
- Context tool and/or resource configuration (`{{files}}`, `{{symbols}}`, `{{terms}}` substitution); each used once per
  AI review, with the resource read gated by the same allow-list.
- CLI: `mcp list|status|add|update|remove|enable|disable|test|tools|call`; VS Code: **MCP Connections** panel.
- Three read-only server tools: `get_impact_analysis`, `get_documentation_sources`, `get_mcp_connections`.

### Providers and routing

- 16 profiles plus a custom endpoint: OpenAI, Anthropic, Gemini (native), DeepSeek, Mistral, OpenRouter, Groq,
  Together, Fireworks, Azure OpenAI, Bedrock (OpenAI-compatible), Vertex (OpenAI-compatible), Ollama, LM Studio, vLLM,
  `openai-compatible`, `custom`.
- `providers[]` profiles and `routing` per task/reviewer, per-task model overrides, explicit fallback, cross-provider
  fallback refused while repository content is shared, recorded routes.
- CLI: `providers list|add|update|remove|route`; VS Code: **AI Providers** panel with routing table and connectivity
  test. Secrets stay in named environment variables.

### Architecture impact

- `core/analysis/impact`: code, module, service, API, database, event, configuration, testing and documentation
  dimensions. Every item carries a relation, provenance (`static`, `configured`, `documentation`, `mcp`, `historical`,
  `ai`), confidence and evidence. Removed routes, changed signatures, destructive migrations without rollback, event
  producers/consumers, env-var changes and affected tests/docs are detected.
- Risk: new explainable factors for breaking interfaces, migration risk, event surfaces and cross-service coupling.
- UI: impact summary, dimension counts, breaking counts, filterable relationship list and explicit coverage limits.
- MCP: `get_impact_analysis`; envelope: `architectureImpact.system`.

### Reviewers

- API contract, reliability, documentation and maintainability reviewers added (12 total), with selection signals and
  deterministic category mapping. Reviewer-specific model routing is supported through `routing`/`models`.
- Retrieved documentation sections are included in reviewer context, fenced as untrusted and budgeted separately.

## 3. What is still not implemented

These are real gaps, not roadmap items:

| Gap | Why it is not done | Consequence |
|---|---|---|
| PDF and binary document parsing | No parser dependency was added; the index lists supported text formats only | A PDF source is not indexed; the limit is stated in LIMITATIONS.md |
| Native AWS Bedrock (SigV4) / Vertex service-account auth | Requires request signing or OAuth token minting; an untested signer is worse than an explicit limitation | Use the OpenAI-compatible endpoints with a bearer token/API key |
| Semantic/vector documentation retrieval | Deliberately excluded: lexical + graph retrieval is measurable and does not replay an answer against different context | A paraphrase not sharing terms with the change may not be retrieved |
| Automatic MCP tool discovery for context | Review only calls a configured context tool/resource; discovery exists (`mcp tools`) but is not used to improvise queries | A server without a `context` block contributes nothing to a review |
| Rule management for built-in rules | Built-ins are code; their severity/enablement is policy, not a YAML file | The editor shows them read-only and points at `policy.json` |
| Approval/decision UI in VS Code | The engine computes state; the editor still has no decision control | Approvals remain a CLI/MCP operation |
| Real GitLab CI execution, inline PR comments | Not part of this change | CI publishes SARIF/JSON only |
| Cross-language call graphs beyond TS/JS | Parser limitation, documented | Impact for Java/Python/etc. is textual and says so |
| Incremental *analysis* (not just indexing) | Every review re-parses changed files | Documentation index is incremental; deterministic analysis is not |

## 4. Verification

Run on Windows 10, Node 24.21, 2026-11-02:

```
npm run build       # 7 workspaces
npm run typecheck   # 7 workspaces, 0 errors
npm test            # 34 files, 380 tests, all pass
```

Additional recorded checks in this change:

- CLI: created, tested, listed, exported and removed a custom rule on the demo repository; added a documentation
  source and printed the index; added provider profiles and a security route; connected to a stdio MCP server, listed
  its tools, called a read-only tool, and observed a write tool refused and audited.
- Review: `diffwise review main..HEAD --no-ai --format json` on the demo repository produced `architectureImpact`
  (31 items across 7 dimensions, including API removals and a destructive migration) and `documentationImpact.index`.
- Policy: a review appended one history entry; `diffwise policy history` printed it.

## 5. Engineering constraints held

- `core` still has no dependency on `ai`, no network I/O and no interface imports.
- Only `ai` performs model network I/O. The MCP client is application-layer tool I/O; it is isolated in `app`.
- `app` remains the orchestration boundary; every interface calls `DiffWiseService` or the workspace services.
- The report schema remains v3. New fields are additive and optional; `migrateReport` and validators are unchanged.
- Every finding still requires evidence; AI findings still pass the verification engine before publication.
- API keys remain environment-variable names; MCP credentials must be `${ENV_VAR}` references.
- A deterministic review without a provider still runs, and still says it is deterministic.
