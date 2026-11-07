import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { readCachedDefaultWorktreeIntent } from "@/lib/worktree/cached-default-worktree-intent";
import { effectiveWorktreeIntent } from "@/lib/worktree/effective-worktree-intent";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";

/**
 * `hostId` scopes the "globally registered folders" fallback: folder paths
 * are host-local, so the fallback must be the composer's target host's
 * bucket (a tab's bound host, the modal's pinned host, the landing page's
 * active host) - never another machine's paths.
 */
export function useWorkspaceMentionRoots(
  preferredRoots: ReadonlyArray<string> | null,
  fallbackToGlobalWhenEmpty: boolean,
  hostId: string | null,
): ReadonlyArray<string> {
  const workspaceFolders = useWorkspaceFoldersStore(
    (state) => selectWorkspaceFoldersBucket(state, hostId).folders,
  );
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

/**
 * The landing draft's folders (the host's registered folders when the draft
 * names none) and the worktree intent staged for it, on the host it will
 * create on.
 */
function useLandingFoldersAndIntent(draftId: string | null): {
  readonly workspace: LandingDraftWorkspaceSnapshot;
  readonly stagedIntent: WorktreeIntent | null;
  readonly activeHostId: string | null;
} {
  const draftWorkspace = useLandingDraftStore((state) => {
    if (draftId === null) return null;
    return (
      state.drafts.find((draft) => draft.id === draftId)?.workspace ?? null
    );
  });
  // The landing composer's placement is its surface pin (pin ?? effective),
  // so the global folder fallback reads the bucket of the host it will
  // actually create on.
  const activeHostId = useComposerSurfaceHostPin().resolvedHostId;
  const globalWorkspace = useWorkspaceFoldersStore((state) =>
    selectWorkspaceFoldersBucket(state, activeHostId),
  );
  const stagingKeyId = worktreeStagingKeyString({
    surface: "landing",
    hostId: activeHostId,
    draftId,
  });
  const stagedIntent = useWorktreeIntentStagingStore(
    (state) => state.intentByKey[stagingKeyId] ?? null,
  );
  return {
    workspace: draftWorkspace ?? globalWorkspace,
    stagedIntent,
    activeHostId,
  };
}

export function useLandingComposerMentionRoots(
  draftId: string | null,
): ReadonlyArray<string> {
  const { workspace, stagedIntent, activeHostId } =
    useLandingFoldersAndIntent(draftId);
  const preferredRoots = useMemo(
    () => mentionRootsFromWorktreeIntent(workspace.folders, stagedIntent),
    [workspace.folders, stagedIntent],
  );

  // `preferredRoots` already resolves the global folders (intent-aware) in the
  // base-landing case, so the global fallback inside `useWorkspaceMentionRoots`
  // would re-resolve the same source intent-stripped. Disable it - the only way
  // `preferredRoots` is empty here is when there are no folders at all, where
  // the fallback would yield `[]` anyway.
  return useWorkspaceMentionRoots(preferredRoots, false, activeHostId);
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
  return dedupeMentionRoots(binding.entries.map(bindingEntryRoot));
}

// Mirror the host's `entryRunDirectory`: an empty-string worktreePath falls
// back to the workspacePath (where the turn actually runs), so a malformed
// worktree row doesn't drop the folder's mention root the host still uses.
function bindingEntryRoot(entry: WorktreeBindingEntry): string {
  return entry.mode === "worktree" &&
    entry.worktreePath !== null &&
    entry.worktreePath.length > 0
    ? entry.worktreePath
    : entry.workspacePath;
}

/**
 * Composer-scoped roots for a chat: the staged (not-yet-materialized) worktree
 * intent layers over the committed binding per folder - `stagedEntry ??
 * bindingEntry`, the same precedence the workspace selector renders and the
 * send path materializes. This keeps next-message surfaces (mention search,
 * slash-command discovery) from probing a path the staged selection has
 * superseded, e.g. a deleted worktree the user just replaced from the
 * composer.
 *
 * A staged `worktree` (create) entry resolves to its source `workspacePath` -
 * the materialized checkout that stands in until the host creates the worktree
 * at send - and a staged `import` to its existing on-disk worktree. Staged
 * entries for folders absent from the binding contribute their roots too.
 */
export function mentionRootsFromWorktreeBindingAndIntent(
  binding: WorktreeBinding | null,
  intent: WorktreeIntent | null,
): ReadonlyArray<string> {
  if (binding !== null && binding.workspaceMode === "folderless") return [];
  if (intent === null || intent.entries.length === 0) {
    return mentionRootsFromWorktreeBinding(binding);
  }
  const stagedByWorkspacePath = new Map(
    intent.entries.map((entry) => [entry.workspacePath, entry]),
  );
  const bindingEntries = binding === null ? [] : binding.entries;
  const bindingRoots = bindingEntries.map((entry) => {
    const staged = stagedByWorkspacePath.get(entry.workspacePath);
    if (staged === undefined) return bindingEntryRoot(entry);
    stagedByWorkspacePath.delete(entry.workspacePath);
    return folderIntentRoot(staged);
  });
  const stagedOnlyRoots = Array.from(stagedByWorkspacePath.values()).map(
    folderIntentRoot,
  );
  return dedupeMentionRoots([...bindingRoots, ...stagedOnlyRoots]);
}

/**
 * Where a folder's next run starts the CLI under its staged intent, or `null`
 * for a worktree the send has not created yet.
 */
function folderIntentRunDirectory(entry: WorktreeFolderIntent): string | null {
  if (entry.kind === "import") return entry.worktreePath;
  return entry.kind === "local" ? entry.workspacePath : null;
}

/**
 * The directory a chat's next run starts its CLI in: the host's run directory
 * for the binding's declared primary entry (`entryRunDirectory`), after any
 * staged intent for that folder. `null` when the client cannot know it - no
 * binding entries yet (the host falls back to the task's folders), a
 * folderless chat (the host's own task folder), or a primary staged onto a
 * worktree not created yet.
 */
export function runDirectoryFromWorktreeBindingAndIntent(
  binding: WorktreeBinding | null,
  intent: WorktreeIntent | null,
): string | null {
  if (
    binding === null ||
    binding.workspaceMode === "folderless" ||
    binding.entries.length === 0
  ) {
    return null;
  }
  const primary =
    binding.entries.find((entry) => entry.isPrimary) ?? binding.entries[0];
  const staged = intent?.entries.find(
    (entry) => entry.workspacePath === primary.workspacePath,
  );
  if (staged !== undefined) return folderIntentRunDirectory(staged);
  return primary.worktreePath !== null && primary.worktreePath.length > 0
    ? primary.worktreePath
    : primary.workspacePath;
}

/**
 * {@link runDirectoryFromWorktreeBindingAndIntent} for a landing draft, whose
 * new chat's binding uses the workspace's selected primary folder.
 */
export function useLandingRunWorkingDirectory(
  draftId: string | null,
): string | null {
  const { workspace, stagedIntent, activeHostId } =
    useLandingFoldersAndIntent(draftId);
  const queryClient = useQueryClient();
  const summariesKey = useMemo(
    () =>
      hostQueryKeys.method<HostRpcRegistry, "worktree.listByWorkspacePaths">(
        activeHostId,
        "worktree.listByWorkspacePaths",
        {
          workspacePaths: [...workspace.folders],
          scriptRefs: [],
          forceRefresh: false,
        },
      ),
    [activeHostId, workspace.folders],
  );
  const subscribe = useCallback(
    (notify: () => void) => queryClient.getQueryCache().subscribe(notify),
    [queryClient],
  );
  const snapshot = useCallback(
    () => queryClient.getQueryData(summariesKey),
    [queryClient, summariesKey],
  );
  // The picker can cache a new-worktree default before staging it. Re-evaluate
  // when that cache changes, using the same fallback as the submit boundary.
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const intent = effectiveWorktreeIntent({
    workspace,
    stagedIntent,
    seedIntent: readCachedDefaultWorktreeIntent(
      queryClient,
      activeHostId,
      workspace,
    ),
  });
  const primary = resolvePrimaryPath(workspace.folders, workspace.primaryPath);
  if (primary === null) return null;
  const entry = intent?.entries.find(
    (entry) => entry.workspacePath === primary,
  );
  return entry === undefined ? primary : folderIntentRunDirectory(entry);
}

function folderIntentRoot(entry: WorktreeFolderIntent): string {
  return entry.kind === "import" ? entry.worktreePath : entry.workspacePath;
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
      return entry === null ? workspacePath : folderIntentRoot(entry);
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
