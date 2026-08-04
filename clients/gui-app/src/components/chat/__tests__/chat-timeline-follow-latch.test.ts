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

/** Throws if ever actually invoked - only `getScrollableNode`/`scrollToEnd`
 *  are exercised by the latch under test; every other member of the (large)
 *  `LegendListRef` interface is stubbed just to keep this a real, uncast
 *  `LegendListRef` value. */
function notImplemented(): never {
  throw new Error("not implemented in this test double");
}

interface FakeListRef {
  readonly current: LegendListRef;
  readonly scrollToEnd: Mock<() => Promise<void>>;
}

function makeFakeListRef(node: HTMLDivElement): FakeListRef {
  const scrollToEnd = vi.fn((): Promise<void> => Promise.resolve());
  const current: LegendListRef = {
    clearCaches: notImplemented,
    flashScrollIndicators: notImplemented,
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
    scrollToOffset: notImplemented,
    setItemSize: notImplemented,
    setScrollProcessingEnabled: notImplemented,
    setVisibleContentAnchorOffset: notImplemented,
  };
  return { current, scrollToEnd };
}

describe("useChatTimelineFollowLatch", () => {
  let shim: ScrollableNodeShim;

  beforeEach(() => {
    capturedResizeCallbacks = [];
    vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
    shim = installScrollableNodeShim();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("synchronizes permission when the parent follow mode changes", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result, rerender } = renderHook(
      ({ initialScrollAtEnd }) =>
        useChatTimelineFollowLatch(listRef, initialScrollAtEnd, true),
      { initialProps: { initialScrollAtEnd: true } },
    );

    rerender({ initialScrollAtEnd: false });
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("review regression: downward scroll that remains non-bottom cannot reacquire", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true),
    );
    fireNativeScroll(node); // confirm at edge

    // Detach far above.
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
      useChatTimelineFollowLatch(listRef, true, true),
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
      useChatTimelineFollowLatch(listRef, false, true),
    );
    fireNativeScroll(node);

    shim.setGeometry(node, { scrollTop: 200.4 }); // sub-1px nudge, still ~1000px away
    fireNativeScroll(node);
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("review regression: programmatic non-bottom navigation and MVCP/virtualization remap do not grant permission", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true),
    );
    fireNativeScroll(node);

    // Explicit navigation to a mid-transcript, non-bottom coordinate - a
    // real DOM scrollTop write, exactly like MVCP's own coordinate remap.
    shim.setGeometry(node, { scrollTop: 300, scrollHeight: 1500 });
    fireNativeScroll(node);
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
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
      useChatTimelineFollowLatch(listRef, false, true),
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
      useChatTimelineFollowLatch(listRef, true, true),
    );
    fireNativeScroll(node);

    // Silent DOM-only detach - no React render anywhere in this sequence.
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
      useChatTimelineFollowLatch(listRef, true, true),
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
    renderHook(() => useChatTimelineFollowLatch(listRef, true, true));
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
      useChatTimelineFollowLatch(listRef, true, true),
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
      useChatTimelineFollowLatch(listRef, true, true),
    );
    fireNativeScroll(node);

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
});
