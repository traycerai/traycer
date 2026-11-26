import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  edgeSwipeDirectionAt,
  isEdgeSwipeReserved,
  isLeadingEdgeSwipeReserved,
} from "@/lib/edge-swipe-zones";
import { setSystemGestureInsets } from "@/lib/system-gesture-insets";

/**
 * The shared boundary the onboarding pager and the row swipe tray defer to:
 * they yield every x this module reserves, so what it reserves is what keeps
 * them from starting a drag inside a strip the OS or the navigation swipe owns.
 * Driven through the real insets setter on a 400px viewport.
 */
describe("edge swipe zones", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: 400,
      configurable: true,
    });
  });
  afterEach(() => {
    setSystemGestureInsets({ left: 0, right: 0 });
  });

  it("reserves the 32px band at each edge with no system inset", () => {
    expect([8, 200, 392].map(edgeSwipeDirectionAt)).toEqual([
      "back",
      null,
      "forward",
    ]);
    expect([8, 33, 200, 367, 392].map(isEdgeSwipeReserved)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it("yields the OS strip as well as the band, and nothing between", () => {
    setSystemGestureInsets({ left: 20, right: 50 });

    expect([10, 52, 53, 200, 317, 318, 351].map(isEdgeSwipeReserved)).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("gives the row tray's leading-only yield the same strip and band", () => {
    setSystemGestureInsets({ left: 20, right: 50 });

    expect([10, 52, 53, 350, 351].map(isLeadingEdgeSwipeReserved)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("answers no swipe anywhere when the insets cross, rather than guessing a band", () => {
    setSystemGestureInsets({ left: 300, right: 300 });

    expect([8, 100, 200, 300, 392].map(edgeSwipeDirectionAt)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});
