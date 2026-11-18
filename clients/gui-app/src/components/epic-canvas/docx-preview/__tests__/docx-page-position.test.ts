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
  it("returns 1 for an empty document", () => {
    expect(
      currentPageAmong(0, () => ({ top: 0, bottom: 0 }), VIEWPORT, 1),
    ).toBe(1);
  });

  it("keeps a fully visible current page, then chooses the largest share with an earlier tie", () => {
    const pages: readonly VerticalExtent[] = [
      { top: 0, bottom: 500 },
      { top: 500, bottom: 1000 },
    ];
    const readPage = (index: number): VerticalExtent => pages[index];

    expect(currentPageAmong(pages.length, readPage, VIEWPORT, 2)).toBe(2);
    expect(currentPageAmong(2, readPage, { top: 250, bottom: 750 }, 2)).toBe(1);
  });

  it("uses visible fraction, so a short fully visible last page wins", () => {
    const pages: readonly VerticalExtent[] = [
      { top: 0, bottom: 1000 },
      { top: 1000, bottom: 1050 },
    ];
    const readPage = (index: number): VerticalExtent => pages[index];

    expect(currentPageAmong(2, readPage, { top: 900, bottom: 1050 }, 1)).toBe(
      2,
    );
  });

  it("ignores zero-height pages and retains the current page through a gap", () => {
    const pages: readonly VerticalExtent[] = [
      { top: 0, bottom: 100 },
      { top: 100, bottom: 100 },
      { top: 116, bottom: 216 },
    ];
    const readPage = (index: number): VerticalExtent => pages[index];

    expect(currentPageAmong(3, readPage, { top: 100, bottom: 116 }, 2)).toBe(2);
    expect(currentPageAmong(3, readPage, { top: 100, bottom: 116 }, 3)).toBe(3);
    expect(currentPageAmong(3, readPage, { top: 120, bottom: 180 }, 2)).toBe(3);
    expect(currentPageAmong(3, readPage, { top: 90, bottom: 170 }, 2)).toBe(3);
  });

  it("clamps the retained page when no positive-height page is visible", () => {
    const pages: readonly VerticalExtent[] = [
      { top: 0, bottom: 100 },
      { top: 120, bottom: 220 },
      { top: 240, bottom: 340 },
    ];
    const readPage = (index: number): VerticalExtent => pages[index];
    const gap = { top: 220, bottom: 240 };

    expect(currentPageAmong(3, readPage, gap, 0)).toBe(1);
    expect(currentPageAmong(3, readPage, gap, 9)).toBe(3);
  });

  it("binary-searches a long document for far jumps without reading every page", () => {
    const pageCount = 1000;
    const pageHeight = 100;
    const gap = 20;
    const pages = Array.from({ length: pageCount }, (_, index) => {
      const top = index * (pageHeight + gap);
      return { top, bottom: top + pageHeight };
    });
    let reads = 0;
    const readPage = (index: number): VerticalExtent => {
      reads += 1;
      return pages[index];
    };
    const maxReads = Math.ceil(Math.log2(pageCount)) + 5;

    reads = 0;
    expect(
      currentPageAmong(
        pageCount,
        readPage,
        { top: 749 * 120 + 20, bottom: 749 * 120 + 100 },
        1,
      ),
    ).toBe(750);
    expect(reads).toBeLessThanOrEqual(maxReads);

    reads = 0;
    expect(
      currentPageAmong(
        pageCount,
        readPage,
        { top: 199 * 120 + 20, bottom: 199 * 120 + 100 },
        750,
      ),
    ).toBe(200);
    expect(reads).toBeLessThanOrEqual(maxReads);
  });

  it("reads live geometry on every call rather than retaining stale page boxes", () => {
    let pages: readonly VerticalExtent[] = [
      { top: 0, bottom: 100 },
      { top: 100, bottom: 200 },
      { top: 200, bottom: 300 },
    ];
    const reads: number[] = [];
    const readPage = (index: number): VerticalExtent => {
      reads.push(index);
      return pages[index];
    };
    const viewport = { top: 100, bottom: 200 };

    expect(currentPageAmong(3, readPage, viewport, 1)).toBe(2);
    pages = [
      { top: 0, bottom: 200 },
      { top: 200, bottom: 400 },
      { top: 400, bottom: 600 },
    ];
    reads.length = 0;
    expect(currentPageAmong(3, readPage, viewport, 2)).toBe(1);
    expect(reads.length).toBeGreaterThan(0);
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
