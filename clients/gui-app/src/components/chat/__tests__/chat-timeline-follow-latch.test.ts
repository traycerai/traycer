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
import type { LegendListRef, LegendListState } from "@legendapp/list/react";
import { SANDBOX_SCROLL_GESTURE_EVENT } from "@/lib/sandbox/bridge-host";
import {
  CHAT_TIMELINE_FOLLOW_CORRECTION_MAX_ATTEMPTS,
  isChatTimelineAtStrictBottom,
  isChatTimelineGeometryMeasurable,
  moveChatTimelineScroller,
  useChatTimelineFollowLatch,
  type ChatTimelineFollowLatch,
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
let capturedResizeObservers: Array<ControllableResizeObserver>;

class ControllableResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  readonly observedTargets: Array<Element> = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    capturedResizeCallbacks.push(this.callback);
    capturedResizeObservers.push(this);
  }
  observe(target: Element): void {
    this.observedTargets.push(target);
  }
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
  type: "touchstart" | "touchmove" | "touchend",
  clientY: number,
): void {
  const event = new Event(type, { bubbles: false });
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: {
      item: (index: number) =>
        index === 0 && type !== "touchend" ? { clientY } : null,
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
  isReattachSuppressed: undefined,
  isTurnRunning: undefined,
};

interface FakeListRef {
  readonly current: LegendListRef;
  /** Moves the list's last row, as rows above it remeasuring would. */
  readonly setLastRowTop: (top: number) => void;
  /** Places a row, after the others if it is new. */
  readonly setRowTop: (key: string, top: number) => void;
  /** Unmounts a row: the list no longer knows its position. */
  readonly removeRow: (key: string) => void;
  /** The size the list laid out, which the DOM may lag. */
  readonly setContentLength: (length: number) => void;
  readonly cancelPendingScroll: Mock<() => boolean>;
  readonly scrollToEnd: Mock<() => Promise<void>>;
  readonly scrollToOffset: Mock<
    (params: {
      readonly offset: number;
      readonly animated?: boolean;
    }) => Promise<void>
  >;
}

const FAKE_LAST_ROW_KEY = "last-row";
const FAKE_LAST_ROW_TOP_PX = 1000;

/** The slice of the list's state the latch reads - its rows and where they
 *  sit - over a state otherwise at rest. */
function makeFakeListState(
  rowTops: ReadonlyMap<string, number>,
  contentLength: number,
) {
  const keys = [...rowTops.keys()];
  const state: LegendListState = {
    activeStickyIndex: -1,
    contentLength,
    data: keys,
    elementAtIndex: () => null,
    end: 0,
    endBuffered: 0,
    isAtEnd: false,
    isAtStart: false,
    isNearEnd: false,
    isNearStart: false,
    isEndReached: false,
    isStartReached: false,
    isWithinMaintainScrollAtEndThreshold: false,
    getAverageItemSizes: () => ({}),
    indexByKey: (key) => keys.indexOf(key),
    keyAtIndex: (index) => keys[index],
    listen: () => () => undefined,
    listenToPosition: () => () => undefined,
    positionAtIndex: (index) => rowTops.get(keys[index]) ?? 0,
    positionByKey: (key) => rowTops.get(key),
    scroll: 0,
    scrollLength: 0,
    scrollVelocity: 0,
    sizeAtIndex: () => 0,
    sizes: new Map(),
    start: 0,
    startBuffered: 0,
  };
  return state;
}

function makeFakeListRef(node: HTMLDivElement): FakeListRef {
  const rowTops = new Map<string, number>([
    [FAKE_LAST_ROW_KEY, FAKE_LAST_ROW_TOP_PX],
  ]);
  let contentLength = 0;
  const cancelPendingScroll = vi.fn((): boolean => false);
  const scrollToEnd = vi.fn((): Promise<void> => Promise.resolve());
  const scrollToOffset = vi.fn((): Promise<void> => Promise.resolve());
  const current: LegendListRef = {
    cancelPendingScroll,
    clearCaches: notImplemented,
    flashScrollIndicators: notImplemented,
    getAnimatableRef: () => node,
    getNativeScrollRef: () => node,
    getScrollableNode: () => node,
    getScrollResponder: () => null,
    getState: () => makeFakeListState(rowTops, contentLength),
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
  return {
    current,
    setLastRowTop: (top) => rowTops.set(FAKE_LAST_ROW_KEY, top),
    setRowTop: (key, top) => rowTops.set(key, top),
    removeRow: (key) => rowTops.delete(key),
    setContentLength: (length) => {
      contentLength = length;
    },
    cancelPendingScroll,
    scrollToEnd,
    scrollToOffset,
  };
}

type HeldListCommand =
  | { readonly kind: "end"; readonly resolve: () => void }
  | {
      readonly kind: "offset";
      readonly offset: number;
      readonly resolve: () => void;
    };

interface HeldCommandListRef extends FakeListRef {
  /** Runs the command the list holds, as it does once its layout has settled:
   *  an end command writes the end, an offset command its clamped offset, and
   *  the native scroll report follows when the offset changed. */
  readonly settle: () => void;
}

/** A fake list that, like `@legendapp/list`, holds ONE imperative command
 *  while it settles. A newer command replaces it and settles its promise at
 *  once; `cancelPendingScroll` retires it. Nothing runs until `settle()`. */
function makeHeldCommandListRef(
  node: HTMLDivElement,
  shim: ScrollableNodeShim,
): HeldCommandListRef {
  const fake = makeFakeListRef(node);
  let held: HeldListCommand | null = null;
  const replaceHeld = (next: HeldListCommand | null): void => {
    const previous = held;
    held = next;
    previous?.resolve();
  };
  fake.scrollToEnd.mockImplementation(
    (): Promise<void> =>
      new Promise<void>((resolve) => replaceHeld({ kind: "end", resolve })),
  );
  fake.scrollToOffset.mockImplementation(
    ({ offset }): Promise<void> =>
      new Promise<void>((resolve) =>
        replaceHeld({ kind: "offset", offset, resolve }),
      ),
  );
  fake.cancelPendingScroll.mockImplementation((): boolean => {
    const wasHeld = held !== null;
    replaceHeld(null);
    return wasHeld;
  });
  return {
    ...fake,
    settle: (): void => {
      const command = held;
      if (command === null) return;
      held = null;
      const end = Math.max(0, node.scrollHeight - node.clientHeight);
      const target =
        command.kind === "end"
          ? end
          : Math.min(Math.max(0, command.offset), end);
      const before = node.scrollTop;
      shim.setGeometry(node, { scrollTop: target });
      if (target !== before) fireNativeScroll(node);
      command.resolve();
    },
  };
}

describe("useChatTimelineFollowLatch", () => {
  let shim: ScrollableNodeShim;
  let animationFrameCallbacks: Map<number, FrameRequestCallback>;
  let nextAnimationFrameId: number;

  beforeEach(() => {
    capturedResizeCallbacks = [];
    capturedResizeObservers = [];
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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

  function mountHeldFollowing(): {
    readonly node: HTMLDivElement;
    readonly listRef: HeldCommandListRef;
    readonly result: { readonly current: ChatTimelineFollowLatch };
    readonly onFollowIntentChange: Mock<(isFollowing: boolean) => void>;
  } {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeHeldCommandListRef(node, shim);
    const onFollowIntentChange = vi.fn<(isFollowing: boolean) => void>();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        ...DEFAULT_FOLLOW_LATCH_OPTIONS,
        onFollowIntentChange,
      }),
    );
    return { node, listRef, result, onFollowIntentChange };
  }

  it("a wheel away retires the held end correction, so settling does not write over the reader", () => {
    const { node, listRef, result, onFollowIntentChange } =
      mountHeldFollowing();

    // The tail grows; the correction lands the end now and the list holds
    // its scrollToEnd while it settles.
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(node.scrollTop).toBe(1200);

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollTop: 467 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    listRef.settle();
    expect(node.scrollTop).toBe(467);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  it("a wheel away retires the held end correction before the reader's own report", () => {
    const { node, listRef, result, onFollowIntentChange } =
      mountHeldFollowing();

    shim.setGeometry(node, { scrollTop: 900 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);

    // Native scroll delivery is still queued; the compositor has already
    // parked the reader away from the tail.
    shim.setGeometry(node, { scrollTop: 467 });
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));

    // A held end command that survived the wheel would restore the strict
    // edge here and its report would re-latch follow.
    listRef.settle();
    fireNativeScroll(node);
    expect(node.scrollTop).toBe(467);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("a touch pan away retires the held end correction, so settling does not write over the reader", () => {
    const { node, listRef, result, onFollowIntentChange } =
      mountHeldFollowing();

    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);

    fireTouch(node, "touchstart", 300);
    fireTouch(node, "touchmove", 400);
    shim.setGeometry(node, { scrollTop: 600 });
    fireNativeScroll(node);
    fireTouch(node, "touchend", 400);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    listRef.settle();
    expect(node.scrollTop).toBe(600);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  // GUARD, not a red test: it passes before and after the fix. Cancelling
  // must only ever retire the end correction's own command; a wrong fix that
  // cancels unconditionally would also kill a newer command (here standing in
  // for a navigation) that replaced it.
  it("guard: a wheel does not cancel a newer command that replaced the end correction", async () => {
    const { node, listRef, result } = mountHeldFollowing();

    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    void listRef.current.scrollToOffset({ offset: 300, animated: false });
    // The replaced command settles at once; its continuations clear the
    // latch's pending-correction record.
    await Promise.resolve();

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    expect(listRef.cancelPendingScroll).not.toHaveBeenCalled();

    listRef.settle();
    expect(node.scrollTop).toBe(300);
  });

  /** A phone reader drags away from the tail, lifts, touches again and
   *  flings toward it. The fling's frames are bare scroll reports. The
   *  suppressions are the transcript's recovery and restore holds, which the
   *  test flips. */
  interface SuppressibleFling {
    readonly node: HTMLDivElement;
    readonly listRef: FakeListRef;
    readonly result: { readonly current: ChatTimelineFollowLatch };
    readonly onFollowIntentChange: Mock<(isFollowing: boolean) => void>;
    readonly suppress: (holds: {
      readonly reattach: boolean;
      readonly correction: boolean;
    }) => void;
  }

  function flingTowardEndSuppressible(): SuppressibleFling {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn<(isFollowing: boolean) => void>();
    const holds = { reattach: false, correction: false };
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        ...DEFAULT_FOLLOW_LATCH_OPTIONS,
        onFollowIntentChange,
        isReattachSuppressed: () => holds.reattach,
        isCorrectionSuppressed: () => holds.correction,
      }),
    );

    fireTouch(node, "touchstart", 300);
    fireTouch(node, "touchmove", 400);
    shim.setGeometry(node, { scrollTop: 700 });
    fireNativeScroll(node);
    fireTouch(node, "touchend", 400);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    fireTouch(node, "touchstart", 400);
    fireTouch(node, "touchmove", 300);
    shim.setGeometry(node, { scrollTop: 760 });
    fireNativeScroll(node);
    fireTouch(node, "touchend", 300);
    flushAnimationFrame();
    flushAnimationFrame();
    return {
      node,
      listRef,
      result,
      onFollowIntentChange,
      suppress: (next) => {
        holds.reattach = next.reattach;
        holds.correction = next.correction;
      },
    };
  }

  function flingTowardEnd() {
    const { node, listRef, result, onFollowIntentChange } =
      flingTowardEndSuppressible();
    return { node, listRef, result, onFollowIntentChange };
  }

  it("a fling that reaches the end follows again although a chunk grew the tail before its report", () => {
    const { node, listRef, onFollowIntentChange } = flingTowardEnd();

    shim.setGeometry(node, { scrollTop: 900 });
    fireNativeScroll(node);
    // The fling reaches the end; its report has not been delivered yet.
    shim.setGeometry(node, { scrollTop: 1000 });
    // The reply's chunk grows the last row, whose top does not move.
    shim.setGeometry(node, { scrollHeight: 1540 });
    fireResizeObservers();
    // The fling's report, no longer at the strict bottom.
    fireNativeScroll(node);

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    expect(listRef.scrollToEnd).toHaveBeenCalled();
  });

  it("control: a fling that stops short of the end stays detached when a chunk grows the tail", () => {
    const { node, listRef, onFollowIntentChange } = flingTowardEnd();

    shim.setGeometry(node, { scrollTop: 900 });
    fireNativeScroll(node);
    shim.setGeometry(node, { scrollTop: 997 });
    shim.setGeometry(node, { scrollHeight: 1540 });
    fireResizeObservers();
    fireNativeScroll(node);

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("control: a reader the list moves to the end by remeasured rows above stays detached", () => {
    const { node, listRef, onFollowIntentChange } = flingTowardEnd();

    shim.setGeometry(node, { scrollTop: 960 });
    fireNativeScroll(node);
    // Rows above the reader remeasure; the list moves the reader with them.
    listRef.setLastRowTop(1040);
    shim.setGeometry(node, { scrollHeight: 1540, scrollTop: 1000 });
    fireResizeObservers();
    fireNativeScroll(node);

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  // A recovery clamp's temporary end is the list's, not where the reader's
  // momentum is headed: recorded as the target, it would be met by the
  // restored content's unchanged offset and drag the reader to the end.
  describe("a lifted finger's momentum target through a recovery", () => {
    const RECOVERING = { reattach: true, correction: false };
    const RESTORING = { reattach: false, correction: true };
    const NONE = { reattach: false, correction: false };

    function clampThenRestore(
      mounted: SuppressibleFling,
      holds: { readonly reattach: boolean; readonly correction: boolean },
    ): void {
      const { node, suppress, result } = mounted;
      suppress(holds);
      // The recovery shrinks the content and the browser clamps the reader's
      // offset to the temporary end.
      shim.setGeometry(node, { scrollHeight: 800, scrollTop: 300 });
      fireNativeScroll(node);
      // The content comes back; the offset has not moved.
      shim.setGeometry(node, { scrollHeight: 1500 });
      fireResizeObservers();
      result.current.followEndIfPermitted();
    }

    it("a clamp's temporary end is not a target the restored content meets", () => {
      const mounted = flingTowardEndSuppressible();
      clampThenRestore(mounted, RECOVERING);

      expect(mounted.onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(mounted.listRef.scrollToEnd).not.toHaveBeenCalled();

      // The hold lifts and the content grows: no stale target is left.
      mounted.suppress(NONE);
      shim.setGeometry(mounted.node, { scrollHeight: 1600 });
      mounted.result.current.followEndIfPermitted();
      fireNativeScroll(mounted.node);

      expect(mounted.onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(mounted.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("a lift on a clamped view records no target", () => {
      const mounted = flingTowardEndSuppressible();
      const { node } = mounted;
      mounted.suppress(RECOVERING);
      shim.setGeometry(node, { scrollHeight: 800, scrollTop: 300 });
      fireTouch(node, "touchstart", 400);
      fireTouch(node, "touchmove", 300);
      fireTouch(node, "touchend", 300);
      flushAnimationFrame();
      flushAnimationFrame();

      shim.setGeometry(node, { scrollHeight: 1500 });
      mounted.suppress(NONE);
      fireResizeObservers();
      mounted.result.current.followEndIfPermitted();

      expect(mounted.onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(mounted.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    // The restore holds the reader at its snapshot's end; the content comes
    // back and the hold lifts in one step, so the first observation after it
    // meets the unchanged offset.
    it("a restore's snapshot end is not a target either", () => {
      const { node, listRef, onFollowIntentChange, suppress, result } =
        flingTowardEndSuppressible();

      suppress(RESTORING);
      shim.setGeometry(node, { scrollHeight: 800, scrollTop: 300 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollHeight: 1500 });
      suppress(NONE);
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    // Control: the target the lift recorded survives a hold that clamps
    // nothing, so the momentum still arrives at it.
    it("control: a fling that reaches the end follows after a hold that clamped nothing", () => {
      const { node, listRef, onFollowIntentChange, suppress } =
        flingTowardEndSuppressible();

      suppress(RECOVERING);
      shim.setGeometry(node, { scrollTop: 800 });
      fireNativeScroll(node);
      suppress(NONE);
      shim.setGeometry(node, { scrollTop: 900 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 1000 });
      shim.setGeometry(node, { scrollHeight: 1540 });
      fireResizeObservers();
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
      expect(listRef.scrollToEnd).toHaveBeenCalled();
    });
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    fireNativeScroll(node);
    shim.setGeometry(node, { scrollHeight: 1800 });
    result.current.followEndIfPermitted();
    for (let frame = 1; frame <= 12; frame += 1) {
      // The tail outgrows every landing, as a deferred shrink or a streaming
      // row resize can leave it, so no attempt reaches the strict bottom.
      shim.setGeometry(node, { scrollHeight: 1800 + frame * 100 });
      flushAnimationFrame();
    }

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
      // The list's own under-landing, announced as the list announces it.
      moveChatTimelineScroller(node, 1120, () =>
        shim.setGeometry(node, { scrollTop: 1120 }),
      );
      fireNativeScroll(node);
      return Promise.resolve();
    });
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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

  describe("a scroll over a sandbox frame", () => {
    // A wheel inside an agent page or MCP App happens in the frame's own
    // document, so the node sees no wheel event, only the scroll it chains to.
    function scrollAwayFromTail(frameGesture: string | null): {
      readonly scrollToEnd: Mock<() => Promise<void>>;
      readonly onFollowIntentChange: Mock<(follow: boolean) => void>;
    } {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const frame = document.createElement("iframe");
      node.appendChild(frame);
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
        }),
      );
      // A report seen first: the ledger is live, so a gesture event is the
      // only thing that suspends its judgment of the scroll below.
      fireNativeScroll(node);
      if (frameGesture !== null) {
        frame.dispatchEvent(
          new CustomEvent(SANDBOX_SCROLL_GESTURE_EVENT, {
            bubbles: true,
            detail: frameGesture,
          }),
        );
      }
      shim.setGeometry(node, { scrollTop: 850 });
      fireNativeScroll(node);
      result.current.followEndIfPermitted();
      return { scrollToEnd: listRef.scrollToEnd, onFollowIntentChange };
    }

    it("reads the relayed gesture as the reader's, so follow is released and not corrected", () => {
      const { scrollToEnd, onFollowIntentChange } =
        scrollAwayFromTail("away-from-end");
      expect(scrollToEnd).not.toHaveBeenCalled();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });

    it("reads a chained scroll no gesture announced as the reader's silent pan", () => {
      const { scrollToEnd, onFollowIntentChange } = scrollAwayFromTail(null);
      expect(scrollToEnd).not.toHaveBeenCalled();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });

    // A toward-end gesture would suspend the ledger and the scroll would be
    // corrected, so the departure proves the detail was not taken as one.
    it("takes a gesture event whose detail is not a direction for no gesture", () => {
      const { scrollToEnd, onFollowIntentChange } =
        scrollAwayFromTail("sideways");
      expect(scrollToEnd).not.toHaveBeenCalled();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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
    // The fractional movement is evidence of the wheel's own scroll, so the
    // arm is released at once and streaming follows again.
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  describe("a strict-bottom scroll report delivered in a wheel's own frame", () => {
    function followingAtStrictBottom() {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
        }),
      );
      return { node, listRef, onFollowIntentChange, result };
    }

    const WHEEL_UP = {
      direction: "away-from-end",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    } as const;

    // A write made before the wheel queued a scroll report that the browser
    // delivers after the wheel event, in the wheel's own frame, before the
    // wheel has scrolled: it reads the old strict-bottom geometry and cannot
    // say the gesture stayed at the edge. Taken as that, it released the
    // wheel's arm, and the wheel's own report a frame later (300px from the
    // end) was corrected back to the end.
    it("does not release the wheel's arm, so the wheel's own report detaches follow", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();

      result.current.noteReaderGesture(WHEEL_UP);
      fireNativeScroll(node);
      flushAnimationFrame();
      shim.setGeometry(node, { scrollTop: 700 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    // A movable wheel whose scroll never comes keeps its arm: strict-bottom
    // geometry that is not movement never releases it, however long it
    // takes. The next reader input ends it.
    it("a wheel whose scroll never comes keeps its arm until the next reader input", () => {
      const { node, listRef, result } = followingAtStrictBottom();

      result.current.noteReaderGesture(WHEEL_UP);
      for (let frame = 0; frame < 10; frame += 1) {
        fireNativeScroll(node);
        flushAnimationFrame();
      }
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));

      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });

    it("no number of frames lets a movable wheel's arm go before its scroll", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();

      result.current.noteReaderGesture(WHEEL_UP);
      for (let frame = 0; frame < 10; frame += 1) {
        flushAnimationFrame();
        fireNativeScroll(node);
      }
      shim.setGeometry(node, { scrollTop: 900 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("a clamp to a lower end is not the wheel's movement", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();

      result.current.noteReaderGesture(WHEEL_UP);
      // The end pad drops: the offset clamps with the end and stays at it.
      shim.setGeometry(node, { scrollHeight: 1436, scrollTop: 936 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 836 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    // The tail moving away from a reader whose wheel up has not reported is
    // the reader leaving it: the wheel's movement may come later, or the end
    // may have come up to absorb it, and no report tells the two apart. Their
    // scroll-up holds; the tail does not drag them.
    it("tail growth after a wheel up whose end came up to absorb it is the reader's departure", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollHeight: 1450, scrollTop: 950 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    // No report has followed the wheel when the tail grows away from them:
    // its scroll is still to come, and would read as layout. The end coming
    // back to meet them, with no turn running, is the list's until then, and
    // the wheel's report is not corrected. Once it has come, none is owed:
    // the end meeting them follows them.
    it("a reader departed ahead of any report of their wheel's stays held when the end comes back to meet them, and follows once that report has come", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();
      fireNativeScroll(node);

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      shim.setGeometry(node, { scrollHeight: 1500 });
      result.current.followEndIfPermitted();
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      flushAnimationFrame();
      flushAnimationFrame();

      expect(onFollowIntentChange.mock.calls).toEqual([[false]]);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(960);

      shim.setGeometry(node, { scrollHeight: 1460 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    // The turn resting before that report changes nothing: the report is
    // still owed, and following them would correct it back to the end.
    it("a reader departed ahead of any report of their wheel's stays held at the turn's rest, and the wheel's report leaves them free", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();
      fireNativeScroll(node);

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();
      shim.setGeometry(node, { scrollHeight: 1500 });
      result.current.followEndIfPermitted();
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange.mock.calls).toEqual([[false]]);

      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      flushAnimationFrame();
      flushAnimationFrame();

      expect(onFollowIntentChange.mock.calls).toEqual([[false]]);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(960);
    });

    // The wheel's report already came, absorbed at the end: none is owed, so
    // the end coming back to meet them at rest follows them, and the tail's
    // next growth with them.
    it("a reader the tail departed after their absorbed wheel's report follows when the end comes back to meet them at rest", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollHeight: 1450, scrollTop: 950 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      shim.setGeometry(node, { scrollHeight: 1450 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange.mock.calls).toEqual([[false], [true]]);

      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      expect(node.scrollTop).toBe(1100);
    });

    // A pan between a correction's frames, which its validating read saw
    // before the pan's report: the end meeting them until that report is the
    // list's, so the tail's growth then does not pull them.
    it("a pan a correction's read published ahead of its report stays held when the end meets them at rest, and is not pulled", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();
      fireNativeScroll(node);

      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      shim.setGeometry(node, { scrollTop: 900 });
      flushAnimationFrame();
      flushAnimationFrame();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      shim.setGeometry(node, { scrollHeight: 1400 });
      result.current.followEndIfPermitted();
      shim.setGeometry(node, { scrollHeight: 1500 });
      result.current.followEndIfPermitted();
      flushAnimationFrame();

      expect(onFollowIntentChange.mock.calls).toEqual([[false]]);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      expect(node.scrollTop).toBe(900);
    });

    // A pad drop clamps the view past where the wheel will take it before
    // the wheel's frame lands. The clamp is not the wheel: its own report
    // follows, and nothing in between is corrected.
    it("a clamp past the wheel's target is not corrected before the wheel's own report", () => {
      const { node, listRef, onFollowIntentChange } = followingAtStrictBottom();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollHeight: 1444, scrollTop: 944 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 904 });
      fireNativeScroll(node);

      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });

    // Absorbed and nothing grew: there is no departure to read, and the
    // reader is still following.
    it("a wheel the end absorbed, with no growth, neither departs nor writes", () => {
      const { node, listRef, onFollowIntentChange } = followingAtStrictBottom();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollHeight: 1450, scrollTop: 950 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    // Only a wheel (or the frame's relay of one) departs on growth. A gesture
    // noted directly (a key press) keeps the wait for its scroll.
    it("growth after a directly noted gesture waits for its scroll instead of departing", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();

      result.current.noteReaderGesture(WHEEL_UP);
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("tail growth after a relayed frame gesture away from the end is the reader's departure", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();

      node.dispatchEvent(
        new CustomEvent(SANDBOX_SCROLL_GESTURE_EVENT, {
          bubbles: true,
          detail: "away-from-end",
        }),
      );
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    describe("a wheel canceled by another listener", () => {
      function wheelUp(target: EventTarget): void {
        target.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -120,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      // Control: a wheel nothing cancels is the reader's, so the tail growing
      // away from it is a departure and is not corrected.
      it("control: an uncanceled wheel is not corrected back to the tail", () => {
        const { node, listRef, onFollowIntentChange, result } =
          followingAtStrictBottom();

        wheelUp(node);
        shim.setGeometry(node, { scrollHeight: 1700 });
        result.current.followEndIfPermitted();

        expect(listRef.scrollToEnd).not.toHaveBeenCalled();
        expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      });

      // A history swipe's opening tick is canceled by a document capture
      // listener before the transcript's own runs: it scrolls nothing, so it
      // is no reader gesture.
      it("a wheel canceled before the transcript's listener is no gesture", () => {
        const onReaderGesture = vi.fn();
        const node = shim.makeNode({
          scrollTop: 1000,
          scrollHeight: 1500,
          clientHeight: 500,
        });
        const listRef = makeFakeListRef(node);
        const { result } = renderHook(() =>
          useChatTimelineFollowLatch(listRef, true, true, {
            ...DEFAULT_FOLLOW_LATCH_OPTIONS,
            onReaderGesture,
          }),
        );
        const cancel = (event: Event): void => event.preventDefault();
        document.addEventListener("wheel", cancel, {
          capture: true,
          passive: false,
        });
        try {
          wheelUp(node);
        } finally {
          document.removeEventListener("wheel", cancel, { capture: true });
        }
        shim.setGeometry(node, { scrollHeight: 1700 });
        result.current.followEndIfPermitted();

        expect(onReaderGesture).not.toHaveBeenCalled();
        expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      });

      // An ancestor's bubble-phase listener runs after the transcript's own:
      // the wheel was already armed, and the arm would wait for a scroll
      // that never comes.
      it("a wheel canceled after the transcript's listener leaves no arm", () => {
        const { node, listRef, result } = followingAtStrictBottom();
        const cancel = (event: Event): void => event.preventDefault();
        document.body.addEventListener("wheel", cancel, { passive: false });
        try {
          wheelUp(node);
        } finally {
          document.body.removeEventListener("wheel", cancel);
        }
        shim.setGeometry(node, { scrollHeight: 1700 });
        result.current.followEndIfPermitted();

        expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      });
    });

    describe("a wheel over a nested scroller", () => {
      function mountWithNestedScroller(childScrollTop: number) {
        const node = shim.makeNode({
          scrollTop: 1000,
          scrollHeight: 1500,
          clientHeight: 500,
        });
        const child = shim.makeNode({
          scrollTop: childScrollTop,
          scrollHeight: 400,
          clientHeight: 100,
        });
        child.style.overflowY = "auto";
        node.appendChild(child);
        const listRef = makeFakeListRef(node);
        const onReaderGesture = vi.fn();
        const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
        const { result } = renderHook(() =>
          useChatTimelineFollowLatch(listRef, true, true, {
            ...DEFAULT_FOLLOW_LATCH_OPTIONS,
            onReaderGesture,
            onFollowIntentChange,
          }),
        );
        child.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -120, bubbles: true }),
        );
        return {
          node,
          child,
          listRef,
          onReaderGesture,
          onFollowIntentChange,
          result,
        };
      }

      it("is not a transcript gesture while the scroller has room to scroll up", () => {
        const { node, listRef, onReaderGesture, result } =
          mountWithNestedScroller(50);
        shim.setGeometry(node, { scrollHeight: 1700 });
        result.current.followEndIfPermitted();

        expect(onReaderGesture).not.toHaveBeenCalled();
        expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      });

      // Control: the scroller's top edge cannot take an upward wheel, so the
      // browser chains it to the transcript, and the tail growing away from
      // that wheel is the reader's departure.
      it("control: is a transcript gesture once the scroller is at its top edge", () => {
        const { node, listRef, onReaderGesture, onFollowIntentChange, result } =
          mountWithNestedScroller(0);
        shim.setGeometry(node, { scrollHeight: 1700 });
        result.current.followEndIfPermitted();

        expect(onReaderGesture).toHaveBeenCalledTimes(1);
        expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
        expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      });

      // Chrome latches a trackpad gesture to the scroller under it. Once that
      // scroller is at its edge the rest of the wheels move nothing, the
      // transcript included, and its one `scrollend` at the gesture's end is
      // all that says so. `scrollend` does not bubble, so the latch hears it
      // in the capture phase.
      it("a scrollend from the scroller the wheel was latched to ends the wait for a scroll", () => {
        const { node, child, listRef, result } = mountWithNestedScroller(0);

        child.dispatchEvent(new Event("scrollend"));
        shim.setGeometry(node, { scrollHeight: 1700 });
        result.current.followEndIfPermitted();

        expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      });

      // The scrollend only stops the wait: the arm stays, so the reader's
      // later scroll off the end is still a departure.
      it("a scrollend does not drop the arm: a later report off the end still departs", async () => {
        const { node, child, listRef, onFollowIntentChange } =
          mountWithNestedScroller(0);

        // The scrollend itself corrects the growth the wait held back. At the
        // strict bottom it would release the arm instead.
        shim.setGeometry(node, { scrollHeight: 1700 });
        child.dispatchEvent(new Event("scrollend"));
        expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
        // The correction it starts lands at the end and validates there,
        // with no scroll report to reconcile the arm.
        shim.setGeometry(node, { scrollTop: 1200 });
        await listRef.scrollToEnd.mock.results[0]?.value;
        flushAnimationFrame();
        flushAnimationFrame();
        shim.setGeometry(node, { scrollTop: 900 });
        fireNativeScroll(node);

        expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      });

      // Control: with the wait still on, the tail growing away from the wheel
      // is a departure and writes nothing, where the latched scroller's
      // scrollend lets the same growth be corrected.
      it("control: a scrollend from a scroller the wheel was not over leaves the arm blocking", () => {
        const { node, listRef, onFollowIntentChange, result } =
          mountWithNestedScroller(0);
        const unrelated = shim.makeNode({
          scrollTop: 0,
          scrollHeight: 400,
          clientHeight: 100,
        });
        unrelated.style.overflowY = "auto";
        node.appendChild(unrelated);

        unrelated.dispatchEvent(new Event("scrollend"));
        shim.setGeometry(node, { scrollHeight: 1700 });
        result.current.followEndIfPermitted();

        expect(listRef.scrollToEnd).not.toHaveBeenCalled();
        expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      });
    });

    // Chrome's smooth wheel scroll reports its first movement a frame or two
    // after the wheel handler. A strict-bottom report before then (a clamp, or
    // a correction's write) is not the wheel's, and the wheel's own report
    // must still read as the reader's.
    it("keeps the wheel's arm through a strict-bottom report a frame after it", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom();

      result.current.noteReaderGesture(WHEEL_UP);
      flushAnimationFrame();
      fireNativeScroll(node);
      flushAnimationFrame();
      shim.setGeometry(node, { scrollTop: 900 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    // Only the report of the wheel's own frame (a clamp) arrives before the
    // view moves; it is not movement, so it cannot release the arm.
    it("keeps the wheel's arm through two frames after a strict-bottom report in its own frame", () => {
      const { node, listRef, onFollowIntentChange } = followingAtStrictBottom();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      fireNativeScroll(node);
      flushAnimationFrame();
      flushAnimationFrame();
      shim.setGeometry(node, { scrollTop: 900 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });
  });

  describe("a reader whose departure the list's own clamp published", () => {
    const WHEEL_UP = {
      direction: "away-from-end",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    } as const;
    // The list's own end, short of the DOM's by the temporary end pad.
    const LIST_END_SCROLL_TOP = 1000;
    const END_PAD_PX = 64;

    /** A following reader at the padded DOM end, where the correction landed.
     *  Their wheel's own scroll moves the view to the list's end and reports:
     *  that publishes the departure at that offset. */
    function departedAtPaddedEnd() {
      const node = shim.makeNode({
        scrollTop: LIST_END_SCROLL_TOP,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
        }),
      );
      shim.setGeometry(node, { scrollHeight: 1500 + END_PAD_PX });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      expect(node.scrollTop).toBe(LIST_END_SCROLL_TOP + END_PAD_PX);

      result.current.noteReaderGesture(WHEEL_UP);
      shim.setGeometry(node, { scrollTop: LIST_END_SCROLL_TOP });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenCalledTimes(1);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      return { node, listRef, onFollowIntentChange, result };
    }

    // The pad dropping leaves the reader at the strict bottom with no scroll
    // report. No read can tell whether their wheel's scroll is still coming,
    // and with no turn running nothing else would move them off the end, so
    // they follow. A report of the wheel's a moment later is still theirs:
    // it departs them again, and is not corrected back to the tail.
    it("follows them when the end pad drops under them, and their wheel's own report departs them again without a correction", () => {
      const { node, listRef, onFollowIntentChange, result } =
        departedAtPaddedEnd();

      shim.setGeometry(node, { scrollHeight: 1500 });
      result.current.followEndIfPermitted();
      flushAnimationFrame();
      shim.setGeometry(node, { scrollTop: 700 });
      fireNativeScroll(node);

      expect(onFollowIntentChange.mock.calls).toEqual([
        [false],
        [true],
        [false],
      ]);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      expect(node.scrollTop).toBe(700);
    });

    // The price of following them there: rows that grow before the wheel's
    // report pull them to the new end once. The report then departs them,
    // with no second pull, and they stay free.
    it("rows grown before their wheel's report pull them once to the new end, and the report departs them with no second pull", () => {
      const { node, listRef, onFollowIntentChange, result } =
        departedAtPaddedEnd();

      shim.setGeometry(node, { scrollHeight: 1500 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);

      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      flushAnimationFrame();
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(2);
      expect(node.scrollTop).toBe(1100);

      shim.setGeometry(node, { scrollTop: 700 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();
      flushAnimationFrame();

      expect(onFollowIntentChange.mock.calls).toEqual([
        [false],
        [true],
        [false],
      ]);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(2);
      expect(node.scrollTop).toBe(700);
    });

    it("follows again at a strict bottom they return to after their wheel's report", () => {
      const { node, listRef, onFollowIntentChange, result } =
        departedAtPaddedEnd();

      shim.setGeometry(node, { scrollTop: 700, scrollHeight: 1500 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 1000 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe("a reader the end pad's reset clamps onto the new end", () => {
    const WHEEL_UP = {
      direction: "away-from-end",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    } as const;
    const PAD_PX = 56;
    const NOTCH_PX = 40;
    const END = 1000;

    /** A following reader whose correction landed at the padded end, then a
     *  wheel notch up published their departure. The pad then resets, and
     *  the browser clamps them onto the new end with a report there. */
    function clampedOntoNewEnd(isTurnRunning: () => boolean) {
      const node = shim.makeNode({
        scrollTop: END,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isTurnRunning,
        }),
      );
      shim.setGeometry(node, { scrollHeight: 1500 + PAD_PX });
      result.current.followEndIfPermitted();
      expect(node.scrollTop).toBe(END + PAD_PX);

      result.current.noteReaderGesture(WHEEL_UP);
      shim.setGeometry(node, { scrollTop: END + PAD_PX - NOTCH_PX });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      // The pad resets; the offset clamps onto the new end.
      shim.setGeometry(node, { scrollHeight: 1500, scrollTop: END });
      result.current.followEndIfPermitted();
      fireNativeScroll(node);
      listRef.scrollToEnd.mockClear();
      return { node, listRef, onFollowIntentChange, result };
    }

    it("M2: stays detached while the turn runs, even as the end grows past them", () => {
      const { node, listRef, onFollowIntentChange, result } = clampedOntoNewEnd(
        () => true,
      );

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      shim.setGeometry(node, { scrollHeight: 1528 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(END);
    });

    it("order A: follows at the clamp report when the turn had already finished", () => {
      const { onFollowIntentChange } = clampedOntoNewEnd(() => false);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("order B: held through the clamp while the turn runs, follows once the turn ends", () => {
      let turnRunning = true;
      const { node, listRef, onFollowIntentChange, result } = clampedOntoNewEnd(
        () => turnRunning,
      );
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      turnRunning = false;
      result.current.reconcileTurnAtRest();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
      shim.setGeometry(node, { scrollHeight: 1528 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });

    // Following them would retire the wheel's arm, and its scroll, landing
    // after the turn's end, would read as the list's and be corrected.
    it("keeps a held reader detached whose wheel up is still awaiting its scroll when the turn ends", () => {
      let turnRunning = true;
      const { node, listRef, onFollowIntentChange, result } = clampedOntoNewEnd(
        () => turnRunning,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      turnRunning = false;
      result.current.reconcileTurnAtRest();
      shim.setGeometry(node, { scrollTop: END - NOTCH_PX });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(END - NOTCH_PX);
    });

    // Control: a held reader the turn's end finds away from the strict
    // bottom has nothing to follow into.
    it("control: a held reader away from the strict bottom stays detached when the turn ends", () => {
      const { node, onFollowIntentChange, result } = clampedOntoNewEnd(
        () => true,
      );
      shim.setGeometry(node, { scrollTop: END - NOTCH_PX });

      result.current.reconcileTurnAtRest();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });
  });

  describe("wheels sharing one arm across the turn's end", () => {
    /** A following reader at the strict bottom with a wheel up already
     *  dispatched; the turn runs. */
    function followingWithTurn(turnRunning: { current: boolean }) {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isTurnRunning: () => turnRunning.current,
        }),
      );
      return { node, listRef, onFollowIntentChange, result };
    }

    it("a wheel's scroll that lands after the turn-rest follow is the reader's departure, though an earlier report of the same wheels published it", () => {
      const turnRunning = { current: true };
      const harness = followingWithTurn(turnRunning);
      const { node, listRef, onFollowIntentChange, result } = harness;

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      // The end comes up to the reader, which M2 holds while the turn runs.
      shim.setGeometry(node, { scrollHeight: 1460, scrollTop: 960 });
      listRef.scrollToEnd.mockClear();
      result.current.followEndIfPermitted();
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      turnRunning.current = false;
      result.current.reconcileTurnAtRest();

      // The second wheel's scroll lands away from the end.
      shim.setGeometry(node, { scrollTop: 920 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(920);
    });

    it("a smooth-scrolling wheel's later frame is the reader's departure, though an earlier frame published it and the turn-rest followed", () => {
      const turnRunning = { current: true };
      const harness = followingWithTurn(turnRunning);
      const { node, listRef, onFollowIntentChange, result } = harness;

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollTop: 980 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      // The end comes up to the reader as the second frame reports: the
      // strict-bottom report the turn holds them through.
      shim.setGeometry(node, { scrollHeight: 1460, scrollTop: 960 });
      fireNativeScroll(node);
      listRef.scrollToEnd.mockClear();
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      turnRunning.current = false;
      result.current.reconcileTurnAtRest();

      // The third frame of the same smooth scroll.
      shim.setGeometry(node, { scrollTop: 940 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(940);
    });

    it("a smooth wheel's later frame is the reader's departure after the end came up to them mid-turn", () => {
      const turnRunning = { current: true };
      const { node, listRef, onFollowIntentChange, result } =
        followingWithTurn(turnRunning);

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollTop: 980 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      // The report moved off the published departure: the hold is cleared.
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);

      shim.setGeometry(node, { scrollHeight: 1460, scrollTop: 960 });
      fireNativeScroll(node);
      result.current.followEndIfPermitted();
      listRef.scrollToEnd.mockClear();

      shim.setGeometry(node, { scrollTop: 940 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(940);
    });

    it.each([false, true])(
      "a held reader's wheel down at the strict bottom follows them (list settling: %s)",
      (settling) => {
        const turnRunning = { current: true };
        let reattachSuppressed = false;
        const node = shim.makeNode({
          scrollTop: 1000,
          scrollHeight: 1500,
          clientHeight: 500,
        });
        const listRef = makeFakeListRef(node);
        const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
        const { result } = renderHook(() =>
          useChatTimelineFollowLatch(listRef, true, true, {
            ...DEFAULT_FOLLOW_LATCH_OPTIONS,
            onFollowIntentChange,
            isTurnRunning: () => turnRunning.current,
            isReattachSuppressed: () => reattachSuppressed,
          }),
        );
        node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
        shim.setGeometry(node, { scrollTop: 960 });
        fireNativeScroll(node);
        shim.setGeometry(node, { scrollHeight: 1460, scrollTop: 960 });
        result.current.followEndIfPermitted();
        fireNativeScroll(node);
        expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
        listRef.scrollToEnd.mockClear();

        reattachSuppressed = settling;
        node.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));

        if (!settling) {
          expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
          return;
        }
        expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
        reattachSuppressed = false;
        shim.setGeometry(node, { scrollHeight: 1500 });
        result.current.followEndIfPermitted();
        expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
        expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe("a held reader's scroll that an announced write or a maintenance read overtakes", () => {
    /** The first W1 shape up to the turn's rest: two wheels up, the first
     *  report published the departure, the end came up and was held, and the
     *  turn's rest followed the reader at 960 with no arm. */
    function followingAfterTurnRest() {
      const turnRunning = { current: true };
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
          isTurnRunning: () => turnRunning.current,
        }),
      );
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollHeight: 1460, scrollTop: 960 });
      result.current.followEndIfPermitted();
      fireNativeScroll(node);
      turnRunning.current = false;
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
      return { node, listRef, onFollowIntentChange, onReaderGesture, result };
    }

    it("a late wheel scroll that a maintenance read sees before its report is the reader's departure", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAfterTurnRest();

      // The second wheel's scroll lands; its report has not been delivered.
      shim.setGeometry(node, { scrollTop: 920 });
      // A row above the view measures 30 larger and the list adjusts.
      shim.setGeometry(node, { scrollHeight: 1490 });
      moveChatTimelineScroller(node, 950, () =>
        shim.setGeometry(node, { scrollTop: 950 }),
      );
      listRef.scrollToEnd.mockClear();
      result.current.followEndIfPermitted();
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(950);
    });

    // Control: with no wheel scroll the adjust brings the reader to the end.
    it("control: an announced adjust to the end with no wheel scroll is no departure", () => {
      const { node, listRef, onFollowIntentChange, onReaderGesture, result } =
        followingAfterTurnRest();
      onFollowIntentChange.mockClear();
      onReaderGesture.mockClear();

      shim.setGeometry(node, { scrollHeight: 1490 });
      moveChatTimelineScroller(node, 990, () =>
        shim.setGeometry(node, { scrollTop: 990 }),
      );
      listRef.scrollToEnd.mockClear();
      result.current.followEndIfPermitted();
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
      expect(onReaderGesture).not.toHaveBeenCalled();
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("a departure offset that an announced write moved still holds the end pad's clamp, so the wheel's scroll stays the reader's", () => {
      const node = shim.makeNode({
        scrollTop: 1056,
        scrollHeight: 1556,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
          isTurnRunning: () => true,
        }),
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      // A row above the view grows 30 and the list's adjust moves them.
      shim.setGeometry(node, { scrollHeight: 1630 });
      moveChatTimelineScroller(node, 1086, () =>
        shim.setGeometry(node, { scrollTop: 1086 }),
      );
      fireNativeScroll(node);

      // The end pad resets and the browser clamps them onto the new end.
      shim.setGeometry(node, { scrollHeight: 1574, scrollTop: 1074 });
      result.current.followEndIfPermitted();
      fireNativeScroll(node);

      // The wheel's scroll lands.
      listRef.scrollToEnd.mockClear();
      shim.setGeometry(node, { scrollTop: 1034 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(1034);
    });

    it("a wheel's scroll that lands after the clamp and the tail's growth is the reader's, though the correction's frames come after it", () => {
      const node = shim.makeNode({
        scrollTop: 1056,
        scrollHeight: 1556,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isTurnRunning: () => true,
        }),
      );
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      shim.setGeometry(node, { scrollHeight: 1630 });
      moveChatTimelineScroller(node, 1086, () =>
        shim.setGeometry(node, { scrollTop: 1086 }),
      );
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollHeight: 1574, scrollTop: 1074 });
      result.current.followEndIfPermitted();
      fireNativeScroll(node);

      // The tail grows again while the turn runs.
      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();

      // The wheel's scroll lands, unreported.
      const landedAt = node.scrollTop - 40;
      shim.setGeometry(node, { scrollTop: landedAt });
      listRef.scrollToEnd.mockClear();
      flushAnimationFrame();
      flushAnimationFrame();
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(landedAt);
    });

    it("a wheel's scroll that lands after the pad reset held them and the turn-rest followed is the reader's, though a row's measure reads it first", () => {
      const turnRunning = { current: true };
      const node = shim.makeNode({
        scrollTop: 1056,
        scrollHeight: 1556,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
          isTurnRunning: () => turnRunning.current,
        }),
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      // The first wheel's report lands inside the pad.
      shim.setGeometry(node, { scrollTop: 1016 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      // The pad resets and the browser clamps the view onto the unpadded end.
      shim.setGeometry(node, { scrollHeight: 1500, scrollTop: 1000 });
      result.current.followEndIfPermitted();
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      turnRunning.current = false;
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
      onReaderGesture.mockClear();

      // The second wheel's scroll lands, unreported. A row in view then
      // measures larger, below the edge, and the maintain call reads the view.
      shim.setGeometry(node, { scrollTop: 960 });
      shim.setGeometry(node, { scrollHeight: 1530 });
      listRef.scrollToEnd.mockClear();
      result.current.followEndIfPermitted();
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(onReaderGesture).toHaveBeenCalledWith({
        direction: "away-from-end",
        freezeInFlightScroll: true,
        publishesReaderPosition: true,
      });
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(960);
    });
  });

  describe("a free reader at the strict bottom whose wheel up awaits its scroll", () => {
    it("stays free through a maintain read, growth and the list's held end command, and the wheel's scroll is the reader's", () => {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeHeldCommandListRef(node, shim);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      // The restore holds the free reader off the end it was restored onto.
      let restoreHolds = true;
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, false, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
          isReattachSuppressed: () => restoreHolds,
        }),
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      // The restore settles; a resize maintain read at the strict bottom
      // comes before the wheel's report.
      restoreHolds = false;
      result.current.followEndIfPermitted();
      // The tail grows.
      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();

      // The wheel's scroll lands, unreported; then the list's held end
      // command, if one was issued, lands.
      const landedAt = node.scrollTop - 40;
      shim.setGeometry(node, { scrollTop: landedAt });
      listRef.settle();
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);
      expect(node.scrollTop).toBe(landedAt);
    });

    function freeShortOfEndWithWheelDown() {
      const node = shim.makeNode({
        scrollTop: 900,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, false, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
        }),
      );
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
      return { node, onFollowIntentChange, result };
    }

    it("follows a reader whose wheel down scrolls them onto the end", () => {
      const { node, onFollowIntentChange } = freeShortOfEndWithWheelDown();
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      shim.setGeometry(node, { scrollTop: 1000 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("follows a reader whose wheel down meets the end coming up to them", () => {
      const { node, onFollowIntentChange, result } =
        freeShortOfEndWithWheelDown();

      shim.setGeometry(node, { scrollHeight: 1400 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });
  });

  describe("a held reader the pad's clamp holds, whose wheel's report landed", () => {
    it("follows at the turn's rest, and the tail's growth is then corrected", () => {
      let turnRunning = true;
      const node = shim.makeNode({
        scrollTop: 1056,
        scrollHeight: 1556,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isTurnRunning: () => turnRunning,
        }),
      );

      // The wheel's report inside the pad publishes the departure and spends
      // the wheel's arm.
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollTop: 1016 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      // The pad resets and the browser clamps them onto the unpadded end.
      shim.setGeometry(node, { scrollHeight: 1500, scrollTop: 1000 });
      result.current.followEndIfPermitted();
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      turnRunning = false;
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);

      listRef.scrollToEnd.mockClear();
      shim.setGeometry(node, { scrollHeight: 1528 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe("a following reader whose wheel up is absorbed at the strict bottom", () => {
    it("ends free with the pill: the departure is published to the reader gesture before follow goes false", () => {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
        }),
      );

      // The wheel up moves nothing: no report follows it.
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(onReaderGesture).toHaveBeenCalledTimes(1);
      expect(
        Math.min(...onReaderGesture.mock.invocationCallOrder),
      ).toBeLessThan(
        Math.max(...onFollowIntentChange.mock.invocationCallOrder),
      );
    });
  });

  describe("a following reader whose view is read outside a scroll report", () => {
    function followingAtLiveEnd() {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
        }),
      );
      fireNativeScroll(node);
      return { node, listRef, onFollowIntentChange, onReaderGesture, result };
    }

    function expectStillFollowing(mounted: {
      readonly onFollowIntentChange: Mock<(follow: boolean) => void>;
      readonly onReaderGesture: Mock;
    }): void {
      expect(mounted.onReaderGesture).not.toHaveBeenCalled();
      expect(mounted.onFollowIntentChange).not.toHaveBeenCalledWith(false);
    }

    it("departs when their scroll lands between a correction's frames, unreported", () => {
      const { node, listRef, onFollowIntentChange, onReaderGesture, result } =
        followingAtLiveEnd();

      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();
      expect(node.scrollTop).toBe(1200);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);

      // 40 up from the end; no input event and no report.
      shim.setGeometry(node, { scrollTop: 1160 });
      flushAnimationFrame();
      flushAnimationFrame();

      expect(onReaderGesture).toHaveBeenCalledTimes(1);
      expect(onReaderGesture).toHaveBeenCalledWith({
        direction: "away-from-end",
        freezeInFlightScroll: true,
        publishesReaderPosition: true,
      });
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(node.scrollTop).toBe(1160);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });

    it("keeps following through an announced adjust the list made with no reader input", () => {
      const mounted = followingAtLiveEnd();

      shim.setGeometry(mounted.node, { scrollHeight: 1530 });
      moveChatTimelineScroller(mounted.node, 1030, () =>
        shim.setGeometry(mounted.node, { scrollTop: 1030 }),
      );
      mounted.result.current.followEndIfPermitted();

      expectStillFollowing(mounted);
    });

    it("keeps following when the browser clamped the view onto a lower end", () => {
      const mounted = followingAtLiveEnd();

      shim.setGeometry(mounted.node, { scrollHeight: 1460, scrollTop: 960 });
      mounted.result.current.followEndIfPermitted();

      expectStillFollowing(mounted);
    });

    it("keeps following through a correction's own write, reissuing the end for growth below it", () => {
      const mounted = followingAtLiveEnd();

      shim.setGeometry(mounted.node, { scrollHeight: 1700 });
      mounted.result.current.followEndIfPermitted();
      shim.setGeometry(mounted.node, { scrollHeight: 1750 });
      flushAnimationFrame();
      flushAnimationFrame();

      expectStillFollowing(mounted);
      expect(mounted.node.scrollTop).toBe(1250);
    });

    it("keeps following through growth above the view that nothing announced, correcting to the end", () => {
      const mounted = followingAtLiveEnd();

      shim.setGeometry(mounted.node, { scrollHeight: 1560 });
      mounted.result.current.followEndIfPermitted();

      expectStillFollowing(mounted);
      expect(mounted.node.scrollTop).toBe(1060);
    });

    it("keeps following when an announced write reads back rounded and the next report jitters within the epsilon", () => {
      const mounted = followingAtLiveEnd();

      shim.setGeometry(mounted.node, { scrollHeight: 1530 });
      // The write asks for 1029.6; the browser reads back 1030.
      moveChatTimelineScroller(mounted.node, Math.round(1029.6), () =>
        shim.setGeometry(mounted.node, { scrollTop: Math.round(1029.6) }),
      );
      mounted.result.current.followEndIfPermitted();
      shim.setGeometry(mounted.node, { scrollTop: 1029.4 });
      fireNativeScroll(mounted.node);

      expectStillFollowing(mounted);
    });
  });

  interface ElementLayout {
    /** Offset in the list's content, so its screen top is this minus the
     *  node's scrollTop. */
    offset: number;
    readonly height: number;
  }

  /** Gives the node a real edge: the list's content container, a row that
   *  spans the node's top edge, and an element inside it that crosses the
   *  edge. jsdom has no layout, so rects follow `scrollTop`. */
  function installEdgeLayout(node: HTMLDivElement): (offset: number) => void {
    const content = document.createElement("div");
    content.className = "legend-list-content-container";
    const row = document.createElement("div");
    const edgeElement = document.createElement("div");
    const edgeLayout: ElementLayout = { offset: 1000, height: 100 };
    row.appendChild(edgeElement);
    content.appendChild(row);
    node.appendChild(content);
    const layouts = new Map<Element, ElementLayout>([
      [content, { offset: 0, height: node.scrollHeight }],
      [row, { offset: 900, height: 400 }],
      [edgeElement, edgeLayout],
    ]);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element): DOMRect {
        const layout = layouts.get(this);
        let top = 0;
        let height = 0;
        if (this === node) {
          height = node.clientHeight;
        } else if (layout !== undefined) {
          top = layout.offset - node.scrollTop;
          height = layout.height;
        }
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          width: 0,
          height,
          bottom: top + height,
          right: 0,
          toJSON: () => ({}),
        };
      },
    );
    return (offset) => {
      edgeLayout.offset = offset;
    };
  }

  describe("a following reader's finger toward the end while the stream grows", () => {
    const TAIL_ROW_KEY = "tail-row";

    function mountWithFinger(
      initialScrollAtEnd: boolean,
      isCorrectionSuppressed: (() => boolean) | undefined,
      withTailRow: boolean,
    ) {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const moveEdgeElement = installEdgeLayout(node);
      const listRef = makeFakeListRef(node);
      // The first row below the viewport's top edge at contact; without it,
      // the last row spans the whole view.
      if (withTailRow) listRef.setRowTop(TAIL_ROW_KEY, 1200);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, initialScrollAtEnd, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
          isCorrectionSuppressed,
        }),
      );
      fireTouch(node, "touchstart", 300);
      // The stream grows the end under the held correction.
      shim.setGeometry(node, { scrollHeight: 1700 });
      return {
        node,
        listRef,
        moveEdgeElement,
        onFollowIntentChange,
        onReaderGesture,
        result,
      };
    }

    it("N1: a report toward the end does not detach them, and the lift reaches the tail", () => {
      const { node, listRef, onFollowIntentChange, onReaderGesture } =
        mountWithFinger(true, undefined, true);

      shim.setGeometry(node, { scrollTop: 1030 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
      expect(onReaderGesture).not.toHaveBeenCalled();
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();

      fireTouch(node, "touchend", 300);

      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      expect(node.scrollTop).toBe(1200);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
    });

    it("N1: movement toward the end that never reports before the lift reaches the tail at the lift", () => {
      const { node, listRef, onFollowIntentChange, onReaderGesture } =
        mountWithFinger(true, undefined, true);

      shim.setGeometry(node, { scrollTop: 1030 });
      fireTouch(node, "touchend", 300);

      expect(node.scrollTop).toBe(1200);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
      expect(onReaderGesture).not.toHaveBeenCalled();
    });

    // The list compensates growth above the view by moving scrollTop with
    // the rows: the view's net movement against the reference row, and the
    // edge element's rise on screen, are the finger's, and here it is away
    // from the end.
    it("still detaches a finger away from the end whose scrollTop the list moved toward it", () => {
      const {
        node,
        listRef,
        moveEdgeElement,
        onFollowIntentChange,
        onReaderGesture,
      } = mountWithFinger(true, undefined, true);

      // Rows above grew by 100: the reference row and the edge element,
      // below the growth, moved with them. scrollTop is +70 net (list +100,
      // finger -30), so the edge element sits 30 lower on screen.
      listRef.setRowTop(TAIL_ROW_KEY, 1300);
      moveEdgeElement(1100);
      shim.setGeometry(node, { scrollTop: 1070 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(onReaderGesture).toHaveBeenCalledTimes(1);
    });

    // One row spans the whole view and grows inside, above the edge element.
    // The list compensates scrollTop by the growth and the row's top does not
    // move, so the row measure alone reads a finger away by 30 as toward the
    // end; the edge element, held still by the compensation, sank on screen.
    it("still detaches a finger away from the end over a spanning row that grew above the edge", () => {
      const { node, moveEdgeElement, onFollowIntentChange, onReaderGesture } =
        mountWithFinger(true, undefined, false);

      moveEdgeElement(1050);
      shim.setGeometry(node, { scrollTop: 1020 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(onReaderGesture).toHaveBeenCalledTimes(1);
    });

    // Rows between the edge element and the reference row grew by 100 and
    // the list anchored the reference row: scrollTop is +100 and the row
    // moved with it, while the edge element, above the growth, did not. It
    // rose on screen, so the edge measure alone reads a finger away by 30 as
    // toward the end; the row measure nets the list's move out.
    it("still detaches a finger away from the end when the list anchored a row below the edge element", () => {
      const { node, listRef, onFollowIntentChange, onReaderGesture } =
        mountWithFinger(true, undefined, true);

      listRef.setRowTop(TAIL_ROW_KEY, 1300);
      shim.setGeometry(node, { scrollTop: 1070 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(onReaderGesture).toHaveBeenCalledTimes(1);
    });

    // Each report is measured from the last one the finger moved toward the
    // end, not from the contact: a reversal stays net toward the end of the
    // contact offset, and is the reader leaving all the same.
    it("detaches a finger that reverses away from the end, though it is still past the contact offset", () => {
      const { node, listRef, onFollowIntentChange, onReaderGesture } =
        mountWithFinger(true, undefined, true);

      shim.setGeometry(node, { scrollTop: 1060 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);

      shim.setGeometry(node, { scrollTop: 1040 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(onReaderGesture).toHaveBeenCalledTimes(1);
      fireTouch(node, "touchend", 300);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(1040);
    });

    it("decides at the lift a reversal back to the contact offset whose report has not arrived", () => {
      const { node, listRef, onFollowIntentChange, onReaderGesture } =
        mountWithFinger(true, undefined, true);

      shim.setGeometry(node, { scrollTop: 1060 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 1000 });
      fireTouch(node, "touchend", 300);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(onReaderGesture).toHaveBeenCalledTimes(1);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(1000);
    });

    // Rows above grew by 100 after the finger's step toward the end: the list
    // moved scrollTop, the reference row and the edge element together, so
    // neither measure moved since that step.
    it("keeps the finger's step toward the end through a compensation reported after it", () => {
      const {
        node,
        listRef,
        moveEdgeElement,
        onFollowIntentChange,
        onReaderGesture,
      } = mountWithFinger(true, undefined, true);

      shim.setGeometry(node, { scrollTop: 1030 });
      fireNativeScroll(node);
      listRef.setRowTop(TAIL_ROW_KEY, 1300);
      moveEdgeElement(1100);
      shim.setGeometry(node, { scrollTop: 1130, scrollHeight: 1800 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
      expect(onReaderGesture).not.toHaveBeenCalled();
      fireTouch(node, "touchend", 300);
      expect(node.scrollTop).toBe(1300);
    });

    it("keeps a resting finger following through a compensation alone", () => {
      const {
        node,
        listRef,
        moveEdgeElement,
        onFollowIntentChange,
        onReaderGesture,
      } = mountWithFinger(true, undefined, true);

      listRef.setRowTop(TAIL_ROW_KEY, 1300);
      moveEdgeElement(1100);
      shim.setGeometry(node, { scrollTop: 1100, scrollHeight: 1800 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
      expect(onReaderGesture).not.toHaveBeenCalled();
      fireTouch(node, "touchend", 300);
      expect(node.scrollTop).toBe(1300);
    });

    it("publishes a departure when the reference row has gone, rather than reading it as toward the end", () => {
      const { node, listRef, onFollowIntentChange } = mountWithFinger(
        true,
        undefined,
        true,
      );

      listRef.removeRow(TAIL_ROW_KEY);
      shim.setGeometry(node, { scrollTop: 1030 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });

    // The exemption needs follow held: a detached reader's finger toward the
    // end is their reading position, published while a restore holds the
    // saved one.
    it("still publishes a detached reader's finger toward the end", () => {
      const { node, onReaderGesture } = mountWithFinger(
        false,
        () => true,
        true,
      );

      shim.setGeometry(node, { scrollTop: 1030 });
      fireNativeScroll(node);

      expect(onReaderGesture).toHaveBeenCalledTimes(1);
    });
  });

  describe("a resting finger whose view a strict-bottom read saw clamped", () => {
    const TAIL_ROW_KEY = "tail-row";

    /** A following reader with a finger resting at the end, a tail row as
     *  the reference row, and the end shrunk 40 under it: the browser clamped
     *  the view onto the new end, and a maintenance read saw that. */
    function fingerClampedOntoLowerEnd() {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      installEdgeLayout(node);
      const listRef = makeFakeListRef(node);
      listRef.setRowTop(TAIL_ROW_KEY, 1200);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
        }),
      );
      fireTouch(node, "touchstart", 300);

      shim.setGeometry(node, { scrollHeight: 1460, scrollTop: 960 });
      result.current.followEndIfPermitted();
      // Before the clamp's report, the row in view grows 40: the end moves
      // past the view, and the rows below it shift with the growth.
      shim.setGeometry(node, { scrollHeight: 1500 });
      listRef.setRowTop(TAIL_ROW_KEY, 1240);
      return { node, onFollowIntentChange, onReaderGesture };
    }

    it("a clamp onto a lower end that a maintenance read saw is not the finger's, though the end moved again before its report", () => {
      const { node, onFollowIntentChange, onReaderGesture } =
        fingerClampedOntoLowerEnd();

      fireNativeScroll(node);

      expect(onReaderGesture).not.toHaveBeenCalled();
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
    });

    it("the finger's real pan away from the end after that clamp is still their departure", () => {
      const { node, onFollowIntentChange, onReaderGesture } =
        fingerClampedOntoLowerEnd();

      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 900 });
      fireNativeScroll(node);

      expect(onReaderGesture).toHaveBeenCalledTimes(1);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });

    function detachedUnderFingerOnRecoveringList() {
      const node = shim.makeNode({
        scrollTop: 900,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, false, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isReattachSuppressed: () => true,
        }),
      );
      fireTouch(node, "touchstart", 300);
      // The recovering list clamps the view onto the strict bottom.
      shim.setGeometry(node, { scrollHeight: 1400 });
      return { node, onFollowIntentChange, result };
    }

    it("a recovering list's clamp onto the strict bottom, seen by a read under a finger, is not the finger arriving", () => {
      const { onFollowIntentChange, result } =
        detachedUnderFingerOnRecoveringList();

      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);
    });
  });

  describe("a write the list makes under a finger, which iOS lands after the lift", () => {
    // A following reader at the end with one report seen, so the latch knows
    // where the view should be.
    function followingWithLiveLedger() {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
        }),
      );
      fireNativeScroll(node);
      return { node, listRef, onFollowIntentChange, onReaderGesture, result };
    }

    /** A row above re-measures 60 smaller and the list adjusts by -60. The
     *  finger is down, so iOS holds the write back: the announcement reads
     *  the old offset. */
    function announceHeldBackAdjust(node: HTMLDivElement): void {
      moveChatTimelineScroller(node, node.scrollTop - 60, () => {});
    }

    /** The held-back adjust lands after the lift, unannounced, while the
     *  stream has grown the end past the view. */
    function landHeldBackAdjust(node: HTMLDivElement): void {
      shim.setGeometry(node, {
        scrollHeight: node.scrollHeight - 60 + 100,
        scrollTop: node.scrollTop - 60,
      });
    }

    it("a tap's held-back adjust that lands after the lift is not the reader's pan", () => {
      const { node, onFollowIntentChange, onReaderGesture } =
        followingWithLiveLedger();

      fireTouch(node, "touchstart", 300);
      announceHeldBackAdjust(node);
      fireTouch(node, "touchend", 300);
      landHeldBackAdjust(node);
      fireNativeScroll(node);

      expect(onReaderGesture).not.toHaveBeenCalled();
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
    });

    it("a tap's held-back adjust that a read sees before its report is not the reader's pan", () => {
      const { node, onFollowIntentChange, onReaderGesture, result } =
        followingWithLiveLedger();

      fireTouch(node, "touchstart", 300);
      announceHeldBackAdjust(node);
      fireTouch(node, "touchend", 300);
      landHeldBackAdjust(node);
      result.current.followEndIfPermitted();
      fireNativeScroll(node);

      expect(onReaderGesture).not.toHaveBeenCalled();
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
    });

    it("a drag toward the end's held-back adjust that lands after the lift is not the reader's pan", () => {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      installEdgeLayout(node);
      const listRef = makeFakeListRef(node);
      // The first row below the viewport's top edge at contact.
      listRef.setRowTop("tail-row", 1200);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
        }),
      );
      fireNativeScroll(node);

      fireTouch(node, "touchstart", 300);
      // The stream grows the end under the finger, which drags toward it.
      shim.setGeometry(node, { scrollHeight: 1700 });
      fireTouch(node, "touchmove", 260);
      shim.setGeometry(node, { scrollTop: 1030 });
      fireNativeScroll(node);
      announceHeldBackAdjust(node);
      fireTouch(node, "touchend", 260);
      landHeldBackAdjust(node);
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
      expect(onReaderGesture).not.toHaveBeenCalledWith(
        expect.objectContaining({ direction: "away-from-end" }),
      );
      expect(onReaderGesture).not.toHaveBeenCalledWith(
        expect.objectContaining({ direction: "indeterminate" }),
      );
    });

    it("a real pan after the landed adjust's report still departs", () => {
      const { node, onFollowIntentChange, onReaderGesture } =
        followingWithLiveLedger();

      fireTouch(node, "touchstart", 300);
      announceHeldBackAdjust(node);
      fireTouch(node, "touchend", 300);
      landHeldBackAdjust(node);
      fireNativeScroll(node);
      expect(onReaderGesture).not.toHaveBeenCalled();

      shim.setGeometry(node, { scrollTop: node.scrollTop - 50 });
      fireNativeScroll(node);

      expect(onReaderGesture).toHaveBeenCalledTimes(1);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });

    it("a departure published in the contact stands where a held-back adjust landed it, so the end coming up to them is held while the turn runs", () => {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isTurnRunning: () => true,
        }),
      );
      fireNativeScroll(node);

      fireTouch(node, "touchstart", 300);
      fireTouch(node, "touchmove", 340);
      shim.setGeometry(node, { scrollTop: 950 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      announceHeldBackAdjust(node);
      fireTouch(node, "touchend", 340);

      // The adjust lands after the lift, and its report comes first.
      shim.setGeometry(node, { scrollTop: 890 });
      fireNativeScroll(node);
      // Then the end comes up to them.
      shim.setGeometry(node, { scrollHeight: 1390 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });

    it("with no write held back, a pan right after the lift still departs", () => {
      const { node, onFollowIntentChange, onReaderGesture } =
        followingWithLiveLedger();

      fireTouch(node, "touchstart", 300);
      fireTouch(node, "touchend", 300);
      shim.setGeometry(node, { scrollTop: 950 });
      fireNativeScroll(node);

      expect(onReaderGesture).toHaveBeenCalledTimes(1);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });
  });

  describe("a departed reader whose own scroll moves on away from the end", () => {
    function followingWithTurn() {
      const turnRunning = { current: true };
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
          isTurnRunning: () => turnRunning.current,
        }),
      );
      fireNativeScroll(node);
      return {
        node,
        listRef,
        onFollowIntentChange,
        onReaderGesture,
        result,
        turnRunning,
      };
    }

    /** The end comes to the departed reader mid-turn, the tail then grows
     *  past them, and the turn rests with the end back on them. */
    function expectHeldThenFollowedAtRest(mounted: {
      readonly node: HTMLDivElement;
      readonly listRef: FakeListRef;
      readonly onFollowIntentChange: Mock<(follow: boolean) => void>;
      readonly result: { readonly current: ChatTimelineFollowLatch };
      readonly turnRunning: { current: boolean };
    }): void {
      const { node, listRef, onFollowIntentChange, result, turnRunning } =
        mounted;

      shim.setGeometry(node, { scrollHeight: 1420, scrollTop: 920 });
      result.current.followEndIfPermitted();
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      listRef.scrollToEnd.mockClear();
      shim.setGeometry(node, { scrollHeight: 1460 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(920);

      shim.setGeometry(node, { scrollHeight: 1420 });
      turnRunning.current = false;
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    }

    it("a smooth wheel's second frame, farther up, leaves the departure held when the end comes to them mid-turn", () => {
      const mounted = followingWithTurn();
      const { node, onFollowIntentChange } = mounted;

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      shim.setGeometry(node, { scrollTop: 920 });
      fireNativeScroll(node);

      expectHeldThenFollowedAtRest(mounted);
    });

    // A scrollbar drag arrives as silent reports with no input event, which
    // the unannounced-pan path publishes as the departure.
    it("a scrollbar drag's next report, farther up, leaves the departure held when the end comes to them mid-turn", () => {
      const mounted = followingWithTurn();
      const { node, onFollowIntentChange, onReaderGesture } = mounted;

      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onReaderGesture).toHaveBeenCalledTimes(1);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      shim.setGeometry(node, { scrollTop: 920 });
      fireNativeScroll(node);

      expectHeldThenFollowedAtRest(mounted);
    });

    // Their scroll has reported, so no report of theirs is coming to move
    // them off the end: with the turn finished, nothing will leave them
    // behind, and holding them would strand them on the end with the pill.
    it("guard: with the turn finished, the end coming to a reader whose scroll moved on follows them", () => {
      const { node, onFollowIntentChange, result, turnRunning } =
        followingWithTurn();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 920 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      turnRunning.current = false;
      shim.setGeometry(node, { scrollHeight: 1420 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    // Published at their wheel's report, not ahead of it: no report of theirs
    // is owed, so with the turn finished the end meeting them, with no scroll
    // event, follows them rather than leaving them free on it.
    it("guard: with the turn finished, the end meeting a reader departed at their wheel's report follows them", () => {
      const { node, onFollowIntentChange, result, turnRunning } =
        followingWithTurn();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      turnRunning.current = false;
      shim.setGeometry(node, { scrollHeight: 1460 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("guard: with the turn finished, the end meeting a reader a scrollbar drag's report departed follows them", () => {
      const { node, onFollowIntentChange, result, turnRunning } =
        followingWithTurn();

      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      turnRunning.current = false;
      shim.setGeometry(node, { scrollHeight: 1460 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    // A read sees the pan before its scroll event: the departure is published
    // ahead of that event, which the view's move makes sure comes. The end
    // meeting them until then is the list's, so rows that grow before the
    // event do not pull them, and the event leaves them free.
    it("a pan a read published ahead of its scroll event stays held when the end meets them idle, is not pulled, and its event leaves them free", () => {
      const { node, listRef, onFollowIntentChange, result, turnRunning } =
        followingWithTurn();
      turnRunning.current = false;

      shim.setGeometry(node, { scrollTop: 960 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      shim.setGeometry(node, { scrollHeight: 1460 });
      result.current.followEndIfPermitted();
      shim.setGeometry(node, { scrollHeight: 1560 });
      result.current.followEndIfPermitted();
      flushAnimationFrame();
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      shim.setGeometry(node, { scrollTop: 920 });
      fireNativeScroll(node);

      expect(onFollowIntentChange.mock.calls).toEqual([[false]]);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(920);
    });

    // iOS delivers no `touchmove`: the finger's report is the departure.
    it("guard: with the turn finished, the end meeting a reader a finger's report departed follows them", () => {
      const { node, onFollowIntentChange, result, turnRunning } =
        followingWithTurn();

      fireTouch(node, "touchstart", 300);
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      fireTouch(node, "touchend", 340);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      turnRunning.current = false;
      shim.setGeometry(node, { scrollHeight: 1460 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    // Their arrival ends the hold even while a restore holds the follow off:
    // the end then dropping under them mid-turn is not the end coming to a
    // held reader, and they follow once the restore lets them.
    it("a held reader's arrival a restore holds off still ends the hold, so a clamp mid-turn after it leaves them to follow", () => {
      const turnRunning = { current: true };
      let restoreHolds = false;
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isTurnRunning: () => turnRunning.current,
          isReattachSuppressed: () => restoreHolds,
        }),
      );
      fireNativeScroll(node);
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      restoreHolds = true;
      shim.setGeometry(node, { scrollTop: 1000 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollHeight: 1440, scrollTop: 940 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      restoreHolds = false;
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    // A drag back toward the end, short of it, still leaves them departed,
    // from there: a pad reset that brings the end exactly to them mid-turn
    // is the list's, and the tail's growth after it does not pull them.
    it("a held reader's drag back toward the end, short of it, stays held when the end pad resets onto them mid-turn", () => {
      const { node, listRef, onFollowIntentChange, result, turnRunning } =
        followingWithTurn();

      shim.setGeometry(node, { scrollTop: 920 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);

      shim.setGeometry(node, { scrollHeight: 1460 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      shim.setGeometry(node, { scrollHeight: 1500 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(960);

      shim.setGeometry(node, { scrollHeight: 1460 });
      turnRunning.current = false;
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    // At fractional offsets (125% display scaling here), the list's write
    // that keeps the view on the end must carry a departure on the end to
    // exactly where it lands: its own report there is not their arrival.
    it("a held reader on the end that an announced write carries at fractional offsets stays held mid-turn", () => {
      const turnRunning = { current: true };
      const from = 2725.6;
      const to = 2799.2;
      const node = shim.makeNode({
        scrollTop: from + 40,
        scrollHeight: from + 540,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isTurnRunning: () => turnRunning.current,
        }),
      );
      fireNativeScroll(node);
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollTop: from });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollHeight: from + 500 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange.mock.calls).toEqual([[false]]);

      shim.setGeometry(node, { scrollHeight: to + 500 });
      moveChatTimelineScroller(node, to, () => {
        shim.setGeometry(node, { scrollTop: to });
      });
      fireNativeScroll(node);

      expect(onFollowIntentChange.mock.calls).toEqual([[false]]);
    });

    // A slow approach's last step into the end can be under a pixel: still
    // past where their departure stood, so still theirs.
    it("a held reader's slow scroll reaching the end mid-turn in sub-pixel steps follows", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingWithTurn();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      for (const scrollTop of [980, 998.6, 999.4, 1000]) {
        shim.setGeometry(node, { scrollTop });
        fireNativeScroll(node);
      }
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);

      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });

    // Their own report at the strict bottom, past where the departure stood,
    // is them arriving: it follows, though the turn runs.
    it("guard: a held reader whose report reaches the strict bottom mid-turn follows", () => {
      const { node, onFollowIntentChange } = followingWithTurn();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      shim.setGeometry(node, { scrollTop: 1000 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    // Their arrival is seen by a read before its report, mid-turn: past where
    // their scroll toward the end moved the departure, it follows them.
    it("guard: a held reader's scroll toward the end, short of it, moves the departure there, and a read of their arrival follows", () => {
      const { node, onFollowIntentChange, result } = followingWithTurn();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      shim.setGeometry(node, { scrollTop: 990 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      shim.setGeometry(node, { scrollTop: 1000 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("guard: a reader whose scroll moved on, back at the end mid-turn, follows at a read that sees them there", () => {
      const { node, onFollowIntentChange, result } = followingWithTurn();

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 920 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      shim.setGeometry(node, { scrollTop: 1000 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });
  });

  describe("a wheel a nested scroller owned, departed by the tail ahead of a report that never comes", () => {
    function followingWithNestedScroller() {
      const turnRunning = { current: true };
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const nested = shim.makeNode({
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 100,
      });
      nested.style.overflowY = "auto";
      node.appendChild(nested);
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isTurnRunning: () => turnRunning.current,
        }),
      );
      fireNativeScroll(node);
      return {
        node,
        nested,
        listRef,
        onFollowIntentChange,
        result,
        turnRunning,
      };
    }

    // The nested scroller at its top owned the gesture and never moved the
    // transcript, though its wheels went on past the growth (a trackpad's
    // momentum): its `scrollend` ends the wait for a report and the arm its
    // later wheels left, so the turn's rest follows them, and the tail's next
    // growth with them.
    it("the turn's rest follows them at the strict bottom once the nested scroller's scroll has ended", () => {
      const {
        node,
        nested,
        listRef,
        onFollowIntentChange,
        result,
        turnRunning,
      } = followingWithNestedScroller();

      nested.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -120, bubbles: true }),
      );
      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      nested.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -120, bubbles: true }),
      );

      shim.setGeometry(node, { scrollHeight: 1500 });
      result.current.followEndIfPermitted();
      nested.dispatchEvent(new Event("scrollend"));
      expect(onFollowIntentChange.mock.calls).toEqual([[false]]);

      turnRunning.current = false;
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange.mock.calls).toEqual([[false], [true]]);

      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });

    it("with no turn running, the end meeting them after the nested scroller's scroll has ended follows them", () => {
      const { node, nested, onFollowIntentChange, result, turnRunning } =
        followingWithNestedScroller();
      turnRunning.current = false;

      nested.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -120, bubbles: true }),
      );
      shim.setGeometry(node, { scrollHeight: 1600 });
      result.current.followEndIfPermitted();
      nested.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -120, bubbles: true }),
      );
      nested.dispatchEvent(new Event("scrollend"));
      shim.setGeometry(node, { scrollHeight: 1500 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange.mock.calls).toEqual([[false], [true]]);
    });
  });

  describe("an end correction's write while the list pads its content end", () => {
    const PAD_PX = 80;

    function followingBeforeGrowth(input: {
      readonly padded: boolean;
      readonly contentLength: number;
      readonly scrollTop: number;
    }) {
      const node = shim.makeNode({
        scrollTop: input.scrollTop,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const content = document.createElement("div");
      content.className = "legend-list-content-container";
      if (input.padded) content.style.paddingBottom = `${PAD_PX}px`;
      node.appendChild(content);
      const listRef = makeFakeListRef(node);
      listRef.setContentLength(input.contentLength);
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(
          listRef,
          true,
          true,
          DEFAULT_FOLLOW_LATCH_OPTIONS,
        ),
      );
      return { node, listRef, result };
    }

    it("lands at the list's end, not inside its padding", () => {
      const { node, listRef, result } = followingBeforeGrowth({
        padded: true,
        contentLength: 1700,
        scrollTop: 1000,
      });

      // The DOM end includes the pad: 1700 laid out + 80 of padding.
      shim.setGeometry(node, { scrollHeight: 1700 + PAD_PX });
      result.current.followEndIfPermitted();

      expect(node.scrollTop).toBe(1700 - 500);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });

    it("never moves the view back from where the list already put it", () => {
      const { node, result } = followingBeforeGrowth({
        padded: true,
        contentLength: 1700,
        scrollTop: 1250,
      });

      shim.setGeometry(node, { scrollHeight: 1700 + PAD_PX });
      result.current.followEndIfPermitted();

      expect(node.scrollTop).toBe(1250);
    });

    // Without the pad the DOM is the truth: it grew before the list
    // re-measured, and the list's size is the stale one.
    it("lands at the DOM end when no padding is held, even where the list's size lags", () => {
      const { node, result } = followingBeforeGrowth({
        padded: false,
        contentLength: 1600,
        scrollTop: 1000,
      });

      shim.setGeometry(node, { scrollHeight: 1780 });
      result.current.followEndIfPermitted();

      expect(node.scrollTop).toBe(1780 - 500);
    });
  });

  describe("a wheel up at the strict bottom, across the turn's end", () => {
    function followingAtStrictBottom(isTurnRunning: () => boolean) {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
          isTurnRunning,
        }),
      );
      return { node, listRef, onFollowIntentChange, onReaderGesture, result };
    }

    // The turn ends between the wheel's event and the browser applying its
    // smooth scroll: the view is still at the strict bottom then.
    it("keeps a wheel's departure whose scroll lands after the turn ended", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom(() => false);

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      result.current.reconcileTurnAtRest();
      shim.setGeometry(node, { scrollTop: 880 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(880);
    });

    // No report tells that wheel from one the end absorbed, so the absorbed
    // one keeps its arm too: the next turn's growth is the reader's
    // departure, and they keep their place with the pill.
    it("leaves an absorbed wheel's arm to depart at the next turn's growth", () => {
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom(() => false);

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      result.current.reconcileTurnAtRest();
      shim.setGeometry(node, { scrollHeight: 1700 });
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(1000);
    });

    it("R3's departure and the end pad's clamp agree: held through the turn, following after it", () => {
      let turnRunning = true;
      const { node, listRef, onFollowIntentChange, result } =
        followingAtStrictBottom(() => turnRunning);

      // The wheel up leaves nothing to report; the tail growing under it is
      // the departure, published at the offset the reader holds.
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      shim.setGeometry(node, { scrollHeight: 1556 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      // The end pad drops: the end clamps below the departure offset.
      shim.setGeometry(node, { scrollHeight: 1450, scrollTop: 950 });
      result.current.followEndIfPermitted();
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();

      turnRunning = false;
      result.current.reconcileTurnAtRest();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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

  // iOS WebKit stops delivering `touchmove` once its native pan owns the
  // touch, so the list sees `touchstart`, scroll reports, and `touchend`.
  it("detaches follow from a touch the list only sees as scroll reports", () => {
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    fireTouch(node, "touchstart", 100);
    // A streamed row grows under the finger: no correction while it is down.
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    expect(onReaderGesture).not.toHaveBeenCalled();

    shim.setGeometry(node, { scrollTop: 850 });
    fireNativeScroll(node);

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    expect(onReaderGesture).toHaveBeenCalledWith({
      direction: "indeterminate",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    });
    fireTouch(node, "touchend", 100);
    shim.setGeometry(node, { scrollHeight: 1900 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  describe("a free reader's touch during a suppressed restore", () => {
    const TOUCH_DEPARTURE = {
      direction: "indeterminate",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    };

    function mountFreeReader(isSuppressed: () => boolean) {
      const node = shim.makeNode({
        scrollTop: 400,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onReaderGesture = vi.fn();
      renderHook(() =>
        useChatTimelineFollowLatch(listRef, false, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onReaderGesture,
          isCorrectionSuppressed: isSuppressed,
        }),
      );
      fireTouch(node, "touchstart", 100);
      return { node, onReaderGesture };
    }

    it("publishes the departure when a scroll report moves the view", () => {
      const { node, onReaderGesture } = mountFreeReader(() => true);

      shim.setGeometry(node, { scrollTop: 300 });
      fireNativeScroll(node);

      expect(onReaderGesture).toHaveBeenCalledTimes(1);
      expect(onReaderGesture).toHaveBeenCalledWith(TOUCH_DEPARTURE);
    });

    it("publishes nothing once the restore is no longer suppressing", () => {
      const { node, onReaderGesture } = mountFreeReader(() => false);

      shim.setGeometry(node, { scrollTop: 300 });
      fireNativeScroll(node);

      expect(onReaderGesture).not.toHaveBeenCalled();
    });

    it("publishes nothing for a report at the contact offset", () => {
      const { node, onReaderGesture } = mountFreeReader(() => true);

      shim.setGeometry(node, { scrollTop: 400.5 });
      fireNativeScroll(node);

      expect(onReaderGesture).not.toHaveBeenCalled();
    });

    it("does not publish again once the publish lifted the suppression", () => {
      let suppressed = true;
      const { node, onReaderGesture } = mountFreeReader(() => suppressed);

      shim.setGeometry(node, { scrollTop: 300 });
      fireNativeScroll(node);
      suppressed = false;
      shim.setGeometry(node, { scrollTop: 250 });
      fireNativeScroll(node);

      expect(onReaderGesture).toHaveBeenCalledTimes(1);
    });
  });

  it("publishes a touch departure at the lift when its scroll report is still pending", () => {
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    fireTouch(node, "touchstart", 100);
    shim.setGeometry(node, { scrollTop: 850 });
    fireTouch(node, "touchend", 100);

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("releases a tap at the end on the lift and catches up the growth it held back", () => {
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    fireTouch(node, "touchstart", 100);
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    fireTouch(node, "touchend", 100);

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
  });

  it("keeps a touch contact armed across a pointer preflight and a strict-bottom pass", () => {
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    fireTouch(node, "touchstart", 100);
    // The host's content-tap `pointerdown` preflight arrives after
    // `touchstart` on some engines; it must not end the contact.
    result.current.noteReaderGesture({
      direction: "indeterminate",
      freezeInFlightScroll: true,
      publishesReaderPosition: false,
    });
    shim.setGeometry(node, { scrollTop: 850 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    // The finger drags back to the strict bottom and on past it: the
    // reattach must not strand the rest of the drag as layout-owned.
    shim.setGeometry(node, { scrollTop: 1000 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    shim.setGeometry(node, { scrollTop: 900 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("measures a touch from the tail it re-reached, not the original contact offset", () => {
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    // Contact at the end; streaming grows the tail past it under the finger.
    fireTouch(node, "touchstart", 100);
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    // The finger drags to the new end, then back to the original contact
    // offset, which is now 200px above the tail.
    shim.setGeometry(node, { scrollTop: 1200 });
    fireNativeScroll(node);
    // Still following: reaching the tail is not a transition.
    expect(onFollowIntentChange).not.toHaveBeenCalled();
    shim.setGeometry(node, { scrollTop: 1000 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    fireTouch(node, "touchend", 100);
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
  });

  // iOS may deliver the first `touchmove`s and then hand the touch to its
  // native pan: the rest of the contact arrives as bare scroll reports.
  it("keeps a touch contact armed after a delivered touchmove and a strict-bottom report", () => {
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    fireTouch(node, "touchstart", 100);
    fireTouch(node, "touchmove", 140);
    // The pan's first report (a rubber-band frame) is still at the edge.
    fireNativeScroll(node);
    expect(onFollowIntentChange).not.toHaveBeenCalled();

    shim.setGeometry(node, { scrollTop: 850 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();
  });

  it("does not reattach a touch contact at an end that streaming has since moved", () => {
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    fireTouch(node, "touchstart", 100);
    // A toward-end touchmove while the end is still 1000; streaming then
    // grows the tail to 1200 before the pan's first report.
    fireTouch(node, "touchmove", 60);
    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).not.toHaveBeenCalled();

    // The finger crosses the old end but is still 150px above the live one.
    shim.setGeometry(node, { scrollTop: 1050 });
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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

  describe("a detached reader arriving at the end while reattachment is suppressed", () => {
    interface DetachedReader {
      readonly node: HTMLDivElement;
      readonly listRef: FakeListRef;
      readonly onFollowIntentChange: Mock<(intent: boolean) => void>;
      readonly maintain: () => void;
      readonly liftSuppression: () => void;
    }

    function mountDetachedReader(): DetachedReader {
      const node = shim.makeNode({
        scrollTop: 700,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(intent: boolean) => void>();
      let suppressed = true;
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, false, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isReattachSuppressed: () => suppressed,
        }),
      );
      return {
        node,
        listRef,
        onFollowIntentChange,
        maintain: () => result.current.followEndIfPermitted(),
        liftSuppression: () => {
          suppressed = false;
        },
      };
    }

    // The settle lifts the suppression and the tail has grown past the reader
    // without a scroll report.
    function settleAfterGrowth(reader: DetachedReader): void {
      reader.liftSuppression();
      shim.setGeometry(reader.node, { scrollHeight: 1700 });
      reader.maintain();
    }

    it("follows the end the reader asked for once the settle lifts, though the tail grew", () => {
      const reader = mountDetachedReader();
      reader.node.dispatchEvent(new WheelEvent("wheel", { deltaY: 180 }));

      shim.setGeometry(reader.node, { scrollTop: 1000 });
      fireNativeScroll(reader.node);
      expect(reader.onFollowIntentChange).not.toHaveBeenCalledWith(true);
      expect(reader.listRef.scrollToEnd).not.toHaveBeenCalled();

      settleAfterGrowth(reader);

      expect(reader.onFollowIntentChange).toHaveBeenLastCalledWith(true);
      expect(reader.listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });

    it("stays detached when the reader wheels away before the settle", () => {
      const reader = mountDetachedReader();
      reader.node.dispatchEvent(new WheelEvent("wheel", { deltaY: 180 }));
      shim.setGeometry(reader.node, { scrollTop: 1000 });
      fireNativeScroll(reader.node);
      reader.node.dispatchEvent(new WheelEvent("wheel", { deltaY: -180 }));

      settleAfterGrowth(reader);

      expect(reader.onFollowIntentChange).not.toHaveBeenCalledWith(true);
      expect(reader.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("stays detached at a clamp the reader did not ask for", () => {
      const reader = mountDetachedReader();
      reader.node.dispatchEvent(new WheelEvent("wheel", { deltaY: -180 }));
      shim.setGeometry(reader.node, { scrollTop: 1000 });
      fireNativeScroll(reader.node);

      settleAfterGrowth(reader);

      expect(reader.onFollowIntentChange).not.toHaveBeenCalledWith(true);
      expect(reader.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("follows an arrival that only a maintain call observed", () => {
      const reader = mountDetachedReader();
      reader.node.dispatchEvent(new WheelEvent("wheel", { deltaY: 180 }));

      shim.setGeometry(reader.node, { scrollTop: 1000 });
      reader.maintain();
      expect(reader.listRef.scrollToEnd).not.toHaveBeenCalled();

      settleAfterGrowth(reader);

      expect(reader.onFollowIntentChange).toHaveBeenLastCalledWith(true);
      expect(reader.listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });
  });

  describe("a toward-end reader and rows that move the end", () => {
    function mountDetachedReader() {
      const node = shim.makeNode({
        scrollTop: 700,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn();
      renderHook(() =>
        useChatTimelineFollowLatch(listRef, false, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
        }),
      );
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: 180 }));
      return { node, listRef, onFollowIntentChange };
    }

    // Rows above the reader remeasure by 300px: the list moves the last row
    // and the reader down with them, so the end the wheel headed for is now
    // 300px further down than the offset it recorded.
    const SHIFT_PX = 300;

    it("does not reattach a reader still short of the end the rows moved", () => {
      const { node, listRef, onFollowIntentChange } = mountDetachedReader();

      listRef.setLastRowTop(FAKE_LAST_ROW_TOP_PX + SHIFT_PX);
      shim.setGeometry(node, {
        scrollTop: 1000 + SHIFT_PX - 100,
        scrollHeight: 2100,
      });
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("reattaches a reader who reaches the end the rows moved", () => {
      const { node, listRef, onFollowIntentChange } = mountDetachedReader();

      listRef.setLastRowTop(FAKE_LAST_ROW_TOP_PX + SHIFT_PX);
      shim.setGeometry(node, {
        scrollTop: 1000 + SHIFT_PX - 100,
        scrollHeight: 2100,
      });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 1000 + SHIFT_PX });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("still reattaches at the old end when only the tail grew", () => {
      const { node, listRef, onFollowIntentChange } = mountDetachedReader();

      shim.setGeometry(node, { scrollTop: 1000, scrollHeight: 1700 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    });
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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

    // A real DOM scrollTop write matching MVCP's own coordinate remap,
    // announced as the list announces it. With no publishing reader input,
    // this layout-owned report cannot revoke the existing follow intent and
    // immediately starts correction.
    moveChatTimelineScroller(node, 300, () =>
      shim.setGeometry(node, { scrollTop: 300, scrollHeight: 1500 }),
    );
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
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

  it("corrects a toward-end wheel whose report lands short of a tail that grew while following", () => {
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
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );
    fireNativeScroll(node); // confirm following at the strict bottom

    // The tail grows while following; the reader is now 200px short of it.
    shim.setGeometry(node, { scrollHeight: 1700 });
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);

    // The wheel's native report lands short of the grown tail.
    shim.setGeometry(node, { scrollTop: 1100 });
    fireNativeScroll(node);

    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("replaces an unreported away-from-end arm with a toward-end wheel and corrects", () => {
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
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );
    fireNativeScroll(node); // confirm following at the strict bottom

    shim.setGeometry(node, { scrollHeight: 1700 });
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    // The away-from-end wheel's native scroll report has not arrived yet.
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
  });

  it("does not supersede a pending end correction with a toward-end wheel while following", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    listRef.scrollToEnd.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const onFollowIntentChange = vi.fn();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        onFollowIntentChange,
        onReaderGesture: undefined,
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    shim.setGeometry(node, { scrollHeight: 1700 });
    result.current.followEndIfPermitted();
    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));

    expect(listRef.scrollToOffset).not.toHaveBeenCalled();
    expect(onFollowIntentChange).not.toHaveBeenCalledWith(false);
  });

  it("follows a toward-end wheel at the bottom when no scroll event arrives after it", () => {
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
        isCorrectionSuppressed: undefined,
        resolveSuppressedEndLanding: undefined,
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );
    fireNativeScroll(node); // confirm at the strict bottom

    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
    shim.setGeometry(node, { scrollTop: 200 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

    // Geometry returns to the strict bottom with no scroll event delivered.
    shim.setGeometry(node, { scrollTop: 1000 });
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));

    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
  });

  it("also observes the legend-list content container child so its own resize follows", () => {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const content = document.createElement("div");
    content.className = "legend-list-content-container";
    node.appendChild(content);
    const listRef = makeFakeListRef(node);
    renderHook(() =>
      useChatTimelineFollowLatch(
        listRef,
        true,
        true,
        DEFAULT_FOLLOW_LATCH_OPTIONS,
      ),
    );

    const [observer] = capturedResizeObservers;
    expect(observer.observedTargets).toContain(content);

    fireNativeScroll(node);
    shim.setGeometry(node, { scrollHeight: 1700 });
    fireResizeObservers();

    expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  describe("completeOwnedFreeNavigation", () => {
    it("follows a strict-bottom landing even while reattach is suppressed", () => {
      const node = shim.makeNode({
        scrollTop: 1000,
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
          isReattachSuppressed: () => true,
          isTurnRunning: undefined,
        }),
      );

      result.current.beginOwnedFreeNavigation();
      result.current.completeOwnedFreeNavigation();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("detaches when its landing is away from the bottom", () => {
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
          isReattachSuppressed: undefined,
          isTurnRunning: undefined,
        }),
      );

      result.current.beginOwnedFreeNavigation();
      shim.setGeometry(node, { scrollTop: 200 });
      result.current.completeOwnedFreeNavigation();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    });

    it("follows when the navigation's own departure report already consumed its arm", () => {
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
          isReattachSuppressed: undefined,
          isTurnRunning: undefined,
        }),
      );

      result.current.beginOwnedFreeNavigation();
      // The navigation's own first report departs the strict bottom,
      // consuming its arm exactly as a reader gesture's report would.
      shim.setGeometry(node, { scrollTop: 400 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      // It then lands back at the strict bottom. That report is still the
      // navigation's: follow waits for its completion, so no correction can
      // start under it and outlive it.
      shim.setGeometry(node, { scrollTop: 1000 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);

      result.current.completeOwnedFreeNavigation();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("is a no-op once reader input has abandoned the navigation", () => {
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
          isReattachSuppressed: undefined,
          isTurnRunning: undefined,
        }),
      );

      result.current.beginOwnedFreeNavigation();
      result.current.noteReaderGesture({
        direction: "indeterminate",
        freezeInFlightScroll: true,
        publishesReaderPosition: false,
      });
      // Land away from the bottom - a landing an owned navigation would
      // otherwise read as its own detaching landing.
      shim.setGeometry(node, { scrollTop: 300 });
      result.current.completeOwnedFreeNavigation();

      expect(onFollowIntentChange).not.toHaveBeenCalled();
    });

    it("is a no-op once a touch contact has begun", () => {
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
          isReattachSuppressed: undefined,
          isTurnRunning: undefined,
        }),
      );

      result.current.beginOwnedFreeNavigation();
      fireTouch(node, "touchstart", 100);
      shim.setGeometry(node, { scrollTop: 300 });
      result.current.completeOwnedFreeNavigation();

      expect(onFollowIntentChange).not.toHaveBeenCalled();
    });

    it("without a prior begin is a no-op", () => {
      const node = shim.makeNode({
        scrollTop: 300,
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
          isReattachSuppressed: undefined,
          isTurnRunning: undefined,
        }),
      );

      result.current.completeOwnedFreeNavigation();

      expect(onFollowIntentChange).not.toHaveBeenCalled();
    });
  });

  it("cancelOwnedFreeNavigation decides no landing and lets the next strict-bottom report follow", () => {
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    result.current.beginOwnedFreeNavigation();
    shim.setGeometry(node, { scrollTop: 400 });
    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
    onFollowIntentChange.mockClear();

    // Back at the strict bottom when cancelled: completing would follow here.
    shim.setGeometry(node, { scrollTop: 1000 });
    result.current.cancelOwnedFreeNavigation();
    expect(onFollowIntentChange).not.toHaveBeenCalled();

    fireNativeScroll(node);
    expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
  });

  it("beginOwnedFreeNavigation does not itself change follow intent", () => {
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
        isReattachSuppressed: undefined,
        isTurnRunning: undefined,
      }),
    );

    result.current.beginOwnedFreeNavigation();

    expect(onFollowIntentChange).not.toHaveBeenCalled();
  });

  describe("while reattachment is suppressed", () => {
    interface SuppressedLatch {
      readonly node: HTMLDivElement;
      readonly listRef: FakeListRef;
      readonly onFollowIntentChange: Mock<(isFollowing: boolean) => void>;
      readonly latch: () => ChatTimelineFollowLatch;
      readonly setSuppressed: (suppressed: boolean) => void;
    }

    /** Mounts a following latch at the strict bottom whose reattachment
     *  suppression the test flips; `isCorrectionSuppressed` stays off. */
    function mountSuppressibleLatch(): SuppressedLatch {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(isFollowing: boolean) => void>();
      let suppressed = false;
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          onFollowIntentChange,
          onReaderGesture: undefined,
          isCorrectionSuppressed: undefined,
          resolveSuppressedEndLanding: undefined,
          isReattachSuppressed: () => suppressed,
          isTurnRunning: undefined,
        }),
      );
      return {
        node,
        listRef,
        onFollowIntentChange,
        latch: () => result.current,
        setSuppressed: (next) => {
          suppressed = next;
        },
      };
    }

    /** The reader wheels away from the tail, then the transcript starts
     *  recovering underneath them. */
    function detachThenSuppress(mounted: SuppressedLatch): void {
      mounted.node.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      shim.setGeometry(mounted.node, { scrollTop: 200 });
      fireNativeScroll(mounted.node);
      expect(mounted.onFollowIntentChange).toHaveBeenLastCalledWith(false);
      mounted.onFollowIntentChange.mockClear();
      mounted.setSuppressed(true);
    }

    /** A recovering commit shrinks the content and the browser clamps the
     *  reader's offset to the new end. */
    function clampToStrictBottom(node: HTMLDivElement): void {
      shim.setGeometry(node, { scrollTop: 300, scrollHeight: 800 });
    }

    it("leaves a detached reader detached at a clamped native strict-bottom report, through the growth after it", () => {
      const mounted = mountSuppressibleLatch();
      detachThenSuppress(mounted);

      clampToStrictBottom(mounted.node);
      fireNativeScroll(mounted.node);

      // The recovery grows the transcript back away from the reader.
      shim.setGeometry(mounted.node, { scrollHeight: 1500 });
      fireNativeScroll(mounted.node);
      shim.setGeometry(mounted.node, { scrollHeight: 1700 });
      mounted.latch().followEndIfPermitted();
      fireResizeObservers();
      for (let i = 0; i < 12; i++) flushAnimationFrame();

      expect(mounted.onFollowIntentChange).not.toHaveBeenCalled();
      expect(mounted.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("leaves a detached reader detached when maintenance finds the clamped strict bottom", () => {
      const mounted = mountSuppressibleLatch();
      detachThenSuppress(mounted);

      clampToStrictBottom(mounted.node);
      mounted.latch().followEndIfPermitted();
      fireResizeObservers();

      expect(mounted.onFollowIntentChange).not.toHaveBeenCalled();
      expect(mounted.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("follows a finger that reaches the tail", () => {
      const mounted = mountSuppressibleLatch();
      detachThenSuppress(mounted);

      fireTouch(mounted.node, "touchstart", 300);
      shim.setGeometry(mounted.node, { scrollTop: 1000 });
      fireNativeScroll(mounted.node);

      expect(mounted.onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("follows an explicit go-live", () => {
      const mounted = mountSuppressibleLatch();
      detachThenSuppress(mounted);

      mounted.latch().beginOwnedEndNavigation();
      shim.setGeometry(mounted.node, { scrollTop: 1000 });
      fireNativeScroll(mounted.node);
      mounted
        .latch()
        .completeOwnedEndNavigation(mounted.latch().isAtStrictEnd());

      expect(mounted.onFollowIntentChange).toHaveBeenCalledTimes(1);
      expect(mounted.onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("re-grants once when it lifts with the reader settled at the strict bottom", () => {
      const mounted = mountSuppressibleLatch();
      detachThenSuppress(mounted);
      clampToStrictBottom(mounted.node);
      fireNativeScroll(mounted.node);

      mounted.setSuppressed(false);
      mounted.latch().followEndIfPermitted();

      expect(mounted.onFollowIntentChange).toHaveBeenCalledTimes(1);
      expect(mounted.onFollowIntentChange).toHaveBeenLastCalledWith(true);
      expect(mounted.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("stays detached when it lifts with the reader settled away from the end", () => {
      const mounted = mountSuppressibleLatch();
      detachThenSuppress(mounted);
      clampToStrictBottom(mounted.node);
      fireNativeScroll(mounted.node);
      shim.setGeometry(mounted.node, { scrollHeight: 1500 });

      mounted.setSuppressed(false);
      mounted.latch().followEndIfPermitted();

      expect(mounted.onFollowIntentChange).not.toHaveBeenCalled();
      expect(mounted.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("keeps a following reader following and correcting", () => {
      const mounted = mountSuppressibleLatch();
      mounted.setSuppressed(true);

      fireNativeScroll(mounted.node);
      shim.setGeometry(mounted.node, { scrollHeight: 1700 });
      mounted.latch().followEndIfPermitted();

      expect(mounted.listRef.scrollToEnd).toHaveBeenCalledTimes(1);
      expect(mounted.onFollowIntentChange).not.toHaveBeenCalled();
    });
  });

  describe("a scroll report that nothing announced", () => {
    const AWAY_FROM_END_PUBLISHED = {
      direction: "away-from-end",
      freezeInFlightScroll: true,
      publishesReaderPosition: true,
    } as const;

    // Following at the strict bottom with one report seen, so the latch knows
    // where the view should be.
    function followingWithLiveLedger() {
      const node = shim.makeNode({
        scrollTop: 1000,
        scrollHeight: 1500,
        clientHeight: 500,
      });
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      const onReaderGesture = vi.fn();
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, true, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          onReaderGesture,
        }),
      );
      fireNativeScroll(node);
      return { node, listRef, onFollowIntentChange, onReaderGesture, result };
    }

    function expectDeparted(mounted: {
      readonly onFollowIntentChange: Mock<(follow: boolean) => void>;
      readonly onReaderGesture: Mock;
    }): void {
      expect(mounted.onReaderGesture).toHaveBeenCalledTimes(1);
      expect(mounted.onReaderGesture).toHaveBeenCalledWith(
        AWAY_FROM_END_PUBLISHED,
      );
      expect(mounted.onFollowIntentChange).toHaveBeenLastCalledWith(false);
    }

    function expectNotDeparted(mounted: {
      readonly onFollowIntentChange: Mock<(follow: boolean) => void>;
      readonly onReaderGesture: Mock;
    }): void {
      expect(mounted.onReaderGesture).not.toHaveBeenCalled();
      expect(mounted.onFollowIntentChange).not.toHaveBeenCalledWith(false);
    }

    it("is the reader's silent pan: it publishes the departure", () => {
      const mounted = followingWithLiveLedger();

      shim.setGeometry(mounted.node, { scrollTop: 970 });
      fireNativeScroll(mounted.node);

      expectDeparted(mounted);
      expect(mounted.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("is not the reader's when the list announced the write it reports", () => {
      const mounted = followingWithLiveLedger();

      moveChatTimelineScroller(mounted.node, 900, () =>
        shim.setGeometry(mounted.node, { scrollTop: 900 }),
      );
      fireNativeScroll(mounted.node);

      expectNotDeparted(mounted);
    });

    it("is the reader's when it lands beyond what the list announced", () => {
      const mounted = followingWithLiveLedger();

      moveChatTimelineScroller(mounted.node, 900, () =>
        shim.setGeometry(mounted.node, { scrollTop: 900 }),
      );
      shim.setGeometry(mounted.node, { scrollTop: 870 });
      fireNativeScroll(mounted.node);

      expectDeparted(mounted);
    });

    it("is not the reader's when the browser clamped the view onto a lower end that an observation saw", () => {
      const mounted = followingWithLiveLedger();

      shim.setGeometry(mounted.node, { scrollHeight: 1460, scrollTop: 960 });
      mounted.result.current.followEndIfPermitted();
      // The end grows again before any report: the view is short of it.
      shim.setGeometry(mounted.node, { scrollHeight: 1520 });
      fireNativeScroll(mounted.node);

      expectNotDeparted(mounted);
    });

    it("is not the reader's when the browser clamped the view onto a lower end that only an announced write's start saw", () => {
      const mounted = followingWithLiveLedger();

      // The end dropped 9 and the browser clamped the view onto it; nothing
      // observed that.
      shim.setGeometry(mounted.node, { scrollHeight: 1491, scrollTop: 991 });
      moveChatTimelineScroller(mounted.node, 982, () =>
        shim.setGeometry(mounted.node, { scrollTop: 982 }),
      );
      fireNativeScroll(mounted.node);

      expectNotDeparted(mounted);
    });

    it("counts the latch's own correction write, so a pan after it departs unannounced", () => {
      const mounted = followingWithLiveLedger();

      shim.setGeometry(mounted.node, { scrollHeight: 1700 });
      mounted.result.current.followEndIfPermitted();
      expect(mounted.node.scrollTop).toBe(1200);

      shim.setGeometry(mounted.node, { scrollTop: 1150 });
      fireNativeScroll(mounted.node);

      expectDeparted(mounted);
    });

    it("does not depart a reader whose owned free navigation still owns the view", () => {
      const mounted = followingWithLiveLedger();
      shim.setGeometry(mounted.node, { scrollTop: 970 });
      fireNativeScroll(mounted.node);
      mounted.onReaderGesture.mockClear();
      mounted.result.current.beginOwnedFreeNavigation();
      // Follow resumes, which releases the navigation's arm; the navigation
      // is not over.
      mounted.result.current.completeOwnedEndNavigation(true);

      shim.setGeometry(mounted.node, { scrollTop: 940 });
      fireNativeScroll(mounted.node);

      expect(mounted.onReaderGesture).not.toHaveBeenCalled();
    });

    it("is not the reader's when an elastic overscroll sprang back after the content grew", () => {
      const mounted = followingWithLiveLedger();

      // iOS reports the rubber band past the end (max 1000).
      shim.setGeometry(mounted.node, { scrollTop: 1030 });
      fireNativeScroll(mounted.node);
      // Streaming grows the content before the spring-back report: 1000 is no
      // longer the strict bottom.
      shim.setGeometry(mounted.node, { scrollHeight: 1600 });
      shim.setGeometry(mounted.node, { scrollTop: 1000 });
      fireNativeScroll(mounted.node);

      expectNotDeparted(mounted);
    });

    it("is not the reader's when an observation saw the overscroll and the spring-back followed the growth", () => {
      const mounted = followingWithLiveLedger();

      shim.setGeometry(mounted.node, { scrollTop: 1030 });
      mounted.result.current.followEndIfPermitted();
      shim.setGeometry(mounted.node, { scrollHeight: 1600 });
      shim.setGeometry(mounted.node, { scrollTop: 1000 });
      fireNativeScroll(mounted.node);

      expectNotDeparted(mounted);
    });

    it("is not the reader's when the view bounced past the top of content that fits it", () => {
      const mounted = followingWithLiveLedger();

      // The content fits the view: the strict bottom is also the top.
      shim.setGeometry(mounted.node, {
        scrollHeight: 500,
        scrollTop: 0,
      });
      fireNativeScroll(mounted.node);
      shim.setGeometry(mounted.node, { scrollTop: -30 });
      fireNativeScroll(mounted.node);

      expectNotDeparted(mounted);
    });

    // A drag toward the end announces itself (`touchmove`), which retires the
    // ledger until a report; the contact may lift before any report comes.
    function followingThroughAnAnnouncedDragThenLift() {
      const mounted = followingWithLiveLedger();
      fireTouch(mounted.node, "touchstart", 400);
      fireTouch(mounted.node, "touchmove", 380);
      fireTouch(mounted.node, "touchend", 380);
      mounted.onReaderGesture.mockClear();
      mounted.onFollowIntentChange.mockClear();
      return mounted;
    }

    it("is not the reader's when a contact lifted at the strict bottom moved nothing, and the end then grows", () => {
      const mounted = followingWithLiveLedger();

      fireTouch(mounted.node, "touchstart", 300);
      fireTouch(mounted.node, "touchend", 300);
      mounted.result.current.followEndIfPermitted();
      fireNativeScroll(mounted.node);
      shim.setGeometry(mounted.node, { scrollHeight: 1540 });
      mounted.result.current.followEndIfPermitted();

      expectNotDeparted(mounted);
      expect(mounted.node.scrollTop).toBe(1040);
    });

    it("departs a pan that follows the lift of a contact that produced no report", () => {
      const mounted = followingThroughAnAnnouncedDragThenLift();

      // No touch or pointer event: the view just moves away from the end.
      shim.setGeometry(mounted.node, { scrollTop: 970 });
      fireNativeScroll(mounted.node);

      expectDeparted(mounted);
      expect(mounted.listRef.scrollToEnd).not.toHaveBeenCalled();
    });

    it("keeps following when the lifted contact's momentum reports move toward the end", () => {
      const mounted = followingThroughAnAnnouncedDragThenLift();

      // The content grows after the lift, so the end is 200 below the view and
      // momentum carries it toward that end, short of the strict bottom.
      shim.setGeometry(mounted.node, { scrollHeight: 1700 });
      shim.setGeometry(mounted.node, { scrollTop: 1100 });
      fireNativeScroll(mounted.node);

      expectNotDeparted(mounted);
    });

    it("publishes a detached reader's further pan once, not again", () => {
      const mounted = followingWithLiveLedger();
      shim.setGeometry(mounted.node, { scrollTop: 970 });
      fireNativeScroll(mounted.node);
      shim.setGeometry(mounted.node, { scrollTop: 900 });
      fireNativeScroll(mounted.node);

      expectDeparted(mounted);
    });
  });

  describe("a free reader's gesture away from the end, once its scroll lands", () => {
    // Mounting free at the strict bottom (the W4 state) must not let the
    // layout effect's own mount-time `followEndIfPermitted` reconcile it back
    // to following before the gesture ever arms: hold reattachment off
    // through the mount, as a restored reading position would, then settle.
    function freeReader(
      geometry: ControllableGeometry,
      isTurnRunning: (() => boolean) | undefined,
    ) {
      const node = shim.makeNode(geometry);
      const listRef = makeFakeListRef(node);
      const onFollowIntentChange = vi.fn<(follow: boolean) => void>();
      let restoreHolds = true;
      const { result } = renderHook(() =>
        useChatTimelineFollowLatch(listRef, false, true, {
          ...DEFAULT_FOLLOW_LATCH_OPTIONS,
          onFollowIntentChange,
          isTurnRunning,
          isReattachSuppressed: () => restoreHolds,
        }),
      );
      restoreHolds = false;
      return { node, listRef, onFollowIntentChange, result };
    }

    it("carries the wheel's armed start through an announced write, so its own landing still releases it", () => {
      const { node, onFollowIntentChange, result } = freeReader(
        { scrollTop: 1000, scrollHeight: 1500, clientHeight: 500 },
        undefined,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));

      // The list inserts 400px above the reader and compensates, announcing
      // the write as it lands.
      shim.setGeometry(node, { scrollHeight: 1900 });
      moveChatTimelineScroller(node, 1400, () => {
        shim.setGeometry(node, { scrollTop: 1400 });
      });
      fireNativeScroll(node);

      // The wheel's own scroll now lands, 40 above where the list left them.
      shim.setGeometry(node, { scrollTop: 1360 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      // They reach the end with no input event of their own.
      shim.setGeometry(node, { scrollTop: 1400 });
      fireNativeScroll(node);
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("records a free landing's departure, so a mid-turn pad clamp holds them instead of following early", () => {
      let turnRunning = true;
      const { node, onFollowIntentChange, result } = freeReader(
        { scrollTop: 900, scrollHeight: 1500, clientHeight: 500 },
        () => turnRunning,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));

      // The wheel's own scroll lands, clearly away from the end.
      shim.setGeometry(node, { scrollTop: 860 });
      fireNativeScroll(node);

      // The end comes up to meet them: an end pad releasing, no farther than
      // where they landed.
      shim.setGeometry(node, { scrollHeight: 1360 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      // A later frame of the same wheel lands farther up, the pad still
      // releasing in step with it.
      shim.setGeometry(node, { scrollTop: 820, scrollHeight: 1320 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      turnRunning = false;
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    // Their wheel's next frame lands farther up: the departure moves there,
    // so the end coming to them mid-turn still holds them.
    it("a free reader's wheel whose next frame lands farther up stays held when the end comes to them mid-turn, and follows at rest", () => {
      let turnRunning = true;
      const { node, listRef, onFollowIntentChange, result } = freeReader(
        { scrollTop: 900, scrollHeight: 1500, clientHeight: 500 },
        () => turnRunning,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
      shim.setGeometry(node, { scrollTop: 860 });
      fireNativeScroll(node);
      shim.setGeometry(node, { scrollTop: 820 });
      fireNativeScroll(node);

      shim.setGeometry(node, { scrollHeight: 1320 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      shim.setGeometry(node, { scrollHeight: 1360 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);
      expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      expect(node.scrollTop).toBe(820);

      shim.setGeometry(node, { scrollHeight: 1320 });
      turnRunning = false;
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    // The landing's report is the departure, not ahead of it: no report of
    // theirs is owed, so the end meeting them at rest follows them.
    it("guard: with no turn running, the end meeting a free reader where their wheel landed follows them", () => {
      const { node, onFollowIntentChange, result } = freeReader(
        { scrollTop: 900, scrollHeight: 1500, clientHeight: 500 },
        () => false,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollTop: 860 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      shim.setGeometry(node, { scrollHeight: 1360 });
      result.current.followEndIfPermitted();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("spends an awaiting arm at the turn's rest once a report has followed it", () => {
      const { node, onFollowIntentChange, result } = freeReader(
        { scrollTop: 1000, scrollHeight: 1500, clientHeight: 500 },
        undefined,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));

      // The wheel's only report reads the strict bottom: its landing and an
      // end-pad release in the same step.
      shim.setGeometry(node, { scrollTop: 960, scrollHeight: 1460 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("leaves an arm with no report to follow held at the turn's rest, and nothing then corrects its departure", () => {
      const { node, onFollowIntentChange, result } = freeReader(
        { scrollTop: 1000, scrollHeight: 1500, clientHeight: 500 },
        undefined,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));

      // No report of the wheel's scroll has arrived yet.
      result.current.reconcileTurnAtRest();
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      // The wheel's own scroll lands and departs them; nothing corrects it.
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);
    });

    it("does not release an overscrolled wheel's arm on its spring-back to the clamped end", () => {
      const { node, onFollowIntentChange } = freeReader(
        { scrollTop: 1010, scrollHeight: 1500, clientHeight: 500 },
        undefined,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));

      // The browser springs the elastic overscroll back to the real,
      // unpadded end.
      shim.setGeometry(node, { scrollTop: 1000 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);
    });

    it("row 23: a wheel up reported away from the end, then a silent arrival follows", () => {
      const { node, onFollowIntentChange, result } = freeReader(
        { scrollTop: 1000, scrollHeight: 1500, clientHeight: 500 },
        undefined,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      shim.setGeometry(node, { scrollTop: 1000 });
      fireNativeScroll(node);
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    it("lands off the end though the arm's distance is stale from a pad drop while it waited", () => {
      const { node, onFollowIntentChange, result } = freeReader(
        { scrollTop: 1000, scrollHeight: 1600, clientHeight: 500 },
        undefined,
      );

      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));

      // The pad drops: the view is now on the end, though it has not moved.
      shim.setGeometry(node, { scrollHeight: 1500 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      // The wheel's own scroll lands off the end - 40 from it, less than the
      // 100 the arm recorded at the gesture, but still above its offset.
      shim.setGeometry(node, { scrollTop: 960 });
      fireNativeScroll(node);
      expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);

      // They reach the end with no input event of their own.
      shim.setGeometry(node, { scrollTop: 1000 });
      fireNativeScroll(node);
      result.current.followEndIfPermitted();

      expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);
    });

    describe("a clamp the end regrew over before its report retires the arm early, yet the wheel's delayed scroll still departs them and nothing corrects it", () => {
      // The browser's own clamp (scrollHeight 1500 -> 1400, scrollTop
      // clamped to 900) queues a scroll report; the end grows back to 1500
      // before that report is delivered, so it reads 900 OFF the end. No
      // observation can tell that from the wheel's own landing, and
      // `noteFreeReportAway` retires the arm on it. The retirement is still
      // harmless: this same report restarts `noteReportMovement`'s ledger
      // and records the reader's departure at 900.
      function armedThenClampedAndRegrown(isTurnRunning: () => boolean) {
        const { node, listRef, onFollowIntentChange, result } = freeReader(
          { scrollTop: 1000, scrollHeight: 1500, clientHeight: 500 },
          isTurnRunning,
        );

        node.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));

        shim.setGeometry(node, { scrollHeight: 1400, scrollTop: 900 });
        shim.setGeometry(node, { scrollHeight: 1500 });
        fireNativeScroll(node);

        return { node, listRef, onFollowIntentChange, result };
      }

      it("mid-turn: stays free through the end catching up to the clamp, and the wheel's delayed landing after it", () => {
        const turnRunning = true;
        const { node, listRef, onFollowIntentChange } =
          armedThenClampedAndRegrown(() => turnRunning);

        // The end comes to them: a strict-bottom report at 900.
        shim.setGeometry(node, { scrollHeight: 1400 });
        fireNativeScroll(node);
        expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);
        expect(listRef.scrollToEnd).not.toHaveBeenCalled();

        // The wheel's delayed scroll lands.
        shim.setGeometry(node, { scrollTop: 860 });
        fireNativeScroll(node);
        expect(onFollowIntentChange).not.toHaveBeenCalledWith(true);
        expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      });

      it("at rest: follows the clamp's own strict bottom, then departs again on the wheel's delayed landing with nothing correcting it", () => {
        const { node, listRef, onFollowIntentChange } =
          armedThenClampedAndRegrown(() => false);

        // A strict-bottom report where the clamp itself moved scrollTop.
        shim.setGeometry(node, { scrollHeight: 1390, scrollTop: 890 });
        fireNativeScroll(node);
        expect(onFollowIntentChange).toHaveBeenLastCalledWith(true);

        // The wheel's delayed scroll lands.
        shim.setGeometry(node, { scrollTop: 850 });
        fireNativeScroll(node);
        expect(onFollowIntentChange).toHaveBeenLastCalledWith(false);
        expect(listRef.scrollToEnd).not.toHaveBeenCalled();
      });
    });
  });
});
