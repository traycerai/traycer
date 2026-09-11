import { describe, expect, it, vi } from "vitest";
import { countingArrayCtor } from "@/lib/comm-graph/office/__tests__/counting-array-ctor";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import {
  findOfficePath,
  officePathScratch,
} from "@/lib/comm-graph/office/office-path";
import type {
  OfficeAgentInput,
  OfficeAppearance,
  OfficeLayout,
  OfficeTilePos,
} from "@/lib/comm-graph/office/office-types";

const APPEARANCE: OfficeAppearance = {
  skin: "#e0b08a",
  hair: "#3a2a1a",
  hairStyle: 0,
  shirt: "#3b6fd6",
  pants: "#22262b",
  accent: "#7fd6ff",
};

function agent(id: string, createdAt: number): OfficeAgentInput {
  return {
    id,
    name: id,
    kind: "chat",
    hostId: null,
    archivedAt: null,
    modelTier: "medium",
    harnessId: null,
    model: null,
    parentId: null,
    archived: false,
    createdAt,
    appearance: APPEARANCE,
  };
}

function sealedLayout(): OfficeLayout {
  const walkable = [
    [true, false, false],
    [false, false, false],
    [false, false, true],
  ];
  return {
    view: "floor",
    cols: 3,
    rows: 3,
    desks: new Map(),
    seats: new Map(),
    signs: [],
    rooms: [],
    floors: [],
    doorTile: { col: 0, row: 0 },
    lobbyTile: { col: 0, row: 0 },
    props: [],
    walkable,
    frozen: null,
    shiftFromPrevious: null,
    stable: false,
  };
}

function isAdjacent(left: OfficeTilePos, right: OfficeTilePos): boolean {
  return Math.abs(left.col - right.col) + Math.abs(left.row - right.row) === 1;
}

