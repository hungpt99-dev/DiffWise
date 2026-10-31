import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ReviewReport } from '@diffwise/core';
import {
  AiReviewer, ReportChat, parseJsonLoose, salvageJson, type CompletionRequest, type CompletionResult,
  type LlmProvider,
} from '../src/index';

/** A provider double: deterministic responses, no network. */
class FakeProvider implements LlmProvider {
  readonly id = 'openai-compatible' as const;
  readonly label = 'fake';
  readonly model = 'fake-1';
  readonly capabilities = { chat: true, jsonMode: true, streaming: false };
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly responses: string[]) {}
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const text = this.responses.shift() ?? '{}';
    return { text, model: this.model, latencyMs: 1, usage: { promptTokens: 10, completionTokens: 5 } };
  }
  async ping() { return { ok: true, latencyMs: 1, message: 'ok', model: this.model }; }
}

const CONTENT = `export class PaymentService {
  refund(id: string, cents: number) {
    const sql = \`UPDATE refunds SET total = total + \${cents}\`;
    return this.db.query(sql);
  }
}
`;

function makeReport(root: string): ReviewReport {
  const change = {
    path: 'src/payments/PaymentService.ts',
    status: 'modified' as const,
    additions: 3,
    deletions: 1,
    binary: false,
    hunks: [],
    patch: 'diff --git a/src/payments/PaymentService.ts b/src/payments/PaymentService.ts\n@@ -1,2 +1,4 @@\n+    const sql = `UPDATE refunds`;\n',
    language: 'typescript' as const,
  };
  return {
    schemaVersion: 1,
    id: 'test-review',
    createdAt: new Date().toISOString(),
    durationMs: 10,
    target: { mode: 'working', label: 'Working tree' },
    repository: {
      root, name: 'fixture', branch: 'main', headCommit: 'abc', headSubject: 'change',
      languages: [{ language: 'typescript', files: 1 }], frameworkHints: [], fileCount: 1,
    },
    summary: {
      changedFiles: 1, changedSymbols: 1, affectedComponents: 0,
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      findingsByCategory: {}, documentationFindings: 0, testsExecuted: false, aiUsed: false, completeness: 'complete',
    },
    risk: { score: 10, level: 'low', summary: 'test', factors: [], method: 'test' },
    stages: [],
    changes: [change],
    changeGroups: [],
    symbols: [],
    architecture: {
      graph: {
        edges: [], importers: {}, changedFiles: [change.path], directlyImpacted: [], indirectlyImpacted: [],
        impactDepth: {}, cycles: [], newCoupling: [], removedCoupling: [], boundaryChanges: [], modules: [], fileCount: 1, edgeCount: 0,
      },
      conventions: [], violations: [],
    },
    documentation: { files: [], findings: [] },
    findings: [],
    tests: { files: [], uncoveredChanges: [change.path], uncoveredSymbols: [], deletedTests: [], suggestions: [] },
    agent: {
      events: [], intents: [], decisions: [], alternatives: [], constraints: [], activities: [], verifications: [], unresolved: [], intentAlignment: [],
    },
    fixes: [],
    appliedFixes: [],
    provider: { configured: true, providerId: 'openai-compatible', model: 'fake-1', state: 'ok' },
    knowledge: [],
    settings: {
      maxFiles: 20, maxFileBytes: 400000, ignoreGlobs: [], aiEnabled: true,
      sendRepositoryContent: true, providerId: 'openai-compatible', model: 'fake-1',
    },
  };
}

const dirs: string[] = [];
async function fixture(): Promise<{ root: string; report: ReviewReport; repoFiles: Map<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), 'diffwise-ai-'));
  dirs.push(root);
  await mkdir(join(root, 'src/payments'), { recursive: true });
  await writeFile(join(root, 'src/payments/PaymentService.ts'), CONTENT, 'utf8');
  const repoFiles = new Map([['src/payments/PaymentService.ts', CONTENT]]);
  return { root, report: makeReport(root), repoFiles };
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('JSON recovery', () => {
  it('parses fenced JSON', () => {
    const parsed = parseJsonLoose('```json\n{"findings":[]}\n```');
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual({ findings: [] });
  });

  it('recovers complete findings from a truncated response', () => {
    const truncated = '{"findings":[{"title":"a","description":"first"},{"title":"b","description":"second"},{"title":"c","descrip';
    const salvaged = salvageJson<{ findings: Array<{ title: string }> }>(truncated);
    expect(salvaged?.findings.length).toBe(2);
    expect(salvaged?.findings[1]?.title).toBe('b');
  });
});

