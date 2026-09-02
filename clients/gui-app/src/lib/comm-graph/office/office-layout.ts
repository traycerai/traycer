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
  OfficeDesk,
  OfficeFloor,
  OfficeLayout,
  OfficeProp,
  OfficeRoom,
  OfficeTilePos,
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
    const localCols =
      cabins.length === 0
        ? EMPTY_ROOM_COLS
        : contentRight + BUILDING_RIGHT_MARGIN_TILES;
    const localRows =
      cabins.length === 0
        ? EMPTY_ROOM_ROWS
        : contentBottom + BUILDING_BOTTOM_MARGIN_TILES;
    builds.push({
      hostId: group.hostId,
      forest,
      cabins,
      localCols,
      localRows,
      originRow,
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

  const walkable = blankWalkableGrid(cols, rows, builds);
  for (const room of rooms) blockCabinWalls(walkable, room);
  for (const desk of desks.values()) {
    for (let offset = 0; offset < DESK_WIDTH_TILES; offset += 1) {
      walkable[desk.deskTile.row][desk.deskTile.col + offset] = false;
    }
    // Blocked in the GENERAL grid: a chair belongs to one agent. The path
    // finder is what grants an exception, by always allowing its own goal.
    walkable[desk.chairTile.row][desk.chairTile.col] = false;
  }

  const props: OfficeProp[] = [];
  const blockTile = (tile: OfficeTilePos): void => {
    if (tile.row < 0 || tile.row >= rows) return;
    if (tile.col < 0 || tile.col >= cols) return;
    walkable[tile.row][tile.col] = false;
  };
  const addBlockingProp = (prop: OfficeProp): void => {
    props.push(prop);
    blockTile(prop.tile);
  };

  const floors: OfficeFloor[] = [];
  const multiFloor = builds.length > 1;
  for (const build of builds) {
    const wallFaceRow = build.originRow + 1;
    const bottomRow = build.originRow + build.localRows - 1;
    const doorTile: OfficeTilePos = { col: doorCol, row: bottomRow };
    const lobbyTile: OfficeTilePos = { col: doorCol, row: bottomRow - 1 };
    walkable[doorTile.row][doorTile.col] = true;

    // The building's own fittings hang on the OUTER wall, clear of every cabin.
    addBlockingProp({
      sprite: { name: "whiteboard" },
      tile: { col: BUILDING_FIRST_CONTENT_COL, row: wallFaceRow },
    });
    const clockTile: OfficeTilePos = {
      col: BUILDING_FIRST_CONTENT_COL + CLOCK_COL_OFFSET,
      row: wallFaceRow,
    };
    addBlockingProp({ sprite: { name: "clock" }, tile: clockTile });
    for (
      let col = BUILDING_FIRST_CONTENT_COL + WINDOW_SPACING_TILES;
      col <= cols - 3;
      col += WINDOW_SPACING_TILES
    ) {
      addBlockingProp({
        sprite: { name: "window" },
        tile: { col, row: wallFaceRow },
      });
    }
    addBlockingProp({
      sprite: { name: "coffee-machine" },
      tile: { col: cols - 3, row: build.originRow + 2 },
    });

    // Reception stands on the lobby row, one clear tile short of the door so
    // nobody has to squeeze past the counter to get out.
    const counterCol = Math.max(
      1,
      doorCol - RECEPTION_DOOR_GAP_TILES - RECEPTION_WIDTH_TILES,
    );
    const receptionTile: OfficeTilePos = {
      col: counterCol,
      row: lobbyTile.row,
    };
    props.push({ sprite: { name: "reception" }, tile: receptionTile });
    for (let offset = 0; offset < RECEPTION_WIDTH_TILES; offset += 1) {
      blockTile({ col: counterCol + offset, row: lobbyTile.row });
    }

    // Decorative only: nobody walks between floors, so the stairwell is a
    // reminder that the building has more than one - never a route. It is
    // FLOOR rather than furniture, so it carries no prop entry: the scene
    // paints it with the floor layer, from this top-left tile.
    const stairsTile = multiFloor
      ? placeStairwell({
          cols,
          lobbyRow: lobbyTile.row,
          originRow: build.originRow,
          blockTile,
        })
      : null;

    floors.push({
      hostId: build.hostId,
      bounds: {
        col: 0,
        row: build.originRow,
        cols,
        rows: build.localRows,
      },
      doorTile,
      lobbyTile,
      receptionTile,
      receptionQueueTiles: receptionQueueTiles(
        walkable,
        receptionTile,
        doorTile,
        lobbyTile,
      ),
      clockTile,
      stairsTile,
    });
    // The rug is the one prop a character may stand on - it marks the lobby.
    props.push({ sprite: { name: "rug" }, tile: lobbyTile });
  }

  for (const desk of desks.values()) {
    if (!desk.manager) continue;
    addBlockingProp({
      sprite: { name: "plant" },
      tile: {
        col: desk.deskTile.col + PLANT_COL_OFFSET,
        row: desk.deskTile.row,
      },
    });
  }
  // A partition reads the grandchildren as their own pod. It goes in the aisle
  // column to the LEFT of the pod head's desk - always either the previous
  // slot's spare column or the cabin's own aisle - and only where that tile is
  // still free, so a divider can never take a desk, a chair or a plant.
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
        if (tile.col < 0 || !walkable[tile.row][tile.col]) return;
        addBlockingProp({ sprite: { name: "partition" }, tile });
      });
    }
  }

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
    props,
    walkable,
  };
}
