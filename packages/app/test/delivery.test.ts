import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiffWiseService, startReportServer, uiSettingsFor, type RunningServer } from '../src';
import { buildStandaloneHtml } from '../src/html';
import { cleanup, makeDemoRepo } from './helpers';

/**
 * Delivery tests: the local server and the standalone export.
 *
 * These exercise real HTTP against a real repository and a real report, and
 * assert the security properties the UI depends on (session, origin, path
 * traversal, workspace boundary, no credential leakage).
 */
describe('local report server', () => {
  let root: string;
  let service: DiffWiseService;
  let server: RunningServer;
  let cookie = '';

  beforeAll(async () => {
    root = await makeDemoRepo();
    service = await DiffWiseService.create({ root, env: { ...process.env, DIFFWISE_AI: 'off' } });
    await service.review({
      target: { mode: 'branch', base: 'main', head: 'feature/partial-refunds', label: 'main..feature/partial-refunds' },
      disableAi: true,
    });
    server = await startReportServer({ service, port: 0 });
    const res = await fetch(server.url, { redirect: 'manual' });
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }, 180_000);

  afterAll(async () => {
    if (server) await server.close();
    if (root) await cleanup(root);
  });

  const api = (path: string, init: RequestInit = {}): Promise<Response> => fetch(
    `http://${server.host}:${server.port}${path}`,
    { ...init, headers: { cookie, 'X-DiffWise-Request': '1', 'Content-Type': 'application/json', ...(init.headers ?? {}) } },
  );

  it('binds loopback and issues a session cookie from the one-time token', async () => {
    expect(server.host).toBe('127.0.0.1');
    expect(server.url).toContain('token=');
    expect(cookie).toMatch(/^dw_session=/);
  });

  it('refuses the document without a session', async () => {
    const res = await fetch(`http://${server.host}:${server.port}/`);
    expect(res.status).toBe(401);
  });

  it('serves the app shell with a strict CSP and the server marker', async () => {
    const res = await fetch(`http://${server.host}:${server.port}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('__DIFFWISE_SERVER__');
  });

  it('reports provider state without leaking credentials', async () => {
    const res = await api('/api/health');
    const body = await res.json() as { provider: Record<string, unknown> };
    expect(body.provider.keyPresent).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/sk-|api[_-]?key"\s*:\s*"/i);
  });

  it('returns the real report in bootstrap', async () => {
    const res = await api('/api/bootstrap');
    const body = await res.json() as { report: { findings: unknown[]; id: string } | null; settings: { readOnly: boolean } };
    expect(res.status).toBe(200);
    expect(body.report?.findings.length).toBeGreaterThan(0);
    expect(body.settings.readOnly).toBe(false);
  });

  it('rejects mutating requests without the custom header (CSRF protection)', async () => {
    const res = await fetch(`http://${server.host}:${server.port}/api/fix/apply`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ findingId: 'x', solutionId: 'y', approved: true }),
    });
    expect([403, 500]).toContain(res.status);
  });

  it('refuses cross-origin mutating requests', async () => {
    const res = await fetch(`http://${server.host}:${server.port}/api/fix/apply`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json', 'X-DiffWise-Request': '1', Origin: 'http://evil.example' },
      body: JSON.stringify({ findingId: 'x', solutionId: 'y', approved: true }),
    });
    expect(res.status).toBe(403);
  });

  it('blocks path traversal on static assets and source reads', async () => {
    const asset = await fetch(`http://${server.host}:${server.port}/assets/../../package.json`, { headers: { cookie } });
    expect([403, 404]).toContain(asset.status);
    const source = await api(`/api/source?path=${encodeURIComponent('../../etc/passwd')}`);
    expect(source.status).toBe(403);
  });

  it('only serves source files that the review references', async () => {
    const outside = await api(`/api/source?path=${encodeURIComponent('package.json')}`);
    expect(outside.status).toBe(403);
    const inside = await api(`/api/source?path=${encodeURIComponent('src/payments/PaymentService.ts')}&start=100&end=110`);
    expect(inside.status).toBe(200);
    const body = await inside.json() as { lines: string[]; totalLines: number };
    expect(body.totalLines).toBeGreaterThan(100);
    expect(body.lines.length).toBe(11);
  });

  it('never applies a patch without approval, even when asked over HTTP', async () => {
    const report = (await service.latestReview())!;
    const finding = report.findings[0]!;
    const target = report.changes.find((c) => c.path.endsWith('.md'))!;
    const abs = join(root, target.path);
    const before = await readFile(abs, 'utf8');
    const firstLine = before.split('\n')[0] ?? '';
    const patch = `--- a/${target.path}\n+++ b/${target.path}\n@@ -1,1 +1,2 @@\n ${firstLine}\n+<!-- diffwise approval test -->\n`;

    const registered = await service.registerPatch({ findingId: finding.id, diff: patch });
    expect(registered.preview.applies).toBe(true);

    const res = await api('/api/fix/apply', {
      method: 'POST',
      body: JSON.stringify({ findingId: finding.id, solutionId: registered.fix.id, approved: false }),
    });
    const body = await res.json() as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/explicit developer approval/);
    expect(await readFile(abs, 'utf8')).toBe(before);
  });

  it('answers chat with a clear provider error instead of a fake answer', async () => {
    const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ question: 'why?' }) });
    const body = await res.json() as { ok: boolean; error: string; kind: string };
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('NO_PROVIDER');
    expect(res.status).toBe(503);
  });

  it('exposes settings without the key value', () => {
    const settings = uiSettingsFor(service);
    expect(settings.apiKeyPresent).toBe(false);
    expect(JSON.stringify(settings)).not.toContain('apiKey"');
  });
});

describe('standalone HTML export', () => {
  it('embeds the report and runs without a server or network assets', async () => {
    const root = await makeDemoRepo();
    try {
      const service = await DiffWiseService.create({ root, env: { ...process.env, DIFFWISE_AI: 'off' } });
      const { report } = await service.review({
        target: { mode: 'branch', base: 'main', head: 'feature/partial-refunds', label: 'main..feature/partial-refunds' },
        disableAi: true,
      });
      const html = await buildStandaloneHtml({ report });
      expect(html).toContain('__DIFFWISE_STATIC__');
      expect(html).toContain(report.id);
      expect(html).not.toMatch(/<script[^>]+src="https?:/);
      expect(html).not.toMatch(/<link[^>]+href="https?:/);
      expect(html).toContain('frame-ancestors');
      expect(html).toContain('aiChat');
      // The payload must not break out of its script element.
      expect(html).not.toContain('</script><script>alert');
      const match = /<script id="diffwise-payload" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
      expect(match).toBeTruthy();
      const payload = JSON.parse(match![1]!) as { report: { id: string; findings: unknown[] } };
      expect(payload.report.id).toBe(report.id);
      expect(payload.report.findings.length).toBe(report.findings.length);
    } finally {
      await cleanup(root);
    }
  }, 180_000);
});
