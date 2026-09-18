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

function horizontalWheel(deltaX: number, target: Element): WheelEvent {
  return dispatchWheel({
    deltaX,
    deltaY: 0,
    target,
    cancelable: true,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    ctrlKey: false,
  });
}

/** Positive travels toward `direction`; negative reverses back toward zero. */
function deltaXToward(
  direction: DesktopHistoryDirection,
  magnitudePx: number,
): number {
  return direction === "back" ? -magnitudePx : magnitudePx;
}

/** Comfortably past the 12px intent threshold, so the first event alone activates. */
const ACTIVATION_PX = DESKTOP_HISTORY_GESTURE.intentPx + 8;

/**
 * Drives a sequence from nothing to exactly `totalTravelPx` of committed
 * travel: one event to activate, one to add the remainder. Both events carry
 * pure horizontal deltas, so vertical/diagonal recognition is exercised by
 * its own tests rather than through this helper.
 */
function driveToTravel(
  direction: DesktopHistoryDirection,
  totalTravelPx: number,
  target: Element,
): void {
  horizontalWheel(deltaXToward(direction, ACTIVATION_PX), target);
  const remaining = totalTravelPx - ACTIVATION_PX;
  if (remaining !== 0)
    horizontalWheel(deltaXToward(direction, remaining), target);
}

interface GestureProbe {
  readonly views: ReadonlyArray<DesktopHistoryGestureView | null>;
  readonly navigations: ReadonlyArray<DesktopHistoryDirection>;
}

interface MountedGesture {
  readonly probe: GestureProbe;
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

function mountGesture(options: MountGestureOptions): MountedGesture {
  const views: Array<DesktopHistoryGestureView | null> = [];
  const navigations: DesktopHistoryDirection[] = [];
  let currentEntry = options.currentEntry;
  let destinationFor = options.destinationFor;
  const uninstall = installDesktopHistoryGesture({
    currentEntry: () => currentEntry,
    destination: (direction) => destinationFor(direction),
    navigate: (direction) => {
      navigations.push(direction);
    },
    render: (view) => {
      views.push(view);
    },
  });
  const mounted: MountedGesture = {
    probe: { views, navigations },
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  activeMounts.forEach((mounted) => mounted.uninstall());
  activeMounts = [];
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.body.style.pointerEvents = "";
});

describe("committing after an input pause", () => {
  function expectCommitsOnce(direction: DesktopHistoryDirection): void {
    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel(direction, DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    expect(mounted.probe.views.some((view) => view?.phase === "ready")).toBe(
      true,
    );

    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);
    expect(mounted.probe.navigations).toEqual([direction]);
    expect(
      mounted.probe.views.some(
        (view) => view?.phase === "committed" && view.direction === direction,
      ),
    ).toBe(true);

    // Nothing later re-fires the same step.
    vi.advanceTimersByTime(
      DESKTOP_HISTORY_GESTURE.tailMs + DESKTOP_HISTORY_GESTURE.settleMs,
    );
    expect(mounted.probe.navigations).toEqual([direction]);
  }

  it("navigates back exactly once, wheel has no native release event to key off", () => {
    expectCommitsOnce("back");
  });

  it("navigates forward exactly once", () => {
    expectCommitsOnce("forward");
  });
});

it("cancels a drag released before it reaches the commit distance", () => {
  const mounted = mountGesture(DEFAULT_MOUNT);
  driveToTravel("forward", 90, document.body);
  expect(mounted.probe.views.some((view) => view?.phase === "ready")).toBe(
    false,
  );

  vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

  expect(mounted.probe.navigations).toEqual([]);
  expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
});

it("cancels when the drag reverses back below commit after already reaching ready", () => {
  const mounted = mountGesture(DEFAULT_MOUNT);
  const target = document.body;
  horizontalWheel(deltaXToward("back", ACTIVATION_PX), target); // travel 20
  horizontalWheel(
    deltaXToward("back", DESKTOP_HISTORY_GESTURE.commitPx - ACTIVATION_PX),
    target,
  ); // travel 180 - ready
  expect(mounted.probe.views.some((view) => view?.phase === "ready")).toBe(
    true,
  );

  horizontalWheel(deltaXToward("back", -100), target); // travel back down to 80
  vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

  // Having been ready at some point along the way buys it nothing: only the
  // travel at release decides.
  expect(mounted.probe.navigations).toEqual([]);
  expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
});

describe("vertical and diagonal drags stay content", () => {
  it("leaves a pure vertical wheel to the page", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const event = dispatchWheel({
      deltaX: 0,
      deltaY: 30,
      target: document.body,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: false,
    });
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(event.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.some((view) => view !== null)).toBe(false);
  });

  it("leaves a diagonal drag that is not primarily horizontal to the page", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    // 10px across, 15px down: the cross axis (y) both clears the intent
    // threshold and leads the primary axis, so this reads as scroll.
    const event = dispatchWheel({
      deltaX: 10,
      deltaY: 15,
      target: document.body,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: false,
    });
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(event.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
  });
});

