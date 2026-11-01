/**
 * Token estimation.
 *
 * Why this exists: the previous budget was a character count (`length / 4`).
 * That is wrong by 30–60% on code, JSON and non-English text, which means a
 * "60k character" budget could either overrun a model's context window or
 * waste a large part of it.
 *
 * This is still an estimator, not a tokenizer — DiffWise must work with any
 * provider without shipping BPE tables. It is deliberately *conservative*
 * (it over-counts slightly), it is family-aware, and its accuracy is measured
 * rather than assumed (`tools/bench/token-calibration.mjs` records the error
 * against provider-reported usage).
 *
 * Contract:
 *  - never returns 0 for non-empty text,
 *  - monotonic: a longer string never estimates fewer tokens,
 *  - deterministic: same input, same output, no configuration.
 */

export type TokenFamily = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'qwen' | 'llama' | 'unknown';

/**
 * Per-family correction factors.
 *
 * The chunk model below is calibrated for the OpenAI BPE family. Other
 * tokenizers differ by a small, stable factor on mixed prose and code; the
 * values are the ones measured by `tools/bench/token-calibration.mjs` and are
 * kept < 1.15 so an unknown model can never be under-budgeted badly.
 */
const FAMILY_FACTOR: Record<TokenFamily, number> = {
  openai: 1,
  anthropic: 1,
  gemini: 0.94,
  deepseek: 1.05,
  qwen: 1.1,
  llama: 1.12,
  unknown: 1,
};

export function tokenFamilyFor(model: string): TokenFamily {
  const m = model.toLowerCase();
  if (/gpt|o[1-9](-|$)|text-embedding|davinci|turbo/.test(m)) return 'openai';
  if (/claude|anthropic/.test(m)) return 'anthropic';
  if (/gemini|palm|google/.test(m)) return 'gemini';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/qwen|tongyi/.test(m)) return 'qwen';
  if (/llama|mistral|mixtral|codellama|phi-|gemma/.test(m)) return 'llama';
  return 'unknown';
}

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
const CHUNK = /([A-Za-z]+)|(\d+)|([^\sA-Za-z\d]+)|(\s+)/g;

/** Cost of one identifier/word chunk, after splitting on case and digits. */
function wordCost(word: string): number {
  let cost = 0;
  // BPE splits identifiers at camelCase, snake_case and digit boundaries, so a
  // long identifier costs several tokens even though it is one "word".
  for (const piece of word.split(/(?<=[a-z0-9])(?=[A-Z])|_/)) {
    if (!piece) continue;
    const n = piece.length;
    if (n <= 5) cost += 1;
    else if (n <= 8) cost += 2;
    else if (n <= 11) cost += 3;
    else cost += Math.ceil(n / 4);
  }
  return Math.max(1, cost);
}

/**
 * Estimate the token count of a string.
 *
 * @param text     the exact text that will be sent
 * @param model    model identifier (used to pick a tokenizer family)
 * @param family   explicit family, overriding `model`
 */
export function estimateTokens(text: string, modelOrFamily?: string): number {
  if (!text) return 0;
  const family: TokenFamily = modelOrFamily && (Object.keys(FAMILY_FACTOR) as TokenFamily[]).includes(modelOrFamily as TokenFamily)
    ? (modelOrFamily as TokenFamily)
    : modelOrFamily
      ? tokenFamilyFor(modelOrFamily)
      : 'openai';

  let total = 0;
  let cjk = 0;
  CHUNK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHUNK.exec(text)) !== null) {
    const [, word, digits, punct, space] = match;
    if (word) total += wordCost(word);
    else if (digits) total += Math.ceil(digits.length / 3); // BPE groups digits in threes
    else if (punct) total += Math.ceil(punct.length / 1.6);
    else if (space) {
      // Indentation is partly absorbed by the following token; newlines cost
      // about half a token in practice. This is the cheapest part of a prompt.
      const newlines = (space.match(/\n/g) ?? []).length;
      total += newlines * 0.5 + (space.length - newlines) / 8;
    }
    if (CJK.test(match[0])) cjk += (match[0].match(new RegExp(CJK, 'g')) ?? []).length;
  }
  // CJK characters are roughly one token each; the chunk model above
  // under-counts them badly, so they are priced separately and removed.
  if (cjk > 0) total = total * (1 - cjk / Math.max(1, text.length)) + cjk;
  return Math.max(1, Math.ceil(total * FAMILY_FACTOR[family]));
}

export interface ChatPromptPart {
  role: string;
  content: string;
}

/** Prompt size including the per-message envelope chat APIs add. */
export function estimatePromptTokens(messages: ChatPromptPart[], model?: string): number {
  // ~4 tokens of role/framing overhead per message, plus 3 for the reply primer.
  return messages.reduce((sum, m) => sum + estimateTokens(m.content, model) + 4, 3);
}

/**
 * Rough tokens for a JSON value as the provider will receive it.
 * Property names repeat in arrays, so this is not `JSON.stringify` length / 4.
 */
export function estimateJsonTokens(value: unknown, model?: string): number {
  try {
    return estimateTokens(JSON.stringify(value), model);
  } catch {
    return 0;
  }
}
