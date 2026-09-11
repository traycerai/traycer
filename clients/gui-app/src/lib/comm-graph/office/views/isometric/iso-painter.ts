/**
 * How Campus and City are DRAWN. One painter, because the two views differ in
 * what stands on a tile and in nothing else about the drawing.
 *
 * `depth: "world"` is not a preference. In this projection a building genuinely
 * stands in front of whatever is behind it and behind whoever is in front of
 * it, and no amount of sorting characters among themselves can express that:
 * props and characters have to come out of one stream ordered by the same key.
 * That key is `isoDepth` - the projected foot, then `col + row`, then kind.
 *
 * ANCHORS, once, because every offset below is one of these:
 *
 * - a floor diamond covers the tile at `(x - 16, y)` and is 32 x 16;
 * - a back wall stands on a tile's upper edge at `(x - 16, y - 16)` (the
 *   top-left edge) or `(x, y - 16)` (the top-right one);
 * - a thing standing ON a tile puts its foot on the diamond's centre;
 * - a City storey is 8 px of slab, so storey `i` of a building hangs at
 *   `y - i * 8` and its roof at `y - storeys * 8`.
 */
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { isOfficeHotStatus } from "@/lib/comm-graph/office/office-status";
import {
  OFFICE_TILE,
  type OfficeAgentStatus,
  type OfficeBlockFill,
  type OfficeDrawable,
  type OfficeErrandSpot,
  type OfficeLayout,
  type OfficeLod,
  type OfficeModelTier,
  type OfficePoint,
  type OfficeSeat,
  type OfficeSpriteName,
  type OfficeTilePos,
  type OfficeTileRect,
  type OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";
import {
  cityRoofLift,
  isoPropsIn,
  isoRoomsIn,
  isoSpotDraws,
  isoWithinRect,
  readCityFrozen,
  ISO_CAMPUS_STACK_HEIGHT,
  ISO_SPOT_FIXTURES,
  type CityFrozen,
} from "@/lib/comm-graph/office/views/isometric/iso-plan-core";
import {
  createIsoProjector,
  isoDepth,
  isoPropOrigin,
  ISO_HALF_HEIGHT,
  ISO_HALF_WIDTH,
  ISO_SPIRE_LIFT,
  ISO_STOREY_HEIGHT,
} from "@/lib/comm-graph/office/views/isometric/iso-projector";
import type {
  OfficeDeskState,
  OfficePainter,
  OfficeProjector,
} from "@/lib/comm-graph/office/views/office-view";

const DESK_ISO_WIDTH = 32;
const DESK_ISO_HEIGHT = 24;
const MONITOR_LIFT = 24;
const WALL_LIFT = 24;
const DOOR_ISO_WIDTH = 16;
const DOOR_ISO_HEIGHT = 32;
const WINDOW_SIZE = 8;
const SPIRE_WIDTH = 8;

/**
 * Everything one seat stands up shares ONE depth - the foot of its own tile.
 *
 * There is no nudge, because `depth` is now measured in foot pixels: a nudge
 * big enough to order a seven-storey stack would be big enough to lift that
 * stack past a character standing a pixel nearer, which is the defect the one
 * depth unit exists to close. Within a tile there is nothing to decide by
 * depth anyway - the parts are emitted back to front, and both the painter's
 * sort and the scene's merge are stable, so emission order is the order.
 */

function projectorFor(layout: OfficeLayout): OfficeProjector {
  const frozen = readCityFrozen(layout);
  if (frozen === null) {
    return createIsoProjector({
      cols: layout.cols,
      rows: layout.rows,
      stackHeight: ISO_CAMPUS_STACK_HEIGHT,
      seatLift: () => 0,
    });
  }
  return createIsoProjector({
    cols: layout.cols,
    rows: layout.rows,
    stackHeight: frozen.stackHeight,
    // An envelope leaves a City agent from the ROOF it works under, not from
    // the pavement its door opens onto.
    seatLift: (seat: OfficeSeat) =>
      cityRoofLift(frozen.storeysBySeatId.get(seat.seatId) ?? 1),
  });
}

/**
 * Campus and City reuse the flat office's reception, trees and fixtures rather
 * than an isometric set - the decision that ships these two views now - so
 * every sprite size below comes from `officeSpriteSize`, the one table that
 * knows them. A second copy of those numbers here was a second place for the
 * painter and the plan's index to disagree about where a foot lands.
 */

/** Where a tile's own corner lands, which every anchor below is relative to. */
function cornerOf(
  projector: OfficeProjector,
  tile: OfficeTilePos,
): OfficePoint {
  return projector.project(tile.col, tile.row);
}

/**
 * A seat's own anchor point: D20's foot for the character that sits in it.
 *
 * The scene puts the character, its name tag and its envelope endpoint here,
 * so anything the painter draws AS that seat has to agree with it.
 */
function seatAnchorOf(
  projector: OfficeProjector,
  seat: OfficeSeat,
): OfficePoint {
  return projector.project(seat.chairTile.col + 0.5, seat.chairTile.row + 1);
}

/** Depth of anything standing on a tile: the foot is the diamond's centre. */
function tileDepth(
  projector: OfficeProjector,
  tile: OfficeTilePos,
  kind: "floor" | "prop" | "character",
): number {
  const foot = projector.project(tile.col + 0.5, tile.row + 0.5);
  return isoDepth(foot.y, tile.col + tile.row, kind);
}

function diamondAt(
  corner: OfficePoint,
  name: OfficeSpriteName,
): OfficeDrawable {
  return {
    kind: "sprite",
    sprite: { name },
    x: corner.x - ISO_HALF_WIDTH,
    y: corner.y,
  };
}

// ---- Floor ------------------------------------------------------------ //

interface FloorScan {
  readonly layout: OfficeLayout;
  readonly projector: OfficeProjector;
  readonly tiles: OfficeTileRect;
}

/** Grass under a courtyard or a park; paving everywhere else in a district. */
function groundSpriteAt(
  layout: OfficeLayout,
  tile: OfficeTilePos,
): OfficeSpriteName | null {
  let inDistrict = false;
  for (const floor of layout.floors) {
    if (!isoWithinRect(floor.bounds, tile)) continue;
    inDistrict = true;
    for (const amenity of floor.amenities) {
      if (amenity.kind !== "garden") continue;
      if (!isoWithinRect(amenity.bounds, tile)) continue;
      return (tile.col + tile.row) % 2 === 0
        ? "floor-grass-iso-a"
        : "floor-grass-iso-b";
    }
  }
  if (!inDistrict) return null;
  return (tile.col + tile.row) % 2 === 0 ? "floor-iso-a" : "floor-iso-b";
}

/**
 * A room's two back walls, as seen from the corner: the top-left edge of every
 * tile in its first column, the top-right edge of every tile in its first row.
 * City blocks have no walls - a building IS its own wall.
 */
function pushRoomWalls(scan: FloorScan, out: OfficeDrawable[]): void {
  if (scan.layout.view !== "campus") return;
  const { tiles } = scan;
  for (const room of isoRoomsIn(scan.layout, tiles)) {
    const { bounds } = room;
    for (let col = bounds.col; col < bounds.col + bounds.cols; col += 1) {
      const tile: OfficeTilePos = { col, row: bounds.row };
      if (!isoWithinRect(tiles, tile)) continue;
      const corner = cornerOf(scan.projector, tile);
      out.push({
        kind: "sprite",
        sprite: { name: "wall-iso-right" },
        x: corner.x,
        y: corner.y - WALL_LIFT,
      });
    }
    for (let row = bounds.row; row < bounds.row + bounds.rows; row += 1) {
      const tile: OfficeTilePos = { col: bounds.col, row };
      if (!isoWithinRect(tiles, tile)) continue;
      const corner = cornerOf(scan.projector, tile);
      out.push({
        kind: "sprite",
        sprite: { name: "wall-iso-left" },
        x: corner.x - ISO_HALF_WIDTH,
        y: corner.y - WALL_LIFT,
      });
    }
  }
}

/**
 * The face the shared clock hands pivot on, one per district.
 *
 * The scene draws the HANDS as an overlay, centred on
 * `project(clockTile) + (width / 2, OFFICE_TILE - height + height / 2)`, and
 * owns nothing else about the clock. A painter that left the face out - as
 * this one did - left the hands turning in mid-air. The anchor below is that
 * same expression minus the centring, so the two cannot drift apart.
 */
function pushClockFaces(scan: FloorScan, out: OfficeDrawable[]): void {
  const size = officeSpriteSize({ name: "clock" });
  for (const floor of scan.layout.floors) {
    if (!isoWithinRect(scan.tiles, floor.clockTile)) continue;
    const face = cornerOf(scan.projector, floor.clockTile);
    out.push({
      kind: "sprite",
      sprite: { name: "clock" },
      x: face.x,
      y: face.y + OFFICE_TILE - size.height,
    });
  }
}

/** The gate every district is entered through, one per floor. */
function pushDoors(scan: FloorScan, out: OfficeDrawable[]): void {
  for (const floor of scan.layout.floors) {
    if (!isoWithinRect(scan.tiles, floor.doorTile)) continue;
    const corner = cornerOf(scan.projector, floor.doorTile);
    out.push({
      kind: "sprite",
      sprite: { name: "door-iso" },
      x: corner.x - DOOR_ISO_WIDTH / 2,
      y: corner.y + ISO_HALF_HEIGHT - DOOR_ISO_HEIGHT,
    });
  }
}

/**
 * Everything the plan stood on the ground that is NOT an errand fixture.
 *
 * A fixture is in `layout.props` too - that is how the plan says what its
 * `actionTile` means - but it is drawn by `spotProps`, in the world stream,
 * where it can be given a depth. Drawing it here as well would paint every
 * coffee machine twice, once behind the person queueing at it. The index
 * leaves the fixtures out for exactly that reason, so there is nothing to
 * filter here and, more to the point, nothing to SCAN: a pan reads the tiles
 * it is asked about and not the thousand props it is not.
 */
function pushProps(scan: FloorScan, out: OfficeDrawable[]): void {
  for (const prop of isoPropsIn(scan.layout, scan.tiles)) {
    const corner = cornerOf(scan.projector, prop.tile);
    const size = officeSpriteSize(prop.sprite);
    const origin = isoPropOrigin(corner, size.width, size.height);
    out.push({ kind: "sprite", sprite: prop.sprite, x: origin.x, y: origin.y });
  }
}

/** Whether two tile rects share a tile, which is the whole cull at lod 0. */
function tileRectsOverlap(
  left: OfficeTileRect,
  right: OfficeTileRect,
): boolean {
  return (
    left.col < right.col + right.cols &&
    right.col < left.col + left.cols &&
    left.row < right.row + right.rows &&
    right.row < left.row + left.rows
  );
}

/**
 * A tile rect as ONE axis-aligned rectangle, which is what a `block` is.
 *
 * A tile rect projects to a DIAMOND here, so a rect can only approximate it and
 * the only question is which rect. Not the bounding box: a diamond fills exactly
 * half of its own box, so boxes of two rooms that do not touch overlap by more
 * than half their width and the whole map reads as one slab. Instead the box is
 * shrunk about the diamond's own centre until its AREA is the diamond's, which
 * is `1 / sqrt(2)` on each side. It covers the right amount of ground in the
 * right place, and regions that do not touch mostly do not either.
 */
const DIAMOND_TO_RECT = Math.SQRT1_2;

function blockOf(
  projector: OfficeProjector,
  bounds: OfficeTileRect,
  fill: OfficeBlockFill,
): OfficeDrawable {
  const centre = projector.project(
    bounds.col + bounds.cols / 2,
    bounds.row + bounds.rows / 2,
  );
  const span = bounds.cols + bounds.rows;
  const width = span * ISO_HALF_WIDTH * DIAMOND_TO_RECT;
  const height = span * ISO_HALF_HEIGHT * DIAMOND_TO_RECT;
  return {
    kind: "block",
    x: centre.x - width / 2,
    y: centre.y - height / 2,
    width,
    height,
    fill,
  };
}

/**
 * The world at OVERVIEW zoom: one rect per district, amenity and block, and no
 * tiles at all. A few dozen drawables where the tile grid is tens of thousands.
 *
 * A Campus room is a cabin and a City block is a stand of buildings, which is
 * the one thing the two views disagree about here; `layout.rooms` carries both.
 */
function blockMap(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): ReadonlyArray<OfficeDrawable> {
  const projector = projectorFor(layout);
  const blocks: OfficeDrawable[] = [];
  const push = (bounds: OfficeTileRect, fill: OfficeBlockFill): void => {
    if (!tileRectsOverlap(bounds, tiles)) return;
    blocks.push(blockOf(projector, bounds, fill));
  };
  for (const floor of layout.floors) push(floor.bounds, "storey");
  for (const floor of layout.floors) {
    for (const amenity of floor.amenities) {
      push(amenity.bounds, amenity.kind === "garden" ? "grass" : "plaza");
    }
  }
  const roomFill: OfficeBlockFill =
    layout.view === "city" ? "building" : "room";
  for (const room of isoRoomsIn(layout, tiles)) push(room.bounds, roomFill);
  return blocks;
}

function paintFloor(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
  lod: OfficeLod,
): ReadonlyArray<OfficeDrawable> {
  if (lod === 0) return blockMap(layout, tiles);
  const projector = projectorFor(layout);
  const scan: FloorScan = { layout, projector, tiles };
  const ground: OfficeDrawable[] = [];
  const standing: OfficeDrawable[] = [];
  const lastCol = Math.min(tiles.col + tiles.cols, layout.cols);
  const lastRow = Math.min(tiles.row + tiles.rows, layout.rows);
  for (let row = Math.max(0, tiles.row); row < lastRow; row += 1) {
    for (let col = Math.max(0, tiles.col); col < lastCol; col += 1) {
      const tile: OfficeTilePos = { col, row };
      const name = groundSpriteAt(layout, tile);
      if (name === null) continue;
      ground.push(diamondAt(cornerOf(projector, tile), name));
    }
  }
  pushRoomWalls(scan, standing);
  pushDoors(scan, standing);
  pushProps(scan, standing);
  // A dial is detail: at office zoom the hands alone read as a clock, and the
  // face would only crowd a district already carrying its signage.
  if (lod === 2) pushClockFaces(scan, standing);
  // Ground first, then whatever stands on it back to front: inside one chunk
  // the floor never occludes anything, and the standing pieces occlude each
  // other exactly as the world stream orders them.
  standing.sort((left, right) => left.y - right.y);
  return [...ground, ...standing];
}

// ---- Seats ------------------------------------------------------------ //

function monitorSpriteOf(
  tier: OfficeModelTier,
  status: OfficeAgentStatus,
  frame: 0 | 1,
): OfficeSpriteName {
  if (status === "failure") return "monitor-crash";
  const lit = status === "working" || status === "background";
  if (tier === "small") return lit ? "monitor-small-on" : "monitor-small-off";
  if (tier === "large") {
    if (!lit) return "monitor-wide-off";
    return frame === 0 ? "monitor-wide-on" : "monitor-wide-on-b";
  }
  if (!lit) return "monitor-off";
  return frame === 0 ? "monitor-on" : "monitor-on-b";
}

function envelopeStackOf(openRequests: number): OfficeSpriteName | null {
  if (openRequests <= 0) return null;
  if (openRequests === 1) return "envelope-stack-1";
  if (openRequests === 2) return "envelope-stack-2";
  return "envelope-stack-3";
}

/** A campus desk: the slab, the screen on its back edge, the pile on it. */
function campusSeatProps(
  projector: OfficeProjector,
  seat: OfficeSeat,
  state: OfficeDeskState,
): ReadonlyArray<OfficeWorldDrawable> {
  const corner = cornerOf(projector, seat.deskTile);
  const depth = tileDepth(projector, seat.deskTile, "prop");
  const out: OfficeWorldDrawable[] = [
    {
      drawable: {
        kind: "sprite",
        sprite: { name: state.sheeted ? "dust-sheet" : "desk-iso" },
        x: corner.x - DESK_ISO_WIDTH / 2,
        y: corner.y + ISO_HALF_HEIGHT - DESK_ISO_HEIGHT,
      },
      depth,
      ownerAgentId: state.agentId,
    },
  ];
  if (state.sheeted) {
    out.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "box" },
        x: corner.x,
        y: corner.y + ISO_HALF_HEIGHT - OFFICE_TILE,
      },
      depth,
      ownerAgentId: state.agentId,
    });
    return out;
  }
  if (state.agentId === null) return out;
  out.push({
    drawable: {
      kind: "sprite",
      sprite: {
        name: monitorSpriteOf(state.modelTier, state.status, state.screenFrame),
      },
      x: corner.x - OFFICE_TILE / 2,
      y: corner.y + ISO_HALF_HEIGHT - MONITOR_LIFT - OFFICE_TILE / 2,
    },
    depth,
    ownerAgentId: state.agentId,
  });
  const stack = envelopeStackOf(state.openRequests);
  if (stack !== null) {
    out.push({
      drawable: {
        kind: "sprite",
        sprite: { name: stack },
        x: corner.x + 2,
        y: corner.y + ISO_HALF_HEIGHT - DESK_ISO_HEIGHT / 2,
      },
      depth,
      ownerAgentId: state.agentId,
    });
  }
  return out;
}

