import { describe, expect, it } from "vitest";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import {
  OfficeScene,
  OFFICE_CULL_MARGIN_PX,
} from "@/lib/comm-graph/office/office-scene";
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
  type OfficePoint,
  type OfficeProp,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeSize,
  type OfficeTilePos,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import {
  measureCity,
  planCity,
} from "@/lib/comm-graph/office/views/isometric/city-plan";
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
  isoDepth,
} from "@/lib/comm-graph/office/views/isometric/iso-projector";
import {
  OFFICE_VIEWS,
  type OfficeDeskState,
  type OfficePlanInput,
} from "@/lib/comm-graph/office/views/office-view";

type Shape = "triage" | "two-hosts";

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

/** One painted roof, with everything the tall-block cases ask about it. */
interface CityRoofFacts {
  readonly agentId: string;
  /** The painted `block-top` box: where the user sees this building's roof. */
  readonly box: OfficeRect;
  readonly depth: number;
  /** D53: the plan's own `hitBox` for this seat - the box a click resolves to. */
  readonly hitBox: OfficeRect;
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

function centreOf(box: OfficeRect): OfficePoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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
 * A real City scene holding two buildings whose PAINTED roofs overlap, with
 * the nearer and the farther of the two picked out.
 *
 * Measured fixture: `one-team(3)` with activity 100/190/280 gives all three
 * of `team-lead`, `member-0` and `agent-root` seven storeys - the cap, which
 * this activity level is chosen to hit for all of them - whose roofs land at
 * `(120,120)` and `(136,128)` for the first two - a 16 x 8 overlap, with
 * `member-0` one lot nearer. The overlap is asserted rather than assumed, so
 * a plan that moved this geometry fails the cases below loudly instead of
 * making them vacuous.
 */
/** One seat's painted roof and its D53 `hitBox`, or `null` if it draws none. */
function cityRoofFactsOf(
  layout: OfficeLayout,
  agentId: string,
  seat: OfficeSeat,
): CityRoofFacts | null {
  const roof = ISO_PAINTER.seatProps(
    layout,
    seat,
    {
      agentId,
      name: agentId,
      status: "working",
      sheeted: false,
      openRequests: 0,
      screenFrame: 0,
      harnessId: null,
      modelTier: "medium",
      accentId: null,
    },
    2,
  ).find(
    (entry) =>
      entry.drawable.kind === "sprite" &&
      entry.drawable.sprite.name === "block-top",
  );
  if (roof === undefined || roof.drawable.kind !== "sprite") return null;
  const size = officeSpriteSize(roof.drawable.sprite);
  // D53: the plan's own declared hitBox for this seat, which is what the
  // scene actually resolves a click against - not a box restated from
  // `hitTiles`, which is the gap the skipped case used to name.
  if (seat.hitBox === null) {
    throw new Error(`expected a hitBox on City seat ${seat.seatId}`);
  }
  return {
    agentId,
    box: {
      x: roof.drawable.x,
      y: roof.drawable.y,
      width: size.width,
      height: size.height,
    },
    depth: roof.depth,
    hitBox: seat.hitBox,
  };
}

/** The first two roofs, in desk order, whose painted boxes overlap. */
function firstOverlappingPair(
  roofs: ReadonlyArray<CityRoofFacts>,
): readonly [CityRoofFacts, CityRoofFacts] | null {
  for (let i = 0; i < roofs.length; i += 1) {
    for (let j = i + 1; j < roofs.length; j += 1) {
      if (rectsOverlap(roofs[i].box, roofs[j].box)) return [roofs[i], roofs[j]];
    }
  }
  return null;
}

function overlappingCityRoofs(): {
  readonly scene: OfficeScene;
  readonly layout: OfficeLayout;
  readonly nearer: CityRoofFacts;
  readonly farther: CityRoofFacts;
  readonly hq: CityRoofFacts;
} {
  const epic = makeTestEpic("one-team", 3, 1);
  const statusById = new Map<string, OfficeAgentStatus>();
  const activityById = new Map<string, number>();
  for (const [index, agent] of epic.agents.entries()) {
    statusById.set(agent.id, "working");
    activityById.set(agent.id, [100, 190, 280][index] ?? 0);
  }
  const scene = new OfficeScene(OFFICE_VIEWS.city, null);
  scene.sync({ ...sceneInputFor(epic.agents, statusById), activityById });
  const layout = scene.layout();
  if (layout === null) throw new Error("expected a layout after sync");

  const roofs: CityRoofFacts[] = [];
  for (const [agentId, desk] of layout.desks) {
    const seat = layout.seats.get(desk.seatId);
    if (seat === undefined) continue;
    const facts = cityRoofFactsOf(layout, agentId, seat);
    if (facts !== null) roofs.push(facts);
  }

  const pair = firstOverlappingPair(roofs);
  if (pair === null) throw new Error("expected two overlapping City roofs");
  const [left, right] = pair;
  const overlapWidth =
    Math.min(left.box.x + left.box.width, right.box.x + right.box.width) -
    Math.max(left.box.x, right.box.x);
  const overlapHeight =
    Math.min(left.box.y + left.box.height, right.box.y + right.box.height) -
    Math.max(left.box.y, right.box.y);
  expect(overlapWidth).toBeGreaterThan(0);
  expect(overlapHeight).toBeGreaterThan(0);
  const nearer = left.depth > right.depth ? left : right;
  const farther = left.depth > right.depth ? right : left;
  expect(nearer.agentId).not.toBe(farther.agentId);
  const hq = roofs.find((roof) => roof.agentId === "agent-root");
  if (hq === undefined) throw new Error("expected agent-root's own roof");
  return { scene, layout, nearer, farther, hq };
}

/**
 * The view contract's invariants against one City layout. Restated rather
 * than shared with `campus-plan.test.ts` because these two files must stand
 * alone (see the ticket).
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

describe("planCity", () => {
  describe.each([12, 309, 1000])(
    "the shared layout invariants at %i agents",
    (n) => {
      const input = inputFor("triage", n, VIEWPORT_1280);
      const layout = planCity(input);
      const agentIds = new Set(input.agents.map((agent) => agent.id));

      it("holds", () => {
        expect(checkContract(layout, agentIds)).toEqual([]);
      });

      it("seats every agent exactly once, with reserve lots on top", () => {
        // City packs reserve lots into every team block, so `seats` outgrows
        // `desks` - the reserve seats are real seats with no occupant yet.
        expect(layout.desks.size).toBe(n);
        expect(layout.seats.size).toBeGreaterThan(layout.desks.size);
        for (const desk of layout.desks.values()) {
          expect(layout.seats.has(desk.seatId)).toBe(true);
        }
        for (const agentId of agentIds)
          expect(layout.desks.has(agentId)).toBe(true);
      });
    },
  );

  it("caps every building's storeys at seven, however busy the agent", () => {
    const input = inputFor("triage", 60, VIEWPORT_1280);
    const busy = new Map<string, number>();
    for (const agent of input.agents) busy.set(agent.id, 400);
    const layout = planCity({ ...input, activityById: busy });
    // Read the STOREY COUNT itself rather than inferring it from `seatLift`.
    // The lift is the height of a roof's centre above its occupant's anchor,
    // which is one storey short of the stack by construction; it was only ever
    // a stand-in for this number and stopped being one when the launch point
    // moved onto the roof.
    const frozen = readCityFrozen(layout);
    if (frozen === null) throw new Error("expected City's frozen packing");
    let maxStoreys = 0;
    for (const storeys of frozen.storeysBySeatId.values()) {
      maxStoreys = Math.max(maxStoreys, storeys);
    }
    expect(maxStoreys).toBeLessThanOrEqual(7);
    // Every occupied seat is busy enough to hit the cap, so the cap is what
    // actually bites here rather than an accident of low activity.
    expect(maxStoreys).toBe(7);
  });

  it("freezes heights across a status flip and an activity drop", () => {
    const input = inputFor("triage", 60, VIEWPORT_1280);
    const busy = new Map<string, number>();
    for (const agent of input.agents) busy.set(agent.id, 400);
    const a = planCity({ ...input, activityById: busy });
    const before = ISO_PAINTER.projector(a);

    const quiet = new Map<string, number>();
    const flipped = new Map(
      input.agents.map((agent) => [agent.id, "idle" as const]),
    );
    for (const agent of input.agents) quiet.set(agent.id, 0);
    const partition = partitionOfficePopulation({
      agents: input.agents,
      statusById: flipped,
      previous: input.partition,
    });
    const b = planCity({
      ...input,
      activityById: quiet,
      partition,
      previous: a,
    });
    const after = ISO_PAINTER.projector(b);

    expect(a.desks.size).toBeGreaterThan(0);
    for (const desk of a.desks.values()) {
      const seat = b.seats.get(desk.seatId);
      expect(seat).toBeDefined();
      if (seat === undefined) continue;
      expect(after.seatLift(seat)).toBe(before.seatLift(desk));
    }
  });

  it("makes the HQ building the tallest, and the only one with a spire", () => {
    const input = inputFor("triage", 60, VIEWPORT_1280);
    const layout = planCity(input);
    const frozen = readCityFrozen(layout);
    expect(frozen).not.toBeNull();
    if (frozen === null) return;
    expect(frozen.spireSeatIds.size).toBe(1);
    const [spireSeatId] = [...frozen.spireSeatIds];
    const spireStoreys = frozen.storeysBySeatId.get(spireSeatId);
    expect(spireStoreys).toBe(7);
    for (const [seatId, storeys] of frozen.storeysBySeatId) {
      if (seatId === spireSeatId) continue;
      expect(storeys).toBeLessThanOrEqual(spireStoreys ?? 0);
    }
  });

  it("is append-stable: every pre-existing agent keeps its tile and seat", () => {
    const first = inputFor("triage", 309, VIEWPORT_1280);
    const a = planCity(first);
    const epic = makeTestEpic("triage", 310, 1);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: first.partition,
    });
    const b = planCity({
      ...first,
      agents: epic.agents,
      partition,
      previous: a,
    });

    expect(b.stable).toBe(true);
    expect(b.shiftFromPrevious).toBeNull();
    for (const [agentId, desk] of a.desks) {
      const after = b.desks.get(agentId);
      expect(after).toBeDefined();
      if (after === undefined) continue;
      expect(after.deskTile).toEqual(desk.deskTile);
      expect(after.seatId).toBe(desk.seatId);
    }
    const newAgentId = epic.agents[epic.agents.length - 1].id;
    expect(a.desks.has(newAgentId)).toBe(false);
    expect(b.desks.has(newAgentId)).toBe(true);
  });

  it("gives two hosts two districts, two host signs, and no walkable path between them", () => {
    const input = inputFor("two-hosts", 120, VIEWPORT_1280);
    const layout = planCity(input);
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
    // Measured directly against `measureCity` and the projector's own bounds:
    // 70 x 81 tiles, 2,416 x 1,300 projected px (includes the tallest
    // building's stack height, `H`).
    const input1280 = inputFor("triage", 1000, VIEWPORT_1280);
    const layout1280 = planCity(input1280);
    const size1280 = measureCity(input1280);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout1280.cols, rows: layout1280.rows }).toEqual({
        cols: 70,
        rows: 81,
      });
      expect(size1280).toEqual({ width: 2416, height: 1300 });
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
      expect(fit).toBeCloseTo(0.53, 2);
    });

    it("pins the fit at 680x440", () => {
      const input680 = inputFor("triage", 1000, VIEWPORT_680);
      const size680 = measureCity(input680);
      const fit = Math.min(
        VIEWPORT_680.width / size680.width,
        VIEWPORT_680.height / size680.height,
      );
      expect(fit).toBeCloseTo(0.28, 2);
    });
  });

  describe("projected bounds at 309 agents", () => {
    // Measured: 44 x 48 tiles, 1,472 x 828 px.
    const input = inputFor("triage", 309, VIEWPORT_1280);
    const layout = planCity(input);
    const size = measureCity(input);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout.cols, rows: layout.rows }).toEqual({
        cols: 44,
        rows: 48,
      });
      expect(size).toEqual({ width: 1472, height: 828 });
    });

    it("pins the fit at both viewports", () => {
      const fit1280 = Math.min(
        VIEWPORT_1280.width / size.width,
        VIEWPORT_1280.height / size.height,
      );
      expect(fit1280).toBeCloseTo(0.85, 2);
      const input680 = inputFor("triage", 309, VIEWPORT_680);
      const size680 = measureCity(input680);
      const fit680 = Math.min(
        VIEWPORT_680.width / size680.width,
        VIEWPORT_680.height / size680.height,
      );
      expect(fit680).toBeCloseTo(0.46, 2);
    });
  });

  it("draws the farther of two overlapping roofs first and hits each building by its own seat box", () => {
    // The old case never drew, merged or hit anything - it took the max of
    // each seat's painter depths, sorted them and checked `col + row` was
    // increasing, which passes for any monotone depth formula whether or not
    // the drawn art actually overlaps. This one goes through the real scene.
    const { scene, nearer, farther } = overlappingCityRoofs();
    // 1. World order: every BUILDING entry the farther owner draws (its
    // slabs, windows and roof - all one depth per seat) comes before every
    // building entry the nearer owner draws. The two owners' own OCCUPANTS
    // are excluded from this comparison on purpose: a seat's occupant always
    // stands nearer than its own building's roof (a character's foot is 12
    // px nearer than the prop on the same tile - see `iso-projector.ts`), so
    // the farther owner's occupant legitimately outranks the nearer owner's
    // building. That is unrelated to which BUILDING is in front.
    const frame = scene.frame(2, WHOLE_WORLD);
    expect(frame.world).not.toBeNull();
    if (frame.world === null) return;
    const isBuildingEntry = (entry: (typeof frame.world)[number]): boolean =>
      entry.drawable.kind === "sprite" &&
      entry.drawable.sprite.name !== "character";
    const buildingIndexOfOwner = new Map<string, number[]>();
    for (const [index, entry] of frame.world.entries()) {
      if (entry.ownerAgentId === null || !isBuildingEntry(entry)) continue;
      const bucket = buildingIndexOfOwner.get(entry.ownerAgentId);
      if (bucket === undefined)
        buildingIndexOfOwner.set(entry.ownerAgentId, [index]);
      else bucket.push(index);
    }
    const nearerBuildingIndices =
      buildingIndexOfOwner.get(nearer.agentId) ?? [];
    const fartherBuildingIndices =
      buildingIndexOfOwner.get(farther.agentId) ?? [];
    expect(nearerBuildingIndices.length).toBeGreaterThan(0);
    expect(fartherBuildingIndices.length).toBeGreaterThan(0);
    const maxFartherBuildingIndex = Math.max(...fartherBuildingIndices);
    const minNearerBuildingIndex = Math.min(...nearerBuildingIndices);
    expect(minNearerBuildingIndex).toBeGreaterThan(maxFartherBuildingIndex);

    // The NEARER building's own occupant - standing in its own doorway, one
    // tile below its own roof - draws after that building's own entries too.
    const nearerOccupantIndices = frame.world
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry.ownerAgentId === nearer.agentId &&
          entry.drawable.kind === "sprite" &&
          entry.drawable.sprite.name === "character",
      )
      .map(({ index }) => index);
    expect(nearerOccupantIndices.length).toBeGreaterThan(0);
    expect(Math.min(...nearerOccupantIndices)).toBeGreaterThan(
      Math.max(...nearerBuildingIndices),
    );

    // 2. `hitTest` genuinely distinguishes the two buildings by their own
    // D53 `hitBox` - each queried at a point that lands in ONLY that
    // building's box, so a lookup that answered from the other seat's box
    // (or from neither) would fail loudly rather than by coincidence.
    const nearerOnlyPoint = {
      x: nearer.hitBox.x + nearer.hitBox.width - 1,
      y: nearer.hitBox.y + 10,
    };
    const fartherOnlyPoint = {
      x: (farther.hitBox.x + nearer.hitBox.x) / 2,
      y: farther.hitBox.y + 10,
    };
    expect(scene.hitTest(nearerOnlyPoint)).toBe(nearer.agentId);
    expect(scene.hitTest(fartherOnlyPoint)).toBe(farther.agentId);
  });

  it("hits a tall building where the user can see it, at its own roof centre", () => {
    const { scene, nearer, farther, hq } = overlappingCityRoofs();
    // The farther roof's own painted centre lands INSIDE the nearer
    // building's `hitBox` - that overlap is real, and front-most semantics
    // correctly resolve it to the nearer owner rather than to whoever the
    // point happens to sit over the middle of.
    const overlapPoint = centreOf(farther.box);
    expect(scene.hitTest(overlapPoint)).toBe(nearer.agentId);
    // A point on the farther roof that the nearer building does not reach -
    // between the farther roof's own left edge and its centre - still hits
    // the farther owner.
    const exposedFartherPoint = {
      x: (farther.box.x + centreOf(farther.box).x) / 2,
      y: centreOf(farther.box).y,
    };
    expect(scene.hitTest(exposedFartherPoint)).toBe(farther.agentId);
    // HQ overlaps nothing else on this fixture, so its own roof centre hits
    // it cleanly.
    expect(scene.hitTest(centreOf(hq.box))).toBe(hq.agentId);
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

  it("declares every isometric seat a non-null D53 hitBox", () => {
    const layout = planCity(inputFor("triage", 60, VIEWPORT_1280));
    const missing: string[] = [];
    for (const seat of layout.seats.values()) {
      if (seat.hitBox === null) missing.push(seat.seatId);
    }
    expect(missing).toEqual([]);
  });

  /** A `seatProps` call's sprites, named and boxed. */
  function spriteBoxesOf(
    layout: OfficeLayout,
    seat: OfficeSeat,
    state: OfficeDeskState,
  ): ReadonlyArray<{ readonly name: string; readonly box: OfficeRect }> {
    return ISO_PAINTER.seatProps(layout, seat, state, 2)
      .filter((entry) => entry.drawable.kind === "sprite")
      .map((entry) => {
        if (entry.drawable.kind !== "sprite") throw new Error("unreachable");
        const size = officeSpriteSize(entry.drawable.sprite);
        return {
          name: entry.drawable.sprite.name,
          box: {
            x: entry.drawable.x,
            y: entry.drawable.y,
            width: size.width,
            height: size.height,
          },
        };
      });
  }

