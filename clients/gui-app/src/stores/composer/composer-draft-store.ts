import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { isJsonContent } from "@/lib/editor/prosemirror-json";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

export interface DraftSelection {
  readonly from: number;
  readonly to: number;
}

export interface DraftState {
  readonly content: JsonContent;
  readonly selection: DraftSelection | null;
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
  /**
   * Resets a task's draft to empty via the same `replaceDraft` broadcast used
   * by queue-edit restore / failed-send handoff, instead of deleting the map
   * entry. A delete can't reliably notify every mounted composer for this
   * `taskId` (split panes, keep-alive tabs): a sibling's `resetEpoch` selector
   * falls back to the same `?? 0` whether the entry never existed or was just
   * removed, so a delete after routine (non-bumping) keystrokes produces no
   * observable change and the sibling's stale Tiptap document never clears.
   * Bumping `resetEpoch` in place is the only way every mounted
   * `useChatComposerDraft` for this `taskId` reliably observes the clear. The
   * explicit empty-document caret applies the reset without invoking
   * `setContent(..., null)`'s focus-at-end behavior in sibling composers.
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
    (set, get) => ({
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
      clearDraft: (taskId) => {
        get().replaceDraft(
          taskId,
          EMPTY_COMPOSER_CONTENT,
          EMPTY_COMPOSER_SELECTION,
        );
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
