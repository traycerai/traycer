import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanvasBoardFrame,
  CanvasLayoutSnapshot,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import {
  boardFrame,
  canvasPageItems,
  canvasToolForKey,
  createCursorThrottle,
  selectLiveBoards,
  type CursorThrottle,
} from "../canvas-model";
import { snapshotFromFixture, type CanvasFixtureFile } from "./canvas-fixtures";

const ZERO_FRAME: CanvasBoardFrame = { x: 0, y: 0, w: 0, h: 0 };

/**
 * `selectLiveBoards` takes one options object; this fills in the parts a
 * test does not care about so each case only states what it is exercising.
 * A point used to be the selector's whole notion of "near"; a
 * zero-size frame at that point reproduces it here, since nothing can
 * intersect a frame with no area.
 */
function liveBoards(
  snapshot: CanvasLayoutSnapshot,
  page: string,
  overrides: Partial<{
    readonly viewport: CanvasBoardFrame;
    readonly fullscreenBoard: string | null;
    readonly playingBoard: string | null;
    readonly recentBoards: readonly string[];
    readonly byteLengths: Readonly<Record<string, number>> | null;
    readonly slotBudget: number;
  }>,
): ReadonlySet<string> {
  return selectLiveBoards({
    boards: snapshot.boards,
    pageBoards: canvasPageItems(snapshot, page, null).boards.map(
      ([path]) => path,
    ),
    byteLengths: null,
    viewport: ZERO_FRAME,
    fullscreenBoard: null,
    playingBoard: null,
    recentBoards: [],
    slotBudget: 8,
    ...overrides,
  });
}

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
    const items = canvasPageItems(snapshot, "page-1", null);
    expect(items.boards.map(([path]) => path)).toEqual([FAR, NEAR, MIDDLE]);
    expect(items.notes.map(([id]) => id)).toEqual(["note-default"]);
  });

  it("returns only the items that name the requested page", () => {
    const items = canvasPageItems(snapshot, "page-2", null);
    expect(items.boards.map(([path]) => path)).toEqual([OTHER_PAGE]);
    expect(items.notes.map(([id]) => id)).toEqual(["note-explicit"]);
  });

  it("returns nothing for a page that does not exist", () => {
    const items = canvasPageItems(snapshot, "page-missing", null);
    expect(items.boards).toEqual([]);
    expect(items.notes).toEqual([]);
  });

  it("keeps boards in layout order", () => {
    const reordered = snapshotFromFixture({
      ...twoPageFile,
      order: [MIDDLE, FAR, NEAR, OTHER_PAGE],
    });
    expect(
      canvasPageItems(reordered, "page-1", null).boards.map(([path]) => path),
    ).toEqual([MIDDLE, FAR, NEAR]);
  });

  it("leaves out a board whose file the committed manifest lacks, without moving the rest", () => {
    const items = canvasPageItems(snapshot, "page-1", new Set([FAR, MIDDLE]));
    expect(items.boards).toEqual([
      [FAR, snapshot.boards[FAR]],
      [MIDDLE, snapshot.boards[MIDDLE]],
    ]);
  });
});

