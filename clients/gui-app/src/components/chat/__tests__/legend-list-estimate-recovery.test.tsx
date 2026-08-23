import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import {
  LegendList,
  type LegendListRef,
  type MaintainVisibleContentPositionConfig,
} from "@legendapp/list/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceLegendListFrames,
  advanceLegendListTime,
  installLegendListTestClock,
  installLegendListViewportMetrics,
  restoreLegendListTestClock,
  settleLegendList,
} from "./legend-list-test-environment";

class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    controllableResizeObservers.push(this);
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

let controllableResizeObservers: ControllableResizeObserver[] = [];

function fireAllResizeObservers(): void {
  for (const observer of controllableResizeObservers) {
    const entries = [...observer.observed].map((target) => {
      const contentRect = target.getBoundingClientRect();
      return {
        target,
        contentRect,
        borderBoxSize: [
          { inlineSize: contentRect.width, blockSize: contentRect.height },
        ],
        contentBoxSize: [
          { inlineSize: contentRect.width, blockSize: contentRect.height },
        ],
        devicePixelContentBoxSize: [
          { inlineSize: contentRect.width, blockSize: contentRect.height },
        ],
      };
    });
    observer.callback(entries, observer);
  }
}

type Row = {
  readonly id: string;
};

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: `row-${index}` }));
}

function createTestList(
  data: readonly Row[],
  listRef: React.RefObject<LegendListRef | null>,
) {
  return (
    <LegendList
      ref={listRef}
      data={data}
      estimatedItemSize={90}
      getItemType={() => "assistant"}
      keyExtractor={(item) => item.id}
      recycleItems={false}
      renderItem={({ item }) => <div data-index={item.id}>{item.id}</div>}
    />
  );
}

/** `ChatTimeline`'s own maintain configuration, on a bare list. The transcript
 *  never passes the library's `maintainScrollAtEnd` (it owns bottom-follow
 *  itself), so the only maintain behavior under test is MVCP. */
function createTranscriptList(
  data: readonly Row[],
  listRef: React.RefObject<LegendListRef | null>,
  maintainVisibleContentPosition: MaintainVisibleContentPositionConfig<Row>,
) {
  return (
    <LegendList
      ref={listRef}
      data={data}
      estimatedItemSize={90}
      getItemType={() => "assistant"}
      keyExtractor={(item) => item.id}
      maintainScrollAtEndThreshold={0}
      maintainVisibleContentPosition={maintainVisibleContentPosition}
      recycleItems={false}
      renderItem={({ item }) => <div data-index={item.id}>{item.id}</div>}
    />
  );
}

/** Every row starts exactly where the previous one ends. A row whose offset
 *  was computed from a size a sibling has already invalidated paints on top of
 *  that sibling. */
function positionGapsAndSizes(list: LegendListRef): {
  readonly gaps: number[];
  readonly sizes: number[];
} {
  const state = list.getState();
  const gaps: number[] = [];
  const sizes: number[] = [];
  for (let index = 0; index < 11; index += 1) {
    gaps.push(state.positionAtIndex(index + 1) - state.positionAtIndex(index));
    sizes.push(state.sizeAtIndex(index));
  }
  return { gaps, sizes };
}

