import { useEffect, useRef, useState } from "react";
import {
  ProviderList,
  type ProviderListRow,
} from "@/components/providers/provider-list";

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

/** Every provider on one scrolling board - no pages, no arrows. */
export function OnboardingProviderGrid(props: {
  readonly rows: readonly ProviderListRow[];
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const edges = useVerticalScrollEdges(scrollerRef, props.rows.length);
  return (
    <div
      ref={scrollerRef}
      data-testid="onboarding-provider-grid"
      data-fade-top={edges.top}
      data-fade-bottom={edges.bottom}
      className="onboarding-provider-scroller no-scrollbar min-h-0 w-full flex-1 overflow-y-auto overscroll-contain"
    >
      <ProviderList
        ariaLabel="Coding agent CLIs"
        variant="onboarding"
        rows={props.rows}
        className="onboarding-provider-cards w-full"
      />
    </div>
  );
}
