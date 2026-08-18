/**
 * Regression suite for the field report: bottom-follow drops during live
 * streaming even though the reader is at the strict bottom - the Jump-to-end
 * pill surfaces with a streaming verb, and clicking it does not stick.
 *
 * Root cause these tests pin: the owned end-correction used to converge via
 * LegendList's imperative `scrollToEnd`, but the library defers that call
 * while it is settling a data change (`isSettlingAfterDataChange()` - a
 * pending data change, a columns change, or a queued MVCP recalculate),
 * waiting for two quiet frames or an 800ms cap, and every fresh imperative
 * scroll bumps its token and restarts the wait. A live stream holds the list
 * in that settling state continuously, so an imperative-only follow never
 * landed; the correction burned its bounded retry budget in the inter-chunk
 * pause and revoked follow intent, surfacing the pill even though the reader
 * never left the edge.
 *
 * The fix scrolls the owned correction to the live bottom synchronously (a
 * raw `scrollTop` write the browser clamps and LegendList reconciles via the
 * native scroll event), which cannot be starved by the settle gate. Test 1
 * models the gate directly: the imperative `scrollToEnd` NEVER moves the
 * scroll position (exactly what the deferred promise amounts to while the
 * list is settling), and bottom-follow must still converge and hold.
 */
import { act, cleanup, render } from "@testing-library/react";
import { createRef, createElement, type ReactNode, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import type { ChatTimelineFollowLatch } from "@/components/chat/chat-timeline-follow-latch";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { makeMessage, makeMessages } from "./chat-message-fixtures";
import {
  advanceLegendListFrames,
  installLegendListTestClock,
  installLegendListViewportMetrics,
  restoreLegendListTestClock,
  settleLegendList,
  setLegendListScrollContainerScrollHeightOverride,
} from "./legend-list-test-environment";

const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;
const ITEM_HEIGHT_PX = 90;
const LEGEND_LIST_HEADER_PX = 40;
const LEGEND_LIST_FOOTER_PX = 40;
const COMPOSER_INSET_PX = 80;

function contentHeightForRowCount(rowCount: number): number {
  return (
    LEGEND_LIST_HEADER_PX + rowCount * ITEM_HEIGHT_PX + LEGEND_LIST_FOOTER_PX
  );
}

function totalHeightFor(rowCount: number, streamingExtraPx: number): number {
  return (
    contentHeightForRowCount(rowCount) + streamingExtraPx + COMPOSER_INSET_PX
  );
}

function maxScrollTop(node: HTMLElement): number {
  return Math.max(0, node.scrollHeight - node.clientHeight);
}

function requireScrollNode(
  listRef: RefObject<LegendListRef | null>,
): HTMLElement {
  const node = listRef.current?.getScrollableNode();
  if (!node) {
    throw new Error("LegendList scrollable node is not mounted");
  }
  return node;
}

/**
 * Browser-faithful scroll-event delivery: the browser NEVER fires `scroll`
 * synchronously inside a `scrollTop` write - it coalesces and dispatches
 * asynchronously (before the next paint). The shared test shim's opt-in
 * dispatches synchronously, which hides every race between a write and its
 * event. This layer clamps writes exactly like the browser and delivers one
 * coalesced event on the next frame - one event per write-batch.
 */
function installAsyncBrowserScrollEvents(): void {
  const store = new WeakMap<HTMLElement, number>();
  const pendingDispatch = new WeakSet<HTMLElement>();

  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement): number {
      return store.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const clamped = Math.max(
        0,
        Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight)),
      );
      const previous = store.get(this) ?? 0;
      store.set(this, clamped);
      if (previous === clamped) return;
      if (pendingDispatch.has(this)) return;
      pendingDispatch.add(this);
      requestAnimationFrame(() => {
        pendingDispatch.delete(this);
        this.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    },
  });
}

interface RenderTimelineHandle {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly rerenderMessages: (
    messages: ReadonlyArray<ChatMessageModel>,
    insetPx: number,
  ) => void;
}

