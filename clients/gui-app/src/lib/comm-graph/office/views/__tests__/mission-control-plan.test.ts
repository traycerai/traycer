/**
 * Mission control plan: amphitheatre packing, growth, hosts, and the shared
 * layout invariants at the scales the fit estimates are quoted at.
 */
import { describe, expect, it } from "vitest";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import {
  officeSpriteColors,
  officeSpriteMaps,
  rasterizeSpriteMap,
} from "@/lib/comm-graph/office/office-pixel-art";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import type { OfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type { OfficeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  frozenOf,
  isMissionControlFrozen,
  TIER_BASE_SEATS,
  TIER_SEAT_GROWTH,
  tierSeatCount,
} from "@/lib/comm-graph/office/views/mission-control/mission-control-plan";
import type { MissionControlFrozen } from "@/lib/comm-graph/office/views/mission-control/mission-control-plan";
import { MISSION_CONTROL_VIEW } from "@/lib/comm-graph/office/views/mission-control/mission-control-view";
import type {
  OfficeDeskState,
  OfficePlanInput,
  OfficeView,
} from "@/lib/comm-graph/office/views/office-view";
import {
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeDrawable,
  type OfficeErrandSpot,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeLayout,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeSize,
  type OfficeSpriteName,
  type OfficeTilePos,
} from "@/lib/comm-graph/office/office-types";

const TRIAGE_SCALES: ReadonlyArray<number> = [12, 309, 1000];
const VIEWPORT_WIDE: OfficeSize = { width: 1280, height: 700 };
const VIEWPORT_NARROW: OfficeSize = { width: 680, height: 440 };
const EMPTY_OCCUPANCY: ReadonlyMap<string, string> = new Map();
const EMPTY_NEEDS: ReadonlyArray<string> = [];
const EMPTY_ACTIVITY: ReadonlyMap<string, number> = new Map();

/** Measured from `planMissionControl` on triage seed 1; not the ticket estimates. */
const PINNED_FIT = {
  agents309: {
    wide: 0.8413461538461539,
    narrow: 0.5059523809523809,
  },
  agents1000: {
    wide: 0.4654255319148936,
    narrow: 0.2925531914893617,
  },
} as const;

interface Planned {
  readonly input: OfficePlanInput;
  readonly partition: OfficePopulation;
  readonly layout: OfficeLayout;
}

function isWalkable(layout: OfficeLayout, tile: OfficeTilePos): boolean {
  return layout.walkable[tile.row]?.[tile.col];
}

function floorBandContains(floor: OfficeFloor, row: number): boolean {
  return row >= floor.bounds.row && row < floor.bounds.row + floor.bounds.rows;
}

function occupancyOf(layout: OfficeLayout): Map<string, string> {
  const occupancy = new Map<string, string>();
  for (const desk of layout.desks.values()) {
    occupancy.set(desk.seatId, desk.agentId);
  }
  return occupancy;
}

function nextCreatedAt(agents: ReadonlyArray<OfficeAgentInput>): number {
  let max = 0;
  for (const agent of agents) {
    if (agent.createdAt > max) max = agent.createdAt;
  }
  return max + 1;
}

function aisleIndexOf(layout: OfficeLayout, id: string): number {
  const lead = layout.desks.get(id);
  if (lead === undefined) throw new Error(`missing lead ${id}`);
  const seats = [...layout.seats.values()]
    .filter(
      (seat) =>
        seat.kind === "console" && seat.deskTile.row === lead.deskTile.row,
    )
    .sort((left, right) => left.deskTile.col - right.deskTile.col);
  const index = seats.findIndex((seat) => seat.seatId === lead.seatId);
  if (
    index === 0 ||
    index === seats.length - 1 ||
    index % 12 === 0 ||
    index % 12 === 11
  ) {
    return -1;
  }
  return index;
}

function teamSizedEpic(sizes: ReadonlyArray<number>): OfficeTestEpic {
  const sample = makeTestEpic("many-roots", 1, 1);
  const root = sample.agents[0];
  const agents: OfficeAgentInput[] = [root];
  for (let t = 0; t < sizes.length; t += 1) {
    const lead = childAgent(root, `team-${t}-lead`, agents.length);
    agents.push(lead);
    for (let m = 1; m < sizes[t]; m += 1) {
      agents.push(childAgent(lead, `team-${t}-member-${m}`, agents.length));
    }
  }
  return { agents, statusById: new Map() };
}

function childAgent(
  parent: OfficeAgentInput,
  id: string,
  createdAt: number,
): OfficeAgentInput {
  return {
    id,
    name: id,
    kind: parent.kind,
    hostId: parent.hostId,
    archivedAt: null,
    modelTier: parent.modelTier,
    harnessId: parent.harnessId,
    model: parent.model,
    parentId: parent.id,
    archived: false,
    createdAt,
    appearance: parent.appearance,
  };
}

function appendChildren(
  agents: ReadonlyArray<OfficeAgentInput>,
  parent: OfficeAgentInput,
  ids: ReadonlyArray<string>,
): ReadonlyArray<OfficeAgentInput> {
  const createdAt = nextCreatedAt(agents);
  const born: OfficeAgentInput[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    born.push(childAgent(parent, ids[i], createdAt + i));
  }
  return [...agents, ...born];
}

function withIdleStatuses(
  previous: ReadonlyMap<string, OfficeAgentStatus>,
  agentIds: ReadonlyArray<string>,
): Map<string, OfficeAgentStatus> {
  const next = new Map(previous);
  for (const agentId of agentIds) next.set(agentId, "idle");
  return next;
}

function agentById(
  agents: ReadonlyArray<OfficeAgentInput>,
  id: string,
): OfficeAgentInput {
  const found = agents.find((agent) => agent.id === id);
  if (found === undefined) {
    throw new Error(`no agent ${id}`);
  }
  return found;
}

function rootAgent(agents: ReadonlyArray<OfficeAgentInput>): OfficeAgentInput {
  const found = agents.find((agent) => agent.parentId === null);
  if (found === undefined) {
    throw new Error("test epic has no root agent");
  }
  return found;
}

function requireFrozen(layout: OfficeLayout): MissionControlFrozen {
  const frozen = frozenOf(layout);
  if (frozen === null) {
    throw new Error("mission-control layout missing frozen metadata");
  }
  return frozen;
}

function consoleIndexOf(seatId: string): number | null {
  const prefix = "-/0/hall/";
  if (!seatId.startsWith(prefix)) return null;
  const raw = seatId.slice(prefix.length);
  if (raw === "podium") return null;
  const index = Number.parseInt(raw, 10);
  if (!Number.isFinite(index)) return null;
  return index;
}

function lastTierStartIndex(counts: ReadonlyArray<number>): number {
  let start = 0;
  for (let i = 0; i < counts.length - 1; i += 1) start += counts[i];
  return start;
}

function consoleSeatId(index: number): string {
  return `-/0/hall/${index}`;
}

function emptyUnreservedLastTierCount(layout: OfficeLayout): number {
  const frozen = requireFrozen(layout);
  const start = lastTierStartIndex(frozen.tierSeatCounts);
  const lastCount = frozen.tierSeatCounts[frozen.tierSeatCounts.length - 1];
  const reserved = new Set(
    frozen.teamReserveSeatIds.map((entry) => entry.seatId),
  );
  const occupied = occupancyOf(layout);
  let empty = 0;
  for (let i = 0; i < lastCount; i += 1) {
    const seatId = consoleSeatId(start + i);
    if (occupied.has(seatId)) continue;
    if (reserved.has(seatId)) continue;
    empty += 1;
  }
  return empty;
}

function expectSeatsUnmoved(previous: OfficeLayout, next: OfficeLayout): void {
  for (const seat of previous.seats.values()) {
    const grown = next.seats.get(seat.seatId);
    expect(grown).toBeDefined();
    if (grown === undefined) continue;
    expect(grown.deskTile).toEqual(seat.deskTile);
    expect(grown.chairTile).toEqual(seat.chairTile);
  }
}

function expectOccupantsHold(previous: OfficeLayout, next: OfficeLayout): void {
  for (const desk of previous.desks.values()) {
    expect(next.desks.get(desk.agentId)?.seatId).toBe(desk.seatId);
  }
}

function fitInViewport(layout: OfficeLayout, viewport: OfficeSize): number {
  return Math.min(
    viewport.width / (layout.cols * OFFICE_TILE),
    viewport.height / (layout.rows * OFFICE_TILE),
  );
}

function planOffice(args: {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly occupancy: ReadonlyMap<string, string>;
  readonly needsCapacity: ReadonlyArray<string>;
  readonly viewport: OfficeSize;
  readonly previousLayout: OfficeLayout | null;
  readonly previousPartition: OfficePopulation | null;
}): Planned {
  const partition = partitionOfficePopulation({
    agents: args.agents,
    statusById: args.statusById,
    previous: args.previousPartition,
  });
  const input: OfficePlanInput = {
    agents: args.agents,
    partition,
    occupancy: args.occupancy,
    needsCapacity: args.needsCapacity,
    activityById: EMPTY_ACTIVITY,
    viewport: args.viewport,
    previous: args.previousLayout,
  };
  return {
    input,
    partition,
    layout: MISSION_CONTROL_VIEW.plan(input),
  };
}

function planFresh(epic: OfficeTestEpic, viewport: OfficeSize): Planned {
  return planOffice({
    agents: epic.agents,
    statusById: epic.statusById,
    occupancy: EMPTY_OCCUPANCY,
    needsCapacity: EMPTY_NEEDS,
    viewport,
    previousLayout: null,
    previousPartition: null,
  });
}

function growPlan(request: {
  readonly previous: Planned;
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly arrivals: ReadonlyArray<string>;
  readonly viewport: OfficeSize;
}): Planned {
  return planOffice({
    agents: request.agents,
    statusById: request.statusById,
    occupancy: occupancyOf(request.previous.layout),
    needsCapacity: request.arrivals,
    viewport: request.viewport,
    previousLayout: request.previous.layout,
    previousPartition: request.previous.partition,
  });
}

describe("planMissionControl", () => {
  it("grows tier widths by two", () => {
    const epic = makeTestEpic("triage", 309, 1);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const frozen = requireFrozen(planned.layout);
    expect(frozen.tierSeatCounts.length).toBeGreaterThan(0);
    for (let r = 0; r < frozen.tierSeatCounts.length; r += 1) {
      expect(frozen.tierSeatCounts[r]).toBe(
        TIER_BASE_SEATS + TIER_SEAT_GROWTH * r,
      );
      expect(frozen.tierSeatCounts[r]).toBe(tierSeatCount(r));
    }
  });

  it("seats a child joining an earlier team on that team's free reserve", () => {
    const epic = makeTestEpic("triage", 40, 1);
    const prior = planFresh(epic, VIEWPORT_WIDE);
    const frozen = requireFrozen(prior.layout);
    expect(frozen.teamReserveSeatIds.length).toBeGreaterThan(0);
    const reserve = frozen.teamReserveSeatIds[0];
    expect(occupancyOf(prior.layout).has(reserve.seatId)).toBe(false);

    const lead = agentById(epic.agents, reserve.teamId);
    const childId = "join-reserve-child";
    const agents = appendChildren(epic.agents, lead, [childId]);
    const grown = growPlan({
      previous: prior,
      agents,
      statusById: withIdleStatuses(epic.statusById, [childId]),
      arrivals: [childId],
      viewport: VIEWPORT_WIDE,
    });

    expect(grown.layout.desks.get(childId)?.seatId).toBe(reserve.seatId);
    expectOccupantsHold(prior.layout, grown.layout);
    expectSeatsUnmoved(prior.layout, grown.layout);
  });

  it("seats a later team child at the last-tier tail once the reserve is taken", () => {
    const epic = makeTestEpic("triage", 40, 1);
    const prior = planFresh(epic, VIEWPORT_WIDE);
    const frozen = requireFrozen(prior.layout);
    expect(frozen.teamReserveSeatIds.length).toBeGreaterThan(0);
    const reserve = frozen.teamReserveSeatIds[0];
    const lead = agentById(epic.agents, reserve.teamId);
    const firstId = "join-reserve-first";
    const overflowId = "join-reserve-overflow";

    const afterFirstAgents = appendChildren(epic.agents, lead, [firstId]);
    const afterFirst = growPlan({
      previous: prior,
      agents: afterFirstAgents,
      statusById: withIdleStatuses(epic.statusById, [firstId]),
      arrivals: [firstId],
      viewport: VIEWPORT_WIDE,
    });
    expect(afterFirst.layout.desks.get(firstId)?.seatId).toBe(reserve.seatId);

    const afterOverflowAgents = appendChildren(afterFirstAgents, lead, [
      overflowId,
    ]);
    const grown = growPlan({
      previous: afterFirst,
      agents: afterOverflowAgents,
      statusById: withIdleStatuses(epic.statusById, [firstId, overflowId]),
      arrivals: [overflowId],
      viewport: VIEWPORT_WIDE,
    });

    const overflowDesk = grown.layout.desks.get(overflowId);
    expect(overflowDesk).toBeDefined();
    if (overflowDesk === undefined) return;
    expect(overflowDesk.seatId).not.toBe(reserve.seatId);
    const index = consoleIndexOf(overflowDesk.seatId);
    expect(index).not.toBeNull();
    if (index === null) return;
    const lastStart = lastTierStartIndex(
      requireFrozen(grown.layout).tierSeatCounts,
    );
    expect(index).toBeGreaterThanOrEqual(lastStart);

    expectOccupantsHold(afterFirst.layout, grown.layout);
    expectSeatsUnmoved(afterFirst.layout, grown.layout);
  });

  it("appends a tier when the last tier is full and moves no existing seat", () => {
    const epic = makeTestEpic("triage", 40, 1);
    const prior = planFresh(epic, VIEWPORT_WIDE);
    const empty = emptyUnreservedLastTierCount(prior.layout);
    const root = rootAgent(epic.agents);
    const ids: string[] = [];
    for (let i = 0; i < empty + 1; i += 1) {
      ids.push(`last-tier-fill-${i}`);
    }
    const agents = appendChildren(epic.agents, root, ids);
    const grown = growPlan({
      previous: prior,
      agents,
      statusById: withIdleStatuses(epic.statusById, ids),
      arrivals: ids,
      viewport: VIEWPORT_WIDE,
    });

    expect(grown.layout.shiftFromPrevious).toBeNull();
    expect(requireFrozen(grown.layout).tierSeatCounts.length).toBe(
      requireFrozen(prior.layout).tierSeatCounts.length + 1,
    );
    expectOccupantsHold(prior.layout, grown.layout);
    expectSeatsUnmoved(prior.layout, grown.layout);
    for (const id of ids) {
      expect(grown.layout.desks.has(id)).toBe(true);
    }
  });

  it("gives two hosts two host signs and two host bands on one floor", () => {
    const epic = makeTestEpic("two-hosts", 60, 1);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const layout = planned.layout;

    expect(layout.floors).toHaveLength(1);
    const floor = layout.floors[0];
    // One mixed hall: the floor is not a host storey, so its hostId is null
    // while seats keep the agent host the colour bands are drawn from.
    expect(floor.hostId).toBeNull();

    const hostSigns = layout.signs.filter((sign) => sign.kind === "host");
    expect(hostSigns).toHaveLength(2);
    expect(new Set(hostSigns.map((sign) => sign.hostId))).toEqual(
      new Set(["host-a", "host-b"]),
    );

    const consoleHostIds = new Set<string>();
    for (const seat of layout.seats.values()) {
      expect(seat.floorIndex).toBe(0);
      // Hosted seats keep the agent host; the floor does not. Unassigned
      // general reserves may be hostless, matching the mixed floor.
      if (seat.hostId !== null) {
        expect(seat.hostId).not.toBe(floor.hostId);
      }
      if (seat.kind !== "console") continue;
      if (seat.hostId === null) continue;
      consoleHostIds.add(seat.hostId);
    }
    expect(consoleHostIds.has("host-a")).toBe(true);
    expect(consoleHostIds.has("host-b")).toBe(true);
    expect(consoleHostIds.size).toBe(2);
  });

  describe.each([
    {
      n: 309,
      viewport: VIEWPORT_WIDE,
      pinned: PINNED_FIT.agents309.wide,
      label: "1280×700",
    },
    {
      n: 309,
      viewport: VIEWPORT_NARROW,
      pinned: PINNED_FIT.agents309.narrow,
      label: "680×440",
    },
    {
      n: 1000,
      viewport: VIEWPORT_WIDE,
      pinned: PINNED_FIT.agents1000.wide,
      label: "1280×700",
    },
    {
      n: 1000,
      viewport: VIEWPORT_NARROW,
      pinned: PINNED_FIT.agents1000.narrow,
      label: "680×440",
    },
  ])("fit at $n agents in $label", ({ n, viewport, pinned }) => {
    it("pins the measured fit", () => {
      const epic = makeTestEpic("triage", n, 1);
      const planned = planFresh(epic, viewport);
      const fit = fitInViewport(planned.layout, viewport);
      expect(fit).toBeCloseTo(pinned, 2);
    });
  });
});

describe("planMissionControl contract", () => {
  describe.each(TRIAGE_SCALES)("triage at %i agents", (n) => {
    const epic = makeTestEpic("triage", n, 1);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const layout = planned.layout;
    const agentIds = new Set(epic.agents.map((agent) => agent.id));

    it("seats every agent exactly once, with every seat id unique", () => {
      expect(layout.desks.size).toBe(n);
      for (const agentId of agentIds)
        expect(layout.desks.has(agentId)).toBe(true);

      const seatIds = new Set<string>();
      for (const seat of layout.seats.values()) {
        expect(seatIds.has(seat.seatId)).toBe(false);
        seatIds.add(seat.seatId);
      }
      for (const desk of layout.desks.values()) {
        expect(layout.seats.get(desk.seatId)).toEqual(desk);
      }
    });

    it("lets every chair reach its own floor's door", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        const path = findOfficePath(layout, desk.chairTile, floor.doorTile);
        expect(path).not.toBeNull();
      }
    });

    it("keeps every spot approach tile, corridor tile and visit tile walkable", () => {
      for (const floor of layout.floors) {
        for (const spot of floor.errandSpots) {
          expect(isWalkable(layout, spot.approachTile)).toBe(true);
        }
        for (const corridorTile of floor.corridorTiles) {
          expect(isWalkable(layout, corridorTile)).toBe(true);
        }
      }
      for (const room of layout.rooms) {
        if (room.visitTile === null) continue;
        expect(isWalkable(layout, room.visitTile)).toBe(true);
      }
    });

    it("names an agent that exists for every sign with an owner", () => {
      for (const sign of layout.signs) {
        if (sign.ownerAgentId === null) continue;
        expect(agentIds.has(sign.ownerAgentId)).toBe(true);
      }
    });

    it("resolves every seat.roomId to the single hall room", () => {
      expect(layout.rooms).toHaveLength(1);
      expect(layout.rooms[0].rootAgentId).toBe("hall");
      for (const seat of layout.seats.values()) {
        const room = layout.rooms.find(
          (candidate) => candidate.rootAgentId === seat.roomId,
        );
        expect(room).toBeDefined();
      }
    });

    it("is one stable mission-control floor", () => {
      expect(layout.floors).toHaveLength(1);
      expect(layout.stable).toBe(true);
      expect(layout.view).toBe("mission-control");
      expect(layout.view).toBe(MISSION_CONTROL_VIEW.id);
      expect(isMissionControlFrozen(layout.frozen)).toBe(true);
      for (const desk of layout.desks.values()) {
        expect(desk.floorIndex).toBe(0);
        expect(floorBandContains(layout.floors[0], desk.deskTile.row)).toBe(
          true,
        );
      }
    });

    it("uses console seats facing up and a podium desk facing down", () => {
      let consoleCount = 0;
      for (const seat of layout.seats.values()) {
        if (seat.kind !== "console") continue;
        expect(seat.hitTiles).toEqual({ width: 2, height: 1 });
        expect(seat.facing).toBe("up");
        consoleCount += 1;
      }
      expect(consoleCount).toBeGreaterThan(0);

      const podium = [...layout.seats.values()].find(
        (seat) => seat.kind === "desk",
      );
      expect(podium).toBeDefined();
      if (podium === undefined) return;
      expect(podium.facing).toBe("down");
      expect(podium.seatId).toBe("-/0/hall/podium");
    });

    it("matches measureMissionControl to cols×OFFICE_TILE by rows×OFFICE_TILE", () => {
      const measured = MISSION_CONTROL_VIEW.measure(planned.input);
      expect(measured).toEqual({
        width: layout.cols * OFFICE_TILE,
        height: layout.rows * OFFICE_TILE,
      });
    });

    it("gives cafe tables distinct fixture ids and the pingpong pair one id", () => {
      const spots: ReadonlyArray<OfficeErrandSpot> =
        layout.floors[0].errandSpots;
      const cafe = spots.filter((spot) => spot.kind === "cafe");
      expect(cafe.length).toBeGreaterThanOrEqual(2);
      const cafeRows = new Set(cafe.map((spot) => spot.tile.row));
      for (const row of cafeRows) {
        const ids = new Set(
          cafe
            .filter((spot) => spot.tile.row === row)
            .map((spot) => spot.fixtureId),
        );
        expect(ids.size).toBeGreaterThan(1);
      }

      const pingpong = spots.filter((spot) => spot.kind === "pingpong");
      expect(pingpong).toHaveLength(2);
      expect(pingpong[0].fixtureId).toBe(pingpong[1].fixtureId);
    });
  });
});

