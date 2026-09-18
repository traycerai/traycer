import { desktopHistoryLayerBlocksNavigation } from "./desktop-history-gesture-ownership";
import { ownsDesktopHorizontalWheel } from "./desktop-history-gesture-ownership";
export { ownsDesktopHorizontalWheel } from "./desktop-history-gesture-ownership";

export type DesktopHistoryDirection = "back" | "forward";

export interface DesktopHistoryGestureView {
  readonly direction: DesktopHistoryDirection;
  readonly progress: number;
  readonly phase: "pulling" | "ready" | "canceling" | "committed";
}

interface DesktopHistoryGestureOptions {
  readonly destination: (direction: DesktopHistoryDirection) => string | null;
  readonly currentEntry: () => string;
  readonly navigate: (direction: DesktopHistoryDirection) => void;
  readonly render: (view: DesktopHistoryGestureView | null) => void;
}

// Wheel input has no portable finger-up or momentum phase. Treat an input
// pause as release, then drain the tail before admitting another gesture.
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
  releaseMs: 160,
  settleMs: 220,
  tailMs: 300,
} as const;

interface WheelSequence {
  ownership: "pending" | "content" | "navigation" | "draining";
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

/** One window's wheel recognizer; the renderer owns the history semantics. */
export function installDesktopHistoryGesture(
  options: DesktopHistoryGestureOptions,
): () => void {
  let sequence: WheelSequence | null = null;
  let releaseTimer: number | undefined;
  let settleTimer: number | undefined;

  const clearRelease = (): void => window.clearTimeout(releaseTimer);
  const reset = (): void => {
    clearRelease();
    window.clearTimeout(settleTimer);
    if (sequence === null) return;
    sequence = null;
    options.render(null);
  };
  const drain = (): void => {
    clearRelease();
    releaseTimer = window.setTimeout(reset, DESKTOP_HISTORY_GESTURE.tailMs);
  };
  const settle = (commit: boolean): void => {
    if (sequence === null || sequence.ownership !== "navigation") return;
    const direction = sequence.direction;
    sequence.ownership = "draining";
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
    drain();
    // Set draining BEFORE navigating: history subscribers may synchronously
    // cancel the gesture when the route changes. A completed step is one step.
    if (commit) options.navigate(direction);
  };
  const cancel = (): void => {
    if (sequence?.ownership === "navigation") settle(false);
    else if (sequence?.ownership !== "draining") reset();
  };
  const finish = (): void => {
    if (sequence?.ownership !== "navigation") {
      reset();
      return;
    }
    settle(
      sequence.travel >= DESKTOP_HISTORY_GESTURE.commitPx &&
        !desktopHistoryLayerBlocksNavigation() &&
        sequence.origin === options.currentEntry() &&
        sequence.destination === options.destination(sequence.direction),
    );
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
    clearRelease();
    if (sequence?.ownership === "draining") {
      if (
        Math.abs(event.deltaX) > Math.abs(event.deltaY) &&
        !modifiedWheel(event)
      )
        consume(event);
      drain();
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
        x: 0,
        y: 0,
        travel: 0,
        direction: "back",
        destination: null,
        origin: options.currentEntry(),
      };
    }
    if (blocked || sequence.origin !== options.currentEntry()) {
      if (sequence.ownership === "navigation") {
        settle(false);
        return;
      }
      sequence.ownership = "content";
    }
    releaseTimer = window.setTimeout(finish, DESKTOP_HISTORY_GESTURE.releaseMs);
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
    document.removeEventListener("wheel", onWheel, true);
    document.removeEventListener("pointerdown", cancel, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("resize", cancel);
  };
}
