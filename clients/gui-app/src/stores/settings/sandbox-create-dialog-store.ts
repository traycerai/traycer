import { create } from "zustand";

/** "New sandbox…": one store, one mounted dialog, like the add-host dialog. */
interface SandboxCreateDialogState {
  readonly open: boolean;
  readonly openDialog: () => void;
  readonly closeDialog: () => void;
}

export const useSandboxCreateDialogStore = create<SandboxCreateDialogState>(
  (set) => ({
    open: false,
    openDialog: () => set({ open: true }),
    closeDialog: () => set({ open: false }),
  }),
);
