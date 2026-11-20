import { describe, expect, it } from "vitest";
import {
  createVirtualRowPinStore,
  withPinnedIndexes,
} from "@/components/epic-canvas/sidebar/virtual-row-pins";

/**
 * Rows a virtual list keeps mounted outside its window: pins are counted, and
 * the rendered indexes stay in row order.
 */

describe("virtual row pins", () => {
  it("holds a key until every holder has released it", () => {
    const store = createVirtualRowPinStore();

    const releaseFirst = store.pin("row");
    const releaseSecond = store.pin("row");
    releaseFirst();
    expect([...store.getSnapshot()]).toEqual(["row"]);
    releaseSecond();

    expect([...store.getSnapshot()]).toEqual([]);
  });

  it("lets a release run twice without freeing another holder's pin", () => {
    const store = createVirtualRowPinStore();
    const release = store.pin("row");
    store.pin("row");

    release();
    release();

    expect([...store.getSnapshot()]).toEqual(["row"]);
  });

  it("tells subscribers when the pinned set changes and keeps its identity otherwise", () => {
    const store = createVirtualRowPinStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    store.pin("row");
    const snapshot = store.getSnapshot();
    store.pin("row");

    expect(notified).toBe(1);
    expect(store.getSnapshot()).toBe(snapshot);
  });
});

describe("withPinnedIndexes", () => {
  const INDEX_BY_KEY = new Map([
    ["a", 0],
    ["b", 50],
    ["c", 200],
  ]);

  it("adds each pinned row to the window, ascending and without repeats", () => {
    expect(
      withPinnedIndexes(
        [48, 49, 50, 51],
        new Set(["c", "a", "b"]),
        INDEX_BY_KEY,
      ),
    ).toEqual([0, 48, 49, 50, 51, 200]);
  });

  it("skips a pinned row the list no longer holds", () => {
    expect(withPinnedIndexes([1, 2], new Set(["gone"]), INDEX_BY_KEY)).toEqual([
      1, 2,
    ]);
  });
});