describe('AiReviewer evidence validation', () => {
  it('keeps only findings whose quoted evidence exists in the repository', async () => {
    const { root, report, repoFiles } = await fixture();
    const response = JSON.stringify({
      findings: [
        {
          title: 'SQL built by interpolation in refund',
          description: 'The refund method interpolates the amount directly into the SQL text instead of binding it.',
          severity: 'high', category: 'security', kind: 'risk', confidence: 'high',
          file: 'src/payments/PaymentService.ts', startLine: 3, endLine: 4,
          evidence: [{ file: 'src/payments/PaymentService.ts', line: 3, quote: 'const sql = `UPDATE refunds SET total = total + ${cents}`;', note: 'interpolated SQL' }],
          whyItMatters: 'A caller-controlled amount becomes SQL syntax.', consequences: ['data loss'],
          recommendation: 'Use bound parameters.', tags: ['sql'],
        },
        {
          title: 'Invented problem in a file that does not exist',
          description: 'This claim cites a path that is not in the repository, so it must be rejected by validation.',
          severity: 'critical', category: 'security', kind: 'problem', confidence: 'high',
          file: 'src/does-not-exist.ts', startLine: 1,
          evidence: [{ file: 'src/does-not-exist.ts', line: 1, quote: 'nope', note: 'nope' }],
          whyItMatters: 'fabricated', recommendation: 'ignore',
        },
        {
          title: 'Real file but fabricated quote',
          description: 'The file exists, but the quoted text does not appear anywhere in it, so the claim is discarded.',
          severity: 'high', category: 'correctness', kind: 'problem', confidence: 'high',
          file: 'src/payments/PaymentService.ts', startLine: 2,
          evidence: [{ file: 'src/payments/PaymentService.ts', line: 2, quote: 'this line is not in the file', note: 'missing' }],
          whyItMatters: 'fabricated quote', recommendation: 'ignore',
        },
      ],
    });
    const provider = new FakeProvider([response, JSON.stringify({ solutions: [] })]);
    const reviewer = new AiReviewer(provider, { generateFixes: false });
    const result = await reviewer.enrich({
      root, report, repoFiles, changedContents: repoFiles,
      settings: report.settings, log: () => {},
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.file).toBe('src/payments/PaymentService.ts');
    expect(result.ai?.evidenceRejected).toBe(2);
    expect(result.ai?.requests).toBe(1);
  });

  it('returns a provider error without throwing when the model fails', async () => {
    const { root, report, repoFiles } = await fixture();
    const provider: LlmProvider = {
      ...new FakeProvider([]),
      complete: async () => { throw new Error('upstream 503'); },
    } as LlmProvider;
    const reviewer = new AiReviewer(provider, { generateFixes: false });
    const result = await reviewer.enrich({ root, report, repoFiles, changedContents: repoFiles, settings: report.settings, log: () => {} });
    expect(result.provider?.state).toBe('error');
    expect(result.warning).toMatch(/503/);
    expect(result.findings ?? []).toHaveLength(0);
  });
});

describe('ReportChat citation validation', () => {
  it('drops citations that do not resolve to repository lines', async () => {
    const { report, repoFiles } = await fixture();
    const provider = new FakeProvider([JSON.stringify({
      answer: 'Evidence: the refund interpolates SQL.\nInterpretation: injection is possible.\nTo verify: run a test.',
      citations: [
        { file: 'src/payments/PaymentService.ts', line: 3, note: 'interpolated SQL' },
        { file: 'src/ghost.ts', line: 1, note: 'not real' },
      ],
      confidence: 'high',
      caveats: [],
    })]);
    const chat = new ReportChat(provider, report, repoFiles);
    const answer = await chat.ask('What is wrong with refund?');
    expect(answer.answer).toMatch(/interpolates SQL/);
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0]?.file).toBe('src/payments/PaymentService.ts');
    expect(answer.invalidCitations).toBe(1);
    expect(answer.caveats.join(' ')).toMatch(/did not resolve/);
  });
});
