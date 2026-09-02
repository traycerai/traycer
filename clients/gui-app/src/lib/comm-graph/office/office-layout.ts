/**
 * The office floor plan: a pure function of WHO EXISTS, never a stored
 * coordinate.
 *
 * Same discipline as the graph mode's dagre pass - an agent that is created,
 * archived or reparented would strand a persisted desk, so the plan is
 * recomputed from the agent set instead. That makes ORDER the whole design:
 * the set is walked as families, so a lineage reads left to right along a row
 * and a creator sits at the head of the people it created.
 *
 * HOSTS ARE FLOORS. The set is first split by `hostId`, and each group gets its
 * own storey of the same building: its own wall ring, its own cabins, its own
 * lobby, door, reception and clock. Storeys stack downward sharing one wall row
 * between them, and `walkable` never joins two of them - messaging is
 * host-local, so an agent has nowhere to walk to on another floor. A
 * single-host epic therefore renders exactly the building it always did.
 *
 * NESTING IS WALLS. Every root agent gets its own walled CABIN and its whole
 * subtree sits inside it, so "who is in whose room" is readable at a glance
 * rather than inferred from adjacency. A cabin has a `wall-top` cap, the wall
 * face below it that carries the name sign, side walls, and one walkable door
 * in the bottom wall. Cabins tile left to right into bands on the building
 * floor with a corridor between them, and the building itself is the outer
 * wall ring with an aisle inside it, the entrance centred on the bottom wall
 * and the lobby directly inside that.
 *
 * Desks are laid into a fixed SLOT grid, 5 columns by 3 rows each: a two-tile
 * desk with a chair below its left tile, one tile of plant space that only a
 * manager uses, and a full aisle row underneath so characters can always walk
 * between desk rows and reach any chair from below. Every slot is 5 wide
 * whether or not it holds a plant, because a manager-only widening would make a
 * desk's column depend on how many managers precede it - and then promoting one
 * agent would shuffle the whole floor.
 */
