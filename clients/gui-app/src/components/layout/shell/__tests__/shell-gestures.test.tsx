import "../../../../../__tests__/test-browser-apis";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  classifyDirectionalIntent,
  commitsDirectionalGesture,
} from "@/components/layout/shell/shell-gestures";
import { useNavDrawerClosePull } from "@/components/layout/shell/use-nav-drawer-close-pull";
import {
  useEdgeNavSwipe,
  type EdgeNavDirection,
  type EdgeNavDragResponse,
  type EdgeNavSwipeRelease,
} from "@/components/layout/shell/use-edge-nav-swipe";
import { useDragToDismissKeyboard } from "@/components/layout/shell/use-drag-to-dismiss-keyboard";
import { setMobileApp } from "@/lib/mobile-app";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

/**
 * jsdom implements `TouchEvent` but ships no working `Touch` constructor, so a
 * touch here is a plain `Event` wearing the one shape the production
 * listeners read off it: a `touches` list of `{ clientX, clientY }` points, a
 * `target`, and a `timeStamp`. Dispatched straight at `document` - where every
 * recognizer under test listens in the capture phase - with `target`
 * overridden via `defineProperty` so a single call site can stand in for a
 * touch that landed on any element, not just `document` itself.
 */
interface FakeTouchPoint {
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * The production listeners read `touches` through both index access and
 * `.item()` (the real `TouchList` shape) - a bare array only covers the
 * first, so `.item()` is bolted on to match.
 */
function makeTouchList(
  points: ReadonlyArray<FakeTouchPoint>,
): ReadonlyArray<FakeTouchPoint> & {
  item(index: number): FakeTouchPoint | null;
} {
  return Object.assign([...points], {
    item: (index: number): FakeTouchPoint | null => points[index] ?? null,
  });
}

function dispatchTouch(
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  options: {
    readonly touches: ReadonlyArray<FakeTouchPoint>;
    readonly target: EventTarget;
    readonly timeStamp: number;
  },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: makeTouchList(options.touches),
    configurable: true,
  });
  Object.defineProperty(event, "target", {
    value: options.target,
    configurable: true,
  });
  Object.defineProperty(event, "timeStamp", {
    value: options.timeStamp,
    configurable: true,
  });
  document.dispatchEvent(event);
}

/**
 * `touchend`/`touchcancel` carry no per-touch data either listener under test
 * reads (both handlers take no event parameter), so this only needs a
 * `timeStamp` for callers that care about ordering.
 */
function dispatchTouchEnd(
  type: "touchend" | "touchcancel",
  timeStamp: number,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "timeStamp", {
    value: timeStamp,
    configurable: true,
  });
  document.dispatchEvent(event);
}

/**
 * The drawer's close recognizer reads POINTER events, because the drag engine
 * it hands the gesture to is pointer-only. jsdom has no usable `PointerEvent`
 * constructor either, so the same trick as above: a plain `Event` wearing the
 * fields the recognizer actually reads - a coordinate pair, an identity, a
 * primary flag, a target and a timestamp.
 */
function dispatchPointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  options: {
    readonly clientX: number;
    readonly clientY: number;
    readonly target: EventTarget;
    readonly timeStamp: number;
    readonly pointerId: number;
    readonly isPrimary: boolean;
  },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", {
    value: options.clientX,
    configurable: true,
  });
  Object.defineProperty(event, "clientY", {
    value: options.clientY,
    configurable: true,
  });
  Object.defineProperty(event, "pointerId", {
    value: options.pointerId,
    configurable: true,
  });
  Object.defineProperty(event, "isPrimary", {
    value: options.isPrimary,
    configurable: true,
  });
  Object.defineProperty(event, "target", {
    value: options.target,
    configurable: true,
  });
  Object.defineProperty(event, "timeStamp", {
    value: options.timeStamp,
    configurable: true,
  });
  document.dispatchEvent(event);
}

function dispatchScroll(target: Element, timeStamp: number): void {
  const event = new Event("scroll", { bubbles: false, cancelable: false });
  Object.defineProperty(event, "target", {
    value: target,
    configurable: true,
  });
  Object.defineProperty(event, "timeStamp", {
    value: timeStamp,
    configurable: true,
  });
  document.dispatchEvent(event);
}

function stubHorizontalPan(
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

function stubVerticalScroller(
  el: HTMLElement,
  metrics: {
    readonly scrollHeight: number;
    readonly clientHeight: number;
    readonly scrollTop: number;
  },
): void {
  Object.defineProperty(el, "scrollHeight", {
    value: metrics.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: metrics.clientHeight,
    configurable: true,
  });
  el.scrollTop = metrics.scrollTop;
}

let activeUnmounts: Array<() => void> = [];

interface ClosePullActivation {
  readonly travelPx: number;
  readonly clientX: number;
}

/** The predicate for a screen with no drawer panel on it. */
const NOTHING_CLAIMED = (): boolean => false;

/**
 * The recognizer reports activations rather than moving the drawer itself, so a
 * probe records them. Deciding where the panel ends up belongs to the release
 * rule (`resolvesToOpen`), not here - all this hook settles is whether a
 * pointer on the panel is a close pull at all.
 */
function mountPull(options: {
  readonly withinPanel: (target: EventTarget | null) => boolean;
}): ReadonlyArray<ClosePullActivation> {
  const activations: ClosePullActivation[] = [];
  const { unmount } = renderHook(() =>
    useNavDrawerClosePull({
      onActivate: (event, travelPx) => {
        activations.push({ travelPx, clientX: event.clientX });
      },
      withinPanel: options.withinPanel,
    }),
  );
  activeUnmounts.push(unmount);
  return activations;
}

function mountKeyboardDismiss(): void {
  const { unmount } = renderHook(() => useDragToDismissKeyboard());
  activeUnmounts.push(unmount);
}

function focusInput(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  return input;
}

afterEach(() => {
  activeUnmounts.forEach((unmount) => {
    unmount();
  });
  activeUnmounts = [];
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--safe-area-inset-left");
  document.documentElement.style.removeProperty("--safe-area-inset-right");
  // The inset reader caches module-wide and only retires on a viewport event,
  // so clearing the property is not enough - without this a test that set an
  // inset would hand its geometry to every test after it.
  window.dispatchEvent(new Event("resize"));
  setMobileApp(false);
  useMobileNavStore.setState({ open: false });
});

describe("classifyDirectionalIntent", () => {
  it("activates once primary travel clears the threshold and leads the cross axis", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: 20, crossPx: 0, elapsedMs: 100 }),
    ).toBe("activate");
  });

  it("fails at exactly the counter-direction threshold", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: -10, crossPx: 0, elapsedMs: 100 }),
    ).toBe("fail");
  });

  it("fails when cross-axis travel exceeds its budget and dominates the primary axis", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: 5, crossPx: 15, elapsedMs: 100 }),
    ).toBe("fail");
  });

  it("waits while primary travel is under the activate threshold and not yet failing", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: 10, crossPx: 0, elapsedMs: 100 }),
    ).toBe("wait");
  });

  it("stays wait for a 12px-primary / 4px-cross drag rather than activating early", () => {
    expect(
      classifyDirectionalIntent({ primaryPx: 12, crossPx: 4, elapsedMs: 100 }),
    ).toBe("wait");
  });
});

