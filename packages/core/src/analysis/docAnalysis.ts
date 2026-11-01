import type {
  ChangedSymbol, DocPatch, DocReference, DocumentationFile, DocumentationFinding, Evidence,
  FileChange, Finding, Severity,
} from '../types';
import { isDocumentationFile, isTestFile, baseName } from './languages';
import { similarity, stableId } from '../util/text';
import { linesOf } from '../rules/util';

interface DocLoadResult {
  docs: DocumentationFile[];
  texts: Map<string, string>;
}

/** Collect documentation files and the identifiers they claim exist. */
export function loadDocuments(repoFiles: Map<string, string>): DocLoadResult {
  const docs: DocumentationFile[] = [];
  const texts = new Map<string, string>();
  for (const [path, content] of repoFiles) {
    if (!isDocumentationFile(path)) continue;
    const kind: DocumentationFile['kind'] = /(^|\/)readme\.md$/i.test(path) ? 'readme'
      : /(^|\/)(adr|decisions?)\//i.test(path) ? 'adr'
      : /openapi|swagger/i.test(path) ? 'openapi'
      : /asyncapi/i.test(path) ? 'asyncapi'
      : 'markdown';
    const titleMatch = /^#\s+(.+)$/m.exec(content);
    const reviewed = /(?:last_reviewed|updated|last_updated)\s*:\s*["']?(\d{4}-\d{2}-\d{2})/i.exec(content);
    docs.push({
      path,
      kind,
      ...(titleMatch?.[1] ? { title: titleMatch[1].trim() } : {}),
      references: extractReferences(content),
      ...(reviewed?.[1] ? { lastReviewed: reviewed[1] } : {}),
    });
    texts.set(path, content);
  }
  return { docs, texts };
}

export function extractReferences(content: string): DocReference[] {
  const refs: DocReference[] = [];
  const lines = linesOf(content);
  lines.forEach((text, idx) => {
    const line = idx + 1;
    for (const m of text.matchAll(/`([^`\n]{2,120})`/g)) {
      const value = m[1]?.trim() ?? '';
      if (!value) continue;
      // Method-qualified routes are the common documentation form:
      // "GET /api/health". Keep the method so the report can compare it.
      const methodRoute = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[\w{}:./-]+)$/i.exec(value);
      if (methodRoute) refs.push({ value: `${methodRoute[1]!.toUpperCase()} ${methodRoute[2]}`, kind: 'route', line });
      else if (/^[A-Z][A-Z0-9_]{2,}$/.test(value)) refs.push({ value, kind: 'env', line });
      else if (/^\/[A-Za-z0-9_{}/:.-]+$/.test(value)) refs.push({ value, kind: 'route', line });
      else if (/^[\w.-]+\.(ts|tsx|js|jsx|json|ya?ml|sql|md|py)$/.test(value)) refs.push({ value, kind: 'file', line });
      else if (/^(npm|pnpm|yarn|npx|git|docker)\s/.test(value)) refs.push({ value, kind: 'command', line });
      else {
        const stripped = value.replace(/\([^)]*\)$/, '').trim();
        if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(stripped)) {
          refs.push({ value: stripped.split('.').pop() ?? stripped, kind: 'symbol', line });
        } else if (/^[A-Za-z_$][\w$]*$/.test(stripped) && stripped.length >= 3) {
          refs.push({ value: stripped, kind: 'symbol', line });
        }
      }
    }
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      const v = m[1]!;
      if (!refs.some((r) => r.value === v)) refs.push({ value: v, kind: 'env', line });
    }
  });
  return refs;
}

export interface DocAnalysisInput {
  docs: DocumentationFile[];
  docTexts: Map<string, string>;
  repoFiles: Map<string, string>;
  changes: FileChange[];
  symbols: ChangedSymbol[];
}

/**
 * Compare documentation claims with the code that now exists.
 * Only contradictions that can be demonstrated are reported as conflicts;
 * documents that merely mention changed code are reported for review.
 */
export function analyseDocumentation(input: DocAnalysisInput): DocumentationFinding[] {
  const { docs, docTexts, repoFiles, changes, symbols } = input;
  const out: DocumentationFinding[] = [];
  void changes;
  const removedSymbols = symbols.filter((s) => s.change === 'removed');
  const addedSymbols = symbols.filter((s) => s.change === 'added');

  // 1. Documents that reference a symbol removed by this change.
  for (const sym of removedSymbols) {
    for (const doc of docs) {
      const ref = doc.references.find((r) => r.kind === 'symbol' && r.value === sym.name);
      if (!ref) continue;
      const rename = findRename(sym, addedSymbols);
      const text = docTexts.get(doc.path) ?? '';
      const patch = rename ? makeDocPatch(doc.path, text, ref.line, sym.name, rename.name) : undefined;
      out.push({
        id: stableId('doc', doc.path, sym.name, 'removed'),
        document: doc.path,
        status: rename ? 'outdated' : 'conflict',
        title: rename
          ? `${doc.path} still names \`${sym.name}\`, now renamed to \`${rename.name}\``
          : `${doc.path} references removed symbol \`${sym.name}\``,
        description: rename
          ? `The change renames \`${sym.name}\` to \`${rename.name}\` in \`${sym.file}\`, but the document still uses the old name at line ${ref.line}.`
          : `\`${sym.name}\` was removed from \`${sym.file}\`, but \`${doc.path}\` line ${ref.line} still describes it as part of the system.`,
        reason: `Symbol \`${sym.name}\` no longer exists in the analysed revision, and the document references it.`,
        codeEvidence: [{
          kind: 'code', file: sym.file, line: sym.range.start,
          note: `Symbol removed from ${sym.file}.`, source: 'deterministic',
        }],
        docEvidence: [{
          kind: 'doc', file: doc.path, line: ref.line,
          snippet: excerpt(text, ref.line), note: 'Documentation reference to the removed symbol.', source: 'deterministic',
        }],
        suggestedUpdate: rename
          ? `Replace \`${sym.name}\` with \`${rename.name}\` in the document, and check the surrounding example still compiles.`
          : `Remove the section that describes \`${sym.name}\`, or document its replacement.`,
        ...(patch ? { patch } : {}),
        confidence: 'high',
        severity: rename ? 'low' : 'medium',
      });
    }
  }

  // 2. Documentation for public API that changed shape.
  for (const sym of symbols) {
    if (!sym.exported || sym.change !== 'modified' || !sym.signatureChanged) continue;
    for (const doc of docs) {
      const ref = doc.references.find((r) => r.kind === 'symbol' && r.value === sym.name);
      if (!ref) continue;
      const text = docTexts.get(doc.path) ?? '';
      out.push({
        id: stableId('doc', doc.path, sym.name, 'signature'),
        document: doc.path,
        status: 'review',
        title: `${doc.path} describes a changed signature for \`${sym.name}\``,
        description: `The declaration of \`${sym.name}\` changed in \`${sym.file}\`. The document references it at line ${ref.line}; the documented parameters or return value may no longer match.`,
        reason: 'Signature changed in code while the document names the symbol.',
        codeEvidence: [{
          kind: 'code', file: sym.file, line: sym.range.start,
          snippet: sym.signature, note: 'New declaration header.', source: 'deterministic',
        }],
        docEvidence: [{
          kind: 'doc', file: doc.path, line: ref.line,
          snippet: excerpt(text, ref.line), note: 'Documentation reference.', source: 'deterministic',
        }],
        suggestedUpdate: `Verify the documented parameters and return value against \`${sym.signature}\`; update the example if it no longer compiles.`,
        confidence: 'medium',
        severity: 'low',
      });
    }
  }

  // 3. OpenAPI paths vs routes that exist in code.
  for (const doc of docs) {
    if (doc.kind !== 'openapi') continue;
    const text = docTexts.get(doc.path) ?? '';
    const documented = openApiPaths(text);
    if (documented.length === 0) continue;
    const implemented = implementedRoutes(repoFiles);
    for (const p of documented) {
      const normalised = normaliseRoute(p.path);
      const match = implemented.find((r) => normaliseRoute(r.path) === normalised);
      if (match) continue;
      out.push({
        id: stableId('doc', doc.path, p.path, 'openapi-missing'),
        document: doc.path,
        status: 'conflict',
        title: `OpenAPI path ${p.path} is not implemented`,
        description: `\`${doc.path}\` documents \`${p.path}\` (line ${p.line}), but no route handler in the repository matches it.`,
        reason: `Documented path has no implementation. ${implemented.length} route(s) were detected in code.`,
        codeEvidence: implemented.slice(0, 5).map((r): Evidence => ({
          kind: 'code', file: r.file, line: r.line, note: `Implemented route ${r.path}.`, source: 'deterministic',
        })),
        docEvidence: [{ kind: 'doc', file: doc.path, line: p.line, snippet: excerpt(text, p.line), note: 'Documented path.', source: 'deterministic' }],
        suggestedUpdate: `Either implement \`${p.path}\` or remove it from the specification. Regenerate clients after the change.`,
        confidence: 'high',
        severity: 'medium',
      });
    }
    for (const r of implemented) {
      const normalised = normaliseRoute(r.path);
      if (documented.some((d) => normaliseRoute(d.path) === normalised)) continue;
      if (!/\/api\/|\/v\d\//.test(r.path)) continue;
      out.push({
        id: stableId('doc', doc.path, r.path, 'openapi-undocumented'),
        document: doc.path,
        status: 'missing',
        title: `Route ${r.path} is missing from the OpenAPI document`,
        description: `\`${r.file}:${r.line}\` registers \`${r.path}\`, which is not described in \`${doc.path}\`.`,
        reason: 'Implemented route has no specification entry.',
        codeEvidence: [{ kind: 'code', file: r.file, line: r.line, snippet: excerpt(repoFiles.get(r.file) ?? '', r.line), note: 'Route handler.', source: 'deterministic' }],
        docEvidence: [{ kind: 'doc', file: doc.path, note: 'No matching path entry found.', source: 'deterministic' }],
        suggestedUpdate: `Add \`${r.path}\` with its request/response schema to the specification, and regenerate clients.`,
        confidence: 'high',
        severity: 'low',
      });
    }
  }

  // 4. Documentation that mentions newly exported symbols is complete; symbols
  //    that no document mentions at all are reported once per file.
  const docCorpus = [...docTexts.values()].join('\n');
  const newExports = addedSymbols.filter((s) => s.exported
    && !isTestFile(s.file)
    && s.name.length > 3
    && (s.kind === 'function' || s.kind === 'method' || s.kind === 'class'));
  const undocumented = newExports.filter((s) => !new RegExp(`\\b${escapeRe(s.name)}\\b`).test(docCorpus));
  const readme = docs.find((d) => d.kind === 'readme');
  if (readme) {
    // One finding per file: a list of names is more useful than one finding each.
    const byFile = new Map<string, ChangedSymbol[]>();
    for (const sym of undocumented) {
      const list = byFile.get(sym.file) ?? [];
      list.push(sym);
      byFile.set(sym.file, list);
    }
    for (const [file, list] of [...byFile.entries()].slice(0, 3)) {
      const code = repoFiles.get(file) ?? '';
      const names = list.map((s) => `\`${s.name}\``).join(', ');
      out.push({
        id: stableId('doc', readme.path, file, list.map((s) => s.name).join(',')),
        document: readme.path,
        status: 'missing',
        title: `New public surface in ${file} is not documented`,
        description: `${list.length} new export(s) in \`${file}\` are not mentioned by any documentation file: ${names}.`,
        reason: 'New public surface without a documentation reference.',
        codeEvidence: [{ kind: 'code', file, line: list[0]!.range.start, snippet: excerpt(code, list[0]!.range.start), note: 'New exported declaration.', source: 'deterministic' }],
        docEvidence: [{ kind: 'doc', file: readme.path, note: 'The documentation corpus does not mention these names.', source: 'deterministic' }],
        suggestedUpdate: `Document ${names} where the module is described, including purpose and a usage example.`,
        confidence: 'medium',
        severity: 'info',
      });
    }
  }

  // 5. Documented npm scripts that no longer exist.
  for (const doc of docs) {
    const text = docTexts.get(doc.path) ?? '';
    const declared = new Set<string>();
    for (const [path, content] of repoFiles) {
      if (!/(^|\/)package\.json$/.test(path)) continue;
      try {
        const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
        for (const name of Object.keys(pkg.scripts ?? {})) declared.add(name);
      } catch {
        // A malformed package.json is reported by other checks.
      }
    }
    if (declared.size === 0) continue;
    for (const m of text.matchAll(/\b(?:npm|pnpm|yarn)\s+run\s+([a-zA-Z0-9:_-]+)/g)) {
      const script = m[1]!;
      if (declared.has(script)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push({
        id: stableId('doc', doc.path, script, 'script'),
        document: doc.path,
        status: 'outdated',
        title: `Documented command \`npm run ${script}\` does not exist`,
        description: `\`${doc.path}:${line}\` tells readers to run \`${script}\`, but no package.json in the repository declares that script.`,
        reason: `Known scripts: ${[...declared].slice(0, 12).join(', ')}.`,
        codeEvidence: [{ kind: 'code', note: `package.json scripts: ${[...declared].join(', ')}`, source: 'deterministic' }],
        docEvidence: [{ kind: 'doc', file: doc.path, line, snippet: excerpt(text, line), note: 'Documented command.', source: 'deterministic' }],
        suggestedUpdate: `Update the command to an existing script, or add \`${script}\` to package.json.`,
        confidence: 'high',
        severity: 'low',
      });
    }
  }

  // De-duplicate: the same document/symbol pair can be produced by several checks.
  const seen = new Set<string>();
  return out.filter((d) => {
    const key = `${d.document}|${d.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Convert documentation findings into review findings so every section is linked. */
export function docsToFindings(docs: DocumentationFinding[]): Finding[] {
  return docs.map((d) => ({
    id: stableId('DW', 'doc', d.document, d.title),
    title: d.title,
    description: d.description,
    severity: d.severity as Severity,
    category: 'documentation',
    kind: d.status === 'conflict' ? 'problem' : 'recommendation',
    confidence: d.confidence,
    file: d.document,
    range: { start: d.docEvidence[0]?.line ?? 1, end: d.docEvidence[0]?.line ?? 1 },
    evidence: [...d.codeEvidence, ...d.docEvidence],
    whyItMatters: d.reason,
    consequences: ['Readers follow documentation that no longer matches the implementation'],
    recommendation: d.suggestedUpdate,
    ruleId: `documentation.${d.status}`,
    source: 'deterministic',
    tags: ['documentation'],
  }));
}

function findRename(removed: ChangedSymbol, added: ChangedSymbol[]): ChangedSymbol | undefined {
  return added.find((a) => a.file === removed.file && a.kind === removed.kind
    && a.name !== removed.name && similarity(a.signature, removed.signature) >= 0.55);
}

function excerpt(text: string, line: number): string {
  const lines = linesOf(text);
  const start = Math.max(1, line - 1);
  const end = Math.min(lines.length, line + 1);
  return lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
}

export function makeDocPatch(path: string, text: string, line: number, from: string, to: string): DocPatch {
  const lines = linesOf(text);
  const original = lines[line - 1];
  if (original === undefined) return { document: path, diff: '', applies: false, reason: 'Documentation line not found.' };
  const replaced = original.split(from).join(to);
  const diff = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${line},1 +${line},1 @@`,
    `-${original}`,
    `+${replaced}`,
  ].join('\n');
  return { document: path, diff, applies: replaced !== original, ...(replaced === original ? { reason: 'Replacement produced no change.' } : {}) };
}

function openApiPaths(text: string): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  const lines = linesOf(text);
  let inPaths = false;
  lines.forEach((l, idx) => {
    if (/^paths\s*:\s*$/.test(l)) { inPaths = true; return; }
    if (inPaths && /^\S/.test(l) && !/^paths/.test(l)) { inPaths = false; return; }
    if (!inPaths) return;
    const m = /^\s{2}(\/[^:]+):\s*$/.exec(l);
    if (m?.[1]) out.push({ path: m[1], line: idx + 1 });
  });
  return out;
}

function implementedRoutes(files: Map<string, string>): Array<{ path: string; file: string; line: number }> {
  const out: Array<{ path: string; file: string; line: number }> = [];
  for (const [file, content] of files) {
    if (!/\.(ts|tsx|js|jsx|py|java|kt|go)$/.test(file)) continue;
    const lines = linesOf(content);
    lines.forEach((l, idx) => {
      const m = /(?:router|app|server|api)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/.exec(l);
      const py = /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/.exec(l);
      if (m?.[2]) out.push({ path: m[2], file, line: idx + 1 });
      else if (py?.[2]) out.push({ path: py[2], file, line: idx + 1 });
    });
  }
  return out;
}

function normaliseRoute(p: string): string {
  return p.replace(/:[A-Za-z_]\w*/g, ':param').replace(/\{[^}]+\}/g, ':param').replace(/\/$/, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { baseName };
