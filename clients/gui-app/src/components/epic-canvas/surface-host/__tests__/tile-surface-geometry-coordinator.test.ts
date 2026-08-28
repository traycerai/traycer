import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerTileSurfaceGeometryHost,
  registerTileSurfaceGeometrySlot,
  resetTileSurfaceGeometryCoordinatorForTesting,
  type TileSurfaceRect,
} from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";

/**
 * The global `MockResizeObserver` installed by `test-browser-apis.ts` is a
 * total no-op - it never invokes its callback. Installing a controllable
 * replacement at MODULE LOAD TIME (before any test body runs, so it is in
 * place before this coordinator's lazily-constructed singleton observer is
 * ever created) lets these tests fire real RO callbacks on demand. Same
 * technique this repo already used for the ticket-17/18 stack's height-only
 * resize pin - see [[legendlist-pass-through-mock-ref-tee]] in memory.
 */
class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    controllableInstances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }
}

let controllableInstances: ControllableResizeObserver[] = [];

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableResizeObserver,
});

function triggerResizeObserverCallbacks(): void {
  for (const instance of controllableInstances) {
    instance.callback([], instance);
  }
}

function fakeRect(rect: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): DOMRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  };
}

function stubRect(
  element: Element,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  element.getBoundingClientRect = () => fakeRect(rect);
}

beforeEach(() => {
  controllableInstances = [];
  resetTileSurfaceGeometryCoordinatorForTesting();
});

afterEach(() => {
  resetTileSurfaceGeometryCoordinatorForTesting();
});

describe("registration and direct-flush application", () => {
  it("applies an initial rect synchronously on registration, without waiting for a RO callback", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const slot = document.createElement("div");
    stubRect(slot, { left: 50, top: 40, width: 200, height: 100 });
    const rects: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-1", slot, (rect) => rects.push(rect));

    expect(rects).toEqual([{ left: 50, top: 40, width: 200, height: 100 }]);
  });

  it("applies a slot's rect host-relative, not viewport-relative", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 20, top: 30, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const slot = document.createElement("div");
    stubRect(slot, { left: 120, top: 130, width: 200, height: 100 });
    const rects: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-1", slot, (rect) => rects.push(rect));

    expect(rects[0]).toEqual({ left: 100, top: 100, width: 200, height: 100 });
  });

  it("applies a RO callback's rect update directly and synchronously in the same task - no requestAnimationFrame dependence", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const slot = document.createElement("div");
    stubRect(slot, { left: 0, top: 0, width: 100, height: 100 });
    const rects: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-1", slot, (rect) => rects.push(rect));
    rects.length = 0;

    stubRect(slot, { left: 0, top: 0, width: 400, height: 300 });
    triggerResizeObserverCallbacks();

    // Synchronous assertion, no await/advanceTimers/rAF flush of any kind:
    // the new rect must already be applied by the time this line runs.
    expect(rects).toEqual([{ left: 0, top: 0, width: 400, height: 300 }]);
    expect(rafSpy).not.toHaveBeenCalled();
    rafSpy.mockRestore();
  });
});

describe("host-root movement invalidates every registered slot", () => {
  it("re-applies every live slot's rect when the host root itself moves, not only a slot named in the triggering batch", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const slotA = document.createElement("div");
    stubRect(slotA, { left: 100, top: 100, width: 50, height: 50 });
    const rectsA: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-a", slotA, (rect) =>
      rectsA.push(rect),
    );

    const slotB = document.createElement("div");
    stubRect(slotB, { left: 300, top: 300, width: 50, height: 50 });
    const rectsB: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-b", slotB, (rect) =>
      rectsB.push(rect),
    );

    rectsA.length = 0;
    rectsB.length = 0;
    const hostRectRead = vi.spyOn(host, "getBoundingClientRect");

    // Simulate a real host-root resize (e.g. the sidebar toggling) - only
    // the HOST's own observed element changed; neither slot moved.
    hostRectRead.mockReturnValue(
      fakeRect({ left: 0, top: 0, width: 400, height: 300 }),
    );
    triggerResizeObserverCallbacks();

    expect(rectsA).toEqual([{ left: 100, top: 100, width: 50, height: 50 }]);
    expect(rectsB).toEqual([{ left: 300, top: 300, width: 50, height: 50 }]);
    expect(hostRectRead).toHaveBeenCalledTimes(1);
  });
});

