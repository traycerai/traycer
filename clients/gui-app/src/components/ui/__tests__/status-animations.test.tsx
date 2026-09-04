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

interface ReducedMotionListenerStub {
  /** Flips what the stubbed MediaQueryList reports as `matches`. */
  readonly setMatches: (matches: boolean) => void;
  /** Invokes every `change` listener the clock registered on the stub. */
  readonly fireChange: () => void;
}

/**
 * Like `stubReducedMotion`, but the returned MediaQueryList actually records
 * `change` listeners and reports a mutable `matches`, so a test can flip the
 * preference mid-run and drive the clock's own `handleReducedMotionChange`.
 */
function stubReducedMotionWithListener(
  initialMatches: boolean,
): ReducedMotionListenerStub {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches(): boolean {
      return query === "(prefers-reduced-motion: reduce)" ? matches : false;
    },
    media: query,
    onchange: null,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.delete(listener);
    },
    dispatchEvent: () => false,
  }));
  return {
    setMatches: (next) => {
      matches = next;
    },
    fireChange: () => {
      for (const listener of listeners) listener();
    },
  };
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

  it("clears every dot's inline opacity and transform when reduced motion turns on mid-run", () => {
    // Install the listener-recording stub BEFORE the first render: the
    // module attaches its change listener only once, on the first
    // subscribe/render after a reset.
    const stub = stubReducedMotionWithListener(false);
    render(<WorkingDots className={undefined} testId="working-dots" />);
    const container = screen.getByTestId("working-dots");
    const dots = container.querySelectorAll<HTMLSpanElement>(":scope > span");

    act(() => {
      vi.advanceTimersByTime(80);
    });
    dots.forEach((dot) => {
      expect(dot.style.opacity).not.toBe("");
    });

    stub.setMatches(true);
    act(() => {
      stub.fireChange();
    });

    dots.forEach((dot) => {
      expect(dot.style.opacity).toBe("");
      expect(dot.style.transform).toBe("");
    });
  });

  it("holds steady through the first 40ms tick and only changes once the pulse cadence (80ms) elapses", () => {
    render(<WorkingDots className={undefined} testId="working-dots" />);
    const container = screen.getByTestId("working-dots");
    const dots = container.querySelectorAll<HTMLSpanElement>(":scope > span");
    const initialOpacities = Array.from(dots).map((dot) => dot.style.opacity);

    // WorkingDots subscribes at STATUS_ANIMATION_PULSE_CADENCE_MS (80ms,
    // every second 40ms tick): the first tick alone must not move it.
    act(() => {
      vi.advanceTimersByTime(40);
    });
    const afterOneTick = Array.from(dots).map((dot) => dot.style.opacity);
    expect(afterOneTick).toEqual(initialOpacities);

    act(() => {
      vi.advanceTimersByTime(40);
    });
    const afterPulseCadence = Array.from(dots).map((dot) => dot.style.opacity);
    expect(afterPulseCadence).not.toEqual(initialOpacities);
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

  it("moves the backgroundPosition after a single smooth tick (40ms)", () => {
    render(
      <WorkingShimmerText className={undefined}>Pondering</WorkingShimmerText>,
    );
    const node = screen.getByText("Pondering");
    expect(node.style.backgroundPosition).toBe("150% center");

    // WorkingShimmerText subscribes at STATUS_ANIMATION_SMOOTH_CADENCE_MS
    // (every 40ms tick), so a single tick alone must already move it.
    act(() => {
      vi.advanceTimersByTime(40);
    });
    const next = node.style.backgroundPosition;
    expect(next).not.toBe("150% center");
    expect(parseFloat(next)).toBeLessThan(150);
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

  it("re-reads the ref on each tick, so swapping 'as' keeps ticking the new host element", () => {
    const { rerender } = render(
      <Shimmer as="p" duration={1}>
        Loading
      </Shimmer>,
    );
    act(() => {
      vi.advanceTimersByTime(80);
    });

    rerender(
      <Shimmer as="span" duration={1}>
        Loading
      </Shimmer>,
    );
    const node = screen.getByText("Loading");
    expect(node.tagName).toBe("SPAN");
    // The new host element mounts at the parked rest position, not
    // wherever the old <p> had swept to.
    expect(node.style.backgroundPosition).toBe("100% center");

    act(() => {
      vi.advanceTimersByTime(80);
    });
    // The next tick wrote onto the NEW element, proving the clock re-read
    // `ref.current` instead of holding the stale <p>.
    expect(parseFloat(node.style.backgroundPosition)).toBeLessThan(100);
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

  it("restores the peak opacity and drops the transform when reduced motion turns on mid-run", () => {
    // Install the listener-recording stub BEFORE the first render: the
    // module attaches its change listener only once, on the first
    // subscribe/render after a reset.
    const stub = stubReducedMotionWithListener(false);
    render(<PingRing toneClass="bg-emerald-500" peakOpacity={0.6} />);
    const ring = queryStatusPing();
    expect(ring).not.toBeNull();
    if (ring === null) throw new Error("ring not found");

    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(parseFloat(ring.style.opacity)).toBeLessThan(0.6);
    expect(ring.style.transform).toMatch(/scale\(/);

    stub.setMatches(true);
    act(() => {
      stub.fireChange();
    });

    // `clear` restores the peak opacity (the resting look the element
    // mounts with) rather than blanking it, and drops the transform.
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