describe("findOfficePath", () => {
  const layout = layoutOffice([
    agent("root", 1),
    agent("second", 2),
    agent("third", 3),
    agent("fourth", 4),
  ]);

  it("walks from the door to a chair without crossing furniture", () => {
    const desk = layout.desks.get("fourth");
    if (desk === undefined) throw new Error("expected a desk");

    const path = findOfficePath(layout, layout.doorTile, desk.chairTile);
    if (path === null) throw new Error("expected a route to the chair");

    expect(path.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual(desk.chairTile);
    expect(isAdjacent(layout.doorTile, path[0])).toBe(true);
    for (let index = 1; index < path.length; index += 1) {
      expect(isAdjacent(path[index - 1], path[index])).toBe(true);
    }
    // Every tile short of the goal must be genuinely walkable - that is what
    // makes routing around desks and other agents' chairs observable.
    for (const tile of path.slice(0, -1)) {
      expect(layout.walkable[tile.row][tile.col]).toBe(true);
    }
    const deskTiles = new Set<string>();
    for (const seat of layout.desks.values()) {
      deskTiles.add(`${seat.deskTile.col},${seat.deskTile.row}`);
      deskTiles.add(`${seat.deskTile.col + 1},${seat.deskTile.row}`);
    }
    for (const tile of path) {
      expect(deskTiles.has(`${tile.col},${tile.row}`)).toBe(false);
    }
  });

  it("enters a cabin only through that cabin's own door", () => {
    const room = layout.rooms.find(
      (candidate) => candidate.rootAgentId === "fourth",
    );
    const desk = layout.desks.get("fourth");
    if (room === undefined || desk === undefined) {
      throw new Error("expected a cabin with a desk");
    }

    const path = findOfficePath(layout, layout.lobbyTile, desk.chairTile);
    if (path === null) throw new Error("expected a route into the cabin");

    // The walls are load-bearing for the fiction: a character that could cut
    // through one would make the nesting meaningless.
    expect(
      path.some(
        (tile) =>
          tile.col === room.doorTile.col && tile.row === room.doorTile.row,
      ),
    ).toBe(true);
  });

  it("returns an empty route when the walker is already there", () => {
    expect(findOfficePath(layout, layout.lobbyTile, layout.lobbyTile)).toEqual(
      [],
    );
  });

  it("enters a blocked goal tile, which is how a chair is ever reached", () => {
    const desk = layout.desks.get("root");
    if (desk === undefined) throw new Error("expected a desk");
    const below = { col: desk.chairTile.col, row: desk.chairTile.row + 1 };

    expect(layout.walkable[desk.chairTile.row][desk.chairTile.col]).toBe(false);
    expect(findOfficePath(layout, below, desk.chairTile)).toEqual([
      desk.chairTile,
    ]);
  });

  it("routes out of a chair it is standing on", () => {
    const desk = layout.desks.get("second");
    if (desk === undefined) throw new Error("expected a desk");

    const path = findOfficePath(layout, desk.chairTile, layout.lobbyTile);
    if (path === null) throw new Error("expected a route off the chair");
    expect(path[path.length - 1]).toEqual(layout.lobbyTile);
  });

  it("returns null when nothing connects the two tiles", () => {
    expect(
      findOfficePath(sealedLayout(), { col: 0, row: 0 }, { col: 2, row: 2 }),
    ).toBeNull();
  });

  it("returns null for a tile outside the room", () => {
    expect(
      findOfficePath(layout, layout.lobbyTile, { col: -1, row: 0 }),
    ).toBeNull();
    expect(
      findOfficePath(layout, layout.lobbyTile, {
        col: layout.cols,
        row: layout.rows,
      }),
    ).toBeNull();
  });

  it("grows its working grids once for a layout, not once per search", () => {
    // A search used to allocate two full-grid typed arrays every time it ran,
    // and a sync of a live office runs dozens of them. The capacity and
    // growth counters below are the scratch's own bookkeeping, and stay green
    // for a version that reverted to `new Int32Array(cellCount)` and
    // `new Uint8Array(cellCount)` at the two working-buffer bindings while
    // leaving that bookkeeping untouched - so a transparent constructor proxy
    // watches for the allocation itself over several warmed searches, not
    // only the counters a correct implementation happens to also produce.
    const desks = [...layout.desks.values()];
    findOfficePath(layout, layout.doorTile, desks[0].chairTile);
    const first = officePathScratch();

    const intCtor = Int32Array;
    const byteCtor = Uint8Array;
    let ints = 0;
    let bytes = 0;
    vi.stubGlobal(
      "Int32Array",
      countingArrayCtor(intCtor, () => {
        ints += 1;
      }),
    );
    vi.stubGlobal(
      "Uint8Array",
      countingArrayCtor(byteCtor, () => {
        bytes += 1;
      }),
    );
    try {
      for (const desk of desks) {
        findOfficePath(layout, layout.doorTile, desk.chairTile);
        findOfficePath(layout, desk.chairTile, layout.lobbyTile);
      }
    } finally {
      // A stub left in place breaks every later suite's typed arrays, so this
      // has to come off even if an assertion above throws.
      vi.unstubAllGlobals();
    }

    const after = officePathScratch();
    expect(after.growths).toBe(first.growths);
    expect(after.capacity).toBeGreaterThanOrEqual(layout.cols * layout.rows);
    // THE ACTUAL ALLOCATION: zero of each type, once the first search above
    // has already sized the buffers to this layout.
    expect({ ints, bytes }).toEqual({ ints: 0, bytes: 0 });
  });

  it("keeps a grid big enough for the largest office it has searched", () => {
    const small = sealedLayout();
    const before = officePathScratch();

    findOfficePath(small, { col: 0, row: 0 }, { col: 2, row: 2 });

    // The big layout above has already run, so a three-by-three floor reuses
    // what is there rather than shrinking it and growing it back.
    const after = officePathScratch();
    expect(after.capacity).toBe(before.capacity);
    expect(after.growths).toBe(before.growths);
  });

  it("counts every constructor form, not only the length one", () => {
    // The guards above are only sound while the stand-in is INVISIBLE, and a
    // version that forwarded `new Ctor(length)` alone was not: an array, a
    // typed array or a buffer view all came back empty, and nothing in this
    // file would have said so - the counts it exists to produce were right.
    // These are the four forms, plus a native method over the result.
    const intCtor = Int32Array;
    const buffer = new ArrayBuffer(16);
    new Int32Array(buffer).set([5, 20, 30, 40]);
    let ints = 0;

    vi.stubGlobal(
      "Int32Array",
      countingArrayCtor(intCtor, () => {
        ints += 1;
      }),
    );
    try {
      expect([...new Int32Array(3)]).toEqual([0, 0, 0]);
      expect([...new Int32Array([7, 11])]).toEqual([7, 11]);
      expect([...new Int32Array(new Int32Array([7, 11]))]).toEqual([7, 11]);

      // A view keeps its offset and its BUFFER, which is the form a stub that
      // rebuilt from a length silently turned into two zeroes.
      const view = new Int32Array(buffer, 4, 2);
      expect([...view]).toEqual([20, 30]);
      expect(view.byteOffset).toBe(4);
      expect(view.buffer).toBe(buffer);

      expect([
        ...new Int32Array([1, 2, 3]).filter((value) => value > 1),
      ]).toEqual([2, 3]);
    } finally {
      vi.unstubAllGlobals();
    }

    // Six `new` expressions above, one of them nested; `filter` builds its
    // result through the real constructor on the prototype, not the stub.
    expect(ints).toBe(6);
  });

  it("finds the same route whichever search ran before it", () => {
    // The grids are shared between calls, so a stale cell left by the previous
    // search would show up as a route that depends on history.
    const desk = layout.desks.get("fourth");
    if (desk === undefined) throw new Error("expected a desk");
    const alone = findOfficePath(layout, layout.doorTile, desk.chairTile);

    findOfficePath(layout, layout.lobbyTile, layout.doorTile);
    findOfficePath(sealedLayout(), { col: 0, row: 0 }, { col: 2, row: 2 });

    expect(findOfficePath(layout, layout.doorTile, desk.chairTile)).toEqual(
      alone,
    );
  });
});
