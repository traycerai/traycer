import {
  clampBoundsOf,
  dragAxisOf,
  dragSlotsOf,
  dragShiftOf,
  dragStarted,
  PointerVelocity,
  restingOffsetOf,
  rubberBanded,
  siblingOffsetOf,
  targetSlotOf,
  type DragAxis,
  type DragSlot,
} from "@/components/layout-editor/canvas/drag-model";
import {
  DRAG_RELEASE_SPRING,
  DRAG_SIBLING_SPRING,
  MAX_SPRING_STEP_SECONDS,
  Spring,
} from "@/components/layout-editor/canvas/spring";
import { prefersReducedMotion } from "@/lib/layout/editor-motion";

/**
 * The drag itself (4.7, L-24, L-29): one engine for the canvas and for the
 * inspector's sortable list.
 *
 * `@dnd-kit` is not used inside the editor even though the app ships it. It
 * gives a transform and a drag overlay; what L-29 asks for is 1:1 tracking from
 * the grab point, siblings reflowing on their own springs, a velocity hand-off
 * on release and a rubber band on a pinned member - none of which its sensor
 * model expresses, and three of which are the feel.
 *
 * Nothing here knows what a region or an arrangement is. It moves elements and
 * reports "member `from` ended up at `to`" once, after the transforms are
 * already gone, which is what makes a whole drag ONE history entry: the live
 * reflow is paint, and the write happens at the end or not at all.
 */

export interface LayoutDragTarget {
  /** The members, in the order they are drawn. */
  readonly items: ReadonlyArray<HTMLElement>;
  readonly index: number;
  /**
   * The box a pinned member may not leave (L-29's rubber band): the model chip
   * belongs to the right cluster, so a pull towards the left one gives a
   * quarter of the way and springs back rather than dropping it there.
   */
  readonly clamp: HTMLElement | null;
}

export interface LayoutDragInput {
  /** The press. A drag arms from it and starts only once it has travelled. */
  readonly event: PointerEvent;
  /**
   * The members, resolved at the threshold rather than at the press: between
   * the two the list may still have been settling, and a stale rect is a
   * reflow that starts in the wrong place.
   */
  readonly resolve: () => LayoutDragTarget | null;
  /** The one write a drag makes, with the transforms already cleared. */
  readonly onDrop: (fromIndex: number, toIndex: number) => void;
}

/** The lift, which says the member is off the surface and in hand (section 6). */
const LIFT_SCALE = 1.02;

/**
 * At most one drag exists at a time, across the canvas and the inspector
 * alike, and it is torn down from here: the session can end under a live
 * gesture, and a half-finished drag would leave a transform on an app element
 * it does not own.
 */
let stopActiveDrag: (() => void) | null = null;

export function layoutDragActive(): boolean {
  return stopActiveDrag !== null;
}

/** Stop wherever it is and write nothing: an exit under a live gesture. */
export function cancelLayoutDrag(): void {
  stopActiveDrag?.();
}

/**
 * Hold a press until it has travelled far enough to be a drag, then start one.
 *
 * The wait is its own phase because a press on a draggable element is also a
 * click: the canvas selects on it and the inspector's provider rows open a
 * level, and neither may be stolen by a hand that did not move.
 */
export function armLayoutDrag(input: LayoutDragInput): void {
  armLayoutGesture({
    event: input.event,
    onStart: (move) => {
      const target = input.resolve();
      // One member cannot be reordered, and a target the list no longer has is
      // not one to pick up.
      if (target === null || target.items.length < 2) return;
      if (target.index < 0 || target.index >= target.items.length) return;
      startLayoutDrag(target, move, input);
    },
  });
}

/**
 * The arm phase every editor drag shares: the reorder above and the canvas's
 * drop of a surface onto an edge (`surface-drag.ts`). `onStart` runs with the
 * move that crossed the activation distance; a gesture it starts takes the one
 * drag slot with {@link holdLayoutDrag}.
 */
