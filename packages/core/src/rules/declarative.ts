/**
 * Declarative rule execution.
 *
 * A rule definition is compiled into a small predicate over the review context.
 * Everything here is deterministic: same input, same findings, no model.
 * Findings always carry the exact repository line that triggered them.
 */
import ts from 'typescript';
import type { Evidence, FileChange, Language } from '../types';
import { matchesAnyGlob } from '../util/glob';
import { parseSource } from '../analysis/symbols';
import type { CandidateFinding, RuleContext } from './types';
import type { RuleDefinition } from './definition';

const MAX_FINDINGS_PER_RULE = 5;

export interface DeclarativeRunResult {
  findings: CandidateFinding[];
  /** Set when the rule could not run at all (unsupported language, parse failure). */
  skipped?: string;
}

function appliesToFile(rule: RuleDefinition, change: FileChange): boolean {
  if (change.binary) return false;
  if (rule.files && rule.files.length > 0 && !matchesAnyGlob(change.path, rule.files)) return false;
  if (rule.exclude && rule.exclude.length > 0 && matchesAnyGlob(change.path, rule.exclude)) return false;
  if (rule.languages === 'any') return true;
  const language = change.language as Language;
  if (rule.languages.includes(language)) return true;
  // tsx/jsx are distinct languages in the model but the same parser family.
  if (language === 'tsx' && rule.languages.includes('typescript')) return true;
  if (language === 'jsx' && rule.languages.includes('javascript')) return true;
  return false;
}

function addedLines(change: FileChange): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  for (const hunk of change.hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== 'add' || line.newLine === undefined) continue;
      out.push({ line: line.newLine, text: line.text });
    }
  }
  return out;
}

