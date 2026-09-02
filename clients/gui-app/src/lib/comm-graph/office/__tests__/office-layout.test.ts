import { describe, expect, it } from "vitest";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
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

function agent(
  overrides: Partial<OfficeAgentInput> & { readonly id: string },
): OfficeAgentInput {
  return {
    name: overrides.id,
    kind: "chat",
    harnessId: null,
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

describe("layoutOffice", () => {
  it("renders a minimal room with a door and no desks when empty", () => {
    const layout = layoutOffice([]);

    expect(layout.cols).toBe(8);
    expect(layout.rows).toBe(6);
    expect(layout.desks.size).toBe(0);
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
});
