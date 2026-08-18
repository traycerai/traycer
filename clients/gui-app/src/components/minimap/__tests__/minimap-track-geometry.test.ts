import { describe, expect, it } from "vitest";
import {
  MINIMAP_TRACK_END_HIT_PADDING,
  MINIMAP_TRACK_ITEM_SPACING,
  resolveMinimapTrackHeightStyle,
  resolveMinimapTrackTopPercent,
  resolveMinimapTrackTopStyle,
  resolveMinimapVisibleItemCapacity,
  resolveMinimapWindow,
} from "@/components/minimap/minimap-track-geometry";
import {
  CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS,
  resolveChatTurnMinimapHeightStyle,
  resolveChatTurnMinimapTopStyle,
} from "@/components/chat/chat-turn-minimap-logic";

describe("resolveMinimapTrackHeightStyle", () => {
  it("floors the natural track height at 1px for a degenerate item count", () => {
    expect(
      resolveMinimapTrackHeightStyle(
        { itemCount: 0, itemSpacing: 8, endHitPadding: 12 },
        ["100px"],
      ),
    ).toBe("min(25px, 100px)");
    expect(
      resolveMinimapTrackHeightStyle(
        { itemCount: 1, itemSpacing: 8, endHitPadding: 12 },
        ["100px"],
      ),
    ).toBe("min(25px, 100px)");
  });

  it("adds spacing per gap and doubles the end padding, capped by every supplied max height in order", () => {
    expect(
      resolveMinimapTrackHeightStyle(
        { itemCount: 5, itemSpacing: 8, endHitPadding: 12 },
        ["50vh", "calc(100% - 1rem)"],
      ),
    ).toBe("min(56px, 50vh, calc(100% - 1rem))");
  });

  it("passes through with no caps when none are supplied", () => {
    expect(
      resolveMinimapTrackHeightStyle(
        { itemCount: 3, itemSpacing: 10, endHitPadding: 0 },
        [],
      ),
    ).toBe("min(20px)");
  });
});

describe("dynamic visible window", () => {
  it("uses at most half of the available height", () => {
    expect(resolveMinimapVisibleItemCapacity(400)).toBe(23);
    expect(resolveMinimapVisibleItemCapacity(600)).toBe(35);
  });

  it("centers the visible items around the current item", () => {
    expect(
      resolveMinimapWindow({ currentIndex: 25, itemCount: 50, maxItems: 35 }),
    ).toEqual({
      startIndex: 8,
      endIndex: 43,
      hasBefore: true,
      hasAfter: true,
    });
  });
});

describe("resolveMinimapTrackTopPercent", () => {
  it("returns 0 for zero or one item", () => {
    expect(resolveMinimapTrackTopPercent(0, 0)).toBe(0);
    expect(resolveMinimapTrackTopPercent(0, 1)).toBe(0);
  });

  it("evenly spaces first/middle/last across many items", () => {
    expect(resolveMinimapTrackTopPercent(0, 4)).toBe(0);
    expect(resolveMinimapTrackTopPercent(1, 4)).toBeCloseTo(33.333, 2);
    expect(resolveMinimapTrackTopPercent(3, 4)).toBe(100);
  });

  it("clamps an out-of-range index into [0, itemCount - 1]", () => {
    expect(resolveMinimapTrackTopPercent(-1, 4)).toBe(0);
    expect(resolveMinimapTrackTopPercent(10, 4)).toBe(100);
  });
});

describe("resolveMinimapTrackTopStyle", () => {
  it("pushes the first marker down and the last marker up by the end padding", () => {
    expect(resolveMinimapTrackTopStyle(0, 4, 12)).toBe("calc(0% + 12px)");
    expect(resolveMinimapTrackTopStyle(3, 4, 12)).toBe("calc(100% - 12px)");
  });

  it("returns a bare percentage at the midpoint, where the pixel offset is 0", () => {
    expect(resolveMinimapTrackTopStyle(1, 3, 12)).toBe("50%");
  });

  it("still offsets the single-item case (percent 0, non-zero padding)", () => {
    expect(resolveMinimapTrackTopStyle(0, 1, 12)).toBe("calc(0% + 12px)");
  });

  it("returns a bare percentage everywhere when end padding is 0", () => {
    expect(resolveMinimapTrackTopStyle(0, 4, 0)).toBe("0%");
    expect(resolveMinimapTrackTopStyle(3, 4, 0)).toBe("100%");
  });
});

describe("equivalence with the chat rail's wrappers", () => {
  it("resolveMinimapTrackHeightStyle matches resolveChatTurnMinimapHeightStyle for chat's own constants", () => {
    for (const itemCount of [0, 1, 2, 7]) {
      expect(
        resolveMinimapTrackHeightStyle(
          {
            itemCount,
            itemSpacing: MINIMAP_TRACK_ITEM_SPACING,
            endHitPadding: MINIMAP_TRACK_END_HIT_PADDING,
          },
          [CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS],
        ),
      ).toBe(resolveChatTurnMinimapHeightStyle(itemCount));
    }
  });

  it("resolveMinimapTrackTopStyle matches resolveChatTurnMinimapTopStyle for chat's own end padding", () => {
    for (const [index, itemCount] of [
      [0, 4],
      [1, 3],
      [3, 4],
    ] as const) {
      expect(
        resolveMinimapTrackTopStyle(
          index,
          itemCount,
          MINIMAP_TRACK_END_HIT_PADDING,
        ),
      ).toBe(resolveChatTurnMinimapTopStyle(index, itemCount));
    }
  });
});
