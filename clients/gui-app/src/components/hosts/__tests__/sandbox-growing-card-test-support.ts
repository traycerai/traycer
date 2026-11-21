import { screen } from "@testing-library/react";
import { expect } from "vitest";

/**
 * A 2/4 start last awake at 4/8, on a 30 GB disk chosen over the 50 GB
 * default: its ranges start at the start's rate, never the current one.
 */
export const GROWING_RESTING_CARD_OVERRIDES = {
  cpus: 2,
  memoryMb: 4_096,
  diskMb: 30_720,
  grows: { cpus: 16, memoryMb: 65_536 },
  priceMcPerHour: {
    awakeMc: 263,
    suspendedMc: 7,
    stoppedMc: 7,
    offer: { startAwakeMc: 135, ceilingAwakeMc: 1_444 },
  },
};

export function expectGrowingRestingAwakeRateCard(): void {
  expect(screen.getByTestId("sandbox-card-other-rate").textContent).toBe(
    "$0.14–$1.44 an hour",
  );
  expect(screen.getByText("Awake rate")).toBeTruthy();
}
