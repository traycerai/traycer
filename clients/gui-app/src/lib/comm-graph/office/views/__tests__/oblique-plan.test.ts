import { describe, expect, it } from "vitest";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import {
  makeTestEpic,
  type OfficeTestEpic,
  type OfficeTestEpicShape,
} from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentInput,
  OfficeDrawable,
  OfficeLayout,
  OfficeLod,
  OfficeRect,
  OfficeSize,
} from "@/lib/comm-graph/office/office-types";
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import type {
  OfficeDeskState,
  OfficePainter,
  OfficePlanInput,
} from "../office-view";
import {
  BUILDING_VIEW,
  measureBuilding,
  measureTowers,
  planBuilding,
  planTowers,
  TOWERS_VIEW,
} from "../oblique/oblique-plan";

const SHAPES: ReadonlyArray<OfficeTestEpicShape> = [
  "triage",
  "one-team",
  "many-roots",
  "two-hosts",
];
const SCALES: ReadonlyArray<number> = [12, 309, 1000];
const VIEWPORTS: ReadonlyArray<OfficeSize> = [
  { width: 1280, height: 700 },
  { width: 680, height: 440 },
];

function populationFor(epic: OfficeTestEpic): OfficePopulation {
  return partitionOfficePopulation({
    agents: epic.agents,
    statusById: epic.statusById,
    previous: null,
  });
}

interface InputOptions {
  readonly previous: OfficeLayout | null;
  readonly needsCapacity: ReadonlyArray<string>;
  readonly occupancy: ReadonlyMap<string, string>;
}

function inputFor(
  epic: OfficeTestEpic,
  viewport: OfficeSize,
  options: InputOptions,
): OfficePlanInput {
  return {
    agents: epic.agents,
    partition: populationFor(epic),
    occupancy: options.occupancy,
    needsCapacity: options.needsCapacity,
    activityById: new Map(epic.agents.map((agent) => [agent.id, 0])),
    viewport,
    previous: options.previous,
  };
}

function initialInput(
  epic: OfficeTestEpic,
  viewport: OfficeSize,
): OfficePlanInput {
  return inputFor(epic, viewport, {
    previous: null,
    needsCapacity: [],
    occupancy: new Map(),
  });
}

function hostKey(hostId: string | null): string {
  return hostId ?? "<unattributed>";
}

function withinRect(
  rect: {
    readonly col: number;
    readonly row: number;
    readonly cols: number;
    readonly rows: number;
  },
  tile: { readonly col: number; readonly row: number },
): boolean {
  return (
    tile.col >= rect.col &&
    tile.col < rect.col + rect.cols &&
    tile.row >= rect.row &&
    tile.row < rect.row + rect.rows
  );
}

function assertSeats(
  layout: OfficeLayout,
  agentIds: ReadonlySet<string>,
): void {
  const seatIds = new Set<string>();
  for (const seat of layout.seats.values()) {
    expect(seatIds.has(seat.seatId)).toBe(false);
    seatIds.add(seat.seatId);
    expect(layout.floors[seat.floorIndex]).toBeDefined();
  }

  const occupants = new Set<string>();
  for (const [agentId, desk] of layout.desks) {
    expect(agentIds.has(agentId)).toBe(true);
    expect(occupants.has(agentId)).toBe(false);
    occupants.add(agentId);
    expect(layout.seats.get(desk.seatId)).toEqual(desk);

    const floor = layout.floors[desk.floorIndex];
    expect(desk.hostId).toBe(floor.hostId);
    expect(layout.walkable[desk.chairTile.row]?.[desk.chairTile.col]).toBe(
      false,
    );
    expect(findOfficePath(layout, desk.chairTile, floor.doorTile)).not.toBe(
      null,
    );
  }
  expect(occupants).toEqual(agentIds);
}