describe("selectLiveBoards", () => {
  const snapshot = snapshotFromFixture(twoPageFile);
  const origin: CanvasBoardFrame = { x: 50, y: 50, w: 0, h: 0 };

  it("picks the boards closest to the viewport centre within the budget", () => {
    expect(
      liveBoards(snapshot, "page-1", { viewport: origin, slotBudget: 2 }),
    ).toEqual(new Set([NEAR, MIDDLE]));
  });

  it("follows the centre when the viewport moves", () => {
    expect(
      liveBoards(snapshot, "page-1", {
        viewport: { x: 5050, y: 50, w: 0, h: 0 },
        slotBudget: 1,
      }),
    ).toEqual(new Set([FAR]));
  });

  it("returns every board of the page when the budget exceeds the count", () => {
    expect(
      liveBoards(snapshot, "page-1", { viewport: origin, slotBudget: 8 }),
    ).toEqual(new Set([NEAR, MIDDLE, FAR]));
  });

  it("never includes boards from another page, however near", () => {
    const live = liveBoards(snapshot, "page-1", {
      viewport: origin,
      slotBudget: 8,
    });
    expect(live.has(OTHER_PAGE)).toBe(false);
    expect(
      liveBoards(snapshot, "page-2", { viewport: origin, slotBudget: 8 }),
    ).toEqual(new Set([OTHER_PAGE]));
  });

  it("yields nothing for a zero or negative budget", () => {
    expect(
      liveBoards(snapshot, "page-1", { viewport: origin, slotBudget: 0 }).size,
    ).toBe(0);
    expect(
      liveBoards(snapshot, "page-1", { viewport: origin, slotBudget: -3 }).size,
    ).toBe(0);
  });

  it("breaks distance ties by layout order", () => {
    const left = "boards/left.html";
    const right = "boards/right.html";
    const point: CanvasBoardFrame = { x: 0, y: 50, w: 0, h: 0 };
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
    expect(
      liveBoards(tied, "page-1", { viewport: point, slotBudget: 1 }),
    ).toEqual(new Set([right]));
    const swapped = snapshotFromFixture({
      pages: [{ id: "page-1", name: "Flow" }],
      boards: {
        [left]: { x: -350, y: 0, w: 100, h: 100 },
        [right]: { x: 250, y: 0, w: 100, h: 100 },
      },
      notes: {},
      order: [left, right],
    });
    expect(
      liveBoards(swapped, "page-1", { viewport: point, slotBudget: 1 }),
    ).toEqual(new Set([left]));
  });

  describe("priority ladder", () => {
    const FS = "boards/fullscreen.html";
    const PLAY = "boards/playing.html";
    const VIS = "boards/visible.html";
    const REC = "boards/recent.html";
    const OFF1 = "boards/off-near.html";
    const OFF2 = "boards/off-far.html";
    const ladder: CanvasFixtureFile = {
      pages: [{ id: "page-1", name: "Flow" }],
      boards: {
        // Far from the viewport: only their priority tier admits them.
        [FS]: { x: 9000, y: 0, w: 100, h: 100 },
        [PLAY]: { x: 9100, y: 0, w: 100, h: 100 },
        [REC]: { x: 9200, y: 0, w: 100, h: 100 },
        // Inside the viewport rect below.
        [VIS]: { x: 0, y: 0, w: 100, h: 100 },
        [OFF1]: { x: 1000, y: 0, w: 100, h: 100 },
        [OFF2]: { x: 2000, y: 0, w: 100, h: 100 },
      },
      notes: {},
      order: [FS, PLAY, REC, VIS, OFF1, OFF2],
    };
    const snapshot = snapshotFromFixture(ladder);
    const viewport: CanvasBoardFrame = { x: -500, y: -500, w: 1000, h: 1000 };

    it("ranks fullscreen above play, an in-viewport board and a recent board", () => {
      // A single slot forces every tier to compete for it at once; only
      // fullscreen's win is unambiguous from Set membership alone.
      const live = liveBoards(snapshot, "page-1", {
        viewport,
        fullscreenBoard: FS,
        playingBoard: PLAY,
        recentBoards: [REC],
        slotBudget: 1,
      });
      expect(live).toEqual(new Set([FS]));
    });

    it("ranks the playing board above an in-viewport board", () => {
      const live = liveBoards(snapshot, "page-1", {
        viewport,
        playingBoard: PLAY,
        slotBudget: 1,
      });
      expect(live).toEqual(new Set([PLAY]));
    });

    it("ranks an in-viewport board above a merely recent one", () => {
      const live = liveBoards(snapshot, "page-1", {
        viewport,
        recentBoards: [REC],
        slotBudget: 1,
      });
      expect(live).toEqual(new Set([VIS]));
    });

    it("ranks a recent board above an offscreen board nearer the viewport", () => {
      // VIS fills the first slot (it sits inside the viewport). The real
      // contest is for the second: OFF1 is nearer by raw distance than REC,
      // so only insertion order - not Set membership - can show REC (merely
      // recent) wins it over OFF1 (nearer but plain offscreen).
      const live = liveBoards(snapshot, "page-1", {
        viewport,
        recentBoards: [REC],
        slotBudget: 2,
      });
      expect([...live]).toEqual([VIS, REC]);
    });

    it("fills remaining slots with offscreen boards nearest the viewport", () => {
      const live = liveBoards(snapshot, "page-1", {
        viewport,
        slotBudget: 2,
      });
      expect(live).toEqual(new Set([VIS, OFF1]));
    });

    it("counts a board named in two tiers only once toward the budget", () => {
      const live = liveBoards(snapshot, "page-1", {
        viewport,
        fullscreenBoard: PLAY,
        playingBoard: PLAY,
        recentBoards: [PLAY],
        slotBudget: 2,
      });
      expect(live).toEqual(new Set([PLAY, VIS]));
    });
  });

  describe("byte-weighted budget", () => {
    const P1 = "boards/p1.html";
    const P2 = "boards/p2.html";
    const P3 = "boards/p3.html";
    const file: CanvasFixtureFile = {
      pages: [{ id: "page-1", name: "Flow" }],
      boards: {
        [P1]: { x: 0, y: 0, w: 100, h: 100 },
        [P2]: { x: 1000, y: 0, w: 100, h: 100 },
        [P3]: { x: 2000, y: 0, w: 100, h: 100 },
      },
      notes: {},
      order: [P1, P2, P3],
    };
    const snapshot = snapshotFromFixture(file);

    it("spends weight 1 + floor(bytes / 40960) of the budget per board", () => {
      // 90000 bytes -> 1 + floor(90000 / 40960) = 3.
      const live = liveBoards(snapshot, "page-1", {
        recentBoards: [P1, P2, P3],
        byteLengths: { [P1]: 0, [P2]: 90_000, [P3]: 0 },
        slotBudget: 5,
      });
      // P1 (1) + P2 (3) = 4 fits; adding P3 (1) would reach 5, which still
      // fits, so every board is admitted here.
      expect(live).toEqual(new Set([P1, P2, P3]));
    });

    it("skips a later candidate that does not fit, but keeps scanning for one that does", () => {
      const live = liveBoards(snapshot, "page-1", {
        recentBoards: [P1, P2, P3],
        byteLengths: { [P1]: 0, [P2]: 90_000, [P3]: 0 },
        slotBudget: 3,
      });
      // P1 costs 1 (used=1). P2 costs 3: 1+3=4 > 3, so it is skipped, but
      // scanning continues to P3, which costs 1 and fits (used=2).
      expect(live).toEqual(new Set([P1, P3]));
    });

    it("always admits the first candidate even when it alone overshoots the budget", () => {
      const live = liveBoards(snapshot, "page-1", {
        recentBoards: [P2],
        byteLengths: { [P2]: 400_000 },
        slotBudget: 2,
      });
      expect(live).toEqual(new Set([P2]));
    });

    it("excludes a candidate the byte-length map has no entry for", () => {
      const live = liveBoards(snapshot, "page-1", {
        recentBoards: [P1, P2],
        byteLengths: { [P1]: 0 },
        slotBudget: 5,
      });
      expect(live).toEqual(new Set([P1]));
    });

    it("treats every board as weight 1 when no byte-length map is given", () => {
      const live = liveBoards(snapshot, "page-1", {
        recentBoards: [P1, P2, P3],
        byteLengths: null,
        slotBudget: 2,
      });
      expect(live.size).toBe(2);
    });
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
    expect(
      liveBoards(snapshot, "page-1", {
        viewport: { x: 700, y: 400, w: 0, h: 0 },
        slotBudget: 1,
      }),
    ).toEqual(new Set([NEAR]));
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
