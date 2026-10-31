import ts from 'typescript';
import type { Evidence, FileChange } from '../types';
import { parseSource } from '../analysis/symbols';

export interface AddedLine {
  line: number;
  text: string;
}

export function addedLines(change: FileChange): AddedLine[] {
  const out: AddedLine[] = [];
  const seen = new Set<number>();
  for (const h of change.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add' && l.newLine !== undefined && !seen.has(l.newLine)) {
        seen.add(l.newLine);
        out.push({ line: l.newLine, text: l.text });
      }
    }
  }
  return out;
}

export function removedLines(change: FileChange): AddedLine[] {
  const out: AddedLine[] = [];
  for (const h of change.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'del' && l.oldLine !== undefined) out.push({ line: l.oldLine, text: l.text });
    }
  }
  return out;
}

export function linesOf(content: string): string[] {
  return content.split(/\r?\n/);
}

export function snippetAround(content: string, line: number, radius = 2): string {
  const lines = linesOf(content);
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
}

export function codeEvidence(file: string, line: number, content: string, note: string, radius = 2): Evidence {
  return {
    kind: 'code',
    file,
    line,
    endLine: Math.min(linesOf(content).length, line + radius),
    snippet: snippetAround(content, line, radius),
    note,
    source: 'deterministic',
  };
}

export function diffEvidence(file: string, line: number, text: string, note: string): Evidence {
  return { kind: 'diff', file, line, snippet: `+ ${text}`, note, source: 'deterministic' };
}

export interface EnclosingFunction {
  name: string;
  start: number;
  end: number;
  kind: 'function' | 'method' | 'constructor' | 'arrow';
}

/** Find the innermost function-like declaration containing a line. */
export function enclosingFunction(path: string, content: string, line: number): EnclosingFunction | null {
  const sf = parseSource(path, content);
  if (!sf) return null;
  const lines = linesOf(content);
  const targetPos = (lines.slice(0, Math.max(0, line - 1)).join('\n') + '\n').length;
  let best: EnclosingFunction | null = null;

  const nameOf = (node: ts.Node, callName?: string): string => {
    if (ts.isConstructorDeclaration(node)) return 'constructor';
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
      return node.name.getText(sf).replace(/^['"]|['"]$/g, '');
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
    // Anonymous callbacks are named after the call that receives them, so a
    // finding can say "router.post() callback" instead of "(anonymous)".
    return callName ? `${callName} callback` : '(anonymous function)';
  };

  const visit = (node: ts.Node, callName?: string): void => {
    const start = node.getStart(sf);
    const end = node.getEnd();
    if (targetPos < start || targetPos > end) return;
    let nextCall = callName;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf).replace(/\s+/g, ' ');
      if (callee.length <= 40) nextCall = callee;
    }
    if (
      ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    ) {
      const kind: EnclosingFunction['kind'] = ts.isConstructorDeclaration(node) ? 'constructor'
        : ts.isMethodDeclaration(node) ? 'method'
        : ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? 'arrow'
        : 'function';
      best = {
        name: nameOf(node, callName),
        start: sf.getLineAndCharacterOfPosition(start).line + 1,
        end: sf.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1,
        kind,
      };
    }
    ts.forEachChild(node, (child) => visit(child, nextCall));
  };
  visit(sf);
  return best;
}

/** Function body text (or the whole file when no function encloses the line). */
export function functionBodyFor(path: string, content: string, line: number): { name: string; start: number; end: number; body: string } {
  const fn = enclosingFunction(path, content, line);
  const lines = linesOf(content);
  if (!fn) return { name: '(file scope)', start: 1, end: lines.length, body: content };
  return { name: fn.name, start: fn.start, end: fn.end, body: lines.slice(fn.start - 1, fn.end).join('\n') };
}

/** Count occurrences of a regex inside a code region. */
export function countIn(text: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) {
    n++;
    if (m.index === global.lastIndex) global.lastIndex++;
  }
  return n;
}

export function isCommentOrEmpty(text: string): boolean {
  const t = text.trim();
  return t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#');
}
