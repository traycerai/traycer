import { beforeEach, describe, expect, it } from "vitest";
import {
  selectOnboardingBusy,
  useOnboardingPresenceStore,
} from "@/stores/onboarding/onboarding-presence-store";

describe("useOnboardingPresenceStore", () => {
  beforeEach(() => {
    useOnboardingPresenceStore.setState({ modalOpen: false, tourBusy: false });
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])(
    "selectOnboardingBusy({ modalOpen: %s, tourBusy: %s }) is %s",
    (modalOpen, tourBusy, expected) => {
      expect(selectOnboardingBusy({ modalOpen, tourBusy })).toBe(expected);
    },
  );

  it("setModalOpen(true) leaves tourBusy false", () => {
    useOnboardingPresenceStore.getState().setModalOpen(true);

    const state = useOnboardingPresenceStore.getState();
    expect(state.modalOpen).toBe(true);
    expect(state.tourBusy).toBe(false);
  });

  it("setTourBusy(true) leaves modalOpen false", () => {
    useOnboardingPresenceStore.getState().setTourBusy(true);

    const state = useOnboardingPresenceStore.getState();
    expect(state.tourBusy).toBe(true);
    expect(state.modalOpen).toBe(false);
  });

  it("setModalOpen with the same value keeps getState() identity (no-op)", () => {
    const before = useOnboardingPresenceStore.getState();
    useOnboardingPresenceStore.getState().setModalOpen(false);
    expect(useOnboardingPresenceStore.getState()).toBe(before);
  });

  it("setTourBusy with the same value keeps getState() identity (no-op)", () => {
    const before = useOnboardingPresenceStore.getState();
    useOnboardingPresenceStore.getState().setTourBusy(false);
    expect(useOnboardingPresenceStore.getState()).toBe(before);
  });
});
