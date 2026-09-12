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
  type OfficeRect,
  type OfficeSeat,
  type OfficeSpriteName,
  type OfficeTilePos,
  type OfficeTileRect,
  type OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";
import {
  cityRoofLift,
  isoGroundAt,
  isoProjectorInputsOf,
  isoPropsIn,
  isoRoomsIn,
  isoSameProjectorInputs,
  isoSpotDraws,
  isoWithinRect,
  readCityFrozen,
  readIsoIndex,
  ISO_SPOT_FIXTURES,
  type CityFrozen,
  type IsoProjectorInputs,
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

function buildProjector(inputs: IsoProjectorInputs): OfficeProjector {
  // The storeys map and not the frozen that holds it: `seatLift` needs the
  // roof heights and nothing else in that packing, and a closure over the
  // whole of it would pin every district, block and lot for the life of the
  // projector - and close a reference cycle back into `frozen`, which holds
  // the index this projector is memoised on.
  const storeys = inputs.storeys;
  if (storeys === null) {
    return createIsoProjector({
      cols: inputs.cols,
      rows: inputs.rows,
      stackHeight: inputs.stackHeight,
      seatLift: () => 0,
    });
  }
  return createIsoProjector({
    cols: inputs.cols,
    rows: inputs.rows,
    stackHeight: inputs.stackHeight,
    // An envelope leaves a City agent from the ROOF it works under, not from
    // the pavement its door opens onto.
    seatLift: (seat: OfficeSeat) => cityRoofLift(storeys.get(seat.seatId) ?? 1),
  });
}

/**
 * This layout's projector, built once however many times it is asked for.
 *
 * The scene is handed one at install and keeps it, but the painter is called
 * with a LAYOUT rather than with that projector, so every floor chunk, every
 * seat and every spot used to build a fresh one: on a 400-agent Campus that
 * was 367 projectors on the cold frame and 47 more every time a second of
 * screen flicker invalidated the scene's per-seat cache. Each is cheap - two
 * object literals and a closure - and none of them was ever different from
 * the last.
 *
 * The memo lives on the layout's own index rather than in this module, for
 * the reason `IsoPlanIndex` states: a cache here would be painter state keyed
 * on a layout the painter does not own - wrong the moment two scenes hold two
 * layouts.
 *
 * What it is keyed on is `IsoProjectorInputs` - the projector's own argument,
 * so the key cannot be narrower than what was built from. It is NOT the index
 * it is stored on, because one index reaches further than itself in two
 * directions: a spread that grows `rows` is a second layout over the same
 * frozen, and a spread of the frozen is a second packing over the same index.
 * Both project differently and neither changes the index.
 *
 * And it is not the LAYOUT either, which would be a complete key and the
 * wrong one: `frozen` is what the next plan carries forward, so a layout
 * reference here would keep the previous world - every seat, floor and sign
 * of it - alive past its own replacement.
 *
 * A layout carrying no index still projects; it just builds each time,
 * exactly as every layout did before.
 */
function projectorFor(layout: OfficeLayout): OfficeProjector {
  const inputs = isoProjectorInputsOf(layout);
  const index = readIsoIndex(layout);
  if (index === null) return buildProjector(inputs);
  const memo = index.projectorMemo;
  if (memo !== null && isoSameProjectorInputs(memo.inputs, inputs)) {
    return memo.projector;
  }
  const projector = buildProjector(inputs);
  index.projectorMemo = { inputs, projector };
  return projector;
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

/**
 * A sprite drawable, narrowed.
 *
 * The floor above overview is made of sprites and nothing else, and it is
 * sorted by where each one hangs - so the array it is collected in says
 * sprite, rather than saying drawable and then reading a `y` that the lod-0
 * `quad` does not have.
 */
type IsoSpriteDrawable = Extract<OfficeDrawable, { kind: "sprite" }>;

function diamondAt(
  corner: OfficePoint,
  name: OfficeSpriteName,
): IsoSpriteDrawable {
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

/**
 * Grass under a courtyard or a park; paving everywhere else in a district.
 *
 * The checker runs off `col + row` rather than off anything the index holds,
 * because it is a fact about the TILE and not about the district it lands in:
 * two neighbouring districts still alternate across the street between them.
 */
function groundSpriteAt(
  layout: OfficeLayout,
  tile: OfficeTilePos,
): OfficeSpriteName | null {
  const ground = isoGroundAt(layout, tile);
  if (ground === null) return null;
  const even = (tile.col + tile.row) % 2 === 0;
  if (ground === "grass") {
    return even ? "floor-grass-iso-a" : "floor-grass-iso-b";
  }
  return even ? "floor-iso-a" : "floor-iso-b";
}

/**
 * A room's two back walls, as seen from the corner: the top-left edge of every
 * tile in its first column, the top-right edge of every tile in its first row.
 * City blocks have no walls - a building IS its own wall.
 */
function pushRoomWalls(scan: FloorScan, out: IsoSpriteDrawable[]): void {
  if (scan.layout.view !== "campus") return;
  const { tiles } = scan;
  const lastCol = tiles.col + tiles.cols;
  const lastRow = tiles.row + tiles.rows;
  for (const room of isoRoomsIn(scan.layout, tiles)) {
    const { bounds } = room;
    // Only the stretch of each edge the window actually holds. A room the
    // index returns overlaps the window SOMEWHERE, which says nothing about
    // its back walls: a bullpen at a thousand agents is ninety-odd tiles on a
    // side, and a one-tile query in the middle of it crosses neither edge.
    // Walking the perimeter to reject it tile by tile put the work back that
    // the index was added to remove.
    if (bounds.row >= tiles.row && bounds.row < lastRow) {
      const from = Math.max(bounds.col, tiles.col);
      const to = Math.min(bounds.col + bounds.cols, lastCol);
      for (let col = from; col < to; col += 1) {
        const corner = cornerOf(scan.projector, { col, row: bounds.row });
        out.push({
          kind: "sprite",
          sprite: { name: "wall-iso-right" },
          x: corner.x,
          y: corner.y - WALL_LIFT,
        });
      }
    }
    if (bounds.col >= tiles.col && bounds.col < lastCol) {
      const from = Math.max(bounds.row, tiles.row);
      const to = Math.min(bounds.row + bounds.rows, lastRow);
      for (let row = from; row < to; row += 1) {
        const corner = cornerOf(scan.projector, { col: bounds.col, row });
        out.push({
          kind: "sprite",
          sprite: { name: "wall-iso-left" },
          x: corner.x - ISO_HALF_WIDTH,
          y: corner.y - WALL_LIFT,
        });
      }
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
function pushClockFaces(scan: FloorScan, out: IsoSpriteDrawable[]): void {
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
function pushDoors(scan: FloorScan, out: IsoSpriteDrawable[]): void {
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
function pushProps(scan: FloorScan, out: IsoSpriteDrawable[]): void {
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
 * A tile rect as the shape it actually projects to: its four corners, filled.
 *
 * IT IS NOT A RECTANGLE, and standing one in for it was wrong in both
 * directions at once. The rect this used to emit had the projected region's
 * area - the bounding box shrunk by `1 / sqrt(2)` about the diamond's centre,
 * to stop the boxes of two rooms that do not touch overlapping by more than
 * half their width - but not its shape, so it painted over ground the region
 * does not cover and left ground it does cover bare. At overview a seat is a
 * pip and a pip is a projected tile, so the population formed the diamond
 * while the floor under it was an axis-aligned slab: on a thousand-agent
 * Campus the pips spilled out of their own storey at the left and right
 * corners, the amenities floated above it, and the two districts of a City
 * read as two overlapping rectangles rather than as the office a person had
 * just been looking at one zoom step in.
 *
 * The four corners are the whole fix. They cost the same as the centre this
 * used to project, the shape IS the union of the diamonds of the tiles it
 * stands for - so it covers exactly its own ground and regions that do not
 * touch cannot overlap at all - and it is what the office looks like at office
 * zoom, which is the reading the block map exists to preserve.
 *
 * Perimeter order, starting at the tile rect's own origin corner: in this
 * projection that is the top vertex, then the right, the bottom and the left.
 */
function quadOf(
  projector: OfficeProjector,
  bounds: OfficeTileRect,
  fill: OfficeBlockFill,
): OfficeDrawable {
  const endCol = bounds.col + bounds.cols;
  const endRow = bounds.row + bounds.rows;
  return {
    kind: "quad",
    points: [
      projector.project(bounds.col, bounds.row),
      projector.project(endCol, bounds.row),
      projector.project(endCol, endRow),
      projector.project(bounds.col, endRow),
    ],
    fill,
  };
}

/**
 * NONE, and the reason is the same one the three identity painters give: the
 * block IS the tiles.
 *
 * D58 exists because an axis-aligned block standing in for a diamond was
 * painted over pixels none of its own tiles projects to, so the scene's
 * inverse tile query - which assumes a block is drawn where its tiles are -
 * found no block for a corner that was plainly on screen, and the painter was
 * made to declare how far past its tiles it reached. A `quad` reaches nowhere
 * past them: its corners are the projections of the tile rect's corners, so
 * every pixel it fills unprojects to one of the tiles the query already asks
 * for. The declaration stays - it is the contract, and the next painter that
 * needs it has somewhere to say so - and this one answers zero.
 *
 * What went with the rect: `cornerOverhangOf`, the region walk it drove, and
 * the parallelogram derivation behind it (`(SQRT1_2 · span - min(cols, rows))`
 * converted through the projected edge normal), which had to grow from 634 px
 * to 2,037 px on one append-grown 18 × 410 district to stay conservative. None
 * of it has anything left to measure.
 */
function isoBlockOverhang(): number {
  return 0;
}

/**
 * The world at OVERVIEW zoom: one filled shape per district, amenity and block,
 * and no tiles at all. A few dozen drawables where the tile grid is tens of
 * thousands.
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
    blocks.push(quadOf(projector, bounds, fill));
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
  const ground: IsoSpriteDrawable[] = [];
  const standing: IsoSpriteDrawable[] = [];
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

/**
 * WHERE A SEAT IS PAINTED, for the plan to put in `hitBox` (D53).
 *
 * These two live here, next to the drawing they measure, because the box a
 * click has to land on is the box the painter puts on the screen and nothing
 * else. `hitTiles` describes a Floor seat - a rectangle of TILES around the
 * desk - and an isometric seat is not shaped like that: a campus desk is a
 * 32 x 32 sprite stack hanging off its tile's corner, and a City building is
 * a column that rises eight pixels per storey and is centred on its
 * occupant's anchor rather than on its lot. The scene derived the region from
 * `hitTiles` alone and missed every roof in the City by up to 56 px, which is
 * the seam T2 closed by letting a seat say where it is actually painted.
 *
 * Both take the tile CORNER the painter starts from, so a caller that has an
 * origin but no projector can answer with `isoProjectAt`.
 */

/**
 * The union over every state a campus desk is drawn in: the slab is the
 * widest part, the monitor the tallest, and the dust sheet, the box and the
 * envelope stack all sit inside those two.
 */
export function isoCampusSeatBox(corner: OfficePoint): OfficeRect {
  const top = corner.y + ISO_HALF_HEIGHT - MONITOR_LIFT - OFFICE_TILE / 2;
  return {
    x: corner.x - DESK_ISO_WIDTH / 2,
    y: top,
    width: DESK_ISO_WIDTH,
    height: corner.y + ISO_HALF_HEIGHT - top,
  };
}

/**
 * A City building: its column of slabs and the roof capping them.
 *
 * The MAST is deliberately out. It is 8 px wide on a 32 px box, so taking it
 * in would make a 32 x 16 band of empty sky above HQ's roof answer clicks in
 * order to catch a spike drawn up the middle of it - a worse answer than the
 * mast not being clickable. Every other part a seat draws is inside this box
 * in every state, the dust sheet that caps a vacated building included.
 */
export function isoCityBuildingBox(
  corner: OfficePoint,
  centreX: number,
  storeys: number,
): OfficeRect {
  const roofY = corner.y - storeys * ISO_STOREY_HEIGHT;
  const slab = officeSpriteSize({ name: "block-left" });
  return {
    x: centreX - ISO_HALF_WIDTH,
    y: roofY,
    width: ISO_HALF_WIDTH * 2,
    height: corner.y + slab.height - roofY,
  };
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
  // `archived` is one of the cold ones the predicate already answers for, so
  // naming it here again said nothing and quietly reopened the question of
  // who decides. An archived desk still reads dark, through the predicate.
  const lit =
    state.agentId !== null && !state.sheeted && isOfficeHotStatus(state.status);
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
  blockOverhangPx: isoBlockOverhang,
};
