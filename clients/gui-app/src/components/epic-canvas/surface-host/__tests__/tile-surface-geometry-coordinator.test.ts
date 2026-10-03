import { resizeObserverEntryFor } from "@/__tests__/resize-observer-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { HORIZONTAL_STRIP_AXIS } from "@/components/epic-canvas/dnd/strip-axis";
import {
  invalidateTabStripGeometry,
  registerTabStripGeometry,
  registerTileSurfaceGeometryHost,
  registerTileSurfaceGeometrySlot,
  remeasureTileSurfaceGeometry,
  resetTileSurfaceGeometryCoordinatorForTesting,
  revealStripTab,
  type StripGeometrySnapshot,
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
    instance.callback(
      [...instance.observed].map(resizeObserverEntryFor),
      instance,
    );
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

    // The host resize also shifts its origin, so every slot's host-relative
    // rect genuinely changes and must be redelivered under the new
    // unchanged-rect suppression.
    hostRectRead.mockReturnValue(
      fakeRect({ left: 50, top: 20, width: 400, height: 300 }),
    );
    triggerResizeObserverCallbacks();

    expect(rectsA).toEqual([{ left: 50, top: 80, width: 50, height: 50 }]);
    expect(rectsB).toEqual([{ left: 250, top: 280, width: 50, height: 50 }]);
    expect(hostRectRead).toHaveBeenCalledTimes(1);
  });
});

describe("read-all then changed-only callbacks (perf fix W1-B item 2)", () => {
  it("does not re-invoke a slot's listener when a RO batch fires but its computed rect is unchanged from the last delivered rect", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const slot = document.createElement("div");
    stubRect(slot, { left: 10, top: 10, width: 100, height: 100 });
    const rects: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-1", slot, (rect) => rects.push(rect));
    rects.length = 0;

    // The shared observer fires, but this slot's own rect never changed.
    triggerResizeObserverCallbacks();

    expect(rects).toEqual([]);
  });

  it("reads every registered slot's rect before invoking any changed listener - a listener's own side effect during the sweep cannot leak into a sibling's rect for the same batch", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 800, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const slotB = document.createElement("div");
    stubRect(slotB, { left: 100, top: 0, width: 50, height: 50 });
    const rectsB: TileSurfaceRect[] = [];

    // Slot A is registered (and iterated) first, so it runs first if
    // listeners were interleaved with reads instead of
    // read-all-then-changed-only. Its side effect below must fire only
    // during the TESTED batch, not during A's own registration-time initial
    // delivery (registration synchronously invokes its listener once) -
    // otherwise it would poison slot B's cached rect during setup and the
    // assertion below would pass for the wrong reason regardless of
    // read/publish ordering.
    let sideEffectArmed = false;
    const slotA = document.createElement("div");
    stubRect(slotA, { left: 0, top: 0, width: 50, height: 50 });
    const rectsA: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-a", slotA, (rect) => {
      rectsA.push(rect);
      if (!sideEffectArmed) return;
      // Side effect mid-sweep: if reads and callbacks were interleaved, this
      // would leak into slot B's rect for the same batch.
      stubRect(slotB, { left: 500, top: 0, width: 50, height: 50 });
    });

    registerTileSurfaceGeometrySlot("chat-b", slotB, (rect) =>
      rectsB.push(rect),
    );

    rectsA.length = 0;
    rectsB.length = 0;
    // Slot B cached its real, untouched rect (100) during setup; now the
    // side effect is live for the batch under test.
    sideEffectArmed = true;

    // Only slot A's underlying rect actually changes this batch.
    stubRect(slotA, { left: 10, top: 0, width: 50, height: 50 });
    triggerResizeObserverCallbacks();

    expect(rectsA).toEqual([{ left: 10, top: 0, width: 50, height: 50 }]);
    // Slot B's rect was unchanged at batch-start, so it must stay
    // unreported - its rect was captured before slot A's callback ran.
    expect(rectsB).toEqual([]);
  });
});

