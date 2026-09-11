import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { DraftDocument } from "@traycer/protocol/host";
import { create } from "zustand";

import type { ComposerMode } from "@/components/home/data/landing-options";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import {
  notifyDraftLocalDelete,
  notifyDraftLocalEdit,
} from "@/lib/drafts/draft-local-edits";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import {
  mergeLandingDraftWorkspaceFolders,
  removeLandingDraftWorkspaceFolder,
  sameLandingDraftWorkspace,
  sameNullableChatRunSettings,
  setLandingDraftWorkspacePrimary,
} from "@/stores/home/landing-draft-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";

export const createEmptyNewConversationContent = (): JsonContent => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});

export interface NewConversationModalSeed {
  readonly content: JsonContent;
  readonly settings: ChatRunSettings | null;
  readonly composerMode: ComposerMode;
  readonly workspace: LandingDraftWorkspaceSnapshot;
}

export interface NewConversationModalDraftPatch {
  readonly content: JsonContent | null;
  // The editor caret, persisted alongside `content` so a focus round-trip that
  // unmounts + remounts the composer body restores the selection, not just the
  // prompt bytes (the body reseeds `initialSelection` from here on mount).
  readonly selection: { readonly from: number; readonly to: number } | null;
  readonly settings: ChatRunSettings | null;
  readonly composerMode: ComposerMode | null;
  readonly workspace: LandingDraftWorkspaceSnapshot | null;
  /**
   * Bumped on every real `setContent` change. The prompt-stash source adapter
   * captures this alongside the epicId as a compare-and-swap token: a stash
   * only clears this draft when the revision it captured still matches, so an
   * edit made while the stash was durably saving is kept.
   */
  readonly revision: number;
  readonly draftId: string | null;
  readonly hostRevision: number;
  readonly lastTouchedAt: number;
  readonly generation: number;
  readonly syncedGeneration: number;
}

interface NewConversationModalStore {
  readonly draftPatchesByEpicId: Readonly<
    Record<string, NewConversationModalDraftPatch | undefined>
  >;
  /**
   * Records a real document mutation - callers must only invoke this from the
   * editor boundary's document-change signal (never a selection-only echo),
   * so every call unconditionally bumps `revision` without comparing content.
   */
  readonly setContent: (epicId: string, content: JsonContent) => void;
  readonly setSelection: (
    epicId: string,
    selection: { readonly from: number; readonly to: number },
  ) => void;
  /**
   * Drops a remembered caret, for a writer that appended to the END of the
   * draft and wants the composer's `autofocus: "end"` to put the caret after
   * what it added rather than restoring wherever the user last was.
   */
  readonly clearSelection: (epicId: string) => void;
  readonly setSettings: (
    epicId: string,
    settings: ChatRunSettings | null,
  ) => void;
  readonly setComposerMode: (epicId: string, mode: ComposerMode) => void;
  // Returns the paths EVICTED by the 50-folder cap (empty when nothing was
  // evicted) so callers can unstage any in-flight worktree intent for them.
  readonly addResolvedFolders: (
    epicId: string,
    seedWorkspace: LandingDraftWorkspaceSnapshot,
    folders: ReadonlyArray<WorkspaceFolderInfo>,
  ) => ReadonlyArray<string>;
  readonly removeFolder: (
    epicId: string,
    seedWorkspace: LandingDraftWorkspaceSnapshot,
    folderKey: string,
  ) => void;
  readonly setPrimaryFolder: (
    epicId: string,
    seedWorkspace: LandingDraftWorkspaceSnapshot,
    folderPath: string,
  ) => void;
  readonly clearDraft: (epicId: string) => void;
  readonly resetForTests: () => void;
}

const EMPTY_DRAFT_PATCH: NewConversationModalDraftPatch = {
  content: null,
  selection: null,
  settings: null,
  composerMode: null,
  workspace: null,
  revision: 0,
  draftId: null,
  hostRevision: 0,
  lastTouchedAt: 0,
  generation: 0,
  syncedGeneration: 0,
};

// Merge a partial patch onto the epic's current draft (seeded from
// EMPTY_DRAFT_PATCH on first touch). Single writer behind every `set*` reducer.
const mergePatch = (
  draftPatchesByEpicId: Readonly<
    Record<string, NewConversationModalDraftPatch | undefined>
  >,
  epicId: string,
  partial: Partial<NewConversationModalDraftPatch>,
  bumpRevision: boolean,
): {
  readonly next: Record<string, NewConversationModalDraftPatch | undefined>;
  readonly draftId: string;
} => {
  const current = draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
  const draftId = current.draftId ?? mintDraftId();
  return {
    draftId,
    next: {
      ...draftPatchesByEpicId,
      [epicId]: {
        ...current,
        ...partial,
        draftId,
        lastTouchedAt: Date.now(),
        generation: current.generation + 1,
        revision: bumpRevision ? current.revision + 1 : current.revision,
      },
    },
  };
};

