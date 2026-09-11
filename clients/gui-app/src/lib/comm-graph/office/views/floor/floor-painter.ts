/**
 * How the Floor is DRAWN: the office as it has always looked, lifted out of the
 * scene without a pixel moving.
 *
 * Everything here used to be private to `OfficeScene` - `buildFloor`, the cabin
 * walls, the pod carpets and outlines, the amenity rings, the desks and their
 * screens, the dust sheets. It is all a pure function of the LAYOUT and a desk
 * STATE, which is exactly why it can leave: nothing in it ever needed to know
 * who was walking where.
 *
 * Three departures from the old prop pass, each forced by the contract rather
 * than chosen:
 *
 * - The floor is asked for ONE CHUNK at a time, so a thousand-agent office is
 *   never one hundred-thousand-drawable array.
 * - At lod 0 it is a BLOCK MAP - one filled rect per storey, cabin, pod and
 *   amenity - because a sixteen-pixel tile at overview zoom is under three
 *   screen pixels, and forty thousand of them is a grey wash that costs a
 *   whole-world bitmap to produce.
 * - Scenery (plants, bins, cafeteria furniture, pod outlines) moves into the
 *   floor layer beside the walls. It is static per layout, which is what the
 *   static bake is for; the desks stay in the prop pass because their screens
 *   animate. The two never overlap on the Floor - a manager's plant stands in
 *   the spare column of its own slot, whose row above is that cabin's aisle.
 *
 * SIGNAGE IS NOT HERE. A sign names an agent, and whether that agent exists is
 * a fact about the time cursor rather than about the plan - so `layout.signs`
 * is drawn by the renderer, which is the only place the visible set is known.
 */
