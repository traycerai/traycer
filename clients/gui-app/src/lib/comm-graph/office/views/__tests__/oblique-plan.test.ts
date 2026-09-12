import { describe, expect, it } from "vitest";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import {
  OFFICE_SIGN_FONT_PX,
  OFFICE_SIGN_LETTER_SPACING_EM,
  OFFICE_SIGN_NARROW_PLATE_MAX_CHARS,
  OFFICE_SIGN_PADDING_X,
  OFFICE_SIGN_PLATE_MAX_CHARS,
  officeSignCenterX,
  officeSignsToDraw,
  type OfficeSignToDraw,
} from "@/lib/comm-graph/office/office-signs";
import {
  makeTestEpic,
  type OfficeTestEpic,
  type OfficeTestEpicShape,
} from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
  OfficeDrawable,
  OfficeLayout,
  OfficeLod,
  OfficeRect,
  OfficeSeat,
  OfficeSceneInput,
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
  obliqueIsPlaza,
  obliqueReserveLabelSeatId,
  planBuilding,
  planTowers,
  TOWERS_VIEW,
} from "../oblique/oblique-plan";

/**
 * A plate's width in the face it is ACTUALLY DRAWN IN, derived the same way
 * `office-signs.test.ts` and `office-board-fit.test.ts` derive it, rather than
 * hard-coded: `ctx.letterSpacing` counts towards `measureText` as well as the
 * painted glyphs, so leaving the tracking out under-reports every plate by the
 * exact margin that separates a rung that fits from one that overflows the
 * room it names.
 */
const MONOSPACE_ADVANCE_EM = 0.6;
const CHAR_PX =
  OFFICE_SIGN_FONT_PX * (MONOSPACE_ADVANCE_EM + OFFICE_SIGN_LETTER_SPACING_EM);
const PLATE_PADDING_PX = OFFICE_SIGN_PADDING_X * 2;
function measure(text: string): number {
  return text.length * CHAR_PX + PLATE_PADDING_PX;
}

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

function inputForPartition(
  epic: OfficeTestEpic,
  partition: OfficePopulation,
  viewport: OfficeSize,
  options: InputOptions,
): OfficePlanInput {
  return {
    ...inputFor(epic, viewport, options),
    partition,
  };
}

