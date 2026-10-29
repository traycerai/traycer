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
};

interface FakeListRef {
  readonly current: LegendListRef;
  /** Moves the list's last row, as rows above it remeasuring would. */
  readonly setLastRowTop: (top: number) => void;
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
function makeFakeListState(rowTops: ReadonlyMap<string, number>) {
  const keys = [...rowTops.keys()];
  const state: LegendListState = {
    activeStickyIndex: -1,
    contentLength: 0,
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
    getState: () => makeFakeListState(rowTops),
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
   *  flings toward it. The fling's frames are bare scroll reports. */
  function flingTowardEnd(): {
    readonly node: HTMLDivElement;
    readonly listRef: FakeListRef;
    readonly result: { readonly current: ChatTimelineFollowLatch };
    readonly onFollowIntentChange: Mock<(isFollowing: boolean) => void>;
  } {
    const node = shim.makeNode({
      scrollTop: 1000,
      scrollHeight: 1500,
      clientHeight: 500,
    });
    const listRef = makeFakeListRef(node);
    const onFollowIntentChange = vi.fn<(isFollowing: boolean) => void>();
    const { result } = renderHook(() =>
      useChatTimelineFollowLatch(listRef, true, true, {
        ...DEFAULT_FOLLOW_LATCH_OPTIONS,
        onFollowIntentChange,
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
        isReattachSuppressed: undefined,
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

    it("corrects the same scroll back to the tail when no gesture was relayed", () => {
      const { scrollToEnd } = scrollAwayFromTail(null);
      expect(scrollToEnd).toHaveBeenCalled();
    });

    it("ignores a gesture event whose detail is not a direction", () => {
      const { scrollToEnd } = scrollAwayFromTail("sideways");
      expect(scrollToEnd).toHaveBeenCalled();
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
    // report. That is the list's clamp, not the reader returning: taken as
    // that, the wheel's own report a moment later read as layout and was
    // corrected back to the tail.
    it("stays detached when the end pad drops under them, so the wheel's own report is not corrected", () => {
      const { node, listRef, onFollowIntentChange, result } =
        departedAtPaddedEnd();

      shim.setGeometry(node, { scrollHeight: 1500 });
      result.current.followEndIfPermitted();
      flushAnimationFrame();
      shim.setGeometry(node, { scrollTop: 700 });
      fireNativeScroll(node);

      expect(onFollowIntentChange).toHaveBeenCalledTimes(1);
      expect(listRef.scrollToEnd).toHaveBeenCalledTimes(1);
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
        isReattachSuppressed: undefined,
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
});
