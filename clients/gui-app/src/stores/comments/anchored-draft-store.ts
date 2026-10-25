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
