/**
 * Standalone HTML export.
 *
 * One self-contained file: the real report payload plus the real built web
 * report bundle, inlined. It opens from disk with no server and no network.
 * Features that genuinely need a live backend (model chat, applying patches,
 * running verification) stay disabled and say so — the export never pretends
 * to be the interactive product.
 */
import { writeFile } from 'node:fs/promises';
import type { ReviewReport } from '@diffwise/core';
import { buildReviewEnvelope } from '@diffwise/core';
import { CSP, embedJson, loadWebAssets, type WebAssets } from './assets';

export interface HtmlExportOptions {
  report: ReviewReport;
  /** Override the report title shown in the browser tab. */
  title?: string;
  /** Assets, when already loaded (server reuse). */
  assets?: WebAssets;
}

export interface StaticPayload {
  mode: 'static';
  generatedAt: string;
  /** Explicit statement of what the exported file can and cannot do. */
  capabilities: {
    readReport: true;
    aiChat: false;
    applyFix: false;
    runVerification: false;
    reason: string;
  };
  report: ReviewReport;
  envelope: ReturnType<typeof buildReviewEnvelope>;
}

export async function buildStandaloneHtml(options: HtmlExportOptions): Promise<string> {
  const assets = options.assets ?? await loadWebAssets();
  const payload: StaticPayload = {
    mode: 'static',
    generatedAt: new Date().toISOString(),
    capabilities: {
      readReport: true,
      aiChat: false,
      applyFix: false,
      runVerification: false,
      reason: 'This is a standalone export. Chat, fix application and verification need a live local session: run "diffwise report latest --serve".',
    },
    report: options.report,
    envelope: buildReviewEnvelope(options.report),
  };
  const title = options.title
    ?? `DiffWise — ${options.report.repository.name} ${options.report.target.label}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="DiffWise ${escapeHtml(options.report.execution?.toolVersion ?? '')}" />
<meta http-equiv="Content-Security-Policy" content="${CSP}" />
<meta name="referrer" content="no-referrer" />
<title>${escapeHtml(title)}</title>
<style>${assets.css}</style>
</head>
<body>
<div id="root"></div>
<script id="diffwise-payload" type="application/json">${embedJson(payload)}</script>
<script>
(function () {
  var el = document.getElementById('diffwise-payload');
  try { window.__DIFFWISE_STATIC__ = JSON.parse(el.textContent); }
  catch (e) { document.body.textContent = 'DiffWise: the embedded report payload is corrupt.'; }
})();
</script>
<script type="module">${assets.js.replace(/<\/script>/gi, '<\\/script>')}</script>
</body>
</html>
`;
}

export async function writeStandaloneHtml(options: HtmlExportOptions & { path: string }): Promise<string> {
  const html = await buildStandaloneHtml(options);
  await writeFile(options.path, html, 'utf8');
  return options.path;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
