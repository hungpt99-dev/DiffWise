import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  GitClient, JsonReviewStore, buildAgentContext, buildReviewEnvelope, makeAgentEvent, matchesAnyGlob,
} from '@diffwise/core';
import type { AgentEvent, ReviewReport, ReviewTarget } from '@diffwise/core';
import { DiffWiseService, ServiceError } from '@diffwise/app';
import { registerPlatformTools } from './tools/platform';

/**
 * DiffWise MCP server (interface version 1).
 *
 * Coding agents call these tools to record explicit engineering intent and to
 * read back the current change/review context. It deliberately does NOT expose
 * model reasoning: only structured statements the agent chooses to record.
 *
 * The transport is stdio, logs go to stderr, and every tool returns JSON text.
 */

export const MCP_INTERFACE_VERSION = 2;
export const SERVER_INFO = { name: 'diffwise-mcp', version: '0.3.0' } as const;

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/.diffwise/**'];

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }], isError: true };
}

export interface ServerContext {
  root: string;
  store: JsonReviewStore;
  service: DiffWiseService;
}

export async function openContext(root: string): Promise<ServerContext> {
  const abs = resolve(root);
  const git = new GitClient(abs);
  await git.assertRepo();
  const service = await DiffWiseService.create({ root: abs });
  return { root: abs, store: new JsonReviewStore(join(abs, '.diffwise')), service };
}

type RecordType = AgentEvent['type'];

function registerRecorder(
  server: McpServer,
  ctx: ServerContext,
  type: RecordType,
  name: string,
  title: string,
  description: string,
  options: { requiresFiles?: boolean } = {},
): void {
  const shape = {
    title: z.string().min(3).max(200).describe('One-line statement of what was decided, intended or observed.'),
    detail: z.string().min(3).max(8000).describe('Explicit engineering detail. Do not include hidden model reasoning or secrets.'),
    files: z.array(z.string()).optional().describe('Repository-relative files this record concerns.'),
    actor: z.string().max(80).optional().describe('Agent or person recording the event, e.g. claude-code.'),
    status: z.string().max(40).optional().describe('Optional status such as passed, failed, partial or blocked.'),
  };
  server.registerTool(
    name,
    {
      title,
      description: `${description} Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const files = (args.files ?? []).filter((f) => typeof f === 'string' && !f.includes('..'));
        if (options.requiresFiles && files.length === 0) {
          return errorResult('At least one file is required for this record type.');
        }
        const event = makeAgentEvent(type, args.title, args.detail, {
          ...(files.length ? { files } : {}),
          ...(args.actor ? { actor: args.actor } : {}),
          ...(args.status ? { status: args.status } : {}),
          metadata: { recordedVia: 'mcp', interfaceVersion: MCP_INTERFACE_VERSION },
        });
        await ctx.store.appendAgentEvent(event);
        return jsonResult({ ok: true, id: event.id, createdAt: event.createdAt, type: event.type });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );
}

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer(SERVER_INFO);

  registerRecorder(server, ctx, 'task_intent', 'record_task_intent',
    'Record task intent',
    'Record what the developer asked for, before implementation. This is the reference used to judge intent-versus-implementation alignment.');
  registerRecorder(server, ctx, 'plan', 'record_plan',
    'Record implementation plan',
    'Record the planned steps and the files each step is expected to touch.');
  registerRecorder(server, ctx, 'decision', 'record_decision',
    'Record engineering decision',
    'Record a design decision that shaped the implementation, including what it rules out.');
  registerRecorder(server, ctx, 'alternative', 'record_alternative',
    'Record rejected alternative',
    'Record an option that was considered and rejected, and why.');
  registerRecorder(server, ctx, 'constraint', 'record_constraint',
    'Record constraint',
    'Record a constraint the implementation must respect (compatibility, dependencies, performance, policy).');
  registerRecorder(server, ctx, 'activity', 'record_activity',
    'Record activity / command',
    'Record a tool, command or action the agent performed, with its outcome status.');
  registerRecorder(server, ctx, 'verification', 'record_verification',
    'Record verification evidence',
    'Record a verification result (typecheck, tests, manual check). State exactly what ran and what did not; never claim unexecuted tests passed.');
  registerRecorder(server, ctx, 'unresolved_issue', 'record_unresolved_issue',
    'Record unresolved issue',
    'Record work that is knowingly incomplete or unverified so the review can surface it.');

  server.registerTool(
    'get_change_context',
    {
      title: 'Get current change context',
      description: `Return the current git status, changed files and recorded agent events for this repository. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: {
        includeContent: z.boolean().optional().describe('Include the unified diff per file (bounded).'),
        maxFiles: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const git = new GitClient(ctx.root);
        const info = await git.info();
        const { changes } = await git.diff({ mode: 'working', label: 'Working tree' });
        const events = await ctx.store.readAgentEvents();
        const limit = args.maxFiles ?? 40;
        return jsonResult({
          repo: { name: info.name, branch: info.branch, head: info.headCommit.slice(0, 12), headSubject: info.headSubject, files: info.fileCount, languages: info.languages.slice(0, 5) },
          change: {
            files: changes.slice(0, limit).map((c) => ({
              path: c.path, status: c.status, additions: c.additions, deletions: c.deletions, language: c.language,
              ...(args.includeContent ? { patch: c.patch.slice(0, 4000) } : {}),
            })),
            totalFiles: changes.length,
            truncated: changes.length > limit,
          },
          agent: {
            events: events.slice(-40),
            intents: events.filter((e) => e.type === 'task_intent').slice(-3),
            unresolved: events.filter((e) => e.type === 'unresolved_issue').slice(-5),
          },
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    'get_review_context',
    {
      title: 'Get latest review context',
      description: `Return the most recent DiffWise review report summary, findings and completeness. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: {
        reviewId: z.string().optional().describe('Specific review id; defaults to the most recent.'),
        includeFindings: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const id = args.reviewId ?? (await ctx.store.listReviews(1))[0]?.id;
        if (!id) return errorResult('No review has been persisted in this repository yet. Run "DiffWise: Review Current Changes" first.');
        const report = await ctx.store.loadReport(id);
        if (!report) return errorResult(`Review ${id} not found.`);
        return jsonResult(compactReport(report, args.includeFindings ?? true));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    'get_related_decisions',
    {
      title: 'Get related decisions',
      description: `Find recorded decisions, alternatives, constraints and unresolved issues related to given files or a query. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: {
        files: z.array(z.string()).optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const events = await ctx.store.readAgentEvents();
        const relevant = events.filter((e) => ['decision', 'alternative', 'constraint', 'unresolved_issue'].includes(e.type));
        const files = args.files ?? [];
        const query = (args.query ?? '').toLowerCase().trim();
        const scored = relevant.map((e) => {
          let score = 0;
          if (files.length && (e.files ?? []).some((f) => files.some((q) => f.includes(q) || q.includes(f)))) score += 3;
          if (query) {
            const haystack = `${e.title} ${e.detail} ${(e.files ?? []).join(' ')}`.toLowerCase();
            for (const term of query.split(/\s+/).filter((t) => t.length > 2)) if (haystack.includes(term)) score += 1;
          }
          return { score, event: e };
        }).filter((x) => x.score > 0 || (files.length === 0 && !query));
        scored.sort((a, b) => b.score - a.score);
        const limit = args.limit ?? 10;
        return jsonResult({ ok: true, count: scored.length, events: scored.slice(0, limit).map((x) => ({ ...x.event, relevance: x.score })) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    'search_project_knowledge',
    {
      title: 'Search project knowledge',
      description: `Search repository documentation, recorded decisions and the latest review for a query. Returns snippets with paths, never generated text. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: {
        query: z.string().min(2),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const matches = await searchKnowledge(ctx, args.query, args.limit ?? 8);
        return jsonResult({ ok: true, query: args.query, count: matches.length, matches });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Review / fix / verification tools (application services, same code path as
  // the CLI). Every mutating tool states its safety contract in the schema.
  // ---------------------------------------------------------------------------

  server.registerTool(
    'run_review',
    {
      title: 'Run a DiffWise review',
      description: `Run the full review pipeline for this repository and return the versioned JSON envelope (schemaVersion "1.0"). AI is used only when a provider is configured and ai is not false. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: {
        mode: z.enum(['working', 'staged', 'branch', 'commits']).optional().describe('Default: working tree.'),
        base: z.string().optional().describe('Base revision, for mode="branch" or "commits".'),
        head: z.string().optional().describe('Head revision, for mode="branch".'),
        paths: z.array(z.string()).optional().describe('Limit the review to these repository-relative paths.'),
        ai: z.boolean().optional().describe('Force AI interpretation on (true) or off (false).'),
        maxCostUsd: z.number().min(0).optional().describe('Cost ceiling for this run. The review still completes and is persisted; the response reports whether the ceiling was exceeded. Requires a pricing table in .diffwise/config.json.'),
      },
      // A review writes a report to disk and may call a provider: not read-only.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const target: ReviewTarget = args.mode === 'branch' && args.base
          ? { mode: 'branch', base: args.base, head: args.head ?? 'HEAD', label: `${args.base}..${args.head ?? 'HEAD'}` }
          : args.mode === 'staged'
            ? { mode: 'staged', label: 'Staged changes' }
            : args.mode === 'commits' && args.base
              ? { mode: 'commits', base: `${args.base}^`, head: args.base, label: `commit ${args.base}` }
              : args.paths?.length
                ? { mode: 'files', paths: args.paths, head: 'HEAD', label: `${args.paths.length} path(s)` }
                : { mode: 'working', label: 'Working tree' };
        const result = await ctx.service.review({
          target,
          ...(args.ai === false ? { disableAi: true } : {}),
          ...(args.ai === true ? { enableAi: true } : {}),
        });
        const envelope = buildReviewEnvelope(result.report);
        if (args.maxCostUsd === undefined) return jsonResult(envelope);
        // A ceiling is reported, not enforced by throwing: the review is already
        // computed and persisted, and the agent needs the data plus a clear
        // signal to decide what to do next.
        const spent = result.report.ai?.estimatedCostUsd;
        const costLimit = spent === undefined
          ? { maxCostUsd: args.maxCostUsd, evaluated: false, reason: 'no priced usage: no model call ran, or no pricing table is configured' }
          : { maxCostUsd: args.maxCostUsd, evaluated: true, exceeded: spent > args.maxCostUsd, costUsd: spent };
        return jsonResult({ ...envelope, costLimit });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    'get_findings',
    {
      title: 'Get findings',
      description: `Return findings from a stored review with stable ids, severity, location and evidence counts. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: {
        reviewId: z.string().optional().describe('Defaults to the most recent review.'),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional().describe('Minimum severity.'),
        category: z.string().optional(),
        max: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const report = await ctx.service.loadReview(args.reviewId ?? 'latest');
        const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
        let findings = report.findings;
        if (args.severity) {
          const limit = rank[args.severity] ?? 4;
          findings = findings.filter((f) => (rank[f.severity] ?? 4) <= limit);
        }
        if (args.category) findings = findings.filter((f) => f.category === args.category);
        const max = args.max ?? 50;
        return jsonResult({
          schemaVersion: '1.0',
          reviewId: report.id,
          status: report.summary.completeness,
          total: report.findings.length,
          count: Math.min(findings.length, max),
          findings: findings.slice(0, max).map((f) => ({
            id: f.id, severity: f.severity, category: f.category, kind: f.kind, confidence: f.confidence,
            title: f.title, file: f.file, range: f.range, evidenceCount: f.evidence.length,
            recommendation: f.recommendation, source: f.source,
          })),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    'get_finding',
    {
      title: 'Get one finding with evidence',
      description: `Return a finding with its full evidence (file, line, exact excerpt) and any fix options. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: { findingId: z.string().describe('Stable finding id, e.g. DW-1a2b3c4d5e.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const { report, finding } = await ctx.service.findByFinding(args.findingId);
        return jsonResult({
          schemaVersion: '1.0',
          reviewId: report.id,
          finding,
          fixes: report.fixes.filter((f) => f.findingId === finding.id).map((f) => ({
            id: f.id, label: f.label, approach: f.approach, complexity: f.complexity,
            files: f.filesAffected, applies: f.patch?.validation.applies ?? null, source: f.source,
          })),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    'suggest_fixes',
    {
      title: 'Suggest fixes for a finding',
      description: `Return fix options for a finding. Patches are validated against the working tree; nothing is applied. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: {
        findingId: z.string(),
        generate: z.boolean().optional().describe('Ask the model for a new patch when a provider is configured.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await ctx.service.fixOptions(args.findingId, { generate: args.generate ?? false });
        return jsonResult({
          schemaVersion: '1.0',
          findingId: result.finding.id,
          warnings: result.warnings,
          fixes: result.fixes.map((f) => ({
            id: f.id, label: f.label, approach: f.approach, description: f.description,
            filesAffected: f.filesAffected, complexity: f.complexity, source: f.source,
            applies: f.patch?.validation.applies ?? null,
            patch: f.patch ? { diff: f.patch.diff, validation: f.patch.validation } : null,
          })),
          recommendation: result.finding.recommendation,
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerTool(
    'apply_fix',
    {
      title: 'Apply an approved fix',
      description: `Apply a fix patch to the working tree. Requires approved=true AND confirmFindingId equal to findingId, so an agent cannot apply a patch it was not asked to apply. The patch is re-validated and hash-pinned before writing; a journal enables rollback. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: {
        findingId: z.string(),
        solutionId: z.string(),
        approved: z.literal(true).describe('Must be true: the developer approved this specific fix.'),
        confirmFindingId: z.string().describe('Must equal findingId.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        if (args.confirmFindingId !== args.findingId) {
          return errorResult('confirmFindingId must equal findingId.');
        }
        const result = await ctx.service.applyFix({
          findingId: args.findingId,
          solutionId: args.solutionId,
          approved: args.approved === true,
        });
        return jsonResult({
          schemaVersion: '1.0',
          ok: result.applied.applied,
          files: result.applied.files,
          backupDir: result.applied.backupDir,
          errors: result.applied.errors,
          reviewId: result.report.id,
          next: 'Run run_verification, then run_review again to confirm the finding is resolved.',
        });
      } catch (err) {
        return errorResult(err instanceof ServiceError ? `${err.code}: ${err.message}` : (err as Error).message);
      }
    },
  );

  server.registerTool(
    'run_verification',
    {
      title: 'Run the configured verification command',
      description: `Execute verification.command from .diffwise/config.json, record the real result, and return it. Returns status "not-run" when no command is configured — never a fabricated pass. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: { findingId: z.string().optional().describe('Record the run against this finding.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await ctx.service.verify({ ...(args.findingId ? { findingId: args.findingId } : {}) });
        return jsonResult({
          schemaVersion: '1.0',
          ok: result.execution.status === 'passed',
          status: result.execution.status,
          execution: result.execution,
          reviewId: result.report.id,
        });
      } catch (err) {
        return errorResult(err instanceof ServiceError ? `${err.code}: ${err.message}` : (err as Error).message);
      }
    },
  );

  server.registerTool(
    'compare_reviews',
    {
      title: 'Compare two reviews',
      description: `Compare two stored reviews and report resolved, introduced and still-present findings. Interface v${MCP_INTERFACE_VERSION}.`,
      inputSchema: {
        left: z.string().describe('Review id, or "latest"/"previous".'),
        right: z.string().optional().describe('Defaults to "latest".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await ctx.service.compare(args.left, args.right ?? 'latest');
        const brief = (f: { id: string; title: string; severity: string; file: string }): unknown => ({
          id: f.id, title: f.title, severity: f.severity, file: f.file,
        });
        return jsonResult({
          schemaVersion: '1.0',
          left: { id: result.left.id, risk: result.left.risk.score, findings: result.left.findings.length },
          right: { id: result.right.id, risk: result.right.risk.score, findings: result.right.findings.length },
          delta: result.summary,
          resolved: result.resolved.map(brief),
          introduced: result.introduced.map(brief),
          persisted: result.persisted.map(brief),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  server.registerResource(
    'latest-review',
    'diffwise://review/latest',
    {
      title: 'Latest DiffWise review',
      description: 'Compact JSON of the most recent review, including completeness and findings.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const id = (await ctx.store.listReviews(1))[0]?.id;
      if (!id) return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'No review available' }) }] };
      const report = await ctx.store.loadReport(id);
      return { contents: [{ uri: uri.href, text: JSON.stringify(report ? compactReport(report, true) : { error: 'Review not found' }) }] };
    },
  );

  // Interface v2: additive platform tools. v1 tools above keep their contracts.
  registerPlatformTools(server, ctx);

  return server;
}

function compactReport(report: ReviewReport, includeFindings: boolean): unknown {
  return {
    schemaVersion: '1.0',
    id: report.id,
    createdAt: report.createdAt,
    target: report.target,
    repository: { name: report.repository.name, branch: report.repository.branch, head: report.repository.headCommit.slice(0, 12) },
    completeness: report.summary.completeness,
    ...(report.summary.completenessNote ? { completenessNote: report.summary.completenessNote } : {}),
    summary: report.summary,
    risk: { score: report.risk.score, level: report.risk.level, summary: report.risk.summary, factors: report.risk.factors.map((f) => ({ id: f.id, label: f.label, points: f.points, explanation: f.explanation })) },
    stages: report.stages.map((s) => ({ id: s.id, status: s.status, error: s.error })),
    changes: report.changes.map((c) => ({ path: c.path, status: c.status, additions: c.additions, deletions: c.deletions })),
    documentation: report.documentation.findings.map((d) => ({ document: d.document, status: d.status, title: d.title })),
    tests: { uncovered: report.tests.uncoveredChanges, deleted: report.tests.deletedTests, execution: report.tests.execution ?? null },
    agent: { intents: report.agent.intents, decisions: report.agent.decisions, unresolved: report.agent.unresolved, alignment: report.agent.intentAlignment },
    ...(includeFindings ? {
      findings: report.findings.map((f) => ({
        id: f.id, severity: f.severity, category: f.category, kind: f.kind, confidence: f.confidence,
        title: f.title, file: f.file, range: f.range, source: f.source,
        evidence: f.evidence.map((e) => ({ file: e.file, line: e.line, note: e.note })),
        recommendation: f.recommendation,
      })),
      fixes: report.fixes.map((f) => ({ id: f.id, findingId: f.findingId, label: f.label, complexity: f.complexity, applies: f.patch?.validation.applies ?? false })),
    } : {}),
  };
}

interface KnowledgeMatch { source: string; path?: string; kind: string; text: string; score: number }

async function searchKnowledge(ctx: ServerContext, query: string, limit: number): Promise<KnowledgeMatch[]> {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const matches: KnowledgeMatch[] = [];
  const files = await listFiles(ctx.root, 400);
  for (const path of files) {
    if (matchesAnyGlob(path, IGNORE)) continue;
    if (!/\.(md|mdx|ya?ml|txt|json)$/i.test(path) && !/(^|\/)(README|CONTRIBUTING|SECURITY|ARCHITECTURE)/i.test(path)) continue;
    try {
      const content = await readFile(join(ctx.root, path), 'utf8');
      if (content.length > 300_000) continue;
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        const lower = line.toLowerCase();
        let score = 0;
        for (const t of terms) if (lower.includes(t)) score += 1;
        if (score > 0) {
          matches.push({ source: 'document', path, kind: 'doc', text: `L${idx + 1}: ${line.trim().slice(0, 300)}`, score });
        }
      });
    } catch {
      // unreadable; skip
    }
  }
  const events = await ctx.store.readAgentEvents();
  for (const e of events) {
    const hay = `${e.title} ${e.detail} ${(e.files ?? []).join(' ')}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 2;
    if (score > 0) matches.push({ source: 'agent-record', kind: e.type, text: `${e.title}: ${e.detail.slice(0, 300)}`, score });
  }
  const latest = (await ctx.store.listReviews(1))[0];
  if (latest) {
    const report = await ctx.store.loadReport(latest.id);
    for (const item of report?.knowledge ?? []) {
      const hay = `${item.title} ${item.text}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      if (score > 0) matches.push({ source: 'review-knowledge', path: item.path, kind: item.kind, text: `${item.title}: ${item.text.slice(0, 300)}`, score });
    }
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function listFiles(root: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.diffwise') continue;
      const rel = join(dir, entry.name).slice(root.length + 1).replace(/\\/g, '/');
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else out.push(rel);
    }
  };
  await walk(root);
  return out;
}

export async function startStdioServer(root: string): Promise<void> {
  const ctx = await openContext(root);
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`diffwise-mcp v${SERVER_INFO.version} ready (interface v${MCP_INTERFACE_VERSION}) for ${ctx.root}\n`);
  // Keep the process alive until the transport closes.
  await new Promise<void>((resolvePromise) => {
    transport.onclose = () => resolvePromise();
  });
}

/** Summarise recorded agent events for the extension's sidebar. */
export function summarizeAgentEvents(events: AgentEvent[]): ReturnType<typeof buildAgentContext> {
  return buildAgentContext(events, []);
}
