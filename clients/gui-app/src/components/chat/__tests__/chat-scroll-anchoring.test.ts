import { describe, expect, it } from "vitest";
import {
  CHAT_LIST_ANCHOR_OFFSET,
  chatTimelineRealContentOverflowsViewport,
  getChatAnchoredTurnMetrics,
  getChatRowBottom,
  resolveChatListAnchoredEndSpace,
  resolveChatTimelineIsAtEnd,
  shouldAcceptChatAnchorReadyEvent,
  type ChatTimelineListMeasurementState,
} from "@/components/chat/chat-scroll-anchoring";

function makeState(input: {
  readonly dataLength: number;
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positions: ReadonlyArray<number | undefined>;
  readonly sizes: ReadonlyArray<number | undefined>;
}): ChatTimelineListMeasurementState {
  return {
    data: Array.from({ length: input.dataLength }, (_, index) => ({
      id: index,
    })),
    scroll: input.scroll,
    scrollLength: input.scrollLength,
    positionAtIndex: (index) => input.positions[index],
    sizeAtIndex: (index) => input.sizes[index],
  };
}

describe("CHAT_LIST_ANCHOR_OFFSET", () => {
  it("starts below the compact 40px fade header", () => {
    expect(CHAT_LIST_ANCHOR_OFFSET).toBe(40);
  });
});

describe("getChatRowBottom", () => {
  it("returns top + max(1, height) for a measured row", () => {
    const state = makeState({
      dataLength: 2,
      scroll: 0,
      scrollLength: 700,
      positions: [0, 100],
      sizes: [100, 50],
    });
    expect(getChatRowBottom(state, 0)).toBe(100);
    expect(getChatRowBottom(state, 1)).toBe(150);
  });

  it("clamps zero height to 1 so a row still has a real bottom edge", () => {
    const state = makeState({
      dataLength: 1,
      scroll: 0,
      scrollLength: 700,
      positions: [40],
      sizes: [0],
    });
    expect(getChatRowBottom(state, 0)).toBe(41);
  });

  it("returns null when top or height is unmeasured", () => {
    const state = makeState({
      dataLength: 2,
      scroll: 0,
      scrollLength: 700,
      positions: [0, undefined],
      sizes: [undefined, 40],
    });
    expect(getChatRowBottom(state, 0)).toBeNull();
    expect(getChatRowBottom(state, 1)).toBeNull();
  });
});

