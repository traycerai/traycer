/**
 * Mission control plan: amphitheatre packing, growth, hosts, and the shared
 * layout invariants at the scales the fit estimates are quoted at.
 */
import { describe, expect, it } from "vitest";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import type { OfficePopulation } from "@/lib/comm-graph/office/office-population";
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
import type { OfficePlanInput } from "@/lib/comm-graph/office/views/office-view";
import {
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeErrandSpot,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeSize,
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