const WHOLE_WORLD = { x: 0, y: 0, width: 10000, height: 10000 };
const DESK_STATE: OfficeDeskState = {
  agentId: "probe",
  name: "probe",
  status: "working",
  sheeted: false,
  openRequests: 3,
  screenFrame: 0,
  harnessId: null,
  modelTier: "medium",
  accentId: null,
};

function sceneInputFor(input: OfficePlanInput): OfficeSceneInput {
  return {
    agents: input.agents,
    partition: input.partition,
    activityById: input.activityById,
    viewport: input.viewport,
    visibleAgentIds: new Set(input.agents.map((agent) => agent.id)),
    statusById: new Map(input.agents.map((agent) => [agent.id, "working"])),
    openRequestsByReceiver: new Map(),
    pulse: null,
    pulseKey: null,
    stepMs: 800,
    cursorMs: null,
    clockMs: 0,
    playing: false,
    reducedMotion: false,
  };
}

function sceneOf(epic: OfficeTestEpic): OfficeScene {
  const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
  scene.sync(sceneInputFor(planFresh(epic, VIEWPORT_WIDE).input));
  return scene;
}

function requireLayout(scene: OfficeScene): OfficeLayout {
  const layout = scene.layout();
  if (layout === null) throw new Error("scene has no layout");
  return layout;
}

