import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
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
   * (queue-edit restore, failed-send handoff). The composer watches
   * this counter to push the new content into Tiptap; routine
   * keystroke snapshots from the editor never bump it.
   */
  readonly resetEpoch: number;
}

interface ComposerDraftStore {
  readonly drafts: Partial<Record<string, DraftState>>;
  readonly setSnapshot: (
    taskId: string,
    content: JsonContent,
    selection: DraftSelection | null,
  ) => void;
  readonly replaceDraft: (
    taskId: string,
    content: JsonContent,
    selection: DraftSelection | null,
  ) => void;
  readonly clearDraft: (taskId: string) => void;
}
const EMPTY_COMPOSER_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export const EMPTY_COMPOSER_DRAFT: DraftState = {
  content: EMPTY_COMPOSER_CONTENT,
  selection: null,
  resetEpoch: 0,
};

function ensureDraft(
  drafts: Partial<Record<string, DraftState>>,
  taskId: string,
): DraftState {
  return drafts[taskId] ?? EMPTY_COMPOSER_DRAFT;
}

export const useComposerDraftStore = create<ComposerDraftStore>()(
  persist(
    (set) => ({
      drafts: {},
      setSnapshot: (taskId, content, selection) => {
        set((state) => {
          const current = ensureDraft(state.drafts, taskId);
          if (
            current.content === content &&
            current.selection?.from === selection?.from &&
            current.selection?.to === selection?.to
          ) {
            return state;
          }
          return {
            drafts: {
              ...state.drafts,
              [taskId]: { ...current, content, selection },
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
              },
            },
          };
        });
      },
      clearDraft: (taskId) => {
        set((state) => {
          if (!(taskId in state.drafts)) return state;
          const next = { ...state.drafts };
          delete next[taskId];
          return { drafts: next };
        });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.composerDraft)),
    },
  ),
);

useComposerDraftStore.persist.onFinishHydration(() => {
  useComposerDraftStore.setState((current) => {
    const entries = Object.entries(current.drafts);
    if (entries.length === 0) return current;
    const bumped: Partial<Record<string, DraftState>> = {};
    for (const [taskId, draft] of entries) {
      if (draft === undefined) continue;
      bumped[taskId] = { ...draft, resetEpoch: draft.resetEpoch + 1 };
    }
    return { drafts: bumped };
  });
});
export function readComposerDraftSnapshot(
  taskId: string | undefined,
): DraftState {
  if (taskId === undefined) return EMPTY_COMPOSER_DRAFT;
  return ensureDraft(useComposerDraftStore.getState().drafts, taskId);
}
