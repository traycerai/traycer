/**
 * Real-`@legendapp/list` integration coverage for the chat-timeline follow
 * latch wiring (fixup: callback-synchronous-follow).
 *
 * The pure/hook-level latch suite (`chat-timeline-follow-latch.test.ts`) already
 * proves the latch itself is sound against a hand-constructed `LegendListRef`.
 * This file mounts the real `LegendList` via `ChatTimeline` and asserts the
 * production wiring at actual callback boundaries - especially the review's
 * no-rerender item/footer/viewport ordering that the rejected render-gated
 * design could not close.
 *
 * Assertions target real DOM geometry (scrollTop at/away from the true end),
 * never `scrollToEnd` call counts. Production may skip a redundant
 * `scrollToEnd` when already at the strict edge (destructive-clamp contract).
 * The latch ResizeObserver is a maintain trigger. It may reconcile a fresh
 * strict-bottom landing, but non-bottom geometry never grants permission or
 * moves a detached reader.
 *
 * Do not duplicate the hook-level numeric sequences; only real-library wiring
 * proofs belong here.
 */
import { act, cleanup, render } from "@testing-library/react";
import { createRef, type ReactNode, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import type { ChatTimelineFollowLatch } from "@/components/chat/chat-timeline-follow-latch";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { makeMessage, makeMessages } from "./chat-message-fixtures";
import {
  installLegendListViewportMetrics,
  setLegendListScrollContainerScrollHeightOverride,
  settleLegendList,
} from "./legend-list-test-environment";

const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;
const ITEM_HEIGHT_PX = 90;
// Matches `legend-list-test-environment.ts` spacer shells (header + footer).
const LEGEND_LIST_HEADER_PX = 40;
const LEGEND_LIST_FOOTER_PX = 40;
const PIXEL_STABILITY_EPSILON_PX = 1;

function contentHeightForRowCount(rowCount: number): number {
  return (
    LEGEND_LIST_HEADER_PX + rowCount * ITEM_HEIGHT_PX + LEGEND_LIST_FOOTER_PX
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

/** Real native `scroll` dispatch - matches the latch's direct passive listener. */
function fireNativeScroll(node: HTMLElement): void {
  node.dispatchEvent(new Event("scroll", { bubbles: true }));
}

function parkAtStrictBottom(node: HTMLElement): number {
  const max = maxScrollTop(node);
  node.scrollTop = max;
  fireNativeScroll(node);
  return node.scrollTop;
}

/**
 * Detach via recognized wheel intent, a real DOM scrollTop write, and a
 * native scroll event.
 * Deliberately no React re-render - this is the review's silent-detach
 * ordering that must leave the latch denying follow on the next callback.
 */
function detachReader(node: HTMLElement, scrollTop: number): number {
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
  node.scrollTop = scrollTop;
  fireNativeScroll(node);
  return node.scrollTop;
}

function expectPixelStable(node: HTMLElement, parked: number): void {
  expect(Math.abs(node.scrollTop - parked)).toBeLessThanOrEqual(
    PIXEL_STABILITY_EPSILON_PX,
  );
}

function expectAtTrueEnd(node: HTMLElement): void {
  expect(node.scrollTop).toBeGreaterThanOrEqual(maxScrollTop(node) - 1);
}

// --- Controllable ResizeObserver ------------------------------------------
// The global MockResizeObserver from test-browser-apis is a total no-op.
// The latch installs its OWN observer on the scroll node for the viewport-
// layout trigger; we need that callback to fire on demand. LegendList also
// uses a module-scoped global observer for footer/header layout - when this
// controllable class is installed before the first LegendList mount in the
// file, that singleton is controllable too.

interface ControllableResizeObserverInstance extends ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed: Set<Element>;
}

let controllableObservers: ControllableResizeObserverInstance[] = [];

class ControllableResizeObserver implements ControllableResizeObserverInstance {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    controllableObservers.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }
}

function installControllableResizeObserver(): void {
  controllableObservers = [];
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ControllableResizeObserver,
  });
}

/**
 * Fire every captured ResizeObserver. Prefer entry-shaped payloads for
 * observers that care about contentRect (LegendList footer/header layout);
 * the latch's own callback ignores entries entirely.
 */
