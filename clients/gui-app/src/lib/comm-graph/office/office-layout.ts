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
  OfficeAreaSign,
  OfficeDesk,
  OfficeErrandSpot,
  OfficeFacing,
  OfficeFloor,
  OfficeLayout,
  OfficeProp,
  OfficeRoom,
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
/** A pod worth separating: an agent that itself created several agents. */
const SUB_CLUSTER_MIN_CHILDREN = 2;

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
 * The cafeteria: a walled break room in the storey's top-right corner, holding
 * everything an idle agent has a reason to walk to. Its footprint is RESERVED
 * out of the floor's width (see `buildFloors`) rather than fitted into whatever
 * gap the cabins happen to leave, because a break room that sometimes exists is
 * a break room the errand system cannot rely on.
 *
 * Interior columns run `col + 1` to `col + 8` and interior rows `row + 2` to
 * `row + 5`, laid out as:
 *
 * ```
 *   row + 1   wall face: the menu board, over the coffee machine
 *   row + 2   coffee machine .. water cooler .. vending machine
 *   row + 3   the aisle they are used from, and where two agents chat
 *   row + 4   two round tables
 *   row + 5   the seats under them, and the way to the door
 * ```
 */
const CAFETERIA_COLS = 10;
const CAFETERIA_ROWS = 7;
/** Left wall, three fixtures two apart, and the door's column clear of the stairs. */
const CAFETERIA_COFFEE_COL_OFFSET = 1;
const CAFETERIA_COOLER_COL_OFFSET = 3;
const CAFETERIA_VENDING_COL_OFFSET = 5;
const CAFETERIA_DOOR_COL_OFFSET = 7;
const CAFETERIA_TABLE_COL_OFFSETS: ReadonlyArray<number> = [1, 5];
/** Rows inside the room, measured from its own top-left. */
const CAFETERIA_FIXTURE_ROW = 2;
const CAFETERIA_AISLE_ROW = 3;
const CAFETERIA_TABLE_ROW = 4;
const CAFETERIA_SEAT_ROW = 5;
/**
 * Below this the storey is all cabin and corridor: dropping a ten-tile room into
 * it would seal the routes the cabins open onto. Such a floor keeps the older
 * corner fittings instead and reports `cafeteria: null`. After the widening
 * above, only the empty-epic room ever does.
 */
const CAFETERIA_MIN_INTERIOR_COLS = 14;
/**
 * The building width that interior minimum implies, counting both outer walls.
 * Every furnished storey is widened to at least this, so `planCafeteria` can
 * only fail on the empty-epic room.
 */
const CAFETERIA_MIN_BUILDING_COLS = CAFETERIA_MIN_INTERIOR_COLS + 2;
const CAFETERIA_MIN_FLOOR_ROWS = CAFETERIA_ROWS + 4;
/** Fallback fittings, when there is no room for a cafeteria. */
const CORNER_COFFEE_COL_OFFSET = 3;
const CORNER_COOLER_COL_OFFSET = 5;

/** A table is two tiles wide, and each of its tiles seats one agent. */
const CAFE_TABLE_WIDTH_TILES = 2;
/**
 * The sofa stands against the break room's RIGHT wall, on the fixture row past
 * the vending machine, with its two seats on the aisle tiles in front of it.
 * Two tiles wide like the tables, so it seats a pair rather than one lounger.
 */
const CAFETERIA_SOFA_COL_OFFSET = 7;
const SOFA_WIDTH_TILES = 2;
/**
 * The waste bin, in the manager desk's own slot: the spare column past the
 * plant, on the desk row. Deliberately NOT the cabin's left aisle column -
 * that column is how a character gets between slot rows, and a bin standing in
 * it would wall a cabin's lower desks off from its door.
 */
const BIN_COL_OFFSET = 3;
/** The bin's throwing line: the cabin aisle two rows under it, looking up. */
const BIN_SPOT_ROW_OFFSET = 2;

