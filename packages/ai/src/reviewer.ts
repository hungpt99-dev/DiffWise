import {
  SEVERITY_ORDER, buildContextPack, redactSecrets, similarity, stableId, validatePatch,
} from '@diffwise/core';
import type {
  EnrichmentInput, EnrichmentResult, Evidence, Finding, FindingCategory, FindingKind, FixSolution,
  ProviderStatus, ReviewEnricher, ReviewReport, Severity,
} from '@diffwise/core';
import { FIX_SYSTEM, REVIEW_SYSTEM, fixUserPrompt, reviewUserPrompt } from './prompts';
import { clampLine, parseJsonLoose, salvageJson, stringArray } from './json';
import type { LlmProvider, Usage } from './types';
import { ProviderError } from './types';

const CATEGORIES = new Set<string>([
  'correctness', 'security', 'performance', 'reliability', 'concurrency', 'database', 'api-contract',
  'maintainability', 'architecture', 'tests', 'documentation', 'error-handling', 'resources', 'configuration',
]);
const SEVERITIES = new Set<string>(['critical', 'high', 'medium', 'low', 'info']);
const KINDS = new Set<string>(['problem', 'risk', 'recommendation', 'question']);
const CONFIDENCES = new Set<string>(['verified', 'high', 'medium', 'low']);

export interface AiReviewerOptions {
  /** Optional faster/cheaper provider for fix generation. */
  fixProvider?: LlmProvider;
  /** How many findings receive generated fix options. */
  maxFixFindings?: number;
  /** Hard cap on accepted model findings. */
  maxFindings?: number;
  /** Context budget in characters. */
  maxContextChars?: number;
  /** Generate fix options at all. */
  generateFixes?: boolean;
}

interface RawFinding {
  title?: unknown;
  description?: unknown;
  severity?: unknown;
  category?: unknown;
  kind?: unknown;
  confidence?: unknown;
  file?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  evidence?: unknown;
  whyItMatters?: unknown;
  consequences?: unknown;
  reproduction?: unknown;
  recommendation?: unknown;
  tags?: unknown;
}

interface RawSolution {
  findingId?: unknown;
  label?: unknown;
  approach?: unknown;
  description?: unknown;
  filesAffected?: unknown;
  advantages?: unknown;
  disadvantages?: unknown;
  performance?: unknown;
  sideEffects?: unknown;
  complexity?: unknown;
  testing?: unknown;
  compatibility?: unknown;
  diff?: unknown;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Does the quoted text actually occur in the file? Returns the real line when found. */
export function locateQuote(content: string, quote: string): number | null {
  const lines = content.split(/\r?\n/);
  const target = normalize(quote);
  if (target.length < 3) return null;
  const single = lines.findIndex((l) => normalize(l) === target);
  if (single >= 0) return single + 1;
  const contains = lines.findIndex((l) => target.length >= 8 && normalize(l).includes(target));
  if (contains >= 0) return contains + 1;
  // Multi-line quote.
  const joined = normalize(content);
  if (target.length >= 12 && joined.includes(target)) {
    const firstLine = quote.split(/\r?\n/)[0] ?? quote;
    const idx = lines.findIndex((l) => normalize(l).includes(normalize(firstLine).slice(0, 24)));
    return idx >= 0 ? idx + 1 : null;
  }
  return null;
}

/**
 * AI review enricher.
 *
 * Produces findings only when the model's claims survive evidence validation,
 * and fix options only when the proposed patch applies to the current tree.
 * Every rejection is counted so the report can show what was discarded.
 */
export class AiReviewer implements ReviewEnricher {
  readonly id = 'ai-review';
  readonly label = 'AI interpretation';
  private readonly maxFixFindings: number;
  private readonly maxFindings: number;
  private readonly maxContextChars: number;
  private readonly generateFixes: boolean;

  private readonly fixProvider?: LlmProvider;

  constructor(private readonly provider: LlmProvider, opts: AiReviewerOptions = {}) {
    this.fixProvider = opts.fixProvider;
    this.maxFixFindings = opts.maxFixFindings ?? 3;
    this.maxFindings = opts.maxFindings ?? 6;
    this.maxContextChars = opts.maxContextChars ?? 60_000;
    this.generateFixes = opts.generateFixes ?? true;
  }

