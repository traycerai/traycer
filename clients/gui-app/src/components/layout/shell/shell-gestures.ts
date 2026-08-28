/**
 * Shared primitives for the mobile shell's touch recognizers - the leftward
 * pull that pushes the navigation drawer back off screen, the downward drag
 * that dismisses the soft keyboard, and the row swipe that reveals a task's
 * tray.
 *
 * They sit over surfaces that own gestures of their own - two of them at the
 * document in the capture phase - so they need the same questions answered the
 * same way: has this drag declared an axis, has it committed, and does
 * something under the finger already claim it. One definition, because a
 * recognizer that guesses differently from its neighbour is how one ends up
 * stealing the other's touches.
 */
import { blockingLayerClaimed } from "@/components/layout/shell/blocking-layer-claim";

export interface DirectionalGesture {
  /** Travel along the gesture's own axis, positive in its direction. */
  readonly primaryPx: number;
  /** Travel across it, either sign. */
  readonly crossPx: number;
  readonly elapsedMs: number;
}

/**
 * Three states, and the third is the point.
 *
 * A two-state recognizer has to decide on the first pixel, so it either steals
 * scrolls or misses swipes. `wait` lets an ambiguous drag stay unclaimed until
 * it declares itself, which is what lets these recognizers share a surface
 * with the scrollers underneath them.
 */
export type DirectionalIntent = "activate" | "fail" | "wait";

/**
 * Counter-direction travel that abandons the gesture. A finger that comes back
 * toward where it started has changed its mind, and honouring that is the
 * cancel affordance every platform drawer has.
 */
const COUNTER_DIRECTION_FAIL_PX = 10;

/**
 * Cross-axis travel that abandons the gesture. Paired with a comparison
 * against the primary axis, so a fast diagonal is judged by which way it is
 * mostly going rather than by an absolute slip budget.
 */
const CROSS_AXIS_FAIL_PX = 10;

/** Travel along the intended axis that claims the touch. */
const INTENT_ACTIVATE_PX = 15;

/**
 * Whether a drag has declared itself ours, someone else's, or neither yet.
 *
 * DIRECTION LOCK: callers run this only while the gesture is undecided and
 * stop once it activates. Re-running it per move after activation is how a
 * recognizer cancels itself - a committed horizontal drag that later curves
 * downward is still the drawer's, and re-classifying would hand it back
 * mid-gesture.
 */
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
  /** Travel that commits on its own, however slow. */
  readonly commitPx: number;
  /** Average speed that commits before that distance is reached. */
  readonly velocityPxPerMs: number;
}

/**
 * Whether an already-activated drag has committed, by distance OR by speed.
 *
 * The speed arm is what makes these feel native rather than dutiful: the
 * platform's own drawer and dismiss gestures commit on a fast swipe that has
 * barely moved, and a distance-only recognizer feels stuck beside them. It
 * needs no minimum distance of its own - activation already required travel,
 * so a jitter can never reach this.
 *
 * Speed is averaged over the whole gesture rather than sampled instantaneously.
 * For a flick, which is short and uniformly fast, the two agree; for a slow
 * drag the average stays low and the distance arm decides, which is the
 * intended split.
 *
 * Callers evaluate this per MOVE, never at touch-end. Crossing the threshold
 * decides, so pausing or lifting somewhere else cannot take the gesture back -
 * the same rule the platform recognizers use.
 */
export function commitsDirectionalGesture(
  gesture: DirectionalGesture,
  limits: DirectionalCommitLimits,
): boolean {
  if (gesture.primaryPx >= limits.commitPx) return true;
  // A zero-duration sample would divide by zero. It is also the shape a
  // synthetic or coalesced event takes, and treating it as infinitely fast
  // would commit on a twitch.
  if (gesture.elapsedMs <= 0) return false;
  return gesture.primaryPx / gesture.elapsedMs >= limits.velocityPxPerMs;
}

function asElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

/**
 * Whether the touch landed inside something that has declared it handles its
 * own touches (`touch-action: none`).
 *
 * The mobile terminal key bar is the case that matters: it cancels `touchstart`
 * outright so a key press cannot blur the terminal. A shell recognizer firing
 * on the same touch would dismiss the keyboard in the middle of someone typing
 * into a terminal.
 */
