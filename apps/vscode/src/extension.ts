import * as vscode from 'vscode';
import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  EmptyReviewError, GitClient, ReviewCancelledError, applyPatch, openStore, revertPatch, runReview,
} from '@diffwise/core';
import type {
  AppliedFix, ChatTurn, FixSolution, ReviewIndexEntry, ReviewReport, ReviewTarget, TestExecution,
} from '@diffwise/core';
import { AiReviewer, ReportChat } from '@diffwise/ai';
import { DiffWisePanel, type PanelHost } from './panel';
import type { HostMessage, SectionId, UiSettings } from './protocol';
import {
  fastProviderFromSettings, getUiSettings, loadRepoFiles, providerFromSettings, runVerificationCommand,
  saveUiSettings, workspaceRoot,
} from './support';
import {
  ChangesTreeProvider, DiagnosticsManager, DiffWiseCodeLensProvider, FindingsTreeProvider,
  HistoryTreeProvider, StatusTreeProvider,
} from './views';

let controller: ReviewController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DiffWise');
  controller = new ReviewController(context, output);
  controller.register();
  // Restore the most recent review so reopening the workspace continues where
  // the developer left off. This never runs an analysis.
  void controller.initialize();

  context.subscriptions.push(output);
  context.subscriptions.push({ dispose: () => controller?.dispose() });
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}

class ReviewController implements PanelHost, vscode.Disposable {
  private readonly status = new StatusTreeProvider();
  private readonly findingsTree = new FindingsTreeProvider();
  private readonly changesTree = new ChangesTreeProvider();
  private readonly historyTree = new HistoryTreeProvider();
  private readonly diagnostics = new DiagnosticsManager();
  private readonly codeLens = new DiffWiseCodeLensProvider();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private report: ReviewReport | null = null;
  private root: string | null = null;
  private store: Awaited<ReturnType<typeof openStore>> | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private history: ReviewIndexEntry[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBar.command = 'diffwise.openReport';
    this.statusBar.show();
    this.updateStatusBar();
  }