describe("blocked from the start: modal layers, modifier keys, and line-mode wheels", () => {
  afterEach(() => {
    document.body.style.pointerEvents = "";
  });

  it("never claims the wheel while a modal layer covers the app", () => {
    document.body.style.pointerEvents = "none";
    const mounted = mountGesture(DEFAULT_MOUNT);
    const event = horizontalWheel(
      deltaXToward("back", ACTIVATION_PX),
      document.body,
    );
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(event.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.some((view) => view !== null)).toBe(false);
  });

  it("never claims the wheel while a modifier key is held", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const event = dispatchWheel({
      deltaX: deltaXToward("back", ACTIVATION_PX),
      deltaY: 0,
      target: document.body,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: true,
    });
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(event.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
  });

  it("never claims a line-mode wheel event", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const event = dispatchWheel({
      deltaX: deltaXToward("back", ACTIVATION_PX),
      deltaY: 0,
      target: document.body,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      ctrlKey: false,
    });
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(event.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual([]);
  });

  it("never navigates when the resolved destination is nothing", () => {
    const mounted = mountGesture({
      ...DEFAULT_MOUNT,
      destinationFor: () => null,
    });
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.some((view) => view !== null)).toBe(false);
  });

  // Ownership is decided once, off the FIRST event of a sequence. A ctrl+wheel
  // zoom that lifts the modifier mid-scroll (a real trackpad quirk) must not
  // let the rest of that same physical gesture re-arm into navigation.
  it("keeps a modifier-blocked sequence content even after the modifier lifts mid-stream", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const target = document.body;
    dispatchWheel({
      deltaX: deltaXToward("back", ACTIVATION_PX),
      deltaY: 0,
      target,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: true,
    });
    horizontalWheel(
      deltaXToward("back", DESKTOP_HISTORY_GESTURE.commitPx - ACTIVATION_PX),
      target,
    );
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.some((view) => view !== null)).toBe(false);
  });
});

