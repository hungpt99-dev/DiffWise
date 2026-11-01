import { buildChangeFirstContext } from '@diffwise/core';
import type { ChatTurn, Citation, Finding, ReviewReport } from '@diffwise/core';
import { CHAT_SYSTEM, chatUserPrompt } from './prompts';
import { clampLine, parseJsonLoose, stringArray } from './json';
import type { LlmProvider, Usage } from './types';

export interface ChatOptions {
  /** Allow sending related repository files, not only the diff. */
  sendRepositoryContent?: boolean;
  /** @deprecated character budget retained for compatibility. */
  maxChars?: number;
  /** Input token budget when the provider advertises no context window. */
  maxInputTokens?: number;
  /** Opt in to full related-file content (T3); off by default. */
  includeDeep?: boolean;
}

export interface AskOptions {
  findingId?: string;
  selection?: { file: string; startLine: number; endLine: number; text: string };
  history?: ChatTurn[];
  signal?: AbortSignal;
}

export interface ChatAnswer {
  answer: string;
  citations: Citation[];
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
  suggestedQuestions: string[];
  invalidCitations: number;
  usage: Usage;
  model: string;
}

interface RawCitation { file?: unknown; line?: unknown; endLine?: unknown; note?: unknown }

/**
 * Report-aware discussion.
 *
 * The chat is not a general assistant: it receives the current report, the
 * selected finding, optional selected code and the conversation history, and
 * every citation it returns is checked against the repository before it is
 * shown. A citation that does not resolve is dropped and counted.
 */
export class ReportChat {
  constructor(
    private readonly provider: LlmProvider,
    private readonly report: ReviewReport,
    private readonly repoFiles: Map<string, string>,
    private readonly options: ChatOptions = {},
  ) {}

  async ask(question: string, opts: AskOptions = {}): Promise<ChatAnswer> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error('Ask a question first.');
    const focus = opts.findingId ? this.report.findings.find((f) => f.id === opts.findingId) : undefined;
    const includeCode = this.options.sendRepositoryContent ?? this.report.settings.sendRepositoryContent;
    // Change-first context: the report and the finding are always present, the
    // conversation is bounded, and code is included only around the change.
    const pack = buildChangeFirstContext(this.report, this.repoFiles, {
      includeCode,
      model: this.provider.model,
      ...(this.provider.capabilities.maxContextTokens
        ? { contextLimit: this.provider.capabilities.maxContextTokens, reservedOutput: 2_000 }
        : { inputLimit: this.options.maxInputTokens ?? 10_000 }),
      ...(focus ? { focusFinding: focus } : {}),
      ...(this.options.includeDeep ? { includeDeep: true } : {}),
    });

    const result = await this.provider.complete({
      messages: [
        { role: 'system', content: CHAT_SYSTEM },
        {
          role: 'user',
          content: chatUserPrompt({
            question: trimmed,
            contextPack: pack.text,
            ...(focus ? { focus: focus, focusDetail: this.findingDetail(focus) } : {}),
            ...(opts.selection ? { selection: opts.selection } : {}),
            history: opts.history ?? [],
            appliedFixes: this.report.appliedFixes.map((a) => `${a.files.join(', ')} (${a.solutionId})`),
          }),
        },
      ],
      json: true,
      task: 'chat',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    const parsed = parseJsonLoose<{
      answer?: unknown;
      citations?: unknown;
      confidence?: unknown;
      caveats?: unknown;
      suggestedQuestions?: unknown;
    }>(result.text);
    if (!parsed.ok || !parsed.value) {
      throw new Error(parsed.error ?? 'The model response could not be parsed.');
    }
    const answer = typeof parsed.value.answer === 'string' ? parsed.value.answer.trim() : '';
    if (!answer) throw new Error('The model returned an empty answer.');

    const { citations, invalid } = this.validateCitations(
      Array.isArray(parsed.value.citations) ? (parsed.value.citations as RawCitation[]) : [],
    );
    const confidence = (['high', 'medium', 'low'].includes(String(parsed.value.confidence))
      ? parsed.value.confidence
      : 'medium') as ChatAnswer['confidence'];
    const caveats = stringArray(parsed.value.caveats, 5);
    if (invalid > 0) caveats.push(`${invalid} citation(s) from the model did not resolve to a repository line and were removed.`);
    if (citations.length === 0) caveats.push('No citation could be verified against the repository; treat this answer as unverified interpretation.');

    return {
      answer,
      citations,
      confidence: citations.length === 0 ? 'low' : confidence,
      caveats,
      suggestedQuestions: stringArray(parsed.value.suggestedQuestions, 4),
      invalidCitations: invalid,
      usage: result.usage,
      model: result.model,
    };
  }

  private findingDetail(finding: Finding): string {
    return [
      `why: ${finding.whyItMatters}`,
      `recommendation: ${finding.recommendation}`,
      ...finding.evidence.slice(0, 3).map((e) => `evidence ${e.file ?? ''}${e.line ? `:${e.line}` : ''} — ${e.note}\n${e.snippet ?? ''}`),
      ...this.report.fixes.filter((f) => f.findingId === finding.id).map((f) => `proposed solution: ${f.label} (${f.id})${f.patch?.validation.applies ? ' [patch applies]' : ''}`),
    ].join('\n');
  }

  private validateCitations(raw: RawCitation[]): { citations: Citation[]; invalid: number } {
    const citations: Citation[] = [];
    let invalid = 0;
    for (const item of raw.slice(0, 8)) {
      const file = typeof item.file === 'string' ? item.file.replace(/^\.\//, '') : '';
      const content = file ? this.repoFiles.get(file) : undefined;
      if (!file || content === undefined) {
        invalid += 1;
        continue;
      }
      const lines = content.split(/\r?\n/).length;
      const line = item.line === undefined ? undefined : clampLine(item.line, lines);
      const endLine = item.endLine === undefined ? undefined : clampLine(item.endLine, lines);
      citations.push({
        file,
        ...(line !== undefined ? { line } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        valid: true,
        ...(typeof item.note === 'string' ? { note: item.note.slice(0, 240) } : {}),
      });
    }
    // Deduplicate identical citations.
    const seen = new Set<string>();
    return {
      citations: citations.filter((c) => {
        const key = `${c.file}:${c.line ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      invalid,
    };
  }
}

/** Lightweight connectivity check used by the settings UI. */
export async function testProvider(provider: LlmProvider): Promise<{ ok: boolean; message: string; latencyMs: number; model: string }> {
  const result = await provider.ping();
  return { ok: result.ok, message: result.message, latencyMs: result.latencyMs, model: result.model };
}