function toFinding(rule: RuleDefinition, change: FileChange, line: number, snippet: string, detail: string): CandidateFinding {
  const evidence: Evidence[] = [{
    kind: rule.detection.type === 'absence' ? 'doc' : 'code',
    file: change.path,
    line,
    snippet: snippet.slice(0, 400),
    note: detail,
    source: 'deterministic',
  }];
  return {
    ruleId: rule.id,
    title: rule.name,
    description: `${rule.description}${detail ? ` ${detail}` : ''}`.trim(),
    severity: rule.severity,
    category: rule.category,
    kind: rule.enforcement === 'advisory'
      ? 'recommendation'
      : rule.severity === 'critical' || rule.severity === 'high' ? 'problem' : 'risk',
    confidence: rule.confidence,
    file: change.path,
    range: { start: line, end: line },
    evidence,
    whyItMatters: rule.description,
    consequences: [],
    recommendation: rule.recommendation,
    tags: [
      ...(rule.tags ?? []),
      `rule:${rule.id}`,
      ...(rule.provenance.pack !== 'builtin' ? [`pack:${rule.provenance.pack}`] : []),
      ...(rule.enforcement ? [`enforcement:${rule.enforcement}`] : []),
      ...(rule.blocksGate ? ['gate:blocking'] : []),
    ],
  };
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

function windowText(content: string, line: number, radius: number): string {
  const lines = content.split(/\r\n|\n|\r/);
  const from = Math.max(0, line - 1 - radius);
  const to = Math.min(lines.length, line + radius);
  return lines.slice(from, to).join('\n');
}

function runPattern(rule: RuleDefinition, ctx: RuleContext): DeclarativeRunResult {
  const detection = rule.detection;
  if (detection.type !== 'pattern') return { findings: [] };
  const re = new RegExp(detection.pattern, (detection.flags ?? '').replace(/[gy]/g, ''));
  const also = detection.mustAlsoMatch ? new RegExp(detection.mustAlsoMatch) : null;
  const not = detection.mustNotMatch ? new RegExp(detection.mustNotMatch) : null;
  const radius = detection.window ?? 6;
  const findings: CandidateFinding[] = [];

  for (const change of ctx.changes) {
    if (!appliesToFile(rule, change)) continue;
    const content = ctx.contents.get(change.path) ?? ctx.repoFiles.get(change.path) ?? '';
    if (!content) continue;

    if (detection.scope === 'file') {
      const match = re.exec(content);
      if (!match) continue;
      const line = lineOf(content, match.index);
      const window = windowText(content, line, radius);
      if (also && !also.test(window)) continue;
      if (not && not.test(window)) continue;
      findings.push(toFinding(rule, change, line, match[0], `Matched ${rule.id} at ${change.path}:${line}.`));
      if (findings.length >= MAX_FINDINGS_PER_RULE) break;
      continue;
    }

    for (const added of addedLines(change)) {
      const match = re.exec(added.text);
      if (!match) continue;
      const window = windowText(content, added.line, radius);
      if (also && !also.test(window)) continue;
      if (not && not.test(window)) continue;
      findings.push(toFinding(rule, change, added.line, added.text, `Added line matches ${rule.id}.`));
      if (findings.length >= MAX_FINDINGS_PER_RULE) break;
    }
    if (findings.length >= MAX_FINDINGS_PER_RULE) break;
  }
  return { findings };
}

function decoratorsOf(node: ts.Node): string[] {
  if (!ts.canHaveDecorators(node)) return [];
  const decorators = ts.getDecorators(node);
  if (!decorators) return [];
  return decorators.map((d) => {
    const expr = d.expression;
    if (ts.isCallExpression(expr)) return expr.expression.getText();
    return expr.getText();
  });
}

function runAst(rule: RuleDefinition, ctx: RuleContext): DeclarativeRunResult {
  const detection = rule.detection;
  if (detection.type !== 'ast') return { findings: [] };
  const nameRe = detection.name ? new RegExp(detection.name) : null;
  const receiverRe = detection.receiver ? new RegExp(detection.receiver) : null;
  const fromRe = detection.from ? new RegExp(detection.from) : null;
  const findings: CandidateFinding[] = [];
  let parsedAny = false;

  for (const change of ctx.changes) {
    if (!appliesToFile(rule, change)) continue;
    if (!['typescript', 'tsx', 'javascript', 'jsx'].includes(change.language)) continue;
    const content = ctx.contents.get(change.path) ?? ctx.repoFiles.get(change.path);
    if (!content) continue;
    const sf = parseSource(change.path, content);
    if (!sf) continue;
    parsedAny = true;
    const added = new Set(addedLines(change).map((l) => l.line));

    const visit = (node: ts.Node, enclosing: { decorated: string[]; inClass: boolean }): void => {
      let scope = enclosing;
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        scope = { ...enclosing, inClass: true };
      }
      if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isFunctionDeclaration(node)) {
        scope = { ...scope, decorated: decoratorsOf(node) };
      }

      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const endLine = sf.getLineAndCharacterOfPosition(Math.max(node.getStart(sf), node.getEnd() - 1)).line + 1;
      const touchesChange = [...added].some((l) => l >= startLine && l <= endLine);

      const report = (): void => {
        const text = sf.text.split(/\r\n|\n|\r/)[startLine - 1] ?? node.getText(sf).slice(0, 200);
        findings.push(toFinding(rule, change, startLine, text, `AST match at ${change.path}:${startLine}.`));
      };

      const decoratorOk = !detection.withinDecorator
        || scope.decorated.some((d) => d === detection.withinDecorator || new RegExp(detection.withinDecorator as string).test(d));
      const classOk = detection.withinClass ? scope.inClass : true;
      const scopeOk = decoratorOk && classOk;

      if (touchesChange && scopeOk && findings.length < MAX_FINDINGS_PER_RULE) {
        if (detection.node === 'call' && ts.isCallExpression(node)) {
          const callee = node.expression;
          const calleeName = ts.isPropertyAccessExpression(callee) ? callee.name.getText() : callee.getText();
          const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression.getText() : '';
          if ((!nameRe || nameRe.test(calleeName)) && (!receiverRe || receiverRe.test(receiver))) report();
        } else if (detection.node === 'new' && ts.isNewExpression(node)) {
          const calleeName = node.expression.getText();
          if (!nameRe || nameRe.test(calleeName)) report();
        } else if (detection.node === 'method' && ts.isMethodDeclaration(node)) {
          const name = node.name.getText();
          if (!nameRe || nameRe.test(name)) report();
        } else if (detection.node === 'property' && (ts.isPropertyAccessExpression(node) || ts.isPropertyDeclaration(node))) {
          const name = ts.isPropertyAccessExpression(node) ? node.name.getText() : node.name.getText();
          if (!nameRe || nameRe.test(name)) report();
        } else if (detection.node === 'decorator') {
          const list = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
          for (const decorator of list) {
            const name = decorator.expression.getText().split('(')[0] ?? '';
            if ((!nameRe || nameRe.test(name)) && touchesChange) report();
          }
        } else if (detection.node === 'import' && ts.isImportDeclaration(node)) {
          const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
          if ((!fromRe || fromRe.test(spec)) && (!nameRe || nameRe.test(spec))) report();
        }
      }
      ts.forEachChild(node, (child) => visit(child, scope));
    };
    visit(sf, { decorated: [], inClass: false });
    if (findings.length >= MAX_FINDINGS_PER_RULE) break;
  }

  if (!parsedAny) return { findings, skipped: 'no changed file in a language this AST rule supports' };
  return { findings };
}

