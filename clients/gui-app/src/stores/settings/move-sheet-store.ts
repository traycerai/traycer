import { create } from "zustand";

/**
 * The move sheet is opened from four places (a Local row's `Move to
 * Personal`, the note above that computer's Providers tabs, its Overview
 * line, the retrospective sheet) and mounted once, app-wide
 * (`EnvironmentSheetsHost`). `target` names the
 * computer whose settings it shows; `null` is closed.
 */
export interface MoveSheetTarget {
  readonly hostId: string;
  readonly hostName: string;
}

interface MoveSheetState {
  readonly target: MoveSheetTarget | null;
  readonly openSheet: (target: MoveSheetTarget) => void;
  readonly closeSheet: () => void;
}

export const useMoveSheetStore = create<MoveSheetState>((set) => ({
  target: null,
  openSheet: (target) => set({ target }),
  closeSheet: () => set({ target: null }),
}));
