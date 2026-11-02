# Rule packs

A rule pack is a directory of declarative rules that DiffWise loads without being recompiled. It is the supported
extension point for organisation-specific policy: a payments team can require an idempotency key on every transfer
without forking the tool.

## Where packs live

```
.diffwise/rules/<pack>/pack.yaml      pack metadata (id, version, dependencies)
.diffwise/rules/<pack>/rules/*.yaml   one or more rules per file
```

A directory with rule files and no `pack.yaml` is still loadable — the id and version are derived from the directory
name and a warning is reported, which keeps a small in-repo rules folder usable. Additional packs can be loaded from
any path with `--rule-pack` (CLI) or `rulePackPaths` (application API).

Rule files may contain a single rule, a list of rules, or `{ rules: [...] }`.

## Rule schema

```yaml
id: java.transaction.self-invocation      # required, lower-case dot/dash separated
name: Spring Transaction Self Invocation  # required
version: 1.0.0                            # required, semver
category: database                        # required, one of the 14 finding categories
severity: high                            # critical | high | medium | low | info
confidence: medium                        # verified | high | medium | low
enabled: true
mode: deterministic                       # deterministic | ai-assisted | hybrid

languages: [java]                         # or `any`
frameworks: [spring]                      # informational; shown by `rules explain`
files: ['src/main/java/**']           # optional globs
exclude: ['src/main/java/legacy/**']  # optional exclusions within the scope
priority: 100                         # lower runs/reports first
enforcement: mandatory                # mandatory | advisory
blocksGate: false                     # true = a finding fails the quality gate regardless of severity

description: >
  Detect calls to transactional methods through self-invocation
  that may bypass Spring proxies.

detection:
  type: ast                               # pattern | ast | absence | forbidden-import
  node: call
  name: chargeCard
  receiver: this
  withinDecorator: Transactional
  withinClass: true

evidence:
  required: true                          # cannot be false for ai-assisted or hybrid rules
  note: The call site and the enclosing method body.

recommendation: >
  Move the transactional operation to another Spring-managed component.

references:
  - title: Spring reference — transaction management
    url: https://docs.spring.io/spring-framework/reference/data-access/transaction.html
examples:
  - bad: 'this.chargeCard(id)'
    good: 'paymentGateway.chargeCard(id)'
    note: The proxy is bypassed only in the first form.
tags: [transaction, proxy]
requires: [security@^1.0.0]               # pack dependencies (id@range)
extends: java.transaction.basic           # inherit detection from another rule
```

### Detection types

| `type` | What it matches | Deterministic |
|---|---|---|
| `pattern` | Regex against added lines (`scope: added`, the default) or the whole file (`scope: file`). `mustAlsoMatch` / `mustNotMatch` are evaluated inside a `window` of lines around the match. | yes |
| `ast` | A TypeScript/JavaScript syntactic shape: `call`, `new`, `method`, `property`, `decorator` or `import`, optionally scoped to a decorated member or a class. Non-JS/TS files are skipped and the reason is recorded. | yes |
| `absence` | Fires when a required regex is missing from a matching file — the shape of "this route has no authorization guard". | yes |
| `forbidden-import` | Fires on a module specifier match, e.g. `^@app/legacy/`, for dependency-boundary policy. | yes |

`mode: deterministic` rules run in the deterministic stage. `ai-assisted` and `hybrid` rules are **not** executed by
the deterministic engine: the engine records them as skipped with that reason and the AI stage is where their
interpretive half belongs.

## Validation

```bash
diffwise rules validate .diffwise/rules/security
diffwise rules list --category security
diffwise rules explain java.transaction.self-invocation
```

Validation is strict about anything that would make a rule silently wrong, and reports every problem with the file
that caused it:

| Condition | Result |
|---|---|
| Invalid regex, unknown category/severity/mode, missing `id`/`name`/`version`/`description`/`recommendation`, missing `detection` (unless `extends`) | **error**, rule dropped |
| Duplicate `id` inside a pack | **error**, later definition wins, both files named |
| Unknown top-level field | **warning**, rule still loads |
| `evidence.required: false` on an `ai-assisted` or `hybrid` rule | **warning**, forced to `true` |
| Dependency missing or out of range | **error**, the whole pack is blocked and none of its rules run |
| `extends` pointing at an unknown rule | **error** |
| Pattern longer than 600 characters, or a nested quantifier such as `(a+)+` | **error**, rejected as a ReDoS risk |
| Repeated `.*` or a very long alternation group | **warning** |