function frameDrawables(frame: OfficeFrame): ReadonlyArray<OfficeDrawable> {
  const world =
    frame.world === null ? [] : frame.world.map((entry) => entry.drawable);
  return [...frame.floor, ...frame.props, ...frame.actors, ...world];
}

function spriteCount(
  draws: ReadonlyArray<OfficeDrawable>,
  name: OfficeSpriteName,
): number {
  return draws.filter(
    (drawable) => drawable.kind === "sprite" && drawable.sprite.name === name,
  ).length;
}

function floorSpriteAtTile(
  draws: ReadonlyArray<OfficeDrawable>,
  tile: OfficeTilePos,
): OfficeSpriteName | null {
  const sprites = draws.filter(
    (drawable) =>
      drawable.kind === "sprite" &&
      drawable.x === tile.col * OFFICE_TILE &&
      drawable.y === tile.row * OFFICE_TILE,
  );
  const last = sprites.at(-1);
  if (last === undefined || last.kind !== "sprite") return null;
  return last.sprite.name;
}

function firstConsole(layout: OfficeLayout): OfficeSeat {
  for (const seat of layout.seats.values()) {
    if (seat.kind === "console") return seat;
  }
  throw new Error("no console seat");
}

function grownFrom(
  input: OfficePlanInput,
  previous: OfficeLayout,
  arrivals: ReadonlyArray<OfficeAgentInput>,
): OfficePlanInput {
  const agents = [...input.agents, ...arrivals];
  const statuses = new Map<string, OfficeAgentStatus>(
    agents.map((agent) => [agent.id, "working"]),
  );
  const occupancy = new Map<string, string>();
  for (const desk of previous.desks.values()) {
    occupancy.set(desk.seatId, desk.agentId);
  }
  return {
    agents,
    partition: partitionOfficePopulation({
      agents,
      statusById: statuses,
      previous: input.partition,
    }),
    occupancy,
    needsCapacity: [],
    activityById: input.activityById,
    viewport: input.viewport,
    previous,
  };
}

