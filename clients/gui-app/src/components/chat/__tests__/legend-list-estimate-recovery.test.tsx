import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

    const state = list.getState();
    const gaps: number[] = [];
    const sizes: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      gaps.push(
        state.positionAtIndex(index + 1) - state.positionAtIndex(index),
      );
      sizes.push(state.sizeAtIndex(index));
    }
    expect(gaps).toEqual(sizes);
  });
});