import {
  officeSpriteFootY,
  officeSpriteSize,
} from "@/lib/comm-graph/office/office-pixel-art";
import {
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
  type OfficeDrawable,
  type OfficeErrandSpot,
  type OfficeLayout,
  type OfficeLod,
  type OfficeModelTier,
  type OfficePod,
  type OfficePodStyle,
  type OfficeProp,
  type OfficeRoom,
  type OfficeSeat,
  type OfficeSpriteName,
  type OfficeTilePos,
  type OfficeTileRect,
  type OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";
import type {
  OfficeDeskState,
  OfficePainter,
  OfficeProjector,
} from "@/lib/comm-graph/office/views/office-view";

/**
 * How each pod style draws its outline. The vertical piece takes the corners
 * too: a corner belongs to the side that carries the run, and a horizontal
 * piece turned on its end reads as a mistake.
 */
interface OfficePodOutlineArt {
  readonly vertical: OfficeSpriteName;
  readonly horizontal: OfficeSpriteName;
}

const POD_OUTLINE_ART: Readonly<Record<OfficePodStyle, OfficePodOutlineArt>> = {
  glass: { vertical: "partition", horizontal: "partition-h" },
  // A planter box reads the same from any side, so one sprite serves the ring.
  planters: { vertical: "planter", horizontal: "planter" },
  shelves: { vertical: "shelf", horizontal: "shelf-h" },
};

/**
 * The tinted floor inside a pod, as a checker. Depth swaps which variant lands
 * on an even tile, so a pod nested inside another never lines up with its
 * parent's floor even where the two share a tint.
 */
const POD_FLOOR_ART: Readonly<
  Record<"cool" | "warm", readonly [OfficeSpriteName, OfficeSpriteName]>
> = {
  cool: ["floor-pod-a", "floor-pod-b"],
  warm: ["floor-pod-warm-a", "floor-pod-warm-b"],
};

const IDLE_MONITOR_ALPHA = 0.6;
const ARCHIVED_ALPHA = 0.45;
/** The plate on the desk's right half, and the logo standing on top of it. */
const NAMEPLATE_Y_OFFSET = 4;
const LOGO_Y_OFFSET = 1;
const MAX_LABEL_CHARS = 14;
const LABEL_GAP = 8;
/**
 * How far a prop's art may reach ABOVE its own tile: a tree is two tiles tall.
 * A chunk therefore draws the rows just under it too, or a plant standing on
 * the first row below a chunk boundary would lose its head to the seam.
 */
const PROP_OVERHANG_TILES = 2;

/**
 * The unanswered-request pile, indexed by how many are waiting (1, 2, 3+).
 * Every height shares one BASE line on the desk, so the pile grows upward as
 * it deepens instead of floating off the furniture.
 */
interface OfficeEnvelopeStack {
  readonly sprite: OfficeSpriteName;
  readonly xOffset: number;
  readonly yOffset: number;
}

const ENVELOPE_STACKS: ReadonlyArray<OfficeEnvelopeStack> = [
  { sprite: "envelope-stack-1", xOffset: 1, yOffset: -2 },
  { sprite: "envelope-stack-2", xOffset: 1, yOffset: -4 },
  { sprite: "envelope-stack-3", xOffset: 1, yOffset: -6 },
];

/**
 * The screen on a desk, by the coarse size class of the agent's model: a
 * laptop, a single monitor, or dual wide displays. `onB` is the second lit
 * frame, and a tier that has none simply does not animate.
 *
 * Offsets sit the screen on the desk's back edge, aligned to where the desk
 * sprite draws its keyboard rather than to the desk's own centre - the screen
 * belongs behind the keys, not behind the middle of the furniture. The crash
 * map is one 16x12 for every tier, so it carries its OWN offset rather than
 * borrowing a wide screen's.
 *
 * The plate moves with the screen for the same reason: a wide display reaches
 * across the desk's right half, so a large tier sets its own plate and badge
 * columns instead of overlapping them.
 */
interface OfficeScreenArt {
  readonly on: OfficeSpriteName;
  readonly onB: OfficeSpriteName | null;
  readonly off: OfficeSpriteName;
  readonly xOffset: number;
  readonly yOffset: number;
  readonly crashXOffset: number;
  readonly crashYOffset: number;
  readonly plateXOffset: number;
  readonly logoXOffset: number;
}

const SCREEN_ART: Readonly<Record<OfficeModelTier, OfficeScreenArt>> = {
  small: {
    on: "monitor-small-on",
    onB: null,
    off: "monitor-small-off",
    xOffset: 5,
    yOffset: -5,
    crashXOffset: 3,
    crashYOffset: -8,
    plateXOffset: 18,
    logoXOffset: 24,
  },
  medium: {
    on: "monitor-on",
    onB: "monitor-on-b",
    off: "monitor-off",
    xOffset: 3,
    yOffset: -8,
    crashXOffset: 3,
    crashYOffset: -8,
    plateXOffset: 18,
    logoXOffset: 24,
  },
  large: {
    on: "monitor-wide-on",
    onB: "monitor-wide-on-b",
    off: "monitor-wide-off",
    xOffset: 0,
    yOffset: -8,
    crashXOffset: 4,
    crashYOffset: -8,
    plateXOffset: 20,
    logoXOffset: 26,
  },
};

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function propDrawY(prop: OfficeProp): number {
  return officeSpriteFootY(prop.sprite, prop.tile.row);
}

/** One drawable with the row it BELONGS to, which is never where it is drawn. */
interface SortedProp {
  readonly drawable: OfficeDrawable;
  readonly sortY: number;
}

function withinTileRect(bounds: OfficeTileRect, tile: OfficeTilePos): boolean {
  return (
    tile.col >= bounds.col &&
    tile.col < bounds.col + bounds.cols &&
    tile.row >= bounds.row &&
    tile.row < bounds.row + bounds.rows
  );
}

function tileRectsOverlap(a: OfficeTileRect, b: OfficeTileRect): boolean {
  return (
    a.col < b.col + b.cols &&
    b.col < a.col + a.cols &&
    a.row < b.row + b.rows &&
    b.row < a.row + a.rows
  );
}

/** The chunk grown by the tallest art, so nothing loses its head to a seam. */
function withOverhang(tiles: OfficeTileRect): OfficeTileRect {
  return {
    col: tiles.col,
    row: tiles.row,
    cols: tiles.cols,
    rows: tiles.rows + PROP_OVERHANG_TILES,
  };
}

// ---- The floor layer -------------------------------------------------- //

/**
 * Inside a garden's hedge, the hedge itself excluded. The boundary is two
 * rows deep at the top exactly as a wall is - the cap and the face under it -
 * because it is the same ring in another material.
 */
function inGarden(layout: OfficeLayout, col: number, row: number): boolean {
  for (const floor of layout.floors) {
    for (const room of floor.amenities) {
      if (room.kind !== "garden") continue;
      const { bounds } = room;
      if (col <= bounds.col || col >= bounds.col + bounds.cols - 1) continue;
      if (row <= bounds.row + 1 || row >= bounds.row + bounds.rows - 1) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function floorSpriteAt(
  layout: OfficeLayout,
  col: number,
  row: number,
): OfficeSpriteName {
  for (const floor of layout.floors) {
    if (row === floor.doorTile.row && col === floor.doorTile.col) {
      return "door";
    }
  }
  // A storey's cap wins over the storey above's bottom wall on the row the
  // two SHARE: what a viewer sees between two floors is one capped wall.
  for (const floor of layout.floors) {
    if (row === floor.bounds.row) return "wall-top";
  }
  for (const floor of layout.floors) {
    const top = floor.bounds.row;
    if (row === top + 1 || row === top + floor.bounds.rows - 1) return "wall";
  }
  if (col === 0 || col === layout.cols - 1) return "wall";
  // A garden's ground is GRASS, and grass is floor rather than a thing
  // standing on it: drawn here, under the hedge and under everyone in it.
  if (inGarden(layout, col, row)) {
    return (col + row) % 2 === 0 ? "floor-grass-a" : "floor-grass-b";
  }
  return (col + row) % 2 === 0 ? "floor-a" : "floor-b";
}

function isWalkableTile(
  layout: OfficeLayout,
  col: number,
  row: number,
): boolean {
  if (row < 0 || row >= layout.rows) return false;
  if (col < 0 || col >= layout.cols) return false;
  return layout.walkable[row][col];
}

/**
 * A cabin's own walls. They sit ON the floor tiles and UNDER the lobby rug:
 * the building's inner structure, not furniture standing on it.
 */
function pushCabinWalls(
  out: OfficeDrawable[],
  room: OfficeRoom,
  tiles: OfficeTileRect,
): void {
  const { col, row, cols, rows } = room.bounds;
  const right = col + cols - 1;
  const bottom = row + rows - 1;
  const push = (name: OfficeSpriteName, wallCol: number, wallRow: number) => {
    if (!withinTileRect(tiles, { col: wallCol, row: wallRow })) return;
    out.push({
      kind: "sprite",
      sprite: { name },
      x: wallCol * OFFICE_TILE,
      y: wallRow * OFFICE_TILE,
    });
  };
  const wallAt = (wallCol: number, wallRow: number): void => {
    const isDoor =
      wallRow === room.doorTile.row && wallCol === room.doorTile.col;
    push(isDoor ? "door" : "wall", wallCol, wallRow);
  };
  for (let scanCol = col; scanCol <= right; scanCol += 1) {
    push("wall-top", scanCol, row);
    wallAt(scanCol, row + 1);
    wallAt(scanCol, bottom);
  }
  for (let scanRow = row + 2; scanRow < bottom; scanRow += 1) {
    wallAt(col, scanRow);
    wallAt(right, scanRow);
  }
}

/**
 * A pod's tinted carpet, on TOP of the cabin's own floor and under
 * everything that stands on it - a tinted region is a different bit of
 * carpet, not a thing in the room.
 *
 * Deepest LAST, so a nested pod's tint wins over its parent's on the tiles
 * the two share.
 */
function pushPodFloors(
  out: OfficeDrawable[],
  room: OfficeRoom,
  tiles: OfficeTileRect,
): void {
  for (const pod of [...room.pods].sort((a, b) => a.depth - b.depth)) {
    const [even, odd] = POD_FLOOR_ART[pod.tint];
    const lastRow = pod.bounds.row + pod.bounds.rows;
    const lastCol = pod.bounds.col + pod.bounds.cols;
    for (let row = pod.bounds.row; row < lastRow; row += 1) {
      for (let col = pod.bounds.col; col < lastCol; col += 1) {
        if (!withinTileRect(tiles, { col, row })) continue;
        const alternate = (col + row + pod.depth) % 2 === 0;
        out.push({
          kind: "sprite",
          sprite: { name: alternate ? even : odd },
          x: col * OFFICE_TILE,
          y: row * OFFICE_TILE,
        });
      }
    }
  }
}

/**
 * One tile of a room's boundary: its cap row, or the wall below and around
 * it. `null` means draw nothing, which is what a gap in a hedge is - a garden
 * is bounded rather than built, so its way in has no door hanging in it.
 */
function ringSpriteAt(
  layout: OfficeLayout,
  col: number,
  row: number,
  style: { readonly hedge: boolean; readonly cap: boolean },
): OfficeSpriteName | null {
  const open = layout.walkable[row][col];
  if (style.hedge) return open ? null : "planter";
  if (style.cap) return "wall-top";
  return open ? "door" : "wall";
}

/**
 * One amenity's ring: cap, wall face, sides, and its own doorway.
 *
 * A HEDGE is the same ring in a different material - a garden is bounded, not
 * built - so the two share every tile and differ only in the sprite. Its
 * opening is still the one ring tile the grid says is walkable, exactly as a
 * walled room's door is.
 */
function pushRoomRing(
  out: OfficeDrawable[],
  layout: OfficeLayout,
  room: OfficeTileRect,
  style: { readonly hedge: boolean; readonly tiles: OfficeTileRect },
): void {
  const { col, row, cols, rows } = room;
  const { hedge, tiles } = style;
  const right = col + cols - 1;
  const bottom = row + rows - 1;
  const push = (
    name: OfficeSpriteName | null,
    atCol: number,
    atRow: number,
  ) => {
    if (name === null) return;
    if (!withinTileRect(tiles, { col: atCol, row: atRow })) return;
    out.push({
      kind: "sprite",
      sprite: { name },
      x: atCol * OFFICE_TILE,
      y: atRow * OFFICE_TILE,
    });
  };
  const ringAt = (ringCol: number, ringRow: number): void => {
    push(
      ringSpriteAt(layout, ringCol, ringRow, { hedge, cap: false }),
      ringCol,
      ringRow,
    );
  };
  for (let scanCol = col; scanCol <= right; scanCol += 1) {
    push(
      ringSpriteAt(layout, scanCol, row, { hedge, cap: true }),
      scanCol,
      row,
    );
    ringAt(scanCol, row + 1);
    ringAt(scanCol, bottom);
  }
  for (let scanRow = row + 2; scanRow < bottom; scanRow += 1) {
    ringAt(col, scanRow);
    ringAt(right, scanRow);
  }
}

/**
 * Which piece of a pod's outline stands on one tile, or `null` where none
 * does: off the ring, on the plate's own tile, or on a tile the grid says is
 * WALKABLE - which is how the single opening stays open. A corner takes the
 * vertical piece, so the two runs meet rather than butting end to end.
 */
function podOutlineSpriteAt(
  layout: OfficeLayout,
  pod: OfficePod,
  col: number,
  row: number,
): OfficeSpriteName | null {
  const left = pod.bounds.col - 1;
  const top = pod.bounds.row - 1;
  const right = pod.bounds.col + pod.bounds.cols;
  const bottom = pod.bounds.row + pod.bounds.rows;
  const onRing = col === left || col === right || row === top || row === bottom;
  if (!onRing) return null;
  if (col === pod.plateTile.col && row === pod.plateTile.row) return null;
  if (isWalkableTile(layout, col, row)) return null;
  const art = POD_OUTLINE_ART[pod.style];
  // A corner is on a side column too, so this covers it: the two runs meet
  // at the vertical piece rather than butting end to end.
  const vertical = col === left || col === right;
  return vertical ? art.vertical : art.horizontal;
}

/**
 * A pod's boundary, drawn in the style the plan gave it. The OPENING is the
 * ring tile the grid still says is walkable, exactly as a room's door is, and
 * the plate's own tile carries no outline because the plate is furniture on
 * the boundary rather than a length of it.
 */
function pushPodOutline(
  sorted: SortedProp[],
  layout: OfficeLayout,
  pod: OfficePod,
  tiles: OfficeTileRect,
): void {
  const { col, row, cols, rows } = pod.bounds;
  const left = col - 1;
  const top = row - 1;
  const right = col + cols;
  const bottom = row + rows;
  for (let scanCol = left; scanCol <= right; scanCol += 1) {
    for (let scanRow = top; scanRow <= bottom; scanRow += 1) {
      if (!withinTileRect(tiles, { col: scanCol, row: scanRow })) continue;
      const name = podOutlineSpriteAt(layout, pod, scanCol, scanRow);
      if (name === null) continue;
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name },
          x: scanCol * OFFICE_TILE,
          y: officeSpriteFootY({ name }, scanRow),
        },
        sortY: scanRow * OFFICE_TILE,
      });
    }
  }
}

