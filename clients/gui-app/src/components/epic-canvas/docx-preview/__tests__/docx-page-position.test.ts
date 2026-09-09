/**
 * `currentPageAmong` / `scrollTopForPage` (docx-page-position.ts): pure
 * geometry so the Word viewer's page tracking is testable without a real
 * layout engine. `currentPageAmong` follows pdf.js's own rule - the current
 * page sticks while it stays fully visible, otherwise the largest visible
 * share wins and an earlier page wins a tie - and `scrollTopForPage` is the
 * inverse: the offset that puts a page's top at the container's top, minus
 * the gutter, floored at 0.
 */
import { describe, expect, it } from "vitest";
import {
  currentPageAmong,
  scrollTopForPage,
  type VerticalExtent,
} from "../docx-page-position";

const VIEWPORT: VerticalExtent = { top: 0, bottom: 1000 };

describe("currentPageAmong", () => {
  it("returns 1 for an empty page list", () => {
    expect(currentPageAmong([], VIEWPORT, 1)).toBe(1);
  });

  it("picks the page with the largest visible share", () => {
    const pages: readonly VerticalExtent[] = [
      // Fully above the viewport - 0 visible.
      { top: -500, bottom: -100 },
      // Half visible: 500 of 1000 -> share 0.5.
      { top: 500, bottom: 1500 },
      // Fully visible: 200 of 200 -> share 1.
      { top: 700, bottom: 900 },
    ];

    expect(currentPageAmong(pages, VIEWPORT, 1)).toBe(3);
  });

  it("keeps the earlier page on a tie", () => {
    const pages: readonly VerticalExtent[] = [
      { top: 0, bottom: 500 },
      { top: 500, bottom: 1000 },
    ];
    // Both are fully visible against a 0-1000 viewport - equal share 1 -
    // the earlier page (1) must win, not the later one that merely ties.
    expect(currentPageAmong(pages, VIEWPORT, 1)).toBe(1);
  });

  it("keeps the current page while it stays fully visible, even though the tie-break alone would pick the earlier one", () => {
    const pages: readonly VerticalExtent[] = [
      { top: 0, bottom: 500 },
      { top: 500, bottom: 1000 },
    ];
    // Both pages are fully visible (share 1 each), so the plain tie-break
    // would land on page 1 - but the current page is 2, and it stays
    // current exactly because it too is still fully visible.
    expect(currentPageAmong(pages, VIEWPORT, 2)).toBe(2);
  });

  it("lets a short, fully-visible last page win over a tall page that shows more raw pixels but a smaller share", () => {
    const pages: readonly VerticalExtent[] = [
      // Tall page: 1000 tall, 500 visible -> share 0.5 (more pixels than
      // the short page below, but a smaller share of itself).
      { top: -500, bottom: 500 },
      // Short page: 50 tall, fully visible -> share 1.
      { top: 500, bottom: 550 },
    ];

    expect(currentPageAmong(pages, VIEWPORT, 1)).toBe(2);
  });

  it("ignores a zero-height page rather than dividing by zero", () => {
    const pages: readonly VerticalExtent[] = [
      // Zero height - must be skipped, not treated as a 0/0 "best" match.
      { top: 200, bottom: 200 },
      // Not visible at all (share 0), but still a valid page to fall back to.
      { top: -300, bottom: -100 },
    ];
    // currentPage points past the end so the "stays current while fully
    // visible" override can't mask the zero-height page's own handling -
    // this test is purely about the best-share fallback.
    expect(currentPageAmong(pages, VIEWPORT, 5)).toBe(2);
  });
});

describe("scrollTopForPage", () => {
  it("computes the offset that puts the page's top at the container's top, minus the gutter", () => {
    const page: VerticalExtent = { top: 532, bottom: 800 };
    const container: VerticalExtent = { top: 32, bottom: 900 };

    // 532 - 32 + 10 - 16 = 494.
    expect(scrollTopForPage(page, container, 10, 16)).toBe(494);
  });

  it("floors at 0 rather than returning a negative offset", () => {
    const page: VerticalExtent = { top: 100, bottom: 400 };
    const container: VerticalExtent = { top: 100, bottom: 900 };

    // 100 - 100 + 0 - 50 = -50, floored to 0.
    expect(scrollTopForPage(page, container, 0, 50)).toBe(0);
  });
});