/**
 * A city building: a column of slabs, its windows lit by what the agent is
 * doing, a roof, and a spire on the one building that is HQ.
 *
 * The doorway is left EMPTY on purpose. The character standing in it is drawn
 * by the scene at the seat's own tile, and the two meet because the seat's
 * chair tile is the door tile.
 */
interface CitySeatArgs {
  readonly projector: OfficeProjector;
  readonly frozen: CityFrozen;
  readonly seat: OfficeSeat;
  readonly state: OfficeDeskState;
}

function citySeatProps(args: CitySeatArgs): ReadonlyArray<OfficeWorldDrawable> {
  const { projector, frozen, seat, state } = args;
  const corner = cornerOf(projector, seat.deskTile);
  // The building stands on its lot but is CENTRED on its occupant's own
  // anchor column - the chair tile's foot, which is the point the scene puts
  // a character, a name tag and an envelope endpoint on. Centring it on the
  // lot instead left every rooftop launch 24 px out to one side of the roof
  // it was supposed to leave from.
  const centreX = seatAnchorOf(projector, seat).x;
  const depth = tileDepth(projector, seat.deskTile, "prop");
  const storeys = frozen.storeysBySeatId.get(seat.seatId) ?? 1;
  const out: OfficeWorldDrawable[] = [];
  const lit =
    state.agentId !== null &&
    !state.sheeted &&
    state.status !== "archived" &&
    isOfficeHotStatus(state.status);
  const windowName: OfficeSpriteName = lit ? "window-lit" : "window-dark";
  for (let storey = 0; storey < storeys; storey += 1) {
    const y = corner.y - storey * ISO_STOREY_HEIGHT;
    out.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "block-left" },
        x: centreX - ISO_HALF_WIDTH,
        y,
      },
      depth,
      ownerAgentId: state.agentId,
    });
    out.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "block-right" },
        x: centreX,
        y,
      },
      depth,
      ownerAgentId: state.agentId,
    });
    out.push({
      drawable: {
        kind: "sprite",
        sprite: { name: windowName },
        x: centreX - ISO_HALF_WIDTH + WINDOW_SIZE / 2,
        y: y + WINDOW_SIZE / 2,
      },
      depth,
      ownerAgentId: state.agentId,
    });
    out.push({
      drawable: {
        kind: "sprite",
        sprite: { name: windowName },
        x: centreX + WINDOW_SIZE / 2,
        y: y + WINDOW_SIZE / 2,
      },
      depth,
      ownerAgentId: state.agentId,
    });
  }
  // A vacated building is not demolished - it is SHUT. The sheet caps it in
  // place of its roof (both sprites are the 32 x 16 roof diamond), the windows
  // above are already dark, and the mast comes down with the occupant.
  const roofY = corner.y - storeys * ISO_STOREY_HEIGHT;
  out.push({
    drawable: {
      kind: "sprite",
      sprite: { name: state.sheeted ? "dust-sheet" : "block-top" },
      x: centreX - ISO_HALF_WIDTH,
      y: roofY,
    },
    depth,
    ownerAgentId: state.agentId,
  });
  if (!state.sheeted && frozen.spireSeatIds.has(seat.seatId)) {
    out.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "spire" },
        x: centreX - SPIRE_WIDTH / 2,
        y: roofY - ISO_SPIRE_LIFT,
      },
      depth,
      ownerAgentId: state.agentId,
    });
  }
  return out;
}

