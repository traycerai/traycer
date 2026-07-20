import type {
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { buildForkWorkspaceSeedFromWorkspaceFolders } from "./fork-workspace-seed";
import { resolvePrimaryPath } from "./resolve-primary-path";

/**
 * The canonical launch-time WorktreeIntent for a workspace snapshot: every
 * folder in `workspace.folders` gets exactly one entry (staged, else the
 * seed's own entry, else a synthesized `local` default - never a gap), and
 * every entry's `isPrimary` is stamped from `resolvePrimaryPath(workspace.
 * folders, workspace.primaryPath)`, NOT from whatever the staged/seed entry's
 * own `isPrimary` bit says. This is the single canonicalizer shared by the
 * new-conversation modal and the seeded pre-create launchers (fork dialogs,
 * terminal-agent launcher) so a primary switch - even onto a folder with no
 * staged entry (a non-git folder, never auto-seeded) - always reaches launch
 * correctly instead of silently producing a zero-primary intent.
 */
export function effectiveWorktreeIntent(input: {
  readonly workspace: LandingDraftWorkspaceSnapshot;
  readonly seedIntent: WorktreeIntent | null;
  readonly stagedIntent: WorktreeIntent | null;
}): WorktreeIntent | null {
  const fallback =
    input.seedIntent ??
    buildForkWorkspaceSeedFromWorkspaceFolders(input.workspace.folders).intent;
  const resolvedPrimary = resolvePrimaryPath(
    input.workspace.folders,
    input.workspace.primaryPath,
  );
  const fallbackByPath = intentEntriesByWorkspacePath(fallback);
  // A null staged intent yields an empty map, so the lookup below degrades to
  // "fallback entry, else synthesize" with no separate nothing-staged branch.
  const stagedByPath = intentEntriesByWorkspacePath(input.stagedIntent);
  const entries = input.workspace.folders.flatMap((workspacePath) => {
    const entry =
      stagedByPath.get(workspacePath) ?? fallbackByPath.get(workspacePath);
    if (entry === undefined) {
      return localIntentEntry(input.workspace, workspacePath, resolvedPrimary);
    }
    return [{ ...entry, isPrimary: workspacePath === resolvedPrimary }];
  });
  return entries.length === 0 ? null : { entries };
}

function localIntentEntry(
  workspace: LandingDraftWorkspaceSnapshot,
  workspacePath: string,
  resolvedPrimary: string | null,
): WorktreeFolderIntent[] {
  if (!Object.hasOwn(workspace.folderInfoByPath, workspacePath)) return [];
  const folder = workspace.folderInfoByPath[workspacePath];
  return [
    {
      kind: "local",
      workspacePath,
      repoIdentifier: folder.repoIdentifier,
      isPrimary: workspacePath === resolvedPrimary,
    },
  ];
}

function intentEntriesByWorkspacePath(
  intent: WorktreeIntent | null,
): ReadonlyMap<string, WorktreeFolderIntent> {
  return new Map(
    intent?.entries.map((entry) => [entry.workspacePath, entry]) ?? [],
  );
}