function runAbsence(rule: RuleDefinition, ctx: RuleContext): DeclarativeRunResult {
  const detection = rule.detection;
  if (detection.type !== 'absence') return { findings: [] };
  const required = new RegExp(detection.required);
  const findings: CandidateFinding[] = [];
  for (const change of ctx.changes) {
    if (!appliesToFile(rule, change)) continue;
    if (change.status === 'deleted') continue;
    const content = ctx.contents.get(change.path) ?? ctx.repoFiles.get(change.path);
    if (content === undefined) continue;
    if (required.test(content)) continue;
    findings.push(toFinding(rule, change, 1, content.split(/\r\n|\n|\r/)[0] ?? '', detection.message));
    if (findings.length >= MAX_FINDINGS_PER_RULE) break;
  }
  return { findings };
}

function runForbiddenImport(rule: RuleDefinition, ctx: RuleContext): DeclarativeRunResult {
  const detection = rule.detection;
  if (detection.type !== 'forbidden-import') return { findings: [] };
  const re = new RegExp(detection.from);
  const findings: CandidateFinding[] = [];

  for (const change of ctx.changes) {
    if (!appliesToFile(rule, change)) continue;
    const content = ctx.contents.get(change.path) ?? ctx.repoFiles.get(change.path);
    if (!content) continue;
    const lines = content.split(/\r\n|\n|\r/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      const spec = /^(?:import\s[^'"]*from\s*|import\s*|export\s[^'"]*from\s*|(?:const|let|var)\s+[^=]+=\s*require\()\s*['"]([^'"]+)['"]/.exec(trimmed);
      const specifier = spec?.[1];
      if (!specifier) continue;
      if (!re.test(specifier)) continue;
      findings.push(toFinding(rule, change, i + 1, line, `Import of "${specifier}" violates the dependency policy.`));
      break;
    }
    if (findings.length >= MAX_FINDINGS_PER_RULE) break;
  }
  return { findings };
}

/** Execute one declarative rule. Never throws; a failure is reported, not hidden. */
export function runDeclarativeRule(rule: RuleDefinition, ctx: RuleContext): DeclarativeRunResult {
  try {
    switch (rule.detection.type) {
      case 'pattern': return runPattern(rule, ctx);
      case 'ast': return runAst(rule, ctx);
      case 'absence': return runAbsence(rule, ctx);
      case 'forbidden-import': return runForbiddenImport(rule, ctx);
      default: return { findings: [], skipped: 'unknown detection type' };
    }
  } catch (err) {
    return { findings: [], skipped: `rule threw: ${(err as Error).message}` };
  }
}
