import "../../../../../__tests__/test-browser-apis";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_HISTORY_GESTURE,
  installDesktopHistoryGesture,
  ownsDesktopHorizontalWheel,
  type DesktopHistoryDirection,
  type DesktopHistoryGestureView,
} from "@/components/layout/shell/desktop-history-gesture";
import { claimBlockingLayer } from "@/components/layout/shell/blocking-layer-claim";
import type {
  DesktopTrackpadScrollEvent,
  DesktopTrackpadScrollKind,
  DesktopTrackpadScrollPhaseBridge,
} from "@/lib/windows/types";

/**
 * Dispatched on the real, attached `target` itself, with `composed: true`,
 * and left to propagate up to `document` - where the recognizer listens in
 * the capture phase - the same way a real wheel event would. The recognizer
 * reads `event.composedPath()[0] ?? event.target` to resolve ownership
 * (desktop-history-gesture.ts), and both of those come from the DOM's own
 * dispatch here rather than a faked EventTarget: a `document.dispatchEvent`
 * with only `target` overridden via `defineProperty` leaves `composedPath()`
 * pointing at `document` itself (not an Element), which silently breaks
 * every ownership check downstream of it.
 */
function dispatchWheel(options: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly target: Element;
  readonly cancelable: boolean;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
}): WheelEvent {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    composed: true,
    cancelable: options.cancelable,
    deltaX: options.deltaX,
    deltaY: options.deltaY,
    deltaMode: options.deltaMode,
    ctrlKey: options.ctrlKey,
  });
  options.target.dispatchEvent(event);
  return event;
}

// `cancelable` is a required argument, not a default, because Chromium wheel
// scroll latching makes it a fact about WHICH event in a sequence this is
// (only the first is cancelable) - a test building a latched sequence must
// say so at every call site rather than silently inheriting a "cancelable"
// default that only happens to fit the first tick.
function horizontalWheel(
  deltaX: number,
  target: Element,
  cancelable: boolean,
): WheelEvent {
  return dispatchWheel({
    deltaX,
    deltaY: 0,
    target,
    cancelable,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    ctrlKey: false,
  });
}

function verticalWheel(
  deltaY: number,
  target: Element,
  cancelable: boolean,
): WheelEvent {
  return dispatchWheel({
    deltaX: 0,
    deltaY,
    target,
    cancelable,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    ctrlKey: false,
  });
}

/** DOM wheel sign: scrolling toward "back" reads as negative deltaX. */
function deltaXToward(
  direction: DesktopHistoryDirection,
  magnitudePx: number,
): number {
  return direction === "back" ? -magnitudePx : magnitudePx;
}

/** Trackpad sign: fingers moving right (positive) reveal "back". */
function scrollingDeltaXToward(
  direction: DesktopHistoryDirection,
  magnitudePx: number,
): number {
  return direction === "back" ? magnitudePx : -magnitudePx;
}

/** Comfortably past the 12px intent threshold, so the first change alone activates. */
const ACTIVATION_PX = DESKTOP_HISTORY_GESTURE.intentPx + 8;

// Trackpad timestamps are seconds. The default step is one 60 Hz frame.
const FRAME_SECONDS = 0.016;
// Slow enough that no two samples share a flick window, so a pull helper
// decides by distance alone and never by accident of velocity.
const SLOW_STEP_SECONDS = 0.25;

let trackpadClockSeconds = 0;

interface TickFields {
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly t: number | undefined;
  readonly modified: boolean | undefined;
}

const PLAIN_TICK: TickFields = {
  x: undefined,
  y: undefined,
  t: undefined,
  modified: undefined,
};

/** Fills what a test does not care about: no vertical travel, unmodified, one frame later. */
function trackpadTick(
  kind: DesktopTrackpadScrollKind,
  fields: TickFields,
): DesktopTrackpadScrollEvent {
  const timestamp = fields.t ?? trackpadClockSeconds + FRAME_SECONDS;
  trackpadClockSeconds = timestamp;
  return {
    kind,
    scrollingDeltaX: fields.x ?? 0,
    scrollingDeltaY: fields.y ?? 0,
    timestamp,
    modified: fields.modified ?? false,
  };
}

/**
 * Fake `DesktopTrackpadScrollPhaseBridge`. The real one forwards macOS NSEvent
 * scroll phases and deltas from the Electron shell; no DOM event models a
 * finger lift, so tests drive it directly through `emit`.
 */
interface FakeTrackpad extends DesktopTrackpadScrollPhaseBridge {
  readonly emit: (event: DesktopTrackpadScrollEvent) => void;
  readonly isDisposed: () => boolean;
}

function createFakeTrackpad(): FakeTrackpad {
  let handler: ((event: DesktopTrackpadScrollEvent) => void) | null = null;
  let disposed = false;
  return {
    onEvent: (nextHandler) => {
      handler = nextHandler;
      return {
        dispose: () => {
          disposed = true;
        },
      };
    },
    emit: (event) => {
      if (handler === null || disposed) return;
      handler(event);
    },
    isDisposed: () => disposed,
  };
}

interface GestureProbe {
  readonly views: ReadonlyArray<DesktopHistoryGestureView | null>;
  readonly navigations: ReadonlyArray<DesktopHistoryDirection>;
}

interface MountedGesture {
  readonly probe: GestureProbe;
  readonly trackpad: FakeTrackpad;
  /** Emits one trackpad event of `kind` with the given fields. */
  readonly send: (kind: DesktopTrackpadScrollKind, fields: TickFields) => void;
  /** Emits a delta-free trackpad event: began, ended, cancelled, momentum-*. */
  readonly signal: (kind: DesktopTrackpadScrollKind) => void;
  readonly uninstall: () => void;
  readonly setCurrentEntry: (entry: string) => void;
  readonly setDestination: (
    destinationFor: (direction: DesktopHistoryDirection) => string | null,
  ) => void;
}