// The layer-blocking checks the recognizer defers to (desktop-history-gesture-ownership.ts's
// desktopHistoryLayerBlocksNavigation) are exercised here through the full
// recognizer rather than in isolation, since it is only ever consulted from
// inside blocksNavigation().
describe("route modals, nested dialogs, and explicit blocking claims", () => {
  afterEach(() => {
    document.body.style.pointerEvents = "";
  });

  function appendLayer(options: {
    readonly role: string;
    readonly historySurface?: "allowed" | "blocked";
    readonly pointerEvents?: "auto" | "none";
    readonly dataState?: string;
  }): HTMLElement {
    const layer = document.createElement("div");
    layer.setAttribute("role", options.role);
    if (options.historySurface !== undefined)
      layer.setAttribute(
        "data-history-navigation-surface",
        options.historySurface,
      );
    // `pointer-events` inherits, so a locked body would otherwise leak "none"
    // onto a plain child div. Real Radix Content sets its own pointer-events
    // explicitly to stay interactive under that same lock - default every
    // fixture layer to that same explicit "auto" so it models the real DOM
    // instead of a bare div that happens to inherit the wrong value.
    layer.style.pointerEvents = options.pointerEvents ?? "auto";
    if (options.dataState !== undefined)
      layer.setAttribute("data-state", options.dataState);
    document.body.appendChild(layer);
    return layer;
  }

  function expectRouteBackedModalAllows(
    direction: DesktopHistoryDirection,
  ): void {
    document.body.style.pointerEvents = "none"; // Radix's modal body lock
    appendLayer({ role: "dialog", historySurface: "allowed" });

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel(direction, DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([direction]);
  }

  it("allows back while a route-backed settings/history surface is the only layer open, even though it locks the body like an ordinary modal", () => {
    expectRouteBackedModalAllows("back");
  });

  it("allows forward while a route-backed settings/history surface is the only layer open, even though it locks the body like an ordinary modal", () => {
    expectRouteBackedModalAllows("forward");
  });

  it("blocks navigation while the route surface is explicitly marked blocked, as SystemTabModalSurface does while the theme editor is open", () => {
    appendLayer({ role: "dialog", historySurface: "blocked" });

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("forward", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
  });

  it("blocks navigation when a nested decision dialog sits above an allowed route surface", () => {
    appendLayer({ role: "dialog", historySurface: "allowed" }); // the Settings modal
    appendLayer({ role: "alertdialog" }); // an unmarked confirm dialog stacked on top

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("forward", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
  });

  it("blocks navigation when a menu sits above an allowed route surface", () => {
    appendLayer({ role: "dialog", historySurface: "allowed" });
    appendLayer({ role: "menu" });

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
  });

  it("blocks navigation when a nested modal menu disables pointer events on the allowed route surface underneath it", () => {
    appendLayer({
      role: "dialog",
      historySurface: "allowed",
      pointerEvents: "none",
    });

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
  });

  it("does not block navigation over an inline role=listbox (search results, a combobox's own results list) that is not a popup", () => {
    const inline = document.createElement("div");
    inline.setAttribute("role", "listbox");
    document.body.appendChild(inline);

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  it("blocks navigation while a real popup listbox (a shadcn Select's data-slot=select-content) is open", () => {
    const popup = document.createElement("div");
    popup.setAttribute("role", "listbox");
    popup.setAttribute("data-slot", "select-content");
    document.body.appendChild(popup);

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("forward", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
  });

  it("blocks navigation while a listbox popover sits inside a Radix popper content wrapper", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.appendChild(wrapper);
    const popup = document.createElement("div");
    popup.setAttribute("role", "listbox");
    wrapper.appendChild(popup);

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
  });

  it("ignores a closed/exiting dialog layer left in the DOM mid-animation", () => {
    document.body.style.pointerEvents = "none";
    appendLayer({ role: "dialog", historySurface: "allowed" });
    appendLayer({ role: "dialog", dataState: "closed" }); // Radix leaves this during its exit animation

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("forward", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual(["forward"]);
  });

  it("blocks navigation via an explicit blocking-layer claim even with no dialog markup in the DOM, then allows it again once released", () => {
    const release = claimBlockingLayer();
    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);
    expect(mounted.probe.navigations).toEqual([]);

    release();
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual(["back"]);
  });
});

describe("a stale origin or destination blocks the commit even past the threshold", () => {
  it("refuses to commit when the origin route changed mid-gesture", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    // No further wheel event observes the change - this pins the re-check
    // `finish()` itself performs before committing, distinct from the
    // inline check a later wheel event would trigger.
    mounted.setCurrentEntry("/somewhere-else");

    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });

  it("refuses to commit when the resolved destination changed mid-gesture", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("forward", DESKTOP_HISTORY_GESTURE.commitPx, document.body);
    mounted.setDestination(() => "/a-different-target");

    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");
  });
});

describe("a modal or a route change discovered mid-gesture still drains its tail", () => {
  it("cancels and keeps draining when a modal covers the app mid-gesture", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const target = document.body;
    driveToTravel("back", 60, target); // live navigation, still pulling

    document.body.style.pointerEvents = "none"; // a modal opens mid-drag
    horizontalWheel(deltaXToward("back", 10), target);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");

    // The fix under test: settling on discovery must leave ownership at
    // "draining", not fall through and stomp it back to plain "content" -
    // a trailing wheel right after is still consumed like any other tail.
    const trailing = horizontalWheel(deltaXToward("back", 20), target);
    expect(trailing.defaultPrevented).toBe(true);
    expect(mounted.probe.navigations).toEqual([]);

    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.tailMs);
    expect(mounted.probe.views.at(-1)).toBeNull();
  });

  it("cancels and keeps draining when the origin route changes mid-gesture", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const target = document.body;
    driveToTravel("forward", 60, target);

    mounted.setCurrentEntry("/somewhere-else");
    horizontalWheel(deltaXToward("forward", 10), target);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");

    const trailing = horizontalWheel(deltaXToward("forward", 20), target);
    expect(trailing.defaultPrevented).toBe(true);

    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.tailMs);
    expect(mounted.probe.views.at(-1)).toBeNull();
  });
});

