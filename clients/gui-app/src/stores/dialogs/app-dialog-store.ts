import { create } from "zustand";

export type AppDialogKind = "open-folder" | "chat-fork" | null;

interface AppDialogStore {
  activeDialog: AppDialogKind;
  openDialog: (dialog: Exclude<AppDialogKind, null>) => void;
  closeDialog: () => void;
}

export const useAppDialogStore = create<AppDialogStore>((set) => ({
  activeDialog: null,
  openDialog: (dialog) => {
    set({ activeDialog: dialog });
  },
  closeDialog: () => {
    set({ activeDialog: null });
  },
}));
