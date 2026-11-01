/**
 * Generic specialised reviewer agent.
 *
 * One implementation, eight specifications. The agent builds a scoped prompt,
 * makes exactly one model call (plus one corrective retry when the response is
 * unusable), and returns *proposals*. It does not validate evidence: that is the
 * orchestrator's job and must stay out of the model's reach.
 */
import type { ReviewerAgent, ReviewerAgentInput, ReviewerAgentResult, ReviewerProposal, ReviewerSpec } from '@diffwise/core';
import { ProviderError } from '../types';
import type { LlmProvider } from '../types';
import { clampLine, parseJsonLoose, salvageJson, stringArray } from '../json';
import { reviewerSystemPrompt, reviewerUserPrompt } from './prompts';

interface RawEvidence { file?: unknown; quote?: unknown; note?: unknown }
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

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const CATEGORIES = new Set([
  'correctness', 'security', 'performance', 'reliability', 'concurrency', 'database', 'api-contract',
  'maintainability', 'architecture', 'tests', 'documentation', 'error-handling', 'resources', 'configuration',
]);
const KINDS = new Set(['problem', 'risk', 'recommendation', 'question']);
const CONFIDENCES = new Set(['verified', 'high', 'medium', 'low']);

export interface ReviewerAgentOptions {
  /** Model used for this reviewer; falls back to the provider's model. */
  model?: string;
  /** Extra instruction appended after the skill, e.g. a repository convention. */
  extraInstructions?: string;
}

export class SpecialisedReviewer implements ReviewerAgent {
  constructor(
    readonly spec: ReviewerSpec,
    private readonly provider: LlmProvider,
    private readonly options: ReviewerAgentOptions = {},
  ) {}

  async run(input: ReviewerAgentInput): Promise<ReviewerAgentResult> {
    const system = reviewerSystemPrompt(input.spec, input.scope.skill);
    const user = reviewerUserPrompt({
      spec: input.spec,
      scope: input.scope,
      changeSummary: `${input.scope.files.length} changed file(s); diff ${input.scope.diff.split(/\r?\n/).length} lines.`,
      changedFiles: input.scope.files.map((f) => f.path),
    });
    const messages = [
      { role: 'system' as const, content: this.options.extraInstructions ? `${system}\n\nRepository conventions:\n${this.options.extraInstructions}` : system },
      { role: 'user' as const, content: user },
    ];

    let promptTokens = 0;
    let completionTokens = 0;
    const call = async (maxTokens: number): Promise<string> => {
      const result = await this.provider.complete({
        messages,
        json: true,
        maxTokens,
        temperature: 0.1,
        task: 'review',
        ...(input.signal ? { signal: input.signal } : {}),
      });
      promptTokens += result.usage.promptTokens;
      completionTokens += result.usage.completionTokens;
      return result.text;
    };

    try {
      let text = await call(input.spec.budget.maxTokens);
      let parsed = parseJsonLoose<{ findings?: RawFinding[] }>(text);
      let warning: string | undefined;
      if (!parsed.ok || !parsed.value) {
        const salvaged = salvageJson<{ findings?: RawFinding[] }>(text);
        if (salvaged) {
          parsed = { ok: true, value: salvaged, recovered: 'repaired' };
          warning = 'the model response was truncated; only complete findings were used';
        }
      }
      if (!parsed.ok || !parsed.value) {
        text = await call(Math.min(input.spec.budget.maxTokens * 2, 24_000));
        parsed = parseJsonLoose<{ findings?: RawFinding[] }>(text);
        if (!parsed.ok || !parsed.value) {
          const salvaged = salvageJson<{ findings?: RawFinding[] }>(text);
          if (salvaged) {
            parsed = { ok: true, value: salvaged, recovered: 'repaired' };
            warning = 'the model response was truncated twice; only complete findings were used';
          }
        }
      }
      if (!parsed.ok || !parsed.value) {
        return {
          proposals: [],
          tokens: { prompt: promptTokens, completion: completionTokens },
          model: this.options.model ?? this.provider.model,
          provider: this.provider.id,
          warning: parsed.error ?? 'the model response was not valid JSON',
        };
      }
      const raw = Array.isArray(parsed.value.findings) ? parsed.value.findings : [];
      const proposals = raw.slice(0, input.spec.budget.maxFindings * 2).flatMap((f) => {
        const proposal = this.toProposal(f, input);
        return proposal ? [proposal] : [];
      });
      return {
        proposals,
        tokens: { prompt: promptTokens, completion: completionTokens },
        model: this.options.model ?? this.provider.model,
        provider: this.provider.id,
        ...(warning ? { warning } : {}),
      };
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : err instanceof Error ? err.message : String(err);
      return {
        proposals: [],
        tokens: { prompt: promptTokens, completion: completionTokens },
        model: this.options.model ?? this.provider.model,
        provider: this.provider.id,
        warning: err instanceof Error && err.name === 'AbortError' ? 'reviewer cancelled' : `provider error: ${message}`,
      };
    }
  }