/**
 * The scenery: everything `layout.props` holds except the lobby rug, which is
 * floor rather than furniture and was already drawn under the walls.
 *
 * Sorted by the row each prop BELONGS to, never by where its sprite lands: a
 * tall prop is lifted onto its own tile, and sorting on the lift would file it
 * behind the row above.
 */
function pushScenery(
  sorted: SortedProp[],
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): void {
  const grown = withOverhang(tiles);
  for (const prop of layout.props) {
    if (prop.sprite.name === "rug") continue;
    if (!withinTileRect(grown, prop.tile)) continue;
    sorted.push({
      drawable: {
        kind: "sprite",
        sprite: prop.sprite,
        x: prop.tile.col * OFFICE_TILE,
        y: propDrawY(prop),
      },
      sortY: prop.tile.row * OFFICE_TILE,
    });
  }
}

/**
 * The floor at OVERVIEW zoom: one filled rect per region, and no tiles at all.
 *
 * A storey, a cabin, a pod, an amenity. That is everything a reader can take
 * in when a desk is three pixels wide, and it is a few dozen drawables where
 * the tile grid is tens of thousands.
 */
function blockMap(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): ReadonlyArray<OfficeDrawable> {
  const blocks: OfficeDrawable[] = [];
  const push = (
    bounds: OfficeTileRect,
    fill: "storey" | "room" | "pod" | "plaza" | "grass",
  ): void => {
    if (!tileRectsOverlap(bounds, tiles)) return;
    blocks.push({
      kind: "block",
      x: bounds.col * OFFICE_TILE,
      y: bounds.row * OFFICE_TILE,
      width: bounds.cols * OFFICE_TILE,
      height: bounds.rows * OFFICE_TILE,
      fill,
    });
  };
  for (const floor of layout.floors) push(floor.bounds, "storey");
  for (const floor of layout.floors) {
    for (const amenity of floor.amenities) {
      push(amenity.bounds, amenity.kind === "garden" ? "grass" : "plaza");
    }
  }
  for (const room of layout.rooms) {
    push(room.bounds, "room");
    for (const pod of [...room.pods].sort((a, b) => a.depth - b.depth)) {
      push(pod.bounds, "pod");
    }
  }
  return blocks;
}

