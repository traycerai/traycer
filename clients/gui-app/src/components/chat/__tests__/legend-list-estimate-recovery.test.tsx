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

  /**
   * Companion to "refreshes never-measured cached estimates..." above, for
   * the transcript's OTHER maintain configuration: a same-key, content-only
   * commit (`{data: false, size: true}` - what `chat-timeline.tsx` sends
   * for the accepted-message/first-token pass, when the row key sequence
   * did not change; see quote-send-scroll-position.test.tsx). The test
   * above only proves a poisoned estimate recovers across an APPEND
   * (`{data: true}`, key sequence changed). A production fix for a
   * detached reader's position moving on the same-key commit must not
   * "fix" it by leaving a stale cached estimate frozen there forever - this
   * proves recovery still reaches a never-individually-measured row on
   * that commit too.
   */
  describe("estimate recovery across a same-key (data: false) commit", () => {
    it("recovers a poisoned estimate through a same-key content commit, not only through an append", async () => {
      const listRef = createRef<LegendListRef | null>();
      const sameKeyMvcp: MaintainVisibleContentPositionConfig<Row> = {
        data: false,
        size: true,
      };
      const data = rows(50);
      const { rerender } = render(
        createTranscriptList(data, listRef, sameKeyMvcp),
      );
      act(() => {
        fireAllResizeObservers();
      });
      await settleLegendList();

      const list = listRef.current;
      if (list === null) throw new Error("LegendList ref did not mount");

      // A genuinely measured baseline, mirroring "refreshes never-measured
      // cached estimates..." above - `sizeAtIndex` reads `sizesKnown`
      // (measured-only) and is `undefined` for row-40 below, which this
      // test deliberately never measures, so it cannot supply this value.
      const measuredSize = list.getState().getAverageItemSizes()
        .assistant.average;

      const effectiveSizeAt = (index: number): number => {
        const state = list.getState();
        return state.positionAtIndex(index + 1) - state.positionAtIndex(index);
      };

      // Poison the live average through a row this test never mounts or
      // scrolls near, exactly as "refreshes never-measured cached
      // estimates..." above does with row-45 - a row close to the top
      // (like row-10) sits inside the render+buffer window a top-mounted
      // list actually draws, so its own real (unmocked) layout-effect
      // measurement re-fires on every rerender and overwrites this poke
      // back to the flat 90px default; row-45 stays outside that window.
      act(() => {
        list.setItemSize("row-45", {
          height: measuredSize * 1_000,
          width: 800,
        });
      });
      const poisonedAverage = list.getState().getAverageItemSizes().assistant;
      expect(poisonedAverage.average).toBeGreaterThan(measuredSize * 10);

      // A same-key, content-only rerender - new row objects, same ids - is
      // exactly what an accepted-message/token commit looks like; it goes
      // through the same `{data: false, size: true}` config the transcript
      // selects for it.
      rerender(
        createTranscriptList(
          data.map((row) => ({ ...row })),
          listRef,
          sameKeyMvcp,
        ),
      );
      await settleLegendList();

      expect(effectiveSizeAt(40)).toBeGreaterThan(measuredSize * 10);

      // Heal the poisoning row back to a normal size.
      act(() => {
        list.setItemSize("row-45", { height: measuredSize, width: 800 });
      });
      const recoveredAverage = list.getState().getAverageItemSizes().assistant;
      expect(recoveredAverage.average).toBeLessThan(measuredSize * 2);

      // Another same-key, content-only rerender under the same
      // `{data: false}` config: row-40's effective size must not stay
      // frozen at the poisoned value - it should reflect the healed
      // average, exactly as the append-direction test above requires of an
      // appended row.
      rerender(
        createTranscriptList(
          data.map((row) => ({ ...row })),
          listRef,
          sameKeyMvcp,
        ),
      );
      await settleLegendList();

      expect(effectiveSizeAt(40)).toBeLessThan(measuredSize * 2);
    });
  });

  /**
   * A reader parked near the end of a long list has many never-measured rows
   * above them, each holding a cached estimate. When the type average then
   * jumps, a scroll-driven pass maintains no visible content position, so
   * replacing those estimates would move every row below them - the reader
   * included - with nothing to compensate. That pass has to keep the cached
   * estimates; the next pass that does maintain the position refreshes them.
   */
  describe("a scroll-driven pass after the type average jumps", () => {
    it("holds the row at the top of the reader's view instead of re-estimating the rows above", async () => {
      const listRef = createRef<LegendListRef | null>();
      // End-aligned like the transcript: the rows near the top are never
      // rendered or measured, so each caches the estimate from mount time.
      render(
        <LegendList
          ref={listRef}
          data={rows(70)}
          estimatedItemSize={90}
          getItemType={() => "assistant"}
          initialScrollAtEnd
          keyExtractor={(item) => item.id}
          maintainScrollAtEndThreshold={0}
          maintainVisibleContentPosition={{ data: false, size: true }}
          recycleItems={false}
          renderItem={({ item }) => <div data-index={item.id}>{item.id}</div>}
        />,
      );
      act(() => {
        fireAllResizeObservers();
      });
      await settleLegendList();

      const list = listRef.current;
      if (list === null) throw new Error("LegendList ref did not mount");

      const measuredSize = list.getState().getAverageItemSizes()
        .assistant.average;

      // row-69 sits at the edge of the window and is not re-measured here, so
      // the average keeps whatever it is told.
      act(() => {
        list.setItemSize("row-69", {
          height: measuredSize * 20,
          width: 800,
        });
      });
      await settleLegendList();
      // Past the factor of two at which a cached estimate counts as stale,
      // but small enough that the position pass still reaches the reader's
      // rows from the top. The unmeasured rows above the view are the ones
      // that re-estimate.
      expect(
        list.getState().getAverageItemSizes().assistant.average,
      ).toBeGreaterThan(measuredSize * 2);

      // A one-pixel change to a row far above the window records the lowest
      // changed index without running a pass, so the next pass recomputes
      // every position from the top - the shape a real timeline reaches
      // whenever an earlier row remeasures.
      act(() => {
        list.setItemSize("row-0", { height: measuredSize + 1, width: 800 });
      });
      await settleLegendList();

      const scrollBefore = list.getState().scroll;

      // Far enough to leave the range the list already calculated, or the
      // scroll event would not run a position pass at all, and short of the
      // top.
      const SCROLL_TARGET = 30 * measuredSize;

      // The row that will sit at the top of the reader's view after the
      // scroll. Rows below the view's bottom edge may re-estimate, since the
      // reader cannot see them move; this row is what the reader is looking at.
      const state = list.getState();
      let anchorIndex = 0;
      while (state.positionAtIndex(anchorIndex) < SCROLL_TARGET) {
        anchorIndex += 1;
      }
      const offsetOf = (): number => {
        const current = list.getState();
        return current.positionAtIndex(anchorIndex) - current.scroll;
      };
      const before = offsetOf();

      const scrollNode = list.getScrollableNode();
      act(() => {
        scrollNode.scrollTop = SCROLL_TARGET;
        scrollNode.dispatchEvent(new Event("scroll"));
      });
      await settleLegendList();

      const scrolled = list.getState().scroll - scrollBefore;
      expect(scrolled).toBe(SCROLL_TARGET - scrollBefore);
      // Within a few px: only the scroll and row-0's pixel may move the row
      // at the top of the reader's view, not a re-estimate of the unmeasured
      // rows above it.
      expect(offsetOf()).toBeCloseTo(before - scrolled, -1);
    });
  });

  /**
   * A transcript is end-aligned, so the rows near its top are never rendered
   * or measured and each caches the estimate from mount time. Once the type
   * average has jumped those estimates are stale, and any pass that
   * re-estimates them moves every row below them, the reader's included. A
   * pass that anchors nothing has to keep them.
   */
  describe("a pass that maintains no visible content position", () => {
    function endAlignedList(
      count: number,
      listRef: React.RefObject<LegendListRef | null>,
    ) {
      return (
        <LegendList
          ref={listRef}
          data={rows(count)}
          estimatedItemSize={90}
          getItemType={() => "assistant"}
          initialScrollAtEnd
          keyExtractor={(item) => item.id}
          maintainScrollAtEndThreshold={0}
          maintainVisibleContentPosition={{ data: false, size: true }}
          recycleItems={false}
          renderItem={({ item }) => <div data-index={item.id}>{item.id}</div>}
        />
      );
    }

    /** Mounts end-aligned, then pushes the type average past twice the cached
     *  estimate of the never-measured rows above the window. */
    async function mountWithStaleEstimates(
      listRef: React.RefObject<LegendListRef | null>,
    ) {
      const view = render(endAlignedList(70, listRef));
      act(() => {
        fireAllResizeObservers();
      });
      await settleLegendList();

      const list = listRef.current;
      if (list === null) throw new Error("LegendList ref did not mount");
      const measuredSize = list.getState().getAverageItemSizes()
        .assistant.average;
      act(() => {
        list.setItemSize("row-69", {
          height: measuredSize * 60,
          width: 800,
        });
      });
      await settleLegendList();
      expect(
        list.getState().getAverageItemSizes().assistant.average,
      ).toBeGreaterThan(measuredSize * 2);
      return { list, measuredSize, rerender: view.rerender };
    }

    it("an append that MVCP does not anchor keeps the unmeasured rows above the view at their estimates", async () => {
      const listRef = createRef<LegendListRef | null>();
      const { list, measuredSize, rerender } =
        await mountWithStaleEstimates(listRef);

      // Park the reader well above the end, with the unmeasured rows between
      // the top of the list and the view.
      const SCROLL_TARGET = 30 * measuredSize;
      const scrollNode = list.getScrollableNode();
      act(() => {
        scrollNode.scrollTop = SCROLL_TARGET;
        scrollNode.dispatchEvent(new Event("scroll"));
      });
      await settleLegendList();

      const state = list.getState();
      let anchorIndex = 0;
      while (state.positionAtIndex(anchorIndex) < state.scroll) {
        anchorIndex += 1;
      }
      const offsetOf = (): number => {
        const current = list.getState();
        return current.positionAtIndex(anchorIndex) - current.scroll;
      };
      const before = offsetOf();

      // `{data: false}` anchors nothing for a data change, so the rows above
      // the view are the only thing that could move the reader's row.
      rerender(endAlignedList(71, listRef));
      await settleLegendList();

      expect(offsetOf()).toBeCloseTo(before, -1);
    });

    it("the settled re-layout after an end request leaves the rows above the view alone", async () => {
      const listRef = createRef<LegendListRef | null>();
      const { list, measuredSize } = await mountWithStaleEstimates(listRef);

      // Park the reader above the end, then ask for the end.
      const scrollNode = list.getScrollableNode();
      act(() => {
        scrollNode.scrollTop = 30 * measuredSize;
        scrollNode.dispatchEvent(new Event("scroll"));
      });
      await settleLegendList();

      const rowCount = 70;
      const positionsBefore = Array.from({ length: rowCount }, (_, index) =>
        list.getState().positionAtIndex(index),
      );

      act(() => {
        void list.scrollToEnd({ animated: false });
      });
      await settleLegendList();

      // The settled pass after an end request anchors nothing, so it must
      // keep the estimate of every unmeasured row the reader has left above
      // the view.
      const after = list.getState();
      const movedAboveView = positionsBefore.flatMap((before, index) =>
        before < after.scroll && after.positionAtIndex(index) !== before
          ? [index]
          : [],
      );
      expect(movedAboveView).toEqual([]);
    });
  });

  /**
   * The transcript mounts end-aligned (`initialScrollAtEnd`), and rows
   * appended while it is still at the end re-arm that bootstrap. A reader who
   * wheels up in that window gets a pass the library runs with
   * `doMVCP: true`, but no anchor is prepared while the bootstrap is active,
   * so the position pass must not treat itself as anchored: re-estimating the
   * unmeasured rows above the reader there moves every row below them with
   * nothing to compensate.
   */
  describe("a pass during a re-armed initial-scroll bootstrap", () => {
    it("keeps the reader's row where it was instead of re-estimating the rows above", async () => {
      const listRef = createRef<LegendListRef | null>();
      const endAlignedList = (count: number) => (
        <LegendList
          ref={listRef}
          data={rows(count)}
          estimatedItemSize={90}
          getItemType={() => "assistant"}
          initialScrollAtEnd
          keyExtractor={(item) => item.id}
          maintainScrollAtEndThreshold={0}
          maintainVisibleContentPosition={{ data: true, size: true }}
          recycleItems={false}
          renderItem={({ item }) => <div data-index={item.id}>{item.id}</div>}
        />
      );
      const { rerender } = render(endAlignedList(70));
      act(() => {
        fireAllResizeObservers();
      });
      await settleLegendList();

      const list = listRef.current;
      if (list === null) throw new Error("LegendList ref did not mount");
      const measuredSize = list.getState().getAverageItemSizes()
        .assistant.average;

      // Appending while end-aligned re-arms the bootstrap. The new rows are
      // never measured here, so it stays active through the steps below.
      rerender(endAlignedList(72));

      // The reader wheels up from the end.
      const scrollNode = list.getScrollableNode();
      act(() => {
        scrollNode.scrollTop = list.getState().scroll - 1_500;
        scrollNode.dispatchEvent(new Event("scroll"));
      });

      // The average jumps through a measured row at the end, below the reader.
      act(() => {
        list.setItemSize("row-69", {
          height: measuredSize * 1_000,
          width: 800,
        });
      });
      expect(
        list.getState().getAverageItemSizes().assistant.average,
      ).toBeGreaterThan(measuredSize * 10);

      // A one-pixel change to a row far above the window records the lowest
      // changed index without running a pass, so the next pass recomputes
      // every position from the top.
      act(() => {
        list.setItemSize("row-0", { height: measuredSize + 1, width: 800 });
      });

      const anchorKey = "row-47";
      const positionBefore = list.getState().positionByKey(anchorKey);
      if (positionBefore === undefined) {
        throw new Error("The anchor row is not in the list");
      }

      // A row in the window remeasures: the pass the library runs with
      // `doMVCP: true`, while the bootstrap is still active.
      act(() => {
        list.setItemSize("row-70", { height: measuredSize + 1, width: 800 });
      });
      await advanceLegendListFrames(1);

      const positionAfter = list.getState().positionByKey(anchorKey);
      if (positionAfter === undefined) {
        throw new Error("The anchor row is not in the list");
      }
      // Only row-0's pixel may move the row, not a re-estimate of the rows
      // above it.
      expect(Math.abs(positionAfter - positionBefore)).toBeLessThan(5);
    });
  });

  /**
   * While an animated scroll is in flight, MVCP adjustments are held instead
   * of moving the scroller. The reader's wheel ends that command, and the
   * held adjust then lands as an absolute write. The wheel has already moved
   * the scroller by then, but its scroll event has not reached the list, so
   * the write has to start from the scroller's offset: from the list's
   * lagging `state.scroll` it would put the reader back where they were
   * before the wheel.
   */
  describe("a held MVCP adjust landed by the reader's wheel", () => {
    it("keeps the wheel's scroll the list has not seen yet", async () => {
      const listRef = createRef<LegendListRef | null>();
      render(
        createTranscriptList(rows(70), listRef, { data: false, size: true }),
      );
      act(() => {
        fireAllResizeObservers();
      });
      await settleLegendList();

      const list = listRef.current;
      if (list === null) throw new Error("LegendList ref did not mount");

      act(() => {
        void list.scrollToIndex({ animated: false, index: 22 });
      });
      await settleLegendList();

      const measuredSize = list.getState().getAverageItemSizes()
        .assistant.average;
      // A smooth scroll that has not moved the scroller yet: the harness's
      // `scrollTo` would land the target at once and end the command.
      const scrollNode = list.getScrollableNode();
      const smoothScrollTo = vi
        .spyOn(scrollNode, "scrollTo")
        .mockImplementation(() => undefined);
      act(() => {
        void list.scrollToIndex({ animated: true, index: 20 });
      });
      await advanceLegendListFrames(3);

      // A row above the reader grows while the command is in flight. The
      // list holds that growth back as the anchor shift for the scroller.
      const sizeBefore = list.getState().sizeAtIndex(19);
      act(() => {
        list.setItemSize("row-19", { height: measuredSize * 3, width: 800 });
      });
      const growth = list.getState().sizeAtIndex(19) - sizeBefore;
      expect(growth).toBeGreaterThan(0);

      // The reader's wheel moves the scroller; its scroll event has not
      // reached the list.
      const WHEEL_STEP = -100;
      const wheeledTo = scrollNode.scrollTop + WHEEL_STEP;
      scrollNode.scrollTop = wheeledTo;

      // From here the scroller takes the list's writes, as the harness does.
      smoothScrollTo.mockImplementation(
        (options: ScrollToOptions | number | undefined) => {
          if (typeof options === "object" && options.top !== undefined) {
            scrollNode.scrollTop = options.top;
          }
        },
      );
      let cancelled = false;
      act(() => {
        cancelled = list.cancelPendingScroll();
      });
      expect(cancelled).toBe(true);
      await advanceLegendListFrames(1);

      expect(scrollNode.scrollTop).toBeCloseTo(wheeledTo + growth, 0);
    });
  });
});
