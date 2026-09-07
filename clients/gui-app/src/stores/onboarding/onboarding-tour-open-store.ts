import { create } from "zustand";

/** Whether the onboarding tour is on screen right now. */
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
