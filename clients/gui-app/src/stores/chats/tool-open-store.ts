import { create } from "zustand";

interface ToolOpenState {
  readonly openIds: ReadonlySet<string>;
  setOpen: (segmentId: string, open: boolean) => void;
  reset: () => void;
}

export const useToolOpenStore = create<ToolOpenState>((set) => ({
  openIds: new Set(),
  setOpen: (segmentId, open) =>
    set((state) => {
      const wasOpen = state.openIds.has(segmentId);
      if (wasOpen === open) return state;
      const next = new Set(state.openIds);
      if (open) {
        next.add(segmentId);
      } else {
        next.delete(segmentId);
      }
      return { openIds: next };
    }),
  reset: () => set({ openIds: new Set() }),
}));
