import type {
  DesktopTrackpadScrollEvent,
  DesktopTrackpadScrollPhaseBridge,
} from "@/lib/windows/types";
import {
  desktopHistoryLayerBlocksNavigation,
  ownsDesktopHorizontalWheel,
} from "./desktop-history-gesture-ownership";

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
  /**
   * Every pull ends in exactly one `committed` or `canceling` view; the view
   * owns the exit timing from there.
   */
  readonly render: (view: DesktopHistoryGestureView) => void;
  readonly trackpad: DesktopTrackpadScrollPhaseBridge;
}

// One ordered stream decides. The shell's trackpad stream carries phase and
// deltas together (macOS NSEvent), so the recognizer never has to guess
// whether a tick belongs to the fingers that just lifted or the fingers that
// just landed. The LIFT is the confirmation: a pull past `commitPx`, or a
// flick, commits on `ended`; anything shorter retracts; fingers resting on
// the trackpad hold the preview. Momentum after a lift is swallowed after a
// claimed gesture and left to scroll after content.
//
// The DOM `wheel` stream has two jobs only: it names the element under the
// pointer (ownership) and it is where content scrolling is suppressed.
//
// Keep the feel constants together so trackpad trials can tune them. These
// are finger pixels, not the mobile recognizer's touch travel: a stronger
// horizontal bias keeps trackpad scroll jitter out of navigation.
export const DESKTOP_HISTORY_GESTURE = {
  intentPx: 12,
  axisRatio: 1.8,
  commitPx: 180,
  maxTravelPx: 240,
  // A flick: a short, fast pull that lifts before `commitPx`. Measured over
  // the last `flickWindowMs` before the lift, from the trackpad's own
  // timestamps. Set `flickPxPerMs` to Infinity to commit on distance only.
  flickMinPx: 60,
  flickPxPerMs: 0.9,
  flickWindowMs: 100,
  settleMs: 220,
  tailMs: 300,
} as const;

interface PendingSequence {
  readonly stage: "pending";
  x: number;
  y: number;
  readonly origin: string;
  /** DOM ticks seen when the fingers landed; the window being scrolled sees more. */
  readonly domTicksAtBegan: number;
}

interface NavigationSequence {
  readonly stage: "navigation";
  readonly direction: DesktopHistoryDirection;
  readonly destination: string;
  readonly origin: string;
  travel: number;
  /** Inward travel per tick, trackpad timestamps in seconds; feeds the flick rule. */
  readonly recent: Array<{ readonly at: number; readonly inward: number }>;
}

interface ContentSequence {
  readonly stage: "content";
}

interface DrainingSequence {
  readonly stage: "draining";
  /** A drained tail is swallowed after a claimed gesture and scrolls after content. */
  readonly consume: boolean;
}

type Sequence =
  | PendingSequence
  | NavigationSequence
  | ContentSequence
  | DrainingSequence;

function modifiedWheel(event: WheelEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
}

function wheelBlocksNavigation(event: WheelEvent): boolean {
  return (
    modifiedWheel(event) ||
    event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
    // Only earlier native capture listeners can have canceled at this point;
    // React/element wheel handlers run later and must declare an owner marker.
    event.defaultPrevented ||
    desktopHistoryLayerBlocksNavigation()
  );
}

function flicked(sequence: NavigationSequence): boolean {
  if (sequence.travel < DESKTOP_HISTORY_GESTURE.flickMinPx) return false;
  const last = sequence.recent.at(-1);
  if (last === undefined) return false;
  const windowStart = last.at - DESKTOP_HISTORY_GESTURE.flickWindowMs / 1000;
  let inward = 0;
  let first = last.at;
  for (const sample of sequence.recent) {
    if (sample.at < windowStart) continue;
    inward += sample.inward;
    first = Math.min(first, sample.at);
  }
  const elapsedMs = (last.at - first) * 1000;
  // One tick has no velocity.
  if (elapsedMs < 8) return false;
  return inward / elapsedMs >= DESKTOP_HISTORY_GESTURE.flickPxPerMs;
}

