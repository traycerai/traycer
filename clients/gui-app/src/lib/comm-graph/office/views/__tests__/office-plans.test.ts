/**
 * The invariants the view contract promises hold of EVERY registered view's
 * plan - run once per entry in `OFFICE_VIEW_IDS`, which is exactly the point:
 * a view registered tomorrow inherits this whole suite for free.
 *
 * Folds in `office-layout-contract.test.ts` (deleted), which pinned these
 * against `layoutOffice` directly before the view seam existed. Every case
 * folded from it is named in its own comment below.
 */
import { describe, expect, it } from "vitest";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeErrandKind,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeSceneInput,
  type OfficeSpriteName,
  type OfficeTilePos,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_VIEW_IDS,
  OFFICE_VIEWS,
  type OfficePlanInput,
} from "@/lib/comm-graph/office/views/office-view";

function isWalkable(layout: OfficeLayout, tile: OfficeTilePos): boolean {
  return layout.walkable[tile.row]?.[tile.col];
}

function floorBandContains(floor: OfficeFloor, row: number): boolean {
  return row >= floor.bounds.row && row < floor.bounds.row + floor.bounds.rows;
}

function withinRect(bounds: OfficeTileRect, tile: OfficeTilePos): boolean {
  return (
    tile.col >= bounds.col &&
    tile.col < bounds.col + bounds.cols &&
    tile.row >= bounds.row &&
    tile.row < bounds.row + bounds.rows
  );
}

/**
 * Every field a plan is allowed to see, built the way the scene builds it -
 * from `partitionOfficePopulation` rather than a stub, so the partition a
 * plan reads is the real thing every other consumer reads too.
 */
function planInputFor(args: {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly overrides: Partial<OfficePlanInput>;
}): OfficePlanInput {
  const { agents, statusById, overrides } = args;
  return {
    agents,
    partition: partitionOfficePopulation({
      agents,
      statusById,
      previous: null,
    }),
    occupancy: new Map<string, string>(),
    needsCapacity: [],
    activityById: new Map<string, number>(),
    viewport: { width: 1040, height: 700 },
    previous: null,
    ...overrides,
  };
}

function sceneInputFor(args: {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly partition: OfficePlanInput["partition"];
}): OfficeSceneInput {
  const { agents, statusById, partition } = args;
  return {
    agents,
    visibleAgentIds: new Set(agents.map((agent) => agent.id)),
    statusById,
    partition,
    activityById: new Map<string, number>(),
    viewport: { width: 1040, height: 700 },
    openRequestsByReceiver: new Map<string, number>(),
    pulse: null,
    pulseKey: null,
    stepMs: 0,
    cursorMs: null,
    clockMs: 0,
    playing: false,
    reducedMotion: true,
  };
}

const TRIAGE_SCALES: ReadonlyArray<number> = [12, 309, 1000];

