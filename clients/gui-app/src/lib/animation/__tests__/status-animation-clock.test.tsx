import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetStatusAnimationClockForTests,
  STATUS_ANIMATION_TICK_MS,
  statusAnimationElapsedMs,
  subscribeStatusAnimation,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

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

interface ProbeProps {
  readonly write: (element: HTMLDivElement, elapsedMs: number) => void;
}

/** Mounts a real element and drives it from the shared clock via the hook. */
function Probe(props: ProbeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useStatusAnimation(ref, props.write);
  return <div ref={ref} data-testid="probe" />;
}

/** Never attaches its ref to an element - exercises the null-ref no-op path. */
function ProbeWithoutElement(props: ProbeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useStatusAnimation(ref, props.write);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStatusAnimationClockForTests();
});

afterEach(() => {
  cleanup();
  resetStatusAnimationClockForTests();
  setDocumentHidden(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("subscribeStatusAnimation", () => {
  it("drives every subscribed writer from one shared interval", () => {
    const calls1: number[] = [];
    const calls2: number[] = [];
    const unsubscribe1 = subscribeStatusAnimation((elapsed) =>
      calls1.push(elapsed),
    );
    const unsubscribe2 = subscribeStatusAnimation((elapsed) =>
      calls2.push(elapsed),
    );

    // Two subscribers, ONE interval - not one each.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(calls1).toEqual([STATUS_ANIMATION_TICK_MS]);
    expect(calls2).toEqual([STATUS_ANIMATION_TICK_MS]);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(calls1).toEqual([
      STATUS_ANIMATION_TICK_MS,
      STATUS_ANIMATION_TICK_MS * 2,
    ]);
    expect(calls2).toEqual([
      STATUS_ANIMATION_TICK_MS,
      STATUS_ANIMATION_TICK_MS * 2,
    ]);

    unsubscribe1();
    unsubscribe2();
  });

  it("stops the interval once the last writer unsubscribes and resumes without resetting elapsed time", () => {
    const unsubscribe = subscribeStatusAnimation(() => {});

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 2);
    });
    expect(statusAnimationElapsedMs()).toBe(STATUS_ANIMATION_TICK_MS * 2);

    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);

    // Nobody is subscribed: the logical clock must not silently keep moving.
    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 3);
    });
    expect(statusAnimationElapsedMs()).toBe(STATUS_ANIMATION_TICK_MS * 2);

    const calls: number[] = [];
    subscribeStatusAnimation((elapsed) => calls.push(elapsed));
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    // Continues from 160, not restarted at 80.
    expect(calls).toEqual([STATUS_ANIMATION_TICK_MS * 3]);
  });

  it("stops ticking while the document is hidden and resumes without advancing the logical clock meanwhile", () => {
    const calls: number[] = [];
    subscribeStatusAnimation((elapsed) => calls.push(elapsed));

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(calls).toEqual([STATUS_ANIMATION_TICK_MS]);

    setDocumentHidden(true);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 5);
    });
    expect(calls).toEqual([STATUS_ANIMATION_TICK_MS]);
    expect(statusAnimationElapsedMs()).toBe(STATUS_ANIMATION_TICK_MS);

    setDocumentHidden(false);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(calls).toEqual([
      STATUS_ANIMATION_TICK_MS,
      STATUS_ANIMATION_TICK_MS * 2,
    ]);
  });

  it("is a no-op under prefers-reduced-motion, with an inert unsubscribe", () => {
    stubReducedMotion(true);

    const calls: number[] = [];
    const unsubscribe = subscribeStatusAnimation((elapsed) =>
      calls.push(elapsed),
    );
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 3);
    });
    expect(calls).toEqual([]);

    expect(() => unsubscribe()).not.toThrow();
  });
});

describe("useStatusAnimation", () => {
  it("writes once synchronously on mount with the clock's current elapsed time, then on every tick, and unsubscribes on unmount", () => {
    // Advance the clock before mounting so "current elapsed" is nonzero.
    const primerUnsubscribe = subscribeStatusAnimation(() => {});
    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 2);
    });
    primerUnsubscribe();
    expect(vi.getTimerCount()).toBe(0);

    const writes: number[] = [];
    const write = (_element: HTMLDivElement, elapsedMs: number): void => {
      writes.push(elapsedMs);
    };

    const { unmount } = render(<Probe write={write} />);
    // Synchronous initial write, before any tick fires.
    expect(writes).toEqual([STATUS_ANIMATION_TICK_MS * 2]);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(writes).toEqual([
      STATUS_ANIMATION_TICK_MS * 2,
      STATUS_ANIMATION_TICK_MS * 3,
    ]);

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 3);
    });
    expect(writes).toEqual([
      STATUS_ANIMATION_TICK_MS * 2,
      STATUS_ANIMATION_TICK_MS * 3,
    ]);
  });

  it("resubscribes when the write callback identity changes", () => {
    const firstWrites: number[] = [];
    const secondWrites: number[] = [];
    const firstWrite = (_element: HTMLDivElement, elapsedMs: number): void => {
      firstWrites.push(elapsedMs);
    };
    const secondWrite = (_element: HTMLDivElement, elapsedMs: number): void => {
      secondWrites.push(elapsedMs);
    };

    const { rerender } = render(<Probe write={firstWrite} />);
    expect(firstWrites).toEqual([0]);
    expect(vi.getTimerCount()).toBe(1);

    rerender(<Probe write={secondWrite} />);
    // The resubscribe re-runs the synchronous initial write on the new callback.
    expect(secondWrites).toEqual([0]);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    // The stale writer must never be called again.
    expect(firstWrites).toEqual([0]);
    expect(secondWrites).toEqual([0, STATUS_ANIMATION_TICK_MS]);
  });

  it("does nothing when the ref has no current element", () => {
    let callCount = 0;
    const write = (_element: HTMLDivElement, _elapsedMs: number): void => {
      callCount += 1;
    };

    render(<ProbeWithoutElement write={write} />);
    expect(callCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing under prefers-reduced-motion", () => {
    stubReducedMotion(true);

    let callCount = 0;
    const write = (_element: HTMLDivElement, _elapsedMs: number): void => {
      callCount += 1;
    };

    render(<Probe write={write} />);
    expect(callCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
