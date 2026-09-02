import { describe, expect, it } from "vitest";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import type {
  OfficeAgentInput,
  OfficeAppearance,
  OfficeLayout,
  OfficeRoom,
  OfficeTilePos,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";

const APPEARANCE: OfficeAppearance = {
  skin: "#e0b08a",
  hair: "#3a2a1a",
  hairStyle: 0,
  shirt: "#3b6fd6",
  pants: "#22262b",
  accent: "#7fd6ff",
};

function agent(
  overrides: Partial<OfficeAgentInput> & { readonly id: string },
): OfficeAgentInput {
  return {
    name: overrides.id,
    kind: "chat",
    harnessId: null,
    model: null,
    parentId: null,
    archived: false,
    createdAt: 0,
    appearance: APPEARANCE,
    ...overrides,
  };
}

function deskColumns(layout: OfficeLayout): ReadonlyArray<string> {
  return Array.from(layout.desks.keys());
}

function tileOf(layout: OfficeLayout, agentId: string): OfficeTilePos {
  const desk = layout.desks.get(agentId);
  if (desk === undefined) throw new Error(`no desk for ${agentId}`);
  return desk.deskTile;
}

function roomOf(layout: OfficeLayout, rootAgentId: string): OfficeRoom {
  const room = layout.rooms.find(
    (candidate) => candidate.rootAgentId === rootAgentId,
  );
  if (room === undefined) throw new Error(`no cabin for ${rootAgentId}`);
  return room;
}

function within(bounds: OfficeTileRect, tile: OfficeTilePos): boolean {
  return (
    tile.col >= bounds.col &&
    tile.col < bounds.col + bounds.cols &&
    tile.row >= bounds.row &&
    tile.row < bounds.row + bounds.rows
  );
}

function partitionTiles(layout: OfficeLayout): ReadonlyArray<OfficeTilePos> {
  return layout.props
    .filter((prop) => prop.sprite.name === "partition")
    .map((prop) => prop.tile);
}

describe("layoutOffice", () => {
  it("renders a minimal room with a door and no desks when empty", () => {
    const layout = layoutOffice([]);

    expect(layout.cols).toBe(8);
    expect(layout.rows).toBe(6);
    expect(layout.desks.size).toBe(0);
    expect(layout.rooms).toEqual([]);
    expect(layout.doorTile).toEqual({ col: 3, row: 5 });
    expect(layout.lobbyTile).toEqual({ col: 3, row: 4 });
    expect(layout.walkable[layout.doorTile.row][layout.doorTile.col]).toBe(
      true,
    );
    expect(layout.walkable[layout.lobbyTile.row][layout.lobbyTile.col]).toBe(
      true,
    );
  });

  it("seats a family contiguously and gives only the root a plant", () => {
    const layout = layoutOffice([
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "child-1", parentId: "root-a", createdAt: 2 }),
      agent({ id: "child-2", parentId: "root-a", createdAt: 3 }),
      agent({ id: "root-b", createdAt: 4 }),
    ]);

    // Root, then its subtree, then the next root - never interleaved.
    expect(deskColumns(layout)).toEqual([
      "root-a",
      "child-1",
      "child-2",
      "root-b",
    ]);
    expect(layout.desks.get("root-a")?.manager).toBe(true);
    expect(layout.desks.get("root-b")?.manager).toBe(true);
    expect(layout.desks.get("child-1")?.manager).toBe(false);
    expect(layout.desks.get("child-2")?.manager).toBe(false);

    const plants = layout.props
      .filter((prop) => prop.sprite.name === "plant")
      .map((prop) => prop.tile);
    const rootA = tileOf(layout, "root-a");
    const rootB = tileOf(layout, "root-b");
    expect(plants).toEqual([
      { col: rootA.col + 2, row: rootA.row },
      { col: rootB.col + 2, row: rootB.row },
    ]);
  });

  it("keeps every slot the same width whether or not it holds a plant", () => {
    const layout = layoutOffice([
      agent({ id: "root", createdAt: 1 }),
      agent({ id: "child", parentId: "root", createdAt: 2 }),
    ]);

    // A manager-only widening would make a desk's column depend on how many
    // managers precede it, so promoting one agent would shuffle the floor.
    expect(tileOf(layout, "child").col - tileOf(layout, "root").col).toBe(5);
  });

  it("is a pure function of the set, not of the input array's order", () => {
    const agents = [
      agent({ id: "root", createdAt: 1 }),
      agent({ id: "child-b", parentId: "root", createdAt: 3 }),
      agent({ id: "child-a", parentId: "root", createdAt: 2 }),
    ];

    const forward = layoutOffice(agents);
    const reversed = layoutOffice([...agents].reverse());

    expect(deskColumns(reversed)).toEqual(deskColumns(forward));
    expect(reversed.desks).toEqual(forward.desks);
    expect(reversed.props).toEqual(forward.props);
    expect(reversed.walkable).toEqual(forward.walkable);
  });

  it("appends a newer agent without moving the desks already placed", () => {
    const existing = [1, 2, 3, 4, 5].map((index) =>
      agent({ id: `agent-${index}`, createdAt: index }),
    );
    const before = layoutOffice(existing);
    const after = layoutOffice([
      ...existing,
      agent({ id: "agent-6", createdAt: 6 }),
    ]);

    expect(after.cols).toBe(before.cols);
    expect(after.rows).toBe(before.rows);
    for (const existingAgent of existing) {
      expect(after.desks.get(existingAgent.id)).toEqual(
        before.desks.get(existingAgent.id),
      );
    }
  });

  it("blocks desks, chairs and props but leaves the door and rug open", () => {
    const layout = layoutOffice([
      agent({ id: "root", createdAt: 1 }),
      agent({ id: "child", parentId: "root", createdAt: 2 }),
    ]);

    for (const desk of layout.desks.values()) {
      expect(layout.walkable[desk.deskTile.row][desk.deskTile.col]).toBe(false);
      expect(layout.walkable[desk.deskTile.row][desk.deskTile.col + 1]).toBe(
        false,
      );
      // Blocked for everyone in the general grid; the path finder grants the
      // owning agent its exception by always allowing its own goal.
      expect(layout.walkable[desk.chairTile.row][desk.chairTile.col]).toBe(
        false,
      );
    }
    for (const prop of layout.props) {
      const walkable = layout.walkable[prop.tile.row][prop.tile.col];
      expect(walkable).toBe(prop.sprite.name === "rug");
    }
    expect(layout.walkable[layout.doorTile.row][layout.doorTile.col]).toBe(
      true,
    );
    expect(layout.walkable[0][0]).toBe(false);
    expect(layout.walkable[1][1]).toBe(false);
  });

  it("mounts the whiteboard and windows on the wall face", () => {
    const layout = layoutOffice([agent({ id: "solo", createdAt: 1 })]);

    const mounted = layout.props.filter(
      (prop) =>
        prop.sprite.name === "whiteboard" || prop.sprite.name === "window",
    );
    expect(mounted.length).toBeGreaterThan(1);
    for (const prop of mounted) expect(prop.tile.row).toBe(1);
    expect(
      layout.props.some((prop) => prop.sprite.name === "coffee-machine"),
    ).toBe(true);
  });

  it("gives every root a cabin and keeps its whole subtree inside it", () => {
    const layout = layoutOffice([
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "child-a", parentId: "root-a", createdAt: 2 }),
      agent({ id: "grandchild-a", parentId: "child-a", createdAt: 3 }),
      agent({ id: "root-b", createdAt: 4 }),
      agent({ id: "child-b", parentId: "root-b", createdAt: 5 }),
    ]);

    expect(layout.rooms.map((room) => room.rootAgentId)).toEqual([
      "root-a",
      "root-b",
    ]);

    const familyA = ["root-a", "child-a", "grandchild-a"];
    const familyB = ["root-b", "child-b"];
    const boundsA = roomOf(layout, "root-a").bounds;
    const boundsB = roomOf(layout, "root-b").bounds;
    for (const id of familyA) {
      expect(within(boundsA, tileOf(layout, id)), id).toBe(true);
      expect(within(boundsB, tileOf(layout, id)), id).toBe(false);
    }
    for (const id of familyB) {
      expect(within(boundsB, tileOf(layout, id)), id).toBe(true);
      expect(within(boundsA, tileOf(layout, id)), id).toBe(false);
    }
    // Only the cabin's own root manages it, however deep the lineage runs.
    expect(layout.desks.get("child-a")?.manager).toBe(false);
    expect(layout.desks.get("grandchild-a")?.manager).toBe(false);
    expect(layout.desks.get("root-b")?.manager).toBe(true);
  });

  it("signs each cabin's wall face and opens a door in its bottom wall", () => {
    const layout = layoutOffice([
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "child-a", parentId: "root-a", createdAt: 2 }),
      agent({ id: "root-b", createdAt: 3 }),
    ]);

    for (const room of layout.rooms) {
      const { col, row, cols, rows } = room.bounds;
      // The sign hangs on the wall FACE - the row under the cap, the same row
      // the building mounts its own fittings on.
      expect(room.signTile.row).toBe(row + 1);
      expect(room.signTile.col).toBe(col + 1);
      // ...and its two tiles stay on that wall.
      expect(room.signTile.col + 1).toBeLessThan(col + cols);

      expect(room.doorTile.row).toBe(row + rows - 1);
      expect(room.doorTile.col).toBeGreaterThan(col);
      expect(room.doorTile.col).toBeLessThan(col + cols - 1);
      expect(layout.walkable[room.doorTile.row][room.doorTile.col]).toBe(true);

      // Everything else on that bottom wall is wall.
      for (let scan = col; scan < col + cols; scan += 1) {
        if (scan === room.doorTile.col) continue;
        expect(layout.walkable[row + rows - 1][scan]).toBe(false);
      }
      expect(layout.walkable[row][col]).toBe(false);
      expect(layout.walkable[row + 1][col]).toBe(false);
    }
  });

  it("routes the lobby to every cabin door and every chair", () => {
    const agents = [
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "child-a1", parentId: "root-a", createdAt: 2 }),
      agent({ id: "child-a2", parentId: "root-a", createdAt: 3 }),
      agent({ id: "child-a3", parentId: "root-a", createdAt: 4 }),
      agent({ id: "root-b", createdAt: 5 }),
      agent({ id: "child-b1", parentId: "root-b", createdAt: 6 }),
      agent({ id: "root-c", createdAt: 7 }),
    ];
    const layout = layoutOffice(agents);

    // A cabin nobody can reach is a cabin nobody can be seated in, so this is
    // the invariant the corridor row under the lowest band exists for.
    for (const room of layout.rooms) {
      expect(
        findOfficePath(layout, layout.lobbyTile, room.doorTile),
        `${room.rootAgentId} door unreachable`,
      ).not.toBeNull();
    }
    for (const person of agents) {
      const desk = layout.desks.get(person.id);
      if (desk === undefined) throw new Error(`no desk for ${person.id}`);
      expect(
        findOfficePath(layout, layout.doorTile, desk.chairTile),
        `${person.id} chair unreachable`,
      ).not.toBeNull();
    }
  });

  it("partitions off a sub-cluster but never the cabin's own root", () => {
    const layout = layoutOffice([
      agent({ id: "root", createdAt: 1 }),
      agent({ id: "lead", parentId: "root", createdAt: 2 }),
      agent({ id: "lead-kid-1", parentId: "lead", createdAt: 3 }),
      agent({ id: "lead-kid-2", parentId: "lead", createdAt: 4 }),
      agent({ id: "solo", parentId: "root", createdAt: 5 }),
      agent({ id: "solo-kid", parentId: "solo", createdAt: 6 }),
    ]);

    // The root also has two children, but a cabin is already its own division -
    // only a pod INSIDE one earns a divider.
    const lead = tileOf(layout, "lead");
    expect(partitionTiles(layout)).toEqual([
      { col: lead.col - 1, row: lead.row },
    ]);
    for (const tile of partitionTiles(layout)) {
      expect(layout.walkable[tile.row][tile.col]).toBe(false);
      // Never over furniture: a divider takes an aisle tile or nothing.
      for (const desk of layout.desks.values()) {
        expect(desk.deskTile).not.toEqual(tile);
        expect(desk.chairTile).not.toEqual(tile);
      }
    }
  });

  it("keeps cabin order and membership stable as a family grows", () => {
    const existing = [
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "child-a", parentId: "root-a", createdAt: 2 }),
      agent({ id: "root-b", createdAt: 3 }),
      agent({ id: "root-c", createdAt: 4 }),
    ];
    const before = layoutOffice(existing);
    const after = layoutOffice([
      ...existing,
      agent({ id: "child-a2", parentId: "root-a", createdAt: 5 }),
    ]);

    // Cabins never reorder: the newcomer joins its family's room, and every
    // other room stays exactly where it was.
    expect(after.rooms.map((room) => room.rootAgentId)).toEqual(
      before.rooms.map((room) => room.rootAgentId),
    );
    // A cabin ahead of the one that grew is untouched...
    expect(roomOf(after, "root-b")).toEqual(roomOf(before, "root-b"));
    expect(after.desks.get("root-b")).toEqual(before.desks.get("root-b"));
    // ...and one in a later band keeps its own shape; only the band it sits
    // in slides down, because the band above it got taller.
    const cBefore = roomOf(before, "root-c").bounds;
    const cAfter = roomOf(after, "root-c").bounds;
    expect(cAfter.cols).toBe(cBefore.cols);
    expect(cAfter.rows).toBe(cBefore.rows);
    expect(cAfter.col).toBe(cBefore.col);
    expect(cAfter.row).toBeGreaterThanOrEqual(cBefore.row);
    for (const id of ["root-a", "child-a", "child-a2"]) {
      expect(
        within(roomOf(after, "root-a").bounds, tileOf(after, id)),
        id,
      ).toBe(true);
    }
  });

  it("names each cabin after the agent whose room it is", () => {
    const layout = layoutOffice([
      agent({ id: "root-a", name: "Planner", createdAt: 1 }),
      agent({
        id: "child-a",
        name: "Worker",
        parentId: "root-a",
        createdAt: 2,
      }),
    ]);

    expect(layout.rooms).toHaveLength(1);
    expect(layout.rooms[0].name).toBe("Planner");
  });
});
