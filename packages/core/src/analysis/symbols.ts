import ts from 'typescript';
import type { ChangedSymbol, FileChange, LineRange } from '../types';
import { CODE_LANGUAGES } from './languages';
import { stableId } from '../util/text';

export interface ExtractedSymbol {
  name: string;
  kind: ChangedSymbol['kind'];
  container?: string;
  range: LineRange;
  exported: boolean;
  signature: string;
}

const SIGNATURE_MAX = 220;

function hasPrivateModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword));
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword));
}

/** Normalise a declaration header into a stable, comparable signature. */
function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  const start = node.getStart(sf);
  const text = node.getText(sf);
  const braceIdx = text.indexOf('{');
  const arrowIdx = text.indexOf('=>');
  const candidates = [braceIdx, arrowIdx].filter((n) => n > 0);
  const end = candidates.length ? Math.min(...candidates) : Math.min(text.length, SIGNATURE_MAX);
  const head = text.slice(0, end).replace(/\s+/g, ' ').trim();
  return head.length > SIGNATURE_MAX ? `${head.slice(0, SIGNATURE_MAX)}…` : head;
}

function lineRangeOf(node: ts.Node, sf: ts.SourceFile): LineRange {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const end = sf.getLineAndCharacterOfPosition(Math.max(node.getStart(sf), node.getEnd() - 1)).line + 1;
  return { start, end };
}

/** Parse a TypeScript/JavaScript source file defensively (never throws). */
export function parseSource(path: string, content: string): ts.SourceFile | null {
  try {
    return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  } catch {
    return null;
  }
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Extract top-level and class-level declarations with their line ranges.
 * Deliberately shallow: DiffWise needs symbol granularity for review, not a
 * full compiler front-end.
 */
export function extractSymbols(path: string, content: string): ExtractedSymbol[] {
  const sf = parseSource(path, content);
  if (!sf) return [];
  const out: ExtractedSymbol[] = [];

  const addVariable = (decl: ts.VariableDeclaration, exported: boolean): void => {
    if (!ts.isIdentifier(decl.name)) return;
    const init = decl.initializer;
    const isFn = init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
    out.push({
      name: decl.name.text,
      kind: isFn ? 'function' : 'variable',
      range: lineRangeOf(decl, sf),
      exported,
      signature: signatureOf(decl, sf),
    });
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      out.push({
        name: stmt.name.text, kind: 'function', range: lineRangeOf(stmt, sf),
        exported: hasExportModifier(stmt), signature: signatureOf(stmt, sf),
      });
    } else if (ts.isClassDeclaration(stmt)) {
      const className = stmt.name?.text ?? '(anonymous class)';
      out.push({
        name: className, kind: 'class', range: lineRangeOf(stmt, sf),
        exported: hasExportModifier(stmt), signature: signatureOf(stmt, sf),
      });
      const classExported = hasExportModifier(stmt) && !hasPrivateModifier(stmt);
      for (const member of stmt.members) {
        const memberExported = classExported && !hasPrivateModifier(member);
        if (ts.isMethodDeclaration(member) && member.name) {
          const name = member.name.getText(sf).replace(/^['"]|['"]$/g, '');
          out.push({
            name, kind: 'method', container: className, range: lineRangeOf(member, sf),
            exported: memberExported, signature: signatureOf(member, sf),
          });
        } else if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
          out.push({
            name: member.name.text, kind: 'variable', container: className, range: lineRangeOf(member, sf),
            exported: memberExported, signature: signatureOf(member, sf),
          });
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      out.push({
        name: stmt.name.text, kind: 'interface', range: lineRangeOf(stmt, sf),
        exported: hasExportModifier(stmt), signature: signatureOf(stmt, sf),
      });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      out.push({
        name: stmt.name.text, kind: 'type', range: lineRangeOf(stmt, sf),
        exported: hasExportModifier(stmt), signature: signatureOf(stmt, sf),
      });
    } else if (ts.isEnumDeclaration(stmt)) {
      out.push({
        name: stmt.name.text, kind: 'enum', range: lineRangeOf(stmt, sf),
        exported: hasExportModifier(stmt), signature: signatureOf(stmt, sf),
      });
    } else if (ts.isVariableStatement(stmt)) {
      const exported = hasExportModifier(stmt);
      for (const decl of stmt.declarationList.declarations) addVariable(decl, exported);
    }
  }
  return out;
}

/** Regex fallback for languages without a TypeScript parser in this build. */
export function extractSymbolsFallback(path: string, content: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const patterns: Array<{ re: RegExp; kind: ChangedSymbol['kind'] }> = [
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, kind: 'function' },
    { re: /^\s*(?:export\s+)?class\s+([A-Za-z_][\w]*)/gm, kind: 'class' },
    { re: /^\s*def\s+([A-Za-z_]\w*)/gm, kind: 'function' },
    { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?[\w<>[\]]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm, kind: 'method' },
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, kind: 'function' },
  ];
  const lines = content.split(/\r?\n/);
  for (const { re, kind } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const line = content.slice(0, m.index).split(/\r?\n/).length;
      if (line > lines.length) continue;
      const signature = (lines[line - 1] ?? '').trim().slice(0, SIGNATURE_MAX);
      out.push({ name, kind, range: { start: line, end: line }, exported: /export|public/.test(m[0]), signature });
    }
  }
  return out;
}

