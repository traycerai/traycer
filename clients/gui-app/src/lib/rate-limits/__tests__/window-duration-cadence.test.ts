import { describe, expect, it } from "vitest";
import { namedCadenceForDuration } from "@/lib/rate-limits/window-duration-cadence";

/**
 * The seam both duration formatters ask, so `mo` and `Monthly` can never be
 * answers to two different questions. Asserted here rather than only through
 * each formatter, because the range that matters is one neither of them owns.
 */
describe("namedCadenceForDuration", () => {
  it.each([
    [60, "hours"],
    [300, "hours"],
    [360, "hours"],
    [1_380, "hours"],
  ])("calls %i minutes an hour count", (minutes, expected) => {
    expect(namedCadenceForDuration(minutes)).toBe(expected);
  });

  it("calls a full 24 hours a day rather than an hour count", () => {
    expect(namedCadenceForDuration(1_440)).toBe("day");
  });

  it("calls exactly seven days a week", () => {
    expect(namedCadenceForDuration(10_080)).toBe("week");
  });

  // The reason this function is shared: a calendar month is whichever of these
  // four lengths the month happens to be, and a formatter that recognised only
  // 30 days would rename a monthly period every January.
  it.each([[40_320], [41_760], [43_200], [44_640]])(
    "calls %i minutes a month",
    (minutes) => {
      expect(namedCadenceForDuration(minutes)).toBe("month");
    },
  );

  // A length with no name is counted, not christened.
  it.each([[20_160], [4_320], [38_880], [46_080], [90]])(
    "gives %i minutes no cadence",
    (minutes) => {
      expect(namedCadenceForDuration(minutes)).toBeNull();
    },
  );

  it.each([[0], [-5]])("gives %i minutes no cadence", (minutes) => {
    expect(namedCadenceForDuration(minutes)).toBeNull();
  });
});
