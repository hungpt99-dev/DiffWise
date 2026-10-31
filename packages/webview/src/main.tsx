import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import type { HostMessage, UiSettings } from './protocol';
import { isVsCodeHost } from './protocol';
import type { ReviewReport } from '@diffwise/core';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');
createRoot(container).render(<StrictMode><App /></StrictMode>);

/**
 * Standalone harness bootstrap.
 *
 * Loads a report produced by the real engine (scripts/analyze.mjs writes it) so
 * the UI can be developed and layout-tested in a browser. It deliberately does
 * not simulate host actions: git, patches and model calls are unavailable here.
 */
async function bootstrapStandalone(): Promise<void> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}sample-report.json`, { cache: 'no-store' });
    if (!response.ok) return;
    const report = await response.json() as ReviewReport;
    const settings: UiSettings = {
      providerId: (report.settings.providerId as UiSettings['providerId']) ?? 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: report.settings.model ?? 'gpt-4o-mini',
      apiKeyEnvVar: 'DIFFWISE_API_KEY',
      apiKeyPresent: false,
      maxTokens: 8000,
      temperature: 0.1,
      timeoutMs: 180000,
      aiEnabled: report.settings.aiEnabled,
      sendRepositoryContent: report.settings.sendRepositoryContent,
      verificationCommand: report.settings.verificationCommand ?? '',
      maxFiles: report.settings.maxFiles,
      extraHeaders: {},
    };
    const message: HostMessage = {
      type: 'report',
      report,
      history: [],
      settings,
      appliedFixes: report.appliedFixes ?? [],
    };
    window.dispatchEvent(new CustomEvent<HostMessage>('diffwise-standalone-message', { detail: message }));
  } catch {
    // A missing sample report is a valid empty state.
  }
}

if (!isVsCodeHost()) void bootstrapStandalone();
