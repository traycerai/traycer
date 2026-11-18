import { create } from "zustand";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";

/**
 * The new-conversation modal's browser-annotation sidecar, per epic: the
 * cards a selection sent to "New chat" carries until the create sends them.
 *
 * Window-scoped and never mirrored, like the chat composer's sidecar: the
 * crop bytes live in this window's image store, so a draft restored in
 * another window could not show them. The text half of such a draft is in
 * the modal's own content store and is mirrored as usual.
 */
interface NewConversationAnnotationState {
  readonly byEpicId: Readonly<
    Record<string, ReadonlyArray<BrowserAnnotationRecord> | undefined>
  >;
  readonly add: (epicId: string, record: BrowserAnnotationRecord) => void;
  readonly remove: (epicId: string, annotationId: string) => void;
  readonly clear: (epicId: string) => void;
}

const NONE: ReadonlyArray<BrowserAnnotationRecord> = [];

export const useNewConversationAnnotationStore =
  create<NewConversationAnnotationState>((set) => ({
    byEpicId: {},
    add: (epicId, record) =>
      set((state) => ({
        byEpicId: {
          ...state.byEpicId,
          [epicId]: [...(state.byEpicId[epicId] ?? []), record],
        },
      })),
    remove: (epicId, annotationId) =>
      set((state) => {
        const current = state.byEpicId[epicId] ?? [];
        const next = current.filter(
          (record) => record.annotationId !== annotationId,
        );
        if (next.length === current.length) return state;
        return { byEpicId: { ...state.byEpicId, [epicId]: next } };
      }),
    clear: (epicId) =>
      set((state) => {
        if (state.byEpicId[epicId] === undefined) return state;
        const next = { ...state.byEpicId };
        delete next[epicId];
        return { byEpicId: next };
      }),
  }));

export function readNewConversationAnnotations(
  epicId: string,
): ReadonlyArray<BrowserAnnotationRecord> {
  return useNewConversationAnnotationStore.getState().byEpicId[epicId] ?? NONE;
}