export function armLayoutGesture(input: {
  readonly event: PointerEvent;
  readonly onStart: (move: PointerEvent) => void;
}): void {
  const { event } = input;
  if (event.button !== 0 || stopActiveDrag !== null) return;
  const originX = event.clientX;
  const originY = event.clientY;
  // Captured for the arm phase too, not only once the drag has started: a
  // press released just OUTSIDE the window delivers its `pointerup` nowhere
  // without capture, and an arm that never disarms leaves `layoutDragActive()`
  // true - which swallows every later `pointermove` on the canvas and refuses
  // every later drag for the rest of the session (G3-06).
  const pressed = event.target instanceof Element ? event.target : null;

  const disarm = (): void => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (pressed !== null && pressed.hasPointerCapture(event.pointerId))
      pressed.releasePointerCapture(event.pointerId);
    if (stopActiveDrag === disarm) stopActiveDrag = null;
  };

  function onPointerMove(move: PointerEvent): void {
    if (move.pointerId !== event.pointerId) return;
    if (!dragStarted(move.clientX - originX, move.clientY - originY)) return;
    disarm();
    input.onStart(move);
  }

  function onPointerUp(up: PointerEvent): void {
    if (up.pointerId === event.pointerId) disarm();
  }

  pressed?.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  stopActiveDrag = disarm;
}

/**
 * Make `stop` the one live drag, so a session exit tears it down and no second
 * drag arms under it. The returned release gives the slot back, and only if
 * `stop` still holds it.
 */
export function holdLayoutDrag(stop: () => void): () => void {
  stopActiveDrag = stop;
  return () => {
    if (stopActiveDrag === stop) stopActiveDrag = null;
  };
}

function startLayoutDrag(
  target: LayoutDragTarget,
  event: PointerEvent,
  input: LayoutDragInput,
): void {
  const { items, index, clamp } = target;
  const dragged = items[index];
  const rects = items.map((item) => item.getBoundingClientRect());
  const axis = dragAxisOf(rects);
  const slots = dragSlotsOf(rects, axis);
  const shift = dragShiftOf(slots, index);
  const bounds = clampBoundsFor(clamp, slots[index], axis);
  const springs = items.map(
    () => new Spring(0, DRAG_SIBLING_SPRING.response, DRAG_SIBLING_SPRING.zeta),
  );
  const velocity = new PointerVelocity();
  // The grab point, so the member tracks the pointer from wherever it was
  // taken hold of rather than jumping its own centre under the cursor.
  const grab = axis === "y" ? event.clientY : event.clientX;
  velocity.sample(grab, performance.now());

  let offset = 0;
  let slot = index;
  let release: Spring | null = null;
  let frame = 0;
  let lastFrameAt = performance.now();

  const tick = (now: number): void => {
    frame = requestAnimationFrame(tick);
    const step = Math.min((now - lastFrameAt) / 1000, MAX_SPRING_STEP_SECONDS);
    lastFrameAt = now;
    const reduced = prefersReducedMotion();

    for (const [member, item] of items.entries()) {
      if (member === index) continue;
      const spring = springs[member];
      const want = siblingOffsetOf(index, slot, member, shift);
      if (reduced) spring.snap(want);
      else {
        spring.setTarget(want);
        spring.step(step);
      }
      writeOffset(item, axis, spring.value, false);
    }

    if (release === null) {
      writeOffset(dragged, axis, offset, true);
    } else {
      release.step(step);
      writeOffset(dragged, axis, release.value, false);
      if (release.settled()) {
        finish();
        return;
      }
    }
  };

  const onPointerMove = (move: PointerEvent): void => {
    if (move.pointerId !== event.pointerId || release !== null) return;
    const point = axis === "y" ? move.clientY : move.clientX;
    const raw = point - grab;
    offset = bounds === null ? raw : rubberBanded(raw, bounds.min, bounds.max);
    velocity.sample(point, performance.now());
    slot = targetSlotOf(slots, index, offset);
  };

  const onPointerUp = (up: PointerEvent): void => {
    if (up.pointerId !== event.pointerId || release !== null) return;
    // The release is still a `pointerup`, so the browser follows it with a
    // `click` on whatever was dragged. A row that opens a second level would
    // otherwise open it at the end of every drag.
    swallowNextClick();
    // Under either reduced-motion gate the drop is placed, not thrown, so the
    // one spring section 6 allows a bounce never runs.
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    const spring = new Spring(
      offset,
      DRAG_RELEASE_SPRING.response,
      DRAG_RELEASE_SPRING.zeta,
    );
    spring.setVelocity(velocity.perSecond());
    spring.setTarget(restingOffsetOf(slots, index, slot));
    release = spring;
  };

  /**
   * A cancelled pointer is not a drop: the system took the gesture away, so
   * the member goes back where it was and nothing is written.
   */
  const onPointerCancel = (cancel: PointerEvent): void => {
    if (cancel.pointerId !== event.pointerId) return;
    teardown();
  };

  /**
   * Every box is measured once, at the threshold crossing, and the firewall
   * deliberately lets wheel and touch scroll through while the app underneath
   * keeps streaming (L-17). A scroll therefore moves every member out from
   * under the numbers this drag is reflowing against, so the gesture ends
   * where it can still be honest rather than dropping into a slot the pointer
   * was never over (G3-09). Capture phase, because a scroll on an ancestor
   * does not bubble to `window`.
   */
  const onScroll = (): void => {
    teardown();
  };

  function teardown(): void {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("scroll", onScroll, true);
    for (const item of items) {
      item.style.transform = "";
      item.style.willChange = "";
    }
    dragged.removeAttribute("data-layout-dragging");
    if (dragged.hasPointerCapture(event.pointerId))
      dragged.releasePointerCapture(event.pointerId);
    if (stopActiveDrag === teardown) stopActiveDrag = null;
  }

  function finish(): void {
    const landed = slot;
    teardown();
    // After the teardown, so the element the caller is about to re-render is
    // already free of the transform this drag put on it.
    if (landed !== index) input.onDrop(index, landed);
  }

  for (const item of items) item.style.willChange = "transform";
  dragged.setAttribute("data-layout-dragging", "1");
  dragged.setPointerCapture(event.pointerId);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("scroll", onScroll, true);
  stopActiveDrag = teardown;
  // The first move is already in hand: the threshold crossing IS a move, and
  // waiting for the next one would start the drag a frame behind the pointer.
  onPointerMove(event);
  frame = requestAnimationFrame(tick);
}

