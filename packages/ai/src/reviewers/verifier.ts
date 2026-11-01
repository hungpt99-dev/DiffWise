/**
 * Independent AI verifier.
 *
 * A verifier sees the claim, the file and what the deterministic checks
 * established — and nothing else. It does not see other verifiers' opinions, the
 * reviewer that produced the finding, or how severe the finding is (severity is
 * deliberately withheld so a "critical" label cannot bias the verdict).
 *
 * Its opinion is *evidence*, never authority: the core engine only lets a
 * verifier opinion reach LIKELY, never CONFIRMED.
 */
import type { Confidence, Evidence, VerifierOpinion } from '@diffwise/core';
import { VERIFIER_LENSES, verifierSystemPrompt, verifierUserPrompt } from './prompts';
import { parseJsonLoose, salvageJson } from '../json';
import { ProviderError, type LlmProvider } from '../types';

export interface VerifierInput {
  finding: {
    title: string;
    description: string;
    category: string;
    kind: string;
    file: string;
    range: { start: number; end: number };
    recommendation: string;
    evidence: Array<{ file?: string; line?: number; snippet?: string; note: string }>;
  };
  fileContent: string;
  deterministicChecks: Array<{ id: string; outcome: string; detail: string }>;
  lensIndex?: number;
  signal?: AbortSignal;
}

const VERDICTS = new Set(['confirmed', 'likely', 'uncertain', 'rejected']);
const CONFIDENCE = new Set(['verified', 'high', 'medium', 'low']);

export class AiVerifier {
  constructor(
    private readonly provider: LlmProvider,
    private readonly verifierId = 'ai-verifier',
    private readonly model?: string,
  ) {}

  /** One independent opinion, using a distinct verification lens. */
  async verify(input: VerifierInput): Promise<VerifierOpinion> {
    const lens = VERIFIER_LENSES[(input.lensIndex ?? 0) % VERIFIER_LENSES.length] as string;
    try {
      const result = await this.provider.complete({
        messages: [
          { role: 'system', content: verifierSystemPrompt() },
          {
            role: 'user',
            content: verifierUserPrompt({
              finding: input.finding,
              fileContent: input.fileContent,
              deterministicChecks: input.deterministicChecks,
              lens,
            }),
          },
        ],
        json: true,
        maxTokens: 2_500,
        temperature: 0,
        task: 'verify',
        ...(input.signal ? { signal: input.signal } : {}),
      });

      type VerifierRaw = { verdict?: unknown; confidence?: unknown; reasoning?: unknown; evidence?: unknown };
      let value: VerifierRaw | null = null;
      const parsed = parseJsonLoose<VerifierRaw>(result.text);
      if (parsed.ok && parsed.value) {
        value = parsed.value;
      } else {
        value = salvageJson<VerifierRaw>(result.text);
      }
      if (!value) return this.uncertain('the verifier response could not be parsed');
      const verdict = VERDICTS.has(String(value.verdict)) ? String(value.verdict) as VerifierOpinion['verdict'] : 'uncertain';
      const confidence = (CONFIDENCE.has(String(value.confidence)) ? String(value.confidence) : 'low') as Confidence;
      const reasoning = typeof value.reasoning === 'string' ? value.reasoning.trim().slice(0, 1200) : '';
      const evidence: Evidence[] = Array.isArray(value.evidence)
        ? value.evidence.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null).flatMap((e) => {
          const file = typeof e.file === 'string' ? e.file.replace(/^\.\//, '') : undefined;
          const quote = typeof e.quote === 'string' ? e.quote : undefined;
          if (!file || !quote) return [];
          return [{
            kind: 'code' as const,
            file,
            snippet: quote.slice(0, 400),
            note: typeof e.note === 'string' ? e.note.slice(0, 240) : 'Quoted by the verifier.',
            source: 'ai' as const,
          }];
        })
        : [];

      if (reasoning.length < 10) {
        return {
          verifierId: this.verifierId,
          kind: 'ai',
          verdict: 'uncertain',
          confidence: 'low',
          reasoning: reasoning || 'the verifier returned no reasoning',
          evidence,
          model: this.model ?? this.provider.model,
          provider: this.provider.id,
          discarded: 'verifier gave no reasoning, so the opinion carries no weight',
        };
      }

      return {
        verifierId: this.verifierId,
        kind: 'ai',
        verdict,
        confidence,
        reasoning,
        evidence,
        model: this.model ?? this.provider.model,
        provider: this.provider.id,
      };
    } catch (err: unknown) {
      const message = err instanceof ProviderError ? err.message : err instanceof Error ? err.message : String(err);
      return this.uncertain(`the verifier could not run: ${message}`);
    }
  }

  private uncertain(reason: string): VerifierOpinion {
    return {
      verifierId: this.verifierId,
      kind: 'ai',
      verdict: 'uncertain',
      confidence: 'low',
      reasoning: reason,
      evidence: [],
      model: this.model ?? this.provider.model,
      provider: this.provider.id,
      discarded: reason,
    };
  }
}

/**
 * Run N independent verifiers over the same finding.
 *
 * Independence here is procedural: separate calls, separate lenses, no shared
 * conversation. It is not model independence, and the report says so — which is
 * exactly why the engine refuses to treat agreement between them as proof.
 */
export async function verifyIndependently(
  provider: LlmProvider,
  input: VerifierInput,
  count: number,
  signal?: AbortSignal,
): Promise<VerifierOpinion[]> {
  const n = Math.max(1, Math.min(3, count));
  const verifiers = Array.from({ length: n }, (_, i) => new AiVerifier(provider, `ai-verifier-${i + 1}`));
  const settled = await Promise.allSettled(
    verifiers.map((verifier, index) => verifier.verify({ ...input, lensIndex: index, ...(signal ? { signal } : {}) })),
  );
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}