describe("commitsDirectionalGesture", () => {
  const limits = { commitPx: 48, velocityPxPerMs: 0.5 };

  it("commits once distance alone clears commitPx", () => {
    expect(
      commitsDirectionalGesture(
        { primaryPx: 50, crossPx: 0, elapsedMs: 1000 },
        limits,
      ),
    ).toBe(true);
  });

  it("commits on average velocity before distance is reached", () => {
    expect(
      commitsDirectionalGesture(
        { primaryPx: 20, crossPx: 0, elapsedMs: 20 },
        limits,
      ),
    ).toBe(true);
  });

  it("stays uncommitted below both the distance and velocity arms", () => {
    expect(
      commitsDirectionalGesture(
        { primaryPx: 10, crossPx: 0, elapsedMs: 100 },
        limits,
      ),
    ).toBe(false);
  });

  it("rejects a zero-duration sample rather than treating it as infinitely fast", () => {
    expect(
      commitsDirectionalGesture(
        { primaryPx: 5, crossPx: 0, elapsedMs: 0 },
        limits,
      ),
    ).toBe(false);
  });
});

/**
 * The panel is a SCROLLING surface, which makes it the hardest place to ask
 * "is this drag mine". A drag engine left to claim on raw travel takes a share
 * of every vertical swipe and drags the drawer sideways underneath a finger
 * that was reading a list - the failure the user sees as the drawer fighting
 * them. These cases pin that the classifier actually arbitrates rather than
 * merely existing.
 */
