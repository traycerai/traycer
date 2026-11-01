import { create } from "zustand";

interface HostPickRequestState {
  /** How many times each surface was asked to open its host picker. */
  readonly bySurface: Readonly<Record<string, number>>;
  readonly request: (surfaceKey: string) => void;
}

/**
 * Asks a composer surface's host picker to open, from an action far from the
 * chip: a stage's "Use another host", when the host it would fall back to is
 * the staged sandbox itself.
 */
export const useHostPickRequestStore = create<HostPickRequestState>((set) => ({
  bySurface: {},
  request: (surfaceKey) => {
    set((state) => ({
      bySurface: {
        ...state.bySurface,
        [surfaceKey]: (state.bySurface[surfaceKey] ?? 0) + 1,
      },
    }));
  },
}));