describe("unregister and re-registration", () => {
  it("stops delivering rect updates after unregister", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const slot = document.createElement("div");
    stubRect(slot, { left: 0, top: 0, width: 100, height: 100 });
    const rects: TileSurfaceRect[] = [];
    const unregister = registerTileSurfaceGeometrySlot("chat-1", slot, (rect) =>
      rects.push(rect),
    );
    rects.length = 0;
    unregister();

    stubRect(slot, { left: 0, top: 0, width: 999, height: 999 });
    triggerResizeObserverCallbacks();

    expect(rects).toEqual([]);
  });

  it("a stale unregister from a displaced registration cannot clobber a fresh registration under the same key", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const slot = document.createElement("div");
    stubRect(slot, { left: 0, top: 0, width: 100, height: 100 });
    const rectsFirst: TileSurfaceRect[] = [];
    const unregisterFirst = registerTileSurfaceGeometrySlot(
      "chat-1",
      slot,
      (rect) => rectsFirst.push(rect),
    );
    const rectsSecond: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-1", slot, (rect) =>
      rectsSecond.push(rect),
    );
    rectsSecond.length = 0;

    // The first registration's own cleanup fires late, after the second
    // registration has already replaced it under the identical key -
    // exactly the StrictMode double-invoke ordering ticket 22's sentinel
    // bug got wrong ("cleanup cancelled but didn't clear").
    unregisterFirst();

    stubRect(slot, { left: 0, top: 0, width: 250, height: 250 });
    triggerResizeObserverCallbacks();

    expect(rectsSecond).toEqual([{ left: 0, top: 0, width: 250, height: 250 }]);
  });

  it("stops all slot updates and unobserves the host after host unregister", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    const unregisterHost = registerTileSurfaceGeometryHost(host);

    const slot = document.createElement("div");
    stubRect(slot, { left: 0, top: 0, width: 100, height: 100 });
    const rects: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-1", slot, (rect) => rects.push(rect));
    rects.length = 0;

    unregisterHost();
    const observer = controllableInstances.at(0);
    expect(observer?.observed.has(host)).toBe(false);
    stubRect(slot, { left: 0, top: 0, width: 250, height: 250 });
    triggerResizeObserverCallbacks();

    expect(rects).toEqual([]);
  });

  it("late cleanup after a test reset does not construct a replacement observer", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    const unregisterHost = registerTileSurfaceGeometryHost(host);
    const slot = document.createElement("div");
    stubRect(slot, { left: 0, top: 0, width: 100, height: 100 });
    const unregisterSlot = registerTileSurfaceGeometrySlot(
      "chat-1",
      slot,
      () => {},
    );
    expect(controllableInstances).toHaveLength(1);

    resetTileSurfaceGeometryCoordinatorForTesting();
    unregisterHost();
    unregisterSlot();

    expect(controllableInstances).toHaveLength(1);
  });
});

describe("host re-registration", () => {
  it("a later host registration replaces the coordinate origin outright", () => {
    const hostOne = document.createElement("div");
    stubRect(hostOne, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(hostOne);

    const hostTwo = document.createElement("div");
    stubRect(hostTwo, { left: 500, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(hostTwo);

    const slot = document.createElement("div");
    stubRect(slot, { left: 600, top: 0, width: 50, height: 50 });
    const rects: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-1", slot, (rect) => rects.push(rect));

    expect(rects).toEqual([{ left: 100, top: 0, width: 50, height: 50 }]);
  });
});

describe("displaced-element unobserve (design-review F2)", () => {
  function soleObserver(): ControllableResizeObserver {
    const observer = controllableInstances.at(0);
    if (observer === undefined) {
      throw new Error("expected the shared observer to already be constructed");
    }
    return observer;
  }

  it("re-registering a different slot under the same key survives AND stops observing the displaced slot element", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const oldSlot = document.createElement("div");
    stubRect(oldSlot, { left: 0, top: 0, width: 100, height: 100 });
    registerTileSurfaceGeometrySlot("chat-1", oldSlot, () => {});
    expect(soleObserver().observed.has(oldSlot)).toBe(true);

    const newSlot = document.createElement("div");
    stubRect(newSlot, { left: 0, top: 0, width: 200, height: 200 });
    registerTileSurfaceGeometrySlot("chat-1", newSlot, () => {});

    // New registration survives (the reviewer's own phrasing)...
    expect(soleObserver().observed.has(newSlot)).toBe(true);
    // ...and the displaced target is no longer observed.
    expect(soleObserver().observed.has(oldSlot)).toBe(false);
  });

  it("a later host registration stops observing the displaced host element", () => {
    const hostOne = document.createElement("div");
    stubRect(hostOne, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(hostOne);
    expect(soleObserver().observed.has(hostOne)).toBe(true);

    const hostTwo = document.createElement("div");
    stubRect(hostTwo, { left: 500, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(hostTwo);

    expect(soleObserver().observed.has(hostTwo)).toBe(true);
    expect(soleObserver().observed.has(hostOne)).toBe(false);
  });
});
