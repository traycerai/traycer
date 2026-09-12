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
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeErrandKind,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeLayout,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSpriteName,
  type OfficeTilePos,
  type OfficeTileRect,
  type OfficeViewId,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_VIEW_IDS,
  OFFICE_VIEWS,
  type OfficePainter,
  type OfficePlanInput,
  type OfficeProjector,
} from "@/lib/comm-graph/office/views/office-view";

function isWalkable(layout: OfficeLayout, tile: OfficeTilePos): boolean {
  return layout.walkable[tile.row]?.[tile.col];
}

/** A frame wide enough that nothing in the layout is culled by the viewport. */
function frameOverLayout(
  scene: OfficeScene,
  projector: OfficeProjector,
): OfficeFrame {
  const { bounds } = projector;
  const worldRect = {
    x: bounds.x - 4096,
    y: bounds.y - 4096,
    width: bounds.width + 8192,
    height: bounds.height + 8192,
  };
  return scene.frame(2, worldRect);
}

/**
 * Where an agent's own CHARACTER is actually drawn, from the frame's hit
 * regions - a seat region is desk-sized, so a character region is the one
 * with `OFFICE_CHARACTER_HEIGHT`. `null` when nothing drew that agent.
 */
function characterRectOf(
  frame: OfficeFrame,
  agentId: string,
): OfficeRect | null {
  // F4 gives `worldHitRegions` one region PER DRAWABLE PART, not one per
  // seat - so on a `world` painter (Campus, City) a seat's furniture parts
  // sit in this same array now. `character` is the only 20px-tall sprite in
  // `SPRITE_SIZES`, but a `block` drawable can be any height, so the width
  // is pinned too; and if more than one region still matches, that is a
  // silent ambiguity this helper must not paper over by taking the first.
  const matches = frame.hitRegions.filter(
    (candidate) =>
      candidate.agentId === agentId &&
      candidate.rect.height === OFFICE_CHARACTER_HEIGHT &&
      candidate.rect.width === OFFICE_CHARACTER_WIDTH,
  );
  if (matches.length > 1) {
    throw new Error(`more than one character-shaped hit region for ${agentId}`);
  }
  return matches.length === 0 ? null : matches[0].rect;
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
    it("keeps every corridor tile inside its own storey and outside every room and amenity", (context) => {
      // Mission control's one hall room IS the amphitheatre; aisle corridors
      // sit inside it. Floor-shaped "outside every cabin" does not apply.
      if (view.id === "mission-control") {
        context.skip(
          "Mission control is one hall; aisle corridors sit inside that room",
        );
        return;
      }
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

    it("still requires Floor to emit every action-anchor kind", (context) => {
      if (viewId !== "floor") {
        context.skip("Floor is the reference view for non-empty errand kinds");
        return;
      }
      for (const { kind } of ACTION_ANCHORS) {
        const spots = layout.floors.flatMap((floor) =>
          floor.errandSpots.filter((spot) => spot.kind === kind),
        );
        expect(spots.length).toBeGreaterThan(0);
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

    it("carries each floor's own hostId on every seat that floor owns", (context) => {
      if (view.id === "mission-control") {
        context.skip(
          "Mission control is one mixed hall; seats keep hostId, the floor does not",
        );
        return;
      }
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

    it("seats the fixture's original root agent on the host the fixture gave it", (context) => {
      if (view.id === "mission-control") {
        context.skip(
          "Mission control is one mixed hall; the root's floor is hostless",
        );
        return;
      }
      const rootAgent = epic.agents.find((agent) => agent.id === "agent-root");
      expect(rootAgent).toBeDefined();
      expect(rootAgent?.hostId).toBe("host-a");

      const rootDesk = layout.desks.get("agent-root");
      expect(rootDesk).toBeDefined();
      if (rootDesk === undefined) return;
      expect(rootDesk.hostId).toBe("host-a");
      const floor = layout.floors[rootDesk.floorIndex];
      expect(floor.hostId).toBe("host-a");
      expect(floorBandContains(floor, rootDesk.deskTile.row)).toBe(true);
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
    it("gives each host its own host sign, wherever the view marks hosts that way", (context) => {
      const hostSigns = layout.signs.filter((sign) => sign.kind === "host");
      if (hostSigns.length === 0) {
        context.skip(
          `${view.id} emits no host sign - Floor names a host by its cabins instead`,
        );
        return;
      }
      const hostIds = new Set(hostSigns.map((sign) => sign.hostId));
      expect(hostIds.size).toBe(2);
    });

    /**
     * Whether a character can walk from one host's door to the other's. Floor
     * keeps hosts on separate storeys and Towers stands each host's towers
     * apart; Building joins its wings with a skybridge, the only crossing;
     * Mission control seats both hosts in one hall and has no plazas to link.
     * Campus and City give each host a district in its own column band, with
     * dead columns between them that no pass ever opens - the isometric views
     * separate hosts by construction rather than by distance.
     * The record is exhaustive on purpose: a view added to the registry has to
     * say which it is before this suite compiles.
     */
    const HOST_PLAZA_LINK: Readonly<
      Record<OfficeViewId, "isolated" | "skybridge" | "one-hall">
    > = {
      floor: "isolated",
      towers: "isolated",
      building: "skybridge",
      "mission-control": "one-hall",
      campus: "isolated",
      city: "isolated",
    };

    it("links host plazas only where the view builds a skybridge", (context) => {
      const link = HOST_PLAZA_LINK[viewId];
      if (link === "one-hall") {
        context.skip(`${viewId} seats both hosts in one hall`);
        return;
      }

      // Every storey of a host shares the host's plaza door (D13), so the
      // first floor of the host is the right door on every view.
      const doorFor = (hostId: string): OfficeTilePos => {
        const floor = layout.floors.find(
          (candidate) => candidate.hostId === hostId,
        );
        if (floor === undefined) {
          throw new Error(`missing a floor for ${hostId}`);
        }
        return floor.doorTile;
      };
      const doorA = doorFor("host-a");
      const doorB = doorFor("host-b");
      const plazaPath = findOfficePath(layout, doorA, doorB);

      if (link === "isolated") {
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
      expect(findOfficePath(withoutBridge, doorA, doorB)).toBeNull();
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

  it("leaves every existing seat's tile unchanged (or uniformly shifted) on a stable layout when an agent is appended", (context) => {
    const epic = makeTestEpic("triage", 30, 3);
    const before = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );
    if (!before.stable) {
      context.skip(
        `${view.id}'s triage-30 layout is not stable at this scale - nothing to prove an unchanged seat set against`,
      );
      return;
    }
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

  it("walks every character whose chair actually moved to its new seat, and leaves the rest exactly where they were, when growth reshapes an unstable layout", (context) => {
    const epic = makeTestEpic("triage", 30, 4);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: null,
    });
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        partition,
      }),
    );
    const before = scene.layout();
    if (before === null) throw new Error("expected a layout");
    if (before.stable) {
      context.skip(
        `${view.id}'s triage-30 layout is stable at this scale - nothing to prove a moved set against`,
      );
      return;
    }
    const beforeProjector = view.painter.projector(before);
    // Captured from the SCENE's own DRAWN characters, not `scene.locate()`:
    // for a seated agent, `locate` answers from the SEAT BOOK's effective
    // seat, not from the character - so it reports the new seat's position
    // even when nothing actually walked there. The hit region a character
    // is really drawn at is the one thing a disabled `rehomeCharacters`
    // cannot fake, because it is built from the character's own tile.
    const beforeFrame = frameOverLayout(scene, beforeProjector);
    const beforeRects = new Map(
      epic.agents.map((person) => [
        person.id,
        characterRectOf(beforeFrame, person.id),
      ]),
    );

    // A single appended solo (the earlier fixture) never disturbs an
    // existing chair on Floor or Campus: both repack by tiling cabins/rooms
    // left to right, and one more pod at the end just extends the tiling.
    // Growing an EXISTING team's lead by a whole extra team's worth of
    // members grows that team's own room/cabin footprint enough to push
    // everything packed after it - which is what actually reshuffles
    // existing chairs on both views at this fixture (verified: 27 of 30
    // pre-existing agents move at this exact scale/seed on both).
    const leadAgent = epic.agents.find((agent) => agent.id.includes("lead"));
    if (leadAgent === undefined) {
      throw new Error("expected a team lead in the triage fixture");
    }
    const grown = [
      ...epic.agents,
      ...Array.from({ length: 7 }, (_unused, index) => ({
        ...epic.agents[0],
        id: `office-plans-grow-probe-${index}`,
        parentId: leadAgent.id,
        createdAt: Number.MAX_SAFE_INTEGER - index,
      })),
    ];
    const grownPartition = partitionOfficePopulation({
      agents: grown,
      statusById: epic.statusById,
      previous: partition,
    });
    scene.sync(
      sceneInputFor({
        agents: grown,
        statusById: epic.statusById,
        partition: grownPartition,
      }),
    );
    const after = scene.layout();
    if (after === null) throw new Error("expected a layout");
    const newSeatId = after.desks.get("office-plans-grow-probe-0")?.seatId;
    expect(newSeatId).toBeDefined();

    // An isometric view's origin can move with growth even when no tile
    // does (F17, tracked separately) - fold that known, separately-scoped
    // delta out here so THIS case stays about the moved-SET, not about F17.
    const afterProjector = view.painter.projector(after);
    const originBefore = beforeProjector.project(0, 0);
    const originAfter = afterProjector.project(0, 0);
    const originDelta = {
      x: originAfter.x - originBefore.x,
      y: originAfter.y - originBefore.y,
    };
    const afterFrame = frameOverLayout(scene, afterProjector);

    // An independent oracle for "where a settled agent's CHARACTER really
    // belongs": a FRESH scene synced directly onto the grown population,
    // which never goes through a re-layout transition or `rehomeCharacters`
    // at all - a character seen for the first time is seated straight onto
    // its assigned chair the moment it appears, a path `rehomeCharacters`
    // never touches. Floor and Campus both replan purely from the agent set
    // (`stable: false`; `previous` is never read - see floor-plan.ts and
    // campus-plan.ts), so this fresh scene's drawn positions are exactly
    // what the transitioned scene above SHOULD converge to, established
    // without relying on the rehoming code path under test.
    const freshScene = new OfficeScene(view, null);
    freshScene.sync(
      sceneInputFor({
        agents: grown,
        statusById: epic.statusById,
        partition: grownPartition,
      }),
    );
    const freshFrame = frameOverLayout(freshScene, afterProjector);

    let movedCount = 0;
    let unmovedCount = 0;
    for (const seatAgent of epic.agents) {
      // Archived agents get a dust-sheeted desk, not a live character - there
      // is nothing drawn to check them against, on EITHER side of growth.
      if (seatAgent.archivedAt !== null) continue;
      const beforeRect = beforeRects.get(seatAgent.id);
      if (beforeRect === undefined) continue;
      if (beforeRect === null) {
        throw new Error(`no drawn character for ${seatAgent.id} before growth`);
      }
      const afterRect = characterRectOf(afterFrame, seatAgent.id);
      const expectedIfUnmoved = {
        ...beforeRect,
        x: beforeRect.x + originDelta.x,
        y: beforeRect.y + originDelta.y,
      };
      const beforeSeat = before.desks.get(seatAgent.id);
      const afterSeat = after.desks.get(seatAgent.id);
      const seatUnchanged =
        beforeSeat !== undefined &&
        afterSeat !== undefined &&
        beforeSeat.chairTile.col === afterSeat.chairTile.col &&
        beforeSeat.chairTile.row === afterSeat.chairTile.row;
      if (seatUnchanged) {
        // A seat whose tile is UNCHANGED between the two plans must leave
        // its occupant's DRAWN character exactly where it was, up to the
        // origin delta - proven through the scene's own rehoming, not a
        // diff the test performs itself.
        unmovedCount += 1;
        expect(afterRect).toEqual(expectedIfUnmoved);
        continue;
      }
      // The scene actually rehomed this agent: its character now has to be
      // DRAWN at the real seat a scene loaded fresh onto the SAME final
      // layout would draw it at - not left standing at the stale pre-growth
      // spot, which is exactly what a disabled `rehomeCharacters` leaves
      // behind.
      movedCount += 1;
      expect(afterRect).toEqual(characterRectOf(freshFrame, seatAgent.id));
      expect(afterRect).not.toEqual(expectedIfUnmoved);
    }
    // The whole point of this fixture: real movement happened, and it
    // was not universal either - both outcomes are exercised.
    expect(movedCount).toBeGreaterThan(0);
    expect(unmovedCount).toBeGreaterThan(0);
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

  it("keeps every sprite the real painter draws CONTAINED in the projector's bounds", () => {
    const epic = makeTestEpic("triage", 60, 6);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: null,
    });
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        partition,
      }),
    );
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout");
    const projector = view.painter.projector(layout);
    const { bounds } = projector;
    const worldRect = {
      x: bounds.x - 4096,
      y: bounds.y - 4096,
      width: bounds.width + 8192,
      height: bounds.height + 8192,
    };
    const frame = scene.frame(2, worldRect);
    // The PAINTER's actual output, not the layout's declared hit boxes - a
    // sprite the painter draws taller or wider than its tile (a tower, a
    // spire) is exactly what a declared-hitbox check cannot see. The floor
    // drawables are included too - a lod-0/lod-1 block or tile sprite is as
    // real a painter output as a prop or an actor.
    const drawables = [
      ...frame.floor,
      ...(frame.world !== null
        ? frame.world.map((entry) => entry.drawable)
        : [...frame.props, ...frame.actors]),
    ];
    let sprites = 0;
    for (const drawable of drawables) {
      if (drawable.kind !== "sprite") continue;
      sprites += 1;
      const size = officeSpriteSize(drawable.sprite);
      // Full CONTAINMENT, not intersection: all four edges of the sprite's
      // box have to sit inside the bounds box, not merely touch it.
      expect(drawable.x).toBeGreaterThanOrEqual(bounds.x);
      expect(drawable.y).toBeGreaterThanOrEqual(bounds.y);
      expect(drawable.x + size.width).toBeLessThanOrEqual(
        bounds.x + bounds.width,
      );
      expect(drawable.y + size.height).toBeLessThanOrEqual(
        bounds.y + bounds.height,
      );
    }
    expect(sprites).toBeGreaterThan(0);
  });

  /**
   * (g)'s positive control: intersection alone would accept a sprite that
   * pokes almost entirely outside the bounds as long as its top-left corner
   * still touches them. Decorate the REAL painter to append one of its own
   * real sprite parts at `(bounds.right - 1, bounds.bottom - 1)` - the exact
   * reproduction the reviewer used - and prove two things about it: it is
   * genuinely present in the real frame (so the probe above is reading real
   * painter output, not a dropped part), and the containment predicate the
   * case above uses rejects it.
   */
  it("(g) rejects a real sprite the painter draws mostly outside the bounds, proving the containment check above is not just intersection", () => {
    const epic = makeTestEpic("triage", 60, 6);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: null,
    });
    let injected = false;
    const decoratedPainter: OfficePainter = {
      ...view.painter,
      seatProps: (seatLayout, seat, state, lod) => {
        const real = view.painter.seatProps(seatLayout, seat, state, lod);
        if (injected) return real;
        const realSprite = real.find(
          (entry) => entry.drawable.kind === "sprite",
        );
        if (realSprite === undefined) return real;
        injected = true;
        const overflowBounds = view.painter.projector(seatLayout).bounds;
        return [
          ...real,
          {
            ...realSprite,
            drawable: {
              ...realSprite.drawable,
              x: overflowBounds.x + overflowBounds.width - 1,
              y: overflowBounds.y + overflowBounds.height - 1,
            },
          },
        ];
      },
    };
    const scene = new OfficeScene({ ...view, painter: decoratedPainter }, null);
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        partition,
      }),
    );
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout");
    const { bounds } = view.painter.projector(layout);
    const worldRect = {
      x: bounds.x - 4096,
      y: bounds.y - 4096,
      width: bounds.width + 8192,
      height: bounds.height + 8192,
    };
    const frame = scene.frame(2, worldRect);
    const drawables = [
      ...frame.floor,
      ...(frame.world !== null
        ? frame.world.map((entry) => entry.drawable)
        : [...frame.props, ...frame.actors]),
    ];
    const overflow = drawables.find(
      (drawable) =>
        drawable.kind === "sprite" &&
        drawable.x === bounds.x + bounds.width - 1 &&
        drawable.y === bounds.y + bounds.height - 1,
    );
    // The overflowing sprite really did reach the frame the scene handed
    // back - injecting it into the painter was not silently dropped
    // somewhere between the painter and the frame.
    expect(overflow).toBeDefined();
    if (overflow === undefined || overflow.kind !== "sprite") return;
    const size = officeSpriteSize(overflow.sprite);
    expect(overflow.x + size.width).toBeGreaterThanOrEqual(bounds.x);
    expect(overflow.y + size.height).toBeGreaterThanOrEqual(bounds.y);
    expect(overflow.x).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(overflow.y).toBeLessThanOrEqual(bounds.y + bounds.height);
    // It intersects the bounds (the four checks above, an intersection
    // predicate, all pass) - and containment must still reject it, because
    // almost its whole box lies past the bounds' right and bottom edges.
    const contained =
      overflow.x >= bounds.x &&
      overflow.y >= bounds.y &&
      overflow.x + size.width <= bounds.x + bounds.width &&
      overflow.y + size.height <= bounds.y + bounds.height;
    expect(contained).toBe(false);
  });
});
