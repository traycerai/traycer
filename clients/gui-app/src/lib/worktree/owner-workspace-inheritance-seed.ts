import type {
  WorktreeBinding,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  buildForkWorkspaceSeed,
  buildForkWorkspaceSeedFromWorkspaceFolders,
  type ForkWorkspaceSeed,
} from "@/lib/worktree/fork-workspace-seed";

export function buildOwnerWorkspaceInheritanceSeed(input: {
  readonly binding: WorktreeBinding | null;
  readonly stagedIntent: WorktreeIntent | null;
  readonly fallbackWorkspaceFolders: readonly string[];
}): ForkWorkspaceSeed | null {
  const stagedIntent =
    input.binding === null || input.binding.entries.length === 0
      ? null
      : input.stagedIntent;
  const bindingSeed = buildForkWorkspaceSeed({
    binding: input.binding,
    stagedIntent,
  });
  if (bindingSeed.intent !== null) return bindingSeed;
  if (input.fallbackWorkspaceFolders.length === 0) return null;
  return buildForkWorkspaceSeedFromWorkspaceFolders(
    input.fallbackWorkspaceFolders,
  );
}
