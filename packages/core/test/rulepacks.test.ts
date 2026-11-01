import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadRulePack, loadRulePacks, runDeclarativeRule, runRuleSet, validateRuleDefinition, regexRisk,
  type FileChange, type RuleDefinition,
} from '../src';
import type { RuleContext as RuleCtx } from '../src/rules/types';

const roots: string[] = [];

async function packDir(name: string, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `diffwise-pack-${name}-`));
  roots.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

const validRule = `
id: java.transaction.self-invocation
name: Spring Transaction Self Invocation
version: 1.0.0
category: database
severity: high
enabled: true
languages: [java]
frameworks: [spring]
description: Detect calls to transactional methods through self-invocation that may bypass Spring proxies.
detection:
  type: pattern
  pattern: "this\\\\.\\\\w+\\\\(.*\\\\)"
evidence:
  required: true
recommendation: Move the transactional operation to another Spring-managed component.
`;

describe('rule definitions', () => {
  it('accepts a valid definition and records provenance', async () => {
    const dir = await packDir('ok', {
      'pack.yaml': 'id: java-spring\nname: Java Spring\nversion: 1.2.0\n',
      'rules/transaction.yaml': validRule,
    });
    const pack = await loadRulePack(dir);
    expect(pack.rules).toHaveLength(1);
    expect(pack.rules[0]?.id).toBe('java.transaction.self-invocation');
    expect(pack.rules[0]?.provenance.pack).toBe('java-spring');
    expect(pack.rules[0]?.provenance.packVersion).toBe('1.2.0');
    expect(pack.issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('rejects a rule without a semver version', () => {
    const issues: never[] = [];
    const rule = validateRuleDefinition({ ...JSON.parse(JSON.stringify({})), id: 'a.b', name: 'x', description: 'd', recommendation: 'r', category: 'security', detection: { type: 'pattern', pattern: 'x' } }, 'r.yaml', { pack: 'p' }, issues as never);
    expect(rule).toBeNull();
    expect((issues as unknown as Array<{ message: string }>).some((i) => i.message.includes('version'))).toBe(true);
  });

  it('rejects an invalid regular expression', () => {
    const issues: Array<{ level: string; message: string }> = [];
    const rule = validateRuleDefinition({
      id: 'a.b', name: 'x', version: '1.0.0', category: 'security', description: 'd', recommendation: 'r',
      detection: { type: 'pattern', pattern: '([unclosed' },
    }, 'r.yaml', { pack: 'p' }, issues as never);
    expect(rule).toBeNull();
    expect(issues.some((i) => i.message.includes('not a valid regular expression'))).toBe(true);
  });

  it('rejects a catastrophic-backtracking pattern', () => {
    expect(regexRisk('(a+)+$').level).toBe('rejected');
    expect(regexRisk('(.*)*').level).toBe('rejected');
    const issues: Array<{ level: string; message: string }> = [];
    const rule = validateRuleDefinition({
      id: 'a.b', name: 'x', version: '1.0.0', category: 'security', description: 'd', recommendation: 'r',
      detection: { type: 'pattern', pattern: '(a+)+$' },
    }, 'r.yaml', { pack: 'p' }, issues as never);
    expect(rule).toBeNull();
    expect(issues.some((i) => i.message.includes('nested quantifier'))).toBe(true);
  });

  it('warns about an unknown field but still loads the rule', () => {
    const issues: Array<{ level: string; message: string }> = [];
    const rule = validateRuleDefinition({
      id: 'a.b', name: 'x', version: '1.0.0', category: 'security', description: 'd', recommendation: 'r',
      detection: { type: 'pattern', pattern: 'secret' }, enforcement: 'block',
    }, 'r.yaml', { pack: 'p' }, issues as never);
    expect(rule?.id).toBe('a.b');
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('enforcement'))).toBe(true);
  });

  it('reports duplicate rule ids across a pack', async () => {
    const dir = await packDir('dup', {
      'pack.yaml': 'id: dup\nversion: 1.0.0\n',
      'a.yaml': 'id: same.rule\nname: A\nversion: 1.0.0\ncategory: security\ndescription: d\nrecommendation: r\ndetection: {type: pattern, pattern: a}\n',
      'b.yaml': 'id: same.rule\nname: B\nversion: 1.0.0\ncategory: security\ndescription: d\nrecommendation: r\ndetection: {type: pattern, pattern: b}\n',
    });
    const pack = await loadRulePack(dir);
    expect(pack.rules).toHaveLength(1);
    expect(pack.issues.some((i) => i.level === 'error' && i.message.includes('duplicate rule id'))).toBe(true);
  });

  it('blocks a pack whose dependency is missing', async () => {
    const dir = await packDir('dep', {
      'pack.yaml': 'id: payments\nversion: 1.0.0\nrequires:\n  - security@^1.0.0\n',
      'r.yaml': 'id: pay.rule\nname: A\nversion: 1.0.0\ncategory: security\ndescription: d\nrecommendation: r\ndetection: {type: pattern, pattern: a}\n',
    });
    const result = await loadRulePacks([dir]);
    expect(result.packs[0]?.blocked).toMatch(/required pack "security" is not installed/);
  });

  it('applies extends inheritance for detection', async () => {
    const dir = await packDir('extends', {
      'pack.yaml': 'id: base\nversion: 1.0.0\n',
      'a.yaml': 'id: base.rule\nname: Base\nversion: 1.0.0\ncategory: security\ndescription: d\nrecommendation: r\ndetection: {type: pattern, pattern: PASSWORD}\n',
      'b.yaml': 'id: child.rule\nname: Child\nextends: base.rule\nversion: 1.0.0\ncategory: security\nseverity: critical\ndescription: d\nrecommendation: r\n',
    });
    const result = await loadRulePacks([dir]);
    const child = result.packs[0]?.rules.find((r) => r.id === 'child.rule');
    expect(child?.detection).toEqual({ type: 'pattern', pattern: 'PASSWORD' });
    expect(child?.severity).toBe('critical');
  });
});

function change(path: string, lines: string[], language: FileChange['language'] = 'typescript'): FileChange {
  return {
    path, status: 'modified', additions: lines.length, deletions: 0, binary: false, language,
    patch: '', hunks: [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: lines.length, header: '@@ -1 +1 @@',
      lines: lines.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 })),
    }],
  };
}