describe("blur, Escape, and pointerdown cancel a live gesture", () => {
  it("cancels an in-progress navigation on window blur and still drains a trailing wheel", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const target = document.body;
    driveToTravel("back", 60, target);

    window.dispatchEvent(new Event("blur"));

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.at(-1)?.phase).toBe("canceling");

    // Momentum right after an OS-level cancel is still the same physical
    // gesture: consumed like any other draining tail, never a fresh sequence.
    const trailing = horizontalWheel(deltaXToward("back", 20), target);
    expect(trailing.defaultPrevented).toBe(true);
    expect(mounted.probe.navigations).toEqual([]);

    vi.advanceTimersByTime(
      DESKTOP_HISTORY_GESTURE.releaseMs + DESKTOP_HISTORY_GESTURE.tailMs,
    );
    expect(mounted.probe.views.at(-1)).toBeNull();
  });

  it("cancels an in-progress navigation on Escape", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("forward", 60, document.body);

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
    driveToTravel("forward", 60, document.body);

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
    mountGesture(DEFAULT_MOUNT); // no wheel driven - sequence stays null

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
    const target = document.body;
    horizontalWheel(deltaXToward("back", 5), target); // under the intent threshold

    document.dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    );

    expect(mounted.probe.navigations).toEqual([]);

    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, target);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual(["back"]);
  });
});

describe("the momentum tail after a commit", () => {
  it("does not navigate twice while trailing wheel events drain", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const target = document.body;
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, target);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);
    expect(mounted.probe.navigations).toEqual(["back"]);

    // Decaying trackpad momentum after the commit: still consumed, never a
    // second navigation.
    vi.advanceTimersByTime(50);
    horizontalWheel(deltaXToward("back", 6), target);
    vi.advanceTimersByTime(50);
    horizontalWheel(deltaXToward("back", 3), target);
    vi.advanceTimersByTime(50);
    horizontalWheel(deltaXToward("back", 1), target);
    expect(mounted.probe.navigations).toEqual(["back"]);

    vi.advanceTimersByTime(
      DESKTOP_HISTORY_GESTURE.tailMs + DESKTOP_HISTORY_GESTURE.settleMs,
    );
    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  // The drain tail's own consume check is axis- and modifier-aware: it must
  // not swallow input the momentum wheel events merely happen to interleave
  // with.
  it("does not consume a vertical wheel event during the drain tail", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const target = document.body;
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, target);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);
    expect(mounted.probe.navigations).toEqual(["back"]);

    const verticalDuringDrain = dispatchWheel({
      deltaX: 0,
      deltaY: 40,
      target,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: false,
    });

    expect(verticalDuringDrain.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  it("does not consume a modified (pinch-zoom) wheel event during the drain tail", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const target = document.body;
    driveToTravel("forward", DESKTOP_HISTORY_GESTURE.commitPx, target);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);
    expect(mounted.probe.navigations).toEqual(["forward"]);

    const zoomDuringDrain = dispatchWheel({
      deltaX: 40,
      deltaY: 0,
      target,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      ctrlKey: true,
    });

    expect(zoomDuringDrain.defaultPrevented).toBe(false);
    expect(mounted.probe.navigations).toEqual(["forward"]);
  });

  it("keeps draining through a tail longer than the quiet window as long as new wheel events keep arriving just inside it", () => {
    const mounted = mountGesture(DEFAULT_MOUNT);
    const target = document.body;
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, target);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);
    expect(mounted.probe.navigations).toEqual(["back"]);

    // Cumulative elapsed time across this loop is several multiples of
    // tailMs, but the gap between any two consecutive events never reaches
    // it - so the tail must never go quiet and reset() must never fire.
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.tailMs - 20);
      const trailing = horizontalWheel(deltaXToward("back", 2), target);
      expect(trailing.defaultPrevented).toBe(true);
    }
    expect(mounted.probe.navigations).toEqual(["back"]);

    // Now let an actual quiet gap pass.
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.tailMs);
    expect(mounted.probe.views.at(-1)).toBeNull();
    expect(mounted.probe.navigations).toEqual(["back"]);
  });
});

