import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { isJsonContent } from "@/lib/editor/prosemirror-json";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { BrowserContextAttachmentPayload } from "@/lib/browser-view/browser-context-attachments";
import {
  collectDraftAnnotationImageHashes,
  mergeBrowserAnnotationRecords,
  parseBrowserAnnotationRecord,
  parseBrowserAnnotationRecords,
  type BrowserAnnotationRecord,
} from "@/lib/browser-view/browser-annotation-record";
import { registerExtraImageRootSource } from "@/lib/composer/landing-image-budget";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";

export interface DraftSelection {
  readonly from: number;
  readonly to: number;
}

export interface DraftState {
  readonly content: JsonContent;
  readonly selection: DraftSelection | null;
  readonly browserContextAttachments?: ReadonlyArray<BrowserContextAttachmentPayload>;
  /**
   * Attached annotation cards. Persisted and rehydrated (unlike the old
   * `browserContextAttachments` array, which the merge path still drops).
   */
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
  /**
   * Bumped only when the draft is replaced from outside the editor
   * (queue-edit restore, failed-send handoff, submit-clear). The composer
   * watches this counter to push the new content into Tiptap; routine
   * keystroke snapshots from the editor never bump it.
   */
  readonly resetEpoch: number;
  /**
   * Bumped on every real content change - typed/pasted edits via
   * `setSnapshot` AND external replacements via `replaceDraft` (queue-edit
   * restore, failed-send handoff, `clearDraft`). The prompt-stash source
   * adapter captures this alongside the taskId as a compare-and-swap token:
   * a stash only clears this draft when the revision it captured still
   * matches, so an edit made while the stash was durably saving is kept.
   */
  readonly revision: number;
}

interface ComposerDraftStore {
  readonly drafts: Partial<Record<string, DraftState>>;
  /**
   * Records a real document mutation - callers must only invoke this from the
   * editor boundary's document-change signal (never a selection-only echo),
   * so every call unconditionally bumps `revision` without comparing content.
   */
  readonly setSnapshot: (
    taskId: string,
    content: JsonContent,
    selection: DraftSelection | null,
  ) => void;
  /**
   * Persists a caret move alone. Never touches `revision` - a selection-only
   * change is not a content edit - and never compares/serializes `content`.
   */
  readonly setSelection: (
    taskId: string,
    selection: DraftSelection | null,
  ) => void;
  readonly replaceDraft: (
    taskId: string,
    content: JsonContent,
    selection: DraftSelection | null,
  ) => void;
  readonly addBrowserContextAttachment: (
    taskId: string,
    attachment: BrowserContextAttachmentPayload,
  ) => void;
  readonly addBrowserAnnotation: (
    taskId: string,
    record: BrowserAnnotationRecord,
  ) => void;
  readonly removeBrowserAnnotation: (
    taskId: string,
    annotationId: string,
  ) => void;
  /**
   * Rejected-send restore: put records back without duplicating an id that
   * is already on the draft (the user may have re-attached while the send
   * was in flight).
   */
  readonly restoreBrowserAnnotations: (
    taskId: string,
    records: ReadonlyArray<BrowserAnnotationRecord>,
  ) => void;
  /**
   * Resets a task's draft in place (empty content + empty annotations + bumped
   * resetEpoch/revision) instead of deleting the map entry. A delete can't
   * reliably notify every mounted composer for this `taskId` (split panes,
   * keep-alive tabs): a sibling's `resetEpoch` selector falls back to the same
   * `?? 0` whether the entry never existed or was just removed. The old
   * `browserContextAttachments` array is left untouched (debug dropdown).
   */
  readonly clearDraft: (taskId: string) => void;
}
const EMPTY_COMPOSER_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};
const EMPTY_COMPOSER_SELECTION: DraftSelection = { from: 1, to: 1 };

export const EMPTY_COMPOSER_DRAFT: DraftState = {
  content: EMPTY_COMPOSER_CONTENT,
  selection: null,
  browserContextAttachments: [],
  browserAnnotations: [],
  resetEpoch: 0,
  revision: 0,
};

function ensureDraft(
  drafts: Partial<Record<string, DraftState>>,
  taskId: string,
): DraftState {
  return drafts[taskId] ?? EMPTY_COMPOSER_DRAFT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function persistAnnotationEntries(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const next: unknown[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      next.push(entry);
      continue;
    }
    const withKind =
      entry.kind === "browser-annotation"
        ? entry
        : { ...entry, kind: "browser-annotation" };
    const parsed = parseBrowserAnnotationRecord(withKind);
    next.push(parsed ?? withKind);
  }
  return next;
}

