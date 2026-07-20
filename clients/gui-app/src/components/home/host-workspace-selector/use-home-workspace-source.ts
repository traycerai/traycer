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
  readonly addResolvedFolders: (
    folders: ReadonlyArray<WorkspaceFolderInfo>,
  ) => void;
  readonly removeFolder: (folderPath: string) => PrimaryRemovalTransition;
  readonly setPrimaryFolder: (folderPath: string) => void;
  readonly stageEntry: (entry: WorktreeFolderIntent) => void;
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
  const draftId = stagingKey.surface === "landing" ? stagingKey.draftId : null;
  const modalEpicId =
    stagingKey.surface === "new-conversation" ? stagingKey.epicId : null;
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
  const globalPrimaryPath = useWorkspaceFoldersStore(
    (state) => state.primaryPath,
  );
  const globalFolders = useWorkspaceFoldersStore((state) => state.folders);
  const globalFolderInfoByPath = useWorkspaceFoldersStore(
    (state) => state.folderInfoByPath,
  );
  const {
    addDraftResolvedFolders,
    removeDraftFolder,
    setDraftWorkspacePrimary,
  } = useLandingDraftStore(
    useShallow((state) => ({
      addDraftResolvedFolders: state.addDraftResolvedFolders,
      removeDraftFolder: state.removeDraftFolder,
      setDraftWorkspacePrimary: state.setDraftWorkspacePrimary,
    })),
  );
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
  const source = modalWorkspace ?? draftWorkspace ?? seededWorkspace;
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
  return useMemo(
    () => ({
      source,
      capturedIntent,
      folders,
      primaryPath,
      primaryWorkspacePath,
      addResolvedFolders: (folders) => {
        // The 50-folder cap can evict a SECONDARY folder as a side effect of
        // an add; an evicted folder disappears from rows/persistence but its
        // staged intent entry (if any) would otherwise survive and still
        // reach launch. Cleanup must follow the ACTIVE representation's
        // eviction set: the global cache and an active draft can legitimately
        // diverge, so a cache-only eviction must not erase surviving draft
        // branch/scripts state.
        if (modalEpicId !== null) {
          const evicted = addModalResolvedFolders(
            modalEpicId,
            modalSeedWorkspace,
            folders,
          );
          for (const path of evicted) unstageStoreEntry(stagingKey, path);
          return;
        }
        if (!usingSeededWorkspace) {
          const evicted = addGlobalResolvedFolders(folders);
          if (activeDraftId === null) {
            for (const path of evicted) unstageStoreEntry(stagingKey, path);
          }
        }
        if (activeDraftId !== null) {
          const evicted = addDraftResolvedFolders(activeDraftId, folders);
          for (const path of evicted) unstageStoreEntry(stagingKey, path);
        }
        if (usingSeededWorkspace) {
          const beforeWorkspace =
            seededWorkspaceState.workspace ??
            emptyLandingDraftWorkspaceSnapshot();
          const afterWorkspace = mergeLandingDraftWorkspaceFolders(
            beforeWorkspace,
            folders,
          );
          const afterSet = new Set(afterWorkspace.folders);
          const evicted = beforeWorkspace.folders.filter(
            (path) => !afterSet.has(path),
          );
          setSeededWorkspaceState((current) => ({
            seed: current.seed,
            workspace: mergeLandingDraftWorkspaceFolders(
              current.workspace ?? emptyLandingDraftWorkspaceSnapshot(),
              folders,
            ),
          }));
          for (const path of evicted) unstageStoreEntry(stagingKey, path);
        }
      },
      removeFolder: (folderPath) => {
        const beforeFolders = source?.folders ?? globalFolders;
        const beforePrimary = resolvePrimaryPath(beforeFolders, primaryPath);
        unstageStoreEntry(stagingKey, folderPath);
        if (modalEpicId !== null) {
          removeModalFolder(modalEpicId, modalSeedWorkspace, folderPath);
        } else {
          if (!usingSeededWorkspace) {
            removeGlobalFolder(folderPath);
          }
          if (activeDraftId !== null) {
            removeDraftFolder(activeDraftId, folderPath);
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
        }
        const afterFolders = beforeFolders.filter(
          (path) => path !== folderPath,
        );
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
      },
      setPrimaryFolder: (folderPath) => {
        // Suppress only the duplicate EVENT on a same-primary re-selection;
        // the state writes below must still run so a staged worktree intent's
        // stale isPrimary bit is restamped before launch consumers read it.
        if (folderPath !== primaryPath) {
          Analytics.getInstance().track(
            AnalyticsEvent.WorkspacePrimaryChanged,
            { source: "direct_ui" },
          );
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
      },
      stageEntry: (entry) => {
        stageStoreEntry(stagingKey, entry);
      },
    }),
    [
      activeDraftId,
      addDraftResolvedFolders,
      addGlobalResolvedFolders,
      addModalResolvedFolders,
      capturedIntent,
      folders,
      globalFolders,
      modalEpicId,
      modalSeedWorkspace,
      primaryPath,
      primaryWorkspacePath,
      removeDraftFolder,
      removeGlobalFolder,
      removeModalFolder,
      seededWorkspaceState,
      setDraftWorkspacePrimary,
      setGlobalPrimaryFolder,
      setModalPrimaryFolder,
      setStagedIntent,
      sourceFolderInfoByPath,
      usingSeededWorkspace,
      source,
      stageStoreEntry,
      stagingKey,
      unstageStoreEntry,
    ],
  );
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
