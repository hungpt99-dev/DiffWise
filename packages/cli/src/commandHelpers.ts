/**
 * Small helpers shared by CLI commands.
 *
 * They exist so a command can read platform state (policy layers, rule packs)
 * without constructing a full service or duplicating filesystem logic.
 */
import { loadPolicyFiles } from '@diffwise/app';
import type { PolicyLayerInput } from '@diffwise/core';

export { loadPolicyFiles };

export async function loadPolicyForCli(root: string): Promise<{ layers: PolicyLayerInput[]; problems: Array<{ path: string; message: string }> }> {
  const files = await loadPolicyFiles(root);
  return { layers: files.layers, problems: files.problems };
}
