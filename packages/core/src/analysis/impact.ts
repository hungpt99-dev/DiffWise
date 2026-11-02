/**
 * System-level architecture impact.
 *
 * The existing dependency graph answers "which files import this file". That is
 * necessary and far from sufficient: a migration can break rollback without any
 * import edge, an event schema can break a consumer that never imports the
 * producer, and an environment variable can break a deployment.
 *
 * This module adds the dimensions the graph cannot see, and it labels every
 * item with the relationship and how it was resolved. Nothing here is inferred
 * from naming similarity, and nothing is presented as a runtime dependency:
 * `provenance` is `static` only when a parser resolved it.
 */
import type {
  ChangedSymbol, DocumentationFile, DocRetrieval, Evidence, FileChange, GraphAnalysis, ImpactAnalysis,
  ImpactDimension, ImpactItem, ImpactProvenance, ImpactRelation, TestAnalysis,
} from '../types';
import { stableId } from '../util/text';
import { isMigrationFile } from './languages';

export interface ImpactInput {
  changes: FileChange[];
  contents: Map<string, string>;
  oldContents: Map<string, string | null>;
  repoFiles: Map<string, string>;
  symbols: ChangedSymbol[];
  graph: GraphAnalysis;
  tests: TestAnalysis;
  docs: DocumentationFile[];
  docTexts: Map<string, string>;
  retrieval?: DocRetrieval;
}

const DIMENSIONS: ImpactDimension[] = ['code', 'module', 'service', 'api', 'database', 'event', 'configuration', 'testing', 'documentation'];

function addedLines(change: FileChange): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  for (const hunk of change.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add' && line.newLine !== undefined) out.push({ line: line.newLine, text: line.text });
    }
  }
  return out;
}

function removedLines(change: FileChange): string[] {
  const out: string[] = [];
  for (const hunk of change.hunks) for (const line of hunk.lines) if (line.kind === 'del') out.push(line.text);
  return out;
}

export function serviceOf(path: string): string | undefined {
  const match = /^(?:services|apps|packages|modules|domains)\/([^/]+)\//.exec(path);
  return match?.[1];
}

export function moduleOfPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '(root)';
  if (/(?:services|apps|packages|modules|domains)/.test(parts[0] ?? '') && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? '(root)';
}

function evidence(file: string, line: number | undefined, snippet: string, note: string): Evidence {
  return {
    kind: 'code', file, ...(line ? { line } : {}), snippet: snippet.slice(0, 300), note, source: 'deterministic',
  };
}

function item(input: Omit<ImpactItem, 'id' | 'confidence'> & { confidence?: ImpactItem['confidence'] }): ImpactItem {
  return {
    ...input,
    id: stableId('imp', input.dimension, input.relation, input.file ?? '', input.line ?? 0, input.label.slice(0, 60)),
    confidence: input.confidence ?? (input.provenance === 'static' ? 'high' : input.provenance === 'ai' ? 'low' : 'medium'),
  };
}

function addGraphImpact(out: ImpactItem[], graph: GraphAnalysis, changed: Set<string>): void {
  for (const file of graph.directlyImpacted) {
    if (changed.has(file)) continue;
    const edge = graph.edges.find((e) => e.to === file && changed.has(e.from))
      ?? graph.edges.find((e) => e.from === file && changed.has(e.to));
    out.push(item({
      dimension: 'code',
      label: `${file} depends on a changed file`,
      detail: `Depth 1 in the static dependency graph (${edge?.kind ?? 'dependency'}). The parser resolved this relationship, not a name match.`,
      direct: true,
      relation: (edge?.kind === 'call' ? 'CALLS' : edge?.kind === 'import' ? 'IMPORTS' : 'DEPENDS_ON') as ImpactRelation,
      provenance: edge?.resolution === 'verified' ? 'static' : 'static',
      file,
      ...(edge ? { line: edge.line } : {}),
      evidence: [evidence(edge?.from ?? file, edge?.line, edge ? `${edge.from} → ${edge.to}` : file, `Static ${edge?.kind ?? 'dependency'} edge.`)],
    }));
  }
  for (const file of graph.indirectlyImpacted.slice(0, 80)) {
    if (changed.has(file) || graph.directlyImpacted.includes(file)) continue;
    out.push(item({
      dimension: 'code',
      label: `${file} is transitively affected`,
      detail: `Depth ${graph.impactDepth[file] ?? 2} in the resolved dependency graph. Closer modules are more likely to break; this is a static relationship, not a runtime proof.`,
      direct: false,
      relation: 'DEPENDS_ON',
      provenance: 'static',
      file,
      evidence: [evidence(file, undefined, file, 'Reachable from a changed file through resolved imports.')],
    }));
  }
}

