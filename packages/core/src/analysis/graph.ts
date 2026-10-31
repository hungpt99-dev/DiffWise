import ts from 'typescript';
import { join, normalize, posix } from 'node:path';
import type {
  Component, Convention, DependencyEdge, EdgeKind, FileChange, GraphAnalysis,
} from '../types';
import { isTestFile, moduleOf } from './languages';
import { parseSource } from './symbols';

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(path);
}

/** Resolve a relative import specifier to a repository file, if it exists. */
export function resolveImport(fromFile: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const baseDir = posix.dirname(fromFile);
  const raw = spec.startsWith('/') ? spec.slice(1) : normalize(join(baseDir, spec)).replace(/\\/g, '/');
  const candidates = new Set<string>();
  for (const suffix of RESOLVE_SUFFIXES) candidates.add(raw.replace(/\.(js|jsx|mjs|cjs)$/, '') + suffix);
  for (const c of candidates) {
    const clean = c.replace(/^\.\//, '');
    if (known.has(clean)) return clean;
  }
  return null;
}

interface ImportRef {
  spec: string;
  line: number;
}

/** Extract import specifiers with line numbers using the TypeScript pre-processor. */
export function extractImports(path: string, content: string): ImportRef[] {
  let infos: Array<{ fileName: string; pos: number }> = [];
  try {
    infos = ts.preProcessFile(content, true, true).importedFiles;
  } catch {
    return [];
  }
  const out: ImportRef[] = [];
  for (const info of infos) {
    const pos = info.pos ?? 0;
    const line = content.slice(0, pos).split(/\r?\n/).length;
    out.push({ spec: info.fileName, line });
  }
  // CommonJS require() calls are not always reported by preProcessFile.
  const re = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] && !out.some((i) => i.spec === m![1])) {
      out.push({ spec: m[1], line: content.slice(0, m.index).split(/\r?\n/).length });
    }
  }
  return out;
}

/** Called identifiers inside a file, used for inferred call edges. */
export function calledIdentifiers(path: string, content: string): Array<{ name: string; line: number }> {
  const sf = parseSource(path, content);
  if (!sf) return [];
  const out: Array<{ name: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        out.push({ name: callee.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        out.push({ name: callee.name.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface GraphInput {
  /** All analysable repository files with content. */
  files: Map<string, string>;
  changes: FileChange[];
  /** Old content for changed files (null for newly added files). */
  oldContents: Map<string, string | null>;
  /** Exported symbol name -> defining files, for inferred call edges. */
  exportedSymbols: Map<string, string[]>;
}

export function buildGraph(input: GraphInput): GraphAnalysis {
  const { files, changes, oldContents, exportedSymbols } = input;
  const known = new Set(files.keys());
  const edges: DependencyEdge[] = [];
  const importers: Record<string, string[]> = {};
  const changedFiles = changes.filter((c) => c.status !== 'deleted').map((c) => c.path);
  const changedSet = new Set(changedFiles);

  for (const [path, content] of files) {
    if (!isCodeFile(path)) continue;
    for (const imp of extractImports(path, content)) {
      const target = resolveImport(path, imp.spec, known);
      if (!target || target === path) continue;
      edges.push({ from: path, to: target, kind: 'import', file: path, line: imp.line, resolution: 'verified' });
      (importers[target] ??= []).push(path);
    }
  }

  // Inferred call edges for changed files: only when the callee name maps to a
  // single exported definition repository-wide, otherwise the edge would be a guess.
  for (const path of changedFiles) {
    const content = files.get(path);
    if (!content || !isCodeFile(path)) continue;
    for (const call of calledIdentifiers(path, content)) {
      const defs = exportedSymbols.get(call.name);
      if (!defs || defs.length !== 1) continue;
      const target = defs[0]!;
      if (target === path || !known.has(target)) continue;
      if (edges.some((e) => e.from === path && e.to === target && e.kind === 'call')) continue;
      edges.push({ from: path, to: target, kind: 'call', file: path, line: call.line, resolution: 'inferred' });
    }
  }

  for (const list of Object.values(importers)) list.sort();

  // Impact: reverse reachability over import edges only (a call edge does not
  // prove that the caller breaks when the callee changes).
  const depth: Record<string, number> = {};
  for (const f of changedFiles) depth[f] = 0;
  let frontier = [...changedFiles];
  const MAX_DEPTH = 4;
  const MAX_NODES = 400;
  for (let d = 1; d <= MAX_DEPTH && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const importer of importers[f] ?? []) {
        if (depth[importer] !== undefined) continue;
        if (Object.keys(depth).length >= MAX_NODES) break;
        depth[importer] = d;
        next.push(importer);
      }
    }
    frontier = next;
  }
  const directlyImpacted = Object.entries(depth).filter(([, d]) => d === 1).map(([f]) => f).sort();
  const indirectlyImpacted = Object.entries(depth).filter(([, d]) => d >= 2).map(([f]) => f).sort();

  // Import cycles (Tarjan SCC), restricted to analysed files.
  const cycles = findCycles(edges, known);

  // Coupling introduced or removed by the change.
  const newCoupling: GraphAnalysis['newCoupling'] = [];
  const removedCoupling: GraphAnalysis['removedCoupling'] = [];
  for (const change of changes) {
    const before = oldContents.get(change.path);
    const after = files.get(change.path) ?? null;
    const oldTargets = new Map<string, number>();
    const newTargets = new Map<string, number>();
    if (before) for (const imp of extractImports(change.oldPath ?? change.path, before)) {
      const t = resolveImport(change.path, imp.spec, known);
      if (t) oldTargets.set(t, imp.line);
    }
    if (after) for (const imp of extractImports(change.path, after)) {
      const t = resolveImport(change.path, imp.spec, known);
      if (t) newTargets.set(t, imp.line);
    }
    for (const [t, line] of newTargets) if (!oldTargets.has(t)) newCoupling.push({ from: change.path, to: t, line });
    for (const [t] of oldTargets) if (!newTargets.has(t)) removedCoupling.push({ from: change.path, to: t });
  }

  const boundaryChanges = findBoundaryChanges(changes, edges, importers);

  const moduleMap = new Map<string, string[]>();
  for (const path of files.keys()) {
    const mod = moduleOf(path);
    (moduleMap.get(mod) ?? moduleMap.set(mod, []).get(mod)!).push(path);
  }
  const modules: Component[] = [...moduleMap.entries()].map(([name, list]) => ({
    id: `module:${name}`,
    name,
    kind: 'module' as const,
    files: list.sort(),
    changed: list.some((f) => changedSet.has(f)),
  })).sort((a, b) => b.files.length - a.files.length);

  return {
    edges,
    importers,
    changedFiles,
    directlyImpacted,
    indirectlyImpacted,
    impactDepth: depth,
    cycles,
    newCoupling,
    removedCoupling,
    boundaryChanges,
    modules,
    fileCount: files.size,
    edgeCount: edges.length,
  };
}

function findBoundaryChanges(
  changes: FileChange[],
  edges: DependencyEdge[],
  importers: Record<string, string[]>,
): GraphAnalysis['boundaryChanges'] {
  const out: GraphAnalysis['boundaryChanges'] = [];
  for (const c of changes) {
    if (c.status === 'deleted') continue;
    const inbound = (importers[c.path] ?? []).length;
    if (/(^|\/)(index|main|server|app)\.[a-z]+$/.test(c.path)) {
      out.push({ file: c.path, reason: 'Entry point or barrel file: downstream consumers import through it.' });
    } else if (/(^|\/)(routes?|controllers?|handlers?|api|endpoints?)\//i.test(c.path)) {
      out.push({ file: c.path, reason: 'HTTP boundary: changes here are visible to API clients.' });
    } else if (inbound >= 3) {
      out.push({ file: c.path, reason: `Shared module imported by ${inbound} other files.` });
    } else if (edges.some((e) => e.from === c.path && e.kind === 'import') && /(^|\/)src\//.test(c.path) === false) {
      out.push({ file: c.path, reason: 'Top-level module outside src/: likely part of the package surface.' });
    }
  }
  return out;
}

/** Tarjan's strongly connected components, filtered to real cycles. */
export function findCycles(edges: DependencyEdge[], known: Set<string>): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  }
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const cycles: string[][] = [];

  const strongConnect = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) cycles.push(comp.sort());
    }
  };

  for (const node of known) if (!idx.has(node) && adj.has(node)) strongConnect(node);
  return cycles.slice(0, 20);
}

