/**
 * Intelligent reviewer selection.
 *
 * Running every reviewer on every change is wasteful and produces noise:
 * a two-line config change does not need a concurrency specialist. Selection is
 * deterministic, explainable and cheap — it reads the diff and the deterministic
 * findings, never a model. Every decision records the signals that produced it
 * so `diffwise reviewers explain` can justify the set.
 */
import type { FileChange, Finding, FindingCategory, GraphAnalysis, RiskAssessment, ChangedSymbol, TestAnalysis } from '../types';
import { DEFAULT_MAX_REVIEWERS, REVIEWER_SPECS } from './registry';
import type { ReviewerId, ReviewerSelectionDecision, ReviewPlan } from './types';
import { REVIEWER_IDS } from './types';

export interface ReviewerPolicyInput {
  /** Explicitly disabled reviewers. Wins over every signal. */
  disabled?: ReviewerId[];
  /** Explicitly enabled reviewers. Bypasses the relevance threshold. */
  enabled?: ReviewerId[];
  maxReviewers?: number;
  /** Run every applicable reviewer regardless of the cap. */
  fullSweep?: boolean;
  /** Model routing for the reviewer stage. */
  route?: { provider: string; model: string };
}

export interface SelectionInput {
  changes: FileChange[];
  contents?: Map<string, string>;
  symbols?: ChangedSymbol[];
  graph?: GraphAnalysis;
  tests?: TestAnalysis;
  findings?: Finding[];
  risk?: Pick<RiskAssessment, 'level' | 'score'>;
  policy?: ReviewerPolicyInput;
}

interface Signal {
  reviewerId: ReviewerId;
  score: number;
  reason: string;
}

const SECURITY_PATH = /(^|\/)(auth|authn|authz|login|session|oauth|jwt|token|crypto|secret|credential|password|security|permission|acl|rbac)(\/|\.|$)/i;
const PAYMENT_PATH = /(^|\/)(payment|billing|invoice|refund|checkout|ledger|wallet|transaction|order|price|pricing|subscription)(\/|\.|$)/i;
const DB_PATH = /(^|\/)(migrations?|schema|dao|repository|repositories|entities|models|sql)(\/|\.|$)|\.sql$/i;
const API_PATH = /(^|\/)(routes?|controllers?|handlers?|api|endpoints?|openapi|swagger)(\/|\.|$)/i;
const TEST_PATH = /(^|\/)(test|tests|spec|specs|__tests__)(\/|\.|$)|\.(test|spec)\.[a-z]+$/i;

