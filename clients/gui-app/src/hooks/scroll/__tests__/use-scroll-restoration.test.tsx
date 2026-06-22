import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollRestoration } from "@/hooks/scroll/use-scroll-restoration";
import type {
  ApplyAnchorResult,
  ScrollRestorationAdapter,
  TileScrollAnchor,
} from "@/hooks/scroll/scroll-restoration-adapter";
import { useTileScrollAnchorStore } from "@/stores/epics/canvas/tile-scroll-anchor-store";

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
    useTileScrollAnchorStore.setState({ anchors: {} });
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

    expect(useTileScrollAnchorStore.getState().getAnchor("t1")).toEqual(ANCHOR);
  });

  it("restores when a hidden tile becomes visible", () => {
    useTileScrollAnchorStore.getState().setAnchor("t1", ANCHOR);
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
    useTileScrollAnchorStore.getState().setAnchor("t1", ANCHOR);
    const mock = makeMockAdapter();

    renderHook(() => useScrollRestoration("t1", mock.adapter, true, true));

    expect(mock.applied).toEqual([ANCHOR]);
  });

  it("does not restore until content is ready, then restores on the transition", () => {
    useTileScrollAnchorStore.getState().setAnchor("t1", ANCHOR);
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

    expect(useTileScrollAnchorStore.getState().getAnchor("t2")).toEqual(ANCHOR);
  });

  it("neither commits nor clears on unmount when the tile was already removed", () => {
    liveness.live = false;
    useTileScrollAnchorStore.getState().setAnchor("t2", ANCHOR);
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
    expect(useTileScrollAnchorStore.getState().getAnchor("t2")).toEqual(ANCHOR);
  });

  it("retries restoration on later frames while the adapter reports retry", () => {
    useTileScrollAnchorStore.getState().setAnchor("t3", ANCHOR);
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
    useTileScrollAnchorStore.getState().setAnchor("t3", ANCHOR);
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
    useTileScrollAnchorStore.getState().setAnchor("t3", ANCHOR);
    const mock = makeMockAdapter();
    mock.queueApplyResults("retry", "retry", "applied");

    const { result } = renderHook(() =>
      useScrollRestoration("t3", mock.adapter, true, true),
    );
    expect(mock.applied).toEqual([ANCHOR]);

    result.current();
    flushRaf();

    expect(mock.applied).toEqual([ANCHOR]);
  });

  it("does nothing to restore when no anchor was saved", () => {
    const mock = makeMockAdapter();

    renderHook(() => useScrollRestoration("fresh", mock.adapter, true, true));

    expect(mock.applied).toHaveLength(0);
  });
});
