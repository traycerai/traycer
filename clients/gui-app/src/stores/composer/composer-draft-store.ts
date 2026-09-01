import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftDocument, DraftPublication } from "@traycer/protocol/host";
import { isJsonContent } from "@/lib/editor/prosemirror-json";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { legacyComposerDraftId, mintDraftId } from "@/lib/drafts/draft-ids";
import { notifyDraftLocalEdit } from "@/lib/drafts/draft-local-edits";
import {
  collectDraftAnnotationImageHashes,
  mergeBrowserAnnotationRecords,
  parseBrowserAnnotationRecords,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/annotation/browser-annotation-record";
import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";

export interface DraftSelection {
  readonly from: number;
  readonly to: number;
}

export interface DraftState {
  readonly content: JsonContent;
  readonly selection: DraftSelection | null;
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
  /**
   * Bumped only when the draft is replaced from outside the editor
   * (queue-edit restore, failed-send handoff, submit-clear). The composer
   * watches this counter to push the new content into Tiptap; routine
   * keystroke snapshots from the editor never bump it.
   *
   * The sidecar array (`browserAnnotations`) deliberately does NOT bump it:
   * it is not the DOCUMENT, so a bump there would replay a stale
   * content+selection into a live editor for a change the document does not
   * contain. The attachment strip subscribes to `browserAnnotations`
   * directly.
   */
  readonly resetEpoch: number;
  /**
   * Bumped on every real content change - typed/pasted edits via
   * `setSnapshot` AND external replacements via `replaceDraft` (queue-edit
   * restore, failed-send handoff, `clearDraft`). The prompt-stash source
   * adapter captures this alongside the chatId as a compare-and-swap token:
   * a stash only clears this draft when the revision it captured still
   * matches, so an edit made while the stash was durably saving is kept.
   *
   * The sidecar mutation bumps it too, unlike `resetEpoch`: the stash carries
   * only the DOCUMENT, while the `clearDraft` it performs on a matching token
   * wipes `browserAnnotations` as well. An annotation attached while that
   * IndexedDB save was in flight would otherwise be destroyed with nothing
   * holding it.
   */
  readonly revision: number;
  /** Client-minted host row id; null until the first local edit. */
  readonly draftId: string | null;
  /** Last host revision we applied or upserted; 0 if never synced. */
  readonly hostRevision: number;
  /**
   * Required by the host whenever `targetChatId` is set. Bound from the
   * composer (the chat's epic); upserts are skipped until this is known.
   */
  readonly targetEpicId: string | null;
  readonly lastTouchedAt: number;
  readonly generation: number;
  readonly syncedGeneration: number;
  /** Host that currently owns the row; null until a host document applies. */
  readonly ownerHostId: string | null;
  readonly origin: "own" | "replica" | null;
  readonly publication: DraftPublication | null;
}

export interface PendingSubmittedDraftDelete {
  readonly hostId: string;
}

interface ComposerDraftStore {
  readonly drafts: Partial<Record<string, DraftState>>;
  readonly pendingSubmittedDraftDeletes: Partial<
    Record<string, PendingSubmittedDraftDelete>
  >;
  /**
   * Records a real document mutation - callers must only invoke this from the
   * editor boundary's document-change signal (never a selection-only echo),
   * so every call unconditionally bumps `revision` without comparing content.
   */
  readonly setSnapshot: (
    chatId: string,
    content: JsonContent,
    selection: DraftSelection | null,
  ) => void;
  /**
   * Persists a caret move alone. Never touches `revision` - a selection-only
   * change is not a content edit - and never compares/serializes `content`.
   */
  readonly setSelection: (
    chatId: string,
    selection: DraftSelection | null,
  ) => void;
  readonly replaceDraft: (
    chatId: string,
    content: JsonContent,
    selection: DraftSelection | null,
  ) => void;
  readonly addBrowserAnnotation: (
    chatId: string,
    record: BrowserAnnotationRecord,
  ) => void;
  readonly removeBrowserAnnotation: (
    chatId: string,
    annotationId: string,
  ) => void;
  /**
   * Rejected-send restore: put records back without duplicating an id that
   * is already on the draft (the user may have re-attached while the send
   * was in flight).
   */
  readonly restoreBrowserAnnotations: (
    chatId: string,
    records: ReadonlyArray<BrowserAnnotationRecord>,
  ) => void;
  /**
   * Resets a chat's draft to empty in place - empty annotations, then the
   * same `replaceDraft` broadcast used by queue-edit restore / failed-send
   * handoff - instead of deleting the map entry. A delete can't reliably
   * notify every mounted composer for this `chatId` (split panes, keep-alive
   * tabs): a sibling's `resetEpoch` selector falls back to the same `?? 0`
   * whether the entry never existed or was just removed, so a delete after
   * routine (non-bumping) keystrokes produces no observable change and the
   * sibling's stale Tiptap document never clears. Bumping `resetEpoch` in
   * place is the only way every mounted `useChatComposerDraft` for this
   * `chatId` reliably observes the clear. The explicit empty-document caret
   * applies the reset without invoking `setContent(..., null)`'s focus-at-end
   * behavior in sibling composers. Going through `replaceDraft` is also what
   * routes the clear to the host mirror.
   */
  readonly clearDraft: (chatId: string) => void;
  /**
   * Retire the submitted draft's host identity. `clearDraft` empties the
   * document but KEEPS `draftId`, so a keystroke landing while the submit
   * finalizer is still flushing and deleting that row would be published
   * under the very id about to be tombstoned - and the tombstone's
   * `rememberSynced(id, 0, ...)` would then mark that content clean, leaving
   * it local-only. Dropping the id here means the next edit mints a fresh
   * one and a fresh host row. The row is left CLEAN because it is empty and
   * its old id is on its way out; nothing is owed to the host.
   */
  readonly fenceAndDetachSubmittedDraft: (
    chatId: string,
    draftId: string,
    hostId: string,
  ) => void;
  readonly completeSubmittedDraftDelete: (draftId: string) => void;
  readonly bindTarget: (chatId: string, epicId: string) => void;
}
const EMPTY_COMPOSER_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};
const EMPTY_COMPOSER_SELECTION: DraftSelection = { from: 1, to: 1 };