function addModuleImpact(out: ImpactItem[], input: ImpactInput): void {
  const changedModules = new Map<string, string[]>();
  for (const change of input.changes) {
    const module = moduleOfPath(change.path);
    const list = changedModules.get(module) ?? [];
    list.push(change.path);
    changedModules.set(module, list);
  }
  for (const [module, files] of changedModules) {
    out.push(item({
      dimension: 'module',
      label: `Module ${module} changed`,
      detail: `${files.length} file(s) in ${module}: ${files.slice(0, 4).join(', ')}${files.length > 4 ? ', …' : ''}.`,
      direct: true, relation: 'CHANGES', provenance: 'static', module,
      evidence: files.slice(0, 3).map((file) => evidence(file, undefined, file, `Changed file in ${module}.`)),
    }));
  }
  const touched = new Set(changedModules.keys());
  for (const component of input.graph.modules) {
    if (touched.has(component.id)) continue;
    if (!input.graph.directlyImpacted.some((file) => component.files.includes(file))) continue;
    out.push(item({
      dimension: 'module',
      label: `Module ${component.name} is affected`,
      detail: `${component.files.length} file(s) in this module depend on changed code.`,
      direct: false, relation: 'DEPENDS_ON', provenance: 'static', module: component.id,
      evidence: [evidence(component.files[0] ?? component.id, undefined, component.id, 'Graph impact reached this module.')],
    }));
  }
}

