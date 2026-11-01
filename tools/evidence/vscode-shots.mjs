#!/usr/bin/env node
/**
 * Capture the DiffWise panel inside a running VS Code Extension Development Host.
 *
 * Used for the README screenshot. Assumes a review already exists in the
 * workspace (run e2e/vscode/trigger-review.mjs first): this script never starts
 * a new review, because a second run on an unchanged tree would replace a valid
 * report with an "Analysis error: no changes" banner in the screenshot.
 *
 *   DISPLAY=:99 node tools/evidence/vscode-shots.mjs docs/screenshots/vscode-e2e.png
 */
const out = process.argv[2] ?? 'docs/screenshots/vscode-e2e.png';
const PORT = process.env.DIFFWISE_CDP_PORT ?? '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error(`timeout ${method}`)); } }, 20_000);
  });
  return { send, close: () => ws.close() };
}

const page = (await targets()).find((t) => t.type === 'page' && /workbench|vscode/.test(t.url));
if (!page) throw new Error('No VS Code workbench target. Is the Extension Development Host running?');
const cdp = await connect(page.webSocketDebuggerUrl);

// Close the panels that would otherwise cover the report: the bottom panel
// (Ctrl+J) and the secondary side bar (Ctrl+Alt+B).
for (const [key, code, modifiers] of [['j', 'KeyJ', 2], ['b', 'KeyB', 3]]) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: code === 'KeyJ' ? 74 : 66 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: code === 'KeyJ' ? 74 : 66 });
  await sleep(400);
}
// Toasts linger for several seconds; a screenshot taken too early has one
// covering the panel it is meant to show.
await sleep(11_000);

// Crop to the editor part: IDE chrome (activity bar, explorer, status bar, chat
// sidebar) is not the product, and a screenshot that includes it makes the panel
// look smaller and busier than it is.
// Prefer the webview target: it can be captured at its full content height, so the
// panel is not cut off by the editor viewport. The workbench crop is the fallback.
const webviewTarget = (await targets()).find((t) => t.type === 'iframe' && /vscode-webview/.test(t.url));
try {
if (webviewTarget) {
  const wv = await connect(webviewTarget.webSocketDebuggerUrl);
  const size = await wv.send('Runtime.evaluate', {
    expression: '(() => { const d = document.documentElement; return { w: d.clientWidth, h: Math.max(d.scrollHeight, document.body.scrollHeight) }; })()',
    returnByValue: true,
  });
  const s2 = size?.result?.value;
  if (s2 && s2.h > 300) {
    const shot = await wv.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: s2.w, height: s2.h, scale: 1 },
    });
    const { writeFile: write } = await import('node:fs/promises');
    await write(out, Buffer.from(shot.data, 'base64'));
    console.log(`screenshot: ${out} (${s2.w}x${s2.h}, full panel)`);
    wv.close();
    cdp.close();
    process.exit(0);
  }
  wv.close();
}
} catch (err) {
  console.warn(`webview capture unavailable (${(err).message}); capturing the workbench instead`);
}

const rect = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.querySelector('.monaco-workbench .part.editor');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`,
  returnByValue: true,
});
const raw = rect?.result?.value;
const fullWindow = process.env.DIFFWISE_SHOT_FULL === '1';
// Drop the editor tab strip: it is VS Code, not DiffWise.
const TAB_STRIP = 36;
const clip = fullWindow ? undefined : raw && raw.height > TAB_STRIP * 2
  ? { x: raw.x, y: raw.y + TAB_STRIP, width: raw.width, height: raw.height - TAB_STRIP }
  : raw;
const { data } = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  ...(clip && clip.width > 300 && clip.height > 300 ? { clip: { ...clip, scale: 1 } } : {}),
});
const { writeFile } = await import('node:fs/promises');
await writeFile(out, Buffer.from(data, 'base64'));
console.log(`screenshot: ${out}`);
cdp.close();