it("cleanup during the momentum tail after a commit stops the drain and clears the in-flight state", () => {
  const mounted = mountGesture(DEFAULT_MOUNT);
  const target = document.body;
  driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, target);
  vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);
  expect(mounted.probe.navigations).toEqual(["back"]);

  mounted.uninstall();
  expect(mounted.probe.views.at(-1)).toBeNull();

  // With the listeners removed, a trailing momentum wheel event is no longer
  // consumed and the tail cannot re-arm.
  const trailing = horizontalWheel(deltaXToward("back", 20), target);
  expect(trailing.defaultPrevented).toBe(false);

  vi.advanceTimersByTime(
    DESKTOP_HISTORY_GESTURE.tailMs + DESKTOP_HISTORY_GESTURE.settleMs,
  );
  expect(mounted.probe.navigations).toEqual(["back"]);
});

it("cleanup removes every listener and clears an in-flight gesture", () => {
  const mounted = mountGesture(DEFAULT_MOUNT);
  const target = document.body;
  driveToTravel("back", 60, target);
  expect(mounted.probe.views.at(-1)).not.toBeNull();

  mounted.uninstall();
  expect(mounted.probe.views.at(-1)).toBeNull();

  const viewsAfterCleanup = mounted.probe.views.length;
  const navigationsAfterCleanup = mounted.probe.navigations.length;

  horizontalWheel(deltaXToward("back", 200), target);
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
  vi.advanceTimersByTime(
    DESKTOP_HISTORY_GESTURE.releaseMs + DESKTOP_HISTORY_GESTURE.tailMs,
  );

  expect(mounted.probe.views.length).toBe(viewsAfterCleanup);
  expect(mounted.probe.navigations.length).toBe(navigationsAfterCleanup);
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
  it("leaves an overflowing surface's sequence to content scroll entirely", () => {
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
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, rail);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.some((view) => view !== null)).toBe(false);
  });

  it("still claims the sequence over a non-overflowing tab strip that merely declares touch-pan-x", () => {
    const strip = document.createElement("div");
    strip.style.touchAction = "pan-x";
    document.body.appendChild(strip);

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("forward", DESKTOP_HISTORY_GESTURE.commitPx, strip);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual(["forward"]);
  });

  it("still claims the sequence over a terminal surface with touch-action: none", () => {
    const terminal = document.createElement("div");
    terminal.className = "xterm terminal";
    terminal.style.touchAction = "none";
    document.body.appendChild(terminal);

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, terminal);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  // Content that fits exactly has nothing to scroll, so it must not suppress
  // navigation - including a terminal, which renders inside a scrollable
  // container whether or not its content currently overflows it.
  it("still claims the sequence over a terminal container whose content currently fits with nothing to scroll", () => {
    const terminal = document.createElement("div");
    terminal.className = "xterm terminal";
    terminal.style.overflowX = "auto";
    document.body.appendChild(terminal);
    Object.defineProperty(terminal, "scrollWidth", {
      value: 300,
      configurable: true,
    });
    Object.defineProperty(terminal, "clientWidth", {
      value: 300,
      configurable: true,
    });

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("forward", DESKTOP_HISTORY_GESTURE.commitPx, terminal);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual(["forward"]);
  });

  // A 1px rounding overflow (scrollWidth exceeding clientWidth by no more than
  // the tolerance ownsDesktopHorizontalWheel allows) still reads as fitting.
  it("still claims the sequence over a surface only 1px over its client width", () => {
    const rail = document.createElement("div");
    rail.style.overflowX = "auto";
    document.body.appendChild(rail);
    Object.defineProperty(rail, "scrollWidth", {
      value: 301,
      configurable: true,
    });
    Object.defineProperty(rail, "clientWidth", {
      value: 300,
      configurable: true,
    });

    const mounted = mountGesture(DEFAULT_MOUNT);
    driveToTravel("back", DESKTOP_HISTORY_GESTURE.commitPx, rail);
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual(["back"]);
  });

  // Ownership is sampled once, off the first event of the sequence - a rail
  // reaching its scroll boundary mid-drag must not hand the rest of that same
  // sequence over to navigation.
  it("keeps a scrollable rail's ownership as content for the whole sequence, even after it reaches its scroll boundary mid-drag", () => {
    const rail = document.createElement("div");
    rail.style.overflowX = "auto";
    document.body.appendChild(rail);
    Object.defineProperty(rail, "scrollWidth", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(rail, "clientWidth", {
      value: 300,
      configurable: true,
    });
    rail.scrollLeft = 0;

    const mounted = mountGesture(DEFAULT_MOUNT);
    horizontalWheel(deltaXToward("back", ACTIVATION_PX), rail);
    rail.scrollLeft = 100; // now sits at its scroll boundary
    horizontalWheel(
      deltaXToward("back", DESKTOP_HISTORY_GESTURE.commitPx - ACTIVATION_PX),
      rail,
    );
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.some((view) => view !== null)).toBe(false);
  });
});

