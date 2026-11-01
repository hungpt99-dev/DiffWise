/**
 * Local report server.
 *
 * Optional, localhost-only, and short-lived: it exists so the interactive parts
 * of the web report (chat, fix preview/apply, verification) can work without a
 * cloud service. Security properties, all enforced here rather than in the UI:
 *
 *   - binds 127.0.0.1 unless a host is explicitly configured;
 *   - a random per-run token is required once, exchanged for an HttpOnly,
 *     SameSite=Strict cookie, so the token does not stay in the URL;
 *   - mutating requests need a custom header (cross-origin pages cannot send it
 *     without a preflight this server never grants) plus a matching Origin;
 *   - static files are resolved inside the built asset directory only;
 *   - source reads are restricted to the workspace and to report-referenced
 *     paths, and are capped in size;
 *   - no response ever contains the provider API key;
 *   - a strict CSP and no frame embedding.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { ReviewReport, ReviewTarget } from '@diffwise/core';
import { loadWebAssets, CSP, type WebAssets } from './assets';
import { resolveInside } from './repo';
import { ServiceError, type DiffWiseService } from './service';

export interface ServerOptions {
  service: DiffWiseService;
  /** Defaults to 127.0.0.1. Non-loopback hosts require `allowPublic: true`. */
  host?: string;
  port?: number;
  /** Open on an OS-assigned port. Default 4700 when free. */
  allowPublic?: boolean;
  /** Print nothing; the CLI decides what to log. */
  quiet?: boolean;
  /** Optional fixed token (tests); otherwise random per run. */
  token?: string;
}

export interface RunningServer {
  url: string;
  token: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

const MAX_BODY = 1_000_000;

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
  });
  res.end(payload);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectPromise(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolvePromise({}); return; }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(new HttpError(400, 'Request body must be JSON.'));
      }
    });
    req.on('error', (err) => rejectPromise(new HttpError(400, err.message)));
  });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** Convert the project config into the settings shape the report UI expects. */
export function uiSettingsFor(service: DiffWiseService): {
  providerId: string; baseUrl: string; model: string; apiKeyEnvVar: string; apiKeyPresent: boolean;
  maxTokens: number; temperature: number; timeoutMs: number; aiEnabled: boolean;
  sendRepositoryContent: boolean; verificationCommand: string; maxFiles: number;
  extraHeaders: Record<string, string>;
  readOnly: boolean;
} {
  const p = service.providers();
  return {
    providerId: service.config.provider.id,
    baseUrl: service.config.provider.baseUrl,
    model: service.config.provider.model,
    apiKeyEnvVar: service.config.provider.apiKeyEnvVar,
    apiKeyPresent: p.apiKeyPresent,
    maxTokens: service.config.provider.maxTokens,
    temperature: service.config.provider.temperature,
    timeoutMs: service.config.provider.timeoutMs,
    aiEnabled: service.config.ai.enabled,
    sendRepositoryContent: service.config.ai.sendRepositoryContent,
    verificationCommand: service.config.verification.command,
    maxFiles: service.config.analysis.maxFiles,
    extraHeaders: service.config.provider.extraHeaders ?? {},
    readOnly: false,
  };
}

