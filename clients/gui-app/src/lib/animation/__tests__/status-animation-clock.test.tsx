import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import {
  resetStatusAnimationClockForTests,
  STATUS_ANIMATION_PULSE_CADENCE_MS,
  STATUS_ANIMATION_SMOOTH_CADENCE_MS,
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

interface ReducedMotionListenerStub {
  /** Flips what the stubbed MediaQueryList reports as `matches`. */
  readonly setMatches: (matches: boolean) => void;
  /** Invokes every `change` listener the clock registered on the stub. */
  readonly fireChange: () => void;
}

/**
 * Like `stubReducedMotion`, but the returned MediaQueryList actually records
 * `change` listeners (as `attachListenersOnce` registers one via
 * `addEventListener`) and reports a mutable `matches`, so a test can flip the
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

interface ProbeProps {
  readonly write: (element: HTMLDivElement, elapsedMs: number) => void;
  readonly clear: (element: HTMLDivElement) => void;
}

/** Mounts a real element and drives it from the shared clock via the hook. */
function Probe(props: ProbeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useStatusAnimation(ref, props.write, props.clear, STATUS_ANIMATION_TICK_MS);
  return <div ref={ref} data-testid="probe" />;
}

/** Never attaches its ref to an element - exercises the null-ref no-op path. */
function ProbeWithoutElement(props: ProbeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useStatusAnimation(ref, props.write, props.clear, STATUS_ANIMATION_TICK_MS);
  return null;
}

function noopClear(_element: HTMLDivElement): void {}

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
    const unsubscribe1 = subscribeStatusAnimation(
      (elapsed) => calls1.push(elapsed),
      STATUS_ANIMATION_TICK_MS,
    );
    const unsubscribe2 = subscribeStatusAnimation(
      (elapsed) => calls2.push(elapsed),
      STATUS_ANIMATION_TICK_MS,
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
    const unsubscribe = subscribeStatusAnimation(
      () => {},
      STATUS_ANIMATION_TICK_MS,
    );

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
    subscribeStatusAnimation(
      (elapsed) => calls.push(elapsed),
      STATUS_ANIMATION_TICK_MS,
    );
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    // Continues from 160, not restarted at 80.
    expect(calls).toEqual([STATUS_ANIMATION_TICK_MS * 3]);
  });

  it("stops ticking while the document is hidden and resumes without advancing the logical clock meanwhile", () => {
    const calls: number[] = [];
    subscribeStatusAnimation(
      (elapsed) => calls.push(elapsed),
      STATUS_ANIMATION_TICK_MS,
    );

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
    const unsubscribe = subscribeStatusAnimation(
      (elapsed) => calls.push(elapsed),
      STATUS_ANIMATION_TICK_MS,
    );
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 3);
    });
    expect(calls).toEqual([]);

    expect(() => unsubscribe()).not.toThrow();
  });

  it("registers the writer even under reduced motion, and starts ticking once the preference turns off", () => {
    // Install the listener-recording stub BEFORE the first subscribe: the
    // module attaches its change listener only once, on the first
    // subscribe/render after a reset.
    const stub = stubReducedMotionWithListener(true);

    const calls: number[] = [];
    const unsubscribe = subscribeStatusAnimation(
      (elapsed) => calls.push(elapsed),
      STATUS_ANIMATION_TICK_MS,
    );

    // Registered, but the interval refuses to start while reduced motion matches.
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 3);
    });
    expect(calls).toEqual([]);
    expect(statusAnimationElapsedMs()).toBe(0);

    stub.setMatches(false);
    act(() => {
      stub.fireChange();
    });

    // The same, already-registered writer starts ticking once the
    // preference turns off - no re-subscribe needed.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(calls).toEqual([STATUS_ANIMATION_TICK_MS]);

    unsubscribe();
  });

  it("ticks a smooth-cadence writer every tick and a pulse-cadence writer every second tick", () => {
    const smoothCalls: number[] = [];
    const pulseCalls: number[] = [];
    const unsubscribeSmooth = subscribeStatusAnimation(
      (elapsed) => smoothCalls.push(elapsed),
      STATUS_ANIMATION_SMOOTH_CADENCE_MS,
    );
    const unsubscribePulse = subscribeStatusAnimation(
      (elapsed) => pulseCalls.push(elapsed),
      STATUS_ANIMATION_PULSE_CADENCE_MS,
    );

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 4);
    });

    expect(smoothCalls).toEqual([
      STATUS_ANIMATION_TICK_MS,
      STATUS_ANIMATION_TICK_MS * 2,
      STATUS_ANIMATION_TICK_MS * 3,
      STATUS_ANIMATION_TICK_MS * 4,
    ]);
    expect(pulseCalls).toEqual([
      STATUS_ANIMATION_PULSE_CADENCE_MS,
      STATUS_ANIMATION_PULSE_CADENCE_MS * 2,
    ]);

    unsubscribeSmooth();
    unsubscribePulse();
  });

  it("normalizes a requested cadence to the nearest multiple of the tick", () => {
    const snapToSmoothCalls: number[] = [];
    const snapToPulseCalls: number[] = [];
    // 50 / STATUS_ANIMATION_TICK_MS (40) = 1.25, rounds to 1 tick -> snaps
    // down to 40: called on every tick, same as the smooth cadence.
    const unsubscribeSnapToSmooth = subscribeStatusAnimation(
      (elapsed) => snapToSmoothCalls.push(elapsed),
      50,
    );
    // 90 / STATUS_ANIMATION_TICK_MS (40) = 2.25, rounds to 2 ticks -> snaps
    // to 80: called on every second tick, same as the pulse cadence.
    const unsubscribeSnapToPulse = subscribeStatusAnimation(
      (elapsed) => snapToPulseCalls.push(elapsed),
      90,
    );

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 4);
    });

    expect(snapToSmoothCalls).toEqual([
      STATUS_ANIMATION_TICK_MS,
      STATUS_ANIMATION_TICK_MS * 2,
      STATUS_ANIMATION_TICK_MS * 3,
      STATUS_ANIMATION_TICK_MS * 4,
    ]);
    expect(snapToPulseCalls).toEqual([
      STATUS_ANIMATION_TICK_MS * 2,
      STATUS_ANIMATION_TICK_MS * 4,
    ]);

    unsubscribeSnapToSmooth();
    unsubscribeSnapToPulse();
  });
});

