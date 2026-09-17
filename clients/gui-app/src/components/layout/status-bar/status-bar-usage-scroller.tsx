import { useEffect, useRef, type ReactNode } from "react";
import { statusBarUsageScrollKey } from "@/components/layout/status-bar/status-bar-usage-display";
import type { StatusBarRateLimitCluster } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { useHorizontalWheelScroll } from "@/hooks/use-horizontal-wheel-scroll";
import {
  horizontalScrollFadeClass,
  useHorizontalScrollEdges,
} from "@/hooks/ui/use-horizontal-scroll-edges";
import { cn } from "@/lib/utils";

/**
 * The box the usage readings scroll in, when there are more of them than the
 * strip is wide.
 *
 * Nothing is hidden to make the readings fit: every drawn account prints
 * every part the preferences ask for, at every width, and what the strip has
 * no room for is a scroll away. The affordance is the fade rather than a
 * scrollbar - `no-scrollbar` because a 6px bar under a 24px row would be most
 * of the row - and it fades ONLY the edge that hides something
 * (`useHorizontalScrollEdges`): the right edge while the tail is off-screen,
 * the left once the head is, both mid-scroll, neither when everything fits.
 * A static both-ends mask would dim the first reading on a strip that had
 * nothing to scroll.
 *
 * Touch and a trackpad scroll it natively. A mouse wheel is turned sideways
 * (`useHorizontalWheelScroll`, the tab strip's), since a vertical wheel over
 * a one-line strip has nowhere else to go.
 *
 * Two boxes rather than one. The outer is the SCROLLPORT: it takes the room
 * the strip gives it (`min-w-0 flex-1`) and clips. The inner is the row at its
 * natural width (`shrink-0`), which is what makes `scrollWidth` exceed
 * `clientWidth` in the first place - a row allowed to shrink would squeeze
 * its readings instead of overflowing, and there would be nothing to scroll
 * to. The row is also the box worth observing for change: a countdown ticking
 * from `4h 15m` to `4h` moves it and nothing else, and the fade has to be
 * re-decided when it does. The children are rendered INSIDE the row rather
 * than as the row, because the strip's child is a `PopoverTrigger` whose
 * button Radix re-wraps after its first commit - a ref held on that button
 * would sit on the node Radix discarded, while the row around it is never
 * swapped.
 *
 * The scroll position is reset to the start when the host or the SET of
 * segments changes (`statusBarUsageScrollKey`: a host switch, a provider
 * hidden or shown, an account checked or unchecked), so the first account is
 * never off-screen by default after the strip's contents were replaced. The
 * host is named explicitly because the strip keeps this subtree across a
 * switch and two hosts can draw identical segment ids. It is deliberately NOT
 * reset when a reading inside a segment moves - a countdown tick or a
 * percentage update - because that happens every minute and would throw away
 * where the user scrolled to. A DOM write from an effect rather than state:
 * the position is the scroller's to keep, and nothing rendered depends on it.
 */
export function StatusBarUsageScroller(props: {
  /** The host the readings belong to, `null` while none is resolved. */
  readonly hostId: string | null;
  readonly cluster: StatusBarRateLimitCluster;
  /**
   * The scroller's own `data-testid`. The strip and the Settings preview can
   * be on screen at once, and one id naming two live boxes is a trap for the
   * next test that queries it.
   */
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  const scrollerRef = useRef<HTMLSpanElement | null>(null);
  const rowRef = useRef<HTMLSpanElement | null>(null);
  const edges = useHorizontalScrollEdges(scrollerRef, rowRef);
  const handleWheel = useHorizontalWheelScroll();
  const scrollKey = statusBarUsageScrollKey(props.hostId, props.cluster);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null) scroller.scrollLeft = 0;
  }, [scrollKey]);
  return (
    <span
      ref={scrollerRef}
      data-testid={props.testId}
      onWheel={handleWheel}
      className={cn(
        "no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain",
        horizontalScrollFadeClass(edges),
      )}
    >
      <span ref={rowRef} className="flex shrink-0 items-center">
        {props.children}
      </span>
    </span>
  );
}
