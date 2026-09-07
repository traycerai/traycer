/** They sit over surfaces that own gestures of their own - two of them at the document in the capture phase. */
import { blockingLayerClaimed } from "@/components/layout/shell/blocking-layer-claim";

export interface DirectionalGesture {
  readonly primaryPx: number;
  readonly crossPx: number;
  readonly elapsedMs: number;
}

/** `wait` lets an ambiguous drag stay unclaimed until it declares itself, which is what lets these recognizers
 * share a surface with the scrollers underneath them. */
export type DirectionalIntent = "activate" | "fail" | "wait";

/** Counter-direction travel that abandons the gesture. */
const COUNTER_DIRECTION_FAIL_PX = 10;

/** Paired with a comparison against the primary axis, so a fast diagonal is judged by which way it is mostly
 * going rather than by an absolute slip budget. */
const CROSS_AXIS_FAIL_PX = 10;

const INTENT_ACTIVATE_PX = 15;

/** Direction lock: callers run this only while the gesture is undecided and stop once it activates. */
export function classifyDirectionalIntent(
  gesture: DirectionalGesture,
): DirectionalIntent {
  if (gesture.primaryPx <= -COUNTER_DIRECTION_FAIL_PX) return "fail";
  const cross = Math.abs(gesture.crossPx);
  if (cross > CROSS_AXIS_FAIL_PX && cross > gesture.primaryPx) return "fail";
  if (gesture.primaryPx >= INTENT_ACTIVATE_PX && gesture.primaryPx > cross) {
    return "activate";
  }
  return "wait";
}

export interface DirectionalCommitLimits {
  readonly commitPx: number;
  /** Average speed that commits before that distance is reached. */
  readonly velocityPxPerMs: number;
}

/** The speed arm is what makes these feel native rather than dutiful. */
export function commitsDirectionalGesture(
  gesture: DirectionalGesture,
  limits: DirectionalCommitLimits,
): boolean {
  if (gesture.primaryPx >= limits.commitPx) return true;
  // A zero-duration sample would divide by zero. It is also the shape a synthetic or coalesced event takes, and
  // treating it as infinitely fast would commit on a twitch.
  if (gesture.elapsedMs <= 0) return false;
  return gesture.primaryPx / gesture.elapsedMs >= limits.velocityPxPerMs;
}

function asElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

/** The mobile terminal key bar is the case that matters: it cancels `touchstart` outright so a key press cannot
 * blur the terminal. */
export function declaresOwnTouchHandling(target: EventTarget | null): boolean {
  let node = asElement(target);
  while (node !== null) {
    if (window.getComputedStyle(node).touchAction === "none") return true;
    node = node.parentElement;
  }
  return false;
}

/** Answered by walking the ancestors at touch time rather than from a registry of pannable surfaces. */
export function ownsHorizontalGesture(target: EventTarget | null): boolean {
  if (declaresOwnTouchHandling(target)) return true;
  let node = asElement(target);
  while (node !== null) {
    const style = window.getComputedStyle(node);
    if (style.touchAction.includes("pan-x")) return true;
    if (
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      node.scrollWidth > node.clientWidth
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** The nearest ancestor a downward drag would scroll, or `null` if the drag has nowhere to go. */
export function verticalScrollTargetForDownwardDrag(
  target: EventTarget | null,
): Element | null {
  let node = asElement(target);
  while (node !== null) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight &&
      node.scrollTop > 0
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** The viewport measurement that would answer it directly (`readVirtualKeyboardInset`) reports 0 under the
 * mobile shell's native keyboard resize. */
export function isTextEntryFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  return active.tagName === "INPUT" || active.tagName === "TEXTAREA";
}

/** The one exemption the tap-to-dismiss arm needs: tapping into your own composer to move the caret is not a
 * request to put the keyboard away, and a blur there would fight the user for their own text field. */
export function isWithinFocusedTextEntry(target: EventTarget | null): boolean {
  const active = document.activeElement;
  if (active === null) return false;
  if (!(target instanceof Node)) return false;
  return active === target || active.contains(target);
}

/** A recognizer keyed on focus instead would stand down across the entire app whenever a composer happened to
 * be focused, which on a phone is most screens. */
export function withinTextEntry(target: EventTarget | null): boolean {
  let node = asElement(target);
  while (node !== null) {
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") return true;
    const editable = node.getAttribute("contenteditable");
    if (editable === "false") return false;
    if (editable !== null) return true;
    node = node.parentElement;
  }
  return false;
}

/** The second is the explicit claim, for surfaces that block without that machinery - the ones that mount the
 * primitive non-modally and inert a subtree of their own instead, so the document never learns anything. */
export function modalLayerCoversApp(): boolean {
  if (document.body.style.pointerEvents === "none") return true;
  return blockingLayerClaimed();
}

export function blurTextEntry(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}
