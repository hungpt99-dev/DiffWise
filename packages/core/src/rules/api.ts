import type { CandidateFinding, Rule } from './types';
import { draftFinding } from './types';
import { codeEvidence, diffEvidence, removedLines } from './util';
import { isRouteFile } from '../analysis/languages';

/** Exported signature changed while other files still reference the symbol. */
function signatureChange(): Rule {
  return {
    id: 'api.signature-change',
    category: 'api-contract',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const sym of ctx.symbols) {
        if (sym.change !== 'modified' || !sym.signatureChanged || !sym.exported) continue;
        if (sym.referenceCount === 0) continue;
        const content = ctx.contents.get(sym.file);
        const old = ctx.oldContents.get(sym.file);
        if (!content) continue;
        out.push(draftFinding({
          ruleId: 'api.signature-change',
          title: `Exported signature changed: ${sym.name}`,
          description: `\`${sym.name}\` is exported and referenced ${sym.referenceCount} time(s) elsewhere in the repository, but its declaration changed:\n\nbefore: \`${findOldSignature(old, sym.name)}\`\nafter: \`${sym.signature}\``,
          severity: 'high',
          category: 'api-contract',
          kind: 'risk',
          confidence: 'high',
          file: sym.file,
          range: sym.range,
          evidence: [
            codeEvidence(sym.file, sym.range.start, content, 'Changed declaration.'),
            {
              kind: 'graph',
              file: sym.file,
              line: sym.range.start,
              note: `${sym.referenceCount} textual references outside the defining file.`,
              source: 'deterministic',
            },
          ],
          whyItMatters: 'Call sites are type-checked only when they are compiled against the new signature. Dynamic callers, other packages and already-deployed consumers are not.',
          consequences: ['Runtime `undefined` arguments at call sites that were not updated', 'Breaking change for downstream packages'],
          recommendation: 'Add an optional parameter or a new overload instead of changing the existing one, and update every call site in the same change (or version the export).',
          tags: ['breaking-change'],
        }));
      }
      return out;
    },
  };
}

function findOldSignature(oldContent: string | null | undefined, name: string): string {
  if (!oldContent) return '(new symbol)';
  const re = new RegExp(`^.*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*$`, 'm');
  const m = re.exec(oldContent);
  return m ? m[0].trim().replace(/\s+/g, ' ').slice(0, 160) : '(not found in previous revision)';
}

/** Exported symbol removed while references remain. */
function removedExport(): Rule {
  return {
    id: 'api.removed-export',
    category: 'api-contract',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const sym of ctx.symbols) {
        if (sym.change !== 'removed' || !sym.exported) continue;
        if (sym.referenceCount === 0) continue;
        out.push(draftFinding({
          ruleId: 'api.removed-export',
          title: `Exported symbol removed: ${sym.name}`,
          description: `\`${sym.name}\` was removed from \`${sym.file}\` but ${sym.referenceCount} reference(s) to the name still exist elsewhere in the repository.`,
          severity: 'critical',
          category: 'api-contract',
          kind: 'problem',
          confidence: 'high',
          file: sym.file,
          range: sym.range,
          evidence: [
            {
              kind: 'graph', file: sym.file, line: sym.range.start,
              note: `${sym.referenceCount} remaining textual references.`, source: 'deterministic',
            },
          ],
          whyItMatters: 'Every remaining reference is a compile error or, for dynamic consumers, a runtime failure at the moment this code path executes.',
          consequences: ['Build failures in dependent packages', 'Runtime TypeError in paths not covered by tests'],
          recommendation: 'Keep a deprecated alias for one release, or remove the remaining references in the same change and verify the build.',
          tags: ['breaking-change'],
        }));
      }
      return out;
    },
  };
}