interface MountGestureOptions {
  readonly currentEntry: string;
  readonly destinationFor: (
    direction: DesktopHistoryDirection,
  ) => string | null;
}

const DEFAULT_MOUNT: MountGestureOptions = {
  currentEntry: "/origin",
  destinationFor: (direction) =>
    direction === "back" ? "/back-target" : "/forward-target",
};

let activeMounts: MountedGesture[] = [];
let laterListenerCleanups: Array<() => void> = [];

function mountGesture(options: MountGestureOptions): MountedGesture {
  const views: Array<DesktopHistoryGestureView | null> = [];
  const navigations: DesktopHistoryDirection[] = [];
  let currentEntry = options.currentEntry;
  let destinationFor = options.destinationFor;
  const trackpad = createFakeTrackpad();
  const uninstall = installDesktopHistoryGesture({
    currentEntry: () => currentEntry,
    destination: (direction) => destinationFor(direction),
    navigate: (direction) => {
      navigations.push(direction);
    },
    render: (view) => {
      views.push(view);
    },
    trackpad,
  });
  const send = (kind: DesktopTrackpadScrollKind, fields: TickFields): void => {
    trackpad.emit(trackpadTick(kind, fields));
  };
  const mounted: MountedGesture = {
    probe: { views, navigations },
    trackpad,
    send,
    signal: (kind) => send(kind, PLAIN_TICK),
    uninstall,
    setCurrentEntry: (entry) => {
      currentEntry = entry;
    },
    setDestination: (next) => {
      destinationFor = next;
    },
  };
  activeMounts.push(mounted);
  return mounted;
}

/**
 * A wheel listener registered AFTER the recognizer's own, on the same node and
 * phase. `stopImmediatePropagation()` is invisible on the event afterwards;
 * whether this listener runs is how a test sees it.
 */
function listenAfterRecognizer(): { readonly reached: () => number } {
  const listener = vi.fn();
  document.addEventListener("wheel", listener, { capture: true });
  laterListenerCleanups.push(() =>
    document.removeEventListener("wheel", listener, { capture: true }),
  );
  return { reached: () => listener.mock.calls.length };
}

/**
 * Drives a full claimed pull: `began`, one cancelable DOM tick on `target`
 * (cancels the opening tick and satisfies the "a DOM tick arrived after
 * began" latch), then trackpad `changed` ticks summing to `travelPx` toward
 * `direction`: one of ACTIVATION_PX, then the remainder a slow step later.
 * Returns the opening DOM tick. It is slow so distance, never velocity,
 * decides at the lift; flick tests drive their own ticks.
 */
function pullTo(
  mounted: MountedGesture,
  direction: DesktopHistoryDirection,
  travelPx: number,
  target: Element,
): WheelEvent {
  mounted.signal("began");
  const opening = horizontalWheel(
    deltaXToward(direction, ACTIVATION_PX),
    target,
    true,
  );
  mounted.send("changed", {
    ...PLAIN_TICK,
    x: scrollingDeltaXToward(direction, ACTIVATION_PX),
  });
  const remaining = travelPx - ACTIVATION_PX;
  if (remaining !== 0)
    mounted.send("changed", {
      ...PLAIN_TICK,
      x: scrollingDeltaXToward(direction, remaining),
      t: trackpadClockSeconds + SLOW_STEP_SECONDS,
    });
  return opening;
}

function hasRenderedView(mounted: MountedGesture): boolean {
  return mounted.probe.views.some((view) => view !== null);
}

function hasPhase(
  mounted: MountedGesture,
  phase: DesktopHistoryGestureView["phase"],
): boolean {
  return mounted.probe.views.some((view) => view?.phase === phase);
}

beforeEach(() => {
  trackpadClockSeconds = 0;
});

afterEach(() => {
  activeMounts.forEach((mounted) => mounted.uninstall());
  activeMounts = [];
  laterListenerCleanups.forEach((cleanup) => cleanup());
  laterListenerCleanups = [];
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.body.style.pointerEvents = "";
});

describe("committing on finger lift", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function expectCommitsOnLift(direction: DesktopHistoryDirection): void {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, direction, DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    expect(hasPhase(mounted, "ready")).toBe(true);

    // There is no pause-based commit and no pause-based cancel: resting
    // fingers - ticks stopped, no lift yet - hold the preview however long
    // they rest.
    vi.advanceTimersByTime(5_000);
    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("ready");

    mounted.signal("ended");
    expect(mounted.probe.navigations).toEqual([direction]);
    expect(mounted.probe.views.at(-1)).toMatchObject({
      phase: "committed",
      direction,
    });

    // Nothing later re-fires the same step.
    vi.advanceTimersByTime(
      DESKTOP_HISTORY_GESTURE.settleMs + DESKTOP_HISTORY_GESTURE.tailMs,
    );
    expect(mounted.probe.navigations).toEqual([direction]);
  }

  it("navigates back exactly once, only once the finger actually lifts", () => {
    expectCommitsOnLift("back");
  });

  it("navigates forward exactly once", () => {
    expectCommitsOnLift("forward");
  });

  it("cancels a slow drag lifted before it reaches the commit distance", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "forward", 90, document.body);
    expect(hasPhase(mounted, "ready")).toBe(false);

    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("cancels when the drag reverses back below commit after already reaching ready, once lifted", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    expect(hasPhase(mounted, "ready")).toBe(true);

    mounted.send("changed", {
      ...PLAIN_TICK,
      x: scrollingDeltaXToward("back", -100),
      t: trackpadClockSeconds + SLOW_STEP_SECONDS,
    });
    mounted.signal("ended");

    // Having been ready at some point along the way buys it nothing: only the
    // travel at lift decides.
    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("never commits on 'cancelled', even past the commit distance", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    expect(hasPhase(mounted, "ready")).toBe(true);

    mounted.signal("cancelled");

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("suppresses every wheel tick while the gesture owns the sequence, cancelable or not", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", 60, document.body);
    const later = listenAfterRecognizer();

    const cancelableTick = horizontalWheel(-6, document.body, true);
    const latchedTick = horizontalWheel(-6, document.body, false);

    expect(cancelableTick.defaultPrevented).toBe(true);
    expect(later.reached()).toBe(0);
    expect(latchedTick.defaultPrevented).toBe(false);
    expect(mounted.probe.views.at(-1)?.phase).toBe("pulling");
  });
});