// Ownership is decided entirely off the sequence's FIRST wheel event
// (installDesktopHistoryGesture's `sequence === null` branch), which reads
// `event.composedPath()[0] ?? event.target` rather than `event.target`
// alone. Outside an open shadow root, `event.target` is retargeted to the
// shadow HOST (per the DOM's shadow-retargeting algorithm), which would
// otherwise hide the real horizontally-scrollable element inside it (a
// Pierre diff viewer, for example) from ownsDesktopHorizontalWheel.
// `horizontalWheel` already dispatches on the real, attached target with
// `composed: true`, so pointing it at the shadow-root inner element here
// exercises the DOM's own retargeting/composedPath - no separate helper
// needed. Only the first event of a sequence needs the real inner element:
// once ownership is fixed, later events don't consult either.
describe("wheel events originating inside an open shadow root", () => {
  function buildShadowScroller(options: {
    readonly overflow: boolean;
    readonly ownerHost?: boolean;
  }): { readonly host: HTMLElement; readonly inner: HTMLElement } {
    const host = document.createElement("div");
    if (options.ownerHost === true)
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
    return { host, inner };
  }

  it("keeps a horizontally-overflowing scroller inside a shadow root owned by content, reading composedPath's real innermost element rather than the retargeted host", () => {
    const { host, inner } = buildShadowScroller({ overflow: true });
    const mounted = mountGesture(DEFAULT_MOUNT);

    horizontalWheel(deltaXToward("back", ACTIVATION_PX), inner);
    horizontalWheel(
      deltaXToward("back", DESKTOP_HISTORY_GESTURE.commitPx - ACTIVATION_PX),
      host,
    );
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
    expect(mounted.probe.views.some((view) => view !== null)).toBe(false);
  });

  it("allows navigation over a shadow-root inner container that currently fits with nothing to scroll", () => {
    const { host, inner } = buildShadowScroller({ overflow: false });
    const mounted = mountGesture(DEFAULT_MOUNT);

    horizontalWheel(deltaXToward("forward", ACTIVATION_PX), inner);
    horizontalWheel(
      deltaXToward("forward", DESKTOP_HISTORY_GESTURE.commitPx - ACTIVATION_PX),
      host,
    );
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual(["forward"]);
  });

  it("still owns the sequence when the gesture-owner marker sits on the shadow host, crossed from the shadow-root inner target via getRootNode()", () => {
    const { host, inner } = buildShadowScroller({
      overflow: false,
      ownerHost: true,
    });
    const mounted = mountGesture(DEFAULT_MOUNT);

    horizontalWheel(deltaXToward("back", ACTIVATION_PX), inner);
    horizontalWheel(
      deltaXToward("back", DESKTOP_HISTORY_GESTURE.commitPx - ACTIVATION_PX),
      host,
    );
    vi.advanceTimersByTime(DESKTOP_HISTORY_GESTURE.releaseMs);

    expect(mounted.probe.navigations).toEqual([]);
  });
});