/** A new required parameter on an exported function. */
function requiredParameter(): Rule {
  return {
    id: 'api.required-parameter',
    category: 'api-contract',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const sym of ctx.symbols) {
        if (sym.change !== 'modified' || !sym.exported || !sym.signatureChanged) continue;
        if (!/function|method/.test(sym.kind)) continue;
        const content = ctx.contents.get(sym.file);
        if (!content) continue;
        const params = parseParams(sym.signature);
        const newRequired = params.filter((p) => !p.optional && !p.hasDefault);
        const before = parseParams(findOldSignature(ctx.oldContents.get(sym.file), sym.name));
        const beforeRequired = before.filter((p) => !p.optional && !p.hasDefault);
        if (newRequired.length <= beforeRequired.length) continue;
        const added = newRequired.filter((p) => !beforeRequired.some((b) => b.name === p.name));
        if (added.length === 0) continue;
        out.push(draftFinding({
          ruleId: 'api.required-parameter',
          title: `New required parameter \`${added[0]!.name}\` on exported \`${sym.name}\``,
          description: `The exported function gained required parameter(s): ${added.map((p) => `\`${p.name}\``).join(', ')}. Existing callers pass no value and will receive \`undefined\`.`,
          severity: 'high',
          category: 'api-contract',
          kind: 'problem',
          confidence: 'high',
          file: sym.file,
          range: sym.range,
          evidence: [codeEvidence(sym.file, sym.range.start, content, 'New parameter list.')],
          whyItMatters: 'TypeScript will flag direct callers, but JSON/RPC callers, tests using mocks and other packages will keep compiling while passing `undefined`.',
          consequences: ['Silent `undefined` reaching persistence or arithmetic', 'Validation errors only in production'],
          recommendation: 'Make the parameter optional with a safe default, or add a new function and migrate callers explicitly.',
          tags: ['breaking-change'],
        }));
      }
      return out;
    },
  };
}

function parseParams(signature: string): Array<{ name: string; optional: boolean; hasDefault: boolean }> {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  return signature.slice(open + 1, close).split(',').map((raw) => raw.trim()).filter(Boolean).map((raw) => {
    const name = raw.replace(/^\.\.\./, '').split(/[:=]/)[0]?.trim() ?? raw;
    return { name, optional: raw.includes('?'), hasDefault: raw.includes('=') };
  });
}

/** Route removed while the path is still advertised or referenced. */
function removedRoute(): Rule {
  return {
    id: 'api.removed-route',
    category: 'api-contract',
    run(ctx) {
      const out: CandidateFinding[] = [];
      for (const change of ctx.changes) {
        if (!isRouteFile(change.path)) continue;
        const content = ctx.contents.get(change.path);
        if (!content) continue;
        const removed = removedLines(change).filter((l) => /\.(get|post|put|patch|delete|all)\s*\(\s*['"`]\//.test(l.text));
        for (const r of removed) {
          const pathMatch = /['"`](\/[^'"`]*)['"`]/.exec(r.text);
          if (!pathMatch) continue;
          const routePath = pathMatch[1]!;
          if (content.includes(routePath)) continue; // still declared elsewhere in the same file
          const elsewhere = [...ctx.repoFiles.entries()].some(([p, c]) => p !== change.path && c.includes(routePath) && /\.(get|post|put|patch|delete)\s*\(/.test(c));
          if (elsewhere) continue;
          const hunk = change.hunks.find((h) => h.lines.some((l) => l.kind === 'del' && l.oldLine === r.line));
          const newLine = hunk?.newStart ?? r.line;
          out.push(draftFinding({
            ruleId: 'api.removed-route',
            title: `HTTP route removed: ${routePath}`,
            description: `\`${routePath}\` is no longer registered anywhere in the repository. Clients and documentation that still call it will receive 404 responses.`,
            severity: 'high',
            category: 'api-contract',
            kind: 'problem',
            confidence: 'medium',
            file: change.path,
            range: { start: newLine, end: newLine },
            evidence: [
              { kind: 'diff', file: change.path, line: newLine, snippet: `- ${r.text}`, note: 'Removed route registration (old line number shown in the snippet).', source: 'deterministic' },
            ],
            whyItMatters: 'A removed route fails at the edge, outside the code path being reviewed, and is usually discovered by clients rather than by tests.',
            consequences: ['404s for existing integrations', 'Silent data loss when a client retries elsewhere'],
            recommendation: 'Deprecate the route first (keep it, return `Deprecation`/`Sunset` headers), or update every consumer and the OpenAPI document in the same change.',
            tags: ['breaking-change', 'http'],
          }));
        }
      }
      return out;
    },
  };
}

export const apiRules: Rule[] = [signatureChange(), removedExport(), requiredParameter(), removedRoute()];
export { parseParams };
export { diffEvidence };