export const EMPTY_COMPOSER_DRAFT: DraftState = {
  content: EMPTY_COMPOSER_CONTENT,
  selection: null,
  browserAnnotations: [],
  resetEpoch: 0,
  revision: 0,
  draftId: null,
  hostRevision: 0,
  targetEpicId: null,
  lastTouchedAt: 0,
  generation: 0,
  syncedGeneration: 0,
  ownerHostId: null,
  origin: null,
  publication: null,
};

function ensureDraft(
  drafts: Partial<Record<string, DraftState>>,
  chatId: string,
): DraftState {
  return drafts[chatId] ?? EMPTY_COMPOSER_DRAFT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasDraftMap(value: unknown): value is Record<string, unknown> & {
  readonly drafts: Record<string, unknown>;
} {
  return isRecord(value) && isRecord(value.drafts);
}

function isDraftSelection(value: unknown): value is DraftSelection {
  return (
    isRecord(value) &&
    typeof value.from === "number" &&
    Number.isFinite(value.from) &&
    typeof value.to === "number" &&
    Number.isFinite(value.to)
  );
}

export const useComposerDraftStore = create<ComposerDraftStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      pendingSubmittedDraftDeletes: {},
      setSnapshot: (chatId, content, selection) => {
        const draftId = touchLocalComposerDraft(chatId, {
          content,
          selection,
          bumpRevision: true,
          bumpResetEpoch: false,
        });
        notifyDraftLocalEdit(draftId);
      },
      setSelection: (chatId, selection) => {
        const current = ensureDraft(get().drafts, chatId);
        if (
          current.selection?.from === selection?.from &&
          current.selection?.to === selection?.to
        ) {
          return;
        }
        const draftId = touchLocalComposerDraft(chatId, {
          content: current.content,
          selection,
          bumpRevision: false,
          bumpResetEpoch: false,
        });
        notifyDraftLocalEdit(draftId);
      },
      replaceDraft: (chatId, content, selection) => {
        const draftId = touchLocalComposerDraft(chatId, {
          content,
          selection,
          bumpRevision: true,
          bumpResetEpoch: true,
        });
        notifyDraftLocalEdit(draftId);
      },
      addBrowserAnnotation: (chatId, record) => {
        set((state) => {
          const current = ensureDraft(state.drafts, chatId);
          const next = mergeBrowserAnnotationRecords(
            current.browserAnnotations,
            [record],
          );
          if (next === current.browserAnnotations) return state;
          return {
            drafts: {
              ...state.drafts,
              [chatId]: {
                ...current,
                browserAnnotations: next,
                revision: current.revision + 1,
              },
            },
          };
        });
      },
      removeBrowserAnnotation: (chatId, annotationId) => {
        set((state) => {
          const current = ensureDraft(state.drafts, chatId);
          const next = current.browserAnnotations.filter(
            (record) => record.annotationId !== annotationId,
          );
          if (next.length === current.browserAnnotations.length) return state;
          return {
            drafts: {
              ...state.drafts,
              [chatId]: {
                ...current,
                browserAnnotations: next,
                revision: current.revision + 1,
              },
            },
          };
        });
      },
      restoreBrowserAnnotations: (chatId, records) => {
        set((state) => {
          const current = ensureDraft(state.drafts, chatId);
          const next = mergeBrowserAnnotationRecords(
            current.browserAnnotations,
            records,
          );
          if (next === current.browserAnnotations) return state;
          return {
            drafts: {
              ...state.drafts,
              [chatId]: {
                ...current,
                browserAnnotations: next,
                revision: current.revision + 1,
              },
            },
          };
        });
      },
      clearDraft: (chatId) => {
        // Sidecar first, document second: `replaceDraft` is the broadcast
        // (resetEpoch bump + host notify), and the sidecar wipe must already
        // be in the state that broadcast is observed against.
        set((state) => {
          const current = ensureDraft(state.drafts, chatId);
          if (current.browserAnnotations.length === 0) return state;
          return {
            drafts: {
              ...state.drafts,
              [chatId]: { ...current, browserAnnotations: [] },
            },
          };
        });
        get().replaceDraft(
          chatId,
          EMPTY_COMPOSER_CONTENT,
          EMPTY_COMPOSER_SELECTION,
        );
        scheduleLandingImageReconcile();
      },
      fenceAndDetachSubmittedDraft: (chatId, draftId, hostId) => {
        set((state) => {
          const current = ensureDraft(state.drafts, chatId);
          if (current.draftId !== draftId) return state;
          return {
            pendingSubmittedDraftDeletes: {
              ...state.pendingSubmittedDraftDeletes,
              [draftId]: { hostId },
            },
            drafts: {
              ...state.drafts,
              [chatId]: {
                ...current,
                draftId: null,
                hostRevision: 0,
                ownerHostId: null,
                origin: null,
                publication: null,
                syncedGeneration: current.generation,
              },
            },
          };
        });
      },
      completeSubmittedDraftDelete: (draftId) => {
        set((state) => {
          if (state.pendingSubmittedDraftDeletes[draftId] === undefined) {
            return state;
          }
          const pendingSubmittedDraftDeletes = {
            ...state.pendingSubmittedDraftDeletes,
          };
          delete pendingSubmittedDraftDeletes[draftId];
          return { pendingSubmittedDraftDeletes };
        });
      },
      bindTarget: (chatId, epicId) => {
        const current = ensureDraft(get().drafts, chatId);
        if (current.targetEpicId === epicId) return;
        const notifyId = current.draftId;
        const shouldNotify = current.generation > current.syncedGeneration;
        set((state) => {
          const existing = ensureDraft(state.drafts, chatId);
          if (existing.targetEpicId === epicId) return state;
          return {
            drafts: {
              ...state.drafts,
              [chatId]: { ...existing, targetEpicId: epicId },
            },
          };
        });
        if (shouldNotify && notifyId !== null) {
          notifyDraftLocalEdit(notifyId);
        }
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.composerDraft)),
      // Synchronous localStorage hydration can finish during `create(...)`,
      // before an `onFinishHydration` subscriber can be registered. Normalize
      // at the merge boundary so legacy revisions are safe on initial import.
      merge: (persistedState, currentState) => {
        if (!hasDraftMap(persistedState)) return currentState;
        const drafts: Partial<Record<string, DraftState>> = {};
        for (const [taskId, value] of Object.entries(persistedState.drafts)) {
          if (!isRecord(value)) continue;
          if (!isJsonContent(value.content, 0)) continue;
          if (value.selection !== null && !isDraftSelection(value.selection)) {
            continue;
          }
          drafts[taskId] = {
            content: value.content,
            selection: value.selection,
            browserAnnotations: parseBrowserAnnotationRecords(
              value.browserAnnotations,
            ),
            resetEpoch: normalizedLegacyResetEpoch(value) + 1,
            revision: normalizedLegacyRevision(value),
            // Deterministic, not minted: this merged state is never persisted
            // back, so a second window hydrating the same legacy draft must
            // arrive at the same id or both would publish. Only an ABSENT
            // field is legacy - an explicit null is `detachSubmittedDraft`'s
            // "mint fresh on the next edit", and re-deriving the old id here
            // would publish new content under a row being tombstoned.
            draftId:
              "draftId" in value
                ? normalizedDraftId(value)
                : legacyComposerDraftId(taskId),
            hostRevision: normalizedNonNegative(value.hostRevision),
            targetEpicId: normalizedNullableId(value.targetEpicId),
            lastTouchedAt: normalizedNonNegative(value.lastTouchedAt),
            generation: 1,
            syncedGeneration: 0,
            ownerHostId: normalizedNullableId(value.ownerHostId),
            origin: normalizedOrigin(value.origin),
            publication: null,
          };
        }
        const pendingSubmittedDraftDeletes: Partial<
          Record<string, PendingSubmittedDraftDelete>
        > = {};
        if (isRecord(persistedState.pendingSubmittedDraftDeletes)) {
          for (const [draftId, value] of Object.entries(
            persistedState.pendingSubmittedDraftDeletes,
          )) {
            if (!isRecord(value)) continue;
            const hostId = normalizedNullableId(value.hostId);
            if (draftId.length === 0 || hostId === null) continue;
            pendingSubmittedDraftDeletes[draftId] = { hostId };
          }
        }
        return { ...currentState, drafts, pendingSubmittedDraftDeletes };
      },
    },
  ),
);