function sceneInputFor(args: {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly partition: OfficePopulation;
}): OfficeSceneInput {
  return {
    agents: args.agents,
    visibleAgentIds: new Set(args.agents.map((agent) => agent.id)),
    statusById: args.statusById,
    partition: args.partition,
    activityById: new Map<string, number>(),
    viewport: canvasViewport(VIEWPORTS[0]),
    openRequestsByReceiver: new Map<string, number>(),
    pulse: null,
    pulseKey: null,
    stepMs: 800,
    cursorMs: null,
    clockMs: 0,
    playing: false,
    reducedMotion: false,
    feedSettled: false,
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
  }
  const corridorViolations: Array<{
    readonly roomId: string;
    readonly floorIndex: number;
    readonly col: number;
    readonly row: number;
  }> = [];
  for (const room of layout.rooms) {
    for (const [floorIndex, floor] of layout.floors.entries()) {
      for (const tile of floor.corridorTiles) {
        if (withinRect(room.bounds, tile)) {
          corridorViolations.push({
            roomId: room.rootAgentId,
            floorIndex,
            col: tile.col,
            row: tile.row,
          });
        }
      }
    }
  }
  expect(corridorViolations).toEqual([]);
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
  it("marks only live team-room desks for idle dimming", () => {
    const source = makeTestEpic("triage", 40, 1);
    const allWorking: OfficeTestEpic = {
      agents: source.agents,
      statusById: new Map(
        source.agents.map((agent) => [agent.id, "working" as const]),
      ),
    };
    const partition = populationFor(allWorking);
    const teamIds = new Set(
      partition.hosts.flatMap((host) =>
        host.teams.flatMap((team) => team.memberAgentIds),
      ),
    );
    const layout = planBuilding(initialInput(allWorking, VIEWPORTS[0]));
    const teamDesks = [...layout.desks.values()].filter((desk) =>
      teamIds.has(desk.agentId),
    );
    const nonTeamDesks = [...layout.desks.values()].filter(
      (desk) => !teamIds.has(desk.agentId) && desk.kind === "desk",
    );
    expect(teamDesks.length).toBeGreaterThan(0);
    expect(nonTeamDesks.length).toBeGreaterThan(0);
    for (const desk of teamDesks) expect(desk.idleAlpha).toBe(0.55);
    for (const desk of nonTeamDesks) expect(desk.idleAlpha).toBeUndefined();
    const towers = planTowers(initialInput(allWorking, VIEWPORTS[0]));
    expect(
      [...towers.seats.values()].every((seat) => seat.idleAlpha === undefined),
    ).toBe(true);

    const cold = makeTestEpic("one-team", 12, 1);
    const coldEpic: OfficeTestEpic = {
      agents: cold.agents,
      statusById: new Map(cold.agents.map((agent) => [agent.id, "idle"])),
    };
    const coldLayout = planBuilding(initialInput(coldEpic, VIEWPORTS[0]));
    const cubbies = [...coldLayout.seats.values()].filter(
      (seat) => seat.kind === "cubby",
    );
    expect(cubbies.length).toBeGreaterThan(0);
    for (const cubby of cubbies) expect(cubby.idleAlpha).toBeUndefined();
  });

  it("keeps area and aggregate solo plates ownerless through name refresh", () => {
    const source = makeTestEpic("triage", 60, 1);
    const epic: OfficeTestEpic = {
      agents: source.agents,
      statusById: new Map(
        source.agents.map((agent) => [agent.id, "working" as const]),
      ),
    };
    for (const view of [TOWERS_VIEW, BUILDING_VIEW]) {
      const partition = populationFor(epic);
      const scene = new OfficeScene(view, null);
      scene.sync(
        sceneInputFor({
          agents: epic.agents,
          statusById: epic.statusById,
          partition,
        }),
      );
      const before = scene.layout();
      if (before === null) throw new Error("expected a scene layout");
      const aggregate = before.signs.filter(
        (sign) =>
          sign.kind === "area" ||
          (sign.kind === "plate" &&
            (sign.text === "Solo desks" || sign.text.startsWith("Bullpen ·"))),
      );
      expect(aggregate.length).toBeGreaterThan(0);
      for (const sign of aggregate) expect(sign.ownerAgentId).toBeNull();
      const aggregateKeys = new Set(
        aggregate.map(
          (sign) =>
            `${sign.kind}:${sign.tile.col}:${sign.tile.row}:${sign.hostId ?? ""}`,
        ),
      );
      const texts = aggregate.map((sign) => sign.text);

      const renamedAgents = epic.agents.map((agent) => ({
        ...agent,
        name: `renamed-${agent.id}`,
      }));
      const renamedPartition = partitionOfficePopulation({
        agents: renamedAgents,
        statusById: epic.statusById,
        previous: partition,
      });
      scene.sync(
        sceneInputFor({
          agents: renamedAgents,
          statusById: epic.statusById,
          partition: renamedPartition,
        }),
      );
      const after = scene.layout();
      if (after === null) throw new Error("expected renamed layout");
      const afterAggregate = after.signs.filter((sign) =>
        aggregateKeys.has(
          `${sign.kind}:${sign.tile.col}:${sign.tile.row}:${sign.hostId ?? ""}`,
        ),
      );
      expect(afterAggregate).toHaveLength(aggregate.length);
      for (const sign of afterAggregate) expect(sign.ownerAgentId).toBeNull();
      expect(afterAggregate.map((sign) => sign.text)).toEqual(texts);
    }
  });

  it("keeps borrowed solo arrivals out of team room and board rosters", () => {
    const source = makeTestEpic("triage", 40, 1);
    const base: OfficeTestEpic = {
      agents: source.agents,
      statusById: new Map(
        source.agents.map((agent) => [agent.id, "working" as const]),
      ),
    };
    const firstPartition = populationFor(base);
    const before = planBuilding(initialInput(base, VIEWPORTS[0]));
    const occupancy = new Map(
      [...before.desks.values()].map((desk) => [desk.seatId, desk.agentId]),
    );
    const freeRoomSeats = [...before.seats.values()].filter(
      (seat) => !occupancy.has(seat.seatId) && seat.roomId !== null,
    );
    const freeBullpenSeats = [...before.seats.values()].filter(
      (seat) => !occupancy.has(seat.seatId) && seat.roomId === null,
    );
    expect(freeRoomSeats.length).toBeGreaterThan(0);
    const template = source.agents.at(0);
    if (template === undefined) throw new Error("expected a source agent");
    const arrivals = Array.from(
      { length: freeBullpenSeats.length + 1 },
      (_unused, index) => ({
        ...template,
        id: `new-solo-${index}`,
        name: `new-solo-${index}`,
        parentId: null,
        createdAt: 100_000 + index,
        archived: false,
        archivedAt: null,
      }),
    );
    const grown: OfficeTestEpic = {
      agents: [...base.agents, ...arrivals],
      statusById: new Map([
        ...base.statusById,
        ...arrivals.map((agent) => [agent.id, "working"] as const),
      ]),
    };
    const afterPartition = partitionOfficePopulation({
      agents: grown.agents,
      statusById: grown.statusById,
      previous: firstPartition,
    });
    const after = planBuilding(
      inputForPartition(grown, afterPartition, VIEWPORTS[0], {
        previous: before,
        needsCapacity: [],
        occupancy,
      }),
    );
    const lastArrival = arrivals.at(-1);
    if (lastArrival === undefined) throw new Error("expected an arrival");
    const borrowed = after.desks.get(lastArrival.id);
    if (borrowed === undefined) throw new Error("expected a borrowed seat");
    if (borrowed.roomId === null) throw new Error("expected a borrowed room");

    const team = afterPartition.hosts
      .flatMap((host) => host.teams)
      .find((candidate) => candidate.teamId === "team-0-lead");
    if (team === undefined) throw new Error("expected team-0 roster");
    const teamRoomIds = new Set(
      Array.from(before.seats.values()).flatMap((seat) =>
        seat.roomId !== null && seat.roomId.startsWith(`${team.teamId}/room/`)
          ? [seat.roomId]
          : [],
      ),
    );
    expect(teamRoomIds.has(borrowed.roomId)).toBe(true);
    const teamSigns = after.signs.filter(
      (sign) =>
        sign.ownerAgentId === team.leadAgentId &&
        (sign.kind === "plate" || sign.kind === "board"),
    );
    expect(teamSigns.length).toBeGreaterThan(0);
    for (const sign of teamSigns) {
      expect(sign.agentIds).toEqual(team.memberAgentIds);
      expect(sign.agentIds).not.toContain(lastArrival.id);
    }
  });

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
  it("classifies overview floors by their plan kind rather than row count", () => {
    for (const view of [TOWERS_VIEW, BUILDING_VIEW]) {
      const layout = view.plan(
        initialInput(
          makeTestEpic("triage", 309, 1),
          canvasViewport(VIEWPORTS[0]),
        ),
      );
      const plazaIndex = layout.floors.findIndex((_, index) =>
        obliqueIsPlaza(layout, index),
      );
      expect(plazaIndex).toBeGreaterThanOrEqual(0);
      if (plazaIndex < 0) throw new Error("expected a canonical plaza floor");
      const storeyIndex = layout.floors.findIndex(
        (floor, index) => index !== plazaIndex && floor.bounds.rows === 4,
      );
      expect(storeyIndex).toBeGreaterThan(0);
      if (storeyIndex <= 0) throw new Error("expected a storey floor");
      const plaza = layout.floors[plazaIndex];
      const storey = layout.floors[storeyIndex];
      const resized = {
        ...layout,
        floors: layout.floors.map((floor, index) => {
          if (index === plazaIndex) {
            return { ...floor, bounds: { ...floor.bounds, rows: 4 } };
          }
          if (index === storeyIndex) {
            return { ...floor, bounds: { ...floor.bounds, rows: 5 } };
          }
          return floor;
        }),
      };
      const plazaBlocks = view.painter
        .floor(resized, { ...plaza.bounds, rows: 4 }, 0)
        .filter(
          (drawable) =>
            drawable.kind === "block" &&
            drawable.x === plaza.bounds.col * OFFICE_TILE &&
            drawable.y === plaza.bounds.row * OFFICE_TILE &&
            drawable.width === plaza.bounds.cols * OFFICE_TILE &&
            drawable.height === 4 * OFFICE_TILE,
        );
      const storeyBlocks = view.painter
        .floor(resized, { ...storey.bounds, rows: 5 }, 0)
        .filter(
          (drawable) =>
            drawable.kind === "block" &&
            drawable.x === storey.bounds.col * OFFICE_TILE &&
            drawable.y === storey.bounds.row * OFFICE_TILE &&
            drawable.width === storey.bounds.cols * OFFICE_TILE &&
            drawable.height === 5 * OFFICE_TILE,
        );
      expect(plazaBlocks).toEqual(
        expect.arrayContaining([expect.objectContaining({ fill: "plaza" })]),
      );
      expect(storeyBlocks).toEqual(
        expect.arrayContaining([expect.objectContaining({ fill: "storey" })]),
      );
    }
  });

  for (const view of [TOWERS_VIEW, BUILDING_VIEW]) {
    it(`${view.id} bounds repeated visible fixture reads to the viewport`, () => {
      const epic = makeTestEpic("triage", 1000, 1);
      let propReads = 0;
      const wrappedView = {
        ...view,
        plan: (input: OfficePlanInput): OfficeLayout => {
          const layout = view.plan(input);
          return {
            ...layout,
            props: new Proxy(layout.props, {
              get(target, key, receiver) {
                if (typeof key === "string" && /^\d+$/.test(key)) {
                  propReads += 1;
                }
                const value: unknown = Reflect.get(target, key, receiver);
                return value;
              },
            }),
          };
        },
      };
      const data = sceneInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        partition: populationFor(epic),
      });
      const scene = new OfficeScene(wrappedView, null);
      scene.sync(data);
      const layout = scene.layout();
      if (layout === null) throw new Error("expected a scene layout");
      const plaza = layout.floors.at(0);
      if (plaza === undefined) throw new Error("expected a plaza floor");
      const rect = {
        x: plaza.bounds.col * OFFICE_TILE,
        y: plaza.bounds.row * OFFICE_TILE,
        width: 400,
        height: 80,
      };
      scene.frame(1, rect);
      propReads = 0;
      scene.frame(1, rect);
      expect(propReads, `${view.id} repeated frame prop reads`).toBeLessThan(
        10_000,
      );
    });
  }

  const chunkSource = makeTestEpic("many-roots", 3, 1);
  const chunkEpic: OfficeTestEpic = {
    agents: chunkSource.agents.map((agent, index) => ({
      ...agent,
      hostId: `host-${index}`,
    })),
    statusById: chunkSource.statusById,
  };
  for (const view of [TOWERS_VIEW, BUILDING_VIEW]) {
    it(`${view.id} includes static sprites overlapping a 512px chunk edge`, () => {
      const layout = view.plan(initialInput(chunkEpic, VIEWPORTS[0]));
      const all = view.painter.floor(
        layout,
        { col: 0, row: 0, cols: layout.cols, rows: layout.rows },
        1,
      );
      const reception = all.find(
        (drawable) =>
          drawable.kind === "sprite" &&
          drawable.sprite.name === "reception" &&
          drawable.x === 1008,
      );
      expect(reception).toBeDefined();
      const leftChunk = view.painter.floor(
        layout,
        { col: 32, row: 0, cols: 32, rows: 32 },
        1,
      );
      const rightChunk = view.painter.floor(
        layout,
        { col: 64, row: 0, cols: 32, rows: 32 },
        1,
      );
      expect(
        leftChunk.some(
          (drawable) =>
            drawable.kind === "sprite" &&
            drawable.sprite.name === "reception" &&
            drawable.x === 1008,
        ),
      ).toBe(true);
      expect(
        rightChunk.some(
          (drawable) =>
            drawable.kind === "sprite" &&
            drawable.sprite.name === "reception" &&
            drawable.x === 1008,
        ),
      ).toBe(true);
    });
  }

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

