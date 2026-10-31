import * as vscode from 'vscode';
import { join } from 'node:path';
import type { Finding, ReviewIndexEntry, ReviewReport } from '@diffwise/core';
import { severityIcon } from './support';

/** Tree views, diagnostics and CodeLens: the native VS Code surfaces. */

class Emitter {
  private readonly delegate = new vscode.EventEmitter<void>();
  readonly event = this.delegate.event;
  refresh(): void { this.delegate.fire(); }
  dispose(): void { this.delegate.dispose(); }
}

export class StatusTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new Emitter();
  readonly onDidChangeTreeData = this.emitter.event;
  private report: ReviewReport | null = null;
  private running = false;

  setReport(report: ReviewReport | null): void { this.report = report; this.emitter.refresh(); }
  setRunning(running: boolean): void { this.running = running; this.emitter.refresh(); }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
    if (this.running) {
      const item = new vscode.TreeItem('Analysis in progress…', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('sync~spin');
      return [item];
    }
    if (!this.report) {
      const item = new vscode.TreeItem('Review current changes to start', vscode.TreeItemCollapsibleState.None);
      item.command = { command: 'diffwise.reviewWorkingTree', title: 'Review current changes' };
      item.iconPath = new vscode.ThemeIcon('play');
      return [item];
    }
    const r = this.report;
    const risk = new vscode.TreeItem(`Risk ${r.risk.score}/100 · ${r.risk.level}`, vscode.TreeItemCollapsibleState.None);
    risk.description = r.target.label;
    risk.tooltip = new vscode.MarkdownString(`${r.risk.summary}\n\n${r.risk.method}`);
    risk.iconPath = new vscode.ThemeIcon(r.risk.level === 'low' ? 'pass' : r.risk.level === 'moderate' ? 'warning' : 'error');
    risk.command = { command: 'diffwise.openReport', title: 'Open report' };

    const findings = new vscode.TreeItem(`${r.findings.length} finding(s)`, vscode.TreeItemCollapsibleState.None);
    findings.description = `${r.summary.findingsBySeverity.critical} critical · ${r.summary.findingsBySeverity.high} high`;
    findings.command = { command: 'diffwise.openReviewSection', arguments: ['review'], title: 'Open findings' };
    findings.iconPath = new vscode.ThemeIcon('shield');

    const changes = new vscode.TreeItem(`${r.changes.length} changed file(s)`, vscode.TreeItemCollapsibleState.None);
    changes.description = `+${r.changes.reduce((n, c) => n + c.additions, 0)} / −${r.changes.reduce((n, c) => n + c.deletions, 0)}`;
    changes.command = { command: 'diffwise.openReviewSection', arguments: ['changes'], title: 'Open changes' };
    changes.iconPath = new vscode.ThemeIcon('diff');

    const docs = new vscode.TreeItem(`${r.documentation.findings.length} documentation issue(s)`, vscode.TreeItemCollapsibleState.None);
    docs.command = { command: 'diffwise.openReviewSection', arguments: ['documentation'], title: 'Open documentation' };
    docs.iconPath = new vscode.ThemeIcon('book');

    const completeness = new vscode.TreeItem(`Analysis ${r.summary.completeness}`, vscode.TreeItemCollapsibleState.None);
    completeness.description = `${r.stages.filter((s) => s.status === 'failed').length} failed stage(s)`;
    completeness.tooltip = r.summary.completenessNote ?? 'Every stage completed.';
    completeness.iconPath = new vscode.ThemeIcon(r.summary.completeness === 'complete' ? 'check' : 'warning');

    const provider = new vscode.TreeItem(r.provider.configured ? `Model: ${r.provider.model ?? r.provider.providerId}` : 'No AI provider configured', vscode.TreeItemCollapsibleState.None);
    provider.description = r.provider.state;
    provider.command = { command: 'diffwise.configureProvider', title: 'Configure provider' };
    provider.iconPath = new vscode.ThemeIcon(r.provider.state === 'ok' ? 'sparkle' : 'plug');

    return [risk, findings, changes, docs, completeness, provider];
  }

  dispose(): void { this.emitter.dispose(); }
}

export class FindingsTreeProvider implements vscode.TreeDataProvider<FindingNode> {
  private readonly emitter = new Emitter();
  readonly onDidChangeTreeData = this.emitter.event;
  private report: ReviewReport | null = null;

  setReport(report: ReviewReport | null): void { this.report = report; this.emitter.refresh(); }

  getTreeItem(element: FindingNode): vscode.TreeItem { return element; }

  getChildren(element?: FindingNode): FindingNode[] {
    if (!this.report) return [];
    if (!element) {
      const order = ['critical', 'high', 'medium', 'low', 'info'] as const;
      return order
        .filter((s) => this.report!.summary.findingsBySeverity[s] > 0)
        .map((s) => {
          const node = new FindingNode(`${s} (${this.report!.summary.findingsBySeverity[s]})`, vscode.TreeItemCollapsibleState.Expanded);
          node.contextValue = 'severityGroup';
          node.iconPath = severityIcon(s);
          node.severity = s;
          return node;
        });
    }
    const severity = element.severity;
    return this.report.findings
      .filter((f) => f.severity === severity)
      .map((f) => {
        const node = new FindingNode(f.title, vscode.TreeItemCollapsibleState.None);
        node.finding = f;
        node.description = `${f.file}:${f.range.start}`;
        node.tooltip = new vscode.MarkdownString(`**${f.title}**\n\n${f.description}\n\n_${f.category} · ${f.confidence}_`);
        node.iconPath = severityIcon(f.severity);
        node.command = { command: 'diffwise.openFinding', arguments: [f.id], title: 'Open finding' };
        return node;
      });
  }

