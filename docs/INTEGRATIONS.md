# Integrations

DiffWise is local-first. Integrations are optional adapters: nothing in the core pipeline requires GitHub, GitLab, Jira
or Confluence, and a review runs identically with none of them configured.

**Status of this document: this page describes the integration architecture and states plainly which parts are
implemented.** The platform work prioritised the review pipeline, verification, rule/policy platform and MCP surface.
External integrations are **not implemented** in 0.3.0. The interfaces below exist in design and in the
`ReviewReport.requirements` / `contextSources` fields, which are populated by tests but by no live adapter.

## What is implemented

| Item | State |
|---|---|
| `RequirementRecord` and `ContextSourceRecord` in the report, with `trusted: false` enforced by validation | implemented |
| Report validation that rejects an imported requirement not marked untrusted | implemented |
| Policy field `integrations.enabled` (accepted, no adapter reads it yet) | implemented, unused |
| CI producing results (SARIF/JSON) for a pipeline | implemented — see `docs/CI_CD.md` |

## What is not implemented

| Item | State |
|---|---|
| GitHub pull-request review: check runs, inline comments, review submission | not implemented |
| GitHub/GitLab webhooks with signature validation and idempotent processing | not implemented |
| GitLab merge-request notes and pipeline status | not implemented |
| Jira issue import, PR-to-ticket linking, requirement coverage | not implemented |
| Confluence and ADR synchronisation | not implemented |
| CI result ingestion back into a review | not implemented |
| External MCP client (connecting DiffWise to third-party MCP servers) | not implemented |

There is no hidden half-implementation behind any of these: no webhook route, no provider client, no fixture-driven
"adapter" that only works in tests. A review that mentions requirements today gets them from
`.diffwise/agent-events.jsonl` (records a coding agent wrote), not from Jira.

## The interface the adapters would implement

The design constraint that matters is that integrations must not leak into core. An adapter would be a producer of two
plain values:

```ts
interface RequirementProvider {
  id: string;                                  // 'jira', 'github-issues', 'confluence'
  /** Fetch the requirements relevant to a change. */
  fetch(input: {
    root: string;
    changedFiles: string[];
    /** Ticket ids discovered in branch name, commits and PR body. */
    hints: string[];
    signal?: AbortSignal;
  }): Promise<{ requirements: RequirementRecord[]; sources: ContextSourceRecord[] }>;
}

interface ReviewPublisher {
  id: string;                                  // 'github', 'gitlab'
  /** Post a review. Never merges, never approves a protected branch. */
  publish(input: {
    report: ReviewReport;
    /** Fail closed: a finding that cannot be mapped to a diff position is
     *  reported in the summary rather than dropped. */
    handleUnmappable: 'summary' | 'fail';
  }): Promise<{ posted: number; unmappable: number; url?: string }>;
}
```

Rules those adapters must obey, written down now so an implementation cannot quietly break them:

1. **Imported content is data, never instructions.** Everything from Jira, Confluence, a PR description or an issue body
   is fenced and labelled untrusted in every prompt, and `trusted: false` is enforced by report validation.
2. **Every requirement carries provenance and a timestamp.** A finding that cites a requirement can be traced to the
   document version it was read from.
3. **No credential in a report, log or tool argument.** Adapters read secrets from environment variables by name only,
   exactly as the existing provider configuration does.
4. **Idempotent by fingerprint.** Repeated runs must not post duplicate comments; the SARIF fingerprints already provide
   the stable identity of a finding across reviews.
5. **Fail closed on unmappable findings.** A finding that cannot be attached to a valid diff position is reported, never
   silently dropped and never attached to a guessed line.
6. **No merge, no approval.** An adapter may post a review and a check status. It may not approve, merge, or satisfy a
   branch-protection rule.
7. **Handling external failures.** A provider that is down degrades its context source to `unavailable` and the review
   proceeds; it never fails the review.

## Why this is the right order

A review platform that posts unverified comments to pull requests at scale is worse than no review at all: it trains
reviewers to ignore the tool. The evidence pipeline (deterministic rules → specialised reviewers → independent
verification → risk and approvals) is the part that decides whether a comment is worth posting, so it was built and
measured first. The adapters above are the remaining work, and they are additive: they consume `ReviewReport` and
produce `RequirementRecord`/`ContextSourceRecord`, both of which already exist and are validated.