function rasterColors(name: OfficeSpriteName): string[] {
  const entry = officeSpriteMaps().find((item) => item.name === name);
  if (entry === undefined) return [];
  const paint = rasterizeSpriteMap(
    entry.map,
    officeSpriteColors({ name }, "dark"),
    false,
  );
  const colors = new Set<string>();
  for (let i = 0; i < paint.pixels.length; i += 4) {
    colors.add(Array.from(paint.pixels.slice(i, i + 4)).join(","));
  }
  return [...colors].sort();
}

function consoleCoversPixel(request: {
  readonly draws: ReadonlyArray<OfficeDrawable>;
  readonly afterIndex: number;
  readonly px: number;
  readonly py: number;
  readonly consoleMap: ReadonlyArray<string>;
}): boolean {
  for (let i = request.afterIndex; i < request.draws.length; i += 1) {
    const later = request.draws[i];
    if (later.kind !== "sprite") continue;
    if (later.sprite.name !== "console") continue;
    const lx = request.px - later.x;
    const ly = request.py - later.y;
    if (lx < 0 || ly < 0 || ly >= request.consoleMap.length) continue;
    const row = request.consoleMap[ly];
    if (lx >= row.length) continue;
    if (row[lx] !== ".") return true;
  }
  return false;
}

function exposedStepPixels(
  draws: ReadonlyArray<OfficeDrawable>,
  steps: ReadonlyArray<OfficeDrawable>,
): number {
  const maps = new Map(
    officeSpriteMaps().map((entry) => [entry.name, entry.map]),
  );
  const consoleMap = maps.get("console");
  if (consoleMap === undefined) throw new Error("no console map");
  let exposed = 0;
  for (const step of steps) {
    if (step.kind !== "sprite") continue;
    const map = maps.get(step.sprite.name);
    if (map === undefined) throw new Error("no step map");
    const raster = rasterizeSpriteMap(
      map,
      officeSpriteColors(step.sprite, "dark"),
      false,
    );
    const afterIndex = draws.indexOf(step) + 1;
    for (let y = 0; y < raster.height; y += 1) {
      for (let x = 0; x < raster.width; x += 1) {
        if (raster.pixels[(y * raster.width + x) * 4 + 3] === 0) continue;
        if (
          !consoleCoversPixel({
            draws,
            afterIndex,
            px: step.x + x,
            py: step.y + y,
            consoleMap,
          })
        ) {
          exposed += 1;
        }
      }
    }
  }
  return exposed;
}