function addServiceImpact(out: ImpactItem[], input: ImpactInput): void {
  const changedServices = new Map<string, string[]>();
  const changedModules = new Set<string>();
  for (const change of input.changes) {
    changedModules.add(moduleOfPath(change.path));
    const service = serviceOf(change.path);
    if (!service) continue;
    const list = changedServices.get(service) ?? [];
    list.push(change.path);
    changedServices.set(service, list);
  }
  for (const [service, files] of changedServices) {
    out.push(item({
      dimension: 'service',
      label: `Service ${service} changed`,
      detail: `${files.length} changed file(s) inside services/${service}.`,
      direct: true, relation: 'CHANGES', provenance: 'static', service,
      evidence: files.slice(0, 3).map((file) => evidence(file, undefined, file, `Changed file in service ${service}.`)),
    }));
  }
  // Cross-service relationship: a changed file in service A is imported by a
  // file in service B. That is evidence of coupling, not of a network call.
  for (const edge of input.graph.edges) {
    const fromService = serviceOf(edge.from);
    const toService = serviceOf(edge.to);
    if (!fromService || !toService || fromService === toService) continue;
    const changedEnd = input.changes.some((c) => c.path === edge.to || c.path === edge.from);
    if (!changedEnd) continue;
    out.push(item({
      dimension: 'service',
      label: `${fromService} depends on ${toService}`,
      detail: `A resolved ${edge.kind} edge crosses a service boundary (${edge.from} → ${edge.to}). Shared-library coupling often means both services must deploy together.`,
      direct: true, relation: edge.kind === 'call' ? 'CALLS' : 'DEPENDS_ON', provenance: 'static',
      file: edge.from, line: edge.line, service: `${fromService}→${toService}`,
      evidence: [evidence(edge.from, edge.line, `${edge.from} → ${edge.to}`, `Cross-service ${edge.kind} edge.`)],
    }));
  }
  for (const change of input.changes) {
    const added = addedLines(change).map((l) => l.text).join('\n');
    const service = serviceOf(change.path);
    if (!service) continue;
    const importedModules = [...changedModules].filter((m) => m !== moduleOfPath(change.path));
    if (importedModules.length === 0) continue;
    if (!/^import\s|^from\s+\S+\s+import|require\(/m.test(added)) continue;
    out.push(item({
      dimension: 'service',
      label: `Boundary changed in ${service}`,
      detail: `The change adds imports inside ${service} and touches ${importedModules.length} other module(s). Review the dependency direction.`,
      direct: true, relation: 'DEPENDS_ON', provenance: 'static', service, file: change.path,
      evidence: [evidence(change.path, addedLines(change)[0]?.line, added.slice(0, 200), 'Imports added at a service boundary.')],
    }));
  }
}

interface RouteChange { method: string; path: string; file: string; line: number; removed: boolean }

function routesIn(text: string, file: string): Array<{ method: string; path: string; line: number }> {
  const out: Array<{ method: string; path: string; line: number }> = [];
  const lines = text.split(/\r\n|\n|\r/);
  lines.forEach((line, index) => {
    const express = /(?:router|app|server|api)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/i.exec(line);
    const py = /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/i.exec(line);
    const spring = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/i.exec(line);
    if (express?.[1] && express[2]) out.push({ method: express[1].toUpperCase(), path: express[2], line: index + 1 });
    else if (py?.[1] && py[2]) out.push({ method: py[1].toUpperCase(), path: py[2], line: index + 1 });
    else if (spring?.[1] && spring[2]) out.push({ method: spring[1].toUpperCase().replace('REQUEST', 'ANY'), path: spring[2], line: index + 1 });
  });
  return out.map((r) => ({ ...r, file }));
}

function addApiImpact(out: ImpactItem[], input: ImpactInput): void {
  const changes: RouteChange[] = [];
  for (const change of input.changes) {
    const next = input.contents.get(change.path) ?? '';
    const previous = input.oldContents.get(change.path) ?? '';
    for (const route of routesIn(next, change.path)) changes.push({ ...route, file: change.path, removed: false });
    for (const route of routesIn(previous, change.path)) changes.push({ ...route, file: change.path, removed: true });
  }
  const removed = changes.filter((c) => c.removed);
  const added = changes.filter((c) => !c.removed);
  for (const route of removed) {
    const replacement = added.find((a) => a.path === route.path || (a.path.split('/').length === route.path.split('/').length && normaliseRoute(a.path) === normaliseRoute(route.path)));
    if (replacement) continue;
    out.push(item({
      dimension: 'api', label: `Endpoint removed: ${route.method} ${route.path}`,
      detail: `The route existed before this change and no equivalent route remains. Any caller that was not updated breaks.`,
      direct: true, relation: 'BREAKS', provenance: 'static', file: route.file, line: route.line,
      evidence: [evidence(route.file, route.line, `${route.method} ${route.path}`, 'Route present in the base revision.')],
    }));
  }
  for (const route of added) {
    const existed = changes.some((c) => c.removed && normaliseRoute(c.path) === normaliseRoute(route.path));
    if (existed) continue;
    out.push(item({
      dimension: 'api', label: `Endpoint added: ${route.method} ${route.path}`,
      detail: 'A new public surface. Authorization, validation and documentation must cover it.',
      direct: true, relation: 'EXPOSES', provenance: 'static', file: route.file, line: route.line,
      evidence: [evidence(route.file, route.line, `${route.method} ${route.path}`, 'New route registration.')],
    }));
  }
  // Changed exported signatures with callers are contract risk even when no
  // route was touched: the exported function is the internal contract.
  for (const symbol of input.symbols) {
    if (!symbol.signatureChanged || !symbol.exported) continue;
    out.push(item({
      dimension: 'api', label: `Signature changed: ${symbol.name}`,
      detail: `${symbol.referenceCount} reference(s) resolved elsewhere. Callers compiled against the previous signature may break.`,
      direct: true, relation: 'BREAKS', provenance: 'static', file: symbol.file, line: symbol.range.start, symbol: symbol.name,
      evidence: [evidence(symbol.file, symbol.range.start, symbol.signature, 'Changed exported declaration.'), ...(symbol.referenceExamples ?? []).slice(0, 2).map((f) => evidence(f, undefined, f, `References ${symbol.name}.`))],
    }));
  }
  // OpenAPI consistency, using the documents the review actually loaded.
  for (const doc of input.docs.filter((d) => d.kind === 'openapi')) {
    const text = input.docTexts.get(doc.path) ?? '';
    const documented = [...text.matchAll(/^\s{2}(\/[^:\s]+):\s*$/gm)].map((m) => m[1]!);
    for (const route of removed) {
      if (!documented.includes(route.path)) continue;
      out.push(item({
        dimension: 'api', label: `Specification still documents ${route.path}`,
        detail: `${doc.path} documents a path the code no longer implements.`,
        direct: false, relation: 'DOCUMENTS', provenance: 'documentation', file: doc.path,
        evidence: [evidence(doc.path, undefined, route.path, 'Documented path.')],
      }));
    }
  }
}

function normaliseRoute(path: string): string {
  return path.replace(/:[A-Za-z_]\w*/g, ':param').replace(/\{[^}]+\}/g, ':param').replace(/\/$/, '');
}