describe("committed and canceling are final views", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("never follows a committed view with null, however long the tail runs", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");

    vi.advanceTimersByTime(
      2 * (DESKTOP_HISTORY_GESTURE.settleMs + DESKTOP_HISTORY_GESTURE.tailMs),
    );

    expect(mounted.probe.views.at(-1)?.phase).toBe("committed");
    expect(mounted.probe.views.includes(null)).toBe(false);
  });

  it("never follows a canceling view with null, however long the tail runs", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "forward", 60, document.body);
    mounted.signal("ended");

    vi.advanceTimersByTime(
      2 * (DESKTOP_HISTORY_GESTURE.settleMs + DESKTOP_HISTORY_GESTURE.tailMs),
    );

    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
    expect(mounted.probe.views.includes(null)).toBe(false);
  });
});

describe("the flick rule", () => {
  // Four 20 px ticks one frame apart: 80 px in under 64 ms.
  function flickWithTicksSeconds(
    mounted: MountedGesture,
    tickTimes: ReadonlyArray<number>,
  ): void {
    mounted.signal("began");
    horizontalWheel(deltaXToward("back", 20), document.body, true);
    for (const t of tickTimes)
      mounted.send("changed", { ...PLAIN_TICK, x: 20, t });
    mounted.signal("ended");
  }

  it("commits a short pull under the commit distance when it lifts fast", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    flickWithTicksSeconds(mounted, [1.0, 1.016, 1.032, 1.048]);

    expect(mounted.probe.navigations).toEqual(["back"]);
    expect(mounted.probe.views.at(-1)).toMatchObject({
      phase: "committed",
      direction: "back",
    });
  });

  it("cancels the same distance delivered slowly", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    flickWithTicksSeconds(mounted, [1.0, 1.333, 1.666, 2.0]);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("cancels a fast pull that travelled less than the flick minimum", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    flickWithTicksSeconds(mounted, [1.0, 1.016]);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });
});

describe("vertical and diagonal drags stay content", () => {
  it("leaves a vertical scroll to the page after canceling only its opening tick", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    mounted.signal("began");
    // The recognizer cannot tell this is a vertical scroll until the trackpad
    // stream says so: the opening tick is canceled up front, so a real scroll
    // loses only that sub-pixel tick.
    const opening = verticalWheel(0.8, document.body, true);
    mounted.send("changed", { ...PLAIN_TICK, y: 30 });
    const laterTick = verticalWheel(40, document.body, false);
    mounted.send("changed", { ...PLAIN_TICK, x: 200 });
    mounted.signal("ended");

    expect(opening.defaultPrevented).toBe(true);
    expect(laterTick.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });

  it("leaves a diagonal drag that is not primarily horizontal to the page", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    mounted.signal("began");
    horizontalWheel(-0.8, document.body, true);
    // 10px across, 15px down: the cross axis both clears the intent threshold
    // and leads the primary axis, so this reads as scroll.
    mounted.send("changed", { ...PLAIN_TICK, x: 10, y: 15 });
    mounted.send("changed", { ...PLAIN_TICK, x: 200 });
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });
});

// Chromium's wheel-scroll latching lets a page cancel only the FIRST wheel
// event of a scroll sequence; the recognizer cancels the opening tick up
// front whenever there is somewhere to navigate, and refuses to claim a
// sequence whose opening tick it could not cancel.
describe("Chromium wheel-scroll latching: the opening tick is canceled up front", () => {
  it("claims and commits a real trackpad sequence whose sub-pixel opening tick was canceled, even though its later DOM ticks arrive non-cancelable", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const target = document.body;

    // Deltas modeled on a captured trackpad swipe.
    mounted.signal("began");
    const firstTick = horizontalWheel(-0.8, target, true);
    mounted.send("changed", { ...PLAIN_TICK, x: 0.8 });
    horizontalWheel(-4.8, target, true);
    mounted.send("changed", { ...PLAIN_TICK, x: 4.8 });
    horizontalWheel(-8, target, true);
    mounted.send("changed", { ...PLAIN_TICK, x: 8 });
    for (const px of [12.8, 18.4, 65.6, 48.8, 42.4]) {
      horizontalWheel(-px, target, false);
      mounted.send("changed", { ...PLAIN_TICK, x: px });
    }

    expect(firstTick.defaultPrevented).toBe(true);
    expect(hasPhase(mounted, "pulling")).toBe(true);
    expect(hasPhase(mounted, "ready")).toBe(true);

    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  it("keeps the sequence content when its opening tick arrives uncancelable", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    mounted.signal("began");
    horizontalWheel(-0.8, document.body, false);
    mounted.send("changed", { ...PLAIN_TICK, x: ACTIVATION_PX });
    mounted.send("changed", { ...PLAIN_TICK, x: 200 });
    const laterTick = horizontalWheel(-40, document.body, true);
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
    expect(laterTick.defaultPrevented).toBe(false);
  });

  it("never claims a changed stream when no DOM wheel tick arrived after 'began'", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    // A tick from before this sequence: it names no element for THIS gesture.
    horizontalWheel(-0.8, document.body, true);
    mounted.signal("began");
    mounted.send("changed", { ...PLAIN_TICK, x: ACTIVATION_PX });
    mounted.send("changed", { ...PLAIN_TICK, x: 200 });
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });

  it("still claims the sequence when its opening tick arrived before 'began' and a second DOM tick follows it", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const before = horizontalWheel(-0.8, document.body, true);
    expect(before.defaultPrevented).toBe(true);

    mounted.signal("began");
    const after = horizontalWheel(-4.8, document.body, true);
    mounted.send("changed", { ...PLAIN_TICK, x: ACTIVATION_PX });
    mounted.send("changed", {
      ...PLAIN_TICK,
      x: DESKTOP_HISTORY_GESTURE.commitPx,
    });
    mounted.signal("ended");

    expect(after.defaultPrevented).toBe(true);
    expect(mounted.probe.navigations).toEqual(["back"]);
  });
});

