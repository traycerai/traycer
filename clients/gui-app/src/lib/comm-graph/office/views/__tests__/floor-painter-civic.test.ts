import { describe, expect, it } from "vitest";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import {
  makeTestEpic,
  type OfficeTestEpic,
} from "@/lib/comm-graph/office/office-test-epic";
import {
  OFFICE_CIVIC_GROUND_ALPHA,
  OFFICE_TILE,
  type OfficeCivicRoom,
  type OfficeDrawable,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeSeat,
  type OfficeSize,
  type OfficeTileRect,
  type OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeDeskState, OfficePlanInput } from "../office-view";
import { planFloor } from "../floor/floor-plan";
import { floorPainter } from "../floor/floor-painter";

const VIEWPORT: OfficeSize = { width: 1280, height: 700 };

function populationFor(epic: OfficeTestEpic): OfficePopulation {
  return partitionOfficePopulation({
    agents: epic.agents,
    statusById: epic.statusById,
    previous: null,
  });
}

function planInputFor(epic: OfficeTestEpic): OfficePlanInput {
  return {
    agents: epic.agents,
    partition: populationFor(epic),
    occupancy: new Map(),
    needsCapacity: [],
    activityById: new Map(epic.agents.map((agent) => [agent.id, 0])),
    viewport: VIEWPORT,
    previous: null,
  };
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

function spriteNames(
  drawables: ReadonlyArray<OfficeWorldDrawable>,
): ReadonlyArray<string> {
  return drawables
    .filter((item) => item.drawable.kind === "sprite")
    .map((item) =>
      item.drawable.kind === "sprite" ? item.drawable.sprite.name : "",
    );
}

/**
 * A big enough triage epic that `planFloor` (`layoutOffice`) packs civic rooms
 * on the first floor: the infirmary's beds and the lounge's chairs. Plan-time
 * geometry does not depend on statuses - civic rooms are furniture the packer
 * lays out for any large enough population - so this is only about having
 * ENOUGH agents, not about which ones are `failure` or `awaiting`.
 */
const CIVIC_EPIC = makeTestEpic("triage", 309, 1);

function seatOfKind(kind: OfficeSeat["kind"]): OfficeSeat {
  const layout = planFloor(planInputFor(CIVIC_EPIC));
  const seat = [...layout.seats.values()].find(
    (candidate) => candidate.kind === kind,
  );
  if (seat === undefined) throw new Error(`expected a ${kind} seat`);
  return seat;
}

describe("floorPainter.seatProps: civic seats", () => {
  it("draws a bed's turned-down sheet only when the ward's per-seat state carries an owner", () => {
    const layout = planFloor(planInputFor(CIVIC_EPIC));
    const bed = seatOfKind("bed");

    const empty = idleDeskState(null);
    const emptySprites = spriteNames(
      floorPainter.seatProps(layout, bed, empty, 2),
    );
    expect(emptySprites).toEqual(["bed"]);

    // The claim under test: `bed-occupied` rides the per-seat state's
    // `agentId`, not the seat's own geometry - the same bed, same layout,
    // draws the extra sheet sprite the instant an owner shows up in state.
    const occupied = idleDeskState("agent-in-ward");
    const occupiedSprites = spriteNames(
      floorPainter.seatProps(layout, bed, occupied, 2),
    );
    expect(occupiedSprites).toEqual(["bed", "bed-occupied"]);
  });

  it("draws a lounge chair with no occupied variant, unlike a bed - a chair reads as taken from the agent sitting in it", () => {
    const layout = planFloor(planInputFor(CIVIC_EPIC));
    const lounge = seatOfKind("lounge");

    const empty = idleDeskState(null);
    const occupied = idleDeskState("agent-in-lounge");

    // There is deliberately no `lounge-chair-occupied` sprite in the
    // contract: a bed needs the sheet because at this scale the bed itself
    // gives no cue that anyone is in it, while a seated agent's own sprite is
    // the lounge chair's cue. Asserting only the base sprite would miss the
    // asymmetry this case exists to pin.
    expect(
      spriteNames(floorPainter.seatProps(layout, lounge, empty, 2)),
    ).toEqual(["lounge-chair"]);
    expect(
      spriteNames(floorPainter.seatProps(layout, lounge, occupied, 2)),
    ).toEqual(["lounge-chair"]);
  });

  it("keeps painting a crashed screen on a desk whose owner has walked off to the infirmary (the painter half of the vanishing-desk fix; F19, occupantToPaint)", () => {
    const layout = planFloor(planInputFor(CIVIC_EPIC));
    const desk = [...layout.seats.values()].find(
      (candidate) => candidate.kind === "desk",
    );
    if (desk === undefined) throw new Error("expected a desk seat");

    // `small`, not `medium`: the medium tier's crash offset happens to equal
    // its normal offset, which would let a broken offset swap through
    // unnoticed. `small`'s crash offset (3, -8) differs from its normal
    // screen offset (5, -5) in both axes, so the assertion below actually
    // exercises the swap.
    // The owner comes from the STATE, not the seat: an `OfficeSeat` is
    // geometry and carries no `agentId` at all. That is the whole point of the
    // fix this case guards - who is at a desk is a per-frame fact the desk
    // state carries, which is why `occupantToPaint` can keep answering for an
    // agent that has walked away.
    const state: OfficeDeskState = {
      ...idleDeskState("agent-at-crashed-desk"),
      status: "failure",
      modelTier: "small",
    };
    const drawables = floorPainter.seatProps(layout, desk, state, 2);
    expect(spriteNames(drawables)).toEqual(
      expect.arrayContaining(["desk", "monitor-crash"]),
    );

    const deskX = desk.deskTile.col * OFFICE_TILE;
    const deskY = desk.deskTile.row * OFFICE_TILE;
    const monitor = drawables.find(
      (item) =>
        item.drawable.kind === "sprite" &&
        item.drawable.sprite.name === "monitor-crash",
    );
    if (monitor?.drawable.kind !== "sprite") {
      throw new Error("expected a monitor-crash sprite");
    }
    // The crashed branch uses `crashXOffset`/`crashYOffset`, not the normal
    // screen offset - that swap is what keeps a crashed screen legible
    // instead of drifting to where a live screen sits.
    expect(monitor.drawable.x).toBe(deskX + 3);
    expect(monitor.drawable.y).toBe(deskY - 8);
  });
});

// ---- Fixtures for the civic ring's enclosure check ------------------- //

const RING_SPRITE_NAMES: ReadonlySet<string> = new Set([
  "wall",
  "wall-top",
  "door",
  "planter",
]);

function allWalkable(
  rows: number,
  cols: number,
): ReadonlyArray<ReadonlyArray<boolean>> {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => true),
  );
}