import type {
  OfficeAgentInput,
  OfficeAmenityKind,
  OfficeAreaSign,
  OfficeDesk,
  OfficeErrandSpot,
  OfficeFacing,
  OfficeFloor,
  OfficeLayout,
  OfficeProp,
  OfficeRoom,
  OfficePod,
  OfficePodStyle,
  OfficeSpriteName,
  OfficeTilePos,
  OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";

/** Slot footprint: desk + plant space across, desk / chair / aisle down. */
const SLOT_COLS = 5;
const SLOT_ROWS = 3;
/**
 * A cabin grows toward a square so a big family does not become a corridor,
 * capped at four so no single cabin can outrun the building's band width.
 */
const CABIN_MIN_SLOTS_PER_ROW = 1;
const CABIN_MAX_SLOTS_PER_ROW = 4;
/** One aisle column down the cabin's left edge, one aisle row under its sign. */
const CABIN_AISLE_COLS = 1;
const CABIN_AISLE_ROWS = 1;
/** `wall-top` cap plus the wall face the sign mounts on, matching the building. */
const CABIN_TOP_WALL_ROWS = 2;
const CABIN_LEFT_WALL_COLS = 1;
/** Left and right wall columns. */
const CABIN_SIDE_WALL_COLS = CABIN_LEFT_WALL_COLS * 2;
/** The two top wall rows plus the bottom wall the door opens through. */
const CABIN_WALL_ROWS = CABIN_TOP_WALL_ROWS + 1;
/** Corridor between two cabins side by side, and between two bands. */
const CABIN_GAP_TILES = 2;
/** Left tile of the two-tile sign, measured from the cabin's left wall. */
const SIGN_COL_OFFSET = 1;
/** The outline ring a pod wears, one tile thick on every side. */
const POD_OUTLINE_TILES = 1;
/** Free floor after the lead's slot, after each pack row, and after each block. */
const BLOCK_GAP_TILES = 1;
/** The aisle down the right of every block's interior, joining its gap rows. */
const BLOCK_AISLE_COLS = 1;
const POD_STYLES: ReadonlyArray<OfficePodStyle> = [
  "glass",
  "planters",
  "shelves",
];

/**
 * Where a band wraps. The floor is looked at as a whole, so the limit grows
 * with the population rather than with whichever cabin happens to be widest -
 * a fixed limit would either wrap a small epic pointlessly or let a large one
 * run off the side.
 */
const MIN_BAND_WIDTH_TILES = 24;
const BAND_WIDTH_PER_SLOT = 6;

/** Outer wall column plus the aisle inside it. */
const BUILDING_FIRST_CONTENT_COL = 2;
/** `wall-top`, the wall face, then the aisle inside them. */
const BUILDING_FIRST_CONTENT_ROW = 3;
/** Aisle + wall to the right of the last cabin, as a count past its last index. */
const BUILDING_RIGHT_MARGIN_TILES = 3;
/**
 * Corridor + lobby + wall below the lowest band. The corridor is not
 * decoration: a cabin in the last band opens its door onto it.
 *
 * The lobby gets a row of its OWN, below that corridor, because the reception
 * counter stands on it - two tiles of furniture across the only walkable row
 * at the bottom of the building would cut the floor in half, and every walk
 * from a desk to reception would tour the whole storey to get around it.
 */
const BUILDING_BOTTOM_MARGIN_TILES = 4;
/** The cap and the wall face under it, at the top of every storey. */
const BUILDING_TOP_WALL_ROWS = 2;

/** An epic with no agents still renders a room; the canvas is never blank. */
const EMPTY_ROOM_COLS = 8;
const EMPTY_ROOM_ROWS = 6;
const WINDOW_SPACING_TILES = 4;
const DESK_WIDTH_TILES = 2;
const PLANT_COL_OFFSET = 2;

/** The counter is two tiles wide and keeps one clear tile beside the door. */
const RECEPTION_WIDTH_TILES = 2;
const RECEPTION_DOOR_GAP_TILES = 1;
/** More than six waiting reads as a crowd, not a queue. */
const MAX_RECEPTION_QUEUE_TILES = 6;
/** The clock hangs on the wall face, clear of the two-tile whiteboard. */
const CLOCK_COL_OFFSET = 2;
/** The stairwell is two tiles square, in the lobby's right-hand corner. */
const STAIRS_TILES = 2;

/**
 * AMENITIES. Every one is a walled room standing in the columns RESERVED to the
 * right of the cabin bands: a wall ring with a single door, its name on its own
 * wall face, and fixtures inside that the errand engine has somewhere to send
 * people. Their footprint is reserved out of the floor's width (see
 * `buildFloors`) rather than fitted into whatever gap the cabins happen to
 * leave, because a room that sometimes exists is a room the errand engine
 * cannot rely on.
 *
 * WHICH rooms exist, and how big each one is, follows the floor's AGENT COUNT.
 * A break room sized for two is a queue for twenty, and a gym on a floor of one
 * is a corridor with a treadmill in it - so the amenities grow with the
 * population instead of being fixed art that only reads right at one size.
 *
 * Every kind shares one row layout, so no room can drift into looking like a
 * different sort of place and the scene can paint any of them with one ring:
 *
 * ```
 *   row + 0   `wall-top` cap (the garden wears a `planter` hedge instead)
 *   row + 1   wall face: the room's name sign, and anything wall-mounted
 *   row + 2   fixtures standing against the back wall
 *   row + 3   the aisle they are used from, and where two agents end up talking
 *   row + 4   free-standing furniture: tables, benches, armchairs
 *   row + 5   the seats under it, and the way to the door
 *   row + 6   the bottom wall, with the door through it
 * ```
 *
 * A kind that needs fewer rows simply ENDS EARLIER rather than being padded to
 * a common height: rooms are stacked into columns, so a row of padding in one
 * of them costs the storey a row of depth for nothing.
 */
const ROOM_FACE_ROW = 1;
const ROOM_FIXTURE_ROW = 2;
const ROOM_AISLE_ROW = 3;
const ROOM_TABLE_ROW = 4;
const ROOM_SEAT_ROW = 5;
/** A room with furniture on its table row: down to the seat row, plus its wall. */
const FURNISHED_ROOM_ROWS = ROOM_SEAT_ROW + 2;
/** A room whose fixtures all stand on the back wall: the aisle is its last row. */
const SHALLOW_ROOM_ROWS = ROOM_AISLE_ROW + 2;
/**
 * Narrower than this a room reads as a cupboard, so every kind takes it as a
 * floor whatever its own fixtures came to. It is also exactly what the break
 * room has always been, which is what keeps a small epic's storey the one it
 * has always had.
 */
const ROOM_MIN_COLS = 10;
/** The door goes in the bottom wall, two columns short of the right wall. */
const ROOM_DOOR_RIGHT_OFFSET = 3;
/** Left tile of a room's own two-tile name sign, clear of the menu board. */
const AREA_SIGN_COL_OFFSET = 4;
/** One corridor tile between two rooms, stacked or side by side. */
const ROOM_GAP_TILES = 1;
/**
 * Interior columns a storey keeps to the LEFT of its amenity columns, both
 * outer walls included: enough that the lobby, the counter and the way out are
 * never squeezed into the last few tiles of a floor that is all break room.
 */
const AMENITY_MIN_LEFT_COLS = 6;
/** How many agents a floor needs before each optional room appears. */
const NAP_MIN_AGENTS = 3;
const GARDEN_MIN_AGENTS = 6;
const GYM_MIN_AGENTS = 10;

/** The break room's three back-wall fixtures, two columns apart. */
const CAFETERIA_COFFEE_COL_OFFSET = 1;
const CAFETERIA_COOLER_COL_OFFSET = 3;
const CAFETERIA_VENDING_COL_OFFSET = 5;
/** A table is two tiles wide, and each of its tiles seats one agent. */
const CAFE_TABLE_WIDTH_TILES = 2;
const CAFETERIA_TABLE_COL_OFFSET = 1;
/** Two clear columns between tables, so the seat row can still be walked. */
const CAFE_TABLE_PITCH_TILES = 4;
/**
 * The sofas stand against the break room's back wall, past the vending machine,
 * with their seats on the aisle tiles in front. Two tiles wide like the tables,
 * so each seats a pair rather than one lounger.
 */
const CAFETERIA_SOFA_COL_OFFSET = 7;
const SOFA_WIDTH_TILES = 2;
const SOFA_PITCH_TILES = SOFA_WIDTH_TILES + 1;
/** Tables and sofas per head, floored and capped so neither runs off the wall. */
const CAFE_TABLES_PER_AGENT = 3;
const CAFE_MIN_TABLES = 2;
const CAFE_MAX_TABLES = 6;
const CAFE_SOFAS_PER_AGENT = 6;
const CAFE_MIN_SOFAS = 1;
const CAFE_MAX_SOFAS = 3;

/**
 * The game room. The ping-pong table and the arcade cabinet are always there;
 * the rest arrives as the floor fills up, because a foosball table nobody has a
 * second player for is furniture rather than a game.
 *
 * Its table row packs left to right, each piece with a standing column either
 * side of it: those columns ARE the spots, which is what makes two players face
 * each other across the thing they are playing.
 */
const GAME_FOOSBALL_MIN_AGENTS = 4;
const GAME_CHESS_MIN_AGENTS = 8;
const GAME_ARCADE_COL_OFFSET = 1;
const PINGPONG_TABLE_WIDTH_TILES = 2;
const FOOSBALL_WIDTH_TILES = 2;
const CHESS_WIDTH_TILES = 1;
/** First standing column of the table row, then one clear column per group. */
const GAME_TABLE_FIRST_COL = 1;
const GAME_TABLE_GROUP_GAP = 1;
/** The dartboard hangs on the wall face; its throwing line is two rows below. */
const GAME_DARTBOARD_COL_OFFSET = 7;
const DARTS_SPOT_ROW_OFFSET = 2;
/** The television, with its own sofa under it and the console seats in front. */
const GAME_TV_COL_OFFSET = 9;

/** The nap room: bags in a grid, a clear row under each so every one is reachable. */
const NAP_BAGS_PER_AGENT = 3;
const NAP_MIN_BAGS = 2;
const NAP_MAX_BAGS = 6;
const NAP_BAGS_PER_ROW = 3;
const NAP_BAG_PITCH_TILES = 2;
const NAP_BAG_COL_OFFSET = 1;

/** The library: bookcases along the back wall, armchairs out on the floor. */
const LIBRARY_BOOKCASES_PER_AGENT = 8;
const LIBRARY_MIN_BOOKCASES = 3;
const LIBRARY_MAX_BOOKCASES = 5;
const LIBRARY_BOOKCASE_COL_OFFSET = 1;
const LIBRARY_CHAIRS_PER_AGENT = 4;
const LIBRARY_MIN_CHAIRS = 1;
const LIBRARY_MAX_CHAIRS = 4;
const LIBRARY_CHAIR_COL_OFFSET = 1;
const LIBRARY_CHAIR_PITCH_TILES = 2;

/** The garden: grass under a hedge, trees along the back, benches to sit on. */
const GARDEN_TREES_PER_AGENT = 10;
const GARDEN_MIN_TREES = 2;
const GARDEN_MAX_TREES = 4;
const GARDEN_TREE_COL_OFFSET = 1;
const GARDEN_TREE_PITCH_TILES = 2;
const GARDEN_BENCHES_PER_AGENT = 5;
const GARDEN_MIN_BENCHES = 1;
const GARDEN_MAX_BENCHES = 3;
const GARDEN_BENCH_COL_OFFSET = 1;
const BENCH_WIDTH_TILES = 2;
const GARDEN_BENCH_PITCH_TILES = BENCH_WIDTH_TILES + 1;
/** Places to simply stand on the grass, spread along the garden's own aisle. */
const GARDEN_STROLL_COL_OFFSETS: ReadonlyArray<number> = [2, 5, 8];
const GARDEN_THIRD_STROLL_MIN_AGENTS = 12;

/** The gym: treadmills against the back wall, one clear row to step on from. */
const GYM_TREADMILLS_PER_AGENT = 6;
const GYM_MIN_TREADMILLS = 1;
const GYM_MAX_TREADMILLS = 3;
const GYM_TREADMILL_COL_OFFSET = 1;
const GYM_TREADMILL_PITCH_TILES = 2;

/** Fallback fittings, on a floor with no room for a cafeteria. */
const CORNER_COFFEE_COL_OFFSET = 3;
const CORNER_COOLER_COL_OFFSET = 5;

/**
 * The waste bin, in the manager desk's own slot: the spare column past the
 * plant, on the desk row. Deliberately NOT the cabin's left aisle column -
 * that column is how a character gets between slot rows, and a bin standing in
 * it would wall a cabin's lower desks off from its door.
 */
const BIN_COL_OFFSET = 3;
/** The bin's throwing line: the cabin aisle two rows under it, looking up. */
const BIN_SPOT_ROW_OFFSET = 2;

/** How many corridor spots one floor offers, and how wide the sample is. */
const MAX_CORRIDOR_SPOTS = 4;
/** More than three windows to stand at reads as a floor with nothing else to do. */
const MAX_WINDOW_SPOTS = 3;

// ---- Amenity sizing --------------------------------------------------- //

/**
 * How many of a thing a floor of this size gets: one per `perAgent` heads,
 * never fewer than `low` and never more than `high`. Every amenity count is
 * drawn through this one function so a floor cannot end up with a room that
 * scales on a rule of its own.
 */
function scaledCount(
  agents: number,
  perAgent: number,
  low: number,
  high: number,
): number {
  return Math.min(high, Math.max(low, Math.ceil(agents / perAgent)));
}

/**
 * The size and contents of one amenity, decided BEFORE anything is placed. The
 * storey's width and depth are reserved from these, and the placement pass
 * reads the same values back - a room that measured itself twice could land
 * outside the wall that was widened for it.
 */
interface AmenitySpecBase {
  readonly kind: OfficeAmenityKind;
  /** Written on the room's sign and carried on `OfficeAmenity`. */
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
}

interface CafeteriaSpec extends AmenitySpecBase {
  readonly kind: "cafeteria";
  readonly tables: number;
  readonly sofas: number;
}

interface GameSpec extends AmenitySpecBase {
  readonly kind: "game";
  readonly foosball: boolean;
  readonly chess: boolean;
}

interface NapSpec extends AmenitySpecBase {
  readonly kind: "nap";
  readonly bags: number;
}

interface LibrarySpec extends AmenitySpecBase {
  readonly kind: "library";
  readonly bookcases: number;
  readonly chairs: number;
}

interface GardenSpec extends AmenitySpecBase {
  readonly kind: "garden";
  readonly trees: number;
  readonly benches: number;
  readonly strolls: number;
}

interface GymSpec extends AmenitySpecBase {
  readonly kind: "gym";
  readonly treadmills: number;
}

type AmenitySpec =
  | CafeteriaSpec
  | GameSpec
  | NapSpec
  | LibrarySpec
  | GardenSpec
  | GymSpec;

/** The width a room needs to hold a run of fixtures, plus its two walls. */
function colsForLastFixture(lastCol: number): number {
  return Math.max(ROOM_MIN_COLS, lastCol + 2);
}

/** Left column of the `index`th fixture in a run laid at a fixed pitch. */
function pitchedCol(first: number, pitch: number, index: number): number {
  return first + index * pitch;
}

function cafeteriaSpecFor(agents: number): CafeteriaSpec {
  const tables = scaledCount(
    agents,
    CAFE_TABLES_PER_AGENT,
    CAFE_MIN_TABLES,
    CAFE_MAX_TABLES,
  );
  const sofas = scaledCount(
    agents,
    CAFE_SOFAS_PER_AGENT,
    CAFE_MIN_SOFAS,
    CAFE_MAX_SOFAS,
  );
  const lastTable =
    pitchedCol(CAFETERIA_TABLE_COL_OFFSET, CAFE_TABLE_PITCH_TILES, tables - 1) +
    CAFE_TABLE_WIDTH_TILES -
    1;
  const lastSofa =
    pitchedCol(CAFETERIA_SOFA_COL_OFFSET, SOFA_PITCH_TILES, sofas - 1) +
    SOFA_WIDTH_TILES -
    1;
  return {
    kind: "cafeteria",
    name: "Cafeteria",
    tables,
    sofas,
    cols: colsForLastFixture(Math.max(lastTable, lastSofa)),
    rows: FURNISHED_ROOM_ROWS,
  };
}

/**
 * Where each piece on the game room's table row starts, packed left to right
 * with a standing column either side of every piece. Returned as one shape so
 * the sizing pass and the placement pass can never disagree about the packing.
 */
interface GameTableColumns {
  readonly pingpong: number;
  readonly foosball: number | null;
  readonly chess: number | null;
  /** The right-hand standing column of the last piece. */
  readonly last: number;
}

function gameTableColumnsOf(spec: GameSpec): GameTableColumns {
  // A group is a standing column, the piece itself, and a second standing
  // column: `width + 2`, and then a clear column before the next group.
  const stride = (width: number): number => width + 2 + GAME_TABLE_GROUP_GAP;
  let cursor = GAME_TABLE_FIRST_COL;
  const pingpong = cursor + 1;
  cursor += stride(PINGPONG_TABLE_WIDTH_TILES);
  let foosball: number | null = null;
  if (spec.foosball) {
    foosball = cursor + 1;
    cursor += stride(FOOSBALL_WIDTH_TILES);
  }
  let chess: number | null = null;
  if (spec.chess) {
    chess = cursor + 1;
    cursor += stride(CHESS_WIDTH_TILES);
  }
  return {
    pingpong,
    foosball,
    chess,
    // The last group's right-hand standing column, the trailing gap undone.
    last: cursor - GAME_TABLE_GROUP_GAP - 1,
  };
}

function gameSpecFor(agents: number): GameSpec {
  const sized: GameSpec = {
    kind: "game",
    name: "Game room",
    foosball: agents >= GAME_FOOSBALL_MIN_AGENTS,
    chess: agents >= GAME_CHESS_MIN_AGENTS,
    cols: ROOM_MIN_COLS,
    rows: FURNISHED_ROOM_ROWS,
  };
  const tables = gameTableColumnsOf(sized);
  // The television is the right-most thing on the wall face and its sofa
  // stands under it, so the room has to be wide enough for both. Everything
  // mounted on that wall arrives with a table on the row below, so a room that
  // has only the cabinet in it is measured on the cabinet.
  const lastMounted = sized.chess
    ? GAME_TV_COL_OFFSET + SOFA_WIDTH_TILES - 1
    : GAME_DARTBOARD_COL_OFFSET;
  const lastFixture = sized.foosball ? lastMounted : GAME_ARCADE_COL_OFFSET;
  return {
    ...sized,
    cols: colsForLastFixture(Math.max(tables.last, lastFixture)),
  };
}

function napSpecFor(agents: number): NapSpec {
  const bags = scaledCount(
    agents,
    NAP_BAGS_PER_AGENT,
    NAP_MIN_BAGS,
    NAP_MAX_BAGS,
  );
  const bagRows = Math.ceil(bags / NAP_BAGS_PER_ROW);
  const lastBag = pitchedCol(
    NAP_BAG_COL_OFFSET,
    NAP_BAG_PITCH_TILES,
    Math.min(bags, NAP_BAGS_PER_ROW) - 1,
  );
  return {
    kind: "nap",
    name: "Nap room",
    bags,
    cols: colsForLastFixture(lastBag),
    // A clear row under every row of bags, the last of them included: a bag is
    // walked ONTO, and a row of them backed straight onto the wall would be
    // reachable only across the bags beside it.
    rows: ROOM_FIXTURE_ROW + bagRows * NAP_BAG_PITCH_TILES + 1,
  };
}

function librarySpecFor(agents: number): LibrarySpec {
  const bookcases = scaledCount(
    agents,
    LIBRARY_BOOKCASES_PER_AGENT,
    LIBRARY_MIN_BOOKCASES,
    LIBRARY_MAX_BOOKCASES,
  );
  const chairs = scaledCount(
    agents,
    LIBRARY_CHAIRS_PER_AGENT,
    LIBRARY_MIN_CHAIRS,
    LIBRARY_MAX_CHAIRS,
  );
  const lastCase = LIBRARY_BOOKCASE_COL_OFFSET + bookcases - 1;
  const lastChair = pitchedCol(
    LIBRARY_CHAIR_COL_OFFSET,
    LIBRARY_CHAIR_PITCH_TILES,
    chairs - 1,
  );
  return {
    kind: "library",
    name: "Library",
    bookcases,
    chairs,
    cols: colsForLastFixture(Math.max(lastCase, lastChair)),
    rows: FURNISHED_ROOM_ROWS,
  };
}

function gardenSpecFor(agents: number): GardenSpec {
  const trees = scaledCount(
    agents,
    GARDEN_TREES_PER_AGENT,
    GARDEN_MIN_TREES,
    GARDEN_MAX_TREES,
  );
  const benches = scaledCount(
    agents,
    GARDEN_BENCHES_PER_AGENT,
    GARDEN_MIN_BENCHES,
    GARDEN_MAX_BENCHES,
  );
  const lastTree = pitchedCol(
    GARDEN_TREE_COL_OFFSET,
    GARDEN_TREE_PITCH_TILES,
    trees - 1,
  );
  const lastBench =
    pitchedCol(GARDEN_BENCH_COL_OFFSET, GARDEN_BENCH_PITCH_TILES, benches - 1) +
    BENCH_WIDTH_TILES -
    1;
  return {
    kind: "garden",
    name: "Garden",
    trees,
    benches,
    strolls:
      agents >= GARDEN_THIRD_STROLL_MIN_AGENTS
        ? GARDEN_STROLL_COL_OFFSETS.length
        : GARDEN_STROLL_COL_OFFSETS.length - 1,
    cols: colsForLastFixture(Math.max(lastTree, lastBench)),
    rows: FURNISHED_ROOM_ROWS,
  };
}

function gymSpecFor(agents: number): GymSpec {
  const treadmills = scaledCount(
    agents,
    GYM_TREADMILLS_PER_AGENT,
    GYM_MIN_TREADMILLS,
    GYM_MAX_TREADMILLS,
  );
  return {
    kind: "gym",
    name: "Gym",
    treadmills,
    cols: colsForLastFixture(
      pitchedCol(
        GYM_TREADMILL_COL_OFFSET,
        GYM_TREADMILL_PITCH_TILES,
        treadmills - 1,
      ),
    ),
    rows: SHALLOW_ROOM_ROWS,
  };
}

/**
 * Which rooms this floor gets, in the order they stack down its columns.
 *
 * The cafeteria, the game room and the library are unconditional: a floor with
 * nowhere to eat, nothing to play and nothing to read is the still office all
 * of this exists to replace. The rest are earned, because a room whose whole
 * point is that several agents use it reads as abandoned on a floor of two.
 */
function amenitySpecsFor(agents: number): ReadonlyArray<AmenitySpec> {
  const specs: AmenitySpec[] = [cafeteriaSpecFor(agents), gameSpecFor(agents)];
  if (agents >= NAP_MIN_AGENTS) specs.push(napSpecFor(agents));
  specs.push(librarySpecFor(agents));
  if (agents >= GARDEN_MIN_AGENTS) specs.push(gardenSpecFor(agents));
  if (agents >= GYM_MIN_AGENTS) specs.push(gymSpecFor(agents));
  return specs;
}

/** One room's slot in the reserved columns, before the building's width is known. */
interface AmenityPlacement {
  readonly spec: AmenitySpec;
  /** Columns between this room's RIGHT edge and the storey's right interior edge. */
  readonly rightOffset: number;
  /** Absolute row of the room's own cap. */
  readonly row: number;
}

interface AmenityPacking {
  readonly placements: ReadonlyArray<AmenityPlacement>;
  /** Total width the columns claim, gaps between them included. */
  readonly width: number;
}

/** A run of rooms stacked one under the other, corridor rows included. */
function stackedHeight(specs: ReadonlyArray<AmenitySpec>): number {
  let height = 0;
  for (const spec of specs) height += spec.rows + ROOM_GAP_TILES;
  return Math.max(0, height - ROOM_GAP_TILES);
}

/**
 * The shortest column that holds these rooms in at most TWO columns.
 *
 * Two is the cap because past it the building is wider than it is readable, so
 * a storey is DEEPENED to fit its rooms rather than widened again - which costs
 * a small floor some empty corridor along its bottom, and that is the cheaper
 * of the two.
 *
 * Every split of the list into two contiguous runs is tried and the best one
 * wins. Greedy packing at that height can only put MORE rooms in the first
 * column than the winning split did, so whatever is left is a suffix of the
 * split's second run and fits under the same ceiling - which is what makes one
 * measurement here enough for the packer below.
 */
function minColumnHeight(specs: ReadonlyArray<AmenitySpec>): number {
  let best = stackedHeight(specs);
  for (let split = 1; split < specs.length; split += 1) {
    const height = Math.max(
      stackedHeight(specs.slice(0, split)),
      stackedHeight(specs.slice(split)),
    );
    best = Math.min(best, height);
  }
  return best;
}

/**
 * Stacks the rooms down the reserved columns, opening a NEW column to the left
 * whenever the next one would run past the storey's last usable row. A column
 * is as wide as its widest room, so a narrow gym does not reserve a break
 * room's width for the whole storey.
 */
function packAmenities(
  specs: ReadonlyArray<AmenitySpec>,
  firstRow: number,
  lastRow: number,
): AmenityPacking {
  const placements: AmenityPlacement[] = [];
  let rightOffset = 0;
  let columnCols = 0;
  let row = firstRow;
  for (const spec of specs) {
    if (columnCols > 0 && row + spec.rows - 1 > lastRow) {
      rightOffset += columnCols + ROOM_GAP_TILES;
      columnCols = 0;
      row = firstRow;
    }
    placements.push({ spec, rightOffset, row });
    columnCols = Math.max(columnCols, spec.cols);
    row += spec.rows + ROOM_GAP_TILES;
  }
  return { placements, width: rightOffset + columnCols };
}

interface Forest {
  /** Agents with no parent on this floor, in `(createdAt, id)` order. */
  readonly roots: ReadonlyArray<OfficeAgentInput>;
  readonly childrenByParent: ReadonlyMap<
    string,
    ReadonlyArray<OfficeAgentInput>
  >;
}

/**
 * One agent's subtree, sized as a rectangle.
 *
 * A leaf is one desk slot. An agent with children is a BLOCK: its own slot at
 * the top-left, its children's blocks packed into rows underneath, and enough
 * room around them that the whole thing can be walked. A block whose agent has
 * children becomes a POD when it is placed - drawn with a tinted floor and an
 * outline, so a sub-team reads as a region without the cabin becoming two rooms.
 *
 * Two pieces of slack are what make the packing routable, and neither is
 * decoration:
 *
 * - a GAP ROW after the lead's slot and after every pack row, so the bottom
 *   edge of any child block always touches free floor;
 * - an AISLE COLUMN down the right of every block's interior, so those gap rows
 *   are joined to each other and to the block's own opening.
 *
 * Without them a pod that filled its parent's width would seal off everything
 * below it, and the desks down there would be drawn but unreachable.
 */
interface BlockPlan {
  readonly agent: OfficeAgentInput;
  readonly children: ReadonlyArray<BlockPlan>;
  /** How many child blocks sit side by side before the pack wraps. */
  readonly perRow: number;
  /** Interior size, excluding the outline this block gets when it is a pod. */
  readonly cols: number;
  readonly rows: number;
  /** An agent with children; a leaf is only ever a desk slot. */
  readonly isPod: boolean;
}

interface CabinPlan {
  readonly root: OfficeAgentInput;
  /** The root's whole subtree, packed. */
  readonly block: BlockPlan;
  readonly cols: number;
  readonly rows: number;
}

interface PlacedCabin extends CabinPlan {
  /** Top-left tile of the cabin's outer wall, in this storey's own rows. */
  readonly col: number;
  readonly row: number;
}

/** One host's storey, planned in its own rows before the stack is offset. */
interface FloorBuild {
  readonly hostId: string | null;
  readonly cabins: ReadonlyArray<PlacedCabin>;
  readonly localCols: number;
  readonly localRows: number;
  /** Row this storey's `wall-top` cap lands on in the finished plan. */
  readonly originRow: number;
  /**
   * This storey's amenity rooms, already packed into their columns. Carried
   * rather than recomputed: the width reservation and the placement read the
   * same answer or a room lands outside the wall that was widened for it.
   */
  readonly amenities: ReadonlyArray<AmenityPlacement>;
}

function compareByCreation(
  left: OfficeAgentInput,
  right: OfficeAgentInput,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * An agent whose `parentId` names someone outside the set is a root here - the
 * creator is not on this floor, so there is no cabin to sit inside.
 */
function buildForest(agents: ReadonlyArray<OfficeAgentInput>): Forest {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenByParent = new Map<string, OfficeAgentInput[]>();
  const roots: OfficeAgentInput[] = [];
  for (const agent of agents) {
    const parentId = agent.parentId;
    if (parentId === null || parentId === agent.id || !byId.has(parentId)) {
      roots.push(agent);
      continue;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) childrenByParent.set(parentId, [agent]);
    else siblings.push(agent);
  }
  roots.sort(compareByCreation);
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareByCreation);
  }
  return { roots, childrenByParent };
}

