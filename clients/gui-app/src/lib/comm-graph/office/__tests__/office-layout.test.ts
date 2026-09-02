import { describe, expect, it } from "vitest";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import type {
  OfficeAgentInput,
  OfficeAppearance,
  OfficeFloor,
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
    hostId: null,
    archivedAt: null,
    modelTier: "medium",
    harnessId: null,
    model: null,
    parentId: null,
    archived: false,
    createdAt: 0,
    appearance: APPEARANCE,
    ...overrides,
  };
}

function floorOfRow(layout: OfficeLayout, row: number): OfficeFloor {
  const found = layout.floors.find(
    (floor) =>
      row >= floor.bounds.row && row < floor.bounds.row + floor.bounds.rows,
  );
  if (found === undefined) throw new Error(`no floor at row ${row}`);
  return found;
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

/** Every tile of a rectangle's own wall ring, in a stable order. */
function wallRingTiles(bounds: OfficeTileRect): ReadonlyArray<OfficeTilePos> {
  const right = bounds.col + bounds.cols - 1;
  const bottom = bounds.row + bounds.rows - 1;
  const tiles: OfficeTilePos[] = [];
  for (let col = bounds.col; col <= right; col += 1) {
    tiles.push({ col, row: bounds.row });
    tiles.push({ col, row: bottom });
  }
  for (let row = bounds.row + 1; row < bottom; row += 1) {
    tiles.push({ col: bounds.col, row });
    tiles.push({ col: right, row });
  }
  return tiles;
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
      const floor = floorOfRow(layout, room.bounds.row);
      expect(
        findOfficePath(layout, floor.lobbyTile, room.doorTile),
        `${room.rootAgentId} door unreachable`,
      ).not.toBeNull();
    }
    for (const person of agents) {
      const desk = layout.desks.get(person.id);
      if (desk === undefined) throw new Error(`no desk for ${person.id}`);
      const floor = floorOfRow(layout, desk.deskTile.row);
      expect(
        findOfficePath(layout, floor.doorTile, desk.chairTile),
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

  it("never overlaps two cabins, whatever the families look like", () => {
    // Sizes chosen to span every cabin shape: a lone root, a wide one that
    // fills a band, and enough of them to wrap into several bands.
    const agents: OfficeAgentInput[] = [];
    let createdAt = 0;
    for (let family = 0; family < 7; family += 1) {
      createdAt += 1;
      const rootId = `root-${family}`;
      agents.push(agent({ id: rootId, createdAt }));
      for (let child = 0; child < family * 2; child += 1) {
        createdAt += 1;
        agents.push(
          agent({ id: `${rootId}-c${child}`, parentId: rootId, createdAt }),
        );
      }
    }
    const layout = layoutOffice(agents);

    // An overlap is invisible in the plan and catastrophic on screen: one
    // cabin's wall ring would be painted straight through the other's floor.
    for (const room of layout.rooms) {
      for (const other of layout.rooms) {
        if (other === room) continue;
        const separated =
          room.bounds.col + room.bounds.cols <= other.bounds.col ||
          other.bounds.col + other.bounds.cols <= room.bounds.col ||
          room.bounds.row + room.bounds.rows <= other.bounds.row ||
          other.bounds.row + other.bounds.rows <= room.bounds.row;
        expect(
          separated,
          `${room.rootAgentId} overlaps ${other.rootAgentId}`,
        ).toBe(true);
      }
      // ...and no cabin may run off the building it stands in.
      expect(room.bounds.col).toBeGreaterThan(0);
      expect(room.bounds.row).toBeGreaterThan(1);
      expect(room.bounds.col + room.bounds.cols).toBeLessThan(layout.cols);
      expect(room.bounds.row + room.bounds.rows).toBeLessThan(layout.rows);
    }
    // Every agent still has a desk, and every desk is inside some cabin.
    expect(layout.desks.size).toBe(agents.length);
    for (const desk of layout.desks.values()) {
      expect(
        layout.rooms.some((room) => within(room.bounds, desk.deskTile)),
        desk.agentId,
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

const SINGLE_HOST: ReadonlyArray<OfficeAgentInput> = [
  agent({ id: "root-a", hostId: "host-a", createdAt: 1 }),
  agent({ id: "child-a", hostId: "host-a", parentId: "root-a", createdAt: 2 }),
];
const TWO_HOSTS: ReadonlyArray<OfficeAgentInput> = [
  ...SINGLE_HOST,
  agent({ id: "root-b", hostId: "host-b", createdAt: 3 }),
  agent({ id: "child-b", hostId: "host-b", parentId: "root-b", createdAt: 4 }),
];

describe("layoutOffice floors", () => {
  it("gives a single-host epic exactly one floor and the building's own door", () => {
    const layout = layoutOffice(SINGLE_HOST);

    expect(layout.floors).toHaveLength(1);
    expect(layout.floors[0].hostId).toBe("host-a");
    expect(layout.floors[0].doorTile).toEqual(layout.doorTile);
    expect(layout.floors[0].lobbyTile).toEqual(layout.lobbyTile);
    // Nothing to climb to, so nothing to climb.
    expect(layout.floors[0].stairsTile).toBeNull();
  });

  it("keeps a single host's geometry exactly where it always was", () => {
    const hostless = layoutOffice([
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "child-a", parentId: "root-a", createdAt: 2 }),
    ]);
    const hosted = layoutOffice(SINGLE_HOST);

    // One group is one storey, whether or not that group happens to name a
    // host: grouping must not move a desk.
    expect(hosted.cols).toBe(hostless.cols);
    expect(hosted.rows).toBe(hostless.rows);
    expect(hosted.desks).toEqual(hostless.desks);
    expect(hosted.doorTile).toEqual(hostless.doorTile);
  });

  it("stacks one floor per host, in host-id order with the hostless last", () => {
    const layout = layoutOffice([
      ...TWO_HOSTS,
      agent({ id: "legacy", createdAt: 5 }),
    ]);

    expect(layout.floors.map((floor) => floor.hostId)).toEqual([
      "host-a",
      "host-b",
      null,
    ]);
    // Each storey sits below the last, sharing exactly one wall row with it.
    for (let index = 1; index < layout.floors.length; index += 1) {
      const above = layout.floors[index - 1];
      expect(layout.floors[index].bounds.row).toBe(
        above.bounds.row + above.bounds.rows - 1,
      );
    }
    // ...and the building is exactly as tall as the stack.
    const last = layout.floors[layout.floors.length - 1];
    expect(layout.rows).toBe(last.bounds.row + last.bounds.rows);
    expect(layout.doorTile).toEqual(layout.floors[0].doorTile);
  });

  it("never lets a walk cross between two floors", () => {
    const layout = layoutOffice(TWO_HOSTS);
    expect(layout.floors).toHaveLength(2);

    const deskA = layout.desks.get("root-a");
    const deskB = layout.desks.get("root-b");
    if (deskA === undefined || deskB === undefined) {
      throw new Error("expected a desk on each floor");
    }
    // Messaging is host-local, so there is nothing to walk between - and a
    // route that existed would let a character stroll out of its own epic
    // half.
    expect(findOfficePath(layout, deskA.chairTile, deskB.chairTile)).toBeNull();
    expect(
      findOfficePath(layout, layout.floors[0].lobbyTile, deskB.chairTile),
    ).toBeNull();
    expect(
      findOfficePath(layout, layout.floors[1].lobbyTile, deskA.chairTile),
    ).toBeNull();
  });

  it("routes each floor's own lobby to every cabin on that floor", () => {
    const layout = layoutOffice(TWO_HOSTS);

    for (const room of layout.rooms) {
      const floor = floorOfRow(layout, room.bounds.row);
      expect(
        findOfficePath(layout, floor.lobbyTile, room.doorTile),
        `${room.rootAgentId} door unreachable`,
      ).not.toBeNull();
    }
    for (const desk of layout.desks.values()) {
      const floor = floorOfRow(layout, desk.deskTile.row);
      expect(
        findOfficePath(layout, floor.doorTile, desk.chairTile),
        `${desk.agentId} chair unreachable`,
      ).not.toBeNull();
    }
  });

  it("fits every floor with a reception, a queue, a clock and stairs", () => {
    const layout = layoutOffice(TWO_HOSTS);

    for (const floor of layout.floors) {
      // The counter stands on the lobby row, left of the door and clear of it.
      expect(floor.receptionTile.row).toBe(floor.lobbyTile.row);
      expect(floor.receptionTile.col + 1).toBeLessThan(floor.doorTile.col);
      expect(
        layout.walkable[floor.receptionTile.row][floor.receptionTile.col],
      ).toBe(false);
      expect(
        layout.walkable[floor.receptionTile.row][floor.receptionTile.col + 1],
      ).toBe(false);

      // The queue is somewhere a person can actually stand, and never in the
      // doorway or on the lobby tile itself.
      expect(floor.receptionQueueTiles.length).toBeGreaterThan(0);
      expect(floor.receptionQueueTiles.length).toBeLessThanOrEqual(6);
      for (const tile of floor.receptionQueueTiles) {
        expect(
          layout.walkable[tile.row][tile.col],
          `${tile.col},${tile.row}`,
        ).toBe(true);
        expect(tile).not.toEqual(floor.doorTile);
        expect(tile).not.toEqual(floor.lobbyTile);
      }

      // The clock hangs on this storey's own wall face, right of the
      // whiteboard, and takes a tile nobody can stand on.
      expect(floor.clockTile.row).toBe(floor.bounds.row + 1);
      expect(floor.clockTile.col).toBeGreaterThan(2);
      expect(layout.walkable[floor.clockTile.row][floor.clockTile.col]).toBe(
        false,
      );

      const stairs = floor.stairsTile;
      if (stairs === null)
        throw new Error("expected stairs on a stacked floor");
      // Two tiles square, decorative, and off-limits in every one of them.
      for (let dCol = 0; dCol < 2; dCol += 1) {
        for (let dRow = 0; dRow < 2; dRow += 1) {
          expect(layout.walkable[stairs.row + dRow][stairs.col + dCol]).toBe(
            false,
          );
        }
      }
    }
    // One clock and one counter per storey, never a shared pair.
    const clocks = layout.props.filter((prop) => prop.sprite.name === "clock");
    const desks = layout.props.filter(
      (prop) => prop.sprite.name === "reception",
    );
    expect(clocks).toHaveLength(layout.floors.length);
    expect(desks).toHaveLength(layout.floors.length);
    // The stairwell is FLOOR, not furniture: the scene paints it, so the plan
    // carries no prop for it.
    expect(layout.props.some((prop) => prop.sprite.name === "stairs")).toBe(
      false,
    );
  });

  it("queues on the bell's side of the counter first", () => {
    const layout = layoutOffice(SINGLE_HOST);
    const floor = layout.floors[0];

    // The bell is at the counter's right end, so the nearest slot is the one
    // beside it rather than the one at the far end.
    const nearest = floor.receptionQueueTiles[0];
    expect(nearest.col).toBeGreaterThanOrEqual(floor.receptionTile.col + 1);
  });

  it("splits a family across floors when its members live on two hosts", () => {
    const layout = layoutOffice([
      agent({ id: "root", hostId: "host-a", createdAt: 1 }),
      agent({
        id: "remote-child",
        hostId: "host-b",
        parentId: "root",
        createdAt: 2,
      }),
    ]);

    // A child on another machine cannot sit inside its creator's cabin, so it
    // opens its own room on its own storey.
    expect(layout.floors).toHaveLength(2);
    expect(layout.rooms.map((room) => room.rootAgentId)).toEqual([
      "root",
      "remote-child",
    ]);
    const deskA = layout.desks.get("root");
    const deskB = layout.desks.get("remote-child");
    if (deskA === undefined || deskB === undefined) {
      throw new Error("expected both desks");
    }
    expect(floorOfRow(layout, deskA.deskTile.row).hostId).toBe("host-a");
    expect(floorOfRow(layout, deskB.deskTile.row).hostId).toBe("host-b");
  });

  it("is a pure function of the set on a stacked building too", () => {
    const forward = layoutOffice(TWO_HOSTS);
    const reversed = layoutOffice([...TWO_HOSTS].reverse());

    expect(reversed.desks).toEqual(forward.desks);
    expect(reversed.floors).toEqual(forward.floors);
    expect(reversed.walkable).toEqual(forward.walkable);
  });

  it("walls a cafeteria into every storey's top-right corner", () => {
    const layout = layoutOffice(TWO_HOSTS);

    expect(layout.floors.length).toBeGreaterThan(1);
    for (const floor of layout.floors) {
      const bounds = floor.cafeteria;
      if (bounds === null) throw new Error("expected a cafeteria");
      // Hard against the outer wall on the right, and starting on the first
      // interior row - the corner, not merely somewhere on the right.
      expect(bounds.col + bounds.cols).toBe(layout.cols - 1);
      expect(bounds.row).toBe(floor.bounds.row + 2);
      expect(bounds.row + bounds.rows).toBeLessThan(
        floor.bounds.row + floor.bounds.rows - 1,
      );

      // Exactly one way in: a break room with two holes in its wall is a
      // corridor, and one with none is a picture of a break room.
      const openings = wallRingTiles(bounds).filter(
        (tile) => layout.walkable[tile.row][tile.col],
      );
      expect(openings).toHaveLength(1);
      // ...and it opens onto a tile the rest of the floor can stand on.
      const outside = { col: openings[0].col, row: openings[0].row + 1 };
      expect(layout.walkable[outside.row][outside.col]).toBe(true);
    }
  });

  it("moves the coffee machine and the cooler inside the cafeteria", () => {
    const layout = layoutOffice(SINGLE_HOST);
    const bounds = layout.floors[0].cafeteria;
    if (bounds === null) throw new Error("expected a cafeteria");

    // The machine used to stand in the open corner. Nothing outside the break
    // room should still be a break-room fixture, or the errand system would be
    // sending people to two different coffees.
    const fixtures = layout.props.filter((prop) =>
      ["coffee-machine", "water-cooler", "vending", "cafe-table"].includes(
        prop.sprite.name,
      ),
    );
    expect(fixtures.length).toBe(5);
    for (const prop of fixtures) {
      expect(within(bounds, prop.tile), prop.sprite.name).toBe(true);
    }
    // The board hangs on the room's own wall FACE, the row under its cap, the
    // way a cabin's sign does.
    const board = layout.props.filter(
      (prop) => prop.sprite.name === "menu-board",
    );
    expect(board).toHaveLength(1);
    expect(board[0].tile.row).toBe(bounds.row + 1);
  });

  it("keeps every errand spot walkable and reachable from every desk", () => {
    const agents = [
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "a1", parentId: "root-a", createdAt: 2 }),
      agent({ id: "a2", parentId: "root-a", createdAt: 3 }),
      agent({ id: "root-b", createdAt: 4 }),
      agent({ id: "b1", parentId: "root-b", createdAt: 5 }),
    ];
    const layout = layoutOffice(agents);
    const floor = layout.floors[0];
    expect(floor.errandSpots.length).toBeGreaterThan(4);

    const reserved = new Set<string>([
      `${floor.doorTile.col},${floor.doorTile.row}`,
      `${floor.lobbyTile.col},${floor.lobbyTile.row}`,
      ...floor.receptionQueueTiles.map((tile) => `${tile.col},${tile.row}`),
    ]);
    const seen = new Set<string>();
    for (const spot of floor.errandSpots) {
      const key = `${spot.tile.col},${spot.tile.row}`;
      // A spot standing in a wall, on a desk, or in the queue somebody else is
      // waiting in is a character the viewer sees stuck in furniture.
      expect(layout.walkable[spot.tile.row][spot.tile.col], key).toBe(true);
      expect(reserved.has(key), key).toBe(false);
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      for (const desk of layout.desks.values()) {
        expect(
          findOfficePath(layout, desk.chairTile, spot.tile),
          `${desk.agentId} cannot reach ${key}`,
        ).not.toBeNull();
      }
    }
  });

  it("offers a spread of things to walk to, tables included", () => {
    const layout = layoutOffice(SINGLE_HOST);
    const floor = layout.floors[0];
    const kinds = new Set(floor.errandSpots.map((spot) => spot.kind));

    for (const kind of [
      "coffee",
      "cooler",
      "cafe",
      "vending",
      "whiteboard",
      "window",
      "plant",
      "corridor",
    ]) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }

    // Two tables, two seats each, and the seats of one table are neighbours so
    // the pair sitting at them can be seen to be together.
    const seats = floor.errandSpots.filter((spot) => spot.kind === "cafe");
    expect(seats).toHaveLength(4);
    expect(seats[0].tile.row).toBe(seats[1].tile.row);
    expect(seats[1].tile.col - seats[0].tile.col).toBe(1);

    // The two cooler spots face each other rather than both facing the cooler:
    // that is what a conversation looks like from above.
    const cooler = floor.errandSpots.filter((spot) => spot.kind === "cooler");
    expect(cooler).toHaveLength(2);
    expect(cooler.map((spot) => spot.facing)).toEqual(["right", "left"]);
    expect(cooler[1].tile.col - cooler[0].tile.col).toBe(1);
  });

  it.each([1, 2])(
    "gives a %i-agent epic a cafeteria rather than a bare corner",
    (count) => {
      // The break room is not a reward for having enough agents. A small epic
      // is exactly where a floor with one lonely fixture reads as broken, so
      // the storey is widened to fit one however few cabins there are.
      const layout = layoutOffice(
        Array.from({ length: count }, (_, index) => agent({ id: `a${index}` })),
      );

      expect(layout.floors[0].cafeteria).not.toBeNull();
      const coffee = layout.props.filter(
        (prop) => prop.sprite.name === "coffee-machine",
      );
      const board = layout.props.filter(
        (prop) => prop.sprite.name === "menu-board",
      );
      expect(coffee).toHaveLength(1);
      expect(board).toHaveLength(1);
      // The board is what says which of the three fixtures is the coffee, so
      // it has to hang over that one and not merely exist somewhere.
      expect(board[0].tile.col).toBe(coffee[0].tile.col);
      expect(board[0].tile.row).toBe(coffee[0].tile.row - 1);
    },
  );

  it("hangs the menu board over the coffee machine on every floor", () => {
    const layout = layoutOffice([
      agent({ id: "a", hostId: "host-a" }),
      agent({ id: "b", hostId: "host-b" }),
    ]);

    expect(layout.floors.length).toBe(2);
    const coffee = layout.props
      .filter((prop) => prop.sprite.name === "coffee-machine")
      .map((prop) => prop.tile);
    const boards = layout.props
      .filter((prop) => prop.sprite.name === "menu-board")
      .map((prop) => prop.tile);
    expect(coffee).toHaveLength(2);
    expect(boards).toHaveLength(2);
    for (const machine of coffee) {
      expect(
        boards.some(
          (board) => board.col === machine.col && board.row === machine.row - 1,
        ),
      ).toBe(true);
    }
  });

  it("falls back to corner fittings on a floor with no room for a cafeteria", () => {
    const layout = layoutOffice([]);
    const floor = layout.floors[0];

    // The empty building is six by eight; a ten-tile break room would seal it.
    expect(floor.cafeteria).toBeNull();
    expect(
      layout.props.some((prop) => prop.sprite.name === "coffee-machine"),
    ).toBe(true);
    expect(
      layout.props.some((prop) => prop.sprite.name === "water-cooler"),
    ).toBe(true);
    // ...and there is still somewhere to walk to, so the floor is not dead.
    expect(floor.errandSpots.length).toBeGreaterThan(0);
    for (const spot of floor.errandSpots) {
      expect(layout.walkable[spot.tile.row][spot.tile.col]).toBe(true);
    }
  });
});
