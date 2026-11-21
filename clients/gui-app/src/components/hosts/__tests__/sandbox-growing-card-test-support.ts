import { screen } from "@testing-library/react";
import { expect } from "vitest";

export const GROWING_RESTING_CARD_OVERRIDES = {
  cpus: 2,
  memoryMb: 4_096,
  diskMb: 51_200,
  grows: { cpus: 16, memoryMb: 65_536 },
  priceMcPerHour: {
    awakeMc: 135,
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
