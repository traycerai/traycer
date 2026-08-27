import { renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import {
  CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS,
  isChatTimelineAtStrictBottom,
  isChatTimelineGeometryMeasurable,
  useChatTimelineFollowLatch,
} from "@/components/chat/chat-timeline-follow-latch";

describe("isChatTimelineGeometryMeasurable", () => {
  it("is false for hidden/unmeasured (clientHeight 0) geometry", () => {
    expect(
      isChatTimelineGeometryMeasurable({
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
      }),
    ).toBe(false);
  });

  it("is true once clientHeight is measured", () => {
    expect(
      isChatTimelineGeometryMeasurable({
        scrollTop: 0,
        scrollHeight: 1500,
        clientHeight: 500,
      }),
    ).toBe(true);
  });
});

describe("isChatTimelineAtStrictBottom", () => {
  it("is true exactly at the edge and within the 1px epsilon", () => {
    expect(
      isChatTimelineAtStrictBottom({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      }),
    ).toBe(true);
    expect(
      isChatTimelineAtStrictBottom({
        scrollTop: 999,
        scrollHeight: 1500,
        clientHeight: 500,
      }),
    ).toBe(true);
  });

  it("is false more than 1px away, including a sub-epsilon-adjacent case", () => {
    expect(
      isChatTimelineAtStrictBottom({
        scrollTop: 998,
        scrollHeight: 1500,
        clientHeight: 500,
      }),
    ).toBe(false);
    expect(
      isChatTimelineAtStrictBottom({
        scrollTop: 200,
        scrollHeight: 1500,
        clientHeight: 500,
      }),
    ).toBe(false);
  });
});

// --- Hook-level tests: a REAL DOM node driven by REAL native `scroll`
// events and a controllable ResizeObserver, proving the latch is sound
// against actual browser event semantics, not just numeric comparisons.

interface ControllableGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

interface ScrollableNodeShim {
  readonly makeNode: (geometry: ControllableGeometry) => HTMLDivElement;
  readonly setGeometry: (
    node: HTMLDivElement,
    geometry: Partial<ControllableGeometry>,
  ) => void;
}

function installScrollableNodeShim(): ScrollableNodeShim {
  const geometryByNode = new WeakMap<HTMLDivElement, ControllableGeometry>();

  vi.spyOn(HTMLDivElement.prototype, "scrollTop", "get").mockImplementation(
    function (this: HTMLDivElement) {
      return geometryByNode.get(this)?.scrollTop ?? 0;
    },
  );
  vi.spyOn(HTMLDivElement.prototype, "scrollTop", "set").mockImplementation(
    function (this: HTMLDivElement, value: number) {
      const current = geometryByNode.get(this);
      if (current) current.scrollTop = value;
    },
  );
  vi.spyOn(HTMLDivElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLDivElement) {
      return geometryByNode.get(this)?.scrollHeight ?? 0;
    },
  );
  vi.spyOn(HTMLDivElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLDivElement) {
      return geometryByNode.get(this)?.clientHeight ?? 0;
    },
  );

  return {
    makeNode: (geometry: ControllableGeometry): HTMLDivElement => {
      const node = document.createElement("div");
      geometryByNode.set(node, { ...geometry });
      document.body.appendChild(node);
      return node;
    },
    setGeometry: (
      node: HTMLDivElement,
      geometry: Partial<ControllableGeometry>,
    ): void => {
      const current = geometryByNode.get(node);
      if (!current) throw new Error("node not registered");
      Object.assign(current, geometry);
    },
  };
}

let capturedResizeCallbacks: Array<ResizeObserverCallback>;

class ControllableResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    capturedResizeCallbacks.push(this.callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    const callbackIndex = capturedResizeCallbacks.indexOf(this.callback);
    if (callbackIndex !== -1) capturedResizeCallbacks.splice(callbackIndex, 1);
  }
}

const FAKE_RESIZE_OBSERVER: ResizeObserver = {
  observe: () => undefined,
  unobserve: () => undefined,
  disconnect: () => undefined,
};

