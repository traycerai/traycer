import { type ReactNode } from "react";
import { create } from "zustand";

/**
 * Slot for surface-contributed actions on the right of the mobile header. The
 * presented surface (e.g. the epic view) sets its own controls here from where
 * it has the session context; the header renders whatever is present. Desktop
 * never renders the mobile header, so this is unused there.
 *
 * The slot holds ONE cell and more than one surface can want it, so every write
 * carries the owner it is written for. Taking the cell is last-in-wins - the
 * surface the phone is presenting now is the one whose controls belong in the
 * header. Releasing it is NOT: a clear only lands while its owner still holds
 * the cell, so a surface going away cannot blank controls another surface has
 * since claimed.
 *
 * That asymmetry is load-bearing because the two events are not ordered.
 * Mounting the incoming surface and tearing down the outgoing one can fall in
 * different commits - a surface whose existence follows something other than
 * the tab layout (a registered pane anchor, say) is torn down a commit late -
 * and an unscoped clear arriving in the later one would empty a cell the new
 * owner had already filled, leaving the header bare until something remounted
 * it.
 */
interface MobileHeaderState {
  readonly rightActions: ReactNode | null;
  /** The surface whose controls currently fill the slot. */
  readonly rightActionsOwner: string | null;
  readonly setRightActions: (owner: string, node: ReactNode) => void;
  readonly clearRightActions: (owner: string) => void;
}

export const useMobileHeaderStore = create<MobileHeaderState>((set) => ({
  rightActions: null,
  rightActionsOwner: null,
  setRightActions: (owner, node) => {
    set({ rightActions: node, rightActionsOwner: owner });
  },
  clearRightActions: (owner) => {
    set((state) =>
      state.rightActionsOwner === owner
        ? { rightActions: null, rightActionsOwner: null }
        : state,
    );
  },
}));