/**
 * A civic room away from the floor's own outer wall - `floorSpriteAt` draws
 * the building's OWN "wall" / "wall-top" / "door" on `bounds.row`, the two
 * rows just inside it, and `col` 0 and `cols - 1`. Keeping this room's rows
 * and columns clear of all of those is what lets a ring sprite found on ITS
 * perimeter be attributed to `pushRoomRing` alone.
 */
function civicRoom(overrides: {
  readonly civicRoomId: string;
  readonly kind: OfficeCivicRoom["kind"];
  readonly enclosure: OfficeCivicRoom["enclosure"];
  readonly bounds: OfficeTileRect;
}): OfficeCivicRoom {
  return {
    civicRoomId: overrides.civicRoomId,
    kind: overrides.kind,
    bounds: overrides.bounds,
    enclosure: overrides.enclosure,
    doorTile: { col: overrides.bounds.col, row: overrides.bounds.row },
    signTile: { col: overrides.bounds.col, row: overrides.bounds.row },
    name: overrides.kind,
    seatIds: [],
    floorIndex: 0,
    hostId: null,
    hostScope: "host",
    kerbTile: null,
  };
}

/** One storey holding only the given civic rooms, well clear of its own walls. */
function civicFloor(civic: ReadonlyArray<OfficeCivicRoom>): OfficeFloor {
  return {
    hostId: null,
    bounds: { col: 0, row: 0, cols: 24, rows: 24 },
    doorTile: { col: 0, row: 0 },
    lobbyTile: { col: 0, row: 1 },
    receptionTile: { col: 0, row: 2 },
    receptionQueueTiles: [],
    queueFacing: "down",
    corridorTiles: [],
    clockTile: { col: 23, row: 0 },
    stairsTile: null,
    errandSpots: [],
    cafeteria: null,
    gameRoom: null,
    areaSigns: [],
    amenities: [],
    civic,
    road: null,
  };
}

function layoutWithCivic(civic: ReadonlyArray<OfficeCivicRoom>): OfficeLayout {
  return {
    view: "floor",
    cols: 24,
    rows: 24,
    desks: new Map(),
    seats: new Map(),
    signs: [],
    rooms: [],
    floors: [civicFloor(civic)],
    doorTile: { col: 0, row: 0 },
    lobbyTile: { col: 0, row: 1 },
    props: [],
    walkable: allWalkable(24, 24),
    frozen: null,
    shiftFromPrevious: null,
    stable: true,
  };
}

