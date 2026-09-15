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
  type OfficeCivicRoom,
  type OfficeDrawable,
  type OfficeErrandSpot,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeProp,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeSize,
  type OfficeTilePos,
  type OfficeTileRect,
  type OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";
import {
  civicPlateWidth,
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
  overviewBoundingBoxOf,
  overviewCentreOf,
  overviewSamplePoints,
  overviewShapeContains,
  overviewShapeOf,
  OVERVIEW_FRACTIONS,
  type OverviewShape,
} from "@/lib/comm-graph/office/views/__tests__/overview-shapes";
import {
  OFFICE_VIEWS,
  type OfficeDeskState,
  type OfficePlanInput,
  type OfficeProjector,
  type OfficeView,
} from "@/lib/comm-graph/office/views/office-view";

/**
 * NOTHING IN ANY WARD, AND NO ARCHIVE TALLY: what a case that is not about the
 * civic signs hands the resolver.
 *
 * The storeys passed beside it are the real plan's, so a civic sign that does
 * appear still resolves against its own room - it just counts nobody.
 */
const NO_CIVIC_COUNTS = {
  occupiedByRoom: new Map<string, number>(),
  archivedByHost: new Map<string | null, number>(),
};

/** A stopped clock with motion unreduced: no sign in these cases blinks. */
const STILL_SIGN_CLOCK = { nowMs: 0, reducedMotion: false };

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
function bumpingArrayProxy<T>(
  items: ReadonlyArray<T>,
  bump: () => void,
): ReadonlyArray<T> {
  return new Proxy(items, {
    get(target, prop, receiver): unknown {
      if (typeof prop === "string" && /^\d+$/.test(prop)) bump();
      return reflectGet(target, prop, receiver);
    },
  });
}

