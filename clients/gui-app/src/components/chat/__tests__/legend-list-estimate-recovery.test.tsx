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
    const { rerender } = render(createTestList(rows(1), listRef));
    act(() => {
      fireAllResizeObservers();
    });
    await settleLegendList();

    const list = listRef.current;
    if (list === null) throw new Error("LegendList ref did not mount");

    const captureDataChangedEstimate = (position: number): void => {
      dataChangedEstimates.push(position - list.getState().positionAtIndex(19));
    };

    act(() => {
      list.setItemSize("row-0", { height: 100_000, width: 800 });
    });
    rerender(createTestList(rows(50), listRef));
    await settleLegendList();

    const poisonedEstimate =
      list.getState().positionAtIndex(20) - list.getState().positionAtIndex(19);
    expect(poisonedEstimate).toBeGreaterThan(90_000);

    act(() => {
      for (let index = 1; index <= 10; index += 1) {
        list.setItemSize(`row-${index}`, { height: 1_000, width: 800 });
      }
    });
    const recoveredAverage = list.getState().getAverageItemSizes().assistant;
    expect(recoveredAverage.average).toBeLessThan(20_000);

    const stopCapturing = list
      .getState()
      .listenToPosition("row-20", captureDataChangedEstimate);
    rerender(createTestList(rows(51), listRef));
    stopCapturing();

    expect(dataChangedEstimates).toHaveLength(1);
    expect(dataChangedEstimates[0]).toBeLessThan(20_000);
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
});
