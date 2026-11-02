import { create } from "zustand";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

/**
 * Whether the sign-out confirmation is up. A store because the controls that
 * ask for it (the drawer's icon, the account menu's item) can unmount under it
 * when a rotation changes the phone shell's form, and the question must outlive
 * them. It must not outlive the session it was asked in: a session that ends
 * elsewhere (another window signing out) takes the dialog's seat away without an
 * answer, and the next sign-in would otherwise find the old question still open.
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

useAuthStore.subscribe((state, previous) => {
  const sessionEnded =
    !admitsLocalPlane(state.status) ||
    state.profile?.userId !== previous.profile?.userId;
  if (sessionEnded) useSignOutConfirmStore.getState().setOpen(false);
});
