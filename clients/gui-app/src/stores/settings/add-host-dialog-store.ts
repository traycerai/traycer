import { create } from "zustand";

/**
 * "Add a machine…" is reachable from two places that must not each own a copy
 * of the dialog: the sidebar host switcher and the Overview page's empty /
 * fleet strip. One store, one mounted dialog.
 */
interface AddHostDialogState {
  readonly open: boolean;
  /**
   * Host ids present when the dialog opened. The arrival watcher diffs against
   * this so it recognises the NEW machine rather than celebrating one that was
   * already registered.
   */
  readonly knownHostIds: readonly string[];
  readonly openDialog: (knownHostIds: readonly string[]) => void;
  readonly closeDialog: () => void;
}

export const useAddHostDialogStore = create<AddHostDialogState>((set) => ({
  open: false,
  knownHostIds: [],
  openDialog: (knownHostIds) => set({ open: true, knownHostIds }),
  closeDialog: () => set({ open: false, knownHostIds: [] }),
}));
