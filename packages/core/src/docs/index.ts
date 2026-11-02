/**
 * Documentation index.
 *
 * Review needs documentation, but sending a documentation tree to a model is
 * both expensive and useless: most sections are unrelated to a change. This
 * module builds a content-addressed index of headings and sections, updates it
 * incrementally by hash, and retrieves a bounded, attributed set of sections for
 * the changed files and symbols.
 *
 * It is deterministic and model-free. A retrieved section is data with a
 * document path and line range; nothing here decides that a document is right.
 */
import { createHash } from 'node:crypto';
import type { DocumentCategory, DocumentationIndex, DocumentationIndexEntry, DocumentationSection, DocReference, DocRetrieval, DocumentationSource } from '../types';
import { extractReferences } from '../analysis/docAnalysis';
import { matchesAnyGlob } from '../util/glob';

export interface DocumentationIndexInput {
  /** Repository-relative path -> text. */
  files: Map<string, string>;
  sources?: DocumentationSource[];
  /** Exclude these paths (vendor docs, generated output). */
  ignoreGlobs?: string[];
}

const DOC_EXT = /\.(md|mdx|markdown|adoc|asciidoc|rst|txt|ya?ml|json|proto|sql|pdf)$/i;

export function isIndexableDocument(path: string): boolean {
  return DOC_EXT.test(path) && !/(^|\/)(node_modules|\.git|dist|build|coverage)\//.test(path);
}

