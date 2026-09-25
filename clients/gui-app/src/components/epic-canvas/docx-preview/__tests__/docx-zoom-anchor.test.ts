/**
 * `documentPointUnder` / `scrollOffsetPlacing` (docx-zoom-anchor.ts): the pure
 * pair that keeps a document point under the pinch focal across a CSS `zoom`
 * change. They are exact inverses along one axis, so the round trip is the
 * property worth pinning down, not just the worked example.
 */
import { describe, expect, it } from "vitest";
import { documentPointUnder, scrollOffsetPlacing } from "../docx-zoom-anchor";

describe("documentPointUnder", () => {
  it("computes the worked example", () => {
    // (100 + 50 - 16) / 2 = 67.
    expect(documentPointUnder(100, 50, 16, 2)).toBe(67);
  });
});

interface RoundTripCase {
  readonly scrollOffset: number;
  readonly focal: number;
  readonly contentOffset: number;
  readonly scale: number;
  readonly newScale: number;
}

const ROUND_TRIP_CASES: readonly RoundTripCase[] = [
  { scrollOffset: 100, focal: 50, contentOffset: 16, scale: 2, newScale: 3 },
  { scrollOffset: 0, focal: 200, contentOffset: 0, scale: 1, newScale: 1.5 },
  {
    scrollOffset: 340,
    focal: 12,
    contentOffset: 40,
    scale: 1.5,
    newScale: 0.75,
  },
  { scrollOffset: 900, focal: 480, contentOffset: 24, scale: 2.5, newScale: 1 },
];

describe("scrollOffsetPlacing", () => {
  it.each(ROUND_TRIP_CASES)(
    "puts the same document point back under the focal after a scale change (%j)",
    ({ scrollOffset, focal, contentOffset, scale, newScale }) => {
      const documentPoint = documentPointUnder(
        scrollOffset,
        focal,
        contentOffset,
        scale,
      );

      const newScrollOffset = scrollOffsetPlacing(
        documentPoint,
        newScale,
        contentOffset,
        focal,
      );

      const recoveredDocumentPoint = documentPointUnder(
        newScrollOffset,
        focal,
        contentOffset,
        newScale,
      );

      expect(recoveredDocumentPoint).toBeCloseTo(documentPoint);
    },
  );

  it("leaves the scroll offset unchanged when the scale does not change", () => {
    const scrollOffset = 250;
    const focal = 80;
    const contentOffset = 20;
    const scale = 1.75;

    const documentPoint = documentPointUnder(
      scrollOffset,
      focal,
      contentOffset,
      scale,
    );
    const newScrollOffset = scrollOffsetPlacing(
      documentPoint,
      scale,
      contentOffset,
      focal,
    );

    expect(newScrollOffset).toBeCloseTo(scrollOffset);
  });
});
