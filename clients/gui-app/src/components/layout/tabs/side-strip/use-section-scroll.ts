import { useEffect, useState } from "react";

/** What the Activity view's scroll position says about the rows it hides. */
export interface SectionScroll {
  /** More rows lie below the bottom edge. */
  readonly moreBelow: boolean;
  /** The Needs you header has scrolled out of view, above the top edge. */
  readonly needsYouAbove: boolean;
  /**
   * The section whose header row is in front on the top edge: the one stuck
   * there, or the next one once it starts to push that one out. `null` at rest.
   */
  readonly stuck: string | null;
}

const AT_REST: SectionScroll = {
  moreBelow: false,
  needsYouAbove: false,
  stuck: null,
};

/**
 * Read the scroll state of the Activity view's scroller. Needs you is the first
 * section and its header sticks, so it is out of view once the next section's
 * header has reached the top and covers it. That is read from where the next
 * header sits in the flow, the end of the row before it, never from where it
 * sticks, so nothing drawn in a stuck header can move the answer. The header
 * in front on the top edge is the last one stuck there, since each covers the
 * one before, or the next one from the moment it overlaps that. Re-read on scroll, on a resize and whenever the rows change,
 * since either can move a row across an edge without a scroll; the state only
 * changes where an edge is crossed.
 */
export function useSectionScroll(scroller: HTMLElement | null): SectionScroll {
  const [scroll, setScroll] = useState(AT_REST);
  useEffect(() => {
    if (scroller === null) return;
    const read = (): void => {
      const rows = Array.from(
        scroller.querySelectorAll("[data-strip-section-row]"),
      );
      const top = scroller.getBoundingClientRect().top + 0.5;
      const needsYouEnd = rows.at(1)?.previousElementSibling ?? null;
      const stuckAt = rows.findLastIndex(
        (row) => row.getBoundingClientRect().top <= top,
      );
      // The next header takes over the moment it starts to slide over the
      // stuck one, so the row in front is never one being covered.
      const incoming = rows.at(stuckAt + 1);
      const stuck =
        stuckAt >= 0 &&
        incoming !== undefined &&
        incoming.getBoundingClientRect().top <
          rows[stuckAt].getBoundingClientRect().bottom - 0.5
          ? incoming
          : rows.at(stuckAt);
      const next: SectionScroll = {
        moreBelow:
          scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop >
          1,
        needsYouAbove:
          scroller.scrollTop > 0 &&
          needsYouEnd !== null &&
          rows[0].getAttribute("data-strip-section-row") === "needs-you" &&
          needsYouEnd.getBoundingClientRect().bottom <= top,
        stuck:
          scroller.scrollTop > 0
            ? (stuck?.getAttribute("data-strip-section-row") ?? null)
            : null,
      };
      setScroll((held) =>
        held.moreBelow === next.moreBelow &&
        held.needsYouAbove === next.needsYouAbove &&
        held.stuck === next.stuck
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
