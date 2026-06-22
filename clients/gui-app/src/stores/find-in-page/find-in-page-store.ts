import { create } from "zustand";

export interface FindMatchesState {
  readonly current: number;
  readonly total: number;
}

export interface FindInPageState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly matches: FindMatchesState | null;
  readonly matchCase: boolean;
  /**
   * Monotonic counters bumped by menu commands so the find bar can react
   * to Cmd+G / Cmd+Shift+G without having to expose its engine ref to
   * the outside world.
   */
  readonly advanceForwardNonce: number;
  readonly advanceBackwardNonce: number;
  readonly focusRequestNonce: number;
  readonly open: () => void;
  readonly close: () => void;
  readonly setQuery: (query: string) => void;
  readonly setMatches: (matches: FindMatchesState | null) => void;
  readonly setMatchCase: (matchCase: boolean) => void;
  readonly requestAdvanceForward: () => void;
  readonly requestAdvanceBackward: () => void;
}

export const useFindInPageStore = create<FindInPageState>((set) => ({
  isOpen: false,
  query: "",
  matches: null,
  matchCase: false,
  advanceForwardNonce: 0,
  advanceBackwardNonce: 0,
  focusRequestNonce: 0,
  open: () =>
    set((state) => ({
      isOpen: true,
      focusRequestNonce: state.focusRequestNonce + 1,
    })),
  close: () => set({ isOpen: false, query: "", matches: null }),
  setQuery: (query) => set({ query }),
  setMatches: (matches) => set({ matches }),
  setMatchCase: (matchCase) => set({ matchCase }),
  requestAdvanceForward: () =>
    set((state) => ({
      isOpen: true,
      advanceForwardNonce: state.advanceForwardNonce + 1,
    })),
  requestAdvanceBackward: () =>
    set((state) => ({
      isOpen: true,
      advanceBackwardNonce: state.advanceBackwardNonce + 1,
    })),
}));
