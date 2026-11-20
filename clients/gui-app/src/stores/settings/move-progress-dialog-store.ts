import { create } from "zustand";
import type { MoveSheetTarget } from "@/stores/settings/move-sheet-store";

/**
 * The move's progress dialog, opened by the move sheet once the computer
 * took the acceptance and mounted once, app-wide (`EnvironmentSheetsHost`).
 * `target` names the computer that is moving; `null` is closed. Closing it
 * does not stop the move.
 */
interface MoveProgressDialogState {
  readonly target: MoveSheetTarget | null;
  readonly openDialog: (target: MoveSheetTarget) => void;
  readonly closeDialog: () => void;
}

export const useMoveProgressDialogStore = create<MoveProgressDialogState>(
  (set) => ({
    target: null,
    openDialog: (target) => set({ target }),
    closeDialog: () => set({ target: null }),
  }),
);