function normalizedLegacyResetEpoch(rawDraft: Record<string, unknown>): number {
  const resetEpoch = rawDraft.resetEpoch;
  return typeof resetEpoch === "number" && Number.isFinite(resetEpoch)
    ? resetEpoch
    : 0;
}

/**
 * Storage written before `revision` existed lacks the field despite the
 * static `DraftState` type - JSON crossing the localStorage boundary is not
 * guaranteed to match it. `current.revision + 1` on an `undefined` value
 * produces `NaN`, which then never compares equal to itself
 * (`NaN !== NaN` is always `true`), permanently blocking the prompt-stash CAS
 * from ever clearing that draft again. Normalize once, here, at the one
 * place untrusted persisted data enters the store - everywhere else
 * (`ensureDraft`, `setSnapshot`, `replaceDraft`) only ever reads a value this
 * function already produced or `EMPTY_COMPOSER_DRAFT.revision`, both real
 * numbers, so `no-unnecessary-condition` correctly stays clean past this
 * boundary.
 */
function normalizedLegacyRevision(rawDraft: unknown): number {
  const revision = (rawDraft as { revision?: unknown } | null)?.revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : 0;
}

export function readComposerDraftSnapshot(
  chatId: string | undefined,
): DraftState {
  if (chatId === undefined) return EMPTY_COMPOSER_DRAFT;
  return ensureDraft(useComposerDraftStore.getState().drafts, chatId);
}

