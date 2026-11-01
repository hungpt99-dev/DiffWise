import { describe, expect, it } from 'vitest';
import {
  ContentCache, TokenBudget, buildChangeFirstContext, clipToTokens, codeWindows, computeCost, contentKey,
  estimatePromptTokens, estimateTokens, mergeRanges, packSections, resolvePrice, selectWindows, tokenFamilyFor,
  UsageMeter, type ReviewReport,
} from '../src/index';

describe('token estimation', () => {
  it('is monotonic and never zero for non-empty input', () => {
    expect(estimateTokens('')).toBe(0);
    const short = estimateTokens('const a = 1;');
    const long = estimateTokens('const a = 1;\n'.repeat(50));
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
  });

  it('charges code more per character than prose', () => {
    const prose = 'The reviewer reads the change and reports the defects it can prove with evidence.';
    const code = 'const{x:y}=z.map((a)=>({a,b:c?.d??e}));if(!f.g){throw new H(i,j)}';
    const proseRate = estimateTokens(prose) / prose.length;
    const codeRate = estimateTokens(code) / code.length;
    expect(codeRate).toBeGreaterThan(proseRate);
  });

  it('splits long identifiers into subword tokens', () => {
    expect(estimateTokens('getUserAccountBalance')).toBeGreaterThan(estimateTokens('balanceNow'));
  });

  it('prices CJK characters without exploding the estimate', () => {
    const text = 'Đánh giá thay đổi mã nguồn và báo cáo lỗi.';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(8);
    expect(tokens).toBeLessThanOrEqual(text.length);
  });

  it('counts digits in groups, as BPE does', () => {
    expect(estimateTokens('123456789')).toBeLessThan(9);
  });

  it('detects tokenizer families and applies a stable factor', () => {
    expect(tokenFamilyFor('gpt-4o-mini')).toBe('openai');
    expect(tokenFamilyFor('claude-sonnet-4')).toBe('anthropic');
    expect(tokenFamilyFor('deepseek-v4.1-flash')).toBe('deepseek');
    expect(tokenFamilyFor('some-unknown-model')).toBe('unknown');
    const text = 'function handle(request) { return request.body; }';
    expect(estimateTokens(text, 'deepseek')).toBeGreaterThanOrEqual(estimateTokens(text, 'openai'));
  });

  it('adds chat framing overhead per message', () => {
    const one = estimatePromptTokens([{ role: 'user', content: 'hello' }], 'gpt-4o');
    const two = estimatePromptTokens([{ role: 'system', content: 'hello' }, { role: 'user', content: 'hello' }], 'gpt-4o');
    expect(two).toBeGreaterThan(one);
    expect(one).toBeGreaterThan(estimateTokens('hello'));
  });
});

describe('token budget', () => {
  it('derives the input limit from window, reservation and margin', () => {
    const budget = new TokenBudget({ contextLimit: 100_000, reservedOutput: 10_000, safetyMargin: 0.1 });
    expect(budget.inputLimit).toBe(81_000);
    expect(budget.source).toBe('derived');
    expect(budget.fits(80_000)).toBe(true);
    expect(budget.fits(82_000)).toBe(false);
  });

  it('honours an explicit input budget over the derived one', () => {
    const budget = new TokenBudget({ contextLimit: 200_000, inputLimit: 12_345 });
    expect(budget.inputLimit).toBe(12_345);
    expect(budget.source).toBe('explicit');
  });

  it('allocates proportional shares without exceeding the budget', () => {
    const budget = new TokenBudget({ inputLimit: 1_000 });
    const shares = budget.allocate([1, 3]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_000);
    expect(shares[1]).toBeGreaterThan(shares[0]!);
  });
});

