import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
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
import {
  __resetDocumentVisibilitySubscribersForTests,
  setDesktopWindowOnScreen,
} from "@/lib/dom/document-visibility";

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

/**
 * jsdom has no IntersectionObserver. This one records what the clock observes
 * and lets a test report a node on or off screen, the way the browser would.
 * The clock creates ONE shared observer for all its writers.
 */
interface IntersectionObserverHandle {
  /** The nodes the clock currently observes. */
  readonly observed: ReadonlySet<Element>;
  /** Delivers one entry for `element`, as the browser does on a change. */
  report(element: Element, isIntersecting: boolean): void;
}

function installFakeIntersectionObserver(): IntersectionObserverHandle {
  const observed = new Set<Element>();
  const callbacks: Array<(entries: IntersectionObserverEntry[]) => void> = [];
  class FakeIntersectionObserver {
    constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
      callbacks.push(callback);
    }
    observe(element: Element): void {
      observed.add(element);
    }
    unobserve(element: Element): void {
      observed.delete(element);
    }
    disconnect(): void {
      observed.clear();
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  return {
    observed,
    report: (element, isIntersecting) => {
      const callback = callbacks.at(-1);
      if (callback === undefined) {
        throw new Error("the clock never created an IntersectionObserver");
      }
      const rect = element.getBoundingClientRect();
      act(() => {
        callback([
          {
            target: element,
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0,
            boundingClientRect: rect,
            intersectionRect: rect,
            rootBounds: null,
            time: 0,
          },
        ]);
      });
    },
  };
}

interface ProbeProps {
  readonly write: (element: HTMLDivElement, elapsedMs: number) => void;
  readonly clear: (element: HTMLDivElement) => void;
}

/** Mounts a real element and drives it from the shared clock via the hook. */
function Probe(props: ProbeProps) {
  const ref = useStatusAnimation<HTMLDivElement>(
    props.write,
    props.clear,
    STATUS_ANIMATION_TICK_MS,
  );
  return <div ref={ref} data-testid="probe" />;
}

/** Never attaches the returned ref to an element - nothing to animate. */
function ProbeWithoutElement(props: ProbeProps) {
  useStatusAnimation<HTMLDivElement>(
    props.write,
    props.clear,
    STATUS_ANIMATION_TICK_MS,
  );
  return null;
}

interface SwapProbeProps {
  readonly tag: "div" | "section";
  readonly write: (element: HTMLElement, elapsedMs: number) => void;
  readonly clear: (element: HTMLElement) => void;
}

/** Swaps its host element's tag (a polymorphic `as`), so React remounts the node. */
function SwapProbe(props: SwapProbeProps) {
  const ref = useStatusAnimation<HTMLElement>(
    props.write,
    props.clear,
    STATUS_ANIMATION_TICK_MS,
  );
  return props.tag === "div" ? (
    <div ref={ref} data-testid="host" />
  ) : (
    <section ref={ref} data-testid="host" />
  );
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
  setDesktopWindowOnScreen(true);
  __resetDocumentVisibilitySubscribersForTests();
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
      null,
    );
    const unsubscribe2 = subscribeStatusAnimation(
      (elapsed) => calls2.push(elapsed),
      STATUS_ANIMATION_TICK_MS,
      null,
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
      null,
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
      null,
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
      null,
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

  it("stops ticking when the desktop window is off screen even though Page Visibility stays visible", () => {
    const calls: number[] = [];
    subscribeStatusAnimation(
      (elapsed) => calls.push(elapsed),
      STATUS_ANIMATION_TICK_MS,
      null,
    );

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS);
    });
    expect(calls).toEqual([STATUS_ANIMATION_TICK_MS]);
    expect(document.visibilityState).toBe("visible");

    setDesktopWindowOnScreen(false);
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(STATUS_ANIMATION_TICK_MS * 5);
    });
    expect(calls).toEqual([STATUS_ANIMATION_TICK_MS]);
    expect(statusAnimationElapsedMs()).toBe(STATUS_ANIMATION_TICK_MS);

    setDesktopWindowOnScreen(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("is a no-op under prefers-reduced-motion, with an inert unsubscribe", () => {
    stubReducedMotion(true);

    const calls: number[] = [];
    const unsubscribe = subscribeStatusAnimation(
      (elapsed) => calls.push(elapsed),
      STATUS_ANIMATION_TICK_MS,
      null,
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
      null,
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
      null,
    );
    const unsubscribePulse = subscribeStatusAnimation(
      (elapsed) => pulseCalls.push(elapsed),
      STATUS_ANIMATION_PULSE_CADENCE_MS,
      null,
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
      null,
    );
    // 90 / STATUS_ANIMATION_TICK_MS (40) = 2.25, rounds to 2 ticks -> snaps
    // to 80: called on every second tick, same as the pulse cadence.
    const unsubscribeSnapToPulse = subscribeStatusAnimation(
      (elapsed) => snapToPulseCalls.push(elapsed),
      90,
      null,
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
      null,
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

describe("status animation clock on-screen gating", () => {
  const TICK = STATUS_ANIMATION_TICK_MS;

  function advanceTicks(ticks: number): void {
    act(() => {
      vi.advanceTimersByTime(TICK * ticks);
    });
  }

  it("does not tick a writer whose node is off screen and stops the interval when none is on screen", () => {
    const io = installFakeIntersectionObserver();
    const node = document.createElement("div");
    const calls: number[] = [];
    subscribeStatusAnimation((elapsed) => calls.push(elapsed), TICK, node);
    expect(io.observed.has(node)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    advanceTicks(1);
    expect(calls).toEqual([TICK]);

    io.report(node, false);
    expect(vi.getTimerCount()).toBe(0);
    advanceTicks(5);
    expect(calls).toEqual([TICK]);
    // The logical clock froze with the interval.
    expect(statusAnimationElapsedMs()).toBe(TICK);
  });

  it("writes a writer that comes back on screen at once with the SHARED elapsed time, then resumes ticking it", () => {
    const io = installFakeIntersectionObserver();
    const node = document.createElement("div");
    const calls: number[] = [];
    subscribeStatusAnimation((elapsed) => calls.push(elapsed), TICK, node);
    // An untracked writer keeps the shared clock running while `node` is off
    // screen, so the clock moves on without the first writer.
    subscribeStatusAnimation(() => undefined, TICK, null);

    advanceTicks(1);
    io.report(node, false);
    advanceTicks(4);
    expect(calls).toEqual([TICK]);
    expect(statusAnimationElapsedMs()).toBe(TICK * 5);

    io.report(node, true);
    // In phase with the shared clock immediately, not on the next tick.
    expect(calls).toEqual([TICK, TICK * 5]);

    advanceTicks(1);
    expect(calls).toEqual([TICK, TICK * 5, TICK * 6]);
  });

  it("ticks only the on-screen writer when two are subscribed and one is off screen", () => {
    const io = installFakeIntersectionObserver();
    const visibleNode = document.createElement("div");
    const hiddenNode = document.createElement("div");
    const visibleCalls: number[] = [];
    const hiddenCalls: number[] = [];
    subscribeStatusAnimation(
      (elapsed) => visibleCalls.push(elapsed),
      TICK,
      visibleNode,
    );
    subscribeStatusAnimation(
      (elapsed) => hiddenCalls.push(elapsed),
      TICK,
      hiddenNode,
    );

    io.report(hiddenNode, false);
    // One writer is still on screen: the interval stays.
    expect(vi.getTimerCount()).toBe(1);
    advanceTicks(2);

    expect(visibleCalls).toEqual([TICK, TICK * 2]);
    expect(hiddenCalls).toEqual([]);
  });

  it("restarts the interval for a new writer after an off-screen writer unsubscribed", () => {
    const io = installFakeIntersectionObserver();
    const offScreen = document.createElement("div");
    const unsubscribeOffScreen = subscribeStatusAnimation(
      () => undefined,
      TICK,
      offScreen,
    );
    io.report(offScreen, false);
    expect(vi.getTimerCount()).toBe(0);

    // Removing a writer that was already off screen must not count against the
    // on-screen writers, or the next subscribe would see zero and not start.
    unsubscribeOffScreen();
    const calls: number[] = [];
    subscribeStatusAnimation((elapsed) => calls.push(elapsed), TICK, null);
    expect(vi.getTimerCount()).toBe(1);

    advanceTicks(1);
    expect(calls).toEqual([TICK]);
  });

  it("stops observing a node when its writer unsubscribes", () => {
    const io = installFakeIntersectionObserver();
    const node = document.createElement("div");
    const unsubscribe = subscribeStatusAnimation(() => undefined, TICK, node);
    expect(io.observed.has(node)).toBe(true);

    unsubscribe();
    expect(io.observed.has(node)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never gates a writer when the platform has no IntersectionObserver", () => {
    const node = document.createElement("div");
    const calls: number[] = [];
    subscribeStatusAnimation((elapsed) => calls.push(elapsed), TICK, node);

    advanceTicks(2);
    expect(calls).toEqual([TICK, TICK * 2]);
  });
});

describe("useStatusAnimation on-screen gating", () => {
  const TICK = STATUS_ANIMATION_TICK_MS;

  function renderProbe(
    selected: boolean,
    write: (element: HTMLDivElement, elapsedMs: number) => void,
    clear: (element: HTMLDivElement) => void,
  ) {
    return (
      <TabBodySelectedContext.Provider value={selected}>
        <Probe write={write} clear={clear} />
      </TabBodySelectedContext.Provider>
    );
  }

  it("does not subscribe in an unselected tab body, clears when it deselects, and writes the CURRENT shared phase when it is selected again", () => {
    // A writer outside the tab keeps the shared clock moving meanwhile.
    subscribeStatusAnimation(() => undefined, TICK, null);

    const writes: number[] = [];
    const cleared: HTMLDivElement[] = [];
    const write = (_element: HTMLDivElement, elapsedMs: number): void => {
      writes.push(elapsedMs);
    };
    const clear = (element: HTMLDivElement): void => {
      cleared.push(element);
    };

    const { rerender } = render(renderProbe(false, write, clear));
    // Unselected from the start: nothing written for it.
    expect(writes).toEqual([]);

    rerender(renderProbe(true, write, clear));
    expect(writes).toEqual([0]);
    act(() => {
      vi.advanceTimersByTime(TICK);
    });
    expect(writes).toEqual([0, TICK]);

    rerender(renderProbe(false, write, clear));
    expect(cleared).toEqual([screen.getByTestId("probe")]);
    act(() => {
      vi.advanceTimersByTime(TICK * 4);
    });
    // No ticks reach the deselected body while the shared clock moves on.
    expect(writes).toEqual([0, TICK]);
    expect(statusAnimationElapsedMs()).toBe(TICK * 5);

    rerender(renderProbe(true, write, clear));
    expect(writes).toEqual([0, TICK, TICK * 5]);
  });

  it("stops ticking a hook's element the shared observer reports off screen, and resumes at the shared phase", () => {
    const io = installFakeIntersectionObserver();
    // Keeps the interval alive while the probe is off screen.
    subscribeStatusAnimation(() => undefined, TICK, null);

    const writes: number[] = [];
    const write = (_element: HTMLDivElement, elapsedMs: number): void => {
      writes.push(elapsedMs);
    };
    render(<Probe write={write} clear={noopClear} />);
    const probeElement = screen.getByTestId("probe");
    expect(io.observed.has(probeElement)).toBe(true);
    expect(writes).toEqual([0]);

    io.report(probeElement, false);
    act(() => {
      vi.advanceTimersByTime(TICK * 3);
    });
    expect(writes).toEqual([0]);

    io.report(probeElement, true);
    expect(writes).toEqual([0, TICK * 3]);
  });
});

describe("useStatusAnimation host element swap", () => {
  const TICK = STATUS_ANIMATION_TICK_MS;

  it("moves the subscription to the new host node, clearing the old one, and follows the new node's visibility", () => {
    const io = installFakeIntersectionObserver();
    const writes: Array<{ readonly tag: string; readonly elapsedMs: number }> =
      [];
    const cleared: HTMLElement[] = [];
    const write = (element: HTMLElement, elapsedMs: number): void => {
      writes.push({ tag: element.tagName, elapsedMs });
    };
    const clear = (element: HTMLElement): void => {
      cleared.push(element);
    };

    const { rerender } = render(
      <SwapProbe tag="div" write={write} clear={clear} />,
    );
    const oldNode = screen.getByTestId("host");
    expect(oldNode.tagName).toBe("DIV");
    expect(io.observed.has(oldNode)).toBe(true);

    rerender(<SwapProbe tag="section" write={write} clear={clear} />);
    const newNode = screen.getByTestId("host");
    expect(newNode.tagName).toBe("SECTION");
    // The old node was cleared and let go; the new one is observed.
    expect(cleared).toEqual([oldNode]);
    expect(io.observed.has(oldNode)).toBe(false);
    expect(io.observed.has(newNode)).toBe(true);
    // One interval, not one per node.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(TICK);
    });
    expect(writes.at(-1)).toEqual({ tag: "SECTION", elapsedMs: TICK });

    // The new node decides visibility: off screen stops it, back on resumes.
    io.report(newNode, false);
    expect(vi.getTimerCount()).toBe(0);
    io.report(newNode, true);
    expect(vi.getTimerCount()).toBe(1);
    expect(writes.at(-1)).toEqual({ tag: "SECTION", elapsedMs: TICK });
    act(() => {
      vi.advanceTimersByTime(TICK);
    });
    expect(writes.at(-1)).toEqual({ tag: "SECTION", elapsedMs: TICK * 2 });
  });
});
