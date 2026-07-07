import { useMemo } from "react";
import type {
  WorktreeBinding,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";

export function useWorkspaceMentionRoots(
  preferredRoots: ReadonlyArray<string> | null,
  fallbackToGlobalWhenEmpty: boolean,
): ReadonlyArray<string> {
  const workspaceFolders = useWorkspaceFoldersStore((state) => state.folders);
  return useMemo(() => {
    const preferred =
      preferredRoots === null ? [] : dedupeMentionRoots(preferredRoots);
    if (preferredRoots !== null && preferred.length === 0) {
      return fallbackToGlobalWhenEmpty
        ? dedupeMentionRoots(workspaceFolders)
        : [];
    }
    // When a surface resolves no roots of its own (e.g. a chat whose
    // worktree binding has not loaded yet), callers may still need file/folder
    // mentions to fall back to the globally registered folders.
    if (preferred.length > 0) return preferred;
    return dedupeMentionRoots(workspaceFolders);
  }, [fallbackToGlobalWhenEmpty, preferredRoots, workspaceFolders]);
}

export function useLandingComposerMentionRoots(
  draftId: string | null,
): ReadonlyArray<string> {
  const draftFolders = useLandingDraftStore((state) => {
    if (draftId === null) return null;
    return (
      state.drafts.find((draft) => draft.id === draftId)?.workspace.folders ??
      null
    );
  });
  const globalFolders = useWorkspaceFoldersStore((state) => state.folders);
  const stagingKeyId = worktreeStagingKeyString({
    surface: "landing",
    draftId,
  });
  const stagedIntent = useWorktreeIntentStagingStore(
    (state) => state.intentByKey[stagingKeyId] ?? null,
  );
  const preferredRoots = useMemo(() => {
    const folders = draftFolders ?? globalFolders;
    return mentionRootsFromWorktreeIntent(folders, stagedIntent);
  }, [draftFolders, globalFolders, stagedIntent]);

  // `preferredRoots` already resolves the global folders (intent-aware) in the
  // base-landing case, so the global fallback inside `useWorkspaceMentionRoots`
  // would re-resolve the same source intent-stripped. Disable it - the only way
  // `preferredRoots` is empty here is when there are no folders at all, where
  // the fallback would yield `[]` anyway.
  return useWorkspaceMentionRoots(preferredRoots, false);
}

/**
 * Mention roots for a chat composer. A chat's working directories come from
 * its per-device worktree binding - the same source rendered by the host
 * workspace selector. `worktree` entries run against their sibling worktree
 * directory; `local` entries run against the workspace path itself.
 */
export function mentionRootsFromWorktreeBinding(
  binding: WorktreeBinding | null,
): ReadonlyArray<string> {
  if (binding === null) return [];
  if (binding.workspaceMode === "folderless") return [];
  // Mirror the host's `entryRunDirectory`: an empty-string worktreePath falls
  // back to the workspacePath (where the turn actually runs), so a malformed
  // worktree row doesn't drop the folder's mention root the host still uses.
  return dedupeMentionRoots(
    binding.entries.map((entry) =>
      entry.mode === "worktree" &&
      entry.worktreePath !== null &&
      entry.worktreePath.length > 0
        ? entry.worktreePath
        : entry.workspacePath,
    ),
  );
}

export function worktreeBindingIsFolderless(
  binding: WorktreeBinding | null,
): boolean {
  return binding?.workspaceMode === "folderless";
}

export function mentionRootsFromWorktreeIntent(
  workspacePaths: ReadonlyArray<string>,
  intent: WorktreeIntent | null,
): ReadonlyArray<string> {
  return dedupeMentionRoots(
    workspacePaths.map((workspacePath) => {
      const entry =
        intent?.entries.find(
          (intentEntry) => intentEntry.workspacePath === workspacePath,
        ) ?? null;
      if (entry !== null && entry.kind === "import") {
        return entry.worktreePath;
      }
      return workspacePath;
    }),
  );
}

function dedupeMentionRoots(
  roots: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return Array.from(
    new Set(
      roots.flatMap((root) => {
        const trimmed = root.trim();
        return trimmed.length > 0 ? [trimmed] : [];
      }),
    ),
  );
}