describe("useNavDrawerClosePull - claiming a pull on the panel", () => {
  function panelNode(): HTMLElement {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    return panel;
  }

  function mountOnPanel(
    panel: HTMLElement,
  ): ReadonlyArray<ClosePullActivation> {
    setMobileApp(true);
    return mountPull({
      withinPanel: (target) => target instanceof Node && panel.contains(target),
    });
  }

  it("hands off the gesture once a leftward drag on the panel declares itself", () => {
    const panel = panelNode();
    const activations = mountOnPanel(panel);

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 184,
      clientY: 100,
      target: panel,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(1);
    // The travel is reported so the panel can meet the finger where the drag
    // declared itself rather than 16px behind it, and it is positive along the
    // pull's OWN direction - leftward.
    expect(activations[0]?.travelPx).toBe(16);
    expect(activations[0]?.clientX).toBe(184);
  });

  // The third state is the point. A two-state recognizer has to decide on the
  // first pixel, so it either steals scrolls or misses swipes; an ambiguous
  // drag stays unclaimed until it declares itself.
  it("waits through an undeclared move and activates on the one that declares", () => {
    const panel = panelNode();
    const activations = mountOnPanel(panel);

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 190,
      clientY: 100,
      target: panel,
      timeStamp: 50,
      pointerId: 1,
      isPrimary: true,
    });
    expect(activations.length).toBe(0);
    dispatchPointer("pointermove", {
      clientX: 180,
      clientY: 100,
      target: panel,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(1);
    expect(activations[0]?.travelPx).toBe(20);
  });

  // Everything after the handoff belongs to the drag engine. A second
  // activation would start a competing pan session against the same transform.
  it("activates at most once per pointer", () => {
    const panel = panelNode();
    const activations = mountOnPanel(panel);

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 180,
      clientY: 100,
      target: panel,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 130,
      clientY: 100,
      target: panel,
      timeStamp: 200,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(1);
  });

  // The reported bug, inverted into a guarantee. A near-vertical swipe with a
  // little sideways lead is a scroll, and the drawer must not take any of it.
  it("leaves a vertical-dominant swipe on the panel to the scroller", () => {
    const panel = panelNode();
    const activations = mountOnPanel(panel);

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 300,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 192,
      clientY: 380,
      target: panel,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  // Rightward on the panel is the counter-direction: a hand pushing an
  // already-open drawer further open, which is nothing. The gesture stays dead
  // for the rest of that pointer rather than re-arming if the finger turns
  // back.
  it("abandons the gesture for good once the finger pushes the other way", () => {
    const panel = panelNode();
    const activations = mountOnPanel(panel);

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 215,
      clientY: 100,
      target: panel,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 100,
      clientY: 100,
      target: panel,
      timeStamp: 200,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  it("aborts once a second pointer joins mid-gesture", () => {
    const panel = panelNode();
    const activations = mountOnPanel(panel);

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    // A pinch or a two-finger pan; neither is a drawer pull, and the tracked
    // pointer stops describing the gesture as a whole.
    dispatchPointer("pointerdown", {
      clientX: 300,
      clientY: 100,
      target: panel,
      timeStamp: 50,
      pointerId: 2,
      isPrimary: false,
    });
    dispatchPointer("pointermove", {
      clientX: 130,
      clientY: 100,
      target: panel,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  it("ignores moves belonging to a pointer it is not tracking", () => {
    const panel = panelNode();
    const activations = mountOnPanel(panel);

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 130,
      clientY: 100,
      target: panel,
      timeStamp: 100,
      pointerId: 2,
      isPrimary: false,
    });
    expect(activations.length).toBe(0);
    // The tracked pointer is untouched by the stray one and still activates.
    dispatchPointer("pointermove", {
      clientX: 130,
      clientY: 100,
      target: panel,
      timeStamp: 200,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(1);
  });

  it("never activates when the mobile app flag is off", () => {
    setMobileApp(false);
    const panel = panelNode();
    const activations = mountPull({
      withinPanel: (target) => target instanceof Node && panel.contains(target),
    });

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 130,
      clientY: 100,
      target: panel,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  // Pushing the menu away mid-draft is an ordinary thing to do, so a focused
  // field is not a reason to stand down.
  it("still activates while a text entry is focused", () => {
    focusInput();
    const panel = panelNode();
    const activations = mountOnPanel(panel);

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 130,
      clientY: 100,
      target: panel,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(1);
  });

  // Claiming nothing until the classifier is satisfied is what keeps the panel
  // itself usable: pressing a menu row is a tap, and a tap never reaches 15px
  // of horizontal travel.
  it("leaves a tap on the panel to the row underneath", () => {
    const panel = panelNode();
    const activations = mountOnPanel(panel);

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: panel,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointerup", {
      clientX: 199,
      clientY: 101,
      target: panel,
      timeStamp: 40,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });
});

/**
 * What the recognizer refuses, and the first case is the load-bearing one:
 * geometry plays NO part in this hook. Landing on the panel is the whole
 * entrance test, so a drag anywhere else - including the screen's leading edge
 * - is somebody else's.
 */
describe("useNavDrawerClosePull - what it refuses", () => {
  function mountOffPanel(): ReadonlyArray<ClosePullActivation> {
    setMobileApp(true);
    return mountPull({ withinPanel: NOTHING_CLAIMED });
  }

  // The hamburger is the only way into the drawer, so a rightward drag from
  // the leading edge must reach whatever surface is under it untouched. A
  // recognizer that kept an edge branch would claim this one.
  it("never activates for a rightward drag from the screen's leading edge", () => {
    const activations = mountOffPanel();

    dispatchPointer("pointerdown", {
      clientX: 2,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 120,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  // The same edge, dragged the way a close pull goes. Neither direction has an
  // entrance here; only the panel does.
  it("never activates for a leftward drag off the panel", () => {
    const activations = mountOffPanel();

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 100,
      clientY: 100,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  // The scrim claims its own pointers the instant they land, so a pointer
  // reaching it is already spoken for. It is on the drawer's layer but not on
  // the panel, which is exactly the distinction `withinPanel` draws.
  it("stands down for a pointer that landed on the scrim", () => {
    const scrim = document.createElement("div");
    document.body.appendChild(scrim);
    const activations = mountOffPanel();

    dispatchPointer("pointerdown", {
      clientX: 300,
      clientY: 300,
      target: scrim,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 200,
      clientY: 302,
      target: scrim,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  it("does not activate on a surface that declares its own touch handling", () => {
    setMobileApp(true);
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    const ownHandling = document.createElement("div");
    ownHandling.style.touchAction = "none";
    panel.appendChild(ownHandling);
    const activations = mountPull({
      withinPanel: (target) => target instanceof Node && panel.contains(target),
    });

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: ownHandling,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 130,
      clientY: 100,
      target: ownHandling,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });

  // A target that pans horizontally is excluded even when it does not declare
  // `touch-action: none` outright - a rail mid-scroll is a gesture the user is
  // already in, so this refuses rather than competes.
  it("does not activate on a rail inside the panel that already pans sideways", () => {
    setMobileApp(true);
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    const rail = document.createElement("div");
    rail.style.overflowX = "auto";
    stubHorizontalPan(rail, { scrollWidth: 600, clientWidth: 300 });
    panel.appendChild(rail);
    const activations = mountPull({
      withinPanel: (target) => target instanceof Node && panel.contains(target),
    });

    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 100,
      target: rail,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 130,
      clientY: 100,
      target: rail,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(activations.length).toBe(0);
  });
});

describe("useDragToDismissKeyboard", () => {
  it("blurs on a tap outside the focused field", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    dispatchTouchEnd("touchend", 10);

    expect(document.activeElement).not.toBe(input);
  });

  it("does not blur on a tap inside the focused field", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();

    dispatchTouch("touchstart", {
      touches: [{ clientX: 10, clientY: 10 }],
      target: input,
      timeStamp: 0,
    });
    dispatchTouchEnd("touchend", 10);

    expect(document.activeElement).toBe(input);
  });

  it("does not treat a touch that travels past the tap slop as a tap", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    // Euclidean travel of ~8.49px, over the 8px slop, and primary/cross both
    // stay under the drag arm's own activate threshold so it never takes over
    // either.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 106, clientY: 106 }],
      target: outside,
      timeStamp: 50,
    });
    dispatchTouchEnd("touchend", 60);

    expect(document.activeElement).toBe(input);
  });

  it("does nothing on any arm when no text entry is focused", () => {
    setMobileApp(true);
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 100, clientY: 160 }],
      target: outside,
      timeStamp: 100,
    });
    dispatchTouchEnd("touchend", 110);

    expect(document.activeElement).toBe(document.body);
  });

  it("blurs on a downward drag past the commit distance over a non-scrollable target", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const target = document.createElement("div");
    document.body.appendChild(target);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target,
      timeStamp: 0,
    });
    // Activates (20px) but stays under the 40px commit distance.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 120 }],
      target,
      timeStamp: 100,
    });
    expect(document.activeElement).toBe(input);
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 145 }],
      target,
      timeStamp: 200,
    });

    expect(document.activeElement).not.toBe(input);
  });

  it("does not arm the drag arm over a scroller that is scrolled away from its top", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    stubVerticalScroller(scroller, {
      scrollHeight: 300,
      clientHeight: 100,
      scrollTop: 50,
    });
    document.body.appendChild(scroller);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: scroller,
      timeStamp: 0,
    });
    // Would clear the drag arm's commit distance if it were armed.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 160 }],
      target: scroller,
      timeStamp: 100,
    });
    dispatchTouchEnd("touchend", 110);

    expect(document.activeElement).toBe(input);
  });

  it("blurs on a scroll flick sampled at least 30ms apart that exceeds the velocity threshold", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    // Away from its top, so the touchstart hands this drag to the scroller
    // rather than arming the drag arm - the scenario the sampler exists for.
    stubVerticalScroller(scroller, {
      scrollHeight: 300,
      clientHeight: 100,
      scrollTop: 100,
    });
    document.body.appendChild(scroller);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: scroller,
      timeStamp: 990,
    });
    // Past the tap slop, so release reads the sampled scroll instead of
    // treating this as a stationary tap.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 109 }],
      target: scroller,
      timeStamp: 995,
    });
    dispatchScroll(scroller, 1000);
    scroller.scrollTop = 20;
    // 80px over 40ms is 2px/ms, past the 1.5px/ms dismiss threshold.
    dispatchScroll(scroller, 1040);
    dispatchTouchEnd("touchend", 1050);

    expect(document.activeElement).not.toBe(input);
  });

  it("does not blur on a gentle scroll under the velocity threshold", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    stubVerticalScroller(scroller, {
      scrollHeight: 300,
      clientHeight: 100,
      scrollTop: 100,
    });
    document.body.appendChild(scroller);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: scroller,
      timeStamp: 990,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 109 }],
      target: scroller,
      timeStamp: 995,
    });
    dispatchScroll(scroller, 1000);
    scroller.scrollTop = 80;
    // 20px over 40ms is 0.5px/ms, under the 1.5px/ms dismiss threshold.
    dispatchScroll(scroller, 1040);
    dispatchTouchEnd("touchend", 1050);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur on two fast scroll events with no live touch sequence", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    scroller.scrollTop = 100;

    // No touchstart ever ran, so the sampler has no touched node to bind this
    // scroll to - a fast flick elsewhere in the app must not read as the
    // user's own gesture just because a text entry happens to be focused.
    dispatchScroll(scroller, 1000);
    scroller.scrollTop = 20;
    dispatchScroll(scroller, 1040);
    dispatchTouchEnd("touchend", 1050);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur when an unrelated element scrolls fast during a live sequence elsewhere", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const elementA = document.createElement("div");
    const elementB = document.createElement("div");
    document.body.appendChild(elementA);
    document.body.appendChild(elementB);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: elementA,
      timeStamp: 0,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 109 }],
      target: elementA,
      timeStamp: 10,
    });
    // B is a sibling of A, neither an ancestor nor the touched node itself -
    // its scroll is not the live gesture's, however fast it moves.
    elementB.scrollTop = 100;
    dispatchScroll(elementB, 1000);
    elementB.scrollTop = 20;
    dispatchScroll(elementB, 1040);
    dispatchTouchEnd("touchend", 1050);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur on an upward drag", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const target = document.createElement("div");
    document.body.appendChild(target);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target,
      timeStamp: 0,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 50 }],
      target,
      timeStamp: 100,
    });
    dispatchTouchEnd("touchend", 110);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur for a gesture on a surface that declares its own touch handling", () => {
    setMobileApp(true);
    const input = focusInput();
    mountKeyboardDismiss();
    const ownHandling = document.createElement("div");
    ownHandling.style.touchAction = "none";
    document.body.appendChild(ownHandling);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target: ownHandling,
      timeStamp: 0,
    });
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 150 }],
      target: ownHandling,
      timeStamp: 100,
    });
    dispatchTouchEnd("touchend", 110);

    expect(document.activeElement).toBe(input);
  });

  it("does not blur the newly-focused field when focus moves away mid-gesture before the tap commits", () => {
    setMobileApp(true);
    focusInput();
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    // A route change or picker autofocusing its own field mid-gesture - the
    // dismiss is still pinned to the field the gesture started on, not
    // whichever one happens to hold focus at release.
    const fieldB = focusInput();
    dispatchTouchEnd("touchend", 10);

    expect(document.activeElement).toBe(fieldB);
  });

  it("does not blur the newly-focused field when focus moves away mid-gesture before the drag commits", () => {
    setMobileApp(true);
    focusInput();
    mountKeyboardDismiss();
    const target = document.createElement("div");
    document.body.appendChild(target);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 50, clientY: 100 }],
      target,
      timeStamp: 0,
    });
    // Activates (20px) but stays under the 40px commit distance.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 120 }],
      target,
      timeStamp: 100,
    });
    const fieldB = focusInput();
    // Crosses the commit distance, which dismisses synchronously from inside
    // this move rather than waiting for touchend.
    dispatchTouch("touchmove", {
      touches: [{ clientX: 50, clientY: 145 }],
      target,
      timeStamp: 200,
    });

    expect(document.activeElement).toBe(fieldB);
  });

  it("does not blur when the mobile app flag is off", () => {
    const input = focusInput();
    setMobileApp(false);
    mountKeyboardDismiss();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    dispatchTouch("touchstart", {
      touches: [{ clientX: 100, clientY: 100 }],
      target: outside,
      timeStamp: 0,
    });
    dispatchTouchEnd("touchend", 10);

    expect(document.activeElement).toBe(input);
  });
});

