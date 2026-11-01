/**
 * Test framework and command discovery.
 *
 * Discovery reads manifest files that the repository already publishes:
 * `package.json` scripts, a Makefile, `pyproject.toml`, `pom.xml`,
 * `build.gradle`, `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile.lock`.
 * Nothing is guessed from a model and nothing is executed here.
 */
import type { DiscoveredCommand, DiscoveryInput, VerificationLevel } from './types';

function parseJson(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function packageManager(files: Map<string, string>): { name: 'npm' | 'pnpm' | 'yarn' | 'bun'; run: string } {
  if (files.has('pnpm-lock.yaml')) return { name: 'pnpm', run: 'pnpm' };
  if (files.has('yarn.lock')) return { name: 'yarn', run: 'yarn' };
  if (files.has('bun.lockb')) return { name: 'bun', run: 'bun run' };
  return { name: 'npm', run: 'npm run' };
}

/** Which test runner a script body actually invokes. */
function detectRunner(text: string): string | undefined {
  if (/\bvitest\b/.test(text)) return 'vitest';
  if (/\bjest\b/.test(text)) return 'jest';
  if (/\bpytest\b/.test(text)) return 'pytest';
  if (/\bmocha\b/.test(text)) return 'mocha';
  if (/\bplaywright\b/.test(text)) return 'playwright';
  if (/\bcypress\b/.test(text)) return 'cypress';
  if (/\brspec\b/.test(text)) return 'rspec';
  if (/\bgo test\b/.test(text)) return 'go';
  if (/\bmvn\b/.test(text) || /\bgradle\b/.test(text)) return 'maven';
  return undefined;
}

const SCRIPT_LEVELS: Array<{ matches: RegExp; level: VerificationLevel; confidence: DiscoveredCommand['confidence'] }> = [
  { matches: /^(typecheck|type-check|tsc)$/i, level: 'typecheck', confidence: 'high' },
  { matches: /^(lint|eslint)$/i, level: 'lint', confidence: 'high' },
  { matches: /^(build|compile)$/i, level: 'build', confidence: 'high' },
  { matches: /^(test:unit|unit|test-unit)$/i, level: 'unit', confidence: 'high' },
  { matches: /^(test:integration|integration)$/i, level: 'integration', confidence: 'high' },
  { matches: /^(test:contract|contract)$/i, level: 'contract', confidence: 'high' },
  { matches: /^(test:e2e|e2e|test-e2e|cypress|playwright)$/i, level: 'e2e', confidence: 'high' },
  { matches: /^(test:security|audit|sast|security)$/i, level: 'security', confidence: 'medium' },
  { matches: /^(test|tests)$/i, level: 'unit', confidence: 'medium' },
];

function discoverNode(input: DiscoveryInput): DiscoveredCommand[] {
  const raw = input.files.get('package.json');
  if (!raw) return [];
  const pkg = parseJson(raw);
  if (!pkg) return [];
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  const pm = packageManager(input.files);
  const out: DiscoveredCommand[] = [];
  const seenLevels = new Set<VerificationLevel>();

  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string') continue;
    const match = SCRIPT_LEVELS.find((l) => l.matches.test(name));
    if (!match) continue;
    // Prefer the most specific script per level (`test:unit` beats `test`).
    if (seenLevels.has(match.level) && match.confidence !== 'high') continue;
    if (seenLevels.has(match.level)) continue;
    seenLevels.add(match.level);
    const runner = detectRunner(`${name} ${command}`);
    out.push({
      id: name,
      label: `${name} — ${command}`.slice(0, 120),
      level: match.level,
      command: `${pm.run} ${name}`,
      source: 'package.json',
      reason: `package.json defines the "${name}" script (${command.slice(0, 80)})`,
      confidence: match.confidence,
      requiresNetwork: /(cypress|playwright|e2e|integration|docker|compose)/i.test(`${name} ${command}`),
      targetable: Boolean(runner),
      ...(runner ? { runner } : {}),
    });
  }

  // Runner detection even without a script.
  const deps = { ...(pkg.devDependencies as Record<string, unknown> | undefined), ...(pkg.dependencies as Record<string, unknown> | undefined) };
  if (!seenLevels.has('unit')) {
    if (deps && 'vitest' in deps) {
      out.push({ id: 'vitest', label: 'vitest run', level: 'unit', command: 'npx vitest run', source: 'package.json', reason: 'vitest is a declared dependency', confidence: 'medium', requiresNetwork: false, targetable: true });
    } else if (deps && 'jest' in deps) {
      out.push({ id: 'jest', label: 'jest', level: 'unit', command: 'npx jest --ci', source: 'package.json', reason: 'jest is a declared dependency', confidence: 'medium', requiresNetwork: false, targetable: true });
    }
  }
  if (!seenLevels.has('typecheck') && input.files.has('tsconfig.json')) {
    out.push({ id: 'tsc', label: 'tsc --noEmit', level: 'typecheck', command: 'npx tsc --noEmit', source: 'package.json', reason: 'tsconfig.json exists and no typecheck script is defined', confidence: 'medium', requiresNetwork: false });
  }
  return out;
}

