import type {
  ChangedSymbol, DocumentationFile, Evidence, FileChange, Finding, FindingCategory, FindingKind,
  GraphAnalysis, Severity, Confidence, TestAnalysis, AnalysisSettings,
} from '../types';

export type CandidateFinding = Omit<Finding, 'id' | 'source' | 'validated'>;

export interface RuleContext {
  changes: FileChange[];
  /** New content of changed files (deleted files are absent). */
  contents: Map<string, string>;
  /** Old content of changed files, when the file existed before. */
  oldContents: Map<string, string | null>;
  /** Every analysable repository file, for cross-file checks. */
  repoFiles: Map<string, string>;
  symbols: ChangedSymbol[];
  docs: DocumentationFile[];
  docTexts: Map<string, string>;
  tests: TestAnalysis;
  graph: GraphAnalysis;
  settings: AnalysisSettings;
  now: Date;
}

export interface Rule {
  id: string;
  category: FindingCategory;
  run(ctx: RuleContext): CandidateFinding[];
}

export interface FindingDraft {
  ruleId: string;
  title: string;
  description: string;
  severity: Severity;
  category: FindingCategory;
  kind: FindingKind;
  confidence: Confidence;
  file: string;
  range: { start: number; end: number };
  evidence: Evidence[];
  whyItMatters: string;
  consequences?: string[];
  reproduction?: string;
  recommendation: string;
  tags?: string[];
}

export function draftFinding(d: FindingDraft): CandidateFinding {
  return {
    ruleId: d.ruleId,
    title: d.title,
    description: d.description,
    severity: d.severity,
    category: d.category,
    kind: d.kind,
    confidence: d.confidence,
    file: d.file,
    range: d.range,
    evidence: d.evidence,
    whyItMatters: d.whyItMatters,
    consequences: d.consequences ?? [],
    ...(d.reproduction ? { reproduction: d.reproduction } : {}),
    recommendation: d.recommendation,
    tags: d.tags ?? [],
  };
}
