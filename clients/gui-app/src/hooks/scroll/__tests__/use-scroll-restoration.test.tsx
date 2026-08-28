import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollRestoration } from "@/hooks/scroll/use-scroll-restoration";
import type {
  ApplyAnchorResult,
  ScrollRestorationAdapter,
  TileScrollAnchor,
} from "@/hooks/scroll/scroll-restoration-adapter";
import {
  activateReadingPositionAccount,
  flushPendingReadingPositionWrites,
  readReadingPosition,
  resetReadingPositionServiceForTests,
  saveReadingPosition,
  type ReadingPositionIdentity,
} from "@/lib/reading-position";
import { isTileScrollAnchor } from "@/hooks/scroll/scroll-anchor-types";

const liveness = vi.hoisted(() => ({ live: true }));

vi.mock("@/stores/epics/canvas/tile-instance-liveness", () => ({
  isEpicCanvasTileInstanceLive: () => liveness.live,
}));

const ANCHOR: TileScrollAnchor = {
  kind: "native",
  scrollTop: 120,
  scrollLeft: 0,
  scrollHeight: 1000,
  scrollWidth: 500,
};

function identity(viewKey: string): ReadingPositionIdentity {
  return {
    viewKey,
    contentKey: null,
    deletionKey: null,
    epicId: null,
    hostId: null,
    durability: "renderer-live",
  };
}

function durableIdentity(viewKey: string): ReadingPositionIdentity {
  return {
    viewKey,
    contentKey: `artifact:${viewKey}`,
    deletionKey: `artifact:${viewKey}`,
    epicId: "epic-1",
    hostId: "host-1",
    durability: "durable",
  };
}

function seed(viewKey: string): void {
  saveReadingPosition(identity(viewKey), "native", ANCHOR);
}

function read(viewKey: string): TileScrollAnchor | null {
  return readReadingPosition(identity(viewKey), "native", isTileScrollAnchor);
}

interface MockAdapter {
  readonly adapter: ScrollRestorationAdapter;
  readonly applied: TileScrollAnchor[];
  captureCalls: number;
  queueApplyResults: (...results: ApplyAnchorResult[]) => void;
  setCaptureValue: (value: TileScrollAnchor | null) => void;
}

function makeMockAdapter(): MockAdapter {
  let captureValue: TileScrollAnchor | null = ANCHOR;
  const applyResults: ApplyAnchorResult[] = [];
  const state: MockAdapter = {
    applied: [],
    captureCalls: 0,
    queueApplyResults: (...results) => applyResults.push(...results),
    setCaptureValue: (value) => {
      captureValue = value;
    },
    adapter: {
      surfaceKind: "native",
      captureAnchor: () => {
        state.captureCalls += 1;
        return captureValue;
      },
      applyAnchor: (anchor) => {
        state.applied.push(anchor);
        return applyResults.shift() ?? "applied";
      },
    },
  };
  return state;
}

interface QueuedRaf {
  readonly id: number;
  readonly callback: FrameRequestCallback;
}

let rafQueue: QueuedRaf[] = [];
let canceledRafIds = new Set<number>();
let nextRafId = 1;

function flushRaf(): void {
  const pending = rafQueue;
  rafQueue = [];
  pending
    .filter((raf) => !canceledRafIds.has(raf.id))
    .forEach((raf) => raf.callback(0));
}