/**
 * The game room: a second walled room the same size as the cafeteria, holding
 * the ping-pong table, the arcade cabinet and a sofa.
 *
 * It goes DIRECTLY BELOW the break room where the storey is deep enough to
 * carry both, and BESIDE it where it is not - a tall thin building and a wide
 * flat one are both fine, but a room that only sometimes exists is a room the
 * errand engine cannot rely on. Which of the two happens is decided once, in
 * `buildFloors`, and carried on the storey so the reservation and the placement
 * can never disagree.
 *
 * ```
 *   row + 1   wall face: the room's own name sign
 *   row + 2   arcade cabinet .. .. .. .. sofa
 *   row + 3   the aisle they are used from
 *   row + 4   the ping-pong table, centred, with an end spot either side
 *   row + 5   the way to the door
 * ```
 */
const GAME_ROOM_COLS = CAFETERIA_COLS;
const GAME_ROOM_ROWS = CAFETERIA_ROWS;
/** One corridor tile between the two rooms, whichever way they are stacked. */
const ROOM_GAP_TILES = 1;
const GAME_ARCADE_COL_OFFSET = 1;
const GAME_SOFA_COL_OFFSET = 6;
const GAME_TABLE_COL_OFFSET = 4;
const GAME_FIXTURE_ROW = 2;
const GAME_AISLE_ROW = 3;
const GAME_TABLE_ROW = 4;
const GAME_DOOR_COL_OFFSET = 7;
/** The table is two tiles wide, and its ends are the tiles either side of it. */
const PINGPONG_TABLE_WIDTH_TILES = 2;
/**
 * Storey depth that fits the game room UNDER the break room: both rooms, the
 * corridor between them, and one more below for the lower room's door to open
 * onto. Short of it the pair goes side by side instead, which costs width.
 */
const STACKED_ROOMS_MIN_FLOOR_ROWS =
  BUILDING_TOP_WALL_ROWS + CAFETERIA_ROWS + ROOM_GAP_TILES + GAME_ROOM_ROWS + 2;
/** The building width the side-by-side arrangement needs, both outer walls in. */
const SIDE_BY_SIDE_MIN_BUILDING_COLS =
  CAFETERIA_MIN_BUILDING_COLS + GAME_ROOM_COLS + ROOM_GAP_TILES;
/** Left tile of a room's own two-tile name sign, clear of the menu board. */
const AREA_SIGN_COL_OFFSET = 4;
/** How many corridor spots one floor offers, and how wide the sample is. */
const MAX_CORRIDOR_SPOTS = 4;
/** More than three windows to stand at reads as a floor with nothing else to do. */
const MAX_WINDOW_SPOTS = 3;

interface Forest {
  /** Agents with no parent on this floor, in `(createdAt, id)` order. */
  readonly roots: ReadonlyArray<OfficeAgentInput>;
  readonly childrenByParent: ReadonlyMap<
    string,
    ReadonlyArray<OfficeAgentInput>
  >;
}

