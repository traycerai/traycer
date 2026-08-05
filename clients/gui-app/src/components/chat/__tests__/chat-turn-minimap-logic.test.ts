import { describe, expect, it } from "vitest";
import {
  CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH_REM,
  CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS,
  compactChatTurnMinimapPreview,
  CHAT_TURN_MINIMAP_EDGE_INSET_REM,
  CHAT_TURN_MINIMAP_END_HIT_PADDING,
  CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
  CHAT_TURN_MINIMAP_ITEM_SPACING,
  CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS,
  CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS,
  resolveChatTurnMinimapHeightStyle,
  resolveChatTurnMinimapHitStripWidth,
  resolveChatTurnMinimapIndexFromPointer,
  resolveChatTurnMinimapRowHeight,
  resolveChatTurnMinimapRowInView,
  resolveChatTurnMinimapRowTop,
  resolveChatTurnMinimapRowViewportDistance,
  resolveChatTurnMinimapTopPercent,
  resolveChatTurnMinimapTopStyle,
} from "@/components/chat/chat-turn-minimap-logic";
import { DEFAULT_UI_FONT_SIZE } from "@/stores/settings/settings-store";

const DEFAULT_UI_ROOT_FONT_SIZE = DEFAULT_UI_FONT_SIZE;

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

describe("resolveChatTurnMinimapHitStripWidth", () => {
  it("returns 0 for non-finite or non-positive viewport widths", () => {
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: DEFAULT_UI_ROOT_FONT_SIZE,
        viewportWidth: 0,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: DEFAULT_UI_ROOT_FONT_SIZE,
        viewportWidth: -10,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: DEFAULT_UI_ROOT_FONT_SIZE,
        viewportWidth: Number.NaN,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: DEFAULT_UI_ROOT_FONT_SIZE,
        viewportWidth: Number.POSITIVE_INFINITY,
      }),
    ).toBe(0);
  });

  it("returns 0 for non-finite or non-positive root font sizes", () => {
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 0,
        viewportWidth: 1200,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: -15,
        viewportWidth: 1200,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: Number.NaN,
        viewportWidth: 1200,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: Number.POSITIVE_INFINITY,
        viewportWidth: 1200,
      }),
    ).toBe(0);
  });

  it("returns concrete safe budgets for supported UI root sizes", () => {
    // Reviewer / production-failure cases first.
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 20,
        viewportWidth: 900,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 20,
        viewportWidth: 1000,
      }),
    ).toBe(5);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 17,
        viewportWidth: 800,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 15,
        viewportWidth: 800,
      }),
    ).toBe(28);

    // Independently calculated expectations across supported roots and common
    // pane widths. Keeping fixed numbers here prevents a mirrored implementation
    // from hiding arithmetic regressions.
    const expectedWidths = [
      [10, [0, 40, 40, 40, 40, 40]],
      [15, [0, 28, 40, 40, 40, 40]],
      [17, [0, 0, 29, 40, 40, 40]],
      [20, [0, 0, 0, 5, 40, 40]],
    ] as const;
    const viewportWidths = [420, 800, 900, 1000, 1200, 2400] as const;
    for (const [rootFontSize, expectedForRoot] of expectedWidths) {
      for (const [index, viewportWidth] of viewportWidths.entries()) {
        expect(
          resolveChatTurnMinimapHitStripWidth({
            rootFontSize,
            viewportWidth,
          }),
        ).toBe(expectedForRoot[index]);
      }
    }
  });

  it("returns 0 when the rem content column consumes the viewport (narrow/tiled)", () => {
    // Default 15px: content max is 720px; at or below that the gutter is 0.
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: DEFAULT_UI_ROOT_FONT_SIZE,
        viewportWidth:
          CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH_REM * DEFAULT_UI_ROOT_FONT_SIZE,
      }),
    ).toBe(0);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: DEFAULT_UI_ROOT_FONT_SIZE,
        viewportWidth: 420,
      }),
    ).toBe(0);
    // Barely wider than content max: gutter still smaller than edge inset.
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: DEFAULT_UI_ROOT_FONT_SIZE,
        viewportWidth: 730,
      }),
    ).toBe(0);
  });

  it("caps the hit strip at the max width in a wide pane", () => {
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: DEFAULT_UI_ROOT_FONT_SIZE,
        viewportWidth: 1200,
      }),
    ).toBe(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: DEFAULT_UI_ROOT_FONT_SIZE,
        viewportWidth: 2400,
      }),
    ).toBe(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH);
    // Small root still caps rather than following the full gutter.
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 10,
        viewportWidth: 800,
      }),
    ).toBe(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH);
  });

  it("uses the remaining side gutter minus rem edge inset when between 0 and max", () => {
    // font15 / 800: contentMax=720, sideGutter=40, edgeInset=11.25 → 28
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 15,
        viewportWidth: 800,
      }),
    ).toBe(
      Math.floor(
        (800 - CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH_REM * 15) / 2 -
          CHAT_TURN_MINIMAP_EDGE_INSET_REM * 15,
      ),
    );
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 15,
        viewportWidth: 800,
      }),
    ).toBe(28);
    // font20 / 1000: contentMax=960, sideGutter=20, edgeInset=15 → 5
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 20,
        viewportWidth: 1000,
      }),
    ).toBe(5);
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