  private toProposal(raw: RawFinding, input: ReviewerAgentInput): ReviewerProposal | null {
    const file = typeof raw.file === 'string' ? raw.file.replace(/^\.\//, '') : '';
    const known = input.scope.files.find((f) => f.path === file)
      ?? input.scope.related.find((f) => f.path === file);
    if (!file || !known) return null;
    const lineCount = known.content.split(/\r?\n/).length;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    const recommendation = typeof raw.recommendation === 'string' ? raw.recommendation.trim() : '';
    if (title.length < 8 || description.length < 20 || recommendation.length < 8) return null;
    const start = clampLine(raw.startLine, lineCount);
    const end = Math.max(start, clampLine(raw.endLine ?? start, lineCount));
    const evidenceRaw = Array.isArray(raw.evidence) ? raw.evidence : [];
    const evidence = evidenceRaw.slice(0, 4).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const e = item as RawEvidence;
      const quote = typeof e.quote === 'string' ? e.quote : '';
      if (quote.trim().length < 3) return [];
      return [{
        ...(typeof e.file === 'string' ? { file: e.file.replace(/^\.\//, '') } : {}),
        quote,
        ...(typeof e.note === 'string' ? { note: e.note.slice(0, 240) } : {}),
      }];
    });

    return {
      title: title.slice(0, 140),
      description: description.slice(0, 1600),
      severity: (SEVERITIES.has(String(raw.severity)) ? raw.severity : 'medium') as ReviewerProposal['severity'],
      category: (CATEGORIES.has(String(raw.category)) ? raw.category : 'correctness') as ReviewerProposal['category'],
      kind: (KINDS.has(String(raw.kind)) ? raw.kind : 'risk') as ReviewerProposal['kind'],
      confidence: (CONFIDENCES.has(String(raw.confidence)) ? raw.confidence : 'medium') as ReviewerProposal['confidence'],
      file,
      startLine: start,
      endLine: end,
      evidence,
      ...(typeof raw.whyItMatters === 'string' ? { whyItMatters: raw.whyItMatters.slice(0, 900) } : {}),
      consequences: stringArray(raw.consequences, 5),
      ...(typeof raw.reproduction === 'string' && raw.reproduction.trim() ? { reproduction: raw.reproduction.slice(0, 700) } : {}),
      recommendation: recommendation.slice(0, 900),
      tags: stringArray(raw.tags, 6),
    };
  }
}

/** Build one agent per selected reviewer. */
export function createReviewerAgents(
  specs: ReviewerSpec[],
  provider: LlmProvider,
  options: { models?: Partial<Record<string, string>>; extraInstructions?: string } = {},
): ReviewerAgent[] {
  return specs.map((spec) => new SpecialisedReviewer(spec, provider, {
    ...(options.models?.[spec.id] ? { model: options.models[spec.id] as string } : {}),
    ...(options.extraInstructions ? { extraInstructions: options.extraInstructions } : {}),
  }));
}
