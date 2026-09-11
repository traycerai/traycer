import { describe, expect, it } from "vitest";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import {
  OfficeScene,
  OFFICE_CULL_MARGIN_PX,
} from "@/lib/comm-graph/office/office-scene";
import { officeSignsToDraw } from "@/lib/comm-graph/office/office-signs";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeErrandSpot,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeLayout,
  type OfficeProp,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeSize,
  type OfficeTilePos,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import {
  measureCampus,
  planCampus,
} from "@/lib/comm-graph/office/views/isometric/campus-plan";
import { ISO_PAINTER } from "@/lib/comm-graph/office/views/isometric/iso-painter";
import {
  isoPropsIn,
  isoRoomsIn,
  isoRectsOverlap,
  readCityFrozen,
} from "@/lib/comm-graph/office/views/isometric/iso-plan-core";
import {
  ISO_HALF_HEIGHT,
  ISO_HALF_WIDTH,
} from "@/lib/comm-graph/office/views/isometric/iso-projector";
import {
  OFFICE_VIEWS,
  type OfficeDeskState,
  type OfficePlanInput,
} from "@/lib/comm-graph/office/views/office-view";

type Shape = "triage" | "two-hosts" | "many-roots";

function inputFor(
  shape: Shape,
  n: number,
  viewport: OfficeSize,
): OfficePlanInput {
  const epic = makeTestEpic(shape, n, 1);
  const partition = partitionOfficePopulation({
    agents: epic.agents,
    statusById: epic.statusById,
    previous: null,
  });
  // Vary activity so the same fixture doubles for City's height tests too, and
  // so nothing about Campus's own plan accidentally depends on it being zero.
  const activityById = new Map<string, number>();
  for (const [index, agent] of epic.agents.entries()) {
    activityById.set(agent.id, index % 37);
  }
  return {
    agents: epic.agents,
    partition,
    occupancy: new Map<string, string>(),
    needsCapacity: [],
    activityById,
    viewport,
    previous: null,
  };
}

const VIEWPORT_1280: OfficeSize = { width: 1280, height: 700 };
const VIEWPORT_680: OfficeSize = { width: 680, height: 440 };

function within(rect: OfficeTileRect, tile: OfficeTilePos): boolean {
  return (
    tile.col >= rect.col &&
    tile.col < rect.col + rect.cols &&
    tile.row >= rect.row &&
    tile.row < rect.row + rect.rows
  );
}

// `Reflect.get` is declared as returning `any`; read it through a narrower
// type so the trap hands back `unknown` rather than smuggling `any` out.
const reflectGet: (
  target: object,
  key: string | symbol,
  receiver: unknown,
) => unknown = Reflect.get;

/**
 * A `ReadonlyArray` wrapper that counts every numeric-index read, so a test
 * can prove a lookup never walked the array it wraps. `for...of` reads
 * indices through the iterator, so it counts too.
 */
function countedArrayProxy<T>(
  items: ReadonlyArray<T>,
  counts: { reads: number },
): ReadonlyArray<T> {
  return new Proxy(items, {
    get(target, prop, receiver): unknown {
      if (typeof prop === "string" && /^\d+$/.test(prop)) counts.reads += 1;
      return reflectGet(target, prop, receiver);
    },
  });
}

/**
 * Mirrors the private `isoPropReaches` in `iso-plan-core.ts`: whether a
 * prop's SPRITE box - an upright box hanging off its tile's projected corner -
 * overlaps a tile window's own projected diamond box. Restated here, against
 * the exported projection constants, so the brute-force check below is an
 * independent read of the same geometry rather than a call into the function
 * under test.
 */
function propReachesWindow(tiles: OfficeTileRect, prop: OfficeProp): boolean {
  const size = officeSpriteSize(prop.sprite);
  const x = (prop.tile.col - prop.tile.row) * ISO_HALF_WIDTH;
  const y = (prop.tile.col + prop.tile.row) * ISO_HALF_HEIGHT;
  const left = x - size.width / 2;
  const top = y + ISO_HALF_HEIGHT - size.height;
  const cols = [tiles.col, tiles.col + tiles.cols];
  const rows = [tiles.row, tiles.row + tiles.rows];
  let minX = Infinity;
  let maxX = -Infinity;
  for (const col of cols) {
    for (const row of rows) {
      minX = Math.min(minX, (col - row) * ISO_HALF_WIDTH);
      maxX = Math.max(maxX, (col - row) * ISO_HALF_WIDTH);
    }
  }
  const minY = (cols[0] + rows[0]) * ISO_HALF_HEIGHT;
  const maxY = (cols[1] + rows[1]) * ISO_HALF_HEIGHT;
  return (
    left < maxX &&
    left + size.width > minX &&
    top < maxY &&
    top + size.height > minY
  );
}

/** Every tile some errand spot names as the fixture it acts on. */
function fixtureTilesOf(layout: OfficeLayout): ReadonlySet<string> {
  const tiles = new Set<string>();
  for (const floor of layout.floors) {
    for (const spot of floor.errandSpots) {
      if (spot.actionTile === null) continue;
      tiles.add(`${spot.actionTile.col},${spot.actionTile.row}`);
    }
  }
  return tiles;
}

const WHOLE_WORLD: OfficeRect = { x: 0, y: 0, width: 8000, height: 8000 };

function sceneInputFor(
  agents: OfficePlanInput["agents"],
  statusById: ReadonlyMap<string, OfficeAgentStatus>,
): OfficeSceneInput {
  const visibleAgentIds = new Set(agents.map((agent) => agent.id));
  return {
    agents,
    visibleAgentIds,
    statusById,
    partition: partitionOfficePopulation({
      agents,
      statusById,
      previous: null,
    }),
    activityById: new Map<string, number>(),
    viewport: VIEWPORT_1280,
    openRequestsByReceiver: new Map<string, number>(),
    pulse: null,
    pulseKey: null,
    stepMs: 800,
    cursorMs: null,
    clockMs: 0,
    // Idle wandering is a LIVE, PAUSED-PLAYBACK behaviour: `errandMustEnd`
    // and `updateErrandStarts` both refuse to run one while `playing` is
    // true, since playback makes every agent idle between its own rows.
    playing: false,
    reducedMotion: false,
  };
}