function context(changes: FileChange[], contents: Record<string, string>): RuleCtx {
  const map = new Map(Object.entries(contents));
  return {
    changes, contents: map, oldContents: new Map(), repoFiles: map, symbols: [], docs: [], docTexts: new Map(),
    tests: { files: [], uncoveredChanges: [], uncoveredSymbols: [], deletedTests: [], suggestions: [] },
    graph: {
      edges: [], importers: {}, changedFiles: [], directlyImpacted: [], indirectlyImpacted: [], impactDepth: {},
      cycles: [], newCoupling: [], removedCoupling: [], boundaryChanges: [], modules: [], fileCount: 0, edgeCount: 0,
    },
    settings: {
      maxFiles: 200, maxFileBytes: 400_000, maxEvidenceSnippets: 40, ignoreGlobs: [],
      aiEnabled: false, sendRepositoryContent: false, providerId: 'none',
    },
    now: new Date('2026-10-01T00:00:00.000Z'),
  };
}

const definition = (overrides: Partial<RuleDefinition>): RuleDefinition => ({
  id: 'test.rule', name: 'Test rule', version: '1.0.0', category: 'security', severity: 'high',
  confidence: 'high', enabled: true, mode: 'deterministic', languages: 'any', description: 'd',
  detection: { type: 'pattern', pattern: 'secret' }, evidence: { required: true },
  recommendation: 'r', provenance: { pack: 'p' }, ...overrides,
});