export async function startReportServer(options: ServerOptions): Promise<RunningServer> {
  const { service } = options;
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host) && !options.allowPublic) {
    throw new Error(`Refusing to bind ${host}: a non-loopback report server exposes repository data. Pass --allow-public only when you intend that.`);
  }
  const assets: WebAssets = await loadWebAssets();
  const token = options.token ?? randomBytes(24).toString('hex');
  const session = createHash('sha256').update(token).digest('hex');
  const port = options.port ?? 4700;

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (res.headersSent) { res.end(); return; }
      json(res, status, { ok: false, error: (err as Error).message });
    });
  });

  async function authorised(req: IncomingMessage): Promise<boolean> {
    return cookieValue(req, 'dw_session') === session;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;

    // Token exchange. The token is only accepted on the document route.
    if (path === '/' && req.method === 'GET') {
      const supplied = url.searchParams.get('token');
      if (supplied) {
        if (supplied !== token) { html(res, 403, simplePage('Invalid session token', 'The token in this URL is not the one issued by this DiffWise server.')); return; }
        res.writeHead(302, {
          'Set-Cookie': `dw_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
          Location: '/',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      if (!(await authorised(req))) {
        html(res, 401, simplePage('Session required', 'Open the URL printed by "diffwise report --serve", including its token, to start a session.'));
        return;
      }
      const injected = assets.indexHtml.replace('</head>',
        '<script>window.__DIFFWISE_SERVER__ = { mode: "server" };</script></head>');
      html(res, 200, injected);
      return;
    }

    if (path === '/source' && req.method === 'GET') {
      if (!(await authorised(req))) {
        html(res, 401, simplePage('Session required', 'Open the URL printed by "diffwise report --serve" first.'));
        return;
      }
      const rel = url.searchParams.get('path') ?? '';
      const report = await service.loadReview(url.searchParams.get('review') ?? 'latest');
      if (!report.changes.some((c) => c.path === rel)) throw new HttpError(403, 'Only files in the current review can be opened.');
      const abs = resolveInside(service.root, rel);
      if (!abs) throw new HttpError(403, 'Path escapes the workspace.');
      try {
        const content = await readFile(abs, 'utf8');
        const focus = Number(url.searchParams.get('line') ?? 0);
        const end = Number(url.searchParams.get('end') ?? 0);
        html(res, 200, sourcePage(rel, content, focus, end));
      } catch {
        html(res, 404, simplePage('File unavailable', `${rel} is not present in the working tree. DiffWise does not fabricate file contents.`));
      }
      return;
    }

    if (path.startsWith('/assets/')) {
      const rel = normalize(path.slice('/assets/'.length));
      const abs = resolve(assets.dir, rel);
      if (!abs.startsWith(assets.dir.endsWith(sep) ? assets.dir : `${assets.dir}${sep}`)) {
        throw new HttpError(403, 'Forbidden.');
      }
      try {
        const content = await readFile(abs);
        const type = contentTypeFor(abs);
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': content.length,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': CSP,
        });
        res.end(content);
      } catch {
        throw new HttpError(404, 'Asset not found.');
      }
      return;
    }

    // Everything below is API and requires a session.
    if (!path.startsWith('/api/')) throw new HttpError(404, 'Not found.');
    if (!(await authorised(req))) throw new HttpError(401, 'Session required.');

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const expected = `http://${host}:${port}`;
      if (origin && origin !== expected && origin !== `http://localhost:${port}`) {
        throw new HttpError(403, 'Cross-origin request refused.');
      }
      if (req.headers['x-diffwise-request'] !== '1') {
        throw new HttpError(403, 'Missing X-DiffWise-Request header.');
      }
    }

    switch (`${req.method} ${path}`) {
      case 'GET /api/health':
        json(res, 200, {
          ok: true,
          tool: 'diffwise',
          root: service.root,
          provider: { id: service.config.provider.id, model: service.config.provider.model, keyPresent: service.providers().apiKeyPresent },
        });
        return;
      case 'GET /api/bootstrap': {
        const report = await service.latestReview();
        const history = await service.listReviews(20);
        json(res, 200, {
          ok: true,
          report,
          history,
          settings: uiSettingsFor(service),
          appliedFixes: report?.appliedFixes ?? [],
          verification: report?.tests.execution ?? null,
        });
        return;
      }
      case 'GET /api/history': {
        json(res, 200, { ok: true, history: await service.listReviews(50) });
        return;
      }
      case 'GET /api/source': {
        const rel = url.searchParams.get('path') ?? '';
        const report = await service.loadReview(url.searchParams.get('review') ?? 'latest');
        const changed = new Set(report.changes.map((c) => c.path));
        if (!changed.has(rel)) throw new HttpError(403, 'Only files in the current review can be opened.');
        const abs = resolveInside(service.root, rel);
        if (!abs) throw new HttpError(403, 'Path escapes the workspace.');
        try {
          const content = await readFile(abs, 'utf8');
          const lines = content.split('\n');
          const start = Math.max(1, Number(url.searchParams.get('start') ?? 1));
          const end = Math.min(lines.length, Number(url.searchParams.get('end') ?? start + 200));
          json(res, 200, {
            ok: true, path: rel, start, end, totalLines: lines.length,
            lines: lines.slice(start - 1, end),
          });
        } catch {
          json(res, 404, { ok: false, error: 'The file is not present in the working tree (deleted or unavailable).' });
        }
        return;
      }
      case 'POST /api/review': {
        const body = (await readBody(req)) as { target?: ReviewTarget };
        const target = body.target;
        if (!target || typeof target.label !== 'string') throw new HttpError(400, 'A review target is required.');
        try {
          const result = await service.review({ target });
          json(res, 200, {
            ok: true,
            report: result.report,
            history: await service.listReviews(20),
            settings: uiSettingsFor(service),
          });
        } catch (err) {
          json(res, 422, { ok: false, error: (err as Error).message, kind: (err as Error).name });
        }
        return;
      }
      case 'POST /api/open-review': {
        const body = (await readBody(req)) as { id?: string };
        if (!body.id) throw new HttpError(400, 'id is required.');
        const report = await service.loadReview(body.id);
        json(res, 200, {
          ok: true, report,
          history: await service.listReviews(20),
          settings: uiSettingsFor(service),
          appliedFixes: report.appliedFixes,
        });
        return;
      }
      case 'POST /api/chat': {
        const body = (await readBody(req)) as { question?: string; findingId?: string; history?: never };
        if (!body.question?.trim()) throw new HttpError(400, 'A question is required.');
        try {
          const result = await service.chat({
            question: body.question,
            ...(body.findingId ? { findingId: body.findingId } : {}),
            ...(Array.isArray(body.history) ? { history: body.history } : {}),
          });
          json(res, 200, {
            ok: true,
            answer: {
              answer: result.answer.answer,
              citations: result.answer.citations,
              confidence: result.answer.confidence,
              caveats: result.answer.caveats,
              suggestedQuestions: result.answer.suggestedQuestions,
              invalidCitations: result.answer.invalidCitations,
            },
            model: result.model,
            provider: result.provider,
          });
        } catch (err) {
          json(res, err instanceof ServiceError && err.code === 'NO_PROVIDER' ? 503 : 502, {
            ok: false,
            error: (err as Error).message,
            kind: err instanceof ServiceError ? err.code : 'CHAT_FAILED',
          });
        }
        return;
      }
      case 'POST /api/fix/generate': {
        const body = (await readBody(req)) as { findingId?: string };
        if (!body.findingId) throw new HttpError(400, 'findingId is required.');
        const result = await service.fixOptions(body.findingId, { generate: true });
        json(res, 200, { ok: true, fixes: result.fixes, warnings: result.warnings });
        return;
      }
      case 'POST /api/fix/preview': {
        const body = (await readBody(req)) as { findingId?: string; solutionId?: string };
        if (!body.findingId || !body.solutionId) throw new HttpError(400, 'findingId and solutionId are required.');
        const { fix, preview } = await service.previewFix(body.findingId, body.solutionId);
        json(res, 200, {
          ok: true,
          fix: { id: fix.id, label: fix.label, description: fix.description, approach: fix.approach, complexity: fix.complexity },
          preview,
        });
        return;
      }
      case 'POST /api/fix/apply': {
        const body = (await readBody(req)) as { findingId?: string; solutionId?: string; approved?: boolean };
        if (!body.findingId || !body.solutionId) throw new HttpError(400, 'findingId and solutionId are required.');
        const result = await service.applyFix({
          findingId: body.findingId,
          solutionId: body.solutionId,
          approved: body.approved === true,
        });
        json(res, 200, {
          ok: result.applied.applied,
          applied: result.applied,
          report: result.report,
          error: result.applied.errors[0],
        });
        return;
      }
      case 'POST /api/fix/rollback': {
        const body = (await readBody(req)) as { appliedFixId?: string };
        if (!body.appliedFixId) throw new HttpError(400, 'appliedFixId is required.');
        const result = await service.rollback(body.appliedFixId);
        json(res, 200, { ok: result.errors.length === 0, reverted: result.reverted, errors: result.errors, report: result.report });
        return;
      }
      case 'POST /api/verify': {
        const body = (await readBody(req)) as { findingId?: string };
        const result = await service.verify({
          ...(body.findingId ? { findingId: body.findingId } : {}),
        });
        json(res, 200, { ok: true, execution: result.execution, report: result.report, record: result.record });
        return;
      }
      default:
        throw new HttpError(404, `No route for ${req.method} ${path}.`);
    }
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}/?token=${token}`,
    token,
    port: boundPort,
    host,
    close: async () => {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      server.closeAllConnections?.();
    },
  };
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function simplePage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0b0d12;color:#e6e9ef;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:34rem;padding:2rem;border:1px solid #232833;border-radius:12px;background:#11141b}h1{font-size:1.1rem;margin:0 0 .6rem}p{color:#9aa3b2;line-height:1.6;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

/**
 * Read-only source viewer for a file referenced by the current review.
 *
 * Rendering happens on the server so the browser never gets a filesystem path
 * it can mutate; the focus line is highlighted and context is bounded.
 */
function sourcePage(path: string, content: string, focusLine: number, focusEnd: number): string {
  const lines = content.split('\n');
  const escape = (s: string): string => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const from = focusLine > 0 ? Math.max(1, focusLine - 12) : 1;
  const to = Math.min(lines.length, focusLine > 0 ? Math.max(focusEnd, focusLine) + 40 : 400);
  const body = lines.slice(from - 1, to).map((line, i) => {
    const n = from + i;
    const hot = focusLine > 0 && n >= focusLine && n <= Math.max(focusEnd, focusLine);
    return `<tr class="${hot ? 'hot' : ''}"><td class="n">${n}</td><td class="l">${escape(line) || '&nbsp;'}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(path)} — DiffWise</title>
<style>
body{margin:0;background:#0b0d12;color:#e6e9ef;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
header{position:sticky;top:0;background:#11141b;border-bottom:1px solid #232833;padding:.7rem 1rem;display:flex;gap:1rem;align-items:baseline}
header b{font-family:ui-sans-serif,system-ui,sans-serif;font-size:.95rem}
header span{color:#8b94a7;font-size:.78rem}
table{border-collapse:collapse;width:100%}
td.n{width:4rem;text-align:right;padding:0 .8rem;color:#5b6376;user-select:none;border-right:1px solid #1b202b;vertical-align:top}
td.l{white-space:pre-wrap;padding:0 .8rem;line-height:1.55}
tr.hot{background:rgba(255,199,80,.10)}
tr.hot td.n{color:#ffc750}
</style></head><body>
<header><b>${escape(path)}</b><span>lines ${from}–${to} of ${lines.length} · read-only</span></header>
<table>${body}</table></body></html>`;
}

/** Report a port conflict in a way a developer can act on. */
export function describeListenError(err: NodeJS.ErrnoException): string {
  if (err.code === 'EADDRINUSE') return 'Port is already in use. Pass --port to choose another one.';
  if (err.code === 'EACCES') return 'Permission denied for that port. Ports below 1024 need privileges; use --port 4700 or higher.';
  return err.message;
}

/** Utility used by tests: wait until the server answers /api/health. */
export async function waitForServer(url: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const base = url.split('/?token=')[0];
  const token = url.split('/?token=')[1] ?? '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
      const cookie = res.headers.get('set-cookie');
      if (cookie) {
        const health = await fetch(`${base}/api/health`, { headers: { cookie: cookie.split(';')[0] ?? '' } });
        if (health.ok) return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Exported for tests that assert the workspace boundary. */
export function staticPathWithin(dir: string, candidate: string): boolean {
  const base = resolve(dir);
  const abs = resolve(join(base, candidate));
  return abs === base || abs.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

export type { ReviewReport };