  async enrich(input: EnrichmentInput): Promise<EnrichmentResult> {
    if (!input.settings.aiEnabled) {
      return {
        provider: {
          configured: this.provider.id !== 'none',
          providerId: this.provider.id,
          model: this.provider.model,
          state: 'disabled',
          message: 'AI interpretation is disabled in settings; the report contains deterministic analysis only.',
          capabilities: this.provider.capabilities,
        },
      };
    }

    const usage: Usage = { promptTokens: 0, completionTokens: 0 };
    const failures: string[] = [];
    let requests = 0;
    let evidenceRejected = 0;
    let redactions = 0;

    const context = buildContextPack(input.report, input.repoFiles, {
      maxChars: this.maxContextChars,
      includeCode: input.settings.sendRepositoryContent,
    });
    redactions += context.redactions;
    input.log(`Sending ${context.approxTokens}≈ tokens of review context (${context.filesIncluded.length} file excerpt(s)).`);

    let findings: Finding[] = [];
    try {
      const prompt = reviewUserPrompt({
        contextPack: context.text,
        deterministicFindings: input.report.findings,
        changedFiles: input.report.changes.map((c) => c.path),
        ...(input.report.agent.intents[0] ? { agentIntent: input.report.agent.intents[0].detail } : {}),
      });
      const messages = [
        { role: 'system' as const, content: REVIEW_SYSTEM },
        { role: 'user' as const, content: prompt },
      ];
      requests += 1;
      let result = await this.provider.complete({
        messages,
        json: true,
        maxTokens: 12_000,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
      let parsed = parseJsonLoose<{ findings?: RawFinding[]; missingDimensions?: unknown }>(result.text);
      if (!parsed.ok || !parsed.value) {
        const salvaged = salvageJson<{ findings?: RawFinding[] }>(result.text);
        if (salvaged) {
          parsed = { ok: true, value: salvaged, recovered: 'repaired' };
          failures.push('The model response was truncated; only the complete findings it contained were used.');
        }
      }
      if (!parsed.ok || !parsed.value) {
        // One corrective retry with a larger budget and a stricter, shorter shape.
        requests += 1;
        const retry = await this.provider.complete({
          messages: [
            { role: 'system', content: REVIEW_SYSTEM },
            { role: 'user', content: `${prompt}\n\nIMPORTANT: your previous answer was cut off. Return at most 4 findings, keep each description under 50 words, omit optional fields, and emit strictly valid JSON that closes every bracket.` },
          ],
          json: true,
          maxTokens: 24_000,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        usage.promptTokens += retry.usage.promptTokens;
        usage.completionTokens += retry.usage.completionTokens;
        parsed = parseJsonLoose<{ findings?: RawFinding[] }>(retry.text);
        if (!parsed.ok || !parsed.value) {
          const salvaged = salvageJson<{ findings?: RawFinding[] }>(retry.text);
          if (salvaged) {
            parsed = { ok: true, value: salvaged, recovered: 'repaired' };
            failures.push('The model response was truncated twice; only complete findings were used.');
          }
        }
      }
      if (!parsed.ok || !parsed.value) {
        failures.push(parsed.error ?? 'Model response could not be parsed');
      } else {
        const raw = Array.isArray(parsed.value.findings) ? parsed.value.findings : [];
        this.log(input, `AI response recovered=${parsed.recovered}; keys=${Object.keys(parsed.value ?? {}).join(',')}; findings=${raw.length}; chars=${result.text.length}`);
        if (raw.length === 0) {
          this.log(input, `AI raw response: ${result.text.slice(0, 700).replace(/\s+/g, ' ')}`);
        }
        const accepted: Finding[] = [];
        for (const candidate of raw.slice(0, this.maxFindings * 2)) {
          const validated = this.toFinding(candidate, input, () => {
            // A rejected claim is the validation layer working, not a failure.
            evidenceRejected += 1;
          });
          if (!validated) continue;
          if (this.duplicates(validated, input.report.findings, accepted)) continue;
          accepted.push(validated);
          if (accepted.length >= this.maxFindings) break;
        }
        findings = accepted;
      }
    } catch (err) {
      const message = this.describe(err);
      failures.push(message);
      return {
        provider: this.status('error', message),
        ai: {
          model: this.provider.model,
          provider: this.provider.id,
          requests,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          failures,
          redactions,
          evidenceRejected,
        },
        warning: `AI review failed: ${message}`,
      };
    }

    let fixes: FixSolution[] = [];
    if (this.generateFixes && findings.length + input.report.findings.length > 0) {
      try {
        const fixResult = await this.generateFixOptions(input, [...input.report.findings, ...findings], (u) => {
          usage.promptTokens += u.promptTokens;
          usage.completionTokens += u.completionTokens;
          requests += 1;
          redactions += u.redactions;
        }, input.signal);
        fixes = fixResult.fixes;
        failures.push(...fixResult.failures);
      } catch (err) {
        failures.push(`fix generation: ${this.describe(err)}`);
      }
    }

    const warning = failures.length ? failures.slice(0, 3).join(' | ') : undefined;
    return {
      findings,
      fixes,
      provider: this.status(findings.length > 0 || failures.length === 0 ? 'ok' : 'error', failures[0]),
      ai: {
        model: this.provider.model,
        provider: this.provider.id,
        requests,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        failures,
        redactions,
        evidenceRejected,
      },
      ...(warning ? { warning } : {}),
      detail: `${findings.length} validated model finding(s), ${fixes.length} fix option(s).`,
    };
  }

  private status(state: ProviderStatus['state'], message?: string): ProviderStatus {
    return {
      configured: this.provider.id !== 'none',
      providerId: this.provider.id,
      model: this.provider.model,
      state,
      ...(message ? { message } : {}),
      capabilities: this.provider.capabilities,
    };
  }

  private describe(err: unknown): string {
    if (err instanceof ProviderError) return err.message;
    if (err instanceof Error) return err.name === 'AbortError' ? 'AI request cancelled' : err.message;
    return String(err);
  }

  private log(input: EnrichmentInput, message: string): void {
    input.log(message);
    if (process.env.DIFFWISE_DEBUG === '1') process.stderr.write(`[diffwise-ai] ${message}\n`);
  }

  private duplicates(candidate: Finding, existing: Finding[], accepted: Finding[]): boolean {
    return [...existing, ...accepted].some((f) => {
      if (f.file !== candidate.file) return false;
      if (f.ruleId === candidate.ruleId) return true;
      return similarity(f.title, candidate.title) > 0.72;
    });
  }

  private toFinding(
    raw: RawFinding,
    input: EnrichmentInput,
    reject: (reason: string) => void,
  ): Finding | null {
    const file = typeof raw.file === 'string' ? raw.file.replace(/^\.\//, '') : '';
    const content = input.repoFiles.get(file) ?? input.changedContents.get(file) ?? null;
    if (!file || content === null) {
      reject(`unknown file "${file || '(missing)'}"`);
      return null;
    }
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    const recommendation = typeof raw.recommendation === 'string' ? raw.recommendation.trim() : '';
    if (title.length < 8 || description.length < 20 || recommendation.length < 8) {
      reject(`incomplete finding "${title.slice(0, 40)}"`);
      return null;
    }
    const lines = content.split(/\r?\n/).length;
    const start = clampLine(raw.startLine, lines);
    const end = Math.max(start, clampLine(raw.endLine ?? start, lines));
    const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
    const evidence: Evidence[] = [];
    for (const item of rawEvidence.slice(0, 4)) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      const eFile = typeof e.file === 'string' ? e.file.replace(/^\.\//, '') : file;
      const eContent = input.repoFiles.get(eFile) ?? input.changedContents.get(eFile) ?? null;
      if (!eFile || eContent === null) continue;
      const quote = typeof e.quote === 'string' ? e.quote : '';
      const located = quote ? locateQuote(eContent, quote) : null;
      if (!located) continue;
      evidence.push({
        kind: eFile === file ? 'code' : 'diff',
        file: eFile,
        line: located,
        snippet: quote.split(/\r?\n/).slice(0, 4).join('\n').slice(0, 500),
        note: typeof e.note === 'string' && e.note ? e.note.slice(0, 240) : 'Quoted from the repository.',
        source: 'ai',
      });
    }
    if (evidence.length === 0) {
      reject(`no verifiable evidence for "${title.slice(0, 50)}"`);
      return null;
    }
    const severity = (SEVERITIES.has(String(raw.severity)) ? raw.severity : 'medium') as Severity;
    const category = (CATEGORIES.has(String(raw.category)) ? raw.category : 'correctness') as FindingCategory;
    const kind = (KINDS.has(String(raw.kind)) ? raw.kind : 'risk') as FindingKind;
    const confidence = (CONFIDENCES.has(String(raw.confidence)) ? raw.confidence : 'medium') as Finding['confidence'];

    return {
      id: stableId('ai', file, start, title),
      title: title.slice(0, 120),
      description: description.slice(0, 1400),
      severity,
      category,
      kind,
      confidence,
      file,
      range: { start, end },
      evidence,
      whyItMatters: (typeof raw.whyItMatters === 'string' ? raw.whyItMatters : description).slice(0, 800),
      consequences: stringArray(raw.consequences, 5),
      ...(typeof raw.reproduction === 'string' && raw.reproduction.trim() ? { reproduction: raw.reproduction.slice(0, 600) } : {}),
      recommendation: recommendation.slice(0, 800),
      ruleId: 'ai-review',
      source: 'ai',
      tags: stringArray(raw.tags, 6),
      validated: true,
    };
  }

  /**
   * Generate fix options on demand (used by "Generate fix" in the report and
   * by the extension's fix workflow). Patches are validated against the
   * current working tree; proposals that do not apply are discarded.
   */
  async generateFixesFor(input: {
    report: ReviewReport;
    repoFiles: Map<string, string>;
    changedContents: Map<string, string>;
    root: string;
    findings?: Finding[];
    signal?: AbortSignal;
  }): Promise<{ fixes: FixSolution[]; failures: string[]; usage: Usage }> {
    const usage: Usage = { promptTokens: 0, completionTokens: 0 };
    const findings = input.findings ?? input.report.findings;
    const result = await this.generateFixOptions(
      { ...input, settings: input.report.settings } as EnrichmentInput,
      findings,
      (u) => { usage.promptTokens += u.promptTokens; usage.completionTokens += u.completionTokens; },
      input.signal,
    );
    return { ...result, usage };
  }

  private async generateFixOptions(
    input: Pick<EnrichmentInput, 'report' | 'repoFiles' | 'changedContents' | 'root'>,
    allFindings: Finding[],
    onUsage: (u: Usage & { redactions: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ fixes: FixSolution[]; failures: string[] }> {
    const actionable = allFindings
      .filter((f) => f.kind !== 'question' && f.severity !== 'info')
      .filter((f) => ['critical', 'high', 'medium'].includes(f.severity))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      .slice(0, this.maxFixFindings);
    if (actionable.length === 0) return { fixes: [], failures: [] };

    const contents: Record<string, string> = {};
    for (const f of actionable) {
      for (const file of [f.file, ...f.evidence.map((e) => e.file).filter((x): x is string => Boolean(x))]) {
        const content = input.changedContents.get(file) ?? input.repoFiles.get(file);
        if (content && !contents[file]) contents[file] = content;
      }
    }
    const context = buildContextPack(input.report, input.repoFiles, { maxChars: 16_000, includeCode: false });
    const userPrompt = fixUserPrompt({ contextPack: context.text, findings: actionable, contents });
    const redacted = redactSecrets(userPrompt);
    onUsage({ promptTokens: 0, completionTokens: 0, redactions: redacted.redactions });

    const provider = this.fixProvider ?? this.provider;
    let result = await provider.complete({
      messages: [
        { role: 'system', content: FIX_SYSTEM },
        { role: 'user', content: redacted.text },
      ],
      json: true,
      maxTokens: 12_000,
      ...(signal ? { signal } : {}),
    });
    onUsage({ promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, redactions: 0 });

    let parsed = parseJsonLoose<{ solutions?: RawSolution[] }>(result.text);
    if (!parsed.ok || !parsed.value) {
      const salvaged = salvageJson<{ solutions?: RawSolution[] }>(result.text);
      if (salvaged) parsed = { ok: true, value: salvaged, recovered: 'repaired' };
    }
    if (!parsed.ok || !parsed.value) {
      result = await provider.complete({
        messages: [
          { role: 'system', content: FIX_SYSTEM },
          { role: 'user', content: `${redacted.text}\n\nIMPORTANT: the previous answer was cut off. Return at most 2 solutions with compact diffs and strictly valid JSON.` },
        ],
        json: true,
        maxTokens: 24_000,
        ...(signal ? { signal } : {}),
      });
      onUsage({ promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, redactions: 0 });
      parsed = parseJsonLoose<{ solutions?: RawSolution[] }>(result.text);
      if (!parsed.ok || !parsed.value) {
        const salvaged = salvageJson<{ solutions?: RawSolution[] }>(result.text);
        if (salvaged) parsed = { ok: true, value: salvaged, recovered: 'repaired' };
      }
    }
    if (!parsed.ok || !parsed.value) {
      return { fixes: [], failures: [parsed.error ?? 'Fix response could not be parsed'] };
    }
    const failures: string[] = [];
    const rejected: string[] = [];
    const solutions = Array.isArray(parsed.value.solutions) ? parsed.value.solutions : [];
    const fixes: FixSolution[] = [];
    for (const raw of solutions) {
      const findingId = typeof raw.findingId === 'string' ? raw.findingId : '';
      const finding = actionable.find((f) => f.id === findingId);
      if (!finding) {
        rejected.push(`fix ignored: unknown finding ${findingId || '(empty)'}`);
        continue;
      }
      const diff = typeof raw.diff === 'string' ? raw.diff : '';
      const label = typeof raw.label === 'string' ? raw.label : '';
      if (!diff.includes('@@') || !label) {
        rejected.push(`fix ignored for ${findingId}: missing diff or label`);
        continue;
      }
      const validation = await validatePatch(input.root, diff);
      if (!validation.applies) {
        rejected.push(`fix rejected for ${findingId}: ${validation.reason ?? 'patch does not apply'}`);
        continue;
      }
      const files = validation.files;
      const destructive = files.some((f) => /(^|\/)(migrations?|\.env|Dockerfile|\.github\/workflows)\b/i.test(f))
        || /deleted file mode|DROP\s+TABLE|DROP\s+COLUMN/i.test(diff);
      fixes.push({
        id: stableId('fix', finding.id, label),
        findingId: finding.id,
        label: label.slice(0, 120),
        approach: (typeof raw.approach === 'string' ? raw.approach : 'Proposed change').slice(0, 160),
        description: (typeof raw.description === 'string' ? raw.description : '').slice(0, 1600),
        filesAffected: files,
        advantages: stringArray(raw.advantages, 6),
        disadvantages: stringArray(raw.disadvantages, 6),
        performance: (typeof raw.performance === 'string' ? raw.performance : 'Not assessed by the model.').slice(0, 500),
        sideEffects: stringArray(raw.sideEffects, 6),
        complexity: (['low', 'medium', 'high'].includes(String(raw.complexity)) ? raw.complexity : 'medium') as FixSolution['complexity'],
        testing: stringArray(raw.testing, 6),
        compatibility: (typeof raw.compatibility === 'string' ? raw.compatibility : 'No compatibility note supplied.').slice(0, 500),
        patch: {
          diff,
          files,
          validation: { applies: true, ...(validation.fuzz !== undefined ? { fuzz: validation.fuzz } : {}) },
          destructive,
        },
        source: 'ai',
      });
    }
    // Keep at most three options per finding and prefer label diversity.
    const byFinding = new Map<string, FixSolution[]>();
    for (const fix of fixes) {
      const list = byFinding.get(fix.findingId) ?? [];
      if (list.length < 3) list.push(fix);
      byFinding.set(fix.findingId, list);
    }
    if (rejected.length) {
      // Not a failure: validation rejected proposals that do not apply. The
      // report shows only validated patches, which is the correct behaviour.
      this.log(input as EnrichmentInput, `${rejected.length} proposed patch(es) discarded (first: ${rejected[0]})`);
    }
    return { fixes: [...byFinding.values()].flat(), failures: [] };
  }
}
