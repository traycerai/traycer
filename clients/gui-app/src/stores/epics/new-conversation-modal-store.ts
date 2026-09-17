import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { DraftDocument } from "@traycer/protocol/host";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  isComposerMode,
  type ComposerMode,
} from "@/components/home/data/landing-options";
import { isJsonContent } from "@/lib/editor/prosemirror-json";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import {
  notifyDraftLocalDelete,
  notifyDraftLocalEdit,
} from "@/lib/drafts/draft-local-edits";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import {
  mergeLandingDraftWorkspaceFolders,
  parseChatRunSettings,
  parseLandingDraftWorkspaceSnapshot,
  removeLandingDraftWorkspaceFolder,
  sameLandingDraftWorkspace,
  sameNullableChatRunSettings,
  setLandingDraftWorkspacePrimary,
  stripBase64ImageNodes,
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
   * Bumped on every real `setContent` change. A compare-and-swap token for an
   * asynchronous reader that captures it alongside the epicId and only acts on
   * this draft while the revision it captured still matches, so an edit made
   * while that read was in flight is kept.
   */
  readonly revision: number;
  readonly draftId: string | null;
  readonly hostRevision: number;
  readonly lastTouchedAt: number;
  readonly generation: number;
  readonly syncedGeneration: number;
  /**
   * Display snapshot for the drafts list, recorded by the mounted modal
   * (`setNewChatEpicTitle`). Not on the wire - the epic title comes from the
   * open-epic projector, which exists only for open epics, while the list
   * must name a draft whose epic is closed. `null` until a modal for this
   * epic has mounted.
   */
  readonly epicTitle: string | null;
  /**
   * Host that owns this row, echoed from the host document. `null` until one
   * applies - a modal typed in offline has no owner yet. The drafts list
   * falls back to the epic's bound mirror host (`newChatBoundHostId`) and
   * hides the row when neither answers, since every row action has to name a
   * host client to reach.
   */
  readonly ownerHostId: string | null;
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
  /**
   * Record the drafts-list display snapshot for an EXISTING patch. Non-
   * dirtying by construction, like `setComposerDraftTitles`: it compares
   * first, writes only that field, and deliberately does NOT go through
   * `mergePatch` (which mints a draft identity and bumps `generation`, so a
   * title write would publish a modal the user never typed in). No-op when
   * this epic has no patch yet; there is nothing to label.
   */
  readonly setNewChatEpicTitle: (
    epicId: string,
    epicTitle: string | null,
  ) => void;
  /**
   * Record the host a write for this epic is being sent to. Non-dirtying for
   * the same reason as the title setter, and for a sharper one: it runs while
   * the mirror is COLLECTING dirty writes, so bumping `generation` there would
   * re-dirty the row the collector is about to mark clean and loop it forever.
   */
  readonly setNewChatOwnerHostId: (epicId: string, hostId: string) => void;
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
  epicTitle: null,
  ownerHostId: null,
};

/**
 * Draft ids this window has deleted, so a document still in flight for one
 * cannot re-attach it. The landing store has retirement receipts and the
 * composer store has an identity check; this plane had neither, and a late
 * apply (an upsert or list entry that was awaiting blob reads) would either
 * resurrect a deleted row or - after Delete then Undo - clobber the fresh id
 * the restore minted, leaving the pending delete's ACK to mark the restored
 * content clean and never publish it.
 *
 * Insertion-ordered and capped: a fence only has to outlive the requests that
 * were already in the air.
 */
const RETIRED_NEW_CHAT_DRAFT_IDS_CAP = 256;
const retiredNewChatDraftIds = new Set<string>();

