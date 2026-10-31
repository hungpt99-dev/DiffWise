# Demo repository

The demo is a small payments service with one feature commit that adds partial refunds. It exists so DiffWise can be
experienced without touching real production code, and so tests and screenshots use a reproducible artefact.

## Build it

```bash
node demo/build-demo-repo.mjs --target /tmp/diffwise-demo
```

The script creates a git repository with:

- `main`: the initial service (charge, fee calculation, settlement batch, typed errors, a repository abstraction).
- `feature/partial-refunds`: one commit that adds refunds, a refund policy, a migration, documentation changes and
  tests.

Nothing is committed inside this project: the fixture is two overlays (`base/` and `feature/`) materialised into a
temporary directory.

## What to look for

The feature commit contains deliberate, realistic defects:

| Area | Defect |
|---|---|
| Security | A signing key is hardcoded in `PaymentService` |
| Security | A refund statistics update is built with SQL string interpolation |
| Database | `002_refunds.sql` drops a column (irreversible) and has no rollback |
| API contract | `GET /api/settlements/pending` is removed while `openapi.yaml` still declares it |
| API contract | `calculateFee` gains a required `currency` parameter; callers and tests still pass one argument |
| Concurrency | The refund path reads a payment, mutates it in memory and writes it back |
| Reliability | The refund route has no idempotency guard |
| Error handling | A failing refund is swallowed by an empty catch |
| Documentation | `docs/payments.md` says per-merchant limits are enforced; the code never calls the policy |
| Tests | The refund path has no concurrency test; the existing tests now fail on the new signature |

The repository also ships recorded agent context in `.diffwise/agent-events.jsonl` (intent, plan, decision, rejected
alternative, constraint, activity, partial verification, unresolved issue), which is what makes the intent-versus-
implementation section meaningful.

## Review it

```bash
node scripts/analyze.mjs \
  --repo /tmp/diffwise-demo --mode branch --base main --head feature/partial-refunds \
  --out /tmp/diffwise-report.json --no-ai
```

Or open the folder in VS Code with the extension installed and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>.

## Install and test

```bash
cd /tmp/diffwise-demo
npm install
npx vitest run
```

Before the fix, two tests fail because `calculateFee` requires a currency. That is intentional: the fixture
demonstrates a signature change that was not propagated to its tests.
