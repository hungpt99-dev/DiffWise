#!/usr/bin/env node
/**
 * VS Code end-to-end smoke test.
 *
 * Prerequisites (a real Extension Development Host on a virtual display):
 *
 *   Xvfb :99 -screen 0 1920x1200x24 &
 *   DISPLAY=:99 code --no-sandbox --disable-gpu --disable-dev-shm-usage \
 *     --user-data-dir=/tmp/dw-vscode --extensions-dir=/tmp/dw-ext \
 *     --remote-debugging-port=9222 \
 *     --extensionDevelopmentPath=<repo>/apps/vscode <demo-repo>
 *
 * Then: node e2e/vscode/run-vscode-e2e.mjs
 *
 * The script asserts that the extension is activated in the real workbench, the
 * DiffWise activity bar view exists, the report panel opens through its
 * keybinding, and the webview renders a report produced by the real pipeline.
 * It never simulates product behaviour: everything is read from the running UI.
 */
import { writeFile } from 'node:fs/promises';

const PORT = process.env.DIFFWISE_CDP_PORT ?? '9222';
const shotDir = process.env.DIFFWISE_E2E_SHOTS ?? '';

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error(`timeout ${method}`)); } }, 20_000);
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'eval failed');
    return result.result?.value;
  };
  return {
    evaluate,
    send,
    close: () => ws.close(),
    async key(key, { ctrl = false, alt = false, shift = false } = {}) {
      const modifiers = (ctrl ? 2 : 0) | (alt ? 1 : 0) | (shift ? 8 : 0);
      const vk = key.toUpperCase().charCodeAt(0);
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: `Key${key.toUpperCase()}`, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: `Key${key.toUpperCase()}`, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    },
    async screenshot(path) {
      const result = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path, Buffer.from(result.data, 'base64'));
    },
  };
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`);
  else { failures += 1; console.error(`  FAIL  ${name} ${detail}`); }
}

const list = await targets().catch(() => []);
const pageTarget = list.find((t) => t.type === 'page' && /workbench/.test(t.url));
if (!pageTarget) {
  console.error('No VS Code workbench target. Is the Extension Development Host running with --remote-debugging-port?');
  process.exit(2);
}
const page = await connect(pageTarget.webSocketDebuggerUrl);
await page.evaluate(`document.querySelector('.monaco-workbench')?.click(); true`);
await sleep(1000);

console.log('VS Code end-to-end');
check('extension development host is running', (await page.evaluate('document.title')).includes('Extension Development Host'));
check('DiffWise activity bar view exists', await page.evaluate(`!!document.querySelector('.activitybar [aria-label="DiffWise"]')`));

// Open the report via the extension keybinding (Ctrl+Alt+D).
// A fresh profile can open the Welcome tab after the first click and swallow the
// first chord, so the keybinding is retried — the assertion is unchanged: the
// panel must open from the keyboard.
let webview = null;
for (let attempt = 0; attempt < 3 && !webview; attempt++) {
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(400);
  await page.evaluate(`(() => {
    const welcome = document.querySelector('.editor-group-container .tabs-container .tab.active');
    if (welcome && /Welcome|Get Started/i.test(welcome.textContent || '')) {
      document.querySelector('.monaco-workbench .editor .title-actions .codicon-close')?.click?.();
    }
    document.querySelector('.monaco-workbench')?.click();
    return true;
  })()`);
  await sleep(600);
  await page.key('d', { ctrl: true, alt: true });
  for (let i = 0; i < 16 && !webview; i++) {
    await sleep(500);
    webview = (await targets()).find((t) => t.type === 'iframe' && /vscode-webview/.test(t.url));
  }
}
check('report panel opens via keybinding', Boolean(webview));
if (!webview) { failures += 1; }
else {
  const w = await connect(webview.webSocketDebuggerUrl);
  let state = null;
  for (let i = 0; i < 60; i++) {
    state = await w.evaluate(`(() => {
      const d = document.querySelector('iframe')?.contentDocument;
      if (!d) return null;
      const text = d.body.innerText;
      return {
        rails: d.querySelectorAll('.rail-item').length,
        text,
        findings: d.querySelectorAll('.finding-row').length,
        stages: d.querySelectorAll('.stage').length,
      };
    })()`);
    if (state && state.rails >= 10 && !state.text.includes('Analysis in progress')) break;
    await sleep(1000);
  }
  // The rail grows as sections are added; assert it is the full navigation, not
  // one fixed number copied from a screenshot.
  check('webview mounts the report UI', (state?.rails ?? 0) >= 10, `rails=${state?.rails}`);
  // Navigate deterministically before asserting section content.
  await w.evaluate(`(() => { const d=document.querySelector('iframe')?.contentDocument; const b=[...d.querySelectorAll('.rail-item')].find(x=>x.textContent.includes('Overview')); b?.click(); return true; })()`);
  await sleep(600);
  const overview = await w.evaluate(`document.querySelector('iframe')?.contentDocument?.body?.innerText ?? ''`);
  check('report shows an analysis result', overview.includes('Engineering overview') && !overview.includes('No review loaded'), overview.slice(0, 80));
  check('pipeline stages are reported', await w.evaluate(`document.querySelector('iframe')?.contentDocument?.querySelectorAll('.stage').length`) > 5);
  check('partial or complete status is explicit', /complete analysis|partial analysis/.test(overview));
  await w.evaluate(`(() => { const d=document.querySelector('iframe')?.contentDocument; const b=[...d.querySelectorAll('.rail-item')].find(x=>x.textContent.includes('Code Review')); b?.click(); return true; })()`);
  await sleep(600);
  check('findings are rendered', await w.evaluate(`document.querySelector('iframe')?.contentDocument?.querySelectorAll('.finding-row').length`) > 0);
  if (shotDir) {
    await page.screenshot(`${shotDir}/vscode-e2e.png`);
    console.log(`  screenshot: ${shotDir}/vscode-e2e.png`);
  }
  await w.close();
}
await page.close();

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll VS Code end-to-end checks passed.');
