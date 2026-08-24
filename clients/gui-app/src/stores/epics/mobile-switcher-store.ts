import { create } from "zustand";

/**
 * Open state of the mobile tab-switcher sheet, keyed by the epic tab it belongs
 * to.
 *
 * A store rather than local view state because the two ends live on opposite
 * sides of the epic session boundary: the trigger sits in the mobile app header
 * (rendered from the app provider stack, outside the epic session tree) while
 * the sheet itself is mounted by the epic tile view, which is where the epic
 * projection, permission role and canvas hooks it reads are available. Keying on
 * `tabId` keeps one epic tab's sheet from opening on another.
 */
interface MobileSwitcherState {
  readonly openTabId: string | null;
  readonly setOpen: (tabId: string, open: boolean) => void;
}

export const useMobileSwitcherStore = create<MobileSwitcherState>((set) => ({
  openTabId: null,
  setOpen: (tabId, open) => {
    set((state) => {
      if (open) return { openTabId: tabId };
      // Closing is scoped to the tab that opened it, so a stale close from a
      // backgrounded tab cannot shut another tab's sheet.
      if (state.openTabId !== tabId) return state;
      return { openTabId: null };
    });
  },
}));

/** Whether the switcher sheet is open for this epic tab. */
export function useIsMobileSwitcherOpen(tabId: string): boolean {
  return useMobileSwitcherStore((state) => state.openTabId === tabId);
}