/**
 * Fixup 6, rule 2 (finding M3-towers): a plate's box used to be centred on its
 * text at whatever length the plan wrote, never checked against the pod it
 * sat over - `TEAM-6-LE│TEAM-8-LEAD│TEAM-10-LEAD` clipped across three
 * neighbouring pods because nothing shrank the reading OR checked its box
 * against the next one's. The general property below is `office-board-fit
 * .test.ts`'s own shape, run over every resolved PLATE (not board) the two
 * bench populations produce: it fits its own pod in pixels, it fits the
 * renderer's character budget (so nothing is left for the renderer to cut),
 * and no two plates on one storey's row overlap. The case after it pins the
 * live sitting's own reproduction.
 */
describe("oblique plates: fixup 6 rule 2 - plates fit their pods and never overlap", () => {
  const ZOOMS: ReadonlyArray<number> = [0.7, 0.92, 1.6];
  const BENCH_POPULATIONS: ReadonlyArray<{
    readonly label: string;
    readonly epic: OfficeTestEpic;
  }> = [
    { label: "two-hosts/400", epic: makeTestEpic("two-hosts", 400, 1) },
    { label: "many-roots/1000", epic: makeTestEpic("many-roots", 1000, 1) },
  ];

  function plateFitAndOverlapOffenders(args: {
    readonly label: string;
    readonly viewId: string;
    readonly drawn: ReadonlyArray<OfficeSignToDraw>;
    readonly zoom: number;
  }): string[] {
    const { label, viewId, drawn, zoom } = args;
    const offenders: string[] = [];
    for (const entry of drawn) {
      const available = entry.sign.widthTiles * OFFICE_TILE * zoom;
      const measured = measure(entry.text);
      if (measured > available) {
        offenders.push(
          `${label}/${viewId}/zoom=${zoom}: "${entry.text}" measures ${measured}px over its ${available}px pod`,
        );
      }
      const maxChars =
        entry.sign.widthTiles >= 2
          ? OFFICE_SIGN_PLATE_MAX_CHARS
          : OFFICE_SIGN_NARROW_PLATE_MAX_CHARS;
      if (entry.text.length > maxChars) {
        offenders.push(
          `${label}/${viewId}/zoom=${zoom}: "${entry.text}" is ${entry.text.length} chars, over its ${maxChars}-char budget`,
        );
      }
    }
    // NO TWO PLATES ON ONE STOREY'S ROW OVERLAP. Grouped by the sign's own
    // tile row, which is the storey: two plates on different storeys stack
    // above and below each other and were never the finding's overlap.
    const byRow = new Map<number, OfficeSignToDraw[]>();
    for (const entry of drawn) {
      const row = entry.sign.tile.row;
      const bucket = byRow.get(row);
      if (bucket === undefined) byRow.set(row, [entry]);
      else bucket.push(entry);
    }
    for (const bucket of byRow.values()) {
      const boxes = bucket
        .map((entry) => {
          const width = measure(entry.text);
          const center = officeSignCenterX(entry) * zoom;
          return {
            left: center - width / 2,
            right: center + width / 2,
            text: entry.text,
          };
        })
        .sort((a, b) => a.left - b.left);
      for (let i = 1; i < boxes.length; i += 1) {
        if (boxes[i].left < boxes[i - 1].right) {
          offenders.push(
            `${label}/${viewId}/zoom=${zoom}: "${boxes[i - 1].text}" overlaps "${boxes[i].text}"`,
          );
        }
      }
    }
    return offenders;
  }

  it("keeps every resolved plate within its own pod's pixels and the renderer's character budget, and never overlapping its neighbour on the same storey, across both bench populations and every supported zoom", () => {
    const offenders: string[] = [];
    let combinationsChecked = 0;
    for (const { label, epic } of BENCH_POPULATIONS) {
      const statusById = new Map(epic.statusById);
      const names = new Map(epic.agents.map((agent) => [agent.id, agent.name]));
      const visibleAgentIds = new Set(epic.agents.map((agent) => agent.id));
      for (const view of [TOWERS_VIEW, BUILDING_VIEW]) {
        const layout = view.plan(initialInput(epic, VIEWPORTS[0]));
        // EVERY plate, not only the ones that declare a ladder: "the plates
        // this view draws all fit" is the property, and a filter on the field
        // the fix added would make the case pass on a plan that had stopped
        // declaring one.
        const plates = layout.signs.filter((sign) => sign.kind === "plate");
        expect(plates.length).toBeGreaterThan(0);
        for (const zoom of ZOOMS) {
          combinationsChecked += 1;
          const drawn = officeSignsToDraw({
            signs: plates,
            visibleAgentIds,
            statusById,
            nameById: names,
            hostNameById: new Map(),
            roleClaims: {},
            zoom,
            measure,
            projector: view.painter.projector(layout),
            lod: 1,
          });
          offenders.push(
            ...plateFitAndOverlapOffenders({
              label,
              viewId: view.id,
              drawn,
              zoom,
            }),
          );
        }
      }
    }
    // Not vacuous: real plates, on both populations and views, were actually
    // exercised - otherwise an empty `offenders` array would prove nothing.
    expect(combinationsChecked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("keeps team-6/-8/-10's adjacent two- and three-desk pods on Towers from colliding, at the live sitting's own reproduction", () => {
    const epic = makeTestEpic("two-hosts", 400, 1);
    const statusById = new Map(epic.statusById);
    const names = new Map(epic.agents.map((agent) => [agent.id, agent.name]));
    const visibleAgentIds = new Set(epic.agents.map((agent) => agent.id));
    const layout = TOWERS_VIEW.plan(initialInput(epic, VIEWPORTS[0]));
    const plates = ["team-6-lead", "team-8-lead", "team-10-lead"].map(
      (text) => {
        const sign = layout.signs.find(
          (candidate) => candidate.kind === "plate" && candidate.text === text,
        );
        if (sign === undefined) throw new Error(`expected a ${text} plate`);
        return sign;
      },
    );
    const resolvedAt = (zoom: number) =>
      officeSignsToDraw({
        signs: plates,
        visibleAgentIds,
        statusById,
        nameById: names,
        hostNameById: new Map(),
        roleClaims: {},
        zoom,
        measure,
        projector: TOWERS_VIEW.painter.projector(layout),
        lod: 1,
      });
    for (const zoom of [0.7, 0.92, 1.6]) {
      const drawn = resolvedAt(zoom);
      expect(drawn).toHaveLength(3);
      const sorted = [...drawn].sort(
        (a, b) => officeSignCenterX(a) - officeSignCenterX(b),
      );
      for (let i = 1; i < sorted.length; i += 1) {
        const prevRight =
          officeSignCenterX(sorted[i - 1]) * zoom +
          measure(sorted[i - 1].text) / 2;
        const nextLeft =
          officeSignCenterX(sorted[i]) * zoom - measure(sorted[i].text) / 2;
        // NO OVERLAP. The reproduction was `TEAM-6-LE│TEAM-8-LEAD│TEAM-10-
        // LEAD` clipping across three pods; the boxes below never cross now.
        expect(nextLeft).toBeGreaterThanOrEqual(prevRight);
      }
    }
    // The two FOUR-TILE pods never keep the full `team-N-lead` reading - the
    // reproduction's own overflow - while the EIGHT-TILE `team-10-lead` pod
    // has the room for it at office zoom.
    const byText = new Map(
      resolvedAt(1).map((entry) => [entry.sign.text, entry.text]),
    );
    expect(byText.get("team-6-lead")).not.toBe("team-6-lead");
    expect(byText.get("team-8-lead")).not.toBe("team-8-lead");
    expect(byText.get("team-10-lead")).toBe("team-10-lead");
  });

  it("pins team-26-lead's own pod ladder at zooms 0.7, 0.92 and 1.6", () => {
    const epic = makeTestEpic("two-hosts", 400, 1);
    const statusById = new Map(epic.statusById);
    const names = new Map(epic.agents.map((agent) => [agent.id, agent.name]));
    const visibleAgentIds = new Set(epic.agents.map((agent) => agent.id));
    const layout = TOWERS_VIEW.plan(initialInput(epic, VIEWPORTS[0]));
    const sign = layout.signs.find(
      (candidate) =>
        candidate.kind === "plate" && candidate.text === "team-26-lead",
    );
    if (sign === undefined) throw new Error("expected a team-26-lead plate");
    // Six tiles at this population - checked here rather than assumed, since
    // the pod a real plan gives a lead is a fact about the packing.
    expect(sign.widthTiles).toBe(6);
    const resolvedAt = (zoom: number): string | undefined =>
      officeSignsToDraw({
        signs: [sign],
        visibleAgentIds,
        statusById,
        nameById: names,
        hostNameById: new Map(),
        roleClaims: {},
        zoom,
        measure,
        projector: TOWERS_VIEW.painter.projector(layout),
        lod: 1,
      })[0]?.text;
    expect(resolvedAt(0.7)).toBe("team-26");
    expect(resolvedAt(0.92)).toBe("team-26");
    expect(resolvedAt(1.6)).toBe("team-26-lead");
  });
});

/**
 * Fixup 6, rule 4 (finding L4): `seatProps` used to draw a `reserve` label
 * under EVERY empty desk at close-up, so a vacant fifteen-desk storey painted
 * the same word fifteen times and competed with the name tags close-up exists
 * to show. `obliqueReserveLabelSeatId` now names one seat per storey - the one
 * nearest its own centre - and only that seat's empty desk draws the label.
 */
describe("oblique painters: fixup 6 rule 4 - one reserve label per storey, not one per empty desk", () => {
  it("paints at most one reserve label per storey while dozens of desks sit empty, on two-hosts/400 Building", () => {
    const epic = makeTestEpic("two-hosts", 400, 1);
    const layout = planBuilding(initialInput(epic, VIEWPORTS[0]));
    const painter = BUILDING_VIEW.painter;
    const assignedSeatIds = new Set(
      [...layout.desks.values()].map((desk) => desk.seatId),
    );
    let emptyDeskSeats = 0;
    const labelCountByFloor = new Map<number, number>();
    for (const seat of layout.seats.values()) {
      if (seat.kind !== "desk" || assignedSeatIds.has(seat.seatId)) continue;
      emptyDeskSeats += 1;
      const props = painter.seatProps(layout, seat, idleDeskState(null), 2);
      const hasLabel = props.some(
        (item) =>
          item.drawable.kind === "label" && item.drawable.text === "reserve",
      );
      if (hasLabel) {
        labelCountByFloor.set(
          seat.floorIndex,
          (labelCountByFloor.get(seat.floorIndex) ?? 0) + 1,
        );
      }
    }
    // DOZENS of empty desks - the noise L4 measured - not a handful, and a
    // double-figure count of storeys that DO carry a label, so the case is
    // not vacuously true of a population with nothing empty to label. Said as
    // floors rather than as this packing's exact 97 and 15: the property is
    // "one a storey however many are empty", and a packing change that moves
    // those two numbers is not a regression of it.
    expect(emptyDeskSeats).toBeGreaterThan(50);
    expect(labelCountByFloor.size).toBeGreaterThan(9);
    // EVERY labelled storey got EXACTLY one - never the fifteen identical
    // "reserve"s a per-cubby label used to paint across one vacant storey.
    expect([...labelCountByFloor.values()].every((count) => count === 1)).toBe(
      true,
    );
  });

  it("names the empty seat nearest the storey's own centre column, not a fixed slot index", () => {
    const epic = makeTestEpic("two-hosts", 400, 1);
    const layout = planBuilding(initialInput(epic, VIEWPORTS[0]));
    const assignedSeatIds = new Set(
      [...layout.desks.values()].map((desk) => desk.seatId),
    );
    const deskSeatsByFloor = new Map<number, OfficeSeat[]>();
    for (const seat of layout.seats.values()) {
      if (seat.kind !== "desk") continue;
      const bucket = deskSeatsByFloor.get(seat.floorIndex);
      if (bucket === undefined) deskSeatsByFloor.set(seat.floorIndex, [seat]);
      else bucket.push(seat);
    }
    let floorsChecked = 0;
    for (const [floorIndex, seats] of deskSeatsByFloor) {
      const empty = seats.filter((seat) => !assignedSeatIds.has(seat.seatId));
      if (empty.length === 0) continue;
      const cols = seats.map((seat) => seat.deskTile.col);
      const centre = (Math.min(...cols) + Math.max(...cols)) / 2;
      // The SAME rule `reserveLabelSeats` (`oblique-plan.ts`) applies: nearest
      // to the centre column, ties broken by the first encountered in
      // ascending column order - which is also this storey's own slot order.
      const nearest = [...empty]
        .sort((a, b) => a.deskTile.col - b.deskTile.col)
        .reduce<OfficeSeat | null>((closest, candidate) => {
          if (closest === null) return candidate;
          const candidateDistance = Math.abs(candidate.deskTile.col - centre);
          const closestDistance = Math.abs(closest.deskTile.col - centre);
          return candidateDistance < closestDistance ? candidate : closest;
        }, null);
      if (nearest === null) continue;
      floorsChecked += 1;
      expect(obliqueReserveLabelSeatId(layout, floorIndex)).toBe(
        nearest.seatId,
      );
    }
    // Not vacuous: at least one storey with an empty desk was actually
    // checked.
    expect(floorsChecked).toBeGreaterThan(0);
  });
});