/**
 * The view contract's invariants (`view-contract/index.md` "Invariants"),
 * spelled out against one layout. `office-layout-contract.test.ts` pins the
 * same list against `layoutOffice`; this is that list again against a plan
 * this ticket owns, which is why it is not shared.
 */
function checkContract(
  layout: OfficeLayout,
  agentIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const seatIds = new Set<string>();
  for (const seat of layout.seats.values()) {
    if (seatIds.has(seat.seatId))
      problems.push(`duplicate seat ${seat.seatId}`);
    seatIds.add(seat.seatId);
  }
  problems.push(...deskProblems(layout));
  problems.push(...floorProblems(layout));
  problems.push(...roomProblems(layout));
  problems.push(...signProblems(layout, agentIds));
  return [...new Set(problems)];
}

/** Every desk resolves to a seat, a room and a floor it can walk out of. */
function deskProblems(layout: OfficeLayout): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const desk of layout.desks.values()) {
    if (layout.seats.get(desk.seatId) !== desk) {
      problems.push(
        `desk not registered under its own seat id: ${desk.seatId}`,
      );
    }
    if (desk.roomId !== null) {
      const room = layout.rooms.find(
        (candidate) => candidate.rootAgentId === desk.roomId,
      );
      if (room === undefined) problems.push(`roomId unresolved ${desk.roomId}`);
      else if (!within(room.bounds, desk.deskTile)) {
        problems.push(`desk tile outside its own room ${desk.seatId}`);
      }
    }
    if (desk.floorIndex < 0 || desk.floorIndex >= layout.floors.length) {
      problems.push(`no floor at index ${desk.floorIndex}`);
      continue;
    }
    const floor = layout.floors[desk.floorIndex];
    if (findOfficePath(layout, desk.chairTile, floor.doorTile) === null) {
      problems.push(`chair unreachable from its floor's door ${desk.seatId}`);
    }
  }
  return problems;
}

/** Somewhere to stand at every errand, and corridors that are only corridors. */
function floorProblems(layout: OfficeLayout): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const floor of layout.floors) {
    for (const spot of floor.errandSpots) {
      if (!layout.walkable[spot.approachTile.row]?.[spot.approachTile.col]) {
        problems.push(`spot approach tile blocked ${spot.kind}`);
      }
      if (findOfficePath(layout, spot.approachTile, floor.doorTile) === null) {
        problems.push(`spot approach unreachable from its door ${spot.kind}`);
      }
    }
    for (const tile of floor.corridorTiles) {
      problems.push(...corridorProblems(layout, floor, tile));
    }
  }
  return problems;
}

function corridorProblems(
  layout: OfficeLayout,
  floor: OfficeFloor,
  tile: OfficeTilePos,
): ReadonlyArray<string> {
  const problems: string[] = [];
  if (!layout.walkable[tile.row]?.[tile.col]) {
    problems.push(`corridor tile blocked ${tile.col},${tile.row}`);
  }
  if (!within(floor.bounds, tile)) {
    problems.push(`corridor tile outside its own floor`);
  }
  if (layout.rooms.some((room) => within(room.bounds, tile))) {
    problems.push(`corridor tile inside a room`);
  }
  if (floor.amenities.some((amenity) => within(amenity.bounds, tile))) {
    problems.push(`corridor tile inside an amenity`);
  }
  return problems;
}

function roomProblems(layout: OfficeLayout): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const room of layout.rooms) {
    if (room.visitTile === null) continue;
    if (!layout.walkable[room.visitTile.row]?.[room.visitTile.col]) {
      problems.push(`visit tile blocked ${room.rootAgentId}`);
    }
  }
  return problems;
}

/** A sign that names somebody must name somebody who exists. */
function signProblems(
  layout: OfficeLayout,
  agentIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const sign of layout.signs) {
    if (sign.ownerAgentId === null) continue;
    if (!agentIds.has(sign.ownerAgentId)) {
      problems.push(`sign owner does not exist ${sign.ownerAgentId}`);
    }
  }
  return problems;
}

/**
 * The two garden spots that share one bench, and every garden spot there is.
 *
 * A bench is two tiles with a seat under each; both seats name the same
 * `fixtureId`, which is what makes them rally, and each acts on its own half.
 */
function gardenSpotsOf(layout: OfficeLayout): {
  readonly all: ReadonlyArray<OfficeErrandSpot>;
  readonly benchPair: ReadonlyArray<OfficeErrandSpot>;
} {
  const all = layout.floors.flatMap((floor) =>
    floor.errandSpots.filter((spot) => spot.kind === "garden"),
  );
  const byFixture = new Map<string, OfficeErrandSpot[]>();
  for (const spot of all) {
    const bucket = byFixture.get(spot.fixtureId);
    if (bucket === undefined) byFixture.set(spot.fixtureId, [spot]);
    else bucket.push(spot);
  }
  const benchPair = [...byFixture.values()].find((spots) => spots.length === 2);
  if (benchPair === undefined) throw new Error("expected a two-seat bench");
  return { all, benchPair };
}

/**
 * Whether anybody reaches this spot and SITS there, within a bounded number
 * of 100 ms ticks. The pose is read off the character drawn on the spot's own
 * projected foot point, which is where the scene puts whoever is using it.
 */
function someoneSitsAt(
  scene: OfficeScene,
  layout: OfficeLayout,
  spot: OfficeErrandSpot,
): boolean {
  const foot = ISO_PAINTER.projector(layout).project(
    spot.tile.col + 0.5,
    spot.tile.row + 1,
  );
  const spriteX = foot.x - OFFICE_CHARACTER_WIDTH / 2;
  const spriteY = foot.y - OFFICE_CHARACTER_HEIGHT;
  for (let step = 0; step < 3000; step += 1) {
    scene.tick(100);
    for (const entry of scene.frame(2, WHOLE_WORLD).world ?? []) {
      const drawable = entry.drawable;
      if (drawable.kind !== "sprite") continue;
      if (drawable.sprite.name !== "character") continue;
      if (drawable.x !== spriteX || drawable.y !== spriteY) continue;
      if (drawable.sprite.pose === "sit") return true;
    }
  }
  return false;
}

