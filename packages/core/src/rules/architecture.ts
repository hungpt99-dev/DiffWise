import type { CandidateFinding, Rule } from './types';
import { draftFinding } from './types';
import { codeEvidence } from './util';

/** New imports that close a dependency cycle. */
function newCycle(): Rule {
  return {
    id: 'architecture.cycle',
    category: 'architecture',
    run(ctx) {
      const out: CandidateFinding[] = [];
      const changed = new Set(ctx.changes.map((c) => c.path));
      for (const cycle of ctx.graph.cycles) {
        const involved = cycle.filter((f) => changed.has(f));
        if (involved.length === 0) continue;
        const newEdge = ctx.graph.newCoupling.find((e) => cycle.includes(e.from) && cycle.includes(e.to));
        if (!newEdge) continue;
        const content = ctx.contents.get(newEdge.from);
        out.push(draftFinding({
          ruleId: 'architecture.cycle',
          title: `New import closes a dependency cycle`,
          description: `\`${newEdge.from}\` now imports \`${newEdge.to}\` (line ${newEdge.line}), completing a cycle:\n\n${cycle.join(' → ')} → ${cycle[0]}`,
          severity: 'medium',
          category: 'architecture',
          kind: 'problem',
          confidence: 'verified',
          file: newEdge.from,
          range: { start: newEdge.line, end: newEdge.line },
          evidence: [
            ...(content ? [codeEvidence(newEdge.from, newEdge.line, content, 'Import that closes the cycle.')] : []),
            {
              kind: 'graph',
              note: `Repository import graph contains a cycle of ${cycle.length} files.`,
              source: 'deterministic',
            },
          ],
          whyItMatters: 'Cycles make modules impossible to load or test in isolation, and they make initialization order observable through partial exports.',
          consequences: ['Undefined imports at startup', 'Tests that only pass with the full application loaded', 'Refactors that ripple in both directions'],
          recommendation: 'Move the shared contract into a lower-level module that both sides import, or invert the dependency with an interface owned by the caller.',
          tags: ['coupling', 'layering'],
        }));
      }
      return out;
    },
  };
}

/** Entry points / shared modules changed: consumers must be checked. */
function boundaryChange(): Rule {
  return {
    id: 'architecture.boundary',
    category: 'architecture',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const b of ctx.graph.boundaryChanges.slice(0, 5)) {
        const content = ctx.contents.get(b.file);
        const change = ctx.changes.find((c) => c.path === b.file);
        const anchor = change?.hunks[0]?.newStart ?? 1;
        out.push(draftFinding({
          ruleId: 'architecture.boundary',
          title: `Change crosses a module boundary: ${b.file}`,
          description: b.reason,
          severity: 'info',
          category: 'architecture',
          kind: 'recommendation',
          confidence: 'high',
          file: b.file,
          range: { start: anchor, end: anchor },
          evidence: [
            ...(content ? [codeEvidence(b.file, anchor, content, 'Boundary file.', 1)] : []),
            {
              kind: 'graph',
              note: `${(ctx.graph.importers[b.file] ?? []).length} importer(s) resolved statically.`,
              source: 'deterministic',
            },
          ],
          whyItMatters: 'Changes at a boundary are consumed by code that is not in the diff, so their assumptions and tests are the ones most likely to break.',
          consequences: ['Consumers depending on the previous shape', 'Integration tests outside this repository'],
          recommendation: `Review the ${(ctx.graph.importers[b.file] ?? []).length} importer(s) listed in the architecture section and confirm the contract they expect is unchanged.`,
          tags: ['boundary'],
        }));
      }
      return out;
    },
  };
}

/** Many new outbound imports from one file. */
function wideCoupling(): Rule {
  return {
    id: 'architecture.new-coupling',
    category: 'architecture',
    run(ctx) {
      const out: CandidateFinding[] = [];
      const byFile = new Map<string, typeof ctx.graph.newCoupling>();
      for (const e of ctx.graph.newCoupling) {
        (byFile.get(e.from) ?? byFile.set(e.from, []).get(e.from)!).push(e);
      }
      for (const [file, edges] of byFile) {
        if (edges.length < 4) continue;
        out.push(draftFinding({
          ruleId: 'architecture.new-coupling',
          title: `${edges.length} new module dependencies in ${file}`,
          description: `The change adds imports to ${edges.length} modules: ${edges.map((e) => `\`${e.to}\``).join(', ')}.`,
          severity: 'low',
          category: 'architecture',
          kind: 'recommendation',
          confidence: 'verified',
          file,
          range: { start: edges[0]!.line, end: edges[edges.length - 1]!.line },
          evidence: edges.slice(0, 4).map((e) => ({
            kind: 'graph' as const,
            file: e.from,
            line: e.line,
            note: `New dependency on ${e.to}.`,
            source: 'deterministic' as const,
          })),
          whyItMatters: 'Each dependency is a reason the file must change again. Wide fan-out makes the module harder to test and increases the chance of cycles.',
          consequences: ['Wider rebuild and test surface', 'Higher chance of future cycles'],
          recommendation: 'Group the new dependencies behind one adapter, or move the orchestration into a module whose job is composition.',
          tags: ['coupling'],
        }));
      }
      return out;
    },
  };
}

/** Change to a documented convention, e.g. untyped errors in a typed-error codebase. */
function conventionViolation(): Rule {
  return {
    id: 'architecture.convention',
    category: 'architecture',
    run(ctx) {
      const out: CandidateFinding[] = [];
      const typed = ctx.repoFiles.size > 0
        ? [...ctx.repoFiles.entries()].some(([, c]) => /class\s+\w*Error\s+extends\s+Error/.test(c))
        : false;
      if (!typed) return out;
      for (const change of ctx.changes) {
        const content = ctx.contents.get(change.path);
        if (!content) continue;
        for (const h of change.hunks) {
          for (const l of h.lines) {
            if (l.kind !== 'add' || l.newLine === undefined) continue;
            if (!/throw\s+new\s+Error\s*\(/.test(l.text)) continue;
            out.push(draftFinding({
              ruleId: 'architecture.convention',
              title: 'Generic Error thrown where the codebase uses typed errors',
              description: 'This repository defines Error subclasses, but the added code throws a bare `new Error(...)`, so callers cannot discriminate this failure from any other.',
              severity: 'low',
              category: 'architecture',
              kind: 'recommendation',
              confidence: 'medium',
              file: change.path,
              range: { start: l.newLine, end: l.newLine },
              evidence: [codeEvidence(change.path, l.newLine, content, 'Generic Error construction.')],
              whyItMatters: 'Error classification is repository-wide; one generic throw forces every upstream handler to fall back to string matching.',
              consequences: ['Coarse error handling', 'Retries applied to non-retryable failures'],
              recommendation: 'Throw the domain-specific Error subclass used elsewhere in the module, adding a stable `code`.',
              tags: ['convention'],
            }));
          }
        }
      }
      return out.slice(0, 3);
    },
  };
}

export const architectureRules: Rule[] = [newCycle(), boundaryChange(), wideCoupling(), conventionViolation()];
