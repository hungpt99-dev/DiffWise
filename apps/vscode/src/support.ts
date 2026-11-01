import * as vscode from 'vscode';
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

/**
 * Read a VS Code setting only when the developer actually set it.
 *
 * `get()` returns the schema default, which is indistinguishable from a value the
 * user chose. Passing those defaults into the service made VS Code settings
 * override `.diffwise/config.json` silently — a project configured for its
 * gateway was reviewed against api.openai.com with the default model.
 */
export function explicitSetting<T>(key: string): T | undefined {
  const inspected = config().inspect<T>(key);
  if (!inspected) return undefined;
  return inspected.workspaceValue ?? inspected.globalValue ?? inspected.workspaceFolderValue;
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