interface CabinPlan {
  readonly root: OfficeAgentInput;
  /** The root first, then its subtree depth-first. One desk slot each. */
  readonly members: ReadonlyArray<OfficeAgentInput>;
  readonly perRow: number;
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
  readonly forest: Forest;
  readonly cabins: ReadonlyArray<PlacedCabin>;
  readonly localCols: number;
  readonly localRows: number;
  /** Row this storey's `wall-top` cap lands on in the finished plan. */
  readonly originRow: number;
  /**
   * Whether the game room goes under the break room rather than beside it.
   * Decided with the storey's size, and carried rather than recomputed: the
   * width reservation and the placement read the same answer or the room lands
   * outside the wall that was widened for it.
   */
  readonly gameBelow: boolean;
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

function cabinShape(size: number): {
  readonly perRow: number;
  readonly cols: number;
  readonly rows: number;
} {
  const perRow = Math.min(
    CABIN_MAX_SLOTS_PER_ROW,
    Math.max(CABIN_MIN_SLOTS_PER_ROW, Math.ceil(Math.sqrt(size))),
  );
  const slotRows = Math.ceil(size / perRow);
  return {
    perRow,
    cols: perRow * SLOT_COLS + CABIN_AISLE_COLS + CABIN_SIDE_WALL_COLS,
    rows: slotRows * SLOT_ROWS + CABIN_AISLE_ROWS + CABIN_WALL_ROWS,
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
    const members: OfficeAgentInput[] = [];
    // Explicit stack rather than recursion: lineage depth is user-controlled.
    const stack: OfficeAgentInput[] = [root];
    for (;;) {
      const agent = stack.pop();
      if (agent === undefined) break;
      if (claimed.has(agent.id)) continue;
      claimed.add(agent.id);
      members.push(agent);
      const children = forest.childrenByParent.get(agent.id);
      if (children === undefined) continue;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
    }
    plans.push({ root, members, ...cabinShape(members.length) });
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
    // The cafeteria's width is reserved here rather than claimed later: it
    // stands to the RIGHT of every cabin band, and a room fitted into leftover
    // space would move whenever a family grew.
    // The break room is not a reward for having enough agents: a one-agent
    // epic is exactly where an empty floor reads as broken, so the storey is
    // widened and deepened to fit a cafeteria whatever the cabins came to.
    // Only the EMPTY-epic room opts out - it has no floor to furnish.
    const localRows =
      cabins.length === 0
        ? EMPTY_ROOM_ROWS
        : Math.max(
            contentBottom + BUILDING_BOTTOM_MARGIN_TILES,
            CAFETERIA_MIN_FLOOR_ROWS,
          );
    // A storey the cabins already made deep enough carries the game room under
    // the break room for nothing. A shallow one pays for it in width instead -
    // deepening the building to stack them would leave a one-agent epic with a
    // storey of empty corridor, which is worse than a wide one.
    const gameBelow =
      cabins.length > 0 && localRows >= STACKED_ROOMS_MIN_FLOOR_ROWS;
    const roomsWidth = gameBelow
      ? CAFETERIA_COLS
      : CAFETERIA_COLS + ROOM_GAP_TILES + GAME_ROOM_COLS;
    const localCols =
      cabins.length === 0
        ? EMPTY_ROOM_COLS
        : Math.max(
            contentRight + BUILDING_RIGHT_MARGIN_TILES + roomsWidth,
            gameBelow
              ? CAFETERIA_MIN_BUILDING_COLS
              : SIDE_BY_SIDE_MIN_BUILDING_COLS,
          );
    builds.push({
      hostId: group.hostId,
      forest,
      cabins,
      localCols,
      localRows,
      originRow,
      gameBelow,
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

interface CafeteriaPlan {
  readonly bounds: OfficeTileRect;
  readonly doorTile: OfficeTilePos;
  readonly coffeeTile: OfficeTilePos;
  readonly coolerTile: OfficeTilePos;
  readonly vendingTile: OfficeTilePos;
  /** Left tile of each two-tile table. */
  readonly tableTiles: ReadonlyArray<OfficeTilePos>;
  /** Left tile of the two-tile sofa, against the room's right wall. */
  readonly sofaTile: OfficeTilePos;
}

/**
 * The corner fittings a floor with no cafeteria keeps instead.
 *
 * Reachable only by the EMPTY-epic room now that every furnished storey is
 * widened to fit a break room. Kept for exactly that case: a room with no
 * agents still wants something in the corner, and it has no cabins to widen
 * around.
 */
interface CornerFittings {
  readonly coffeeTile: OfficeTilePos;
  readonly coolerTile: OfficeTilePos | null;
}

function planCafeteria(
  context: PlanContext,
  build: FloorBuild,
): CafeteriaPlan | null {
  // Both guards now only fire for the empty-epic room; a furnished storey is
  // sized to clear them - see `localCols` / `localRows`.
  if (context.cols - 2 < CAFETERIA_MIN_INTERIOR_COLS) return null;
  if (build.localRows < CAFETERIA_MIN_FLOOR_ROWS) return null;
  const col = context.cols - 1 - CAFETERIA_COLS;
  const row = build.originRow + BUILDING_TOP_WALL_ROWS;
  if (col <= BUILDING_FIRST_CONTENT_COL) return null;
  return {
    bounds: { col, row, cols: CAFETERIA_COLS, rows: CAFETERIA_ROWS },
    // In the BOTTOM wall, right of both tables and one column clear of the
    // stairwell, so the way out is never the way past somebody eating.
    doorTile: {
      col: col + CAFETERIA_DOOR_COL_OFFSET,
      row: row + CAFETERIA_ROWS - 1,
    },
    coffeeTile: {
      col: col + CAFETERIA_COFFEE_COL_OFFSET,
      row: row + CAFETERIA_FIXTURE_ROW,
    },
    coolerTile: {
      col: col + CAFETERIA_COOLER_COL_OFFSET,
      row: row + CAFETERIA_FIXTURE_ROW,
    },
    vendingTile: {
      col: col + CAFETERIA_VENDING_COL_OFFSET,
      row: row + CAFETERIA_FIXTURE_ROW,
    },
    tableTiles: CAFETERIA_TABLE_COL_OFFSETS.map((offset) => ({
      col: col + offset,
      row: row + CAFETERIA_TABLE_ROW,
    })),
    // On the fixture row past the vending machine, so it backs onto the same
    // wall the machines do and its seats look out over the tables.
    sofaTile: {
      col: col + CAFETERIA_SOFA_COL_OFFSET,
      row: row + CAFETERIA_FIXTURE_ROW,
    },
  };
}

interface GameRoomPlan {
  readonly bounds: OfficeTileRect;
  readonly doorTile: OfficeTilePos;
  readonly arcadeTile: OfficeTilePos;
  /** Left tile of the two-tile ping-pong table. */
  readonly tableTile: OfficeTilePos;
  readonly sofaTile: OfficeTilePos;
}

/**
 * Where the game room lands, given the break room it shares the storey with.
 * `null` only where there is no break room to place it against - the empty-epic
 * room, which has no floor to furnish.
 */
function planGameRoom(
  build: FloorBuild,
  cafeteria: CafeteriaPlan | null,
): GameRoomPlan | null {
  if (cafeteria === null) return null;
  const { col, row } = cafeteria.bounds;
  const bounds: OfficeTileRect = build.gameBelow
    ? {
        col,
        row: row + CAFETERIA_ROWS + ROOM_GAP_TILES,
        cols: GAME_ROOM_COLS,
        rows: GAME_ROOM_ROWS,
      }
    : {
        col: col - GAME_ROOM_COLS - ROOM_GAP_TILES,
        row,
        cols: GAME_ROOM_COLS,
        rows: GAME_ROOM_ROWS,
      };
  if (bounds.col <= BUILDING_FIRST_CONTENT_COL) return null;
  if (bounds.row + bounds.rows > build.originRow + build.localRows - 1) {
    return null;
  }
  return {
    bounds,
    doorTile: {
      col: bounds.col + GAME_DOOR_COL_OFFSET,
      row: bounds.row + GAME_ROOM_ROWS - 1,
    },
    arcadeTile: {
      col: bounds.col + GAME_ARCADE_COL_OFFSET,
      row: bounds.row + GAME_FIXTURE_ROW,
    },
    tableTile: {
      col: bounds.col + GAME_TABLE_COL_OFFSET,
      row: bounds.row + GAME_TABLE_ROW,
    },
    sofaTile: {
      col: bounds.col + GAME_SOFA_COL_OFFSET,
      row: bounds.row + GAME_FIXTURE_ROW,
    },
  };
}

/**
 * A walled room's own ring and its door, shared by the break room and the game
 * room. Mirrors a cabin's - cap, wall face, sides, one walkable door - so the
 * scene can paint either with the same two sprites.
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

/** The table, the cabinet and the sofa, inside the ring the room already has. */
function buildGameRoom(context: PlanContext, plan: GameRoomPlan): void {
  buildRoomShell(context, plan.bounds, plan.doorTile);
  addBlockingProp(context, {
    sprite: { name: "arcade" },
    tile: plan.arcadeTile,
  });
  addWideProp(
    context,
    "pingpong-table",
    plan.tableTile,
    PINGPONG_TABLE_WIDTH_TILES,
  );
  addWideProp(context, "sofa", plan.sofaTile, SOFA_WIDTH_TILES);
}

/**
 * The break room's own fittings, inside the ring it shares with the game room.
 */
function buildCafeteria(context: PlanContext, plan: CafeteriaPlan): void {
  const { col, row } = plan.bounds;
  buildRoomShell(context, plan.bounds, plan.doorTile);
  // On the wall face over the coffee machine, exactly where a cabin hangs its
  // sign - the board is what says which of the three fixtures is the coffee.
  addBlockingProp(context, {
    sprite: { name: "menu-board" },
    tile: { col: col + CAFETERIA_COFFEE_COL_OFFSET, row: row + 1 },
  });
  addBlockingProp(context, {
    sprite: { name: "coffee-machine" },
    tile: plan.coffeeTile,
  });
  addBlockingProp(context, {
    sprite: { name: "water-cooler" },
    tile: plan.coolerTile,
  });
  addBlockingProp(context, {
    sprite: { name: "vending" },
    tile: plan.vendingTile,
  });
  for (const tile of plan.tableTiles) {
    addWideProp(context, "cafe-table", tile, CAFE_TABLE_WIDTH_TILES);
  }
  // Two tiles wide like a table, and blocked across both: a sofa is furniture
  // you sit ON from the front, never a tile the room routes through.
  addWideProp(context, "sofa", plan.sofaTile, SOFA_WIDTH_TILES);
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
  readonly cafeteria: CafeteriaPlan | null;
  readonly gameRoom: GameRoomPlan | null;
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

function addCafeteriaSpots(builder: SpotBuilder, plan: CafeteriaPlan): void {
  const aisleRow = plan.bounds.row + CAFETERIA_AISLE_ROW;
  addSpot(builder, "coffee", { col: plan.coffeeTile.col, row: aisleRow }, "up");
  // TWO cooler spots, side by side and turned toward each other: a water cooler
  // is where two people talk, and a single spot can only ever hold a monologue.
  addSpot(
    builder,
    "cooler",
    { col: plan.coolerTile.col, row: aisleRow },
    "right",
  );
  addSpot(
    builder,
    "cooler",
    { col: plan.coolerTile.col + 1, row: aisleRow },
    "left",
  );
  addSpot(
    builder,
    "vending",
    { col: plan.vendingTile.col, row: aisleRow },
    "up",
  );
  for (const table of plan.tableTiles) {
    for (let offset = 0; offset < CAFE_TABLE_WIDTH_TILES; offset += 1) {
      addSpot(
        builder,
        "cafe",
        {
          col: table.col + offset,
          row: plan.bounds.row + CAFETERIA_SEAT_ROW,
        },
        "up",
      );
    }
  }
  // One seat per sofa tile, on the aisle in front of it. The facing looks AT
  // the sofa, as every spot's does; the scene turns whoever sits down back
  // toward the room, which is the way a person on a sofa actually faces.
  for (let offset = 0; offset < SOFA_WIDTH_TILES; offset += 1) {
    addSpot(
      builder,
      "sofa",
      { col: plan.sofaTile.col + offset, row: aisleRow },
      "up",
    );
  }
}

/**
 * The game room's own spots: an end of the table each side, the aisle in front
 * of the cabinet, and a seat in front of each half of the sofa.
 *
 * The two table ends face EACH OTHER rather than the table, because a rally is
 * the only errand that is two people rather than one - the same reason the
 * cooler has a facing pair.
 */
function addGameRoomSpots(builder: SpotBuilder, plan: GameRoomPlan): void {
  const table = plan.tableTile;
  addSpot(builder, "pingpong", { col: table.col - 1, row: table.row }, "right");
  addSpot(
    builder,
    "pingpong",
    { col: table.col + PINGPONG_TABLE_WIDTH_TILES, row: table.row },
    "left",
  );
  const aisleRow = plan.bounds.row + GAME_AISLE_ROW;
  addSpot(builder, "arcade", { col: plan.arcadeTile.col, row: aisleRow }, "up");
  for (let offset = 0; offset < SOFA_WIDTH_TILES; offset += 1) {
    addSpot(
      builder,
      "sofa",
      { col: plan.sofaTile.col + offset, row: aisleRow },
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
      const cafeteria = request.cafeteria;
      if (cafeteria !== null && withinRect(cafeteria.bounds, tile)) continue;
      const gameRoom = request.gameRoom;
      if (gameRoom !== null && withinRect(gameRoom.bounds, tile)) continue;
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
  const cafeteria = request.cafeteria;
  const corner = request.corner;
  if (cafeteria !== null) addCafeteriaSpots(builder, cafeteria);
  else if (corner !== null) addCornerSpots(builder, corner);
  const gameRoom = request.gameRoom;
  if (gameRoom !== null) addGameRoomSpots(builder, gameRoom);
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

function collectCabins(
  builds: ReadonlyArray<FloorBuild>,
  desks: Map<string, OfficeDesk>,
  rooms: OfficeRoom[],
): void {
  for (const build of builds) {
    for (const cabin of build.cabins) {
      const cabinRow = cabin.row + build.originRow;
      const firstSlotCol = cabin.col + CABIN_LEFT_WALL_COLS + CABIN_AISLE_COLS;
      const firstSlotRow = cabinRow + CABIN_TOP_WALL_ROWS + CABIN_AISLE_ROWS;
      cabin.members.forEach((member, index) => {
        const col = firstSlotCol + (index % cabin.perRow) * SLOT_COLS;
        const row = firstSlotRow + Math.floor(index / cabin.perRow) * SLOT_ROWS;
        desks.set(member.id, {
          agentId: member.id,
          deskTile: { col, row },
          chairTile: { col, row: row + 1 },
          // The cabin's root heads its own room; nobody else in it manages.
          manager: index === 0,
        });
      });
      rooms.push({
        rootAgentId: cabin.root.id,
        name: cabin.root.name,
        // Sub-team pods are a later lane's; a cabin with none is not a cabin
        // with an unknown number of them.
        pods: [],
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
 * A partition reads the grandchildren as their own pod. It goes in the aisle
 * column to the LEFT of the pod head's desk - always either the previous slot's
 * spare column or the cabin's own aisle - and only where that tile is still
 * free, so a divider can never take a desk, a chair or a plant.
 */
function addPodPartitions(
  context: PlanContext,
  builds: ReadonlyArray<FloorBuild>,
  desks: ReadonlyMap<string, OfficeDesk>,
): void {
  for (const build of builds) {
    for (const cabin of build.cabins) {
      cabin.members.forEach((member, index) => {
        if (index === 0) return;
        const children = build.forest.childrenByParent.get(member.id);
        if (children === undefined) return;
        if (children.length < SUB_CLUSTER_MIN_CHILDREN) return;
        const desk = desks.get(member.id);
        if (desk === undefined) return;
        const tile: OfficeTilePos = {
          col: desk.deskTile.col - 1,
          row: desk.deskTile.row,
        };
        if (tile.col < 0 || !context.walkable[tile.row][tile.col]) return;
        addBlockingProp(context, { sprite: { name: "partition" }, tile });
      });
    }
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
  const cafeteria = planCafeteria(context, build);
  const corner =
    cafeteria === null ? buildCornerFittings(context, build) : null;
  if (cafeteria !== null) buildCafeteria(context, cafeteria);
  const gameRoom = planGameRoom(build, cafeteria);
  if (gameRoom !== null) buildGameRoom(context, gameRoom);

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
      cafeteria,
      gameRoom,
      corner,
      rooms: request.rooms,
      stairsTile,
    }),
    cafeteria: cafeteria === null ? null : cafeteria.bounds,
    gameRoom: gameRoom === null ? null : gameRoom.bounds,
    areaSigns: areaSignsFor(cafeteria, gameRoom),
  };
}

/**
 * A name plate on each walled amenity's wall face, mounted exactly where a
 * cabin hangs its own sign. Two tiles along from the room's left wall, which is
 * left of both doors and clear of the menu board the break room already hangs
 * over its coffee machine.
 */
function areaSignsFor(
  cafeteria: CafeteriaPlan | null,
  gameRoom: GameRoomPlan | null,
): ReadonlyArray<OfficeAreaSign> {
  const signs: OfficeAreaSign[] = [];
  if (cafeteria !== null) {
    signs.push({
      name: "Cafeteria",
      signTile: {
        col: cafeteria.bounds.col + AREA_SIGN_COL_OFFSET,
        row: cafeteria.bounds.row + 1,
      },
    });
  }
  if (gameRoom !== null) {
    signs.push({
      name: "Game room",
      signTile: {
        col: gameRoom.bounds.col + AREA_SIGN_COL_OFFSET,
        row: gameRoom.bounds.row + 1,
      },
    });
  }
  return signs;
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
  // Before the storeys are fitted out, so a cabin's own furniture is already
  // standing when the errand spots are picked over the finished grid.
  addManagerPlants(context, desks);
  addCabinBins(context, desks);
  addPodPartitions(context, builds, desks);

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
