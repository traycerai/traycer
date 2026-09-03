import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStatusAnimationClockForTests } from "@/lib/animation/status-animation-clock";
import { WorkingDots } from "@/components/ui/working-dots";
import { WorkingShimmerText } from "@/components/ui/working-shimmer-text";
import { Shimmer } from "@/components/ui/shimmer";
import { PingRing } from "@/components/ui/ping-ring";
import { LivePulse } from "@/components/ui/live-pulse";
import { HostPresenceDot } from "@/components/settings/host-scope/host-glyph";

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

function queryStatusPing(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".status-ping");
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

describe("WorkingDots", () => {
  it("writes distinct inline opacity per dot from the stagger, both pre-paint and after ticks", () => {
    render(<WorkingDots className={undefined} testId="working-dots" />);
    const container = screen.getByTestId("working-dots");
    const dots = container.querySelectorAll<HTMLSpanElement>(":scope > span");
    expect(dots.length).toBe(3);

    const initialOpacities = Array.from(dots).map((dot) => dot.style.opacity);
    initialOpacities.forEach((opacity) => expect(opacity).not.toBe(""));
    // The 200ms stagger means the three dots are never in perfect lockstep.
    expect(new Set(initialOpacities).size).toBeGreaterThan(1);

    act(() => {
      vi.advanceTimersByTime(80);
    });
    const nextOpacities = Array.from(dots).map((dot) => dot.style.opacity);
    expect(nextOpacities).not.toEqual(initialOpacities);
  });

  it("writes no inline opacity or transform under reduced motion", () => {
    stubReducedMotion(true);
    render(<WorkingDots className={undefined} testId="working-dots" />);
    const container = screen.getByTestId("working-dots");
    const dots = container.querySelectorAll<HTMLSpanElement>(":scope > span");
    dots.forEach((dot) => {
      expect(dot.style.opacity).toBe("");
      expect(dot.style.transform).toBe("");
    });
  });
});

describe("WorkingShimmerText", () => {
  it("writes a sweeping backgroundPosition from the shared clock", () => {
    render(
      <WorkingShimmerText className={undefined}>Pondering</WorkingShimmerText>,
    );
    const node = screen.getByText("Pondering");
    expect(node.style.backgroundPosition).toBe("150% center");

    act(() => {
      vi.advanceTimersByTime(80);
    });
    const next = node.style.backgroundPosition;
    expect(next).not.toBe("150% center");
    expect(parseFloat(next)).toBeLessThan(150);
  });

  it("writes no inline backgroundPosition under reduced motion", () => {
    stubReducedMotion(true);
    render(
      <WorkingShimmerText className={undefined}>Pondering</WorkingShimmerText>,
    );
    const node = screen.getByText("Pondering");
    expect(node.style.backgroundPosition).toBe("");
  });
});

describe("Shimmer", () => {
  it("renders the default <p> element and honors an explicit 'as'", () => {
    const { unmount } = render(<Shimmer>Loading</Shimmer>);
    const paragraph = screen.getByText("Loading");
    expect(paragraph.tagName).toBe("P");
    unmount();

    render(<Shimmer as="span">Loading</Shimmer>);
    const span = screen.getByText("Loading");
    expect(span.tagName).toBe("SPAN");
  });

  it("sweeps backgroundPosition from 100% toward 0% and jumps back up across the wrap", () => {
    render(<Shimmer duration={1}>Loading</Shimmer>);
    const node = screen.getByText("Loading");
    expect(node.style.backgroundPosition).toBe("100% center");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    const midway = parseFloat(node.style.backgroundPosition);
    expect(midway).toBeLessThan(100);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    const late = parseFloat(node.style.backgroundPosition);
    expect(late).toBeLessThan(midway);

    act(() => {
      vi.advanceTimersByTime(240);
    });
    const wrapped = parseFloat(node.style.backgroundPosition);
    expect(wrapped).toBeGreaterThan(late);
  });
});

describe("PingRing", () => {
  it("grows scale and fades opacity toward 0 over the cycle", () => {
    render(<PingRing toneClass="bg-emerald-500" peakOpacity={0.75} />);
    const ring = queryStatusPing();
    expect(ring).not.toBeNull();
    if (ring === null) throw new Error("ring not found");
    expect(ring.style.opacity).toBe("0.75");

    act(() => {
      vi.advanceTimersByTime(80);
    });
    const opacityAfterTick = parseFloat(ring.style.opacity);
    expect(opacityAfterTick).toBeLessThan(0.75);
    expect(ring.style.transform).toMatch(/scale\(/);
    const scaleValue = parseFloat(ring.style.transform.replace(/[^0-9.]/g, ""));
    expect(scaleValue).toBeGreaterThan(1);
  });

  it("keeps only its initial peak opacity under reduced motion, with no transform written", () => {
    stubReducedMotion(true);
    render(<PingRing toneClass="bg-emerald-500" peakOpacity={0.6} />);
    const ring = queryStatusPing();
    expect(ring).not.toBeNull();
    if (ring === null) throw new Error("ring not found");
    expect(ring.style.opacity).toBe("0.6");
    expect(ring.style.transform).toBe("");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(ring.style.opacity).toBe("0.6");
    expect(ring.style.transform).toBe("");
  });
});

describe("LivePulse", () => {
  it("renders a .status-ping child only for the active tone", () => {
    const { rerender } = render(
      <LivePulse
        size="sm"
        tone="active"
        ariaLabel="status"
        className={undefined}
      />,
    );
    expect(queryStatusPing()).not.toBeNull();

    rerender(
      <LivePulse
        size="sm"
        tone="idle"
        ariaLabel="status"
        className={undefined}
      />,
    );
    expect(queryStatusPing()).toBeNull();
  });
});

describe("HostPresenceDot", () => {
  it("renders a .status-ping child only when animate is true", () => {
    const { rerender } = render(
      <HostPresenceDot tone="live" animate className={undefined} />,
    );
    expect(queryStatusPing()).not.toBeNull();

    rerender(
      <HostPresenceDot tone="live" animate={false} className={undefined} />,
    );
    expect(queryStatusPing()).toBeNull();
  });
});
