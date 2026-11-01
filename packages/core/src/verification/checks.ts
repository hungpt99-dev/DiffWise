/**
 * Deterministic verification checks.
 *
 * These run without a model. They answer questions that can be answered from
 * the repository text: does the quoted evidence exist, is the cited line part of
 * this change, is the risky construct actually present, is there a covering test?
 *
 * Honesty about strength is encoded in `kind`:
 *   evidence   – the quote resolves (or does not resolve) in the file
 *   structural – a textual fact that demonstrates the claim (deleted route, DDL)
 *   heuristic  – a pattern near the line; useful, but never enough alone
 *
 * Only `evidence` + (`structural` | test | runtime | human) can produce
 * CONFIRMED. A `heuristic` can never do that.
 */
import type { Evidence } from '../types';
import { locateQuote } from '../util/text';
import type { FindingGroup } from './normalize';
import type { VerificationCheck, VerificationContext } from './types';

const WINDOW_BEFORE = 18;
const WINDOW_AFTER = 14;

function windowAround(content: string, start: number, end: number): { text: string; from: number; to: number } {
  const lines = content.split(/\r\n|\n|\r/);
  if (start > lines.length) return { text: '', from: start, to: start };
  const from = Math.max(1, start - WINDOW_BEFORE);
  const to = Math.min(lines.length, end + WINDOW_AFTER);
  return { text: lines.slice(from - 1, to).join('\n'), from, to };
}

function evidenceFor(file: string, line: number, snippet: string, note: string): Evidence {
  return { kind: 'code', file, line, snippet: snippet.slice(0, 400), note, source: 'deterministic' };
}

/** Check 0: the cited line exists in the file at all. */
function checkRangeExists(group: FindingGroup, ctx: VerificationContext): VerificationCheck {
  const content = ctx.files.get(group.file);
  if (content === undefined) {
    return {
      id: 'range.exists',
      description: 'The cited line exists in the file',
      kind: 'evidence',
      outcome: 'inconclusive',
      detail: `${group.file} was not read, so the cited line cannot be checked (see file.exists).`,
    };
  }
  const lineCount = content.split(/\r\n|\n|\r/).length;
  if (group.range.start > lineCount) {
    return {
      id: 'range.exists',
      description: 'The cited line exists in the file',
      kind: 'evidence',
      outcome: 'contradicts',
      detail: `The finding cites line ${group.range.start} but ${group.file} has only ${lineCount} lines, so the citation cannot be real.`,
    };
  }
  return {
    id: 'range.exists',
    description: 'The cited line exists in the file',
    kind: 'evidence',
    outcome: 'supports',
    detail: `Lines ${group.range.start}-${group.range.end} exist in ${group.file} (${lineCount} lines).`,
  };
}

/** Check 1: the file the finding points at exists in this review. */
function checkFileExists(group: FindingGroup, ctx: VerificationContext): VerificationCheck {
  const content = ctx.files.get(group.file);
  if (content !== undefined) {
    return {
      id: 'file.exists',
      description: `File ${group.file} exists in the reviewed tree`,
      kind: 'evidence',
      outcome: 'supports',
      detail: `${content.split(/\r\n|\n|\r/).length} lines read from ${group.file}.`,
    };
  }
  return {
    id: 'file.exists',
    description: `File ${group.file} exists in the reviewed tree`,
    kind: 'evidence',
    outcome: 'contradicts',
    detail: `${group.file} is not part of the reviewed tree, so the finding cannot be checked.`,
  };
}

/**
 * Normalise a producer's evidence snippet before matching.
 *
 * Rules record evidence in the format they found it: a diff line keeps its `+`
 * marker, a context block keeps `NNN: ` prefixes. The verification question is
 * "does this text exist in the file", not "did the producer format it the way I
 * would". Stripping the decoration is therefore correct; inventing content is not.
 */
export function cleanQuote(quote: string): string {
  let out = quote.trimEnd();
  // Diff markers: a removed line starts with `-`, an added line with `+`.
  if (/^[-+] /.test(out)) out = out.slice(2);
  else if (/^[-+]\S/.test(out)) out = out.slice(1);
  out = out.replace(/…$/, '');
  const lines = out.split(/\r?\n/);
  const numbered = lines.filter((l) => l.trim() !== '').every((l) => /^\s*\d+:\s?/.test(l));
  if (numbered && lines.length > 0) {
    out = lines.map((l) => l.replace(/^\s*\d+:\s?/, '')).join('\n');
  }
  return out;
}

