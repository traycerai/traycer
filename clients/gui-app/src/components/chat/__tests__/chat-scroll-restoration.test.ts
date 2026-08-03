import { describe, expect, it } from "vitest";
import {
  captureChatFreeScrollingOffset,
  resolveChatTimelineIsAtEnd,
  type ChatFreeScrollingMeasurementSource,
} from "@/components/chat/chat-scroll-restoration";

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

describe("captureChatFreeScrollingOffset", () => {
  function listWith(
    position: number | undefined,
    scroll: number,
    topOffsetAdjustment: number | undefined,
  ): ChatFreeScrollingMeasurementSource {
    return {
      getState: () => ({
        positionAtIndex: (index: number) =>
          index === 0 ? position : undefined,
        scroll,
        topOffsetAdjustment,
      }),
    };
  }

  it("returns 0 when list is null or index is undefined", () => {
    expect(captureChatFreeScrollingOffset(null, 0)).toBe(0);
    expect(
      captureChatFreeScrollingOffset(listWith(100, 40, 0), undefined),
    ).toBe(0);
  });

  it("returns 0 when the row is unmeasured or non-finite", () => {
    expect(captureChatFreeScrollingOffset(listWith(undefined, 40, 0), 0)).toBe(
      0,
    );
    expect(captureChatFreeScrollingOffset(listWith(Number.NaN, 40, 0), 0)).toBe(
      0,
    );
  });

  it("captures position + topOffsetAdjustment - scroll (decision #18)", () => {
    // Content-relative position 500, header pad 40, DOM scroll 200 →
    // viewOffset that restores the same pixel is 340.
    expect(captureChatFreeScrollingOffset(listWith(500, 200, 40), 0)).toBe(
      500 + 40 - 200,
    );
  });

  it("treats a missing or non-finite topOffsetAdjustment as 0", () => {
    expect(
      captureChatFreeScrollingOffset(listWith(500, 2000, undefined), 0),
    ).toBe(500 - 2000);
    expect(
      captureChatFreeScrollingOffset(listWith(720, 360, Number.NaN), 0),
    ).toBe(720 - 360);
  });
});