  function stateFor(agentId: string | null, sheeted: boolean): OfficeDeskState {
    return {
      agentId,
      name: agentId,
      status: "working",
      sheeted,
      openRequests: 3,
      screenFrame: 0,
      harnessId: null,
      modelTier: "medium",
      accentId: null,
    };
  }

  it("makes hitBox the painted union for every City seat, the mast excepted on HQ", () => {
    const layout = planCity(inputFor("triage", 60, VIEWPORT_1280));
    const frozen = readCityFrozen(layout);
    if (frozen === null) throw new Error("expected City's frozen packing");
    const occupantBySeatId = new Map(
      [...layout.desks.entries()].map(([agentId, desk]) => [
        desk.seatId,
        agentId,
      ]),
    );

    for (const seat of layout.seats.values()) {
      if (seat.hitBox === null) throw new Error(`no hitBox on ${seat.seatId}`);
      const occupantId = occupantBySeatId.get(seat.seatId) ?? null;

      // Occupied, not sheeted, `openRequests: 3` - the state the ticket
      // measures the union against.
      const boxes = spriteBoxesOf(layout, seat, stateFor(occupantId, false));
      const mast = boxes.find((entry) => entry.name === "spire");
      const nonMast = boxes.filter((entry) => entry.name !== "spire");
      const union = unionOf(nonMast.map((entry) => entry.box));
      if (mast !== undefined) {
        // HQ, the one seat with a spire: every other part is EXACTLY the
        // box, and the mast is the one part deliberately outside it.
        expect(union).toEqual(seat.hitBox);
        expect(containsBox(seat.hitBox, mast.box)).toBe(false);
      } else {
        expect(union).toEqual(seat.hitBox);
      }

      // Sheeted and unoccupied still paint entirely inside the same box -
      // fewer sprites (no lit windows, a dust sheet for the roof), never a
      // bigger footprint.
      for (const sheeted of [true, false]) {
        for (const agentId of [occupantId, null]) {
          const otherBoxes = spriteBoxesOf(
            layout,
            seat,
            stateFor(agentId, sheeted),
          ).filter((entry) => entry.name !== "spire");
          expect(
            containsBox(seat.hitBox, unionOf(otherBoxes.map((e) => e.box))),
          ).toBe(true);
        }
      }
    }
  });