/**
 * The platform navigation swipes. Each edge answers exactly ONE direction -
 * the one travelling inward from it - so the two zones can never both claim a
 * gesture, and a drag off the screen is not a navigation that changed its mind.
 *
 * `window.innerWidth` is pinned rather than assumed: the trailing zone is
 * derived from it, and a suite-wide default that shifted would move the zone
 * without moving the coordinates the cases dispatch at.
 */
describe("useEdgeNavSwipe", () => {
  const VIEWPORT_PX = 400;

  interface SwipeProbe {
    /** Discrete steps - the path taken when nothing follows the finger. */
    readonly navigations: ReadonlyArray<EdgeNavDirection>;
    readonly dragStarts: ReadonlyArray<EdgeNavDirection>;
    readonly dragTravel: ReadonlyArray<number>;
    readonly releases: ReadonlyArray<EdgeNavSwipeRelease>;
  }

  function mountSwipe(options: {
    readonly edgesClaimed: () => boolean;
    /** What the transition answers at activation. */
    readonly response: EdgeNavDragResponse;
  }): SwipeProbe {
    const navigations: EdgeNavDirection[] = [];
    const dragStarts: EdgeNavDirection[] = [];
    const dragTravel: number[] = [];
    const releases: EdgeNavSwipeRelease[] = [];
    const { unmount } = renderHook(() =>
      useEdgeNavSwipe({
        onDragStart: (direction) => {
          dragStarts.push(direction);
          return options.response;
        },
        onDragMove: (travelPx) => {
          dragTravel.push(travelPx);
        },
        onDragEnd: (release) => {
          releases.push(release);
        },
        onNavigate: (direction) => {
          navigations.push(direction);
        },
        edgesClaimed: options.edgesClaimed,
      }),
    );
    activeUnmounts.push(unmount);
    return { navigations, dragStarts, dragTravel, releases };
  }

  /**
   * The ordinary case: the mobile app, nothing covering the edges, and no
   * transition able to follow the finger - so activation navigates outright,
   * which is the shape every case below asserts against.
   */
  function mountOnBareScreen(): SwipeProbe {
    setMobileApp(true);
    return mountSwipe({ edgesClaimed: NOTHING_CLAIMED, response: "instant" });
  }

  /** The same screen, with a transition that takes the drag at activation. */
  function mountWithFollowingTransition(): SwipeProbe {
    setMobileApp(true);
    return mountSwipe({ edgesClaimed: NOTHING_CLAIMED, response: "follow" });
  }

  function swipe(options: {
    readonly from: number;
    readonly to: number;
    readonly target: EventTarget;
    readonly dropY: number;
  }): void {
    dispatchPointer("pointerdown", {
      clientX: options.from,
      clientY: 300,
      target: options.target,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: options.to,
      clientY: 300 + options.dropY,
      target: options.target,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });
  }

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: VIEWPORT_PX,
      configurable: true,
    });
  });

  it("navigates back on a rightward swipe from the leading edge", () => {
    const probe = mountOnBareScreen();

    swipe({ from: 8, to: 60, target: document.body, dropY: 0 });

    expect(probe.navigations).toEqual(["back"]);
  });

  it("navigates forward on a leftward swipe from the trailing edge", () => {
    const probe = mountOnBareScreen();

    swipe({
      from: VIEWPORT_PX - 8,
      to: VIEWPORT_PX - 60,
      target: document.body,
      dropY: 0,
    });

    expect(probe.navigations).toEqual(["forward"]);
  });

  // Outward from the leading edge is the counter-direction there - a swipe off
  // the screen, not a back. The trailing edge owns leftward and this edge does
  // not answer it.
  it("ignores a leftward swipe that starts at the leading edge", () => {
    const probe = mountOnBareScreen();

    swipe({ from: 30, to: 0, target: document.body, dropY: 0 });

    expect(probe.navigations).toEqual([]);
  });

  it("ignores a rightward swipe that starts at the trailing edge", () => {
    const probe = mountOnBareScreen();

    swipe({
      from: VIEWPORT_PX - 30,
      to: VIEWPORT_PX,
      target: document.body,
      dropY: 0,
    });

    expect(probe.navigations).toEqual([]);
  });

  it("ignores a swipe that starts between the two zones", () => {
    const probe = mountOnBareScreen();

    swipe({ from: 200, to: 320, target: document.body, dropY: 0 });

    expect(probe.navigations).toEqual([]);
  });

  // A vertical scroll that happens to begin at the edge stays a scroll; the
  // classifier judges a drag by which way it is mostly going.
  it("leaves a vertical-dominant drag from the edge to whatever is scrolling", () => {
    const probe = mountOnBareScreen();

    swipe({ from: 8, to: 16, target: document.body, dropY: 80 });

    expect(probe.navigations).toEqual([]);
  });

  // Nothing is claimed until the classifier sees travel a tap could not have
  // made, which is what keeps a control at the screen edge tappable.
  it("leaves a tap at the edge to whatever it landed on", () => {
    const probe = mountOnBareScreen();

    dispatchPointer("pointerdown", {
      clientX: 8,
      clientY: 300,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointerup", {
      clientX: 9,
      clientY: 301,
      target: document.body,
      timeStamp: 40,
      pointerId: 1,
      isPrimary: true,
    });

    expect(probe.navigations).toEqual([]);
  });

  // Navigation is a discrete step, so the rest of the drag is nothing. A second
  // activation would take the user two surfaces back for one swipe.
  it("navigates at most once per pointer", () => {
    const probe = mountOnBareScreen();

    dispatchPointer("pointerdown", {
      clientX: 8,
      clientY: 300,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 60,
      clientY: 300,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointermove", {
      clientX: 200,
      clientY: 300,
      target: document.body,
      timeStamp: 200,
      pointerId: 1,
      isPrimary: true,
    });

    expect(probe.navigations).toEqual(["back"]);
  });

  it("aborts once a second pointer joins mid-gesture", () => {
    const probe = mountOnBareScreen();

    dispatchPointer("pointerdown", {
      clientX: 8,
      clientY: 300,
      target: document.body,
      timeStamp: 0,
      pointerId: 1,
      isPrimary: true,
    });
    dispatchPointer("pointerdown", {
      clientX: 200,
      clientY: 300,
      target: document.body,
      timeStamp: 50,
      pointerId: 2,
      isPrimary: false,
    });
    dispatchPointer("pointermove", {
      clientX: 60,
      clientY: 300,
      target: document.body,
      timeStamp: 100,
      pointerId: 1,
      isPrimary: true,
    });

    expect(probe.navigations).toEqual([]);
  });

  it("never navigates when the mobile app flag is off", () => {
    setMobileApp(false);
    const probe = mountSwipe({
      edgesClaimed: NOTHING_CLAIMED,
      response: "instant",
    });

    swipe({ from: 8, to: 60, target: document.body, dropY: 0 });

    expect(probe.navigations).toEqual([]);
  });

  // The drawer covers both edges while it is out, and a pointer landing on it
  // is already inside a drag of its own.
  it("stands down while the caller says the edges are claimed", () => {
    setMobileApp(true);
    const probe = mountSwipe({ edgesClaimed: () => true, response: "instant" });

    swipe({ from: 8, to: 60, target: document.body, dropY: 0 });

    expect(probe.navigations).toEqual([]);
  });

  /**
   * A blocking surface can arrive DURING the contact - a migration frame lands,
   * a dialog opens on something happening elsewhere - so the finger that began
   * on an ordinary screen is mid-travel over a surface the user has to address.
   * No amount of care about WHEN a claimant registers covers this; only asking
   * again does.
   */
  describe("a claim arriving mid-contact", () => {
    function mountWithSwitchableClaim(): {
      readonly probe: SwipeProbe;
      readonly claim: (next: boolean) => void;
    } {
      setMobileApp(true);
      let claimed = false;
      const probe = mountSwipe({
        edgesClaimed: () => claimed,
        response: "instant",
      });
      return {
        probe,
        claim: (next: boolean) => {
          claimed = next;
        },
      };
    }

    it("drops a gesture that was clean at pointer-down", () => {
      const { probe, claim } = mountWithSwitchableClaim();

      dispatchPointer("pointerdown", {
        clientX: 8,
        clientY: 300,
        target: document.body,
        timeStamp: 0,
        pointerId: 1,
        isPrimary: true,
      });
      claim(true);
      dispatchPointer("pointermove", {
        clientX: 80,
        clientY: 300,
        target: document.body,
        timeStamp: 100,
        pointerId: 1,
        isPrimary: true,
      });

      expect(probe.navigations).toEqual([]);
    });

    // Dropped, not paused. A claim that appears mid-contact does not retract
    // when the layer closes: the swipe that started under one screen is not
    // owed to whatever screen follows it, and re-arming a resident tracker
    // would hand it over.
    it("does not re-arm the same contact once the claim lifts", () => {
      const { probe, claim } = mountWithSwitchableClaim();

      dispatchPointer("pointerdown", {
        clientX: 8,
        clientY: 300,
        target: document.body,
        timeStamp: 0,
        pointerId: 1,
        isPrimary: true,
      });
      claim(true);
      dispatchPointer("pointermove", {
        clientX: 40,
        clientY: 300,
        target: document.body,
        timeStamp: 100,
        pointerId: 1,
        isPrimary: true,
      });
      claim(false);
      dispatchPointer("pointermove", {
        clientX: 120,
        clientY: 300,
        target: document.body,
        timeStamp: 200,
        pointerId: 1,
        isPrimary: true,
      });

      expect(probe.navigations).toEqual([]);
    });

    // The novelty guard for both cases above: the next contact is a new
    // gesture and navigates normally.
    it("answers the next contact once the claim is gone", () => {
      const { probe, claim } = mountWithSwitchableClaim();

      dispatchPointer("pointerdown", {
        clientX: 8,
        clientY: 300,
        target: document.body,
        timeStamp: 0,
        pointerId: 1,
        isPrimary: true,
      });
      claim(true);
      dispatchPointer("pointermove", {
        clientX: 80,
        clientY: 300,
        target: document.body,
        timeStamp: 100,
        pointerId: 1,
        isPrimary: true,
      });
      dispatchPointer("pointerup", {
        clientX: 80,
        clientY: 300,
        target: document.body,
        timeStamp: 150,
        pointerId: 1,
        isPrimary: true,
      });
      claim(false);

      swipe({ from: 8, to: 60, target: document.body, dropY: 0 });

      expect(probe.navigations).toEqual(["back"]);
    });
  });

  it("does not navigate on a rail that already pans sideways", () => {
    const probe = mountOnBareScreen();
    const rail = document.createElement("div");
    rail.style.overflowX = "auto";
    stubHorizontalPan(rail, { scrollWidth: 600, clientWidth: 300 });
    document.body.appendChild(rail);

    swipe({ from: 8, to: 60, target: rail, dropY: 0 });

    expect(probe.navigations).toEqual([]);
  });

  // The composer spans the full width, so its own leading edge sits inside the
  // zone. A horizontal drag there is the caret being dragged through the text,
  // and it belongs to the field whether or not the field held focus when the
  // finger came down.
  it("does not navigate on a drag inside a text entry", () => {
    const probe = mountOnBareScreen();
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);

    swipe({ from: 8, to: 60, target: composer, dropY: 0 });

    expect(probe.navigations).toEqual([]);
  });

  it("does not navigate on a drag inside a contenteditable", () => {
    const probe = mountOnBareScreen();
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.appendChild(editable);
    const line = document.createElement("span");
    editable.appendChild(line);

    swipe({ from: 8, to: 60, target: line, dropY: 0 });

    expect(probe.navigations).toEqual([]);
  });

  // The shape a rich editor's node views take: a non-editable atom - a mention
  // chip, a slash-command result, an attached image - inside an editable root.
  // There is no caret in one to drag, so the nearest declaration wins and the
  // swipe is the shell's. Walking past it to the editable root would refuse a
  // gesture over every atom in the document.
  it("navigates on a drag over a non-editable atom inside an editor", () => {
    const probe = mountOnBareScreen();
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.appendChild(editable);
    const atom = document.createElement("span");
    atom.setAttribute("contenteditable", "false");
    editable.appendChild(atom);
    const glyph = document.createElement("span");
    atom.appendChild(glyph);

    swipe({ from: 8, to: 60, target: glyph, dropY: 0 });

    expect(probe.navigations).toEqual(["back"]);
  });

  // The carve-out is about the caret, not about ownership of every descendant:
  // a real field nested inside a non-editable atom is still a field, and the
  // tag is checked at every level on the way up.
  it("does not navigate on a field nested inside a non-editable atom", () => {
    const probe = mountOnBareScreen();
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.appendChild(editable);
    const atom = document.createElement("span");
    atom.setAttribute("contenteditable", "false");
    editable.appendChild(atom);
    const field = document.createElement("input");
    atom.appendChild(field);

    swipe({ from: 8, to: 60, target: field, dropY: 0 });

    expect(probe.navigations).toEqual([]);
  });

  /**
   * The touch layer, whose only job is to stop the browser taking the drag
   * before the recognizer can read it. What jsdom can honestly pin is the
   * DECISION - which touches are cancelled, which are let go, and when the
   * per-move listener exists at all. Whether cancelling is enough to keep a
   * real web view's scroll view off the gesture is a device question and is
   * stated as one; no simulator reproduces it either, since synthesized
   * touches drive no such arbitration.
   */
  describe("reserving the gesture from the browser", () => {
    interface TouchPoint {
      readonly clientX: number;
      readonly clientY: number;
    }

    function touchList(
      points: ReadonlyArray<TouchPoint>,
    ): ReadonlyArray<TouchPoint> & { item(index: number): TouchPoint | null } {
      return Object.assign([...points], {
        item: (index: number): TouchPoint | null => points[index] ?? null,
      });
    }

    /**
     * Dispatches and hands the event back, so a case can read whether the
     * browser's own handling was cancelled.
     */
    function fireTouch(
      type: "touchstart" | "touchmove" | "touchend",
      options: {
        readonly points: ReadonlyArray<TouchPoint>;
        readonly target: EventTarget;
      },
    ): Event {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        value: touchList(options.points),
        configurable: true,
      });
      Object.defineProperty(event, "target", {
        value: options.target,
        configurable: true,
      });
      document.dispatchEvent(event);
      return event;
    }

    function touchDown(clientX: number, target: EventTarget): void {
      fireTouch("touchstart", { points: [{ clientX, clientY: 300 }], target });
    }

    function touchTo(
      point: TouchPoint,
      target: EventTarget,
    ): { readonly cancelled: boolean } {
      const event = fireTouch("touchmove", { points: [point], target });
      return { cancelled: event.defaultPrevented };
    }

    it("cancels the browser's handling of an inward drag from the leading edge", () => {
      mountOnBareScreen();

      touchDown(8, document.body);
      const first = touchTo({ clientX: 14, clientY: 300 }, document.body);
      const later = touchTo({ clientX: 60, clientY: 300 }, document.body);

      expect(first.cancelled).toBe(true);
      // Every move after the decision, not only the one that made it: handing
      // the drag back mid-gesture would let the page start scrolling under a
      // finger the recognizer is still reading.
      expect(later.cancelled).toBe(true);
    });

    it("cancels the browser's handling of an inward drag from the trailing edge", () => {
      mountOnBareScreen();

      touchDown(VIEWPORT_PX - 8, document.body);
      const move = touchTo(
        { clientX: VIEWPORT_PX - 20, clientY: 300 },
        document.body,
      );

      expect(move.cancelled).toBe(true);
    });

    // The constraint that makes this safe to install app-wide: a scroll that
    // begins in the strip is a scroll. Nothing is cancelled, so it does not
    // even start late.
    it("leaves a vertical drag from the edge to the page", () => {
      mountOnBareScreen();

      touchDown(8, document.body);
      const move = touchTo({ clientX: 10, clientY: 340 }, document.body);

      expect(move.cancelled).toBe(false);
    });

    // Once released, released. Re-deciding after the page has begun scrolling
    // is the one thing that cannot work, so the drag is never taken back.
    it("does not reclaim a released touch that later turns horizontal", () => {
      mountOnBareScreen();

      touchDown(8, document.body);
      touchTo({ clientX: 10, clientY: 340 }, document.body);
      const later = touchTo({ clientX: 120, clientY: 345 }, document.body);

      expect(later.cancelled).toBe(false);
    });

    // Outward from the edge is a swipe off the screen, which this recognizer
    // never answers - so cancelling it would take a gesture from the page and
    // give it to nobody.
    it("leaves an outward drag from the leading edge to the page", () => {
      mountOnBareScreen();

      touchDown(30, document.body);
      const move = touchTo({ clientX: 6, clientY: 300 }, document.body);

      expect(move.cancelled).toBe(false);
    });

    it("leaves a drag that starts between the zones to the page", () => {
      mountOnBareScreen();

      touchDown(200, document.body);
      const move = touchTo({ clientX: 260, clientY: 300 }, document.body);

      expect(move.cancelled).toBe(false);
    });

    // The reservation applies the recognizer's own entrance test, so the two
    // can never disagree about whose gesture this is - taking a drag the
    // recognizer would refuse would cancel a scroll for nothing.
    it("leaves a drag inside a text entry to the page", () => {
      mountOnBareScreen();
      const composer = document.createElement("textarea");
      document.body.appendChild(composer);

      touchDown(8, composer);
      const move = touchTo({ clientX: 60, clientY: 300 }, composer);

      expect(move.cancelled).toBe(false);
    });

    it("leaves a drag alone while the edges are claimed", () => {
      setMobileApp(true);
      mountSwipe({ edgesClaimed: () => true, response: "instant" });

      touchDown(8, document.body);
      const move = touchTo({ clientX: 60, clientY: 300 }, document.body);

      expect(move.cancelled).toBe(false);
    });

    it("ignores a second finger, leaving pinch and two-finger pans to the page", () => {
      mountOnBareScreen();

      fireTouch("touchstart", {
        points: [
          { clientX: 8, clientY: 300 },
          { clientX: 200, clientY: 300 },
        ],
        target: document.body,
      });
      const move = touchTo({ clientX: 60, clientY: 300 }, document.body);

      expect(move.cancelled).toBe(false);
    });

    /**
     * A document-level non-passive `touchmove` is the one listener that
     * genuinely costs something: the browser must wait for it before moving the
     * page on every frame of every scroll in the app. So its LIFETIME is the
     * contract, not merely its behaviour - it may exist between a qualifying
     * touch-down and that touch ending, and at no other time.
     */
    describe("the cost of the per-move listener", () => {
      /**
       * Whether a registration asked for the passive slot, read off the
       * recorded argument rather than from a type: what matters is what the
       * browser was actually told.
       */
      function askedForPassive(options: unknown): boolean {
        if (typeof options !== "object" || options === null) return false;
        return "passive" in options && options.passive === true;
      }

      function passiveFlagsFor(
        calls: ReadonlyArray<ReadonlyArray<unknown>>,
        type: string,
      ): ReadonlyArray<boolean> {
        return calls
          .filter((call) => call[0] === type)
          .map((call) => askedForPassive(call[2]));
      }

      function countFor(
        calls: ReadonlyArray<ReadonlyArray<unknown>>,
        type: string,
      ): number {
        return calls.filter((call) => call[0] === type).length;
      }

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it("registers nothing per-move until a touch qualifies", () => {
        const addSpy = vi.spyOn(document, "addEventListener");

        mountOnBareScreen();

        expect(passiveFlagsFor(addSpy.mock.calls, "touchmove")).toEqual([]);
      });

      // Non-passive is the whole point: a listener that cannot cancel reserves
      // nothing, and a browser that knows nothing can cancel hands the drag
      // straight to its scroller.
      it("registers a cancellable per-move listener once a touch qualifies", () => {
        mountOnBareScreen();
        const addSpy = vi.spyOn(document, "addEventListener");

        touchDown(8, document.body);

        expect(passiveFlagsFor(addSpy.mock.calls, "touchmove")).toEqual([
          false,
        ]);
      });

      it("drops it when the touch ends", () => {
        mountOnBareScreen();
        touchDown(8, document.body);
        touchTo({ clientX: 60, clientY: 300 }, document.body);
        const removeSpy = vi.spyOn(document, "removeEventListener");

        fireTouch("touchend", { points: [], target: document.body });

        expect(countFor(removeSpy.mock.calls, "touchmove")).toBeGreaterThan(0);
      });

      it("drops it the moment the drag turns out to be a scroll", () => {
        mountOnBareScreen();
        touchDown(8, document.body);
        const removeSpy = vi.spyOn(document, "removeEventListener");

        touchTo({ clientX: 10, clientY: 340 }, document.body);

        expect(countFor(removeSpy.mock.calls, "touchmove")).toBeGreaterThan(0);
      });
    });
  });

  /**
   * The zones are 32px of APP SURFACE, not of screen. In landscape the sensor
   * housing's inset can be wider than a zone itself, so a recognizer measuring
   * from raw viewport coordinates puts the whole strip inside the cutout -
   * reachable by nothing, on the orientation where a navigation gesture is most
   * useful. These pin the shape of the correction: the inset moves where a zone
   * begins and does NOT stretch how wide it is.
   */
  describe("the zones start where the app surface does", () => {
    const INSET_PX = 60;

    function withInsets(): SwipeProbe {
      document.documentElement.style.setProperty(
        "--safe-area-inset-left",
        `${INSET_PX}px`,
      );
      document.documentElement.style.setProperty(
        "--safe-area-inset-right",
        `${INSET_PX}px`,
      );
      // The reader caches, and a viewport event is what retires it - the same
      // signal a real rotation sends.
      window.dispatchEvent(new Event("resize"));
      return mountOnBareScreen();
    }

    it("moves the leading zone inboard by the left inset", () => {
      const probe = withInsets();

      swipe({ from: INSET_PX + 8, to: 160, target: document.body, dropY: 0 });

      expect(probe.navigations).toEqual(["back"]);
    });

    it("refuses a pointer that lands before the app surface begins", () => {
      const probe = withInsets();

      swipe({ from: INSET_PX - 1, to: 160, target: document.body, dropY: 0 });

      expect(probe.navigations).toEqual([]);
    });

    it("keeps the leading zone 32px wide rather than widening it by the inset", () => {
      const probe = withInsets();

      // Past 60 + 32. A recognizer that added the inset to the WIDTH instead of
      // the origin would claim this touch.
      swipe({ from: INSET_PX + 40, to: 200, target: document.body, dropY: 0 });

      expect(probe.navigations).toEqual([]);
    });

    it("moves the trailing zone inboard by the right inset", () => {
      const probe = withInsets();

      swipe({
        from: VIEWPORT_PX - INSET_PX - 8,
        to: 200,
        target: document.body,
        dropY: 0,
      });

      expect(probe.navigations).toEqual(["forward"]);
    });

    it("refuses a pointer that lands past where the app surface ends", () => {
      const probe = withInsets();

      swipe({
        from: VIEWPORT_PX - INSET_PX + 1,
        to: 200,
        target: document.body,
        dropY: 0,
      });

      expect(probe.navigations).toEqual([]);
    });
  });

  /**
   * What activation leads to. The recognizer asks whether anything can follow
   * the finger and spends the rest of the pointer accordingly - carrying a
   * drag to its release, or making the step there and then. Both answers come
   * out of the same activation, so the cases live together.
   */
  describe("a drag something can follow", () => {
    function press(clientX: number, timeStamp: number): void {
      dispatchPointer("pointerdown", {
        clientX,
        clientY: 300,
        target: document.body,
        timeStamp,
        pointerId: 1,
        isPrimary: true,
      });
    }

    function move(clientX: number, timeStamp: number): void {
      dispatchPointer("pointermove", {
        clientX,
        clientY: 300,
        target: document.body,
        timeStamp,
        pointerId: 1,
        isPrimary: true,
      });
    }

    function lift(
      type: "pointerup" | "pointercancel",
      timeStamp: number,
    ): void {
      dispatchPointer(type, {
        clientX: 160,
        clientY: 300,
        target: document.body,
        timeStamp,
        pointerId: 1,
        isPrimary: true,
      });
    }

    it("hands the drag over instead of navigating, when one can be followed", () => {
      const probe = mountWithFollowingTransition();

      press(8, 0);
      move(60, 100);

      expect(probe.dragStarts).toEqual(["back"]);
      expect(probe.navigations).toEqual([]);
      expect(probe.dragTravel).toEqual([52]);
    });

    // The step is made at activation only because nothing could carry it. The
    // recognizer asks first either way, which is what keeps one activation
    // rule behind both outcomes.
    it("makes the step at activation when nothing can follow it", () => {
      const probe = mountOnBareScreen();

      press(8, 0);
      move(60, 100);

      expect(probe.dragStarts).toEqual(["back"]);
      expect(probe.navigations).toEqual(["back"]);
      expect(probe.dragTravel).toEqual([]);
    });

    // The third answer. A declined gesture is CONSUMED - no follow, and no
    // instant step either: the decliner is a navigation already in flight,
    // and falling back to a discrete step would fire a second navigation
    // under layers still showing the first.
    it("consumes the gesture entirely when the transition declines it", () => {
      setMobileApp(true);
      const probe = mountSwipe({
        edgesClaimed: NOTHING_CLAIMED,
        response: "decline",
      });

      press(8, 0);
      move(60, 100);
      move(160, 200);
      lift("pointerup", 300);

      expect(probe.dragStarts).toEqual(["back"]);
      expect(probe.navigations).toEqual([]);
      expect(probe.dragTravel).toEqual([]);
      expect(probe.releases).toEqual([]);
    });

    it("reports travel for the whole drag rather than only its activation", () => {
      const probe = mountWithFollowingTransition();

      press(8, 0);
      move(60, 100);
      move(110, 200);
      move(160, 300);

      expect(probe.dragTravel).toEqual([52, 102, 152]);
      expect(probe.dragStarts).toEqual(["back"]);
    });

    // The trailing edge, exercised end to end. The followed-drag path inverts
    // travel for a forward swipe in two places, and a block that only ever
    // presses at the leading edge would pass with a sign error in either -
    // one direction covered and the other assumed is the exact shape of the
    // defect this feature shipped with.
    it("follows a forward drag from the trailing edge, travel inward-positive", () => {
      const probe = mountWithFollowingTransition();

      press(VIEWPORT_PX - 8, 0);
      move(VIEWPORT_PX - 60, 100);
      move(VIEWPORT_PX - 110, 200);
      move(VIEWPORT_PX - 160, 300);
      dispatchPointer("pointerup", {
        clientX: VIEWPORT_PX - 160,
        clientY: 300,
        target: document.body,
        timeStamp: 400,
        pointerId: 1,
        isPrimary: true,
      });

      expect(probe.dragStarts).toEqual(["forward"]);
      expect(probe.navigations).toEqual([]);
      expect(probe.dragTravel).toEqual([52, 102, 152]);
      // Velocity is the last move-pair's 500 px/s; the up sat still at a
      // later timestamp, so the last real sample stands.
      expect(probe.releases).toEqual([
        { travelPx: 152, velocityPxPerS: 500, cancelled: false },
      ]);
    });

    // DIRECTION LOCK, the axis half: past activation the classifier is never
    // consulted again, so a drag that curves sharply downward afterwards is
    // still this gesture's - a thumb arcing across a phone does not travel a
    // straight line, and re-classifying mid-drag would drop the screen it is
    // carrying.
    it("keeps a followed drag that curves off-axis after activation", () => {
      const probe = mountWithFollowingTransition();

      press(8, 0);
      move(60, 100);
      // Far more vertical than horizontal from here - travel that would have
      // failed the classifier had it still been asked.
      dispatchPointer("pointermove", {
        clientX: 70,
        clientY: 460,
        target: document.body,
        timeStamp: 200,
        pointerId: 1,
        isPrimary: true,
      });
      lift("pointerup", 300);

      expect(probe.dragTravel).toEqual([52, 62]);
      expect(probe.releases).toHaveLength(1);
    });

    // A release is judged on what the hand was doing when it let go, so the
    // speed comes from the last move rather than from the gesture's average -
    // the difference between a long slow drag finished with a flick and the
    // drag it mostly was.
    it("releases with the speed of the last move", () => {
      const probe = mountWithFollowingTransition();

      press(8, 0);
      // Activation, then 200ms crawling 20px, then 100ms covering 80. The
      // average over the followed drag is 333 px/s; the flick it ended on is
      // 800, and 800 is what a release means.
      move(60, 100);
      move(80, 300);
      move(160, 400);
      lift("pointerup", 400);

      expect(probe.releases).toEqual([
        { travelPx: 152, velocityPxPerS: 800, cancelled: false },
      ]);
    });

    // Precision-clamped event clocks hand samples dispatched together the
    // SAME timestamp. Ground covered is ground covered regardless: the up's
    // travel must count even at a tied clock, while the speed - underivable
    // over zero elapsed - stands at the last real sample.
    it("counts the up's travel even when its timestamp ties the last move", () => {
      const probe = mountWithFollowingTransition();

      press(8, 0);
      move(60, 100);
      dispatchPointer("pointerup", {
        clientX: 200,
        clientY: 300,
        target: document.body,
        timeStamp: 100,
        pointerId: 1,
        isPrimary: true,
      });

      // Travel is the up's 192; velocity is the activation seed (52px/100ms),
      // the last sample with real elapsed time behind it.
      expect(probe.releases).toEqual([
        { travelPx: 192, velocityPxPerS: 520, cancelled: false },
      ]);
    });

    // The hand does not stop moving when it leaves the glass: a fast swipe
    // covers real ground between the last delivered move and the up, and a
    // release judged on the move's numbers alone would refuse a flick that
    // crossed the threshold on its way out.
    it("judges the release on the ground the up itself covered", () => {
      const probe = mountWithFollowingTransition();

      press(8, 0);
      move(60, 100);
      dispatchPointer("pointerup", {
        clientX: 140,
        clientY: 300,
        target: document.body,
        timeStamp: 200,
        pointerId: 1,
        isPrimary: true,
      });

      expect(probe.releases).toEqual([
        { travelPx: 132, velocityPxPerS: 800, cancelled: false },
      ]);
    });

    it("reports a release the system took as cancelled", () => {
      const probe = mountWithFollowingTransition();

      press(8, 0);
      move(60, 100);
      lift("pointercancel", 200);

      // 520 is the activation seed - 52px over the 100ms it took to activate.
      // It is reported faithfully even here; cancellation beats velocity in
      // the release rule, so nothing downstream may read it as intent.
      expect(probe.releases).toEqual([
        { travelPx: 52, velocityPxPerS: 520, cancelled: true },
      ]);
    });

    // A flick fast enough to activate on its only move and release in place
    // has exactly one speed sample: the ground covered reaching activation.
    // Judged at zero it would spring back - punishing precisely the quickest
    // gestures.
    it("commits a flick whose only sample is the activating move", () => {
      const probe = mountWithFollowingTransition();

      press(8, 0);
      move(60, 50);
      dispatchPointer("pointerup", {
        clientX: 60,
        clientY: 300,
        target: document.body,
        timeStamp: 60,
        pointerId: 1,
        isPrimary: true,
      });

      // 52px over 50ms: a 1040 px/s flick, far past the commit threshold
      // despite travel far short of the distance rule.
      expect(probe.releases).toEqual([
        { travelPx: 52, velocityPxPerS: 1040, cancelled: false },
      ]);
    });

    // DIRECTION LOCK. A surface arriving mid-flight takes the edges from the
    // NEXT gesture; it cannot take a screen out from under a finger already
    // carrying one, which would strand the transition with nothing to move it.
    it("keeps a followed drag when a blocking surface arrives mid-flight", () => {
      setMobileApp(true);
      let claimed = false;
      const probe = mountSwipe({
        edgesClaimed: () => claimed,
        response: "follow",
      });

      press(8, 0);
      move(60, 100);
      claimed = true;
      move(160, 200);
      lift("pointerup", 200);

      expect(probe.dragTravel).toEqual([52, 152]);
      expect(probe.releases).toEqual([
        { travelPx: 152, velocityPxPerS: 1000, cancelled: false },
      ]);
    });

    // A second finger is a pinch or a two-finger pan, and the tracked pointer's
    // coordinates stop describing the gesture. The drag did not choose to end,
    // so it ends the way the system ending it would.
    it("cancels a followed drag when a second pointer lands", () => {
      const probe = mountWithFollowingTransition();

      press(8, 0);
      move(60, 100);
      dispatchPointer("pointerdown", {
        clientX: 300,
        clientY: 300,
        target: document.body,
        timeStamp: 150,
        pointerId: 2,
        isPrimary: false,
      });

      expect(probe.releases).toEqual([
        { travelPx: 52, velocityPxPerS: 520, cancelled: true },
      ]);
    });

    // Nothing is left holding a screen it can no longer move.
    it("cancels a followed drag when the recognizer is torn down", () => {
      setMobileApp(true);
      const probe = mountSwipe({
        edgesClaimed: NOTHING_CLAIMED,
        response: "follow",
      });

      press(8, 0);
      move(60, 100);
      for (const unmount of activeUnmounts.splice(0)) unmount();

      expect(probe.releases).toEqual([
        { travelPx: 52, velocityPxPerS: 520, cancelled: true },
      ]);
    });
  });
});