/** Check 2: every quoted excerpt actually occurs in the repository. */
function checkEvidenceQuotes(group: FindingGroup, ctx: VerificationContext): VerificationCheck {
  const quoted = group.evidence.filter((e) => typeof e.snippet === 'string' && e.snippet.trim().length >= 3);
  if (quoted.length === 0) {
    return {
      id: 'evidence.quotes',
      description: 'Quoted evidence resolves in the repository',
      kind: 'evidence',
      outcome: 'inconclusive',
      detail: 'The finding carries no quotation, so its evidence cannot be checked against file content.',
    };
  }
  const resolved: Evidence[] = [];
  const missing: string[] = [];
  for (const item of quoted.slice(0, 8)) {
    const file = item.file ?? group.file;
    const content = ctx.files.get(file);
    if (content === undefined) { missing.push(`${file} (file absent)`); continue; }
    const snippet = cleanQuote(item.snippet as string);
    const line = locateQuote(content, snippet);
    if (line !== null) {
      resolved.push(evidenceFor(file, line, snippet, 'Verified: this text exists in the file.'));
      continue;
    }
    const previous = ctx.oldFiles?.get(file) ?? null;
    if (previous && locateQuote(previous, snippet) !== null) {
      resolved.push(evidenceFor(file, line ?? group.range.start, snippet, 'Verified: this text exists in the previous revision (this change removed or replaced it).'));
      continue;
    }
    missing.push(`${file} (quote not found in the current or previous revision)`);
  }
  if (resolved.length === 0) {
    return {
      id: 'evidence.quotes',
      description: 'Quoted evidence resolves in the repository',
      kind: 'evidence',
      outcome: 'contradicts',
      detail: `None of the ${quoted.length} quoted excerpt(s) occur in the repository: ${missing.slice(0, 3).join('; ')}.`,
    };
  }
  return {
    id: 'evidence.quotes',
    description: 'Quoted evidence resolves in the repository',
    kind: 'evidence',
    outcome: 'supports',
    detail: `${resolved.length}/${quoted.length} quoted excerpt(s) found${missing.length ? `; unresolved: ${missing.slice(0, 3).join('; ')}` : ''}.`,
    evidence: resolved,
  };
}

/** Check 3: is the cited range actually part of this change? */
function checkRangeIsChanged(group: FindingGroup, ctx: VerificationContext): VerificationCheck {
  const added = ctx.addedLines.get(group.file);
  if (!ctx.changedFiles.has(group.file)) {
    return {
      id: 'range.in-change',
      description: 'The cited lines are part of this change',
      kind: 'structural',
      outcome: 'contradicts',
      detail: `${group.file} is not changed by this review, so the finding is pre-existing rather than introduced.`,
    };
  }
  const content = ctx.files.get(group.file);
  if (content !== undefined) {
    const lineCount = content.split(/\r\n|\n|\r/).length;
    if (group.range.start > lineCount) {
      return {
        id: 'range.in-change',
        description: 'The cited lines are part of this change',
        kind: 'structural',
        outcome: 'inconclusive',
        detail: `The cited line ${group.range.start} is past the end of ${group.file} (${lineCount} lines); see range.exists.`,
      };
    }
  }
  if (!added || added.size === 0) {
    return {
      id: 'range.in-change',
      description: 'The cited lines are part of this change',
      kind: 'structural',
      outcome: 'inconclusive',
      detail: `${group.file} changed, but this review recorded no added lines (deletion-only change).`,
    };
  }
  const touched: number[] = [];
  for (let line = group.range.start; line <= group.range.end; line += 1) if (added.has(line)) touched.push(line);
  if (touched.length > 0) {
    return {
      id: 'range.in-change',
      description: 'The cited lines are part of this change',
      kind: 'structural',
      outcome: 'supports',
      detail: `Changed line(s) ${touched.slice(0, 6).join(', ')} fall inside the cited range ${group.range.start}-${group.range.end}.`,
    };
  }
  return {
    id: 'range.in-change',
    description: 'The cited lines are part of this change',
    kind: 'structural',
    outcome: 'inconclusive',
    detail: `The cited range ${group.range.start}-${group.range.end} contains no added line; the defect may be in surrounding unchanged code.`,
  };
}