/** The ground itself: one sprite per tile of the requested chunk. */
function pushGroundTiles(
  out: OfficeDrawable[],
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): void {
  const firstRow = Math.max(0, tiles.row);
  const lastRow = Math.min(layout.rows - 1, tiles.row + tiles.rows - 1);
  const firstCol = Math.max(0, tiles.col);
  const lastCol = Math.min(layout.cols - 1, tiles.col + tiles.cols - 1);
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      out.push({
        kind: "sprite",
        sprite: { name: floorSpriteAt(layout, col, row) },
        x: col * OFFICE_TILE,
        y: row * OFFICE_TILE,
      });
    }
  }
}

/**
 * A stairwell is a hole in the FLOOR, not a thing standing on it, so it is
 * drawn from its own top-left tile with no foot lift at all.
 */
function pushStairwells(
  out: OfficeDrawable[],
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): void {
  for (const floorPlan of layout.floors) {
    const stairsTile = floorPlan.stairsTile;
    if (stairsTile === null) continue;
    if (!withinTileRect(tiles, stairsTile)) continue;
    out.push({
      kind: "sprite",
      sprite: { name: "stairs" },
      x: stairsTile.col * OFFICE_TILE,
      y: stairsTile.row * OFFICE_TILE,
    });
  }
}

function pushRugs(
  out: OfficeDrawable[],
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): void {
  const grown = withOverhang(tiles);
  for (const prop of layout.props) {
    if (prop.sprite.name !== "rug") continue;
    if (!withinTileRect(grown, prop.tile)) continue;
    // Centred on its tile as well as lifted onto it: the rug is wider than
    // one tile and the door sits directly below the lobby, so a top-left
    // draw would carpet over the way in.
    const overhang = officeSpriteSize(prop.sprite).width - OFFICE_TILE;
    out.push({
      kind: "sprite",
      sprite: prop.sprite,
      x: prop.tile.col * OFFICE_TILE - overhang / 2,
      y: propDrawY(prop),
    });
  }
}