/** A viewport as the scene culls to it: grown by its own margin. */
function grownByMargin(view: OfficeRect): OfficeRect {
  return {
    x: view.x - OFFICE_CULL_MARGIN_PX,
    y: view.y - OFFICE_CULL_MARGIN_PX,
    width: view.width + OFFICE_CULL_MARGIN_PX * 2,
    height: view.height + OFFICE_CULL_MARGIN_PX * 2,
  };
}

function rectKey(rect: OfficeRect): string {
  return [rect.x, rect.y, rect.width, rect.height].join(",");
}

function rectsOverlap(left: OfficeRect, right: OfficeRect): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

/**
 * The owners whose own SEAT region is in this frame.
 *
 * A frame's `hitRegions` carry a seat's box and its occupant's character box
 * under the SAME `agentId`, so a set of ids cannot tell the two apart - and a
 * seat dropped by a broken cull would still be named there by its own
 * character standing in front of it. Matching a region against the seat's
 * declared `hitBox` is what isolates the seat half, which is the half the
 * projected chunk index decides.
 */
function seatRegionOwners(
  frame: OfficeFrame,
  layout: OfficeLayout,
): Set<string> {
  const seatBoxByOwner = new Map<string, string>();
  for (const [agentId, desk] of layout.desks) {
    const seat = layout.seats.get(desk.seatId);
    if (seat === undefined || seat.hitBox === null) continue;
    seatBoxByOwner.set(agentId, rectKey(seat.hitBox));
  }
  const found = new Set<string>();
  for (const region of frame.hitRegions) {
    if (seatBoxByOwner.get(region.agentId) !== rectKey(region.rect)) continue;
    found.add(region.agentId);
  }
  return found;
}

/** Every occupied seat whose own PAINTED box reaches this rect. */
function seatsReaching(layout: OfficeLayout, rect: OfficeRect): Set<string> {
  const found = new Set<string>();
  for (const [agentId, desk] of layout.desks) {
    const seat = layout.seats.get(desk.seatId);
    if (seat === undefined || seat.hitBox === null) continue;
    if (rectsOverlap(seat.hitBox, rect)) found.add(agentId);
  }
  return found;
}