describe("blocked from the start: modal layers, modifier keys, and line-mode wheels", () => {
  it("never claims the wheel while a modal layer covers the app", () => {
    document.body.style.pointerEvents = "none";
    const mounted = mountGesture(DEFAULT_MOUNT);
    const opening = pullTo(
      mounted,
      "back",
      DESKTOP_HISTORY_GESTURE.commitPx,
      document.body,
    );
    mounted.signal("ended");

    expect(opening.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });

  // Ownership is decided once, off the opening DOM tick. A ctrl+wheel zoom
  // that lifts the modifier mid-scroll (a real trackpad quirk) must not let
  // the rest of that same physical gesture re-arm into navigation.
  it("keeps a sequence content when its opening DOM tick carried a modifier, even after the modifier lifts", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    mounted.signal("began");
    const opening = dispatchWheel({
      deltaX: deltaXToward("back", ACTIVATION_PX),
      deltaY: 0,
      target: document.body,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: true,
    });
    mounted.send("changed", { ...PLAIN_TICK, x: ACTIVATION_PX });
    horizontalWheel(-40, document.body, true);
    mounted.send("changed", {
      ...PLAIN_TICK,
      x: DESKTOP_HISTORY_GESTURE.commitPx,
    });
    mounted.signal("ended");

    expect(opening.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });

  it("never claims a sequence whose trackpad events report a modifier", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    mounted.signal("began");
    horizontalWheel(-0.8, document.body, true);
    mounted.send("changed", { ...PLAIN_TICK, x: ACTIVATION_PX, modified: true });
    mounted.send("changed", { ...PLAIN_TICK, x: 200 });
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });

  it("does not cancel the first tick over a surface that already owns horizontal wheel", () => {
    const rail = document.createElement("div");
    rail.style.overflowX = "auto";
    document.body.appendChild(rail);
    Object.defineProperty(rail, "scrollWidth", {
      value: 600,
      configurable: true,
    });
    Object.defineProperty(rail, "clientWidth", {
      value: 300,
      configurable: true,
    });

    const mounted = mountGesture(DEFAULT_MOUNT);
    mounted.signal("began");
    const firstTick = horizontalWheel(
      deltaXToward("back", ACTIVATION_PX),
      rail,
      true,
    );

    expect(firstTick.defaultPrevented).toBe(false);
  });

  it("never claims a line-mode wheel sequence", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    mounted.signal("began");
    const opening = dispatchWheel({
      deltaX: deltaXToward("back", ACTIVATION_PX),
      deltaY: 0,
      target: document.body,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      ctrlKey: false,
    });
    mounted.send("changed", { ...PLAIN_TICK, x: ACTIVATION_PX });
    mounted.send("changed", { ...PLAIN_TICK, x: 200 });
    mounted.signal("ended");

    expect(opening.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });

  it("never navigates when the resolved destination is nothing", () => {
    const mounted = mountGesture({
      ...DEFAULT_MOUNT,
      destinationFor: () => null,
    });
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });

  // The latching guard cancels a sequence's opening tick only when there is
  // somewhere it could navigate; with nothing in either direction it has
  // nothing to protect, so the first tick must pass through uncanceled.
  it("does not cancel the first tick when neither direction has a destination", () => {
    const mounted = mountGesture({
      ...DEFAULT_MOUNT,
      destinationFor: () => null,
    });
    mounted.signal("began");
    const firstTick = horizontalWheel(
      deltaXToward("back", ACTIVATION_PX),
      document.body,
      true,
    );

    expect(firstTick.defaultPrevented).toBe(false);
  });
});

