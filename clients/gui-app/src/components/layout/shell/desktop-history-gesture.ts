import { desktopHistoryLayerBlocksNavigation } from "./desktop-history-gesture-ownership";
import { ownsDesktopHorizontalWheel } from "./desktop-history-gesture-ownership";

export { ownsDesktopHorizontalWheel } from "./desktop-history-gesture-ownership";

export type DesktopHistoryDirection = "back" | "forward";

export interface DesktopHistoryGestureView {
  readonly direction: DesktopHistoryDirection;
  readonly progress: number;
  readonly phase: "pulling" | "ready" | "canceling" | "committed";
}

/**
 * Finger-sequence transitions from the shell (macOS NSEvent scroll phase).
 * The DOM `wheel` stream has no finger-up: Chromium strips the phase, macOS
 * sends no end tick (measured: none across ~1900 real trackpad ticks), and
 * Electron's main-process wheel event carries deltas only. This source is the
 * missing half, and the gesture is not installed without it.
 */
export type DesktopHistoryFingerTransition =
  | "began"
  | "ended"
  | "cancelled"
  | "momentum-began"
  | "momentum-ended"
  | "momentum-cancelled";

export interface DesktopHistoryFingerSource {
  onTransition(
    handler: (transition: {
      readonly kind: DesktopHistoryFingerTransition;
    }) => void,
  ): { dispose: () => void };
}

interface DesktopHistoryGestureOptions {
  readonly destination: (direction: DesktopHistoryDirection) => string | null;
  readonly currentEntry: () => string;
  readonly navigate: (direction: DesktopHistoryDirection) => void;
  readonly render: (view: DesktopHistoryGestureView | null) => void;
  readonly fingers: DesktopHistoryFingerSource;
}

// Two inputs, one gesture. Wheel ticks carry the deltas and know which element
// is under the pointer, so they drive ownership, progress and the scroll
// cancel. Finger transitions say when the sequence starts and stops, so the
// LIFT is the confirmation: a pull past `commitPx` commits on `ended`, a pull
// that stops short retracts on `ended`, and a finger resting on the trackpad
// holds the preview for as long as it rests. Momentum after a lift is drained,
// swallowed after a claimed gesture and left to scroll after content.
//
// Keep the feel constants together so trackpad trials can tune them.
// These are wheel deltas, not the mobile recognizer's finger travel: require a
// stronger horizontal bias to keep trackpad scroll jitter out of navigation.
// Unmodified pixel-mode wheel is the input contract, including compatible
// horizontal mice. Wheel deltas cannot reliably identify a finger count.
export const DESKTOP_HISTORY_GESTURE = {
  intentPx: 12,
  axisRatio: 1.8,
  commitPx: 180,
  maxTravelPx: 240,
  settleMs: 220,
  tailMs: 300,
  // Safety net only, never the mechanism: a sequence whose lift never arrives
  // (a mouse wheel has no phases; a transition can be lost) is let go after
  // this much silence, and a live pull is cancelled, never committed.
  idleCancelMs: 800,
} as const;

interface WheelSequence {
  ownership: "pending" | "content" | "navigation" | "draining";
  /** A drained tail is swallowed after a claimed gesture and scrolls after content. */
  consumeTail: boolean;
  x: number;
  y: number;
  travel: number;
  direction: DesktopHistoryDirection;
  destination: string | null;
  readonly origin: string;
}

function modifiedWheel(event: WheelEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
}

function blocksNavigation(event: WheelEvent): boolean {
  return (
    modifiedWheel(event) ||
    event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
    // Only earlier native capture listeners can have canceled at this point;
    // React/element wheel handlers run later and must declare an owner marker.
    event.defaultPrevented ||
    desktopHistoryLayerBlocksNavigation()
  );
}

