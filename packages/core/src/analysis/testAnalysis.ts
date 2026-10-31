import type { ChangedSymbol, FileChange, TestAnalysis, TestFile } from '../types';
import { baseName, isDocumentationFile, isTestFile } from './languages';

const TEST_CALL_RE = /\b(it|test|specify)\s*\(\s*['"`]/g;

function frameworkOf(path: string, content: string): TestFile['framework'] {
  if (/pytest|import pytest/.test(content) || /(^|\/)test_.*\.py$/.test(path)) return 'pytest';
  if (/\bdescribe\s*\(/.test(content) && /from ['"]vitest['"]|vi\.fn/.test(content)) return 'vitest';
  if (/\bdescribe\s*\(/.test(content) && /jest\./.test(content)) return 'jest';
  if (/\bdescribe\s*\(/.test(content)) return /vitest/.test(content) ? 'vitest' : 'jest';
  if (/\bgo test|func Test/.test(content)) return 'go-test';
  if (/@Test/.test(content)) return 'junit';
  return 'unknown';
}

function countTests(content: string, framework: TestFile['framework']): number {
  if (framework === 'pytest') return (content.match(/^\s*def test_/gm) ?? []).length;
  if (framework === 'go-test') return (content.match(/^func Test/gm) ?? []).length;
  if (framework === 'junit') return (content.match(/@Test/g) ?? []).length;
  return (content.match(TEST_CALL_RE) ?? []).length;
}

/**
 * Build the test picture from the repository, then compare it with the change.
 *
 * Coverage here is *static reference coverage*: a test file is associated with a
 * source file by path convention and symbol names. It is not line coverage, and
 * the report says so.
 */
export function analyseTests(
  repoFiles: Map<string, string>,
  changes: FileChange[],
  symbols: ChangedSymbol[],
): TestAnalysis {
  const files: TestFile[] = [];
  for (const [path, content] of repoFiles) {
    if (!isTestFile(path)) continue;
    const framework = frameworkOf(path, content);
    const stem = baseName(path).replace(/\.(test|spec)$/, '');
    const targets = [...repoFiles.keys()].filter((p) => {
      if (isTestFile(p) || isDocumentationFile(p) || p === path) return false;
      return baseName(p).toLowerCase() === stem.toLowerCase();
    });
    const testSymbols = [...content.matchAll(/\b(?:import|from)\s*\{([^}]+)\}/g)]
      .flatMap((m) => (m[1] ?? '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]?.trim() ?? ''))
      .filter((s) => s.length > 1);
    files.push({ path, framework, targets, symbols: [...new Set(testSymbols)], testCount: countTests(content, framework) });
  }

  const testCorpus = [...repoFiles.entries()].filter(([p]) => isTestFile(p)).map(([, c]) => c).join('\n');
  const coveredStems = new Set(files.flatMap((f) => f.targets.map((t) => baseName(t).toLowerCase())));
  const changedSource = changes.filter((c) => c.status !== 'deleted' && !isTestFile(c.path) && !isDocumentationFile(c.path) && /\.(ts|tsx|js|jsx|py|java|kt|go|rb|php|cs|rs)$/.test(c.path));
  const uncoveredChanges = changedSource.filter((c) => !coveredStems.has(baseName(c.path).toLowerCase())).map((c) => c.path);

  const uncoveredSymbols = symbols
    .filter((s) => s.change !== 'removed' && !isTestFile(s.file))
    .filter((s) => s.exported && (s.kind === 'function' || s.kind === 'method' || s.kind === 'class'))
    .filter((s) => s.name.length > 3 && !new RegExp(`\\b${escapeRe(s.name)}\\b`).test(testCorpus))
    .map((s) => ({ file: s.file, symbol: s.name }))
    .slice(0, 12);

  const deletedTests = changes.filter((c) => c.status === 'deleted' && isTestFile(c.path)).map((c) => c.path);

  const suggestions = symbols
    .filter((s) => s.change !== 'removed' && !isTestFile(s.file))
    .filter((s) => uncoveredSymbols.some((u) => u.symbol === s.name && u.file === s.file))
    .slice(0, 6)
    .map((s) => ({
      title: `Cover ${s.name}`,
      file: s.file,
      rationale: `\`${s.name}\` (${s.kind}) changed in this review and no test file references the name. The scenarios below are derived from the symbol's role and the change type.`,
      scenarios: scenariosFor(s),
    }));

  return { files, uncoveredChanges, uncoveredSymbols, deletedTests, suggestions };
}

function scenariosFor(s: ChangedSymbol): string[] {
  const scenarios: string[] = [];
  if (s.kind === 'class') {
    scenarios.push('constructs with valid dependencies and exposes the documented surface');
    scenarios.push('rejects invalid constructor input with a typed error');
  } else if (s.kind === 'method') {
    scenarios.push(`returns the expected result for a valid input of \`${s.name}\``);
    scenarios.push(`propagates a failure instead of returning a partial result`);
  } else {
    scenarios.push('returns the expected output for a representative valid input');
    scenarios.push('fails with a typed error for malformed input rather than throwing a generic exception');
  }
  scenarios.push('is safe when the same operation is invoked twice (idempotency)');
  if (s.signatureChanged) scenarios.push('preserves the previous behaviour for callers that omit the new parameter');
  return scenarios;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
