/**
 * Cost accounting.
 *
 * Deliberate design decision: DiffWise ships **no default price table**.
 * Published prices change, region and contract differ, and a wrong number in a
 * report is worse than no number. When the user configures prices, cost is
 * computed from provider-reported token usage and labelled as a list-price
 * estimate — never as an invoiced amount.
 */

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** Discounted rate for cached input, when the provider bills it separately. */
  cachedInputPerMTok?: number;
  /** Where the number came from, e.g. "contract 2026-Q4" or a URL. */
  source: string;
  asOf?: string;
}

export type PriceTable = Record<string, ModelPrice>;

export interface TokenUsageLike {
  prompt: number;
  completion: number;
  cachedPrompt?: number;
}

export interface CostEstimate {
  usd: number;
  /** Always estimated: DiffWise never sees an invoice. */
  estimated: true;
  basis: 'list-price';
  price: ModelPrice;
  breakdown: { input: number; cachedInput: number; output: number };
  caveat: string;
}

const CAVEAT = 'Estimated from provider-reported token counts and the list price configured for this model. Not an invoiced amount.';

/**
 * Resolve a price by exact model name, then by prefix wildcard (`deepseek-*`).
 * Longest pattern wins so `gpt-4o-mini-*` beats `gpt-*`.
 */
export function resolvePrice(model: string, table: PriceTable | undefined): ModelPrice | undefined {
  if (!table) return undefined;
  const exact = table[model];
  if (exact) return exact;
  const patterns = Object.keys(table)
    .filter((key) => key.endsWith('*'))
    .map((key) => ({ key, prefix: key.slice(0, -1) }))
    .filter(({ prefix }) => model.startsWith(prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const best = patterns[0];
  return best ? table[`${best.prefix}*`] : undefined;
}

export function computeCost(usage: TokenUsageLike, price: ModelPrice | undefined): CostEstimate | undefined {
  if (!price) return undefined;
  const cached = Math.min(usage.prompt, Math.max(0, usage.cachedPrompt ?? 0));
  const fresh = Math.max(0, usage.prompt - cached);
  const input = (fresh / 1_000_000) * price.inputPerMTok;
  const cachedInput = price.cachedInputPerMTok !== undefined
    ? (cached / 1_000_000) * price.cachedInputPerMTok
    : (cached / 1_000_000) * price.inputPerMTok;
  const output = (usage.completion / 1_000_000) * price.outputPerMTok;
  const usd = input + cachedInput + output;
  return {
    usd: Math.round(usd * 1e6) / 1e6,
    estimated: true,
    basis: 'list-price',
    price,
    breakdown: {
      input: Math.round(input * 1e6) / 1e6,
      cachedInput: Math.round(cachedInput * 1e6) / 1e6,
      output: Math.round(output * 1e6) / 1e6,
    },
    caveat: CAVEAT,
  };
}