function advanceSequence(
  sequence: WheelSequence,
  event: WheelEvent,
  destination: DesktopHistoryGestureOptions["destination"],
): boolean {
  if (sequence.ownership !== "pending") {
    const inward = sequence.direction === "back" ? -event.deltaX : event.deltaX;
    sequence.travel = Math.max(
      0,
      Math.min(DESKTOP_HISTORY_GESTURE.maxTravelPx, sequence.travel + inward),
    );
    return true;
  }
  sequence.x += event.deltaX;
  sequence.y += Math.abs(event.deltaY);
  const x = Math.abs(sequence.x);
  if (sequence.y >= DESKTOP_HISTORY_GESTURE.intentPx && sequence.y >= x) {
    sequence.ownership = "content";
    return false;
  }
  if (
    x < DESKTOP_HISTORY_GESTURE.intentPx ||
    x < sequence.y * DESKTOP_HISTORY_GESTURE.axisRatio
  )
    return false;
  sequence.direction = sequence.x < 0 ? "back" : "forward";
  sequence.destination = destination(sequence.direction);
  if (sequence.destination === null || !event.cancelable) {
    sequence.ownership = "content";
    return false;
  }
  sequence.ownership = "navigation";
  sequence.travel = Math.min(x, DESKTOP_HISTORY_GESTURE.maxTravelPx);
  return true;
}