describe("getChatAnchoredTurnMetrics", () => {
  it("returns null for empty data", () => {
    const state = makeState({
      dataLength: 0,
      scroll: 0,
      scrollLength: 700,
      positions: [],
      sizes: [],
    });
    expect(
      getChatAnchoredTurnMetrics({
        state,
        anchorIndex: 0,
        endInset: 80,
        anchorOffset: 16,
        topOffsetAdjustment: 0,
      }),
    ).toBeNull();
  });

  it("returns null when the anchor or last row is unmeasured", () => {
    const state = makeState({
      dataLength: 2,
      scroll: 0,
      scrollLength: 700,
      positions: [undefined, 100],
      sizes: [90, 90],
    });
    expect(
      getChatAnchoredTurnMetrics({
        state,
        anchorIndex: 0,
        endInset: 0,
        anchorOffset: 16,
        topOffsetAdjustment: 0,
      }),
    ).toBeNull();
  });

  it("computes usable viewport, turn height, overflow, and reveal delta", () => {
    // Rows: [0..100], [100..250]. Anchor at 0, last bottom 250.
    // viewport 700, endInset 100, anchorOffset 16 → usable = 584.
    // turnHeight = 250, no overflow; targetScroll = 0; delta = 0.
    const shortTurn = makeState({
      dataLength: 2,
      scroll: 0,
      scrollLength: 700,
      positions: [0, 100],
      sizes: [100, 150],
    });
    const shortMetrics = getChatAnchoredTurnMetrics({
      state: shortTurn,
      anchorIndex: 0,
      endInset: 100,
      anchorOffset: 16,
      topOffsetAdjustment: 0,
    });
    expect(shortMetrics).toEqual({
      anchorTop: 0,
      lastBottom: 250,
      turnHeight: 250,
      usableViewportHeight: 584,
      visibleUsableBottom: 584,
      overflowsUsableViewport: false,
      targetScrollToRevealEnd: 0,
      scrollDeltaToRevealEnd: 0,
    });

    // Tall turn: last bottom 900, scroll already 100.
    // usable = 700 - 80 - 16 = 604.
    // targetScroll = max(0, 900 - 604) = 296.
    // delta = max(0, 296 - 100) = 196.
    const tallTurn = makeState({
      dataLength: 3,
      scroll: 100,
      scrollLength: 700,
      positions: [0, 200, 700],
      sizes: [200, 500, 200],
    });
    const tallMetrics = getChatAnchoredTurnMetrics({
      state: tallTurn,
      anchorIndex: 1,
      endInset: 80,
      anchorOffset: 16,
      topOffsetAdjustment: 0,
    });
    expect(tallMetrics).toMatchObject({
      anchorTop: 200,
      lastBottom: 900,
      turnHeight: 700,
      usableViewportHeight: 604,
      visibleUsableBottom: 704,
      overflowsUsableViewport: true,
      targetScrollToRevealEnd: 296,
      scrollDeltaToRevealEnd: 196,
    });
  });

  it("normalizes the header-inclusive scroll before comparing the content-relative end", () => {
    const state = makeState({
      dataLength: 3,
      scroll: 296,
      scrollLength: 700,
      positions: [0, 200, 700],
      sizes: [200, 500, 200],
    });
    const metrics = getChatAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      endInset: 80,
      anchorOffset: 16,
      topOffsetAdjustment: 40,
    });

    // lastBottom=900 and usable=604. The content-relative viewport starts at
    // scroll-header=256, so its usable bottom is 860 and 40px remain. A bare
    // comparison against the header-inclusive scroll would incorrectly say 0.
    expect(metrics).toMatchObject({
      visibleUsableBottom: 860,
      targetScrollToRevealEnd: 296,
      scrollDeltaToRevealEnd: 40,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "treats a non-finite top-offset adjustment (%s) as zero",
    (topOffsetAdjustment) => {
      const state = makeState({
        dataLength: 3,
        scroll: 100,
        scrollLength: 700,
        positions: [0, 200, 700],
        sizes: [200, 500, 200],
      });
      const metrics = getChatAnchoredTurnMetrics({
        state,
        anchorIndex: 1,
        endInset: 80,
        anchorOffset: 16,
        topOffsetAdjustment,
      });

      expect(metrics).toMatchObject({
        visibleUsableBottom: 704,
        targetScrollToRevealEnd: 296,
        scrollDeltaToRevealEnd: 196,
      });
    },
  );

  it("clamps a negative usable viewport to 0", () => {
    const state = makeState({
      dataLength: 1,
      scroll: 0,
      scrollLength: 50,
      positions: [0],
      sizes: [200],
    });
    const metrics = getChatAnchoredTurnMetrics({
      state,
      anchorIndex: 0,
      endInset: 80,
      anchorOffset: 16,
      topOffsetAdjustment: 0,
    });
    expect(metrics?.usableViewportHeight).toBe(0);
    expect(metrics?.targetScrollToRevealEnd).toBe(200);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(200);
  });

  it("bounds an out-of-range anchor index to the data range", () => {
    const state = makeState({
      dataLength: 2,
      scroll: 0,
      scrollLength: 700,
      positions: [0, 100],
      sizes: [100, 100],
    });
    const metrics = getChatAnchoredTurnMetrics({
      state,
      anchorIndex: 99,
      endInset: 0,
      anchorOffset: 0,
      topOffsetAdjustment: 0,
    });
    // Clamped to last row (index 1).
    expect(metrics?.anchorTop).toBe(100);
    expect(metrics?.turnHeight).toBe(100);
  });
});

describe("chatTimelineRealContentOverflowsViewport", () => {
  it("returns false for empty or unmeasured content", () => {
    expect(
      chatTimelineRealContentOverflowsViewport(
        makeState({
          dataLength: 0,
          scroll: 0,
          scrollLength: 700,
          positions: [],
          sizes: [],
        }),
        0,
        16,
      ),
    ).toBe(false);

    expect(
      chatTimelineRealContentOverflowsViewport(
        makeState({
          dataLength: 1,
          scroll: 0,
          scrollLength: 700,
          positions: [undefined],
          sizes: [100],
        }),
        0,
        16,
      ),
    ).toBe(false);
  });

  it("compares last-row bottom against usable scroll length", () => {
    const state = makeState({
      dataLength: 2,
      scroll: 0,
      scrollLength: 700,
      positions: [0, 600],
      sizes: [600, 200],
    });
    // lastBottom = 800; usable = 700 - 80 - 16 = 604 → overflows
    expect(chatTimelineRealContentOverflowsViewport(state, 80, 16)).toBe(true);
    // usable = 700 - 0 - 0 = 700; lastBottom 800 still overflows
    expect(chatTimelineRealContentOverflowsViewport(state, 0, 0)).toBe(true);

    const short = makeState({
      dataLength: 1,
      scroll: 0,
      scrollLength: 700,
      positions: [0],
      sizes: [100],
    });
    expect(chatTimelineRealContentOverflowsViewport(short, 0, 16)).toBe(false);
  });
});

describe("resolveChatListAnchoredEndSpace", () => {
  const items = [
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "b" }, // duplicate id near the end - search from tail
  ];

  it("returns undefined when anchorId is null", () => {
    expect(
      resolveChatListAnchoredEndSpace(items, null, (item) => item.id, 16),
    ).toBeUndefined();
  });

  it("returns undefined when the anchor id is not present", () => {
    expect(
      resolveChatListAnchoredEndSpace(items, "missing", (item) => item.id, 16),
    ).toBeUndefined();
  });

  it("searches from the end so the latest matching id wins", () => {
    expect(
      resolveChatListAnchoredEndSpace(items, "b", (item) => item.id, 24),
    ).toEqual({ anchorIndex: 3, anchorOffset: 24 });
  });

  it("finds a unique mid-list anchor", () => {
    expect(
      resolveChatListAnchoredEndSpace(items, "a", (item) => item.id, 16),
    ).toEqual({ anchorIndex: 0, anchorOffset: 16 });
  });
});