describe("explicit remeasure (position-only move)", () => {
  it("re-applies every registered slot's rect on an explicit remeasure when only its position changed and no RO callback fired", () => {
    const host = document.createElement("div");
    stubRect(host, { left: 0, top: 0, width: 1000, height: 600 });
    registerTileSurfaceGeometryHost(host);

    const slotA = document.createElement("div");
    stubRect(slotA, { left: 0, top: 0, width: 500, height: 600 });
    const rectsA: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-a", slotA, (rect) =>
      rectsA.push(rect),
    );

    const slotB = document.createElement("div");
    stubRect(slotB, { left: 500, top: 0, width: 500, height: 600 });
    const rectsB: TileSurfaceRect[] = [];
    registerTileSurfaceGeometrySlot("chat-b", slotB, (rect) =>
      rectsB.push(rect),
    );

    rectsA.length = 0;
    rectsB.length = 0;

    // Position-only move: ONLY `left` changes, width/height stay identical -
    // exactly the "Reverse views" swap condition (`swapSplitSides`) that a
    // ResizeObserver cannot see, since it only fires on a SIZE change.
    stubRect(slotA, { left: 500, top: 0, width: 500, height: 600 });
    stubRect(slotB, { left: 0, top: 0, width: 500, height: 600 });

    // No RO callback is triggered here - proves the RO path alone cannot see
    // a position-only move: nothing has been delivered yet.
    expect(rectsA).toEqual([]);
    expect(rectsB).toEqual([]);

    remeasureTileSurfaceGeometry();

    expect(rectsA).toEqual([{ left: 500, top: 0, width: 500, height: 600 }]);
    expect(rectsB).toEqual([{ left: 0, top: 0, width: 500, height: 600 }]);
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

describe("tab strip geometry (cached bounds)", () => {
  interface StripModel {
    scrollLeft: number;
    scrollWidth: number;
    tabs: Map<string, { left: number; right: number }>;
  }

  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let rectReads: number;
  let model: StripModel;
  let strip: HTMLDivElement;
  let snapshots: StripGeometrySnapshot[];

  function flushFrames(): void {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  }

  /** Deliver pending MutationObserver records, then run the scheduled frame. */
  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    flushFrames();
  }

  function latest(): StripGeometrySnapshot {
    const snapshot = snapshots.at(-1);
    if (snapshot === undefined) throw new Error("no snapshot published");
    return snapshot;
  }

  function addTab(
    key: string,
    box: { left: number; right: number },
  ): HTMLElement {
    model.tabs.set(key, box);
    const tab = document.createElement("button");
    tab.dataset.headerTabKey = key;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    tab.getBoundingClientRect = () => {
      rectReads += 1;
      const current = model.tabs.get(key) ?? box;
      return fakeRect({
        left: current.left - model.scrollLeft,
        top: 0,
        width: current.right - current.left,
        height: 20,
      });
    };
    strip.appendChild(tab);
    return tab;
  }

  function tabOf(key: string): HTMLElement {
    const tab = strip.querySelector<HTMLElement>(
      `[data-header-tab-key="${key}"]`,
    );
    if (tab === null) throw new Error(`no tab ${key}`);
    return tab;
  }

  beforeEach(() => {
    frames = new Map();
    nextFrameId = 0;
    rectReads = 0;
    snapshots = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    // A 400px viewport at x=0 over 460px of content, scrolled to the start.
    model = { scrollLeft: 0, scrollWidth: 600, tabs: new Map() };
    strip = document.createElement("div");
    Object.defineProperty(strip, "scrollLeft", {
      configurable: true,
      get: () => model.scrollLeft,
      set: (value: number) => {
        model.scrollLeft = value;
      },
    });
    Object.defineProperty(strip, "clientWidth", { get: () => 400 });
    Object.defineProperty(strip, "scrollWidth", {
      get: () => model.scrollWidth,
    });
    strip.getBoundingClientRect = () => {
      rectReads += 1;
      return fakeRect({ left: 0, top: 0, width: 400, height: 20 });
    };
    document.body.appendChild(strip);
    addTab("a", { left: 0, right: 100 });
    addTab("b", { left: 100, right: 220 });
    addTab("c", { left: 220, right: 340 });
    addTab("d", { left: 340, right: 460 });
    useEpicDndStore.setState(useEpicDndStore.getInitialState(), true);
  });

  afterEach(() => {
    useEpicDndStore.setState(useEpicDndStore.getInitialState(), true);
    strip.remove();
    vi.unstubAllGlobals();
  });

  function register(): () => void {
    const dispose = registerTabStripGeometry(
      strip,
      HORIZONTAL_STRIP_AXIS,
      (snapshot) => {
        snapshots.push(snapshot);
      },
    );
    flushFrames();
    return dispose;
  }

  it("lists the tabs clipped past each edge from one measurement pass", () => {
    register();
    expect(latest()).toEqual({
      hiddenTabKeys: { left: [], right: ["d"] },
      hasOverflow: true,
    });
  });

  it("reveals a newly selected tab from cached bounds without reading any rect", async () => {
    register();
    rectReads = 0;
    tabOf("d").setAttribute("aria-selected", "true");
    await settle();
    // d ends at 460 in a 400px viewport: the least scroll that shows it.
    expect(model.scrollLeft).toBe(60);
    expect(latest().hiddenTabKeys).toEqual({ left: ["a"], right: [] });
    expect(rectReads).toBe(0);
  });

  it("leaves the offset alone when the selected tab is already in view", async () => {
    register();
    rectReads = 0;
    tabOf("b").setAttribute("aria-selected", "true");
    await settle();
    expect(model.scrollLeft).toBe(0);
    expect(rectReads).toBe(0);
  });

  it("re-reads bounds when the observer reports a size change", () => {
    register();
    rectReads = 0;
    model.tabs.set("d", { left: 340, right: 380 });
    model.scrollWidth = 380;
    triggerResizeObserverCallbacks();
    expect(rectReads).toBeGreaterThan(0);
    expect(latest()).toEqual({
      hiddenTabKeys: { left: [], right: [] },
      hasOverflow: false,
    });
  });

  it("re-reads bounds and observes the new tab when membership changes", async () => {
    register();
    const observer = controllableInstances[0];
    rectReads = 0;
    const added = addTab("e", { left: 460, right: 580 });
    await settle();
    expect(rectReads).toBeGreaterThan(0);
    expect(latest().hiddenTabKeys.right).toEqual(["d", "e"]);
    expect(observer.observed.has(added)).toBe(true);
  });

  it("re-reads bounds after an explicit invalidation", async () => {
    register();
    rectReads = 0;
    model.tabs.set("d", { left: 340, right: 380 });
    model.scrollWidth = 380;
    invalidateTabStripGeometry(strip);
    await settle();
    expect(rectReads).toBeGreaterThan(0);
    expect(latest().hasOverflow).toBe(false);
  });

  it("does not move the strip under a header-tab drag, and keeps the reader's scroll", async () => {
    register();
    useEpicDndStore.setState({
      activeHeaderTab: {
        kind: "header-tab",
        stripItemId: "d",
        tabKind: "epic",
        tabId: "d",
        index: 3,
      },
    });
    rectReads = 0;
    tabOf("d").setAttribute("aria-selected", "true");
    await settle();
    expect(model.scrollLeft).toBe(0);
    // The gesture (or its autoscroll) moves the strip; the cache follows the
    // offset instead of fighting it.
    model.scrollLeft = 30;
    strip.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(model.scrollLeft).toBe(30);
    expect(latest().hiddenTabKeys).toEqual({ left: ["a"], right: ["d"] });
    expect(rectReads).toBe(0);
  });

  it("revealStripTab scrolls a cached tab into view by key and focuses it", () => {
    register();
    rectReads = 0;
    revealStripTab(strip, "d");
    expect(model.scrollLeft).toBe(60);
    expect(document.activeElement).toBe(tabOf("d"));
    expect(rectReads).toBe(0);
    revealStripTab(strip, "missing");
    expect(model.scrollLeft).toBe(60);
  });

  describe("a wrapped split frame wider than the viewport", () => {
    let selectedHalf: HTMLElement;

    function buildWrappedSplit(keyed: boolean): void {
      strip.replaceChildren();
      const place = (
        element: HTMLElement,
        box: { left: number; right: number },
      ): void => {
        element.getBoundingClientRect = () => {
          rectReads += 1;
          return fakeRect({
            left: box.left - model.scrollLeft,
            top: 0,
            width: box.right - box.left,
            height: 20,
          });
        };
      };
      // The strip item wraps both halves, so the half is not a strip child
      // and only the frame's bounds sit under the scroller.
      const frame = document.createElement("div");
      frame.dataset.stripItemId = "split";
      place(frame, { left: 100, right: 700 });
      selectedHalf = document.createElement("button");
      selectedHalf.setAttribute("role", "tab");
      selectedHalf.setAttribute("aria-selected", "true");
      place(selectedHalf, { left: 250, right: 520 });
      const otherHalf = document.createElement("button");
      otherHalf.setAttribute("role", "tab");
      otherHalf.setAttribute("aria-selected", "false");
      place(otherHalf, { left: 520, right: 700 });
      if (keyed) {
        selectedHalf.dataset.headerTabKey = "x";
        otherHalf.dataset.headerTabKey = "y";
      }
      frame.append(selectedHalf, otherHalf);
      strip.appendChild(frame);
      model.scrollWidth = 700;
    }

    function scrollBackToStart(): void {
      model.scrollLeft = 0;
      strip.dispatchEvent(new Event("scroll"));
      flushFrames();
    }

    it("reveals the selected half, not the frame edge that would clip it", () => {
      buildWrappedSplit(true);
      register();
      // The frame (600) cannot fit the 400px viewport. Its end would scroll
      // to 300 and clip the selected half's start (250); the half's own end
      // needs only 120.
      expect(model.scrollLeft).toBe(120);
      expect(latest().hiddenTabKeys).toEqual({ left: [], right: ["y"] });
    });

    it("reveals an unkeyed role=tab half the same way", () => {
      buildWrappedSplit(false);
      register();
      expect(model.scrollLeft).toBe(120);
      expect(latest().hiddenTabKeys).toEqual({ left: [], right: [] });
    });

    it("keeps that offset through revealStripTab, an explicit invalidation and a selection change", async () => {
      buildWrappedSplit(true);
      register();

      scrollBackToStart();
      revealStripTab(strip, "x");
      expect(model.scrollLeft).toBe(120);
      flushFrames();
      expect(model.scrollLeft).toBe(120);

      scrollBackToStart();
      invalidateTabStripGeometry(strip);
      flushFrames();
      expect(model.scrollLeft).toBe(120);

      scrollBackToStart();
      selectedHalf.setAttribute("aria-selected", "false");
      await settle();
      expect(model.scrollLeft).toBe(0);
      selectedHalf.setAttribute("aria-selected", "true");
      await settle();
      expect(model.scrollLeft).toBe(120);
    });
  });

  it("reveals by a canvas frame's layout box, not its scaled drop-tween box, and keeps it after the tween ends", () => {
    strip.replaceChildren();
    const frame = document.createElement("div");
    frame.dataset.tileItemId = "t";
    // Layout 300..500 (200 wide). Mid drop tween the frame is scaled to 0.97
    // about its centre and translated 12px, so it renders 194 wide at 315.
    Object.defineProperty(frame, "offsetWidth", { value: 200 });
    frame.style.transform = "matrix(0.97, 0, 0, 0.97, 12, 0)";
    frame.getBoundingClientRect = () => {
      rectReads += 1;
      const tweening = frame.style.transform !== "none";
      const box = tweening
        ? { left: 315, width: 194 }
        : { left: 300, width: 200 };
      return fakeRect({
        left: box.left - model.scrollLeft,
        top: 0,
        width: box.width,
        height: 20,
      });
    };
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "true");
    tab.dataset.headerTabKey = "t";
    frame.appendChild(tab);
    strip.appendChild(frame);
    model.scrollWidth = 500;
    register();
    // The true layout end (500) needs 100; the shrunken box would say 97.
    expect(model.scrollLeft).toBe(100);

    // The tween ends without any resize or mutation signal.
    frame.style.transform = "none";
    model.scrollLeft = 0;
    strip.dispatchEvent(new Event("scroll"));
    flushFrames();
    rectReads = 0;
    revealStripTab(strip, "t");
    expect(model.scrollLeft).toBe(100);
    expect(rectReads).toBe(0);
  });

  it("stops observing and publishing after dispose", async () => {
    const dispose = register();
    const observer = controllableInstances[0];
    dispose();
    expect(observer.observed.has(strip)).toBe(false);
    const published = snapshots.length;
    triggerResizeObserverCallbacks();
    tabOf("d").setAttribute("aria-selected", "true");
    await settle();
    expect(snapshots).toHaveLength(published);
    expect(model.scrollLeft).toBe(0);
  });
});
