import { describe, expect, it } from 'vitest';
import { buildReproductionPlan, buildVerificationPlan, discoverCommands, targetedCommand } from '../src';

const pkg = (scripts: Record<string, string>, devDeps: Record<string, string> = {}): string =>
  JSON.stringify({ name: 'demo', scripts, devDependencies: devDeps });

function files(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe('verification command discovery', () => {
  it('reads scripts from package.json and maps them to levels', () => {
    const discovered = discoverCommands({
      files: files({
        'package.json': pkg({
          test: 'vitest run',
          'test:e2e': 'node e2e/run.mjs',
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          build: 'tsc -p tsconfig.json',
        }),
      }),
      changedFiles: [],
    });
    const levels = discovered.map((c) => c.level);
    expect(levels).toContain('unit');
    expect(levels).toContain('e2e');
    expect(levels).toContain('typecheck');
    expect(levels).toContain('lint');
    expect(levels).toContain('build');
    expect(discovered.find((c) => c.level === 'e2e')?.requiresNetwork).toBe(true);
  });

  it('uses the lockfile to choose the package manager', () => {
    const discovered = discoverCommands({
      files: files({ 'package.json': pkg({ test: 'vitest run' }), 'pnpm-lock.yaml': '' }),
      changedFiles: [],
    });
    expect(discovered.find((c) => c.level === 'unit')?.command).toBe('pnpm test');
  });

  it('infers a runner from dependencies when no script exists', () => {
    const discovered = discoverCommands({
      files: files({ 'package.json': pkg({}, { vitest: '^2.0.0' }, ) }),
      changedFiles: [],
    });
    expect(discovered.find((c) => c.level === 'unit')?.command).toBe('npx vitest run');
  });

  it('reads a Makefile, pytest configuration and Go module', () => {
    expect(discoverCommands({ files: files({ Makefile: 'test:\n\tgo test ./...\n' }), changedFiles: [] })
      .some((c) => c.command === 'make test')).toBe(true);
    expect(discoverCommands({ files: files({ 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = -q\n' }), changedFiles: [] })
      .some((c) => c.command === 'python -m pytest')).toBe(true);
    expect(discoverCommands({ files: files({ 'go.mod': 'module x\n' }), changedFiles: [] })
      .some((c) => c.command === 'go test ./...')).toBe(true);
  });

  it('returns nothing rather than guessing when no manifest exists', () => {
    expect(discoverCommands({ files: files({ 'src/a.ts': 'export const a = 1;' }), changedFiles: [] })).toHaveLength(0);
  });

  it('prefers a policy command over a discovered one', () => {
    const discovered = discoverCommands({
      files: files({ 'package.json': pkg({ test: 'vitest run' }) }),
      changedFiles: [],
      policyCommands: [{ id: 'unit', label: 'org runner', level: 'unit', command: 'npx vitest run --reporter=json', timeoutMs: 1000, requiresNetwork: false }],
    });
    expect(discovered.find((c) => c.level === 'unit')?.source).toBe('policy');
  });
});

describe('targeted narrowing', () => {
  const command = { id: 'test', label: 'test', level: 'unit' as const, command: 'npx vitest run', source: 'package.json' as const, reason: '', confidence: 'high' as const, requiresNetwork: false, targetable: true };

  it('narrows vitest, jest, pytest and go test to the given files', () => {
    expect(targetedCommand(command, ['test/a.test.ts'])?.command).toBe('npx vitest run test/a.test.ts');
    expect(targetedCommand({ ...command, command: 'npx jest --ci' }, ['test/a.test.js'])?.command).toBe('npx jest --ci test/a.test.js');
    expect(targetedCommand({ ...command, command: 'python -m pytest' }, ['tests/test_a.py'])?.command).toBe('python -m pytest tests/test_a.py');
    expect(targetedCommand({ ...command, command: 'go test ./...' }, ['svc/handler_test.go'])?.command).toBe('go test ./svc');
  });

  it('refuses to pretend a non-targetable runner was narrowed', () => {
    expect(targetedCommand({ ...command, command: 'make test', targetable: false }, ['test/a.ts'])).toBeNull();
  });
});

describe('verification plan', () => {
  const base = {
    files: files({
      'package.json': pkg({ test: 'vitest run', typecheck: 'tsc --noEmit', 'test:e2e': 'node e2e/run.mjs' }, { vitest: '^2' }),
    }),
    changedFiles: ['src/refund.ts'],
    testFiles: [{ path: 'src/refund.test.ts', framework: 'vitest' }],
  };

  it('plans a targeted strategy with the related test file', () => {
    const plan = buildVerificationPlan(base);
    expect(plan.strategy).toBe('targeted');
    const unit = plan.items.find((i) => i.level === 'unit');
    expect(unit?.command).toBe('npx vitest run src/refund.test.ts');
    expect(unit?.targets).toEqual(['src/refund.test.ts']);
    expect(unit?.requiresApproval).toBe(true);
  });

  it('reports levels it could not plan instead of inventing a command', () => {
    const plan = buildVerificationPlan({ ...base, levels: ['integration', 'security'] });
    expect(plan.items).toHaveLength(0);
    expect(plan.missing).toEqual(['integration', 'security']);
    expect(plan.strategy).toBe('none');
    expect(plan.warnings.join(' ')).toMatch(/will not guess a command/);
  });

  it('marks a command that needs the network as not sandboxable', () => {
    const plan = buildVerificationPlan({ ...base, levels: ['e2e'] });
    const e2e = plan.items[0];
    expect(e2e?.sandboxable).toBe(false);
    expect(plan.warnings.join(' ')).toMatch(/cannot be isolated/);
  });

  it('honours requireApproval = false only when the caller passes it explicitly', () => {
    const plan = buildVerificationPlan({ ...base, requireApproval: false });
    expect(plan.items.every((i) => i.requiresApproval === false)).toBe(true);
  });

  it('builds a reproduction plan scoped to a finding', () => {
    const plan = buildReproductionPlan(base, { file: 'src/refund.ts', title: 'SQL injection in refund' });
    expect(plan.summary).toContain('SQL injection in refund');
    expect(plan.items[0]?.reason).toContain('reproduce a finding in src/refund.ts');
  });
});
