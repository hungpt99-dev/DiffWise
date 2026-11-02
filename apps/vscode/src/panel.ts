import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { ChatTurn, ReviewTarget } from '@diffwise/core';
import type { HostMessage, SectionId, UiSettings, WebviewMessage } from './protocol';

/** Everything the panel needs from the extension. Implemented by the controller. */
export interface PanelHost {
  initialMessages(): HostMessage[];
  run(target: ReviewTarget): void;
  cancel(): void;
  openFile(file: string, line?: number, endLine?: number): void;
  openReview(id: string): Promise<void>;
  openHistory(): Promise<void>;
  applyFix(findingId: string, solutionId: string): Promise<void>;
  revertFix(appliedFixId: string): Promise<void>;
  verify(command?: string, approved?: boolean): Promise<void>;
  ask(requestId: string, question: string, findingId: string | undefined, history: ChatTurn[]): Promise<void>;
  saveSettings(settings: UiSettings): Promise<void>;
  testProvider(requestId: string, settings: UiSettings): Promise<void>;
  generateFix(findingId: string): Promise<void>;
  workspaceAction(action: string, payload?: unknown): Promise<void>;
  log(message: string): void;
}

/**
 * The interactive report webview.
 *
 * The webview is a pure view: every action that touches the repository, the
 * model or the filesystem is performed here, in the extension host, and results
 * are posted back. Undefined message shapes are ignored rather than trusted.
 */
export class DiffWisePanel {
  static current: DiffWisePanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;

  static show(context: vscode.ExtensionContext, host: PanelHost, reveal = false): DiffWisePanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (DiffWisePanel.current) {
      if (reveal) DiffWisePanel.current.panel.reveal(column);
      DiffWisePanel.current.sendInitial();
      return DiffWisePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'diffwise.report',
      'DiffWise Review',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media', 'webview')],
      },
    );
    DiffWisePanel.current = new DiffWisePanel(panel, context, host);
    return DiffWisePanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly host: PanelHost,
  ) {
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((message: unknown) => { void this.onMessage(message); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
    const message = raw as WebviewMessage;
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          this.sendInitial();
          return;
        case 'run':
          if (isTarget(message.target)) this.host.run(message.target);
          return;
        case 'cancel': this.host.cancel(); return;
        case 'openFile':
          if (typeof message.file === 'string') this.host.openFile(message.file, num(message.line), num(message.endLine));
          return;
        case 'openReview':
          if (typeof message.id === 'string') await this.host.openReview(message.id);
          return;
        case 'openHistory': await this.host.openHistory(); return;
        case 'applyFix':
          if (typeof message.findingId === 'string' && typeof message.solutionId === 'string' && message.approved === true) {
            await this.host.applyFix(message.findingId, message.solutionId);
          }
          return;
        case 'revertFix':
          if (typeof message.appliedFixId === 'string') await this.host.revertFix(message.appliedFixId);
          return;
        case 'verify': await this.host.verify(typeof message.command === 'string' ? message.command : undefined, message.approved === true); return;
        case 'ask':
          if (typeof message.requestId === 'string' && typeof message.question === 'string' && message.question.trim()) {
            await this.host.ask(message.requestId, message.question, typeof message.findingId === 'string' ? message.findingId : undefined, Array.isArray(message.history) ? message.history : []);
          }
          return;
        case 'saveSettings':
          if (message.settings && typeof message.settings === 'object') await this.host.saveSettings(message.settings);
          return;
        case 'testProvider':
          if (typeof message.requestId === 'string' && message.settings) await this.host.testProvider(message.requestId, message.settings);
          return;
        case 'generateFix':
          if (typeof message.findingId === 'string') await this.host.generateFix(message.findingId);
          return;
        case 'openSettingsFile':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'diffwise');
          return;
        case 'copy':
          if (typeof message.text === 'string') await vscode.env.clipboard.writeText(message.text);
          return;
        case 'workspaceAction':
          if (typeof message.action === 'string') await this.host.workspaceAction(message.action, message.payload);
          return;
        default:
          this.host.log(`Ignored unknown webview message: ${String((message as { type?: string }).type)}`);
      }
    } catch (err) {
      const text = (err as Error).message;
      this.host.log(`Webview action failed (${message.type}): ${text}`);
      this.post({ type: 'notice', level: 'error', message: text });
    }
  }

  post(message: HostMessage): void {
    if (!this.ready) return;
    void this.panel.webview.postMessage(message);
  }

  sendInitial(): void {
    for (const message of this.host.initialMessages()) this.post(message);
  }

  navigate(section: SectionId): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.One);
    this.post({ type: 'navigate', section });
  }

  openFinding(id: string): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.One);
    this.post({ type: 'openFinding', id });
  }

  dispose(): void {
    DiffWisePanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(webview: vscode.Webview): string {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview');
    const indexPath = vscode.Uri.joinPath(dist, 'index.html').fsPath;
    // The file is produced by the Vite build and shipped inside the extension.
    // Reading it synchronously keeps the panel creation simple; the file is
    // small and local, and a failure surfaces as an explicit error page.
    let html: string;
    try {
      html = readFileSync(indexPath, 'utf8');
    } catch (err) {
      return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground);">
        <h2>DiffWise UI is not built</h2>
        <p>Run <code>npm run build</code> in the repository root, then reload the window.</p>
        <pre>${escapeHtml((err as Error).message)}</pre></body></html>`;
    }
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: https:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    html = html
      .replace(/(src|href)="\.?\/?(assets\/[^"]+)"/g, (_m, attr: string, path: string) => {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(dist, path));
        return `${attr}="${uri}"`;
      })
      .replace(/<script /g, `<script nonce="${nonce}" `)
      .replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
    return html;
  }

}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isTarget(value: unknown): value is ReviewTarget {
  if (!value || typeof value !== 'object') return false;
  const t = value as { mode?: unknown; label?: unknown };
  return typeof t.mode === 'string' && typeof t.label === 'string'
    && ['working', 'staged', 'branch', 'commits', 'files'].includes(t.mode);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}
