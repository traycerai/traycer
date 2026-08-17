import { describe, expect, it } from "vitest";
import {
  resolveMinimapTrackHeightStyle,
  resolveMinimapTrackIndexFromPointer,
  resolveMinimapTrackTopPercent,
  resolveMinimapTrackTopStyle,
} from "@/components/minimap/minimap-track-geometry";
import {
  CHAT_TURN_MINIMAP_END_HIT_PADDING,
  CHAT_TURN_MINIMAP_ITEM_SPACING,
  CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS,
  CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS,
  resolveChatTurnMinimapHeightStyle,
  resolveChatTurnMinimapIndexFromPointer,
  resolveChatTurnMinimapTopPercent,
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

describe("resolveMinimapTrackIndexFromPointer", () => {
  const base = {
    itemCount: 5,
    endHitPadding: 12,
    railTop: 100,
    railHeight: 200,
  };

  it("returns null for a non-positive item count or rail height", () => {
    expect(
      resolveMinimapTrackIndexFromPointer({
        ...base,
        itemCount: 0,
        pointerY: 150,
      }),
    ).toBeNull();
    expect(
      resolveMinimapTrackIndexFromPointer({
        ...base,
        railHeight: 0,
        pointerY: 150,
      }),
    ).toBeNull();
  });

  it("returns 0 for a single item regardless of pointer position", () => {
    expect(
      resolveMinimapTrackIndexFromPointer({
        ...base,
        itemCount: 1,
        pointerY: 999,
      }),
    ).toBe(0);
  });

  it("clamps a pointer above or below the rail to the first/last index", () => {
    expect(resolveMinimapTrackIndexFromPointer({ ...base, pointerY: 0 })).toBe(
      0,
    );
    expect(
      resolveMinimapTrackIndexFromPointer({ ...base, pointerY: 1000 }),
    ).toBe(4);
  });

  it("maps a mid-rail pointer to the nearest item, accounting for end padding", () => {
    // track spans [112, 288); midpoint 200 -> progress 0.5 -> index 2 of 5
    expect(
      resolveMinimapTrackIndexFromPointer({ ...base, pointerY: 200 }),
    ).toBe(2);
  });

  it("shrinks end padding rather than collapsing the track when the rail is too short", () => {
    // railHeight 10 -> clamped endPadding = max(0, (10-1)/2) = 4.5, trackHeight = 1
    const result = resolveMinimapTrackIndexFromPointer({
      itemCount: 3,
      endHitPadding: 12,
      railTop: 0,
      railHeight: 10,
      pointerY: 5,
    });
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(2);
  });
});

describe("equivalence with the chat rail's wrappers", () => {
  it("resolveMinimapTrackHeightStyle matches resolveChatTurnMinimapHeightStyle for chat's own constants", () => {
    for (const itemCount of [0, 1, 2, 7]) {
      expect(
        resolveMinimapTrackHeightStyle(
          {
            itemCount,
            itemSpacing: CHAT_TURN_MINIMAP_ITEM_SPACING,
            endHitPadding: CHAT_TURN_MINIMAP_END_HIT_PADDING,
          },
          [
            CHAT_TURN_MINIMAP_MAX_HEIGHT_CSS,
            CHAT_TURN_MINIMAP_PANE_MAX_HEIGHT_CSS,
          ],
        ),
      ).toBe(resolveChatTurnMinimapHeightStyle(itemCount));
    }
  });

  it("resolveMinimapTrackTopPercent matches resolveChatTurnMinimapTopPercent", () => {
    for (const [index, itemCount] of [
      [0, 0],
      [0, 1],
      [2, 5],
      [4, 5],
    ] as const) {
      expect(resolveMinimapTrackTopPercent(index, itemCount)).toBe(
        resolveChatTurnMinimapTopPercent(index, itemCount),
      );
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
          CHAT_TURN_MINIMAP_END_HIT_PADDING,
        ),
      ).toBe(resolveChatTurnMinimapTopStyle(index, itemCount));
    }
  });

  it("resolveMinimapTrackIndexFromPointer matches resolveChatTurnMinimapIndexFromPointer", () => {
    const input = { itemCount: 6, railTop: 20, railHeight: 300, pointerY: 150 };
    expect(
      resolveMinimapTrackIndexFromPointer({
        ...input,
        endHitPadding: CHAT_TURN_MINIMAP_END_HIT_PADDING,
      }),
    ).toBe(resolveChatTurnMinimapIndexFromPointer(input));
  });
});