  it("locates a City seat by its own D53 building box, not the old hitTiles box", () => {
    const epic = makeTestEpic("one-team", 3, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "working");
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    scene.sync(sceneInputFor(epic.agents, statusById));
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout after sync");
    const seatId = layout.desks.get("team-lead")?.seatId;
    const seat = seatId === undefined ? undefined : layout.seats.get(seatId);
    if (seat === undefined || seat.hitBox === null) {
      throw new Error("expected team-lead to have a hitBox");
    }
    expect(scene.locate("team-lead")).toEqual(seat.hitBox);
  });

  it("F4: reports the origin delta as a shift when a real City plan grows rows (33 -> 34 agents), cancelling no errand", () => {
    // Measured: growing a `triage` seed-1 roster one agent at a time - the
    // way `OfficeScene` is actually driven, and the only way that reproduces
    // City's real append-only packing, since a plan built fresh at a given
    // count is not the one grown incrementally into it would reach (a fresh
    // plan re-derives its whole team roster from the final count, while an
    // incrementally grown one keeps every block it already placed). 33 -> 34
    // is also the one boundary that does NOT cross `triage`'s own
    // teams-per-count threshold (`floor((count - 1) / 7)`), which is what
    // keeps every agent's identity - not just its seat - stable across the
    // growth; 21 -> 22 crosses it and reassigns three leaves into a brand
    // new team, which is a fixture defect this case avoids rather than one
    // to pin. City holds 18 x 23 tiles at 33 agents and 18 x 26 at 34.
    // `rows` grows by 3, so `originX` (`rows * ISO_HALF_WIDTH`) moves by
    // exactly `3 * 16 = 48` px, and no column ever changes.
    const seed = 1;
    const agentsAt = (n: number): ReadonlyArray<OfficeAgentInput> =>
      makeTestEpic("triage", n, seed).agents;
    // The target - the epic's root, present from n=1 onward - starts idle so
    // it wanders off on an errand, and stays idle through the growth below;
    // everyone else is "working".
    const target = agentsAt(1)[0].id;
    const statusFor = (
      roster: ReadonlyArray<OfficeAgentInput>,
    ): Map<string, OfficeAgentStatus> => {
      const statusById = new Map<string, OfficeAgentStatus>();
      for (const agent of roster) {
        statusById.set(agent.id, agent.id === target ? "idle" : "working");
      }
      return statusById;
    };

    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    let previousPartition: OfficePlanInput["partition"] | null = null;
    const syncAt = (n: number): void => {
      const roster = agentsAt(n);
      const statusById = statusFor(roster);
      const partition = partitionOfficePopulation({
        agents: roster,
        statusById,
        previous: previousPartition,
      });
      previousPartition = partition;
      scene.sync({
        ...sceneInputFor(roster, statusById),
        partition,
      });
    };
    // Real incremental growth, one agent at a time, so the packing this test
    // measures against is the one City's append-only shelf actually reaches -
    // not the one a single plan built fresh at n=33 would choose.
    for (let n = 1; n <= 33; n += 1) syncAt(n);
    // Drain whatever the build-up itself queued, so only the 33 -> 34 step's
    // own delta is left pending below - `takeShift` accumulates across every
    // sync until it is read.
    scene.takeShift();

    const before = scene.layout();
    if (before === null) throw new Error("expected a layout after sync");
    expect(before.rows).toBe(23);
    const beforeSeatIds = new Map(
      Array.from(before.desks.entries()).map(([id, desk]) => [id, desk.seatId]),
    );
    const beforeTiles = new Map(
      Array.from(before.desks.entries()).map(([id, desk]) => [
        id,
        { deskTile: desk.deskTile, chairTile: desk.chairTile },
      ]),
    );
    const beforeProjector = ISO_PAINTER.projector(before);
    const beforeOrigin = beforeProjector.project(0, 0);
    expect(beforeOrigin.x).toBe(368);

    let away = false;
    for (let step = 0; step < 500 && !away; step += 1) {
      scene.tick(100);
      away = scene.frame(2, WHOLE_WORLD).awayAgentIds.has(target);
    }
    expect(away).toBe(true);
    for (let step = 0; step < 5; step += 1) scene.tick(100);

    syncAt(34);

    const after = scene.layout();
    if (after === null) throw new Error("expected a layout after growth");
    expect(after.rows).toBe(26);
    expect(after.cols).toBe(before.cols);
    expect(after.shiftFromPrevious).toBeNull();
    const afterProjector = ISO_PAINTER.projector(after);
    const afterOrigin = afterProjector.project(0, 0);
    expect(afterOrigin.x).toBe(416);
    const delta = {
      x: afterOrigin.x - beforeOrigin.x,
      y: afterOrigin.y - beforeOrigin.y,
    };
    expect(delta).toEqual({ x: 48, y: 0 });

    // Every pre-existing seat id survives, on the same tiles.
    for (const [id, seatId] of beforeSeatIds) {
      expect(after.desks.get(id)?.seatId).toBe(seatId);
    }
    for (const [id, tiles] of beforeTiles) {
      expect(after.desks.get(id)?.deskTile).toEqual(tiles.deskTile);
      expect(after.desks.get(id)?.chairTile).toEqual(tiles.chairTile);
    }
    // And every pre-existing seat's PROJECTED point moved by exactly the
    // origin delta - the tile did not move, the camera's origin did.
    for (const tiles of beforeTiles.values()) {
      const beforePoint = beforeProjector.project(
        tiles.deskTile.col,
        tiles.deskTile.row,
      );
      const afterPoint = afterProjector.project(
        tiles.deskTile.col,
        tiles.deskTile.row,
      );
      expect({
        x: afterPoint.x - beforePoint.x,
        y: afterPoint.y - beforePoint.y,
      }).toEqual(delta);
    }

    const shift = scene.takeShift();
    expect(shift).toEqual(delta);
    // Draining: a second call sees nothing left.
    expect(scene.takeShift()).toBeNull();

    for (let step = 0; step < 5; step += 1) scene.tick(100);
    expect(scene.frame(2, WHOLE_WORLD).awayAgentIds.has(target)).toBe(true);
  });

