import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LegendListRef, LegendListState } from "@legendapp/list/react";
import { preserveChatScrollAcrossDisclosureChange } from "@/components/chat/chat-scroll-disclosure";

type DisclosureList = Pick<LegendListRef, "getState" | "scrollToOffset">;

describe("preserveChatScrollAcrossDisclosureChange", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockRect(bottom: number): DOMRect {
    return {
      x: 0,
      y: bottom - 40,
      width: 100,
      height: 40,
      top: bottom - 40,
      left: 0,
      right: 100,
      bottom,
      toJSON: () => ({}),
    };
  }

  function fakeList(scroll: number): {
    readonly list: DisclosureList;
    readonly scrollToOffset: Mock;
  } {
    const scrollToOffset = vi.fn();
    // The helper only reads `.scroll` off getState(); satisfy LegendListState
    // without fabricating every measurement field.
    const list: DisclosureList = {
      getState: () => ({ scroll }) as LegendListState,
      scrollToOffset,
    };
    return { list, scrollToOffset };
  }

  it("runs mutate via flushSync even when list/anchor are null", () => {
    const mutate = vi.fn();
    preserveChatScrollAcrossDisclosureChange({
      list: null,
      anchorElement: null,
      mutate,
    });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("does not scroll when the anchor bottom moves by less than 0.5px", () => {
    const { list, scrollToOffset } = fakeList(200);
    const anchor = document.createElement("div");
    const rect = vi.spyOn(anchor, "getBoundingClientRect");
    rect.mockReturnValueOnce(mockRect(400));
    rect.mockReturnValueOnce(mockRect(400.4));

    preserveChatScrollAcrossDisclosureChange({
      list,
      anchorElement: anchor,
      mutate: () => undefined,
    });

    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it("corrects scroll by the anchor-bottom delta when it is large enough", () => {
    const { list, scrollToOffset } = fakeList(200);
    const anchor = document.createElement("div");
    const rect = vi.spyOn(anchor, "getBoundingClientRect");
    rect.mockReturnValueOnce(mockRect(400));
    // Expand: bottom moves down by 80px → scroll must increase by 80.
    rect.mockReturnValueOnce(mockRect(480));

    const mutate = vi.fn();
    preserveChatScrollAcrossDisclosureChange({
      list,
      anchorElement: anchor,
      mutate,
    });

    expect(mutate).toHaveBeenCalledOnce();
    expect(scrollToOffset).toHaveBeenCalledWith({
      offset: 280,
      animated: false,
    });
  });

  it("corrects upward (collapse) by a negative delta", () => {
    const { list, scrollToOffset } = fakeList(500);
    const anchor = document.createElement("div");
    const rect = vi.spyOn(anchor, "getBoundingClientRect");
    rect.mockReturnValueOnce(mockRect(600));
    rect.mockReturnValueOnce(mockRect(520));

    preserveChatScrollAcrossDisclosureChange({
      list,
      anchorElement: anchor,
      mutate: () => undefined,
    });

    expect(scrollToOffset).toHaveBeenCalledWith({
      offset: 420,
      animated: false,
    });
  });

  it("skips correction when list is null after mutate", () => {
    const anchor = document.createElement("div");
    vi.spyOn(anchor, "getBoundingClientRect")
      .mockReturnValueOnce(mockRect(400))
      .mockReturnValueOnce(mockRect(500));

    expect(() =>
      preserveChatScrollAcrossDisclosureChange({
        list: null,
        anchorElement: anchor,
        mutate: () => undefined,
      }),
    ).not.toThrow();
  });

  it("skips correction when anchorElement is null (mutate still runs)", () => {
    const { list, scrollToOffset } = fakeList(10);
    const mutate = vi.fn();
    preserveChatScrollAcrossDisclosureChange({
      list,
      anchorElement: null,
      mutate,
    });
    expect(mutate).toHaveBeenCalledOnce();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  // Anchor is itself the expanding row: top edge stays put while bottom grows
  // (content added below a fixed top). Measuring `.top` correctly reports no
  // shift; measuring `.bottom` would spuriously correct by the growth amount.
  it("does not correct scroll when the anchor grows downward (top fixed, bottom expands)", () => {
    const { list, scrollToOffset } = fakeList(200);
    const anchor = document.createElement("div");
    const rect = vi.spyOn(anchor, "getBoundingClientRect");
    // Before expand: top=100, height=40, bottom=140.
    rect.mockReturnValueOnce(mockRectAt(100, 40));
    // After expand: top stays 100, height grows to 120, bottom=220.
    rect.mockReturnValueOnce(mockRectAt(100, 120));

    preserveChatScrollAcrossDisclosureChange({
      list,
      anchorElement: anchor,
      mutate: () => undefined,
    });

    expect(scrollToOffset).not.toHaveBeenCalled();
  });
});

function mockRectAt(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 100,
    height,
    top,
    left: 0,
    right: 100,
    bottom: top + height,
    toJSON: () => ({}),
  };
}