function renderTimeline(options: {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly insetPx: number;
  readonly onFollowIntentChange:
    | ((isFollowing: boolean) => void)
    | undefined;
}): RenderTimelineHandle {
  const listRef = createRef<LegendListRef | null>();
  const followLatchRef = createRef<ChatTimelineFollowLatch | null>();

  const jsx = (
    current: ReadonlyArray<ChatMessageModel>,
    insetPx: number,
  ): ReactNode =>
    createElement(
      "div",
      { style: { height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX } },
      createElement(ChatTimeline, {
        messages: current,
        taskTitle: "streaming follow",
        backgroundToolBlockIds: new Set(),
        getMessageActions: () => null,
        nextStepActions: null,
        listRef,
        className: "h-full",
        initialScrollAtEnd: true,
        contentInsetEndAdjustment: insetPx,
        onFollowIntentChange: options.onFollowIntentChange,
        followLatchRef,
      }),
    );

  const result = render(jsx(options.messages, options.insetPx));
  return {
    listRef,
    rerenderMessages: (messages, insetPx) => {
      result.rerender(jsx(messages, insetPx));
    },
  };
}

function growStreamingMessage(
  messages: ReadonlyArray<ChatMessageModel>,
  messageId: string,
  token: string,
): ReadonlyArray<ChatMessageModel> {
  return messages.map((message) =>
    message.id === messageId
      ? { ...message, content: `${message.content} ${token}` }
      : message,
  );
}

/** Park at the strict bottom and let both the latch and LegendList's own
 *  coalesced onScroll observe the landing (LegendList schedules its emit one
 *  frame behind the event; drain it here so it cannot land on a later,
 *  grown geometry out of band). */