function floorChunk(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
  lod: OfficeLod,
): ReadonlyArray<OfficeDrawable> {
  if (lod === 0) return blockMap(layout, tiles);
  const out: OfficeDrawable[] = [];
  pushGroundTiles(out, layout, tiles);
  for (const room of layout.rooms) pushCabinWalls(out, room, tiles);
  for (const room of layout.rooms) pushPodFloors(out, room, tiles);
  // Every amenity's ring is drawn with the cabins' own two sprites, and the
  // garden's with a hedge instead. Their doors are not carried in the plan
  // and do not need to be: a ring tile the grid still says is walkable IS
  // the door, by construction.
  for (const floorPlan of layout.floors) {
    for (const room of floorPlan.amenities) {
      pushRoomRing(out, layout, room.bounds, {
        hedge: room.kind === "garden",
        tiles,
      });
    }
  }
  pushStairwells(out, layout, tiles);
  pushRugs(out, layout, tiles);
  // The scenery and the pod outlines stand ON the floor, so they come after
  // all of it, sorted among themselves by the row each belongs to.
  const sorted: SortedProp[] = [];
  for (const room of layout.rooms) {
    for (const pod of room.pods) pushPodOutline(sorted, layout, pod, tiles);
  }
  pushScenery(sorted, layout, tiles);
  sorted.sort((left, right) => left.sortY - right.sortY);
  for (const entry of sorted) out.push(entry.drawable);
  return out;
}

