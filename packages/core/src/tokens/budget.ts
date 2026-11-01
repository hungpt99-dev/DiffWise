/**
 * Token budgets and section packing.
 *
 * A budget is a small explicit contract instead of an implicit char limit:
 *
 *     context window − reserved output − safety margin = input budget
 *
 * Context is then assembled as labelled sections with priorities, and the
 * packer decides what survives. This keeps two properties the old
 * "concatenate until the string is too long, then stop" approach could not:
 *
 *  - the *first* section dropped is the least valuable one, not the last one
 *    written;
 *  - every cut is recorded, so the report can say what the model did not see.
 */
import { estimateTokens } from './estimate';

export interface TokenBudgetPlan {
  model?: string;
  /** Hard window advertised by the provider, when known. */
  contextLimit?: number;
  /** Explicit input budget; wins over `contextLimit`. */
  inputLimit?: number;
  /** Space kept free for the completion. */
  reservedOutput?: number;
  /** Fraction of the window held back as a guard against estimator error. */
  safetyMargin?: number;
}

export type BudgetSource = 'explicit' | 'derived' | 'default';

const DEFAULT_CONTEXT_LIMIT = 32_000;
const DEFAULT_RESERVED_OUTPUT = 4_000;
const DEFAULT_MARGIN = 0.08;

export class TokenBudget {
  readonly model?: string;
  readonly contextLimit: number;
  readonly reservedOutput: number;
  readonly safetyMargin: number;
  readonly inputLimit: number;
  readonly source: BudgetSource;

  constructor(plan: TokenBudgetPlan = {}) {
    this.model = plan.model;
    const contextLimit = Math.max(1_000, plan.contextLimit ?? DEFAULT_CONTEXT_LIMIT);
    const reservedOutput = Math.max(0, Math.min(plan.reservedOutput ?? DEFAULT_RESERVED_OUTPUT, contextLimit));
    const margin = Math.max(0, Math.min(plan.safetyMargin ?? DEFAULT_MARGIN, 0.5));
    this.contextLimit = contextLimit;
    this.reservedOutput = reservedOutput;
    this.safetyMargin = margin;

    if (plan.inputLimit !== undefined) {
      this.inputLimit = Math.max(256, Math.floor(plan.inputLimit));
      this.source = 'explicit';
      return;
    }
    const usable = Math.max(256, contextLimit - reservedOutput);
    const reserved = plan.reservedOutput ?? DEFAULT_RESERVED_OUTPUT;
    this.inputLimit = Math.max(256, Math.floor(usable * (1 - margin)));
    this.source = plan.contextLimit !== undefined || reserved > 0 ? 'derived' : 'default';
  }

  fits(tokens: number): boolean {
    return tokens <= this.inputLimit;
  }

  remaining(used: number): number {
    return Math.max(0, this.inputLimit - used);
  }

  /** Split the input budget proportionally, keeping the sum inside the limit. */
  allocate(shares: number[]): number[] {
    const total = shares.reduce((a, b) => a + Math.max(0, b), 0);
    if (total <= 0) return shares.map(() => 0);
    let assigned = 0;
    return shares.map((share) => {
      const value = Math.floor((Math.max(0, share) / total) * this.inputLimit);
      assigned += value;
      return value;
    }).map((value, i, all) => (i === all.length - 1 ? value + Math.max(0, this.inputLimit - assigned) : value));
  }

  describe(): string {
    return `${this.inputLimit} input tokens (window ${this.contextLimit}, ${this.reservedOutput} reserved for output, ${Math.round(this.safetyMargin * 100)}% margin, ${this.source})`;
  }
}

export interface PackableSection {
  id: string;
  /** 1 = essential change data, 2 = targeted context, 3 = deep investigation. */
  tier: 1 | 2 | 3;
  /** Higher survives first. */
  priority: number;
  text: string;
  /** Included even if it has to be clipped to fit. */
  required?: boolean;
  /** Per-section ceiling, independent of what is left in the budget. */
  maxTokens?: number;
}

export interface PackedSection {
  id: string;
  tier: 1 | 2 | 3;
  priority: number;
  text: string;
  tokens: number;
  clipped: boolean;
}

