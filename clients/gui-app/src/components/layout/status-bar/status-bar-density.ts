import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * How much of itself the strip can afford to show.
 *
 * Measured from the BAR's own width rather than the viewport's, because the
 * strip is the thing that runs out of room: a window can be wide while the bar
 * is narrow (it is not, today, but the segments below it are laid out against
 * their container and nothing else). Container width is also what the same
 * thresholds mean in the design.
 *
 * Component state, never persisted. It is a fact about the current window, and
 * a persisted copy of it would be wrong the moment the window was resized on
 * another screen.
 */
export type StatusBarDensity = "full" | "compact" | "icon-only";

const COMPACT_MAX_WIDTH_PX = 900;
const ICON_ONLY_MAX_WIDTH_PX = 500;

export function statusBarDensityForWidth(widthPx: number): StatusBarDensity {
  if (widthPx < ICON_ONLY_MAX_WIDTH_PX) return "icon-only";
  if (widthPx < COMPACT_MAX_WIDTH_PX) return "compact";
  return "full";
}

/**
 * Starts at `full` and narrows on the first observation rather than measuring
 * during layout: a `ResizeObserver` fires synchronously after the first paint,
 * so the widest form is on screen for at most one frame — and the alternative,
 * reading `offsetWidth` in a layout effect, is a forced reflow on every mount
 * of the shell for a value the observer is about to deliver anyway.
 */
export function useStatusBarDensity(
  ref: RefObject<HTMLElement | null>,
): StatusBarDensity {
  const [density, setDensity] = useState<StatusBarDensity>("full");
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      // The LAST entry, not the first: a batch delivered after several resizes
      // in one frame carries them in order, and the first is already stale by
      // the time this runs.
      const width = entries.at(-1)?.contentRect.width;
      if (width === undefined) return;
      setDensity(statusBarDensityForWidth(width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return density;
}

/**
 * A `scrollWidth`/`clientWidth` comparison is integer-rounded on both sides, so
 * a box holding subpixel content reports a phantom pixel of overflow. One pixel
 * of slack is below anything a reader could lose.
 */
const OVERFLOW_SLACK_PX = 1;

/**
 * Whether an element is currently hiding content past its own edge.
 *
 * The width thresholds above cannot answer this. They describe how much room
 * the strip HAS; whether that is enough depends on how much there is to draw,
 * and a Claude account on a large plan reports five-plus windows from one
 * provider before anything is hidden. A bar wide enough to stay `full` can
 * still clip a whole trailing provider at the trigger's edge.
 *
 * Measured after every render AND on resize, because the two events are
 * disjoint and neither implies the other. A countdown ticking from `4h 15m` to
 * `4h` changes the content without changing any box, so no observer fires; a
 * window resize inside one density bucket changes the box without re-rendering
 * anything, so no render happens. A `ResizeObserver` on the element alone
 * catches only the second - its box is width-bounded and `overflow-hidden`, so
 * growing content never moves it.
 *
 * It cannot oscillate, and that is a property of what the flag DRIVES rather
 * than of the measurement: a mask paints, it does not lay out, so nothing this
 * flag turns on can change the width it was measured from. A flag that fed back
 * into what is rendered - stepping the density down - would need a latch and a
 * reset rule to stay still, which is a different change from this one.
 *
 * The verdict is published as a `data-clipped` attribute written straight to the
 * element, never as React state, which is the same shape the live-activity
 * window uses for its own overflow fade. Two reasons, and the second is the
 * load-bearing one. A measurement taken after EVERY render can only be taken in
 * an effect, and a `setState` there is a cascading render by construction -
 * every reader of this repo's React rules is told so, and its lint enforces it.
 * Writing the DOM instead cannot re-render anything, so the "it cannot
 * oscillate" claim above stops depending on what the flag happens to drive and
 * becomes true of the mechanism itself. Every consumer of the answer is CSS,
 * which is what the attribute is for.
 *
 * Hands back a CALLBACK REF rather than taking a `RefObject`, and that is the
 * whole correctness of the observer half. A ref object mutates without
 * re-rendering, so an effect keyed on it runs once and keeps whatever node the
 * first commit happened to leave there - and the measured node is not
 * guaranteed to survive its first commit.
 *
 * The strip is a live instance of that. `PopoverAnchor` publishes itself
 * through a Radix context in a mount EFFECT, and `PopoverTrigger` reads that
 * context to decide whether to wrap its child in a Popper anchor of its own -
 * so a trigger with an anchor elsewhere in the same popover renders one element
 * type on the first commit and another on the second, and React replaces the
 * DOM node underneath. The status bar has exactly that shape: the anchor is the
 * slot, a SIBLING of this trigger (`app-status-bar.tsx`). Which is the point of
 * spelling it out here - the swap is a property of that wiring, not of
 * `PopoverTrigger` alone, and a reader of this file cannot see it.
 *
 * An effect-attached observer would then watch a detached node forever, and a
 * resize that stayed inside one density bucket - 1400px to 950px, where nothing
 * re-renders - would never be measured at all. A callback ref is run again for
 * the replacement, and its returned cleanup disconnects the observer from the
 * node being discarded, so the two can never drift apart. That holds whether or
 * not any particular caller triggers the swap.
 */
export function useStatusBarContentOverflow(): (
  node: HTMLElement | null,
) => (() => void) | undefined {
  const measuredRef = useRef<HTMLElement | null>(null);
  const measure = useCallback(() => {
    const node = measuredRef.current;
    if (node === null) return;
    node.dataset.clipped = String(
      node.scrollWidth > node.clientWidth + OVERFLOW_SLACK_PX,
    );
  }, []);
  // No dependency array: every render of the strip is a content change, which
  // is exactly when this has to be re-read. Layout, not passive, so the mask is
  // never a frame behind the text it is masking, and a DOM write rather than a
  // state update, so measuring cannot schedule the render that measures again.
  useLayoutEffect(measure);
  // The observer is attached and torn down BY the ref, through the cleanup a
  // callback ref may now return - so it follows the node instead of an effect
  // having to guess when the node changed.
  return useCallback(
    (node: HTMLElement | null) => {
      // React runs the cleanup instead of a `null` call for a ref that returns
      // one, so this arm is the type's older contract rather than a path taken.
      if (node === null) {
        measuredRef.current = null;
        return undefined;
      }
      measuredRef.current = node;
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => {
        observer.disconnect();
        measuredRef.current = null;
      };
    },
    [measure],
  );
}