function fireAllResizeObservers(
  buildEntry: (target: Element) => ResizeObserverEntry | null,
): void {
  for (const observer of [...controllableObservers]) {
    const entries: ResizeObserverEntry[] = [];
    for (const target of observer.observed) {
      const entry = buildEntry(target);
      if (entry) entries.push(entry);
    }
    // Latch ignores entries; still invoke with whatever we have (possibly []).
    observer.callback(entries, observer);
  }
}

function makeResizeEntry(
  target: Element,
  width: number,
  height: number,
): ResizeObserverEntry {
  const contentRect = {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  } as DOMRectReadOnly;
  return {
    target,
    contentRect,
    borderBoxSize: [{ inlineSize: width, blockSize: height }],
    contentBoxSize: [{ inlineSize: width, blockSize: height }],
    devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
  };
}

/**
 * Instance-level clientHeight override. The shared viewport-metrics shim
 * spies the prototype; an own-property getter on the node wins, so this is
 * how a single scroll container can report unmeasurable 0x0 geometry without
 * restacking the prototype spy (which recurses).
 */
function setNodeClientHeight(node: HTMLElement, height: number): void {
  Object.defineProperty(node, "clientHeight", {
    configurable: true,
    enumerable: true,
    get: () => height,
  });
}

function clearNodeClientHeight(node: HTMLElement): void {
  Reflect.deleteProperty(node, "clientHeight");
}

interface RenderTimelineOptions {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly listRef: RefObject<LegendListRef | null> | undefined;
  readonly initialScrollAtEnd: boolean | undefined;
  readonly contentInsetEndAdjustment: number | undefined;
  readonly onItemSizeChanged: (() => void) | undefined;
  readonly onListMetricsChange:
    | ((metrics: {
        readonly headerSize: number;
        readonly footerSize: number;
      }) => void)
    | undefined;
  readonly onFollowIntentChange: ((isFollowing: boolean) => void) | undefined;
  readonly followLatchRef:
    | RefObject<ChatTimelineFollowLatch | null>
    | undefined;
}

interface RerenderTimelineOptions {
  readonly contentInsetEndAdjustment: number | undefined;
  readonly initialScrollAtEnd: boolean | undefined;
}

interface RenderTimelineResult {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly rerenderMessages: (
    messages: ReadonlyArray<ChatMessageModel>,
    next: RerenderTimelineOptions | undefined,
  ) => void;
  readonly unmount: () => void;
}

function renderTimeline(
  options: Partial<RenderTimelineOptions> & {
    readonly messages: ReadonlyArray<ChatMessageModel>;
  },
): RenderTimelineResult {
  const listRef = options.listRef ?? createRef<LegendListRef | null>();

  const jsx = (
    messages: ReadonlyArray<ChatMessageModel>,
    contentInsetEndAdjustment: number,
    initialScrollAtEnd: boolean,
  ): ReactNode => (
    <div
      style={{
        height: VIEWPORT_HEIGHT_PX,
        width: VIEWPORT_WIDTH_PX,
      }}
    >
      <ChatTimeline
        rows={transcriptListRows({ window: null, rendered: messages })}
        taskTitle="follow-latch integration"
        backgroundToolBlockIds={new Set()}
        getMessageActions={() => null}
        nextStepActions={null}
        listRef={listRef}
        className="h-full"
        initialScrollAtEnd={initialScrollAtEnd}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        onItemSizeChanged={options.onItemSizeChanged}
        onListMetricsChange={options.onListMetricsChange}
        onFollowIntentChange={options.onFollowIntentChange}
        followLatchRef={options.followLatchRef}
      />
    </div>
  );

  let currentInset = options.contentInsetEndAdjustment ?? 0;
  let currentInitialScrollAtEnd = options.initialScrollAtEnd ?? true;

  const result = render(
    jsx(options.messages, currentInset, currentInitialScrollAtEnd),
  );

  return {
    listRef,
    unmount: result.unmount,
    rerenderMessages: (
      messages: ReadonlyArray<ChatMessageModel>,
      next: RerenderTimelineOptions | undefined,
    ) => {
      if (next?.contentInsetEndAdjustment !== undefined) {
        currentInset = next.contentInsetEndAdjustment;
      }
      if (next?.initialScrollAtEnd !== undefined) {
        currentInitialScrollAtEnd = next.initialScrollAtEnd;
      }
      result.rerender(jsx(messages, currentInset, currentInitialScrollAtEnd));
    },
  };
}