export interface PackResult {
  sections: PackedSection[];
  /** Sections that did not fit at all. */
  dropped: string[];
  /** Sections included with fewer tokens than requested. */
  clipped: string[];
  tokens: number;
  truncated: boolean;
  budget: TokenBudget;
}

export interface PackOptions {
  /** Below this many free tokens a section is dropped instead of clipped. */
  minSectionTokens?: number;
  /** Non-required sections clipped below this share of themselves are dropped. */
  minKeepRatio?: number;
  /** Text appended to a clipped section; also the marker in its report. */
  clipMarker?(omittedLines: number): string;
}

/** Clip text at a line boundary to approximately `maxTokens`. */
export function clipToTokens(text: string, maxTokens: number, opts: { model?: string; marker?: string } = {}): { text: string; tokens: number; clipped: boolean } {
  const full = estimateTokens(text, opts.model);
  if (full <= maxTokens) return { text, tokens: full, clipped: false };
  if (maxTokens <= 0) return { text: '', tokens: 0, clipped: true };
  const marker = opts.marker ?? '\n…[section truncated to fit the context budget]…';
  const lines = text.split('\n');
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = lines.slice(0, mid).join('\n') + marker;
    if (estimateTokens(candidate, opts.model) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) {
    // A single line longer than the whole budget: cut it by characters using
    // the same estimator, never mid-grapheme.
    const ratio = maxTokens / Math.max(1, full);
    const cut = text.slice(0, Math.max(1, Math.floor(text.length * ratio * 0.9))) + marker;
    return { text: cut, tokens: estimateTokens(cut, opts.model), clipped: true };
  }
  const out = lines.slice(0, lo).join('\n') + (lo < lines.length ? marker : '');
  return { text: out, tokens: estimateTokens(out, opts.model), clipped: true };
}

/**
 * Choose sections that fit the budget.
 *
 * Required sections are placed first (they are the change itself), then the
 * rest by descending priority. A section that does not fit whole is clipped
 * only if enough budget remains to be useful.
 */
export function packSections(sections: PackableSection[], budget: TokenBudget, opts: PackOptions = {}): PackResult {
  const model = budget.model;
  const minSection = opts.minSectionTokens ?? 160;
  /** A non-required section kept below this share of itself is noise, not context. */
  const minKeepRatio = opts.minKeepRatio ?? 0.5;
  const marker = opts.clipMarker ?? ((omitted: number) => `\n…[${omitted} line(s) omitted: context budget]…`);
  const packed: PackedSection[] = [];
  const dropped: string[] = [];
  const clipped: string[] = [];
  let used = 0;

  const place = (section: PackableSection): void => {
    const remaining = budget.remaining(used);
    const ceiling = section.maxTokens !== undefined ? Math.min(section.maxTokens, remaining) : remaining;
    const tokens = estimateTokens(section.text, model);
    if (tokens <= ceiling) {
      packed.push({ id: section.id, tier: section.tier, priority: section.priority, text: section.text, tokens, clipped: false });
      used += tokens;
      return;
    }
    const keepable = section.required || ceiling >= tokens * minKeepRatio;
    if (keepable && ceiling >= minSection) {
      const cut = clipToTokens(section.text, ceiling, { model, marker: marker(section.text.split('\n').length) });
      packed.push({ id: section.id, tier: section.tier, priority: section.priority, text: cut.text, tokens: cut.tokens, clipped: true });
      clipped.push(section.id);
      used += cut.tokens;
      return;
    }
    dropped.push(section.id);
  };

  for (const section of sections.filter((s) => s.required)) place(section);
  const rest = sections.filter((s) => !s.required).slice().sort((a, b) => b.priority - a.priority);
  for (const section of rest) place(section);

  // Stable order for the prompt: tier first, then priority, so the model reads
  // the change before the context that explains it.
  packed.sort((a, b) => a.tier - b.tier || b.priority - a.priority);
  return {
    sections: packed,
    dropped,
    clipped,
    tokens: packed.reduce((sum, s) => sum + s.tokens, 0),
    truncated: dropped.length > 0 || clipped.length > 0,
    budget,
  };
}