function countingReads<T>(
  items: ReadonlyArray<T>,
  onRead: () => void,
): ReadonlyArray<T> {
  return new Proxy(items, {
    get(target, property) {
      if (property === "length") return target.length;
      if (property === "every") return target.every.bind(target);
      if (property === "map") return target.map.bind(target);
      if (property === "filter") return target.filter.bind(target);
      if (property === Symbol.iterator) {
        return target[Symbol.iterator].bind(target);
      }
      if (typeof property === "string" && /^\d+$/.test(property)) {
        onRead();
        return target[Number.parseInt(property, 10)];
      }
      return undefined;
    },
  });
}

function countingIndexReads<T>(
  items: ReadonlyArray<T>,
  seen: number[],
): ReadonlyArray<T> {
  return new Proxy(items, {
    get(target, property) {
      if (property === "length") return target.length;
      if (property === "every") {
        return (
          predicate: (value: T, index: number, array: readonly T[]) => boolean,
        ) => target.every(predicate);
      }
      if (typeof property === "string" && /^\d+$/.test(property)) {
        const index = Number.parseInt(property, 10);
        seen.push(index);
        return target[index];
      }
      return undefined;
    },
  });
}

function sceneAdvance(
  input: OfficePlanInput,
  scene: OfficeScene,
  agents: ReadonlyArray<OfficeAgentInput>,
): OfficePlanInput {
  const previous = requireLayout(scene);
  const statuses = new Map<string, OfficeAgentStatus>(
    agents.map((agent) => [agent.id, "working"]),
  );
  const next: OfficePlanInput = {
    ...input,
    agents,
    partition: partitionOfficePopulation({
      agents,
      statusById: statuses,
      previous: input.partition,
    }),
    occupancy: occupancyOf(previous),
    previous,
  };
  scene.sync({ ...sceneInputFor(next), reducedMotion: true });
  return next;
}

class CountingSeatMap extends Map<string, OfficeSeat> {
  constructor(
    entries: Iterable<readonly [string, OfficeSeat]>,
    private readonly onVisit: () => void,
  ) {
    super(entries);
  }

  override *values(): MapIterator<OfficeSeat> {
    for (const seat of super.values()) {
      this.onVisit();
      yield seat;
    }
  }
}

