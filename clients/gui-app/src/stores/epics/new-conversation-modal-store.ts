import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { create } from "zustand";

import type { ComposerMode } from "@/components/home/data/landing-options";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import {
  mergeLandingDraftWorkspaceFolders,
  removeLandingDraftWorkspaceFolder,
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
  readonly settings: ChatRunSettings | null;
  readonly composerMode: ComposerMode | null;
  readonly workspace: LandingDraftWorkspaceSnapshot | null;
}

interface NewConversationModalStore {
  readonly draftPatchesByEpicId: Readonly<
    Record<string, NewConversationModalDraftPatch | undefined>
  >;
  readonly setContent: (epicId: string, content: JsonContent) => void;
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
  settings: null,
  composerMode: null,
  workspace: null,
};

// Merge a partial patch onto the epic's current draft (seeded from
// EMPTY_DRAFT_PATCH on first touch). Single writer behind every `set*` reducer.
const mergePatch = (
  draftPatchesByEpicId: Readonly<
    Record<string, NewConversationModalDraftPatch | undefined>
  >,
  epicId: string,
  partial: Partial<NewConversationModalDraftPatch>,
): Record<string, NewConversationModalDraftPatch | undefined> => {
  const current = draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
  return { ...draftPatchesByEpicId, [epicId]: { ...current, ...partial } };
};

export const useNewConversationModalStore = create<NewConversationModalStore>()(
  (set, get) => ({
    draftPatchesByEpicId: {},
    setContent: (epicId, content) =>
      set((state) => ({
        draftPatchesByEpicId: mergePatch(state.draftPatchesByEpicId, epicId, {
          content,
        }),
      })),
    setSettings: (epicId, settings) =>
      set((state) => ({
        draftPatchesByEpicId: mergePatch(state.draftPatchesByEpicId, epicId, {
          settings,
        }),
      })),
    setComposerMode: (epicId, mode) =>
      set((state) => ({
        draftPatchesByEpicId: mergePatch(state.draftPatchesByEpicId, epicId, {
          composerMode: mode,
        }),
      })),
    addResolvedFolders: (epicId, seedWorkspace, folders) => {
      const beforeWorkspace =
        get().draftPatchesByEpicId[epicId]?.workspace ?? seedWorkspace;
      set((state) => {
        const current = state.draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
        const workspace = mergeLandingDraftWorkspaceFolders(
          current.workspace ?? seedWorkspace,
          folders,
        );
        return {
          draftPatchesByEpicId: mergePatch(state.draftPatchesByEpicId, epicId, {
            workspace,
          }),
        };
      });
      const afterWorkspace =
        get().draftPatchesByEpicId[epicId]?.workspace ?? seedWorkspace;
      const afterSet = new Set(afterWorkspace.folders);
      return beforeWorkspace.folders.filter((path) => !afterSet.has(path));
    },
    removeFolder: (epicId, seedWorkspace, folderKey) =>
      set((state) => {
        const current = state.draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
        const workspace = removeLandingDraftWorkspaceFolder(
          current.workspace ?? seedWorkspace,
          folderKey,
        );
        return {
          draftPatchesByEpicId: mergePatch(state.draftPatchesByEpicId, epicId, {
            workspace,
          }),
        };
      }),
    setPrimaryFolder: (epicId, seedWorkspace, folderPath) =>
      set((state) => {
        const current = state.draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
        const workspace = setLandingDraftWorkspacePrimary(
          current.workspace ?? seedWorkspace,
          folderPath,
        );
        return {
          draftPatchesByEpicId: mergePatch(state.draftPatchesByEpicId, epicId, {
            workspace,
          }),
        };
      }),
    clearDraft: (epicId) =>
      set((state) => {
        const { [epicId]: _removed, ...draftPatchesByEpicId } =
          state.draftPatchesByEpicId;

        return { draftPatchesByEpicId };
      }),
    resetForTests: () => set({ draftPatchesByEpicId: {} }),
  }),
);