function fireResizeObservers(): void {
  // Snapshot first: firing a callback can itself trigger a re-render that
  // registers a NEW observer (pushing into `capturedResizeCallbacks`) -
  // iterating the live array would pick up entries added during this same
  // pass.
  for (const callback of [...capturedResizeCallbacks]) {
    callback([], FAKE_RESIZE_OBSERVER);
  }
}

/** Real native `scroll` dispatch - not a synthetic React event - matching
 *  what the latch's own direct `addEventListener` listens for. */
function fireNativeScroll(node: HTMLDivElement): void {
  node.dispatchEvent(new Event("scroll", { bubbles: false }));
}

function fireTouch(
  node: HTMLDivElement,
  type: "touchstart" | "touchmove",
  clientY: number,
): void {
  const event = new Event(type, { bubbles: false });
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: {
      item: (index: number) => (index === 0 ? { clientY } : null),
    },
  });
  node.dispatchEvent(event);
}

/** Throws if ever actually invoked - only `getScrollableNode`/`scrollToEnd`
 *  are exercised by the latch under test; every other member of the (large)
 *  `LegendListRef` interface is stubbed just to keep this a real, uncast
 *  `LegendListRef` value. */
function notImplemented(): never {
  throw new Error("not implemented in this test double");
}

const DEFAULT_FOLLOW_LATCH_OPTIONS = {
  onFollowIntentChange: undefined,
  onReaderGesture: undefined,
  isCorrectionSuppressed: undefined,
  resolveSuppressedEndLanding: undefined,
};

interface FakeListRef {
  readonly current: LegendListRef;
  readonly scrollToEnd: Mock<() => Promise<void>>;
  readonly scrollToOffset: Mock<
    (params: {
      readonly offset: number;
      readonly animated?: boolean;
    }) => Promise<void>
  >;
}

function makeFakeListRef(node: HTMLDivElement): FakeListRef {
  const scrollToEnd = vi.fn((): Promise<void> => Promise.resolve());
  const scrollToOffset = vi.fn((): Promise<void> => Promise.resolve());
  const current: LegendListRef = {
    clearCaches: notImplemented,
    flashScrollIndicators: notImplemented,
    getAnimatableRef: () => node,
    getNativeScrollRef: () => node,
    getScrollableNode: () => node,
    getScrollResponder: () => null,
    getState: notImplemented,
    reportContentInset: notImplemented,
    scrollIndexIntoView: notImplemented,
    scrollItemIntoView: notImplemented,
    scrollToEnd,
    scrollToIndex: notImplemented,
    scrollToItem: notImplemented,
    scrollToOffset,
    setItemSize: notImplemented,
    setScrollProcessingEnabled: notImplemented,
    setVisibleContentAnchorOffset: notImplemented,
  };
  return { current, scrollToEnd, scrollToOffset };
}