export function extractAnySymbols(path: string, content: string): ExtractedSymbol[] {
  if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(path)) return extractSymbols(path, content);
  if (/\.(py|java|kt|go|rb|php|rs|cs)$/.test(path)) return extractSymbolsFallback(path, content);
  return [];
}

function intersects(range: LineRange, lines: number[]): boolean {
  return lines.some((l) => l >= range.start && l <= range.end);
}

function compressLines(lines: number[]): LineRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: LineRange[] = [];
  for (const l of sorted) {
    const last = out[out.length - 1];
    if (last && l <= last.end + 1) last.end = l;
    else out.push({ start: l, end: l });
  }
  return out;
}

export interface SymbolDiffInput {
  change: FileChange;
  oldContent: string | null;
  newContent: string | null;
}

/**
 * Determine which symbols were added, removed or modified.
 *
 * A symbol counts as modified when a changed line falls inside its declaration
 * range, or when its declaration header (signature) changed while the name and
 * container stayed the same.
 */
export function diffSymbols(input: SymbolDiffInput): ChangedSymbol[] {
  const { change, oldContent, newContent } = input;
  const oldSymbols = oldContent ? extractAnySymbols(change.oldPath ?? change.path, oldContent) : [];
  const newSymbols = newContent ? extractAnySymbols(change.path, newContent) : [];
  const addedLines: number[] = [];
  const removedLines: number[] = [];
  for (const h of change.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add' && l.newLine !== undefined) addedLines.push(l.newLine);
      if (l.kind === 'del' && l.oldLine !== undefined) removedLines.push(l.oldLine);
    }
  }

  const oldMap = new Map(oldSymbols.map((s) => [`${s.container ?? ''}::${s.name}`, s]));
  const newMap = new Map(newSymbols.map((s) => [`${s.container ?? ''}::${s.name}`, s]));
  const out: ChangedSymbol[] = [];

  for (const [key, sym] of newMap) {
    const before = oldMap.get(key);
    const touched = intersects(sym.range, addedLines);
    const signatureChanged = before !== undefined && before.signature !== sym.signature;
    if (!before) {
      out.push(toChanged(change.path, sym, 'added', compressLines(addedLines.filter((l) => l >= sym.range.start && l <= sym.range.end)), false));
    } else if (touched || signatureChanged) {
      const ranges = compressLines(addedLines.filter((l) => l >= sym.range.start && l <= sym.range.end));
      out.push(toChanged(change.path, sym, 'modified', ranges.length ? ranges : [sym.range], signatureChanged));
    }
  }
  for (const [key, sym] of oldMap) {
    if (newMap.has(key)) continue;
    // A symbol removed along with the file is reported once, at file level.
    out.push(toChanged(change.oldPath ?? change.path, sym, 'removed', compressLines(removedLines.filter((l) => l >= sym.range.start && l <= sym.range.end)), false));
  }
  return out;
}

function toChanged(
  file: string,
  sym: ExtractedSymbol,
  change: ChangedSymbol['change'],
  changeRanges: LineRange[],
  signatureChanged: boolean,
): ChangedSymbol {
  return {
    id: stableId('sym', file, sym.container ?? '', sym.name, sym.range.start),
    name: sym.name,
    kind: sym.kind,
    file,
    range: sym.range,
    ...(sym.container ? { container: sym.container } : {}),
    exported: sym.exported,
    change,
    changeRanges: changeRanges.length ? changeRanges : [sym.range],
    signature: sym.signature,
    signatureChanged,
    referenceCount: 0,
  };
}

/** Count textual references to a name outside its defining file. */
export function countReferences(files: Array<{ path: string; content: string }>, name: string, definitionFile: string): { count: number; examples: string[] } {
  if (name.length < 3) return { count: 0, examples: [] };
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  let count = 0;
  const examples: string[] = [];
  for (const f of files) {
    if (f.path === definitionFile) continue;
    const matches = f.content.match(re);
    if (!matches) continue;
    count += matches.length;
    if (examples.length < 3) examples.push(f.path);
  }
  return { count, examples };
}