describe("resolveChatTimelineIsAtEnd", () => {
  it("uses only the strict live-edge signal", () => {
    expect(
      resolveChatTimelineIsAtEnd({ isNearEnd: true, isAtEnd: false }),
    ).toBe(false);
    expect(
      resolveChatTimelineIsAtEnd({ isNearEnd: false, isAtEnd: true }),
    ).toBe(true);
  });

  it("reads isAtEnd when proximity metadata is absent", () => {
    expect(resolveChatTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveChatTimelineIsAtEnd({ isAtEnd: false })).toBe(false);
  });

  it("returns undefined when state is undefined or both flags absent", () => {
    expect(resolveChatTimelineIsAtEnd(undefined)).toBeUndefined();
    expect(resolveChatTimelineIsAtEnd({})).toBeUndefined();
  });
});

describe("shouldAcceptChatAnchorReadyEvent (H4)", () => {
  it("accepts when messageId matches the pending anchor", () => {
    expect(
      shouldAcceptChatAnchorReadyEvent({
        messageId: "user-1",
        pendingAnchorMessageId: "user-1",
        positionedAnchorMessageId: null,
      }),
    ).toBe(true);
  });

  it("accepts when messageId matches the positioned anchor", () => {
    expect(
      shouldAcceptChatAnchorReadyEvent({
        messageId: "user-1",
        pendingAnchorMessageId: null,
        positionedAnchorMessageId: "user-1",
      }),
    ).toBe(true);
  });

  it("accepts when messageId matches either pending or positioned", () => {
    expect(
      shouldAcceptChatAnchorReadyEvent({
        messageId: "user-1",
        pendingAnchorMessageId: "user-1",
        positionedAnchorMessageId: "user-1",
      }),
    ).toBe(true);
  });

  it("rejects when messageId matches neither (stale/cancelled/superseded)", () => {
    expect(
      shouldAcceptChatAnchorReadyEvent({
        messageId: "user-old",
        pendingAnchorMessageId: null,
        positionedAnchorMessageId: null,
      }),
    ).toBe(false);

    expect(
      shouldAcceptChatAnchorReadyEvent({
        messageId: "user-old",
        pendingAnchorMessageId: "user-new",
        positionedAnchorMessageId: null,
      }),
    ).toBe(false);

    expect(
      shouldAcceptChatAnchorReadyEvent({
        messageId: "user-old",
        pendingAnchorMessageId: null,
        positionedAnchorMessageId: "user-new",
      }),
    ).toBe(false);
  });
});
