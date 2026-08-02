import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  mergeLandingDraftWorkspaceFolders,
  removeLandingDraftWorkspaceFolder,
  setLandingDraftWorkspacePrimary,
  useLandingDraftStore,
  usePendingOrPinnedLandingWorkspace,
  type LandingDraftWorkspaceSnapshot,
} from "@/stores/home/landing-draft-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { restampWorktreeIntentPrimary } from "./worktree-intent-merge";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface PrimaryRemovalTransition {
  // Whether removing the folder demoted-and-reassigned primary to a
  // different remaining folder (the removed folder WAS primary, and at
  // least one folder remains). `false` for a secondary removal, or a
  // removal that empties the workspace.
  readonly primaryChanged: boolean;
  readonly newPrimaryName: string | null;
}

export interface HomeWorkspaceSource {
  readonly source: LandingDraftWorkspaceSnapshot | null;
  readonly capturedIntent: WorktreeIntent | null;
  /** Current folders from the active draft/modal/seed/global representation. */
  readonly folders: ReadonlyArray<string>;
  // Raw stored value for the active workspace representation (draft / modal
  // / seeded / global) - membership-unvalidated. Callers resolve the
  // EFFECTIVE primary via `resolvePrimaryPath(folders, primaryPath)`, the
  // single resolver every consumer (rows, chip, launch) shares.
  readonly primaryPath: string | null;
  /** Membership-validated primary folder for launch consumers. */
  readonly primaryWorkspacePath: string | null;
  /** The persistent saved-project list (global store), selection-independent. */
  readonly savedFolders: ReadonlyArray<string>;
  readonly savedFolderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>;
  /** The pinned default project for NEW tasks (never a per-chat state). */
  readonly pinnedPath: string | null;
  // Whether per-chat selection toggles are meaningful here. `false` only for
  // the implicit global-fallback representation (no draft / modal / seed /
  // pending landing), where "selection" IS the saved list and a deselect
  // would destroy a saved project.
  readonly canToggleSelection: boolean;
  readonly addResolvedFolders: (
    folders: ReadonlyArray<WorkspaceFolderInfo>,
  ) => void;
  readonly removeFolder: (folderPath: string) => PrimaryRemovalTransition;
  /** Selects a SAVED project for the current chat (surface-only add). */
  readonly selectFolder: (folderPath: string) => void;
  /** Deselects a project from the current chat; the saved list is untouched. */
  readonly deselectFolder: (folderPath: string) => PrimaryRemovalTransition;
  /**
   * Switches the chat's MAIN project to `folderPath` in one action: selects
   * it, makes it primary, and drops the previous main from the chat (unless
   * it was the same folder). Additional (checked) folders are untouched. In
   * the global-fallback representation this only moves primary - selection
   * IS the saved list there.
   */
  readonly switchMainFolder: (folderPath: string) => void;
  readonly setPrimaryFolder: (folderPath: string) => void;
  readonly setPinnedFolder: (folderPath: string) => void;
  readonly stageEntry: (entry: WorktreeFolderIntent) => void;
}

/** Returns the draft ID represented by a landing staging key. */
function landingDraftIdFor(stagingKey: WorktreeStagingKey): string | null {
  return stagingKey.surface === "landing" ? stagingKey.draftId : null;
}

/** Returns the epic ID represented by a new-conversation staging key. */
function newConversationEpicIdFor(
  stagingKey: WorktreeStagingKey,
): string | null {
  return stagingKey.surface === "new-conversation" ? stagingKey.epicId : null;
}

/**
 * The single mutation/read seam for every not-yet-created picker's workspace
 * representation (landing draft / new-conversation modal / seeded fork /
 * global), routing each action to the store(s) that own the active
 * representation. Lives in its own module (not `host-workspace-selector.tsx`)
 * so hook-level wiring tests can `renderHook` it directly - it has no
 * host/React-context dependencies of its own (zustand stores only).
 */