function discoverMakefile(input: DiscoveryInput): DiscoveredCommand[] {
  const raw = input.files.get('Makefile');
  if (!raw) return [];
  const targets = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+):(?!=)/.exec(line);
    if (match?.[1]) targets.add(match[1]);
  }
  const out: DiscoveredCommand[] = [];
  const wanted: Array<{ target: string; level: VerificationLevel }> = [
    { target: 'test', level: 'unit' },
    { target: 'lint', level: 'lint' },
    { target: 'build', level: 'build' },
    { target: 'typecheck', level: 'typecheck' },
    { target: 'e2e', level: 'e2e' },
  ];
  for (const { target, level } of wanted) {
    if (!targets.has(target)) continue;
    out.push({
      id: `make:${target}`,
      label: `make ${target}`,
      level,
      command: `make ${target}`,
      source: 'makefile',
      reason: `Makefile defines the "${target}" target`,
      confidence: 'medium',
      requiresNetwork: level === 'e2e',
    });
  }
  return out;
}

function discoverPython(input: DiscoveryInput): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  const pyproject = input.files.get('pyproject.toml');
  const hasPytestConfig = Boolean(input.files.get('pytest.ini')) || Boolean(pyproject && /\[tool\.pytest/.test(pyproject));
  if (hasPytestConfig || input.files.has('setup.cfg')) {
    out.push({ id: 'pytest', label: 'pytest', level: 'unit', command: 'python -m pytest', source: pyproject ? 'pyproject' : 'pytest', reason: 'pytest configuration is present', confidence: 'high', requiresNetwork: false, targetable: true });
  }
  if (pyproject && /\[tool\.mypy/.test(pyproject)) {
    out.push({ id: 'mypy', label: 'mypy', level: 'typecheck', command: 'python -m mypy .', source: 'pyproject', reason: 'mypy is configured in pyproject.toml', confidence: 'medium', requiresNetwork: false });
  }
  if (pyproject && /\[tool\.ruff/.test(pyproject)) {
    out.push({ id: 'ruff', label: 'ruff check', level: 'lint', command: 'python -m ruff check .', source: 'pyproject', reason: 'ruff is configured in pyproject.toml', confidence: 'medium', requiresNetwork: false });
  }
  return out;
}

function discoverJvm(input: DiscoveryInput): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  if (input.files.has('pom.xml')) {
    out.push({ id: 'mvn-test', label: 'mvn test', level: 'unit', command: 'mvn -q -DskipITs test', source: 'pom', reason: 'pom.xml is present', confidence: 'high', requiresNetwork: true, targetable: true });
  }
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    if (!input.files.has(name)) continue;
    const wrapper = input.files.has('gradlew') ? './gradlew' : 'gradle';
    out.push({ id: 'gradle-test', label: `${wrapper} test`, level: 'unit', command: `${wrapper} test`, source: 'gradle', reason: `${name} is present`, confidence: 'high', requiresNetwork: true, targetable: true });
    break;
  }
  return out;
}