function appendAssistantRows(
  messages: ReadonlyArray<ChatMessageModel>,
  count: number,
  idPrefix: string,
): ReadonlyArray<ChatMessageModel> {
  const start = messages.length;
  const extras = Array.from({ length: count }, (_unused, index) => {
    const absolute = start + index;
    return {
      ...makeMessage(absolute, "assistant"),
      id: `${idPrefix}-${index}`,
      createdAt: 100_000 + absolute,
      content: `streamed ${idPrefix} ${index}`,
    };
  });
  return [...messages, ...extras];
}

function growAssistantInPlace(
  messages: ReadonlyArray<ChatMessageModel>,
  messageId: string,
  extraText: string,
): ReadonlyArray<ChatMessageModel> {
  return messages.map((message) =>
    message.id === messageId
      ? { ...message, content: `${message.content}${extraText}` }
      : message,
  );
}

describe("ChatTimeline follow-latch real-LegendList integration", () => {
  beforeEach(() => {
    installControllableResizeObserver();
    installLegendListViewportMetrics();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // Restore the setup-file no-op ResizeObserver so sibling suites in the
    // same worker are not left with a live controllable class.
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: class MockResizeObserver {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    });
    controllableObservers = [];
  });

  // -----------------------------------------------------------------------
  // 1. Production-order owned correction and reader reattachment
  // -----------------------------------------------------------------------

  it("converges through a no-settle user/assistant/reasoning/text/tool/inset burst, then honors reader detach and strict-end reacquisition", async () => {
    const rowCount = 36;
    const composerInset = 160;
    const baseMessages = makeMessages(rowCount);
    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(rowCount) + composerInset,
    );
    const followLatchRef = createRef<ChatTimelineFollowLatch | null>();
    const onFollowIntentChange = vi.fn();
    const { listRef, rerenderMessages } = renderTimeline({
      messages: baseMessages,
      contentInsetEndAdjustment: composerInset,
      followLatchRef,
      onFollowIntentChange,
    });
    await settleLegendList();

    const node = requireScrollNode(listRef);
    parkAtStrictBottom(node);
    const list = listRef.current;
    if (!list) throw new Error("LegendList ref not mounted");
    const ownedUnderLanding = vi
      .spyOn(list, "scrollToEnd")
      .mockImplementation((): Promise<void> => {
        node.scrollTop = Math.max(0, maxScrollTop(node) - 72);
        fireNativeScroll(node);
        return Promise.resolve();
      });

    const userAppend = [
      ...baseMessages,
      {
        ...makeMessage(rowCount, "user"),
        id: "burst-user",
        content: "send with composer chrome present",
      },
    ];
    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(userAppend.length) + composerInset,
    );
    rerenderMessages(userAppend, undefined);

    const assistantBase = {
      ...makeMessage(rowCount + 1, "assistant"),
      id: "burst-assistant",
    };
    const assistantAppend = [...userAppend, assistantBase];
    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(assistantAppend.length) + composerInset + 40,
    );
    rerenderMessages(assistantAppend, undefined);

    const withReasoning = [
      ...userAppend,
      {
        ...assistantBase,
        content: "Thinking through the request",
      },
    ];
    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(withReasoning.length) + composerInset + 180,
    );
    rerenderMessages(withReasoning, undefined);
    act(() => {
      list.setItemSize("burst-assistant", {
        height: 270,
        width: VIEWPORT_WIDTH_PX,
      });
    });

    const withText = withReasoning.map((message) =>
      message.id === "burst-assistant"
        ? {
            ...message,
            content: `${message.content}\nStreaming answer text`,
          }
        : message,
    );
    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(withText.length) + composerInset + 300,
    );
    rerenderMessages(withText, undefined);

    const withToolStatus = withText.map((message) =>
      message.id === "burst-assistant"
        ? {
            ...message,
            content: `${message.content}\nTool output`,
            statusLabel: "Running tool",
          }
        : message,
    );
    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(withToolStatus.length) + composerInset + 440,
    );
    rerenderMessages(withToolStatus, {
      contentInsetEndAdjustment: composerInset + 120,
      initialScrollAtEnd: undefined,
    });

    expect(ownedUnderLanding).toHaveBeenCalled();
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
    ownedUnderLanding.mockRestore();
    const correctionLanding = vi
      .spyOn(list, "scrollToEnd")
      .mockImplementation((): Promise<void> => {
        node.scrollTop = maxScrollTop(node);
        fireNativeScroll(node);
        return Promise.resolve();
      });
    act(() => {
      followLatchRef.current?.followEndIfPermitted();
    });
    await settleLegendList();
    expectAtTrueEnd(node);

    act(() => {
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      node.scrollTop = Math.max(0, maxScrollTop(node) - 240);
      fireNativeScroll(node);
    });
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    act(() => {
      node.scrollTop = maxScrollTop(node);
      fireNativeScroll(node);
    });
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);

    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(withToolStatus.length) + composerInset + 560,
    );
    rerenderMessages(
      withToolStatus.map((message) =>
        message.id === "burst-assistant"
          ? { ...message, statusLabel: "Tool completed" }
          : message,
      ),
      undefined,
    );
    await settleLegendList();
    expectAtTrueEnd(node);
    correctionLanding.mockRestore();
  });

  it("retains follow through disclosure shrink and Todo inset growth without reader input", async () => {
    const rowCount = 36;
    const baseInset = 140;
    const baseMessages = makeMessages(rowCount);
    const baseHeight = contentHeightForRowCount(rowCount) + baseInset;
    setLegendListScrollContainerScrollHeightOverride(baseHeight);
    const followLatchRef = createRef<ChatTimelineFollowLatch | null>();
    const onFollowIntentChange = vi.fn();
    const { listRef, rerenderMessages } = renderTimeline({
      messages: baseMessages,
      contentInsetEndAdjustment: baseInset,
      followLatchRef,
      onFollowIntentChange,
    });
    await settleLegendList();

    const node = requireScrollNode(listRef);
    parkAtStrictBottom(node);
    const list = listRef.current;
    if (!list) throw new Error("LegendList ref not mounted");

    // Expanded disclosure/stream growth moves the end. The first owned
    // landing intentionally stops short so correction remains active.
    const expandedHeight = baseHeight + 360;
    setLegendListScrollContainerScrollHeightOverride(expandedHeight);
    const scrollToEnd = vi
      .spyOn(list, "scrollToEnd")
      .mockImplementation((): Promise<void> => {
        node.scrollTop = Math.max(0, maxScrollTop(node) - 40);
        fireNativeScroll(node);
        return Promise.resolve();
      });
    act(() => {
      followLatchRef.current?.followEndIfPermitted();
    });
    expect(scrollToEnd).toHaveBeenCalled();

    // LegendList's deferred web shrink/MVCP path may report a lower
    // scrollTop after the disclosure's non-publishing pointer preflight has
    // cancelled correction ownership. This is still layout motion, not a
    // reader departure.
    act(() => {
      followLatchRef.current?.noteReaderGesture({
        direction: "indeterminate",
        freezeInFlightScroll: true,
        publishesReaderPosition: false,
      });
      node.scrollTop = Math.max(0, node.scrollTop - 180);
      fireNativeScroll(node);
    });
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);

    // Collapse settles at the new browser-clamped strict edge. A maintain
    // callback must heal/reconcile it without issuing a semantic jump.
    setLegendListScrollContainerScrollHeightOverride(baseHeight);
    act(() => {
      node.scrollTop = maxScrollTop(node);
      followLatchRef.current?.followEndIfPermitted();
    });
    expectAtTrueEnd(node);
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);

    // The Todo dock now increases the lower-surface inset. Following must
    // remain live and land at the new end instead of surfacing the pill.
    scrollToEnd.mockImplementation((): Promise<void> => {
      node.scrollTop = maxScrollTop(node);
      fireNativeScroll(node);
      return Promise.resolve();
    });
    const todoInset = baseInset + 180;
    setLegendListScrollContainerScrollHeightOverride(
      contentHeightForRowCount(rowCount) + todoInset,
    );
    rerenderMessages(baseMessages, {
      contentInsetEndAdjustment: todoInset,
      initialScrollAtEnd: undefined,
    });
    await settleLegendList();

    expectAtTrueEnd(node);
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
    scrollToEnd.mockRestore();
  });

  // -----------------------------------------------------------------------
  // 2. Core no-rerender proof (review's central finding)
  // -----------------------------------------------------------------------

  describe("silent detach then layout callbacks with no ChatTimeline rerender", () => {
    it("attaches the latch when an initially empty transcript receives its first rows", async () => {
      const rowCount = 40;
      const messages = makeMessages(rowCount);
      const { listRef, rerenderMessages } = renderTimeline({ messages: [] });
      await settleLegendList();

      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(rowCount),
      );
      rerenderMessages(messages, undefined);
      await settleLegendList();

      const node = requireScrollNode(listRef);
      parkAtStrictBottom(node);
      const parked = detachReader(node, 180);
      const next = appendAssistantRows(messages, 1, "after-empty");
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(next.length),
      );
      rerenderMessages(next, undefined);
      await settleLegendList();

      expectPixelStable(node, parked);
    });

    it("setItemSize alone does not yank a detached reader (no preparatory rerender)", async () => {
      const rowCount = 40;
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(rowCount),
      );
      const messages = makeMessages(rowCount);
      const onItemSizeChanged = vi.fn();
      const { listRef } = renderTimeline({ messages, onItemSizeChanged });
      await settleLegendList();

      const node = requireScrollNode(listRef);
      parkAtStrictBottom(node);
      const parked = detachReader(node, 180);
      expect(parked).toBe(180);

      // CRITICAL: no rerenderMessages / no React commit between detach and
      // setItemSize - this is the ordering the rejected gate tests avoided.
      onItemSizeChanged.mockClear();
      act(() => {
        listRef.current?.setItemSize("message-6", {
          height: 260,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await settleLegendList();

      expect(onItemSizeChanged).toHaveBeenCalled();
      expectPixelStable(node, parked);
    });

    it("footer/header metrics change via real RO does not yank a detached reader", async () => {
      const rowCount = 40;
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(rowCount),
      );
      const onListMetricsChange = vi.fn();
      const { listRef } = renderTimeline({
        messages: makeMessages(rowCount),
        onListMetricsChange,
      });
      await settleLegendList();

      const node = requireScrollNode(listRef);
      parkAtStrictBottom(node);
      const parked = detachReader(node, 220);
      onListMetricsChange.mockClear();

      // Fire LegendList's footer/header layout observers with a NEW size so
      // setFooterSize/setHeaderSize change and onMetricsChange (our
      // handleMetricsChange → followEndIfPermitted) runs - still no React
      // re-render of ChatTimeline.
      act(() => {
        fireAllResizeObservers((target) => {
          // Skip the scroll container itself here; the next test covers it.
          if (target === node) return null;
          return makeResizeEntry(target, VIEWPORT_WIDTH_PX, 96);
        });
      });
      await settleLegendList();

      expectPixelStable(node, parked);
    });

    it("viewport ResizeObserver on the scroll node does not yank a detached reader", async () => {
      const rowCount = 40;
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(rowCount),
      );
      const { listRef } = renderTimeline({ messages: makeMessages(rowCount) });
      await settleLegendList();

      const node = requireScrollNode(listRef);
      parkAtStrictBottom(node);
      const parked = detachReader(node, 150);

      // Latch's own ResizeObserver is a maintain TRIGGER only (does not
      // refresh permission from post-resize geometry). With permission
      // already false from the detach scroll, a pure container resize must
      // not yank - and no ChatTimeline re-render accompanies it.
      act(() => {
        fireAllResizeObservers((target) =>
          target === node
            ? makeResizeEntry(target, VIEWPORT_WIDTH_PX, VIEWPORT_HEIGHT_PX)
            : null,
        );
      });
      await settleLegendList();

      expectPixelStable(node, parked);
    });

    it("setItemSize while strictly at bottom retains follow so a subsequent append lands at the newest end", async () => {
      // Item-layout alone is the no-rerender trigger under test; a pure
      // setItemSize against the DOM scrollHeight override does not give the
      // library's scrollToEnd a new measurable end that matches our shim, so
      // the discriminating proof here is: (1) item-size at the edge does not
      // clear permission / yank the reader off the edge, and (2) the next
      // data-change maintain trigger still follows. Detached setItemSize is
      // covered above; full growth-follow for data is covered by the matrix.
      const rowCount = 40;
      const baseHeight = contentHeightForRowCount(rowCount);
      setLegendListScrollContainerScrollHeightOverride(baseHeight);
      const messages = makeMessages(rowCount);
      const { listRef, rerenderMessages } = renderTimeline({ messages });
      await settleLegendList();

      const node = requireScrollNode(listRef);
      parkAtStrictBottom(node);

      act(() => {
        listRef.current?.setItemSize("message-8", {
          height: 280,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await settleLegendList();
      // Still at the DOM edge after the item-layout trigger (no detach).
      expectAtTrueEnd(node);

      const next = appendAssistantRows(messages, 2, "after-item-size");
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(next.length),
      );
      rerenderMessages(next, undefined);
      await settleLegendList();

      expectAtTrueEnd(node);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Mutation matrix: append / in-place / footer-inset / short-height
  // -----------------------------------------------------------------------

  describe("mutation matrix: detached pixel-stable; strict-bottom follows", () => {
    type MutationKind =
      | "append"
      | "in-place-growth"
      | "footer-inset"
      | "item-size"
      | "short-height";

    const mutationKinds: ReadonlyArray<MutationKind> = [
      "append",
      "in-place-growth",
      "footer-inset",
      "item-size",
      "short-height",
    ];

    async function applyMutation(
      kind: MutationKind,
      ctx: {
        readonly messages: ReadonlyArray<ChatMessageModel>;
        readonly listRef: RefObject<LegendListRef | null>;
        readonly rerenderMessages: RenderTimelineResult["rerenderMessages"];
        readonly rowCount: number;
      },
    ): Promise<void> {
      const { messages, listRef, rerenderMessages, rowCount } = ctx;
      switch (kind) {
        case "append": {
          const next = appendAssistantRows(messages, 2, `append-${rowCount}`);
          setLegendListScrollContainerScrollHeightOverride(
            contentHeightForRowCount(next.length),
          );
          rerenderMessages(next, undefined);
          break;
        }
        case "in-place-growth": {
          const targetId = messages[messages.length - 1]?.id;
          if (!targetId) throw new Error("no target row");
          const next = growAssistantInPlace(
            messages,
            targetId,
            "\n\nmore streamed tokens that grow the card",
          );
          setLegendListScrollContainerScrollHeightOverride(
            contentHeightForRowCount(rowCount) + 180,
          );
          // In-place content change is a data identity change for the stable-
          // rows cache, so ChatTimeline re-renders; also remeasure the row
          // the way a real streaming card resize would.
          rerenderMessages(next, undefined);
          act(() => {
            listRef.current?.setItemSize(targetId, {
              height: 270,
              width: VIEWPORT_WIDTH_PX,
            });
          });
          break;
        }
        case "footer-inset": {
          // contentInsetEndAdjustment is a real prop path (layout effect
          // wiring in chat-timeline.tsx) covering the footer/inset maintain
          // trigger that production uses for the composer overlay.
          rerenderMessages(messages, {
            contentInsetEndAdjustment: 180,
            initialScrollAtEnd: undefined,
          });
          break;
        }
        case "item-size": {
          act(() => {
            listRef.current?.setItemSize("message-4", {
              height: 240,
              width: VIEWPORT_WIDTH_PX,
            });
          });
          break;
        }
        case "short-height": {
          // Near-end short content growth: only a few px of height change.
          const next = appendAssistantRows(messages, 1, `short-${rowCount}`);
          // Keep the same scrollHeight delta tiny even with one more row so
          // the case stays "short-height" rather than a full append.
          setLegendListScrollContainerScrollHeightOverride(
            contentHeightForRowCount(rowCount) + 8,
          );
          rerenderMessages(next, undefined);
          break;
        }
        default: {
          const _exhaustive: never = kind;
          throw new Error(`unhandled mutation: ${String(_exhaustive)}`);
        }
      }
      await settleLegendList();
    }

    for (const kind of mutationKinds) {
      it(`detached remains pixel-stable across ${kind}`, async () => {
        const rowCount = 36;
        setLegendListScrollContainerScrollHeightOverride(
          contentHeightForRowCount(rowCount),
        );
        const messages = makeMessages(rowCount);
        const { listRef, rerenderMessages } = renderTimeline({ messages });
        await settleLegendList();

        const node = requireScrollNode(listRef);
        parkAtStrictBottom(node);
        const parked = detachReader(node, 240);

        await applyMutation(kind, {
          messages,
          listRef,
          rerenderMessages,
          rowCount,
        });

        expectPixelStable(node, parked);
      });

      it(`strict-bottom follows newest end across ${kind}`, async () => {
        const rowCount = 36;
        setLegendListScrollContainerScrollHeightOverride(
          contentHeightForRowCount(rowCount),
        );
        const messages = makeMessages(rowCount);
        const { listRef, rerenderMessages } = renderTimeline({ messages });
        await settleLegendList();

        const node = requireScrollNode(listRef);
        parkAtStrictBottom(node);

        await applyMutation(kind, {
          messages,
          listRef,
          rerenderMessages,
          rowCount,
        });

        // After follow, geometry must be at the true end. For mutations that
        // do not grow max-scroll (item-size alone with fixed scrollHeight
        // override), "at end" still means the same max; for growth cases the
        // end has moved and we must have moved with it.
        expectAtTrueEnd(node);
      });
    }
  });

  // -----------------------------------------------------------------------
  // 3. Hidden 0x0 → reveal restored free-reading → growth
  // -----------------------------------------------------------------------

  describe("hidden 0x0 reveal restored free-reading", () => {
    it("does not overwrite a restored non-bottom position after reveal, and growth stays parked", async () => {
      const rowCount = 40;
      const fullHeight = contentHeightForRowCount(rowCount);
      setLegendListScrollContainerScrollHeightOverride(fullHeight);

      // Mount as free-reading (not following-end). initialScrollAtEnd=false
      // seeds the latch permission as false - the restored free-reading
      // intent the review requires.
      const { listRef, rerenderMessages } = renderTimeline({
        messages: makeMessages(rowCount),
        initialScrollAtEnd: false,
      });
      await settleLegendList();

      const node = requireScrollNode(listRef);

      // Simulate the inactive display:none pane reporting 0x0. Unmeasurable
      // geometry must not be treated as a confirmed edge. Scroll while 0x0 is
      // ignored by the latch (clientHeight===0); ResizeObserver is trigger-
      // only and never rewrites permission from post-resize geometry.
      setNodeClientHeight(node, 0);
      setLegendListScrollContainerScrollHeightOverride(0);
      node.scrollTop = 0;
      fireNativeScroll(node);
      act(() => {
        fireAllResizeObservers((target) =>
          target === node ? makeResizeEntry(target, 0, 0) : null,
        );
      });

      // Reveal at a restored free-reading coordinate far from the tail.
      // A real scroll event at that coordinate is the only permission source.
      clearNodeClientHeight(node);
      setLegendListScrollContainerScrollHeightOverride(fullHeight);
      const restoredTop = 500;
      node.scrollTop = restoredTop;
      fireNativeScroll(node);
      act(() => {
        fireAllResizeObservers((target) =>
          target === node
            ? makeResizeEntry(target, VIEWPORT_WIDTH_PX, VIEWPORT_HEIGHT_PX)
            : null,
        );
      });
      await settleLegendList();

      expectPixelStable(node, restoredTop);
      expect(node.scrollTop).toBeLessThan(maxScrollTop(node) - 1);

      // Immediate subsequent growth must still not yank.
      const grown = appendAssistantRows(
        makeMessages(rowCount),
        3,
        "post-reveal",
      );
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(grown.length),
      );
      rerenderMessages(grown, undefined);
      await settleLegendList();

      expectPixelStable(node, restoredTop);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Downward scroll that stops short of true bottom cannot reacquire
  // -----------------------------------------------------------------------

  describe("downward-but-not-bottom cannot reacquire follow", () => {
    it("real native scroll steps that never reach the edge leave append growth parked", async () => {
      const rowCount = 40;
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(rowCount),
      );
      const messages = makeMessages(rowCount);
      const { listRef, rerenderMessages } = renderTimeline({ messages });
      await settleLegendList();

      const node = requireScrollNode(listRef);
      parkAtStrictBottom(node);

      // Detach far above, then crawl downward with real native scroll events
      // at each step - still hundreds of px from the true end (review's
      // counter-example against a numeric baseline heuristic).
      detachReader(node, 200);
      for (const top of [400, 700, 1000, 1500]) {
        node.scrollTop = top;
        fireNativeScroll(node);
        expect(maxScrollTop(node) - node.scrollTop).toBeGreaterThan(1);
      }
      const parked = node.scrollTop;

      const next = appendAssistantRows(messages, 2, "downward-no-reacq");
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(next.length),
      );
      rerenderMessages(next, undefined);
      await settleLegendList();

      expectPixelStable(node, parked);
    });
  });

  // -----------------------------------------------------------------------
  // 5. MVCP / virtualization coordinate remap does not grant permission
  // -----------------------------------------------------------------------

  describe("virtualization / MVCP coordinate remap", () => {
    it("a large structural data remap that moves scrollTop does not re-enable follow on its own", async () => {
      const rowCount = 80;
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(rowCount),
      );
      const messages = makeMessages(rowCount);
      const { listRef, rerenderMessages } = renderTimeline({ messages });
      await settleLegendList();

      const node = requireScrollNode(listRef);
      parkAtStrictBottom(node);
      const parked = detachReader(node, 300);

      // Large prepend-like rewrite: replace the data array with a different
      // identity set of the same length so LegendList recalculates item
      // positions (MVCP/virtualization path) while the reader is free.
      // maintainVisibleContentPosition may adjust scrollTop; that adjustment
      // must not be read as "reader returned to the edge".
      const remapped = messages.map((message, index) => ({
        ...message,
        id: `remapped-${index}`,
        content: `remapped body ${index}`,
      }));
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(remapped.length) + 400,
      );
      rerenderMessages(remapped, undefined);
      await settleLegendList();

      // Whatever MVCP did to scrollTop, we must not be yanked to the true
      // end. A follow would land within 1px of max; free-reading after a
      // remap stays clearly away from it.
      const afterRemap = node.scrollTop;
      expect(afterRemap).toBeLessThan(maxScrollTop(node) - 1);

      // A subsequent growth must still not follow - remap alone never
      // reacquired permission.
      const grown = appendAssistantRows(remapped, 2, "post-remap");
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(grown.length) + 400,
      );
      rerenderMessages(grown, undefined);
      await settleLegendList();

      expectPixelStable(node, afterRemap);
      // Sanity: we started detached and never intentionally returned.
      expect(parked).toBe(300);
    });

    it("declared programmatic non-bottom navigation preserves its free-reading position", async () => {
      const rowCount = 40;
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(rowCount),
      );
      const messages = makeMessages(rowCount);
      const followLatchRef = createRef<ChatTimelineFollowLatch | null>();
      const { listRef, rerenderMessages } = renderTimeline({
        messages,
        followLatchRef,
      });
      await settleLegendList();

      const node = requireScrollNode(listRef);
      parkAtStrictBottom(node);

      act(() => {
        // Non-bottom navigation declares its destination explicitly. Bare
        // scrollTop movement is not reader intent because MVCP and layout use
        // the same browser signal.
        followLatchRef.current?.beginOwnedFreeNavigation();
        void listRef.current?.scrollToOffset({ offset: 350, animated: false });
        // Mirror production: programmatic navigation also lands a real DOM
        // scrollTop the latch observes via its direct listener.
        node.scrollTop = 350;
        fireNativeScroll(node);
      });
      await settleLegendList();
      const parked = node.scrollTop;
      expect(parked).toBeLessThan(maxScrollTop(node) - 1);

      const next = appendAssistantRows(messages, 2, "prog-nav");
      setLegendListScrollContainerScrollHeightOverride(
        contentHeightForRowCount(next.length),
      );
      rerenderMessages(next, undefined);
      await settleLegendList();

      expectPixelStable(node, parked);
    });
  });
});
