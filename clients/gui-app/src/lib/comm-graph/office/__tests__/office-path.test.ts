import { describe, expect, it } from "vitest";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
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
    cols: 3,
    rows: 3,
    desks: new Map(),
    rooms: [],
    doorTile: { col: 0, row: 0 },
    lobbyTile: { col: 0, row: 0 },
    props: [],
    walkable,
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
});