// ---- Desks ------------------------------------------------------------ //

function screenArtFor(state: OfficeDeskState): OfficeScreenArt {
  return SCREEN_ART[state.modelTier];
}

function monitorSpriteFor(state: OfficeDeskState): OfficeSpriteName {
  // One crash map serves every tier; it is drawn at the tier's own screen
  // offset, which is where that desk's display already was.
  if (state.status === "failure") return "monitor-crash";
  const art = screenArtFor(state);
  if (state.status === "archived") return art.off;
  if (state.status === "working" || state.status === "background") {
    // A laptop has one lit frame, so it simply does not flicker.
    return state.screenFrame === 1 ? (art.onB ?? art.on) : art.on;
  }
  return art.on;
}

function monitorAlphaFor(state: OfficeDeskState): number | undefined {
  // Idle keeps a LIT monitor, merely dimmed: the screen is on, nobody is at
  // it. Only an archived record actually powers down.
  if (state.status === "idle") return IDLE_MONITOR_ALPHA;
  if (state.status === "archived") return ARCHIVED_ALPHA;
  return undefined;
}

function envelopeStackFor(state: OfficeDeskState): OfficeEnvelopeStack | null {
  if (state.openRequests <= 0) return null;
  const index = Math.min(state.openRequests, ENVELOPE_STACKS.length) - 1;
  return ENVELOPE_STACKS[index];
}