describe.each(OFFICE_VIEW_IDS)("%s view", (viewId) => {
  const view = OFFICE_VIEWS[viewId];

  describe.each(TRIAGE_SCALES)("triage at %i agents", (n) => {
    const epic = makeTestEpic("triage", n, 1);
    const layout = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );
    const agentIds = new Set(epic.agents.map((agent) => agent.id));

    // Folded from office-layout-contract.test.ts: "seats every agent exactly
    // once, with every seat id unique".
    it("seats every agent exactly once, with every seat id unique and stable", () => {
      expect(layout.desks.size).toBe(n);
      for (const agentId of agentIds) {
        expect(layout.desks.has(agentId)).toBe(true);
      }

      const seatIds = new Set<string>();
      for (const seat of layout.seats.values()) {
        expect(seatIds.has(seat.seatId)).toBe(false);
        seatIds.add(seat.seatId);
      }
      for (const desk of layout.desks.values()) {
        expect(layout.seats.get(desk.seatId)).toEqual(desk);
      }
    });

    // Folded: "agrees each desk's floorIndex with the storey it physically
    // sits in".
    it("agrees each desk's floorIndex and hostId with the storey it physically sits in", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        expect(floor).toBeDefined();
        expect(floorBandContains(floor, desk.deskTile.row)).toBe(true);
        // Mission control is one mixed hall: seats keep their host, the floor
        // does not. Floor (and every per-host-storey view) still match.
        if (view.id === "mission-control") continue;
        expect(desk.hostId).toBe(floor.hostId);
      }
    });

    // Folded: "resolves every desk's roomId to a cabin whose bounds hold its
    // tile, or null".
    it("resolves every desk's roomId to a cabin whose bounds hold its tile, or null", () => {
      for (const desk of layout.desks.values()) {
        if (desk.roomId === null) continue;
        const room = layout.rooms.find(
          (candidate) => candidate.rootAgentId === desk.roomId,
        );
        expect(room).toBeDefined();
        if (room === undefined) continue;
        expect(withinRect(room.bounds, desk.deskTile)).toBe(true);
      }
    });

    // Folded: "lets every chair reach its own floor's door" - the contract's
    // reachability invariant, and the one that catches a plan that produced
    // an unreachable seat before `walkTo` ever has to fall back to teleporting.
    it("lets every chair reach its own floor's door", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        const path = findOfficePath(layout, desk.chairTile, floor.doorTile);
        expect(path).not.toBeNull();
      }
    });

    // Folded: "keeps every spot's approach tile, corridor tile and visit tile
    // walkable".
    it("keeps every spot's approach tile, corridor tile and visit tile walkable", () => {
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

    // Folded: "keeps every corridor tile inside its own storey and outside
    // every room and amenity".
    it("keeps every corridor tile inside its own storey and outside every room and amenity", () => {
      // Mission control's one hall room IS the amphitheatre; aisle corridors
      // sit inside it. Floor-shaped "outside every cabin" does not apply.
      if (view.id === "mission-control") return;
      for (const floor of layout.floors) {
        for (const corridorTile of floor.corridorTiles) {
          expect(floorBandContains(floor, corridorTile.row)).toBe(true);
          for (const room of layout.rooms) {
            expect(withinRect(room.bounds, corridorTile)).toBe(false);
          }
          for (const amenity of floor.amenities) {
            expect(withinRect(amenity.bounds, corridorTile)).toBe(false);
          }
        }
      }
    });

    // Folded: "names an agent that exists for every sign with an owner".
    it("names an agent that exists for every sign with an owner", () => {
      for (const sign of layout.signs) {
        if (sign.ownerAgentId === null) continue;
        expect(agentIds.has(sign.ownerAgentId)).toBe(true);
      }
    });

    // Folded: "carries a non-empty signs list and a non-empty corridorTiles
    // list per floor". Universal assertions that only check `.length >= 0`, or
    // check nothing once a set is empty, pass on an accidentally-empty
    // implementation just as happily as a correct one. These pin the sets as
    // genuinely non-empty at every scale, so an accidental regression to
    // "always empty" fails.
    it("carries a non-empty signs list and a non-empty corridorTiles list per floor", () => {
      expect(layout.signs.length).toBeGreaterThan(0);
      for (const floor of layout.floors) {
        expect(floor.corridorTiles.length).toBeGreaterThan(0);
      }
    });

    // Folded: "gives at least one room a non-null visitTile".
    it("gives at least one room a non-null visitTile", () => {
      expect(layout.rooms.length).toBeGreaterThan(0);
      const withVisit = layout.rooms.filter((room) => room.visitTile !== null);
      expect(withVisit.length).toBeGreaterThan(0);
    });
  });

  /**
   * Folded from office-layout-contract.test.ts's `action anchors` describe.
   *
   * Every non-garden action kind maps to exactly one sprite. A spot's
   * `actionTile` must be that exact sprite, standing directly above the spot in
   * the same column - which is a promise the PLAN makes to the scene, not a
   * Floor detail: a view that draws its bins somewhere else still has to say
   * where the bin it means is.
   */
  describe("action anchors", () => {
    const epic = makeTestEpic("triage", 309, 1);
    const layout = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );

    const ACTION_ANCHORS: ReadonlyArray<{
      readonly kind: OfficeErrandKind;
      readonly sprite: OfficeSpriteName;
    }> = [
      { kind: "bin", sprite: "bin" },
      { kind: "darts", sprite: "dartboard" },
      { kind: "water-plant", sprite: "plant" },
      { kind: "arcade", sprite: "arcade" },
      { kind: "console", sprite: "tv" },
    ];

    it.for(ACTION_ANCHORS)(
      "anchors every $kind spot with a non-null actionTile on the exact $sprite prop above it",
      ({ kind, sprite }, context) => {
        const spots = layout.floors.flatMap((floor) =>
          floor.errandSpots.filter((spot) => spot.kind === kind),
        );
        if (spots.length === 0 && viewId !== "floor") {
          context.skip(`${viewId} intentionally has no ${kind} spots`);
          return;
        }
        expect(spots.length).toBeGreaterThan(0);
        // At least one spot must actually resolve an anchor - otherwise the
        // loop below is vacuously true over an all-null set, exactly the
        // universal-assertion trap this suite exists to close.
        const anchored = spots.filter((spot) => spot.actionTile !== null);
        expect(anchored.length).toBeGreaterThan(0);
        for (const spot of anchored) {
          const tile = spot.actionTile;
          if (tile === null) continue;
          expect(tile.col).toBe(spot.tile.col);
          expect(tile.row).toBeLessThan(spot.tile.row);
          const propStandsThere = layout.props.some(
            (prop) =>
              prop.sprite.name === sprite &&
              prop.tile.col === tile.col &&
              prop.tile.row === tile.row,
          );
          expect(propStandsThere).toBe(true);
        }
      },
    );

    it("gives the garden BOTH outcomes: spots with a bench anchor and spots without one", (context) => {
      const garden = layout.floors.flatMap((floor) =>
        floor.errandSpots.filter((spot) => spot.kind === "garden"),
      );
      // D25: views without gardens intentionally skip this shared-plan case;
      // Floor remains the reference view and must keep both outcomes.
      if (garden.length === 0 && viewId !== "floor") {
        context.skip(`${viewId} intentionally has no garden spots`);
        return;
      }
      expect(garden.length).toBeGreaterThan(0);

      const withBench = garden.filter((spot) => spot.actionTile !== null);
      const withoutBench = garden.filter((spot) => spot.actionTile === null);
      // Both outcomes exist at this fixture: some garden spots sit under a
      // bench and are sat in, others are bare stroll tiles. The garden is the
      // one kind that is two things, and a view that collapsed it to one -
      // every spot a bench, or none - would break the sitting decision the
      // scene reads straight off this field.
      expect(withBench.length).toBeGreaterThan(0);
      expect(withoutBench.length).toBeGreaterThan(0);

      for (const spot of withBench) {
        const tile = spot.actionTile;
        if (tile === null) continue;
        expect(tile.col).toBe(spot.tile.col);
        expect(tile.row).toBeLessThan(spot.tile.row);
        const benchStandsThere = layout.props.some(
          (prop) =>
            prop.sprite.name === "bench" &&
            prop.tile.col === tile.col &&
            prop.tile.row === tile.row,
        );
        expect(benchStandsThere).toBe(true);
      }
    });
  });

  // Folded from office-layout-contract.test.ts's `the two-host shape` describe.
  describe("the two-host shape", () => {
    const epic = makeTestEpic("two-hosts", 60, 1);
    const layout = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );

    it("carries each floor's own hostId on every seat that floor owns", () => {
      if (view.id === "mission-control") return;
      expect(layout.floors.length).toBeGreaterThanOrEqual(2);
      for (const seat of layout.seats.values()) {
        const floor = layout.floors[seat.floorIndex];
        expect(floor).toBeDefined();
        expect(seat.hostId).toBe(floor.hostId);
      }
    });

    it("keeps every desk's tile inside its own floor's physical band", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        expect(floor).toBeDefined();
        expect(floorBandContains(floor, desk.deskTile.row)).toBe(true);
        expect(withinRect(floor.bounds, desk.deskTile)).toBe(true);
      }
    });

    it("seats the fixture's original root agent on the host the fixture gave it", () => {
      const rootAgent = epic.agents.find((agent) => agent.id === "agent-root");
      expect(rootAgent).toBeDefined();
      expect(rootAgent?.hostId).toBe("host-a");

      const rootDesk = layout.desks.get("agent-root");
      expect(rootDesk).toBeDefined();
      if (rootDesk === undefined) return;
      expect(rootDesk.hostId).toBe("host-a");
      const floor = layout.floors[rootDesk.floorIndex];
      if (view.id === "mission-control") {
        expect(floor.hostId).toBeNull();
        expect(floorBandContains(floor, rootDesk.deskTile.row)).toBe(true);
        return;
      }
      expect(floor.hostId).toBe("host-a");
      expect(floorBandContains(floor, rootDesk.deskTile.row)).toBe(true);
    });

    it("has no walkable path between host plazas that is not a skybridge", () => {
      if (view.id === "mission-control") return;
      if (layout.floors.length < 2) return;
      const first = layout.floors[0].doorTile;
      const second = layout.floors[1].doorTile;
      expect(findOfficePath(layout, first, second)).toBeNull();
    });

    /**
     * Every host gets its own naming, one way or another. Floor names a host by
     * the cabins standing on its own storey rather than by a `host` sign - that
     * sign kind is for the views that stack several hosts' buildings where the
     * storeys themselves need a label - so this only holds views that actually
     * emit one to the letter, and is a no-op everywhere else, INCLUDING Floor
     * today. It still runs for Floor so the day a Floor-shaped host label is
     * added, this starts checking it with no edit here.
     */
    it("gives each host its own host sign, wherever the view marks hosts that way", () => {
      const hostSigns = layout.signs.filter((sign) => sign.kind === "host");
      if (hostSigns.length === 0) return;
      const hostIds = new Set(hostSigns.map((sign) => sign.hostId));
      expect(hostIds.size).toBe(2);
    });

    it("connects host plazas only through Building's skybridge", () => {
      if (viewId !== "building" && viewId !== "towers") return;

      const plazaFor = (hostId: string): OfficeFloor => {
        const plaza = layout.floors.find(
          (floor) => floor.hostId === hostId && floor.bounds.rows === 5,
        );
        if (plaza === undefined) {
          throw new Error(`missing plaza for ${hostId}`);
        }
        return plaza;
      };
      const plazaA = plazaFor("host-a");
      const plazaB = plazaFor("host-b");
      const plazaPath = findOfficePath(
        layout,
        plazaA.doorTile,
        plazaB.doorTile,
      );

      if (viewId === "towers") {
        expect(plazaPath).toBeNull();
        return;
      }

      expect(plazaPath).not.toBeNull();
      const walkable = layout.walkable.map((row) => [...row]);
      for (const prop of layout.props) {
        if (prop.sprite.name !== "skybridge") continue;
        walkable[prop.tile.row][prop.tile.col] = false;
      }
      const withoutBridge: OfficeLayout = { ...layout, walkable };
      expect(
        findOfficePath(withoutBridge, plazaA.doorTile, plazaB.doorTile),
      ).toBeNull();
    });
  });

  it("preserves seats when one status flip is planned with the previous layout", () => {
    const epic = makeTestEpic("triage", 40, 2);
    const cold = new Map<string, OfficeAgentStatus>();
    const target = epic.agents.at(1);
    if (target === undefined) throw new Error("expected a second agent");
    const hot = new Map(cold).set(target.id, "working");

    const firstPartition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: cold,
      previous: null,
    });
    const layoutCold = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: cold,
        overrides: { partition: firstPartition },
      }),
    );
    const hotPartition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: hot,
      previous: firstPartition,
    });
    const layoutHot = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: hot,
        overrides: { partition: hotPartition, previous: layoutCold },
      }),
    );

    expect(layoutHot.seats).toEqual(layoutCold.seats);
  });

  it("does not call a plan again for a status-only flip while reserves remain", () => {
    const epic = makeTestEpic("one-team", 12, 7);
    const cold = new Map<string, OfficeAgentStatus>(
      epic.agents.map((agent) => [agent.id, "idle"]),
    );
    const target = epic.agents.find((agent) => agent.parentId !== null);
    if (target === undefined) throw new Error("expected a team member");
    const hot = new Map(cold).set(target.id, "working");
    let planCalls = 0;
    const countingView = {
      ...view,
      plan: (input: OfficePlanInput) => {
        planCalls += 1;
        return view.plan(input);
      },
    };
    const scene = new OfficeScene(countingView, null);
    const coldPartition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: cold,
      previous: null,
    });
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: cold,
        partition: coldPartition,
      }),
    );
    expect(planCalls).toBe(1);
    const hotPartition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: hot,
      previous: coldPartition,
    });
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: hot,
        partition: hotPartition,
      }),
    );
    expect(planCalls).toBe(1);
  });

  it("leaves every existing seat's tile unchanged (or uniformly shifted) on a stable layout when an agent is appended", () => {
    const epic = makeTestEpic("triage", 30, 3);
    const before = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );
    if (!before.stable) return;
    const grown = [
      ...epic.agents,
      {
        ...epic.agents[0],
        id: "office-plans-append-probe",
        parentId: null,
        createdAt: Number.MAX_SAFE_INTEGER,
      },
    ];
    const after = view.plan(
      planInputFor({
        agents: grown,
        statusById: epic.statusById,
        overrides: { previous: before },
      }),
    );
    const shift = after.shiftFromPrevious ?? { col: 0, row: 0 };
    for (const [seatId, seat] of before.seats) {
      const stillThere = after.seats.get(seatId);
      expect(stillThere).toBeDefined();
      if (stillThere === undefined) continue;
      expect(stillThere.chairTile).toEqual({
        col: seat.chairTile.col + shift.col,
        row: seat.chairTile.row + shift.row,
      });
    }
  });

  it("reports which seats moved on an unstable layout when an agent is appended", () => {
    const epic = makeTestEpic("triage", 30, 4);
    const before = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );
    if (before.stable) return;
    const grown = [
      ...epic.agents,
      {
        ...epic.agents[0],
        id: "office-plans-append-probe-2",
        parentId: null,
        createdAt: Number.MAX_SAFE_INTEGER,
      },
    ];
    const after = view.plan(
      planInputFor({
        agents: grown,
        statusById: epic.statusById,
        overrides: { previous: before },
      }),
    );
    // The new agent has a real seat, and the moved set - whoever's tile is not
    // identical between the two plans - is itself well-formed: every moved
    // seat id still names a seat in the new layout, and the new agent's own
    // seat is unconditionally part of it (nowhere to have moved FROM).
    const newSeatId = after.desks.get("office-plans-append-probe-2")?.seatId;
    expect(newSeatId).toBeDefined();
    const moved: string[] = [];
    for (const [seatId, seat] of after.seats) {
      const was = before.seats.get(seatId);
      if (
        was === undefined ||
        was.chairTile.col !== seat.chairTile.col ||
        was.chairTile.row !== seat.chairTile.row
      ) {
        moved.push(seatId);
      }
    }
    expect(newSeatId === undefined ? false : moved.includes(newSeatId)).toBe(
      true,
    );
  });

  it("measures exactly the size its own plan projects to", () => {
    const epic = makeTestEpic("triage", 60, 5);
    const input = planInputFor({
      agents: epic.agents,
      statusById: epic.statusById,
      overrides: {},
    });
    const layout = view.plan(input);
    const scene = new OfficeScene(view, layout);

    expect(view.measure(input)).toEqual(scene.worldSize());
  });

  it("gives every seat and every spot a projected box inside the projector's bounds", () => {
    const epic = makeTestEpic("triage", 60, 6);
    const layout = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );
    const projector = view.painter.projector(layout);
    const { bounds } = projector;

    for (const seat of layout.seats.values()) {
      const origin = projector.project(seat.deskTile.col, seat.deskTile.row);
      expect(origin.x).toBeGreaterThanOrEqual(bounds.x);
      expect(origin.y).toBeGreaterThanOrEqual(bounds.y);
      // The seat's own hit box, in the tiles the layout itself declares.
      const boxWidth = seat.hitTiles.width * OFFICE_TILE;
      const boxHeight = seat.hitTiles.height * OFFICE_TILE;
      expect(origin.x + boxWidth).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(origin.y + boxHeight).toBeLessThanOrEqual(
        bounds.y + bounds.height,
      );
    }
    for (const floor of layout.floors) {
      for (const spot of floor.errandSpots) {
        const point = projector.project(
          spot.approachTile.col,
          spot.approachTile.row,
        );
        expect(point.x).toBeGreaterThanOrEqual(bounds.x);
        expect(point.y).toBeGreaterThanOrEqual(bounds.y);
        expect(point.x).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height);
      }
    }
  });
});
