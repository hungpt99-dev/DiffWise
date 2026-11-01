import { createHash } from 'node:crypto';

/** Stable, short identifier used for findings and symbols across runs. */
export function stableId(prefix: string, ...parts: Array<string | number | undefined>): string {
  const h = createHash('sha1');
  h.update(prefix);
  for (const p of parts) {
    h.update('\u0000');
    h.update(String(p ?? ''));
  }
  return `${prefix}-${h.digest('hex').slice(0, 10)}`;
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Similarity in [0,1] based on token overlap (Jaccard). Cheap and explainable. */
export function similarity(a: string, b: string): number {
  const ta = new Set(normalizeWhitespace(a.toLowerCase()).split(' ').filter(Boolean));
  const tb = new Set(normalizeWhitespace(b.toLowerCase()).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Locate a quoted excerpt in a file and return its 1-based line.
 *
 * Quotes come from models and from rule authors, so matching is deliberately
 * tolerant of whitespace but strict about content: a quote either appears in
 * the file or it does not. This is the primitive every evidence validator uses,
 * which is why it lives in core rather than next to one producer.
 */
export function locateQuote(content: string, quote: string): number | null {
  const lines = content.split(/\r\n|\n|\r/);
  const target = normalizeWhitespace(quote);
  if (target.length < 3) return null;
  const single = lines.findIndex((l) => normalizeWhitespace(l) === target);
  if (single >= 0) return single + 1;
  if (target.length >= 8) {
    const contains = lines.findIndex((l) => normalizeWhitespace(l).includes(target));
    if (contains >= 0) return contains + 1;
  }
  const joined = normalizeWhitespace(content);
  if (target.length >= 12 && joined.includes(target)) {
    // Anchor on the longest line of the quote; a short first line (a bare `*/`)
    // makes a poor probe for locating the block.
    const quoteLines = quote.split(/\r\n|\n|\r/).map((l) => normalizeWhitespace(l)).filter((l) => l.length >= 4);
    const anchor = quoteLines.reduce((best, line) => (line.length > best.length ? line : best), '');
    const probe = anchor.slice(0, 24);
    if (probe.length >= 4) {
      const idx = lines.findIndex((l) => normalizeWhitespace(l).includes(probe));
      if (idx >= 0) return idx + 1;
    }
  }
  return null;
}
