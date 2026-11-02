import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RuleStore, detectRuleConflicts, testRule, type RuleDraft,
} from '@diffwise/core';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'diffwise-rules-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function draft(overrides: Partial<RuleDraft> = {}): RuleDraft {
  return {
    id: 'team.no-direct-repository',
    name: 'Controllers must not access repositories',
    category: 'architecture',
    severity: 'high',
    description: 'A controller may only call the service layer.',
    recommendation: 'Move the repository call behind the service.',
    files: ['src/controllers/**'],
    detection: { type: 'pattern', pattern: 'repository\\.' },
    ...overrides,
  };
}

describe('rule management', () => {
  it('creates, loads, updates, disables and deletes a custom rule', async () => {
    const root = await tempRoot();
    const store = new RuleStore({ root });
    const created = await store.create(draft());
    expect(created.issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(created.rule?.id).toBe('team.no-direct-repository');

    const listed = await store.list();
    expect(listed.rules.map((rule) => rule.id)).toContain('team.no-direct-repository');
    const yamlText = await readFile(join(root, '.diffwise/rules/custom/team.no-direct-repository.yaml'), 'utf8');
    expect(yamlText).toContain('detection:');

    const updated = await store.update('team.no-direct-repository', draft({ severity: 'critical', priority: 5 }));
    expect(updated.rule?.severity).toBe('critical');
    expect(updated.rule?.priority).toBe(5);

    const disabled = await store.setEnabled('team.no-direct-repository', false);
    expect(disabled.rule?.enabled).toBe(false);

    const removed = await store.remove('team.no-direct-repository');
    expect(removed.removed).toBe(true);
    expect((await store.list()).rules).toEqual([]);
  });

  it('refuses an invalid regex and writes nothing', async () => {
    const root = await tempRoot();
    const store = new RuleStore({ root });
    const result = await store.create(draft({ detection: { type: 'pattern', pattern: '(' } }));
    expect(result.issues.some((issue) => issue.level === 'error')).toBe(true);
    expect((await store.list()).rules).toEqual([]);
  });

  it('imports a pack atomically and exports YAML', async () => {
    const root = await tempRoot();
    const store = new RuleStore({ root });
    const source = `
id: imported
name: Imported pack
version: 1.0.0
rules:
  - id: team.transaction-boundary
    name: Transaction boundary required
    version: 1.0.0
    category: database
    severity: high
    confidence: high
    description: Database writes need an explicit transaction boundary.
    recommendation: Wrap the writes in a transaction.
    detection:
      type: pattern
      pattern: '\\b(INSERT|UPDATE|DELETE)\\b'
      scope: added
`;
    const imported = await store.import(source);
    expect(imported.imported.map((rule) => rule.id)).toEqual(['team.transaction-boundary']);
    const exported = await store.export();
    expect(exported.count).toBe(1);
    expect(exported.yaml).toContain('team.transaction-boundary');
  });

  it('tests a draft against repository content and reports scope honestly', async () => {
    const files = new Map([
      ['src/controllers/user.ts', 'import { repository } from "../db";\nrepository.find();\n'],
      ['src/services/user.ts', 'repository.find();\n'],
      ['src/controllers/user.test.ts', 'repository.find();\n'],
    ]);
    const withExclude = draft({ exclude: ['**/*.test.ts'] });
    const result = testRule(withExclude, { files });
    expect(result.valid).toBe(true);
    expect(result.matches.map((match) => match.file)).toEqual(['src/controllers/user.ts']);
    expect(result.skipped).toBe(2);
  });

  it('detects duplicate ids and policy entries that name a missing rule', () => {
    const conflicts = detectRuleConflicts({
      builtinIds: ['security.hardcoded-secret'],
      packs: [
        { id: 'a', name: 'A', version: '1.0.0', path: '/a', rules: [{ id: 'x.rule', name: 'X', version: '1.0.0', category: 'security', severity: 'high', confidence: 'high', enabled: true, mode: 'deterministic', languages: 'any', description: 'd', detection: { type: 'pattern', pattern: 'a' }, evidence: { required: true }, recommendation: 'r', provenance: { pack: 'a' } }], issues: [] },
        { id: 'b', name: 'B', version: '1.0.0', path: '/b', rules: [{ id: 'x.rule', name: 'X', version: '1.0.0', category: 'security', severity: 'high', confidence: 'high', enabled: true, mode: 'deterministic', languages: 'any', description: 'd', detection: { type: 'pattern', pattern: 'a' }, evidence: { required: true }, recommendation: 'r', provenance: { pack: 'b' } }], issues: [] },
      ],
      policy: { enable: { 'missing.rule': true }, severityOverride: {}, suppress: [] },
    });
    expect(conflicts.some((conflict) => conflict.id === 'x.rule' && conflict.level === 'error')).toBe(true);
    expect(conflicts.some((conflict) => conflict.id === 'missing.rule' && conflict.level === 'warning')).toBe(true);
  });
});