/** The same, for a case counting into one tally rather than several. */
function countedArrayProxy<T>(
  items: ReadonlyArray<T>,
  counts: { reads: number },
): ReadonlyArray<T> {
  return bumpingArrayProxy(items, () => {
    counts.reads += 1;
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

/** Occupied, close-up: enough sprites that a stale projector would show. */
const CLOSE_UP_WORKING: OfficeDeskState = {
  agentId: "agent-root",
  name: "Root",
  status: "working",
  sheeted: false,
  openRequests: 3,
  screenFrame: 0,
  harnessId: null,
  modelTier: "large",
  accentId: null,
};

/** Nobody in it: the reserve state, which is what an unclaimed bed is. */
const EMPTY_SEAT: OfficeDeskState = {
  agentId: null,
  name: "",
  status: "idle",
  sheeted: false,
  openRequests: 0,
  screenFrame: 0,
  harnessId: null,
  modelTier: "small",
  accentId: null,
};

function paintAllSeats(layout: OfficeLayout): void {
  for (const seat of layout.seats.values()) {
    ISO_PAINTER.seatProps(layout, seat, CLOSE_UP_WORKING, 2);
  }
}

/** Chebyshev gap between two tile rects: 0 if they overlap. */
function tileRectGap(left: OfficeTileRect, right: OfficeTileRect): number {
  const gapCol = Math.max(
    0,
    left.col - (right.col + right.cols),
    right.col - (left.col + left.cols),
  );
  const gapRow = Math.max(
    0,
    left.row - (right.row + right.rows),
    right.row - (left.row + left.rows),
  );
  return Math.max(gapCol, gapRow);
}

function wrapRectReads(rect: OfficeTileRect, bump: () => void): OfficeTileRect {
  return new Proxy(rect, {
    get(target, key, receiver): unknown {
      bump();
      return reflectGet(target, key, receiver);
    },
  });
}

/**
 * Counting proxies over every floor's bounds and amenities, in place, so the
 * ground question's cost is visible on the same `OfficeFloor` objects the
 * index holds. Per-floor and total, because the claim is that districts far
 * from the window cost nothing.
 */
function installFloorBoundCounters(layout: OfficeLayout): {
  readonly total: { reads: number };
  readonly perFloor: ReadonlyArray<{ reads: number }>;
} {
  const total = { reads: 0 };
  const perFloor = layout.floors.map(() => ({ reads: 0 }));
  for (const [index, floor] of layout.floors.entries()) {
    const counts = perFloor[index];
    const bump = (): void => {
      counts.reads += 1;
      total.reads += 1;
    };
    Object.defineProperty(floor, "bounds", {
      value: wrapRectReads({ ...floor.bounds }, bump),
      configurable: true,
    });
    const rawAmenities = floor.amenities;
    for (const amenity of rawAmenities) {
      Object.defineProperty(amenity, "bounds", {
        value: wrapRectReads({ ...amenity.bounds }, bump),
        configurable: true,
      });
    }
    Object.defineProperty(floor, "amenities", {
      value: bumpingArrayProxy(rawAmenities, bump),
      configurable: true,
    });
  }
  total.reads = 0;
  for (const counts of perFloor) counts.reads = 0;
  return { total, perFloor };
}

function lastDistrictWindow(layout: OfficeLayout): OfficeTileRect {
  const last = layout.floors[layout.floors.length - 1];
  return { col: last.bounds.col, row: last.bounds.row, cols: 32, rows: 32 };
}

function snapshotFloorBounds(
  layout: OfficeLayout,
): ReadonlyArray<OfficeTileRect> {
  return layout.floors.map((floor) => ({ ...floor.bounds }));
}

function spriteDeltas(
  before: ReadonlyArray<OfficeWorldDrawable>,
  after: ReadonlyArray<OfficeWorldDrawable>,
): string[] {
  const deltas = new Set<string>();
  for (const [index, entry] of before.entries()) {
    const next = after[index];
    const left = entry.drawable;
    const right = next.drawable;
    if (left.kind !== "sprite" || right.kind !== "sprite") {
      throw new Error("expected sprite drawables");
    }
    deltas.add(`${right.x - left.x},${right.y - left.y}`);
  }
  return [...deltas];
}

function allSeatProps(
  layout: OfficeLayout,
): ReadonlyArray<ReadonlyArray<OfficeWorldDrawable>> {
  return [...layout.seats.values()].map((seat) =>
    ISO_PAINTER.seatProps(layout, seat, CLOSE_UP_WORKING, 2),
  );
}

function wholeWorldTiles(layout: OfficeLayout): OfficeTileRect {
  return { col: 0, row: 0, cols: layout.cols, rows: layout.rows };
}

function projectGrid(
  projector: OfficeProjector,
  layout: OfficeLayout,
): ReadonlyArray<string> {
  const points: string[] = [];
  for (let col = 0; col <= layout.cols; col += 7) {
    for (let row = 0; row <= layout.rows; row += 5) {
      const point = projector.project(col, row);
      points.push(`${point.x},${point.y}`);
    }
  }
  return points;
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
    feedSettled: false,
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
  readonly benchRow: ReadonlyArray<OfficeErrandSpot>;
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
  // THE LARGEST BUCKET IS THE BENCH ROW, and it is a row rather than the pair it
  // used to be: Campus's waiting room IS this row, so it holds
  // `civicCapacityFor().chairs` sitting places and they all share ONE fixture id
  // so that everybody on it rallies with everybody else. The strolls across the
  // lawn belong to no fixture and sit in buckets of one.
  const benchRow = [...byFixture.values()].reduce<OfficeErrandSpot[]>(
    (widest, spots) => (spots.length > widest.length ? spots : widest),
    [],
  );
  if (benchRow.length < 2) throw new Error("expected a bench row");
  return { all, benchRow };
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

/**
 * A stand-in `measure` for the I3 case below, which is about the plate's
 * ANCHOR, not its text. `officeSignsToDraw` only calls `measure` for
 * `sign.kind === "board" | "hq-board"`; the I3 case filters to
 * `kind === "plate"`, so this function is never actually invoked - it exists
 * because the parameter is required, and its value is arbitrary. Anything
 * that genuinely measures a plate's text should take `OFFICE_SIGN_FONT_PX`
 * and `OFFICE_SIGN_LETTER_SPACING_EM` from `office-signs.ts`, not this number.
 */
function plateMeasure(text: string): number {
  return text.length * 6 + 8;
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

function rectsOverlap(left: OfficeRect, right: OfficeRect): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

/** Every seat, occupied or reserve, whose own declared `hitBox` reaches this rect. */
function seatIdsReaching(layout: OfficeLayout, rect: OfficeRect): Set<string> {
  const found = new Set<string>();
  for (const seat of layout.seats.values()) {
    if (seat.hitBox !== null && rectsOverlap(seat.hitBox, rect)) {
      found.add(seat.seatId);
    }
  }
  return found;
}

/** The key `OfficeScene` dedupes a spot by: the tile its walker actually stands on. */
function spotKey(spot: OfficeErrandSpot): string {
  return `${spot.approachTile.col},${spot.approachTile.row}`;
}

/** Every distinct spot in the layout, deduped the same way the scene's chunk index dedupes them. */
function dedupedSpots(layout: OfficeLayout): ReadonlyArray<OfficeErrandSpot> {
  const byKey = new Map<string, OfficeErrandSpot>();
  for (const floor of layout.floors) {
    for (const spot of floor.errandSpots) byKey.set(spotKey(spot), spot);
  }
  return [...byKey.values()];
}

/** A spot's own projected box: one tile at its approach point, the box the chunk index files it under. */
function spotBoxOf(
  projector: OfficeProjector,
  spot: OfficeErrandSpot,
): OfficeRect {
  const origin = projector.project(
    spot.approachTile.col,
    spot.approachTile.row,
  );
  return { x: origin.x, y: origin.y, width: OFFICE_TILE, height: OFFICE_TILE };
}

/**
 * `real` with its `seatProps`/`spotProps` wrapped to record every seat and
 * spot the scene actually asks the painter to draw, while still returning
 * exactly what the real painter returns - so wrapping changes nothing about
 * what a frame contains, only what this test can observe about how it got
 * there.
 */
function wrappedPainterView(
  real: OfficeView,
  seatCalls: OfficeSeat[],
  spotCalls: OfficeErrandSpot[],
): OfficeView {
  return {
    ...real,
    painter: {
      ...real.painter,
      seatProps: (layout, seat, state, lod) => {
        seatCalls.push(seat);
        return real.painter.seatProps(layout, seat, state, lod);
      },
      spotProps: (layout, spot, lod) => {
        spotCalls.push(spot);
        return real.painter.spotProps(layout, spot, lod);
      },
    },
  };
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
    // bounds: 105 x 121 tiles, 3,616 x 1,852 projected px. Campus reads no
    // aspect, so the fit is viewport-independent of shape but not of the
    // viewport itself - each viewport gets its own pinned fit.
    //
    // FOUR ROWS TALLER than before the civic quarter, and the four are the sick
    // bay's band: three rows of ward plus the one-tile gap under the packed
    // shelves. The COLUMNS did not move - the courtyard's longer bench row fits
    // inside the width the packer had already budgeted at this size, and the ward
    // is narrower than the district's content - so the whole cost here is rows.
    const input1280 = inputFor("triage", 1000, VIEWPORT_1280);
    const layout1280 = planCampus(input1280);
    const size1280 = measureCampus(input1280);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout1280.cols, rows: layout1280.rows }).toEqual({
        cols: 105,
        rows: 121,
      });
      expect(size1280).toEqual({ width: 3616, height: 1852 });
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
      expect(fit).toBeCloseTo(0.35, 2);
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
    // Measured: 65 x 89 tiles, 2,464 x 1,276 px.
    //
    // NINE rows taller, where 1,000 agents only grew by four. Four of the nine
    // are the sick bay's band, which every district pays; the other five are a
    // SHELF the packer added, because the courtyard's longer bench row no longer
    // leaves room beside it for the cabin that used to sit there. At 1,000 the
    // budget is wide enough that it did not.
    const input = inputFor("triage", 309, VIEWPORT_1280);
    const layout = planCampus(input);
    const size = measureCampus(input);

    it("pins the tile and pixel size", () => {
      expect({ cols: layout.cols, rows: layout.rows }).toEqual({
        cols: 65,
        rows: 89,
      });
      expect(size).toEqual({ width: 2464, height: 1276 });
    });

    it("pins the fit at both viewports", () => {
      const fit1280 = Math.min(
        VIEWPORT_1280.width / size.width,
        VIEWPORT_1280.height / size.height,
      );
      expect(fit1280).toBeCloseTo(0.52, 2);
      const input680 = inputFor("triage", 309, VIEWPORT_680);
      const size680 = measureCampus(input680);
      const fit680 = Math.min(
        VIEWPORT_680.width / size680.width,
        VIEWPORT_680.height / size680.height,
      );
      expect(fit680).toBeCloseTo(0.28, 2);
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

  it("returns the same projector object for a spread that keeps cols, rows and frozen", () => {
    // The miss above grows `rows`. This spread changes nothing the projector
    // is built from - same `cols`, `rows`, same frozen - so the memo hits
    // even though the layout object is new. A layout-identity key would miss.
    const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
    const first = ISO_PAINTER.projector(layout);
    expect(ISO_PAINTER.projector({ ...layout })).toBe(first);
  });

  describe("the painter's projector memo", () => {
    it("returns the same projector object for the same layout", () => {
      const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
      const first = ISO_PAINTER.projector(layout);
      expect(ISO_PAINTER.projector(layout)).toBe(first);
    });

    it("builds one projector for every seat on the same layout, not one per seat", () => {
      // A value-keyed memo must read `layout.cols` (and `rows`) on every
      // call, hits included - that is the price of not holding a layout
      // reference on `frozen`. The observable is the BUILD: if any seat
      // missed the memo it wrote a new projector, and the final call
      // hands that new object back instead of `before`.
      const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
      expect(layout.seats.size).toBeGreaterThan(20);
      const before = ISO_PAINTER.projector(layout);
      paintAllSeats(layout);
      expect(ISO_PAINTER.projector(layout)).toBe(before);
    });

    it("moves every painted seat by exactly the origin delta when rows grow", () => {
      const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
      const k = 3;
      const grown: OfficeLayout = { ...layout, rows: layout.rows + k };
      const seat = [...layout.seats.values()][0];
      const before = ISO_PAINTER.seatProps(layout, seat, CLOSE_UP_WORKING, 2);
      const after = ISO_PAINTER.seatProps(grown, seat, CLOSE_UP_WORKING, 2);
      expect(before.length).toBeGreaterThan(0);
      expect(after).toHaveLength(before.length);
      expect(spriteDeltas(before, after)).toEqual([`${16 * k},0`]);
    });

    it("paints the same drawables with the index as without it", () => {
      // A layout with no index takes the branch that builds a projector every
      // time, so this is the memoised path against the unmemoised one on the
      // same world. The floor call goes FIRST deliberately: it fills the memo
      // through the painter's own internals, and the projector compared below
      // is then whatever that left behind.
      //
      // Floor lod 2 and spotProps are outside the comparison, and not because
      // they are inconvenient: stripping `frozen` drops the index itself, so
      // the floor pass paints the fixtures the index leaves to spots and
      // `isoSpotDraws` answers true for every `actionTile`. Those differences
      // are the index's, and say nothing about the projector.
      const layout = planCampus(inputFor("triage", 60, VIEWPORT_1280));
      const unindexed: OfficeLayout = { ...layout, frozen: null };
      const tiles = wholeWorldTiles(layout);
      const indexedLod0: ReadonlyArray<OfficeDrawable> = ISO_PAINTER.floor(
        layout,
        tiles,
        0,
      );
      expect(projectGrid(ISO_PAINTER.projector(layout), layout)).toEqual(
        projectGrid(ISO_PAINTER.projector(unindexed), unindexed),
      );
      expect(indexedLod0).toEqual(ISO_PAINTER.floor(unindexed, tiles, 0));
      expect(allSeatProps(layout)).toEqual(allSeatProps(unindexed));
    });
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
      expect(drawable.kind).toBe("quad");
      const shape = overviewShapeOf(drawable);
      if (shape === null) continue;
      // A sheared region has no box of its own, so the bounds check is over
      // the box its four corners span - which is the tightest rectangle the
      // projector has to keep inside the world it reports.
      checkBox("block", overviewBoundingBoxOf(shape));
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

  it("keeps every overview pip inside its own room and inside its district", () => {
    // THE LIVE FINDING (M4), as a case. At overview a seat is a pip (D27) and
    // a pip is a projected tile, so the population traces the shape the tiles
    // project to - a parallelogram. The block map used to answer that with an
    // axis-aligned rectangle of the same AREA, and on the acceptance pass's
    // own `officeBenchShape=many-roots` bench at a thousand agents the result
    // was a grey rectangle with its own people standing outside it at the
    // left and right corners, three amenities floating above it, and none of
    // the rooms where the desks were.
    //
    // The pip's position is the scene's, not this file's: every pip below is
    // read off a real `frame(0, ...)`, and the seat it belongs to is found
    // through `layout.desks`, so nothing here re-derives where a person is
    // drawn.
    const epic = makeTestEpic("many-roots", 1000, 1);
    const scene = new OfficeScene(OFFICE_VIEWS.campus, null);
    scene.sync(sceneInputFor(epic.agents, epic.statusById));
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout after sync");
    // One bullpen for a forest of loners, plus the HQ's own room: the room
    // under test is the one the whole population sits in.
    expect(layout.rooms.length).toBe(2);

    const world = scene.worldSize();
    const frame = scene.frame(0, {
      x: 0,
      y: 0,
      width: world.width,
      height: world.height,
    });
    const projector = ISO_PAINTER.projector(layout);
    const shapeByCentre = new Map<string, OverviewShape>();
    for (const drawable of frame.floor) {
      const shape = overviewShapeOf(drawable);
      if (shape === null) continue;
      const centre = overviewCentreOf(shape);
      shapeByCentre.set(`${centre.x.toFixed(3)},${centre.y.toFixed(3)}`, shape);
    }
    // A region's drawable is found by the point BOTH shapes are centred on -
    // the projection of the region's own centre tile - so this case reads the
    // same drawable whether the painter answers with a rectangle or with the
    // four projected corners, and fails on where that drawable reaches rather
    // than on which one it picked up.
    const shapeFor = (bounds: OfficeTileRect): OverviewShape | undefined => {
      const centre = projector.project(
        bounds.col + bounds.cols / 2,
        bounds.row + bounds.rows / 2,
      );
      return shapeByCentre.get(`${centre.x.toFixed(3)},${centre.y.toFixed(3)}`);
    };

    const outsideRoom: string[] = [];
    const outsideDistrict: string[] = [];
    const unseated: string[] = [];
    let pips = 0;
    let checked = 0;
    for (const drawable of frame.actors) {
      if (drawable.kind !== "pip") continue;
      pips += 1;
      const desk = layout.desks.get(drawable.agentId);
      if (desk === undefined || desk.roomId === null) {
        unseated.push(drawable.agentId);
        continue;
      }
      const room = layout.rooms.find(
        (candidate) => candidate.rootAgentId === desk.roomId,
      );
      if (room === undefined) {
        unseated.push(drawable.agentId);
        continue;
      }
      checked += 1;
      const point = { x: drawable.x, y: drawable.y };
      const roomShape = shapeFor(room.bounds);
      if (roomShape === undefined || !overviewShapeContains(roomShape, point)) {
        outsideRoom.push(`${drawable.agentId} at ${point.x},${point.y}`);
      }
      const district = layout.floors[desk.floorIndex];
      const districtShape = shapeFor(district.bounds);
      if (
        districtShape === undefined ||
        !overviewShapeContains(districtShape, point)
      ) {
        outsideDistrict.push(`${drawable.agentId} at ${point.x},${point.y}`);
      }
    }

    // Anti-vacuity: a frame that drew no pips, or a lookup that found no
    // desks, would satisfy any emptiness below. Every pip resolves to a room
    // (the 40 of the 1,000 with no pip are the fixture's archived share, who
    // are not drawn at all), and the population checked is the population.
    expect(unseated).toEqual([]);
    expect(checked).toBe(pips);
    expect(checked).toBeGreaterThan(900);
    // Measured on the equal-area rectangle: 160 of these pips stood outside
    // their own room and 122 outside their own district.
    expect(outsideRoom.slice(0, 5)).toEqual([]);
    expect(outsideDistrict.slice(0, 5)).toEqual([]);
  });

  it("draws no two same-level, non-touching rooms overlapping on screen", () => {
    // THE PROPERTY the projected quad exists for, and only half of what the
    // old equal-area rectangle delivered: a diamond fills half its bounding
    // box, so two rooms whose TILES never touch could still have boxes that
    // overlap by up to half their width - which is exactly how a two-host
    // City used to read as two overlapping rectangles rather than as two
    // separate blocks. A `quad` is the exact ground its own tiles project
    // to, so two regions whose tile rects are disjoint cannot paint over each
    // other at all; this case is the ground-truth check for that, over a
    // real plan with many rooms rather than a hand-built pair.
    //
    // `triage(1000, ...)` plans 32 Campus rooms (D38's HQ + 30 team cabins +
    // 1 bullpen) - the same fixture the "reads only the index's own
    // references" case below cites for that count - which is enough rooms to
    // make a quadratic all-pairs sweep a real property check without being
    // slow: 32 choose 2 is 496 pairs, each sampled at 9 points a side.
    const input = inputFor("triage", 1000, VIEWPORT_1280);
    const layout = planCampus(input);
    expect(layout.rooms.length).toBe(32);

    const tiles: OfficeTileRect = {
      col: 0,
      row: 0,
      cols: layout.cols,
      rows: layout.rows,
    };
    const drawables = ISO_PAINTER.floor(layout, tiles, 0);
    expect(drawables.length).toBeGreaterThan(0);
    // Rooms are keyed by the projection of their own tile-rect centre, the
    // same match-by-centre the pip case above uses - it reads whichever
    // shape the painter actually emitted (today a `quad`) without this case
    // re-deriving the projection itself.
    const projector = ISO_PAINTER.projector(layout);
    const shapeByCentre = new Map<string, OverviewShape>();
    for (const drawable of drawables) {
      const shape = overviewShapeOf(drawable);
      if (shape === null) continue;
      const centre = overviewCentreOf(shape);
      shapeByCentre.set(`${centre.x.toFixed(3)},${centre.y.toFixed(3)}`, shape);
    }
    const shapeFor = (bounds: OfficeTileRect): OverviewShape | undefined => {
      const centre = projector.project(
        bounds.col + bounds.cols / 2,
        bounds.row + bounds.rows / 2,
      );
      return shapeByCentre.get(`${centre.x.toFixed(3)},${centre.y.toFixed(3)}`);
    };

    const overlaps: string[] = [];
    let disjointPairs = 0;
    for (let i = 0; i < layout.rooms.length; i += 1) {
      const roomA = layout.rooms[i];
      const shapeA = shapeFor(roomA.bounds);
      if (shapeA === undefined) continue;
      const pointsA = overviewSamplePoints(shapeA, OVERVIEW_FRACTIONS);
      for (let j = i + 1; j < layout.rooms.length; j += 1) {
        const roomB = layout.rooms[j];
        // Rooms at the SAME level are supposed never to touch - an amenity
        // sitting inside its district, or a room inside its district, is a
        // deliberate nesting this case has nothing to say about, so pairing
        // is over `layout.rooms` alone and skips any pair whose tile rects
        // do overlap (which same-level rooms should not, but a pair that did
        // would be a different bug from the one under test here).
        if (isoRectsOverlap(roomA.bounds, roomB.bounds)) continue;
        const shapeB = shapeFor(roomB.bounds);
        if (shapeB === undefined) continue;
        disjointPairs += 1;
        const pointsB = overviewSamplePoints(shapeB, OVERVIEW_FRACTIONS);
        for (const point of pointsA) {
          if (overviewShapeContains(shapeB, point)) {
            overlaps.push(
              `${roomA.rootAgentId}'s point ${point.x},${point.y} inside ${roomB.rootAgentId}`,
            );
          }
        }
        for (const point of pointsB) {
          if (overviewShapeContains(shapeA, point)) {
            overlaps.push(
              `${roomB.rootAgentId}'s point ${point.x},${point.y} inside ${roomA.rootAgentId}`,
            );
          }
        }
      }
    }

    // Anti-vacuity: a sweep that resolved no shape (a lookup miss on every
    // room) or found no disjoint pair at all would leave `overlaps` empty for
    // a reason that has nothing to do with the projected quad's shape.
    expect(disjointPairs).toBeGreaterThan(400);
    expect(overlaps.slice(0, 5)).toEqual([]);
  });

  it("reads only the index's own references at lod 2, never layout.rooms or layout.props whole", () => {
    // D38 replaced the old one-room-per-lineage-root Campus with one room per
    // partition team, so `triage(1000, 1)` - the largest room count any view
    // still has - plans 32 rooms (HQ + 30 team cabins + 1 bullpen), not the
    // review's "1,000 rooms and 1,011 props" against the old plan. Measured on
    // this fixture.
    //
    // 70 props where the civic quarter found 47, and the 23 decompose exactly:
    // the courtyard's bench row is the WAITING ROOM here, so at 1,000 agents it
    // holds `civicCapacityFor().chairs` = 16 sitting places where the park held
    // 2, and `isoFixtureProps` stands one bench per fixture tile (+14); the sick
    // bay lays `civicCapacityFor().beds` = 8 beds (+8); the records hut has its
    // door (+1). The room count is untouched because a civic room is not a team's
    // room - it lives on `floor.civic`, and `layout.rooms` never sees it.
    const input = inputFor("triage", 1000, VIEWPORT_1280);
    const layout = planCampus(input);
    expect(layout.rooms.length).toBe(32);
    expect(layout.props.length).toBe(70);

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
    // Measured: 9 of the 32 rooms overlap this window - 12 before the
    // courtyard's bench row became the waiting room and took sixteen tiles
    // instead of two, which pushes three cabins out of a window anchored at the
    // district's top-left corner. Asserting the count is smaller than the whole
    // roster is what stops a lookup that just returns everything from passing
    // this case by accident, and 9 of 32 says it just as well as 12 did.
    expect(rooms.length).toBe(9);
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
    // NAMED rather than counted, because the count alone stopped saying which
    // props these are the moment the civic quarter added some: the courtyard's
    // two trees and its reception desk, plus the records hut's door, which the
    // packer lays on the first shelf just past the cafe. The sick bay's beds are
    // a band under every shelf, far below a window anchored at the corner.
    expect(props.map((prop) => prop.sprite.name).sort()).toEqual([
      "reception",
      "records-door",
      "tree",
      "tree",
    ]);
  });

  it("gives every bench seat a sitting pose and leaves the bare lawn spots standing", () => {
    const epic = makeTestEpic("triage", 12, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "idle");
    const scene = new OfficeScene(OFFICE_VIEWS.campus, null);
    scene.sync(sceneInputFor(epic.agents, statusById));
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout after sync");

    const { all, benchRow } = gardenSpotsOf(layout);
    // EVERY seat on the row is a real anchor with its own sprite on it. Before
    // the fix the second carried `null` to keep the art from being drawn twice,
    // and the scene reads a null garden anchor as "no bench, therefore stand" -
    // so the second arrival waited on its feet. The row is as long as the
    // waiting room's chair count now, so this walks all of it rather than a pair.
    expect(benchRow.length).toBeGreaterThan(2);
    const propAt = new Map(
      layout.props.map((prop) => [`${prop.tile.col},${prop.tile.row}`, prop]),
    );
    const problems: string[] = [];
    for (const spot of benchRow) {
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
      if (benchRow.includes(spot)) continue;
      if (spot.actionTile !== null) {
        problems.push(
          `stroll at ${spot.tile.col},${spot.tile.row} has an anchor`,
        );
      }
    }
    expect(problems).toEqual([]);

    expect(someoneSitsAt(scene, layout, benchRow[1])).toBe(true);
  });

  /**
   * THE SHARED BENCH, and the one thing it must never do.
   *
   * A campus bench is two things at one tile: the seat the waiting room lends and
   * the fixture a stroll sits on. `OfficeErrandSpot.seatId` names the seat on the
   * spot so the errand pass can ask whether it is taken, and `spotSuitsAgent`
   * drops a spot whose seat has somebody in it.
   *
   * Without that, both systems place somebody on the same tile: the waiter that
   * the seat book believes it seated, and the stroller that walked over to sit
   * down. So what this pins is the count of SITTERS on a bench tile at every
   * tick, and sitters rather than characters because a bench's seat is open lawn -
   * anybody crossing the courtyard stands on it in passing, which is a walker
   * using a path and not two people in one seat. `sit` is what both the lounge
   * claim and the garden errand draw, so it is the pose that catches the clash.
   */
  it("never sits a stroller on a bench a waiting agent holds", () => {
    const epic = makeTestEpic("triage", 12, 1);
    const layoutForSeats = planCampus(inputFor("triage", 12, VIEWPORT_1280));
    const benches = [...layoutForSeats.seats.values()].filter(
      (seat) => seat.kind === "lounge",
    );
    expect(benches.length).toBeGreaterThan(1);

    // EVERY bench claimed, so any stroller the errand pass wants to seat has to
    // be turned away from all of them rather than from all but the last.
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "idle");
    for (const agent of epic.agents.slice(0, benches.length)) {
      statusById.set(agent.id, "awaiting");
    }
    const scene = new OfficeScene(OFFICE_VIEWS.campus, null);
    scene.sync(sceneInputFor(epic.agents, statusById));
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout after sync");

    const projector = ISO_PAINTER.projector(layout);
    const footOf = (tile: OfficeTilePos): string => {
      const point = projector.project(tile.col + 0.5, tile.row + 1);
      return `${point.x - OFFICE_CHARACTER_WIDTH / 2},${point.y - OFFICE_CHARACTER_HEIGHT}`;
    };
    const benchFeet = new Set(benches.map((seat) => footOf(seat.chairTile)));
    let sharedTile: string | null = null;
    let everOccupied = false;
    for (let step = 0; step < 600 && sharedTile === null; step += 1) {
      scene.tick(100);
      const perFoot = new Map<string, number>();
      for (const entry of scene.frame(2, WHOLE_WORLD).world ?? []) {
        const drawable = entry.drawable;
        if (drawable.kind !== "sprite") continue;
        if (drawable.sprite.name !== "character") continue;
        if (drawable.sprite.pose !== "sit") continue;
        const key = `${drawable.x},${drawable.y}`;
        if (!benchFeet.has(key)) continue;
        const seen = (perFoot.get(key) ?? 0) + 1;
        perFoot.set(key, seen);
        everOccupied = true;
        if (seen > 1) sharedTile = key;
      }
    }
    // Anti-vacuity: a run where nobody ever reached a bench would report no
    // sharing for a reason that has nothing to do with the predicate.
    expect(everOccupied).toBe(true);
    expect(sharedTile).toBeNull();
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
    remapHostId: ((index: number) => string) | undefined,
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
    it.each([{ n: 10 }, { n: 100 }, { n: 1000 }])(
      "reads bullpen.bounds a handful of times at $n hosts",
      ({ n }) => {
        const layout = planCampus(manyRootsInput(n, undefined));
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
        // Measured: 11, 8 and 8 reads at 10, 100 and 1,000 hosts. One shared
        // budget across all three is the constancy claim; 24 leaves headroom
        // over the 11 without letting a per-tile perimeter walk (hundreds
        // of reads on a large bullpen) pass.
        expect(counts.reads).toBeLessThan(24);
      },
    );
  });

  it("costs the same per tile at 1 host and at 50, for the ground question", () => {
    // `isoGroundAt` answers per tile from the coarse-cell index, so cost
    // tracks the WINDOW and not the population. Counting proxies wrap every
    // floor's bounds and amenities in place, over the same `OfficeFloor`
    // OBJECTS the index holds - per floor, because the claim is that the
    // districts the window is not in cost NOTHING, which no total can say.
    //
    // Measured over the 1,024-tile window: 7,191 reads at one host and 8,214
    // at fifty - and at fifty, two districts are read and the other
    // forty-eight exactly zero times. Evidence in a comment, not pins: the
    // assertions below are the zero, a per-tile bound (10 a tile), and the
    // ratio. An earlier form of this case took its window from bounds it had
    // already wrapped, which cost two reads of the last floor, spent
    // measuring rather than painting - the same +2 any instrumentation of
    // this case pays, so a figure two above these was measured that way.
    //
    // THE BOUND WAS 8 AND THE CIVIC QUARTER OUTGREW IT, so it is 10. What
    // grew, at this case's twenty agents: the district went 22x22 -> 19x31,
    // NARROWER and nine rows taller, because the sick bay's band lies under
    // every packed shelf and the shelves re-pack around a wider courtyard;
    // and the courtyard went 7 -> 9 columns, since its bench row IS the
    // waiting room and the contract asks for four chairs at this size
    // (`isoCourtyardCols`). Reads followed the tiles: 6,221 -> 8,214 at
    // fifty, which is 6.08 -> 8.02 a tile. So 8 was headroom over 6.08 and
    // is now under the measurement; 10 is headroom over 8.02. The bound is
    // still the constancy claim and not a budget for the quarter - what it
    // must keep out is a per-tile perimeter walk, which is hundreds a tile
    // and not eight.
    //
    // An early break in `isoGroundAt` - stopping the floor scan at the first
    // district whose bounds contain the tile - was tried here to win the
    // growth back and MEASURED AS NOTHING: the index already hands it one or
    // two candidates, so there is no scan left to cut short. Reverted, and
    // recorded so it is not tried a third time.

    const layout1 = planCampus(manyRootsInput(20, undefined));
    const window1 = lastDistrictWindow(layout1);
    const counts1 = installFloorBoundCounters(layout1);
    ISO_PAINTER.floor(layout1, window1, 2);

    // 50 hosts at the same density - 1,000 agents dealt round-robin across
    // fifty host bands, so each district holds the same twenty agents the
    // one-host plan above does and only the DISTRICT count differs.
    const layout50 = planCampus(
      manyRootsInput(1000, (index) => `host-${index % 50}`),
    );
    expect(layout50.floors.length).toBe(50);
    const bounds50 = snapshotFloorBounds(layout50);
    const window50 = lastDistrictWindow(layout50);
    const counts50 = installFloorBoundCounters(layout50);
    ISO_PAINTER.floor(layout50, window50, 2);

    let farFloors = 0;
    let nearbyReads = 0;
    for (const [index, bounds] of bounds50.entries()) {
      if (tileRectGap(bounds, window50) > 32) {
        expect(counts50.perFloor[index].reads).toBe(0);
        farFloors += 1;
      } else {
        nearbyReads += counts50.perFloor[index].reads;
      }
    }
    expect(farFloors).toBeGreaterThan(layout50.floors.length / 2);
    // Districts READ AT ALL, which is the claim from the other side: the
    // window's own and whatever shares a coarse cell with it. Measured 2 of
    // 50. A count of districts rather than of field reads, so a reader that
    // asks each of them one question fewer does not move it.
    const touched = counts50.perFloor.filter((counts) => counts.reads > 0);
    expect(touched.length).toBeLessThanOrEqual(5);
    expect(nearbyReads).toBeLessThan(1024 * 10);
    expect(counts1.total.reads).toBeLessThan(1024 * 10);
    expect(counts50.total.reads / counts1.total.reads).toBeLessThan(2);

    // Without the index (the walk this replaced), the same 50-host window
    // costs an order of magnitude more - the comparison the index exists
    // to make untrue.
    const unindexed: OfficeLayout = { ...layout50, frozen: null };
    const countsUnindexed = installFloorBoundCounters(unindexed);
    ISO_PAINTER.floor(unindexed, window50, 2);
    expect(countsUnindexed.total.reads).toBeGreaterThan(
      counts50.total.reads * 5,
    );
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
      // DESKS, which is what this case is named for and what `campusSeatProps`
      // draws. A bed and a bench are seats too and they carry a real box for the
      // same reason - `isoCampusSeatBox` off their own tile, asserted above by
      // the `null` check every seat goes through.
      //
      // THE PAINTER NOW HAS A CIVIC BRANCH, and this case still does not read
      // it: `paintSeat` returns nothing for a civic seat, so a painted union
      // measured here would be empty. Stated as what is UNVERIFIED rather than
      // as a reason: between this skip and the sibling case's `null` check, the
      // civic seats' hit-box GEOMETRY is pinned by neither - only its
      // non-nullness is. The pin belongs with whichever branch ends up drawing
      // civic furniture from the seat in the isometric views, and today none
      // does; Campus draws it from the plan.
      if (seat.civicRoomId !== null) continue;
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

  it("I1: culls seats AND spots by their own PROJECTED box, not a raw tile viewport", () => {
    // T2 F1: `chunkKeysOfBox(this.seatBox(seat))`/`chunkKeysOfBox(this.spotBox(spot))`
    // file a seat/spot under the chunks its own PROJECTED box covers. Real
    // Campus at 1,000 agents, over three populated windows - the chunk-
    // boundary corner this case originally shipped with (which, it turns
    // out, contains zero spots and so cannot guard the spot half at all) plus
    // two corners that genuinely contain spots (measured on `dd72b1399`: 3
    // seats/8 spots and 5 seats/10 spots), so inclusion and exclusion are
    // both exercised for both seats and spots, over a world of 1,000 seats
    // and 46 spots.
    //
    // A FRESH `OfficeScene` per window, never one scene panned across
    // several: `buildSeatProps` caches a seat's/spot's own painter output by
    // seat id/tile, so a selection that re-enters view under a cache hit
    // would never reach `seatProps`/`spotProps` again, and this callback
    // would miss it - exactly the gap the reviewer's own probe had to work
    // around by reaching into the cache. A fresh scene per window has no
    // such cache to hide behind.
    const epic = makeTestEpic("triage", 1000, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "working");

    const views: ReadonlyArray<OfficeRect> = [
      { x: 950, y: 550, width: 250, height: 300 },
      { x: 1836, y: 68, width: 64, height: 64 },
      { x: 2012, y: 156, width: 64, height: 64 },
    ];
    let sawSpots = false;
    let sawExcludedSeat = false;
    let sawExcludedSpot = false;

    for (const view of views) {
      const seatCalls: OfficeSeat[] = [];
      const spotCalls: OfficeErrandSpot[] = [];
      const scene = new OfficeScene(
        wrappedPainterView(OFFICE_VIEWS.campus, seatCalls, spotCalls),
        null,
      );
      scene.sync(sceneInputFor(epic.agents, statusById));
      const layout = scene.layout();
      if (layout === null) throw new Error("expected a layout after sync");
      const projector = OFFICE_VIEWS.campus.painter.projector(layout);
      const grown = grownByMargin(view);

      scene.frame(2, view);

      const wantedSeats = seatIdsReaching(layout, grown);
      const allSpots = dedupedSpots(layout);
      const wantedSpots = new Set(
        allSpots
          .filter((spot) => rectsOverlap(spotBoxOf(projector, spot), grown))
          .map(spotKey),
      );
      // Equal in BOTH directions - `toEqual` on a `Set` fails on either an
      // extra or a missing member - which is what makes exclusion outside
      // the margin non-vacuous alongside inclusion inside it.
      expect(new Set(seatCalls.map((seat) => seat.seatId))).toEqual(
        wantedSeats,
      );
      expect(new Set(spotCalls.map(spotKey))).toEqual(wantedSpots);

      if (wantedSpots.size > 0) sawSpots = true;
      if (wantedSeats.size < layout.seats.size) sawExcludedSeat = true;
      if (wantedSpots.size < allSpots.length) sawExcludedSpot = true;
    }

    // Non-vacuous: at least one window genuinely contains spots (closing R3
    // - the shipped window alone never could), and every window's exact
    // match still excludes some of the world's seats and spots rather than
    // the comparison passing because both sides happened to be everything,
    // or both empty.
    expect(sawSpots).toBe(true);
    expect(sawExcludedSeat).toBe(true);
    expect(sawExcludedSpot).toBe(true);
  });

  it("I1: a small window's spot query reads a small fraction of a whole-world one, through the index's own approachTile objects", () => {
    // R3's read-budget half. Counting Proxies installed IN PLACE over the
    // exact `approachTile` object each spot carries - the same objects
    // `spotsIn`'s chunk index holds and `spotBox` reads through - so this
    // measures the real per-tile cost of the lookup the painter is fed
    // through, not a count taken on some other copy of the data.
    const epic = makeTestEpic("triage", 1000, 1);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const agent of epic.agents) statusById.set(agent.id, "working");
    const scene = new OfficeScene(OFFICE_VIEWS.campus, null);
    scene.sync(sceneInputFor(epic.agents, statusById));
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout after sync");
    // The chunk index is built lazily on its first use, inside the first
    // `spotsIn` call - so warm it with an untracked frame BEFORE installing
    // the counting Proxies below, or the count would include the one-time
    // build cost (every spot, once) rather than only the QUERY cost this
    // case is about.
    scene.frame(2, WHOLE_WORLD);

    const counts = { reads: 0 };
    for (const floor of layout.floors) {
      for (const spot of floor.errandSpots) {
        const raw: OfficeTilePos = { ...spot.approachTile };
        Object.defineProperty(spot, "approachTile", {
          value: new Proxy(raw, {
            get(target, key) {
              counts.reads += 1;
              return reflectGet(target, key, target);
            },
          }),
          configurable: true,
        });
      }
    }

    counts.reads = 0;
    scene.frame(2, { x: 1836, y: 68, width: 64, height: 64 });
    const smallWindowReads = counts.reads;

    counts.reads = 0;
    scene.frame(2, WHOLE_WORLD);
    const wholeWorldReads = counts.reads;

    expect(smallWindowReads).toBeGreaterThan(0);
    // Measured on 08ee4f038: 96 reads for the 64x64 window against 278 for
    // the whole 8,000x8,000 world; bounded at 2x those rather than pinned,
    // since the claim is the FRACTION and not either count.
    //
    // The mutation these are aimed at is the query ignoring the chunk index
    // and scanning every chunk: the small window then reads 204, which
    // breaks the bound and the ratio together. A tile-chunk filing of the
    // spots themselves - the pre-T2 shape - makes the small window read
    // FEWER (8), and is caught where it belongs, by the culling case above:
    // `expected Set{} to deeply equal Set{ '2,4', '3,4', '6,4', '1,5', ... }`.
    // A floor under the read count would catch it here too, and would fail
    // just as readily on a reader that legitimately read `approachTile`
    // once instead of twice, which is the pin this case is being cured of.
    expect(smallWindowReads).toBeLessThan(192);
    expect(wholeWorldReads).toBeLessThan(556);
    expect(smallWindowReads).toBeLessThan(wholeWorldReads / 2);
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
        floors: layout.floors,
        civicTally: NO_CIVIC_COUNTS,
        clock: STILL_SIGN_CLOCK,
        signs: [sign],
        visibleAgentIds: new Set(layout.desks.keys()),
        statusById: new Map(),
        nameById: new Map(),
        hostNameById: new Map(),
        roleClaims: {},
        projector,
        lod: 2,
        zoom: 1,
        measure: plateMeasure,
      });
      expect(drawn).toHaveLength(1);
      expect(drawn[0].anchor).toEqual(anchor);
    }
  });
});

/**
 * WHAT THE PAINTER OWES A CIVIC ROOM, and what it must not give it.
 *
 * Read O's findings 1 and 2: the civic seats and rooms reached the plan and then
 * fell through the painter. Beds and benches entered `layout.seats`, the scene
 * asked for their props like any other seat's, and the isometric painter had no
 * branch for them - so `campusSeatProps` put a `desk-iso` slab on a hospital bed
 * and a crashed monitor on top of the patient in it. The rooms had the mirror
 * problem: `pushRoomWalls` reads `layout.rooms`, so the ward's and the hut's wall
 * tiles were blocked by the plan and drawn by nobody, and `blockMap` never
 * emitted a civic quad, so all four rooms vanished as rooms at overview.
 */
describe("campus civic rooms, painted", () => {
  const CIVIC_SEAT_KINDS: ReadonlySet<OfficeSeat["kind"]> = new Set([
    "bed",
    "lounge",
  ]);

  function campusLayout(n: number): OfficeLayout {
    return planCampus(inputFor("triage", n, { width: 1040, height: 700 }));
  }

  /** Sprite names in a run of drawables, however they are wrapped. */
  function spritesOf(
    drawables: ReadonlyArray<OfficeWorldDrawable>,
  ): ReadonlyArray<string> {
    const names: string[] = [];
    for (const entry of drawables) {
      const drawable = entry.drawable;
      if (drawable.kind === "sprite") names.push(drawable.sprite.name);
    }
    return names;
  }

  it.each([1, 2] as const)(
    "gives a bed and a bench no workstation at lod %i",
    (lod) => {
      const layout = campusLayout(309);
      const civic = [...layout.seats.values()].filter(
        (seat) => seat.civicRoomId !== null,
      );
      // The fixture has to hold both kinds, or the case is about one of them.
      expect(civic.length).toBeGreaterThan(0);
      expect(new Set(civic.map((seat) => seat.kind))).toEqual(CIVIC_SEAT_KINDS);

      for (const seat of civic) {
        // EMPTY AND CLAIMED, because the defect was different in each: an empty
        // bed grew a desk slab, and an occupied one grew the slab AND a monitor.
        for (const state of [EMPTY_SEAT, CLOSE_UP_WORKING]) {
          const painted = ISO_PAINTER.seatProps(layout, seat, state, lod);
          expect(
            spritesOf(painted),
            `${seat.kind} ${seat.seatId} painted a workstation`,
          ).toEqual([]);
        }
      }

      // AND ORDINARY DESKS ARE UNTOUCHED, which is the half that keeps this from
      // passing on a painter that stopped drawing seats altogether.
      const desks = [...layout.seats.values()].filter(
        (seat) => seat.civicRoomId === null && seat.kind === "desk",
      );
      expect(desks.length).toBeGreaterThan(0);
      const drawn = spritesOf(
        ISO_PAINTER.seatProps(layout, desks[0], CLOSE_UP_WORKING, lod),
      );
      expect(drawn).toContain("desk-iso");
    },
  );

  it("walls a civic room where the plan blocked it, and nowhere else", () => {
    const layout = campusLayout(309);
    const ward = layout.floors
      .flatMap((floor) => floor.civic)
      .find((room) => room.kind === "infirmary");
    // THE HUT TOO, because the filter exists for TWO openings and this case
    // used to witness one. The ward's aisle is the first; the records hut's own
    // way out, on the last row of its first column, is the second.
    const hut = layout.floors
      .flatMap((floor) => floor.civic)
      .find((room) => room.kind === "archive");
    if (hut === undefined) throw new Error("no records hut");
    if (ward === undefined) throw new Error("no ward");

    // The whole district, so the window cannot be the reason a wall is missing.
    const whole: OfficeTileRect = {
      col: 0,
      row: 0,
      cols: layout.cols,
      rows: layout.rows,
    };
    const walls = ISO_PAINTER.floor(layout, whole, 1).filter(
      (drawable) =>
        drawable.kind === "sprite" &&
        (drawable.sprite.name === "wall-iso-left" ||
          drawable.sprite.name === "wall-iso-right"),
    );
    expect(walls.length).toBeGreaterThan(0);

    const projector = ISO_PAINTER.projector(layout);
    const cornerKey = (col: number, row: number): string => {
      const point = projector.project(col, row);
      return `${point.x},${point.y}`;
    };
    const rightWalls = new Set<string>();
    const leftWalls = new Set<string>();
    for (const wall of walls) {
      if (wall.kind !== "sprite") continue;
      const key = `${wall.x},${wall.y + 24}`;
      if (wall.sprite.name === "wall-iso-right") rightWalls.add(key);
      // PLUS SIXTEEN, not thirty-two: a left wall is drawn at
      // `corner.x - ISO_HALF_WIDTH`, and ISO_HALF_WIDTH is one tile. At +32 no
      // key in this set ever matched a corner, so every `leftWalls.has(...)`
      // below answered false and the aisle assertion - the one that justifies
      // the walkability filter existing at all - passed on an empty set.
      else leftWalls.add(`${wall.x + ISO_HALF_WIDTH},${wall.y + 24}`);
    }

    // THE WARD'S TOP ROW IS A WALL, every column of it.
    for (
      let col = ward.bounds.col;
      col < ward.bounds.col + ward.bounds.cols;
      col += 1
    ) {
      expect(
        rightWalls.has(cornerKey(col, ward.bounds.row)),
        `ward top row col ${String(col)} has no wall`,
      ).toBe(true);
    }
    // AND ITS AISLE COLUMN IS NOT, below that corner - the door is in it, and a
    // wall there would leave whoever came through facing a bed with no step. The
    // plan says so by leaving those tiles walkable, and this is the assertion
    // that a painter deriving walls from bounds alone would fail.
    for (
      let row = ward.bounds.row + 1;
      row < ward.bounds.row + ward.bounds.rows;
      row += 1
    ) {
      expect(layout.walkable[row]?.[ward.bounds.col]).toBe(true);
      expect(
        leftWalls.has(cornerKey(ward.bounds.col, row)),
        `ward aisle row ${String(row)} was walled shut`,
      ).toBe(false);
    }

    // THE HUT'S BACK WALL IS A WALL, so the negative below is not passing
    // because the hut is unwalled altogether.
    for (
      let col = hut.bounds.col;
      col < hut.bounds.col + hut.bounds.cols;
      col += 1
    ) {
      expect(
        rightWalls.has(cornerKey(col, hut.bounds.row)),
        `hut top row col ${String(col)} has no wall`,
      ).toBe(true);
    }
    // AND ITS WAY OUT IS OPEN: the last row of its first column, which the plan
    // leaves walkable while walling the rows between the corners. This is the
    // second opening the walkability filter exists for, and the one this case
    // did not witness before.
    const hutExitRow = hut.bounds.row + hut.bounds.rows - 1;
    expect(layout.walkable[hutExitRow]?.[hut.bounds.col]).toBe(true);
    expect(
      leftWalls.has(cornerKey(hut.bounds.col, hutExitRow)),
      "the hut's way out was walled shut",
    ).toBe(false);
    // The rows between the corners ARE walled, which is what makes the line
    // above an opening rather than a hut with no left wall at all.
    for (let row = hut.bounds.row + 1; row < hutExitRow; row += 1) {
      expect(
        leftWalls.has(cornerKey(hut.bounds.col, row)),
        `hut left wall missing at row ${String(row)}`,
      ).toBe(true);
    }
  });

  /**
   * AN OPEN CIVIC ROOM GETS NO WALLS, WHATEVER ITS TILES SAY.
   *
   * The counter case is the regression: the front desk's bounds ARE the
   * reception counter, whose two tiles are blocked because a counter is solid,
   * and a painter that read blockedness as a wall boxed in the one room in the
   * layer you are meant to walk up to. Measured at the time: two
   * `wall-iso-right` along its top row and one `wall-iso-left` down its side, at
   * every population.
   *
   * ONE CASE PER OPEN ROOM rather than one for the desk, because the rule is
   * about the CLASS - `enclosure`, which the plan states - and the two open
   * rooms fail it in different ways. The counter is open AND blocked, so it
   * reds a painter that reads tiles. The bench row is open and UNBLOCKED, so it
   * reds a painter that reads bounds instead. Only the pair distinguishes the
   * field from either shortcut.
   *
   * The reverse direction is deliberately not asserted anywhere: "open implies
   * an unblocked perimeter" is FALSE of the counter, and believing it is exactly
   * what went wrong.
   *
   * READ V'S E3, ATTRIBUTED: WHICH MUTANT ACTUALLY GAVE THE BENCH ROW ITS TEETH.
   * The mutant recorded for that - "benches declared walled AND filter removed",
   * 4 red - reds all three bench cases, but it reds them on the FIRST line of
   * each, `enclosure` itself, because declaring the row walled changes the
   * plan's own declaration and the wall scan below never runs. So those three
   * reds established nothing about the scan, which is the half the paragraph
   * above rests on.
   *
   * Measured on the PAINTER instead, which is where the bounds-reading shortcut
   * would live: `pushCivicWalls` with its `enclosure` gate and BOTH blockedness
   * gates removed. The declaration line stays green, the scan reds - `bench 2,4
   * was walled: expected true to be false` - at 12, 309 and 1,000. Both gates
   * have to go together: dropping the `enclosure` gate alone leaves the bench
   * cases green, since an unblocked row gives that painter no tile to wall,
   * which is the same asymmetry the table's first row already recorded.
   */
  describe("open civic rooms", () => {
    /** Every wall corner the painter emitted, by side, for one population. */
    function wallCornersOf(layout: OfficeLayout): {
      right: ReadonlySet<string>;
      left: ReadonlySet<string>;
    } {
      const whole: OfficeTileRect = {
        col: 0,
        row: 0,
        cols: layout.cols,
        rows: layout.rows,
      };
      const right = new Set<string>();
      const left = new Set<string>();
      for (const drawable of ISO_PAINTER.floor(layout, whole, 1)) {
        if (drawable.kind !== "sprite") continue;
        if (drawable.sprite.name === "wall-iso-right") {
          right.add(`${drawable.x},${drawable.y + 24}`);
        } else if (drawable.sprite.name === "wall-iso-left") {
          left.add(`${drawable.x + ISO_HALF_WIDTH},${drawable.y + 24}`);
        }
      }
      return { right, left };
    }

    it.each([12, 309, 1000])(
      "leaves the front desk's counter open at %i agents",
      (n) => {
        const layout = campusLayout(n);
        const desk = layout.floors
          .flatMap((floor) => floor.civic)
          .find((room) => room.kind === "help-desk");
        if (desk === undefined) throw new Error("no front desk");
        expect(desk.enclosure).toBe("open");

        // THE COUNTER IS STILL THERE, so "no walls" cannot be passing because
        // the desk stopped being drawn at all.
        const counterTiles = new Set<string>();
        for (let col = desk.bounds.col; col < desk.bounds.col + 2; col += 1) {
          counterTiles.add(`${String(col)},${String(desk.bounds.row)}`);
        }
        // DRAWN, not merely planned. `layout.props` says the plan asked for a
        // counter; only the painter's own output says one is on screen, and
        // "the desk is still there" is the claim this line has to make.
        //
        // Its anchor is the counter tile's projected corner less half a tile
        // each way - measured, and stated so a sprite drawn at some other
        // counter cannot satisfy it. Exactly one, at both close ranges.
        const counterCorner = ISO_PAINTER.projector(layout).project(
          desk.bounds.col,
          desk.bounds.row,
        );
        const wantAt = `${String(counterCorner.x - ISO_HALF_WIDTH)},${String(counterCorner.y - ISO_HALF_HEIGHT)}`;
        for (const lod of [1, 2] as const) {
          const drawnAt = ISO_PAINTER.floor(
            layout,
            { col: 0, row: 0, cols: layout.cols, rows: layout.rows },
            lod,
          ).flatMap((drawable) =>
            drawable.kind === "sprite" && drawable.sprite.name === "reception"
              ? [`${String(drawable.x)},${String(drawable.y)}`]
              : [],
          );
          expect(drawnAt, `reception at lod ${String(lod)}`).toEqual([wantAt]);
        }
        // AND ITS TILES ARE BLOCKED, which is the premise that made the defect
        // possible: a painter reading tiles sees exactly what a wall looks like.
        for (const tile of counterTiles) {
          const [col, row] = tile.split(",").map(Number);
          expect(layout.walkable[row]?.[col]).not.toBe(true);
        }

        const { right, left } = wallCornersOf(layout);
        const projector = ISO_PAINTER.projector(layout);
        for (const tile of counterTiles) {
          const [col, row] = tile.split(",").map(Number);
          const point = projector.project(col, row);
          const key = `${point.x},${point.y}`;
          expect(right.has(key), `counter ${tile} got a right wall`).toBe(
            false,
          );
          expect(left.has(key), `counter ${tile} got a left wall`).toBe(false);
        }
      },
    );

    it.each([12, 309, 1000])("leaves the bench row open at %i agents", (n) => {
      const layout = campusLayout(n);
      const benches = layout.floors
        .flatMap((floor) => floor.civic)
        .find((room) => room.kind === "waiting-room");
      if (benches === undefined) throw new Error("no bench row");
      expect(benches.enclosure).toBe("open");

      const { right, left } = wallCornersOf(layout);
      const projector = ISO_PAINTER.projector(layout);
      const b = benches.bounds;
      for (let col = b.col; col < b.col + b.cols; col += 1) {
        for (let row = b.row; row < b.row + b.rows; row += 1) {
          const point = projector.project(col, row);
          const key = `${point.x},${point.y}`;
          expect(
            right.has(key) || left.has(key),
            `bench ${String(col)},${String(row)} was walled`,
          ).toBe(false);
        }
      }
      // The lawn is walkable under the whole row, which is the other half of
      // what makes this room the bounds-reading painter's discriminator.
      for (let col = b.col; col < b.col + b.cols; col += 1) {
        expect(layout.walkable[b.row]?.[col]).toBe(true);
      }
    });
  });

  it("gives every civic room a quad of its own at overview", () => {
    const layout = campusLayout(309);
    const whole: OfficeTileRect = {
      col: 0,
      row: 0,
      cols: layout.cols,
      rows: layout.rows,
    };
    const blocks = ISO_PAINTER.floor(layout, whole, 0);
    // `quad`, not `block`: the isometric painter draws a lod-0 region as a
    // projected diamond, where the flat and oblique painters draw a rect.
    const civicQuads = blocks.filter(
      (drawable) => drawable.kind === "quad" && drawable.fill === "civic",
    );
    const rooms = layout.floors.flatMap((floor) => floor.civic);
    expect(rooms.length).toBeGreaterThan(0);
    // One per room, and the district's own quads still there beneath them.
    expect(civicQuads.length).toBe(rooms.length);
    expect(
      blocks.some(
        (drawable) => drawable.kind === "quad" && drawable.fill === "storey",
      ),
    ).toBe(true);
  });
});

/**
 * THE WIDTH RULE, WITH ITS OWN WITNESSES.
 *
 * A civic plate is as wide as the room it names, and where it hangs decides
 * which reading of that applies. The inset reading had a shipped witness until
 * the sick bay's plate moved to its wall's corner to clear the district's host
 * sign; nothing Campus plans is inset now, so the case plants one rather than
 * letting the rule go untested. The numbers below are the ones the defect was
 * measured at when the plate WAS inset: a 4-tile frontage plated with 5 at two
 * beds, and a 16-tile frontage plated with 17 at eight.
 */
describe("campus civic plate width", () => {
  function roomAt(args: {
    readonly boundsCol: number;
    readonly cols: number;
    readonly signCol: number;
  }): OfficeCivicRoom {
    const { boundsCol, cols, signCol } = args;
    return {
      civicRoomId: "host/0/civic/infirmary",
      kind: "infirmary",
      bounds: { col: boundsCol, row: 20, cols, rows: 3 },
      doorTile: { col: boundsCol, row: 21 },
      signTile: { col: signCol, row: 20 },
      name: "Sick bay",
      seatIds: [],
      floorIndex: 0,
      hostId: null,
      hostScope: "host",
      enclosure: "walled",
      kerbTile: null,
    };
  }

  it("stops an inset plate at the room's right edge, not one tile past it", () => {
    // The historical anchor: one column in, past the ward's wall. Sizing by the
    // room gave 5 over a 4-tile frontage - the plate lettering onto the tile
    // after the room - and this is the control that keeps that rule pinned now
    // that no shipped room hangs a plate there.
    const twoBeds = roomAt({ boundsCol: 1, cols: 5, signCol: 2 });
    expect(civicPlateWidth(twoBeds)).toBe(4);
    expect(twoBeds.signTile.col + civicPlateWidth(twoBeds)).toBe(
      twoBeds.bounds.col + twoBeds.bounds.cols,
    );

    // The same at the other end of the contract's bed range: 17 over 16.
    const eightBeds = roomAt({ boundsCol: 1, cols: 17, signCol: 2 });
    expect(civicPlateWidth(eightBeds)).toBe(16);
    expect(eightBeds.signTile.col + civicPlateWidth(eightBeds)).toBe(
      eightBeds.bounds.col + eightBeds.bounds.cols,
    );
  });

  it("gives a plate on the room's first column the whole frontage", () => {
    // Where the two readings agree, which is why sizing by the room survived
    // until an inset plate arrived - and where the sick bay's plate sits now.
    const corner = roomAt({ boundsCol: 1, cols: 5, signCol: 1 });
    expect(civicPlateWidth(corner)).toBe(5);
  });

  it("gives a plate anchored outside the room the room's own width", () => {
    // The front desk at the district's gate: columns away from the counter it
    // names, so the run from the anchor to the room is not a frontage. Both
    // sides of the room are tested, because a plate to the RIGHT of its room
    // would make the inside formula negative rather than merely too wide.
    const fromTheLeft = roomAt({ boundsCol: 3, cols: 2, signCol: 0 });
    expect(civicPlateWidth(fromTheLeft)).toBe(2);
    const fromTheRight = roomAt({ boundsCol: 3, cols: 2, signCol: 9 });
    expect(civicPlateWidth(fromTheRight)).toBe(2);
    // The boundary itself is INSIDE: a plate on the room's last column spans
    // exactly that one tile, and is not the outside case.
    const lastColumn = roomAt({ boundsCol: 3, cols: 2, signCol: 4 });
    expect(civicPlateWidth(lastColumn)).toBe(1);
  });
});