describe("mission-control cold-review findings", () => {
  it("keeps the incumbent on the podium when an earlier HQ arrives from another host", () => {
    const fixture = makeTestEpic("many-roots", 2, 1);
    const agents = fixture.agents.map((agent, index) => ({
      ...agent,
      hostId: "host-a",
      createdAt: 100 + index,
    }));
    const epic: OfficeTestEpic = { ...fixture, agents };
    const input = planFresh(epic, VIEWPORT_WIDE).input;
    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    scene.sync(sceneInputFor(input));
    const prior = requireLayout(scene);
    const incumbent = input.agents[0];
    const arrival: OfficeAgentInput = {
      ...input.agents[0],
      id: "older-remote-hq",
      name: "Older remote HQ",
      hostId: "host-b",
      createdAt: 50,
    };
    const next = grownFrom(input, prior, [arrival]);
    scene.sync({ ...sceneInputFor(next), reducedMotion: true });
    const layout = requireLayout(scene);
    expect(layout.desks.size).toBe(3);
    expect(layout.desks.get(incumbent.id)?.seatId).toBe(
      prior.desks.get(incumbent.id)?.seatId,
    );
    expect(layout.desks.get(arrival.id)?.seatId).not.toBe("-/0/hall/podium");
    expect(scene.locate(incumbent.id)).not.toEqual(scene.locate(arrival.id));
    expect(scene.locate(arrival.id)).not.toBeNull();
  });

  it("paints every declared whiteboard, the reception and the bookcase", () => {
    const scene = sceneOf(makeTestEpic("triage", 40, 1));
    const layout = requireLayout(scene);
    const draws = frameDrawables(scene.frame(2, WHOLE_WORLD));
    const plannedBoard = layout.props.filter(
      (prop) => prop.sprite.name === "whiteboard",
    );
    expect(spriteCount(draws, "whiteboard")).toBe(plannedBoard.length);
    expect(spriteCount(draws, "whiteboard")).toBe(48);
    expect(spriteCount(draws, "reception")).toBe(1);
    expect(spriteCount(draws, "bookcase")).toBe(1);
  });

  it("tints only a team's own seats when that team overflows to the tail", () => {
    const input = planFresh(
      makeTestEpic("triage", 309, 1),
      VIEWPORT_WIDE,
    ).input;
    const prior = MISSION_CONTROL_VIEW.plan(input);
    const reserve = frozenOf(prior)?.teamReserveSeatIds[0];
    if (reserve === undefined) throw new Error("no reserve");
    const parent = input.agents.find((agent) => agent.id === reserve.teamId);
    if (parent === undefined) throw new Error("no lead");
    const first = grownFrom(input, prior, [
      childAgent(parent, "new-child-1", nextCreatedAt(input.agents)),
    ]);
    const one = MISSION_CONTROL_VIEW.plan(first);
    const second = grownFrom(first, one, [
      childAgent(parent, "new-child-2", nextCreatedAt(first.agents)),
    ]);
    const two = MISSION_CONTROL_VIEW.plan(second);
    const oldFloor = MISSION_CONTROL_VIEW.painter.floor(
      prior,
      { col: 0, row: 0, cols: prior.cols, rows: prior.rows },
      1,
    );
    const newFloor = MISSION_CONTROL_VIEW.painter.floor(
      two,
      { col: 0, row: 0, cols: two.cols, rows: two.rows },
      1,
    );
    const changed: string[] = [];
    for (const [id, desk] of prior.desks) {
      if (input.partition.members.get(id)?.teamId !== null) continue;
      const probe = { col: desk.chairTile.col + 1, row: desk.chairTile.row };
      if (
        floorSpriteAtTile(oldFloor, probe) !==
        floorSpriteAtTile(newFloor, probe)
      ) {
        changed.push(id);
      }
    }
    expect(changed).toEqual([]);
  });

  it("sits every team lead at an aisle end on triage 309 and 1000", () => {
    for (const n of [309, 1000]) {
      const planned = planFresh(makeTestEpic("triage", n, 1), VIEWPORT_WIDE);
      const bad: string[] = [];
      for (const host of planned.input.partition.hosts) {
        for (const team of host.teams) {
          const lead = planned.layout.desks.get(team.teamId);
          if (lead === undefined) throw new Error(`no lead ${team.teamId}`);
          const rowSeats = [...planned.layout.seats.values()]
            .filter(
              (seat) =>
                seat.kind === "console" &&
                seat.deskTile.row === lead.deskTile.row,
            )
            .sort((left, right) => left.deskTile.col - right.deskTile.col);
          const index = rowSeats.findIndex(
            (seat) => seat.seatId === lead.seatId,
          );
          const inGroup = index % 12;
          if (
            index !== 0 &&
            index !== rowSeats.length - 1 &&
            inGroup !== 0 &&
            inGroup !== 11
          ) {
            bad.push(`${n}:${team.teamId}:${index}`);
          }
        }
      }
      expect(bad).toEqual([]);
    }
  });

  it("allocates a reserve for a team that arrives after the first plan", () => {
    const input = planFresh(makeTestEpic("triage", 12, 1), VIEWPORT_WIDE).input;
    const prior = MISSION_CONTROL_VIEW.plan(input);
    const root = rootAgent(input.agents);
    const lead = childAgent(root, "arriving-lead", nextCreatedAt(input.agents));
    const member = childAgent(lead, "arriving-member", lead.createdAt + 1);
    const next = grownFrom(input, prior, [lead, member]);
    expect(
      next.partition.hosts.some((host) =>
        host.teams.some((team) => team.teamId === lead.id),
      ),
    ).toBe(true);
    const layout = MISSION_CONTROL_VIEW.plan(next);
    const reserves = frozenOf(layout)?.teamReserveSeatIds;
    expect(reserves?.some((entry) => entry.teamId === lead.id)).toBe(true);
  });

  it("paints distinct host-band palettes for two hosts", () => {
    const scene = sceneOf(makeTestEpic("two-hosts", 60, 1));
    const layout = requireLayout(scene);
    const frame = scene.frame(1, WHOLE_WORLD);
    const palettes: string[][] = [];
    for (const host of ["host-a", "host-b"]) {
      const seats = [...layout.seats.values()]
        .filter((seat) => seat.kind === "console" && seat.hostId === host)
        .sort(
          (left, right) =>
            left.deskTile.row - right.deskTile.row ||
            left.deskTile.col - right.deskTile.col,
        );
      const seat = seats[0];
      const tile = { col: seat.deskTile.col - 1, row: seat.deskTile.row };
      const sprite = frame.floor.find(
        (drawable) =>
          drawable.kind === "sprite" &&
          drawable.x === tile.col * OFFICE_TILE &&
          drawable.y === tile.row * OFFICE_TILE,
      );
      if (sprite === undefined || sprite.kind !== "sprite") {
        throw new Error(`no band sprite for ${host}`);
      }
      palettes.push(rasterColors(sprite.sprite.name));
    }
    expect(palettes[0]).not.toEqual(palettes[1]);
  });

  it("paints the reading chair on the tile the reader sits on", () => {
    const scene = sceneOf(makeTestEpic("triage", 40, 1));
    const layout = requireLayout(scene);
    const spot = layout.floors[0].errandSpots.find(
      (entry) => entry.kind === "read",
    );
    if (spot === undefined) throw new Error("no read spot");
    const chair = frameDrawables(scene.frame(2, WHOLE_WORLD)).find(
      (drawable) =>
        drawable.kind === "sprite" && drawable.sprite.name === "armchair",
    );
    expect(chair?.x).toBe(spot.tile.col * OFFICE_TILE);
    expect(chair?.y).toBe(spot.tile.row * OFFICE_TILE);
  });

  it("leaves opaque tier-step pixels uncovered by the console", () => {
    const scene = sceneOf(makeTestEpic("triage", 40, 1));
    const layout = requireLayout(scene);
    const seat = firstConsole(layout);
    const draws = frameDrawables(scene.frame(1, WHOLE_WORLD));
    const steps = draws.filter(
      (drawable) =>
        drawable.kind === "sprite" &&
        drawable.sprite.name === "tier-step" &&
        (drawable.x === seat.deskTile.col * OFFICE_TILE ||
          drawable.x === (seat.deskTile.col + 1) * OFFICE_TILE),
    );
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(exposedStepPixels(draws, steps)).toBeGreaterThan(0);
  });

  it("keeps every host foot sign inside the projected world", () => {
    const fixture = makeTestEpic("many-roots", 20, 1);
    const epic: OfficeTestEpic = {
      ...fixture,
      agents: fixture.agents.map((agent, index) => ({
        ...agent,
        hostId: `host-${String(index).padStart(2, "0")}`,
      })),
    };
    const scene = sceneOf(epic);
    const layout = requireLayout(scene);
    const width = scene.worldSize().width;
    const out = layout.signs.filter(
      (sign) =>
        sign.kind === "host" &&
        (sign.tile.col + sign.widthTiles) * OFFICE_TILE > width,
    );
    expect(out).toEqual([]);
  });

  it("keeps an arriving character inside the projector bounds", () => {
    const input = planFresh(makeTestEpic("triage", 12, 1), VIEWPORT_WIDE).input;
    const scene = new OfficeScene(MISSION_CONTROL_VIEW, null);
    const base = sceneInputFor(input);
    const newcomer = input.agents.at(-1);
    if (newcomer === undefined) throw new Error("no newcomer");
    scene.sync({
      ...base,
      visibleAgentIds: new Set(
        input.agents.slice(0, -1).map((agent) => agent.id),
      ),
    });
    scene.sync({
      ...base,
      pulse: {
        kind: "edge",
        edgeId: "root-newcomer",
        pulseKind: "created",
        fromAgentId: input.agents[0].id,
        toAgentId: newcomer.id,
      },
      pulseKey: "new-agent",
    });
    const chars = scene
      .frame(2, WHOLE_WORLD)
      .actors.filter(
        (drawable) =>
          drawable.kind === "sprite" && drawable.sprite.name === "character",
      );
    const projector = MISSION_CONTROL_VIEW.painter.projector(
      requireLayout(scene),
    );
    const out = chars.filter(
      (drawable) =>
        drawable.y < projector.bounds.y ||
        drawable.x < projector.bounds.x ||
        drawable.y + 20 > projector.bounds.y + projector.bounds.height,
    );
    expect(out).toEqual([]);
  });

  it("does not enumerate seats while panning a 1×1 empty viewport", () => {
    let visits = 0;
    const tracked: OfficeView = {
      ...MISSION_CONTROL_VIEW,
      plan: (input) => {
        const layout = MISSION_CONTROL_VIEW.plan(input);
        const seats = new CountingSeatMap(layout.seats, () => {
          visits += 1;
        });
        return { ...layout, seats };
      },
    };
    const scene = new OfficeScene(tracked, null);
    scene.sync(
      sceneInputFor(
        planFresh(makeTestEpic("triage", 1000, 1), VIEWPORT_WIDE).input,
      ),
    );
    scene.frame(1, { x: 0, y: 0, width: 1, height: 1 });
    visits = 0;
    scene.frame(1, { x: 16, y: 0, width: 1, height: 1 });
    expect(visits).toBe(0);
  });

  it("keeps a single-host floor hostless", () => {
    const epic = makeTestEpic("triage", 12, 1);
    const hosted: OfficeTestEpic = {
      ...epic,
      agents: epic.agents.map((agent) => ({ ...agent, hostId: "host-a" })),
    };
    expect(sceneOf(hosted).layout()?.floors[0].hostId).toBeNull();
  });

  it("returns no seat or spot props at lod 0", () => {
    const layout = planFresh(
      makeTestEpic("triage", 40, 1),
      VIEWPORT_WIDE,
    ).layout;
    expect(
      MISSION_CONTROL_VIEW.painter.seatProps(
        layout,
        firstConsole(layout),
        DESK_STATE,
        0,
      ),
    ).toEqual([]);
    expect(
      MISSION_CONTROL_VIEW.painter.spotProps(
        layout,
        layout.floors[0].errandSpots[0],
        0,
      ),
    ).toEqual([]);
  });

  it("seats every agent when aisle alignment fragments a row", () => {
    const epic = teamSizedEpic([2, 2, 14]);
    const planned = planFresh(epic, VIEWPORT_WIDE);
    const scene = sceneOf(epic);
    const layout = requireLayout(scene);
    expect(planned.layout.desks.size).toBe(epic.agents.length);
    expect(layout.desks.size).toBe(epic.agents.length);
    expect(
      spriteCount(frameDrawables(scene.frame(2, WHOLE_WORLD)), "character"),
    ).toBe(epic.agents.length);
    expect(scene.locate("team-2-lead")).not.toBeNull();
  });

  it("seats every agent across team-size mixes of 1 to 16", () => {
    const mixes: ReadonlyArray<ReadonlyArray<number>> = [
      [2, 2, 14],
      [14, 2, 2],
      [1, 16, 3],
      [8, 8, 8],
      [16, 1, 1, 1],
      [3, 3, 3, 3, 3],
      [1, 2, 3, 4, 5, 6],
    ];
    for (const sizes of mixes) {
      const epic = teamSizedEpic(sizes);
      const scene = sceneOf(epic);
      const layout = requireLayout(scene);
      expect(layout.desks.size).toBe(epic.agents.length);
      for (const agent of epic.agents) {
        expect(scene.locate(agent.id)).not.toBeNull();
      }
    }
  });

  it("keeps seats identical after a status-only replan that follows a consumed reserve", () => {
    const input = planFresh(
      makeTestEpic("one-team", 12, 1),
      VIEWPORT_WIDE,
    ).input;
    const before = MISSION_CONTROL_VIEW.plan(input);
    const lead = input.agents.find((agent) => agent.id === "team-lead");
    if (lead === undefined) throw new Error("no lead");
    const next = grownFrom(input, before, [
      childAgent(lead, "reserve-consumer", nextCreatedAt(input.agents)),
    ]);
    const consumed = MISSION_CONTROL_VIEW.plan(next);
    const statuses = new Map<string, OfficeAgentStatus>(
      next.agents.map((agent) => [agent.id, "working"]),
    );
    statuses.set(lead.id, "awaiting");
    const statusOnly = MISSION_CONTROL_VIEW.plan({
      ...next,
      previous: consumed,
      occupancy: new Map(),
      partition: partitionOfficePopulation({
        agents: next.agents,
        statusById: statuses,
        previous: next.partition,
      }),
    });
    expect(statusOnly.seats.size).toBe(consumed.seats.size);
    expect(statusOnly.seats).toEqual(consumed.seats);
  });

  it("sits every lead at an aisle end on a fresh three-team office", () => {
    const layout = planFresh(teamSizedEpic([2, 2, 2]), VIEWPORT_WIDE).layout;
    const interior = ["team-0-lead", "team-1-lead", "team-2-lead"].filter(
      (id) => aisleIndexOf(layout, id) >= 0,
    );
    expect(interior).toEqual([]);
  });

  it("sits an arriving team lead at an aisle end", () => {
    const input = planFresh(
      makeTestEpic("many-roots", 2, 1),
      VIEWPORT_WIDE,
    ).input;
    const before = MISSION_CONTROL_VIEW.plan(input);
    const parent = input.agents[0];
    const lead = childAgent(
      parent,
      "arriving-lead",
      nextCreatedAt(input.agents),
    );
    const member = childAgent(lead, "arriving-member", lead.createdAt + 1);
    const after = MISSION_CONTROL_VIEW.plan(
      grownFrom(input, before, [lead, member]),
    );
    expect(aisleIndexOf(after, lead.id)).toBe(-1);
  });

  it("does not grow band or pod reads with population on an empty pan", () => {
    const counts: Array<{ bandReads: number; podReads: number }> = [];
    for (const n of [12, 1000]) {
      let bandReads = 0;
      let podReads = 0;
      const tracked: OfficeView = {
        ...MISSION_CONTROL_VIEW,
        plan: (input) => {
          const layout = MISSION_CONTROL_VIEW.plan(input);
          const frozen = frozenOf(layout);
          if (frozen === null) throw new Error("no frozen");
          const hostBands = countingReads(frozen.hostBands, () => {
            bandReads += 1;
          });
          const rooms = layout.rooms.map((room) => ({
            ...room,
            pods: countingReads(room.pods, () => {
              podReads += 1;
            }),
          }));
          return { ...layout, rooms, frozen: { ...frozen, hostBands } };
        },
      };
      const epic = makeTestEpic("triage", n, 1);
      const hosted: OfficeTestEpic = {
        ...epic,
        agents: epic.agents.map((agent) => ({ ...agent, hostId: "host-a" })),
      };
      const scene = new OfficeScene(tracked, null);
      scene.sync(sceneInputFor(planFresh(hosted, VIEWPORT_WIDE).input));
      scene.frame(1, { x: 0, y: 0, width: 1, height: 1 });
      bandReads = 0;
      podReads = 0;
      scene.frame(1, { x: 16, y: 0, width: 1, height: 1 });
      counts.push({ bandReads, podReads });
    }
    expect(counts[1].bandReads).toBeLessThanOrEqual(counts[0].bandReads);
    expect(counts[1].podReads).toBeLessThanOrEqual(counts[0].podReads);
  });

  it("puts the partition lead at an aisle end for every arrival permutation", () => {
    const input = planFresh(
      makeTestEpic("many-roots", 2, 1),
      VIEWPORT_WIDE,
    ).input;
    const parent = input.agents[0];
    const lead = childAgent(parent, "late-list-lead", 10_000);
    const firstChild = childAgent(lead, "early-list-member", 10_001);
    const secondChild = childAgent(lead, "other-member", 10_002);
    const permutations: ReadonlyArray<ReadonlyArray<OfficeAgentInput>> = [
      [lead, firstChild, secondChild],
      [firstChild, lead, secondChild],
      [secondChild, firstChild, lead],
    ];
    const tiles: Array<{ col: number; row: number }> = [];
    for (const arrivals of permutations) {
      const after = MISSION_CONTROL_VIEW.plan(
        grownFrom(input, MISSION_CONTROL_VIEW.plan(input), arrivals),
      );
      expect(aisleIndexOf(after, lead.id)).toBe(-1);
      const desk = after.desks.get(lead.id);
      if (desk === undefined) throw new Error("lead unseated");
      tiles.push(desk.deskTile);
    }
    expect(tiles[0]).toEqual(tiles[1]);
    expect(tiles[1]).toEqual(tiles[2]);
  });

  it("does not scan hostBands on an empty lod-0 pan at 12 or 1000 agents", () => {
    let bandReads = 0;
    const tracked: OfficeView = {
      ...MISSION_CONTROL_VIEW,
      plan: (input) => {
        const layout = MISSION_CONTROL_VIEW.plan(input);
        const frozen = frozenOf(layout);
        if (frozen === null) throw new Error("no frozen");
        return {
          ...layout,
          frozen: {
            ...frozen,
            hostBands: countingReads(frozen.hostBands, () => {
              bandReads += 1;
            }),
          },
        };
      },
    };
    const full = makeTestEpic("triage", 1000, 1).agents.map((agent) => ({
      ...agent,
      hostId: "host-a",
    }));
    const counts: number[] = [];
    for (const n of [12, 1000, 12]) {
      const hosted: OfficeTestEpic = {
        agents: full.slice(0, n),
        statusById: new Map(),
      };
      const scene = new OfficeScene(tracked, null);
      scene.sync(sceneInputFor(planFresh(hosted, VIEWPORT_WIDE).input));
      scene.frame(0, { x: 0, y: 0, width: 1, height: 1 });
      bandReads = 0;
      const frame = scene.frame(0, { x: 16, y: 0, width: 1, height: 1 });
      expect(frame.floor.length).toBe(0);
      expect(frame.actors.length).toBe(0);
      counts.push(bandReads);
    }
    expect(counts[1]).toBeLessThanOrEqual(counts[0]);
    expect(counts[2]).toBeLessThanOrEqual(counts[0]);
  });

  it("reads no non-overlapping tier counts on an empty lod-0 pan through growth and shrink", () => {
    let tierReads = 0;
    let bandReads = 0;
    let reserveReads = 0;
    const tracked: OfficeView = {
      ...MISSION_CONTROL_VIEW,
      plan: (input) => {
        const layout = MISSION_CONTROL_VIEW.plan(input);
        const frozen = frozenOf(layout);
        if (frozen === null) throw new Error("no frozen");
        return {
          ...layout,
          frozen: {
            ...frozen,
            tierSeatCounts: countingReads(frozen.tierSeatCounts, () => {
              tierReads += 1;
            }),
            hostBands: countingReads(frozen.hostBands, () => {
              bandReads += 1;
            }),
            teamReserveSeatIds: countingReads(frozen.teamReserveSeatIds, () => {
              reserveReads += 1;
            }),
          },
        };
      },
    };
    const full = makeTestEpic("one-team", 1000, 1).agents.map((agent) => ({
      ...agent,
      hostId: "host-a",
      archived: false,
      archivedAt: null,
    }));
    let input = planFresh(
      { agents: full.slice(0, 12), statusById: new Map() },
      VIEWPORT_WIDE,
    ).input;
    const scene = new OfficeScene(tracked, null);
    scene.sync(sceneInputFor(input));
    const tierReadsByN: number[] = [];
    for (const n of [12, 1000, 12]) {
      input = sceneAdvance(input, scene, full.slice(0, n));
      scene.frame(0, { x: 0, y: 0, width: 1, height: 1 });
      tierReads = 0;
      bandReads = 0;
      reserveReads = 0;
      const frame = scene.frame(0, { x: 16, y: 0, width: 1, height: 1 });
      expect(frame.floor.length).toBe(0);
      expect(frame.actors.length).toBe(0);
      expect(bandReads).toBe(0);
      expect(reserveReads).toBe(0);
      tierReadsByN.push(tierReads);
    }
    expect(tierReadsByN).toEqual([0, 0, 0]);
  });

  it("paints only overlapping lod-0 tier geometry for a three-row query", () => {
    for (const n of [12, 1000]) {
      const layout = planFresh(
        makeTestEpic("one-team", n, 1),
        VIEWPORT_WIDE,
      ).layout;
      const frozen = frozenOf(layout);
      if (frozen === null) throw new Error("no frozen");
      const seen: number[] = [];
      const observed = {
        ...layout,
        frozen: {
          ...frozen,
          tierSeatCounts: countingIndexReads(frozen.tierSeatCounts, seen),
        },
      };
      const frame = MISSION_CONTROL_VIEW.painter.floor(
        observed,
        { col: 0, row: 8, cols: layout.cols, rows: 3 },
        0,
      );
      expect(frame).toHaveLength(1);
      expect(seen).toEqual([0]);
    }
  });
});