describe('declarative execution', () => {
  it('fires on added lines and attaches the real line as evidence', () => {
    const ctx = context([change('src/cfg.ts', ['const apiKey = "abc";', 'const other = 1;'])], { 'src/cfg.ts': 'const apiKey = "abc";\nconst other = 1;' });
    const result = runDeclarativeRule(definition({ detection: { type: 'pattern', pattern: 'apiKey' } }), ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.evidence[0]?.line).toBe(1);
    expect(result.findings[0]?.evidence[0]?.snippet).toContain('apiKey');
  });

  it('honours mustNotMatch inside the window', () => {
    const ctx = context([change('src/cfg.ts', ['const password = env.PASSWORD;'])], { 'src/cfg.ts': 'const password = env.PASSWORD;' });
    const result = runDeclarativeRule(definition({
      detection: { type: 'pattern', pattern: 'password', mustNotMatch: 'env\\.' },
    }), ctx);
    expect(result.findings).toHaveLength(0);
  });

  it('skips a file whose language the rule does not declare', () => {
    const ctx = context([change('src/a.py', ['password = 1'], 'python')], { 'src/a.py': 'password = 1' });
    const result = runDeclarativeRule(definition({ languages: ['java'] }), ctx);
    expect(result.findings).toHaveLength(0);
  });

  it('detects a call inside a decorated method with an AST rule', () => {
    const source = `class Service {\n  @Transactional()\n  refund() {\n    this.chargeCard();\n  }\n}\n`;
    const ctx = context([change('src/Service.ts', source.split('\n'))], { 'src/Service.ts': source });
    const result = runDeclarativeRule(definition({
      languages: ['typescript'],
      detection: { type: 'ast', node: 'call', name: 'chargeCard', receiver: 'this', withinDecorator: 'Transactional' },
    }), ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe('src/Service.ts');
  });

  it('does not fire an AST rule outside the decorated method', () => {
    const source = `class Service {\n  refund() {\n    this.chargeCard();\n  }\n}\n`;
    const ctx = context([change('src/Service.ts', source.split('\n'))], { 'src/Service.ts': source });
    const result = runDeclarativeRule(definition({
      languages: ['typescript'],
      detection: { type: 'ast', node: 'call', name: 'chargeCard', withinDecorator: 'Transactional' },
    }), ctx);
    expect(result.findings).toHaveLength(0);
  });

  it('reports an absence rule when the required guard is missing', () => {
    const ctx = context([change('src/routes.ts', ['app.post("/refund", handler);'])], { 'src/routes.ts': 'app.post("/refund", handler);' });
    const result = runDeclarativeRule(definition({
      detection: { type: 'absence', required: 'authorize\\(', message: 'Route has no authorization guard.' },
    }), ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.description).toContain('Route has no authorization guard');
  });

  it('does not report an absence rule when the guard exists', () => {
    const ctx = context([change('src/routes.ts', ['app.post("/refund", authorize, handler);'])], { 'src/routes.ts': 'app.post("/refund", authorize, handler);' });
    const result = runDeclarativeRule(definition({
      detection: { type: 'absence', required: 'authorize', message: 'Route has no authorization guard.' },
    }), ctx);
    expect(result.findings).toHaveLength(0);
  });

  it('detects a forbidden import', () => {
    const ctx = context([change('src/pay.ts', ['import { legacy } from "@app/legacy/db";'])], { 'src/pay.ts': 'import { legacy } from "@app/legacy/db";' });
    const result = runDeclarativeRule(definition({
      category: 'architecture',
      detection: { type: 'forbidden-import', from: '^@app/legacy/' },
    }), ctx);
    expect(result.findings).toHaveLength(1);
  });
});

describe('rule registry with policy', () => {
  const builtin = [{
    id: 'security.demo',
    category: 'security' as const,
    run: () => [{
      ruleId: 'security.demo', title: 'demo', description: 'demo', severity: 'high' as const,
      category: 'security' as const, kind: 'problem' as const, confidence: 'high' as const,
      file: 'src/a.ts', range: { start: 1, end: 1 }, evidence: [],
      whyItMatters: 'w', consequences: [], recommendation: 'r', tags: [],
    }],
  }];

  it('applies a policy severity override and tags the change', () => {
    const ctx = context([change('src/a.ts', ['x'])], { 'src/a.ts': 'x' });
    const policy = {
      rulePacks: { require: [], disable: [] },
      rules: { enable: {}, severityOverride: { 'security.demo': 'critical' as const }, suppress: [], minSeverity: 'info' as const },
    };
    const result = runRuleSet(ctx, { builtinRules: builtin, policy: policy as never });
    expect(result.findings[0]?.severity).toBe('critical');
    expect(result.overridden).toBe(1);
  });

  it('drops a suppressed finding and counts it', () => {
    const ctx = context([change('src/a.ts', ['x'])], { 'src/a.ts': 'x' });
    const policy = {
      rulePacks: { require: [], disable: [] },
      rules: {
        enable: {}, severityOverride: {}, minSeverity: 'info' as const,
        suppress: [{ ruleId: 'security.demo', reason: 'accepted risk', approvedBy: 'hung', expiresAt: '2099-01-01T00:00:00.000Z' }],
      },
    };
    const result = runRuleSet(ctx, { builtinRules: builtin, policy: policy as never });
    expect(result.findings).toHaveLength(0);
    expect(result.suppressed).toBe(1);
  });

  it('records a throwing rule as failed without aborting the run', () => {
    const ctx = context([change('src/a.ts', ['x'])], { 'src/a.ts': 'x' });
    const rules = [
      { id: 'boom', category: 'security' as const, run: () => { throw new Error('bad rule'); } },
      ...builtin,
    ];
    const result = runRuleSet(ctx, { builtinRules: rules });
    expect(result.records.find((r) => r.id === 'boom')?.status).toBe('failed');
    expect(result.records.find((r) => r.id === 'security.demo')?.status).toBe('ran');
    expect(result.findings).toHaveLength(1);
  });
});