// The layer-blocking checks the recognizer defers to
// (desktopHistoryLayerBlocksNavigation) are exercised through the full
// recognizer rather than in isolation.
describe("route modals, nested dialogs, and explicit blocking claims", () => {
  interface LayerFixture {
    readonly role: string;
    readonly historySurface: "allowed" | "blocked" | undefined;
    readonly pointerEvents: "auto" | "none";
    readonly dataState: string | undefined;
  }

  const ALLOWED_ROUTE_LAYER: LayerFixture = {
    role: "dialog",
    historySurface: "allowed",
    pointerEvents: "auto",
    dataState: undefined,
  };

  function appendLayer(fixture: LayerFixture): HTMLElement {
    const layer = document.createElement("div");
    layer.setAttribute("role", fixture.role);
    if (fixture.historySurface !== undefined)
      layer.setAttribute("data-history-navigation-surface", fixture.historySurface);
    // `pointer-events` inherits, so a locked body would otherwise leak "none"
    // onto a plain child div. Real Radix Content sets its own pointer-events
    // explicitly to stay interactive under that same lock, so every fixture
    // layer states it too.
    layer.style.pointerEvents = fixture.pointerEvents;
    if (fixture.dataState !== undefined)
      layer.setAttribute("data-state", fixture.dataState);
    document.body.appendChild(layer);
    return layer;
  }

  function pullAndLift(
    direction: DesktopHistoryDirection,
  ): ReadonlyArray<DesktopHistoryDirection> {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, direction, DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");
    return mounted.probe.navigations;
  }

  it("allows back while a route-backed settings/history surface is the only layer open, even though it locks the body like an ordinary modal", () => {
    document.body.style.pointerEvents = "none"; // Radix's modal body lock
    appendLayer(ALLOWED_ROUTE_LAYER);
    expect(pullAndLift("back")).toEqual(["back"]);
  });

  it("allows forward while a route-backed settings/history surface is the only layer open", () => {
    document.body.style.pointerEvents = "none";
    appendLayer(ALLOWED_ROUTE_LAYER);
    expect(pullAndLift("forward")).toEqual(["forward"]);
  });

  it("blocks navigation while the route surface is explicitly marked blocked", () => {
    appendLayer({ ...ALLOWED_ROUTE_LAYER, historySurface: "blocked" });
    expect(pullAndLift("forward")).toEqual([]);
  });

  it("blocks navigation when a nested decision dialog sits above an allowed route surface", () => {
    appendLayer(ALLOWED_ROUTE_LAYER);
    appendLayer({
      ...ALLOWED_ROUTE_LAYER,
      role: "alertdialog",
      historySurface: undefined,
    });
    expect(pullAndLift("forward")).toEqual([]);
  });

  it("blocks navigation when a menu sits above an allowed route surface", () => {
    appendLayer(ALLOWED_ROUTE_LAYER);
    appendLayer({
      ...ALLOWED_ROUTE_LAYER,
      role: "menu",
      historySurface: undefined,
    });
    expect(pullAndLift("back")).toEqual([]);
  });

  it("blocks navigation when a nested modal menu disables pointer events on the allowed route surface underneath it", () => {
    appendLayer({ ...ALLOWED_ROUTE_LAYER, pointerEvents: "none" });
    expect(pullAndLift("back")).toEqual([]);
  });

  it("does not block navigation over an inline role=listbox that is not a popup", () => {
    const inline = document.createElement("div");
    inline.setAttribute("role", "listbox");
    document.body.appendChild(inline);
    expect(pullAndLift("back")).toEqual(["back"]);
  });

  it("blocks navigation while a real popup listbox (a shadcn Select's data-slot=select-content) is open", () => {
    const popup = document.createElement("div");
    popup.setAttribute("role", "listbox");
    popup.setAttribute("data-slot", "select-content");
    document.body.appendChild(popup);
    expect(pullAndLift("forward")).toEqual([]);
  });

  it("blocks navigation while a listbox popover sits inside a Radix popper content wrapper", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.appendChild(wrapper);
    const popup = document.createElement("div");
    popup.setAttribute("role", "listbox");
    wrapper.appendChild(popup);
    expect(pullAndLift("back")).toEqual([]);
  });

  it("ignores a closed/exiting dialog layer left in the DOM mid-animation", () => {
    document.body.style.pointerEvents = "none";
    appendLayer(ALLOWED_ROUTE_LAYER);
    appendLayer({
      ...ALLOWED_ROUTE_LAYER,
      historySurface: undefined,
      dataState: "closed", // Radix leaves this during its exit animation
    });
    expect(pullAndLift("forward")).toEqual(["forward"]);
  });

  it("blocks navigation via an explicit blocking-layer claim even with no dialog markup in the DOM, then allows it again once released", () => {
    const release = claimBlockingLayer();
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");
    expect(mounted.probe.navigations).toEqual([]);

    release();
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual(["back"]);
  });
});

describe("a stale origin, destination, or blocking layer refuses the commit even past the threshold", () => {
  it("refuses to commit when the origin route changed mid-gesture", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    // No further trackpad tick observes the change - this pins the re-check
    // the lift itself performs before committing.
    mounted.setCurrentEntry("/somewhere-else");

    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("refuses to commit when the resolved destination changed mid-gesture", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "forward", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.setDestination(() => "/a-different-target");

    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("refuses to commit when a blocking layer appears mid-gesture with no further tick to observe it", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    document.body.style.pointerEvents = "none"; // a modal opens mid-drag

    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });
});

describe("a modal or a route change discovered mid-gesture still drains its tail", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("cancels and keeps draining when a modal covers the app mid-gesture", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", 60, document.body); // live navigation, still pulling

    document.body.style.pointerEvents = "none"; // a modal opens mid-drag
    mounted.send("changed", { ...PLAIN_TICK, x: 10 });

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");

    // Settling on discovery leaves the sequence draining: a trailing wheel
    // right after is still consumed like any other tail, and a lift does not
    // commit it.
    const trailing = horizontalWheel(-20, document.body, true);
    mounted.signal("ended");
    expect(trailing.defaultPrevented).toBe(true);
    expect(mounted.probe.navigations).toEqual([]);

    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.tailMs);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("cancels and keeps draining when the origin route changes mid-gesture", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "forward", 60, document.body);

    mounted.setCurrentEntry("/somewhere-else");
    mounted.send("changed", { ...PLAIN_TICK, x: -10 });

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");

    const trailing = horizontalWheel(20, document.body, true);
    expect(trailing.defaultPrevented).toBe(true);

    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.tailMs);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });
});