/**
 * A stable, dependency-free spread over agent ids, for the choices the PLAN
 * makes - which outline a pod wears, which tint it starts on.
 *
 * The same FNV-1a the scene uses for its own per-agent variety, and
 * deliberately a second copy rather than a shared import: the floor plan must
 * not depend on the simulation, and one of the two changing its mixing is not
 * a reason for the other to move every desk.
 */
function hashAgentId(agentId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** What a child block costs its parent, outline included where it has one. */
function footprintOf(block: BlockPlan): {
  readonly cols: number;
  readonly rows: number;
} {
  const margin = block.isPod ? POD_OUTLINE_TILES * 2 : 0;
  return { cols: block.cols + margin, rows: block.rows + margin };
}

/** The child blocks of one pack row, `perRow` at a time. */
function packRowsOf(
  children: ReadonlyArray<BlockPlan>,
  perRow: number,
): ReadonlyArray<ReadonlyArray<BlockPlan>> {
  const rows: BlockPlan[][] = [];
  for (let index = 0; index < children.length; index += perRow) {
    rows.push(children.slice(index, index + perRow));
  }
  return rows;
}

/**
 * Sizes one agent's subtree from the bottom up. A leaf is a slot; anything else
 * is its own slot plus the rectangle its children pack into, grown toward a
 * square so a large family does not become a corridor.
 */
function blockPlanFor(
  agent: OfficeAgentInput,
  forest: Forest,
  claimed: Set<string>,
): BlockPlan {
  claimed.add(agent.id);
  const children: BlockPlan[] = [];
  for (const child of forest.childrenByParent.get(agent.id) ?? []) {
    // A reparenting cycle can name a child that is already somebody's: it keeps
    // the first desk it was given rather than being drawn twice.
    if (claimed.has(child.id)) continue;
    children.push(blockPlanFor(child, forest, claimed));
  }
  if (children.length === 0) {
    return {
      agent,
      children,
      perRow: 1,
      cols: SLOT_COLS,
      rows: SLOT_ROWS,
      isPod: false,
    };
  }
  const perRow = Math.min(
    CABIN_MAX_SLOTS_PER_ROW,
    Math.max(CABIN_MIN_SLOTS_PER_ROW, Math.ceil(Math.sqrt(children.length))),
  );
  let contentCols = 0;
  let contentRows = 0;
  for (const packRow of packRowsOf(children, perRow)) {
    let rowCols = 0;
    let rowRows = 0;
    for (const child of packRow) {
      const footprint = footprintOf(child);
      // Every block is followed by a free column, so two siblings' outlines
      // never touch and there is always a way between them.
      rowCols += footprint.cols + BLOCK_GAP_TILES;
      rowRows = Math.max(rowRows, footprint.rows);
    }
    contentCols = Math.max(contentCols, rowCols);
    contentRows += rowRows + BLOCK_GAP_TILES;
  }
  return {
    agent,
    children,
    perRow,
    cols: Math.max(SLOT_COLS, contentCols) + BLOCK_AISLE_COLS,
    rows: SLOT_ROWS + BLOCK_GAP_TILES + contentRows,
    isPod: true,
  };
}

/**
 * One cabin per root, each holding its whole subtree in depth-first order.
 *
 * Reparenting can leave a cycle in the recorded lineage, which has no root to
 * be reached from. Those agents are claimed afterwards in the same canonical
 * order, each opening its own cabin - an odd floor plan rather than a hang, and
 * still every agent with a desk.
 */
function cabinPlans(
  forest: Forest,
  agents: ReadonlyArray<OfficeAgentInput>,
): ReadonlyArray<CabinPlan> {
  const claimed = new Set<string>();
  const plans: CabinPlan[] = [];
  const collect = (root: OfficeAgentInput): void => {
    if (claimed.has(root.id)) return;
    const block = blockPlanFor(root, forest, claimed);
    plans.push({
      root,
      block,
      cols: block.cols + CABIN_AISLE_COLS + CABIN_SIDE_WALL_COLS,
      rows: block.rows + CABIN_AISLE_ROWS + CABIN_WALL_ROWS,
    });
  };
  for (const root of forest.roots) collect(root);
  for (const agent of [...agents].sort(compareByCreation)) collect(agent);
  return plans;
}

/**
 * Cabins tile left to right into bands, top-aligned, wrapping when the band
 * would outgrow the floor's width budget. Order is fixed by the plan list, so
 * a later agent joining a family grows that family's cabin without moving any
 * cabin that was already placed before it.
 */
function placeCabins(
  plans: ReadonlyArray<CabinPlan>,
  totalSlots: number,
): ReadonlyArray<PlacedCabin> {
  const bandLimit = Math.max(
    MIN_BAND_WIDTH_TILES,
    Math.ceil(Math.sqrt(totalSlots)) * BAND_WIDTH_PER_SLOT,
  );
  const placed: PlacedCabin[] = [];
  let col = BUILDING_FIRST_CONTENT_COL;
  let row = BUILDING_FIRST_CONTENT_ROW;
  let bandRows = 0;
  for (const plan of plans) {
    const wouldSpan = col - BUILDING_FIRST_CONTENT_COL + plan.cols;
    // A cabin wider than the whole budget still gets its own band rather than
    // an empty one above it.
    if (bandRows > 0 && wouldSpan > bandLimit) {
      col = BUILDING_FIRST_CONTENT_COL;
      row += bandRows + CABIN_GAP_TILES;
      bandRows = 0;
    }
    placed.push({ ...plan, col, row });
    bandRows = Math.max(bandRows, plan.rows);
    col += plan.cols + CABIN_GAP_TILES;
  }
  return placed;
}

/**
 * Agents split into storeys, one per host, in host-id order with the
 * hostless group last.
 *
 * `null` is its OWN group rather than being folded into some arbitrary host:
 * a record that predates host binding is not evidence that it lived on the
 * alphabetically-first machine.
 */
function groupByHost(agents: ReadonlyArray<OfficeAgentInput>): ReadonlyArray<{
  readonly hostId: string | null;
  readonly agents: ReadonlyArray<OfficeAgentInput>;
}> {
  const byHost = new Map<string, OfficeAgentInput[]>();
  const hostless: OfficeAgentInput[] = [];
  for (const agent of agents) {
    const hostId = agent.hostId;
    if (hostId === null) {
      hostless.push(agent);
      continue;
    }
    const group = byHost.get(hostId);
    if (group === undefined) byHost.set(hostId, [agent]);
    else group.push(agent);
  }
  const groups: Array<{
    readonly hostId: string | null;
    readonly agents: ReadonlyArray<OfficeAgentInput>;
  }> = [];
  for (const hostId of Array.from(byHost.keys()).sort()) {
    const group = byHost.get(hostId);
    if (group === undefined) continue;
    groups.push({ hostId, agents: group });
  }
  if (hostless.length > 0) groups.push({ hostId: null, agents: hostless });
  return groups;
}

/** Plans every storey in its own rows, then stacks them sharing a wall row. */
function buildFloors(
  agents: ReadonlyArray<OfficeAgentInput>,
): ReadonlyArray<FloorBuild> {
  const groups = groupByHost(agents);
  const shapes =
    groups.length === 0
      ? [{ hostId: null, agents: [] as ReadonlyArray<OfficeAgentInput> }]
      : groups;
  const builds: FloorBuild[] = [];
  let originRow = 0;
  for (const group of shapes) {
    const forest = buildForest(group.agents);
    const cabins = placeCabins(
      cabinPlans(forest, group.agents),
      group.agents.length,
    );
    let contentRight = 0;
    let contentBottom = 0;
    for (const cabin of cabins) {
      contentRight = Math.max(contentRight, cabin.col + cabin.cols - 1);
      contentBottom = Math.max(contentBottom, cabin.row + cabin.rows - 1);
    }
    // The amenities' footprint is reserved here rather than claimed later: they
    // stand to the RIGHT of every cabin band, and a room fitted into leftover
    // space would move whenever a family grew.
    //
    // They are not a reward for having enough agents either: a one-agent epic
    // is exactly where an empty floor reads as broken, so the storey is widened
    // AND deepened to fit its rooms whatever the cabins came to. Only the
    // EMPTY-epic room opts out - it has no floor to furnish.
    const specs =
      cabins.length === 0 ? [] : amenitySpecsFor(group.agents.length);
    const localRows =
      cabins.length === 0
        ? EMPTY_ROOM_ROWS
        : Math.max(
            contentBottom + BUILDING_BOTTOM_MARGIN_TILES,
            // The cap, the wall face, the rooms, and the corridor row the
            // lowest room's door opens onto.
            BUILDING_TOP_WALL_ROWS + minColumnHeight(specs) + 2,
          );
    const packing = packAmenities(
      specs,
      originRow + BUILDING_TOP_WALL_ROWS,
      originRow + localRows - 2,
    );
    const localCols =
      cabins.length === 0
        ? EMPTY_ROOM_COLS
        : Math.max(
            contentRight + BUILDING_RIGHT_MARGIN_TILES + packing.width,
            packing.width + AMENITY_MIN_LEFT_COLS,
          );
    builds.push({
      hostId: group.hostId,
      cabins,
      localCols,
      localRows,
      originRow,
      amenities: packing.placements,
    });
    // The storey below reuses this one's bottom wall as its own cap, so the
    // two buildings read as one block rather than as a seam of dead rows.
    originRow += localRows - 1;
  }
  return builds;
}

/**
 * Walls everywhere a storey has one, and nowhere else. Two storeys meet on a
 * SHARED row, which is a wall in both readings - that shared row plus the wall
 * face under it is what makes `walkable` unable to join two floors.
 */
function blankWalkableGrid(
  cols: number,
  rows: number,
  floors: ReadonlyArray<FloorBuild>,
): boolean[][] {
  const wallRows = new Set<number>();
  for (const floor of floors) {
    for (let offset = 0; offset < BUILDING_TOP_WALL_ROWS; offset += 1) {
      wallRows.add(floor.originRow + offset);
    }
    wallRows.add(floor.originRow + floor.localRows - 1);
  }
  const grid: boolean[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < cols; col += 1) {
      const isWall = wallRows.has(row) || col === 0 || col === cols - 1;
      line.push(!isWall);
    }
    grid.push(line);
  }
  return grid;
}

