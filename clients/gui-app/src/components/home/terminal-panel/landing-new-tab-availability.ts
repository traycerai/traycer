import { create } from "zustand";

interface LandingNewTabAvailability {
  readonly terminalDisabled: boolean;
  readonly browserDisabled: boolean;
}

/** The palette reads the active panel's resolved target, including a captured gesture. */
export const useLandingNewTabAvailability =
  create<LandingNewTabAvailability | null>(() => null);