function retireNewChatDraftId(draftId: string): void {
  retiredNewChatDraftIds.delete(draftId);
  retiredNewChatDraftIds.add(draftId);
  for (const id of retiredNewChatDraftIds) {
    if (retiredNewChatDraftIds.size <= RETIRED_NEW_CHAT_DRAFT_IDS_CAP) break;
    retiredNewChatDraftIds.delete(id);
  }
}

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
  persist(
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
        notifyDraftLocalEdit(
          applyNewChatLocalPatch(epicId, { settings }, false),
        );
      },
      setComposerMode: (epicId, mode) => {
        const current = get().draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
        if (current.composerMode === mode) return;
        notifyDraftLocalEdit(
          applyNewChatLocalPatch(epicId, { composerMode: mode }, false),
        );
      },
      setNewChatEpicTitle: (epicId, epicTitle) => {
        set((state) => {
          const current = state.draftPatchesByEpicId[epicId];
          if (current === undefined || current.epicTitle === epicTitle) {
            return state;
          }
          return {
            draftPatchesByEpicId: {
              ...state.draftPatchesByEpicId,
              [epicId]: { ...current, epicTitle },
            },
          };
        });
      },
      setNewChatOwnerHostId: (epicId, hostId) => {
        set((state) => {
          const current = state.draftPatchesByEpicId[epicId];
          if (current === undefined || current.ownerHostId === hostId) {
            return state;
          }
          return {
            draftPatchesByEpicId: {
              ...state.draftPatchesByEpicId,
              [epicId]: { ...current, ownerHostId: hostId },
            },
          };
        });
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
        // Notify BEFORE removing: the coordinator resolves this draft's host
        // through `findNewChatByDraftId`, which reads this store. Removing
        // first left a modal the user is not looking at with no route for its
        // `drafts.delete` at all, and the host went on listing the row.
        if (removed?.draftId !== undefined && removed.draftId !== null) {
          retireNewChatDraftId(removed.draftId);
          notifyDraftLocalDelete(removed.draftId);
        }
        set((state) => {
          const { [epicId]: _removed, ...draftPatchesByEpicId } =
            state.draftPatchesByEpicId;
          return { draftPatchesByEpicId };
        });
      },
      resetForTests: () => {
        retiredNewChatDraftIds.clear();
        set({ draftPatchesByEpicId: {} });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.newConversationDraft)),
      // Same serialization boundary as the landing store's: a paste's
      // still-pending base64 node never reaches localStorage, while a
      // hash-only node (whose bytes are durably stored) always survives.
      partialize: (state) => ({
        draftPatchesByEpicId: Object.fromEntries(
          Object.entries(state.draftPatchesByEpicId).flatMap(
            ([epicId, patch]) =>
              patch === undefined
                ? []
                : [
                    [
                      epicId,
                      {
                        ...patch,
                        content:
                          patch.content === null
                            ? null
                            : stripBase64ImageNodes(patch.content),
                      },
                    ],
                  ],
          ),
        ),
      }),
      // Rebuilt field by field, like the composer store's: the JSON crossing
      // this boundary is untrusted, and one malformed `content` would throw
      // wherever the drafts list flattens it to a preview.
      //
      // `hostRevision` / `generation` / `syncedGeneration` / `draftId` are
      // persisted AS WRITTEN rather than re-dirtied: a reload that marked
      // every clean row dirty would re-publish rows the host already holds.
      merge: (persistedState, currentState) => {
        if (!isRecord(persistedState)) return currentState;
        const rawPatches = persistedState.draftPatchesByEpicId;
        if (!isRecord(rawPatches)) return currentState;
        const draftPatchesByEpicId: Record<
          string,
          NewConversationModalDraftPatch | undefined
        > = {};
        for (const [epicId, raw] of Object.entries(rawPatches)) {
          if (!isRecord(raw)) continue;
          // A patch with no restorable document is not a draft: it lists
          // nothing and seeds nothing.
          if (!isJsonContent(raw.content, 0)) continue;
          draftPatchesByEpicId[epicId] = {
            content: raw.content,
            selection: parseNewChatSelection(raw.selection),
            settings: parseChatRunSettings(raw.settings),
            composerMode: parsePersistedComposerMode(raw.composerMode),
            workspace: parsePersistedWorkspace(raw.workspace),
            revision: nonNegativeNumber(raw.revision),
            draftId: parseNullableId(raw.draftId),
            hostRevision: nonNegativeNumber(raw.hostRevision),
            lastTouchedAt: nonNegativeNumber(raw.lastTouchedAt),
            generation: nonNegativeNumber(raw.generation),
            syncedGeneration: nonNegativeNumber(raw.syncedGeneration),
            epicTitle: typeof raw.epicTitle === "string" ? raw.epicTitle : null,
            ownerHostId: parseNullableId(raw.ownerHostId),
          };
        }
        return { ...currentState, draftPatchesByEpicId };
      },
    },
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNewChatSelection(
  value: unknown,
): NewConversationModalDraftPatch["selection"] {
  if (!isRecord(value)) return null;
  const { from, to } = value;
  if (
    typeof from !== "number" ||
    typeof to !== "number" ||
    !Number.isFinite(from) ||
    !Number.isFinite(to)
  ) {
    return null;
  }
  return { from, to };
}

// `null` is this patch's "the modal has not chosen a mode", so an absent or
// unrecognized value restores as null rather than as a default the user never
// picked (the body seeds its own).
function parsePersistedComposerMode(value: unknown): ComposerMode | null {
  return typeof value === "string" && isComposerMode(value) ? value : null;
}

// `null` is meaningful here - "this modal has no workspace of its own yet, use
// the seed" - so it must survive the round trip rather than collapsing to the
// empty snapshot the way an unparsable record does.
function parsePersistedWorkspace(
  value: unknown,
): LandingDraftWorkspaceSnapshot | null {
  if (value === null || value === undefined) return null;
  return parseLandingDraftWorkspaceSnapshot(value);
}

function parseNullableId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

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
  // A document for an id this window already deleted is stale by
  // construction: applying it would re-attach the dead id to whatever patch
  // the epic holds now (see `retiredNewChatDraftIds`).
  if (retiredNewChatDraftIds.has(document.draftId)) return;
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
            ownerHostId: document.ownerHostId,
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
          ownerHostId: document.ownerHostId,
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
  // Retired whether or not a local entry still holds the id: the fence exists
  // for the documents already in flight, not for the row.
  retireNewChatDraftId(draftId);
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