describe("useStatusAnimation", () => {
  it("writes once synchronously on mount with the clock's current elapsed time, then on every tick, and unsubscribes on unmount", () => {
    // Advance the clock before mounting so "current elapsed" is nonzero.
    const primerUnsubscribe = subscribeStatusAnimation(
      () => {},
      STATUS_ANIMATION_TICK_MS,
    );
    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 2);
    });
    primerUnsubscribe();
    expect(vi.getTimerCount()).toBe(0);

    const writes: number[] = [];
    const write = (_element: HTMLDivElement, elapsedMs: number): void => {
      writes.push(elapsedMs);
    };

    const { unmount } = render(<Probe write={write} clear={noopClear} />);
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

    const { rerender } = render(<Probe write={firstWrite} clear={noopClear} />);
    expect(firstWrites).toEqual([0]);
    expect(vi.getTimerCount()).toBe(1);

    rerender(<Probe write={secondWrite} clear={noopClear} />);
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

    render(<ProbeWithoutElement write={write} clear={noopClear} />);
    expect(callCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing under prefers-reduced-motion", () => {
    stubReducedMotion(true);

    let callCount = 0;
    const write = (_element: HTMLDivElement, _elapsedMs: number): void => {
      callCount += 1;
    };

    render(<Probe write={write} clear={noopClear} />);
    expect(callCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calls clear with the element on unmount", () => {
    const clearCalls: HTMLDivElement[] = [];
    const write = (_element: HTMLDivElement, _elapsedMs: number): void => {};
    const clear = (element: HTMLDivElement): void => {
      clearCalls.push(element);
    };

    const { unmount } = render(<Probe write={write} clear={clear} />);
    const probeElement = screen.getByTestId("probe");
    expect(clearCalls).toEqual([]);

    unmount();
    expect(clearCalls).toEqual([probeElement]);
  });

  it("clears and stops the interval when reduced motion turns on mid-run, then resumes with a synchronous write and a new interval when it turns off", () => {
    // Install the listener-recording stub BEFORE the first render: the
    // module attaches its change listener only once, on the first
    // subscribe/render after a reset.
    const stub = stubReducedMotionWithListener(false);

    const writes: number[] = [];
    const clearCalls: HTMLDivElement[] = [];
    const write = (_element: HTMLDivElement, elapsedMs: number): void => {
      writes.push(elapsedMs);
    };
    const clear = (element: HTMLDivElement): void => {
      clearCalls.push(element);
    };

    render(<Probe write={write} clear={clear} />);
    const probeElement = screen.getByTestId("probe");
    expect(writes).toEqual([0]);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(writes).toEqual([0, STATUS_ANIMATION_TICK_MS]);

    stub.setMatches(true);
    act(() => {
      stub.fireChange();
    });

    // The effect's cleanup ran: clear fired once with the element, and the
    // interval stopped.
    expect(clearCalls).toEqual([probeElement]);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 3);
    });
    // No further writes while reduced motion matches.
    expect(writes).toEqual([0, STATUS_ANIMATION_TICK_MS]);

    stub.setMatches(false);
    act(() => {
      stub.fireChange();
    });

    // Flipping off re-runs the effect: a synchronous write with the clock's
    // current (frozen) elapsed time, and a fresh interval.
    expect(writes).toEqual([
      0,
      STATUS_ANIMATION_TICK_MS,
      STATUS_ANIMATION_TICK_MS,
    ]);
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(writes).toEqual([
      0,
      STATUS_ANIMATION_TICK_MS,
      STATUS_ANIMATION_TICK_MS,
      STATUS_ANIMATION_TICK_MS * 2,
    ]);
  });

  it("does not write or subscribe inside a hidden keep-alive pane, clears when the pane hides, and resumes when it shows", () => {
    const writes: number[] = [];
    const cleared: HTMLDivElement[] = [];
    const write = (_element: HTMLDivElement, elapsedMs: number): void => {
      writes.push(elapsedMs);
    };
    const clear = (element: HTMLDivElement): void => {
      cleared.push(element);
    };

    const { rerender } = render(
      <PaneVisibilityContext.Provider value={false}>
        <Probe write={write} clear={clear} />
      </PaneVisibilityContext.Provider>,
    );
    // Hidden from the start: nothing written, no interval.
    expect(writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    rerender(
      <PaneVisibilityContext.Provider value>
        <Probe write={write} clear={clear} />
      </PaneVisibilityContext.Provider>,
    );
    // Shown: a synchronous write and a live interval.
    expect(writes).toEqual([0]);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(writes).toEqual([0, STATUS_ANIMATION_TICK_MS]);

    rerender(
      <PaneVisibilityContext.Provider value={false}>
        <Probe write={write} clear={clear} />
      </PaneVisibilityContext.Provider>,
    );
    // Hidden again: the element is cleared, the interval stops, no writes.
    expect(cleared).toEqual([screen.getByTestId("probe")]);
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 3);
    });
    expect(writes).toEqual([0, STATUS_ANIMATION_TICK_MS]);
  });
});
