import { create } from "zustand";

/**
 * Whether the onboarding flow currently HAS THE SCREEN. Presence, not
 * progress: the flow store (`onboarding-flow-store.ts`) owns what the user
 * has done and where the chain is; this only says whether something of the
 * flow is up right now, so app-level ambient surfaces - the import-progress
 * toast, the announcement toasts, the completion toast - can hold rather
 * than pile onto a welcome modal or a running tour.
 *
 * In memory, never persisted: it is a fact about this window's frame, and a
 * persisted "modal open" would survive the modal.
 *
 * Writers are the welcome modal (`modalOpen`, while it is mounted and open)
 * and the tour host (`tourBusy`, from a tour's activation, through its
 * target waits and route changes, until the chain ends or pauses). Readers
 * take `selectOnboardingBusy`; the two flags are kept separate so a reader
 * that cares about one of them can say which.
 */
export interface OnboardingPresenceState {
  /** The welcome modal is mounted and open. */
  readonly modalOpen: boolean;
  /**
   * A tour is active: from activation, through target waits and route
   * changes, until the chain ends or pauses.
   */
  readonly tourBusy: boolean;
  readonly setModalOpen: (open: boolean) => void;
  readonly setTourBusy: (busy: boolean) => void;
}

export const useOnboardingPresenceStore = create<OnboardingPresenceState>()(
  (set) => ({
    modalOpen: false,
    tourBusy: false,
    setModalOpen: (open) =>
      set((state) => (state.modalOpen === open ? state : { modalOpen: open })),
    setTourBusy: (busy) =>
      set((state) => (state.tourBusy === busy ? state : { tourBusy: busy })),
  }),
);

export const selectOnboardingBusy = (
  state: Pick<OnboardingPresenceState, "modalOpen" | "tourBusy">,
): boolean => state.modalOpen || state.tourBusy;
