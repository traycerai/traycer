import { describe, expect, it } from "vitest";
import { withStoredNumber } from "@/components/settings/panels/fallback/fallback-behavior-range";

describe("withStoredNumber", () => {
  it("returns the options unchanged when the stored value is already one of them", () => {
    const options = [10, 11, 12];
    expect(withStoredNumber(options, 11)).toEqual([10, 11, 12]);
  });

  it("gives an absent stored value its own option, sorted into place", () => {
    // Below every option.
    expect(withStoredNumber([10, 11, 12], 5)).toEqual([5, 10, 11, 12]);
    // Between two options.
    expect(withStoredNumber([10, 12, 14], 13)).toEqual([10, 12, 13, 14]);
    // Above every option.
    expect(withStoredNumber([10, 11, 12], 20)).toEqual([10, 11, 12, 20]);
  });

  it("does not mutate the options array it was handed", () => {
    const options = [60, 180, 360];
    const frozen = Object.freeze([...options]);
    // A mutating implementation (e.g. `options.push(stored).sort(...)`) would
    // throw on a frozen array; this call must not.
    expect(() => withStoredNumber(frozen, 720)).not.toThrow();
    expect(options).toEqual([60, 180, 360]);
    expect(frozen).toEqual([60, 180, 360]);
  });

  it("returns a new array even when the stored value was already present", () => {
    const options = [10, 11, 12];
    const result = withStoredNumber(options, 10);
    expect(result).toEqual(options);
    // Same content, not necessarily the same reference - callers must not
    // rely on identity, but the source array must be provably untouched.
    expect(options).toEqual([10, 11, 12]);
  });
});