describe("blur, Escape, and pointerdown cancel a live gesture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("cancels an in-progress navigation on window blur and still drains a trailing wheel", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", 60, document.body);

    window.dispatchEvent(new Event("blur"));

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");

    // Momentum right after an OS-level cancel is still the same physical
    // gesture: consumed like any other draining tail, never a fresh sequence.
    const trailing = horizontalWheel(-20, document.body, true);
    expect(trailing.defaultPrevented).toBe(true);
    expect(mounted.probe.navigations).toEqual([]);

    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.tailMs);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("cancels an in-progress navigation on Escape", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "forward", 60, document.body);

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("stops Escape from reaching the route modal's own dismiss handler while a gesture is actively navigating", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "forward", 60, document.body);

    // Registered after the recognizer's own keydown listener, the same order a
    // route modal's dismissable-layer handler mounts in relative to the
    // document-level recognizer installed near the app root.
    const modalEscapeHandler = vi.fn();
    document.addEventListener("keydown", modalEscapeHandler);

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(modalEscapeHandler).not.toHaveBeenCalled();
    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");

    document.removeEventListener("keydown", modalEscapeHandler);
  });

  it("leaves Escape to the route modal's own dismiss handler when no gesture is active", () => {
    mountGesture(DEFAULT_MOUNT); // nothing driven - no sequence

    const modalEscapeHandler = vi.fn();
    document.addEventListener("keydown", modalEscapeHandler);

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(modalEscapeHandler).toHaveBeenCalledTimes(1);

    document.removeEventListener("keydown", modalEscapeHandler);
  });

  it("drops a not-yet-activated gesture on pointerdown, leaving the next gesture unaffected", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    mounted.signal("began");
    horizontalWheel(-5, document.body, true);
    mounted.send("changed", { ...PLAIN_TICK, x: 5 }); // under the intent threshold

    document.dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    );
    // The dropped sequence must not wake up and activate on later ticks.
    mounted.send("changed", { ...PLAIN_TICK, x: 200 });
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);

    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual(["back"]);
  });
});

describe("the momentum tail after a lift", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function commitBack(mounted: MountedGesture): void {
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");
    expect(mounted.probe.navigations).toEqual(["back"]);
  }

  it("does not navigate twice while momentum drains after a commit", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    commitBack(mounted);

    mounted.signal("momentum-began");
    for (const px of [60, 30, 10]) {
      vi.advanceTimersByTime(50);
      horizontalWheel(-px, document.body, true);
      mounted.send("momentum-changed", { ...PLAIN_TICK, x: px });
    }
    mounted.signal("momentum-ended");

    vi.advanceTimersByTime(
      DESKTOP_HISTORY_GESTURE.tailMs + DESKTOP_HISTORY_GESTURE.settleMs,
    );
    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  it("consumes horizontal momentum ticks - preventDefault and stops propagation to later listeners - after a committed lift", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    commitBack(mounted);
    const later = listenAfterRecognizer();

    const momentumTick = horizontalWheel(-6, document.body, true);

    expect(momentumTick.defaultPrevented).toBe(true);
    expect(later.reached()).toBe(0);
  });

  it("resets on 'momentum-ended' so the next sequence is no longer swallowed, and renders nothing", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    commitBack(mounted);
    const viewsBefore = mounted.probe.views.length;
    const later = listenAfterRecognizer();

    horizontalWheel(-6, document.body, false); // consumed: reaches no one
    expect(later.reached()).toBe(0);
    mounted.signal("momentum-ended");
    horizontalWheel(-6, document.body, false); // no tail left to swallow it

    expect(later.reached()).toBe(1);
    expect(mounted.probe.views.length).toBe(viewsBefore);
  });

  it("ignores 'momentum-began' except that the tail now waits for momentum instead of silence", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    commitBack(mounted);
    const viewsBefore = mounted.probe.views.length;
    const later = listenAfterRecognizer();

    mounted.signal("momentum-began");
    expect(mounted.probe.views.length).toBe(viewsBefore);

    // Far longer than the silence window: only momentum-ended may end it.
    vi.advanceTimersByTime(5 * DESKTOP_HISTORY_GESTURE.tailMs);
    horizontalWheel(-6, document.body, false);

    expect(later.reached()).toBe(0);
    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  it("ends the tail on silence when the lift brings no momentum", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    commitBack(mounted);
    const later = listenAfterRecognizer();

    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.tailMs);
    horizontalWheel(-6, document.body, false);

    expect(later.reached()).toBe(1);
  });

  it("does not consume momentum after a content scroll's lift, and opens no gesture from it", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    mounted.signal("began");
    verticalWheel(30, document.body, true);
    mounted.send("changed", { ...PLAIN_TICK, y: 30 });
    mounted.signal("ended");

    // Content's own momentum is left alone - the recognizer never claims it.
    const momentumTick = horizontalWheel(-ACTIVATION_PX, document.body, true);
    expect(momentumTick.defaultPrevented).toBe(false);

    // Momentum carries no `began`, so its deltas open nothing.
    mounted.send("momentum-changed", {
      ...PLAIN_TICK,
      x: DESKTOP_HISTORY_GESTURE.commitPx,
    });
    mounted.send("changed", { ...PLAIN_TICK, x: 200 });
    mounted.signal("ended");
    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);

    // Fresh fingers open a normal gesture.
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");
    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  // The drain tail's consume check is axis- and modifier-aware: it must not
  // swallow input the momentum wheel events merely happen to interleave with.
  it("does not consume a vertical wheel event during the drain tail", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    commitBack(mounted);

    const verticalDuringDrain = verticalWheel(40, document.body, true);

    expect(verticalDuringDrain.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  it("does not consume a modified (pinch-zoom) wheel event during the drain tail", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "forward", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");
    expect(mounted.probe.navigations).toEqual(["forward"]);

    const zoomDuringDrain = dispatchWheel({
      deltaX: 40,
      deltaY: 0,
      target: document.body,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: true,
    });

    expect(zoomDuringDrain.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual(["forward"]);
  });
});

