import { type ReactNode } from "react";
import { create } from "zustand";

/**
 * Slot for route-contributed actions on the right of the mobile header. The
 * active surface (e.g. the epic view) sets its own controls here from where it
 * has the session context; the header renders whatever is present. Phase 0
 * leaves this empty - the epic overflow/actions fill lands with the single-tile
 * epic view. Desktop never renders the mobile header, so this is unused there.
 */
interface MobileHeaderState {
  readonly rightActions: ReactNode | null;
  readonly setRightActions: (node: ReactNode | null) => void;
}

export const useMobileHeaderStore = create<MobileHeaderState>((set) => ({
  rightActions: null,
  setRightActions: (node) => {
    set({ rightActions: node });
  },
}));
