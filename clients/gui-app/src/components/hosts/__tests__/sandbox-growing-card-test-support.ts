import { screen } from "@testing-library/react";
import { expect } from "vitest";
import { AUTO_SIZING_GROWING_SUMMARY_OVERRIDES } from "@/lib/sandboxes/__tests__/sandbox-auto-sizing-fixture";

/**
 * A 2/4 start at its 50 GB quote, with its full offered awake range.
 */
export const GROWING_RESTING_CARD_OVERRIDES =
  AUTO_SIZING_GROWING_SUMMARY_OVERRIDES;

export function expectGrowingRestingAwakeRateCard(): void {
  expect(screen.getByTestId("sandbox-card-other-rate").textContent).toBe(
    "$0.14–$1.44 an hour",
  );
  expect(screen.getByText("Awake rate")).toBeTruthy();
}
