import { create } from "zustand";
import type { CanvasSelection } from "@/components/canvas-artifact/canvas-selection-store";
import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";

export type AnchoredDraftAnchor =
  | { readonly kind: "artifact" }
  | {
      readonly kind: "canvas-point";
      readonly page: string;
      readonly x: number;
      readonly y: number;
      readonly label: string;
    }
  | {
      readonly kind: "element";
      readonly artboard: string;
      readonly elementId: string | null;
      readonly label: string;
    }
  | {
      readonly kind: "text";
      readonly artboard: string;
      readonly elementId: string | null;
      readonly label: string;
      readonly startOffset: number;
      readonly endOffset: number;
    };

export interface AnchoredCommentDraft {
  readonly draftId: string;
  readonly tileId: string;
  readonly artifactId: string;
  readonly artifactType: "html" | "canvas";
  readonly anchor: AnchoredDraftAnchor;
  readonly quotedText: string;
  readonly rect: CanvasBox;
  /** Frozen source identity for the first-comment id insertion. */
  readonly selection: CanvasSelection | null;
  readonly retargeted: boolean;
  readonly generatedText?: boolean;
  readonly submitting?: boolean;
}
interface AnchoredDraftState {
  readonly byEpicId: Readonly<Record<string, AnchoredCommentDraft | undefined>>;
  readonly setDraft: (epicId: string, draft: AnchoredCommentDraft) => void;
  readonly updateDraft: (
    epicId: string,
    draftId: string,
    patch: Partial<AnchoredCommentDraft>,
  ) => void;
  readonly clearDraft: (epicId: string, draftId: string) => void;
}
const openDraftDiscards = new Map<
  string,
  { readonly draftId: string; readonly discard: () => boolean }
>();

/**
 * Lets the box showing a task's open draft answer for it when another view
 * starts a comment, with the box's own discard. Returns the release.
 */
export function registerOpenDraftDiscard(
  epicId: string,
  draftId: string,
  discard: () => boolean,
): () => void {
  const entry = { draftId, discard };
  openDraftDiscards.set(epicId, entry);
  return () => {
    if (openDraftDiscards.get(epicId) === entry)
      openDraftDiscards.delete(epicId);
  };
}

/**
 * Whether the view `tileId` may open a new draft in the task. A task holds one
 * draft, and another view's goes first through its own discard, which asks
 * before dropping typed text: a draft out of sight (a card lowered under it,
 * a pane in the background) answers no press outside it, so without this it
 * would be replaced without a word. A draft no box shows holds no text.
 */
export function yieldOpenDraft(epicId: string, tileId: string): boolean {
  const current = useAnchoredDraftStore.getState().byEpicId[epicId];
  if (current === undefined || current.tileId === tileId) return true;
  const entry = openDraftDiscards.get(epicId);
  if (entry?.draftId !== current.draftId) return true;
  return entry.discard();
}

export const useAnchoredDraftStore = create<AnchoredDraftState>((set) => ({
  byEpicId: {},
  setDraft: (epicId, draft) =>
    set((state) => ({ byEpicId: { ...state.byEpicId, [epicId]: draft } })),
  updateDraft: (epicId, draftId, patch) =>
    set((state) => {
      const current = state.byEpicId[epicId];
      if (current?.draftId !== draftId) return state;
      return {
        byEpicId: {
          ...state.byEpicId,
          [epicId]: { ...current, ...patch, draftId },
        },
      };
    }),
  clearDraft: (epicId, draftId) =>
    set((state) => {
      if (state.byEpicId[epicId]?.draftId !== draftId) return state;
      const next = { ...state.byEpicId };
      delete next[epicId];
      return { byEpicId: next };
    }),
}));