  register(): void {
    const reg = (id: string, handler: (...args: unknown[]) => unknown): void => {
      this.disposables.push(vscode.commands.registerCommand(id, handler));
    };

    this.disposables.push(
      vscode.window.registerTreeDataProvider('diffwise.status', this.status),
      vscode.window.registerTreeDataProvider('diffwise.findings', this.findingsTree),
      vscode.window.registerTreeDataProvider('diffwise.changes', this.changesTree),
      vscode.window.registerTreeDataProvider('diffwise.history', this.historyTree),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.codeLens),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('diffwise')) {
          this.log('Configuration changed.');
          if (DiffWisePanel.current) DiffWisePanel.current.sendInitial();
        }
      }),
    );

    reg('diffwise.reviewWorkingTree', () => this.run({ mode: 'working', label: 'Working tree' }));
    reg('diffwise.reviewStaged', () => this.run({ mode: 'staged', label: 'Staged changes' }));
    reg('diffwise.reviewBranch', () => this.reviewBranch());
    reg('diffwise.reviewCommits', () => this.reviewCommits());
    reg('diffwise.reviewFiles', () => this.reviewSelectedFiles());
    reg('diffwise.reanalyze', () => this.report ? this.run(this.report.target) : this.run({ mode: 'working', label: 'Working tree' }));
    reg('diffwise.cancelReview', () => this.cancel());
    reg('diffwise.openReport', () => this.openPanel('overview'));
    reg('diffwise.openReviewSection', (section) => this.openPanel(typeof section === 'string' ? section as SectionId : 'overview'));
    reg('diffwise.history', () => this.openHistory());
    reg('diffwise.loadReview', (id) => typeof id === 'string' ? this.openReview(id) : undefined);
    reg('diffwise.openFinding', (id) => typeof id === 'string' ? this.openFinding(id) : undefined);
    reg('diffwise.openChangedFile', (path) => typeof path === 'string' ? this.openFile(path) : undefined);
    reg('diffwise.explainFinding', () => this.explainFindingAtCursor());
    reg('diffwise.generateFix', () => this.pickAndGenerateFix());
    reg('diffwise.discussReport', () => this.openPanel('discussion'));
    reg('diffwise.discussFinding', (id) => {
      if (typeof id !== 'string') return;
      this.openFinding(id);
      DiffWisePanel.current?.navigate('discussion');
    });
    reg('diffwise.revertFix', () => this.pickAndRevertFix());
    reg('diffwise.runVerification', () => this.verify(undefined, false));
    reg('diffwise.testProvider', () => this.testProviderCommand());
    reg('diffwise.configureProvider', () => this.openPanel('settings'));
    reg('diffwise.showOutput', () => this.output.show());
  }

  dispose(): void {
    this.abort?.abort();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.status.dispose();
    this.findingsTree.dispose();
    this.changesTree.dispose();
    this.historyTree.dispose();
    this.diagnostics.dispose();
    this.codeLens.dispose();
    this.statusBar.dispose();
  }

  log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  /** Load history and restore the latest review without starting an analysis. */
  async initialize(): Promise<void> {
    const root = workspaceRoot();
    if (!root) return;
    try {
      await new GitClient(root).assertRepo();
    } catch {
      this.log('Workspace is not a git repository; DiffWise is idle.');
      return;
    }
    this.root = root;
    this.store = await openStore(root, vscode.workspace.getConfiguration('diffwise').get<string>('storage.directory', '.diffwise'));
    await this.refreshHistory();
    DiffWisePanel.current?.post({ type: 'history', history: this.history });
    const latest = this.history[0];
    if (!latest) return;
    const report = await this.store.loadReport(latest.id);
    if (!report) return;
    await this.adoptReport(report);
    this.log(`Restored review ${report.id} (${report.findings.length} findings).`);
  }

  // --- Panel host ---------------------------------------------------------

  initialMessages(): HostMessage[] {
    const settings = getUiSettings();
    const messages: HostMessage[] = [];
    if (this.report) {
      messages.push({
        type: 'report',
        report: this.report,
        history: this.history,
        settings,
        appliedFixes: this.report.appliedFixes,
      });
    } else {
      messages.push({ type: 'history', history: this.history });
    }
    if (this.running) messages.push({ type: 'progress', stages: this.report?.stages ?? [], running: true, label: 'Analysis in progress' });
    return messages;
  }

  async run(target: ReviewTarget): Promise<void> {
    if (this.running) {
      void vscode.window.showInformationMessage('A DiffWise analysis is already running.');
      return;
    }
    const root = await this.ensureRoot();
    if (!root) return;
    const ui = getUiSettings();
    const panel = DiffWisePanel.show(this.context, this);
    this.running = true;
    this.abort = new AbortController();
    this.status.setRunning(true);
    this.statusBar.text = '$(sync~spin) DiffWise: analysing';
    this.output.show(true);
    this.log(`Starting review: ${target.mode} ${target.label} in ${root}`);
    panel.post({ type: 'progress', stages: [], running: true, label: 'Collecting changes' });

    try {
      const enrichers = [];
      if (ui.aiEnabled && ui.providerId !== 'none') {
        const provider = providerFromSettings(ui);
        const fixProvider = fastProviderFromSettings(ui);
        enrichers.push(new AiReviewer(provider, {
          ...(fixProvider ? { fixProvider } : {}),
          maxFixFindings: 3,
        }));
        if (!ui.apiKeyPresent) {
          this.log(`No API key in $${ui.apiKeyEnvVar}; the provider call will fail and the report will be marked partial.`);
        }
      }
      const report = await runReview({
        root,
        target,
        settings: {
          maxFiles: ui.maxFiles,
          maxFileBytes: vscode.workspace.getConfiguration('diffwise').get<number>('analysis.maxFileBytes', 400000),
          maxEvidenceSnippets: vscode.workspace.getConfiguration('diffwise').get<number>('analysis.maxEvidenceSnippets', 40),
          ignoreGlobs: vscode.workspace.getConfiguration('diffwise').get<string[]>('analysis.ignoreGlobs', ['**/node_modules/**', '**/dist/**', '**/build/**']),
          aiEnabled: ui.aiEnabled,
          sendRepositoryContent: ui.sendRepositoryContent,
          providerId: ui.providerId,
          model: ui.model,
          verificationCommand: ui.verificationCommand,
        },
        enrichers,
        signal: this.abort.signal,
        onProgress: (stages) => {
          this.status.setRunning(true);
          DiffWisePanel.current?.post({ type: 'progress', stages, running: true, label: stages.find((s) => s.status === 'running')?.label ?? 'Analysing' });
        },
      });
      await this.adoptReport(report, { announce: true });
    } catch (err) {
      if (err instanceof EmptyReviewError) {
        DiffWisePanel.current?.post({ type: 'error', message: 'No changes to review for this target.', detail: 'Commit or stage some work, or choose a different review target.' });
        void vscode.window.showInformationMessage('DiffWise: no changes to review for this target.');
      } else if (err instanceof ReviewCancelledError) {
        this.status.setRunning(false);
        DiffWisePanel.current?.post({ type: 'progress', stages: err.stages, running: false });
        DiffWisePanel.current?.post({ type: 'notice', level: 'warn', message: 'Analysis cancelled. No partial report was saved.' });
        void vscode.window.showWarningMessage('DiffWise: analysis cancelled.');
      } else {
        const message = (err as Error).message;
        this.log(`Review failed: ${message}`);
        DiffWisePanel.current?.post({ type: 'error', message: 'Analysis failed.', detail: message });
        void vscode.window.showErrorMessage(`DiffWise: ${message}`);
      }
    } finally {
      this.running = false;
      this.abort = null;
      this.status.setRunning(false);
      this.updateStatusBar();
    }
  }

  private async adoptReport(report: ReviewReport, opts: { announce?: boolean } = {}): Promise<void> {
    this.report = report;
    this.root = report.repository.root;
    this.diagnostics.set(report, this.root);
    this.codeLens.setReport(report);
    this.status.setReport(report);
    this.findingsTree.setReport(report);
    this.changesTree.setReport(report, this.root);
    await this.refreshHistory();
    this.updateStatusBar();
    DiffWisePanel.current?.post({
      type: 'report', report, history: this.history, settings: getUiSettings(), appliedFixes: report.appliedFixes,
    });
    if (opts.announce) {
      const critical = report.summary.findingsBySeverity.critical;
      const high = report.summary.findingsBySeverity.high;
      const msg = `${report.findings.length} finding(s) · ${critical} critical, ${high} high · risk ${report.risk.score}/100 (${report.risk.level})`;
      if (report.summary.completeness === 'partial') {
        void vscode.window.showWarningMessage(`DiffWise: ${msg}. Analysis is partial.`, 'Open report').then((choice) => {
          if (choice === 'Open report') this.openPanel('overview');
        });
      } else {
        void vscode.window.showInformationMessage(`DiffWise: ${msg}.`, 'Open report').then((choice) => {
          if (choice === 'Open report') this.openPanel('overview');
        });
      }
    }
  }

  cancel(): void {
    this.abort?.abort();
    this.log('Cancellation requested.');
  }

  async openFile(file: string, line?: number, endLine?: number): Promise<void> {
    const root = this.root ?? workspaceRoot();
    if (!root) return;
    const abs = resolve(root, file);
    if (!abs.startsWith(resolve(root))) {
      void vscode.window.showErrorMessage('DiffWise refused to open a file outside the workspace.');
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      const start = Math.max(0, (line ?? 1) - 1);
      const end = Math.max(start, (endLine ?? line ?? 1) - 1);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const range = new vscode.Range(start, 0, end, document.lineAt(Math.min(end, document.lineCount - 1)).range.end.character);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (err) {
      void vscode.window.showErrorMessage(`DiffWise could not open ${file}: ${(err as Error).message}`);
    }
  }

  async openReview(id: string): Promise<void> {
    if (!this.store) await this.ensureRoot();
    if (!this.store) return;
    const report = await this.store.loadReport(id);
    if (!report) {
      void vscode.window.showWarningMessage(`DiffWise: review ${id} was not found.`);
      return;
    }
    await this.adoptReport(report);
    this.openPanel('overview');
  }

  async openHistory(): Promise<void> {
    await this.refreshHistory();
    if (this.history.length === 0) {
      void vscode.window.showInformationMessage('DiffWise: no reviews recorded in this repository yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(this.history.map((h) => ({
      label: h.targetLabel,
      description: `${new Date(h.createdAt).toLocaleString()} · ${h.findings} findings · risk ${h.riskScore}`,
      detail: h.id,
    })), { title: 'DiffWise review history' });
    if (picked) await this.openReview(picked.detail);
  }

  async applyFix(findingId: string, solutionId: string): Promise<void> {
    const report = this.report;
    const root = this.root;
    if (!report || !root) return;
    const solution = report.fixes.find((f) => f.id === solutionId);
    if (!solution?.patch) {
      void vscode.window.showWarningMessage('DiffWise: this fix has no applicable patch.');
      return;
    }
    if (solution.patch.validation.applies !== true) {
      void vscode.window.showErrorMessage('DiffWise: the patch does not apply to the current working tree. Re-run the analysis.');
      return;
    }
    if (solution.patch.destructive) {
      const choice = await vscode.window.showWarningMessage(
        `This patch is destructive (${solution.filesAffected.join(', ')}). Review the diff before continuing.`,
        { modal: true },
        'Apply anyway',
      );
      if (choice !== 'Apply anyway') return;
    }
    const appliedId = `fix-${Date.now().toString(36)}`;
    const backupDir = join(root, '.diffwise', 'backups', appliedId);
    try {
      await mkdir(backupDir, { recursive: true });
      const result = await applyPatch(root, solution.patch.diff, { backupDir, ...(solution.patch.destructive ? { allowDelete: true } : {}) });
      if (!result.applied) {
        void vscode.window.showErrorMessage(`DiffWise: patch was not applied. ${result.errors.join('; ')}`);
        return;
      }
      const applied: AppliedFix = {
        id: appliedId,
        reviewId: report.id,
        findingId,
        solutionId,
        appliedAt: new Date().toISOString(),
        files: result.files,
        diff: solution.patch.diff,
        backupDir,
      };
      report.appliedFixes = [...report.appliedFixes, applied];
      this.report = report;
      await this.store?.recordAppliedFix(applied);
      await this.store?.saveReport(report);
      this.log(`Applied fix ${solutionId} to ${result.files.join(', ')} (backup ${backupDir}).`);
      DiffWisePanel.current?.post({ type: 'applied', applied, report });
      this.diagnostics.set(report, root);
      void vscode.window.showInformationMessage(
        `DiffWise applied the fix to ${result.files.length} file(s). Backups are in ${relative(root, backupDir)}.`,
        'Run verification',
      ).then((choice) => { if (choice === 'Run verification') void this.verify(); });
    } catch (err) {
      void vscode.window.showErrorMessage(`DiffWise: applying the patch failed. ${(err as Error).message}`);
    }
  }

  async revertFix(appliedFixId: string): Promise<void> {
    const report = this.report;
    const root = this.root;
    if (!report || !root) return;
    const applied = report.appliedFixes.find((a) => a.id === appliedFixId);
    if (!applied) return;
    const confirm = await vscode.window.showWarningMessage(
      `Revert the fix applied to ${applied.files.join(', ')}? Files return to their pre-fix content.`,
      { modal: true },
      'Revert',
    );
    if (confirm !== 'Revert') return;
    const result = await revertPatch(root, applied.backupDir, applied.files);
    if (result.errors.length > 0) {
      void vscode.window.showErrorMessage(`DiffWise: revert had errors: ${result.errors.join('; ')}`);
    }
    report.appliedFixes = report.appliedFixes.map((a) => a.id === applied.id ? { ...a, revertedAt: new Date().toISOString() } : a);
    this.report = report;
    await this.store?.saveReport(report);
    DiffWisePanel.current?.post({ type: 'report', report, history: this.history, settings: getUiSettings(), appliedFixes: report.appliedFixes });
    this.diagnostics.set(report, root);
    void vscode.window.showInformationMessage(`DiffWise reverted ${result.reverted.length} file(s).`);
  }

  async verify(command?: string, approved = false): Promise<void> {
    const report = this.report;
    const root = this.root;
    if (!report || !root) return;
    const configured = getUiSettings().verificationCommand;
    const cmd = (command ?? configured).trim();
    if (!cmd) {
      void vscode.window.showWarningMessage('DiffWise: no verification command configured. Set diffwise.verification.command first.');
      return;
    }
    // Consent comes from the report's explicit approval checkbox. Invocations
    // from the command palette have no such consent, so they get a modal.
    if (!approved) {
      const confirm = await vscode.window.showWarningMessage(
        `Run this command in ${root}?\n\n${cmd}`,
        { modal: true, detail: 'DiffWise executes only this configured command, with output captured in the report.' },
        'Run',
      );
      if (confirm !== 'Run') return;
    }
    this.log(`Running verification: ${cmd}`);
    const execution = await runVerificationCommand(root, cmd, vscode.workspace.getConfiguration('diffwise').get<number>('verification.timeoutMs', 300000), 'user-command');
    report.tests = { ...report.tests, execution };
    const lastApplied = report.appliedFixes[report.appliedFixes.length - 1];
    if (lastApplied) {
      report.appliedFixes = report.appliedFixes.map((a) => a.id === lastApplied.id ? { ...a, verification: execution } : a);
    }
    this.report = report;
    await this.store?.saveReport(report);
    DiffWisePanel.current?.post({ type: 'verification', execution });
    void vscode.window.showInformationMessage(`DiffWise verification ${execution.status} (exit ${execution.exitCode ?? 'n/a'}).`, 'Show output').then((choice) => {
      if (choice === 'Show output') this.output.show();
    });
  }

  async ask(requestId: string, question: string, findingId: string | undefined, history: ChatTurn[]): Promise<void> {
    const report = this.report;
    const root = this.root;
    if (!report || !root) {
      DiffWisePanel.current?.post({ type: 'chat', requestId, error: 'No review is loaded.' });
      return;
    }
    const ui = getUiSettings();
    if (!ui.apiKeyPresent || ui.providerId === 'none') {
      DiffWisePanel.current?.post({ type: 'chat', requestId, error: 'No AI provider key is available. Configure diffwise.provider.apiKeyEnvVar and restart VS Code so the variable is in the extension host environment.' });
      return;
    }
    try {
      const provider = providerFromSettings(ui);
      const repoFiles = await loadRepoFiles(root, report);
      const chat = new ReportChat(provider, report, repoFiles, { sendRepositoryContent: ui.sendRepositoryContent });
      const answer = await chat.ask(question, {
        ...(findingId ? { findingId } : {}),
        history,
        signal: this.abort?.signal,
      });
      this.log(`Chat answered: ${answer.citations.length} citation(s), ${answer.invalidCitations} rejected.`);
      DiffWisePanel.current?.post({
        type: 'chat',
        requestId,
        answer: {
          answer: answer.answer,
          citations: answer.citations,
          confidence: answer.confidence,
          caveats: answer.caveats,
          suggestedQuestions: answer.suggestedQuestions,
          invalidCitations: answer.invalidCitations,
        },
      });
    } catch (err) {
      const message = (err as Error).message;
      this.log(`Chat failed: ${message}`);
      DiffWisePanel.current?.post({ type: 'chat', requestId, error: message });
    }
  }

  async saveSettings(settings: UiSettings): Promise<void> {
    await saveUiSettings(settings);
    DiffWisePanel.current?.post({ type: 'settingsSaved', settings: getUiSettings() });
    this.log('Settings saved.');
  }

  async testProvider(requestId: string, settings: UiSettings): Promise<void> {
    const provider = providerFromSettings(settings);
    const result = await provider.ping();
    DiffWisePanel.current?.post({ type: 'providerTest', requestId, result });
    this.log(`Provider test: ${result.ok ? 'ok' : 'failed'} — ${result.message}`);
  }

  async generateFix(findingId: string): Promise<void> {
    const report = this.report;
    const root = this.root;
    if (!report || !root) return;
    const finding = report.findings.find((f) => f.id === findingId);
    if (!finding) {
      DiffWisePanel.current?.post({ type: 'fixes', findingId, fixes: [], error: 'Finding not found.' });
      return;
    }
    const ui = getUiSettings();
    if (!ui.apiKeyPresent || ui.providerId === 'none') {
      DiffWisePanel.current?.post({ type: 'fixes', findingId, fixes: report.fixes.filter((f) => f.findingId === findingId), error: 'No AI provider key is available, so a new patch cannot be generated.' });
      return;
    }
    try {
      const provider = providerFromSettings(ui);
      const fixProvider = fastProviderFromSettings(ui);
      const reviewer = new AiReviewer(provider, { ...(fixProvider ? { fixProvider } : {}) });
      const repoFiles = await loadRepoFiles(root, report);
      const changed = new Map<string, string>(repoFiles);
      const generated = await reviewer.generateFixesFor({
        report, repoFiles: changed, changedContents: changed, root, findings: [finding],
      });
      const existing = report.fixes.filter((f) => f.findingId !== findingId);
      report.fixes = [...existing, ...report.fixes.filter((f) => f.findingId === findingId), ...generated.fixes];
      this.report = report;
      await this.store?.saveReport(report);
      DiffWisePanel.current?.post({
        type: 'fixes',
        findingId,
        fixes: report.fixes.filter((f) => f.findingId === findingId),
        ...(generated.failures.length ? { error: generated.failures.join('; ') } : {}),
      });
      if (generated.fixes.length === 0) {
        void vscode.window.showWarningMessage(`DiffWise could not produce an applicable patch: ${generated.failures.join('; ') || 'no solutions returned'}`);
      }
    } catch (err) {
      DiffWisePanel.current?.post({ type: 'fixes', findingId, fixes: report.fixes.filter((f) => f.findingId === findingId), error: (err as Error).message });
      this.log(`Fix generation failed: ${(err as Error).message}`);
    }
  }

  // --- Native integrations -----------------------------------------------

  private openPanel(section: SectionId): void {
    const panel = DiffWisePanel.show(this.context, this, true);
    panel.navigate(section);
  }

  private openFinding(id: string): void {
    const panel = DiffWisePanel.show(this.context, this, true);
    panel.openFinding(id);
  }

  private async explainFindingAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const report = this.report;
    if (!report) {
      void vscode.window.showInformationMessage('DiffWise: run a review first.');
      return;
    }
    if (!editor) return;
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    const line = editor.selection.active.line + 1;
    const exact = report.findings.filter((f) => f.file === rel && line >= f.range.start - 2 && line <= f.range.end + 2);
    const picked = exact[0] ?? report.findings.filter((f) => f.file === rel)[0];
    if (!picked) {
      void vscode.window.showInformationMessage(`DiffWise: no finding on this line of ${rel}.`);
      return;
    }
    this.openFinding(picked.id);
  }

  private async pickAndGenerateFix(): Promise<void> {
    const report = this.report;
    if (!report) {
      void vscode.window.showInformationMessage('DiffWise: run a review first.');
      return;
    }
    const actionable = report.findings.filter((f) => f.kind !== 'question' && f.severity !== 'info');
    if (actionable.length === 0) {
      void vscode.window.showInformationMessage('DiffWise: there is no actionable finding to fix.');
      return;
    }
    const picked = await vscode.window.showQuickPick(actionable.map((f) => ({
      label: `${f.severity} · ${f.title}`,
      description: `${f.file}:${f.range.start}`,
      detail: f.id,
    })), { title: 'Generate a fix for…' });
    if (!picked) return;
    this.openFinding(picked.detail);
    await this.generateFix(picked.detail);
  }

  private async pickAndRevertFix(): Promise<void> {
    const applied = this.report?.appliedFixes.filter((a) => !a.revertedAt) ?? [];
    if (applied.length === 0) {
      void vscode.window.showInformationMessage('DiffWise: no applied fix to revert.');
      return;
    }
    const picked = await vscode.window.showQuickPick(applied.map((a) => ({
      label: a.files.join(', '),
      description: new Date(a.appliedAt).toLocaleString(),
      detail: a.id,
    })), { title: 'Revert an applied fix' });
    if (picked) await this.revertFix(picked.detail);
  }

  private async testProviderCommand(): Promise<void> {
    const ui = getUiSettings();
    if (ui.providerId === 'none') {
      void vscode.window.showWarningMessage('DiffWise: no AI provider is configured.');
      return;
    }
    const provider = providerFromSettings(ui);
    void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'DiffWise: testing provider' }, async () => {
      const result = await provider.ping();
      if (result.ok) void vscode.window.showInformationMessage(`DiffWise: ${result.message} (${result.model})`);
      else void vscode.window.showErrorMessage(`DiffWise provider error: ${result.message}`);
    });
  }

  private async reviewBranch(): Promise<void> {
    const base = await vscode.window.showInputBox({ title: 'Base branch', value: 'main', prompt: 'Compare HEAD against this branch' });
    if (!base) return;
    await this.run({ mode: 'branch', base, head: 'HEAD', label: `${base}...HEAD` });
  }

  private async reviewCommits(): Promise<void> {
    const base = await vscode.window.showInputBox({ title: 'From commit', value: 'HEAD~1', prompt: 'Review commits base..head' });
    if (!base) return;
    const head = await vscode.window.showInputBox({ title: 'To commit', value: 'HEAD' });
    if (!head) return;
    await this.run({ mode: 'commits', base, head, label: `${base}..${head}` });
  }

  private async reviewSelectedFiles(): Promise<void> {
    const root = await this.ensureRoot();
    if (!root) return;
    const uris = vscode.window.activeTextEditor
      ? [vscode.window.activeTextEditor.document.uri]
      : await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: vscode.Uri.file(root), title: 'Select files to review' }) ?? [];
    if (uris.length === 0) return;
    const paths = uris.map((u) => relative(root, u.fsPath).replace(/\\/g, '/')).filter((p) => !p.startsWith('..'));
    if (paths.length === 0) {
      void vscode.window.showWarningMessage('DiffWise: select files inside the workspace.');
      return;
    }
    await this.run({ mode: 'files', paths, label: `${paths.length} selected file(s)` });
  }

  private async ensureRoot(): Promise<string | null> {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('DiffWise needs an open folder with a git repository.');
      return null;
    }
    try {
      await new GitClient(root).assertRepo();
    } catch {
      void vscode.window.showErrorMessage('DiffWise: the workspace is not a git repository.');
      return null;
    }
    if (!this.store || this.root !== root) {
      this.root = root;
      this.store = await openStore(root, vscode.workspace.getConfiguration('diffwise').get<string>('storage.directory', '.diffwise'));
      await this.refreshHistory();
    }
    return root;
  }

  private async refreshHistory(): Promise<void> {
    if (!this.store) return;
    this.history = await this.store.listReviews(50);
    this.historyTree.setEntries(this.history);
  }

  private updateStatusBar(): void {
    if (this.running) {
      this.statusBar.text = '$(sync~spin) DiffWise: analysing';
      this.statusBar.tooltip = 'DiffWise analysis is running. Click to open the report.';
      return;
    }
    if (!this.report) {
      this.statusBar.text = '$(shield) DiffWise';
      this.statusBar.tooltip = 'Review current changes';
      return;
    }
    const critical = this.report.summary.findingsBySeverity.critical;
    const icon = critical > 0 ? '$(error)' : this.report.summary.findingsBySeverity.high > 0 ? '$(warning)' : '$(pass)';
    this.statusBar.text = `${icon} DiffWise: ${this.report.findings.length} findings`;
    this.statusBar.tooltip = `${this.report.risk.level} risk (${this.report.risk.score}/100) · ${this.report.summary.completeness} analysis\nClick to open the report`;
  }
}