function touchLocalComposerDraft(
  chatId: string,
  patch: {
    readonly content: JsonContent;
    readonly selection: DraftSelection | null;
    readonly bumpRevision: boolean;
    readonly bumpResetEpoch: boolean;
  },
): string {
  let draftId = "";
  useComposerDraftStore.setState((state) => {
    const current = ensureDraft(state.drafts, chatId);
    draftId = current.draftId ?? mintDraftId();
    return {
      drafts: {
        ...state.drafts,
        [chatId]: {
          ...current,
          content: patch.content,
          selection: patch.selection,
          draftId,
          lastTouchedAt: Date.now(),
          generation: current.generation + 1,
          revision: patch.bumpRevision
            ? current.revision + 1
            : current.revision,
          resetEpoch: patch.bumpResetEpoch
            ? current.resetEpoch + 1
            : current.resetEpoch,
        },
      },
    };
  });
  return draftId;
}

export function composerDraftIsDirty(draftId: string): boolean {
  const draft = findComposerDraftById(draftId);
  if (draft === null) return false;
  return draft.generation > draft.syncedGeneration;
}

export function composerSubmittedDraftDeleteIsPending(
  draftId: string,
): boolean {
  return (
    useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId] !==
    undefined
  );
}

export function pendingSubmittedDraftDeleteHostId(
  draftId: string,
): string | null {
  return (
    useComposerDraftStore.getState().pendingSubmittedDraftDeletes[draftId]
      ?.hostId ?? null
  );
}