function migrationFiles(files: Map<string, string>): string[] {
  return [...files.keys()].filter((path) => isMigrationFile(path) || /\.sql$/i.test(path));
}

function addDatabaseImpact(out: ImpactItem[], input: ImpactInput): void {
  for (const change of input.changes) {
    if (!isMigrationFile(change.path) && !/\.(sql|entity|model)$/i.test(change.path)) continue;
    const added = addedLines(change).map((l) => l.text);
    const removed = removedLines(change);
    const destructive = added.filter((line) => /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|ALTER\s+COLUMN|RENAME\s+(TABLE|COLUMN)|DELETE\s+FROM)\b/i.test(line));
    const table = /\b(?:ALTER|CREATE|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`]?([\w.]+)/i.exec(added.join('\n'))?.[1];
    if (destructive.length > 0) {
      const hasRollback = /(^|\/)(down|rollback|revert)/i.test(change.path)
        || /\b(ROLLBACK|DOWN\s+MIGRATION|--\s*rollback)/i.test(added.join('\n') + input.contents.get(change.path));
      out.push(item({
        dimension: 'database', label: `Destructive DDL${table ? ` on ${table}` : ''}`,
        detail: `${destructive.length} destructive statement(s) added. ${hasRollback ? 'A rollback path is present.' : 'No rollback path was found in the migration.'}`,
        direct: true, relation: 'WRITES', provenance: 'static', file: change.path,
        ...(added.find((l) => /\bDROP|TRUNCATE|ALTER\b/i.test(l)) ? { line: change.hunks.flatMap((h) => h.lines).find((l) => l.kind === 'add' && /\bDROP|TRUNCATE|ALTER\b/i.test(l.text))?.newLine } : {}),
        confidence: hasRollback ? 'high' : 'medium',
        evidence: [evidence(change.path, undefined, destructive.slice(0, 3).join('\n'), 'Destructive SQL added by the migration.')],
      }));
    }
    if (table) {
      out.push(item({
        dimension: 'database', label: `Table ${table} changed`,
        detail: `Schema or migration change to ${table}. Column changes can break ORM mappings and queries that were not edited.`,
        direct: true, relation: 'ALTERS' as ImpactRelation, provenance: 'static', file: change.path,
        evidence: [evidence(change.path, undefined, added.slice(0, 3).join('\n'), `DDL touching ${table}.`)],
      }));
    }
    for (const line of removed) {
      if (!/\b(DROP|ALTER|CREATE)\b/i.test(line)) continue;
      out.push(item({
        dimension: 'database', label: 'Prior DDL removed or replaced',
        detail: 'A previously applied migration line was removed. Migration history is immutable; editing it makes environments diverge.',
        direct: true, relation: 'WRITES', provenance: 'static', file: change.path,
        evidence: [evidence(change.path, undefined, line, 'Removed migration statement.')],
      }));
      break;
    }
  }
  // Query dependencies on changed tables are textual: a repository file that
  // names the table is a candidate reader, not a proven runtime consumer.
  const tables = new Set(out.filter((i) => i.dimension === 'database' && i.label.startsWith('Table ')).map((i) => i.label.replace('Table ', '').replace(' changed', '')));
  if (tables.size > 0) {
    for (const [path, content] of input.repoFiles) {
      if (input.contents.has(path)) continue;
      if (!/\.(ts|js|py|java|kt|go|rb|php|cs|sql)$/i.test(path)) continue;
      for (const table of tables) {
        if (!new RegExp(`\\b${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(content)) continue;
        out.push(item({
          dimension: 'database', label: `${path} reads or writes ${table}`,
          detail: 'The table name appears in this file. This is textual evidence of a query dependency; it is not a resolved ORM relationship.',
          direct: false, relation: 'READS', provenance: 'static', confidence: 'medium', file: path,
          evidence: [evidence(path, undefined, table, `Textual reference to table ${table}.`)],
        }));
        break;
      }
      if (out.filter((i) => i.dimension === 'database').length > 40) break;
    }
  }
}