function assertFloors(layout: OfficeLayout): void {
  for (const floor of layout.floors) {
    for (const tile of floor.corridorTiles) {
      expect(layout.walkable[tile.row]?.[tile.col]).toBe(true);
      expect(tile.row).toBeGreaterThanOrEqual(floor.bounds.row);
      expect(tile.row).toBeLessThan(floor.bounds.row + floor.bounds.rows);
    }
    for (const spot of floor.errandSpots) {
      expect(spot.floorIndex).toBe(layout.floors.indexOf(floor));
      expect(
        layout.walkable[spot.approachTile.row]?.[spot.approachTile.col],
      ).toBe(true);
    }
  }
}

function assertRooms(layout: OfficeLayout): void {
  for (const desk of layout.desks.values()) {
    if (desk.roomId === null) continue;
    const room = layout.rooms.find(
      (candidate) => candidate.rootAgentId === desk.roomId,
    );
    expect(room).toBeDefined();
    if (room !== undefined)
      expect(withinRect(room.bounds, desk.deskTile)).toBe(true);
  }
  for (const room of layout.rooms) {
    if (room.visitTile !== null) {
      expect(layout.walkable[room.visitTile.row]?.[room.visitTile.col]).toBe(
        true,
      );
    }
    for (const floor of layout.floors) {
      for (const tile of floor.corridorTiles)
        expect(withinRect(room.bounds, tile)).toBe(false);
    }
  }
}

function assertSigns(
  layout: OfficeLayout,
  agentIds: ReadonlySet<string>,
): void {
  for (const sign of layout.signs) {
    if (sign.ownerAgentId !== null)
      expect(agentIds.has(sign.ownerAgentId)).toBe(true);
  }
}

function assertPlanContract(layout: OfficeLayout, epic: OfficeTestEpic): void {
  const agentIds = new Set(epic.agents.map((agent) => agent.id));
  expect(layout.desks.size).toBe(epic.agents.length);
  assertSeats(layout, agentIds);
  assertFloors(layout);
  assertRooms(layout);
  assertSigns(layout, agentIds);
}

function seatsByFloor(layout: OfficeLayout): Map<number, number> {
  const result = new Map<number, number>();
  for (const seat of layout.seats.values()) {
    result.set(seat.floorIndex, (result.get(seat.floorIndex) ?? 0) + 1);
  }
  return result;
}

function agentsByHost(epic: OfficeTestEpic): Map<string, number> {
  const result = new Map<string, number>();
  for (const agent of epic.agents) {
    const key = hostKey(agent.hostId);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function floorIndicesByHost(layout: OfficeLayout): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const seat of layout.seats.values()) {
    const floor = layout.floors[seat.floorIndex];
    const key = hostKey(floor.hostId);
    const indices = result.get(key);
    if (indices === undefined) result.set(key, new Set([seat.floorIndex]));
    else indices.add(seat.floorIndex);
  }
  return result;
}

function appendIdleAgent(
  epic: OfficeTestEpic,
  parentId: string | null,
): OfficeTestEpic {
  const id = `growth-${epic.agents.length}`;
  const first = epic.agents[0];
  const newcomer: OfficeAgentInput = {
    ...first,
    id,
    name: id,
    parentId,
    hostId: first.hostId,
    archivedAt: null,
    archived: false,
    createdAt: first.createdAt + epic.agents.length + 1,
  };
  return {
    agents: [...epic.agents, newcomer],
    statusById: new Map(epic.statusById).set(id, "idle"),
  };
}

function occupiedReserves(layout: OfficeLayout): ReadonlyMap<string, string> {
  const assignedSeatIds = new Set(
    [...layout.desks.values()].map((desk) => desk.seatId),
  );
  return new Map(
    [...layout.seats.values()]
      .filter((seat) => !assignedSeatIds.has(seat.seatId))
      .map((seat) => [seat.seatId, "reserved-for-test"]),
  );
}

function expectExistingDesksStable(
  before: OfficeLayout,
  after: OfficeLayout,
  rowShift: number,
): void {
  for (const [agentId, desk] of before.desks) {
    const next = after.desks.get(agentId);
    expect(next).toBeDefined();
    if (next === undefined) continue;
    expect(next.seatId).toBe(desk.seatId);
    expect(next.deskTile).toEqual({
      col: desk.deskTile.col,
      row: desk.deskTile.row + rowShift,
    });
    expect(next.chairTile).toEqual({
      col: desk.chairTile.col,
      row: desk.chairTile.row + rowShift,
    });
  }
}

