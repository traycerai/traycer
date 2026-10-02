import { useEffect, useState } from "react";

/** What the Activity view's scroll position says about the rows it hides. */
export interface SectionScroll {
  /** More rows lie below the bottom edge. */
  readonly moreBelow: boolean;
  /** The Needs you header has scrolled out of view, above the top edge. */
  readonly needsYouAbove: boolean;
}

const AT_REST: SectionScroll = { moreBelow: false, needsYouAbove: false };

/**
 * Read the scroll state of the Activity view's scroller. Needs you is the first
 * section and its header sticks, so it is out of view once the next section's
 * header has reached the top and covers it. That is read from where the next
 * header sits in the flow, the end of the row before it, never from where it
 * sticks: the headers stick lower while the pill shows, and reading that would
 * hide the pill it made room for. Re-read on scroll, on a resize and whenever
 * the rows change, since either can move a row across an edge without a
 * scroll; the state only changes where an edge is crossed.
 */
export function useSectionScroll(scroller: HTMLElement | null): SectionScroll {
  const [scroll, setScroll] = useState(AT_REST);
  useEffect(() => {
    if (scroller === null) return;
    const read = (): void => {
      const headers = scroller.querySelectorAll("[data-strip-section]");
      const needsYouEnd = headers[1]?.previousElementSibling ?? null;
      const next: SectionScroll = {
        moreBelow:
          scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop >
          1,
        needsYouAbove:
          scroller.scrollTop > 0 &&
          needsYouEnd !== null &&
          headers[0].getAttribute("data-strip-section") === "needs-you" &&
          needsYouEnd.getBoundingClientRect().bottom <=
            scroller.getBoundingClientRect().top + 0.5,
      };
      setScroll((held) =>
        held.moreBelow === next.moreBelow &&
        held.needsYouAbove === next.needsYouAbove
          ? held
          : next,
      );
    };
    read();
    scroller.addEventListener("scroll", read, { passive: true });
    const resize = new ResizeObserver(read);
    resize.observe(scroller);
    const rows = new MutationObserver(read);
    rows.observe(scroller, { childList: true, subtree: true });
    return () => {
      scroller.removeEventListener("scroll", read);
      resize.disconnect();
      rows.disconnect();
    };
  }, [scroller]);
  return scroller === null ? AT_REST : scroll;
}