/** Every tile on `bounds`'s own perimeter - the ring `pushRoomRing` walks. */
function perimeterTiles(
  bounds: OfficeTileRect,
): ReadonlyArray<{ readonly col: number; readonly row: number }> {
  const { col, row, cols, rows } = bounds;
  const right = col + cols - 1;
  const bottom = row + rows - 1;
  const tiles: { readonly col: number; readonly row: number }[] = [];
  for (let atCol = col; atCol <= right; atCol += 1) {
    tiles.push({ col: atCol, row });
    tiles.push({ col: atCol, row: row + 1 });
    tiles.push({ col: atCol, row: bottom });
  }
  for (let atRow = row + 2; atRow < bottom; atRow += 1) {
    tiles.push({ col, row: atRow });
    tiles.push({ col: right, row: atRow });
  }
  return tiles;
}

/** How many ring-only sprites (wall, wall-top, door, planter) sit on `bounds`'s perimeter. */
function ringSpritesOn(
  drawables: ReadonlyArray<OfficeDrawable>,
  bounds: OfficeTileRect,
): number {
  const tiles = new Set(
    perimeterTiles(bounds).map(
      (tile) => `${tile.col * OFFICE_TILE},${tile.row * OFFICE_TILE}`,
    ),
  );
  let count = 0;
  for (const drawable of drawables) {
    if (drawable.kind !== "sprite") continue;
    if (!RING_SPRITE_NAMES.has(drawable.sprite.name)) continue;
    if (!tiles.has(`${drawable.x},${drawable.y}`)) continue;
    count += 1;
  }
  return count;
}

describe("floorPainter.floor: civic ring follows enclosure, not size alone", () => {
  const OPEN_ROOM_BOUNDS: OfficeTileRect = {
    col: 8,
    row: 8,
    cols: 4,
    rows: 4,
  };
  const WALLED_ROOM_BOUNDS: OfficeTileRect = {
    col: 15,
    row: 8,
    cols: 4,
    rows: 4,
  };

  it("draws no ring sprites on an OPEN civic room's perimeter, even at 4x4", () => {
    const layout = layoutWithCivic([
      civicRoom({
        civicRoomId: "h/civic/help-desk",
        kind: "help-desk",
        enclosure: "open",
        bounds: OPEN_ROOM_BOUNDS,
      }),
    ]);
    const tiles: OfficeTileRect = { col: 0, row: 0, cols: 24, rows: 24 };
    const drawables = floorPainter.floor(layout, tiles, 2);
    expect(ringSpritesOn(drawables, OPEN_ROOM_BOUNDS)).toBe(0);
  });

  it("CONTROL: still draws a ring on a WALLED civic room of the same size", () => {
    const layout = layoutWithCivic([
      civicRoom({
        civicRoomId: "h/civic/infirmary",
        kind: "infirmary",
        enclosure: "walled",
        bounds: WALLED_ROOM_BOUNDS,
      }),
    ]);
    const tiles: OfficeTileRect = { col: 0, row: 0, cols: 24, rows: 24 };
    const drawables = floorPainter.floor(layout, tiles, 2);
    expect(ringSpritesOn(drawables, WALLED_ROOM_BOUNDS)).toBeGreaterThan(0);
  });
});

// ---- pushCivicGround: the tinted ground every civic room stands on --- //

/**
 * Two rooms, one OPEN and one WALLED, both clear of the fixture floor's own
 * outer wall and of each other - `pushCivicGround` tints every civic room
 * regardless of enclosure, which is the opposite of the ring above, so the
 * fixture below deliberately covers both kinds.
 */
const GROUND_OPEN_BOUNDS: OfficeTileRect = { col: 8, row: 8, cols: 4, rows: 4 };
const GROUND_WALLED_BOUNDS: OfficeTileRect = {
  col: 15,
  row: 8,
  cols: 5,
  rows: 3,
};

type CivicBlock = Extract<OfficeDrawable, { kind: "block" }>;

function civicBlocksIn(
  drawables: ReadonlyArray<OfficeDrawable>,
): ReadonlyArray<CivicBlock> {
  return drawables.filter(
    (drawable): drawable is CivicBlock =>
      drawable.kind === "block" && drawable.fill === "civic",
  );
}

