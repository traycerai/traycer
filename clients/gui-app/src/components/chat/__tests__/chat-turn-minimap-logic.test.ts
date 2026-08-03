import { describe, expect, it } from "vitest";
import {
  CHAT_TURN_MINIMAP_END_HIT_PADDING,
  CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH,
  CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
  CHAT_TURN_MINIMAP_ITEM_SPACING,
  CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS,
  CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS,
  resolveChatTurnMinimapHeightStyle,
  resolveChatTurnMinimapIndexFromPointer,
  resolveChatTurnMinimapInteractiveWidth,
  resolveChatTurnMinimapRowHeight,
  resolveChatTurnMinimapRowInView,
  resolveChatTurnMinimapRowTop,
  resolveChatTurnMinimapRowViewportDistance,
  resolveChatTurnMinimapTopPercent,
  resolveChatTurnMinimapTopStyle,
} from "@/components/chat/chat-turn-minimap-logic";

describe("resolveChatTurnMinimapHeightStyle", () => {
  it("adds endpoint hit padding to the visual track height, capped by the viewport and pane", () => {
    expect(resolveChatTurnMinimapHeightStyle(1)).toBe(
      `min(${1 + CHAT_TURN_MINIMAP_END_HIT_PADDING * 2}px, ${CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS}, ${CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS})`,
    );
    expect(resolveChatTurnMinimapHeightStyle(2)).toBe(
      `min(${CHAT_TURN_MINIMAP_ITEM_SPACING + CHAT_TURN_MINIMAP_END_HIT_PADDING * 2}px, ${CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS}, ${CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS})`,
    );
    expect(resolveChatTurnMinimapHeightStyle(5)).toBe(
      `min(${4 * CHAT_TURN_MINIMAP_ITEM_SPACING + CHAT_TURN_MINIMAP_END_HIT_PADDING * 2}px, ${CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS}, ${CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS})`,
    );
  });
});

describe("resolveChatTurnMinimapTopPercent", () => {
  it("returns 0 for a single item (or degenerate counts)", () => {
    expect(resolveChatTurnMinimapTopPercent(0, 1)).toBe(0);
    expect(resolveChatTurnMinimapTopPercent(0, 0)).toBe(0);
  });

  it("places first / middle / last of many items at 0 / 50 / 100", () => {
    expect(resolveChatTurnMinimapTopPercent(0, 5)).toBe(0);
    expect(resolveChatTurnMinimapTopPercent(2, 5)).toBe(50);
    expect(resolveChatTurnMinimapTopPercent(4, 5)).toBe(100);
  });

  it("clamps out-of-range indices to the rail ends", () => {
    expect(resolveChatTurnMinimapTopPercent(-3, 4)).toBe(0);
    expect(resolveChatTurnMinimapTopPercent(99, 4)).toBe(100);
  });
});

describe("resolveChatTurnMinimapTopStyle", () => {
  it("insets only the two endpoint strips while preserving even track spacing", () => {
    expect(resolveChatTurnMinimapTopStyle(0, 5)).toBe(
      `calc(0% + ${CHAT_TURN_MINIMAP_END_HIT_PADDING}px)`,
    );
    expect(resolveChatTurnMinimapTopStyle(2, 5)).toBe("50%");
    expect(resolveChatTurnMinimapTopStyle(4, 5)).toBe(
      `calc(100% - ${CHAT_TURN_MINIMAP_END_HIT_PADDING}px)`,
    );
  });
});

describe("resolveChatTurnMinimapIndexFromPointer", () => {
  const base = {
    railTop: 100,
    railHeight: 200,
  } as const;

  it("returns null when there are no items or the rail has no height", () => {
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 0,
        pointerY: 150,
      }),
    ).toBeNull();
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        itemCount: 3,
        railTop: 100,
        railHeight: 0,
        pointerY: 150,
      }),
    ).toBeNull();
  });

  it("returns 0 for a single-item rail regardless of pointer Y", () => {
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 1,
        pointerY: -999,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 1,
        pointerY: 9999,
      }),
    ).toBe(0);
  });

  it("maps above the rail to the first index and below the rail to the last", () => {
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 5,
        pointerY: 50, // above railTop
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 5,
        pointerY: 400, // below railBottom
      }),
    ).toBe(4);
  });

  it("maps exact top / mid / bottom boundaries for a multi-item rail", () => {
    // 3 items: progress 0 → 0, 0.5 → 1, 1 → 2
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 3,
        pointerY: 100,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 3,
        pointerY: 200,
      }),
    ).toBe(1);
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 3,
        pointerY: 300,
      }),
    ).toBe(2);
  });

  it("gives the first and last items the extra endpoint padding", () => {
    const trackHeight = base.railHeight - CHAT_TURN_MINIMAP_END_HIT_PADDING * 2;
    const halfItemStep = trackHeight / (5 - 1) / 2;
    const firstInteriorBoundary =
      base.railTop + CHAT_TURN_MINIMAP_END_HIT_PADDING + halfItemStep;
    const lastInteriorBoundary =
      base.railTop +
      base.railHeight -
      CHAT_TURN_MINIMAP_END_HIT_PADDING -
      halfItemStep;

    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 5,
        pointerY: firstInteriorBoundary - 1,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 5,
        pointerY: firstInteriorBoundary + 1,
      }),
    ).toBe(1);
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 5,
        pointerY: lastInteriorBoundary - 1,
      }),
    ).toBe(3);
    expect(
      resolveChatTurnMinimapIndexFromPointer({
        ...base,
        itemCount: 5,
        pointerY: lastInteriorBoundary + 1,
      }),
    ).toBe(4);
  });
});