describe("rapid repeat and fresh fingers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("commits twice for two back-to-back pulls, the second starting from its own travel", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");
    const viewsAfterFirst = mounted.probe.views.length;

    // No timer advance: the first sequence is still draining.
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual(["back", "back"]);
    const secondPullViews = mounted.probe.views.slice(viewsAfterFirst);
    expect(secondPullViews[0]).toMatchObject({
      direction: "back",
      phase: "pulling",
    });
    expect(secondPullViews[0]?.progress).toBeCloseTo(
      ACTIVATION_PX / DESKTOP_HISTORY_GESTURE.commitPx,
    );
  });

  it("ends a draining tail on 'began', so the next sequence is no longer swallowed", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");
    expect(mounted.probe.views.at(-1)?.phase).toBe("committed");
    const later = listenAfterRecognizer();

    mounted.signal("began");
    horizontalWheel(-6, document.body, false);

    expect(later.reached()).toBe(1);
    expect(mounted.probe.views.at(-1)?.phase).toBe("committed");
  });

  it("treats 'began' mid-pull as fresh fingers: the live pull is canceled, not continued", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", 60, document.body);

    mounted.signal("began");

    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
    expect(mounted.probe.navigations).toEqual([]);

    // The old pull's travel is gone: a lift now has nothing to commit.
    mounted.signal("ended");
    expect(mounted.probe.navigations).toEqual([]);

    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");
    expect(mounted.probe.navigations).toEqual(["back"]);
  });
});

it("disposes the trackpad subscription on uninstall", () => {
  const mounted = mountGesture(DEFAULT_MOUNT);
  expect(mounted.trackpad.isDisposed()).toBe(false);

  mounted.uninstall();

  expect(mounted.trackpad.isDisposed()).toBe(true);
});

describe("uninstall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("during the momentum tail after a commit stops the drain", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.signal("ended");
    expect(mounted.probe.navigations).toEqual(["back"]);

    mounted.uninstall();

    // With the listeners removed, a trailing momentum wheel event is no longer
    // consumed and the tail cannot re-arm.
    const trailing = horizontalWheel(-20, document.body, true);
    expect(trailing.defaultPrevented).toBe(false);

    vi.advanceTimersByTime(
      DESKTOP_HISTORY_GESTURE.tailMs + DESKTOP_HISTORY_GESTURE.settleMs,
    );
    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  it("cancels an in-flight pull and removes every listener", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, "back", 60, document.body);
    expect(mounted.probe.views.at(-1)?.phase).toBe("pulling");

    mounted.uninstall();
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");

    const viewsAfterCleanup = mounted.probe.views.length;
    const navigationsAfterCleanup = mounted.probe.navigations.length;

    const afterTick = horizontalWheel(-200, document.body, true);
    document.dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    window.dispatchEvent(new Event("blur"));
    mounted.signal("ended");
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.tailMs);

    expect(afterTick.defaultPrevented).toBe(false);
    expect(mounted.probe.views.length).toBe(viewsAfterCleanup);
    expect(mounted.probe.navigations.length).toBe(navigationsAfterCleanup);
  });
});

describe("ownsDesktopHorizontalWheel", () => {
  function stubScrollWidth(
    el: HTMLElement,
    metrics: { readonly scrollWidth: number; readonly clientWidth: number },
  ): void {
    Object.defineProperty(el, "scrollWidth", {
      value: metrics.scrollWidth,
      configurable: true,
    });
    Object.defineProperty(el, "clientWidth", {
      value: metrics.clientWidth,
      configurable: true,
    });
  }

  it("owns a horizontally-overflowing surface regardless of which edge it is scrolled to", () => {
    const rail = document.createElement("div");
    rail.style.overflowX = "auto";
    document.body.appendChild(rail);
    stubScrollWidth(rail, { scrollWidth: 600, clientWidth: 300 });

    rail.scrollLeft = 0;
    expect(ownsDesktopHorizontalWheel(rail)).toBe(true);
    rail.scrollLeft = 300;
    expect(ownsDesktopHorizontalWheel(rail)).toBe(true);
  });

  it("does not own a tab strip that declares touch-pan-x but has nothing to scroll", () => {
    const strip = document.createElement("div");
    strip.style.touchAction = "pan-x";
    strip.style.overflowX = "auto";
    document.body.appendChild(strip);
    stubScrollWidth(strip, { scrollWidth: 300, clientWidth: 300 });

    expect(ownsDesktopHorizontalWheel(strip)).toBe(false);
  });

  it("does not own a terminal surface that only declares touch-action: none", () => {
    const terminal = document.createElement("div");
    terminal.className = "xterm terminal";
    terminal.style.touchAction = "none";
    document.body.appendChild(terminal);

    expect(ownsDesktopHorizontalWheel(terminal)).toBe(false);
  });

  it("owns an explicitly-registered gesture surface via the selector allowlist", () => {
    const owner = document.createElement("div");
    owner.setAttribute("data-history-gesture-owner", "");
    document.body.appendChild(owner);

    expect(ownsDesktopHorizontalWheel(owner)).toBe(true);
  });
});

