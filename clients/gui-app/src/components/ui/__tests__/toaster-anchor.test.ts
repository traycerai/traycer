import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOASTER_ANCHOR,
  pickToasterAnchor,
  TOASTER_EDGE_OFFSET_PX,
  type ToasterAnchor,
} from "@/components/ui/toaster-anchor";
import type { BrowserOverlayRect } from "@/lib/browser-view/tiles/browser-overlay-coordinator";

const VIEWPORT = { width: 1200, height: 800 };
const TOASTER_SIZE = { width: 356, height: 120 };

const ANCHOR_LEFT: Record<ToasterAnchor, number> = {
  "top-left": TOASTER_EDGE_OFFSET_PX,
  "bottom-left": TOASTER_EDGE_OFFSET_PX,
  "top-center": (VIEWPORT.width - TOASTER_SIZE.width) / 2,
  "bottom-center": (VIEWPORT.width - TOASTER_SIZE.width) / 2,
  "top-right": VIEWPORT.width - TOASTER_EDGE_OFFSET_PX - TOASTER_SIZE.width,
  "bottom-right": VIEWPORT.width - TOASTER_EDGE_OFFSET_PX - TOASTER_SIZE.width,
};

const ANCHOR_TOP: Record<ToasterAnchor, number> = {
  "top-left": TOASTER_EDGE_OFFSET_PX,
  "top-center": TOASTER_EDGE_OFFSET_PX,
  "top-right": TOASTER_EDGE_OFFSET_PX,
  "bottom-left": VIEWPORT.height - TOASTER_EDGE_OFFSET_PX - TOASTER_SIZE.height,
  "bottom-center":
    VIEWPORT.height - TOASTER_EDGE_OFFSET_PX - TOASTER_SIZE.height,
  "bottom-right":
    VIEWPORT.height - TOASTER_EDGE_OFFSET_PX - TOASTER_SIZE.height,
};

function rectForAnchor(anchor: ToasterAnchor): BrowserOverlayRect {
  const left = ANCHOR_LEFT[anchor];
  const top = ANCHOR_TOP[anchor];
  return {
    left,
    top,
    right: left + TOASTER_SIZE.width,
    bottom: top + TOASTER_SIZE.height,
    width: TOASTER_SIZE.width,
    height: TOASTER_SIZE.height,
  };
}

const ALL_ANCHORS: readonly ToasterAnchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

describe("pickToasterAnchor", () => {
  it("returns the default anchor when there are no tiles", () => {
    expect(
      pickToasterAnchor({
        toasterSize: TOASTER_SIZE,
        viewport: VIEWPORT,
        tileRects: [],
      }),
    ).toBe(DEFAULT_TOASTER_ANCHOR);
  });

  it("returns the default anchor when the toaster has never been measured", () => {
    expect(
      pickToasterAnchor({
        toasterSize: null,
        viewport: VIEWPORT,
        tileRects: [rectForAnchor(DEFAULT_TOASTER_ANCHOR)],
      }),
    ).toBe(DEFAULT_TOASTER_ANCHOR);
  });

  it("moves off the default anchor when a tile covers it", () => {
    const anchor = pickToasterAnchor({
      toasterSize: TOASTER_SIZE,
      viewport: VIEWPORT,
      tileRects: [rectForAnchor(DEFAULT_TOASTER_ANCHOR)],
    });

    expect(anchor).not.toBe(DEFAULT_TOASTER_ANCHOR);
    expect(
      rectsOverlap(
        rectForAnchor(anchor),
        rectForAnchor(DEFAULT_TOASTER_ANCHOR),
      ),
    ).toBe(false);
  });

  it("keeps the default anchor when every anchor is covered", () => {
    const tileRects = ALL_ANCHORS.map(rectForAnchor);

    expect(
      pickToasterAnchor({
        toasterSize: TOASTER_SIZE,
        viewport: VIEWPORT,
        tileRects,
      }),
    ).toBe(DEFAULT_TOASTER_ANCHOR);
  });

  it("picks the fixed preference order's first free anchor, not just any free one", () => {
    // Cover the default (bottom-right) and bottom-center, leaving
    // bottom-left as the first free anchor in preference order.
    const tileRects = [
      rectForAnchor("bottom-right"),
      rectForAnchor("bottom-center"),
    ];

    expect(
      pickToasterAnchor({
        toasterSize: TOASTER_SIZE,
        viewport: VIEWPORT,
        tileRects,
      }),
    ).toBe("bottom-left");
  });
});

function rectsOverlap(a: BrowserOverlayRect, b: BrowserOverlayRect): boolean {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}
