import { create } from "zustand";

/**
 * Whether the sign-out confirmation is up. A store because the controls that
 * ask for it (the drawer's icon, the account menu's item) can unmount under it
 * when a rotation changes the phone shell's form, and the question must outlive
 * them.
 */
interface SignOutConfirmState {
  readonly open: boolean;
  readonly setOpen: (next: boolean) => void;
}

export const useSignOutConfirmStore = create<SignOutConfirmState>((set) => ({
  open: false,
  setOpen: (next) => {
    set({ open: next });
  },
}));