function canvasViewport(viewport: OfficeSize): OfficeSize {
  const directoryWidth = Math.min(viewport.width * 0.3, 240);
  return { width: viewport.width - directoryWidth, height: viewport.height };
}

function fitZoom(size: OfficeSize, viewport: OfficeSize): number {
  return Math.min(viewport.width / size.width, viewport.height / size.height);
}

function assertWorldSpriteInBounds(
  drawable: OfficeDrawable,
  bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  if (drawable.kind !== "sprite") return;
  const size = officeSpriteSize(drawable.sprite);
  expect(drawable.x).toBeGreaterThanOrEqual(bounds.x);
  expect(drawable.y).toBeGreaterThanOrEqual(bounds.y);
  expect(drawable.x + size.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  expect(drawable.y + size.height).toBeLessThanOrEqual(
    bounds.y + bounds.height,
  );
}

function idleDeskState(agentId: string | null): OfficeDeskState {
  return {
    agentId,
    name: agentId,
    accentId: null,
    status: "idle",
    sheeted: false,
    openRequests: 0,
    screenFrame: 0,
    harnessId: null,
    modelTier: "medium",
  };
}

function assertSpotSpritesInBounds(
  layout: OfficeLayout,
  painter: OfficePainter,
  lod: OfficeLod,
  bounds: OfficeRect,
): void {
  for (const floor of layout.floors) {
    for (const spot of floor.errandSpots) {
      for (const world of painter.spotProps(layout, spot, lod))
        assertWorldSpriteInBounds(world.drawable, bounds);
    }
  }
}

describe("oblique plans: shared contract", () => {
  for (const plan of [planTowers, planBuilding]) {
    describe(plan === planTowers ? "Towers" : "Building", () => {
      for (const shape of SHAPES) {
        for (const count of SCALES) {
          it(`${shape} at ${count} agents seats and routes every agent`, () => {
            const epic = makeTestEpic(shape, count, 1);
            const input = initialInput(epic, VIEWPORTS[0]);
            const inputAgents = [...input.agents];
            const inputPartition = input.partition;
            const layout = plan(input);
            assertPlanContract(layout, epic);
            expect(input.agents).toEqual(inputAgents);
            expect(input.partition).toBe(inputPartition);
          });
        }
      }

      it("reports the same measured world size as the real plan", () => {
        for (const viewport of VIEWPORTS) {
          const epic = makeTestEpic("triage", 309, 1);
          const input = initialInput(epic, viewport);
          const layout = plan(input);
          const measure = plan === planTowers ? measureTowers : measureBuilding;
          expect(measure(input)).toEqual({
            width: layout.cols * OFFICE_TILE,
            height: layout.rows * OFFICE_TILE,
          });
        }
      });
    });
  }
});

describe("Towers packing", () => {
  it("uses nine seats per storey and leaves one vacant storey per tower", () => {
    for (const shape of SHAPES) {
      const epic = makeTestEpic(shape, 309, 1);
      const layout = planTowers(initialInput(epic, VIEWPORTS[0]));
      const floors = seatsByFloor(layout);
      const counts = agentsByHost(epic);
      const byHost = floorIndicesByHost(layout);

      for (const count of floors.values()) expect(count).toBe(9);
      for (const key of counts.keys()) {
        const hostFloors = byHost.get(key) ?? new Set<number>();
        const seatFloors = [...hostFloors].map(
          (floorIndex) => layout.floors[floorIndex],
        );
        const towerColumns = new Set(
          seatFloors
            .filter((floor) => floor.bounds.rows === 4)
            .map((floor) => floor.bounds.col),
        );
        const columns = [...towerColumns];
        const span = Math.max(...columns) - Math.min(...columns) + 26;
        expect(span % 26).toBe(0);
        expect(span / 26).toBe(towerColumns.size);
        const liveFloors = seatFloors.filter(
          (floor) => floor.bounds.rows === 4 && floor.bounds.row > 2,
        );
        expect(towerColumns.size).toBeGreaterThan(0);
        const occupied = new Set(
          [...layout.desks.values()]
            .filter((desk) => hostKey(desk.hostId) === key)
            .map((desk) => desk.floorIndex),
        );
        expect(
          liveFloors.filter(
            (floor) => !occupied.has(layout.floors.indexOf(floor)),
          ).length,
        ).toBe(towerColumns.size);
      }
    }
  });

  it("freezes the tower count chosen from the first viewport aspect", () => {
    const epic = makeTestEpic("triage", 309, 1);
    const first = planTowers(initialInput(epic, VIEWPORTS[0]));
    const resized = planTowers(
      inputFor(epic, VIEWPORTS[1], {
        previous: first,
        needsCapacity: [],
        occupancy: new Map(),
      }),
    );
    expect(resized.stable).toBe(true);
    expect(resized.cols).toBe(first.cols);
    expect(resized.rows).toBe(first.rows);
    for (const [agentId, desk] of first.desks) {
      expect(resized.desks.get(agentId)?.deskTile).toEqual(desk.deskTile);
      expect(resized.desks.get(agentId)?.chairTile).toEqual(desk.chairTile);
    }
  });

  it("uses a free reserve for an arrival without moving existing tower desks", () => {
    const beforeEpic = makeTestEpic("one-team", 12, 1);
    const before = planTowers(initialInput(beforeEpic, VIEWPORTS[0]));
    const afterEpic = appendIdleAgent(
      beforeEpic,
      beforeEpic.agents[1]?.id ?? null,
    );
    const after = planTowers(
      inputFor(afterEpic, VIEWPORTS[0], {
        previous: before,
        needsCapacity: [],
        occupancy: new Map(),
      }),
    );
    expect(after.shiftFromPrevious).toBeNull();
    expectExistingDesksStable(before, after, 0);
    expect(after.desks.has("growth-12")).toBe(true);
  });

  it("inserts a storey on every tower when a reserve-exhausted arrival lands", () => {
    const beforeEpic = makeTestEpic("one-team", 12, 1);
    const before = planTowers(initialInput(beforeEpic, VIEWPORTS[0]));
    const afterEpic = appendIdleAgent(
      beforeEpic,
      beforeEpic.agents[1]?.id ?? null,
    );
    const after = planTowers(
      inputFor(afterEpic, VIEWPORTS[0], {
        previous: before,
        needsCapacity: ["growth-12"],
        occupancy: occupiedReserves(before),
      }),
    );
    expect(after.shiftFromPrevious).toEqual({ col: 0, row: 4 });
    expectExistingDesksStable(before, after, 4);
    expect(after.desks.has("growth-12")).toBe(true);
  });
});

describe("Building packing", () => {
  it("gives live teams rooms with one reserve seat per room and puts the rest in partition order cubbies", () => {
    for (const shape of SHAPES) {
      const epic = makeTestEpic(shape, 309, 1);
      const partition = populationFor(epic);
      const layout = planBuilding(initialInput(epic, VIEWPORTS[0]));
      const expectedCubbies: string[] = [];
      for (const host of partition.hosts) {
        for (const team of host.teams) {
          if (!team.live) expectedCubbies.push(...team.memberAgentIds);
        }
        for (const solo of host.solos) {
          if (!solo.hot) expectedCubbies.push(solo.agentId);
        }
      }
      const cubbies = [...layout.desks.values()]
        .filter((desk) => desk.kind === "cubby")
        .sort(
          (a, b) =>
            a.floorIndex - b.floorIndex ||
            a.deskTile.row - b.deskTile.row ||
            a.deskTile.col - b.deskTile.col,
        )
        .map((desk) => desk.agentId);
      expect(cubbies).toEqual(expectedCubbies);

      for (const team of partition.hosts.flatMap((host) => host.teams)) {
        if (!team.live) continue;
        const roomIds = new Set(
          team.memberAgentIds.map(
            (agentId) => layout.desks.get(agentId)?.roomId,
          ),
        );
        expect(roomIds.has(null)).toBe(false);
        for (const roomId of roomIds) {
          if (roomId === null) continue;
          const seats = [...layout.seats.values()].filter(
            (seat) => seat.roomId === roomId,
          );
          const desks = [...layout.desks.values()].filter(
            (desk) => desk.roomId === roomId,
          );
          expect(seats.length - desks.length).toBe(1);
          expect(desks.every((desk) => desk.kind === "desk")).toBe(true);
        }
      }
    }
  });

  it("appends a live storey with a four-row shift when capacity is exhausted", () => {
    const beforeEpic = makeTestEpic("one-team", 12, 1);
    const before = planBuilding(initialInput(beforeEpic, VIEWPORTS[0]));
    const afterEpic = appendIdleAgent(
      beforeEpic,
      beforeEpic.agents[1]?.id ?? null,
    );
    const assignedSeatIds = new Set(
      [...before.desks.values()].map((desk) => desk.seatId),
    );
    const occupiedReserves = new Map(
      [...before.seats.values()]
        .filter((seat) => !assignedSeatIds.has(seat.seatId))
        .map((seat) => [seat.seatId, "reserved-for-test"]),
    );
    const after = planBuilding(
      inputFor(afterEpic, VIEWPORTS[0], {
        previous: before,
        needsCapacity: ["growth-12"],
        occupancy: occupiedReserves,
      }),
    );
    expect(after.shiftFromPrevious).toEqual({ col: 0, row: 4 });
    expect(after.rows).toBeGreaterThan(before.rows);
    expect(after.stable).toBe(true);
    for (const [agentId, desk] of before.desks) {
      const moved = after.desks.get(agentId);
      expect(moved?.deskTile).toEqual({
        col: desk.deskTile.col,
        row: desk.deskTile.row + 4,
      });
      expect(moved?.chairTile).toEqual({
        col: desk.chairTile.col,
        row: desk.chairTile.row + 4,
      });
    }
  });

  it("appends a cubby storey without shifting the existing world when a row fills", () => {
    const baseEpic = makeTestEpic("many-roots", 45, 1);
    const beforeEpic: OfficeTestEpic = {
      agents: baseEpic.agents,
      statusById: new Map(baseEpic.agents.map((agent) => [agent.id, "idle"])),
    };
    const before = planBuilding(initialInput(beforeEpic, VIEWPORTS[0]));
    const afterEpic = appendIdleAgent(beforeEpic, null);
    const after = planBuilding(
      inputFor(afterEpic, VIEWPORTS[0], {
        previous: before,
        needsCapacity: [],
        occupancy: new Map(),
      }),
    );
    expect(after.shiftFromPrevious).toBeNull();
    expect(after.rows).toBeGreaterThan(before.rows);
    expect(after.stable).toBe(true);
  });

  it("keeps cubby geometry across status flips and seats a hot child of a cold team", () => {
    const base = makeTestEpic("one-team", 12, 1);
    const coldEpic: OfficeTestEpic = {
      agents: base.agents,
      statusById: new Map(base.agents.map((agent) => [agent.id, "idle"])),
    };
    const before = planBuilding(initialInput(coldEpic, VIEWPORTS[0]));
    const flippedStatuses = new Map(coldEpic.statusById).set(
      coldEpic.agents[2]?.id ?? "",
      "working",
    );
    const flipped: OfficeTestEpic = {
      agents: coldEpic.agents,
      statusById: flippedStatuses,
    };
    const afterFlip = planBuilding(
      inputFor(flipped, VIEWPORTS[0], {
        previous: before,
        needsCapacity: [],
        occupancy: new Map(),
      }),
    );
    expectExistingDesksStable(before, afterFlip, 0);
    for (const [agentId, desk] of before.desks) {
      expect(afterFlip.desks.get(agentId)?.kind).toBe(desk.kind);
    }

    const appended = appendIdleAgent(coldEpic, coldEpic.agents[1]?.id ?? null);
    const hotChild: OfficeTestEpic = {
      agents: appended.agents,
      statusById: new Map(appended.statusById).set("growth-12", "working"),
    };
    const afterChild = planBuilding(
      inputFor(hotChild, VIEWPORTS[0], {
        previous: before,
        needsCapacity: [],
        occupancy: new Map(),
      }),
    );
    expectExistingDesksStable(before, afterChild, 0);
    expect(afterChild.desks.get("growth-12")?.kind).toBe("desk");
  });

  it("places a second host in an adjacent building and marks the skybridge", () => {
    const epic = makeTestEpic("two-hosts", 60, 1);
    const layout = planBuilding(initialInput(epic, VIEWPORTS[0]));
    const hostIds = new Set(epic.agents.map((agent) => hostKey(agent.hostId)));
    const floorHosts = new Set(
      layout.floors.map((floor) => hostKey(floor.hostId)),
    );
    expect(floorHosts.size).toBe(hostIds.size);
    expect(layout.signs.filter((sign) => sign.kind === "host")).toHaveLength(
      hostIds.size,
    );
    expect(layout.props.some((prop) => prop.sprite.name === "skybridge")).toBe(
      true,
    );
  });
});

describe("oblique painters", () => {
  it("uses a world stream and an identity projector for both plans", () => {
    const epic = makeTestEpic("triage", 309, 1);
    for (const view of [TOWERS_VIEW, BUILDING_VIEW]) {
      const layout = view.plan(
        initialInput(epic, canvasViewport(VIEWPORTS[0])),
      );
      const painter = view.painter;
      const projector = painter.projector(layout);
      expect(painter.depth).toBe("world");
      expect(projector.project(2.5, 3)).toEqual({ x: 40, y: 48 });
      expect(projector.bounds).toEqual({
        x: 0,
        y: 0,
        width: layout.cols * OFFICE_TILE,
        height: layout.rows * OFFICE_TILE,
      });

      const desk = [...layout.desks.values()].find(
        (candidate) => candidate.kind === "desk",
      );
      expect(desk).toBeDefined();
      if (desk !== undefined) {
        const front = painter
          .seatProps(layout, desk, idleDeskState(desk.agentId), 2)
          .find(
            (item) =>
              item.drawable.kind === "sprite" &&
              item.drawable.sprite.name === "desk-front",
          );
        expect(front).toBeDefined();
        if (front !== undefined) {
          expect(front.depth).toBe(
            (desk.chairTile.row + 1) * OFFICE_TILE + 0.1,
          );
          expect(front.depth).toBeLessThan(
            (desk.chairTile.row + 2) * OFFICE_TILE,
          );
        }
      }
    }
  });

  it("draws cubby frames and overview silhouettes without desk props", () => {
    const epic = makeTestEpic("triage", 309, 1);
    const layout = planBuilding(
      initialInput(epic, canvasViewport(VIEWPORTS[0])),
    );
    const cubby = [...layout.desks.values()].find(
      (candidate) => candidate.kind === "cubby",
    );
    expect(cubby).toBeDefined();
    if (cubby === undefined) return;
    const painter = BUILDING_VIEW.painter;
    expect(
      painter.seatProps(layout, cubby, idleDeskState(cubby.agentId), 0),
    ).toEqual([]);
    const overview = painter.seatProps(
      layout,
      cubby,
      idleDeskState(cubby.agentId),
      1,
    );
    const close = painter.seatProps(
      layout,
      cubby,
      idleDeskState(cubby.agentId),
      2,
    );
    const overviewNames = overview.flatMap((item) =>
      item.drawable.kind === "sprite" ? [item.drawable.sprite.name] : [],
    );
    const closeNames = close.flatMap((item) =>
      item.drawable.kind === "sprite" ? [item.drawable.sprite.name] : [],
    );
    expect(overviewNames).toEqual(
      expect.arrayContaining(["cubby", "silhouette"]),
    );
    expect(closeNames).toContain("cubby");
    expect(closeNames).not.toContain("silhouette");
    for (const name of [...overviewNames, ...closeNames]) {
      expect(name).not.toMatch(/monitor|nameplate|envelope/);
    }
  });

  it("emits a canonical plaza fixture once and suppresses its live-floor aliases", () => {
    const epic = makeTestEpic("triage", 309, 1);
    const layout = planBuilding(
      initialInput(epic, canvasViewport(VIEWPORTS[0])),
    );
    const entries = layout.floors.flatMap((floor) =>
      floor.errandSpots.map((spot) => ({ hostId: floor.hostId, spot })),
    );
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = `${hostKey(entry.hostId)}/${entry.spot.fixtureId}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [entry]);
      else group.push(entry);
    }
    const group = [...groups.values()].find((candidates) => {
      const floors = new Set(
        candidates.map((candidate) => candidate.spot.floorIndex),
      );
      return floors.size > 1;
    });
    expect(group).toBeDefined();
    if (group === undefined) return;
    const emitted = group.map((entry) => ({
      entry,
      props: BUILDING_VIEW.painter.spotProps(layout, entry.spot, 1),
    }));
    const canonical = emitted.find((entry) => entry.props.length > 0);
    expect(canonical).toBeDefined();
    if (canonical === undefined) return;
    for (const alias of emitted.filter(
      (entry) =>
        entry.entry.spot.floorIndex !== canonical.entry.spot.floorIndex,
    )) {
      expect(alias.props).toEqual([]);
    }
  });

  it("clips the overview block map to the requested tile chunk", () => {
    const epic = makeTestEpic("triage", 309, 1);
    for (const view of [TOWERS_VIEW, BUILDING_VIEW]) {
      const layout = view.plan(
        initialInput(epic, canvasViewport(VIEWPORTS[0])),
      );
      const tiles = { col: 5, row: 5, cols: 8, rows: 8 };
      const blocks = view.painter.floor(layout, tiles, 0);
      expect(blocks.length).toBeGreaterThan(0);
      expect(
        blocks.some(
          (block) => block.kind === "block" && block.fill === "building",
        ),
      ).toBe(true);
      expect(
        blocks.some(
          (block) => block.kind === "block" && block.fill === "storey",
        ),
      ).toBe(true);
      for (const block of blocks) {
        expect(block.kind).toBe("block");
        if (block.kind !== "block") continue;
        expect(block.x).toBeGreaterThanOrEqual(tiles.col * OFFICE_TILE);
        expect(block.y).toBeGreaterThanOrEqual(tiles.row * OFFICE_TILE);
        expect(block.x + block.width).toBeLessThanOrEqual(
          (tiles.col + tiles.cols) * OFFICE_TILE,
        );
        expect(block.y + block.height).toBeLessThanOrEqual(
          (tiles.row + tiles.rows) * OFFICE_TILE,
        );
      }
    }
  });

  it("uses the occupant team accent on cubbies", () => {
    const layout = planBuilding(
      initialInput(
        makeTestEpic("triage", 309, 1),
        canvasViewport(VIEWPORTS[0]),
      ),
    );
    const cubby = [...layout.seats.values()].find(
      (seat) => seat.kind === "cubby",
    );
    if (cubby === undefined) throw new Error("Expected a cubby");
    const state = { ...idleDeskState("occupant"), accentId: "team-lead" };
    const props = BUILDING_VIEW.painter.seatProps(layout, cubby, state, 1);
    const frame = props.find(
      (item) =>
        item.drawable.kind === "sprite" &&
        item.drawable.sprite.name === "cubby",
    );
    if (frame?.drawable.kind !== "sprite")
      throw new Error("Expected a cubby frame");
    expect(frame.drawable.sprite.tint).toBe(
      agentAppearance("team-lead", "chat", null).shirt,
    );
    expect(
      props.find(
        (item) =>
          item.drawable.kind === "sprite" &&
          item.drawable.sprite.name === "silhouette",
      )?.ownerAgentId,
    ).toBe("occupant");
  });

  it("aliases lead-only HQ boards across live storeys within each host", () => {
    for (const view of [TOWERS_VIEW, BUILDING_VIEW]) {
      const layout = view.plan(
        initialInput(
          makeTestEpic("two-hosts", 309, 1),
          canvasViewport(VIEWPORTS[0]),
        ),
      );
      for (const [floorIndex, floor] of layout.floors.entries()) {
        const boards = floor.errandSpots.filter(
          (spot) => spot.kind === "whiteboard",
        );
        const desks = [...layout.seats.values()].filter(
          (seat) => seat.floorIndex === floorIndex && seat.kind === "desk",
        );
        if (desks.length === 0) {
          expect(boards).toHaveLength(0);
          continue;
        }
        if (floor.bounds.row > 2) expect(boards).toHaveLength(3);
        for (const board of boards) {
          expect(board.audience).toEqual({ kind: "leads" });
          const canonical = layout.floors.find(
            (candidate) =>
              candidate.bounds.row <= board.tile.row &&
              candidate.bounds.row + candidate.bounds.rows > board.tile.row &&
              candidate.bounds.col <= board.tile.col &&
              candidate.bounds.col + candidate.bounds.cols > board.tile.col,
          );
          expect(canonical?.hostId).toBe(floor.hostId);
          expect(
            canonical?.errandSpots.some(
              (spot) => spot.fixtureId === board.fixtureId,
            ),
          ).toBe(true);
        }
      }
    }
  });

  it("keeps lod-one and lod-two emitted sprites inside projected bounds", () => {
    const epic = makeTestEpic("triage", 309, 1);
    for (const view of [TOWERS_VIEW, BUILDING_VIEW]) {
      const layout = view.plan(
        initialInput(epic, canvasViewport(VIEWPORTS[0])),
      );
      const painter = view.painter;
      const projector = painter.projector(layout);
      const tileRect = { col: 0, row: 0, cols: layout.cols, rows: layout.rows };
      for (const lod of [1, 2] as const) {
        for (const drawable of painter.floor(layout, tileRect, lod)) {
          assertWorldSpriteInBounds(drawable, projector.bounds);
        }
        for (const seat of layout.seats.values()) {
          const desk = [...layout.desks.values()].find(
            (candidate) => candidate.seatId === seat.seatId,
          );
          const state = idleDeskState(desk?.agentId ?? null);
          for (const world of painter.seatProps(layout, seat, state, lod)) {
            assertWorldSpriteInBounds(world.drawable, projector.bounds);
          }
        }
        assertSpotSpritesInBounds(layout, painter, lod, projector.bounds);
      }
    }
  });
});

describe("oblique fit ranges", () => {
  const fitPins = {
    towers: {
      wide: { 309: 0.68359375, 1000: 0.4166666667 },
      narrow: { 309: 0.3814102564, 1000: 0.2288461538 },
    },
    building: {
      wide: { 309: 0.9943181818, 1000: 0.6842105263 },
      narrow: { 309: 0.6071428571, 1000: 0.4131944444 },
    },
  } as const;

  for (const viewport of VIEWPORTS) {
    for (const count of [309, 1000] as const) {
      it(`pins measured ${viewport.width}x${viewport.height} fit at ${count}`, () => {
        const epic = makeTestEpic("triage", count, 1);
        const canvas = canvasViewport(viewport);
        const input = initialInput(epic, canvas);
        const wide = viewport.width > 1000;
        for (const [name, measure] of [
          ["towers", measureTowers],
          ["building", measureBuilding],
        ] as const) {
          const zoom = fitZoom(measure(input), canvas);
          const expected = fitPins[name][wide ? "wide" : "narrow"][count];
          expect(
            zoom,
            `${name} ${count} at ${viewport.width}x${viewport.height}`,
          ).toBeGreaterThanOrEqual(expected * 0.9);
          expect(
            zoom,
            `${name} ${count} at ${viewport.width}x${viewport.height}`,
          ).toBeLessThanOrEqual(expected * 1.1);
        }
      });
    }
  }
});