/** Infer a category from the path and content, never from a model. */
export function categoriseDocument(path: string, content = ''): DocumentCategory {
  const lower = path.toLowerCase();
  if (/(^|\/)readme(\.|$)/.test(lower)) return 'readme';
  if (/(^|\/)(adr|adrs|decisions?)\//.test(lower) || /\barchitecture decision record\b/i.test(content)) return 'adr';
  if (/(openapi|swagger)/.test(lower)) return 'openapi';
  if (/asyncapi/.test(lower)) return 'asyncapi';
  if (/\.proto$/.test(lower)) return 'protobuf';
  if (/(^|\/)(migrations?|schema|ddl)\//.test(lower) || /\.sql$/.test(lower)) return 'sql';
  if (/(architecture|design|system)/.test(lower)) return 'architecture';
  if (/(requirement|business|product|prd)/.test(lower)) return 'business';
  if (/(standard|style|convention|contributing)/.test(lower)) return 'standards';
  if (/(api|contract|interface)/.test(lower)) return 'contract';
  if (/(^|\/)docs?\//.test(lower)) return 'technical';
  return 'other';
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

/** Split markdown/YAML/plain text into heading sections with line ranges. */
export function splitSections(path: string, content: string, category: DocumentCategory): DocumentationSection[] {
  const lines = content.split(/\r\n|\n|\r/);
  const sections: DocumentationSection[] = [];
  const references = extractReferences(content);
  const refsByLine = new Map<number, DocReference[]>();
  for (const ref of references) {
    const list = refsByLine.get(ref.line) ?? [];
    list.push(ref);
    refsByLine.set(ref.line, list);
  }
  let current: { heading: string; level: number; start: number } | null = null;
  const flush = (endLine: number): void => {
    if (!current) return;
    const text = lines.slice(current.start - 1, endLine).join('\n').trim();
    if (!text) return;
    sections.push({
      id: `${path}#L${current.start}`,
      docPath: path,
      heading: current.heading,
      level: current.level,
      startLine: current.start,
      endLine,
      text,
      contentHash: hash(text),
      references: [...new Set(references.filter((r) => r.line >= current!.start && r.line <= endLine).map((r) => r.value))].slice(0, 40),
      category,
    });
  };
  lines.forEach((line, index) => {
    const at = index + 1;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const yamlKey = !heading && /^([A-Za-z][\w -]{2,60}):\s*$/.test(line) ? /^([A-Za-z][\w -]{2,60}):\s*$/.exec(line) : null;
    if (heading || yamlKey) {
      flush(at - 1);
      current = {
        heading: (heading?.[2] ?? yamlKey?.[1] ?? 'Document').trim(),
        level: heading ? heading[1]!.length : 1,
        start: at,
      };
    }
  });
  flush(lines.length);
  if (sections.length === 0) {
    const text = content.trim();
    if (text) {
      sections.push({
        id: `${path}#L1`, docPath: path, heading: path.split('/').pop() ?? path, level: 1,
        startLine: 1, endLine: Math.max(1, lines.length), text, contentHash: hash(text),
        references: [...new Set(references.map((r) => r.value))].slice(0, 40), category,
      });
    }
  }
  return sections;
}

/** Build an index from scratch. */
export function buildDocumentationIndex(input: DocumentationIndexInput): DocumentationIndex {
  const sources = input.sources ?? [];
  const entries: DocumentationIndexEntry[] = [];
  const seenHashes = new Map<string, string>();
  const generatedAt = new Date().toISOString();
  for (const [path, content] of [...input.files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isIndexableDocument(path)) continue;
    if (input.ignoreGlobs && matchesAnyGlob(path, input.ignoreGlobs)) continue;
    const source = sourceFor(path, sources);
    if (sources.length > 0 && (!source || source.enabled === false)) continue;
    const category = source?.category ?? categoriseDocument(path, content);
    const contentHash = hash(content);
    const sections = splitSections(path, content, category);
    const duplicateOf = seenHashes.get(contentHash);
    if (!duplicateOf) seenHashes.set(contentHash, path);
    entries.push({
      path,
      category,
      priority: source?.priority ?? defaultPriority(category),
      contentHash,
      bytes: content.length,
      title: sections[0]?.heading ?? path,
      sections,
      ...(source?.modules?.length ? { modules: source.modules } : {}),
      ...(duplicateOf ? { duplicateOf } : {}),
      indexedAt: generatedAt,
    });
  }
  return {
    version: 1,
    generatedAt,
    sources,
    entries,
    stats: {
      documents: entries.length,
      sections: entries.reduce((n, e) => n + e.sections.length, 0),
      bytes: entries.reduce((n, e) => n + e.bytes, 0),
      duplicates: entries.filter((e) => e.duplicateOf).length,
    },
  };
}

/**
 * Incremental update: entries whose content hash is unchanged keep their parsed
 * sections (the expensive part), and removed files disappear.
 */
export function updateDocumentationIndex(previous: DocumentationIndex | undefined, input: DocumentationIndexInput): DocumentationIndex {
  if (!previous) return buildDocumentationIndex(input);
  const sources = input.sources ?? previous.sources;
  const byPath = new Map(previous.entries.map((entry) => [entry.path, entry]));
  const sourcesChanged = JSON.stringify(previous.sources) !== JSON.stringify(sources);
  const entries: DocumentationIndexEntry[] = [];
  const seenHashes = new Map<string, string>();
  const generatedAt = new Date().toISOString();
  let reused = 0;
  let changed = 0;
  let added = 0;
  for (const [path, content] of [...input.files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isIndexableDocument(path)) continue;
    if (input.ignoreGlobs && matchesAnyGlob(path, input.ignoreGlobs)) continue;
    const source = sourceFor(path, sources);
    if (sources.length > 0 && (!source || source.enabled === false)) continue;
    const category = source?.category ?? categoriseDocument(path, content);
    const contentHash = hash(content);
    const prior = byPath.get(path);
    let entry: DocumentationIndexEntry;
    if (prior && prior.contentHash === contentHash && prior.category === category && !sourcesChanged) {
      entry = prior;
      reused += 1;
    } else {
      if (prior) changed += 1; else added += 1;
      entry = {
        path, category, priority: source?.priority ?? defaultPriority(category),
        contentHash, bytes: content.length, title: splitSections(path, content, category)[0]?.heading ?? path,
        sections: splitSections(path, content, category),
        ...(source?.modules?.length ? { modules: source.modules } : {}),
        indexedAt: generatedAt,
      };
    }
    const duplicateOf = seenHashes.get(contentHash);
    if (!duplicateOf) seenHashes.set(contentHash, path);
    entries.push({ ...entry, ...(duplicateOf && duplicateOf !== path ? { duplicateOf } : {}) });
  }
  return {
    version: 1,
    generatedAt,
    sources,
    entries,
    stats: {
      documents: entries.length,
      sections: entries.reduce((n, e) => n + e.sections.length, 0),
      bytes: entries.reduce((n, e) => n + e.bytes, 0),
      duplicates: entries.filter((e) => e.duplicateOf).length,
      reused,
      added,
      changed,
      removed: [...byPath.keys()].filter((path) => !entries.some((e) => e.path === path)).length,
    },
  };
}

function defaultPriority(category: DocumentCategory): number {
  switch (category) {
    case 'readme': return 10;
    case 'adr': return 20;
    case 'architecture': return 25;
    case 'openapi': case 'asyncapi': case 'protobuf': case 'contract': return 30;
    case 'sql': return 35;
    case 'business': return 40;
    case 'technical': return 50;
    case 'standards': return 60;
    default: return 100;
  }
}

export function sourceFor(path: string, sources: DocumentationSource[]): DocumentationSource | undefined {
  return sources.find((source) => matchesAnyGlob(path, [source.path]));
}

export interface DocumentationQuery {
  /** Changed files; a document mentioning one of them ranks higher. */
  files?: string[];
  /** Changed symbol names. */
  symbols?: string[];
  /** Free-text terms from the change or the review intent. */
  terms?: string[];
  categories?: DocumentCategory[];
  maxSections?: number;
  maxChars?: number;
  /** Prefer sections from documents with at least this priority (lower is stronger). */
  minPriority?: number;
}

/**
 * Retrieve a bounded set of sections relevant to a change.
 *
 * Scoring is transparent: a symbol/file term match in the heading is worth
 * more than one in the body, and the document's configured priority breaks
 * ties. Sections without any match are never included — an unrelated document
 * in a prompt is worse than no document.
 */
export function retrieveDocumentation(index: DocumentationIndex, query: DocumentationQuery): DocRetrieval {
  const started = Date.now();
  const maxSections = Math.max(1, Math.min(20, query.maxSections ?? 6));
  const maxChars = Math.max(400, query.maxChars ?? 6_000);
  const files = (query.files ?? []).filter(Boolean);
  const symbols = (query.symbols ?? []).filter(Boolean);
  const terms = [...new Set((query.terms ?? []).filter((t) => t.length >= 3).map((t) => t.toLowerCase()))];
  const scored: Array<{ section: DocumentationSection; score: number; why: string; entry: DocumentationIndexEntry }> = [];
  const skipped: string[] = [];

  for (const entry of index.entries) {
    if (entry.duplicateOf) { skipped.push(`${entry.path}: duplicate of ${entry.duplicateOf}`); continue; }
    if (query.categories && query.categories.length > 0 && !query.categories.includes(entry.category)) continue;
    if (query.minPriority !== undefined && entry.priority > query.minPriority) continue;
    for (const section of entry.sections) {
      const haystack = `${section.heading}\n${section.text}`.toLowerCase();
      let score = Math.max(0, 100 - entry.priority) / 10;
      const reasons: string[] = [];
      for (const symbol of symbols) {
        if (symbol.length < 3) continue;
        const needle = symbol.toLowerCase();
        if (section.heading.toLowerCase().includes(needle)) { score += 12; reasons.push(`heading names ${symbol}`); }
        else if (haystack.includes(needle)) { score += 6; reasons.push(`mentions ${symbol}`); }
      }
      for (const file of files) {
        const base = file.split('/').pop() ?? file;
        if (haystack.includes(file.toLowerCase()) || (base.length > 4 && haystack.includes(base.toLowerCase()))) {
          score += 8; reasons.push(`references ${file}`);
        }
      }
      for (const term of terms) {
        if (section.heading.toLowerCase().includes(term)) { score += 5; reasons.push(`heading contains "${term}"`); }
        else if (haystack.includes(term)) { score += 2; reasons.push(`contains "${term}"`); }
      }
      if (reasons.length === 0) continue;
      scored.push({ section, score, why: [...new Set(reasons)].slice(0, 4).join('; '), entry });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.entry.priority - b.entry.priority || a.section.docPath.localeCompare(b.section.docPath) || a.section.startLine - b.section.startLine);
  const sections: DocRetrieval['sections'] = [];
  let used = 0;
  for (const item of scored) {
    if (sections.length >= maxSections) break;
    const remaining = maxChars - used;
    if (remaining < 120) break;
    const text = item.section.text.length > remaining ? `${item.section.text.slice(0, remaining - 1)}…` : item.section.text;
    sections.push({
      document: item.section.docPath,
      heading: item.section.heading,
      startLine: item.section.startLine,
      endLine: item.section.endLine,
      category: item.section.category,
      text,
      score: item.score,
      why: item.why,
      truncated: text.length < item.section.text.length,
    });
    used += text.length;
  }
  return {
    generatedAt: new Date().toISOString(),
    query: { files, symbols, terms, ...(query.categories ? { categories: query.categories } : {}) },
    sections,
    consideredSections: scored.length,
    skipped,
    truncated: sections.length < scored.length,
    durationMs: Date.now() - started,
  };
}

/** A bounded index summary for the report header and the UI. */
export function documentationIndexSummary(index: DocumentationIndex): {
  documents: number; sections: number; bytes: number; duplicates: number; categories: Partial<Record<DocumentCategory, number>>;
  sources: number; generatedAt: string;
} {
  const categories: Partial<Record<DocumentCategory, number>> = {};
  for (const entry of index.entries) categories[entry.category] = (categories[entry.category] ?? 0) + 1;
  return {
    documents: index.entries.length,
    sections: index.entries.reduce((n, e) => n + e.sections.length, 0),
    bytes: index.entries.reduce((n, e) => n + e.bytes, 0),
    duplicates: index.entries.filter((e) => e.duplicateOf).length,
    categories,
    sources: index.sources.length,
    generatedAt: index.generatedAt,
  };
}
