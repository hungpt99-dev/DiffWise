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