/** One window's recognizer; the renderer owns the history semantics. */
export function installDesktopHistoryGesture(
  options: DesktopHistoryGestureOptions,
): () => void {
  let sequence: WheelSequence | null = null;
  let tailTimer: number | undefined;
  let idleTimer: number | undefined;
  let settleTimer: number | undefined;
  const clearIdle = (): void => window.clearTimeout(idleTimer);
  const reset = (): void => {
    clearIdle();
    window.clearTimeout(tailTimer);
    window.clearTimeout(settleTimer);
    if (sequence === null) return;
    sequence = null;
    options.render(null);
  };
  // The tail is whatever the same finger sequence still delivers after the
  // decision: momentum ticks, or nothing. It ends on `momentum-ended` or on
  // silence, and no new gesture is admitted until it has.
  const armTail = (): void => {
    window.clearTimeout(tailTimer);
    tailTimer = window.setTimeout(reset, DESKTOP_HISTORY_GESTURE.tailMs);
  };
  const settle = (commit: boolean): void => {
    if (sequence === null || sequence.ownership !== "navigation") return;
    clearIdle();
    const direction = sequence.direction;
    sequence.ownership = "draining";
    sequence.consumeTail = true;
    options.render({
      direction,
      progress: commit
        ? 1
        : Math.min(1, sequence.travel / DESKTOP_HISTORY_GESTURE.commitPx),
      phase: commit ? "committed" : "canceling",
    });
    settleTimer = window.setTimeout(
      () => options.render(null),
      DESKTOP_HISTORY_GESTURE.settleMs,
    );
    armTail();
    // Set draining BEFORE navigating: history subscribers may synchronously
    // cancel the gesture when the route changes. A completed step is one step.
    if (commit) options.navigate(direction);
  };
  const cancel = (): void => {
    if (sequence?.ownership === "navigation") settle(false);
    else if (sequence?.ownership !== "draining") reset();
  };
  const idle = (): void => {
    if (sequence?.ownership === "navigation") settle(false);
    else if (sequence?.ownership !== "draining") reset();
  };
  const armIdle = (): void => {
    clearIdle();
    idleTimer = window.setTimeout(idle, DESKTOP_HISTORY_GESTURE.idleCancelMs);
  };
  // The finger left the trackpad: the one moment the pull is decided.
  const lift = (mayCommit: boolean): void => {
    if (sequence === null) return;
    if (sequence.ownership === "navigation") {
      settle(
        mayCommit &&
          sequence.travel >= DESKTOP_HISTORY_GESTURE.commitPx &&
          !desktopHistoryLayerBlocksNavigation() &&
          sequence.origin === options.currentEntry() &&
          sequence.destination === options.destination(sequence.direction),
      );
      return;
    }
    if (sequence.ownership === "draining") return;
    // A content scroll or an undecided start: its momentum must scroll, and
    // must not open a gesture of its own.
    clearIdle();
    sequence.ownership = "draining";
    sequence.consumeTail = false;
    armTail();
  };
  const onTransition = (transition: {
    readonly kind: DesktopHistoryFingerTransition;
  }): void => {
    switch (transition.kind) {
      case "began":
        // Fresh fingers end whatever tail was still draining. A live sequence
        // is left alone: its first tick can outrun this transition.
        if (sequence?.ownership === "draining") reset();
        return;
      case "ended":
        lift(true);
        return;
      case "cancelled":
        lift(false);
        return;
      case "momentum-began":
        return;
      case "momentum-ended":
      case "momentum-cancelled":
        if (sequence?.ownership === "draining") reset();
        return;
    }
  };
  const updateView = (): void => {
    if (sequence === null) return;
    const progress = Math.min(
      1,
      sequence.travel / DESKTOP_HISTORY_GESTURE.commitPx,
    );
    options.render({
      direction: sequence.direction,
      progress,
      phase: progress >= 1 ? "ready" : "pulling",
    });
  };
  const consume = (event: WheelEvent): void => {
    if (event.cancelable) event.preventDefault();
    // xterm and custom scrollers have their own wheel listeners. A claimed
    // horizontal gesture must not also deliver its diagonal noise to them.
    event.stopImmediatePropagation();
  };
  const onWheel = (event: WheelEvent): void => {
    if (event.deltaX === 0 && event.deltaY === 0) return;
    if (sequence?.ownership === "draining") {
      if (
        sequence.consumeTail &&
        Math.abs(event.deltaX) > Math.abs(event.deltaY) &&
        !modifiedWheel(event)
      )
        consume(event);
      armTail();
      return;
    }
    const blocked = blocksNavigation(event);
    if (sequence === null) {
      sequence = {
        ownership:
          blocked ||
          ownsDesktopHorizontalWheel(event.composedPath()[0] ?? event.target)
            ? "content"
            : "pending",
        consumeTail: false,
        x: 0,
        y: 0,
        travel: 0,
        direction: "back",
        destination: null,
        origin: options.currentEntry(),
      };
      // Chromium lets a page cancel only the FIRST wheel event of a scroll
      // sequence (wheel scroll latching, Chrome 65+): once that one passes
      // uncanceled, every later event of the same swipe arrives with
      // `cancelable === false`, and `advanceSequence` must then yield to
      // content. A trackpad's first tick carries under a pixel, far short of
      // `intentPx`, so a recognizer that decides late forfeits every real
      // swipe (measured on a MacBook: 9 of 350 events cancelable, all of them
      // first ticks). Cancel that first tick whenever there is somewhere to
      // navigate; a scroll that follows loses only that sub-pixel tick.
      if (
        sequence.ownership === "pending" &&
        event.cancelable &&
        (options.destination("back") !== null ||
          options.destination("forward") !== null)
      )
        event.preventDefault();
    }
    if (blocked || sequence.origin !== options.currentEntry()) {
      if (sequence.ownership === "navigation") {
        settle(false);
        return;
      }
      sequence.ownership = "content";
    }
    armIdle();
    if (sequence.ownership === "content") return;
    if (!advanceSequence(sequence, event, options.destination)) return;
    consume(event);
    updateView();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (sequence?.ownership !== "navigation") return;
    // Escape cancels the preview only, not the Settings route underneath it.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    cancel();
  };
  const onVisibility = (): void => {
    if (document.hidden) cancel();
  };
  const fingers = options.fingers.onTransition(onTransition);
  document.addEventListener("wheel", onWheel, {
    capture: true,
    passive: false,
  });
  document.addEventListener("pointerdown", cancel, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", cancel);
  window.addEventListener("resize", cancel);
  return () => {
    reset();
    fingers.dispose();
    document.removeEventListener("wheel", onWheel, true);
    document.removeEventListener("pointerdown", cancel, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("resize", cancel);
  };
}