describe("wheel ownership decides who gets the whole sequence", () => {
  function appendRail(metrics: {
    readonly className: string;
    readonly scrollWidth: number | undefined;
    readonly clientWidth: number | undefined;
    readonly touchAction: string | undefined;
  }): HTMLElement {
    const rail = document.createElement("div");
    rail.className = metrics.className;
    if (metrics.touchAction !== undefined)
      rail.style.touchAction = metrics.touchAction;
    if (metrics.scrollWidth !== undefined) {
      rail.style.overflowX = "auto";
      Object.defineProperty(rail, "scrollWidth", {
        value: metrics.scrollWidth,
        configurable: true,
      });
      Object.defineProperty(rail, "clientWidth", {
        value: metrics.clientWidth,
        configurable: true,
      });
    }
    document.body.appendChild(rail);
    return rail;
  }

  function pullOver(
    target: Element,
    direction: DesktopHistoryDirection,
  ): MountedGesture {
    const mounted = mountGesture(DEFAULT_MOUNT);
    pullTo(mounted, direction, DESKTOP_HISTORY_GESTURE.commitPx, target);
    mounted.signal("ended");
    return mounted;
  }

  it("leaves an overflowing surface's sequence to content scroll entirely", () => {
    const rail = appendRail({
      className: "",
      scrollWidth: 600,
      clientWidth: 300,
      touchAction: undefined,
    });
    const mounted = pullOver(rail, "back");

    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });

  it("still claims the sequence over a non-overflowing tab strip that merely declares touch-pan-x", () => {
    const strip = appendRail({
      className: "",
      scrollWidth: undefined,
      clientWidth: undefined,
      touchAction: "pan-x",
    });
    expect(pullOver(strip, "forward").probe.navigations).toEqual(["forward"]);
  });

  it("still claims the sequence over a terminal surface with touch-action: none", () => {
    const terminal = appendRail({
      className: "xterm terminal",
      scrollWidth: undefined,
      clientWidth: undefined,
      touchAction: "none",
    });
    expect(pullOver(terminal, "back").probe.navigations).toEqual(["back"]);
  });

  // Content that fits exactly has nothing to scroll, so it must not suppress
  // navigation - including a terminal, which renders inside a scrollable
  // container whether or not its content currently overflows it.
  it("still claims the sequence over a terminal container whose content currently fits", () => {
    const terminal = appendRail({
      className: "xterm terminal",
      scrollWidth: 300,
      clientWidth: 300,
      touchAction: undefined,
    });
    expect(pullOver(terminal, "forward").probe.navigations).toEqual([
      "forward",
    ]);
  });

  // A 1px rounding overflow still reads as fitting.
  it("still claims the sequence over a surface only 1px over its client width", () => {
    const rail = appendRail({
      className: "",
      scrollWidth: 301,
      clientWidth: 300,
      touchAction: undefined,
    });
    expect(pullOver(rail, "back").probe.navigations).toEqual(["back"]);
  });
});

// Ownership reads `event.composedPath()[0] ?? event.target` off the latest
// DOM tick rather than `event.target` alone. Outside an open shadow root,
// `event.target` is retargeted to the shadow HOST, which would otherwise hide
// the real horizontally-scrollable element inside it (a diff viewer, for
// example) from ownsDesktopHorizontalWheel. `horizontalWheel` dispatches on the
// real, attached target with `composed: true`, so pointing it at the
// shadow-root inner element exercises the DOM's own retargeting.
describe("wheel events originating inside an open shadow root", () => {
  function buildShadowScroller(options: {
    readonly overflow: boolean;
    readonly ownerHost: boolean;
  }): HTMLElement {
    const host = document.createElement("div");
    if (options.ownerHost)
      host.setAttribute("data-history-gesture-owner", "");
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    inner.style.overflowX = "auto";
    shadowRoot.appendChild(inner);
    Object.defineProperty(inner, "scrollWidth", {
      value: options.overflow ? 600 : 300,
      configurable: true,
    });
    Object.defineProperty(inner, "clientWidth", {
      value: 300,
      configurable: true,
    });
    return inner;
  }

  it("keeps a horizontally-overflowing scroller inside a shadow root owned by content, reading the real innermost element rather than the retargeted host", () => {
    const inner = buildShadowScroller({ overflow: true, ownerHost: false });
    const mounted = mountGesture(DEFAULT_MOUNT);

    const opening = pullTo(
      mounted,
      "back",
      DESKTOP_HISTORY_GESTURE.commitPx,
      inner,
    );
    mounted.signal("ended");

    expect(opening.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });

  it("allows navigation over a shadow-root inner container that currently fits with nothing to scroll", () => {
    const inner = buildShadowScroller({ overflow: false, ownerHost: false });
    const mounted = mountGesture(DEFAULT_MOUNT);

    pullTo(mounted, "forward", DESKTOP_HISTORY_GESTURE.commitPx, inner);
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual(["forward"]);
  });

  it("still owns the sequence when the gesture-owner marker sits on the shadow host, crossed from the inner target via getRootNode()", () => {
    const inner = buildShadowScroller({ overflow: false, ownerHost: true });
    const mounted = mountGesture(DEFAULT_MOUNT);

    pullTo(mounted, "back", DESKTOP_HISTORY_GESTURE.commitPx, inner);
    mounted.signal("ended");

    expect(mounted.probe.navigations).toEqual([]);
    expect(hasRenderedView(mounted)).toBe(false);
  });
});
