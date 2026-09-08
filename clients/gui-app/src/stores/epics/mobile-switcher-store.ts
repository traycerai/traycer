import { create } from "zustand";

/**
 * Open state of the mobile tab-switcher sheet, keyed by the epic tab it belongs
 * to, alongside which tabs currently have a sheet mounted to open.
 *
 * A store rather than local view state because the two ends live on opposite
 * sides of the epic session boundary: the trigger sits in the mobile app header
 * (rendered from the app provider stack, outside the epic session tree) while
 * the sheet itself is mounted by the epic tile view, which is where the epic
 * projection, permission role and canvas hooks it reads are available. Keying on
 * `tabId` keeps one epic tab's sheet from opening on another.
 *
 * That same split is why the mount registry exists. The trigger renders from a
 * slot that is live for the whole epic pane, while the sheet is mounted only
 * from the canvas branches that have a session and a snapshot - so there are
 * reachable states (a loading skeleton, a snapshot fetch error, a repoint
 * failure card) where the trigger is on screen and no sheet is listening. The
 * open flag alone cannot tell those apart from a mounted-but-closed sheet: it
 * is a request, not a capability. Mounts register here so the trigger can read
 * the capability directly and disable itself instead of writing an open that
 * nothing renders.
 */
interface MobileSwitcherState {
  readonly openTabId: string | null;
  /**
   * Live {@link MobileSwitcherState.registerMount} count per epic tab. A COUNT
   * rather than a set of ids: the sheet is mounted from several mutually
   * exclusive canvas branches, and moving between two of them is one commit -
   * a set would be correct only because React happens to run every cleanup
   * before every effect, so the tab would read as unmounted mid-swap under any
   * other order. A count is correct either way.
   */
  readonly mountCountByTabId: Readonly<Record<string, number>>;
  readonly setOpen: (tabId: string, open: boolean) => void;
  /** Declares that a switcher sheet is now rendered for this epic tab. */
  readonly registerMount: (tabId: string) => void;
  /** Undoes one {@link MobileSwitcherState.registerMount}. */
  readonly unregisterMount: (tabId: string) => void;
}

export const useMobileSwitcherStore = create<MobileSwitcherState>((set) => ({
  openTabId: null,
  mountCountByTabId: {},
  setOpen: (tabId, open) => {
    set((state) => {
      if (open) return { openTabId: tabId };
      // Closing is scoped to the tab that opened it, so a stale close from a
      // backgrounded tab cannot shut another tab's sheet.
      if (state.openTabId !== tabId) return state;
      return { openTabId: null };
    });
  },
  registerMount: (tabId) => {
    set((state) => ({
      mountCountByTabId: {
        ...state.mountCountByTabId,
        [tabId]: (state.mountCountByTabId[tabId] ?? 0) + 1,
      },
    }));
  },
  unregisterMount: (tabId) => {
    set((state) => {
      const remaining = (state.mountCountByTabId[tabId] ?? 0) - 1;
      const next = { ...state.mountCountByTabId };
      if (remaining > 0) next[tabId] = remaining;
      else delete next[tabId];
      // `openTabId` is deliberately left alone. Losing the last mount is not a
      // user closing the sheet, and clearing here would close one that is open
      // across a branch swap - the sheet's own create/activate rows already
      // close it before the canvas they populate takes over. Nothing strands
      // either: the trigger cannot write an open with no mount, and the other
      // writer (`use-activate-comment-thread`) only fires from inside a
      // rendered tile, which is a state that mounts the sheet.
      return { mountCountByTabId: next };
    });
  },
}));

/** Whether the switcher sheet is open for this epic tab. */
export function useIsMobileSwitcherOpen(tabId: string): boolean {
  return useMobileSwitcherStore((state) => state.openTabId === tabId);
}

/**
 * Whether a switcher sheet is mounted for this epic tab - i.e. whether asking
 * for it to open would put anything on screen.
 */
export function useIsMobileSwitcherMounted(tabId: string): boolean {
  return useMobileSwitcherStore(
    (state) => (state.mountCountByTabId[tabId] ?? 0) > 0,
  );
}