export function pendingSubmittedDraftDeleteIdsForHost(
  hostId: string,
): readonly string[] {
  return Object.entries(
    useComposerDraftStore.getState().pendingSubmittedDraftDeletes,
  ).flatMap(([draftId, pending]) =>
    pending?.hostId === hostId ? [draftId] : [],
  );
}

export function composerDraftRememberSynced(
  draftId: string,
  hostRevision: number,
  collectedGeneration: number,
): void {
  const found = findComposerChatIdByDraftId(draftId);
  if (found === null) return;
  useComposerDraftStore.setState((state) => {
    const current = state.drafts[found];
    if (current === undefined) return state;
    const clearDirty = collectedGeneration >= current.generation;
    return {
      drafts: {
        ...state.drafts,
        [found]: {
          ...current,
          hostRevision,
          syncedGeneration: clearDirty
            ? current.generation
            : current.syncedGeneration,
        },
      },
    };
  });
}

export function applyComposerHostDocument(document: DraftDocument): void {
  if (document.kind !== "chat-composer") return;
  const chatId = document.target.chatId;
  if (chatId === null) return;
  useComposerDraftStore.setState((state) => {
    const current = ensureDraft(state.drafts, chatId);
    if (current.generation > current.syncedGeneration) {
      return {
        drafts: {
          ...state.drafts,
          [chatId]: {
            ...current,
            draftId: document.draftId,
            hostRevision: document.revision,
            targetEpicId: document.target.epicId ?? current.targetEpicId,
            ownerHostId: document.ownerHostId,
            origin: document.origin,
            publication: document.publication,
          },
        },
      };
    }
    return {
      drafts: {
        ...state.drafts,
        [chatId]: {
          ...current,
          content: document.portable.content,
          selection: document.portable.selection,
          draftId: document.draftId,
          hostRevision: document.revision,
          targetEpicId: document.target.epicId ?? current.targetEpicId,
          lastTouchedAt: document.lastTouchedAt,
          resetEpoch: current.resetEpoch + 1,
          revision: current.revision + 1,
          generation: current.generation,
          syncedGeneration: current.generation,
          ownerHostId: document.ownerHostId,
          origin: document.origin,
          publication: document.publication,
        },
      },
    };
  });
}

