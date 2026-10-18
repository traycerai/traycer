import { create } from "zustand";
import type {
  CanvasElement,
  CanvasTextSelection,
} from "@/lib/sandbox/canvas-bridge";

export interface CanvasSelection {
  readonly artifactId: string;
  readonly boardPath: string;
  readonly page: string | null;
  /** Hash of the bytes that produced the marker, frozen when the frame answers. */
  readonly servedSha256: string;
  readonly element: CanvasElement;
  readonly textRange: CanvasTextSelection | null;
}

export function sameCanvasElement(a: CanvasElement, b: CanvasElement): boolean {
  if (a.tid !== null && b.tid !== null) return a.tid === b.tid;
  if (a.marker !== null || b.marker !== null) return a.marker === b.marker;
  return a.selector === b.selector;
}

interface CanvasSelectionState {
  readonly selection: CanvasSelection | null;
  readonly selectionOwner: symbol | null;
  readonly generation: number;
  readonly pendingPick: {
    readonly owner: symbol;
    readonly artifactId: string;
    readonly boardPath: string;
  } | null;
  readonly beginPick: (
    owner: symbol,
    artifactId: string,
    boardPath: string,
  ) => number;
  readonly completePick: (
    owner: symbol,
    generation: number,
    selection: CanvasSelection | null,
  ) => void;
  readonly retire: (owner: symbol, boardPath: string | null) => void;
  readonly select: (selection: CanvasSelection) => void;
  readonly clear: () => void;
  readonly setTextRange: (
    artifactId: string,
    boardPath: string,
    range: CanvasTextSelection | null,
  ) => void;
  readonly updateElement: (
    artifactId: string,
    boardPath: string,
    marker: number | null,
    element: CanvasElement,
  ) => void;
  readonly updateTid: (
    artifactId: string,
    boardPath: string,
    marker: number | null,
    tid: string,
  ) => void;
}

/** Window-local selection, never written to the artifact or sent to an agent. */
export const useCanvasSelectionStore = create<CanvasSelectionState>(
  (set, get) => ({
    selection: null,
    selectionOwner: null,
    generation: 0,
    pendingPick: null,
    beginPick: (owner, artifactId, boardPath) => {
      const generation = get().generation + 1;
      set({ generation, pendingPick: { owner, artifactId, boardPath } });
      return generation;
    },
    completePick: (owner, generation, selection) =>
      set((state) => {
        if (
          state.generation !== generation ||
          state.pendingPick?.owner !== owner
        )
          return state;
        return {
          selection,
          selectionOwner: selection === null ? null : owner,
          pendingPick: null,
        };
      }),
    retire: (owner, boardPath) =>
      set((state) => {
        const retiresPick =
          state.pendingPick?.owner === owner &&
          (boardPath === null || state.pendingPick.boardPath === boardPath);
        const retiresSelection =
          state.selectionOwner === owner &&
          (boardPath === null || state.selection?.boardPath === boardPath);
        if (!retiresPick && !retiresSelection) return state;
        return {
          generation: retiresPick ? state.generation + 1 : state.generation,
          pendingPick: retiresPick ? null : state.pendingPick,
          selection: retiresSelection ? null : state.selection,
          selectionOwner: retiresSelection ? null : state.selectionOwner,
        };
      }),
    select: (selection) =>
      set((state) => ({
        selection,
        selectionOwner:
          state.selection?.artifactId === selection.artifactId &&
          state.selection.boardPath === selection.boardPath
            ? state.selectionOwner
            : null,
        generation: state.generation + 1,
        pendingPick: null,
      })),
    clear: () =>
      set((state) => ({
        selection: null,
        selectionOwner: null,
        pendingPick: null,
        generation: state.generation + 1,
      })),
    setTextRange: (artifactId, boardPath, range) =>
      set((state) => {
        const current = state.selection;
        if (
          current === null ||
          current.artifactId !== artifactId ||
          current.boardPath !== boardPath ||
          (range !== null && !sameCanvasElement(current.element, range.element))
        )
          return state;
        return {
          selection: {
            ...current,
            textRange:
              range === null || range.quote.length === 0 ? null : range,
          },
        };
      }),
    updateElement: (artifactId, boardPath, marker, element) =>
      set((state) => {
        const current = state.selection;
        if (
          current === null ||
          current.artifactId !== artifactId ||
          current.boardPath !== boardPath ||
          current.element.marker !== marker ||
          !sameCanvasElement(current.element, element)
        )
          return state;
        return { selection: { ...current, element } };
      }),
    updateTid: (artifactId, boardPath, marker, tid) =>
      set((state) => {
        const current = state.selection;
        if (
          current === null ||
          current.artifactId !== artifactId ||
          current.boardPath !== boardPath ||
          current.element.marker !== marker ||
          marker === null
        )
          return state;
        return {
          selection: { ...current, element: { ...current.element, tid } },
        };
      }),
  }),
);
