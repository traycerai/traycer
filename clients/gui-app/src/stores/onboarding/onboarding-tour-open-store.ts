import { create } from "zustand";

/**
 * Whether the onboarding tour is on screen right now. Session-local on
 * purpose - this is presence, not progress (the persisted onboarding store
 * owns that) - and it exists so app-level ambient surfaces can hold while the
 * tour has the screen: the import-progress toast waits for the user to land
 * in the real app instead of floating over the stage.
 */
interface OnboardingTourOpenState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

export const useOnboardingTourOpenStore = create<OnboardingTourOpenState>()(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
  }),
);