/** The cabin's own wall ring, minus the one tile its door opens through. */
function blockCabinWalls(walkable: boolean[][], room: OfficeRoom): void {
  const { col, row, cols, rows } = room.bounds;
  const right = col + cols - 1;
  const bottom = row + rows - 1;
  for (let scanCol = col; scanCol <= right; scanCol += 1) {
    for (let topRow = row; topRow < row + CABIN_TOP_WALL_ROWS; topRow += 1) {
      walkable[topRow][scanCol] = false;
    }
    walkable[bottom][scanCol] = false;
  }
  for (
    let scanRow = row + CABIN_TOP_WALL_ROWS;
    scanRow < bottom;
    scanRow += 1
  ) {
    walkable[scanRow][col] = false;
    walkable[scanRow][right] = false;
  }
  walkable[room.doorTile.row][room.doorTile.col] = true;
}

/**
 * Standing room at the counter, nearest first.
 *
 * The BELL is at the counter's right end, so the queue forms on that side and
 * only spreads left once the right has run out - somebody waiting for
 * attention stands where the attention is.
 *
 * Only tiles that are actually walkable survive, so a floor whose cabins come
 * down close to the lobby simply offers fewer places to wait rather than
 * queueing people into a wall.
 */
function receptionQueueTiles(
  walkable: ReadonlyArray<ReadonlyArray<boolean>>,
  counter: OfficeTilePos,
  doorTile: OfficeTilePos,
  lobbyTile: OfficeTilePos,
): ReadonlyArray<OfficeTilePos> {
  const counterCol = counter.col;
  const lobbyRow = counter.row;
  const bellCol = counterCol + RECEPTION_WIDTH_TILES - 1;
  const candidates: OfficeTilePos[] = [
    { col: bellCol, row: lobbyRow - 1 },
    { col: bellCol + 1, row: lobbyRow },
    { col: bellCol + 1, row: lobbyRow - 1 },
    { col: counterCol, row: lobbyRow - 1 },
  ];
  for (let spread = 2; spread <= MAX_RECEPTION_QUEUE_TILES; spread += 1) {
    candidates.push({ col: bellCol + spread, row: lobbyRow });
    candidates.push({ col: counterCol - (spread - 1), row: lobbyRow });
    candidates.push({ col: bellCol + spread, row: lobbyRow - 1 });
    candidates.push({ col: counterCol - (spread - 1), row: lobbyRow - 1 });
  }
  const tiles: OfficeTilePos[] = [];
  for (const tile of candidates) {
    if (tiles.length >= MAX_RECEPTION_QUEUE_TILES) break;
    if (tile.row < 0 || tile.row >= walkable.length) continue;
    if (tile.col < 0 || tile.col >= walkable[tile.row].length) continue;
    if (!walkable[tile.row][tile.col]) continue;
    if (tile.col === doorTile.col && tile.row === doorTile.row) continue;
    if (tile.col === lobbyTile.col && tile.row === lobbyTile.row) continue;
    if (
      tiles.some((chosen) => chosen.col === tile.col && chosen.row === tile.row)
    ) {
      continue;
    }
    tiles.push(tile);
  }
  return tiles;
}

/**
 * The stairwell's top-left tile, or `null` where this floor has no room for
 * one. Blocks the two-by-two footprint as a side effect: a stairwell is not
 * walkable, and it is what keeps `walkable` from joining two floors.
 */
function placeStairwell(args: {
  readonly cols: number;
  readonly lobbyRow: number;
  readonly originRow: number;
  readonly blockTile: (tile: OfficeTilePos) => void;
}): OfficeTilePos | null {
  const { blockTile, cols, lobbyRow, originRow } = args;
  const col = cols - 1 - STAIRS_TILES;
  const row = lobbyRow - (STAIRS_TILES - 1);
  if (col <= 0 || row <= originRow + 1) return null;
  for (let dCol = 0; dCol < STAIRS_TILES; dCol += 1) {
    for (let dRow = 0; dRow < STAIRS_TILES; dRow += 1) {
      blockTile({ col: col + dCol, row: row + dRow });
    }
  }
  return { col, row };
}

// ---- Fitting out a storey -------------------------------------------- //

/**
 * The mutable half of the plan, threaded through every fitting-out pass. Props
 * and walkability move together: nearly everything placed on a floor is a thing
 * you cannot walk through, and keeping the two in one value is what stops a
 * prop from being drawn over a tile agents still route across.
 */
interface PlanContext {
  readonly cols: number;
  readonly rows: number;
  readonly props: OfficeProp[];
  readonly walkable: boolean[][];
}

/** Deterministic expansion order, matching the path finder's. */
const FLOOD_OFFSETS: ReadonlyArray<OfficeTilePos> = [
  { col: 0, row: -1 },
  { col: 0, row: 1 },
  { col: -1, row: 0 },
  { col: 1, row: 0 },
];

function tileKey(tile: OfficeTilePos): string {
  return `${tile.col},${tile.row}`;
}

function withinRect(bounds: OfficeTileRect, tile: OfficeTilePos): boolean {
  return (
    tile.col >= bounds.col &&
    tile.col < bounds.col + bounds.cols &&
    tile.row >= bounds.row &&
    tile.row < bounds.row + bounds.rows
  );
}

function blockPlanTile(context: PlanContext, tile: OfficeTilePos): void {
  if (tile.row < 0 || tile.row >= context.rows) return;
  if (tile.col < 0 || tile.col >= context.cols) return;
  context.walkable[tile.row][tile.col] = false;
}

function addBlockingProp(context: PlanContext, prop: OfficeProp): void {
  context.props.push(prop);
  blockPlanTile(context, prop.tile);
}

/**
 * Every tile a walker can get to from `start`. One flood per storey answers the
 * question every errand spot has to pass - a spot behind a wall is a spot the
 * scene would send someone to and never see them arrive.
 */