const GROUND_LAYOUT = layoutWithCivic([
  civicRoom({
    civicRoomId: "h/civic/help-desk",
    kind: "help-desk",
    enclosure: "open",
    bounds: GROUND_OPEN_BOUNDS,
  }),
  civicRoom({
    civicRoomId: "h/civic/infirmary",
    kind: "infirmary",
    enclosure: "walled",
    bounds: GROUND_WALLED_BOUNDS,
  }),
]);
const GROUND_TILES: OfficeTileRect = { col: 0, row: 0, cols: 24, rows: 24 };

/**
 * How many ground sprites `pushGroundTiles` emits for this chunk - derived
 * from the painter's OWN clamp (the requested rect intersected with the
 * layout) rather than from the rect the caller asked for, which can hang off
 * the floor.
 */
function groundTileCount(layout: OfficeLayout, tiles: OfficeTileRect): number {
  const rows =
    Math.min(layout.rows - 1, tiles.row + tiles.rows - 1) -
    Math.max(0, tiles.row) +
    1;
  const cols =
    Math.min(layout.cols - 1, tiles.col + tiles.cols - 1) -
    Math.max(0, tiles.col) +
    1;
  return Math.max(0, rows) * Math.max(0, cols);
}

describe("floorPainter.floor: pushCivicGround tints every civic room (K2/K3 ground bake)", () => {
  it.each([1, 2] as const)(
    "gives both the open and the walled room exactly one tinted block at lod %i, at the room's own bounds * OFFICE_TILE",
    (lod) => {
      const drawables = floorPainter.floor(GROUND_LAYOUT, GROUND_TILES, lod);
      const blocks = civicBlocksIn(drawables);

      // Not vacuous: both rooms produced a block, open and walled alike.
      expect(blocks.length).toBe(2);
      for (const bounds of [GROUND_OPEN_BOUNDS, GROUND_WALLED_BOUNDS]) {
        const match = blocks.find(
          (block) =>
            block.x === bounds.col * OFFICE_TILE &&
            block.y === bounds.row * OFFICE_TILE &&
            block.width === bounds.cols * OFFICE_TILE &&
            block.height === bounds.rows * OFFICE_TILE,
        );
        expect(
          match,
          `no tinted block for ${JSON.stringify(bounds)}`,
        ).toBeDefined();
        expect(match?.alpha).toBe(OFFICE_CIVIC_GROUND_ALPHA);
        // Bakes with the sprites - see `pushCivicGround`'s own comment and
        // `officeBakesIntoStaticFloor` (office-static-layer.ts).
        expect(match?.ground).toBe(true);
      }
    },
  );

  it.each([1, 2] as const)(
    "splices the tint between the ground tiles and the fixtures at lod %i - not before both and not after both",
    (lod) => {
      const drawables = floorPainter.floor(GROUND_LAYOUT, GROUND_TILES, lod);
      const groundCount = groundTileCount(GROUND_LAYOUT, GROUND_TILES);

      const before = drawables.slice(0, groundCount);
      const seam = drawables.slice(groundCount, groundCount + 2);
      const after = drawables.slice(groundCount + 2);

      // Not vacuous: `floorChunk` really does run a ground pass and a fixture
      // pass here, so "between them" names a position that exists.
      expect(groundCount).toBeGreaterThan(0);
      expect(after.length).toBeGreaterThan(0);

      // The ground pass is opaque `floor-a`/`floor-b` sprites. A tint emitted
      // among THEM is painted over.
      expect(civicBlocksIn(before).length).toBe(0);
      // The fixture passes stand ON the floor. A tint emitted among them
      // recolours the furniture instead of the ground.
      expect(civicBlocksIn(after).length).toBe(0);
      expect(civicBlocksIn(seam).length).toBe(2);
    },
  );

  it("uses the lod-0 block map instead, whose civic blocks carry neither the tint's alpha nor its ground marker", () => {
    const blocks = civicBlocksIn(
      floorPainter.floor(GROUND_LAYOUT, GROUND_TILES, 0),
    );

    // Not vacuous: the block map really does draw a civic block for each room.
    expect(blocks.length).toBe(2);
    // The discriminator: `blockMap`'s own `push` sets neither `alpha` nor
    // `ground` for any fill, civic included - only `pushCivicGround`'s lod
    // >= 1 path does, which is what scopes the bake to the tint rather than
    // to the whole overview.
    for (const block of blocks) {
      expect(block.alpha).toBeUndefined();
      expect(block.ground).toBeUndefined();
    }
  });
});