Rule-supplied regexes are compiled by DiffWise, and JavaScript cannot interrupt a runaway regex. The rejection above is
a heuristic and it is documented as one: a pack author can still write an expensive but non-catastrophic pattern.

## Precedence and overrides

The engine resolves, in order: pack `enabled` → policy `rules.enable[<id>]` → policy suppression.

```json
{
  "rules": {
    "enable": { "java.transaction.self-invocation": false },
    "severityOverride": { "security.hardcoded-secret": "critical" },
    "minSeverity": "low",
    "suppress": [
      {
        "ruleId": "security.sql-injection",
        "files": ["legacy/**"],
        "reason": "Legacy module scheduled for removal in Q2",
        "approvedBy": "hung",
        "expiresAt": "2026-06-30T00:00:00.000Z"
      }
    ]
  }
}
```

A suppression without an expiry is rejected at load time. An expired suppression is ignored and reported in the
policy warnings, so a suppression cannot quietly become permanent. `severityOverride` tags the finding with
`severity-overridden:<from>-><to>` so the change is visible in the report.

## Writing a rule that survives review

1. **Name the exact construct.** `pattern` on added lines, with `mustNotMatch` for the safe form, is usually better
   than a broad keyword.
2. **Require evidence.** A rule whose finding quotes the triggering line is verifiable; one that does not is an
   opinion. The verification engine rejects findings whose quotes do not resolve.
3. **Use the narrowest language and file scope.** A rule that fires in every file trains reviewers to ignore it.
4. **Add a `references` entry and an `examples` block.** They are shown by `rules explain`, and they are what a
   reviewer reads when deciding whether to trust the finding.
5. **Validate before committing**: `diffwise rules validate .diffwise/rules/<pack>`.
6. **Test the negative case.** A rule without a fixture where it must *not* fire will eventually fire everywhere.

## Rule provenance

Every finding records the rule that produced it (`ruleId`), and the report's pipeline section lists each rule with its
pack, status, finding count, duration and any error. A pack that failed to load is named; it is never silently absent.

## Import and export

`exportRulePack()` serialises a loaded pack back to YAML, which is what a team uses to fork an internal pack or to
review a change to one. `diffwise rules install <dir>` records installed pack ids in `.diffwise/rule-packs.json`; the
files themselves are read from `.diffwise/rules/` or the path passed at load time.

## Managing rules

A rule can be written by hand, created in VS Code, or created from the CLI. All three go through the same validator
and land in `.diffwise/rules/custom/<id>.yaml`:

```bash
diffwise rules create team.no-direct-db \
  --name "Controllers must not access repositories" \
  --category architecture --severity high \
  --pattern "repository\\." --files "src/controllers/**" \
  --exclude "**/*.test.ts" --enforcement mandatory --gate
diffwise rules test team.no-direct-db --max-files 400   # runs the detector, no review
diffwise rules enable team.no-direct-db
diffwise rules export --out team-rules.yaml
diffwise rules import team-rules.yaml
diffwise rules remove team.no-direct-db
```

`rules test` treats every selected file as if all its lines were added, so an `added`-scope rule can be evaluated
against the current tree. It reports files scanned, matched and skipped by scope: a rule that matches nothing is
usually a scope mistake, not a clean repository. Import validates the whole file first and writes nothing if any rule
is invalid, so a half-imported pack is impossible.

In VS Code, **Rules & Policies** lists custom and built-in rules, filters them, toggles them, edits them in a form,
tests them against the working tree and exports them. `priority` orders the list and the report; `enforcement:
advisory` turns the finding into a recommendation; `blocksGate: true` tags it `gate:blocking`, and the quality gate
fails on that tag even when the severity is below the threshold.

Rule conflicts are reported rather than resolved silently: two packs defining the same id (the later pack wins, both
files are named), and policy entries (`enable`, `severityOverride`, `suppress`) that name a rule that is not installed.
