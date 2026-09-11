/**
 * What Campus and City both have to do, once.
 *
 * The two isometric plans differ in exactly one thing: what a BLOCK is. Campus
 * packs rooms sized by subtree; City packs grids of two-tile lots. Everything
 * around that - how blocks shelf into a near-square, how a district gets its
 * ring, its courtyard, its cafe, its door, its queue and its signs, which tiles
 * end up walkable, and how the whole thing is folded into an `OfficeLayout` -
 * is the same work, and a second copy of it would be a second set of bugs.
 *
 * Private to `views/isometric/`. Nothing outside imports from here.
 *
 * DISTRICTS RUN ALONG COLUMNS. Each host owns a column band with a frozen
 * width, and a district grows DOWNWARD inside its own band. That is what makes
 * City append-stable: a district that grows adds rows to the world, and rows
 * move the projected origin rather than any tile, so no seat ever moves and no
 * neighbouring district is ever displaced. It is also the diagonal the spec
 * asks for - in this projection a band to the right of another one is drawn
 * down and to the right of it.
 */
import type {
  OfficeAmenity,
  OfficeAreaSign,
  OfficeErrandSpot,
  OfficeFloor,
  OfficeLayout,
  OfficeProp,
  OfficeRoom,
  OfficeSign,
  OfficeTilePos,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";

/**
 * `H` for Campus: the tallest thing stacked on one of its tiles, measured up
 * from that tile's projected corner.
 *
 * A back wall is a 32 px slab whose foot follows the tile's upper edge, so it
 * reaches 24 px above the corner; a courtyard tree reaches exactly the same.
 * A desk stops at 16 and a seated character at 16, so 24 is the whole of it -
 * and the projected origin only has to clear the tallest.
 */
export const ISO_CAMPUS_STACK_HEIGHT = 24;

/** Walkable lane between two blocks, and between a block and the ring. */
export const ISO_BLOCK_GAP = 1;
/** The corridor ring a district keeps inside its own bounds. */
export const ISO_DISTRICT_RING = 1;
/**
 * Dead columns between two districts. Never walkable: "no walkable path
 * between two hosts' plazas" is an invariant, not a matter of distance.
 */
export const ISO_DISTRICT_GAP = 2;
/** Even a one-agent district has to hold a courtyard and a cafe side by side. */
export const ISO_MIN_DISTRICT_WIDTH = 16;

export const ISO_COURTYARD_COLS = 7;
export const ISO_COURTYARD_ROWS = 5;
export const ISO_CAFE_COLS = 7;
export const ISO_CAFE_ROWS = 6;

export const ISO_SIGN_WIDTH_TILES = 2;

/** Where the district's own signage hangs, measured from its top-left. */
const HOST_SIGN_COL_OFFSET = 1;
const CLOCK_COL_OFFSET = 3;

export interface IsoBlockSpec {
  readonly blockId: string;
  readonly cols: number;
  readonly rows: number;
}

export interface IsoPlacedBlock extends IsoBlockSpec {
  /** Absolute top-left tile. */
  readonly col: number;
  readonly row: number;
}

/**
 * The shelf cursor, carried so a later plan can append where the last one
 * stopped instead of re-packing. A frozen cursor is what turns "shelf-packed"
 * into "append-only": blocks already placed keep their tiles for ever.
 */
export interface IsoShelfCursor {
  readonly col: number;
  readonly row: number;
  /** Tallest block on the shelf row being filled. */
  readonly shelfRows: number;
}

export function isoShelfStart(
  originCol: number,
  originRow: number,
): IsoShelfCursor {
  return { col: originCol, row: originRow, shelfRows: 0 };
}

export interface IsoShelfResult {
  readonly placed: ReadonlyArray<IsoPlacedBlock>;
  readonly cursor: IsoShelfCursor;
}

/**
 * Blocks tile left to right until the band's width is spent, then wrap to a
 * new shelf row under the tallest block of the one just filled.
 *
 * A block wider than the whole band still gets a shelf of its own rather than
 * an empty one above it - the band is a budget, not a wall.
 */
export function isoShelfPack(
  blocks: ReadonlyArray<IsoBlockSpec>,
  widthBudget: number,
  originCol: number,
  start: IsoShelfCursor,
): IsoShelfResult {
  const placed: IsoPlacedBlock[] = [];
  let { col, row, shelfRows } = start;
  for (const block of blocks) {
    const spanned = col - originCol + block.cols;
    if (shelfRows > 0 && spanned > widthBudget) {
      col = originCol;
      row += shelfRows + ISO_BLOCK_GAP;
      shelfRows = 0;
    }
    placed.push({ ...block, col, row });
    shelfRows = Math.max(shelfRows, block.rows);
    col += block.cols + ISO_BLOCK_GAP;
  }
  return { placed, cursor: { col, row, shelfRows } };
}

/**
 * A band wide enough that the shelf comes out roughly square once the gaps are
 * paid for. Square is not vanity: the projection turns a long thin plan into a
 * long thin DIAGONAL, which is the one shape a rectangular canvas cannot hold.
 */
export function isoNearSquareWidth(
  blocks: ReadonlyArray<IsoBlockSpec>,
): number {
  let area = 0;
  let widest = 0;
  for (const block of blocks) {
    area += (block.cols + ISO_BLOCK_GAP) * (block.rows + ISO_BLOCK_GAP);
    widest = Math.max(widest, block.cols);
  }
  return Math.max(ISO_MIN_DISTRICT_WIDTH, widest, Math.ceil(Math.sqrt(area)));
}

// ---- The walkable grid ------------------------------------------------ //

export interface IsoGrid {
  readonly cols: number;
  readonly rows: number;
  readonly walkable: boolean[][];
}

export function isoBlankGrid(cols: number, rows: number): IsoGrid {
  const walkable: boolean[][] = [];
  for (let row = 0; row < rows; row += 1) {
    walkable.push(new Array<boolean>(cols).fill(false));
  }
  return { cols, rows, walkable };
}

export function isoWithinGrid(grid: IsoGrid, tile: OfficeTilePos): boolean {
  return (
    tile.col >= 0 &&
    tile.row >= 0 &&
    tile.col < grid.cols &&
    tile.row < grid.rows
  );
}

export function isoOpenRect(grid: IsoGrid, rect: OfficeTileRect): void {
  for (let row = rect.row; row < rect.row + rect.rows; row += 1) {
    for (let col = rect.col; col < rect.col + rect.cols; col += 1) {
      if (!isoWithinGrid(grid, { col, row })) continue;
      grid.walkable[row][col] = true;
    }
  }
}

export function isoBlock(grid: IsoGrid, tile: OfficeTilePos): void {
  if (!isoWithinGrid(grid, tile)) return;
  grid.walkable[tile.row][tile.col] = false;
}

export function isoTileKey(tile: OfficeTilePos): string {
  return `${tile.col},${tile.row}`;
}

export function isoWithinRect(
  rect: OfficeTileRect,
  tile: OfficeTilePos,
): boolean {
  return (
    tile.col >= rect.col &&
    tile.col < rect.col + rect.cols &&
    tile.row >= rect.row &&
    tile.row < rect.row + rect.rows
  );
}

// ---- Amenities -------------------------------------------------------- //

/**
 * One amenity block, whole: where it is, what stands in it, what that blocks,
 * and the errand spots in front of each fixture.
 *
 * A FIXTURE IS DRAWN FROM ITS SPOT, not from `layout.props`: the spot that owns
 * a fixture carries its tile as `actionTile` and the painter draws it there.
 * The second seat at a two-seat table carries `null` instead, so the table is
 * drawn once while both seats still share a `fixtureId` and still rally.
 */
export interface IsoAmenityBuild {
  readonly rect: OfficeTileRect;
  readonly amenity: OfficeAmenity;
  readonly areaSign: OfficeAreaSign;
  /** Props that are NOT an errand fixture; these do go in `layout.props`. */
  readonly props: ReadonlyArray<OfficeProp>;
  readonly blocked: ReadonlyArray<OfficeTilePos>;
  readonly spots: ReadonlyArray<OfficeErrandSpot>;
}

export interface IsoCourtyardBuild extends IsoAmenityBuild {
  readonly receptionTile: OfficeTilePos;
  readonly queueTiles: ReadonlyArray<OfficeTilePos>;
  readonly lobbyTile: OfficeTilePos;
}

interface AmenityArgs {
  readonly col: number;
  readonly row: number;
  readonly floorIndex: number;
  readonly name: string;
}

/**
 * A fixture id that names the FIXTURE and not its row.
 *
 * The Floor can get away with `<floor>/<kind>/<row>` because a storey there
 * holds at most one table of each kind. A district holds two cafe tables on one
 * row, so the column has to be in the id or the two tables would read as one
 * and somebody would rally with a stranger across the room.
 */
function fixtureIdOf(
  floorIndex: number,
  kind: OfficeErrandSpot["kind"],
  tile: OfficeTilePos,
): string {
  return `${floorIndex}/${kind}/${tile.col}/${tile.row}`;
}

export interface IsoSpotArgs {
  readonly kind: OfficeErrandSpot["kind"];
  readonly stand: OfficeTilePos;
  readonly fixture: OfficeTilePos;
  readonly floorIndex: number;
  /** `false` for the second seat of a shared fixture: it draws nothing. */
  readonly owns: boolean;
  readonly facing: OfficeErrandSpot["facing"];
}

export function isoSpotAt(args: IsoSpotArgs): OfficeErrandSpot {
  return {
    kind: args.kind,
    tile: args.stand,
    facing: args.facing,
    fixtureId: fixtureIdOf(args.floorIndex, args.kind, args.fixture),
    approachTile: args.stand,
    actionTile: args.owns ? args.fixture : null,
    floorIndex: args.floorIndex,
  };
}

/**
 * The district's front door: grass, two trees, the reception counter, the
 * queue in front of it, a bench and a plant somebody can water.
 *
 * Everything a district needs to be ENTERED is here, which is why it is placed
 * first in the shelf: the door hangs on the ring beside it.
 */
export function buildIsoCourtyard(args: AmenityArgs): IsoCourtyardBuild {
  const { col, row, floorIndex } = args;
  const rect: OfficeTileRect = {
    col,
    row,
    cols: ISO_COURTYARD_COLS,
    rows: ISO_COURTYARD_ROWS,
  };
  const receptionTile: OfficeTilePos = { col: col + 2, row };
  const benchTile: OfficeTilePos = { col: col + 1, row: row + 2 };
  const plantTile: OfficeTilePos = { col: col + 5, row: row + 2 };
  const props: OfficeProp[] = [
    { sprite: { name: "tree" }, tile: { col, row } },
    { sprite: { name: "reception" }, tile: receptionTile },
    { sprite: { name: "tree" }, tile: { col: col + 6, row } },
  ];
  const blocked: OfficeTilePos[] = [
    { col, row },
    receptionTile,
    { col: col + 3, row },
    { col: col + 6, row },
    benchTile,
    { col: col + 2, row: row + 2 },
    plantTile,
  ];
  const queueTiles: ReadonlyArray<OfficeTilePos> = [
    { col: col + 2, row: row + 1 },
    { col: col + 3, row: row + 1 },
    { col: col + 4, row: row + 1 },
  ];
  const spots: OfficeErrandSpot[] = [
    isoSpotAt({
      kind: "garden",
      stand: { col: col + 1, row: row + 3 },
      fixture: benchTile,
      floorIndex,
      owns: true,
      facing: "up",
    }),
    isoSpotAt({
      kind: "garden",
      stand: { col: col + 2, row: row + 3 },
      fixture: benchTile,
      floorIndex,
      owns: false,
      facing: "up",
    }),
    isoSpotAt({
      kind: "water-plant",
      stand: { col: col + 5, row: row + 3 },
      fixture: plantTile,
      floorIndex,
      owns: true,
      facing: "up",
    }),
    isoSpotAt({
      kind: "garden",
      stand: { col, row: row + 4 },
      fixture: { col, row: row + 4 },
      floorIndex,
      owns: false,
      facing: "down",
    }),
    isoSpotAt({
      kind: "garden",
      stand: { col: col + 6, row: row + 4 },
      fixture: { col: col + 6, row: row + 4 },
      floorIndex,
      owns: false,
      facing: "down",
    }),
  ];
  return {
    rect,
    amenity: {
      kind: "garden",
      bounds: rect,
      doorTile: { col: col + 4, row: row + 1 },
      signTile: { col: col + 4, row },
      name: args.name,
    },
    areaSign: { name: args.name, signTile: { col: col + 4, row } },
    props,
    blocked,
    spots,
    receptionTile,
    queueTiles,
    lobbyTile: { col, row: row + 1 },
  };
}

/** Coffee, water, a vending machine, two tables and a sofa. */
export function buildIsoCafe(args: AmenityArgs): IsoAmenityBuild {
  const { col, row, floorIndex } = args;
  const rect: OfficeTileRect = {
    col,
    row,
    cols: ISO_CAFE_COLS,
    rows: ISO_CAFE_ROWS,
  };
  const coffeeTile: OfficeTilePos = { col, row };
  const coolerTile: OfficeTilePos = { col: col + 3, row };
  const vendingTile: OfficeTilePos = { col: col + 6, row };
  const tableA: OfficeTilePos = { col, row: row + 2 };
  const tableB: OfficeTilePos = { col: col + 4, row: row + 2 };
  const sofaTile: OfficeTilePos = { col: col + 2, row: row + 4 };
  const blocked: OfficeTilePos[] = [
    coffeeTile,
    coolerTile,
    vendingTile,
    tableA,
    { col: col + 1, row: row + 2 },
    tableB,
    { col: col + 5, row: row + 2 },
    sofaTile,
    { col: col + 3, row: row + 4 },
  ];
  const spots: OfficeErrandSpot[] = [
    isoSpotAt({
      kind: "coffee",
      stand: { col, row: row + 1 },
      fixture: coffeeTile,
      floorIndex,
      owns: true,
      facing: "up",
    }),
    isoSpotAt({
      kind: "cooler",
      stand: { col: col + 3, row: row + 1 },
      fixture: coolerTile,
      floorIndex,
      owns: true,
      facing: "up",
    }),
    isoSpotAt({
      kind: "vending",
      stand: { col: col + 6, row: row + 1 },
      fixture: vendingTile,
      floorIndex,
      owns: true,
      facing: "up",
    }),
    isoSpotAt({
      kind: "cafe",
      stand: { col, row: row + 3 },
      fixture: tableA,
      floorIndex,
      owns: true,
      facing: "up",
    }),
    isoSpotAt({
      kind: "cafe",
      stand: { col: col + 1, row: row + 3 },
      fixture: tableA,
      floorIndex,
      owns: false,
      facing: "up",
    }),
    isoSpotAt({
      kind: "cafe",
      stand: { col: col + 4, row: row + 3 },
      fixture: tableB,
      floorIndex,
      owns: true,
      facing: "up",
    }),
    isoSpotAt({
      kind: "cafe",
      stand: { col: col + 5, row: row + 3 },
      fixture: tableB,
      floorIndex,
      owns: false,
      facing: "up",
    }),
    isoSpotAt({
      kind: "sofa",
      stand: { col: col + 2, row: row + 5 },
      fixture: sofaTile,
      floorIndex,
      owns: true,
      facing: "up",
    }),
    isoSpotAt({
      kind: "sofa",
      stand: { col: col + 3, row: row + 5 },
      fixture: sofaTile,
      floorIndex,
      owns: false,
      facing: "up",
    }),
  ];
  return {
    rect,
    amenity: {
      kind: "cafeteria",
      bounds: rect,
      doorTile: { col: col + 1, row: row + 1 },
      signTile: { col: col + 1, row },
      name: args.name,
    },
    areaSign: { name: args.name, signTile: { col: col + 1, row } },
    props: [],
    blocked,
    spots,
  };
}

// ---- Districts -------------------------------------------------------- //

/**
 * One host's district, after its blocks are placed but before the grid exists.
 * Both plans build one of these and hand it back for the common assembly.
 */
export interface IsoDistrictBuild {
  readonly hostId: string | null;
  readonly bounds: OfficeTileRect;
  readonly courtyard: IsoCourtyardBuild;
  readonly cafe: IsoAmenityBuild;
  readonly rooms: ReadonlyArray<OfficeRoom>;
  readonly props: ReadonlyArray<OfficeProp>;
  /** Tiles this district's own contents block, on top of the amenities'. */
  readonly blocked: ReadonlyArray<OfficeTilePos>;
  readonly spots: ReadonlyArray<OfficeErrandSpot>;
  readonly signs: ReadonlyArray<OfficeSign>;
}

export function isoDistrictDoorTile(build: IsoDistrictBuild): OfficeTilePos {
  return { col: build.bounds.col, row: build.courtyard.rect.row + 1 };
}

/**
 * Opens the district's floor, then closes everything standing on it.
 *
 * Order matters and is the whole method: the ring and every lane between blocks
 * are floor, and the things placed on that floor - walls, desks, chairs,
 * fixtures - take their tiles back afterwards.
 */
export function isoPaintDistrict(grid: IsoGrid, build: IsoDistrictBuild): void {
  isoOpenRect(grid, build.bounds);
  for (const tile of build.courtyard.blocked) isoBlock(grid, tile);
  for (const tile of build.cafe.blocked) isoBlock(grid, tile);
  for (const tile of build.blocked) isoBlock(grid, tile);
}

export interface IsoFloorArgs {
  readonly build: IsoDistrictBuild;
  readonly floorIndex: number;
  readonly grid: IsoGrid;
}

/**
 * The district as an `OfficeFloor`, corridors and all.
 *
 * A corridor tile is walkable floor that belongs to NOTHING: not a room, not an
 * amenity, not the door, the lobby, the queue, and not a tile an errand spot
 * already names. Standing about in one of those is not a stroll.
 */
export function isoFloorOf(args: IsoFloorArgs): OfficeFloor {
  const { build, grid } = args;
  const doorTile = isoDistrictDoorTile(build);
  const lobbyTile = build.courtyard.lobbyTile;
  const spots = [...build.courtyard.spots, ...build.cafe.spots, ...build.spots];
  const reserved = new Set<string>([
    isoTileKey(doorTile),
    isoTileKey(lobbyTile),
    ...build.courtyard.queueTiles.map(isoTileKey),
    ...spots.map((spot) => isoTileKey(spot.tile)),
    ...spots.map((spot) => isoTileKey(spot.approachTile)),
  ]);
  const amenities: ReadonlyArray<OfficeAmenity> = [
    build.courtyard.amenity,
    build.cafe.amenity,
  ];
  const corridorTiles: OfficeTilePos[] = [];
  const { bounds } = build;
  for (let row = bounds.row; row < bounds.row + bounds.rows; row += 1) {
    for (let col = bounds.col; col < bounds.col + bounds.cols; col += 1) {
      const tile: OfficeTilePos = { col, row };
      if (!grid.walkable[row][col]) continue;
      if (reserved.has(isoTileKey(tile))) continue;
      if (build.rooms.some((room) => isoWithinRect(room.bounds, tile)))
        continue;
      if (amenities.some((room) => isoWithinRect(room.bounds, tile))) continue;
      corridorTiles.push(tile);
    }
  }
  return {
    hostId: build.hostId,
    bounds,
    doorTile,
    lobbyTile,
    receptionTile: build.courtyard.receptionTile,
    receptionQueueTiles: build.courtyard.queueTiles,
    // The counter is on the row ABOVE the queue here, not below it as on the
    // Floor, so somebody waiting looks up at it rather than away from it.
    queueFacing: "up",
    corridorTiles,
    clockTile: { col: bounds.col + CLOCK_COL_OFFSET, row: bounds.row },
    stairsTile: null,
    errandSpots: spots,
    cafeteria: build.cafe.rect,
    gameRoom: null,
    areaSigns: [build.courtyard.areaSign, build.cafe.areaSign],
    amenities,
  };
}

/** The `host` plate at the foot of a district; the renderer resolves the name. */
export function isoHostSign(build: IsoDistrictBuild): OfficeSign {
  return {
    kind: "host",
    tile: {
      col: build.bounds.col + HOST_SIGN_COL_OFFSET,
      row: build.bounds.row + build.bounds.rows - 1,
    },
    widthTiles: ISO_SIGN_WIDTH_TILES,
    text: "",
    ownerAgentId: null,
    hostId: build.hostId,
    agentIds: [],
  };
}

/** A host key that no host id can collide with; `null` is its own group. */
export function isoHostKey(hostId: string | null): string {
  return hostId === null ? "unattributed" : `h:${hostId}`;
}

// ---- City's frozen packing -------------------------------------------- //

/**
 * City's `frozen`, declared HERE rather than in `city-plan.ts` because the
 * painter reads it too - `seatLift` is a rooftop, and a rooftop is a frozen
 * height. Putting the shape in the plan would have the painter importing the
 * plan that imports the painter.
 *
 * It is opaque to everything outside `views/isometric/`, exactly as the
 * contract says `frozen` is: wings, tiers and lot grids are facts about one
 * packer and nothing above it may read them.
 */
export interface CityFrozenBlock {
  readonly blockId: string;
  readonly hostKey: string;
  readonly kind: "park" | "cafe" | "hq" | "team" | "solos";
  /** The lead or HQ occupant this block is named for; `null` for solos. */
  readonly ownerAgentId: string | null;
  readonly rect: OfficeTileRect;
  /** Lots side by side before the grid wraps. */
  readonly perRow: number;
  readonly capacity: number;
}

export interface CityFrozenDistrict {
  readonly hostKey: string;
  readonly hostId: string | null;
  readonly col: number;
  readonly widthBudget: number;
  readonly cursor: IsoShelfCursor;
}

export interface CityFrozen {
  readonly kind: "city";
  readonly districts: ReadonlyArray<CityFrozenDistrict>;
  readonly blocks: ReadonlyArray<CityFrozenBlock>;
  /** Which seat each agent holds; a seat id names a block and a lot index. */
  readonly seatIdByAgentId: ReadonlyMap<string, string>;
  /** Storeys per seat, so the painter and `seatLift` agree on one number. */
  readonly storeysBySeatId: ReadonlyMap<string, number>;
  /** Storeys per agent, FROZEN at first sight: activity never moves a roof. */
  readonly storeysByAgentId: ReadonlyMap<string, number>;
  readonly spireSeatIds: ReadonlySet<string>;
  /** `H`: the tallest tower plus whatever stands on it. */
  readonly stackHeight: number;
}

/**
 * This layout's City packing, or `null` for anything else.
 *
 * A runtime check rather than an assertion: `frozen` is `unknown` by contract,
 * and the one thing a reader of it must never do is assume.
 */
function isCityFrozen(value: unknown): value is CityFrozen {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "city"
  );
}

export function readCityFrozen(layout: OfficeLayout | null): CityFrozen | null {
  if (layout === null) return null;
  return isCityFrozen(layout.frozen) ? layout.frozen : null;
}

/** The `<host>` segment of a seat id. */
export const ISO_SEAT_ID_NONE = "-";
