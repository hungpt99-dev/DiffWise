# Verification

A finding is a claim. Verification is the part of DiffWise that decides which claims the repository actually supports,
and records enough for a reviewer to disagree with the verdict.

## The five verdicts

| Verdict | Meaning | What can produce it |
|---|---|---|
| `CONFIRMED` | A non-model evidence class supports the defect and nothing contradicts it | Human confirmation, a recorded failing test/runtime execution, or quoted evidence plus a structural fact that demonstrates the defect |
| `LIKELY` | Supported but not demonstrated | Resolved evidence, a structural check on a conditional hazard, or independent model agreement |
| `DISPUTED` | Verifiers or checks disagree | At least one supporting and one contradicting signal |
| `UNVERIFIED` | Nothing was checked | No evidence check resolved and no verifier ran |
| `REJECTED` | The claim is contradicted | Cited evidence does not exist, the cited line is past the end of the file, the file is absent, or a human rejected it |

**The invariant that matters most:** a finding is never `CONFIRMED` because several models agreed. Agreement is recorded
(`corroborated`, `verifiers[]`) and is worth reading — it is not proof. The report UI says so next to the verdict.

## The five evidence classes

Every verdict records which classes supported it:

| Class | Source | Can it confirm? |
|---|---|---|
| `static` | Deterministic rule, resolved quotation, structural fact | yes |
| `test` | A recorded execution that failed | yes |
| `runtime` | Recorded runtime observation | yes |
| `human` | A recorded human decision | yes |
| `model` | Reviewer or verifier interpretation | **no** |

## The checks

Deterministic checks run on every review, with or without a model. Each one records an outcome (`supports`,
`contradicts`, `inconclusive`) and a sentence explaining what was looked at.

| id | Kind | Question |
|---|---|---|
| `file.exists` | evidence | Is the cited file part of this review? |
| `range.exists` | evidence | Does the cited line exist in the file? |
| `evidence.quotes` | evidence | Do the quoted excerpts occur in the file (or in the previous revision, for removed code)? |
| `range.in-change` | structural | Is the cited range part of this change, or pre-existing? |
| `test.execution` | evidence | Is there a recorded run that failed on this finding? |
| `human.confirmation` | evidence | Has a human accepted or rejected it? |
| `security.sink` | structural / heuristic | Is a query or command sink built from interpolated input here? |
| `security.secret-literal` | structural | Is a credential-shaped literal assigned near the line? |
| `database.ddl` | structural | Is destructive DDL present? |
| `database.query-in-loop` | heuristic | Is a query inside a loop (N+1 shape)? |
| `concurrency.shared-write` | heuristic | Is shared state written with no visible lock, atomic or transaction? |
| `tests.covering-file` | structural / heuristic | Does a test file reference the changed module? |

Only `evidence` and `structural` checks can support a confirmation. A `heuristic` can raise a finding to `LIKELY` and
never further — that distinction is enforced in code, not in prose.

## Evidence normalisation

Producers record evidence in the form they found it: a rule may keep the diff's `+`/`-` marker or a `NNN: ` context
prefix; a model quotes a line verbatim. Verification strips that decoration before matching (`cleanQuote`), because the
question is "does this text exist in the file", not "was it formatted the way the engine would have".

This matters: before the normalisation existed, the engine rejected 23 of 25 valid findings in the demo repository as
"quote not found". It is recorded in `docs/QUALITY_CHECKLIST.md` as a defect found by the corpus, not as a design choice.

## Severity and confidence recalculation

Severity is capped by the verdict, and the cap is always explained:

| Verdict | Severity cap |
|---|---|
| `CONFIRMED` | no cap |
| `LIKELY` | `high` |
| `UNVERIFIED` | `medium` |
| `DISPUTED` | `medium` |
| `REJECTED` | `low` |

A `critical` claim supported only by model interpretation becomes `high` with the reason printed. This is deliberate:
an undemonstrated critical claim is not a critical finding, and treating it as one is how review tools lose trust.

## Grouping and de-duplication

Before verification, findings are normalised and grouped: same file, overlapping or near-by ranges (2 lines of slack),
compatible category family, and either the same rule or sufficient title similarity. Grouping is deliberately
conservative — over-merging hides real defects, which is worse than showing a duplicate.

`corroborated` means a deterministic rule **and** a reviewer independently described the same defect. Two reviewers
agreeing is corroboration of an interpretation, not of a defect.

## Publication

`verification.minimumStatus` (default `UNVERIFIED`) sets the floor for the published finding list. Findings below the
floor are **withheld, not deleted**: they are stored in `withheldFindings` and shown in the UI's withheld section, so a
policy decision stays auditable.

## Verification with no model

`diffwise review --no-ai` still runs the full verification engine. On the demo repository it reports 25 published
findings: 7 `CONFIRMED` from static evidence, 18 `LIKELY`, 0 rejected. The model adds opinions; it does not gate the
verdicts.
