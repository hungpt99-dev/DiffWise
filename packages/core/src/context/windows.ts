/**
 * Code windows.
 *
 * A changed line rarely makes sense on its own, and a whole file is usually
 * mostly unrelated to the change. These helpers take the lines that actually
 * changed and return the smallest set of contiguous windows that give them
 * readable context — merged when they nearly touch, capped when a file has
 * many scattered edits.
 *
 * Everything is 1-based and inclusive, matching `LineRange` elsewhere.
 */

export interface CodeWindow {
  /** 1-based, inclusive. */
  start: number;
  end: number;
}

export interface WindowOptions {
  /** Lines of context kept on each side of a changed range. */
  radius?: number;
  /** Windows closer than this are merged into one. */
  mergeGap?: number;
  /** Never return more than this many windows. */
  maxWindows?: number;
  /** Never return more than this many lines in total. */
  maxLines?: number;
  /**
   * Prefix each line with its absolute number. Useful for a model that must
   * cite lines; harmful when its quotes are validated against the raw file.
   */
  numbered?: boolean;
}

/** Merge overlapping or near-touching ranges. Input order is preserved. */
export function mergeRanges(ranges: CodeWindow[], gap = 0): CodeWindow[] {
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start)
    .map((r) => ({ start: Math.max(1, Math.floor(r.start)), end: Math.max(1, Math.floor(r.end)) }))
    .sort((a, b) => a.start - b.start);
  const merged: CodeWindow[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + gap + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Expand ranges by `radius`, merge, then enforce the window and line caps. */
export function selectWindows(ranges: CodeWindow[], opts: WindowOptions = {}, lineCount?: number): { windows: CodeWindow[]; dropped: number } {
  const radius = Math.max(0, opts.radius ?? 12);
  const gap = Math.max(0, opts.mergeGap ?? 6);
  const maxWindows = Math.max(1, opts.maxWindows ?? 4);
  const maxLines = Math.max(1, opts.maxLines ?? 220);
  const expand = (r: CodeWindow): CodeWindow => ({
    start: Math.max(1, r.start - radius),
    end: lineCount ? Math.min(lineCount, r.end + radius) : r.end + radius,
  });
  const all = mergeRanges(ranges.map(expand), gap);
  const windows: CodeWindow[] = [];
  let used = 0;
  for (const window of all) {
    if (windows.length >= maxWindows) break;
    const size = window.end - window.start + 1;
    if (used + size > maxLines && windows.length > 0) continue;
    windows.push(window);
    used += size;
  }
  return { windows, dropped: Math.max(0, all.length - windows.length) };
}

export interface RenderedWindows {
  text: string;
  lines: number;
  /** Windows that were shown, after all caps. */
  shown: CodeWindow[];
  /** Windows that existed but were left out to stay inside the caps. */
  omitted: number;
}

/**
 * Render windows as numbered lines. Numbers are absolute so the model can cite
 * a real `file:line` and its quote can be located in the file afterwards.
 */
export function renderWindows(content: string, windows: CodeWindow[], opts: { header?: string; numbered?: boolean } = {}): RenderedWindows {
  const numbered = opts.numbered ?? true;
  const lines = content.split(/\r\n|\n|\r/);
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i]!;
    if (i > 0) parts.push('  …');
    if (opts.header) parts.push(opts.header);
    for (let n = window.start; n <= Math.min(window.end, lines.length); n++) {
      parts.push(numbered ? `${n}| ${lines[n - 1] ?? ''}` : (lines[n - 1] ?? ''));
      total += 1;
    }
  }
  return { text: parts.join('\n'), lines: total, shown: windows, omitted: 0 };
}

export interface CodeWindowResult extends RenderedWindows {
  /** Tokens of the rendered text, per the shared estimator. */
  chars: number;
}

/** Convenience: ranges + file content → rendered windows. */
export function codeWindows(content: string, ranges: CodeWindow[], opts: WindowOptions = {}): CodeWindowResult {
  const lineCount = content.split(/\r\n|\n|\r/).length;
  const { windows, dropped } = selectWindows(ranges, opts, lineCount);
  const rendered = renderWindows(content, windows, { numbered: opts.numbered ?? true });
  return { ...rendered, omitted: dropped, chars: rendered.text.length };
}
