import { create } from "zustand";

/** A modal backdrop's dim: its `bg-black/<strength>`. */
export type BackdropStrength = "10" | "30" | "40";

export interface OpenBackdrop {
  readonly id: number;
  readonly strength: BackdropStrength;
  /** Playing its exit: Radix keeps a closing overlay mounted until it ends. */
  readonly closing: boolean;
}

interface BackdropDimState {
  /** The window's mounted modal backdrops, in the order they opened. */
  readonly backdrops: readonly OpenBackdrop[];
  readonly add: (strength: BackdropStrength, closing: boolean) => number;
  readonly setClosing: (id: number, closing: boolean) => void;
  readonly remove: (id: number) => void;
}

let nextId = 0;

/**
 * The modal backdrops on screen, published by the overlays themselves
 * (`BackdropDimSource`) so the joined top tab can take their dim
 * (`JoinedTabDim`). In the desktop window the backdrops start under the title
 * band, which holds the tab.
 */
export const useBackdropDimStore = create<BackdropDimState>((set) => ({
  backdrops: [],
  add: (strength, closing) => {
    nextId += 1;
    const id = nextId;
    set((state) => ({
      backdrops: [...state.backdrops, { id, strength, closing }],
    }));
    return id;
  },
  setClosing: (id, closing) =>
    set((state) => ({
      backdrops: state.backdrops.map((backdrop) =>
        backdrop.id === id && backdrop.closing !== closing
          ? { ...backdrop, closing }
          : backdrop,
      ),
    })),
  remove: (id) =>
    set((state) => ({
      backdrops: state.backdrops.filter((backdrop) => backdrop.id !== id),
    })),
}));