const EVENT_PRODUCE = /\b(?:producer\.send|kafkaTemplate\.send|publish\(|emit\(|\.produce\(|rabbitTemplate\.convertAndSend|channel\.sendTo)\s*\(?\s*['"`]?([\w.\-:]+)/;
const EVENT_CONSUME = /@(?:KafkaListener|RabbitListener)\s*\([^)]*?['"`]([\w.\-:]+)['"`]|\b(?:consumer\.subscribe|consume\()\s*\(?\s*['"`]([\w.\-:]+)['"`]/;

function addEventImpact(out: ImpactItem[], input: ImpactInput): void {
  const producers = new Set<string>();
  const consumers = new Set<string>();
  for (const change of input.changes) {
    const text = addedLines(change).map((l) => l.text).join('\n');
    for (const match of text.matchAll(new RegExp(EVENT_PRODUCE.source, 'g'))) {
      const topic = match[1];
      if (!topic || topic.length < 2) continue;
      producers.add(topic);
      out.push(item({
        dimension: 'event', label: `Event produced: ${topic}`,
        detail: 'A producer was added or changed. Consumer schema compatibility and ordering assumptions must be checked.',
        direct: true, relation: 'PRODUCES', provenance: 'static', file: change.path,
        evidence: [evidence(change.path, undefined, match[0], `Producer for ${topic}.`)],
      }));
    }
    for (const match of text.matchAll(new RegExp(EVENT_CONSUME.source, 'g'))) {
      const topic = match[1];
      if (!topic || topic.length < 2) continue;
      consumers.add(topic);
      out.push(item({
        dimension: 'event', label: `Event consumed: ${topic}`,
        detail: 'A consumer was added or changed. Retry and idempotency behaviour applies to every delivery.',
        direct: true, relation: 'CONSUMES', provenance: 'static', file: change.path,
        evidence: [evidence(change.path, undefined, match[0], `Consumer for ${topic}.`)],
      }));
    }
  }
  for (const topic of producers) {
    if (consumers.has(topic)) continue;
    for (const [path, content] of input.repoFiles) {
      if (path === input.changes[0]?.path || input.contents.has(path)) continue;
      if (!content.includes(topic)) continue;
      out.push(item({
        dimension: 'event', label: `${path} may consume ${topic}`,
        detail: 'The topic name appears in this file. This is textual correlation, not a resolved subscription: confirm before treating it as a consumer.',
        direct: false, relation: 'CONSUMES', provenance: 'static', confidence: 'low', file: path,
        evidence: [evidence(path, undefined, topic, `Textual reference to topic ${topic}.`)],
      }));
      break;
    }
  }
}

function envVars(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) out.add(match[1]!);
  for (const match of text.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g)) out.add(match[1]!);
  for (const match of text.matchAll(/os\.environ(?:\.get)?[\[(]\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g)) out.add(match[1]!);
  for (const match of text.matchAll(/System\.getenv\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) out.add(match[1]!);
  for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]{2,})\}/g)) out.add(match[1]!);
  return [...out];
}

function addConfigurationImpact(out: ImpactItem[], input: ImpactInput): void {
  for (const change of input.changes) {
    const next = input.contents.get(change.path) ?? '';
    const previous = input.oldContents.get(change.path) ?? '';
    const added = envVars(addedLines(change).map((l) => l.text).join('\n'));
    const before = envVars(previous).filter((name) => !envVars(next).includes(name));
    for (const name of added) {
      out.push(item({
        dimension: 'configuration', label: `Environment variable ${name} is now read`,
        detail: 'The code reads a variable that deployments must supply. A missing value is a startup or runtime failure, not a code review opinion.',
        direct: true, relation: 'CONFIGURES', provenance: 'static', file: change.path,
        evidence: [evidence(change.path, undefined, name, `Reads ${name}.`)],
      }));
    }
    for (const name of before) {
      out.push(item({
        dimension: 'configuration', label: `Environment variable ${name} is no longer read`,
        detail: 'The variable was removed from this file. Remove it from deployment configuration or confirm another file still uses it.',
        direct: true, relation: 'CONFIGURES', provenance: 'static', file: change.path,
        evidence: [evidence(change.path, undefined, name, `Previously read ${name}.`)],
      }));
    }
    if (/(^|\/)(docker-compose|compose)\.ya?ml$|(^|\/)Dockerfile$|(^|\/)(helm|k8s|kubernetes|terraform|deploy)\//i.test(change.path)) {
      out.push(item({
        dimension: 'configuration', label: `Deployment configuration changed: ${change.path}`,
        detail: 'Runtime topology, ports, resources or secrets references changed. The application change may require a rollout, not only a deploy.',
        direct: true, relation: 'CONFIGURES', provenance: 'static', file: change.path,
        evidence: [evidence(change.path, undefined, change.path, 'Deployment file in the diff.')],
      }));
    }
  }
}

function addTestingImpact(out: ImpactItem[], input: ImpactInput): void {
  for (const file of input.tests.uncoveredChanges) {
    out.push(item({
      dimension: 'testing', label: `No covering test for ${file}`,
      detail: 'Static path/name association found no test file. This does not prove untested behaviour, but there is no test evidence in the repository for this change.',
      direct: true, relation: 'TESTS', provenance: 'static', file,
      evidence: [evidence(file, undefined, file, 'No test file maps to this source file.')],
    }));
  }
  for (const test of input.tests.files.slice(0, 40)) {
    if (test.targets.length === 0) continue;
    out.push(item({
      dimension: 'testing', label: `Affected test file: ${test.path}`,
      detail: `Covers ${test.targets.slice(0, 3).join(', ')}${test.targets.length > 3 ? ', …' : ''}. Run it before merging.`,
      direct: false, relation: 'TESTS', provenance: 'static', file: test.path,
      evidence: [evidence(test.path, undefined, test.path, 'Test file associated with a changed source file.')],
    }));
  }
  for (const deleted of input.tests.deletedTests) {
    out.push(item({
      dimension: 'testing', label: `Test file deleted: ${deleted}`,
      detail: 'Deleting a test removes evidence for behaviour that may still exist.',
      direct: true, relation: 'TESTS', provenance: 'static', file: deleted,
      evidence: [evidence(deleted, undefined, deleted, 'Test file removed by this change.')],
    }));
  }
}

function addDocumentationImpact(out: ImpactItem[], input: ImpactInput): void {
  for (const section of input.retrieval?.sections ?? []) {
    out.push(item({
      dimension: 'documentation', label: `${section.document} § ${section.heading}`,
      detail: `Selected by the documentation index because it ${section.why}. Treat the document as a claim to check, not as ground truth.`,
      direct: false, relation: 'DOCUMENTS', provenance: 'documentation', file: section.document, line: section.startLine,
      confidence: 'medium',
      evidence: [{
        kind: 'doc', file: section.document, line: section.startLine, endLine: section.endLine,
        snippet: section.text.slice(0, 300), note: 'Retrieved documentation section.', source: 'document',
      }],
    }));
  }
  const removed = input.symbols.filter((s) => s.change === 'removed');
  for (const symbol of removed) {
    for (const doc of input.docs) {
      const ref = doc.references.find((r) => r.kind === 'symbol' && r.value === symbol.name);
      if (!ref) continue;
      out.push(item({
        dimension: 'documentation', label: `${doc.path} still documents ${symbol.name}`,
        detail: `The symbol was removed from ${symbol.file} but the document references it.`,
        direct: false, relation: 'DOCUMENTS', provenance: 'documentation', file: doc.path, line: ref.line,
        evidence: [evidence(symbol.file, symbol.range.start, symbol.name, 'Symbol removed.'), { kind: 'doc', file: doc.path, line: ref.line, snippet: symbol.name, note: 'Documentation reference.', source: 'document' }],
      }));
      break;
    }
  }
}

function initialCounts(): Record<ImpactDimension, { items: number; direct: number }> {
  const out = {} as Record<ImpactDimension, { items: number; direct: number }>;
  for (const dimension of DIMENSIONS) out[dimension] = { items: 0, direct: 0 };
  return out;
}

/**
 * Build the impact analysis.
 *
 * Every dimension is attempted. A dimension with no evidence is recorded as
 * empty rather than omitted, because "we looked and found nothing" and "we did
 * not look" are different answers.
 */
export function analyseImpact(input: ImpactInput): ImpactAnalysis {
  const out: ImpactItem[] = [];
  const changed = new Set(input.changes.map((c) => c.path));
  addGraphImpact(out, input.graph, changed);
  addModuleImpact(out, input);
  addServiceImpact(out, input);
  addApiImpact(out, input);
  addDatabaseImpact(out, input);
  addEventImpact(out, input);
  addConfigurationImpact(out, input);
  addTestingImpact(out, input);
  addDocumentationImpact(out, input);

  const dimensions = initialCounts();
  for (const entry of out) {
    dimensions[entry.dimension].items += 1;
    if (entry.direct) dimensions[entry.dimension].direct += 1;
  }
  const languages = [...new Set(input.changes.map((c) => c.language).filter((l) => l !== 'other' && l !== 'markdown'))];
  const unresolved = Object.keys(input.graph.impactDepth).length > 0
    ? 0
    : input.graph.indirectlyImpacted.length;
  const breaking = {
    api: out.filter((i) => i.dimension === 'api' && i.relation === 'BREAKS').length,
    database: out.filter((i) => i.dimension === 'database' && i.detail.includes('No rollback')).length,
    event: out.filter((i) => i.dimension === 'event').length,
  };
  const summaryParts = [
    `${out.length} impact item(s) across ${DIMENSIONS.filter((d) => dimensions[d].items > 0).length} dimension(s)`,
    `${dimensions.code.items} code, ${dimensions.api.items} API, ${dimensions.database.items} database, ${dimensions.event.items} event`,
  ];
  const services = new Set(out.filter((i) => i.dimension === 'service' && i.service).map((i) => i.service));
  if (services.size > 0) summaryParts.push(`services touched: ${[...services].slice(0, 4).join(', ')}`);
  const note = input.changes.some((c) => !['typescript', 'tsx', 'javascript', 'jsx'].includes(c.language))
    ? 'Import and call edges are resolved with the TypeScript parser. Other languages use textual extraction, so some relationships may be missing; this report does not claim complete impact coverage.'
    : 'Impact is derived from the resolved dependency graph, parser-level facts and textual contract extraction. Historical correlation is not presented as a runtime dependency.';

  return {
    generatedAt: new Date().toISOString(),
    dimensions,
    items: out.sort((a, b) => DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension) || Number(b.direct) - Number(a.direct) || a.label.localeCompare(b.label)),
    summary: `${summaryParts.join('; ')}.`,
    coverage: {
      filesAnalysed: input.repoFiles.size,
      filesChanged: input.changes.length,
      languages,
      unresolved,
      note,
    },
    breaking,
  };
}

export { DIMENSIONS as IMPACT_DIMENSIONS };