describe("useChatTimelineFollowLatch", () => {
  let shim: ScrollableNodeShim;
  let animationFrameCallbacks: Map<number, FrameRequestCallback>;
  let nextAnimationFrameId: number;

  beforeEach(() => {
    capturedResizeCallbacks = [];
    vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
    animationFrameCallbacks = new Map();
    nextAnimationFrameId = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback): number => {
        const id = nextAnimationFrameId;
        nextAnimationFrameId += 1;
        animationFrameCallbacks.set(id, callback);
        return id;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      animationFrameCallbacks.delete(id);
    });
    shim = installScrollableNodeShim();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function flushAnimationFrame(): void {
    const callbacks = [...animationFrameCallbacks.values()];
    animationFrameCallbacks.clear();
    for (const callback of callbacks) callback(performance.now());
  }

  it("treats initialScrollAtEnd as a mount seed, not a live reset", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result, rerender } = renderHook(
      ({ initialScrollAtEnd }) =>
        useChatTimelineFollowLatch(
          listRef,
          initialScrollAtEnd,
          true,
          DEFAULT_FOLLOW_LATCH_OPTIONS,
        ),
      { initialProps: { initialScrollAtEnd: true } },
    );

    rerender({ initialScrollAtEnd: false });
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("owns an under-landing until bounded correction reaches the true end", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    listRef.scrollToEnd.mockImplementation((): Promise<void> => {
      if (listRef.scrollToEnd.mock.calls.length === 1) {
        shim.setGeometry(node, { scrollTop: 1120, scrollHeight: 1700 });
      } else {
        shim.setGeometry(node, { scrollTop: 1200, scrollHeight: 1700 });
      }
      fireNativeScroll(node);
      return Promise.resolve();
    });
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);

    flushAnimationFrame();
    flushAnimationFrame();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(2);
    expect(node.scrollTop).toBe(1200);

    result.current.noteReaderGesture({
      direction: "away-from-end",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    });
    shim.setGeometry(node, { scrollTop: 800 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    shim.setGeometry(node, { scrollTop: 1200 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);

    shim.setGeometry(node, { scrollHeight: 1800 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(3);
  });

  it("supersedes a deferred end correction when the reader scrolls away", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    let runDeferredEnd = (): void => undefined;
    listRef.scrollToEnd.mockImplementation(
      () =>
        new Promise<void>(() => {
          runDeferredEnd = (): void => {
            shim.setGeometry(node, { scrollTop: 1000 });
            fireNativeScroll(node);
          };
        }),
    );
    listRef.scrollToOffset.mockImplementation(({ offset }): Promise<void> => {
      runDeferredEnd = (): void => undefined;
      shim.setGeometry(node, { scrollTop: offset });
      return Promise.resolve();
    });
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    // LegendList can queue this correction while a data/layout pass settles.
    shim.setGeometry(node, { scrollTop: 900 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    shim.setGeometry(node, { scrollTop: 1000 });

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollTop: 467 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    // A stale queued end command must not execute after the reader has parked.
    runDeferredEnd();
    expect(node.scrollTop).toBe(467);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  it("supersedes a deferred end correction before its coalesced strict-bottom report", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    let runDeferredEnd = (): void => undefined;
    listRef.scrollToEnd.mockImplementation(
      () =>
        new Promise<void>(() => {
          runDeferredEnd = (): void => {
            shim.setGeometry(node, { scrollTop: 1000 });
            fireNativeScroll(node);
          };
        }),
    );
    listRef.scrollToOffset.mockImplementation(({ offset }): Promise<void> => {
      runDeferredEnd = (): void => undefined;
      shim.setGeometry(node, { scrollTop: offset });
      return Promise.resolve();
    });
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    shim.setGeometry(node, { scrollTop: 900 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);

    // Native scroll delivery is still queued; the compositor has already
    // parked the reader away from the tail.
    shim.setGeometry(node, { scrollTop: 467 });
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));

    // If the pending LegendList token is still live, this restores the
    // strict edge and coalesces as a native strict-bottom report, which
    // would re-latch follow. Arm-time supersede must cancel it first.
    runDeferredEnd();
    fireNativeScroll(node);
    expect(node.scrollTop).toBe(467);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("ends a bounded correction burst without inventing reader departure", () => {
    const node = shim.makeNode({
      scrollTop: 1200,
      scrollHeight: 1700,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    fireNativeScroll(node);
    shim.setGeometry(node, { scrollHeight: 1800 });
    result.current.followEndIfPermitted();
    for (let frame = 0; frame < 12; frame += 1) flushAnimationFrame();

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(
      CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS,
    );
    expect(animationFrameCallbacks.size).toBe(0);
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);

    // A later layout/stream maintain trigger can start a fresh bounded burst;
    // exhausting the previous CPU-safety window did not revoke follow.
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(
      CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS + 1,
    );
  });

  it("keeps layout-owned opposed motion inside the active correction", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    listRef.scrollToEnd.mockImplementation((): Promise<void> => {
      shim.setGeometry(node, { scrollTop: 1120 });
      fireNativeScroll(node);
      return Promise.resolve();
    });
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);

    // A disclosure pointerdown is a non-publishing preflight. It cancels the
    // in-flight correction but does not authorize the resulting layout
    // movement to publish a reader departure.
    result.current.noteReaderGesture({
      direction: "indeterminate",
      freezeInFlightScroll: true,
      publishesReaderPosition: false,
    });
    shim.setGeometry(node, { scrollTop: 900 });
    fireNativeScroll(node);

    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
    // The layout-owned native report itself starts correction immediately;
    // it does not wait for a second size/inset callback.
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(2);

    // The deferred shrink finally settles at the new strict end. A maintain
    // callback reconciles that passive landing without issuing navigation.
    shim.setGeometry(node, { scrollTop: 900, scrollHeight: 1400 });
    result.current.followEndIfPermitted();
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
  });

  it("wires wheel intent before native scroll so growth cannot swallow a departure", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const onReaderGesture = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollTop: 850 });
    fireNativeScroll(node);

    expect(onReaderGesture).toHaveBeenCalledWith({
      direction: "away-from-end",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    });
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  it("blocks a maintain correction between wheel intent and native scroll", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    shim.setGeometry(node, { scrollTop: 850 });
    fireNativeScroll(node);

    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  it("preserves a movable wheel arm through a strict-bottom maintain pass", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    // A maintain callback can see the old strict-bottom geometry before the
    // browser delivers the wheel's native scroll event.
    result.current.followEndIfPermitted();
    shim.setGeometry(node, { scrollTop: 850 });
    fireNativeScroll(node);

    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  it("releases a movable wheel arm after a sub-epsilon strict-bottom scroll", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    // Native delivery confirms that the gesture completed without departing:
    // the fractional movement remains inside the strict-bottom epsilon.
    shim.setGeometry(node, { scrollTop: 999.5 });
    fireNativeScroll(node);
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("blocks a maintain correction between touch intent and native scroll", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    fireTouch(node, "touchstart", 100);
    fireTouch(node, "touchmove", 140);
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    shim.setGeometry(node, { scrollTop: 850 });
    fireNativeScroll(node);

    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  it("does not block follow for an upward wheel that cannot move from the top edge", () => {
    const node = shim.makeNode({
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollHeight: 700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("clears an immovable gesture arm when a strict-bottom observation proves no departure", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    result.current.followEndIfPermitted();
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("releases a settled no-op owned free navigation", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );

    result.current.beginOwnedFreeNavigation();
    // The target is already at the strict end, so the programmatic navigation
    // emits no scroll event. Its settle callback must release the arm.
    result.current.completeOwnedFreeNavigation();
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("clears a publishing pointer preflight when pointer completion produces no scroll", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );

    result.current.noteReaderGesture({
      direction: "indeterminate",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    });
    node.dispatchEvent(new PointerEvent("pointerup"));
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("preserves a scrollbar drag through pointerup until its delayed scroll report", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    result.current.noteReaderGesture({
      direction: "indeterminate",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    });
    // The compositor has moved the thumb, but under long-list main-thread
    // pressure pointer completion and layout maintenance can run before the
    // coalesced native scroll event is delivered.
    shim.setGeometry(node, { scrollTop: 200 });
    node.dispatchEvent(new PointerEvent("pointerup"));
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    fireNativeScroll(node);

    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  it("converges a toward-end reader landing when content grows before scroll delivery", () => {
    const node = shim.makeNode({
      scrollTop: 700,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    renderHook(() =>
      useChatTimelineFollowLatch(listRef, false, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 180 }));
    // The reader physically reaches the end that existed at gesture time.
    // A streaming commit then grows the document before scroll delivery.
    shim.setGeometry(node, { scrollTop: 1000, scrollHeight: 1700 });
    fireNativeScroll(node);

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("owns an animated go-live operation until its fresh-DOM landing resolves", () => {
    const node = shim.makeNode({
      scrollTop: 200,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, false, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    result.current.beginOwnedEndNavigation();
    shim.setGeometry(node, { scrollTop: 650 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).not.toHaveBeenLastCalledWith(false);

    shim.setGeometry(node, { scrollTop: 1000 });
    fireNativeScroll(node);
    result.current.completeOwnedEndNavigation(result.current.isAtStrictEnd());
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
  });

  it("lets owned end navigation supersede a gesture arm", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    result.current.beginOwnedEndNavigation();
    shim.setGeometry(node, { scrollTop: 700 });
    fireNativeScroll(node);

    shim.setGeometry(node, { scrollTop: 1000 });
    fireNativeScroll(node);
    result.current.completeOwnedEndNavigation(true);
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("yields an owned go-live operation to recognized reader input", () => {
    const node = shim.makeNode({
      scrollTop: 500,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, false, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    result.current.beginOwnedEndNavigation();
    shim.setGeometry(node, { scrollTop: 800 });
    fireNativeScroll(node);
    result.current.noteReaderGesture({
      direction: "away-from-end",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    });
    shim.setGeometry(node, { scrollTop: 700 });
    fireNativeScroll(node);

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  it("maintenance heals stale false permission at strict bottom without navigation", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    renderHook(() =>
      useChatTimelineFollowLatch(listRef, false, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // Reacquired permission is live: subsequent growth follows normally.
    shim.setGeometry(node, { scrollHeight: 1700 });
    fireResizeObservers();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("maintenance heals stale false permission when content no longer overflows", () => {
    const node = shim.makeNode({
      scrollTop: 0,
      scrollHeight: 320,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    renderHook(() =>
      useChatTimelineFollowLatch(listRef, false, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("keeps a suppressed hydration edge visibly detached", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: () => true,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  it("review regression: downward scroll that remains non-bottom cannot reacquire", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );
    fireNativeScroll(node); // confirm at edge

    // Detach far above.
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollTop: 200 });
    fireNativeScroll(node);
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // Scroll DOWNWARD again but still 200px short of the (grown) end -
    // review's exact counter-example against a numeric baseline.
    shim.setGeometry(node, { scrollTop: 1000, scrollHeight: 1700 });
    fireNativeScroll(node);
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("review regression: library catch-up then upward detach above the old numeric position", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );
    fireNativeScroll(node);

    // Catch-up scroll moves further down (still at the edge as content grew).
    shim.setGeometry(node, { scrollTop: 1200, scrollHeight: 1700 });
    fireNativeScroll(node);
    expect(
      isChatTimelineAtStrictBottom({
        scrollTop: 1200,
        scrollHeight: 1700,
        clientHeight: 500,
      }),
    ).toBe(true);

    // Reader detaches upward to 1100 - ABOVE the very first observed 1000,
    // but 400px from the true end. A numeric "hasn't decreased since 1000"
    // baseline would wrongly grant follow here; the latch must not.
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollTop: 1100 });
    fireNativeScroll(node);
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("review regression: sub-epsilon scrollTop change while distance remains >1px", () => {
    const node = shim.makeNode({
      scrollTop: 200,
      scrollHeight: 1700,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        false,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );
    fireNativeScroll(node);

    shim.setGeometry(node, { scrollTop: 200.4 }); // sub-1px nudge, still ~1000px away
    fireNativeScroll(node);
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("review regression: MVCP/virtualization remap without reader input retains permission", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );
    fireNativeScroll(node);

    // A real DOM scrollTop write matching MVCP's own coordinate remap. With
    // no publishing reader input, this layout-owned report cannot revoke the
    // existing follow intent and immediately starts correction.
    shim.setGeometry(node, { scrollTop: 300, scrollHeight: 1500 });
    fireNativeScroll(node);
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("review regression: hidden 0x0 reveal does not overwrite a restored free-reading permission", () => {
    // Mount hidden (0x0) with a restored NON-bottom intent
    // (`initialScrollAtEnd=false`).
    const node = shim.makeNode({
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        false,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );

    // A resize/scroll event can still fire while hidden (0x0) - must be
    // ignored as unmeasurable, not treated as a confirmed edge.
    fireResizeObservers();
    fireNativeScroll(node);

    // Reveal at the restored free-reading coordinate - far from the end.
    shim.setGeometry(node, {
      scrollTop: 500,
      scrollHeight: 2000,
      clientHeight: 500,
    });
    fireResizeObservers();

    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // Immediate growth right after reveal must also stay pixel-stable.
    shim.setGeometry(node, { scrollHeight: 2200 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("review regression: silent detach then item-size/footer/viewport callbacks with no preparatory rerender do not follow", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );
    fireNativeScroll(node);

    // Recognized reader intent plus DOM-only detach - no React render
    // anywhere in this sequence.
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollTop: 200 });
    fireNativeScroll(node);

    // Item-size callback equivalent (component-level wiring calls
    // `followEndIfPermitted` directly from `onItemSizeChanged` - this proves
    // the latch itself denies it regardless of caller).
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // Footer/header measurement equivalent.
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // Viewport-layout trigger: the latch's OWN ResizeObserver fires with NO
    // React render at all.
    fireResizeObservers();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("confirms permission at the strict edge and follows on every real maintain trigger", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );
    fireNativeScroll(node);

    // Content grows past the confirmed edge - there is now something to
    // correct, so a maintain trigger must actually call `scrollToEnd`.
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);

    shim.setGeometry(node, { scrollHeight: 1900 });
    fireResizeObservers();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(2);
  });

  it("a viewport resize alone does not revoke permission (symmetric to content growth)", () => {
    // A container resize (clientHeight shrinking - composer growing taller,
    // eating into the list's height) moves the strict-edge distance exactly
    // like content growth does, with scrollTop untouched. Treating that as
    // "the reader detached" would be the same unsoundness content growth
    // already had to be protected against - the resize observer must only
    // TRIGGER a follow attempt against the EXISTING permission, never itself
    // decide permission from post-resize geometry.
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );
    fireNativeScroll(node); // confirm following

    // Shrink the viewport - distance is now > epsilon with NO scrollTop
    // change at all.
    shim.setGeometry(node, { clientHeight: 450 });
    fireResizeObservers();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1); // catches up

    // A LATER resize with no further scrollTop movement must still be
    // treated as following (permission was never revoked) - if the resize
    // itself had wrongly cleared permission, this would silently no-op.
    shim.setGeometry(node, { clientHeight: 400 });
    fireResizeObservers();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(2);
  });

  it("skips a redundant scrollToEnd when already exactly at the edge (no invented navigation)", () => {
    // A destructive mutation the UA itself already clamped to the new max
    // lands exactly at the edge with no reader-earned follow behind it -
    // `followEndIfPermitted` must not issue an imperative call that has
    // nothing to correct.
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );
    fireNativeScroll(node);

    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("re-acquires only after a fresh measured <=1px edge, not merely on any downward motion", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );
    fireNativeScroll(node);

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollTop: 200 });
    fireNativeScroll(node);
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // Move downward but still short of the edge.
    shim.setGeometry(node, { scrollTop: 900 });
    fireNativeScroll(node);
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // Finally reach the true edge - permission re-acquires, but there is
    // nothing to correct yet (already there), so no call happens here...
    shim.setGeometry(node, { scrollTop: 1000 });
    fireNativeScroll(node);
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // ...until growth actually needs catching up, which proves permission
    // really was re-acquired (not still denied from the earlier detach).
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("regression: a sub-epsilon bottom report cannot disarm an owned free navigation", () => {
    // Minimap/find/deep-link jump issued while latched at the strict bottom.
    // An ANIMATED jump's first smooth-scroll frame moves <1px, so its scroll
    // event still reads as strict-bottom geometry; that report must not
    // consume the armed departure, or every later (genuinely departing)
    // report is classified layout-owned and a correction burst yanks the
    // jump straight back to the tail.
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
      }),
    );

    // navigateToMessage's exact sequence for a minimap click:
    result.current.noteReaderGesture({
      direction: "indeterminate",
      freezeInFlightScroll: false,
      publishesReaderPosition: false,
    });
    result.current.beginOwnedFreeNavigation();

    // First animated frame: still inside the 1px strict-bottom epsilon.
    shim.setGeometry(node, { scrollTop: 999.5 });
    fireNativeScroll(node);

    // Streaming/layout maintenance in the gap must not create a competing
    // bottom correction before the navigation genuinely leaves the edge.
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // Subsequent frames genuinely leave the bottom.
    shim.setGeometry(node, { scrollTop: 900 });
    fireNativeScroll(node);
    shim.setGeometry(node, { scrollTop: 400 });
    fireNativeScroll(node);
    for (let i = 0; i < 12; i++) flushAnimationFrame();

    // Follow releases to the navigation; no corrective snap-back is issued.
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });
});