function hasDraftMap(
  value: unknown,
): value is { readonly drafts: Record<string, unknown> } {
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
    (set) => ({
      drafts: {},
      setSnapshot: (taskId, content, selection) => {
        set((state) => {
          const current = ensureDraft(state.drafts, taskId);
          return {
            drafts: {
              ...state.drafts,
              [taskId]: {
                ...current,
                content,
                selection,
                revision: current.revision + 1,
              },
            },
          };
        });
      },
      setSelection: (taskId, selection) => {
        set((state) => {
          const current = ensureDraft(state.drafts, taskId);
          if (
            current.selection?.from === selection?.from &&
            current.selection?.to === selection?.to
          ) {
            return state;
          }
          return {
            drafts: {
              ...state.drafts,
              [taskId]: { ...current, selection },
            },
          };
        });
      },
      replaceDraft: (taskId, content, selection) => {
        set((state) => {
          const current = ensureDraft(state.drafts, taskId);
          return {
            drafts: {
              ...state.drafts,
              [taskId]: {
                ...current,
                content,
                selection,
                resetEpoch: current.resetEpoch + 1,
                revision: current.revision + 1,
              },
            },
          };
        });
      },
      addBrowserContextAttachment: (taskId, attachment) => {
        set((state) => {
          const current = ensureDraft(state.drafts, taskId);
          const attachments = current.browserContextAttachments ?? [];
          return {
            drafts: {
              ...state.drafts,
              [taskId]: {
                ...current,
                browserContextAttachments: [...attachments, attachment],
                resetEpoch: current.resetEpoch + 1,
              },
            },
          };
        });
      },
      addBrowserAnnotation: (taskId, record) => {
        set((state) => {
          const current = ensureDraft(state.drafts, taskId);
          const next = mergeBrowserAnnotationRecords(
            current.browserAnnotations,
            [record],
          );
          if (next === current.browserAnnotations) return state;
          return {
            drafts: {
              ...state.drafts,
              [taskId]: {
                ...current,
                browserAnnotations: next,
                resetEpoch: current.resetEpoch + 1,
              },
            },
          };
        });
      },
      removeBrowserAnnotation: (taskId, annotationId) => {
        set((state) => {
          const current = ensureDraft(state.drafts, taskId);
          const next = current.browserAnnotations.filter(
            (record) => record.annotationId !== annotationId,
          );
          if (next.length === current.browserAnnotations.length) return state;
          return {
            drafts: {
              ...state.drafts,
              [taskId]: {
                ...current,
                browserAnnotations: next,
                resetEpoch: current.resetEpoch + 1,
              },
            },
          };
        });
      },
      restoreBrowserAnnotations: (taskId, records) => {
        set((state) => {
          const current = ensureDraft(state.drafts, taskId);
          const next = mergeBrowserAnnotationRecords(
            current.browserAnnotations,
            records,
          );
          if (next === current.browserAnnotations) return state;
          return {
            drafts: {
              ...state.drafts,
              [taskId]: {
                ...current,
                browserAnnotations: next,
                resetEpoch: current.resetEpoch + 1,
              },
            },
          };
        });
      },
      clearDraft: (taskId) => {
        set((state) => {
          const current = ensureDraft(state.drafts, taskId);
          return {
            drafts: {
              ...state.drafts,
              [taskId]: {
                ...current,
                content: EMPTY_COMPOSER_CONTENT,
                selection: EMPTY_COMPOSER_SELECTION,
                browserAnnotations: [],
                resetEpoch: current.resetEpoch + 1,
                revision: current.revision + 1,
              },
            },
          };
        });
        scheduleLandingImageReconcile();
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.composerDraft)),
      // Synchronous localStorage hydration can finish during `create(...)`,
      // before an `onFinishHydration` subscriber can be registered. Normalize
      // at the merge boundary so legacy revisions are safe on initial import.
      merge: (persistedState, currentState) => {
        if (!hasDraftMap(persistedState)) {
          return currentState;
        }
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
              persistAnnotationEntries(value.browserAnnotations),
            ),
            resetEpoch: normalizedLegacyResetEpoch(value) + 1,
            revision: normalizedLegacyRevision(value),
          };
        }
        return { ...currentState, drafts };
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
  taskId: string | undefined,
): DraftState {
  if (taskId === undefined) return EMPTY_COMPOSER_DRAFT;
  return ensureDraft(useComposerDraftStore.getState().drafts, taskId);
}

registerExtraImageRootSource({
  hashes: () =>
    collectDraftAnnotationImageHashes(useComposerDraftStore.getState().drafts),
});