const INTERPOLATED_SINK = /(\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]{0,200}(\$\{|\+\s*[A-Za-z_$]|%s|\bformat\())|(\b(exec|execSync|spawn|system|popen)\s*\([^)]*(\$\{|\+))|(innerHTML\s*=)/i;
const DESTRUCTIVE_DDL = /\b(DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)|TRUNCATE|DELETE\s+FROM\s+\w+\s*(;|$))/i;
const LOOP_START = /(\bfor\s*\(|\.forEach\s*\(|\.map\s*\(|\bwhile\s*\(|for\s+\w+\s+in\b)/;
const QUERY_CALL = /(\.find(One|Many|All)?\s*\(|\.query\s*\(|\.execute\s*\(|\.select\s*\(|\.where\s*\(|repository\.\w+\(|em\.\w+\(|SELECT\s)/i;
const LOCK_PRIMITIVE = /(\block\b|synchronized|Mutex|Semaphore|Atomic|Interlocked|transaction|FOR UPDATE|version\s*=|optimistic)/i;
const SECRET_LITERAL = /(api[_-]?key|secret|password|token|credential|private[_-]?key)\s*[:=]\s*['"`][^'"`]{8,}/i;

/** Category-specific structural checks. */
function checkCategoryConstruct(group: FindingGroup, ctx: VerificationContext): VerificationCheck | null {
  const content = ctx.files.get(group.file);
  if (content === undefined) return null;
  const win = windowAround(content, group.range.start, group.range.end);
  const lines = content.split(/\r\n|\n|\r/);
  const before = lines.slice(Math.max(0, win.from - 26), win.from - 1).join('\n');

  if (group.category === 'security') {
    if (INTERPOLATED_SINK.test(win.text)) {
      const line = lines.findIndex((l, i) => i + 1 >= win.from && i + 1 <= win.to && INTERPOLATED_SINK.test(l)) + 1;
      return {
        id: 'security.sink',
        description: 'A query or command sink built from interpolated input is present',
        kind: 'structural',
        outcome: 'supports',
        detail: `Interpolated sink found in lines ${win.from}-${win.to} of ${group.file}.`,
        evidence: [evidenceFor(group.file, line || group.range.start, lines[(line || group.range.start) - 1] ?? '', 'Interpolated sink.')],
      };
    }
    if (SECRET_LITERAL.test(win.text)) {
      return {
        id: 'security.secret-literal',
        description: 'A credential-shaped literal is present near the cited line',
        kind: 'structural',
        outcome: 'supports',
        detail: 'A credential-named identifier is assigned a string literal in the cited window.',
      };
    }
    return {
      id: 'security.sink',
      description: 'A query or command sink built from interpolated input is present',
      kind: 'heuristic',
      outcome: 'inconclusive',
      detail: 'No interpolation or credential literal was found in the cited window; the finding depends on data flow this analyser does not resolve.',
    };
  }

  if (group.category === 'database') {
    if (DESTRUCTIVE_DDL.test(win.text)) {
      const line = lines.findIndex((l, i) => i + 1 >= win.from && i + 1 <= win.to && DESTRUCTIVE_DDL.test(l)) + 1;
      return {
        id: 'database.ddl',
        description: 'Destructive DDL is present in the change',
        kind: 'structural',
        outcome: 'supports',
        detail: `Destructive DDL found in lines ${win.from}-${win.to} of ${group.file}.`,
        evidence: [evidenceFor(group.file, line || group.range.start, lines[(line || group.range.start) - 1] ?? '', 'Destructive DDL statement.')],
      };
    }
    if (QUERY_CALL.test(win.text) && LOOP_START.test(`${before}\n${win.text}`)) {
      return {
        id: 'database.query-in-loop',
        description: 'A query call appears inside a loop',
        kind: 'heuristic',
        outcome: 'supports',
        detail: 'A loop construct precedes a query call in the cited window, which is the shape of an N+1 query.',
      };
    }
    return {
      id: 'database.query-in-loop',
      description: 'A query call appears inside a loop',
      kind: 'heuristic',
      outcome: 'inconclusive',
      detail: 'Neither destructive DDL nor a query inside a loop was found in the cited window.',
    };
  }

  if (group.category === 'concurrency') {
    const hasLock = LOCK_PRIMITIVE.test(`${before}\n${win.text}`);
    const writes = /\b(this\.\w+\s*[+\-*/]?=|state\.\w+\s*=|shared\w*\s*[+\-*/]?=|\w+\[\w+\]\s*=|\+\+|--)/.test(win.text);
    if (writes && !hasLock) {
      return {
        id: 'concurrency.shared-write',
        description: 'Shared state is written without a visible lock or transaction',
        kind: 'heuristic',
        outcome: 'supports',
        detail: 'The cited window mutates state and contains no lock, atomic or transaction primitive.',
      };
    }
    if (hasLock) {
      return {
        id: 'concurrency.shared-write',
        description: 'Shared state is written without a visible lock or transaction',
        kind: 'heuristic',
        outcome: 'contradicts',
        detail: 'A lock, atomic or transaction primitive is present in the cited window.',
      };
    }
    return {
      id: 'concurrency.shared-write',
      description: 'Shared state is written without a visible lock or transaction',
      kind: 'heuristic',
      outcome: 'inconclusive',
      detail: 'No shared-state write was found in the cited window.',
    };
  }

  return null;
}

/** Check 4: a real test execution was recorded for this finding. */
function checkTestEvidence(group: FindingGroup, ctx: VerificationContext): VerificationCheck {
  const related = ctx.executions.filter((e) => e.findingId && group.members.some((m) => m.finding.id === e.findingId));
  if (related.length === 0) {
    return {
      id: 'test.execution',
      description: 'A test execution reproducing this finding exists',
      kind: 'evidence',
      outcome: 'inconclusive',
      detail: 'No test command has been run against this finding.',
    };
  }
  const failing = related.filter((e) => e.status === 'failed');
  if (failing.length > 0) {
    return {
      id: 'test.execution',
      description: 'A test execution reproducing this finding exists',
      kind: 'evidence',
      outcome: 'supports',
      detail: `${failing.length} recorded run(s) failed, the most recent being \`${failing[failing.length - 1]?.command ?? ''}\` at ${failing[failing.length - 1]?.at ?? ''}.`,
    };
  }
  return {
    id: 'test.execution',
    description: 'A test execution reproducing this finding exists',
    kind: 'evidence',
    outcome: 'inconclusive',
    detail: `${related.length} run(s) recorded, none of which failed. A passing suite is not evidence that a specific defect is absent.`,
  };
}

/** Check 5: human confirmation recorded against the finding. */
function checkHumanConfirmation(group: FindingGroup, ctx: VerificationContext): VerificationCheck {
  const decisions = (ctx.humanDecisions ?? []).filter((d) => group.members.some((m) => m.finding.id === d.findingId));
  const accept = decisions.filter((d) => d.action === 'accept');
  const reject = decisions.filter((d) => d.action === 'reject' || d.action === 'false-positive');
  if (accept.length > 0) {
    return {
      id: 'human.confirmation',
      description: 'A human confirmed this finding',
      kind: 'evidence',
      outcome: 'supports',
      detail: `${accept[0]?.actor ?? 'a reviewer'} accepted this finding at ${accept[0]?.at ?? 'an earlier review'}${accept[0]?.rationale ? `: “${accept[0].rationale}”` : ''}.`,
    };
  }
  if (reject.length > 0) {
    return {
      id: 'human.confirmation',
      description: 'A human confirmed this finding',
      kind: 'evidence',
      outcome: 'contradicts',
      detail: `${reject[0]?.actor ?? 'a reviewer'} rejected this finding (${reject[0]?.action}) at ${reject[0]?.at ?? 'an earlier review'}.`,
    };
  }
  return {
    id: 'human.confirmation',
    description: 'A human confirmed this finding',
    kind: 'evidence',
    outcome: 'inconclusive',
    detail: 'No human decision has been recorded for this finding.',
  };
}

/** Check 6: does a test file reference the changed file or symbol? */
function checkCoveringTest(group: FindingGroup, ctx: VerificationContext): VerificationCheck | null {
  if (group.category !== 'tests') return null;
  const base = group.file.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
  if (!base) return null;
  const candidates = [...ctx.files.entries()].filter(([path]) => /(^|\/)(test|tests|spec|__tests__)(\/|\.)|\.(test|spec)\./.test(path));
  const referencing = candidates.filter(([, content]) => content.includes(base)).map(([path]) => path);
  if (referencing.length > 0) {
    return {
      id: 'tests.covering-file',
      description: 'A test file references the changed module',
      kind: 'structural',
      outcome: 'contradicts',
      detail: `${referencing.slice(0, 3).join(', ')} reference “${base}”. Coverage is path-based, not runtime coverage.`,
    };
  }
  return {
    id: 'tests.covering-file',
    description: 'A test file references the changed module',
    kind: 'heuristic',
    outcome: 'supports',
    detail: `No test file references “${base}”. Absence of a reference is a strong but not conclusive signal.`,
  };
}

/** All deterministic checks for one group, in a stable order. */
export function runDeterministicChecks(group: FindingGroup, ctx: VerificationContext): VerificationCheck[] {
  const checks: VerificationCheck[] = [
    checkFileExists(group, ctx),
    checkRangeExists(group, ctx),
    checkEvidenceQuotes(group, ctx),
    checkRangeIsChanged(group, ctx),
    checkTestEvidence(group, ctx),
    checkHumanConfirmation(group, ctx),
  ];
  const categoryCheck = checkCategoryConstruct(group, ctx);
  if (categoryCheck) checks.push(categoryCheck);
  const testCheck = checkCoveringTest(group, ctx);
  if (testCheck) checks.push(testCheck);
  return checks;
}
