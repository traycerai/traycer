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
 * Pages must be stacked in document order without overlap. Read their live
 * bounds on demand: binary search skips pages above the viewport, and the
 * scan stops below it, keeping measurements to O(log(pageCount) + visible).
 */
export function currentPageAmong(
  pageCount: number,
  readPage: (index: number) => VerticalExtent,
  viewport: VerticalExtent,
  currentPage: number,
): number {
  if (pageCount === 0) return 1;
  const currentNumber = Math.min(Math.max(currentPage, 1), pageCount);
  const current = readPage(currentNumber - 1);
  if (
    current.bottom > current.top &&
    current.top >= viewport.top &&
    current.bottom <= viewport.bottom
  ) {
    return currentNumber;
  }

  let first = 0;
  let end = pageCount;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    if (readPage(middle).bottom <= viewport.top) {
      first = middle + 1;
    } else {
      end = middle;
    }
  }

  // Keep the current page when only a gap between pages is visible.
  let bestPage = currentNumber;
  let bestShare = 0;
  for (let index = first; index < pageCount; index++) {
    const page = readPage(index);
    if (page.top >= viewport.bottom) break;
    const height = page.bottom - page.top;
    if (height <= 0) continue;
    const visible =
      Math.min(page.bottom, viewport.bottom) - Math.max(page.top, viewport.top);
    const share = Math.max(visible, 0) / height;
    if (share > bestShare) {
      bestShare = share;
      bestPage = index + 1;
    }
  }
  return bestPage;
}

/**
 * The scroll offset that puts a page's top edge at the top of the container,
 * leaving `gutter` (already in visual px) of the scroll container's padding above it.
 */
export function scrollTopForPage(
  page: VerticalExtent,
  container: VerticalExtent,
  containerScrollTop: number,
  gutter: number,
): number {
  return Math.max(page.top - container.top + containerScrollTop - gutter, 0);
}