export const useNewConversationModalStore = create<NewConversationModalStore>()(
  (set, get) => ({
    draftPatchesByEpicId: {},
    setContent: (epicId, content) => {
      notifyDraftLocalEdit(applyNewChatLocalPatch(epicId, { content }, true));
    },
    // Every reducer below compares before it writes. `mergePatch` mints a
    // draft identity and bumps `generation`, so an unchanged value applied
    // anyway makes a modal the user never touched dirty and publishes it.
    setSelection: (epicId, selection) => {
      const current = get().draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
      if (sameNewChatSelection(current.selection, selection)) return;
      notifyDraftLocalEdit(
        applyNewChatLocalPatch(epicId, { selection }, false),
      );
    },
    clearSelection: (epicId) => {
      const current = get().draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
      if (current.selection === null) return;
      notifyDraftLocalEdit(
        applyNewChatLocalPatch(epicId, { selection: null }, false),
      );
    },
    setSettings: (epicId, settings) => {
      const current = get().draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
      if (sameNullableChatRunSettings(current.settings, settings)) return;
      notifyDraftLocalEdit(applyNewChatLocalPatch(epicId, { settings }, false));
    },
    setComposerMode: (epicId, mode) => {
      const current = get().draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
      if (current.composerMode === mode) return;
      notifyDraftLocalEdit(
        applyNewChatLocalPatch(epicId, { composerMode: mode }, false),
      );
    },
    addResolvedFolders: (epicId, seedWorkspace, folders) => {
      const current = get().draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
      const beforeWorkspace = current.workspace ?? seedWorkspace;
      const workspace = mergeLandingDraftWorkspaceFolders(
        beforeWorkspace,
        folders,
      );
      // A merge that adds nothing (every folder already staged) evicts
      // nothing either, so there is no work and no patch - unless the draft
      // has no workspace of its own yet: the first workspace gesture writes
      // the seed through, so the mirror carries the folders the user is
      // looking at rather than `null`.
      if (
        current.workspace !== null &&
        sameLandingDraftWorkspace(beforeWorkspace, workspace)
      ) {
        return [];
      }
      notifyDraftLocalEdit(
        applyNewChatLocalPatch(epicId, { workspace }, false),
      );
      const afterSet = new Set(workspace.folders);
      return beforeWorkspace.folders.filter((path) => !afterSet.has(path));
    },
    removeFolder: (epicId, seedWorkspace, folderKey) => {
      const current = get().draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
      const before = current.workspace ?? seedWorkspace;
      const workspace = removeLandingDraftWorkspaceFolder(before, folderKey);
      if (
        current.workspace !== null &&
        sameLandingDraftWorkspace(before, workspace)
      ) {
        return;
      }
      notifyDraftLocalEdit(
        applyNewChatLocalPatch(epicId, { workspace }, false),
      );
    },
    setPrimaryFolder: (epicId, seedWorkspace, folderPath) => {
      const current = get().draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
      const before = current.workspace ?? seedWorkspace;
      const workspace = setLandingDraftWorkspacePrimary(before, folderPath);
      if (
        current.workspace !== null &&
        sameLandingDraftWorkspace(before, workspace)
      ) {
        return;
      }
      notifyDraftLocalEdit(
        applyNewChatLocalPatch(epicId, { workspace }, false),
      );
    },
    clearDraft: (epicId) => {
      const removed = get().draftPatchesByEpicId[epicId];
      set((state) => {
        const { [epicId]: _removed, ...draftPatchesByEpicId } =
          state.draftPatchesByEpicId;
        return { draftPatchesByEpicId };
      });
      if (removed?.draftId !== undefined && removed.draftId !== null) {
        notifyDraftLocalDelete(removed.draftId);
      }
    },
    resetForTests: () => set({ draftPatchesByEpicId: {} }),
  }),
);

function sameNewChatSelection(
  left: NewConversationModalDraftPatch["selection"],
  right: NewConversationModalDraftPatch["selection"],
): boolean {
  if (left === null || right === null) return left === right;
  return left.from === right.from && left.to === right.to;
}

function applyNewChatLocalPatch(
  epicId: string,
  partial: Partial<NewConversationModalDraftPatch>,
  bumpRevision: boolean,
): string {
  let draftId = "";
  useNewConversationModalStore.setState((state) => {
    const merged = mergePatch(
      state.draftPatchesByEpicId,
      epicId,
      partial,
      bumpRevision,
    );
    draftId = merged.draftId;
    return { draftPatchesByEpicId: merged.next };
  });
  return draftId;
}

