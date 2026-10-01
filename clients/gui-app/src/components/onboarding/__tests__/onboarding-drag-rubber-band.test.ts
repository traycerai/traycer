import { describe, expect, it } from "vitest";
import { rubberBandOffset } from "@/components/onboarding/use-onboarding-swipe";

/**
 * The resistance law at the tour's ends. Pinned as arithmetic because that is
 * the only place it is observable: the gesture tests can see that a throw past
 * the last act does not commit, but not that the surface answered the finger on
 * its way there - and a hard stop instead reads as a frozen screen.
 */
describe("rubberBandOffset", () => {
  const width = 400;

  it("follows the finger less and less, and never as far as it asks", () => {
    let previous = 0;
    for (const pull of [10, 40, 100, 200, 400, 800]) {
      const offset = rubberBandOffset(pull, width);
      // Still moving, always: resistance, not a wall.
      expect(offset).toBeGreaterThan(previous);
      // And always behind the finger.
      expect(offset).toBeLessThan(pull);
      // The share of the pull that lands keeps shrinking.
      previous = offset;
    }
    expect(rubberBandOffset(10, width) / 10).toBeGreaterThan(
      rubberBandOffset(400, width) / 400,
    );
    // A pull of the surface's own width lands about a third of it.
    expect(rubberBandOffset(width, width) / width).toBeCloseTo(0.355, 3);
  });

  it("resists both directions by the same law, and needs a width to resist in", () => {
    expect(rubberBandOffset(-120, width)).toBe(-rubberBandOffset(120, width));
    // An unmeasured surface has no overshoot to scale: 0 keeps it still rather
    // than dividing by a width that does not exist.
    expect(rubberBandOffset(120, 0)).toBe(0);
  });
});
