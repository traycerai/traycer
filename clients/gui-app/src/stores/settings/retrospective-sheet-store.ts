import { create } from "zustand";

/**
 * The retrospective sheet is opened by itself once on a computer an earlier
 * version shared (`RetrospectiveShowOnce`), from the Overview's `Shared by an
 * earlier version · Details`, and from the Start toast while anything is on
 * hold; it is mounted once, app-wide (`EnvironmentSheetsHost`). `target`
 * names the computer whose upload it records, or an explicitly addressed
 * environment/person opening for cloud Review, `null` before the first open;
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

export interface EnvironmentReviewTarget {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly viewerId: string;
  readonly opening: number;
}

interface RetrospectiveSheetState {
  readonly target: RetrospectiveSheetTarget | EnvironmentReviewTarget | null;
  readonly open: boolean;
  readonly checkedHostIds: ReadonlySet<string>;
  readonly heldToastDismissed: boolean;
  readonly openSheet: (target: RetrospectiveSheetTarget) => void;
  readonly reviewOpening: number;
  readonly openEnvironmentReview: (
    target: Omit<EnvironmentReviewTarget, "opening">,
  ) => void;
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
    reviewOpening: 0,
    openSheet: (target) => set({ target, open: true }),
    openEnvironmentReview: (target) =>
      set((state) => ({
        target: { ...target, opening: state.reviewOpening + 1 },
        reviewOpening: state.reviewOpening + 1,
        open: true,
      })),
    closeSheet: () => set({ open: false }),
    recordShowOnce: (hostId, due) =>
      set((state) => ({
        checkedHostIds: new Set([...state.checkedHostIds, hostId]),
        ...(due === null ? {} : { target: due, open: true }),
      })),
    dismissHeldToast: () => set({ heldToastDismissed: true }),
  }),
);
