import { create } from "zustand";

interface ScreencastArmedState {
  readonly ownerId: string | null;
  readonly claim: (ownerId: string) => void;
  readonly release: (ownerId: string) => void;
}

export const useScreencastArmedStore = create<ScreencastArmedState>((set) => ({
  ownerId: null,
  claim: (ownerId) => set({ ownerId }),
  release: (ownerId) =>
    set((state) => (state.ownerId === ownerId ? { ownerId: null } : state)),
}));
