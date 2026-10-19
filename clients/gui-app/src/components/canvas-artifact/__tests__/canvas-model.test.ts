import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasLayoutSnapshot } from "@traycer/protocol/persistence/epic/canvas-layout";
import {
  boardFrame,
  canvasPageItems,
  canvasToolForKey,
  createCursorThrottle,
  selectLiveBoards,
  type CursorThrottle,
} from "../canvas-model";
import { snapshotFromFixture, type CanvasFixtureFile } from "./canvas-fixtures";

const NEAR = "boards/near.html";
const FAR = "boards/far.html";
const MIDDLE = "boards/middle.html";
const OTHER_PAGE = "boards/other-page.html";

const twoPageFile: CanvasFixtureFile = {
  pages: [
    { id: "page-1", name: "Flow" },
    { id: "page-2", name: "Details" },
  ],
  boards: {
    [FAR]: { x: 5000, y: 0, w: 100, h: 100 },
    [NEAR]: { x: 0, y: 0, w: 100, h: 100 },
    [MIDDLE]: { x: 1000, y: 0, w: 100, h: 100 },
    [OTHER_PAGE]: { x: 10, y: 0, w: 100, h: 100, page: "page-2" },
  },
  notes: {
    "note-default": { type: "sticky", x: 0, y: 0, text: "no page set" },
    "note-explicit": {
      type: "sticky",
      x: 0,
      y: 0,
      text: "on page two",
      page: "page-2",
    },
  },
  order: [FAR, NEAR, MIDDLE, OTHER_PAGE],
};

describe("canvasPageItems", () => {
  const snapshot = snapshotFromFixture(twoPageFile);

  it("treats items without a page as belonging to the first page", () => {
    const items = canvasPageItems(snapshot, "page-1");
    expect(items.boards.map(([path]) => path)).toEqual([FAR, NEAR, MIDDLE]);
    expect(items.notes.map(([id]) => id)).toEqual(["note-default"]);
  });

  it("returns only the items that name the requested page", () => {
    const items = canvasPageItems(snapshot, "page-2");
    expect(items.boards.map(([path]) => path)).toEqual([OTHER_PAGE]);
    expect(items.notes.map(([id]) => id)).toEqual(["note-explicit"]);
  });

  it("returns nothing for a page that does not exist", () => {
    const items = canvasPageItems(snapshot, "page-missing");
    expect(items.boards).toEqual([]);
    expect(items.notes).toEqual([]);
  });

  it("keeps boards in layout order", () => {
    const reordered = snapshotFromFixture({
      ...twoPageFile,
      order: [MIDDLE, FAR, NEAR, OTHER_PAGE],
    });
    expect(
      canvasPageItems(reordered, "page-1").boards.map(([path]) => path),
    ).toEqual([MIDDLE, FAR, NEAR]);
  });
});

describe("selectLiveBoards", () => {
  const snapshot = snapshotFromFixture(twoPageFile);
  const origin = { x: 50, y: 50 };

  it("picks the boards closest to the viewport centre within the budget", () => {
    expect(selectLiveBoards(snapshot, "page-1", origin, 2)).toEqual(
      new Set([NEAR, MIDDLE]),
    );
  });

  it("follows the centre when the viewport moves", () => {
    expect(selectLiveBoards(snapshot, "page-1", { x: 5050, y: 50 }, 1)).toEqual(
      new Set([FAR]),
    );
  });

  it("returns every board of the page when the budget exceeds the count", () => {
    expect(selectLiveBoards(snapshot, "page-1", origin, 8)).toEqual(
      new Set([NEAR, MIDDLE, FAR]),
    );
  });

  it("never includes boards from another page, however near", () => {
    const live = selectLiveBoards(snapshot, "page-1", origin, 8);
    expect(live.has(OTHER_PAGE)).toBe(false);
    expect(selectLiveBoards(snapshot, "page-2", origin, 8)).toEqual(
      new Set([OTHER_PAGE]),
    );
  });

  it("yields nothing for a zero or negative budget", () => {
    expect(selectLiveBoards(snapshot, "page-1", origin, 0).size).toBe(0);
    expect(selectLiveBoards(snapshot, "page-1", origin, -3).size).toBe(0);
  });

  it("breaks distance ties by layout order", () => {
    const left = "boards/left.html";
    const right = "boards/right.html";
    const tied = snapshotFromFixture({
      pages: [{ id: "page-1", name: "Flow" }],
      boards: {
        [left]: { x: -350, y: 0, w: 100, h: 100 },
        [right]: { x: 250, y: 0, w: 100, h: 100 },
      },
      notes: {},
      order: [right, left],
    });
    // Both centres are 300 from x=0, so only the order can decide.
    expect(selectLiveBoards(tied, "page-1", { x: 0, y: 50 }, 1)).toEqual(
      new Set([right]),
    );
    const swapped = snapshotFromFixture({
      pages: [{ id: "page-1", name: "Flow" }],
      boards: {
        [left]: { x: -350, y: 0, w: 100, h: 100 },
        [right]: { x: 250, y: 0, w: 100, h: 100 },
      },
      notes: {},
      order: [left, right],
    });
    expect(selectLiveBoards(swapped, "page-1", { x: 0, y: 50 }, 1)).toEqual(
      new Set([left]),
    );
  });
});

