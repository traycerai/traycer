import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS,
  scrollChatBlockIntoView,
  useChatNavigationBlockReveal,
} from "@/components/chat/chat-navigation-highlight";

const pendingFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function flushAnimationFrames(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const callbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    act(() => {
      for (const callback of callbacks) callback(0);
    });
  }
}

describe("scrollChatBlockIntoView", () => {
  it("centers the matching block and ignores other rows", () => {
    const scroller = document.createElement("div");
    const otherRow = document.createElement("div");
    otherRow.dataset.messageId = "assistant:other";
    const otherBlock = document.createElement("div");
    otherBlock.dataset.blockId = "block-1";
    const otherBlockScrollIntoView = vi.fn();
    otherBlock.scrollIntoView = otherBlockScrollIntoView;
    otherRow.append(otherBlock);
    const row = document.createElement("div");
    row.dataset.messageId = "assistant:turn";
    const block = document.createElement("div");
    block.dataset.blockId = "block-1";
    const blockScrollIntoView = vi.fn();
    block.scrollIntoView = blockScrollIntoView;
    row.append(block);
    scroller.append(otherRow);
    scroller.append(row);

    expect(scrollChatBlockIntoView(scroller, "assistant:turn", "block-1")).toBe(
      "scrolled",
    );
    expect(blockScrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
      behavior: "auto",
    });
    expect(otherBlockScrollIntoView).not.toHaveBeenCalled();
    expect(scrollChatBlockIntoView(scroller, "assistant:turn", "missing")).toBe(
      "block-absent",
    );
    expect(scrollChatBlockIntoView(scroller, "missing-row", "block-1")).toBe(
      "row-absent",
    );
  });
});

describe("useChatNavigationBlockReveal", () => {
  beforeEach(() => {
    pendingFrames.clear();
    nextFrameId = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      pendingFrames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      pendingFrames.delete(id);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not consume retries while the row is unmounted, then reveals on mount", () => {
    const scroller = document.createElement("div");
    const scrollIntoView = vi.fn();
    const getScroller = (): HTMLElement | null => scroller;
    const { result } = renderHook(() =>
      useChatNavigationBlockReveal({ getScroller }),
    );

    act(() => {
      result.current.requestReveal("assistant:turn", "block-1");
    });
    flushAnimationFrames(1);
    expect(pendingFrames.size).toBe(0);
    flushAnimationFrames(12);

    const row = document.createElement("div");
    row.dataset.messageId = "assistant:turn";
    const block = document.createElement("div");
    block.dataset.blockId = "block-1";
    block.scrollIntoView = scrollIntoView;
    row.append(block);
    scroller.append(row);

    act(() => {
      result.current.onRowMount("assistant:turn");
    });
    flushAnimationFrames(2);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying a mounted row until the flash deadline so a late block still centers", () => {
    const now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const scroller = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.messageId = "assistant:turn";
    scroller.append(row);
    const { result } = renderHook(() =>
      useChatNavigationBlockReveal({ getScroller: () => scroller }),
    );

    act(() => {
      result.current.requestReveal("assistant:turn", "block-1");
    });
    flushAnimationFrames(8);
    expect(pendingFrames.size).toBe(1);

    const block = document.createElement("div");
    block.dataset.blockId = "block-1";
    const lateScrollIntoView = vi.fn();
    block.scrollIntoView = lateScrollIntoView;
    row.append(block);
    flushAnimationFrames(2);

    expect(lateScrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does not revive a reveal after the flash deadline", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const scroller = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.messageId = "assistant:turn";
    scroller.append(row);
    const { result } = renderHook(() =>
      useChatNavigationBlockReveal({ getScroller: () => scroller }),
    );

    act(() => {
      result.current.requestReveal("assistant:turn", "block-1");
    });
    flushAnimationFrames(1);

    now = CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS;
    const block = document.createElement("div");
    block.dataset.blockId = "block-1";
    const expiredScrollIntoView = vi.fn();
    block.scrollIntoView = expiredScrollIntoView;
    row.append(block);
    act(() => {
      result.current.onRowMount("assistant:turn");
    });
    flushAnimationFrames(2);

    expect(expiredScrollIntoView).not.toHaveBeenCalled();
  });

  it("does not revive a reveal after clearReveal", () => {
    const scroller = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.messageId = "assistant:turn";
    const block = document.createElement("div");
    block.dataset.blockId = "block-1";
    const clearedScrollIntoView = vi.fn();
    block.scrollIntoView = clearedScrollIntoView;
    row.append(block);
    scroller.append(row);
    const { result } = renderHook(() =>
      useChatNavigationBlockReveal({ getScroller: () => scroller }),
    );

    act(() => {
      result.current.requestReveal("assistant:turn", "block-1");
    });
    act(() => {
      result.current.clearReveal();
    });
    act(() => {
      result.current.onRowMount("assistant:turn");
    });
    flushAnimationFrames(2);

    expect(clearedScrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps a pending reveal when the scroller is missing and revives on row mount", () => {
    const scroller = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.messageId = "assistant:turn";
    const block = document.createElement("div");
    block.dataset.blockId = "block-1";
    const missingScrollerScrollIntoView = vi.fn();
    block.scrollIntoView = missingScrollerScrollIntoView;
    row.append(block);
    scroller.append(row);

    let current: HTMLElement | null = null;
    const { result } = renderHook(() =>
      useChatNavigationBlockReveal({ getScroller: () => current }),
    );

    act(() => {
      result.current.requestReveal("assistant:turn", "block-1");
    });
    flushAnimationFrames(4);
    expect(pendingFrames.size).toBe(0);
    expect(missingScrollerScrollIntoView).not.toHaveBeenCalled();

    current = scroller;
    act(() => {
      result.current.onRowMount("assistant:turn");
    });
    flushAnimationFrames(2);
    expect(missingScrollerScrollIntoView).toHaveBeenCalledTimes(1);
  });
});