async function parkAtStrictBottom(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.scrollTop = maxScrollTop(node);
  });
  await advanceLegendListFrames(1);
  await act(async () => {
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await advanceLegendListFrames(1);
}

describe("ChatTimeline streaming bottom-follow at production cadence", () => {
  beforeEach(() => {
    installLegendListViewportMetrics();
    installAsyncBrowserScrollEvents();
    installLegendListTestClock();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
    vi.restoreAllMocks();
  });

  it("keeps bottom-follow while LegendList's imperative scrollToEnd is starved by its settle gate", async () => {
    // 24 rows of history + one streaming assistant row.
    const rowCount = 24;
    const messages: ReadonlyArray<ChatMessageModel> = [
      ...makeMessages(rowCount - 1),
      {
        ...makeMessage(rowCount - 1, "assistant"),
        content: "stream start",
        runState: "running" as const,
      },
    ];
    const streamingId = messages[messages.length - 1]?.id ?? "";

    setLegendListScrollContainerScrollHeightOverride(
      totalHeightFor(rowCount, 0),
    );
    const onFollowIntentChange = vi.fn();
    const { listRef, rerenderMessages } = renderTimeline({
      messages,
      insetPx: COMPOSER_INSET_PX,
      onFollowIntentChange,
    });
    await settleLegendList();

    const node = requireScrollNode(listRef);
    const list = listRef.current;
    if (!list) throw new Error("LegendList ref is not mounted");
    await parkAtStrictBottom(node);
    expect(node.scrollTop).toBeGreaterThanOrEqual(maxScrollTop(node) - 1);

    // Model the library's settle gate: while a stream keeps the list
    // settling, the imperative `scrollToEnd` promise never applies a scroll
    // position (runWhenReady never sees two quiet frames and every re-issue
    // bumps the token). This is exactly the contract the field report hit -
    // proven against the installed library source (`isSettlingAfterDataChange`
    // / `runWhenReady` / `startImperativeScroll`).
    const starvedScrollToEnd = vi
      .spyOn(list, "scrollToEnd")
      .mockImplementation((): Promise<void> => new Promise(() => undefined));

    let current = messages;
    let streamingExtraPx = 0;
    const CHUNKS = 12;
    for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
      streamingExtraPx += 60;
      await act(async () => {
        list.setItemSize(streamingId, {
          height: ITEM_HEIGHT_PX + streamingExtraPx,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      current = growStreamingMessage(current, streamingId, `token-${chunk}`);
      setLegendListScrollContainerScrollHeightOverride(
        totalHeightFor(rowCount, streamingExtraPx),
      );
      await act(async () => {
        rerenderMessages(current, COMPOSER_INSET_PX);
      });
      // Inter-chunk pause comfortably longer than the correction's whole
      // bounded budget (5 attempts x 2 frames): on the old imperative-only
      // correction this is exactly the gap that exhausted the budget and
      // revoked follow intent.
      await advanceLegendListFrames(16);
    }

    expect(
      starvedScrollToEnd,
      "test setup must actually starve the imperative scroll",
    ).toHaveBeenCalled();
    expect(
      onFollowIntentChange,
      `follow intent revoked while the reader never left the edge; scrollTop=${node.scrollTop} max=${maxScrollTop(node)}`,
    ).not.toHaveBeenCalledWith(false);
    expect(node.scrollTop).toBeGreaterThanOrEqual(maxScrollTop(node) - 1);
  });

  it("reacquires follow when the reader scrolls to the bottom mid-stream and stays pinned under a starved imperative scroll", async () => {
    const rowCount = 24;
    const messages: ReadonlyArray<ChatMessageModel> = [
      ...makeMessages(rowCount - 1),
      {
        ...makeMessage(rowCount - 1, "assistant"),
        content: "stream start",
        runState: "running" as const,
      },
    ];
    const streamingId = messages[messages.length - 1]?.id ?? "";

    setLegendListScrollContainerScrollHeightOverride(
      totalHeightFor(rowCount, 0),
    );
    const onFollowIntentChange = vi.fn();
    const { listRef, rerenderMessages } = renderTimeline({
      messages,
      insetPx: COMPOSER_INSET_PX,
      onFollowIntentChange,
    });
    await settleLegendList();

    const node = requireScrollNode(listRef);
    const list = listRef.current;
    if (!list) throw new Error("LegendList ref is not mounted");
    await parkAtStrictBottom(node);
    onFollowIntentChange.mockClear();

    // Detach upward first (a real wheel-up + landing scroll).
    await act(async () => {
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -240 }));
      node.scrollTop = 120;
    });
    await advanceLegendListFrames(1);
    await act(async () => {
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    const starvedScrollToEnd = vi
      .spyOn(list, "scrollToEnd")
      .mockImplementation((): Promise<void> => new Promise(() => undefined));

    // The reply keeps streaming in while the reader wheels back down.
    let current = messages;
    let streamingExtraPx = 0;
    for (let chunk = 0; chunk < 8; chunk += 1) {
      streamingExtraPx += 60;
      await act(async () => {
        list.setItemSize(streamingId, {
          height: ITEM_HEIGHT_PX + streamingExtraPx,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      current = growStreamingMessage(current, streamingId, `more-${chunk}`);
      setLegendListScrollContainerScrollHeightOverride(
        totalHeightFor(rowCount, streamingExtraPx),
      );
      await act(async () => {
        rerenderMessages(current, COMPOSER_INSET_PX);
      });
      await advanceLegendListFrames(6);
    }

    // The reader's final toward-end gesture reaches the live bottom.
    await act(async () => {
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: 2000 }));
      node.scrollTop = maxScrollTop(node);
    });
    await advanceLegendListFrames(1);
    await act(async () => {
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await advanceLegendListFrames(2);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    onFollowIntentChange.mockClear();

    // Stream keeps growing under the starved imperative scroll - the
    // reacquired follow must hold and keep landing at the live bottom.
    for (let chunk = 0; chunk < 8; chunk += 1) {
      streamingExtraPx += 60;
      await act(async () => {
        list.setItemSize(streamingId, {
          height: ITEM_HEIGHT_PX + streamingExtraPx,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      current = growStreamingMessage(current, streamingId, `tail-${chunk}`);
      setLegendListScrollContainerScrollHeightOverride(
        totalHeightFor(rowCount, streamingExtraPx),
      );
      await act(async () => {
        rerenderMessages(current, COMPOSER_INSET_PX);
      });
      await advanceLegendListFrames(16);
    }

    expect(starvedScrollToEnd).toHaveBeenCalled();
    expect(
      onFollowIntentChange,
      `reacquired follow dropped during the stream; scrollTop=${node.scrollTop} max=${maxScrollTop(node)}`,
    ).not.toHaveBeenCalledWith(false);
    expect(node.scrollTop).toBeGreaterThanOrEqual(maxScrollTop(node) - 1);
  });

  it("keeps follow through a fast continuous token stream (no inter-chunk settle window)", async () => {
    const rowCount = 36;
    const messages: ReadonlyArray<ChatMessageModel> = [
      ...makeMessages(rowCount - 1),
      {
        ...makeMessage(rowCount - 1, "assistant"),
        content: "stream start",
        runState: "running" as const,
      },
    ];
    const streamingId = messages[messages.length - 1]?.id ?? "";

    setLegendListScrollContainerScrollHeightOverride(
      totalHeightFor(rowCount, 0),
    );
    const onFollowIntentChange = vi.fn();
    const { listRef, rerenderMessages } = renderTimeline({
      messages,
      insetPx: COMPOSER_INSET_PX,
      onFollowIntentChange,
    });
    await settleLegendList();

    const node = requireScrollNode(listRef);
    const list = listRef.current;
    if (!list) throw new Error("LegendList ref is not mounted");
    await parkAtStrictBottom(node);

    let current = messages;
    let streamingExtraPx = 0;
    let maxLagPx = 0;
    const CHUNKS = 80;
    for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
      streamingExtraPx += 24;
      await act(async () => {
        list.setItemSize(streamingId, {
          height: ITEM_HEIGHT_PX + streamingExtraPx,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      current = growStreamingMessage(current, streamingId, `t${chunk}`);
      setLegendListScrollContainerScrollHeightOverride(
        totalHeightFor(rowCount, streamingExtraPx),
      );
      await act(async () => {
        rerenderMessages(current, COMPOSER_INSET_PX);
      });
      await advanceLegendListFrames(2);
      const lag = maxScrollTop(node) - node.scrollTop;
      if (lag > maxLagPx) maxLagPx = lag;
    }
    await settleLegendList();
    expect(
      onFollowIntentChange,
      `follow revoked in fast stream; lag=${maxLagPx}px scrollTop=${node.scrollTop} max=${maxScrollTop(node)}`,
    ).not.toHaveBeenCalledWith(false);
    expect(node.scrollTop).toBeGreaterThanOrEqual(maxScrollTop(node) - 1);
  });

  it("keeps bottom-follow when the composer dock shrinks mid-stream while following", async () => {
    const rowCount = 36;
    const messages: ReadonlyArray<ChatMessageModel> = [
      ...makeMessages(rowCount - 1),
      {
        ...makeMessage(rowCount - 1, "assistant"),
        content: "stream start",
        runState: "running" as const,
      },
    ];
    const streamingId = messages[messages.length - 1]?.id ?? "";

    setLegendListScrollContainerScrollHeightOverride(
      totalHeightFor(rowCount, 0),
    );
    const onFollowIntentChange = vi.fn();
    const { listRef, rerenderMessages } = renderTimeline({
      messages,
      insetPx: COMPOSER_INSET_PX,
      onFollowIntentChange,
    });
    await settleLegendList();

    const node = requireScrollNode(listRef);
    const list = listRef.current;
    if (!list) throw new Error("LegendList ref is not mounted");
    await parkAtStrictBottom(node);
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);

    // Stream in some growth first so the reply is live.
    let current = messages;
    let streamingExtraPx = 240;
    await act(async () => {
      list.setItemSize(streamingId, {
        height: ITEM_HEIGHT_PX + streamingExtraPx,
        width: VIEWPORT_WIDTH_PX,
      });
    });
    current = growStreamingMessage(current, streamingId, "growth");
    setLegendListScrollContainerScrollHeightOverride(
      totalHeightFor(rowCount, streamingExtraPx),
    );
    await act(async () => {
      rerenderMessages(current, COMPOSER_INSET_PX);
    });
    await advanceLegendListFrames(4);
    expect(node.scrollTop).toBeGreaterThanOrEqual(maxScrollTop(node) - 1);

    // The dock collapses (queued surface flushed / pinned todos cleared)
    // while the reply is still streaming - the transcript's bottom inset
    // shrinks and the browser clamps scrollTop to the new max, firing a
    // scroll event at the clamped position. Bottom-follow must survive the
    // clamp; the reader never moved.
    const shrunkenInsetPx = 40;
    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(rowCount) + streamingExtraPx + shrunkenInsetPx,
    );
    await act(async () => {
      rerenderMessages(current, shrunkenInsetPx);
    });
    await act(async () => {
      node.scrollTop = maxScrollTop(node);
    });
    await advanceLegendListFrames(4);

    // And streaming continues after the shrink.
    streamingExtraPx += 60;
    await act(async () => {
      list.setItemSize(streamingId, {
        height: ITEM_HEIGHT_PX + streamingExtraPx,
        width: VIEWPORT_WIDTH_PX,
      });
    });
    current = growStreamingMessage(current, streamingId, "post-shrink");
    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(rowCount) + streamingExtraPx + shrunkenInsetPx,
    );
    await act(async () => {
      rerenderMessages(current, shrunkenInsetPx);
    });
    await settleLegendList();

    expect(
      onFollowIntentChange,
      `follow revoked by the clamp; scrollTop=${node.scrollTop} max=${maxScrollTop(node)}`,
    ).not.toHaveBeenCalledWith(false);
    expect(node.scrollTop).toBeGreaterThanOrEqual(maxScrollTop(node) - 1);
  });
});