describe('section packing', () => {
  const big = (id: string, priority: number, tier: 1 | 2 | 3, lines: number) => ({
    id, priority, tier, text: `${id}\n${'line of context '.repeat(6).trim()}\n`.repeat(lines),
  });

  it('keeps required sections and drops low priority first', () => {
    const budget = new TokenBudget({ inputLimit: 400 });
    const result = packSections([
      { id: 'must', priority: 1, tier: 1, required: true, text: 'changed file list' },
      big('diff', 99, 1, 4),
      big('knowledge', 10, 2, 200),
    ], budget);
    const ids = result.sections.map((s) => s.id);
    expect(ids).toContain('must');
    expect(ids).toContain('diff');
    expect(ids).not.toContain('knowledge');
    expect(result.dropped).toContain('knowledge');
    expect(result.truncated).toBe(true);
    expect(result.tokens).toBeLessThanOrEqual(budget.inputLimit);
  });

  it('clips a section that is close to fitting and says so', () => {
    const budget = new TokenBudget({ inputLimit: 250 });
    const result = packSections([big('windows', 50, 2, 12)], budget, { minSectionTokens: 100 });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.clipped).toBe(true);
    expect(result.clipped).toContain('windows');
    expect(result.sections[0]!.tokens).toBeLessThanOrEqual(budget.inputLimit);
  });

  it('orders sections by tier so the change precedes its context', () => {
    const budget = new TokenBudget({ inputLimit: 5_000 });
    const result = packSections([big('context', 10, 2, 2), big('diff', 99, 1, 2)], budget);
    expect(result.sections.map((s) => s.id)).toEqual(['diff', 'context']);
  });

  it('clips at a line boundary and keeps the marker', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i} with some content`).join('\n');
    const cut = clipToTokens(text, 60);
    expect(cut.clipped).toBe(true);
    expect(cut.text.startsWith('line 0')).toBe(true);
    expect(cut.text).toContain('truncated');
    expect(cut.tokens).toBeLessThanOrEqual(60);
  });
});

describe('code windows', () => {
  it('merges near ranges and expands by the radius', () => {
    expect(mergeRanges([{ start: 10, end: 12 }, { start: 14, end: 15 }], 2)).toEqual([{ start: 10, end: 15 }]);
    const { windows } = selectWindows([{ start: 50, end: 52 }], { radius: 4 }, 200);
    expect(windows).toEqual([{ start: 46, end: 56 }]);
  });

  it('caps the window count and reports omissions', () => {
    const ranges = Array.from({ length: 8 }, (_, i) => ({ start: i * 100 + 1, end: i * 100 + 2 }));
    const { windows, dropped } = selectWindows(ranges, { radius: 1, mergeGap: 1, maxWindows: 2 }, 1000);
    expect(windows).toHaveLength(2);
    expect(dropped).toBe(6);
  });

  it('renders absolute line numbers so quotes can be located later', () => {
    const content = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const { text } = codeWindows(content, [{ start: 3, end: 4 }], { radius: 0 });
    expect(text).toContain('3| c');
    expect(text).toContain('4| d');
    expect(text).not.toContain('1| a');
  });
});

describe('content-addressed cache', () => {
  it('stores and reads a value by key', async () => {
    const cache = new ContentCache({ ttlMs: 10_000 });
    await cache.set('abc12345', { answer: 42 });
    expect(await cache.get('abc12345')).toMatchObject({ value: { answer: 42 } });
    expect(cache.snapshot()).toEqual({ hits: 1, misses: 0, writes: 1 });
  });

  it('expires entries using the injected clock', async () => {
    let now = 1_000;
    const cache = new ContentCache({ ttlMs: 100, now: () => now });
    await cache.set('abc12345', 'v');
    now = 1_050;
    expect(await cache.get('abc12345')).toBeDefined();
    now = 1_200;
    expect(await cache.get('abc12345')).toBeUndefined();
  });

  it('refuses keys that could escape the cache directory', async () => {
    const cache = new ContentCache({});
    await cache.set('../../etc/passwd', 'x');
    expect(await cache.get('../../etc/passwd')).toBeUndefined();
  });

  it('derives keys from every input, and only from them', () => {
    const a = contentKey('model', 'prompt');
    expect(a).toBe(contentKey('model', 'prompt'));
    expect(a).not.toBe(contentKey('model', 'prompt '));
    expect(a).not.toBe(contentKey(null, 'model', 'prompt'));
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it('evicts the oldest entries when the entry cap is exceeded', async () => {
    let now = 1;
    const cache = new ContentCache({ maxEntries: 2, now: () => now++ });
    await cache.set('key00001', 1);
    await cache.set('key00002', 2);
    await cache.set('key00003', 3);
    const stats = await cache.stats();
    expect(stats.entries).toBeLessThanOrEqual(2);
    expect(stats.evictions).toBeGreaterThan(0);
  });
});

describe('pricing and usage', () => {
  it('reports no cost when no price is configured', () => {
    const meter = new UsageMeter();
    meter.record({ task: 'review', provider: 'p', model: 'unknown-model', promptTokens: 1_000, completionTokens: 200 });
    const summary = meter.summary();
    expect(summary.cost).toBeUndefined();
    expect(summary.costBasis).toBe('unknown');
    expect(summary.totals.promptTokens).toBe(1_000);
  });

  it('computes a list-price estimate from provider token counts', () => {
    const price = { inputPerMTok: 1, outputPerMTok: 2, source: 'test' };
    const cost = computeCost({ prompt: 1_000_000, completion: 500_000 }, price)!;
    expect(cost.usd).toBe(2);
    expect(cost.estimated).toBe(true);
    expect(cost.basis).toBe('list-price');
  });

  it('resolves wildcard prices with the longest pattern winning', () => {
    const table = {
      'deepseek-*': { inputPerMTok: 10, outputPerMTok: 10, source: 'broad' },
      'deepseek-v4-*': { inputPerMTok: 1, outputPerMTok: 1, source: 'narrow' },
    };
    expect(resolvePrice('deepseek-v4-flash', table)?.source).toBe('narrow');
    expect(resolvePrice('deepseek-r1', table)?.source).toBe('broad');
    expect(resolvePrice('gpt-4o', table)).toBeUndefined();
  });

  it('attributes usage per task and keeps provider and estimated counts apart', () => {
    const meter = new UsageMeter();
    meter.record({ task: 'review', provider: 'p', model: 'm', promptTokens: 100, completionTokens: 10, source: 'provider' });
    meter.record({ task: 'fix', provider: 'p', model: 'm', promptTokens: 50, completionTokens: 5, source: 'estimated' });
    meter.record({ task: 'review', provider: 'p', model: 'm', promptTokens: 100, completionTokens: 10, cacheHit: true, tokensSavedByCache: 100, source: 'provider' });
    const summary = meter.summary();
    expect(summary.totals.requests).toBe(3);
    expect(summary.totals.cacheHits).toBe(1);
    expect(summary.totals.tokensSavedByCache).toBe(100);
    expect(summary.totals.source).toBe('mixed');
    expect(summary.byTask.map((t) => t.task)).toContain('fix');
  });
});

describe('change-first context', () => {
  const report = {
    schemaVersion: 3,
    id: 'r1',
    createdAt: new Date(0).toISOString(),
    durationMs: 1,
    target: { kind: 'working', label: 'working tree' },
    repository: { name: 'demo', branch: 'main', root: '/tmp/demo', head: 'abc', dirty: true },
    summary: { headline: 'x', narrative: '', topRisks: [], nextSteps: [] },
    risk: { score: 40, level: 'moderate', summary: 's', factors: [{ id: 'f', label: 'security', points: 20, maxPoints: 40, explanation: '', evidence: [] }], method: 'additive' },
    stages: [],
    changes: [{
      path: 'src/pay.ts', status: 'modified', additions: 3, deletions: 1, binary: false, language: 'typescript',
      patch: '@@ -1,3 +1,5 @@\n a\n+b\n+c',
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, header: '-1,3 +1,5 @@', lines: [
        { kind: 'context', text: 'const a = 1;', newLine: 1, oldLine: 1 },
        { kind: 'add', text: 'const b = charge(amount);', newLine: 2 },
        { kind: 'del', text: 'const c = 0;', oldLine: 2 },
        { kind: 'add', text: 'const d = settle(b);', newLine: 3 },
      ] }],
    }],
    changeGroups: [],
    symbols: [{ id: 's1', name: 'charge', kind: 'function', file: 'src/pay.ts', range: { start: 2, end: 8 }, changeRanges: [{ start: 2, end: 3 }], exported: true, change: 'modified', signature: 'charge(amount)', signatureChanged: false, referenceCount: 2, referenceExamples: ['src/api.ts'] }],
    architecture: { graph: { nodes: [], edges: [], directlyImpacted: ['src/api.ts'], indirectlyImpacted: [], cycles: [] } },
    documentation: { files: [], findings: [] },
    findings: [
      { id: 'DW-1', title: 'Missing idempotency on retry', description: 'd', severity: 'high', category: 'reliability', kind: 'risk', confidence: 'high', file: 'src/pay.ts', range: { start: 2, end: 3 }, evidence: [], whyItMatters: 'w', recommendation: 'r', ruleId: 'x', source: 'deterministic', tags: [] },
    ],
    tests: { files: [{ path: 'test/pay.test.ts', relatedTo: [], covers: [], assertions: 0, framework: 'vitest' }], uncoveredChanges: [], uncoveredSymbols: [], deletedTests: [], suggestions: [] },
    agent: { events: [], intents: [] },
    fixes: [],
    appliedFixes: [],
    provider: { configured: false, providerId: 'none', model: 'none', state: 'disabled', capabilities: { chat: false, jsonMode: false, streaming: false } },
    knowledge: [],
    settings: {},
    execution: { mode: 'deterministic' },
    verification: [],
  } as unknown as ReviewReport;

  const files = new Map([['src/pay.ts', Array.from({ length: 120 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n')]]);

  it('includes the change, symbols and findings in tier 1', () => {
    const pack = buildChangeFirstContext(report, files, { inputLimit: 4_000, includeCode: true });
    const ids = pack.sections.map((s) => s.id);
    expect(ids).toContain('diff');
    expect(ids).toContain('symbols');
    expect(ids).toContain('findings');
    expect(pack.text).toContain('src/pay.ts');
    expect(pack.text).toContain('Missing idempotency');
    expect(pack.tokens).toBeLessThanOrEqual(4_000);
  });

  it('never sends file content without consent', () => {
    const pack = buildChangeFirstContext(report, files, { inputLimit: 8_000, includeCode: false });
    expect(pack.text).not.toContain('const line10 = 10;');
    expect(pack.sections.map((s) => s.id)).not.toContain('windows');
  });

  it('sends only windows around the changed lines with consent', () => {
    const pack = buildChangeFirstContext(report, files, { inputLimit: 8_000, includeCode: true });
    expect(pack.sections.map((s) => s.id)).toContain('windows');
    expect(pack.text).toContain('const line2 = 2;');
    expect(pack.text).not.toContain('const line110 = 110;');
  });

  it('stays inside a small budget and reports what it dropped', () => {
    const pack = buildChangeFirstContext(report, files, { inputLimit: 400, includeCode: true, includeDeep: true });
    expect(pack.tokens).toBeLessThanOrEqual(400);
    expect(pack.truncated).toBe(true);
    expect([...pack.dropped, ...pack.clipped].length).toBeGreaterThan(0);
  });

  it('fingerprints the exact context so cache keys cannot outlive it', () => {
    const a = buildChangeFirstContext(report, files, { inputLimit: 4_000 });
    const b = buildChangeFirstContext(report, files, { inputLimit: 4_000 });
    const changed = { ...report, findings: [{ ...report.findings[0]!, severity: 'critical' as const }] } as ReviewReport;
    const c = buildChangeFirstContext(changed, files, { inputLimit: 4_000 });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it('records the budget it used rather than a character limit', () => {
    const pack = buildChangeFirstContext(report, files, { contextLimit: 100_000, reservedOutput: 20_000 });
    expect(pack.budget).toContain('input tokens');
    expect(pack.budget).toContain('reserved for output');
  });
});