describe("resolveChatTurnMinimapInteractiveWidth", () => {
  it("returns the collapsed numeric width when not expanded", () => {
    expect(
      resolveChatTurnMinimapInteractiveWidth(
        CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
        false,
      ),
    ).toBe(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH);
  });

  it("returns the expanded rem width once the preview is open", () => {
    expect(resolveChatTurnMinimapInteractiveWidth(0, true)).toBe(
      CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH,
    );
    expect(resolveChatTurnMinimapInteractiveWidth(40, true)).toBe(
      CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH,
    );
    expect(CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH).toContain("100vw");
  });
});

describe("resolveChatTurnMinimapRowTop / RowHeight / RowInView", () => {
  const state = {
    scroll: 100,
    scrollLength: 400,
    positionAtIndex: (index: number): number | undefined => {
      if (index === 0) return 0;
      if (index === 1) return 150;
      if (index === 2) return 450;
      if (index === 3) return 600;
      return undefined;
    },
    sizeAtIndex: (index: number): number | undefined => {
      if (index === 0) return 80;
      if (index === 1) return 100;
      if (index === 2) return 50;
      if (index === 3) return Number.NaN;
      return undefined;
    },
  };

  it("returns null when position/size is missing or non-finite", () => {
    expect(resolveChatTurnMinimapRowTop(state, 99)).toBeNull();
    expect(resolveChatTurnMinimapRowHeight(state, 99)).toBeNull();
    expect(resolveChatTurnMinimapRowHeight(state, 3)).toBeNull();
    expect(resolveChatTurnMinimapRowTop({}, 0)).toBeNull();
  });

  it("returns the measured top / height for known rows", () => {
    expect(resolveChatTurnMinimapRowTop(state, 1)).toBe(150);
    expect(resolveChatTurnMinimapRowHeight(state, 1)).toBe(100);
  });

  it("treats a row as in-view when it intersects the scrolled viewport band", () => {
    // Viewport band: [100, 500)
    // row 0: [0, 80) - fully above → false
    expect(resolveChatTurnMinimapRowInView(state, 0)).toBe(false);
    // row 1: [150, 250) - intersects → true
    expect(resolveChatTurnMinimapRowInView(state, 1)).toBe(true);
    // row 2: [450, 500) - touches bottom edge from below scrollBottom → true
    // (rowTop < scrollBottom && rowBottom > scrollTop)
    expect(resolveChatTurnMinimapRowInView(state, 2)).toBe(true);
    // row missing position → false
    expect(resolveChatTurnMinimapRowInView(state, 99)).toBe(false);
  });

  it("falls back to a 1px height when size is missing so a top-only row can still hit", () => {
    const thin = {
      scroll: 0,
      scrollLength: 10,
      positionAtIndex: () => 5,
      // no sizeAtIndex
    };
    expect(resolveChatTurnMinimapRowInView(thin, 0)).toBe(true);
  });

  it("defaults scroll/scrollLength to 0 when omitted", () => {
    const emptyBand = {
      positionAtIndex: () => 10,
      sizeAtIndex: () => 20,
    };
    // scrollBottom = 0; row [10, 30) does not intersect [0, 0)
    expect(resolveChatTurnMinimapRowInView(emptyBand, 0)).toBe(false);

    const atOrigin = {
      positionAtIndex: () => 0,
      sizeAtIndex: () => 0,
      scrollLength: 1,
    };
    // rowHeight falls back to max(1, 0) = 1 → [0, 1) intersects [0, 1)
    expect(resolveChatTurnMinimapRowInView(atOrigin, 0)).toBe(true);
  });

  it("subtracts the header offset before comparing (decision #18 - positionAtIndex is content-relative, scroll is not)", () => {
    // A measured 80px header. scroll=80 means the viewport's own top edge
    // sits at content-relative position 0.
    const headerState = {
      scroll: 80,
      scrollLength: 100,
      topOffsetAdjustment: 80,
      positionAtIndex: (index: number): number | undefined => [0, 200][index],
      sizeAtIndex: (): number => 60,
    };
    // row 0 [0, 60) sits in the visible top 80px (content-relative band is
    // [0, 100)) - must read in-view.
    expect(resolveChatTurnMinimapRowInView(headerState, 0)).toBe(true);
    // row 1 [200, 260) is well below the band - must read out of view.
    expect(resolveChatTurnMinimapRowInView(headerState, 1)).toBe(false);
  });
});

describe("resolveChatTurnMinimapRowViewportDistance", () => {
  const state = {
    scroll: 200,
    scrollLength: 100,
    positionAtIndex: (index: number): number | undefined =>
      [50, 220, 400][index],
    sizeAtIndex: (): number => 50,
  };

  it("encodes above, intersecting, and below rows in one geometry result", () => {
    expect(resolveChatTurnMinimapRowViewportDistance(state, 0)).toBe(100);
    expect(resolveChatTurnMinimapRowViewportDistance(state, 1)).toBe(-1);
    expect(resolveChatTurnMinimapRowViewportDistance(state, 2)).toBe(100);
  });

  it("keeps a touching row out of view while reporting zero proximity", () => {
    expect(
      resolveChatTurnMinimapRowViewportDistance(
        {
          ...state,
          positionAtIndex: () => 300,
        },
        0,
      ),
    ).toBe(0);
  });

  it("returns null when row geometry is unavailable", () => {
    expect(resolveChatTurnMinimapRowViewportDistance({}, 0)).toBeNull();
  });
});