export function useHomeWorkspaceSource(
  stagingKey: WorktreeStagingKey,
  workspaceSeed: LandingDraftWorkspaceSnapshot | null,
): HomeWorkspaceSource {
  const draftId = landingDraftIdFor(stagingKey);
  const modalEpicId = newConversationEpicIdFor(stagingKey);
  const draftWorkspace = useLandingDraftStore(
    useShallow((state) => {
      if (draftId === null) return null;
      return (
        state.drafts.find((draft) => draft.id === draftId)?.workspace ?? null
      );
    }),
  );
  const modalWorkspace = useNewConversationModalStore(
    useShallow((state) => {
      if (modalEpicId === null) return null;
      return state.draftPatchesByEpicId[modalEpicId]?.workspace ?? null;
    }),
  );
  const stagingKeyId = worktreeStagingKeyString(stagingKey);
  const capturedIntent = useWorktreeIntentStagingStore(
    (state) => state.intentByKey[stagingKeyId] ?? null,
  );
  const stageStoreEntry = useWorktreeIntentStagingStore(
    (state) => state.stageEntry,
  );
  const unstageStoreEntry = useWorktreeIntentStagingStore(
    (state) => state.unstageEntry,
  );
  const setStagedIntent = useWorktreeIntentStagingStore(
    (state) => state.setIntent,
  );
  const addGlobalResolvedFolders = useWorkspaceFoldersStore(
    (state) => state.addResolvedFolders,
  );
  const removeGlobalFolder = useWorkspaceFoldersStore(
    (state) => state.removeFolder,
  );
  const setGlobalPrimaryFolder = useWorkspaceFoldersStore(
    (state) => state.setPrimaryFolder,
  );
  const setGlobalPinnedFolder = useWorkspaceFoldersStore(
    (state) => state.setPinnedFolder,
  );
  const globalPrimaryPath = useWorkspaceFoldersStore(
    (state) => state.primaryPath,
  );
  const globalPinnedPath = useWorkspaceFoldersStore(
    (state) => state.pinnedPath,
  );
  const globalFolders = useWorkspaceFoldersStore((state) => state.folders);
  const globalFolderInfoByPath = useWorkspaceFoldersStore(
    (state) => state.folderInfoByPath,
  );
  const {
    addDraftResolvedFolders,
    removeDraftFolder,
    setDraftWorkspacePrimary,
    addPendingResolvedFolders,
    removePendingFolder,
    setPendingWorkspacePrimary,
  } = useLandingDraftStore(
    useShallow((state) => ({
      addDraftResolvedFolders: state.addDraftResolvedFolders,
      removeDraftFolder: state.removeDraftFolder,
      setDraftWorkspacePrimary: state.setDraftWorkspacePrimary,
      addPendingResolvedFolders: state.addPendingResolvedFolders,
      removePendingFolder: state.removePendingFolder,
      setPendingWorkspacePrimary: state.setPendingWorkspacePrimary,
    })),
  );
  const pendingOrPinnedWorkspace = usePendingOrPinnedLandingWorkspace();
  const { addModalResolvedFolders, removeModalFolder, setModalPrimaryFolder } =
    useNewConversationModalStore(
      useShallow((state) => ({
        addModalResolvedFolders: state.addResolvedFolders,
        removeModalFolder: state.removeFolder,
        setModalPrimaryFolder: state.setPrimaryFolder,
      })),
    );
  const [seededWorkspaceState, setSeededWorkspaceState] = useState<{
    readonly seed: LandingDraftWorkspaceSnapshot | null;
    readonly workspace: LandingDraftWorkspaceSnapshot | null;
  }>(() => ({ seed: workspaceSeed, workspace: workspaceSeed }));
  if (seededWorkspaceState.seed !== workspaceSeed) {
    setSeededWorkspaceState({
      seed: workspaceSeed,
      workspace: workspaceSeed,
    });
  }
  const seededWorkspace =
    seededWorkspaceState.seed === workspaceSeed
      ? seededWorkspaceState.workspace
      : workspaceSeed;
  // The BLANK landing (no draft minted yet, no seed, no modal) edits a real
  // per-chat PENDING snapshot in the landing-draft store - never the global
  // fallback. `createDraftWithId` consumes that snapshot as the new draft's
  // workspace, so a pre-typing add/main-switch survives the first substantive
  // editor change instead of being silently discarded.
  const usingPendingLanding =
    stagingKey.surface === "landing" &&
    stagingKey.draftId === null &&
    seededWorkspace === null;
  const pendingSource = usingPendingLanding ? pendingOrPinnedWorkspace : null;
  const source =
    modalWorkspace ?? draftWorkspace ?? seededWorkspace ?? pendingSource;
  const activeDraftId = draftWorkspace === null ? null : draftId;
  const modalSeedWorkspace = useMemo(
    () => workspaceSeed ?? emptyLandingDraftWorkspaceSnapshot(),
    [workspaceSeed],
  );
  const usingSeededWorkspace =
    modalEpicId === null && draftWorkspace === null && seededWorkspace !== null;
  // `source` already carries `primaryPath` for every representation except
  // the implicit "no draft, no modal, no seed" case, where the picker reads
  // the global store directly (mirrors `useResolvedWorkspaceFolders`'s own
  // `source === null` fallback) - so the raw primary must fall back the same
  // way, or the two would disagree about which folder is primary.
  const primaryPath = source !== null ? source.primaryPath : globalPrimaryPath;
  const folders = source !== null ? source.folders : globalFolders;
  const primaryWorkspacePath = resolvePrimaryPath(folders, primaryPath);
  const sourceFolderInfoByPath =
    source !== null ? source.folderInfoByPath : globalFolderInfoByPath;
  // Mirror the seeded workspace into an externally-readable slot so a
  // seeded picker's submit handler (outside this hook/component tree) can
  // read the LIVE folders + primary at launch, instead of only the static
  // `workspaceSeed` prop it was opened with. See `seeded-workspace-snapshot-
  // store.ts` for why this external sync is needed (a true external-store
  // sync, not derivable render-time state).
  useEffect(() => {
    // `usingSeededWorkspace` implies `seededWorkspace !== null` (it is one
    // of its conjuncts), so this one guard covers both.
    if (!usingSeededWorkspace) return;
    useSeededWorkspaceSnapshotStore
      .getState()
      .setSnapshot(stagingKey, seededWorkspace);
  }, [usingSeededWorkspace, seededWorkspace, stagingKey]);
  const usingGlobalFallback = source === null;
  return useMemo(() => {
    const applySetPrimary = (folderPath: string): void => {
      // Suppress only the duplicate EVENT on a same-primary re-selection;
      // the state writes below must still run so a staged worktree intent's
      // stale isPrimary bit is restamped before launch consumers read it.
      if (folderPath !== primaryPath) {
        Analytics.getInstance().track(AnalyticsEvent.WorkspacePrimaryChanged, {
          source: "direct_ui",
        });
      }
      if (modalEpicId !== null) {
        setModalPrimaryFolder(modalEpicId, modalSeedWorkspace, folderPath);
      } else {
        if (!usingSeededWorkspace) {
          setGlobalPrimaryFolder(folderPath);
        }
        if (activeDraftId !== null) {
          setDraftWorkspacePrimary(activeDraftId, folderPath);
        }
        if (usingPendingLanding) {
          setPendingWorkspacePrimary(folderPath);
        }
        if (usingSeededWorkspace) {
          setSeededWorkspaceState((current) => ({
            seed: current.seed,
            workspace:
              current.workspace === null
                ? null
                : setLandingDraftWorkspacePrimary(
                    current.workspace,
                    folderPath,
                  ),
          }));
        }
      }
      // Restamp staged intent entries in place (never remove/unstage) so a
      // switch never leaves a stale `isPrimary` bit for another consumer
      // to read before the next launch-boundary canonicalization.
      const restamped = restampWorktreeIntentPrimary(
        capturedIntent,
        folderPath,
      );
      if (restamped !== capturedIntent) {
        setStagedIntent(stagingKey, restamped);
      }
    };
    const applySurfaceOnlyAdd = (
      infos: ReadonlyArray<WorkspaceFolderInfo>,
    ): void => {
      if (modalEpicId !== null) {
        const evicted = addModalResolvedFolders(
          modalEpicId,
          modalSeedWorkspace,
          infos,
        );
        for (const path of evicted) unstageStoreEntry(stagingKey, path);
        return;
      }
      if (activeDraftId !== null) {
        const evicted = addDraftResolvedFolders(activeDraftId, infos);
        for (const path of evicted) unstageStoreEntry(stagingKey, path);
      }
      if (usingPendingLanding) {
        const evicted = addPendingResolvedFolders(infos);
        for (const path of evicted) unstageStoreEntry(stagingKey, path);
      }
      if (usingSeededWorkspace) {
        const beforeWorkspace =
          seededWorkspaceState.workspace ??
          emptyLandingDraftWorkspaceSnapshot();
        const afterWorkspace = mergeLandingDraftWorkspaceFolders(
          beforeWorkspace,
          infos,
        );
        const afterSet = new Set(afterWorkspace.folders);
        const evicted = beforeWorkspace.folders.filter(
          (path) => !afterSet.has(path),
        );
        setSeededWorkspaceState((current) => ({
          seed: current.seed,
          workspace: mergeLandingDraftWorkspaceFolders(
            current.workspace ?? emptyLandingDraftWorkspaceSnapshot(),
            infos,
          ),
        }));
        for (const path of evicted) unstageStoreEntry(stagingKey, path);
      }
    };
    const applySurfaceOnlyRemove = (folderPath: string): void => {
      if (modalEpicId !== null) {
        removeModalFolder(modalEpicId, modalSeedWorkspace, folderPath);
        return;
      }
      if (activeDraftId !== null) {
        removeDraftFolder(activeDraftId, folderPath);
      }
      if (usingPendingLanding) {
        removePendingFolder(folderPath);
      }
      if (usingSeededWorkspace) {
        setSeededWorkspaceState((current) => ({
          seed: current.seed,
          workspace:
            current.workspace === null
              ? null
              : removeLandingDraftWorkspaceFolder(
                  current.workspace,
                  folderPath,
                ),
        }));
      }
    };
    const removalTransitionFor = (
      folderPath: string,
    ): PrimaryRemovalTransition => {
      const beforeFolders = source?.folders ?? globalFolders;
      const beforePrimary = resolvePrimaryPath(beforeFolders, primaryPath);
      const afterFolders = beforeFolders.filter((path) => path !== folderPath);
      const afterPrimary = resolvePrimaryPath(afterFolders, primaryPath);
      const primaryChanged =
        beforePrimary === folderPath &&
        afterPrimary !== null &&
        afterPrimary !== beforePrimary;
      return {
        primaryChanged,
        newPrimaryName: primaryRemovalNewName(
          primaryChanged,
          afterPrimary,
          sourceFolderInfoByPath,
        ),
      };
    };
    return {
      source,
      capturedIntent,
      folders,
      primaryPath,
      primaryWorkspacePath,
      savedFolders: globalFolders,
      savedFolderInfoByPath: globalFolderInfoByPath,
      pinnedPath: globalPinnedPath,
      canToggleSelection: !usingGlobalFallback,
      addResolvedFolders: (added) => {
        // Every explicit add SAVES the folder for future chats (the global
        // list) and selects it for the current representation. The 50-folder
        // cap can evict a SECONDARY folder as a side effect of an add; an
        // evicted folder disappears from rows/persistence but its staged
        // intent entry (if any) would otherwise survive and still reach
        // launch. Cleanup must follow the ACTIVE representation's eviction
        // set: the global cache and an active draft can legitimately
        // diverge, so a cache-only eviction must not erase surviving draft
        // branch/scripts state.
        const globalEvicted = addGlobalResolvedFolders(added);
        if (usingGlobalFallback) {
          for (const path of globalEvicted) {
            unstageStoreEntry(stagingKey, path);
          }
          return;
        }
        // Single-project mode ("Allow multiple folders in chat" off): an
        // explicit add means "work on this project now" - only the first
        // picked folder joins the chat, as its new MAIN (the previous main
        // leaves; the rest are saved for later). Read at call time: the
        // toggle can flip while this seam's memo is still current.
        const allowMultiple =
          useWorkspaceFoldersStore.getState().allowMultipleFolders;
        if (allowMultiple) {
          applySurfaceOnlyAdd(added);
          return;
        }
        const first = added.length > 0 ? added[0] : null;
        if (first === null) return;
        const currentMain = resolvePrimaryPath(folders, primaryPath);
        applySurfaceOnlyAdd([first]);
        if (currentMain === null || currentMain === first.path) return;
        applySetPrimary(first.path);
        unstageStoreEntry(stagingKey, currentMain);
        applySurfaceOnlyRemove(currentMain);
      },
      removeFolder: (folderPath) => {
        // The trash action deletes the project from the SAVED list and drops
        // it from the current chat's selection.
        unstageStoreEntry(stagingKey, folderPath);
        const transition = removalTransitionFor(folderPath);
        removeGlobalFolder(folderPath);
        applySurfaceOnlyRemove(folderPath);
        return transition;
      },
      selectFolder: (folderPath) => {
        if (usingGlobalFallback) return;
        const info = Object.hasOwn(globalFolderInfoByPath, folderPath)
          ? globalFolderInfoByPath[folderPath]
          : null;
        if (info === null) return;
        applySurfaceOnlyAdd([info]);
      },
      deselectFolder: (folderPath) => {
        const transition = removalTransitionFor(folderPath);
        if (usingGlobalFallback) return transition;
        unstageStoreEntry(stagingKey, folderPath);
        applySurfaceOnlyRemove(folderPath);
        return transition;
      },
      setPrimaryFolder: applySetPrimary,
      switchMainFolder: (folderPath) => {
        const currentMain = resolvePrimaryPath(folders, primaryPath);
        if (folderPath === currentMain) return;
        // In the global-fallback representation every saved folder is
        // "selected", so a switch is purely a primary move.
        if (usingGlobalFallback) {
          applySetPrimary(folderPath);
          return;
        }
        const info = folderInfoFor(
          folderPath,
          globalFolderInfoByPath,
          sourceFolderInfoByPath,
        );
        if (info === null) return;
        // Select the new main first, then move primary, then drop the old
        // main - this order never leaves the chat without a primary folder.
        applySurfaceOnlyAdd([info]);
        applySetPrimary(folderPath);
        if (currentMain !== null) {
          unstageStoreEntry(stagingKey, currentMain);
          applySurfaceOnlyRemove(currentMain);
        }
      },
      setPinnedFolder: (folderPath) => {
        // The pin is a property of the SAVED list (default for new tasks),
        // never of the active chat's selection - it always writes globally.
        setGlobalPinnedFolder(folderPath);
      },
      stageEntry: (entry) => {
        stageStoreEntry(stagingKey, entry);
      },
    };
  }, [
    activeDraftId,
    addDraftResolvedFolders,
    addGlobalResolvedFolders,
    addModalResolvedFolders,
    capturedIntent,
    addPendingResolvedFolders,
    folders,
    globalFolderInfoByPath,
    globalFolders,
    globalPinnedPath,
    modalEpicId,
    modalSeedWorkspace,
    primaryPath,
    primaryWorkspacePath,
    removeDraftFolder,
    removeGlobalFolder,
    removeModalFolder,
    removePendingFolder,
    seededWorkspaceState,
    setDraftWorkspacePrimary,
    setGlobalPinnedFolder,
    setGlobalPrimaryFolder,
    setModalPrimaryFolder,
    setPendingWorkspacePrimary,
    setStagedIntent,
    sourceFolderInfoByPath,
    usingGlobalFallback,
    usingPendingLanding,
    usingSeededWorkspace,
    source,
    stageStoreEntry,
    stagingKey,
    unstageStoreEntry,
  ]);
}

/** Saved-list metadata first (the switch target is usually a saved project),
 * then the active representation's own metadata (fork-seeded extras). */
function folderInfoFor(
  folderPath: string,
  globalFolderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
  sourceFolderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
): WorkspaceFolderInfo | null {
  if (Object.hasOwn(globalFolderInfoByPath, folderPath)) {
    return globalFolderInfoByPath[folderPath];
  }
  if (Object.hasOwn(sourceFolderInfoByPath, folderPath)) {
    return sourceFolderInfoByPath[folderPath];
  }
  return null;
}

// The narrated reassignment name for `removeFolder`'s
// `PrimaryRemovalTransition` - `null` unless removal actually demoted-and-
// reassigned primary to a different remaining folder.
function primaryRemovalNewName(
  primaryChanged: boolean,
  afterPrimary: string | null,
  folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
): string | null {
  if (!primaryChanged || afterPrimary === null) return null;
  return Object.hasOwn(folderInfoByPath, afterPrimary)
    ? folderInfoByPath[afterPrimary].name
    : workspaceFolderName(afterPrimary);
}
