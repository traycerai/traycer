import { useEffect, useState, type RefObject } from "react";

export interface HorizontalScrollEdges {
  readonly left: boolean;
  readonly right: boolean;
}

const NO_EDGES: HorizontalScrollEdges = { left: false, right: false };

/**
 * Which horizontal edges of a scroller currently hide content. Tracked from
 * scroll plus resizes of both the scroller and its content row, so the edge
 * fades appear only where something is actually cut off (a static both-ends
 * mask would fade the first/last item even when fully scrolled to that side)
 * and follow a content set that changes without the scroller itself resizing.
 */
export function useHorizontalScrollEdges(
  scrollerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
): HorizontalScrollEdges {
  const [edges, setEdges] = useState<HorizontalScrollEdges>(NO_EDGES);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const update = () => {
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      // 1px slack: fractional scroll positions on touch never settle on the
      // exact integer bounds.
      const left = scroller.scrollLeft > 1;
      const right = scroller.scrollLeft < maxScroll - 1;
      setEdges((prev) =>
        prev.left === left && prev.right === right ? prev : { left, right },
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    const content = contentRef.current;
    if (content !== null) observer.observe(content);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [contentRef, scrollerRef]);
  return edges;
}

const FADE_BOTH =
  "[-webkit-mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)] [mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]";
const FADE_LEFT =
  "[-webkit-mask-image:linear-gradient(to_right,transparent,black_1.5rem)] [mask-image:linear-gradient(to_right,transparent,black_1.5rem)]";
const FADE_RIGHT =
  "[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]";

/**
 * The mask utilities that fade whichever edges of a horizontal scroller still
 * hide content, or `null` when nothing is cut off.
 */
export function horizontalScrollFadeClass(
  edges: HorizontalScrollEdges,
): string | null {
  if (edges.left && edges.right) return FADE_BOTH;
  if (edges.left) return FADE_LEFT;
  if (edges.right) return FADE_RIGHT;
  return null;
}