describe("boardFrame", () => {
  it("clamps a board smaller than the minimum frame", () => {
    const snapshot = snapshotFromFixture({
      pages: [{ id: "page-1", name: "Flow" }],
      boards: { [NEAR]: { x: 3, y: 4, w: 1, h: 1 } },
      notes: {},
      order: [NEAR],
    });
    expect(boardFrame(snapshot.boards[NEAR])).toEqual({
      x: 3,
      y: 4,
      w: 80,
      h: 60,
    });
  });

  it("gives a board with no size the 1280 by 800 frame and keeps a size it has", () => {
    expect(boardFrame({ x: 3, y: 4 })).toEqual({
      x: 3,
      y: 4,
      w: 1280,
      h: 800,
    });
    expect(boardFrame({ h: 333 })).toEqual({ x: 0, y: 0, w: 1280, h: 333 });
  });

  it("measures a board with no size as a 1280 by 800 frame when picking live boards", () => {
    const snapshot: CanvasLayoutSnapshot = {
      v: 1,
      title: "Flow",
      pages: [{ id: "page-1", name: "Flow", pos: "a0" }],
      boards: {
        [NEAR]: { x: 0, y: 0, pos: "a0" },
        [FAR]: { x: 500, y: 350, w: 100, h: 100, pos: "a1" },
      },
      notes: {},
      order: [FAR, NEAR],
      extra: {},
    };
    // The unsized board's centre is (640, 400), 60 from the point; an 800 by 600
    // fallback would put it at (400, 300) and lose to the sized board at (550, 400).
    expect(selectLiveBoards(snapshot, "page-1", { x: 700, y: 400 }, 1)).toEqual(
      new Set([NEAR]),
    );
  });
});

describe("canvasToolForKey", () => {
  it.each([
    ["v", "select"],
    ["h", "hand"],
    ["n", "sticky"],
    ["r", "rect"],
    ["o", "oval"],
    ["l", "line"],
    ["a", "arrow"],
    ["p", "pen"],
    ["t", "title"],
    ["Escape", "select"],
  ])("maps %s to the %s tool", (key, tool) => {
    expect(canvasToolForKey(key)).toBe(tool);
  });

  it("ignores letter case", () => {
    expect(canvasToolForKey("R")).toBe("rect");
  });

  it("returns null for keys with no tool", () => {
    expect(canvasToolForKey("z")).toBeNull();
    expect(canvasToolForKey("Enter")).toBeNull();
    expect(canvasToolForKey("")).toBeNull();
  });

  it("does not resolve inherited object keys to a tool", () => {
    expect(canvasToolForKey("constructor")).toBeNull();
    expect(canvasToolForKey("__proto__")).toBeNull();
  });
});

describe("createCursorThrottle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function startThrottle(): {
    published: number[];
    throttle: CursorThrottle<number>;
  } {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const published: number[] = [];
    return {
      published,
      throttle: createCursorThrottle<number>((value) => {
        published.push(value);
      }),
    };
  }

  it("publishes the first position immediately", () => {
    const { published, throttle } = startThrottle();
    throttle.push(1);
    expect(published).toEqual([1]);
  });

  it("holds later positions and publishes only the latest as the trailing call", () => {
    const { published, throttle } = startThrottle();
    throttle.push(1);
    vi.advanceTimersByTime(5);
    throttle.push(2);
    vi.advanceTimersByTime(5);
    throttle.push(3);
    expect(published).toEqual([1]);
    vi.advanceTimersByTime(40);
    expect(published).toEqual([1, 3]);
  });

  it("never publishes faster than 30 per second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const publishedAt: number[] = [];
    const throttle = createCursorThrottle<number>(() => {
      publishedAt.push(Date.now());
    });
    for (let elapsed = 0; elapsed < 1000; elapsed += 1) {
      throttle.push(elapsed);
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(100);

    expect(publishedAt.length).toBeGreaterThan(20);
    for (let index = 1; index < publishedAt.length; index += 1) {
      expect(
        publishedAt[index] - publishedAt[index - 1],
      ).toBeGreaterThanOrEqual(33);
    }
  });

  it("publishes immediately again once the interval has passed", () => {
    const { published, throttle } = startThrottle();
    throttle.push(1);
    vi.advanceTimersByTime(100);
    throttle.push(2);
    expect(published).toEqual([1, 2]);
  });

  it("drops the queued position on cancel so nothing stale lands after leave", () => {
    const { published, throttle } = startThrottle();
    throttle.push(1);
    vi.advanceTimersByTime(5);
    throttle.push(2);
    throttle.cancel();
    vi.advanceTimersByTime(200);
    expect(published).toEqual([1]);
  });

  it("starts fresh after cancel", () => {
    const { published, throttle } = startThrottle();
    throttle.push(1);
    throttle.cancel();
    throttle.push(2);
    expect(published).toEqual([1, 2]);
  });
});