export function applyComposerHostDelete(draftId: string): void {
  const chatId = findComposerChatIdByDraftId(draftId);
  if (chatId === null) return;
  useComposerDraftStore.setState((state) => {
    const current = ensureDraft(state.drafts, chatId);
    return {
      drafts: {
        ...state.drafts,
        [chatId]: {
          ...current,
          content: EMPTY_COMPOSER_CONTENT,
          selection: EMPTY_COMPOSER_SELECTION,
          resetEpoch: current.resetEpoch + 1,
          revision: current.revision + 1,
          generation: current.generation,
          syncedGeneration: current.generation,
          hostRevision: 0,
        },
      },
    };
  });
}

export function collectComposerDirtyWrites(): ReadonlyArray<{
  readonly chatId: string;
  readonly draft: DraftState;
}> {
  const out: Array<{ readonly chatId: string; readonly draft: DraftState }> =
    [];
  const drafts = useComposerDraftStore.getState().drafts;
  for (const [chatId, draft] of Object.entries(drafts)) {
    if (draft === undefined) continue;
    if (draft.generation <= draft.syncedGeneration) continue;
    if (draft.draftId === null) continue;
    out.push({ chatId, draft });
  }
  return out;
}

export function dropComposerAbsentFromList(
  hostId: string,
  listedIds: ReadonlySet<string>,
  boundHostByChatId: ReadonlyMap<string, string>,
): void {
  const drafts = useComposerDraftStore.getState().drafts;
  for (const [chatId, draft] of Object.entries(drafts)) {
    if (draft === undefined || draft.draftId === null) continue;
    const boundHostId = boundHostByChatId.get(chatId);
    // Unbound or bound to another host: KEEP. Absence from *this* host's
    // list is not a delete.
    if (boundHostId === undefined || boundHostId !== hostId) continue;
    if (draft.generation > draft.syncedGeneration) continue;
    if (listedIds.has(draft.draftId)) continue;
    dropComposerLocalMirror(draft.draftId);
  }
}

/**
 * List-absence on the bound host drops the mirror bookkeeping, never the
 * typed content. Authoritative host deletes go through
 * `applyComposerHostDelete` (subscribe delete / `drafts.delete`).
 */
function dropComposerLocalMirror(draftId: string): void {
  const chatId = findComposerChatIdByDraftId(draftId);
  if (chatId === null) return;
  useComposerDraftStore.setState((state) => {
    const current = ensureDraft(state.drafts, chatId);
    if (current.hostRevision === 0) return state;
    return {
      drafts: {
        ...state.drafts,
        [chatId]: {
          ...current,
          hostRevision: 0,
        },
      },
    };
  });
}

function findComposerDraftById(draftId: string): DraftState | null {
  const chatId = findComposerChatIdByDraftId(draftId);
  if (chatId === null) return null;
  return useComposerDraftStore.getState().drafts[chatId] ?? null;
}

export function findComposerChatIdByDraftId(draftId: string): string | null {
  const drafts = useComposerDraftStore.getState().drafts;
  for (const [chatId, draft] of Object.entries(drafts)) {
    if (draft?.draftId === draftId) return chatId;
  }
  return null;
}

function normalizedDraftId(raw: Record<string, unknown>): string | null {
  return typeof raw.draftId === "string" && raw.draftId.length > 0
    ? raw.draftId
    : null;
}

function normalizedNullableId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedOrigin(value: unknown): "own" | "replica" | null {
  return value === "own" || value === "replica" ? value : null;
}

function normalizedNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

registerExtraImageRootSource({
  hashes: () =>
    collectDraftAnnotationImageHashes(useComposerDraftStore.getState().drafts),
});