describe("compactChatTurnMinimapPreview", () => {
  it("normalizes whitespace and drops empty text", () => {
    expect(compactChatTurnMinimapPreview("  hello\n\n  world  ")).toBe(
      "hello world",
    );
    expect(compactChatTurnMinimapPreview("   \n\t ")).toBeNull();
    expect(compactChatTurnMinimapPreview(null)).toBeNull();
    expect(compactChatTurnMinimapPreview(undefined)).toBeNull();
  });

  it("retains only a bounded head of a very long turn", () => {
    // The rail holds one of these per turn. Before this bound, a long
    // transcript kept a second full-length copy of itself here.
    const long = `Prompt ${"u".repeat(500_000)}`;
    const preview = compactChatTurnMinimapPreview(long);

    expect(preview).not.toBeNull();
    expect((preview ?? "").length).toBeLessThanOrEqual(
      CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS + 1,
    );
    expect((preview ?? "").startsWith("Prompt uuu")).toBe(true);
    // Elided rather than silently cut.
    expect((preview ?? "").endsWith("…")).toBe(true);
  });

  it("still fills the budget when the head is mostly whitespace", () => {
    // Collapsing runs of whitespace can shrink text far below the scan
    // window, so the scan has to read past the budget to fill it.
    const spaced = `${"a \n".repeat(100_000)}end`;
    const preview = compactChatTurnMinimapPreview(spaced);

    // Budget essentially filled (a trailing space may be trimmed before the
    // ellipsis), rather than starved by the collapse.
    expect((preview ?? "").length).toBeGreaterThan(
      CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS - 5,
    );
    expect((preview ?? "").length).toBeLessThanOrEqual(
      CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS + 1,
    );
    expect((preview ?? "").startsWith("a a a")).toBe(true);
  });

  it("leaves a short turn untouched and unelided", () => {
    expect(compactChatTurnMinimapPreview("short reply")).toBe("short reply");
  });
});

describe("compactChatTurnMinimapPreview surrogate safety", () => {
  it("never truncates in the middle of an astral character", () => {
    // The 200th UTF-16 unit lands inside the emoji, so a code-unit slice would
    // emit a lone high surrogate - rendered as a replacement glyph, and read
    // aloud by a screen reader since this text is also the jump target's
    // accessible name.
    const text = `${"a".repeat(199)}\u{1F600}${"b".repeat(300)}`;
    const preview = compactChatTurnMinimapPreview(text);
    if (preview === null) throw new Error("expected a preview");

    expect(preview).toBe(preview.replace(/\uFFFD/g, ""));
    for (let index = 0; index < preview.length; index += 1) {
      const code = preview.charCodeAt(index);
      const isLead = code >= 0xd800 && code <= 0xdbff;
      if (!isLead) continue;
      const next = preview.charCodeAt(index + 1);
      expect(Number.isNaN(next) ? -1 : next).toBeGreaterThanOrEqual(0xdc00);
    }
    // The pair is dropped whole rather than split.
    expect(preview.endsWith("\u2026")).toBe(true);
  });

  it("keeps an astral character that fits entirely inside the budget", () => {
    const preview = compactChatTurnMinimapPreview("hi \u{1F600} there");
    expect(preview).toBe("hi \u{1F600} there");
  });
});

describe("compactChatTurnMinimapPreview whitespace-heavy input", () => {
  it("finds the visible text after a long run of whitespace", () => {
    // A fixed-length prefix scan normalized this to the empty string and lost
    // the preview entirely - and with it the jump target's accessible name.
    const text = `${" ".repeat(900)}the actual message`;
    expect(compactChatTurnMinimapPreview(text)).toBe("the actual message");
  });

  it("still collapses interior whitespace to single spaces", () => {
    expect(compactChatTurnMinimapPreview("a\n\n\n  b\t\tc")).toBe("a b c");
  });

  it("truncates on visible characters, not on source offset", () => {
    const text = `${"\n".repeat(500)}${"z".repeat(400)}`;
    const preview = compactChatTurnMinimapPreview(text);
    if (preview === null) throw new Error("expected a preview");
    expect(preview.startsWith("z".repeat(50))).toBe(true);
    expect(preview.endsWith("\u2026")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(
      CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS + 1,
    );
  });
});