describe("planCampus", () => {
  describe.each([12, 309, 1000])(
    "the shared layout invariants at %i agents",
    (n) => {
      const input = inputFor("triage", n, VIEWPORT_1280);
      const layout = planCampus(input);
      const agentIds = new Set(input.agents.map((agent) => agent.id));

      it("holds", () => {
        expect(checkContract(layout, agentIds)).toEqual([]);
      });

      it("seats every agent exactly once", () => {
        expect(layout.desks.size).toBe(n);
        for (const agentId of agentIds)
          expect(layout.desks.has(agentId)).toBe(true);
      });
    },
  );

  it("re-packs every plan: stable is false, nothing is carried forward, and there is no shift", () => {
    const input = inputFor("triage", 60, VIEWPORT_1280);
    const layout = planCampus(input);
    expect(layout.stable).toBe(false);
    expect(layout.shiftFromPrevious).toBeNull();
    // `frozen` holds the painter's lookup and NOT a packing - this plan has
    // none to carry, and never reads one back. So handing it its own last
    // layout changes nothing, which is the invariant a bare `frozen === null`
    // used to stand in for.
    expect(readCityFrozen(layout)).toBeNull();
    const withPrevious = planCampus({ ...input, previous: layout });
    expect({ cols: withPrevious.cols, rows: withPrevious.rows }).toEqual({
      cols: layout.cols,
      rows: layout.rows,
    });
    for (const [agentId, desk] of layout.desks) {
      const again = withPrevious.desks.get(agentId);
      expect(again?.seatId).toBe(desk.seatId);
      expect(again?.deskTile).toEqual(desk.deskTile);
    }
  });

  it("re-packs on growth, reports a non-empty moved set, and reseats everybody", () => {
    // The Floor's rule, restated for Campus: growth may move any seat, and the
    // scene walks exactly whoever moved. 60 -> 61 adds a 37th solo, which
    // takes the district's one bullpen from a 6-wide slot grid to a 7-wide one
    // (19x19 -> 22x19 tiles) and re-lays every row in it. It is the measured
    // case rather than an arbitrary one: an arrival that lands in a spare slot
    // moves nobody, and a boundary that happened to leave every desk untouched
    // would prove nothing about the moved set.
    const first = inputFor("triage", 60, VIEWPORT_1280);
    const a = planCampus(first);
    const epic = makeTestEpic("triage", 61, 1);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: first.partition,
    });
    const secondInput: OfficePlanInput = {
      ...first,
      agents: epic.agents,
      partition,
      previous: a,
    };
    const b = planCampus(secondInput);

    let moved = 0;
    for (const [agentId, desk] of a.desks) {
      const after = b.desks.get(agentId);
      expect(after).toBeDefined();
      if (after === undefined) continue;
      if (
        after.deskTile.col !== desk.deskTile.col ||
        after.deskTile.row !== desk.deskTile.row
      ) {
        moved += 1;
      }
    }
    // Measured: 30 of the 60 pre-existing agents move. The epic shape drives
    // the exact count, so only "more than none" is pinned here.
    expect(moved).toBeGreaterThan(0);
    expect(b.desks.size).toBe(61);
    for (const agentId of epic.agents.map((agent) => agent.id)) {
      expect(b.desks.has(agentId)).toBe(true);
    }

    // Determinism: re-running the same input produces byte-identical tiles.
    const bAgain = planCampus(secondInput);
    for (const [agentId, desk] of b.desks) {
      const again = bAgain.desks.get(agentId);
      expect(again?.deskTile).toEqual(desk.deskTile);
      expect(again?.seatId).toBe(desk.seatId);
    }
  });

  it("gives every partition team a cabin, HQ its own, and the district's solos one bullpen", () => {
    // D38, pinned on the recording's shape. The plan this replaced built one
    // room per lineage SUBTREE, and triage is one root with everybody under
    // it: 309 desks in a single 55 x 55 room, thirty teams with no cabin, no
    // plate and no region of their own. The counts below are the whole point
    // of the ruling, so they are asserted rather than sampled.
    const input = inputFor("triage", 309, VIEWPORT_1280);
    const layout = planCampus(input);
    const host = input.partition.hosts[0];
    expect(host.teams.length).toBe(30);
    expect(host.hqAgentId).toBe("agent-root");

    const roomsById = new Map(
      layout.rooms.map((room) => [room.rootAgentId, room]),
    );
    expect(roomsById.size).toBe(layout.rooms.length);
    // HQ, one cabin per team, one bullpen for the solos. No team here has nine
    // members, so no team takes a second cabin on this fixture.
    expect(layout.rooms.length).toBe(1 + host.teams.length + 1);

    const plateAt = new Map(
      layout.signs
        .filter((sign) => sign.kind === "plate")
        .map((sign) => [`${sign.tile.col},${sign.tile.row}`, sign]),
    );
    const problems: string[] = [];
    for (const team of host.teams) {
      const roomId = `${team.teamId}/room/0`;
      const room = roomsById.get(roomId);
      if (room === undefined) {
        problems.push(`no cabin for ${team.teamId}`);
        continue;
      }
      // D16: the room's id is synthetic, and the REAL lead is on the plate.
      const plate = plateAt.get(`${room.signTile.col},${room.signTile.row}`);
      if (plate === undefined) problems.push(`no plate on ${roomId}`);
      else if (plate.ownerAgentId !== team.leadAgentId) {
        problems.push(`plate on ${roomId} names ${plate.ownerAgentId ?? "-"}`);
      }
      for (const memberId of team.memberAgentIds) {
        const desk = layout.desks.get(memberId);
        if (desk === undefined) problems.push(`${memberId} has no desk`);
        else if (desk.roomId !== roomId) {
          problems.push(`${memberId} sits in ${desk.roomId ?? "-"}`);
        }
      }
      const lead = layout.desks.get(team.leadAgentId);
      if (lead !== undefined && !lead.manager) {
        problems.push(`${team.leadAgentId} is not its cabin's manager`);
      }
    }
    expect(problems).toEqual([]);

    expect(layout.desks.get("agent-root")?.roomId).toBe("agent-root/hq");
    // One bullpen, and it is nobody's room: a solo has no lead, and promoting
    // the first of them to the plate would invent one.
    const soloRooms = new Set(
      host.solos.map((member) => layout.desks.get(member.agentId)?.roomId),
    );
    expect(soloRooms.size).toBe(1);
    const bullpen = roomsById.get([...soloRooms][0] ?? "");
    expect(bullpen).toBeDefined();
    if (bullpen !== undefined) {
      const plate = plateAt.get(
        `${bullpen.signTile.col},${bullpen.signTile.row}`,
      );
      expect(plate?.ownerAgentId).toBeNull();
    }
  });

  it("gives two hosts two districts, two host signs, and no walkable path between them", () => {
    const input = inputFor("two-hosts", 120, VIEWPORT_1280);
    const layout = planCampus(input);
    expect(layout.floors.length).toBe(2);
    expect(layout.signs.filter((sign) => sign.kind === "host")).toHaveLength(2);
    expect(
      findOfficePath(
        layout,
        layout.floors[0].doorTile,
        layout.floors[1].doorTile,
      ),
    ).toBeNull();
  });

  describe("projected bounds at 1,000 agents", () => {
    // Measured directly against `measureCampus` and the projector's own
    // bounds: 105 x 117 tiles, 3,552 x 1,820 projected px. Campus reads no
    // aspect, so the fit is viewport-independent of shape but not of the
    // viewport itself - each viewport gets its own pinned fit.
    const input1280 = inputFor("triage", 1000, VIEWPORT_1280);
    const layout1280 = planCampus(input1280);
    const size1280 = measureCampus(input1280);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout1280.cols, rows: layout1280.rows }).toEqual({
        cols: 105,
        rows: 117,
      });
      expect(size1280).toEqual({ width: 3552, height: 1820 });
    });

    it("agrees with the projector's own bounds", () => {
      const bounds = ISO_PAINTER.projector(layout1280).bounds;
      expect({ width: bounds.width, height: bounds.height }).toEqual(size1280);
    });

    it("pins the fit at 1280x700", () => {
      const fit = Math.min(
        VIEWPORT_1280.width / size1280.width,
        VIEWPORT_1280.height / size1280.height,
      );
      expect(fit).toBeCloseTo(0.36, 2);
    });

    it("pins the fit at 680x440", () => {
      const input680 = inputFor("triage", 1000, VIEWPORT_680);
      const size680 = measureCampus(input680);
      const fit = Math.min(
        VIEWPORT_680.width / size680.width,
        VIEWPORT_680.height / size680.height,
      );
      expect(fit).toBeCloseTo(0.19, 2);
    });
  });

  describe("projected bounds at 309 agents", () => {
    // Measured: 65 x 80 tiles, 2,320 x 1,204 px.
    const input = inputFor("triage", 309, VIEWPORT_1280);
    const layout = planCampus(input);
    const size = measureCampus(input);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout.cols, rows: layout.rows }).toEqual({
        cols: 65,
        rows: 80,
      });
      expect(size).toEqual({ width: 2320, height: 1204 });
    });

    it("pins the fit at both viewports", () => {
      const fit1280 = Math.min(
        VIEWPORT_1280.width / size.width,
        VIEWPORT_1280.height / size.height,
      );
      expect(fit1280).toBeCloseTo(0.55, 2);
      const input680 = inputFor("triage", 309, VIEWPORT_680);
      const size680 = measureCampus(input680);
      const fit680 = Math.min(
        VIEWPORT_680.width / size680.width,
        VIEWPORT_680.height / size680.height,
      );
      expect(fit680).toBeCloseTo(0.29, 2);
    });
  });

  it("moves every projected point by exactly the origin delta when rows grow", () => {
    const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
    const before = ISO_PAINTER.projector(layout);
    const k = 3;
    const after = ISO_PAINTER.projector({ ...layout, rows: layout.rows + k });
    const deltas = new Set<string>();
    for (let col = 0; col <= layout.cols; col += 7) {
      for (let row = 0; row <= layout.rows; row += 5) {
        const p = before.project(col, row);
        const q = after.project(col, row);
        deltas.add(`${q.x - p.x},${q.y - p.y}`);
      }
    }
    expect([...deltas]).toEqual([`${16 * k},0`]);
  });

  it("keeps the projector's bounds a superset of every drawable's sprite box", () => {
    const layout = planCampus(inputFor("triage", 200, VIEWPORT_1280));
    const projector = ISO_PAINTER.projector(layout);
    const { bounds } = projector;
    const problems: string[] = [];

    const checkBox = (label: string, box: OfficeRect): void => {
      if (box.x < bounds.x) problems.push(`${label} x below bounds`);
      if (box.y < bounds.y) problems.push(`${label} y below bounds`);
      if (box.x + box.width > bounds.x + bounds.width) {
        problems.push(`${label} x+width exceeds bounds`);
      }
      if (box.y + box.height > bounds.y + bounds.height) {
        problems.push(`${label} y+height exceeds bounds`);
      }
    };

    // Every seat's props, at the state most likely to reach for the corners:
    // an occupied desk with a full envelope stack, at close-up LOD.
    for (const seat of layout.seats.values()) {
      const drawables = ISO_PAINTER.seatProps(
        layout,
        seat,
        {
          agentId: "agent-root",
          name: "Root",
          status: "working",
          sheeted: false,
          openRequests: 3,
          screenFrame: 0,
          harnessId: null,
          modelTier: "large",
          accentId: null,
        },
        2,
      );
      for (const entry of drawables) {
        if (entry.drawable.kind !== "sprite") continue;
        const size = officeSpriteSize(entry.drawable.sprite);
        checkBox(`seatProps ${seat.seatId}`, {
          x: entry.drawable.x,
          y: entry.drawable.y,
          width: size.width,
          height: size.height,
        });
      }
    }

    // Every chunk of floor, at office LOD - lod 0 draws nothing, so this is
    // the LOD that actually exercises walls, doors and props.
    const tiles: OfficeTileRect = {
      col: 0,
      row: 0,
      cols: layout.cols,
      rows: layout.rows,
    };
    for (const drawable of ISO_PAINTER.floor(layout, tiles, 1)) {
      if (drawable.kind !== "sprite") continue;
      const size = officeSpriteSize(drawable.sprite);
      checkBox("floor", {
        x: drawable.x,
        y: drawable.y,
        width: size.width,
        height: size.height,
      });
    }

    expect([...new Set(problems)]).toEqual([]);
  });

  it("holds a character, a lod-0 block and every fixture inside those bounds", () => {
    const layout = planCampus(inputFor("triage", 200, VIEWPORT_1280));
    const projector = ISO_PAINTER.projector(layout);
    const { bounds } = projector;
    const problems: string[] = [];

    const checkBox = (label: string, box: OfficeRect): void => {
      if (box.x < bounds.x) problems.push(`${label} x below bounds`);
      if (box.y < bounds.y) problems.push(`${label} y below bounds`);
      if (box.x + box.width > bounds.x + bounds.width) {
        problems.push(`${label} x+width exceeds bounds`);
      }
      if (box.y + box.height > bounds.y + bounds.height) {
        problems.push(`${label} y+height exceeds bounds`);
      }
    };

    // The anchor every view now shares: a character's foot is the projected
    // bottom-centre of its tile and its sprite hangs the character's height
    // above it. `H` is what buys the top row's character its headroom, so
    // this is the case that would fail if `H` were sized off the props alone.
    const characterBox = (tile: OfficeTilePos): OfficeRect => {
      const foot = projector.project(tile.col + 0.5, tile.row + 1);
      return {
        x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
        y: foot.y - OFFICE_CHARACTER_HEIGHT,
        width: OFFICE_CHARACTER_WIDTH,
        height: OFFICE_CHARACTER_HEIGHT,
      };
    };
    const extremes: ReadonlyArray<OfficeTilePos> = [
      { col: 0, row: 0 },
      { col: layout.cols - 1, row: 0 },
      { col: 0, row: layout.rows - 1 },
      { col: layout.cols - 1, row: layout.rows - 1 },
    ];
    for (const tile of extremes) {
      checkBox(`character at ${tile.col},${tile.row}`, characterBox(tile));
    }
    for (const seat of layout.seats.values()) {
      checkBox(`character in ${seat.seatId}`, characterBox(seat.chairTile));
    }

    // The overview block map, which is world pixels rather than a sprite box.
    const tiles: OfficeTileRect = {
      col: 0,
      row: 0,
      cols: layout.cols,
      rows: layout.rows,
    };
    const blocks = ISO_PAINTER.floor(layout, tiles, 0);
    expect(blocks.length).toBeGreaterThan(0);
    for (const drawable of blocks) {
      expect(drawable.kind).toBe("block");
      if (drawable.kind !== "block") continue;
      checkBox("block", {
        x: drawable.x,
        y: drawable.y,
        width: drawable.width,
        height: drawable.height,
      });
    }

    // And every fixture an errand spot stands up.
    for (const floor of layout.floors) {
      for (const spot of floor.errandSpots) {
        for (const entry of ISO_PAINTER.spotProps(layout, spot, 2)) {
          if (entry.drawable.kind !== "sprite") continue;
          const size = officeSpriteSize(entry.drawable.sprite);
          checkBox(`spot ${spot.kind}`, {
            x: entry.drawable.x,
            y: entry.drawable.y,
            width: size.width,
            height: size.height,
          });
        }
      }
    }

    expect([...new Set(problems)]).toEqual([]);
  });

  it("reads only the index's own references at lod 2, never layout.rooms or layout.props whole", () => {
    // D38 replaced the old one-room-per-lineage-root Campus with one room per
    // partition team, so `triage(1000, 1)` - the largest room count any view
    // still has - plans 32 rooms (HQ + 30 team cabins + 1 bullpen) and 47
    // props, not the review's "1,000 rooms and 1,011 props" against the old
    // plan. Measured on this fixture.
    const input = inputFor("triage", 1000, VIEWPORT_1280);
    const layout = planCampus(input);
    expect(layout.rooms.length).toBe(32);
    expect(layout.props.length).toBe(47);

    const roomCounts = { reads: 0 };
    const propCounts = { reads: 0 };
    const countingLayout: OfficeLayout = {
      ...layout,
      rooms: countedArrayProxy(layout.rooms, roomCounts),
      props: countedArrayProxy(layout.props, propCounts),
    };
    const window: OfficeTileRect = { col: 0, row: 0, cols: 32, rows: 32 };
    ISO_PAINTER.floor(countingLayout, window, 2);
    // Before the fix the floor pass walked both arrays whole to find what
    // falls in one small window; the index built once by the plan makes both
    // zero however big the layout is.
    expect(roomCounts.reads).toBe(0);
    expect(propCounts.reads).toBe(0);

    const rooms = isoRoomsIn(layout, window);
    const bruteRooms = new Set(
      layout.rooms.filter((room) => isoRectsOverlap(room.bounds, window)),
    );
    expect(new Set(rooms)).toEqual(bruteRooms);
    // Measured: 12 of the 32 rooms overlap this window. Asserting the count
    // is smaller than the whole roster is what stops a lookup that just
    // returns everything from passing this case by accident.
    expect(rooms.length).toBe(12);
    expect(rooms.length).toBeLessThan(layout.rooms.length);

    // `isoPropsIn` also drops every FIXTURE tile - a bench, a table, a
    // coffee machine - because those are drawn from their errand spot in the
    // world stream, not from the floor pass; painting them here too would
    // double them. So the brute force has to exclude those tiles as well, or
    // it counts fixtures the lookup is right to leave out.
    const fixtureTiles = fixtureTilesOf(layout);
    const props = isoPropsIn(layout, window);
    const bruteProps = new Set(
      layout.props.filter(
        (prop) =>
          !fixtureTiles.has(`${prop.tile.col},${prop.tile.row}`) &&
          propReachesWindow(window, prop),
      ),
    );
    expect(new Set(props)).toEqual(bruteProps);
    for (const prop of props) {
      expect(propReachesWindow(window, prop)).toBe(true);
    }
    // Measured: the courtyard's two trees and its reception desk - the only
    // non-fixture props this district stands near the window's corner.
    expect(props.length).toBe(3);
  });

  it("gives both bench seats a sitting pose and leaves the bare lawn spots standing", () => {
    const epic = makeTestEpic("triage", 12, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "idle");
    const scene = new OfficeScene(OFFICE_VIEWS.campus, null);
    scene.sync(sceneInputFor(epic.agents, statusById));
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout after sync");

    const { all, benchPair } = gardenSpotsOf(layout);
    // Both halves of the bench are real anchors, each with its own sprite on
    // it. Before the fix the second carried `null` to keep the art from being
    // drawn twice, and the scene reads a null garden anchor as "no bench,
    // therefore stand" - so the second arrival waited on its feet.
    const propAt = new Map(
      layout.props.map((prop) => [`${prop.tile.col},${prop.tile.row}`, prop]),
    );
    const problems: string[] = [];
    for (const spot of benchPair) {
      const tile = spot.actionTile;
      if (tile === null) {
        problems.push(
          `bench seat at ${spot.tile.col},${spot.tile.row} has no anchor`,
        );
        continue;
      }
      const name = propAt.get(`${tile.col},${tile.row}`)?.sprite.name;
      if (name !== "bench")
        problems.push(`no bench at ${tile.col},${tile.row}`);
    }
    // A bare stroll across the lawn still acts on nothing, which is the other
    // half of the garden's two outcomes.
    for (const spot of all) {
      if (benchPair.includes(spot)) continue;
      if (spot.actionTile !== null) {
        problems.push(
          `stroll at ${spot.tile.col},${spot.tile.row} has an anchor`,
        );
      }
    }
    expect(problems).toEqual([]);

    expect(someoneSitsAt(scene, layout, benchPair[1])).toBe(true);
  });

  it("draws exactly one clock per floor at lod 2, and none at lod 1", () => {
    const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
    const clockSize = officeSpriteSize({ name: "clock" });
    const projector = ISO_PAINTER.projector(layout);
    const window: OfficeTileRect = {
      col: 0,
      row: 0,
      cols: layout.cols,
      rows: layout.rows,
    };

    const atLod1 = ISO_PAINTER.floor(layout, window, 1);
    const clocksAt1 = atLod1.filter(
      (drawable) =>
        drawable.kind === "sprite" && drawable.sprite.name === "clock",
    );
    expect(clocksAt1).toHaveLength(0);

    const atLod2 = ISO_PAINTER.floor(layout, window, 2);
    const clocksAt2 = atLod2.filter(
      (drawable) =>
        drawable.kind === "sprite" && drawable.sprite.name === "clock",
    );
    expect(clocksAt2).toHaveLength(layout.floors.length);
    for (const floor of layout.floors) {
      const corner = projector.project(
        floor.clockTile.col,
        floor.clockTile.row,
      );
      const expected = {
        x: corner.x,
        y: corner.y + OFFICE_TILE - clockSize.height,
      };
      const found = clocksAt2.some(
        (drawable) =>
          drawable.kind === "sprite" &&
          drawable.x === expected.x &&
          drawable.y === expected.y,
      );
      expect(
        found,
        `no clock face for floor at ${floor.clockTile.col},${floor.clockTile.row}`,
      ).toBe(true);
    }
  });

  it("draws nothing for an occupied seat at overview, and something at close-up", () => {
    const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
    const seat = [...layout.seats.values()][0];
    const state = {
      agentId: "agent-root",
      name: "Root",
      status: "working" as const,
      sheeted: false,
      openRequests: 0,
      screenFrame: 0 as const,
      harnessId: null,
      modelTier: "medium" as const,
      accentId: null,
    };
    expect(ISO_PAINTER.seatProps(layout, seat, state, 0)).toEqual([]);
    expect(
      ISO_PAINTER.seatProps(layout, seat, state, 2).length,
    ).toBeGreaterThan(0);
  });

  /** A `many-roots(n)` plan, every agent `working`, for the R1/ground cases. */
  function manyRootsInput(
    n: number,
    remapHostId?: (index: number) => string,
  ): OfficePlanInput {
    const epic = makeTestEpic("many-roots", n, 1);
    const agents: ReadonlyArray<OfficeAgentInput> =
      remapHostId === undefined
        ? epic.agents
        : epic.agents.map((agent, index) => ({
            ...agent,
            hostId: remapHostId(index),
          }));
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of agents) statusById.set(agent.id, "working");
    const partition = partitionOfficePopulation({
      agents,
      statusById,
      previous: null,
    });
    const activityById = new Map<string, number>();
    for (const agent of agents) activityById.set(agent.id, 0);
    return {
      agents,
      partition,
      occupancy: new Map<string, string>(),
      needsCapacity: [],
      activityById,
      viewport: VIEWPORT_1280,
      previous: null,
    };
  }

  describe("R1: pushRoomWalls reads only the bullpen's own bounds, flat in host count", () => {
    // The old walk read every returned room's WHOLE perimeter to answer a
    // one-tile interior query - `bounds.cols`/`bounds.rows` read tile by
    // tile around the room. The clamp reads the bounds a handful of times
    // regardless of how big the bullpen is: measured 11, 8 and 8 reads at
    // 10, 100 and 1,000 hosts (10 reads a touch higher, since its window
    // sits close enough to an edge to walk a few wall tiles).
    it.each([
      { n: 10, reads: 11 },
      { n: 100, reads: 8 },
      { n: 1000, reads: 8 },
    ])("reads bullpen.bounds $reads times at $n hosts", ({ n, reads }) => {
      const layout = planCampus(manyRootsInput(n));
      const bullpen = layout.rooms.find((room) =>
        room.rootAgentId.endsWith("/bullpen"),
      );
      if (bullpen === undefined) throw new Error("expected a bullpen room");
      const tiles: OfficeTileRect = {
        col: bullpen.bounds.col + 2,
        row: bullpen.bounds.row + 2,
        cols: 1,
        rows: 1,
      };
      // Installed AFTER planning and indexing, over the SAME room objects
      // the index holds - the index bypasses `layout.rooms` (the array),
      // which is exactly why a guard on that array alone would miss this.
      const counts = { reads: 0 };
      for (const room of layout.rooms) {
        const raw: OfficeTileRect = { ...room.bounds };
        Object.defineProperty(room, "bounds", {
          value: new Proxy(raw, {
            get(target, key) {
              counts.reads += 1;
              return reflectGet(target, key, target);
            },
          }),
          configurable: true,
        });
      }
      counts.reads = 0;
      const out = ISO_PAINTER.floor(layout, tiles, 2);
      // One ground diamond for the one tile asked about, tile for tile the
      // same as the old per-tile filter would have produced.
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe("sprite");
      expect(counts.reads).toBe(reads);
    });
  });

  it("costs the same per tile at 1 host and at 50, for the ground question", () => {
    // `groundSpriteAt`/`isoGroundAt`'s O(1)-per-tile claim, pinned by
    // wrapping every floor's bounds and amenities in counting proxies -
    // installed in place, over the same `OfficeFloor` OBJECTS the index
    // holds, so the count is observable at all.
    const install = (layout: OfficeLayout, counts: { reads: number }): void => {
      for (const floor of layout.floors) {
        const rawBounds: OfficeTileRect = { ...floor.bounds };
        Object.defineProperty(floor, "bounds", {
          value: new Proxy(rawBounds, {
            get(target, key) {
              counts.reads += 1;
              return reflectGet(target, key, target);
            },
          }),
          configurable: true,
        });
        const rawAmenities = floor.amenities;
        for (const amenity of rawAmenities) {
          const rawAmenityBounds: OfficeTileRect = { ...amenity.bounds };
          Object.defineProperty(amenity, "bounds", {
            value: new Proxy(rawAmenityBounds, {
              get(target, key) {
                counts.reads += 1;
                return reflectGet(target, key, target);
              },
            }),
            configurable: true,
          });
        }
        Object.defineProperty(floor, "amenities", {
          value: new Proxy(rawAmenities, {
            get(target, prop, receiver) {
              if (typeof prop === "string" && /^\d+$/.test(prop)) {
                counts.reads += 1;
              }
              return reflectGet(target, prop, receiver);
            },
          }),
          configurable: true,
        });
      }
    };
    const window = (layout: OfficeLayout): OfficeTileRect => {
      const last = layout.floors[layout.floors.length - 1];
      return { col: last.bounds.col, row: last.bounds.row, cols: 32, rows: 32 };
    };

    // 1 host.
    const layout1 = planCampus(manyRootsInput(20));
    const counts1 = { reads: 0 };
    install(layout1, counts1);
    counts1.reads = 0;
    ISO_PAINTER.floor(layout1, window(layout1), 2);
    // Measured: 5,695 reads over the 1,024-tile window - 5.56/tile.
    expect(counts1.reads).toBe(5695);

    // 50 hosts at the same density - 1,000 agents dealt round-robin across
    // fifty host bands, so each district holds the same twenty agents the
    // one-host plan above does and only the DISTRICT count differs.
    const layout50 = planCampus(
      manyRootsInput(1000, (index) => `host-${index % 50}`),
    );
    expect(layout50.floors.length).toBe(50);
    const counts50 = { reads: 0 };
    install(layout50, counts50);
    counts50.reads = 0;
    ISO_PAINTER.floor(layout50, window(layout50), 2);
    // Measured: 6,223 reads - 6.08/tile, a small constant over the 1-host
    // cost rather than the ~50x it would be walking every district.
    expect(counts50.reads).toBe(6223);
    expect(counts50.reads / counts1.reads).toBeLessThan(2);

    // Without the index (the walk this replaced), the same 50-host window
    // costs an order of magnitude more - the comparison the index exists
    // to make untrue.
    const unindexed: OfficeLayout = { ...layout50, frozen: null };
    const countsUnindexed = { reads: 0 };
    install(unindexed, countsUnindexed);
    countsUnindexed.reads = 0;
    ISO_PAINTER.floor(unindexed, window(unindexed), 2);
    expect(countsUnindexed.reads).toBeGreaterThan(counts50.reads * 5);
  });

  /** The bounding box over a set of sprite rects: min corner to max corner. */
  function unionOf(boxes: ReadonlyArray<OfficeRect>): OfficeRect {
    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const maxY = Math.max(...boxes.map((box) => box.y + box.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function containsBox(outer: OfficeRect, inner: OfficeRect): boolean {
    return (
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height
    );
  }

  function spriteBoxesOf(
    layout: OfficeLayout,
    seat: OfficeSeat,
    state: OfficeDeskState,
  ): ReadonlyArray<OfficeRect> {
    return ISO_PAINTER.seatProps(layout, seat, state, 2)
      .filter((entry) => entry.drawable.kind === "sprite")
      .map((entry) => {
        if (entry.drawable.kind !== "sprite") throw new Error("unreachable");
        const size = officeSpriteSize(entry.drawable.sprite);
        return {
          x: entry.drawable.x,
          y: entry.drawable.y,
          width: size.width,
          height: size.height,
        };
      });
  }

  it("declares every isometric seat a non-null D53 hitBox", () => {
    const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
    const missing: string[] = [];
    for (const seat of layout.seats.values()) {
      if (seat.hitBox === null) missing.push(seat.seatId);
    }
    expect(missing).toEqual([]);
  });

  it("makes hitBox the painted union for every Campus desk, occupied or not", () => {
    const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
    const occupantBySeatId = new Map(
      [...layout.desks.entries()].map(([agentId, desk]) => [
        desk.seatId,
        agentId,
      ]),
    );
    for (const seat of layout.seats.values()) {
      if (seat.hitBox === null) throw new Error(`no hitBox on ${seat.seatId}`);
      const occupantId = occupantBySeatId.get(seat.seatId) ?? null;
      // Occupied, not sheeted, `openRequests: 3` - the union the ticket
      // measures the box against.
      const occupiedBoxes = spriteBoxesOf(layout, seat, {
        agentId: occupantId,
        name: occupantId,
        status: "working",
        sheeted: false,
        openRequests: 3,
        screenFrame: 0,
        harnessId: null,
        modelTier: "medium",
        accentId: null,
      });
      expect(unionOf(occupiedBoxes)).toEqual(seat.hitBox);

      // Sheeted and unoccupied still paint entirely inside that same box.
      for (const sheeted of [true, false]) {
        for (const agentId of [occupantId, null]) {
          const otherBoxes = spriteBoxesOf(layout, seat, {
            agentId,
            name: agentId,
            status: "working",
            sheeted,
            openRequests: 3,
            screenFrame: 0,
            harnessId: null,
            modelTier: "medium",
            accentId: null,
          });
          expect(containsBox(seat.hitBox, unionOf(otherBoxes))).toBe(true);
        }
      }
    }
  });

  it("I1: culls seats and spots by their own PROJECTED box, not a raw tile viewport", () => {
    // T2 F1: `chunkKeysOfBox(this.seatBox(seat))` files a seat under the
    // chunks its PROJECTED box covers. Real Campus at 1,000 agents, over a
    // viewport pinned to a populated corner, so this is the isometric plan
    // itself exercising the seam rather than a hand-built layout.
    const epic = makeTestEpic("triage", 1000, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "working");
    const scene = new OfficeScene(OFFICE_VIEWS.campus, null);
    scene.sync(sceneInputFor(epic.agents, statusById));
    const sceneLayout = scene.layout();
    if (sceneLayout === null) throw new Error("expected a layout after sync");

    // Straddles a 1,024 px chunk boundary (`FRAME_CHUNK_PX`) rather than
    // sitting deep inside one - the only place a seat filed under its raw
    // tile point instead of its own projected box can actually go missing.
    const view: OfficeRect = { x: 950, y: 550, width: 250, height: 300 };
    const grown = grownByMargin(view);
    const frame = scene.frame(2, view);
    const wanted = seatsReaching(sceneLayout, grown);
    expect(seatRegionOwners(frame, sceneLayout)).toEqual(wanted);
    // A corner this small is a fraction of a 1,000-agent world: the cull is
    // doing real work rather than handing back everything or nothing.
    expect(wanted.size).toBeGreaterThan(0);
    expect(wanted.size).toBeLessThan(sceneLayout.desks.size);
  });

  it("I3: a cabin's plate anchors at its tile PROJECTED, never at a raw col * OFFICE_TILE", () => {
    // T2 F5: `officeSignsToDraw` anchors every sign at
    // `projector.project(sign.tile.col, sign.tile.row)`. Real Campus cabins
    // at lod 2, so every plate a real plan hands the painter is checked, not
    // one hand-built sign object.
    const layout = planCampus(inputFor("triage", 309, VIEWPORT_1280));
    const projector = ISO_PAINTER.projector(layout);
    const plates = layout.signs.filter((sign) => sign.kind === "plate");
    expect(plates.length).toBeGreaterThan(0);
    for (const sign of plates) {
      const anchor = projector.project(sign.tile.col, sign.tile.row);
      const raw = {
        x: sign.tile.col * OFFICE_TILE,
        y: sign.tile.row * OFFICE_TILE,
      };
      // On an isometric projector these two disagree almost everywhere -
      // asserted so this case cannot pass by the raw formula coinciding
      // with the projected one by accident.
      expect(anchor).not.toEqual(raw);
      // What the painter actually reads: the officeSignsToDraw entry for
      // this sign anchors identically to a direct `projector.project` call.
      const drawn = officeSignsToDraw({
        signs: [sign],
        visibleAgentIds: new Set(layout.desks.keys()),
        statusById: new Map(),
        nameById: new Map(),
        hostNameById: new Map(),
        roleClaims: {},
        projector,
        lod: 2,
      });
      expect(drawn).toHaveLength(1);
      expect(drawn[0].anchor).toEqual(anchor);
    }
  });
});
