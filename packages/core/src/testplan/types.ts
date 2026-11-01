/**
 * Verification planning contracts.
 *
 * A verification plan is a proposal, not an execution. Commands come from the
 * repository's own manifest files or from policy — never from a model, never
 * from a finding's prose. Execution requires an explicit approval and is bounded
 * by a timeout.
 */
import type { VerificationLevel } from '../policy/types';

export type { VerificationLevel };

export interface DiscoveredCommand {
  /** Stable id, e.g. `unit`, `typecheck`, `e2e`. */
  id: string;
  label: string;
  level: VerificationLevel;
  command: string;
  /** Which manifest the command was read from. */
  source: 'package.json' | 'makefile' | 'pyproject' | 'pytest' | 'pom' | 'gradle' | 'go.mod' | 'cargo' | 'composer' | 'gemfile' | 'config' | 'policy';
  /** Why this command was inferred. Shown in `diffwise verify --plan`. */
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  /** True when the command may reach the network or a real datastore. */
  requiresNetwork: boolean;
  /** Test files the command can be narrowed to, when the runner supports it. */
  targetable?: boolean;
  /** Underlying runner detected from the script body, e.g. `vitest`, `jest`, `pytest`. */
  runner?: string;
}

export interface VerificationPlanItem {
  id: string;
  level: VerificationLevel;
  label: string;
  command: string;
  source: DiscoveredCommand['source'];
  timeoutMs: number;
  /** True when policy requires an approval flag before execution. */
  requiresApproval: boolean;
  /** False when the command cannot be isolated (needs network, spawns services). */
  sandboxable: boolean;
  reason: string;
  /** Files the run is scoped to, for targeted verification. */
  targets?: string[];
  /** Set when the item is planned but will not run. */
  skipped?: string;
}

export interface VerificationPlan {
  strategy: 'targeted' | 'full' | 'none';
  items: VerificationPlanItem[];
  /** Levels that were requested but could not be planned. */
  missing: VerificationLevel[];
  /** Discovered commands that were not selected, with the reason. */
  notSelected: Array<{ id: string; command: string; reason: string }>;
  warnings: string[];
  /** Sandbox adapter that would wrap execution. */
  sandbox: 'none' | 'docker' | 'nsjail' | 'custom';
  /** Human-readable summary quoted in the report. */
  summary: string;
}

export interface DiscoveryInput {
  /** Repository files, path → content. Pure input, no filesystem access. */
  files: Map<string, string>;
  /** Changed file paths. */
  changedFiles: string[];
  /** Test files discovered by the deterministic analyser. */
  testFiles?: Array<{ path: string; framework: string }>;
  /** Policy-defined commands, which always win over inference. */
  policyCommands?: Array<{ id: string; label: string; level: VerificationLevel; command: string; timeoutMs: number; requiresNetwork: boolean }>;
}

export interface PlanInput extends DiscoveryInput {
  /** Which levels to plan. Empty means "targeted default set". */
  levels?: VerificationLevel[];
  /** Narrow unit/integration commands to the changed files' tests. */
  targeted?: boolean;
  /** Timeout applied when a command does not specify one. */
  defaultTimeoutMs?: number;
  /** Policy approval requirement. */
  requireApproval?: boolean;
  /** Sandbox adapter available in this environment. */
  sandbox?: 'none' | 'docker' | 'nsjail' | 'custom';
}
