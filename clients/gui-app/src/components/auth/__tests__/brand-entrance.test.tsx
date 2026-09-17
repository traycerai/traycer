import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * The stylesheet half of the same two contracts. jsdom does not process CSS,
 * so the inline-style assertions above cannot see an `animation:` added to
 * the class, or a mask rule moved out from under the motion media query -
 * either of which would pass every render-time check while a reduced-motion
 * user got a permanently dimmed mark, or every user paid for an always-on
 * CSS animation. Read the source instead.
 */
describe("auth-arrival.css: the boot mark shimmer rules", () => {
  const css = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "styles",
      "auth-arrival.css",
    ),
    "utf8",
  );

  /** Every `.brand-entrance-mark-shimmer { … }` declaration block, with the index it starts at. */
  function shimmerRules(): { readonly start: number; readonly body: string }[] {
    const rules: { start: number; body: string }[] = [];
    const pattern = /\.brand-entrance-mark-shimmer\s*\{([^}]*)\}/g;
    for (const match of css.matchAll(pattern)) {
      rules.push({ start: match.index, body: match[1] });
    }
    return rules;
  }

  /** `[start, end)` of the body of the `prefers-reduced-motion: no-preference` block. */
  function motionBlockRange(): readonly [number, number] {
    const open = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(open).toBeGreaterThanOrEqual(0);
    const bodyStart = css.indexOf("{", open) + 1;
    let depth = 1;
    for (let i = bodyStart; i < css.length; i++) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) return [bodyStart, i];
      }
    }
    throw new Error("unterminated motion media block");
  }

  it("declares the mask only under the motion media query", () => {
    const [start, end] = motionBlockRange();
    const masked = shimmerRules().filter((rule) =>
      rule.body.includes("mask-image"),
    );
    expect(masked.length).toBe(1);
    for (const rule of masked) {
      expect(rule.start).toBeGreaterThan(start);
      expect(rule.start).toBeLessThan(end);
    }
  });

  it("never drives the sweep with a CSS animation", () => {
    const rules = shimmerRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.body).not.toMatch(/animation|transition/);
    }
  });
});
