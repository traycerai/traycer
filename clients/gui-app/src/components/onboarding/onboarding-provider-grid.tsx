import { useEffect, useRef, useState } from "react";
import {
  ProviderList,
  type ProviderListRow,
} from "@/components/providers/provider-list";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";

interface VerticalEdges {
  readonly top: boolean;
  readonly bottom: boolean;
}

const NO_EDGES: VerticalEdges = { top: false, bottom: false };

/**
 * Which vertical edges of the grid still hide a card. The fade is painted from
 * these rather than as a static both-ends mask, because a permanent top fade
 * would dim the first row - which is where the enabled providers sort - even
 * with nothing scrolled past it.
 *
 * Local to this act rather than a sibling of `useHorizontalScrollEdges`: the
 * one caller is right here, and the tour is the only surface that fades a
 * vertical scroller.
 */
function useVerticalScrollEdges(
  scrollerRef: React.RefObject<HTMLElement | null>,
  rowCount: number,
): VerticalEdges {
  const [edges, setEdges] = useState<VerticalEdges>(NO_EDGES);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const update = () => {
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      // 1px slack: fractional scroll offsets never settle on the exact bounds.
      const top = scroller.scrollTop > 1;
      const bottom = scroller.scrollTop < maxScroll - 1;
      setEdges((previous) =>
        previous.top === top && previous.bottom === bottom
          ? previous
          : { top, bottom },
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (scroller.firstElementChild !== null) {
      observer.observe(scroller.firstElementChild);
    }
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [rowCount, scrollerRef]);
  return edges;
}

/**
 * Every provider on one scrolling board - no pages, no arrows.
 *
 * On a phone the same rows become a grouped LIST (see `ProviderList`'s phone
 * shape): fifteen 8.5rem cards is three on screen and a scroll bar for the
 * rest. The breakpoint is read once here, so the rows below take no
 * subscription of their own; the list's own class names exist only in that
 * shape, so the stylesheet needs no media query to reach them.
 */
export function OnboardingProviderGrid(props: {
  readonly rows: readonly ProviderListRow[];
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const edges = useVerticalScrollEdges(scrollerRef, props.rows.length);
  const phone = useIsMobileViewport();
  return (
    <div
      ref={scrollerRef}
      data-testid="onboarding-provider-grid"
      // The fades are the CARD board's affordance. A phone list ends on a
      // hairline and scrolls under the footer, so it takes neither - and a
      // mask is also a clip, which is what cut a row's first glyph in half
      // while it was still arriving.
      data-fade-top={!phone && edges.top}
      data-fade-bottom={!phone && edges.bottom}
      className="onboarding-provider-scroller no-scrollbar min-h-0 w-full flex-1 overflow-y-auto overscroll-contain"
    >
      <ProviderList
        ariaLabel="Coding agent CLIs"
        variant="onboarding"
        rows={props.rows}
        phone={phone}
        className="onboarding-provider-cards w-full"
      />
    </div>
  );
}