function reachableFrom(
  context: PlanContext,
  start: OfficeTilePos,
): ReadonlySet<string> {
  const seen = new Set<string>();
  if (start.row < 0 || start.row >= context.rows) return seen;
  if (start.col < 0 || start.col >= context.cols) return seen;
  if (!context.walkable[start.row][start.col]) return seen;
  const queue: OfficeTilePos[] = [start];
  seen.add(tileKey(start));
  let head = 0;
  while (head < queue.length) {
    const tile = queue[head];
    head += 1;
    for (const offset of FLOOD_OFFSETS) {
      const next: OfficeTilePos = {
        col: tile.col + offset.col,
        row: tile.row + offset.row,
      };
      if (next.row < 0 || next.row >= context.rows) continue;
      if (next.col < 0 || next.col >= context.cols) continue;
      if (!context.walkable[next.row][next.col]) continue;
      const key = tileKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * One amenity as PLACED: the spec that sized it, its outer bounds, its single
 * door and the tile its name sign hangs on. Every fixture inside it is derived
 * from the spec and these bounds on demand rather than stored, so the pass that
 * stands the furniture up and the pass that lays the errand spots over it can
 * only ever be reading the same arithmetic.
 */
interface AmenityPlan {
  readonly spec: AmenitySpec;
  readonly bounds: OfficeTileRect;
  readonly doorTile: OfficeTilePos;
  readonly signTile: OfficeTilePos;
}

/**
 * The corner fittings a floor with no amenities keeps instead.
 *
 * Reachable only by the EMPTY-epic room now that every furnished storey is
 * widened to fit its rooms. Kept for exactly that case: a room with no agents
 * still wants something in the corner, and it has no cabins to widen around.
 */
interface CornerFittings {
  readonly coffeeTile: OfficeTilePos;
  readonly coolerTile: OfficeTilePos | null;
}

/**
 * Turns a packed placement into real tiles, once the building's final width is
 * known. Rooms hug the RIGHT interior edge, so the offset the packer recorded
 * is measured from there rather than from the storey's own width - a narrow
 * storey in a tall building still lines its rooms up with everyone else's.
 */
function planAmenity(placement: AmenityPlacement, cols: number): AmenityPlan {
  const { spec } = placement;
  const col = cols - 2 - placement.rightOffset - (spec.cols - 1);
  const bounds: OfficeTileRect = {
    col,
    row: placement.row,
    cols: spec.cols,
    rows: spec.rows,
  };
  return {
    spec,
    bounds,
    // In the bottom wall, two columns short of the right one, so the way out is
    // never the way past somebody eating.
    doorTile: {
      col: col + spec.cols - ROOM_DOOR_RIGHT_OFFSET,
      row: placement.row + spec.rows - 1,
    },
    signTile: {
      col: col + AREA_SIGN_COL_OFFSET,
      row: placement.row + ROOM_FACE_ROW,
    },
  };
}

/** A run of `count` fixtures laid at a fixed pitch along one of a room's rows. */
function pitchedTiles(
  bounds: OfficeTileRect,
  row: number,
  first: number,
  run: { readonly count: number; readonly pitch: number },
): ReadonlyArray<OfficeTilePos> {
  const tiles: OfficeTilePos[] = [];
  for (let index = 0; index < run.count; index += 1) {
    tiles.push({
      col: bounds.col + pitchedCol(first, run.pitch, index),
      row: bounds.row + row,
    });
  }
  return tiles;
}

function cafeteriaTableTiles(
  spec: CafeteriaSpec,
  bounds: OfficeTileRect,
): ReadonlyArray<OfficeTilePos> {
  return pitchedTiles(bounds, ROOM_TABLE_ROW, CAFETERIA_TABLE_COL_OFFSET, {
    count: spec.tables,
    pitch: CAFE_TABLE_PITCH_TILES,
  });
}

function cafeteriaSofaTiles(
  spec: CafeteriaSpec,
  bounds: OfficeTileRect,
): ReadonlyArray<OfficeTilePos> {
  return pitchedTiles(bounds, ROOM_FIXTURE_ROW, CAFETERIA_SOFA_COL_OFFSET, {
    count: spec.sofas,
    pitch: SOFA_PITCH_TILES,
  });
}

function napBagTiles(
  spec: NapSpec,
  bounds: OfficeTileRect,
): ReadonlyArray<OfficeTilePos> {
  const tiles: OfficeTilePos[] = [];
  for (let index = 0; index < spec.bags; index += 1) {
    tiles.push({
      col:
        bounds.col +
        pitchedCol(
          NAP_BAG_COL_OFFSET,
          NAP_BAG_PITCH_TILES,
          index % NAP_BAGS_PER_ROW,
        ),
      // A clear row between rows of bags: a bag is walked ONTO, so the one
      // behind it must not be the only way to reach it.
      row:
        bounds.row +
        ROOM_FIXTURE_ROW +
        Math.floor(index / NAP_BAGS_PER_ROW) * NAP_BAG_PITCH_TILES,
    });
  }
  return tiles;
}

function libraryBookcaseTiles(
  spec: LibrarySpec,
  bounds: OfficeTileRect,
): ReadonlyArray<OfficeTilePos> {
  return pitchedTiles(bounds, ROOM_FIXTURE_ROW, LIBRARY_BOOKCASE_COL_OFFSET, {
    count: spec.bookcases,
    pitch: 1,
  });
}

function libraryChairTiles(
  spec: LibrarySpec,
  bounds: OfficeTileRect,
): ReadonlyArray<OfficeTilePos> {
  return pitchedTiles(bounds, ROOM_TABLE_ROW, LIBRARY_CHAIR_COL_OFFSET, {
    count: spec.chairs,
    pitch: LIBRARY_CHAIR_PITCH_TILES,
  });
}

function gardenTreeTiles(
  spec: GardenSpec,
  bounds: OfficeTileRect,
): ReadonlyArray<OfficeTilePos> {
  return pitchedTiles(bounds, ROOM_FIXTURE_ROW, GARDEN_TREE_COL_OFFSET, {
    count: spec.trees,
    pitch: GARDEN_TREE_PITCH_TILES,
  });
}

function gardenBenchTiles(
  spec: GardenSpec,
  bounds: OfficeTileRect,
): ReadonlyArray<OfficeTilePos> {
  return pitchedTiles(bounds, ROOM_TABLE_ROW, GARDEN_BENCH_COL_OFFSET, {
    count: spec.benches,
    pitch: GARDEN_BENCH_PITCH_TILES,
  });
}

function gymTreadmillTiles(
  spec: GymSpec,
  bounds: OfficeTileRect,
): ReadonlyArray<OfficeTilePos> {
  return pitchedTiles(bounds, ROOM_FIXTURE_ROW, GYM_TREADMILL_COL_OFFSET, {
    count: spec.treadmills,
    pitch: GYM_TREADMILL_PITCH_TILES,
  });
}

/**
 * A walled room's own ring and its door, shared by every amenity. Mirrors a
 * cabin's - cap, wall face, sides, one walkable door - so the scene can paint
 * any of them with the same two sprites. The garden's hedge is the same ring;
 * only the sprite the scene reaches for differs.
 */
function buildRoomShell(
  context: PlanContext,
  bounds: OfficeTileRect,
  doorTile: OfficeTilePos,
): void {
  const { col, row, cols, rows } = bounds;
  const right = col + cols - 1;
  const bottom = row + rows - 1;
  for (let scanCol = col; scanCol <= right; scanCol += 1) {
    for (let top = row; top < row + CABIN_TOP_WALL_ROWS; top += 1) {
      blockPlanTile(context, { col: scanCol, row: top });
    }
    blockPlanTile(context, { col: scanCol, row: bottom });
  }
  for (
    let scanRow = row + CABIN_TOP_WALL_ROWS;
    scanRow < bottom;
    scanRow += 1
  ) {
    blockPlanTile(context, { col, row: scanRow });
    blockPlanTile(context, { col: right, row: scanRow });
  }
  context.walkable[doorTile.row][doorTile.col] = true;
}

/** A two-tile-wide piece of furniture: drawn from its left tile, blocked across. */
function addWideProp(
  context: PlanContext,
  sprite: OfficeSpriteName,
  tile: OfficeTilePos,
  widthTiles: number,
): void {
  context.props.push({ sprite: { name: sprite }, tile });
  for (let offset = 0; offset < widthTiles; offset += 1) {
    blockPlanTile(context, { col: tile.col + offset, row: tile.row });
  }
}

/**
 * Furniture a character stands or lies ON rather than beside: a sleeping bag,
 * an armchair, a treadmill. Its tile stays WALKABLE, because the errand spot is
 * that same tile - a spot the grid calls solid is a spot the flood cannot
 * reach and `addSpot` refuses outright.
 *
 * Two agents never share one, because the scene claims a spot's tile for as
 * long as its errand lasts.
 */
function addOccupiableProp(context: PlanContext, prop: OfficeProp): void {
  context.props.push(prop);
}

/** The break room's fittings: the machines on the back wall, tables to eat at. */
function buildCafeteria(
  context: PlanContext,
  spec: CafeteriaSpec,
  bounds: OfficeTileRect,
): void {
  const { col, row } = bounds;
  const fixtureRow = row + ROOM_FIXTURE_ROW;
  // On the wall face over the coffee machine, exactly where a cabin hangs its
  // sign - the board is what says which of the three fixtures is the coffee.
  addBlockingProp(context, {
    sprite: { name: "menu-board" },
    tile: { col: col + CAFETERIA_COFFEE_COL_OFFSET, row: row + ROOM_FACE_ROW },
  });
  addBlockingProp(context, {
    sprite: { name: "coffee-machine" },
    tile: { col: col + CAFETERIA_COFFEE_COL_OFFSET, row: fixtureRow },
  });
  addBlockingProp(context, {
    sprite: { name: "water-cooler" },
    tile: { col: col + CAFETERIA_COOLER_COL_OFFSET, row: fixtureRow },
  });
  addBlockingProp(context, {
    sprite: { name: "vending" },
    tile: { col: col + CAFETERIA_VENDING_COL_OFFSET, row: fixtureRow },
  });
  for (const tile of cafeteriaTableTiles(spec, bounds)) {
    addWideProp(context, "cafe-table", tile, CAFE_TABLE_WIDTH_TILES);
  }
  // Two tiles wide like a table, and blocked across both: a sofa is furniture
  // you sit ON from the front, never a tile the room routes through.
  for (const tile of cafeteriaSofaTiles(spec, bounds)) {
    addWideProp(context, "sofa", tile, SOFA_WIDTH_TILES);
  }
}

/**
 * The game room's fittings. The cabinet and the ping-pong table are always
 * there; the foosball table, the dartboard, the chess table and the television
 * arrive with the floor's population.
 */
function buildGameRoom(
  context: PlanContext,
  spec: GameSpec,
  bounds: OfficeTileRect,
): void {
  const { col, row } = bounds;
  addBlockingProp(context, {
    sprite: { name: "arcade" },
    tile: { col: col + GAME_ARCADE_COL_OFFSET, row: row + ROOM_FIXTURE_ROW },
  });
  const tables = gameTableColumnsOf(spec);
  const tableRow = row + ROOM_TABLE_ROW;
  addWideProp(
    context,
    "pingpong-table",
    { col: col + tables.pingpong, row: tableRow },
    PINGPONG_TABLE_WIDTH_TILES,
  );
  const foosball = tables.foosball;
  if (foosball !== null) {
    addWideProp(
      context,
      "foosball",
      { col: col + foosball, row: tableRow },
      FOOSBALL_WIDTH_TILES,
    );
    addBlockingProp(context, {
      sprite: { name: "dartboard" },
      tile: { col: col + GAME_DARTBOARD_COL_OFFSET, row: row + ROOM_FACE_ROW },
    });
  }
  const chess = tables.chess;
  if (chess === null) return;
  addWideProp(
    context,
    "chess-table",
    { col: col + chess, row: tableRow },
    CHESS_WIDTH_TILES,
  );
  addBlockingProp(context, {
    sprite: { name: "tv" },
    tile: { col: col + GAME_TV_COL_OFFSET, row: row + ROOM_FACE_ROW },
  });
  addWideProp(
    context,
    "sofa",
    { col: col + GAME_TV_COL_OFFSET, row: row + ROOM_FIXTURE_ROW },
    SOFA_WIDTH_TILES,
  );
}

/** Bags in a grid, each one a tile an agent lies down ON. */
function buildNapRoom(
  context: PlanContext,
  spec: NapSpec,
  bounds: OfficeTileRect,
): void {
  for (const tile of napBagTiles(spec, bounds)) {
    addOccupiableProp(context, { sprite: { name: "sleep-bag" }, tile });
  }
}

/** Bookcases along the back wall, armchairs out in front of them. */
function buildLibrary(
  context: PlanContext,
  spec: LibrarySpec,
  bounds: OfficeTileRect,
): void {
  for (const tile of libraryBookcaseTiles(spec, bounds)) {
    addBlockingProp(context, { sprite: { name: "bookcase" }, tile });
  }
  for (const tile of libraryChairTiles(spec, bounds)) {
    addOccupiableProp(context, { sprite: { name: "armchair" }, tile });
  }
}

/** Trees along the back of the garden, benches to sit on in front of them. */
function buildGarden(
  context: PlanContext,
  spec: GardenSpec,
  bounds: OfficeTileRect,
): void {
  for (const tile of gardenTreeTiles(spec, bounds)) {
    addBlockingProp(context, { sprite: { name: "tree" }, tile });
  }
  for (const tile of gardenBenchTiles(spec, bounds)) {
    addWideProp(context, "bench", tile, BENCH_WIDTH_TILES);
  }
}

/** Treadmills against the back wall, each one a tile an agent runs ON. */
function buildGym(
  context: PlanContext,
  spec: GymSpec,
  bounds: OfficeTileRect,
): void {
  for (const tile of gymTreadmillTiles(spec, bounds)) {
    addOccupiableProp(context, { sprite: { name: "treadmill" }, tile });
  }
}

/** The ring every amenity wears, and then whatever that kind stands inside it. */
function buildAmenity(context: PlanContext, plan: AmenityPlan): void {
  buildRoomShell(context, plan.bounds, plan.doorTile);
  const { spec } = plan;
  if (spec.kind === "cafeteria") buildCafeteria(context, spec, plan.bounds);
  else if (spec.kind === "game") buildGameRoom(context, spec, plan.bounds);
  else if (spec.kind === "nap") buildNapRoom(context, spec, plan.bounds);
  else if (spec.kind === "library") buildLibrary(context, spec, plan.bounds);
  else if (spec.kind === "garden") buildGarden(context, spec, plan.bounds);
  else buildGym(context, spec, plan.bounds);
}

/**
 * What a floor with no room for a cafeteria gets: the machine in the corner it
 * always stood in, and the cooler two columns along so the pair still has an
 * aisle tile each to be used from.
 */
function buildCornerFittings(
  context: PlanContext,
  build: FloorBuild,
): CornerFittings {
  const row = build.originRow + BUILDING_TOP_WALL_ROWS;
  const coffeeTile: OfficeTilePos = {
    col: context.cols - CORNER_COFFEE_COL_OFFSET,
    row,
  };
  addBlockingProp(context, {
    sprite: { name: "coffee-machine" },
    tile: coffeeTile,
  });
  const coolerCol = context.cols - CORNER_COOLER_COL_OFFSET;
  if (coolerCol <= 0) return { coffeeTile, coolerTile: null };
  const coolerTile: OfficeTilePos = { col: coolerCol, row };
  addBlockingProp(context, {
    sprite: { name: "water-cooler" },
    tile: coolerTile,
  });
  return { coffeeTile, coolerTile };
}

// ---- Errand spots ----------------------------------------------------- //

interface SpotBuilder {
  readonly context: PlanContext;
  readonly spots: OfficeErrandSpot[];
  readonly used: Set<string>;
  /** Tiles the floor already owes to something else: the door, the lobby, the queue. */
  readonly blocked: ReadonlySet<string>;
  readonly reachable: ReadonlySet<string>;
}

interface ErrandSpotRequest {
  readonly context: PlanContext;
  readonly build: FloorBuild;
  readonly lobbyTile: OfficeTilePos;
  readonly blocked: ReadonlySet<string>;
  readonly amenities: ReadonlyArray<AmenityPlan>;
  readonly corner: CornerFittings | null;
  readonly rooms: ReadonlyArray<OfficeRoom>;
  readonly stairsTile: OfficeTilePos | null;
}

/**
 * Records one spot, or refuses it. Every refusal is a case that would otherwise
 * become a character standing in a wall, on a desk, or in the queue somebody
 * else is waiting in.
 */
function addSpot(
  builder: SpotBuilder,
  kind: OfficeErrandSpot["kind"],
  tile: OfficeTilePos,
  facing: OfficeFacing,
): boolean {
  const { context } = builder;
  if (tile.row < 0 || tile.row >= context.rows) return false;
  if (tile.col < 0 || tile.col >= context.cols) return false;
  if (!context.walkable[tile.row][tile.col]) return false;
  const key = tileKey(tile);
  if (builder.used.has(key)) return false;
  if (builder.blocked.has(key)) return false;
  if (!builder.reachable.has(key)) return false;
  builder.used.add(key);
  builder.spots.push({ kind, tile, facing });
  return true;
}

function addCafeteriaSpots(
  builder: SpotBuilder,
  spec: CafeteriaSpec,
  bounds: OfficeTileRect,
): void {
  const aisleRow = bounds.row + ROOM_AISLE_ROW;
  addSpot(
    builder,
    "coffee",
    { col: bounds.col + CAFETERIA_COFFEE_COL_OFFSET, row: aisleRow },
    "up",
  );
  // TWO cooler spots, side by side and turned toward each other: a water cooler
  // is where two people talk, and a single spot can only ever hold a monologue.
  const coolerCol = bounds.col + CAFETERIA_COOLER_COL_OFFSET;
  addSpot(builder, "cooler", { col: coolerCol, row: aisleRow }, "right");
  addSpot(builder, "cooler", { col: coolerCol + 1, row: aisleRow }, "left");
  addSpot(
    builder,
    "vending",
    { col: bounds.col + CAFETERIA_VENDING_COL_OFFSET, row: aisleRow },
    "up",
  );
  for (const table of cafeteriaTableTiles(spec, bounds)) {
    for (let offset = 0; offset < CAFE_TABLE_WIDTH_TILES; offset += 1) {
      addSpot(
        builder,
        "cafe",
        { col: table.col + offset, row: bounds.row + ROOM_SEAT_ROW },
        "up",
      );
    }
  }
  // One seat per sofa tile, on the aisle in front of it. The facing looks AT
  // the sofa, as every spot's does; the scene turns whoever sits down back
  // toward the room, which is the way a person on a sofa actually faces.
  for (const sofa of cafeteriaSofaTiles(spec, bounds)) {
    for (let offset = 0; offset < SOFA_WIDTH_TILES; offset += 1) {
      addSpot(builder, "sofa", { col: sofa.col + offset, row: aisleRow }, "up");
    }
  }
}

/**
 * The two standing columns either side of a piece on the game room's table row,
 * turned toward EACH OTHER rather than toward the table - the same arrangement
 * the cooler pair uses, and for the same reason: these are the errands that are
 * two people rather than one.
 */
function addFacingPair(
  builder: SpotBuilder,
  kind: OfficeErrandSpot["kind"],
  tile: OfficeTilePos,
  widthTiles: number,
): void {
  addSpot(builder, kind, { col: tile.col - 1, row: tile.row }, "right");
  addSpot(builder, kind, { col: tile.col + widthTiles, row: tile.row }, "left");
}

function addGameRoomSpots(
  builder: SpotBuilder,
  spec: GameSpec,
  bounds: OfficeTileRect,
): void {
  const tables = gameTableColumnsOf(spec);
  const tableRow = bounds.row + ROOM_TABLE_ROW;
  const aisleRow = bounds.row + ROOM_AISLE_ROW;
  addFacingPair(
    builder,
    "pingpong",
    { col: bounds.col + tables.pingpong, row: tableRow },
    PINGPONG_TABLE_WIDTH_TILES,
  );
  addSpot(
    builder,
    "arcade",
    { col: bounds.col + GAME_ARCADE_COL_OFFSET, row: aisleRow },
    "up",
  );
  const foosball = tables.foosball;
  if (foosball !== null) {
    addFacingPair(
      builder,
      "foosball",
      { col: bounds.col + foosball, row: tableRow },
      FOOSBALL_WIDTH_TILES,
    );
    // The throwing line, back from the board and looking up at it - the same
    // shape as a cabin's bin, so one toss reads like the other.
    addSpot(
      builder,
      "darts",
      {
        col: bounds.col + GAME_DARTBOARD_COL_OFFSET,
        row: bounds.row + ROOM_FACE_ROW + DARTS_SPOT_ROW_OFFSET,
      },
      "up",
    );
  }
  const chess = tables.chess;
  if (chess === null) return;
  addFacingPair(
    builder,
    "chess",
    { col: bounds.col + chess, row: tableRow },
    CHESS_WIDTH_TILES,
  );
  // On the aisle in front of the sofa, looking up at the television over it.
  for (let offset = 0; offset < SOFA_WIDTH_TILES; offset += 1) {
    addSpot(
      builder,
      "console",
      { col: bounds.col + GAME_TV_COL_OFFSET + offset, row: aisleRow },
      "up",
    );
  }
}

/**
 * A spot ON the fixture itself - the bag you lie on, the chair you read in, the
 * treadmill you walk on. The tile is the furniture, so the facing is where the
 * occupant ends up looking rather than what it is looking at.
 */
function addOccupiedSpots(
  builder: SpotBuilder,
  kind: OfficeErrandSpot["kind"],
  tiles: ReadonlyArray<OfficeTilePos>,
  facing: OfficeFacing,
): void {
  for (const tile of tiles) addSpot(builder, kind, tile, facing);
}

function addGardenSpots(
  builder: SpotBuilder,
  spec: GardenSpec,
  bounds: OfficeTileRect,
): void {
  // Sitting on a bench you face OUT over the garden, not into the backrest.
  for (const bench of gardenBenchTiles(spec, bounds)) {
    for (let offset = 0; offset < BENCH_WIDTH_TILES; offset += 1) {
      addSpot(
        builder,
        "garden",
        { col: bench.col + offset, row: bounds.row + ROOM_SEAT_ROW },
        "down",
      );
    }
  }
  for (let index = 0; index < spec.strolls; index += 1) {
    addSpot(
      builder,
      "garden",
      {
        col: bounds.col + GARDEN_STROLL_COL_OFFSETS[index],
        row: bounds.row + ROOM_AISLE_ROW,
      },
      "down",
    );
  }
}

/** Whatever this kind of room gives an idle agent to do, once it is standing. */
function addAmenitySpots(builder: SpotBuilder, plan: AmenityPlan): void {
  const { spec, bounds } = plan;
  if (spec.kind === "cafeteria") addCafeteriaSpots(builder, spec, bounds);
  else if (spec.kind === "game") addGameRoomSpots(builder, spec, bounds);
  else if (spec.kind === "nap") {
    addOccupiedSpots(builder, "nap", napBagTiles(spec, bounds), "down");
  } else if (spec.kind === "library") {
    addOccupiedSpots(builder, "read", libraryChairTiles(spec, bounds), "down");
  } else if (spec.kind === "garden") addGardenSpots(builder, spec, bounds);
  else {
    addOccupiedSpots(
      builder,
      "treadmill",
      gymTreadmillTiles(spec, bounds),
      "up",
    );
  }
}

function addCornerSpots(builder: SpotBuilder, corner: CornerFittings): void {
  addSpot(
    builder,
    "coffee",
    { col: corner.coffeeTile.col, row: corner.coffeeTile.row + 1 },
    "up",
  );
  const cooler = corner.coolerTile;
  if (cooler === null) return;
  addSpot(builder, "cooler", { col: cooler.col, row: cooler.row + 1 }, "right");
  addSpot(
    builder,
    "cooler",
    { col: cooler.col + 1, row: cooler.row + 1 },
    "left",
  );
}

/** The aisle under the storey's own wall face, where its fittings hang. */
function addWallSpots(builder: SpotBuilder, build: FloorBuild): void {
  const faceRow = build.originRow + 1;
  const aisleRow = build.originRow + BUILDING_TOP_WALL_ROWS;
  for (const prop of builder.context.props) {
    if (prop.tile.row !== faceRow) continue;
    if (prop.sprite.name !== "whiteboard") continue;
    addSpot(builder, "whiteboard", { col: prop.tile.col, row: aisleRow }, "up");
  }
  let windows = 0;
  for (const prop of builder.context.props) {
    if (windows >= MAX_WINDOW_SPOTS) break;
    if (prop.tile.row !== faceRow) continue;
    if (prop.sprite.name !== "window") continue;
    const added = addSpot(
      builder,
      "window",
      { col: prop.tile.col, row: aisleRow },
      "up",
    );
    if (added) windows += 1;
  }
}

/**
 * Two spots per cabin plant, stacked under it. The near one is where you stand
 * to WATER it, close enough that a can held at the hand reaches the leaves; the
 * far one is the older errand of simply standing and looking at it, moved a row
 * back so the two can never be the same tile.
 */
function addPlantSpots(builder: SpotBuilder, build: FloorBuild): void {
  const top = build.originRow;
  const bottom = top + build.localRows - 1;
  for (const prop of builder.context.props) {
    if (prop.sprite.name !== "plant") continue;
    if (prop.tile.row < top || prop.tile.row > bottom) continue;
    addSpot(
      builder,
      "water-plant",
      { col: prop.tile.col, row: prop.tile.row + 1 },
      "up",
    );
    addSpot(
      builder,
      "plant",
      { col: prop.tile.col, row: prop.tile.row + 2 },
      "up",
    );
  }
}

/** One throwing line per cabin bin: the aisle two rows under it, looking up. */
function addBinSpots(builder: SpotBuilder, build: FloorBuild): void {
  const top = build.originRow;
  const bottom = top + build.localRows - 1;
  for (const prop of builder.context.props) {
    if (prop.sprite.name !== "bin") continue;
    if (prop.tile.row < top || prop.tile.row > bottom) continue;
    addSpot(
      builder,
      "bin",
      { col: prop.tile.col, row: prop.tile.row + BIN_SPOT_ROW_OFFSET },
      "up",
    );
  }
}

/**
 * The corridor tile directly outside each cabin's door, looking in. A peek is
 * paid to SOMEBODY ELSE'S room - the scene is what refuses an agent its own
 * doorway, because the plan does not know who is idle.
 */
function addPeekSpots(
  builder: SpotBuilder,
  build: FloorBuild,
  rooms: ReadonlyArray<OfficeRoom>,
): void {
  const top = build.originRow;
  const bottom = top + build.localRows - 1;
  for (const room of rooms) {
    const door = room.doorTile;
    if (door.row < top || door.row > bottom) continue;
    addSpot(builder, "peek", { col: door.col, row: door.row + 1 }, "up");
  }
}

/**
 * Beside the stairwell, looking at it. Only a stacked building has one, so a
 * single-floor epic simply offers no such spot - which is what makes the errand
 * multi-floor-only without the scene having to count storeys.
 */
function addStairsSpot(
  builder: SpotBuilder,
  stairsTile: OfficeTilePos | null,
): void {
  if (stairsTile === null) return;
  // Left of the well, on each of the two rows it spans: the first that is
  // walkable wins, and a well hard against furniture simply offers none.
  for (let offset = 0; offset < STAIRS_TILES; offset += 1) {
    const tile: OfficeTilePos = {
      col: stairsTile.col - 1,
      row: stairsTile.row + offset,
    };
    if (addSpot(builder, "stairs", tile, "right")) return;
  }
}

/**
 * A handful of places to simply stand, sampled evenly across the floor's
 * columns. Column-major order is what makes "evenly spaced index" mean "spread
 * left to right" rather than "four tiles of the same corridor".
 */
function addCorridorSpots(
  builder: SpotBuilder,
  request: ErrandSpotRequest,
): void {
  const { context, build } = request;
  const firstRow = build.originRow + BUILDING_TOP_WALL_ROWS + 1;
  const lobbyRow = request.lobbyTile.row;
  const candidates: OfficeTilePos[] = [];
  for (let col = 1; col < context.cols - 1; col += 1) {
    for (let row = firstRow; row < lobbyRow; row += 1) {
      if (!context.walkable[row][col]) continue;
      const tile: OfficeTilePos = { col, row };
      const key = tileKey(tile);
      if (builder.used.has(key) || builder.blocked.has(key)) continue;
      if (!builder.reachable.has(key)) continue;
      if (request.rooms.some((room) => withinRect(room.bounds, tile))) continue;
      // Inside an amenity you are AT that amenity; a corridor spot in the nap
      // room would have somebody standing between the beds doing nothing.
      if (request.amenities.some((plan) => withinRect(plan.bounds, tile))) {
        continue;
      }
      candidates.push(tile);
    }
  }
  if (candidates.length === 0) return;
  const wanted = Math.min(MAX_CORRIDOR_SPOTS, candidates.length);
  const span = candidates.length - 1;
  for (let index = 0; index < wanted; index += 1) {
    const pick = wanted === 1 ? 0 : Math.floor((index * span) / (wanted - 1));
    addSpot(builder, "corridor", candidates[pick], "down");
  }
}

function errandSpotsFor(
  request: ErrandSpotRequest,
): ReadonlyArray<OfficeErrandSpot> {
  const builder: SpotBuilder = {
    context: request.context,
    spots: [],
    used: new Set<string>(),
    blocked: request.blocked,
    // Reachability is asked from the LOBBY rather than from each desk: the
    // corridor that reaches every chair is the same one that reaches the lobby,
    // so one flood answers for the whole storey.
    reachable: reachableFrom(request.context, request.lobbyTile),
  };
  const corner = request.corner;
  if (corner !== null) addCornerSpots(builder, corner);
  for (const plan of request.amenities) addAmenitySpots(builder, plan);
  addWallSpots(builder, request.build);
  addPlantSpots(builder, request.build);
  addBinSpots(builder, request.build);
  addPeekSpots(builder, request.build, request.rooms);
  addStairsSpot(builder, request.stairsTile);
  // Last, so a corridor sample can never take a tile one of the named spots
  // above was going to want.
  addCorridorSpots(builder, request);
  return builder.spots;
}

// ---- Assembly --------------------------------------------------------- //

/**
 * Everything one recursive walk produces: a desk per agent and a pod per agent
 * that has children.
 */
interface PlacedBlocks {
  readonly desks: Map<string, OfficeDesk>;
  readonly pods: OfficePod[];
}

/**
 * Which outline a lead's child pods wear, and which tint they take.
 *
 * STYLE round-robins from a seeded start, so the first three pods under one
 * lead are always three different outlines - with three styles that is the most
 * that can be promised, and promising it for the first two only would be
 * weaker for no gain. It deliberately does NOT exclude the parent's style: with
 * one excluded there would be two left, and three siblings could not all
 * differ.
 *
 * TINT is what keeps nesting legible instead, alternating every level so a pod
 * inside a pod never shares its parent's floor.
 */
function podStyleAt(
  leadId: string,
  depth: number,
  index: number,
): OfficePodStyle {
  const start = hashAgentId(`${leadId}:${depth}`) % POD_STYLES.length;
  return POD_STYLES[(start + index) % POD_STYLES.length];
}

function podTintAt(depth: number, rootId: string): "cool" | "warm" {
  const warmFirst = hashAgentId(rootId) % 2 === 1;
  const even = depth % 2 === 1;
  return even === warmFirst ? "warm" : "cool";
}

interface PlaceBlockRequest {
  readonly block: BlockPlan;
  readonly tile: OfficeTilePos;
  readonly depth: number;
  readonly rootId: string;
}

/**
 * Walks one block into desks and pods. The lead takes the slot at the top-left
 * of its own interior; its children pack into rows underneath, each pod inset by
 * its outline so the ring has a tile of its own to sit on.
 */
function placeBlock(request: PlaceBlockRequest, out: PlacedBlocks): void {
  const { block, tile, depth, rootId } = request;
  out.desks.set(block.agent.id, {
    agentId: block.agent.id,
    deskTile: { col: tile.col, row: tile.row },
    chairTile: { col: tile.col, row: tile.row + 1 },
    // The cabin's own root, and nobody else: a pod lead heads a region, which
    // its outline and plate already say. Keyed on the ROOT rather than on the
    // nesting depth, because a leaf child of the root sits at depth 0 too.
    manager: block.agent.id === rootId,
  });
  let row = tile.row + SLOT_ROWS + BLOCK_GAP_TILES;
  let podIndex = 0;
  for (const packRow of packRowsOf(block.children, block.perRow)) {
    let col = tile.col;
    let bandRows = 0;
    for (const child of packRow) {
      const footprint = footprintOf(child);
      bandRows = Math.max(bandRows, footprint.rows);
      if (child.isPod) {
        const inner: OfficeTilePos = {
          col: col + POD_OUTLINE_TILES,
          row: row + POD_OUTLINE_TILES,
        };
        out.pods.push({
          leadAgentId: child.agent.id,
          name: child.agent.name,
          depth: depth + 1,
          bounds: {
            col: inner.col,
            row: inner.row,
            cols: child.cols,
            rows: child.rows,
          },
          // The plate hangs on the ring itself, which is why `bounds` excludes
          // it: the interior is what the team works in.
          plateTile: { col, row },
          style: podStyleAt(block.agent.id, depth, podIndex),
          tint: podTintAt(depth + 1, rootId),
        });
        podIndex += 1;
        placeBlock(
          { block: child, tile: inner, depth: depth + 1, rootId },
          out,
        );
      } else {
        placeBlock({ block: child, tile: { col, row }, depth, rootId }, out);
      }
      col += footprint.cols + BLOCK_GAP_TILES;
    }
    row += bandRows + BLOCK_GAP_TILES;
  }
}

function collectCabins(
  builds: ReadonlyArray<FloorBuild>,
  desks: Map<string, OfficeDesk>,
  rooms: OfficeRoom[],
): void {
  for (const build of builds) {
    for (const cabin of build.cabins) {
      const cabinRow = cabin.row + build.originRow;
      const placed: PlacedBlocks = { desks, pods: [] };
      placeBlock(
        {
          block: cabin.block,
          tile: {
            col: cabin.col + CABIN_LEFT_WALL_COLS + CABIN_AISLE_COLS,
            row: cabinRow + CABIN_TOP_WALL_ROWS + CABIN_AISLE_ROWS,
          },
          depth: 0,
          rootId: cabin.root.id,
        },
        placed,
      );
      rooms.push({
        rootAgentId: cabin.root.id,
        name: cabin.root.name,
        pods: placed.pods,
        bounds: {
          col: cabin.col,
          row: cabinRow,
          cols: cabin.cols,
          rows: cabin.rows,
        },
        doorTile: {
          col: cabin.col + Math.floor((cabin.cols - 1) / 2),
          row: cabinRow + cabin.rows - 1,
        },
        signTile: { col: cabin.col + SIGN_COL_OFFSET, row: cabinRow + 1 },
      });
    }
  }
}

function blockDeskTiles(
  walkable: boolean[][],
  desks: ReadonlyMap<string, OfficeDesk>,
): void {
  for (const desk of desks.values()) {
    for (let offset = 0; offset < DESK_WIDTH_TILES; offset += 1) {
      walkable[desk.deskTile.row][desk.deskTile.col + offset] = false;
    }
    // Blocked in the GENERAL grid: a chair belongs to one agent. The path
    // finder is what grants an exception, by always allowing its own goal.
    walkable[desk.chairTile.row][desk.chairTile.col] = false;
  }
}

function addManagerPlants(
  context: PlanContext,
  desks: ReadonlyMap<string, OfficeDesk>,
): void {
  for (const desk of desks.values()) {
    if (!desk.manager) continue;
    addBlockingProp(context, {
      sprite: { name: "plant" },
      tile: {
        col: desk.deskTile.col + PLANT_COL_OFFSET,
        row: desk.deskTile.row,
      },
    });
  }
}

/**
 * One bin per cabin, in the manager's own slot: the spare column past the
 * plant, on the desk row. Every slot is five wide whether or not it holds a
 * plant, so that column exists in every cabin - and taking it leaves the
 * slot's LAST column free, which is the one a character uses to get between
 * slot rows when the cabin's left aisle is busy.
 *
 * Skipped where the tile is already spoken for, so a bin can never be the
 * thing that walls a desk off from its door.
 */
function addCabinBins(
  context: PlanContext,
  desks: ReadonlyMap<string, OfficeDesk>,
): void {
  for (const desk of desks.values()) {
    if (!desk.manager) continue;
    const tile: OfficeTilePos = {
      col: desk.deskTile.col + BIN_COL_OFFSET,
      row: desk.deskTile.row,
    };
    if (tile.col >= context.cols) continue;
    if (!context.walkable[tile.row][tile.col]) continue;
    addBlockingProp(context, { sprite: { name: "bin" }, tile });
  }
}

/**
 * A pod's outline: the ring of tiles around its interior, blocked so the region
 * reads as bounded, with ONE opening in the bottom edge on the interior's own
 * aisle column - which is the column every gap row inside the pod already runs
 * into, and the tile below it is the parent's gap row.
 *
 * The plate's tile is part of the ring and stays blocked; a plate is furniture
 * on the boundary, not a way in.
 */
function podOpeningOf(pod: OfficePod): OfficeTilePos {
  return {
    col: pod.bounds.col + pod.bounds.cols - BLOCK_AISLE_COLS,
    row: pod.bounds.row + pod.bounds.rows,
  };
}

function blockPodOutlines(
  context: PlanContext,
  rooms: ReadonlyArray<OfficeRoom>,
): void {
  for (const room of rooms) {
    for (const pod of room.pods) {
      const { col, row, cols, rows } = pod.bounds;
      const left = col - POD_OUTLINE_TILES;
      const top = row - POD_OUTLINE_TILES;
      const right = col + cols;
      const bottom = row + rows;
      for (let scanCol = left; scanCol <= right; scanCol += 1) {
        blockPlanTile(context, { col: scanCol, row: top });
        blockPlanTile(context, { col: scanCol, row: bottom });
      }
      for (let scanRow = top; scanRow <= bottom; scanRow += 1) {
        blockPlanTile(context, { col: left, row: scanRow });
        blockPlanTile(context, { col: right, row: scanRow });
      }
      const opening = podOpeningOf(pod);
      context.walkable[opening.row][opening.col] = true;
    }
  }
}

/**
 * Blocks every surviving pod's outline, after dropping any pod the cabin door
 * cannot reach the inside of - such a pod is emitted as plain slots instead, so
 * its desks stay part of the cabin rather than sitting behind a sealed wall.
 *
 * The packing is built not to produce one: every pod's opening sits on the
 * aisle its own gap rows run into, and the tile beyond it is the parent's gap
 * row. So this is the check that SAYS so rather than a case anyone has seen -
 * and it is worth its cost because the alternative failure is invisible on a
 * small epic and silently strands a whole sub-team on a large one.
 *
 * Each round tests on a COPY of the grid: a ring that has to come back off
 * cannot be un-blocked in place without also un-blocking whatever else shares
 * those tiles.
 */
function resolvePods(context: PlanContext, rooms: OfficeRoom[]): void {
  for (;;) {
    const trial: PlanContext = {
      cols: context.cols,
      rows: context.rows,
      props: [],
      walkable: context.walkable.map((line) => [...line]),
    };
    blockPodOutlines(trial, rooms);
    let dropped = false;
    for (let index = 0; index < rooms.length; index += 1) {
      const room = rooms[index];
      if (room.pods.length === 0) continue;
      const reachable = reachableFrom(trial, room.doorTile);
      const kept = room.pods.filter((pod) =>
        reachable.has(tileKey(podOpeningOf(pod))),
      );
      if (kept.length === room.pods.length) continue;
      rooms[index] = { ...room, pods: kept };
      dropped = true;
    }
    if (dropped) continue;
    blockPodOutlines(context, rooms);
    return;
  }
}

interface FloorFitRequest {
  readonly context: PlanContext;
  readonly build: FloorBuild;
  readonly doorCol: number;
  readonly multiFloor: boolean;
  readonly rooms: ReadonlyArray<OfficeRoom>;
}

/** The building's own fittings hang on the OUTER wall, clear of every cabin. */
function addWallFittings(
  context: PlanContext,
  wallFaceRow: number,
): OfficeTilePos {
  addBlockingProp(context, {
    sprite: { name: "whiteboard" },
    tile: { col: BUILDING_FIRST_CONTENT_COL, row: wallFaceRow },
  });
  const clockTile: OfficeTilePos = {
    col: BUILDING_FIRST_CONTENT_COL + CLOCK_COL_OFFSET,
    row: wallFaceRow,
  };
  addBlockingProp(context, { sprite: { name: "clock" }, tile: clockTile });
  for (
    let col = BUILDING_FIRST_CONTENT_COL + WINDOW_SPACING_TILES;
    col <= context.cols - 3;
    col += WINDOW_SPACING_TILES
  ) {
    addBlockingProp(context, {
      sprite: { name: "window" },
      tile: { col, row: wallFaceRow },
    });
  }
  return clockTile;
}

function fitFloor(request: FloorFitRequest): OfficeFloor {
  const { build, context, doorCol } = request;
  const bottomRow = build.originRow + build.localRows - 1;
  const doorTile: OfficeTilePos = { col: doorCol, row: bottomRow };
  const lobbyTile: OfficeTilePos = { col: doorCol, row: bottomRow - 1 };
  context.walkable[doorTile.row][doorTile.col] = true;

  const clockTile = addWallFittings(context, build.originRow + 1);
  // The rooms were sized and packed with the storey; all that is left here is
  // to turn each slot into tiles and stand its furniture up.
  const amenities = build.amenities.map((placement) =>
    planAmenity(placement, context.cols),
  );
  const corner =
    amenities.length === 0 ? buildCornerFittings(context, build) : null;
  for (const plan of amenities) buildAmenity(context, plan);

  // Reception stands on the lobby row, one clear tile short of the door so
  // nobody has to squeeze past the counter to get out.
  const counterCol = Math.max(
    1,
    doorCol - RECEPTION_DOOR_GAP_TILES - RECEPTION_WIDTH_TILES,
  );
  const receptionTile: OfficeTilePos = { col: counterCol, row: lobbyTile.row };
  context.props.push({ sprite: { name: "reception" }, tile: receptionTile });
  for (let offset = 0; offset < RECEPTION_WIDTH_TILES; offset += 1) {
    blockPlanTile(context, { col: counterCol + offset, row: lobbyTile.row });
  }
  const queueTiles = receptionQueueTiles(
    context.walkable,
    receptionTile,
    doorTile,
    lobbyTile,
  );

  // Decorative only: nobody walks between floors, so the stairwell is a
  // reminder that the building has more than one - never a route. It is FLOOR
  // rather than furniture, so it carries no prop entry: the scene paints it
  // with the floor layer, from this top-left tile.
  const stairsTile = request.multiFloor
    ? placeStairwell({
        cols: context.cols,
        lobbyRow: lobbyTile.row,
        originRow: build.originRow,
        blockTile: (tile) => blockPlanTile(context, tile),
      })
    : null;
  // The rug is the one prop a character may stand on - it marks the lobby.
  context.props.push({ sprite: { name: "rug" }, tile: lobbyTile });

  const blocked = new Set<string>([
    tileKey(doorTile),
    tileKey(lobbyTile),
    ...queueTiles.map(tileKey),
  ]);
  return {
    hostId: build.hostId,
    bounds: {
      col: 0,
      row: build.originRow,
      cols: context.cols,
      rows: build.localRows,
    },
    doorTile,
    lobbyTile,
    receptionTile,
    receptionQueueTiles: queueTiles,
    clockTile,
    stairsTile,
    errandSpots: errandSpotsFor({
      context,
      build,
      lobbyTile,
      blocked,
      amenities,
      corner,
      rooms: request.rooms,
      stairsTile,
    }),
    // The two rooms that predate the amenity list stay MIRRORED on their own
    // fields: everything that only knows about a break room keeps working.
    cafeteria: amenityBoundsOf(amenities, "cafeteria"),
    gameRoom: amenityBoundsOf(amenities, "game"),
    areaSigns: areaSignsFor(amenities),
    amenities: amenities.map((plan) => ({
      kind: plan.spec.kind,
      bounds: plan.bounds,
      doorTile: plan.doorTile,
      signTile: plan.signTile,
      name: plan.spec.name,
    })),
  };
}

/**
 * A name plate on each walled amenity's wall face, mounted exactly where a
 * cabin hangs its own sign. Two tiles along from the room's left wall, which is
 * left of both doors and clear of the menu board the break room already hangs
 * over its coffee machine.
 */
function areaSignsFor(
  amenities: ReadonlyArray<AmenityPlan>,
): ReadonlyArray<OfficeAreaSign> {
  return amenities.map((plan) => ({
    name: plan.spec.name,
    signTile: plan.signTile,
  }));
}

/** The bounds of the one room of this kind, for the fields that predate the list. */
function amenityBoundsOf(
  amenities: ReadonlyArray<AmenityPlan>,
  kind: OfficeAmenityKind,
): OfficeTileRect | null {
  const found = amenities.find((plan) => plan.spec.kind === kind);
  return found === undefined ? null : found.bounds;
}

export function layoutOffice(
  agents: ReadonlyArray<OfficeAgentInput>,
): OfficeLayout {
  const builds = buildFloors(agents);
  const last = builds[builds.length - 1];
  let cols = 0;
  for (const build of builds) cols = Math.max(cols, build.localCols);
  const rows = last.originRow + last.localRows;
  const doorCol = Math.floor((cols - 1) / 2);

  const desks = new Map<string, OfficeDesk>();
  const rooms: OfficeRoom[] = [];
  collectCabins(builds, desks, rooms);

  const walkable = blankWalkableGrid(cols, rows, builds);
  for (const room of rooms) blockCabinWalls(walkable, room);
  blockDeskTiles(walkable, desks);

  const context: PlanContext = { cols, rows, props: [], walkable };
  // Outlines first, and with only the walls and the desks standing: a pod is
  // kept or dropped on whether its cabin can reach INSIDE it, which is a
  // question about the room's structure rather than about its pot plants.
  resolvePods(context, rooms);
  // Before the storeys are fitted out, so a cabin's own furniture is already
  // standing when the errand spots are picked over the finished grid.
  addManagerPlants(context, desks);
  addCabinBins(context, desks);

  const multiFloor = builds.length > 1;
  const floors = builds.map((build) =>
    fitFloor({ context, build, doorCol, multiFloor, rooms }),
  );

  return {
    cols,
    rows,
    desks,
    rooms,
    floors,
    // The FIRST storey's entrance is the building's, so everything that only
    // knows about one door keeps working on a single-host epic.
    doorTile: floors[0].doorTile,
    lobbyTile: floors[0].lobbyTile,
    props: context.props,
    walkable,
  };
}