const KEYWORDS: Array<{ reviewerId: ReviewerId; score: number; pattern: RegExp; reason: string }> = [
  { reviewerId: 'security', score: 34, pattern: /\b(eval|exec|execSync|spawn|system|popen|innerHTML|dangerouslySetInnerHTML|deserialize|pickle\.loads|readFileSync|sendFile|redirect)\s*\(/i, reason: 'added code contains a command/eval/deserialization or file sink' },
  { reviewerId: 'security', score: 30, pattern: /\b(crypto|hash|hmac|aes|rsa|bcrypt|md5|sha1|randomUUID|Math\.random)\b/i, reason: 'added code touches cryptography or randomness' },
  { reviewerId: 'security', score: 26, pattern: /\b(authorize|authenticate|isAdmin|hasRole|permission|policy|guard|@PreAuthorize|requireAuth)\b/i, reason: 'added code changes an authorization decision' },
  { reviewerId: 'security', score: 22, pattern: /(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,120}(\$\{|\+\s*\w|%s|f['"])/i, reason: 'a SQL string is built by interpolation' },
  { reviewerId: 'concurrency', score: 34, pattern: /\b(Promise\.all|Promise\.race|await\s|async\s|go\s+func|synchronized|Mutex|lock\(|unlock\(|Semaphore|Atomic|Interlocked|threading|Thread)\b/, reason: 'added code is asynchronous or takes a lock' },
  { reviewerId: 'concurrency', score: 26, pattern: /\b(transaction|Transaction|tx\.|commit\(|rollback\(|BEGIN|COMMIT|SAVEPOINT)\b/, reason: 'added code manages a transaction boundary' },
  { reviewerId: 'concurrency', score: 24, pattern: /\b(idempot|retry|dedup|outbox|queue|consumer|worker|job)\b/i, reason: 'added code is retried, queued or consumed' },
  { reviewerId: 'database', score: 32, pattern: /(\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\.findOne\(|\.findMany\(|\.query\(|createQueryBuilder|@Query|JpaRepository)/, reason: 'added code issues a query' },
  { reviewerId: 'database', score: 28, pattern: /(ALTER\s+TABLE|DROP\s+(TABLE|COLUMN|INDEX)|CREATE\s+(TABLE|INDEX)|TRUNCATE|RENAME\s+COLUMN)/i, reason: 'added code contains DDL' },
  { reviewerId: 'database', score: 20, pattern: /for\s*\([^)]*\)\s*\{[\s\S]{0,240}?(await\s+)?\w+\.(find|query|get|load|fetch)/, reason: 'a lookup appears inside a loop (N+1 candidate)' },
  { reviewerId: 'architecture', score: 30, pattern: /^import\s|^from\s+\S+\s+import|^require\(|^use\s/m, reason: 'added imports change the dependency graph' },
  { reviewerId: 'performance', score: 30, pattern: /(for\s*\([^)]*\)[\s\S]{0,200}\.includes\(|\.indexOf\([^)]*\)\s*[<>=!]|JSON\.parse\(JSON\.stringify|Array\.from\(|\.map\([^)]*\)\.filter\()/, reason: 'added code has a super-linear or copy-heavy pattern' },
  { reviewerId: 'performance', score: 24, pattern: /\b(readFileSync|writeFileSync|execSync|sleep\(|busy-?wait)\b/, reason: 'added code blocks the current thread' },
  { reviewerId: 'tests', score: 26, pattern: /\b(expect\(|assert\.|assertEquals|toBe\(|toEqual\()/, reason: 'added code contains assertions' },
  { reviewerId: 'business-logic', score: 36, pattern: /\b(amount|price|total|refund|charge|capture|balance|currency|tax|discount|invoice|quota|limit)\b/i, reason: 'added code computes money or quota values' },
  { reviewerId: 'business-logic', score: 28, pattern: /\b(status|state)\s*[:=]\s*['"`](pending|paid|failed|refunded|cancelled|approved|rejected|shipped)/i, reason: 'added code assigns a domain state' },
  { reviewerId: 'correctness', score: 12, pattern: /(if\s*\(|switch\s*\(|\?\?|\|\||&&|==|===)/, reason: 'added code changes a branch condition' },
  { reviewerId: 'api-contract', score: 30, pattern: /(router|app|server|api)\.(get|post|put|patch|delete)\s*\(|@(Get|Post|Put|Patch|Delete|Request)Mapping|@(app|router)\.(get|post|put|patch|delete)/i, reason: 'added code registers or changes an HTTP endpoint' },
  { reviewerId: 'api-contract', score: 26, pattern: /(openapi|swagger|asyncapi|\.proto\b|message\s+\w+\s*\{)/i, reason: 'added code changes an API or schema contract' },
  { reviewerId: 'api-contract', score: 18, pattern: /export\s+(async\s+)?(function|class|interface|type|const)\s+\w+/i, reason: 'added code creates an exported surface' },
  { reviewerId: 'reliability', score: 28, pattern: /\b(fetch|axios|http\.request|requests\.(get|post)|await\s+\w+|\.send\(|\.publish\(|retry|setTimeout|timeout)\b/i, reason: 'added code performs IO or retries' },
  { reviewerId: 'reliability', score: 22, pattern: /\bcatch\s*\(|\bexcept\s+\w+|\bEOFError\b|\berr(or)?\s*=>\s*\{\s*\}/i, reason: 'added code handles or swallows a failure' },
  { reviewerId: 'documentation', score: 26, pattern: /(^|\/)readme|docs?\//i, reason: 'the change touches documentation' },
  { reviewerId: 'maintainability', score: 20, pattern: /(TODO|FIXME|HACK|deprecated|@deprecated)\b|function\s+\w+[\s\S]{0,600}function\s+\w+/i, reason: 'added code adds a shortcut, duplication or a deprecated surface' },
];

function addedText(change: FileChange): string {
  const lines: string[] = [];
  for (const hunk of change.hunks) {
    for (const line of hunk.lines) if (line.kind === 'add') lines.push(line.text);
  }
  return lines.join('\n');
}

function categorySignal(category: FindingCategory): ReviewerId | null {
  switch (category) {
    case 'security': return 'security';
    case 'concurrency': return 'concurrency';
    case 'database': return 'database';
    case 'architecture': return 'architecture';
    case 'performance': return 'performance';
    case 'resources': return 'performance';
    case 'tests': return 'tests';
    case 'correctness': return 'correctness';
    case 'api-contract': return 'api-contract';
    case 'reliability':
    case 'error-handling': return 'reliability';
    case 'documentation': return 'documentation';
    case 'maintainability': return 'maintainability';
    default: return null;
  }
}

/**
 * Score every reviewer, then keep the most relevant up to the cap.
 *
 * The cap is the point: eight reviewers exist, but a review runs the smallest
 * set that covers the change. `fullSweep` is an explicit, logged choice.
 */
export function selectReviewers(input: SelectionInput): ReviewPlan {
  const policy = input.policy ?? {};
  const disabled = new Set(policy.disabled ?? []);
  const forced = new Set(policy.enabled ?? []);
  const signals: Signal[] = [];
  const add = (reviewerId: ReviewerId, score: number, reason: string): void => {
    signals.push({ reviewerId, score, reason });
  };

  const changes = input.changes;
  const codeChanges = changes.filter((c) => c.language !== 'markdown' && c.language !== 'json' && c.language !== 'yaml');
  const addedLines = changes.reduce((n, c) => n + c.additions, 0);
  const changedSymbols = input.symbols?.length ?? 0;

  for (const change of codeChanges) {
    if (SECURITY_PATH.test(change.path)) add('security', 40, `${change.path} is in a security-sensitive path`);
    if (PAYMENT_PATH.test(change.path)) add('business-logic', 34, `${change.path} is in a money-moving path`);
    if (DB_PATH.test(change.path)) add('database', 40, `${change.path} is a database artifact`);
    if (API_PATH.test(change.path)) {
      add('architecture', 18, `${change.path} is an API boundary`);
      add('business-logic', 14, `${change.path} exposes an API boundary`);
    }
    if (TEST_PATH.test(change.path)) add('tests', 32, `${change.path} is a test file`);
    if (/\.(md|mdx|adoc|rst)$/i.test(change.path) || /(^|\/)(docs?|adr)\//i.test(change.path)) {
      add('documentation', 30, `${change.path} is documentation`);
      add('api-contract', 10, `${change.path} may describe an API contract`);
    }
  }

  for (const change of codeChanges) {
    const text = addedText(change);
    if (!text) continue;
    for (const k of KEYWORDS) {
      if (k.pattern.test(text)) add(k.reviewerId, k.score, `${k.reason} (${change.path})`);
    }
    if (change.status === 'deleted' && /\.(test|spec)\.[a-z]+$/i.test(change.path)) {
      add('tests', 34, `test file deleted: ${change.path}`);
    }
  }

  for (const finding of input.findings ?? []) {
    const reviewerId = categorySignal(finding.category);
    if (!reviewerId) continue;
    const weight = finding.severity === 'critical' ? 26 : finding.severity === 'high' ? 20 : 12;
    add(reviewerId, weight, `a ${finding.severity} ${finding.category} finding already exists`);
  }

  if (input.graph) {
    if (input.graph.cycles.length > 0) add('architecture', 30, `the repository has ${input.graph.cycles.length} dependency cycle(s)`);
    if (input.graph.boundaryChanges.length > 0) add('architecture', 30, 'the change alters an architectural boundary');
    const impacted = input.graph.directlyImpacted.length + input.graph.indirectlyImpacted.length;
    if (impacted >= 8) add('architecture', 16, `${impacted} files are impacted transitively`);
  }

  if (input.tests) {
    if (input.tests.uncoveredChanges.length > 0) add('tests', Math.min(30, 10 + input.tests.uncoveredChanges.length * 4), `${input.tests.uncoveredChanges.length} changed file(s) have no covering test`);
    if (input.tests.deletedTests.length > 0) add('tests', 30, `${input.tests.deletedTests.length} test file(s) deleted`);
  }

  if (input.risk) {
    if (input.risk.level === 'severe' || input.risk.level === 'high') {
      add('security', 14, `risk is ${input.risk.level} (${input.risk.score})`);
      add('correctness', 10, `risk is ${input.risk.level} (${input.risk.score})`);
    }
  }

  // Aggregate per reviewer, keeping the strongest reasons.
  const byReviewer = new Map<ReviewerId, { score: number; reasons: string[] }>();
  for (const reviewerId of REVIEWER_IDS) byReviewer.set(reviewerId, { score: 0, reasons: [] });
  for (const s of signals) {
    const entry = byReviewer.get(s.reviewerId);
    if (!entry) continue;
    entry.score += s.score;
    if (!entry.reasons.includes(s.reason)) entry.reasons.push(s.reason);
  }

  // Stats that scale the baseline reviewer.
  const correctness = byReviewer.get('correctness');
  if (correctness) {
    const sizeBonus = Math.min(28, Math.round(addedLines / 12) + changedSymbols);
    correctness.score += sizeBonus;
    if (addedLines > 0) correctness.reasons.push(`${addedLines} added line(s), ${changedSymbols} changed symbol(s)`);
  }

  const maxReviewers = Math.max(1, Math.min(REVIEWER_IDS.length, policy.maxReviewers ?? DEFAULT_MAX_REVIEWERS));
  const decisions: ReviewerSelectionDecision[] = [];

  for (const reviewerId of REVIEWER_IDS) {
    const entry = byReviewer.get(reviewerId) ?? { score: 0, reasons: [] };
    const spec = REVIEWER_SPECS[reviewerId];
    if (disabled.has(reviewerId)) {
      decisions.push({ reviewerId, selected: false, score: entry.score, reasons: ['disabled by policy'] });
      continue;
    }
    if (!spec.defaultEnabled && entry.score < 20 && !forced.has(reviewerId)) {
      decisions.push({ reviewerId, selected: false, score: entry.score, reasons: ['no signal in this change'] });
      continue;
    }
    if (entry.score < 12 && !forced.has(reviewerId)) {
      decisions.push({ reviewerId, selected: false, score: entry.score, reasons: ['no material signal in this change'] });
      continue;
    }
    decisions.push({ reviewerId, selected: true, score: entry.score, reasons: entry.reasons.length ? entry.reasons : ['baseline reviewer'] });
  }

  const eligible = decisions.filter((d) => d.selected).sort((a, b) => b.score - a.score);
  const chosen = new Set<ReviewerId>();
  // Pinned reviewers (correctness) are chosen before the cap is applied: they
  // are the floor of a review, not a competitor for a slot.
  for (const decision of eligible) {
    if (REVIEWER_SPECS[decision.reviewerId].pinned) chosen.add(decision.reviewerId);
  }
  const slots = Math.max(1, maxReviewers - chosen.size);
  const remaining = eligible.filter((d) => !chosen.has(d.reviewerId));
  const keep = policy.fullSweep ? remaining.length : Math.min(slots, remaining.length);
  for (const decision of remaining.slice(0, keep)) chosen.add(decision.reviewerId);
  for (const forcedId of forced) {
    if (!disabled.has(forcedId)) chosen.add(forcedId);
  }
  if (chosen.size === 0 && !disabled.has('correctness')) chosen.add('correctness');
  const totalKept = chosen.size;

  const finalDecisions = decisions.map((d) => {
    if (chosen.has(d.reviewerId)) return { ...d, selected: true };
    if (d.selected) {
      return {
        ...d,
        selected: false,
        reasons: [...d.reasons, `ranked out: maxReviewers=${maxReviewers} kept ${totalKept} reviewer(s)`],
      };
    }
    return d;
  });

  const reviewers = REVIEWER_IDS.filter((id) => chosen.has(id));
  return {
    reviewers,
    decisions: finalDecisions,
    considered: [...REVIEWER_IDS],
    maxReviewers,
    route: policy.route ?? { provider: 'configured', model: 'configured' },
    truncated: eligible.length > totalKept,
  };
}

/** Human-readable justification, used by the CLI and the report. */
export function explainPlan(plan: ReviewPlan): string[] {
  const lines: string[] = [];
  for (const id of plan.reviewers) {
    const d = plan.decisions.find((x) => x.reviewerId === id);
    const spec = REVIEWER_SPECS[id];
    lines.push(`${spec.name} (${id}, score ${d?.score ?? 0})`);
    for (const reason of d?.reasons ?? []) lines.push(`    - ${reason}`);
  }
  for (const d of plan.decisions.filter((x) => !plan.reviewers.includes(x.reviewerId))) {
    lines.push(`not run: ${d.reviewerId} — ${d.reasons[d.reasons.length - 1] ?? 'not relevant'}`);
  }
  return lines;
}
