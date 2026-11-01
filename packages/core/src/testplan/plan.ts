/**
 * Verification planning.
 *
 * Turns discovered commands into a plan with an explicit strategy, an approval
 * requirement, a timeout and a sandbox verdict. The plan is data: the UI shows
 * it, the CLI prints it, and the executor refuses to run anything that was not
 * planned from a trusted source.
 */
import { discoverCommands, targetedCommand } from './discover';
import type { DiscoveredCommand, PlanInput, VerificationLevel, VerificationPlan, VerificationPlanItem } from './types';

const DEFAULT_LEVELS: VerificationLevel[] = ['typecheck', 'lint', 'unit'];

const LEVEL_ORDER: VerificationLevel[] = ['static', 'typecheck', 'lint', 'build', 'unit', 'integration', 'contract', 'e2e', 'security', 'custom'];

function order(level: VerificationLevel): number {
  const index = LEVEL_ORDER.indexOf(level);
  return index === -1 ? LEVEL_ORDER.length : index;
}

/**
 * Can this command run without touching the network or a real service?
 * A command that needs either cannot be isolated by DiffWise, and the plan says
 * so instead of implying a sandbox it does not have.
 */
function sandboxable(command: DiscoveredCommand): boolean {
  if (command.requiresNetwork) return false;
  if (/(docker|compose|kubectl|terraform|aws|gcloud|az |psql|mysql|redis-cli)/i.test(command.command)) return false;
  return true;
}

export function buildVerificationPlan(input: PlanInput): VerificationPlan {
  const warnings: string[] = [];
  const discovered = discoverCommands(input);
  const requested = input.levels && input.levels.length > 0 ? input.levels : DEFAULT_LEVELS;
  const targeted = input.targeted ?? true;
  const requireApproval = input.requireApproval ?? true;
  const sandbox = input.sandbox ?? 'none';
  const defaultTimeout = input.defaultTimeoutMs ?? 300_000;

  const testFiles = (input.testFiles ?? [])
    .map((t) => t.path)
    .filter((p) => input.changedFiles.length === 0 || true);

  const items: VerificationPlanItem[] = [];
  const notSelected: VerificationPlan['notSelected'] = [];
  const missing: VerificationLevel[] = [];

  for (const level of [...requested].sort((a, b) => order(a) - order(b))) {
    const candidates = discovered
      .filter((c) => c.level === level)
      .sort((a, b) => (a.source === 'policy' ? 0 : 1) - (b.source === 'policy' ? 0 : 1));
    if (candidates.length === 0) {
      missing.push(level);
      continue;
    }
    const chosen = candidates[0] as DiscoveredCommand;
    const extras = candidates.slice(1);
    for (const extra of extras) {
      notSelected.push({ id: extra.id, command: extra.command, reason: `another ${level} command was preferred (${chosen.id})` });
    }

    let command = chosen.command;
    let targets: string[] | undefined;
    let reason = chosen.reason;
    if (targeted && chosen.targetable) {
      const narrowed = targetedCommand(chosen, testFiles);
      if (narrowed) {
        command = narrowed.command;
        targets = narrowed.targets;
        reason = `${chosen.reason}; narrowed to ${targets.length} test file(s) related to this change`;
      } else if (testFiles.length === 0) {
        reason = `${chosen.reason}; no related test files were resolved, so the full suite is planned`;
      }
    }

    const isolatable = sandboxable(chosen);
    items.push({
      id: chosen.id,
      level,
      label: chosen.label,
      command,
      source: chosen.source,
      timeoutMs: defaultTimeout,
      requiresApproval: requireApproval,
      sandboxable: isolatable,
      reason,
      ...(targets ? { targets } : {}),
    });
    if (!isolatable) {
      warnings.push(`${chosen.id} requires network or external services and cannot be isolated; it will run in the workspace with only a timeout as a control.`);
    }
  }

  for (const command of discovered) {
    if (requested.includes(command.level)) continue;
    notSelected.push({ id: command.id, command: command.command, reason: `level ${command.level} was not requested` });
  }

  const strategy: VerificationPlan['strategy'] = items.length === 0
    ? 'none'
    : items.some((i) => (i.targets?.length ?? 0) > 0) ? 'targeted' : 'full';

  if (items.length === 0) {
    warnings.push('No verification command could be planned: no manifest defined one and policy configured none. DiffWise will not guess a command.');
  }

  const summary = items.length === 0
    ? 'No verification plan: nothing in this repository declares a runnable check.'
    : `${strategy} verification: ${items.map((i) => `${i.level} (${i.command})`).join(', ')}${requireApproval ? '; execution requires explicit approval' : ''}.`;

  return {
    strategy,
    items,
    missing,
    notSelected,
    warnings,
    sandbox,
    summary,
  };
}

/** A plan for reproducing one specific finding: the narrowest command available. */
export function buildReproductionPlan(input: PlanInput, finding: { file: string; title: string }): VerificationPlan {
  const base = buildVerificationPlan({ ...input, levels: ['unit', 'integration'], targeted: true });
  if (base.items.length === 0) {
    return {
      ...base,
      summary: `No test runner was discovered, so a reproduction for “${finding.title}” cannot be executed here.`,
      warnings: [...base.warnings, 'A reproduction requires a runnable test suite; DiffWise will not invent a test command.'],
    };
  }
  const items = base.items.map((item) => ({
    ...item,
    reason: `${item.reason}; selected to reproduce a finding in ${finding.file}`,
  }));
  return {
    ...base,
    items,
    strategy: 'targeted',
    summary: `Reproduction plan for “${finding.title}”: ${items.map((i) => i.command).join(', ')}.`,
  };
}
