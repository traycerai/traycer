import {
  useCallback,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
  LIVE_ACTIVITY_WINDOW_EXIT_MS,
  useLiveActivityWindowMounted,
} from "./live-activity-window-mount";

/**
 * Distance from the bottom, in px, within which the window still counts as
 * hugging the tail. Matches `ReasoningTail`'s threshold - a wheel notch lands
 * well outside it, so one deliberate scroll up suspends the pin.
 */
const TAIL_PIN_SLACK_PX = 16;

/**
 * A scroller with 1px or less of hidden content is treated as not scrollable:
 * it cannot consume a gesture, so it must not swallow one either.
 */
const OVERFLOW_EPSILON_PX = 1;

interface LiveActivityWindowProps {
  /**
   * True while the run is live and the group is collapsed. Going false starts
   * the fold-away; the component stays mounted for `LIVE_ACTIVITY_WINDOW_EXIT_MS`
   * so the height transition has something to animate.
   */
  readonly shown: boolean;
  readonly children: ReactNode;
}

/**
 * Bounded, tail-following viewport for the activity that is happening right
 * now. Rows scroll up out of it instead of growing the turn, so the run
 * indicator below stays put while tools and reasoning stream.
 *
 * Generalized from `ReasoningTail`, which is the same widget scoped to one
 * markdown string. Everything it proved - the tail pin, a manual scroll
 * suspending that pin, and a top fade gated on a MEASURED overflow flag so a
 * short body is not dimmed into invisibility - carries over unchanged.
 *
 * Two things it adds:
 *
 * 1. Gesture containment. The transcript is a LegendList whose scroll policy
 *    reads wheel/touch/pointer gestures as reader intent at the live edge and
 *    drops an upward departure into `free-scrolling` with a jump-to-latest
 *    pill. Looking back two rows in here must not trigger that, so the gesture
 *    is stopped at this element. `overscroll-contain` alone is not enough: it
 *    governs scroll CHAINING, not event propagation, and the transcript's
 *    listener fires on the event regardless of whether anything scrolled.
 * 2. An animated exit. The collapse is system-initiated (the turn ended, or
 *    prose started), so it deliberately does NOT route through
 *    `requestChatMeasuredItemChange`: that helper is a flushSync + one-shot
 *    geometric correction and cannot absorb a change spread over 300ms.
 *    LegendList observes every item root with a shared ResizeObserver, and its
 *    `contain: paint layout style` carries no `size`, so the root is still
 *    sized by its descendants and this transition is tracked as it runs.
 */
export function LiveActivityWindow(props: LiveActivityWindowProps) {
  const { shown, children } = props;
  // Same hook `ActivityGroupSegment` reads, deliberately called twice rather
  // than lifted into a prop. Both calls take the identical `shown` value in the
  // identical commit, so they enter and leave together; keeping this one here
  // leaves the window self-contained and its own tests driving only `shown`.
  const mounted = useLiveActivityWindowMounted(shown);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Stays true while the window hugs the newest row; a manual scroll up (to
  // read something that already went past) suspends the pin until the reader
  // returns to the bottom.
  const pinnedRef = useRef(true);

  const bindScroller = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    if (node === null) return;

    // A fresh scroller starts pinned. `pinnedRef` lives on the component, which
    // outlives the scroller: the component stays mounted for the whole run and
    // only returns null between folds, so a pin suspended by scrolling up would
    // otherwise survive into the next scroller - one that starts at
    // `scrollTop = 0`. The layout effect would then refuse to move it, and the
    // window would sit frozen on the oldest rows while the run streamed on.
    pinnedRef.current = true;

    // NATIVE listeners, on this element, and deliberately NOT React's
    // `onWheel`/`onTouchMove`. The follow latch attaches its own `wheel` and
    // `touchmove` listeners directly to the LegendList scroll node, which is
    // a DESCENDANT of React's root container.
    // Native bubbling therefore reaches that listener before React dispatches
    // any synthetic event at the root, so `stopPropagation()` on a synthetic
    // event would run long after the damage was done.
    //
    // Gated on actually being scrollable: a window with nothing hidden cannot
    // consume the gesture, and swallowing it would make this a dead zone where
    // the transcript refuses to scroll at all.
    const stopWhenScrollable = (event: Event): void => {
      if (node.scrollHeight - node.clientHeight <= OVERFLOW_EPSILON_PX) return;
      event.stopPropagation();
    };
    node.addEventListener("wheel", stopWhenScrollable, { passive: true });
    node.addEventListener("touchmove", stopWhenScrollable, { passive: true });
    return () => {
      node.removeEventListener("wheel", stopWhenScrollable);
      node.removeEventListener("touchmove", stopWhenScrollable);
      scrollRef.current = null;
    };
  }, []);

  // The transcript ALSO cancels live-follow from a plain `onPointerDown`, and
  // that one is a React handler, so a synthetic stop is both sufficient and
  // necessary here. Ungated: clicking inside the live window - to select text
  // out of it, say - is never intent to stop following the run.
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.stopPropagation();
    },
    [],
  );

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_PIN_SLACK_PX;
  }, []);

  // Live external sync (browser scroll position <-> streaming rows): no
  // dependency array on purpose. The window only exists while the run is live,
  // and every render of it means a row was added or grew - which is exactly
  // when the tail needs re-pinning and the overflow flag re-measuring. A
  // dependency list here would have to encode "any content changed", which no
  // stable value expresses. Writes DOM only, never state, so it cannot loop.
  //
  // Layout, not passive: a passive effect lets the browser paint the stale
  // scroll offset and the un-masked box for one frame before correcting, and a
  // visible one-frame jolt per streamed row is the exact thing this widget
  // exists to remove.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.dataset.overflowing = String(
      el.scrollHeight - el.clientHeight > OVERFLOW_EPSILON_PX,
    );
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  });

  if (!mounted) return null;

  return (
    // The `0fr`/`1fr` grid row is what makes the exit animatable: it
    // interpolates an auto height without anyone having to measure the content.
    // Growth WITHIN the open state is not animated - the specified value stays
    // `1fr` as rows arrive, and a transition only fires on a specified-value
    // change - so rows still appear instantly.
    <div
      data-testid="activity-live-window"
      data-shown={String(shown)}
      style={{ transitionDuration: `${LIVE_ACTIVITY_WINDOW_EXIT_MS}ms` }}
      className={cn(
        "grid transition-[grid-template-rows] ease-[cubic-bezier(0.32,0.72,0,1)]",
        "motion-reduce:transition-none",
        shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="overflow-hidden">
        <div
          ref={bindScroller}
          onScroll={handleScroll}
          onPointerDown={handlePointerDown}
          data-testid="activity-live-window-scroller"
          // Labelled but deliberately not focusable: a tab stop that appears
          // and vanishes as runs start and end would be worse than none, and
          // every row in here is reachable by opening the group, which is a
          // real button.
          role="group"
          aria-label="Live activity"
          className={cn(
            // `leading-6` is load-bearing, not decoration: `lh` resolves
            // against THIS element's line-height, and without it the box would
            // inherit `text-ui-sm`'s 1.25rem and cap at three rows of the
            // `leading-6` body it mostly holds, not the four that was asked for.
            "mt-0.5 ml-5 flex max-h-[4lh] flex-col gap-0.5 overflow-y-auto overscroll-contain border-l border-border/35 pl-3 leading-6",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "data-[overflowing=true]:[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]",
            "data-[overflowing=true]:[mask-image:linear-gradient(to_bottom,transparent,black_1.25rem)]",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
