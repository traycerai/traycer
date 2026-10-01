import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
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
 * no room for is a scroll away. The one give is on a phone, where account
 * names truncate to a short floor before the row overflows. The affordance is the fade rather than a
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
 *
 * The ROW is also `usageLimits`'s canvas node (C-02). Usage limits is ONE
 * region however many accounts it draws, so it registers ONCE here instead of
 * once per provider segment: the editor stamps `data-selected` on every
 * instance of a region by design (L-23), so a registration per segment drew
 * the travelling ring around the first account and a separate white box around
 * each of the others, where the artifact draws one ring around the whole
 * cluster.
 *
 * The row and not the scrollport, which is where this differs from the audit's
 * recommendation and from the prototype's own `.usage-cluster-wrap`. That
 * wrapper hugs its readings and clips only when it must; the scrollport here
 * is `flex-1` because it is the strip's grower (`app-status-bar.tsx`), so it
 * is as wide as everything the resource readout leaves - and a ring around it
 * would enclose half the status bar rather than the cluster. The row is the
 * natural-width cluster, which is the box the artifact rings. The cost is the
 * overflow case: with more readings than the strip is wide, the ring is drawn
 * around the whole row and runs past the strip's edge. That case is rare, it
 * still names the right thing, and the ring re-measures every frame so it
 * tracks the scroll.
 *
 * Only the live strip mounts this; every passive picture of the cluster (the
 * specimen stage, the Settings preview, a ghost) renders `StatusBarUsageReadings`
 * directly, so there is no `interactive` gate to thread through.
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
  const { ref: regionRef } = useLayoutRegion({
    regionId: "usageLimits",
    instanceId: null,
  });
  // One node with two owners: the fade reads the row's width through
  // `rowRef`, and the editor registers the same element as the region.
  const setRow = useCallback(
    (node: HTMLSpanElement | null) => {
      rowRef.current = node;
      regionRef(node);
    },
    [regionRef],
  );
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
      {/* A phone lets the row give first: account names shorten to a floor
        (`StatusBarProviderSegment`) before anything scrolls, since a strip
        one reading too wide there fades the last reading's tail against the
        refresh control rather than showing a scroll worth taking. */}
      <span ref={setRow} className="flex shrink-0 items-center max-md:shrink">
        {props.children}
      </span>
    </span>
  );
}
