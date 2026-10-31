import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewReport, TestExecution } from '@diffwise/core';
import { createProvider, type LlmProvider } from '@diffwise/ai';
import type { UiSettings } from './protocol';

/** Settings, provider construction and the verification runner. */

export function workspaceRoot(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : null;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('diffwise');
}

export function getUiSettings(): UiSettings {
  const c = config();
  const envVar = c.get<string>('provider.apiKeyEnvVar', 'DIFFWISE_API_KEY');
  const extraHeaders = c.get<Record<string, string>>('provider.extraHeaders', {});
  return {
    providerId: c.get<UiSettings['providerId']>('provider.id', 'openai-compatible'),
    baseUrl: c.get<string>('provider.baseUrl', 'https://api.openai.com/v1'),
    model: c.get<string>('provider.model', 'gpt-4o-mini'),
    apiKeyEnvVar: envVar,
    apiKeyPresent: Boolean(process.env[envVar]),
    maxTokens: c.get<number>('provider.maxTokens', 4000),
    temperature: c.get<number>('provider.temperature', 0.1),
    timeoutMs: c.get<number>('provider.timeoutMs', 120000),
    aiEnabled: c.get<boolean>('ai.enabled', true),
    sendRepositoryContent: c.get<boolean>('ai.sendRepositoryContent', false),
    verificationCommand: c.get<string>('verification.command', ''),
    maxFiles: c.get<number>('analysis.maxFiles', 200),
    extraHeaders: extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {},
  };
}

/** UI settings are persisted to the workspace (or user) configuration. */
export async function saveUiSettings(settings: UiSettings): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  const c = config();
  await c.update('provider.id', settings.providerId, target);
  await c.update('provider.baseUrl', settings.baseUrl, target);
  await c.update('provider.model', settings.model, target);
  await c.update('provider.apiKeyEnvVar', settings.apiKeyEnvVar, target);
  await c.update('provider.maxTokens', settings.maxTokens, target);
  await c.update('provider.temperature', settings.temperature, target);
  await c.update('provider.timeoutMs', settings.timeoutMs, target);
  await c.update('provider.extraHeaders', settings.extraHeaders, target);
  await c.update('ai.enabled', settings.aiEnabled, target);
  await c.update('ai.sendRepositoryContent', settings.sendRepositoryContent, target);
  await c.update('verification.command', settings.verificationCommand, target);
  await c.update('analysis.maxFiles', settings.maxFiles, target);
}

export function providerFromSettings(settings: UiSettings): LlmProvider {
  const apiKey = settings.apiKeyEnvVar ? process.env[settings.apiKeyEnvVar] : undefined;
  return createProvider({
    id: settings.providerId,
    baseUrl: settings.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    model: settings.model,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    timeoutMs: settings.timeoutMs,
    extraHeaders: settings.extraHeaders,
  });
}

/** Fast provider for fix generation and discussion, when configured. */
export function fastProviderFromSettings(settings: UiSettings): LlmProvider | undefined {
  const fastModel = config().get<string>('provider.fastModel', '').trim();
  if (!fastModel || fastModel === settings.model) return undefined;
  const apiKey = settings.apiKeyEnvVar ? process.env[settings.apiKeyEnvVar] : undefined;
  return createProvider({
    id: settings.providerId,
    baseUrl: settings.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    model: fastModel,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    timeoutMs: settings.timeoutMs,
    extraHeaders: settings.extraHeaders,
  });
}

/**
 * Run the user-configured verification command.
 *
 * Gated by an explicit modal confirmation at the call site. The command is
 * developer-authored configuration, executed in the workspace root; repository
 * content is never treated as a command.
 */
export async function runVerificationCommand(
  root: string,
  command: string,
  timeoutMs: number,
  ranBy: TestExecution['ranBy'],
): Promise<TestExecution> {
  const startedAt = new Date().toISOString();
  if (!command.trim()) {
    return {
      command, startedAt, durationMs: 0, exitCode: null, status: 'not-run',
      outputTail: 'No verification command is configured (diffwise.verification.command).',
      ranBy, relatedTestsExecuted: false,
    };
  }
  return new Promise<TestExecution>((resolvePromise) => {
    const t0 = Date.now();
    const child = spawn(command, { cwd: root, shell: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
    let output = '';
    let finished = false;
    const finish = (status: TestExecution['status'], exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise({
        command, startedAt, durationMs: Date.now() - t0, exitCode, status,
        outputTail: output.slice(-8000), ranBy,
        relatedTestsExecuted: /(?:test|spec|vitest|jest|pytest|go test)/i.test(command),
      });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish('timed-out', null); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('error', (err) => { output += `\nFailed to start: ${err.message}`; finish('failed', null); });
    child.on('close', (code) => finish(code === 0 ? 'passed' : 'failed', code));
  });
}

/** Load repository text for the files a chat or fix request may reference. */
export async function loadRepoFiles(root: string, report: ReviewReport, limit = 250): Promise<Map<string, string>> {
  const paths = new Set<string>();
  for (const change of report.changes) paths.add(change.path);
  for (const finding of report.findings) {
    paths.add(finding.file);
    for (const e of finding.evidence) if (e.file) paths.add(e.file);
  }
  for (const doc of report.documentation.files) paths.add(doc.path);
  for (const d of report.documentation.findings) {
    paths.add(d.document);
    for (const e of [...d.codeEvidence, ...d.docEvidence]) if (e.file) paths.add(e.file);
  }
  for (const symbol of report.symbols) paths.add(symbol.file);
  for (const item of report.knowledge) if (item.path) paths.add(item.path);
  const map = new Map<string, string>();
  let count = 0;
  for (const path of paths) {
    if (count >= limit) break;
    if (path.includes('..') || path.startsWith('/')) continue;
    try {
      const content = await readFile(join(root, path), 'utf8');
      if (content.length > 400_000) continue;
      map.set(path, content);
      count += 1;
    } catch {
      // Deleted or unreadable file: leave it out rather than fabricating content.
    }
  }
  return map;
}

export function severityIcon(severity: string): vscode.ThemeIcon {
  switch (severity) {
    case 'critical': return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    case 'high': return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
    case 'medium': return new vscode.ThemeIcon('info', new vscode.ThemeColor('editorInfo.foreground'));
    case 'low': return new vscode.ThemeIcon('lightbulb');
    default: return new vscode.ThemeIcon('note');
  }
}

export function diagnosticSeverity(severity: string): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'critical':
    case 'high': return vscode.DiagnosticSeverity.Error;
    case 'medium': return vscode.DiagnosticSeverity.Warning;
    case 'low': return vscode.DiagnosticSeverity.Information;
    default: return vscode.DiagnosticSeverity.Hint;
  }
}
