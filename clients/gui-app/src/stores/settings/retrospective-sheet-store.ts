import { create } from "zustand";

/**
 * The retrospective sheet is opened by itself once on a computer an earlier
 * version shared (`RetrospectiveShowOnce`), from the Overview's `Shared by an
 * earlier version · Details`, and from the Start toast while anything is on
 * hold; it is mounted once, app-wide (`EnvironmentSheetsHost`). `target`
 * names the computer whose upload it records, `null` before the first open;
 * it outlives a close, so the sheet and the sheets it opened (Stop using
 * Personal) stay mounted while they animate out. `open` is whether it shows.
 *
 * `checkedHostIds` are the computers whose show-once this window has already
 * decided, so it reads each one once. `heldToastDismissed` closes the Start
 * toast for this window's session; the toast retires by itself once nothing
 * is on hold.
 */
export interface RetrospectiveSheetTarget {
  readonly hostId: string;
  readonly hostName: string;
}

interface RetrospectiveSheetState {
  readonly target: RetrospectiveSheetTarget | null;
  readonly open: boolean;
  readonly checkedHostIds: ReadonlySet<string>;
  readonly heldToastDismissed: boolean;
  readonly openSheet: (target: RetrospectiveSheetTarget) => void;
  readonly closeSheet: () => void;
  /** The show-once for `hostId` is decided; `due` opens the sheet on it. */
  readonly recordShowOnce: (
    hostId: string,
    due: RetrospectiveSheetTarget | null,
  ) => void;
  readonly dismissHeldToast: () => void;
}

export const useRetrospectiveSheetStore = create<RetrospectiveSheetState>(
  (set) => ({
    target: null,
    open: false,
    checkedHostIds: new Set(),
    heldToastDismissed: false,
    openSheet: (target) => set({ target, open: true }),
    closeSheet: () => set({ open: false }),
    recordShowOnce: (hostId, due) =>
      set((state) => ({
        checkedHostIds: new Set([...state.checkedHostIds, hostId]),
        ...(due === null ? {} : { target: due, open: true }),
      })),
    dismissHeldToast: () => set({ heldToastDismissed: true }),
  }),
);
