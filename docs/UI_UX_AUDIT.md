# UI/UX audit — web report and VS Code webview

Scope: `packages/webview` (12 sections, 460 CSS rule blocks) as it renders in the VS Code webview, the standalone
report server and the static HTML export. Method: read the design system and every section component, then drive the
production build in Chromium at 1600×1000, 860×720 and 600×800, screenshot each view and inspect the rendered output.
Where a claim is visual, the screenshot that proves it is named.

## 1. What is already good, and should not be rebuilt

- **Theme mapping is real.** Every core colour is a VS Code variable with a dark fallback
  (`--vscode-editor-background`, `--vscode-panel-border`, `--vscode-button-background`, …), so the surface follows the
  editor theme instead of fighting it.
- **Density is appropriate.** 13px base, 12px mono for identifiers, 10–11px uppercase micro-labels; cards are compact
  rather than padded into emptiness.
- **Severity is encoded consistently** (colour + text label, never colour alone) via `SeverityBadge`.
- **Progressive disclosure exists** in the places that need it: finding detail tabs, fix comparison, collapsible
  evidence.
- **States are mostly implemented**: skeletons/empty states per section, `Banner` for partial analysis, explicit
  "requires a host" refusal in standalone mode instead of a disabled-looking button.
- **Reduced motion is honoured** (`@media (prefers-reduced-motion: reduce)`).

Rebuilding this would cost weeks and lose the VS Code integration. The work below is refinement.

## 2. Information architecture

The rail order already follows the developer's questions rather than the pipeline's internals:

| Question | Section |
|---|---|
| Is this change safe? | Overview (risk + completeness + factors) |
| What changed? | Change Explorer |
| What does it touch? | Architecture Impact |
| What are the problems? | Code Review (badge = finding count) |
| Can I trust them? | Verified Findings |
| What did the analysis actually do? | Review Pipeline |
| What must I change elsewhere? | Documentation, Testing |
| What did the agent do? | Agent Activity |
| Can I ask about it? | Discussion |

No section was added in this cycle. One was enriched (AI usage, inside Overview) because the product now has data
that a reviewer needs in order to trust a run.

## 3. Issues found and fixed

| # | Issue | Evidence | Fix |
|---|---|---|---|
| U1 | Sidebar said **`AI off`** on a report produced with AI (the status bar of the same screen said "27 model request(s)") | `ui-overview-wide.png` before the fix | rail derives its state from `report.ai.requests` first; shows `AI · 27 req` with provider/model in the title |
| U2 | Footer claimed **`DiffWise 0.1.0`** on a 0.3.0 report | screenshot | footer reads `report.execution.toolVersion` |
| U3 | Usage table: numeric headers left-aligned, cells right-aligned; task column 34 % wide and empty | `ui-usage-wide.png` (first render) | numeric headers right-aligned, `table-layout: fixed`, task column 24 % at wide / 34 % at narrow |
| U4 | Latency rendered as `5m`, ambiguous next to `ms` values | screenshot | `5m 20s` / `1.4s` / `850ms` |
| U5 | Cache column showed `—` for both "no hits" and "not reported" | screenshot | shows `hits/requests` |
| U6 | Run-on footnote mixing three unrelated facts | screenshot | bulleted list, one fact per line |
| U7 | Provider-side prompt caching and DiffWise's own cache were both called "cached", reading as a contradiction (`cache 0/27 hit` next to `48.9k tokens billed as cached`) | screenshot | "DiffWise cache 0/27" vs "billed at the provider's own cached rate (separate from DiffWise's cache)" |
| U8 | `est. $0.0000` on a fully cached run, next to "62,261 tokens avoided" | CLI and panel | label is `charged (est.)` / `charged this run`; avoided tokens are a separate line |
| U9 | **No `:focus-visible` rule anywhere**; keyboard users got the UA ring, which is invisible on several custom buttons | CSS audit (`grep -c focus-visible` = 0) | explicit 2px outline in `--vscode-focusBorder` with 2px offset on every interactive element |
| U10 | Active section not exposed to assistive technology | `App.tsx` | `aria-current="page"` on the active rail item |
| U11 | `--dw-space` declared but used 0 times — the spacing scale existed only in the comment | `grep -o 'var(--dw-space)' | wc -l` = 0 | token replaced by the documented 2px scale actually in use, so the design system does not lie |
| U12 | At 600px (narrow VS Code panel) task cells ellipsized | `ui-overview-narrow600.png` probe: 2 clipped cells | usage table drops the Cache column < 700px and Latency < 620px; totals go to 3 columns < 820px. Re-probe: 0 clipped cells, no horizontal overflow |
| U13 | The usage panel was unverifiable because the sample fixture had no `ai` block | `sample-report.json` | fixture now carries a real recorded usage block; four E2E checks assert the panel and the `cost unknown` state |

## 4. The new panel (AI usage)

Design intent: answer "what did this review cost, and where did it go" without pretending to know more than the
provider reported.

- Five totals: requests, tokens, input, output, charged-estimate (or **cost unknown**).
- Per-task table: review / verification / fix / chat, with requests, input, output, latency, cache hits.
- Notes: DiffWise cache hits, provider-side cached tokens, reasoning tokens, rejected claims, redactions, and the
  cost caveat.
- Source badge: `provider-reported` / `estimated` / `mixed`.

Verified at 1600px (`ui-usage-wide.png`), 860px (`ui-usage-narrow.png`) and 600px (probe): no clipping, no overflow,
numbers aligned with their headers.

## 5. Verification

| Check | Result |
|---|---|
| Production build renders all 12 sections | 32 E2E checks pass (`npm run test:e2e`) |
| Findings open, evidence block present, fix options labelled | E2E |
| Keyboard focus ring renders (computed style, not CSS presence) | E2E, driven by real Tab navigation |
| Active section exposed as `aria-current="page"` | E2E |
| Unpriced model says "cost unknown" instead of `$0.00` | E2E |
| No horizontal overflow / clipped cells at 600, 860, 1600 px | probe (`tools/evidence/narrow-probe.mjs`) + screenshots |
| No uncaught page errors | E2E |

Screenshots: `docs/screenshots/ui-overview-{wide,narrow}.png`, `ui-usage-{wide,narrow}.png`,
`ui-review-{wide,narrow}.png`, `ui-overview-narrow600.png`. Regenerate with `node tools/evidence/ui-shots.mjs`.

## 6. Remaining UI limitations (not fixed, stated)

1. **No light theme.** In VS Code the mapped variables follow the editor theme, but the literal severity colours
   (`#3fb950`, `#d29922`, `#f85149`) and the `#0d1117` fallbacks are chosen for dark backgrounds; contrast in a light
   editor is untested. A light palette needs a real audit, not a filter.
2. **No virtualisation on very long finding lists.** 200 findings render 200 rows; fine at that size, unmeasured above.
3. **Architecture graph** is a fixed layout with a node cap; progressive expansion is not implemented.
4. **Accessibility is improved, not certified.** Focus and landmarks are covered; a screen-reader pass and contrast
   measurement per theme were not run.
5. **No RTL layout**, no i18n.
6. The `filters` in Code Review persist per session but not across reloads.

## 7. Design-system gaps worth closing next

- Severity colour tokens exist per severity but not per *surface* (badge, bar, text), which is why the risk bar and the
  badge use different alphas.
- No elevation scale: one shadow token, used in three places.
- Button variants are `.btn`, `.btn.primary`, `.link`; there is no `danger` variant, which is exactly what apply/revert
  need (destructive actions currently rely on copy and a warning, not on colour).