/**
 * An archived agent's desk, once its character has left: sheeted over, its
 * chair holding a packed box, no screen and no plate. The name stays, muted,
 * because a nameless sheeted desk is a hole in the floor plan rather than a
 * record of who used to sit there.
 */
function sheetedDesk(
  seat: OfficeSeat,
  state: OfficeDeskState,
): ReadonlyArray<OfficeWorldDrawable> {
  const deskX = seat.deskTile.col * OFFICE_TILE;
  const deskY = seat.deskTile.row * OFFICE_TILE;
  const chairX = seat.chairTile.col * OFFICE_TILE;
  const chairY = seat.chairTile.row * OFFICE_TILE;
  const owner = state.agentId;
  const out: OfficeWorldDrawable[] = [
    {
      drawable: {
        kind: "sprite",
        sprite: { name: "dust-sheet" },
        x: deskX,
        y: deskY,
      },
      depth: deskY,
      ownerAgentId: owner,
    },
    {
      drawable: {
        kind: "sprite",
        sprite: { name: "chair" },
        x: chairX,
        y: chairY,
      },
      depth: chairY,
      ownerAgentId: owner,
    },
  ];
  // Under the desk's RIGHT half - the chair is under its left, and a packed
  // box standing in the seat would read as furniture rather than as moving
  // out.
  const boxTile: OfficeTilePos = {
    col: seat.deskTile.col + 1,
    row: seat.deskTile.row + 1,
  };
  out.push({
    drawable: {
      kind: "sprite",
      sprite: { name: "box" },
      x: boxTile.col * OFFICE_TILE,
      y: officeSpriteFootY({ name: "box" }, boxTile.row),
    },
    depth: boxTile.row * OFFICE_TILE,
    ownerAgentId: owner,
  });
  if (state.name === null) return out;
  out.push({
    drawable: {
      kind: "label",
      text: truncate(state.name, MAX_LABEL_CHARS),
      // Exactly where the seated character's own label was, so the desk does
      // not appear to shift when its owner leaves: a character's tag hangs a
      // gap below its FEET, and its feet are the bottom of its chair tile.
      x: chairX + OFFICE_CHARACTER_WIDTH / 2,
      y: chairY + OFFICE_TILE + LABEL_GAP,
      tone: "muted",
      ownerAgentId: owner,
    },
    depth: chairY,
    ownerAgentId: owner,
  });
  return out;
}

/**
 * One desk, as it stands this instant.
 *
 * A CUBBY is the exception the contract names: a one-tile slot where a cold
 * agent waits has no screen to light, no plate to put a logo on and no pile to
 * stack. The Floor makes none, so on this view the branch never fires - it is
 * here because the rule belongs to the painter rather than to the views that
 * happen to need it.
 */