describe("LegendList estimate recovery", () => {
  beforeEach(() => {
    controllableResizeObservers = [];
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ControllableResizeObserver,
    });
    installLegendListViewportMetrics();
    installLegendListTestClock();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
  });

  it("refreshes never-measured cached estimates after the live item-type average converges", async () => {
    const listRef = createRef<LegendListRef | null>();
    const dataChangedEstimates: number[] = [];
    const { rerender } = render(createTestList(rows(50), listRef));
    act(() => {
      fireAllResizeObservers();
    });
    await settleLegendList();

    const list = listRef.current;
    if (list === null) throw new Error("LegendList ref did not mount");

    const captureDataChangedEstimate = (position: number): void => {
      dataChangedEstimates.push(position - list.getState().positionAtIndex(50));
    };

    // Thresholds are expressed against the settled measurement rather than
    // pixel constants, so the assertions describe the ratio the guard keys
    // on (a cached estimate more than 2x off the live average is stale) and
    // not the harness's row height.
    const measuredSize = list.getState().getAverageItemSizes()
      .assistant.average;
    const grosslyOff = measuredSize * 10;

    // An offscreen row reports a grossly oversized measurement - the shape a
    // hidden/collapsed pane produces. Nothing re-measures it while it stays
    // outside the render window, so the live type average keeps that value.
    act(() => {
      list.setItemSize("row-45", { height: measuredSize * 1_000, width: 800 });
    });
    const poisonedAverage = list.getState().getAverageItemSizes().assistant;
    expect(poisonedAverage.average).toBeGreaterThan(grosslyOff);

    // Rows appended while that average stands cache it as their estimate.
    // They are never measured, so nothing revisits them on its own.
    rerender(createTestList(rows(60), listRef));
    await settleLegendList();

    const poisonedEstimate =
      list.getState().positionAtIndex(51) - list.getState().positionAtIndex(50);
    expect(poisonedEstimate).toBeGreaterThan(grosslyOff);

    act(() => {
      list.setItemSize("row-45", { height: measuredSize, width: 800 });
    });
    const recoveredAverage = list.getState().getAverageItemSizes().assistant;
    expect(recoveredAverage.average).toBeLessThan(measuredSize * 2);

    const stopCapturing = list
      .getState()
      .listenToPosition("row-51", captureDataChangedEstimate);
    rerender(createTestList(rows(61), listRef));
    stopCapturing();

    expect(dataChangedEstimates).toHaveLength(1);
    expect(dataChangedEstimates[0]).toBeLessThan(measuredSize * 2);
  });

  it("rejects a zero-width vertical item measurement", async () => {
    const listRef = createRef<LegendListRef | null>();
    render(createTestList(rows(20), listRef));
    await settleLegendList();

    const list = listRef.current;
    if (list === null) throw new Error("LegendList ref did not mount");
    const sizeBefore = list.getState().sizes.get("row-10");
    const averageBefore = list.getState().getAverageItemSizes().assistant;

    act(() => {
      list.setItemSize("row-10", { height: 85_195, width: 0 });
    });

    expect(list.getState().sizes.get("row-10")).toBe(sizeBefore);
    expect(list.getState().getAverageItemSizes().assistant).toEqual(
      averageBefore,
    );
  });

  it("cancels consecutive imperative scrolls without rebinding the browser canceller", async () => {
    const listRef = createRef<LegendListRef | null>();
    render(createTestList(rows(20), listRef));
    await settleLegendList();

    const list = listRef.current;
    if (list === null) throw new Error("LegendList ref did not mount");

    const clearTimeout = globalThis.clearTimeout;
    const clearTimeoutSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(function receiverCheckedClearTimeout(
        this: unknown,
        handle: NodeJS.Timeout | string | number | undefined,
      ): void {
        if (this !== undefined && this !== globalThis) {
          throw new TypeError("Illegal invocation");
        }
        clearTimeout(handle);
      });

    try {
      void list.scrollToIndex({ animated: false, index: 18 });
      const replacementScroll = list.scrollToIndex({
        animated: false,
        index: 19,
      });
      const replacementSettled =
        expect(replacementScroll).resolves.toBeUndefined();
      await advanceLegendListTime(100);

      await replacementSettled;
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  /**
   * Every row has to start exactly where the previous one ends: a position
   * computed from a size that a sibling's later measurement has already
   * invalidated paints two rows on top of each other. This holds the
   * invariant when several rows remeasure in the same frame, the shape a
   * streaming transcript produces. It is a guard, not a reproduction - jsdom
   * applies these measurements deterministically, so it stays green on a
   * library build that overlaps rows in a real browser.
   */
  it("keeps row positions contiguous when several rows grow in one frame", async () => {
    const listRef = createRef<LegendListRef | null>();
    render(createTestList(rows(12), listRef));
    await settleLegendList();

    const list = listRef.current;
    if (list === null) throw new Error("LegendList ref did not mount");

    const measuredSize = list.getState().getAverageItemSizes()
      .assistant.average;
    act(() => {
      for (const index of [2, 3, 4]) {
        list.setItemSize(`row-${index}`, {
          height: measuredSize * 3,
          width: 800,
        });
      }
    });

    const { gaps, sizes } = positionGapsAndSizes(list);
    expect(gaps).toEqual(sizes);
  });

  /**
   * A streaming reply hands the list a structurally-changed array on every
   * token while the row it is appending to keeps growing. Both halves land in
   * the same commit, so the offsets of the rows after the growing one have to
   * be rewritten before the browser paints - the browser has already laid that
   * row out at its new height, and any row still carrying its previous offset
   * paints inside the grown row's band.
   *
   * The two cases below are the same sequence under the two MVCP
   * configurations. They pin the channel the transcript selects for a
   * same-key token and, in the second case, hold the reproduction that made
   * it necessary - so this stays a regression suite rather than a description
   * of current behavior. The parked-anchor describe that follows pins the
   * other arm, and the two together are why the channel is chosen per commit
   * instead of being turned off outright.
   */
  describe("streaming growth after a data change", () => {
    async function streamTokenThenGrowRow(
      maintainVisibleContentPosition: MaintainVisibleContentPositionConfig<Row>,
    ): Promise<LegendListRef> {
      const listRef = createRef<LegendListRef | null>();
      const { rerender } = render(
        createTranscriptList(rows(12), listRef, maintainVisibleContentPosition),
      );
      await settleLegendList();

      const list = listRef.current;
      if (list === null) throw new Error("LegendList ref did not mount");

      const measuredSize = list.getState().getAverageItemSizes()
        .assistant.average;

      // One token: same keys, fresh row objects. With no `itemsAreEqual` the
      // library reads that as a structural data change, exactly as a live
      // transcript does on every token.
      rerender(
        createTranscriptList(rows(12), listRef, maintainVisibleContentPosition),
      );
      act(() => {
        list.setItemSize("row-3", { height: measuredSize * 3, width: 800 });
      });
      return list;
    }

    it("rewrites positions in the same commit under the transcript's config", async () => {
      const list = await streamTokenThenGrowRow({ data: false, size: true });

      const { gaps, sizes } = positionGapsAndSizes(list);
      expect(gaps).toEqual(sizes);
    });

    it("leaves positions a frame stale once the data channel arms the MVCP anchor lock", async () => {
      const list = await streamTokenThenGrowRow({ data: true, size: true });

      // The lock is armed by the data change and holds for 300ms, re-armed by
      // every further token. While it is held the library stops recalculating
      // positions inline and defers the pass to an animation frame, so the row
      // after the grown one still carries its previous offset.
      const stale = positionGapsAndSizes(list);
      expect(stale.gaps).not.toEqual(stale.sizes);

      await advanceLegendListFrames(1);

      const settled = positionGapsAndSizes(list);
      expect(settled.gaps).toEqual(settled.sizes);
    });
  });

  /**
   * The other half of the contract. A transcript is not append-only: rows are
   * removed when a settled turn's last segment is suppressed, moved when a
   * setup card reaches its anchor, and dropped when a steer nests into its
   * assistant turn or a branch edit lands. A reader parked below one of those
   * has nothing else holding their place - the scroller sets
   * `overflow-anchor: none`, so the browser's own anchoring is off - which is
   * what the data channel is for, and why it is selected rather than removed.
   */
  describe("a row removed above a parked reader", () => {
    const ANCHOR_KEY = "row-22";

    async function viewportOffsetAcrossRemoval(
      maintainVisibleContentPosition: MaintainVisibleContentPositionConfig<Row>,
    ): Promise<{ readonly before: number; readonly after: number }> {
      const listRef = createRef<LegendListRef | null>();
      const data = rows(40);
      const { rerender } = render(
        createTranscriptList(data, listRef, maintainVisibleContentPosition),
      );
      await settleLegendList();

      const list = listRef.current;
      if (list === null) throw new Error("LegendList ref did not mount");

      // Park the reader well down the list, detached from both edges. The
      // scroll promise settles on the virtual clock, so it is fired here and
      // awaited by the settle below rather than directly.
      act(() => {
        void list.scrollToIndex({ animated: false, index: 20 });
      });
      await settleLegendList();

      const offsetOf = (): number => {
        const state = list.getState();
        const position = state.positionByKey(ANCHOR_KEY);
        if (position === undefined) {
          throw new Error(`${ANCHOR_KEY} left the list`);
        }
        return position - state.scroll;
      };
      const before = offsetOf();

      // A row ABOVE the parked one disappears. Everything below it shifts up
      // by that row's height unless the scroll offset is corrected to match.
      rerender(
        createTranscriptList(
          data.filter((row) => row.id !== "row-5"),
          listRef,
          maintainVisibleContentPosition,
        ),
      );
      await settleLegendList();

      return { after: offsetOf(), before };
    }

    it("holds the parked row at the same viewport offset with the data channel on", async () => {
      const { before, after } = await viewportOffsetAcrossRemoval({
        data: true,
        size: true,
      });

      expect(after).toBeCloseTo(before, 0);
    });

    it("shifts the parked row when the data channel is off", async () => {
      const { before, after } = await viewportOffsetAcrossRemoval({
        data: false,
        size: true,
      });

      // The regression a blanket `data: false` would have shipped: the reader
      // is moved by the height of the row that vanished above them.
      expect(after).not.toBeCloseTo(before, 0);
    });
  });
});
