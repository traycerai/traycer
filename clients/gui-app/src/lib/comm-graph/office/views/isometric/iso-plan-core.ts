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
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import {
  ISO_HALF_HEIGHT,
  ISO_HALF_WIDTH,
  ISO_STOREY_HEIGHT,
} from "@/lib/comm-graph/office/views/isometric/iso-projector";
import type {
  OfficeAmenity,
  OfficeAreaSign,
  OfficeCivicKind,
  OfficeCivicRoom,
  OfficeErrandSpot,
  OfficeFloor,
  OfficeLayout,
  OfficeProp,
  OfficeRect,
  OfficeRoad,
  OfficeRoom,
  OfficeSeat,
  OfficeSign,
  OfficeSpotAudience,
  OfficeSpriteName,
  OfficeTilePos,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

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

/**
 * SITTING PLACES ON THE BENCH ROW, and the courtyard is as wide as it needs to
 * be for them.
 *
 * Two is one bench, which is the park both isometric views have always had: two
 * tiles, two garden spots, one fixture id so the pair rally with each other.
 *
 * THE TWO CALLERS ASK FOR DIFFERENT NUMBERS, on purpose. **City** passes
 * `ISO_COURTYARD_BENCHES` and its park is unchanged - its waiting room is the
 * bus shelter at the kerb, because a city is where a vehicle pulls up and a
 * citizen waits at the street, not inside a district. **Campus** passes
 * `civicCapacityFor(...).chairs`, because its waiting room IS this bench row:
 * the courtyard is the campus's public room, and the contract's chair count is
 * exact, so the row grows until it holds them. A campus bench is therefore two
 * things at one tile - a stroll's fixture and a seat the waiting room lends -
 * which is what `OfficeErrandSpot.seatId` exists to keep straight.
 */
export const ISO_COURTYARD_BENCHES = 2;

/**
 * Everything in the courtyard that is not bench: the lobby column, the
 * reception and its queue, the watered plant past the benches, and the tree at
 * each end.
 */
const COURTYARD_SIDE_COLS = 5;

/** The courtyard's width for a bench row of this many sitting places. */
export function isoCourtyardCols(benches: number): number {
  return Math.max(benches, ISO_COURTYARD_BENCHES) + COURTYARD_SIDE_COLS;
}

export const ISO_COURTYARD_COLS = isoCourtyardCols(ISO_COURTYARD_BENCHES);
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
 * A FIXTURE IS DRAWN FROM ITS SPOT: every spot that acts on something carries
 * that tile as `actionTile` and the painter draws it there, with a depth,
 * rather than flat in the floor pass.
 *
 * A bench, a table and a sofa are all wider than the diamond they stand on,
 * so each is TWO tiles with a seat under each - and each seat acts on the
 * half it is standing at, which is what lets the second of them sit down
 * instead of waiting in front of an anchor it does not have. The two still
 * name one `fixtureId`, which is what makes them rally rather than sit at the
 * same table ignoring each other. Every one of those tiles is RECORDED in
 * `layout.props`: `actionTile` promises that a named sprite stands there, and
 * the painter is not the only reader of that promise.
 */
export interface IsoAmenityBuild {
  readonly rect: OfficeTileRect;
  readonly amenity: OfficeAmenity;
  readonly areaSign: OfficeAreaSign;
  /** Scenery and fixtures alike; the painter decides which pass draws which. */
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
 * The courtyard takes its bench count from the caller; see
 * `ISO_COURTYARD_BENCHES` for why the two views ask for different ones. Named
 * rather than defaulted, so neither caller can forget to have an opinion.
 */
interface CourtyardArgs extends AmenityArgs {
  readonly benches: number;
  /**
   * The seat id for the bench tile at index `i`, or `null` from a caller whose
   * benches are furniture and nothing else. Campus's waiting room answers with
   * the lounge seat it laid on that tile; City's park answers `null`.
   */
  readonly seatIdAt: (index: number) => string | null;
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

/**
 * The audience of everything a DISTRICT stands up: its courtyard, its cafe,
 * its park.
 *
 * A district is one host's whole world here - there is no second storey to be
 * excluded from and no cabin any of it stands inside - so an amenity spot is
 * open to everyone seated in it, and the floor index the scene checks first is
 * what keeps one host's coffee out of another's reach.
 */
export const ISO_FLOOR_AUDIENCE: OfficeSpotAudience = { kind: "floor" };

export interface IsoSpotArgs {
  readonly kind: OfficeErrandSpot["kind"];
  readonly stand: OfficeTilePos;
  /**
   * The FIXTURE this spot belongs to: the bench, the table, the sofa. Two
   * seats at one of those name the same tile here however far apart they sit,
   * because that shared name is what makes them rally instead of ignoring
   * each other across the same table. `null` for a spot that belongs to no
   * fixture - a stroll across the lawn - which then rallies with nobody.
   */
  readonly fixture: OfficeTilePos | null;
  /**
   * What this spot ACTS on: its OWN end of that fixture, directly above it.
   *
   * A bench is wider than the diamond it is anchored on, so a two-seat bench
   * is two tiles with a seat under each, and each seat sits on the half it is
   * standing at. `null` only where the spot acts on nothing at all - and only
   * there, because the scene reads a null anchor as "nothing to sit on": a
   * second seat that carried `null` to avoid painting a second sprite would
   * be paying for one bench with one arrival left standing.
   */
  readonly action: OfficeTilePos | null;
  readonly floorIndex: number;
  readonly facing: OfficeErrandSpot["facing"];
  readonly audience: OfficeSpotAudience;
  /**
   * The seat this spot's fixture IS, where the fixture is one the seat book can
   * seat somebody in - Campus's courtyard bench, which its waiting room lends.
   * `null` for every fixture nobody is ever in: a plant, a cooler, a board.
   *
   * Named here rather than defaulted, because a bench that forgot to say so is
   * a stroller sitting down on top of somebody. See `OfficeErrandSpot.seatId`.
   */
  readonly seatId: string | null;
}

export function isoSpotAt(args: IsoSpotArgs): OfficeErrandSpot {
  return {
    kind: args.kind,
    tile: args.stand,
    facing: args.facing,
    audience: args.audience,
    // A spot with no fixture rallies with nobody, so it is named by the tile
    // it stands on and shares that id with no one.
    fixtureId: fixtureIdOf(
      args.floorIndex,
      args.kind,
      args.fixture ?? args.stand,
    ),
    approachTile: args.stand,
    actionTile: args.action,
    floorIndex: args.floorIndex,
    seatId: args.seatId,
  };
}

/**
 * What stands at each errand kind. Declared once, because the plan and the
 * painter both have to mean the same object by it: the plan RECORDS the fixture
 * in `layout.props` - `actionTile` is a promise that a named sprite stands
 * there, and a plan that only implied one would leave the scene guessing - and
 * the painter DRAWS it from the spot, where it can be given a depth.
 */
export const ISO_SPOT_FIXTURES: Partial<
  Record<OfficeErrandSpot["kind"], OfficeSpriteName>
> = {
  coffee: "coffee-machine",
  cooler: "water-cooler",
  vending: "vending",
  cafe: "cafe-table",
  sofa: "sofa",
  garden: "bench",
  "water-plant": "plant",
};

/**
 * The props a set of spots stands up: one per fixture TILE.
 *
 * Per tile rather than per spot, because two spots can act on one tile - a
 * queue in front of a coffee machine - and one prop is one prop.
 */
export function isoFixtureProps(
  spots: ReadonlyArray<OfficeErrandSpot>,
): ReadonlyArray<OfficeProp> {
  const props: OfficeProp[] = [];
  const standing = new Set<string>();
  for (const spot of spots) {
    const tile = spot.actionTile;
    if (tile === null) continue;
    const name = ISO_SPOT_FIXTURES[spot.kind];
    if (name === undefined) continue;
    const key = isoTileKey(tile);
    if (standing.has(key)) continue;
    standing.add(key);
    props.push({ sprite: { name }, tile });
  }
  return props;
}

/**
 * The district's front door: grass, two trees, the reception counter, the
 * queue in front of it, A BENCH ROW as long as the caller asks for, and a plant
 * somebody can water.
 *
 * Everything a district needs to be ENTERED is here, which is why it is placed
 * first in the shelf: the door hangs on the ring beside it.
 *
 * The bench row is the only thing here that varies, and `ISO_COURTYARD_BENCHES`
 * says why: City asks for its two and gets the park it has always had, Campus
 * asks for `civicCapacityFor(...).chairs` because this row IS its waiting room.
 * At two benches every tile below is exactly where it was before the row could
 * grow, which is what keeps City's park a park.
 */
export function buildIsoCourtyard(args: CourtyardArgs): IsoCourtyardBuild {
  const { col, row, floorIndex } = args;
  const benches = Math.max(args.benches, ISO_COURTYARD_BENCHES);
  const cols = isoCourtyardCols(benches);
  const rect: OfficeTileRect = { col, row, cols, rows: ISO_COURTYARD_ROWS };
  const receptionTile: OfficeTilePos = { col: col + 2, row };
  // The bench row runs from the second column - the first is the lobby's, and
  // the way in may not be furniture - and the plant sits past its far end, so
  // watering it is never a walk through the benches.
  const benchTiles: ReadonlyArray<OfficeTilePos> = Array.from(
    { length: benches },
    (_unused, index) => ({ col: col + 1 + index, row: row + 2 }),
  );
  const lastBench = benchTiles[benchTiles.length - 1];
  const plantTile: OfficeTilePos = { col: lastBench.col + 3, row: row + 2 };
  const rightCol = col + cols - 1;
  const scenery: ReadonlyArray<OfficeProp> = [
    { sprite: { name: "tree" }, tile: { col, row } },
    { sprite: { name: "reception" }, tile: receptionTile },
    { sprite: { name: "tree" }, tile: { col: rightCol, row } },
  ];
  const blocked: OfficeTilePos[] = [
    { col, row },
    receptionTile,
    { col: col + 3, row },
    { col: rightCol, row },
    ...benchTiles,
    plantTile,
  ];
  const queueTiles: ReadonlyArray<OfficeTilePos> = [
    { col: col + 2, row: row + 1 },
    { col: col + 3, row: row + 1 },
    { col: col + 4, row: row + 1 },
  ];
  // ONE FIXTURE ID FOR THE WHOLE ROW, which is what `fixture` means here: every
  // sitter on the bench row rallies with every other, the way the two-tile bench
  // always did. A per-tile fixture would turn one bench into N benches nobody
  // talks across.
  const benchSpots: ReadonlyArray<OfficeErrandSpot> = benchTiles.map(
    (tile, index) =>
      isoSpotAt({
        kind: "garden",
        stand: { col: tile.col, row: row + 3 },
        fixture: benchTiles[0],
        // Its OWN end of the bench: a sitter sits on the half it stood at, so a
        // shared anchor would leave every arrival but one standing.
        action: tile,
        floorIndex,
        facing: "up",
        audience: ISO_FLOOR_AUDIENCE,
        seatId: args.seatIdAt(index),
      }),
  );
  const spots: ReadonlyArray<OfficeErrandSpot> = [
    ...benchSpots,
    isoSpotAt({
      kind: "water-plant",
      stand: { col: plantTile.col, row: row + 3 },
      fixture: plantTile,
      action: plantTile,
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "garden",
      stand: { col, row: row + 4 },
      // Grass, not a bench: a stroll belongs to no fixture and acts on
      // nothing, and the scene reads the sitting decision off that null.
      fixture: null,
      action: null,
      floorIndex,
      facing: "down",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "garden",
      stand: { col: rightCol, row: row + 4 },
      fixture: null,
      action: null,
      floorIndex,
      facing: "down",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
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
    props: [...scenery, ...isoFixtureProps(spots)],
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
      action: coffeeTile,
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "cooler",
      stand: { col: col + 3, row: row + 1 },
      fixture: coolerTile,
      action: coolerTile,
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "vending",
      stand: { col: col + 6, row: row + 1 },
      fixture: vendingTile,
      action: vendingTile,
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "cafe",
      stand: { col, row: row + 3 },
      fixture: tableA,
      action: tableA,
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "cafe",
      stand: { col: col + 1, row: row + 3 },
      fixture: tableA,
      action: { col: col + 1, row: row + 2 },
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "cafe",
      stand: { col: col + 4, row: row + 3 },
      fixture: tableB,
      action: tableB,
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "cafe",
      stand: { col: col + 5, row: row + 3 },
      fixture: tableB,
      action: { col: col + 5, row: row + 2 },
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "sofa",
      stand: { col: col + 2, row: row + 5 },
      fixture: sofaTile,
      action: sofaTile,
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
    }),
    isoSpotAt({
      kind: "sofa",
      stand: { col: col + 3, row: row + 5 },
      fixture: sofaTile,
      action: { col: col + 3, row: row + 4 },
      floorIndex,
      facing: "up",
      audience: ISO_FLOOR_AUDIENCE,
      seatId: null,
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
    props: isoFixtureProps(spots),
    blocked,
    spots,
  };
}

// ---- Districts -------------------------------------------------------- //

/**
 * `<host>/civic/<kind>`, the id every seat in the room carries back.
 *
 * SHARED, because a civic room id is a promise across syncs and not a plan's
 * private spelling: the seat book matches claims by it, so two isometric views
 * spelling it two ways would be two views the book cannot compare. Lifted here
 * from Campus when City needed the same ids.
 *
 * WHAT THE ROOM IS, NEVER WHERE IT CAME IN THE ORDER. This carried the FLOOR
 * INDEX until read X: a district's index is its position in the partition's
 * host-id ordering, so a host arriving lexically earlier moved every later
 * district to a new index and renamed its four rooms and all their seats -
 * while the district's own geometry stayed frozen. The book then adopted
 * nothing, dropped the held claims and swapped the beds under the patients
 * still in them. `seatIdOf` in `city-plan.ts` had the identical defect for
 * DESKS and its doc already states the rule: name a seat after identities that
 * outlive the plan. A host and a kind are two of those; an ordinal is not.
 *
 * The ordinal was never carrying uniqueness either - measured over all six
 * views at 12, 309 and 1,000 agents on a two-host epic, `(hostId, kind)`
 * collides nowhere: a host owns exactly one room of each kind, and Mission
 * control's hall - whose producer has always taken the kind alone - owns one of
 * each for every host.
 */
export function civicRoomIdOf(
  hostId: string | null,
  kind: OfficeCivicKind,
): string {
  return [hostId ?? ISO_SEAT_ID_NONE, "civic", kind].join("/");
}

/**
 * THE LANE: the district's left ring column, top to bottom.
 *
 * A column and not a row, and "lane" is satisfied by it - straight, and never
 * reversing. Projected isometrically a column is one down-left run, `dy >= 0`
 * with `dx` constant and negative, so a vehicle driving it faces one way for the
 * whole trip.
 *
 * It has to be this column rather than a row because two kerbs are promises: the
 * infirmary's and the help desk's have to be road tiles one step from their own
 * doors, and the ring column is the only line in a shelf-packed district whose
 * position is known before the packing. The district's own entrance already
 * stands on it, which is the help desk's kerb.
 *
 * SHARED by both districted views, which is the whole reason it reads only
 * `bounds`: a lane that needed a view's own packing could not be the same
 * promise in two views.
 */
export function districtLane(bounds: OfficeTileRect): OfficeRoad {
  const tiles: OfficeTilePos[] = [];
  for (let row = bounds.row; row < bounds.row + bounds.rows; row += 1) {
    tiles.push({ col: bounds.col, row });
  }
  return {
    entryTile: tiles[0],
    tiles,
    exitTile: tiles[tiles.length - 1],
  };
}

/**
 * A bed or a bench: furniture the occupant's own tile IS.
 *
 * The HIT BOX is an argument rather than computed here, and that is the one thing
 * this helper cannot share. A box is what the view's PAINTER draws, and the two
 * views answer it differently: Campus boxes its beds in the union its desks are
 * drawn in, City in the furniture sprite's own rect. Computing either here would
 * mean this module importing the painter that imports it.
 */
export function civicSeat(args: {
  readonly seatId: string;
  readonly civicRoomId: string;
  readonly kind: "bed" | "lounge";
  readonly tile: OfficeTilePos;
  readonly widthTiles: number;
  readonly floorIndex: number;
  readonly hostId: string | null;
  readonly hitBox: OfficeRect;
}): OfficeSeat {
  return {
    seatId: args.seatId,
    kind: args.kind,
    // LAIN ON, or SAT ON: the occupant's tile is the furniture's own, so there
    // is no chair beside it to walk to - the same shape the hall's beds have.
    deskTile: args.tile,
    chairTile: args.tile,
    // Everything in a district faces the same way its desks do.
    facing: "up",
    hitTiles: { width: args.widthTiles, height: 1 },
    // A REAL BOX, not `null`. An isometric seat is a sprite stack hanging off
    // its tile's corner, and a region derived from tiles alone misses it - which
    // is the seam `hitBox` exists to close, so a bed answers clicks like a desk.
    hitBox: args.hitBox,
    floorIndex: args.floorIndex,
    // A bed belongs to no TEAM, which is what `roomId` names.
    roomId: null,
    hostId: args.hostId,
    manager: false,
    civicRoomId: args.civicRoomId,
  };
}

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
  /**
   * The district's four civic rooms, and the street they face. A view that has
   * not enrolled in the civic layer yet answers `[]` and `null`, which is what
   * `CIVIC_ROOMS_EXPECTED` and `CIVIC_ROADS_EXPECTED` assert of it - so these
   * being empty is a statement rather than an omission.
   */
  readonly civic: ReadonlyArray<OfficeCivicRoom>;
  readonly road: OfficeRoad | null;
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
      // NOR THROUGH A WARD. A corridor tile is somewhere a walker may stroll to
      // for no reason, and a civic room is not that - somebody lying in a bed is
      // not scenery to wander past. The rooms are excluded here rather than
      // trusted to be blocked, because a ward's own walk row is walkable on
      // purpose and would otherwise read as corridor.
      if (build.civic.some((room) => isoWithinRect(room.bounds, tile)))
        continue;
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
    civic: build.civic,
    road: build.road,
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
    civicRoomId: null,
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

/**
 * How far above its D20 anchor a City seat's envelope leaves: the CENTRE of
 * the roof its occupant works under, not the roof's top edge.
 *
 * The scene puts an endpoint at `anchor.y - OFFICE_CHARACTER_HEIGHT - lift`,
 * and the roof of a `storeys`-high stack is drawn with its centre one storey
 * below the top of the stack. Those two cancel to exactly this, which is why
 * a one-storey building lifts nothing: its roof centre IS its occupant's head
 * height. Painter and projector both read it, so they cannot disagree.
 */
export function cityRoofLift(storeys: number): number {
  return (storeys - 1) * ISO_STOREY_HEIGHT;
}

export interface CityFrozen {
  readonly kind: "city";
  /** What the painter reads instead of walking `rooms` and `props`. */
  readonly index: IsoPlanIndex;
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

// ---- The painter's index ---------------------------------------------- //

/**
 * WHAT THE PAINTER READS, arranged so that a pan reads what it draws.
 *
 * The painter is called per visible CHUNK, and a chunk of a 1,000-agent world
 * holds a few dozen tiles. Walking `layout.rooms` and `layout.props` to find
 * them means reading a thousand rooms and a thousand props to emit thirty-two
 * drawables, sixty times a second, for every chunk on screen. So the plan -
 * which walks those arrays once anyway, while it is building them - hands the
 * painter a lookup instead.
 *
 * It lives in `frozen`, which the contract already calls per-view metadata
 * opaque to everything above the view. That is the only place it can live: a
 * field on `OfficeLayout` would be an isometric fact in a shared type, and a
 * cache in the painter module would be state keyed on a layout it does not
 * own - wrong the moment two scenes hold two layouts, and unfalsifiable in a
 * test. `frozen` carrying an index is not the same as `frozen` carrying a
 * PACKING: Campus re-packs every plan and still has one of these.
 *
 * The class is the guard. `frozen` is `unknown`, and `instanceof` is the one
 * check that cannot be spoofed by a plain object that happens to have the
 * right shape.
 */
const ISO_INDEX_CELL = 16;

interface IsoIndexedProp {
  readonly prop: OfficeProp;
  readonly order: number;
}

interface IsoIndexedRoom {
  readonly room: OfficeRoom;
  readonly order: number;
}

/**
 * EVERYTHING A PROJECTOR IS BUILT FROM, as one value.
 *
 * This exists so that "the projector is a function of these and nothing else"
 * is structural rather than a claim in a comment: the painter builds from an
 * `IsoProjectorInputs` and cannot reach past it, so the memo below can key on
 * the same record and be complete by construction.
 *
 * The two halves come from different places, and a memo that confused them
 * would be wrong:
 *
 * - `cols` and `rows` are the LAYOUT's, and a spread that grows either is a
 *   second layout over the same frozen - `{ ...layout, rows: rows + 3 }`
 *   projects to a different origin, which is what "growth moves the origin"
 *   means;
 * - `stackHeight` and `storeys` are the CITY PACKING's, read off the frozen
 *   that owns the index rather than off the index, so an index reaching a
 *   second frozen is the same hazard one step down.
 *
 * `storeys` is a REFERENCE and `stackHeight` a NUMBER on purpose, because the
 * projector treats them differently: `stackHeight` is captured when the
 * projector is built, so a changed one leaves a stale projector; the storeys
 * map is read through on every `seatLift` call, so only its identity matters
 * and a map mutated in place still answers for itself.
 */
export interface IsoProjectorInputs {
  readonly cols: number;
  readonly rows: number;
  /** `H`: Campus's one constant, or the City packing's tallest stack. */
  readonly stackHeight: number;
  /** City's roof heights; `null` on Campus, which lifts nothing off the floor. */
  readonly storeys: ReadonlyMap<string, number> | null;
}

export function isoProjectorInputsOf(layout: OfficeLayout): IsoProjectorInputs {
  const frozen = readCityFrozen(layout);
  if (frozen === null) {
    return {
      cols: layout.cols,
      rows: layout.rows,
      stackHeight: ISO_CAMPUS_STACK_HEIGHT,
      storeys: null,
    };
  }
  return {
    cols: layout.cols,
    rows: layout.rows,
    stackHeight: frozen.stackHeight,
    storeys: frozen.storeysBySeatId,
  };
}

export function isoSameProjectorInputs(
  left: IsoProjectorInputs,
  right: IsoProjectorInputs,
): boolean {
  return (
    left.cols === right.cols &&
    left.rows === right.rows &&
    left.stackHeight === right.stackHeight &&
    left.storeys === right.storeys
  );
}

/**
 * A built projector and the inputs it was built from.
 *
 * Deliberately NOT the layout it was built for. A memo on `frozen` holding a
 * layout keeps that whole layout - its seats, floors, rooms and signs - alive
 * for as long as the frozen lives, and `frozen` is exactly what the next plan
 * carries forward, so the previous world would outlive its own replacement.
 * Three numbers and a map that the projector already holds retain nothing.
 */
export interface IsoProjectorMemo {
  readonly inputs: IsoProjectorInputs;
  readonly projector: OfficeProjector;
}

/** One civic room in the index, with the order its plan listed it in. */
interface IsoIndexedCivic {
  readonly room: OfficeCivicRoom;
  readonly order: number;
}

export class IsoPlanIndex {
  /** Floor-pass props only: a fixture is drawn from its spot, not from here. */
  readonly propsByTile: Map<string, IsoIndexedProp[]>;
  /** Rooms by coarse cell, because a room is a rect and a tile map of one
   * would hold every interior tile it covers. */
  readonly roomsByCell: Map<string, IsoIndexedRoom[]>;
  /** Districts by the same coarse cell, for the ground question below. */
  readonly floorsByCell: Map<string, OfficeFloor[]>;
  /**
   * CIVIC ROOMS by the same coarse cell, and a second map rather than entries
   * in `roomsByCell` because the two are different things to the painter. A
   * team room's back walls are solid and are drawn from its bounds alone; a
   * civic room's are drawn only where the PLAN blocked a tile, so its ward's
   * open aisle and its hut's door stay open. Folding them together would make
   * every reader ask which kind it was holding.
   */
  readonly civicByCell: Map<string, IsoIndexedCivic[]>;
  /** The one spot per fixture tile that draws it; the rest only sit at it. */
  readonly drawingSpots: Set<string>;
  /**
   * The FIXTURE a seat is, by seat id - for the reader that has a seat and needs
   * to know its furniture belongs to the courtyard rather than to it.
   *
   * Every spot with a seat id is in here, not only the one that draws: the art
   * exists for both ends of a shared bench, and which of the two dispatched it
   * is not a fact about either seat.
   */
  readonly seatFixtures: Map<string, OfficeErrandSpot>;
  /** The widest and tallest sprite indexed, in TILES, rounded up. */
  propMargin: number;
  /**
   * The last projector the painter built through this index, with the inputs
   * it was built from. A memo, filled on first use rather than at build time,
   * because a plan has no projector to hand and the painter does.
   *
   * `null` is a complete answer - nothing reads this that cannot build one -
   * which is what lets it be a memo rather than a fact about the plan. It
   * lives here and not in the painter module for the reason the class comment
   * gives: a cache there would be painter state keyed on a layout the painter
   * does not own, wrong the moment two scenes hold two layouts.
   */
  projectorMemo: IsoProjectorMemo | null;
  constructor() {
    this.propsByTile = new Map();
    this.roomsByCell = new Map();
    this.floorsByCell = new Map();
    this.civicByCell = new Map();
    this.drawingSpots = new Set();
    this.seatFixtures = new Map();
    this.projectorMemo = null;
    this.propMargin = 0;
  }
}

export interface IsoIndexArgs {
  readonly props: ReadonlyArray<OfficeProp>;
  readonly rooms: ReadonlyArray<OfficeRoom>;
  readonly spots: ReadonlyArray<OfficeErrandSpot>;
  readonly floors: ReadonlyArray<OfficeFloor>;
}

/** A spot's own name, stable across the two places that build one. */
function isoSpotKey(spot: OfficeErrandSpot): string {
  return [
    spot.floorIndex,
    spot.kind,
    spot.approachTile.col,
    spot.approachTile.row,
  ].join("/");
}

function cellKey(col: number, row: number): string {
  return `${col}:${row}`;
}

/** Every coarse cell a rect touches, once each, in row-major order. */
function eachCell(bounds: OfficeTileRect, visit: (key: string) => void): void {
  const firstCol = Math.floor(bounds.col / ISO_INDEX_CELL);
  const lastCol = Math.floor((bounds.col + bounds.cols - 1) / ISO_INDEX_CELL);
  const firstRow = Math.floor(bounds.row / ISO_INDEX_CELL);
  const lastRow = Math.floor((bounds.row + bounds.rows - 1) / ISO_INDEX_CELL);
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      visit(cellKey(col, row));
    }
  }
}

export function buildIsoIndex(args: IsoIndexArgs): IsoPlanIndex {
  const index = new IsoPlanIndex();

  // Which spot draws which fixture, decided once. First spot in plan order
  // wins, which is the seat the plan itself listed first.
  const drawn = new Set<string>();
  const fixtureTiles = new Set<string>();
  for (const spot of args.spots) {
    const tile = spot.actionTile;
    if (tile === null) continue;
    const key = isoTileKey(tile);
    fixtureTiles.add(key);
    if (ISO_SPOT_FIXTURES[spot.kind] === undefined) continue;
    if (spot.seatId !== null && !index.seatFixtures.has(spot.seatId)) {
      index.seatFixtures.set(spot.seatId, spot);
    }
    if (drawn.has(key)) continue;
    drawn.add(key);
    index.drawingSpots.add(isoSpotKey(spot));
  }

  let margin = 0;
  for (const [order, prop] of args.props.entries()) {
    const key = isoTileKey(prop.tile);
    // A fixture is in `layout.props` so the plan's promise is readable, and
    // out of this index so the floor pass cannot paint it a second time.
    if (fixtureTiles.has(key)) continue;
    const bucket = index.propsByTile.get(key);
    if (bucket === undefined) index.propsByTile.set(key, [{ prop, order }]);
    else bucket.push({ prop, order });
    const size = officeSpriteSize(prop.sprite);
    // A sprite is anchored at its tile's CORNER and reaches up and to the
    // left of it. One tile step is 16 px across and 8 px down, so a sprite
    // `h` tall can be anchored `h / 8` tiles behind the window and still
    // reach into it, and one `w` wide `w / 32` tiles to either side.
    margin = Math.max(
      margin,
      Math.ceil(size.height / ISO_HALF_HEIGHT),
      Math.ceil(size.width / (ISO_HALF_WIDTH * 2)),
    );
  }
  index.propMargin = margin;

  for (const [order, room] of args.rooms.entries()) {
    eachCell(room.bounds, (key) => {
      const bucket = index.roomsByCell.get(key);
      if (bucket === undefined) index.roomsByCell.set(key, [{ room, order }]);
      else bucket.push({ room, order });
    });
  }

  // The floor OBJECT, not a copy of its bounds: the painter asks this index a
  // ground question per visible tile, and a guard that wants to count what
  // that costs has to be able to see the reads. An index that copied the
  // rects out at build time would answer from numbers nothing can observe.
  for (const floor of args.floors) {
    eachCell(floor.bounds, (key) => {
      const bucket = index.floorsByCell.get(key);
      if (bucket === undefined) index.floorsByCell.set(key, [floor]);
      else bucket.push(floor);
    });
  }

  // One order across every storey's civic rooms, so two districts' wards come
  // back in plan order rather than in whatever order the cells were walked.
  let civicOrder = 0;
  for (const floor of args.floors) {
    for (const room of floor.civic) {
      const order = civicOrder;
      civicOrder += 1;
      eachCell(room.bounds, (key) => {
        const bucket = index.civicByCell.get(key);
        if (bucket === undefined) index.civicByCell.set(key, [{ room, order }]);
        else bucket.push({ room, order });
      });
    }
  }
  return index;
}

/**
 * This layout's index, or `null` for a layout that carries none.
 *
 * `null` is a real answer, not an error: a plan from another view - or from a
 * version of this one that predates the index - has no lookup to offer, and
 * the painter falls back to reading the arrays whole. Slow is not wrong.
 */
export function readIsoIndex(layout: OfficeLayout): IsoPlanIndex | null {
  const frozen = layout.frozen;
  if (typeof frozen !== "object" || frozen === null) return null;
  if (!("index" in frozen)) return null;
  const index = frozen.index;
  return index instanceof IsoPlanIndex ? index : null;
}

/**
 * THE FIXTURE THIS SEAT IS, or `null` for a seat that is not one.
 *
 * Campus's courtyard bench is furniture two systems share: a stroll sits at it as
 * a SPOT, and the waiting room lends the tile in front of it as a SEAT. The art
 * is the spot's - one bench per `actionTile`, a row behind the tile the body
 * stands on, drawn by `spotProps` and owned by nobody - so a reader holding only
 * the seat cannot otherwise tell that the furniture under it is not the seat's
 * own. A ward bed and a City shelter chair are the other shape: a prop the civic
 * plan stands on the seat's own tile, and no spot at all.
 *
 * The seat id is the whole key. `seatId` is what the plan hands the courtyard for
 * exactly this pairing, and it is unique across a layout's seats.
 */
export function isoSeatFixture(
  layout: OfficeLayout,
  seatId: string,
): OfficeErrandSpot | null {
  const index = readIsoIndex(layout);
  if (index !== null) return index.seatFixtures.get(seatId) ?? null;
  for (const floor of layout.floors) {
    for (const spot of floor.errandSpots) {
      if (spot.seatId !== seatId || spot.actionTile === null) continue;
      if (ISO_SPOT_FIXTURES[spot.kind] === undefined) continue;
      return spot;
    }
  }
  return null;
}

/** Whether this spot is the one that DRAWS its fixture. */
export function isoSpotDraws(
  layout: OfficeLayout,
  spot: OfficeErrandSpot,
): boolean {
  if (spot.actionTile === null) return false;
  const index = readIsoIndex(layout);
  if (index === null) return true;
  return index.drawingSpots.has(isoSpotKey(spot));
}

/**
 * The floor-pass props anchored in or just behind this window.
 *
 * "Just behind" is the margin: a tree anchored one tile off the top edge still
 * hangs into the window, and a chunk that dropped it would show half a tree
 * whenever the camera stopped on that line.
 */
export function isoPropsIn(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): ReadonlyArray<OfficeProp> {
  const index = readIsoIndex(layout);
  if (index === null) {
    return layout.props.filter((prop) => isoWithinRect(tiles, prop.tile));
  }
  if (tiles.cols <= 0 || tiles.rows <= 0) return [];
  const found: IsoIndexedProp[] = [];
  // The margin runs BOTH ways on both axes, unlike an axis-aligned view's.
  // A sprite hangs half its width to either side of its tile's corner here,
  // so a neighbour in front can reach back into the window exactly as one
  // behind can reach forward into it.
  const margin = index.propMargin;
  const firstRow = Math.max(0, tiles.row - margin);
  const firstCol = Math.max(0, tiles.col - margin);
  for (let row = firstRow; row < tiles.row + tiles.rows + margin; row += 1) {
    for (let col = firstCol; col < tiles.col + tiles.cols + margin; col += 1) {
      const bucket = index.propsByTile.get(`${col},${row}`);
      if (bucket !== undefined) found.push(...bucket);
    }
  }
  return found
    .filter(({ prop }) => isoPropReaches(tiles, prop))
    .sort((left, right) => left.order - right.order)
    .map(({ prop }) => prop);
}

/**
 * Whether a prop's SPRITE reaches the window, rather than its tile.
 *
 * Both are measured in projected pixels, because that is the only space in
 * which "does this overlap" has an answer here: a tile rect projects to a
 * diamond, and a sprite is an upright box hanging off one tile's corner.
 */
function isoPropReaches(tiles: OfficeTileRect, prop: OfficeProp): boolean {
  const size = officeSpriteSize(prop.sprite);
  const x = (prop.tile.col - prop.tile.row) * ISO_HALF_WIDTH;
  const y = (prop.tile.col + prop.tile.row) * ISO_HALF_HEIGHT;
  const left = x - size.width / 2;
  const top = y + ISO_HALF_HEIGHT - size.height;
  // The window's own projected box: its four tile corners, min and max. The
  // origin cancels on both sides, so neither term needs the projector.
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

/** What a tile stands on: a garden's grass, a district's paving, or nothing. */
export type IsoGroundKind = "grass" | "paved";

/**
 * The ground under ONE tile, in O(1) whatever the world holds.
 *
 * This is the hottest question the painter asks. A 32 x 32 chunk is 1,024
 * tiles, and answering each by walking every district and then the amenities
 * inside the one it lands in costs fifty hosts' worth of rects per tile just
 * to lay one chunk of pavement. The coarse cell holds the one or two
 * districts that can possibly cover the tile, and a district holds a handful
 * of amenities, so the answer costs the same at fifty hosts as at one.
 *
 * A layout with no index still gets an answer, by the walk this replaced.
 */
export function isoGroundAt(
  layout: OfficeLayout,
  tile: OfficeTilePos,
): IsoGroundKind | null {
  const index = readIsoIndex(layout);
  const floors =
    index === null
      ? layout.floors
      : (index.floorsByCell.get(
          cellKey(
            Math.floor(tile.col / ISO_INDEX_CELL),
            Math.floor(tile.row / ISO_INDEX_CELL),
          ),
        ) ?? []);
  let inDistrict = false;
  for (const floor of floors) {
    if (!isoWithinRect(floor.bounds, tile)) continue;
    inDistrict = true;
    for (const amenity of floor.amenities) {
      if (amenity.kind !== "garden") continue;
      if (isoWithinRect(amenity.bounds, tile)) return "grass";
    }
  }
  return inDistrict ? "paved" : null;
}

/** The rooms whose bounds touch this window, in the plan's own order. */
export function isoRoomsIn(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): ReadonlyArray<OfficeRoom> {
  const index = readIsoIndex(layout);
  if (index === null) return layout.rooms;
  if (tiles.cols <= 0 || tiles.rows <= 0) return [];
  const found = new Map<number, OfficeRoom>();
  const firstCol = Math.floor(Math.max(0, tiles.col) / ISO_INDEX_CELL);
  const lastCol = Math.floor(
    Math.max(0, tiles.col + tiles.cols - 1) / ISO_INDEX_CELL,
  );
  const firstRow = Math.floor(Math.max(0, tiles.row) / ISO_INDEX_CELL);
  const lastRow = Math.floor(
    Math.max(0, tiles.row + tiles.rows - 1) / ISO_INDEX_CELL,
  );
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      for (const entry of index.roomsByCell.get(cellKey(col, row)) ?? []) {
        if (!isoRectsOverlap(entry.room.bounds, tiles)) continue;
        found.set(entry.order, entry.room);
      }
    }
  }
  return [...found.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, room]) => room);
}

/**
 * The CIVIC rooms whose bounds meet this window, in plan order.
 *
 * Through the index for the reason `isoRoomsIn` is: the painter asks per window
 * and a walk over every district's `civic` would make a far district cost
 * something, which the ground-question guard asserts it does not. A layout with
 * no index answers from every storey, which is the un-frozen path and is only
 * ever a test's.
 */
export function isoCivicIn(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): ReadonlyArray<OfficeCivicRoom> {
  const index = readIsoIndex(layout);
  if (index === null) {
    return layout.floors.flatMap((floor) => [...floor.civic]);
  }
  if (tiles.cols <= 0 || tiles.rows <= 0) return [];
  const found = new Map<number, OfficeCivicRoom>();
  const firstCol = Math.floor(Math.max(0, tiles.col) / ISO_INDEX_CELL);
  const lastCol = Math.floor(
    Math.max(0, tiles.col + tiles.cols - 1) / ISO_INDEX_CELL,
  );
  const firstRow = Math.floor(Math.max(0, tiles.row) / ISO_INDEX_CELL);
  const lastRow = Math.floor(
    Math.max(0, tiles.row + tiles.rows - 1) / ISO_INDEX_CELL,
  );
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      for (const entry of index.civicByCell.get(cellKey(col, row)) ?? []) {
        if (!isoRectsOverlap(entry.room.bounds, tiles)) continue;
        found.set(entry.order, entry.room);
      }
    }
  }
  return [...found.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, room]) => room);
}

export function isoRectsOverlap(
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
