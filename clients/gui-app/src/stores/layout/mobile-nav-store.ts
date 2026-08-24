import { create } from "zustand";

/**
 * Open state for the mobile hamburger navigation drawer. Kept in a tiny
 * external store so the header's hamburger trigger and the drawer surface can
 * live in different parts of the tree without prop drilling. Desktop never
 * mounts either, so this stays untouched there.
 */
interface MobileNavState {
  readonly open: boolean;
  readonly setOpen: (next: boolean) => void;
}

export const useMobileNavStore = create<MobileNavState>((set) => ({
  open: false,
  setOpen: (next) => {
    set({ open: next });
  },
}));