/** Repository conventions, measured rather than asserted by a model. */
export function detectConventions(files: Map<string, string>): Convention[] {
  const codeFiles = [...files.entries()].filter(([p]) => /\.(ts|tsx|js|jsx)$/.test(p) && !isTestFile(p));
  if (codeFiles.length === 0) return [];
  const out: Convention[] = [];

  const withBarrel = codeFiles.filter(([p]) => /(^|\/)index\.[tj]sx?$/.test(p)).map(([p]) => p);
  if (withBarrel.length > 0) {
    out.push({
      id: 'barrel-exports',
      statement: 'Modules expose their public surface through index barrel files.',
      supportingFiles: withBarrel.length,
      totalFiles: codeFiles.length,
      examples: withBarrel.slice(0, 3),
    });
  }

  const errorClasses = codeFiles.filter(([, c]) => /class\s+\w*Error\s+extends\s+Error/.test(c)).map(([p]) => p);
  if (errorClasses.length > 0) {
    out.push({
      id: 'typed-errors',
      statement: 'Domain failures are raised as typed Error subclasses rather than string throws.',
      supportingFiles: errorClasses.length,
      totalFiles: codeFiles.length,
      examples: errorClasses.slice(0, 3),
    });
  }

  const tests = [...files.keys()].filter(isTestFile);
  const srcDirs = new Set(codeFiles.map(([p]) => moduleOf(p)));
  const testedDirs = new Set(tests.map((p) => moduleOf(p)));
  if (tests.length > 0) {
    out.push({
      id: 'tests-mirror-src',
      statement: 'Tests live beside the modules they cover, named *.test.ts / *.spec.ts.',
      supportingFiles: [...testedDirs].filter((d) => srcDirs.has(d)).length,
      totalFiles: srcDirs.size,
      examples: tests.slice(0, 3),
    });
  }

  const asyncIo = codeFiles.filter(([, c]) => /\bawait\s+(fetch|axios|this\.\w+\()/.test(c)).map(([p]) => p);
  if (asyncIo.length >= Math.max(2, Math.floor(codeFiles.length * 0.2))) {
    out.push({
      id: 'async-await',
      statement: 'I/O is expressed with async/await rather than callbacks.',
      supportingFiles: asyncIo.length,
      totalFiles: codeFiles.length,
      examples: asyncIo.slice(0, 3),
    });
  }

  const guards = codeFiles.filter(([, c]) => /(typeof\s+\w+\s*===|if\s*\(!?\w+\)\s*\{?\s*throw)/.test(c)).map(([p]) => p);
  if (guards.length >= Math.max(2, Math.floor(codeFiles.length * 0.3))) {
    out.push({
      id: 'fail-fast-guards',
      statement: 'Public entry points validate inputs and fail fast with explicit errors.',
      supportingFiles: guards.length,
      totalFiles: codeFiles.length,
      examples: guards.slice(0, 3),
    });
  }
  return out;
}
