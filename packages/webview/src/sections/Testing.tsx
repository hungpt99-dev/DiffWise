import { useMemo, useState } from 'react';
import type { ReviewReport, TestExecution } from '@diffwise/core';
import { Banner, Chip, EmptyState, FileRef, SectionHeader } from '../ui';

export function Testing({ report, onOpen, onVerify, verification, onCopy }: {
  report: ReviewReport;
  onOpen: (file: string, line?: number) => void;
  onVerify: () => void;
  verification?: TestExecution;
  onCopy: (text: string) => void;
}) {
  const t = report.tests;
  const execution = verification ?? t.execution;
  const totalTests = t.files.reduce((n, f) => n + f.testCount, 0);
  const [skeletonFor, setSkeletonFor] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const suggestion = t.suggestions.find((s) => s.title === skeletonFor);
  const skeleton = useMemo(() => suggestion ? buildSkeleton(suggestion.file, suggestion.scenarios) : '', [suggestion]);

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="Testing and verification"
        title="What is actually covered"
        description="Coverage is resolved from repository structure and imports, not from a claimed percentage. Test execution results appear only when a command was actually run."
      />

      <div className="grid grid-4">
        <div className="mini-stat"><strong>{t.files.length}</strong><span>test files</span></div>
        <div className="mini-stat"><strong>{totalTests}</strong><span>test cases detected</span></div>
        <div className="mini-stat"><strong>{t.uncoveredChanges.length}</strong><span>changed files without tests</span></div>
        <div className="mini-stat"><strong>{t.deletedTests.length}</strong><span>deleted or reduced suites</span></div>
      </div>

      {t.uncoveredChanges.length > 0 && (
        <Banner level="warn" title={`${t.uncoveredChanges.length} changed file(s) have no covering test`}>
          <div className="file-list">{t.uncoveredChanges.map((f) => <FileRef key={f} file={f} onOpen={onOpen} inline />)}</div>
        </Banner>
      )}
      {t.deletedTests.length > 0 && (
        <Banner level="error" title="Tests were deleted or reduced">
          <ul className="tight">{t.deletedTests.map((d) => <li key={d}>{d}</li>)}</ul>
        </Banner>
      )}

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2>Suggested test scenarios</h2><Chip tone="neutral">{t.suggestions.length}</Chip></div>
          {t.suggestions.length === 0 ? <p className="muted">Every changed symbol is referenced by a test. No additional scenario was derived.</p> : (
            <div className="suggestions">
              {t.suggestions.map((s) => (
                <div className="suggestion" key={s.title}>
                  <div className="suggestion-head">
                    <strong>{s.title}</strong>
                    <FileRef file={s.file} onOpen={onOpen} inline />
                  </div>
                  <p className="muted small">{s.rationale}</p>
                  <ul className="tight">{s.scenarios.map((sc, i) => <li key={i}>{sc}</li>)}</ul>
                  <button className="link" onClick={() => setSkeletonFor(s.title)}>Preview test skeleton →</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h2>Verification</h2><Chip tone={execution ? (execution.status === 'passed' ? 'good' : execution.status === 'not-run' ? 'warn' : 'bad') : 'neutral'}>{execution?.status ?? 'not run'}</Chip></div>
          <p className="muted small">DiffWise runs a command only when you press the button, using the command configured in settings. It never executes repository scripts on its own.</p>
          <div className="meta-row">
            <span><strong>Command</strong> <code>{report.settings.verificationCommand ?? '(not configured)'}</code></span>
          </div>
          <label className="check">
            <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
            <span>I approve running <code>{report.settings.verificationCommand || 'the configured command'}</code> in this repository.</span>
          </label>
          <button className="btn primary" onClick={onVerify} disabled={!approved || !report.settings.verificationCommand}>Run verification command</button>
          {execution ? (
            <div className="stack">
              <div className="meta-row">
                <span><strong>Exit</strong> {execution.exitCode ?? '—'}</span>
                <span><strong>Duration</strong> {(execution.durationMs / 1000).toFixed(1)}s</span>
                <span><strong>Trigger</strong> {execution.ranBy}</span>
                <span><strong>Related tests</strong> {execution.relatedTestsExecuted ? 'yes' : 'not detected'}</span>
              </div>
              <pre className="output">{execution.outputTail || '(no output)'}</pre>
              <p className="muted small">Status is the process exit code. A passing command does not prove the change is correct beyond the tests that ran; tests not executed are not reported as passing.</p>
            </div>
          ) : (
            <p className="muted small">No execution has been recorded for this review.</p>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Test map</h2><span className="muted small">resolved by path, basename and import</span></div>
        {t.files.length === 0 ? <EmptyState title="No test files found" body="DiffWise did not find a recognised test file in this repository. That is a finding in itself: nothing here is protected by automated tests." /> : (
          <table className="table">
            <thead><tr><th>Test file</th><th>Framework</th><th>Tests</th><th>Covers</th></tr></thead>
            <tbody>
              {t.files.map((f) => (
                <tr key={f.path}>
                  <td><FileRef file={f.path} onOpen={onOpen} inline /></td>
                  <td>{f.framework}</td>
                  <td>{f.testCount}</td>
                  <td>{f.targets.length === 0 ? <span className="muted">unresolved</span> : f.targets.map((x) => <FileRef key={x} file={x} onOpen={onOpen} inline />)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {t.uncoveredSymbols.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>Changed symbols never referenced by a test</h2></div>
          <div className="tag-row">{t.uncoveredSymbols.map((s) => <Chip key={`${s.file}:${s.symbol}`} tone="warn" title={s.file}>{s.symbol}</Chip>)}</div>
        </section>
      )}

      {skeleton && suggestion && (
        <div className="modal-backdrop" onClick={() => setSkeletonFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-head"><h2>Test skeleton</h2><button className="icon-btn" onClick={() => setSkeletonFor(null)}>✕</button></div>
            <p className="muted small">Generated from the changed symbols and their scenario list. It is a starting point, not a verified test.</p>
            <pre className="output">{skeleton}</pre>
            <div className="modal-actions">
              <button className="btn" onClick={() => onCopy(skeleton)}>Copy</button>
              <button className="btn ghost" onClick={() => setSkeletonFor(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function buildSkeleton(file: string, scenarios: string[]): string {
  const base = (file.split('/').pop() ?? 'module').replace(/\.(ts|tsx|js|jsx|py)$/, '');
  return [
    `// Suggested tests for ${file}`,
    `// Generated by DiffWise from the changed symbols. Review before committing.`,
    `import { describe, it, expect } from 'vitest';`,
    ``,
    `describe('${base}', () => {`,
    ...scenarios.map((s, i) => [
      `  it('${s.replace(/'/g, "\\'")}', async () => {`,
      `    // Arrange: build the minimal input for this scenario`,
      `    // Act: call the changed behaviour`,
      `    // Assert: state the observable outcome (${i + 1})`,
      `    expect(true).toBe(false); // replace with a real assertion`,
      `  });`,
      ``,
    ].join('\n')),
    `});`,
  ].join('\n');
}