function paintSeat(
  layout: OfficeLayout,
  seat: OfficeSeat,
  state: OfficeDeskState,
  lod: OfficeLod,
): ReadonlyArray<OfficeWorldDrawable> {
  // D27: at overview a seat is a pip the scene draws, and the block map is the
  // whole of the floor. Answered before projecting, so nothing is computed for
  // a seat that has nothing to say.
  if (lod === 0) return [];
  const projector = projectorFor(layout);
  const frozen = readCityFrozen(layout);
  if (frozen !== null) {
    return citySeatProps({ projector, frozen, seat, state });
  }
  return campusSeatProps(projector, seat, state);
}

// ---- Errand spots ----------------------------------------------------- //

/**
 * The fixture a spot stands at, drawn ONCE however many seats it has.
 *
 * EVERY seat at a bench names that bench as its `actionTile` - that is the
 * anchor a sitting pose is aimed at, and a second seat that named nothing
 * would leave its arrival standing in front of a bench it cannot reach. So
 * the plan's index, not the anchor, decides which of them paints it: one
 * bench, two people on it, no second copy half a pixel away.
 */
function paintSpot(
  layout: OfficeLayout,
  spot: OfficeErrandSpot,
  lod: OfficeLod,
): ReadonlyArray<OfficeWorldDrawable> {
  if (lod === 0) return [];
  const tile = spot.actionTile;
  if (tile === null) return [];
  if (!isoSpotDraws(layout, spot)) return [];
  const name = ISO_SPOT_FIXTURES[spot.kind];
  if (name === undefined) return [];
  const size = officeSpriteSize({ name });
  const projector = projectorFor(layout);
  const origin = isoPropOrigin(
    cornerOf(projector, tile),
    size.width,
    size.height,
  );
  return [
    {
      drawable: { kind: "sprite", sprite: { name }, x: origin.x, y: origin.y },
      depth: tileDepth(projector, tile, "prop"),
      ownerAgentId: null,
    },
  ];
}

export const ISO_PAINTER: OfficePainter = {
  depth: "world",
  projector: projectorFor,
  floor: paintFloor,
  seatProps: paintSeat,
  spotProps: paintSpot,
};