function discoverOther(input: DiscoveryInput): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  if (input.files.has('go.mod')) {
    out.push({ id: 'go-test', label: 'go test ./...', level: 'unit', command: 'go test ./...', source: 'go.mod', reason: 'go.mod is present', confidence: 'high', requiresNetwork: true, targetable: true });
  }
  if (input.files.has('Cargo.toml')) {
    out.push({ id: 'cargo-test', label: 'cargo test', level: 'unit', command: 'cargo test', source: 'cargo', reason: 'Cargo.toml is present', confidence: 'high', requiresNetwork: true });
  }
  if (input.files.has('composer.json')) {
    out.push({ id: 'composer-test', label: 'composer test', level: 'unit', command: 'composer test', source: 'composer', reason: 'composer.json is present', confidence: 'medium', requiresNetwork: true });
  }
  if (input.files.has('Gemfile.lock')) {
    out.push({ id: 'rspec', label: 'bundle exec rspec', level: 'unit', command: 'bundle exec rspec', source: 'gemfile', reason: 'Gemfile.lock is present', confidence: 'medium', requiresNetwork: true, targetable: true });
  }
  return out;
}

/** All commands discoverable from the repository manifests. */
export function discoverCommands(input: DiscoveryInput): DiscoveredCommand[] {
  const discovered = [
    ...discoverNode(input),
    ...discoverMakefile(input),
    ...discoverPython(input),
    ...discoverJvm(input),
    ...discoverOther(input),
  ];
  for (const command of input.policyCommands ?? []) {
    discovered.push({
      id: command.id,
      label: command.label,
      level: command.level,
      command: command.command,
      source: 'policy',
      reason: 'configured in review policy',
      confidence: 'high',
      requiresNetwork: command.requiresNetwork,
    });
  }
  // One command per level: policy wins, then the highest confidence. The
  // alternatives are still discoverable through `plan.notSelected`.
  const rank = (c: DiscoveredCommand): number => (c.source === 'policy' ? 0 : c.confidence === 'high' ? 1 : c.confidence === 'medium' ? 2 : 3);
  const byLevel = new Map<string, DiscoveredCommand>();
  for (const command of discovered) {
    const existing = byLevel.get(command.level);
    if (!existing || rank(command) < rank(existing)) byLevel.set(command.level, command);
  }
  return [...byLevel.values()];
}

/**
 * Narrow a test command to the test files that cover the change.
 *
 * Only runners whose CLI accepts a file list are targeted. Everything else is
 * planned as a full run rather than pretending to be targeted.
 */
export function targetedCommand(command: DiscoveredCommand, testFiles: string[]): { command: string; targets: string[] } | null {
  if (testFiles.length === 0) return null;
  const files = testFiles.filter((f) => !f.includes(' '));
  if (files.length === 0) return null;
  const joined = files.join(' ');
  const runner = command.runner ?? '';
  const probe = `${runner} ${command.command}`;

  if (/vitest/.test(probe)) return { command: `npx vitest run ${joined}`, targets: files };
  if (/\bjest\b/.test(probe)) return { command: `npx jest --ci ${joined}`, targets: files };
  if (/pytest/.test(probe)) return { command: `python -m pytest ${joined}`, targets: files };
  if (/rspec/.test(probe)) return { command: `bundle exec rspec ${joined}`, targets: files };
  if (/go test/.test(probe) || runner === 'go') {
    const packages = [...new Set(files.map((f) => {
      const dir = f.split('/').slice(0, -1).join('/');
      return dir ? `./${dir}` : '.';
    }))];
    return { command: `go test ${packages.join(' ')}`, targets: packages };
  }
  if (/mvn/.test(command.command)) {
    // Surefire selects by test class, not by source path.
    const classes = [...new Set(files.map((f) => (f.split('/').pop() ?? '').replace(/\.(java|kt)$/, '')))].filter(Boolean);
    if (classes.length === 0) return null;
    return { command: `mvn -q -DskipITs -Dtest=${classes.join(',')} test`, targets: classes };
  }
  return null;
}
