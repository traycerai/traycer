import { create } from "zustand";

/** Open state for the mobile hamburger navigation drawer. */
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
