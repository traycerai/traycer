/**
 * The office floor plan: a pure function of WHO EXISTS, never a stored
 * coordinate.
 *
 * Same discipline as the graph mode's dagre pass - an agent that is created,
 * archived or reparented would strand a persisted desk, so the plan is
 * recomputed from the agent set instead. That makes ORDER the whole design:
 * the set is walked as families (root, then its subtree depth-first, children
 * by `(createdAt, id)`), so a lineage reads left to right along a row and a
 * creator sits at the head of the people it created.
 *
 * The room is a walled rectangle. Row 0 is the wall's top cap and row 1 its
 * face - windows and the whiteboard mount there - the outer columns and the
 * last row are wall, and the door is a walkable gap at the bottom centre with
 * the lobby tile directly inside it.
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
  OfficeLayout,
  OfficeProp,
  OfficeTilePos,
} from "@/lib/comm-graph/office/office-types";

/** Slot footprint: desk + plant space across, desk / chair / aisle down. */
const SLOT_COLS = 5;
const SLOT_ROWS = 3;
/** Two keeps a one-agent epic from looking like a corridor; six keeps a busy
 * epic from needing a horizontal scroll before the camera can fit it. */
const MIN_SLOTS_PER_ROW = 2;
const MAX_SLOTS_PER_ROW = 6;
/** Wall, then a one-tile aisle, before the first slot - on both axes. */
const FIRST_SLOT_COL = 2;
const FIRST_SLOT_ROW = 3;
/** Wall column + aisle on each side. */
const HORIZONTAL_MARGIN_TILES = 4;
/** Wall-top + wall face + top aisle + bottom aisle + bottom wall. */
const VERTICAL_MARGIN_TILES = 5;
/** An epic with no agents still renders a room; the canvas is never blank. */
const EMPTY_ROOM_COLS = 8;
const EMPTY_ROOM_ROWS = 6;
const WINDOW_SPACING_TILES = 4;
const DESK_WIDTH_TILES = 2;
const PLANT_COL_OFFSET = 2;

interface SeatingEntry {
  readonly agent: OfficeAgentInput;
  /** A root of the lineage forest; its desk gets the plant. */
  readonly manager: boolean;
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
 * Families contiguous: every root in `(createdAt, id)` order, each followed
 * immediately by its subtree in the same order.
 *
 * An agent whose `parentId` names someone outside the set is a root here - the
 * creator is not on this floor, so there is no family to sit beside.
 */
function seatingOrder(
  agents: ReadonlyArray<OfficeAgentInput>,
): ReadonlyArray<SeatingEntry> {
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

  const ordered: SeatingEntry[] = [];
  const seated = new Set<string>();
  // Explicit stack rather than recursion: lineage depth is user-controlled.
  const stack: SeatingEntry[] = [];
  const pushSubtree = (entries: ReadonlyArray<SeatingEntry>): void => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      stack.push(entries[index]);
    }
  };
  pushSubtree(roots.map((agent) => ({ agent, manager: true })));
  const drain = (): void => {
    for (;;) {
      const entry = stack.pop();
      if (entry === undefined) return;
      // Reparenting can leave a cycle in the recorded lineage; visiting once
      // turns that into a merely odd seating order instead of a hang.
      if (seated.has(entry.agent.id)) continue;
      seated.add(entry.agent.id);
      ordered.push(entry);
      const children = childrenByParent.get(entry.agent.id);
      if (children === undefined) continue;
      pushSubtree(children.map((agent) => ({ agent, manager: false })));
    }
  };
  drain();

  // Anyone left is inside such a cycle and has no root to be reached from.
  // Seat them after the families, in the same canonical order.
  const stranded = agents
    .filter((agent) => !seated.has(agent.id))
    .sort(compareByCreation);
  pushSubtree(stranded.map((agent) => ({ agent, manager: false })));
  drain();
  return ordered;
}

function slotsPerRow(agentCount: number): number {
  const square = Math.ceil(Math.sqrt(agentCount));
  return Math.min(MAX_SLOTS_PER_ROW, Math.max(MIN_SLOTS_PER_ROW, square));
}

function blankWalkableGrid(cols: number, rows: number): boolean[][] {
  const grid: boolean[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < cols; col += 1) {
      const isWall =
        row <= 1 || row === rows - 1 || col === 0 || col === cols - 1;
      line.push(!isWall);
    }
    grid.push(line);
  }
  return grid;
}

export function layoutOffice(
  agents: ReadonlyArray<OfficeAgentInput>,
): OfficeLayout {
  const seating = seatingOrder(agents);
  const perRow = slotsPerRow(seating.length);
  const slotRowCount = Math.ceil(seating.length / perRow);
  const cols =
    seating.length === 0
      ? EMPTY_ROOM_COLS
      : perRow * SLOT_COLS + HORIZONTAL_MARGIN_TILES;
  const rows =
    seating.length === 0
      ? EMPTY_ROOM_ROWS
      : slotRowCount * SLOT_ROWS + VERTICAL_MARGIN_TILES;

  const doorTile: OfficeTilePos = {
    col: Math.floor((cols - 1) / 2),
    row: rows - 1,
  };
  const lobbyTile: OfficeTilePos = { col: doorTile.col, row: rows - 2 };

  const desks = new Map<string, OfficeDesk>();
  seating.forEach((entry, index) => {
    const col = FIRST_SLOT_COL + (index % perRow) * SLOT_COLS;
    const row = FIRST_SLOT_ROW + Math.floor(index / perRow) * SLOT_ROWS;
    desks.set(entry.agent.id, {
      agentId: entry.agent.id,
      deskTile: { col, row },
      chairTile: { col, row: row + 1 },
      manager: entry.manager,
    });
  });

  const props: OfficeProp[] = [
    { sprite: { name: "whiteboard" }, tile: { col: FIRST_SLOT_COL, row: 1 } },
  ];
  for (
    let col = FIRST_SLOT_COL + WINDOW_SPACING_TILES;
    col <= cols - 3;
    col += WINDOW_SPACING_TILES
  ) {
    props.push({ sprite: { name: "window" }, tile: { col, row: 1 } });
  }
  props.push({
    sprite: { name: "coffee-machine" },
    tile: { col: cols - 3, row: 2 },
  });
  for (const desk of desks.values()) {
    if (!desk.manager) continue;
    props.push({
      sprite: { name: "plant" },
      tile: {
        col: desk.deskTile.col + PLANT_COL_OFFSET,
        row: desk.deskTile.row,
      },
    });
  }
  // The rug is the one prop a character may stand on - it marks the lobby.
  props.push({ sprite: { name: "rug" }, tile: lobbyTile });

  const walkable = blankWalkableGrid(cols, rows);
  walkable[doorTile.row][doorTile.col] = true;
  for (const desk of desks.values()) {
    for (let offset = 0; offset < DESK_WIDTH_TILES; offset += 1) {
      walkable[desk.deskTile.row][desk.deskTile.col + offset] = false;
    }
    // Blocked in the GENERAL grid: a chair belongs to one agent. The path
    // finder is what grants an exception, by always allowing its own goal.
    walkable[desk.chairTile.row][desk.chairTile.col] = false;
  }
  for (const prop of props) {
    if (prop.sprite.name === "rug") continue;
    walkable[prop.tile.row][prop.tile.col] = false;
  }

  return { cols, rows, desks, doorTile, lobbyTile, props, walkable };
}
