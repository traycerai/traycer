import { create } from "zustand";
import { scopedChatOpenId } from "@/stores/chats/open-store-scope";

interface SubagentOpenState {
  readonly openIds: ReadonlySet<string>;
  setOpen: (scope: string, segmentId: string, open: boolean) => void;
}

export const useSubagentOpenStore = create<SubagentOpenState>((set) => ({
  openIds: new Set(),
  setOpen: (scope, segmentId, open) =>
    set((state) => {
      const scopedId = scopedChatOpenId(scope, segmentId);
      const wasOpen = state.openIds.has(scopedId);
      if (wasOpen === open) return state;
      const next = new Set(state.openIds);
      if (open) {
        next.add(scopedId);
      } else {
        next.delete(scopedId);
      }
      return { openIds: next };
    }),
}));
