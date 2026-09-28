import {
  MAX_SPRING_STEP_SECONDS,
  RING_SPRING,
  Spring,
} from "@/components/layout-editor/canvas/spring";
import { prefersReducedMotion } from "@/lib/layout/editor-motion";

/**
 * The one selection ring, which travels between regions (L-29, 4.6).
 *
 * One element and one rAF loop for the whole editor, rather than a ring per
 * region: the point of the travel is that the SAME object moves, and two rings
 * cross-fading is a different, cheaper-looking thing.
 *
 * It is the one piece of the editor that still measures rects, because a CSS
 * outline cannot animate from one element's box to another's. Everything else
 * about selection is a data attribute (L-13).
 *
 * ## Why the loop never parks (L-90)
 *
 * The loop runs for as long as a region is selected and re-reads the tracked
 * rect every frame. It used to park once the springs settled and be woken by a
 * LIST - a `ResizeObserver` on the node, window `scroll` and `resize`, a preset
 * preview, a layout-store write - and the owner found the hole in that list
 * live: switching the inspector's dock side writes the EDITOR store and moves
 * the app column 380px sideways without resizing anything, so none of the four
 * fired and the ring stayed at its old viewport coordinates, drawn around the
 * inspector's "Discard changes".
 *
 * A dock switch is not a special case, it is the first one noticed. A float
 * toggle, a float edge-snap, a ghost materialising beside the selection, the
 * inspector arriving or leaving and the region's own host remounting all move
 * a box without resizing it and without passing through either store. Reading
 * the rect is the only mechanism under which none of them has to be enumerated,
 * and it is what the approved prototype does (`startRingLoop`).
 *
 * The G1-04 budget this replaced a wake list to protect is still honoured, and
 * measured rather than assumed: a frame on which the target has not moved and
 * the springs have arrived costs exactly ONE `getBoundingClientRect` and writes
 * nothing - no spring step, no style write, no reduced-motion read.
 */

/** Clears the region's own edge without swallowing its neighbours. */
const RING_PADDING = 3;

/**
 * How far the widest band paints OUTSIDE the ring's own box: the halo's spread
 * in `layout-editor.css`.
 *
 * The ring is a `box-shadow`, so the thing the user sees is 6px larger on every
 * side than the box measured here - which is why a box that merely touches the
 * window edge is already clipped (LV2-16).
 */
const RING_BLEED = 6;

/** The ring's own box in viewport pixels, which is the rect plus the padding. */
interface RingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SelectionRingController {
  /**
   * The node the ring should be on now, or `null` to put it away.
   *
   * Identity-guarded: called with the node it is already on, it does nothing.
   * The canvas painter runs on every editor-store notification, and a re-track
   * that restarted the travel would make a hover or a filter keystroke
   * re-animate a ring that is already where it belongs.
   */
  readonly track: (node: HTMLElement | null) => void;
  readonly destroy: () => void;
}

export function createSelectionRing(): SelectionRingController {
  const element = document.createElement("div");
  element.setAttribute("data-layout-selection-ring", "");
  element.setAttribute("aria-hidden", "true");
  element.hidden = true;
  document.body.append(element);

  const springs = {
    x: new Spring(0, RING_SPRING.response, RING_SPRING.zeta),
    y: new Spring(0, RING_SPRING.response, RING_SPRING.zeta),
    width: new Spring(0, RING_SPRING.response, RING_SPRING.zeta),
    height: new Spring(0, RING_SPRING.response, RING_SPRING.zeta),
  };

  let tracked: HTMLElement | null = null;
  let frame = 0;
  let lastFrameAt = 0;
  // The first frame on a fresh selection places the ring without travelling
  // to it from wherever it last was, and fades it in instead.
  let fresh = true;
  /** The box the springs are aiming at, and the one an idle frame compares to. */
  let aim: RingBox | null = null;
  /** Whether `data-on` is on the element, which is what fades it in. */
  let lit = false;

  function start(): void {
    if (tracked === null || frame !== 0) return;
    lastFrameAt = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    const node = tracked;
    if (node === null) {
      frame = 0;
      return;
    }
    const step = Math.min((now - lastFrameAt) / 1000, MAX_SPRING_STEP_SECONDS);
    lastFrameAt = now;
    // Scheduled before the work, so the loop survives every early return below
    // and `cancel()` still has a frame id to take back.
    frame = requestAnimationFrame(tick);

    const rect = node.getBoundingClientRect();
    const target = insideWindow({
      x: rect.left - RING_PADDING,
      y: rect.top - RING_PADDING,
      width: rect.width + RING_PADDING * 2,
      height: rect.height + RING_PADDING * 2,
    });
    // Nothing has moved, the ring has arrived and it is already lit: the rect
    // above is the whole cost of this frame.
    if (lit && aim !== null && sameBox(aim, target) && settled()) return;
    aim = target;

    if (fresh || prefersReducedMotion()) {
      springs.x.snap(target.x);
      springs.y.snap(target.y);
      springs.width.snap(target.width);
      springs.height.snap(target.height);
    } else {
      springs.x.setTarget(target.x);
      springs.y.setTarget(target.y);
      springs.width.setTarget(target.width);
      springs.height.setTarget(target.height);
      springs.x.step(step);
      springs.y.step(step);
      springs.width.step(step);
      springs.height.step(step);
    }

    element.style.transform = `translate(${springs.x.value.toFixed(2)}px, ${springs.y.value.toFixed(2)}px)`;
    element.style.width = `${Math.max(0, springs.width.value).toFixed(2)}px`;
    element.style.height = `${Math.max(0, springs.height.value).toFixed(2)}px`;
    element.hidden = false;

    if (fresh) {
      // One frame with the ring placed but still transparent, so the opacity
      // transition has something to run from.
      fresh = false;
      return;
    }
    lit = true;
    element.setAttribute("data-on", "1");
  }

  function settled(): boolean {
    return (
      springs.x.settled() &&
      springs.y.settled() &&
      springs.width.settled() &&
      springs.height.settled()
    );
  }

  function track(node: HTMLElement | null): void {
    if (node === tracked) return;
    tracked = node;
    if (node === null) {
      cancel();
      element.removeAttribute("data-on");
      element.hidden = true;
      fresh = true;
      lit = false;
      aim = null;
      return;
    }
    start();
  }

  function cancel(): void {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  }

  return {
    track,
    destroy: () => {
      cancel();
      element.remove();
      tracked = null;
    },
  };
}

/**
 * The ring with every band it paints inside the window (LV2-16).
 *
 * Regions sit on the window's last pixel row - the status bar's usage row is
 * one - so a padded box plus the halo's bleed puts the bottom band off screen,
 * where the browser clips it and the selection reads as an open box rather
 * than as a ring.
 *
 * Shrunk rather than moved: the ring says WHICH element is selected, so every
 * edge it can show stays on the element's own edge. A region that has left the
 * window entirely keeps its true box and travels off screen as before - there
 * is nothing there to frame, and a collapsed box would draw a bar against the
 * edge instead.
 */
function insideWindow(box: RingBox): RingBox {
  const left = Math.max(box.x, RING_BLEED);
  const top = Math.max(box.y, RING_BLEED);
  const right = Math.min(box.x + box.width, window.innerWidth - RING_BLEED);
  const bottom = Math.min(box.y + box.height, window.innerHeight - RING_BLEED);
  if (right <= left || bottom <= top) return box;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function sameBox(left: RingBox, right: RingBox): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
