/**
 * Tolerant JSON extraction for model output.
 *
 * Models wrap JSON in fences, prepend a sentence, or emit trailing commas.
 * Instead of failing the whole review we locate the first balanced object or
 * array and parse that. If it still fails, the caller receives a precise error
 * rather than a silent empty result.
 */

export interface JsonParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  /** How the payload had to be recovered, for the report's audit trail. */
  recovered: 'clean' | 'fenced' | 'substring' | 'repaired' | 'none';
}

function stripFences(text: string): { text: string; fenced: boolean } {
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fence?.[1]) return { text: fence[1].trim(), fenced: true };
  return { text: text.trim(), fenced: false };
}

function findBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function repair(json: string): string {
  return json
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

export function parseJsonLoose<T = unknown>(text: string): JsonParseResult<T> {
  const attempts: Array<{ candidate: string; recovered: JsonParseResult<T>['recovered'] }> = [];
  const stripped = stripFences(text);
  attempts.push({ candidate: stripped.text, recovered: stripped.fenced ? 'fenced' : 'clean' });
  const obj = findBalanced(stripped.text, '{', '}');
  const arr = findBalanced(stripped.text, '[', ']');
  if (obj) attempts.push({ candidate: obj, recovered: 'substring' });
  if (arr) attempts.push({ candidate: arr, recovered: 'substring' });

  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt.candidate) as T;
      return { ok: true, value, recovered: attempt.recovered };
    } catch {
      try {
        const value = JSON.parse(repair(attempt.candidate)) as T;
        return { ok: true, value, recovered: 'repaired' };
      } catch {
        // continue
      }
    }
  }
  return { ok: false, error: `Model output was not valid JSON (${text.slice(0, 160).replace(/\n/g, ' ')}…)`, recovered: 'none' };
}

/**
 * Recover the longest valid JSON prefix from a truncated response.
 *
 * Reasoning models can hit max_tokens mid-object. Rather than discarding the
 * whole answer, we cut at the last complete value and close the open containers.
 * The caller must report that the payload was recovered from a truncated answer.
 */
export function salvageJson<T = unknown>(text: string): T | null {
  const stripped = stripFences(text).text;
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  const body = stripped.slice(start);
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') closers.push('}');
    else if (c === '[') closers.push(']');
    else if (c === '}' || c === ']') closers.pop();
  }
  // Cut back to the last complete value, then close whatever is still open.
  for (let end = body.length; end > 0; end--) {
    const ch = body[end - 1]!;
    if (ch !== '}' && ch !== ']') continue;
    const candidate = body.slice(0, end);
    const stack: string[] = [];
    let inStr = false;
    let esc = false;
    for (const c of candidate) {
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') stack.push('}');
      else if (c === '[') stack.push(']');
      else if (c === '}' || c === ']') stack.pop();
    }
    const repaired = candidate + stack.reverse().join('');
    try {
      return JSON.parse(repaired) as T;
    } catch {
      // keep trimming
    }
  }
  return null;
}

/** Coerce a model value into a string array without throwing. */
export function stringArray(value: unknown, max = 8): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' ? [value] : [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()).slice(0, max);
}

/** Clamp a 1-based line number into an existing file. */
export function clampLine(value: unknown, lineCount: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, n), Math.max(1, lineCount));
}