  it("orders isoDepth by foot y first, then col+row, then kind", () => {
    const lowFoot = isoDepth(10, 500, "character");
    const highFoot = isoDepth(11, 0, "floor");
    expect(highFoot).toBeGreaterThan(lowFoot);

    const nearer = isoDepth(10, 5, "floor");
    const farther = isoDepth(10, 2, "floor");
    expect(nearer).toBeGreaterThan(farther);

    const floor = isoDepth(10, 5, "floor");
    const prop = isoDepth(10, 5, "prop");
    const character = isoDepth(10, 5, "character");
    expect(prop).toBeGreaterThan(floor);
    expect(character).toBeGreaterThan(prop);
  });

  it("keeps the projector's bounds a superset of every drawable's sprite box", () => {
    const layout = planCity(inputFor("triage", 200, VIEWPORT_1280));
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
    const layout = planCity(inputFor("triage", 200, VIEWPORT_1280));
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

  it("renames nothing when a lexically earlier host arrives", () => {
    const first = makeTestEpic("triage", 40, 1);
    // Every agent starts on host-b, so the district's own seat ids carry
    // "host-b" throughout - the rewrite is entirely in `hostId`.
    const hostBAgents: ReadonlyArray<OfficeAgentInput> = first.agents.map(
      (agent) => ({ ...agent, hostId: "host-b" }),
    );
    const partitionA = partitionOfficePopulation({
      agents: hostBAgents,
      statusById: first.statusById,
      previous: null,
    });
    const inputA: OfficePlanInput = {
      agents: hostBAgents,
      partition: partitionA,
      occupancy: new Map<string, string>(),
      needsCapacity: [],
      activityById: new Map<string, number>(),
      viewport: VIEWPORT_1280,
      previous: null,
    };
    const a = planCity(inputA);

    // A later-created root agent on host-a, which sorts before "host-b" in
    // the partition's own host order (`Array.from(named).sort()` in
    // `office-population.ts`) - that lexical ordering is what pushes
    // host-b's district from districtIndex 0 to districtIndex 1.
    const extra: OfficeAgentInput = {
      id: "agent-extra-root",
      name: "agent-extra-root",
      kind: "chat",
      hostId: "host-a",
      archivedAt: null,
      modelTier: "medium",
      harnessId: null,
      model: null,
      parentId: null,
      archived: false,
      createdAt: hostBAgents.length,
      appearance: agentAppearance("agent-extra-root", "chat", null),
    };
    const agentsB = [...hostBAgents, extra];
    const statusById = new Map(first.statusById);
    statusById.set(extra.id, "idle");
    const partitionB = partitionOfficePopulation({
      agents: agentsB,
      statusById,
      previous: partitionA,
    });
    const b = planCity({
      ...inputA,
      agents: agentsB,
      partition: partitionB,
      previous: a,
    });
    expect(b.floors.length).toBe(2);

    const problems: string[] = [];
    for (const agent of hostBAgents) {
      const before = a.desks.get(agent.id);
      const after = b.desks.get(agent.id);
      if (before === undefined || after === undefined) {
        problems.push(`${agent.id} lost its desk`);
        continue;
      }
      if (after.seatId !== before.seatId) {
        problems.push(
          `${agent.id} seatId moved from ${before.seatId} to ${after.seatId}`,
        );
      }
      if (
        after.deskTile.col !== before.deskTile.col ||
        after.deskTile.row !== before.deskTile.row
      ) {
        problems.push(`${agent.id} deskTile moved`);
      }
      if (
        after.chairTile.col !== before.chairTile.col ||
        after.chairTile.row !== before.chairTile.row
      ) {
        problems.push(`${agent.id} chairTile moved`);
      }
    }
    // Before the fix `seatIdOf` folded the district's INDEX into the id, so
    // every one of these 40 seat ids changed the moment host-a's district
    // took index 0 and pushed host-b's to index 1 - even though nothing
    // about host-b moved.
    expect(problems).toEqual([]);
  });

  it("keeps a nearer character painted over a farther prop in the merged world stream", () => {
    const epic = makeTestEpic("triage", 60, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "working");
    const activityById = new Map<string, number>();
    for (const [index, agent] of epic.agents.entries()) {
      activityById.set(agent.id, index % 37);
    }
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    scene.sync({ ...sceneInputFor(epic.agents, statusById), activityById });
    const frame = scene.frame(2, WHOLE_WORLD);
    expect(frame.world).not.toBeNull();
    if (frame.world === null) return;

    const isCharacter = (entry: (typeof frame.world)[number]): boolean =>
      entry.drawable.kind === "sprite" &&
      entry.drawable.sprite.name === "character";
    const isProp = (entry: (typeof frame.world)[number]): boolean =>
      entry.drawable.kind === "sprite" && !isCharacter(entry);

    const characterDepths = frame.world.filter(isCharacter).map((e) => e.depth);
    const propEntries = frame.world.filter(isProp);
    expect(characterDepths.length).toBeGreaterThan(0);
    expect(propEntries.length).toBeGreaterThan(0);

    // `frame.world` is built by a stable ascending sort on `depth`, so it is
    // non-decreasing by construction - restated here as the merge's own
    // contract rather than as evidence of the fix.
    for (let index = 1; index < frame.world.length; index += 1) {
      expect(frame.world[index].depth).toBeGreaterThanOrEqual(
        frame.world[index - 1].depth,
      );
    }

    // The defect: before the fix every prop's depth was `footY * 4096 + tie`,
    // so on any fixture this size a prop's depth (in the tens of thousands)
    // dwarfed every character's raw foot-y depth (at most a few thousand) -
    // no prop could ever sort BEFORE (behind) any character, however far
    // back it actually stood. With one depth unit, a prop far from the
    // camera legitimately sorts behind a character standing near it. Assert
    // that mixed ordering actually happens, or this case proves nothing.
    const minCharacterDepth = Math.min(...characterDepths);
    const hasPropBehindACharacter = propEntries.some(
      (entry) => entry.depth < minCharacterDepth,
    );
    expect(hasPropBehindACharacter).toBe(true);

    // Every prop's depth is the real projected foot y plus a tie-break that
    // stays strictly under one pixel, and never exceeds the layout's own
    // projected height.
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout after sync");
    const projectedHeight = ISO_PAINTER.projector(layout).bounds.height;
    for (const entry of propEntries) {
      const fraction = entry.depth - Math.floor(entry.depth);
      expect(fraction).toBeLessThan(1);
      expect(entry.depth).toBeLessThan(projectedHeight);
    }
  });

  it("leaves a request envelope from the sender's own roof centre, not its side", () => {
    const epic = makeTestEpic("one-team", 3, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "idle");
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    const baseInput = sceneInputFor(epic.agents, statusById);
    scene.sync(baseInput);
    const pulse: CommGraphPulse = {
      kind: "edge",
      edgeId: "agent-root<->team-lead",
      pulseKind: "request",
      fromAgentId: "agent-root",
      toAgentId: "team-lead",
    };
    scene.sync({ ...baseInput, pulse, pulseKey: "pulse-1" });
    // No `tick` yet, so the envelope's own progress is 0 - its endpoint is
    // exactly the sender's launch point, with no arc lift folded in.
    const frame = scene.frame(2, WHOLE_WORLD);
    const envelope = frame.overlay.find(
      (drawable) => drawable.kind === "envelope",
    );
    expect(envelope).toBeDefined();
    if (envelope === undefined) return;

    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout after sync");
    const rootSeatId = layout.desks.get("agent-root")?.seatId;
    const rootSeat =
      rootSeatId === undefined ? undefined : layout.seats.get(rootSeatId);
    expect(rootSeat).toBeDefined();
    if (rootSeat === undefined) return;
    const drawables = ISO_PAINTER.seatProps(
      layout,
      rootSeat,
      {
        agentId: "agent-root",
        name: "Root",
        status: "idle",
        sheeted: false,
        openRequests: 0,
        screenFrame: 0,
        harnessId: null,
        modelTier: "medium",
        accentId: null,
      },
      2,
    );
    const roof = drawables.find(
      (entry) =>
        entry.drawable.kind === "sprite" &&
        entry.drawable.sprite.name === "block-top",
    );
    expect(roof).toBeDefined();
    if (roof === undefined || roof.drawable.kind !== "sprite") return;
    const roofSize = officeSpriteSize(roof.drawable.sprite);
    // Before the fix the roof was centred on the desk tile's own corner, 24
    // px to one side of this.
    expect({ x: envelope.x, y: envelope.y }).toEqual({
      x: roof.drawable.x + roofSize.width / 2,
      y: roof.drawable.y + roofSize.height / 2,
    });
  });

  it("reads only the index's own references at lod 2, never layout.rooms or layout.props whole", () => {
    const input = inputFor("triage", 1000, VIEWPORT_1280);
    const layout = planCity(input);

    const roomCounts = { reads: 0 };
    const propCounts = { reads: 0 };
    const countingLayout: OfficeLayout = {
      ...layout,
      rooms: countedArrayProxy(layout.rooms, roomCounts),
      props: countedArrayProxy(layout.props, propCounts),
    };
    // Measured: the first district's park (with its two trees and its
    // reception desk) sits near here on this fixture, so this window is one
    // that actually holds non-fixture props - unlike the world's own corner,
    // which City's shelf-packed districts leave empty.
    const window: OfficeTileRect = { col: 50, row: 42, cols: 32, rows: 32 };
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
    // Asserting the count is smaller than the whole roster is what stops a
    // lookup that just returns everything from passing this case by
    // accident. Measured on this fixture.
    expect(rooms.length).toBeLessThan(layout.rooms.length);
    expect(rooms.length).toBeGreaterThan(0);

    // `isoPropsIn` also drops every FIXTURE tile - a bench, a table, a
    // coffee machine - because those are drawn from their errand spot in the
    // world stream, not from the floor pass; painting them here too would
    // double them. So the brute force has to exclude those tiles too, or it
    // counts fixtures the lookup is right to leave out.
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
    expect(props.length).toBeGreaterThan(0);
    expect(props.length).toBeLessThan(layout.props.length);
  });

  it("gives both bench seats a sitting pose and leaves the bare lawn spots standing", () => {
    const epic = makeTestEpic("triage", 12, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "idle");
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
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
    const layout = planCity(inputFor("triage", 60, VIEWPORT_1280));
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
    const layout = planCity(inputFor("triage", 60, VIEWPORT_1280));
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

  it("I1: culls seats and spots by their own PROJECTED box, not a raw tile viewport", () => {
    // T2 F1: `chunkKeysOfBox(this.seatBox(seat))` files a seat under the
    // chunks its PROJECTED box covers. Real City at 1,000 agents, over a
    // viewport pinned to a chunk boundary - the only place a seat filed
    // under its raw tile point instead of its own box can go missing.
    const epic = makeTestEpic("triage", 1000, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    const activityById = new Map<string, number>();
    for (const agent of epic.agents) {
      statusById.set(agent.id, "working");
      activityById.set(agent.id, 400);
    }
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    scene.sync({ ...sceneInputFor(epic.agents, statusById), activityById });
    const sceneLayout = scene.layout();
    if (sceneLayout === null) throw new Error("expected a layout after sync");

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

  it("I2: hitTest resolves an overlap to whichever region the world stream drew LAST", () => {
    // T2 F4: `worldHitRegions` sorts by `compareDepthOrder` and returns the
    // regions in REVERSE - front-most first - so `hitTest` (which takes the
    // first match) always answers with whatever the world stream actually
    // painted last at that pixel, and never with whichever seat happens to
    // sort first by id. `many-roots(60)` at this activity spread is measured
    // to give a pair whose NEARER roof's agent id sorts alphabetically AFTER
    // the farther one's - `root-2` in front of `root-1` - so a hit order
    // that fell back to seat order would answer wrong here, unlike on the
    // `one-team(3)` fixture above where the two happen to coincide.
    const epic = makeTestEpic("many-roots", 60, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    const activityById = new Map<string, number>();
    for (const [index, agent] of epic.agents.entries()) {
      statusById.set(agent.id, "working");
      activityById.set(agent.id, (index * 37) % 400);
    }
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    scene.sync({ ...sceneInputFor(epic.agents, statusById), activityById });
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout after sync");

    const rootOneSeatId = layout.desks.get("root-1")?.seatId;
    const rootTwoSeatId = layout.desks.get("root-2")?.seatId;
    const rootOne =
      rootOneSeatId === undefined ? undefined : layout.seats.get(rootOneSeatId);
    const rootTwo =
      rootTwoSeatId === undefined ? undefined : layout.seats.get(rootTwoSeatId);
    if (rootOne === undefined || rootTwo === undefined) {
      throw new Error("expected root-1 and root-2 to have seats");
    }
    const roofBoxOf = (agentId: string, seat: OfficeSeat): OfficeRect => {
      const roof = ISO_PAINTER.seatProps(
        layout,
        seat,
        {
          agentId,
          name: agentId,
          status: "working",
          sheeted: false,
          openRequests: 0,
          screenFrame: 0,
          harnessId: null,
          modelTier: "medium",
          accentId: null,
        },
        2,
      ).find(
        (entry) =>
          entry.drawable.kind === "sprite" &&
          entry.drawable.sprite.name === "block-top",
      );
      if (roof === undefined || roof.drawable.kind !== "sprite") {
        throw new Error(`expected a roof for ${agentId}`);
      }
      const size = officeSpriteSize(roof.drawable.sprite);
      return {
        x: roof.drawable.x,
        y: roof.drawable.y,
        width: size.width,
        height: size.height,
      };
    };
    const rootOneBox = roofBoxOf("root-1", rootOne);
    const rootTwoBox = roofBoxOf("root-2", rootTwo);
    expect(rectsOverlap(rootOneBox, rootTwoBox)).toBe(true);

    // The genuine overlap rect's own centre - not `centreOf` either roof box
    // alone, which can (and did, on the first draft of this fixture) sit
    // outside the other box despite the two boxes overlapping SOMEWHERE.
    const overlapRect: OfficeRect = {
      x: Math.max(rootOneBox.x, rootTwoBox.x),
      y: Math.max(rootOneBox.y, rootTwoBox.y),
      width:
        Math.min(
          rootOneBox.x + rootOneBox.width,
          rootTwoBox.x + rootTwoBox.width,
        ) - Math.max(rootOneBox.x, rootTwoBox.x),
      height:
        Math.min(
          rootOneBox.y + rootOneBox.height,
          rootTwoBox.y + rootTwoBox.height,
        ) - Math.max(rootOneBox.y, rootTwoBox.y),
    };
    const overlapPoint = centreOf(overlapRect);
    // Independent of `hitTest`: the real merged world stream this scene
    // draws, restricted to these two owners' sprites over the overlap
    // point, tells us which one was painted LAST.
    const frame = scene.frame(2, WHOLE_WORLD);
    expect(frame.world).not.toBeNull();
    if (frame.world === null) return;
    const candidates = frame.world
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          (entry.ownerAgentId === "root-1" ||
            entry.ownerAgentId === "root-2") &&
          entry.drawable.kind === "sprite",
      )
      .filter(({ entry }) => {
        if (entry.drawable.kind !== "sprite") return false;
        const size = officeSpriteSize(entry.drawable.sprite);
        return rectsOverlap(
          {
            x: entry.drawable.x,
            y: entry.drawable.y,
            width: size.width,
            height: size.height,
          },
          { x: overlapPoint.x, y: overlapPoint.y, width: 1, height: 1 },
        );
      });
    expect(candidates.length).toBeGreaterThan(1);
    const lastIndex = Math.max(...candidates.map((c) => c.index));
    const lastOwner = frame.world[lastIndex].ownerAgentId;
    expect(lastOwner).toBe("root-2");
    expect(scene.hitTest(overlapPoint)).toBe(lastOwner);
  });

  it("I4: an unoccupied City reserve lot is painted at lod 1 and 2, and drawn as nothing at lod 0", () => {
    // T2 F8: the chunk index's `reserves` bucket keeps a spare, unassigned
    // seat visible to the painter with `agentId: null` rather than dropping
    // it - City always packs at least one spare lot per team, so a real
    // plan already exercises this.
    const layout = planCity(inputFor("triage", 60, VIEWPORT_1280));
    const assignedSeatIds = new Set(
      [...layout.desks.values()].map((desk) => desk.seatId),
    );
    const reserve = [...layout.seats.values()].find(
      (seat) => !assignedSeatIds.has(seat.seatId) && seat.kind !== "cubby",
    );
    if (reserve === undefined) throw new Error("expected a reserve seat");
    const reserveBox = reserve.hitBox;
    if (reserveBox === null) throw new Error("expected a reserve hitBox");

    const epic = makeTestEpic("triage", 60, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "working");
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    scene.sync(sceneInputFor(epic.agents, statusById));
    const view = reserveBox;

    const atLod0 = scene.frame(0, view).world;
    const atLod1 = scene.frame(1, view).world;
    const atLod2 = scene.frame(2, view).world;
    expect(atLod0).toBeNull();
    for (const frameWorld of [atLod1, atLod2]) {
      expect(frameWorld).not.toBeNull();
      if (frameWorld === null) continue;
      const drawn = frameWorld.some(
        (entry) =>
          entry.ownerAgentId === null &&
          entry.drawable.kind === "sprite" &&
          rectsOverlap(
            {
              x: entry.drawable.x,
              y: entry.drawable.y,
              width: officeSpriteSize(entry.drawable.sprite).width,
              height: officeSpriteSize(entry.drawable.sprite).height,
            },
            reserveBox,
          ),
      );
      expect(drawn).toBe(true);
    }
  });
});
