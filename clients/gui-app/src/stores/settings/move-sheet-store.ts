import { create } from "zustand";

/**
 * The move sheet is opened from three places (a Local row's `Move to
 * Personal`, the note above that computer's Providers tabs, its Overview
 * line) and mounted once, in the Settings sidebar. `hostId` names the
 * computer whose settings it shows; `null` is closed.
 */
interface MoveSheetState {
  readonly hostId: string | null;
  readonly openSheet: (hostId: string) => void;
  readonly closeSheet: () => void;
}

export const useMoveSheetStore = create<MoveSheetState>((set) => ({
  hostId: null,
  openSheet: (hostId) => set({ hostId }),
  closeSheet: () => set({ hostId: null }),
}));