export function declaresOwnTouchHandling(target: EventTarget | null): boolean {
  let node = asElement(target);
  while (node !== null) {
    if (window.getComputedStyle(node).touchAction === "none") return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * Whether the touch landed on something that already pans sideways.
 *
 * A few surfaces do: the tab strips (`touch-pan-x` over an `overflow-x-auto`
 * rail), the attachment strip, code blocks. Those are gestures a user could be
 * mid-way through when a shell recognizer stole the touch, so this refuses
 * rather than competes.
 *
 * Answered by walking the ancestors at touch time rather than from a registry
 * of pannable surfaces. A registry is more precise - it can say "this rail is
 * scrolled away from its start, so it owns the drag" for surfaces that are not
 * ancestors of the touch - but it has to be kept in step with every surface
 * that gains or loses a pan, and each recognizer here already enters from a
 * surface of its own, which keeps the two apart for every case in the app
 * today.
 *
 * `scrollWidth > clientWidth` is part of the test on purpose: a rail whose tabs
 * all fit does not actually pan, and treating it as if it did would leave a
 * dead strip whose length varied with how many tabs happened to be open.
 */
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

/**
 * The nearest ancestor a DOWNWARD drag would scroll, or `null` if the drag has
 * nowhere to go.
 *
 * Dragging down scrolls content back toward its start, so an element can only
 * consume the gesture while it is scrolled away from the top. A list already at
 * `scrollTop === 0` is at its boundary and will not move - which is exactly
 * where the platform hands the drag to the keyboard instead.
 */
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

/**
 * Whether the user is typing - the state the keyboard recognizer needs to be
 * true before it has anything to dismiss.
 *
 * A focused entry is not a reason for other shell gestures to stand down. The
 * drawer's close pull deliberately runs while the keyboard is up, because
 * pushing the menu away mid-draft is an ordinary thing to do and nothing is
 * claimed until the classifier has seen travel a caret could not have asked
 * for.
 *
 * This is also the app's only usable "is the soft keyboard up" signal. The
 * viewport measurement that would answer it directly
 * (`readVirtualKeyboardInset`) reports 0 under the mobile shell's native
 * keyboard resize, because the web view is resized instead of overlaid and
 * nothing is left covered - so gating on a measured inset would disable the
 * dismissal outright rather than protect it.
 */
export function isTextEntryFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  return active.tagName === "INPUT" || active.tagName === "TEXTAREA";
}

/**
 * Whether a touch landed inside the field that currently has focus.
 *
 * The one exemption the tap-to-dismiss arm needs: tapping into your own
 * composer to move the caret is not a request to put the keyboard away, and a
 * blur there would fight the user for their own text field.
 */
export function isWithinFocusedTextEntry(target: EventTarget | null): boolean {
  const active = document.activeElement;
  if (active === null) return false;
  if (!(target instanceof Node)) return false;
  return active === target || active.contains(target);
}

/**
 * Whether a touch landed inside a text entry, focused or not.
 *
 * Asked of the TARGET rather than of `document.activeElement`, and the
 * difference is the whole point. A horizontal drag inside a field is a text
 * selection - the caret being dragged across the line - which is a gesture the
 * field owns whether or not it held focus when the finger came down. A
 * recognizer keyed on focus instead would stand down across the entire app
 * whenever a composer happened to be focused, which on a phone is most screens.
 *
 * Rich editors are recognized by the `contenteditable` ATTRIBUTE rather than by
 * the resolved `isContentEditable` property. The property's whole advantage is
 * that it resolves inheritance, and this walk already climbs to the ancestor
 * carrying the attribute - so the attribute answers the same question one level
 * up, and answers it in terms of what the markup actually declares.
 *
 * The NEAREST declaration wins, which is what makes an explicit
 * `contenteditable="false"` a real carve-out rather than a value that is merely
 * skipped over. The walk stops there and answers no, because the editor said
 * that subtree is not text: rich-text node views - a mention chip, a
 * slash-command result, an attached image - are non-editable atoms sitting
 * inside an editable root, and there is no caret in one to drag. Continuing up
 * to the root would refuse a gesture over every one of them, which is the
 * opposite of what the carve-out is for. A field nested INSIDE such an atom is
 * still a field: the tag is checked first, at every level.
 */
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

/**
 * Whether a layer is covering the app - a dialog, a sheet, an alert, a modal
 * menu, or a surface that blocks the app by its own means.
 *
 * TWO SOURCES, because there are two ways to be blocking and only one of them
 * is visible in the DOM.
 *
 * The first is `body`'s inline `pointer-events`, which the dismissable-layer
 * primitive sets to `none` for as long as at least one layer has outside
 * pointer events disabled, and restores when the last one unmounts. That is not
 * a proxy for the question: it IS the question. "A modal layer is up" matters
 * here only because it means the surface underneath is not the user's to
 * interact with, and this is the app declaring exactly that. Every surface
 * using the primitive's modal machinery funnels through it, so nothing has to
 * be enumerated and nothing new has to be remembered when one is added.
 *
 * The second is the explicit claim, for surfaces that block WITHOUT that
 * machinery - the ones that mount the primitive non-modally and inert a subtree
 * of their own instead, so the document never learns anything. They are no less
 * blocking for it; they are just silent, and a guard reading only the barrier
 * would wave a gesture straight through them.
 *
 * Cheap enough to ask per gesture: an inline style read on one element and a
 * counter, no query and no layout.
 */
export function modalLayerCoversApp(): boolean {
  if (document.body.style.pointerEvents === "none") return true;
  return blockingLayerClaimed();
}

/** Blurs the focused text entry, which is what closes the soft keyboard. */
export function blurTextEntry(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}
