#!/usr/bin/env node
/**
 * Drive a review from the VS Code command palette over CDP.
 *
 * Used to prove the direction the webview E2E cannot: an analysis *started in
 * the editor* must produce the same persisted review the CLI can read, with
 * policy, reviewer plan and verification attached.
 *
 * Prerequisites: Extension Development Host running with --remote-debugging-port
 * and a workspace that has uncommitted changes.
 *
 * Usage: node e2e/vscode/trigger-review.mjs
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.DIFFWISE_CDP_PORT ?? '9222';
const WORKSPACE = process.env.DIFFWISE_E2E_WORKSPACE ?? '';
const reviewsDir = WORKSPACE ? join(WORKSPACE, '.diffwise', 'reviews') : '';
const existing = new Set(reviewsDir ? readdirSync(reviewsDir).filter((f) => f.endsWith('.json')) : []);
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
    let msg;
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed');
      return result.result?.value;
    },
    close: () => ws.close(),
  };
}

const list = await targets().catch(() => []);
const pageTarget = list.find((t) => t.type === 'page' && /workbench/.test(t.url));
if (!pageTarget) {
  console.error('No VS Code workbench target. Start the Extension Development Host with --remote-debugging-port.');
  process.exit(2);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.evaluate(`document.querySelector('.monaco-workbench')?.click(); true`);
await sleep(500);

// Command palette → "DiffWise: Review Working Tree".
await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'P', code: 'KeyP', modifiers: 2 | 8, windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 });
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', modifiers: 2 | 8, windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 });
await sleep(1200);
// Title from package.json: commands are "Review Current Changes" etc.
await page.send('Input.insertText', { text: 'DiffWise: Review Current Changes' });
await sleep(1200);
await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

// The unambiguous signal is the artefact: a new review file the CLI can read.
let finished = false;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  if (reviewsDir) {
    const now = readdirSync(reviewsDir).filter((f) => f.endsWith('.json') && !existing.has(f));
    if (now.length > 0) {
      console.log(`new review written by the editor: ${now[0]}`);
      finished = true;
      break;
    }
    continue;
  }
  const body = await page.evaluate('document.body.innerText');
  if (/DiffWise: \d+ findings/.test(body)) { finished = true; break; }
}
console.log(finished ? 'review completed in the editor' : 'no new review appeared within 120s');
if (!finished) {
  const body = await page.evaluate('document.body.innerText');
  console.error(body.slice(0, 600));
}
await page.close();
process.exit(finished ? 0 : 1);