describe("useScrollRestoration", () => {
  beforeEach(() => {
    resetReadingPositionServiceForTests();
    window.localStorage.clear();
    liveness.live = true;
    rafQueue = [];
    canceledRafIds = new Set<number>();
    nextRafId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextRafId;
      nextRafId += 1;
      rafQueue.push({ id, callback: cb });
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      canceledRafIds.add(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("commits the anchor when the tile becomes hidden", () => {
    const mock = makeMockAdapter();
    const { rerender } = renderHook(
      ({ visible }) => useScrollRestoration("t1", mock.adapter, visible, true),
      { initialProps: { visible: true } },
    );

    rerender({ visible: false });

    expect(read("t1")).toEqual(ANCHOR);
  });

  it("restores when a hidden tile becomes visible", () => {
    seed("t1");
    const mock = makeMockAdapter();
    const { rerender } = renderHook(
      ({ visible }) => useScrollRestoration("t1", mock.adapter, visible, true),
      { initialProps: { visible: false } },
    );
    expect(mock.applied).toHaveLength(0);

    rerender({ visible: true });

    expect(mock.applied).toEqual([ANCHOR]);
  });

  it("restores on first mount when already visible (remount path)", () => {
    seed("t1");
    const mock = makeMockAdapter();

    renderHook(() => useScrollRestoration("t1", mock.adapter, true, true));

    expect(mock.applied).toEqual([ANCHOR]);
  });

  it("does not restore until content is ready, then restores on the transition", () => {
    seed("t1");
    const mock = makeMockAdapter();
    const { rerender } = renderHook(
      ({ contentReady }) =>
        useScrollRestoration("t1", mock.adapter, true, contentReady),
      { initialProps: { contentReady: false } },
    );
    expect(mock.applied).toHaveLength(0);

    rerender({ contentReady: true });

    expect(mock.applied).toEqual([ANCHOR]);
  });

  it("commits the anchor on unmount", () => {
    const mock = makeMockAdapter();
    const { unmount } = renderHook(() =>
      useScrollRestoration("t2", mock.adapter, true, true),
    );

    unmount();

    expect(read("t2")).toEqual(ANCHOR);
  });

  it("neither commits nor clears on unmount when the tile was already removed", () => {
    liveness.live = false;
    seed("t2");
    const mock = makeMockAdapter();
    const { unmount } = renderHook(() =>
      useScrollRestoration("t2", mock.adapter, true, true),
    );

    unmount();

    // The store's anchor sweep owns clearing on a permanent close; the hook
    // must not re-commit a dead tile (would resurrect a swept anchor) and must
    // not clear (would duplicate the sweep). So the pre-set anchor is left
    // untouched here, and capture is never called.
    expect(mock.captureCalls).toBe(0);
    expect(read("t2")).toEqual(ANCHOR);
  });

  it("retries restoration on later frames while the adapter reports retry", () => {
    seed("t3");
    const mock = makeMockAdapter();
    mock.queueApplyResults("retry", "retry", "applied");

    renderHook(() => useScrollRestoration("t3", mock.adapter, true, true));
    expect(mock.applied).toEqual([ANCHOR]); // first attempt: retry

    flushRaf(); // second attempt: retry
    flushRaf(); // third attempt: applied
    expect(mock.applied).toEqual([ANCHOR, ANCHOR, ANCHOR]);

    flushRaf(); // no further attempts once applied
    expect(mock.applied).toEqual([ANCHOR, ANCHOR, ANCHOR]);
  });

  it("keeps re-asserting on later frames while the adapter reports defend", () => {
    seed("t3");
    const mock = makeMockAdapter();
    mock.queueApplyResults("defend", "defend", "applied");

    renderHook(() => useScrollRestoration("t3", mock.adapter, true, true));
    expect(mock.applied).toEqual([ANCHOR]); // first attempt: defend

    flushRaf(); // second attempt: defend
    flushRaf(); // third attempt: applied
    expect(mock.applied).toEqual([ANCHOR, ANCHOR, ANCHOR]);

    flushRaf(); // stops once applied
    expect(mock.applied).toEqual([ANCHOR, ANCHOR, ANCHOR]);
  });

  it("lets callers cancel a retry loop when user input takes over", () => {
    seed("t3");
    const mock = makeMockAdapter();
    mock.queueApplyResults("retry", "retry", "applied");

    const { result } = renderHook(() =>
      useScrollRestoration("t3", mock.adapter, true, true),
    );
    expect(mock.applied).toEqual([ANCHOR]);

    result.current.cancelRetry();
    flushRaf();

    expect(mock.applied).toEqual([ANCHOR]);
  });

  it("does nothing to restore when no anchor was saved", () => {
    const mock = makeMockAdapter();

    renderHook(() => useScrollRestoration("fresh", mock.adapter, true, true));

    expect(mock.applied).toHaveLength(0);
  });

  it("performs one late cross-window reconciliation when the destination has not moved", () => {
    activateReadingPositionAccount("account-1");
    const target = durableIdentity("late-view");
    const mock = makeMockAdapter();
    mock.setCaptureValue(null);
    renderHook(() => useScrollRestoration(target, mock.adapter, true, true));

    saveReadingPosition(target, "native", ANCHOR);
    flushPendingReadingPositionWrites();
    const exactKey = Object.keys(window.localStorage).find((key) =>
      key.includes(encodeURIComponent(target.viewKey)),
    );
    expect(exactKey).toBeDefined();
    if (exactKey === undefined) throw new Error("Expected exact-view key");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: exactKey,
        newValue: window.localStorage.getItem(exactKey),
        storageArea: window.localStorage,
      }),
    );

    expect(mock.applied).toEqual([ANCHOR]);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: exactKey,
        newValue: window.localStorage.getItem(exactKey),
        storageArea: window.localStorage,
      }),
    );
    expect(mock.applied).toEqual([ANCHOR]);
  });

  it("lets destination interaction win over a late source storage event", () => {
    activateReadingPositionAccount("account-1");
    const target = durableIdentity("locally-moved-view");
    const mock = makeMockAdapter();
    renderHook(() => useScrollRestoration(target, mock.adapter, true, true));

    saveReadingPosition(target, "native", ANCHOR);
    flushPendingReadingPositionWrites();
    const exactKey = Object.keys(window.localStorage).find((key) =>
      key.includes(encodeURIComponent(target.viewKey)),
    );
    expect(exactKey).toBeDefined();
    if (exactKey === undefined) throw new Error("Expected exact-view key");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: exactKey,
        newValue: window.localStorage.getItem(exactKey),
        storageArea: window.localStorage,
      }),
    );

    expect(mock.applied).toHaveLength(0);
  });
});
