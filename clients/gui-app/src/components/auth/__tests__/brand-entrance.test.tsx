import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandEntrance } from "@/components/auth/brand-entrance";
import {
  STATUS_ANIMATION_TICK_MS,
  resetStatusAnimationClockForTests,
} from "@/lib/animation/status-animation-clock";

/**
 * The global test shim answers every media query with `matches: false`. This
 * narrows the reduced-motion query alone; the clock reads only `matches`.
 */
function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced && query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function queryShimmer(): HTMLElement | null {
  return screen.queryByTestId("brand-entrance-mark-shimmer");
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStatusAnimationClockForTests();
});

afterEach(() => {
  cleanup();
  resetStatusAnimationClockForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('<BrandEntrance size="boot" /> mark shimmer', () => {
  it("wraps the MARK alone and sweeps its mask from the shared clock, not a CSS animation", () => {
    render(<BrandEntrance size="boot">{<p>traycer</p>}</BrandEntrance>);
    const shimmer = queryShimmer();
    expect(shimmer).not.toBeNull();
    if (shimmer === null) throw new Error("unreachable");

    // The highlight is clipped to the mark: the wrapper holds the SVG and
    // nothing else, so the wordmark beside it is never under the mask.
    expect(shimmer.children.length).toBe(1);
    expect(shimmer.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(shimmer.contains(screen.getByText("traycer"))).toBe(false);

    // Pre-paint first write: the band starts parked off the left edge.
    expect(shimmer.style.maskPosition).toBe("100% center");
    // Mounted on the clock, not on `animation:` - the card can stay up for
    // minutes, and an always-on CSS animation is the cost the clock exists
    // to avoid.
    expect(shimmer.style.animation).toBe("");
    expect(shimmer.className).not.toMatch(/animate/);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 4);
    });
    const next = shimmer.style.maskPosition;
    expect(next).not.toBe("100% center");
    expect(parseFloat(next)).toBeLessThan(100);
    expect(parseFloat(next)).toBeGreaterThan(0);
  });

  it("parks the band between sweeps and starts the next one from the far edge", () => {
    render(<BrandEntrance size="boot">{null}</BrandEntrance>);
    const shimmer = queryShimmer();
    if (shimmer === null) throw new Error("shimmer missing");

    // Past the travel window, inside the pause: the band sits at 0% (off the
    // right edge) and stays there until the period wraps.
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(shimmer.style.maskPosition).toBe("0% center");
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(shimmer.style.maskPosition).toBe("0% center");

    // The period wraps at 2800ms and the band re-enters from the left.
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(shimmer.style.maskPosition).toBe("100% center");
  });

  it("writes nothing under reduced motion, leaving the static mark", () => {
    stubReducedMotion(true);
    render(<BrandEntrance size="boot">{null}</BrandEntrance>);
    const shimmer = queryShimmer();
    if (shimmer === null) throw new Error("shimmer missing");
    expect(shimmer.style.maskPosition).toBe("");
    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 10);
    });
    expect(shimmer.style.maskPosition).toBe("");
  });

  it("clears its inline position when the boot card goes away", () => {
    const { unmount } = render(
      <BrandEntrance size="boot">{null}</BrandEntrance>,
    );
    const shimmer = queryShimmer();
    if (shimmer === null) throw new Error("shimmer missing");
    expect(shimmer.style.maskPosition).not.toBe("");
    unmount();
    expect(shimmer.style.maskPosition).toBe("");
  });

  it("does not shimmer the hero mark", () => {
    render(<BrandEntrance size="hero">{null}</BrandEntrance>);
    expect(queryShimmer()).toBeNull();
    expect(
      screen.getByTestId("brand-entrance").querySelector("svg"),
    ).not.toBeNull();
  });
});
