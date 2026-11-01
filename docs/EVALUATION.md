# Evaluation

Evaluation answers one question with evidence: *how well does the detector work on defects whose presence is known in
advance?* It is deliberately a small, labelled, reproducible corpus — not a claim about real-world recall.

## Run it

```bash
npm run eval:build          # materialise the fixtures (8 small git repositories)
npm run eval                # run the corpus and print measured metrics
npm run eval -- --json      # machine-readable report
```

Fixtures are generated, not committed: each case is a real git repository with a `main` commit and a `feature` branch
that introduces exactly one defect class. `diffwise evaluate` builds them automatically when they are missing.

## The corpus

`evals/dataset.json` defines 8 cases and 13 labelled findings. Each expectation names the file, an acceptable line
window, the category and the severity at which the defect would matter.

| Case | Defect | Expected findings |
|---|---|---|
| `sql-injection` | query built by string concatenation | `security` high, `performance` low |
| `hardcoded-secret` | live API key committed | `security` critical |
| `destructive-migration` | `DROP COLUMN` on a populated table | `database` high, `database` medium (no rollback) |
| `n-plus-one` | query per element in a loop | `performance` medium ×2, `performance` low |
| `lost-update` | read-modify-write without a lock | `concurrency` high |
| `swallowed-error` | empty catch block | `error-handling` medium |
| `api-breaking-change` | exported signature changed under its caller | `api-contract` high |
| `missing-idempotency` | retryable transfer with no idempotency key | `reliability` high, `api-contract` high |

Cases also carry `forbidden` entries: locations where a finding would be a false positive. Producing one is a hard
failure of the run, not a percentage.

`ignoreCategories` excludes documentation and maintainability findings from the precision computation, because the
corpus deliberately does not label documentation drift. Excluding them is stated in the dataset rather than hidden in
the metric.

## Metrics and what they mean

| Metric | Definition |
|---|---|
| `detected` | expectations whose defect was found, at any severity |
| `matched` | expectations found at the labelled severity or better |
| `precision` | `detected / found` |
| `recall` | `detected / expected` |
| `f1` | harmonic mean of the two |
| `severityAccuracy` | `matched / detected` |
| `verificationRate` | share of detected findings that reached `CONFIRMED` or `LIKELY` |
| `forbiddenViolations` | findings produced in a location the corpus marks as safe — must be zero |

A defect found at the wrong severity counts as detected but reduces `severityAccuracy`; it is not double-counted as a
miss and a false positive.

## Measured result

Run on this machine (`node evals/build-fixtures.mjs` then `npm run eval`), recorded in
`docs/evidence/evaluation-run.json`:

```
precision 1.0   recall 1.0   f1 1.0   severity 1.0   verification 1.0
expected 13   found 13   detected 13   matched 13   forbidden violations 0
```

**Read this carefully.** A perfect score on 13 labelled findings in 8 tiny fixtures is weak evidence. It says the
detector finds the eight defect classes it was designed for, when they appear in the shape it recognises. It does not
say anything about recall on real code, and the report prints that caveat with the numbers.

## The first run, before tuning

The honest baseline, from the first execution of the corpus:

```
precision 0.438   recall 0.875   f1 0.584   severity 1.0   forbidden violations 0
```

Two things were wrong and both were fixed in code, not in the metric:

1. **A real false positive.** The N+1 rule matched `await fetch('/api/sync')` inside a loop and reported it as a
   database round-trip. The rule now requires a database-ish receiver (`repository.`, `db.`, `prisma.`, `em.`,
   `.query(`, `.findOne(` …). `swallowed-error` no longer produces a phantom database finding.
2. **An incomplete corpus.** Several findings were real secondary defects in the fixtures (a migration with no
   rollback, a new required parameter on an exported function, an unbounded `SELECT *`) that the dataset had not
   labelled. They were added as expectations because they are genuinely present, not because they were produced.

The remaining precision loss came from documentation findings, which the corpus now explicitly excludes.

## Adding a case

1. Add the fixture files to `evals/build-fixtures.mjs` (`base` and `feature` overlays).
2. Run `npm run eval:build` and confirm the repository looks right.
3. Add the case to `evals/dataset.json` with expectations that describe the *defect*, including secondary defects the
   fixture genuinely contains.
4. Add `forbidden` entries for nearby code that must not be flagged — that is what protects specificity.
5. Run `npm run eval` and read the per-case output, not just the totals.

A case whose expectation you had to adjust after seeing the output is worth writing down: it is either a corpus bug or
a detector bug, and the distinction belongs in the commit message.

## Using it as a regression gate

`diffwise evaluate` exits `1` when a forbidden finding is produced or a case fails to run, and `0` otherwise. That makes
it usable in CI as a specificity gate: a rule change that starts flagging safe code fails the build.