function seatPropsOf(
  _layout: OfficeLayout,
  seat: OfficeSeat,
  state: OfficeDeskState,
  _lod: OfficeLod,
): ReadonlyArray<OfficeWorldDrawable> {
  const deskX = seat.deskTile.col * OFFICE_TILE;
  const deskY = seat.deskTile.row * OFFICE_TILE;
  const owner = state.agentId;
  const out: OfficeWorldDrawable[] = [
    {
      drawable: {
        kind: "sprite",
        sprite: { name: seat.kind === "cubby" ? "chair" : "desk" },
        x: deskX,
        y: deskY,
      },
      depth: deskY,
      ownerAgentId: owner,
    },
  ];
  if (seat.kind === "cubby") return out;
  if (state.sheeted) return sheetedDesk(seat, state);
  // Shares the desk's depth so it always lands ON the desk, even though it is
  // drawn above the desk's own top edge.
  const art = screenArtFor(state);
  const screen = monitorSpriteFor(state);
  const crashed = screen === "monitor-crash";
  out.push({
    drawable: {
      kind: "sprite",
      sprite: { name: screen },
      x: deskX + (crashed ? art.crashXOffset : art.xOffset),
      y: deskY + (crashed ? art.crashYOffset : art.yOffset),
      alpha: monitorAlphaFor(state),
    },
    depth: deskY,
    ownerAgentId: owner,
  });
  // After the screen, in the same bucket: the paper is in FRONT of the
  // display's lower-left corner, not behind it.
  const stack = envelopeStackFor(state);
  if (stack !== null) {
    out.push({
      drawable: {
        kind: "sprite",
        sprite: { name: stack.sprite },
        x: deskX + stack.xOffset,
        y: deskY + stack.yOffset,
      },
      depth: deskY,
      ownerAgentId: owner,
    });
  }
  out.push({
    drawable: {
      kind: "sprite",
      sprite: { name: "chair" },
      x: seat.chairTile.col * OFFICE_TILE,
      y: seat.chairTile.row * OFFICE_TILE,
    },
    depth: seat.chairTile.row * OFFICE_TILE,
    ownerAgentId: owner,
  });
  // The plate and its logo share the desk's depth for the same reason the
  // monitor does: they are ON the desk, drawn above its own top edge.
  out.push({
    drawable: {
      kind: "sprite",
      sprite: { name: "nameplate" },
      x: deskX + art.plateXOffset,
      y: deskY + NAMEPLATE_Y_OFFSET,
    },
    depth: deskY,
    ownerAgentId: owner,
  });
  // The scene places the logo and never sees the icon; a record that carries
  // no harness simply has an empty plate.
  if (state.harnessId !== null) {
    out.push({
      drawable: {
        kind: "logo",
        harnessId: state.harnessId,
        x: deskX + art.logoXOffset,
        y: deskY + LOGO_Y_OFFSET,
      },
      depth: deskY,
      ownerAgentId: owner,
    });
  }
  return out;
}

// ---- The view's painter ----------------------------------------------- //

/**
 * The Floor's projector is the IDENTITY: a tile is sixteen pixels square,
 * where it always was. Every other view bends this, which is precisely why the
 * scene has to go through it even here - a routine that shortcut the identity
 * would be a routine that only works on one view.
 */
function floorProjector(layout: OfficeLayout): OfficeProjector {
  return {
    project: (col, row) => ({ x: col * OFFICE_TILE, y: row * OFFICE_TILE }),
    bounds: {
      x: 0,
      y: 0,
      width: layout.cols * OFFICE_TILE,
      height: layout.rows * OFFICE_TILE,
    },
    seatLift: () => 0,
  };
}

/** Shared, so a frame that walks a floor's spots allocates nothing per spot. */
const NO_SPOT_PROPS: ReadonlyArray<OfficeWorldDrawable> = [];

export const floorPainter: OfficePainter = {
  // Props then actors, as the office always has: nothing on this floor stands
  // in front of its own occupant.
  depth: "layered",
  projector: floorProjector,
  floor: floorChunk,
  seatProps: seatPropsOf,
  /**
   * Nothing. Every fixture an errand spot names - the bin, the cafe table, the
   * dartboard - is a prop in `layout.props` and is already drawn with the
   * scenery, because on this floor it never moves and never changes.
   */
  spotProps: (
    _layout: OfficeLayout,
    _spot: OfficeErrandSpot,
    _lod: OfficeLod,
  ) => NO_SPOT_PROPS,
};
