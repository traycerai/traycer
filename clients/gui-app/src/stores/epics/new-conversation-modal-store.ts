import type { OrdinaryDraftEditor } from "@/lib/drafts/ordinary-draft-db";
import {
  chatRunSettingsSchema,
  chatRunSettingsSchemaPreUltracode,
} from "@traycer/protocol/persistence/epic/foundation";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { DraftDocument } from "@traycer/protocol/host";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  isComposerMode,
  type ComposerMode,
} from "@/components/home/data/landing-options";
import { isJsonContent } from "@/lib/editor/prosemirror-json";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import { runSettingsFromDraftEcho } from "@/lib/drafts/draft-write-codec";
import { containsPendingInlineImageNode } from "@/lib/composer/image-atoms";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
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
} from "@/stores/home/landing-draft-store";
import { stripBase64ImageNodesWithSelection } from "@/lib/composer/strip-base64-image-nodes";
import {
  parseReturnedSandbox,
  sameStoredReturnedSandbox,
  storeReturnedSandbox,
  type ReturnedSandbox,
  type StoredReturnedSandbox,
} from "@/lib/sandboxes/returned-sandbox";
import { collectAnnotationImageHashes } from "@/lib/browser-view/annotation/browser-annotation-record";
import {
  clearOrdinaryModalSidecars,
  ordinaryModalSidecarsForStorage,
  restoreOrdinaryModalSidecar,
  uncoverOrdinaryModalSidecar,
  useNewConversationAnnotationStore,
} from "./new-conversation-annotation-store";
import { hashOnlyImageHashes } from "@/lib/composer/image-atoms";
import {
  currentOrdinaryDraftScopeBinding,
  onCommittedOrdinaryDraftRows,
  ordinaryDraftOverlayStorage,
  onOrdinaryDraftScopeChanged,
  persistOrdinaryDraftEditor,
  readOrdinaryDraftEditor,
  readWindowOrdinaryDraftScope,
  type PersistedModalDraftSidecar,
  type PersistedModalDraftSidecars,
} from "@/stores/composer/composer-canvas-persistence";
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
  readonly ordinaryCloudProjection?: true;
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
  /**
   * The sandbox a message given back to this draft was going to: the
   * composer stages it again while it holds no pick of its own. Local to
   * this device, like the stage it restores; absent on any other draft.
   */
  readonly returnedSandbox?: StoredReturnedSandbox;
  /** Local to this device: a draft without it whose settings are set counts as chosen and never moves. */
  readonly accountFollowsDefault?: true;
}

/**
 * A give-back must preserve text and any intervening settings or workspace choice.
 * A remembered caret alone can come from autofocus and does not occupy the draft.
 */