  dispose(): void { this.emitter.dispose(); }
}

export class FindingNode extends vscode.TreeItem {
  finding?: Finding;
  severity?: string;
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new Emitter();
  readonly onDidChangeTreeData = this.emitter.event;
  private report: ReviewReport | null = null;
  private root: string | null = null;

  setReport(report: ReviewReport | null, root: string | null): void { this.report = report; this.root = root; this.emitter.refresh(); }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
    if (!this.report) return [];
    return this.report.changes.map((c) => {
      const item = new vscode.TreeItem(c.path, vscode.TreeItemCollapsibleState.None);
      item.description = `${c.status} +${c.additions}/−${c.deletions}`;
      item.resourceUri = this.root ? vscode.Uri.file(join(this.root, c.path)) : undefined;
      item.contextValue = 'changedFile';
      item.iconPath = new vscode.ThemeIcon(c.status === 'added' ? 'add' : c.status === 'deleted' ? 'trash' : 'edit');
      item.command = { command: 'diffwise.openChangedFile', arguments: [c.path], title: 'Open file' };
      return item;
    });
  }

  dispose(): void { this.emitter.dispose(); }
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new Emitter();
  readonly onDidChangeTreeData = this.emitter.event;
  private entries: ReviewIndexEntry[] = [];

  setEntries(entries: ReviewIndexEntry[]): void { this.entries = entries; this.emitter.refresh(); }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
    return this.entries.map((e) => {
      const item = new vscode.TreeItem(e.targetLabel, vscode.TreeItemCollapsibleState.None);
      item.description = `${new Date(e.createdAt).toLocaleString()} · ${e.findings} findings`;
      item.tooltip = `${e.branch} · risk ${e.riskLevel} ${e.riskScore}/100 · ${e.completeness}`;
      item.iconPath = new vscode.ThemeIcon(e.riskLevel === 'low' ? 'pass' : e.riskLevel === 'moderate' ? 'warning' : 'error');
      item.command = { command: 'diffwise.loadReview', arguments: [e.id], title: 'Open review' };
      return item;
    });
  }

  dispose(): void { this.emitter.dispose(); }
}

/** Diagnostics are regenerated from the report; stale findings are always cleared. */
export class DiagnosticsManager implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('diffwise');

  set(report: ReviewReport | null, root: string | null): void {
    this.collection.clear();
    if (!report || !root) return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const finding of report.findings) {
      if (finding.file.startsWith('/') || finding.file.includes('..')) continue;
      const abs = join(root, finding.file);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(Math.max(0, finding.range.start - 1), 0, Math.max(0, finding.range.end - 1), 400),
        `${finding.title}\n${finding.description}`,
        diagnosticSeverityFor(finding.severity),
      );
      diagnostic.source = 'DiffWise';
      diagnostic.code = finding.ruleId;
      diagnostic.relatedInformation = finding.evidence
        .filter((e) => e.file && e.line)
        .slice(0, 3)
        .map((e) => new vscode.DiagnosticRelatedInformation(
          new vscode.Location(vscode.Uri.file(join(root, e.file!)), new vscode.Position(Math.max(0, (e.line ?? 1) - 1), 0)),
          e.note,
        ));
      diagnostic.tags = finding.kind === 'question' ? [vscode.DiagnosticTag.Unnecessary] : undefined;
      const list = byFile.get(abs) ?? [];
      list.push(diagnostic);
      byFile.set(abs, list);
    }
    for (const [file, diagnostics] of byFile) this.collection.set(vscode.Uri.file(file), diagnostics);
  }

  dispose(): void { this.collection.dispose(); }
}

function diagnosticSeverityFor(severity: string): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'critical':
    case 'high': return vscode.DiagnosticSeverity.Error;
    case 'medium': return vscode.DiagnosticSeverity.Warning;
    case 'low': return vscode.DiagnosticSeverity.Information;
    default: return vscode.DiagnosticSeverity.Hint;
  }
}

export class DiffWiseCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private report: ReviewReport | null = null;

  setReport(report: ReviewReport | null): void { this.report = report; this.emitter.fire(); }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.report) return [];
    const rel = vscode.workspace.asRelativePath(document.uri, false);
    const findings = this.report.findings.filter((f) => f.file === rel);
    if (findings.length === 0) return [];
    const top = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]!;
    return [new vscode.CodeLens(new vscode.Range(Math.max(0, top.range.start - 1), 0, Math.max(0, top.range.start - 1), 0), {
      title: `DiffWise: ${findings.length} finding(s)${top.severity === 'critical' || top.severity === 'high' ? ` · ${top.severity}` : ''}`,
      command: 'diffwise.openFinding',
      arguments: [top.id],
    })];
  }

  dispose(): void { this.emitter.dispose(); }
}

function severityRank(s: string): number {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[s] ?? 5;
}