/** One window's recognizer; the renderer owns the history semantics. */
export function installDesktopHistoryGesture(
  options: DesktopHistoryGestureOptions,
): () => void {
  let sequence: Sequence | null = null;
  // What the DOM wheel stream last reported. `domArmed` means this sequence's
  // opening tick was canceled, so Chromium keeps every later tick cancelable
  // (wheel scroll latching, Chrome 65+); without it a claimed gesture could
  // not stop the page from scrolling too.
  let domTicks = 0;
  let domTarget: EventTarget | null = null;
  let domTickAlreadyCanceled = false;
  let domArmed = false;
  let tailTimer: number | undefined;

  /** Only ever reached after `cancel()`, so no live pull is dropped unseen. */
  const reset = (): void => {
    window.clearTimeout(tailTimer);
    domArmed = false;
    sequence = null;
  };
  // The tail is whatever the same finger sequence still delivers after the
  // lift: momentum ticks, or nothing. With momentum it ends on
  // `momentum-ended`; without, on silence.
  const armTail = (): void => {
    window.clearTimeout(tailTimer);
    tailTimer = window.setTimeout(reset, DESKTOP_HISTORY_GESTURE.tailMs);
  };
  const settle = (commit: boolean): void => {
    if (sequence?.stage !== "navigation") return;
    const { direction, travel } = sequence;
    sequence = { stage: "draining", consume: true };
    domArmed = false;
    options.render({
      direction,
      progress: commit
        ? 1
        : Math.min(1, travel / DESKTOP_HISTORY_GESTURE.commitPx),
      phase: commit ? "committed" : "canceling",
    });
    armTail();
    // Set draining BEFORE navigating: history subscribers may synchronously
    // cancel the gesture when the route changes. A completed step is one step.
    if (commit) options.navigate(direction);
  };
  const cancel = (): void => {
    if (sequence === null) return;
    if (sequence.stage === "navigation") settle(false);
    else if (sequence.stage !== "draining") reset();
  };
  const updateView = (): void => {
    if (sequence?.stage !== "navigation") return;
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

  const begin = (): void => {
    // Fresh fingers end whatever came before: a draining tail, a content
    // sequence whose lift was lost, even a live pull.
    cancel();
    reset();
    sequence = {
      stage: "pending",
      x: 0,
      y: 0,
      origin: options.currentEntry(),
      domTicksAtBegan: domTicks,
    };
  };
  const pull = (
    live: NavigationSequence,
    event: DesktopTrackpadScrollEvent,
  ): void => {
    const inward =
      live.direction === "back" ? event.scrollingDeltaX : -event.scrollingDeltaX;
    live.travel = Math.max(
      0,
      Math.min(DESKTOP_HISTORY_GESTURE.maxTravelPx, live.travel + inward),
    );
    live.recent.push({ at: event.timestamp, inward });
    const keepFrom =
      event.timestamp - (2 * DESKTOP_HISTORY_GESTURE.flickWindowMs) / 1000;
    while (live.recent.length > 0 && live.recent[0].at < keepFrom)
      live.recent.shift();
    updateView();
  };
  /** Still pending, content, or the claimed navigation. */
  const decide = (
    pending: PendingSequence,
    event: DesktopTrackpadScrollEvent,
  ): Sequence => {
    pending.x += event.scrollingDeltaX;
    pending.y += Math.abs(event.scrollingDeltaY);
    const x = Math.abs(pending.x);
    if (pending.y >= DESKTOP_HISTORY_GESTURE.intentPx && pending.y >= x)
      return { stage: "content" };
    if (
      x < DESKTOP_HISTORY_GESTURE.intentPx ||
      x < pending.y * DESKTOP_HISTORY_GESTURE.axisRatio
    )
      return pending;
    // Every window receives the stream, but only the window under the pointer
    // receives DOM wheel ticks for it. Until one arrives this window cannot
    // name the element being scrolled, and may not be the one scrolled at all.
    if (domTicks === pending.domTicksAtBegan) return pending;
    // Revealing what is to the left is back.
    const direction: DesktopHistoryDirection =
      pending.x > 0 ? "back" : "forward";
    const destination = options.destination(direction);
    if (
      destination === null ||
      !domArmed ||
      domTickAlreadyCanceled ||
      ownsDesktopHorizontalWheel(domTarget)
    )
      return { stage: "content" };
    return {
      stage: "navigation",
      direction,
      destination,
      origin: pending.origin,
      travel: Math.min(x, DESKTOP_HISTORY_GESTURE.maxTravelPx),
      recent: [{ at: event.timestamp, inward: x }],
    };
  };
  const advance = (event: DesktopTrackpadScrollEvent): void => {
    if (sequence === null) return;
    if (sequence.stage === "content" || sequence.stage === "draining") return;
    if (
      event.modified ||
      sequence.origin !== options.currentEntry() ||
      desktopHistoryLayerBlocksNavigation()
    ) {
      if (sequence.stage === "navigation") settle(false);
      else sequence = { stage: "content" };
      return;
    }
    if (sequence.stage === "navigation") {
      pull(sequence, event);
      return;
    }
    sequence = decide(sequence, event);
    if (sequence.stage === "navigation") updateView();
  };
  // The fingers left the trackpad: the one moment the pull is decided.
  const lift = (mayCommit: boolean): void => {
    domArmed = false;
    if (sequence === null || sequence.stage === "draining") return;
    if (sequence.stage === "navigation") {
      settle(
        mayCommit &&
          (sequence.travel >= DESKTOP_HISTORY_GESTURE.commitPx ||
            flicked(sequence)) &&
          !desktopHistoryLayerBlocksNavigation() &&
          sequence.origin === options.currentEntry() &&
          sequence.destination === options.destination(sequence.direction),
      );
      return;
    }
    // A content scroll or an undecided start: its momentum must scroll, and
    // must not open a gesture of its own.
    sequence = { stage: "draining", consume: false };
    armTail();
  };
  const onTrackpad = (event: DesktopTrackpadScrollEvent): void => {
    switch (event.kind) {
      case "began":
        begin();
        return;
      case "changed":
        advance(event);
        return;
      case "ended":
        lift(true);
        return;
      case "cancelled":
        lift(false);
        return;
      case "momentum-began":
        // The drain now ends with the momentum, not with silence.
        window.clearTimeout(tailTimer);
        return;
      case "momentum-changed":
        return;
      case "momentum-ended":
      case "momentum-cancelled":
        if (sequence?.stage === "draining") reset();
        return;
    }
  };

  const consume = (event: WheelEvent): void => {
    if (event.cancelable) {
      event.preventDefault();
      domArmed = true;
    }
    // xterm and custom scrollers have their own wheel listeners. A claimed
    // horizontal gesture must not also deliver its diagonal noise to them.
    event.stopImmediatePropagation();
  };
  // Idle or pending. Chromium lets a page cancel only the FIRST wheel event of
  // a scroll sequence: once that one passes uncanceled, every later event of
  // the same swipe arrives with `cancelable === false`, and a claimed gesture
  // could no longer stop the page scrolling under it. A trackpad's first tick
  // carries under a pixel, far short of `intentPx`, so the opening tick is
  // canceled whenever there is somewhere to navigate; a scroll that follows
  // loses only that sub-pixel tick.
  const opensCancelableSequence = (event: WheelEvent): boolean =>
    !domArmed &&
    event.cancelable &&
    !wheelBlocksNavigation(event) &&
    !ownsDesktopHorizontalWheel(domTarget) &&
    (options.destination("back") !== null ||
      options.destination("forward") !== null);
  const onWheel = (event: WheelEvent): void => {
    if (event.deltaX === 0 && event.deltaY === 0) return;
    domTicks++;
    domTarget = event.composedPath()[0] ?? event.target;
    domTickAlreadyCanceled = event.defaultPrevented;
    const stage = sequence === null ? "idle" : sequence.stage;
    if (stage === "navigation") {
      consume(event);
      return;
    }
    if (stage === "draining") {
      // After a claimed gesture: its momentum, its late ticks, and the opening
      // ticks of the next sequence when they outrun its `began`, all swallowed.
      // After content: its momentum flows.
      if (
        sequence?.stage === "draining" &&
        sequence.consume &&
        Math.abs(event.deltaX) > Math.abs(event.deltaY) &&
        !modifiedWheel(event)
      )
        consume(event);
      return;
    }
    if (stage === "content") return;
    if (opensCancelableSequence(event)) {
      event.preventDefault();
      domArmed = true;
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (sequence?.stage !== "navigation") return;
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
  const trackpad = options.trackpad.onEvent(onTrackpad);
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
    cancel();
    reset();
    trackpad.dispose();
    document.removeEventListener("wheel", onWheel, true);
    document.removeEventListener("pointerdown", cancel, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("resize", cancel);
  };
}
