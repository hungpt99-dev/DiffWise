# CI/CD integration

DiffWise is designed to run in a pipeline without a model, without a network and without an editor. This guide covers
what is implemented today and what is not.

## What exists

| Capability | Command | Notes |
|---|---|---|
| Headless review of a change | `diffwise review <range> --json` | no provider required |
| Quality gate on severity | `diffwise review --fail-on high` | exit `1` when the gate fails |
| SARIF export for code scanning | `diffwise review --format sarif --out out.sarif` | SARIF 2.1.0, structurally validated |
| Machine-readable findings | `diffwise findings --json`, `diffwise show <id> --json` | stable envelope |
| Verification command execution | `diffwise verify` | opt-in, requires a configured command |
| Rule pack validation | `diffwise rules validate <dir>` | fails on any error |
| Policy introspection | `diffwise policy effective --json` | includes warnings |
| Evaluation gate | `diffwise evaluate` | exits `1` on a forbidden finding or a failed case |
| MCP for coding agents | `diffwise-mcp --root <repo>` | stdio; 42 tools (19 in interface v1, 23 added in v2) |

Exit codes are stable and documented in `docs/CLI.md`: `0` success, `1` gate failed, `2` usage, `3` workspace, `4` not
found, `5` provider, `6` verification failed, `7` fix rejected, `8` cancelled, `9` internal.

## GitHub Actions

```yaml
name: diffwise
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # only needed for the SARIF upload
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # the review needs both refs

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: npm ci
      - run: npm run build

      - name: Review the pull request
        run: |
          npx diffwise review "origin/${{ github.base_ref }}...HEAD" \
            --format sarif --out diffwise.sarif \
            --fail-on high --no-ai

      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: diffwise.sarif
```

`.github/workflows/diffwise-review.yml` in this repository is a working example of exactly this job.

Notes:

- `--no-ai` keeps the job deterministic and free. Drop it and configure a provider if you want reviewer findings; the
  job then needs the API key as a secret.
- `fetch-depth: 0` matters: a shallow clone cannot resolve `origin/main`.
- The quality gate reads effective severities, so a finding capped by verification is gated at the capped level.

## GitLab CI

```yaml
diffwise:
  image: node:22
  rules:
    - if: $CI_MERGE_REQUEST_IID
  variables:
    GIT_DEPTH: 0
  script:
    - npm ci
    - npm run build
    - npx diffwise review "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME...HEAD" --fail-on high --no-ai --format json --out diffwise.json
  artifacts:
    when: always
    paths: [diffwise.json]
```

GitLab can consume the JSON artefact directly, or `--format sarif` if the instance has code-quality ingestion enabled.

## Generic CI

Any runner that can execute a shell command can run DiffWise:

```bash
npm ci && npm run build
npx diffwise review "$BASE...HEAD" --fail-on high --no-ai --format json --out review.json
```

Read `review.json` for the envelope, or `diffwise findings --json` for a flat list. `--json` output is written to stdout
and nothing else is: progress goes to stderr, so `diffwise ... --json | jq` is safe.

## Ingesting CI results into a review

`docs/INTEGRATIONS.md` describes the provider-neutral ingestion interfaces. **CI result ingestion into a review is not
implemented**: DiffWise produces results for CI, but does not yet read CI failures back into a report.

## What is not implemented

- **Pull-request ingestion.** DiffWise does not create PR/MR reviews, inline comments or check runs. It reviews local git
  targets, which a CI job sets up with a ref range.
- **Webhook receivers.** No GitHub/GitLab webhook endpoint, no signature verification, no idempotent event processing.
- **Remote review posting.** Findings are written to artefacts, not to a pull request.

The provider-neutral interfaces for these exist in the architecture (`docs/ARCHITECTURE.md` → "Integrations"), but they
have no implementation and no tests, and this document will not claim otherwise.
