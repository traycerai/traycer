import { screen } from "@testing-library/react";
import { expect } from "vitest";

/**
 * A 2/4 start on the 50 GB default disk, last awake at 4/8: every figure is
 * the server's quote at 50 GB, and its range starts at the start's rate,
 * never the current one.
 */
export const GROWING_RESTING_CARD_OVERRIDES = {
  cpus: 2,
  memoryMb: 4_096,
  diskMb: 51_200,
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
