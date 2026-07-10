import type {
  WorktreeBinding,
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { bindingToWorktreeIntent } from "./binding-to-intent";

export interface ForkWorkspaceSeed {
  readonly intent: WorktreeIntent | null;
  readonly workspace: LandingDraftWorkspaceSnapshot;
}

export function buildForkWorkspaceSeed(input: {
  readonly binding: WorktreeBinding | null;
  readonly stagedIntent: WorktreeIntent | null;
}): ForkWorkspaceSeed {
  const intent = visibleWorktreeIntent(input.binding, input.stagedIntent);
  return {
    intent,
    workspace: worktreeIntentToLandingWorkspaceSnapshot(intent),
  };
}

/**
 * The A/B fork's workspace seed: each folder is REBASED to the source chat's
 * actual working-copy directory, so the picker treats that directory as the
 * base and the `worktree-carry` override forks a new worktree off ITS working
 * tree. A worktree-bound folder's base becomes the origin WORKTREE PATH (not
 * the root workspace folder — an A/B fork of a worktree-bound chat must not
 * fork the root repo); a local folder's base stays the folder itself. Entries
 * are emitted as `local` carriers: the base directory is the identity, and
 * the picker's seeding override supplies the new-worktree branch selection
 * from that base's disk truth (current branch, generated name).
 */
export function buildAbForkWorkspaceSeed(input: {
  readonly binding: WorktreeBinding | null;
  readonly stagedIntent: WorktreeIntent | null;
}): ForkWorkspaceSeed {
  const visible = visibleWorktreeIntent(input.binding, input.stagedIntent);
  const intent =
    visible === null
      ? null
      : {
          entries: visible.entries.map((entry) => ({
            kind: "local" as const,
            workspacePath:
              entry.kind === "import"
                ? entry.worktreePath
                : entry.workspacePath,
            repoIdentifier: entry.repoIdentifier,
            isPrimary: entry.isPrimary,
          })),
        };
  return {
    intent,
    workspace: worktreeIntentToLandingWorkspaceSnapshot(intent),
  };
}

export function buildForkWorkspaceSeedFromWorkspaceFolders(
  workspaceFolders: readonly string[],
): ForkWorkspaceSeed {
  const intent =
    workspaceFolders.length === 0
      ? null
      : {
          entries: workspaceFolders.map((workspacePath, index) => ({
            kind: "local" as const,
            workspacePath,
            repoIdentifier: null,
            isPrimary: index === 0,
          })),
        };
  return {
    intent,
    workspace: worktreeIntentToLandingWorkspaceSnapshot(intent),
  };
}

export function visibleWorktreeIntent(
  binding: WorktreeBinding | null,
  stagedIntent: WorktreeIntent | null,
): WorktreeIntent | null {
  const bindingIntent = bindingToWorktreeIntent(binding);
  const entries = mergeVisibleEntries(
    bindingIntent?.entries ?? [],
    stagedIntent?.entries ?? [],
  );
  return entries.length === 0 ? null : { entries };
}

function mergeVisibleEntries(
  bindingEntries: ReadonlyArray<WorktreeFolderIntent>,
  stagedEntries: ReadonlyArray<WorktreeFolderIntent>,
): WorktreeFolderIntent[] {
  const stagedByPath = new Map(
    stagedEntries.map((entry) => [entry.workspacePath, entry]),
  );
  const bindingPaths = new Set(
    bindingEntries.map((entry) => entry.workspacePath),
  );
  const overlaidBindingEntries = bindingEntries.map(
    (entry) => stagedByPath.get(entry.workspacePath) ?? entry,
  );
  const stagedOnlyEntries = stagedEntries.filter(
    (entry) => !bindingPaths.has(entry.workspacePath),
  );
  return [...overlaidBindingEntries, ...stagedOnlyEntries];
}

function worktreeIntentToLandingWorkspaceSnapshot(
  intent: WorktreeIntent | null,
): LandingDraftWorkspaceSnapshot {
  if (intent === null) return emptyLandingDraftWorkspaceSnapshot();
  const folderInfoByPath = intent.entries.reduce<
    Record<string, WorkspaceFolderInfo>
  >(
    (accumulator, entry) => ({
      ...accumulator,
      [entry.workspacePath]: folderIntentToWorkspaceFolderInfo(entry),
    }),
    {},
  );
  return {
    folders: intent.entries.map((entry) => entry.workspacePath),
    folderInfoByPath,
  };
}

function folderIntentToWorkspaceFolderInfo(
  intent: WorktreeFolderIntent,
): WorkspaceFolderInfo {
  return {
    path: intent.workspacePath,
    name: workspaceFolderName(intent.workspacePath),
    repoIdentifier: intent.repoIdentifier,
  };
}