export function newChatDraftIsDirty(draftId: string): boolean {
  const found = findNewChatByDraftId(draftId);
  if (found === null) return false;
  return found.patch.generation > found.patch.syncedGeneration;
}

export function newChatDraftRememberSynced(
  draftId: string,
  hostRevision: number,
  collectedGeneration: number,
): void {
  const found = findNewChatByDraftId(draftId);
  if (found === null) return;
  useNewConversationModalStore.setState((state) => {
    const current = state.draftPatchesByEpicId[found.epicId];
    if (current === undefined) return state;
    return {
      draftPatchesByEpicId: {
        ...state.draftPatchesByEpicId,
        [found.epicId]: {
          ...current,
          hostRevision,
          syncedGeneration:
            collectedGeneration >= current.generation
              ? current.generation
              : current.syncedGeneration,
        },
      },
    };
  });
}

export function applyNewChatHostDocument(document: DraftDocument): void {
  if (document.kind !== "new-chat") return;
  const epicId = document.target.epicId;
  if (epicId === null) return;
  useNewConversationModalStore.setState((state) => {
    const current = state.draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
    if (current.generation > current.syncedGeneration) {
      return {
        draftPatchesByEpicId: {
          ...state.draftPatchesByEpicId,
          [epicId]: {
            ...current,
            draftId: document.draftId,
            hostRevision: document.revision,
          },
        },
      };
    }
    return {
      draftPatchesByEpicId: {
        ...state.draftPatchesByEpicId,
        [epicId]: {
          ...current,
          content: document.portable.content,
          selection: document.portable.selection,
          settings: document.portable.runSettings,
          composerMode: document.portable.composerMode,
          workspace: document.workspace,
          draftId: document.draftId,
          hostRevision: document.revision,
          lastTouchedAt: document.lastTouchedAt,
          revision: current.revision + 1,
          generation: current.generation,
          syncedGeneration: current.generation,
        },
      },
    };
  });
}

export function applyNewChatHostDelete(draftId: string): void {
  const found = findNewChatByDraftId(draftId);
  if (found === null) return;
  useNewConversationModalStore.setState((state) => {
    const { [found.epicId]: _removed, ...draftPatchesByEpicId } =
      state.draftPatchesByEpicId;
    return { draftPatchesByEpicId };
  });
}

export function collectNewChatDirtyWrites(): ReadonlyArray<{
  readonly epicId: string;
  readonly patch: NewConversationModalDraftPatch;
}> {
  const out: Array<{
    readonly epicId: string;
    readonly patch: NewConversationModalDraftPatch;
  }> = [];
  const patches = useNewConversationModalStore.getState().draftPatchesByEpicId;
  for (const [epicId, patch] of Object.entries(patches)) {
    if (patch === undefined) continue;
    if (patch.generation <= patch.syncedGeneration) continue;
    if (patch.draftId === null) continue;
    out.push({ epicId, patch });
  }
  return out;
}

export function dropNewChatAbsentFromList(
  hostId: string,
  listedIds: ReadonlySet<string>,
  boundHostByEpicId: ReadonlyMap<string, string>,
): void {
  const patches = useNewConversationModalStore.getState().draftPatchesByEpicId;
  for (const [epicId, patch] of Object.entries(patches)) {
    if (patch === undefined || patch.draftId === null) continue;
    const boundHostId = boundHostByEpicId.get(epicId);
    if (boundHostId === undefined || boundHostId !== hostId) continue;
    if (patch.generation > patch.syncedGeneration) continue;
    if (listedIds.has(patch.draftId)) continue;
    dropNewChatLocalMirror(patch.draftId);
  }
}

/**
 * List-absence is not a delete: keep the modal draft, drop only the host
 * revision so we do not pretend a missing row is still live.
 */
function dropNewChatLocalMirror(draftId: string): void {
  const found = findNewChatByDraftId(draftId);
  if (found === null) return;
  if (found.patch.hostRevision === 0) return;
  useNewConversationModalStore.setState((state) => {
    const current = state.draftPatchesByEpicId[found.epicId];
    if (current === undefined) return state;
    return {
      draftPatchesByEpicId: {
        ...state.draftPatchesByEpicId,
        [found.epicId]: {
          ...current,
          hostRevision: 0,
        },
      },
    };
  });
}

export function findNewChatByDraftId(draftId: string): {
  readonly epicId: string;
  readonly patch: NewConversationModalDraftPatch;
} | null {
  const patches = useNewConversationModalStore.getState().draftPatchesByEpicId;
  for (const [epicId, patch] of Object.entries(patches)) {
    if (patch?.draftId === draftId) return { epicId, patch };
  }
  return null;
}
