import { describe, expect, it } from "vitest";
import { reasoningDragPosition } from "@/components/home/pickers/use-reasoning-slider-gesture";

const MAX_PULL = 0.07;
// A ladder of 6+ options (lastIndex >= 5) is where the cap saturates to the
// full, unscaled coefficient - the baseline every earlier assertion here was
// written against before the small-ladder cap existed.
const UNCAPPED_LAST_INDEX = 5;

describe("reasoningDragPosition", () => {
  it("leaves every integer stop exactly where it is", () => {
    for (const stop of [-2, -1, 0, 1, 2, 3, 10]) {
      expect(reasoningDragPosition(stop, UNCAPPED_LAST_INDEX)).toBe(stop);
    }
  });

  it("never pulls a position more than 7% of one interval away from itself", () => {
    for (let raw = -3; raw <= 3; raw += 0.01) {
      expect(
        Math.abs(reasoningDragPosition(raw, UNCAPPED_LAST_INDEX) - raw),
      ).toBeLessThanOrEqual(MAX_PULL + 1e-9);
    }
  });

  it("is monotonically increasing - the preview never runs backward as the raw position advances", () => {
    let previous = reasoningDragPosition(-3, UNCAPPED_LAST_INDEX);
    for (let raw = -2.99; raw <= 3; raw += 0.01) {
      const current = reasoningDragPosition(raw, UNCAPPED_LAST_INDEX);
      expect(current).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = current;
    }
  });

  it("pulls a position toward its nearest stop without changing which stop that is", () => {
    // 1.125 is 1/8 of the way past stop 1 - pulled back toward it, but the
    // RAW position (not this eased preview) is what `Math.round` in the
    // gesture's `onValueChange` commits, so the selected level is unaffected.
    const pulled = reasoningDragPosition(1.125, UNCAPPED_LAST_INDEX);
    expect(pulled).toBeCloseTo(1.0755, 4);
    expect(pulled).not.toBeCloseTo(1.125, 4);
    expect(Math.round(pulled)).toBe(Math.round(1.125));
  });

  it("has zero pull exactly at the midpoint between two stops", () => {
    // `Math.round(1.5)` is 2 in JS (rounds .5 up), so the offset from that
    // nearest stop is -0.5, and `sin(-π)` is (numerically) zero.
    expect(reasoningDragPosition(1.5, UNCAPPED_LAST_INDEX)).toBeCloseTo(1.5, 9);
  });

  // A flat 7%-of-one-interval pull put a 2-level ladder's single interval -
  // the WHOLE track - under a 7% displacement. Scaling the coefficient by
  // `lastIndex / 5` keeps a small ladder's worst case proportionally smaller,
  // reaching the full 7% only once the ladder is long enough (6+ options)
  // that one interval is a small slice of the track anyway.
  describe("small-ladder pull cap", () => {
    // The pull peaks at a quarter-interval offset (`sin(π/2) = 1`), so the
    // displacement there IS the coefficient itself - the cleanest way to read
    // off "how hard does this ladder length pull".
    function worstCasePull(lastIndex: number): number {
      const raw = 0.25;
      return Math.abs(reasoningDragPosition(raw, lastIndex) - raw);
    }

    it("scales the worst-case pull down for 2- and 3-option ladders instead of a flat 7%", () => {
      const twoOptions = worstCasePull(1);
      const threeOptions = worstCasePull(2);
      const sixOptions = worstCasePull(UNCAPPED_LAST_INDEX);

      expect(twoOptions).toBeCloseTo(0.014, 6);
      expect(threeOptions).toBeCloseTo(0.028, 6);
      expect(sixOptions).toBeCloseTo(MAX_PULL, 6);
      expect(twoOptions).toBeLessThan(threeOptions);
      expect(threeOptions).toBeLessThan(sixOptions);
    });

    it("caps at the full 7% once a ladder reaches 6 options - longer ladders never pull harder", () => {
      expect(worstCasePull(UNCAPPED_LAST_INDEX)).toBeCloseTo(MAX_PULL, 6);
      expect(worstCasePull(9)).toBeCloseTo(MAX_PULL, 6);
      expect(worstCasePull(20)).toBeCloseTo(MAX_PULL, 6);
    });

    it("keeps a 2-option ladder's worst case at 1.4% of its whole track, not 7% of it", () => {
      // With only 1 interval, "one interval" IS the whole track, so
      // normalizing the pull by `lastIndex` gives the fraction of total
      // travel it represents.
      const lastIndex = 1;
      expect(worstCasePull(lastIndex) / lastIndex).toBeCloseTo(0.014, 6);
    });
  });
});
