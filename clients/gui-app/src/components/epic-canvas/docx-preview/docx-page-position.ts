/**
 * Page arithmetic for the Word viewer's page navigation. docx-preview lays
 * every page out as its own section in one scroll container, so "the current
 * page" is a question about geometry, answered here from bounding rects so
 * the viewer can be tested without a layout engine. Rects are visual
 * coordinates, which is what makes this correct under CSS `zoom`.
 */

/** A rect's edges - what `getBoundingClientRect()` returns, without the rest. */
export interface VerticalExtent {
  readonly top: number;
  readonly bottom: number;
}

/**
 * The page (1-based) the viewer should report for the given scroll position,
 * following pdf.js's rule: the current page stays current while it is fully
 * visible, otherwise the page with the largest visible share wins, and the
 * earlier page wins a tie. A scroll that reveals a short last page in full
 * therefore lands on it even though the page above still fills more of the
 * viewport, and a tall page stays current while the reader is inside it.
 */
export function currentPageAmong(
  pages: readonly VerticalExtent[],
  viewport: VerticalExtent,
  currentPage: number,
): number {
  if (pages.length === 0) return 1;
  let bestPage = 1;
  let bestShare = -1;
  pages.forEach((page, index) => {
    const height = page.bottom - page.top;
    if (height <= 0) return;
    const visible =
      Math.min(page.bottom, viewport.bottom) - Math.max(page.top, viewport.top);
    const share = Math.max(visible, 0) / height;
    if (share > bestShare) {
      bestShare = share;
      bestPage = index + 1;
    }
  });
  if (currentPage < 1 || currentPage > pages.length) return bestPage;
  const current = pages[currentPage - 1];
  const currentFullyVisible =
    current.top >= viewport.top && current.bottom <= viewport.bottom;
  return currentFullyVisible ? currentPage : bestPage;
}

/**
 * The scroll offset that puts a page's top edge at the top of the container,
 * leaving `gutter` (already in visual px) of the wrapper's padding above it.
 */
export function scrollTopForPage(
  page: VerticalExtent,
  container: VerticalExtent,
  containerScrollTop: number,
  gutter: number,
): number {
  return Math.max(page.top - container.top + containerScrollTop - gutter, 0);
}
