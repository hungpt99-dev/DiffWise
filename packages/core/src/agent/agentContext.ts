import { randomUUID } from 'node:crypto';
import type { AgentContext, AgentEvent, FileChange, IntentAlignment } from '../types';

export function makeAgentEvent(type: AgentEvent['type'], title: string, detail: string, extra: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: `evt-${randomUUID().slice(0, 12)}`,
    type,
    title,
    detail,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Build the agent section and compare stated intent with the actual diff.
 *
 * The comparison is deliberately mechanical: it only checks which files the
 * agent said it would touch versus which files changed. It makes no claim about
 * whether the implementation is correct.
 */
export function buildAgentContext(events: AgentEvent[], changes: FileChange[]): AgentContext {
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const by = (type: AgentEvent['type']): AgentEvent[] => sorted.filter((e) => e.type === type);
  const touched = changes.map((c) => c.path);

  const alignments: IntentAlignment[] = [];
  for (const plan of [...by('task_intent'), ...by('plan')]) {
    const planned = new Set((plan.files ?? []).filter(Boolean));
    if (planned.size === 0) {
      alignments.push({
        intent: plan,
        touchedFiles: touched,
        unplannedFiles: [],
        plannedButUnchanged: [],
        verdict: 'not-verifiable',
        note: 'No files were recorded with this intent, so the diff cannot be compared against it.',
      });
      continue;
    }
    const unplanned = touched.filter((t) => !planned.has(t) && !isSupporting(t));
    const unchanged = [...planned].filter((p) => !touched.includes(p));
    const verdict: IntentAlignment['verdict'] = unplanned.length === 0 && unchanged.length === 0
      ? 'aligned'
      : unplanned.length === 0 ? 'partially-aligned'
      : unplanned.length > touched.length / 2 ? 'divergent' : 'partially-aligned';
    alignments.push({
      intent: plan,
      touchedFiles: touched,
      unplannedFiles: unplanned,
      plannedButUnchanged: unchanged,
      verdict,
      note: verdict === 'aligned'
        ? 'Every recorded file changed and no unplanned file was touched.'
        : `${unplanned.length} touched file(s) were not in the recorded plan; ${unchanged.length} planned file(s) did not change.`,
    });
  }

  return {
    events: sorted,
    intents: by('task_intent'),
    decisions: by('decision'),
    alternatives: by('alternative'),
    constraints: by('constraint'),
    activities: by('activity'),
    verifications: by('verification'),
    unresolved: by('unresolved_issue'),
    intentAlignment: alignments,
  };
}

/** Documentation, lockfiles and formatting changes are not "extra features". */
function isSupporting(path: string): boolean {
  return /(^|\/)(README|CHANGELOG|LICENSE)(\.|$)/i.test(path)
    || /\.(md|mdx|json|lock)$/.test(path)
    || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path);
}

export function emptyAgentContext(): AgentContext {
  return {
    events: [], intents: [], decisions: [], alternatives: [], constraints: [],
    activities: [], verifications: [], unresolved: [], intentAlignment: [],
  };
}