export function isNewConversationDraftOccupied(
  draft: NewConversationModalDraftPatch | undefined,
): boolean {
  return (
    draft !== undefined &&
    ((draft.content !== null && !isEmptyLandingDraftContent(draft.content)) ||
      draft.settings !== null ||
      draft.workspace !== null ||
      draft.composerMode !== null)
  );
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
  /** Local and non-dirtying: nothing is published. */
  readonly setAccountFollowsDefault: (epicId: string, follows: boolean) => void;
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
  /**
   * Drops the modal's own workspace, so the draft reads its host's seed
   * again: a sandbox handoff, whose new host has none of the folders picked
   * on the old one.
   */
  readonly clearWorkspace: (epicId: string) => void;
  readonly clearDraft: (epicId: string) => void;
  /**
   * Records, under the signed-in account, or drops the draft's returned
   * sandbox. Not an edit: the draft stays as clean or dirty as it was, and no
   * draft is made for it.
   */
  readonly setReturnedSandbox: (
    epicId: string,
    returned: ReturnedSandbox | StoredReturnedSandbox | null,
  ) => void;
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

const coveredReleasedModalDrafts = new Map<
  string,
  NewConversationModalDraftPatch
>();
let releasedModalOrder: string[] = [];

function releasedModalDrafts(
  drafts: Readonly<Record<string, NewConversationModalDraftPatch | undefined>>,
): Record<string, NewConversationModalDraftPatch | undefined> {
  if (!Object.values(drafts).some((draft) => draft?.ordinaryCloudProjection)) {
    releasedModalOrder = Object.keys(drafts);
    return { ...drafts };
  }
  const released = new Map(
    Object.entries(drafts).flatMap(([epicId, draft]) => {
      const row = draft?.ordinaryCloudProjection
        ? coveredReleasedModalDrafts.get(epicId)
        : draft;
      return row === undefined ? [] : [[epicId, row] as const];
    }),
  );
  releasedModalOrder = [
    ...new Set([
      ...releasedModalOrder.filter((epicId) => released.has(epicId)),
      ...released.keys(),
    ]),
  ];
  return Object.fromEntries(
    releasedModalOrder.map((epicId) => [epicId, released.get(epicId)]),
  );
}

export function readReleasedModalDrafts(): NewConversationModalStore["draftPatchesByEpicId"] {
  return releasedModalDrafts(
    useNewConversationModalStore.getState().draftPatchesByEpicId,
  );
}

function updateReleasedModalDraft(
  epicId: string,
  update: (
    current: NewConversationModalDraftPatch | undefined,
  ) => NewConversationModalDraftPatch | undefined,
): void {
  useNewConversationModalStore.setState((state) => {
    const visible = state.draftPatchesByEpicId[epicId];
    if (visible?.ordinaryCloudProjection) {
      const next = update(coveredReleasedModalDrafts.get(epicId));
      if (next === undefined) coveredReleasedModalDrafts.delete(epicId);
      else coveredReleasedModalDrafts.set(epicId, next);
      return {};
    }
    const current = state.draftPatchesByEpicId[epicId];
    const patches = { ...state.draftPatchesByEpicId };
    const next = update(current);
    if (next === undefined) delete patches[epicId];
    else patches[epicId] = next;
    return { draftPatchesByEpicId: patches };
  });
}

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
      setAccountFollowsDefault: (epicId, follows) => {
        set((state) => {
          const current = state.draftPatchesByEpicId[epicId];
          if (
            current === undefined ||
            (current.accountFollowsDefault === true) === follows
          ) {
            return state;
          }
          const { accountFollowsDefault: _previous, ...rest } = current;
          return {
            draftPatchesByEpicId: {
              ...state.draftPatchesByEpicId,
              [epicId]: follows
                ? { ...rest, accountFollowsDefault: true }
                : rest,
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
      clearWorkspace: (epicId) => {
        const current = get().draftPatchesByEpicId[epicId] ?? EMPTY_DRAFT_PATCH;
        if (current.workspace === null) return;
        notifyDraftLocalEdit(
          applyNewChatLocalPatch(epicId, { workspace: null }, false),
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
      setReturnedSandbox: (epicId, given) =>
        set((state) => {
          const current = state.draftPatchesByEpicId[epicId];
          const returned = given === null ? null : storeReturnedSandbox(given);
          if (
            current === undefined ||
            sameStoredReturnedSandbox(current.returnedSandbox ?? null, returned)
          )
            return state;
          const { returnedSandbox: _previous, ...rest } = current;
          return {
            draftPatchesByEpicId: {
              ...state.draftPatchesByEpicId,
              [epicId]:
                returned === null
                  ? rest
                  : { ...rest, returnedSandbox: returned },
            },
          };
        }),
      resetForTests: () => {
        retiredNewChatDraftIds.clear();
        set({ draftPatchesByEpicId: {} });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.newConversationDraft)),
      storage: createJSONStorage(ordinaryDraftOverlayStorage),
      // Same serialization boundary as the landing store's: a paste's
      // still-pending base64 node never reaches localStorage, while a
      // hash-only node (whose bytes are durably stored) always survives.
      partialize: (state) => {
        persistScopedModalDrafts(state.draftPatchesByEpicId, undefined);
        return {
          draftPatchesByEpicId: Object.fromEntries(
            Object.entries(
              releasedModalDrafts(state.draftPatchesByEpicId),
            ).flatMap(([epicId, patch]) => {
              if (patch === undefined || patch.ordinaryCloudProjection)
                return [];
              return [[epicId, serializeModalDraft(patch, false)]];
            }),
          ),
        };
      },
      // Rebuilt field by field, like the composer store's: the JSON crossing
      // this boundary is untrusted, and one malformed `content` would throw
      // wherever the drafts list flattens it to a preview.
      //
      // `hostRevision` / `generation` / `syncedGeneration` / `draftId` are
      // persisted AS WRITTEN rather than re-dirtied: a reload that marked
      // every clean row dirty would re-publish rows the host already holds.
      merge: (persistedState, currentState) => {
        coveredReleasedModalDrafts.clear();
        const raw = isRecord(persistedState)
          ? persistedState.draftPatchesByEpicId
          : undefined;
        return {
          ...currentState,
          draftPatchesByEpicId: restoreScopedModalDrafts(
            parseModalDrafts(raw, false),
          ),
        };
      },
    },
  ),
);

function serializeModalDraft(
  patch: NewConversationModalDraftPatch,
  scoped: boolean,
): object {
  return {
    ...patch,
    settings:
      patch.settings === null || scoped
        ? patch.settings
        : chatRunSettingsSchemaPreUltracode.parse(patch.settings),
    ...(patch.content === null
      ? {}
      : stripBase64ImageNodesWithSelection(patch.content, patch.selection)),
  };
}

function readModalDraftSettings(
  value: unknown,
  scoped: boolean,
): ChatRunSettings | null {
  if (!scoped) return parseChatRunSettings(value);
  const parsed = chatRunSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseModalDrafts(
  rawPatches: unknown,
  scoped: boolean,
): Record<string, NewConversationModalDraftPatch | undefined> {
  if (!isRecord(rawPatches)) return {};
  const draftPatchesByEpicId: Record<
    string,
    NewConversationModalDraftPatch | undefined
  > = {};
  for (const [epicId, raw] of Object.entries(rawPatches)) {
    if (!isRecord(raw)) continue;
    // A patch with no restorable document is not a draft: it lists
    // nothing and seeds nothing.
    if (!isJsonContent(raw.content, 0)) continue;
    const patch: NewConversationModalDraftPatch = {
      content: raw.content,
      selection: parseNewChatSelection(raw.selection),
      settings: readModalDraftSettings(raw.settings, scoped),
      ...(scoped ? { ordinaryCloudProjection: true as const } : {}),
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
    const returnedSandbox = parseReturnedSandbox(raw.returnedSandbox);
    const withSandbox =
      returnedSandbox === null ? patch : { ...patch, returnedSandbox };
    draftPatchesByEpicId[epicId] =
      raw.accountFollowsDefault === true
        ? { ...withSandbox, accountFollowsDefault: true }
        : withSandbox;
  }
  return draftPatchesByEpicId;
}

function persistScopedModalDrafts(
  drafts: Readonly<Record<string, NewConversationModalDraftPatch | undefined>>,
  sidecars: PersistedModalDraftSidecars | undefined,
): boolean {
  if (currentOrdinaryDraftScopeBinding() === null) return false;
  const currentSidecars =
    sidecars ??
    ordinaryModalSidecarsForStorage(
      useNewConversationAnnotationStore.getState(),
    );
  return persistOrdinaryDraftEditor(
    "modal",
    Object.entries(drafts).flatMap(([epicId, patch]) => {
      if (!patch?.ordinaryCloudProjection || patch.draftId === null) return [];
      const sidecar = currentSidecars[epicId];
      const roots = new Set(
        collectAnnotationImageHashes(sidecar?.records ?? []),
      );
      if (patch.content !== null)
        for (const hash of hashOnlyImageHashes(patch.content)) roots.add(hash);
      return [
        {
          draftId: patch.draftId,
          slot: epicId,
          value: serializeModalDraft(patch, true),
          roots: [...roots],
          dirty:
            patch.generation > patch.syncedGeneration ||
            sidecar?.dirty === true,
          ...(sidecar === undefined ? {} : { sidecar }),
        },
      ];
    }),
  );
}

function restoreScopedModalDrafts(
  released: Readonly<
    Record<string, NewConversationModalDraftPatch | undefined>
  >,
): Record<string, NewConversationModalDraftPatch | undefined> {
  const drafts = { ...released };
  for (const [epicId, patch] of Object.entries(
    parseModalDrafts(readOrdinaryDraftEditor("modal"), true),
  )) {
    const occupant = released[epicId];
    if (patch === undefined) continue;
    if (useNewConversationAnnotationStore.getState().dirtyByEpicId[epicId])
      continue;
    if (
      occupant?.draftId !== undefined &&
      occupant.draftId !== null &&
      (occupant.draftId !== patch.draftId ||
        occupant.generation > occupant.syncedGeneration)
    )
      continue;
    if (occupant !== undefined)
      coveredReleasedModalDrafts.set(epicId, occupant);
    drafts[epicId] = patch;
  }
  return drafts;
}

onOrdinaryDraftScopeChanged((binding) => {
  clearOrdinaryModalSidecars();
  useNewConversationModalStore.setState((state) => {
    const released = releasedModalDrafts(state.draftPatchesByEpicId);
    coveredReleasedModalDrafts.clear();
    return { draftPatchesByEpicId: restoreScopedModalDrafts(released) };
  });
  if (binding === null) return;
  const sidecars = readWindowOrdinaryDraftScope(
    binding.ownerId,
    binding.scopeId,
  )?.modalSidecars;
  const patches = useNewConversationModalStore.getState().draftPatchesByEpicId;
  for (const [epicId, sidecar] of Object.entries(sidecars ?? {})) {
    if (sidecar !== undefined && patches[epicId]?.ordinaryCloudProjection)
      restoreOrdinaryModalSidecar(epicId, sidecar);
  }
});

function uncoverTombstonedModal(
  patches: Record<string, NewConversationModalDraftPatch | undefined>,
  draftId: string,
): void {
  for (const [epicId, patch] of Object.entries(patches)) {
    if (!patch?.ordinaryCloudProjection || patch.draftId !== draftId) continue;
    uncoverOrdinaryModalSidecar(epicId);
    const released = coveredReleasedModalDrafts.get(epicId);
    coveredReleasedModalDrafts.delete(epicId);
    if (released === undefined) delete patches[epicId];
    else patches[epicId] = released;
  }
}

onCommittedOrdinaryDraftRows((rows) => {
  const state = useNewConversationModalStore.getState();
  const patches = { ...state.draftPatchesByEpicId };
  const reloaded = parseModalDrafts(readOrdinaryDraftEditor("modal"), true);
  const binding = currentOrdinaryDraftScopeBinding();
  const sidecars =
    binding === null
      ? undefined
      : readWindowOrdinaryDraftScope(binding.ownerId, binding.scopeId)
          ?.modalSidecars;
  for (const row of rows) {
    const editor = row.editor;
    if (row.recovery === null && editor?.surface === "modal") {
      const patch = reloaded[editor.slot];
      if (patch === undefined) continue;
      const outgoing = patches[editor.slot];
      if (outgoing !== undefined && !outgoing.ordinaryCloudProjection)
        coveredReleasedModalDrafts.set(editor.slot, outgoing);
      patches[editor.slot] = patch;
      const sidecar = sidecars?.[editor.slot];
      if (sidecar !== undefined)
        restoreOrdinaryModalSidecar(editor.slot, sidecar);
    } else if (row.acceptedEntry === null && row.recovery === null) {
      uncoverTombstonedModal(patches, row.draftId);
    }
  }
  useNewConversationModalStore.setState({ draftPatchesByEpicId: patches });
});

useNewConversationAnnotationStore.subscribe((state, previous) => {
  if (
    state.byEpicId === previous.byEpicId &&
    state.dirtyByEpicId === previous.dirtyByEpicId
  )
    return;
  persistScopedModalDrafts(
    useNewConversationModalStore.getState().draftPatchesByEpicId,
    ordinaryModalSidecarsForStorage(state),
  );
});

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
  const found = findReleasedNewChatByDraftId(draftId);
  if (found === null) return false;
  return found.patch.generation > found.patch.syncedGeneration;
}

export function newChatDraftRememberSynced(
  draftId: string,
  hostRevision: number,
  collectedGeneration: number,
): void {
  const found = findReleasedNewChatByDraftId(draftId);
  if (found === null) return;
  updateReleasedModalDraft(found.epicId, (current) => {
    if (current === undefined) return undefined;
    return {
      ...withoutOwnEchoProofWhenClamped(current, hostRevision),
      // Never backward. This field IS the frontier
      // `applyNewChatHostDocument` fences on, and the store cannot check
      // the ordering of what reaches it: the session's held revision is
      // not monotonic across a reconnect, so a stale `drafts.list` can
      // reset it below what is installed and an acknowledgement then
      // carries the lower number through. Scoped by draft id alone,
      // which is exactly how that fence identifies a line too - this
      // patch carries no owner. If new-chat ever gains cross-host
      // re-adoption, the fence and this clamp need the owner together.
      hostRevision: Math.max(current.hostRevision, hostRevision),
      syncedGeneration:
        collectedGeneration >= current.generation
          ? current.generation
          : current.syncedGeneration,
    };
  });
}

/** @returns whether the patch took this document; see `applyHostDocument`. */
export function applyNewChatHostDocument(document: DraftDocument): boolean {
  return applyNewChatDocument(document);
}

function applyNewChatDocument(document: DraftDocument): boolean {
  if (document.kind !== "new-chat") return false;
  // A document for an id this window already deleted is stale by
  // construction: applying it would re-attach the dead id to whatever patch
  // the epic holds now (see `retiredNewChatDraftIds`).
  if (retiredNewChatDraftIds.has(document.draftId)) return false;
  const epicId = document.target.epicId;
  if (epicId === null) return false;
  // Revision frontier, matching `applyLandingHostDocument` and the composer
  // store: image reads finish out of order after subscribe-frame admission,
  // so two upserts for this row can both be admitted and the slower one land
  // last. The older continuation would otherwise overwrite the newer text.
  // Only the same draft line is comparable - a re-mint is different
  // numbering - and a cloud head's synthetic revision 0 is not a position.
  const held = readReleasedModalDrafts()[epicId];
  if (
    held !== undefined &&
    held.draftId === document.draftId &&
    document.revision > 0 &&
    held.hostRevision > document.revision
  ) {
    return false;
  }
  // Whether the document's CONTENT lands, which is the question a caller
  // writing bytes for it has to ask. A dirty row keeps the local text and
  // takes only the identity, so the document's hashes stay unrooted and
  // recovering them would leave bytes resident with nothing to release them.
  // Read before the updater so it is this decision, not a later one.
  const contentLands =
    held === undefined || held.generation <= held.syncedGeneration;
  updateReleasedModalDraft(epicId, (patch) => {
    const current = patch ?? EMPTY_DRAFT_PATCH;
    return current.generation > current.syncedGeneration
      ? {
          ...current,
          draftId: document.draftId,
          hostRevision: document.revision,
          ownerHostId: document.ownerHostId,
        }
      : modalDocumentProjection(current, document, undefined, false);
  });
  return contentLands;
}

function modalDocumentProjection(
  current: NewConversationModalDraftPatch,
  document: Extract<DraftDocument, { kind: "new-chat" }>,
  projection: { readonly settings: ChatRunSettings | null } | undefined,
  scoped: boolean,
): NewConversationModalDraftPatch {
  return {
    ...keptAccountProvenance(
      dropReturnedSandboxOnNewLine(current, document.draftId),
      document,
    ),
    content: document.portable.content,
    selection: document.portable.selection,
    settings:
      projection === undefined
        ? runSettingsFromDraftEcho(
            document.portable.runSettings,
            current.draftId === document.draftId ? current.settings : null,
          )
        : projection.settings,
    composerMode: document.portable.composerMode,
    workspace: document.workspace,
    draftId: document.draftId,
    hostRevision: document.revision,
    ownerHostId: document.ownerHostId,
    ...(!scoped ? {} : { ordinaryCloudProjection: true }),
    lastTouchedAt: document.lastTouchedAt,
    revision: current.revision + 1,
    generation: current.generation,
    syncedGeneration: current.generation,
  };
}

export function buildOrdinaryModalEditor(
  document: Extract<DraftDocument, { kind: "new-chat" }>,
  projection: { readonly settings: ChatRunSettings | null } | undefined,
  sidecar: PersistedModalDraftSidecar,
  options: {
    readonly roots: readonly string[];
    readonly retiring: ReadonlySet<string> | null;
  },
): OrdinaryDraftEditor | null {
  const epicId = document.target.epicId;
  if (epicId === null) return null;
  const held =
    useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
  if (
    (held !== undefined &&
      held.draftId !== null &&
      held.draftId !== document.draftId &&
      !(held.ordinaryCloudProjection && options.retiring?.has(held.draftId))) ||
    useNewConversationAnnotationStore.getState().dirtyByEpicId[epicId]
  )
    return null;
  const patch = modalDocumentProjection(
    held ?? EMPTY_DRAFT_PATCH,
    document,
    projection,
    true,
  );
  return {
    surface: "modal",
    slot: epicId,
    value: { value: serializeModalDraft(patch, true), sidecar },
    roots: options.roots,
    occurrence: crypto.randomUUID(),
    dirty: false,
  };
}

/** An acknowledgement older than the held revision means a newer write came first, so the provenance loses its proof. */
function withoutOwnEchoProofWhenClamped(
  current: NewConversationModalDraftPatch,
  hostRevision: number,
): NewConversationModalDraftPatch {
  if (
    current.accountFollowsDefault !== true ||
    hostRevision >= current.hostRevision
  ) {
    return current;
  }
  const { accountFollowsDefault: _dropped, ...rest } = current;
  return rest;
}

/**
 * Only this window's own write echoing back keeps the provenance. A newer revision
 * is another writer's, and a cloud head (revision 0) proves nothing: equal values
 * are not an own echo.
 */
function keptAccountProvenance(
  current: NewConversationModalDraftPatch,
  document: DraftDocument,
): NewConversationModalDraftPatch {
  if (current.accountFollowsDefault !== true) return current;
  if (
    current.draftId === document.draftId &&
    document.revision > 0 &&
    current.hostRevision === document.revision
  ) {
    return current;
  }
  const { accountFollowsDefault: _dropped, ...rest } = current;
  return rest;
}

/** Another draft line's text does not inherit this line's destination. */
function dropReturnedSandboxOnNewLine(
  current: NewConversationModalDraftPatch,
  draftId: string,
): NewConversationModalDraftPatch {
  if (current.draftId === draftId) return current;
  const { returnedSandbox: _dropped, ...rest } = current;
  return rest;
}

export function applyNewChatHostDelete(draftId: string): void {
  // Retired whether or not a local entry still holds the id: the fence exists
  // for the documents already in flight, not for the row.
  retireNewChatDraftId(draftId);
  const found = findReleasedNewChatByDraftId(draftId);
  if (found !== null) updateReleasedModalDraft(found.epicId, () => undefined);
}

export function collectNewChatDirtyWrites(): ReadonlyArray<{
  readonly epicId: string;
  readonly patch: NewConversationModalDraftPatch;
}> {
  const out: Array<{
    readonly epicId: string;
    readonly patch: NewConversationModalDraftPatch;
  }> = [];
  const patches = readReleasedModalDrafts();
  for (const [epicId, patch] of Object.entries(patches)) {
    if (patch === undefined) continue;
    if (patch.generation <= patch.syncedGeneration) continue;
    if (patch.draftId === null) continue;
    // Same rule as the chat composer's collect: a pending inline image node is
    // a hash rewrite still in flight, and publishing now would put the base64
    // snapshot on the wire that the rewrite is about to make small. The
    // rewrite's own document change re-dirties this patch moments later.
    if (
      patch.content !== null &&
      containsPendingInlineImageNode(patch.content)
    ) {
      continue;
    }
    out.push({ epicId, patch });
  }
  return out;
}

export function dropNewChatAbsentFromList(
  hostId: string,
  listedIds: ReadonlySet<string>,
  boundHostByEpicId: ReadonlyMap<string, string>,
): void {
  const patches = readReleasedModalDrafts();
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
  const found = findReleasedNewChatByDraftId(draftId);
  if (found === null || found.patch.hostRevision === 0) return;
  updateReleasedModalDraft(found.epicId, (current) =>
    current === undefined ? undefined : { ...current, hostRevision: 0 },
  );
}

function findReleasedNewChatByDraftId(draftId: string): {
  readonly epicId: string;
  readonly patch: NewConversationModalDraftPatch;
} | null {
  for (const [epicId, patch] of Object.entries(readReleasedModalDrafts())) {
    if (patch?.draftId === draftId) return { epicId, patch };
  }
  return null;
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