/**
 * Eat the one `click` the browser synthesises from the release, and nothing
 * else: the listener takes itself off on that click, and a macrotask later in
 * case the release produced none (a pointer that left the element).
 */
export function swallowNextClick(): void {
  const swallow = (click: MouseEvent): void => {
    click.preventDefault();
    click.stopPropagation();
    window.removeEventListener("click", swallow, true);
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => {
    window.removeEventListener("click", swallow, true);
  }, 0);
}

/**
 * Only `transform` (L-29), and written straight onto the element rather than
 * into a custom property on a parent, so one member moving never invalidates
 * the whole list's style.
 */
function writeOffset(
  node: HTMLElement,
  axis: DragAxis,
  value: number,
  lifted: boolean,
): void {
  const translate =
    axis === "y"
      ? `translateY(${value.toFixed(2)}px)`
      : `translateX(${value.toFixed(2)}px)`;
  node.style.transform = lifted
    ? `${translate} scale(${String(LIFT_SCALE)})`
    : translate;
}

function clampBoundsFor(
  clamp: HTMLElement | null,
  slot: DragSlot,
  axis: DragAxis,
): { readonly min: number; readonly max: number } | null {
  if (clamp === null) return null;
  const rect = clamp.getBoundingClientRect();
  const start = axis === "y" ? rect.top : rect.left;
  const end = axis === "y" ? rect.bottom : rect.right;
  // A cluster that does not contain the member it is meant to hold is not a
  // clamp: a `display: contents` ancestor reports an empty box, and clamping
  // to that would pin the member to a point instead of to its row.
  if (end - start < slot.size) return null;
  return clampBoundsOf(slot, start, end);
}
