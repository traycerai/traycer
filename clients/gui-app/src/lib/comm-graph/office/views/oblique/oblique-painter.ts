/** Oblique art shares the simulation's tile grid; only foreground depth differs. */
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { isOfficeHotStatus } from "@/lib/comm-graph/office/office-status";
import {
  OFFICE_LABEL_GAP,
  OFFICE_TILE,
} from "@/lib/comm-graph/office/office-types";
import type {
  OfficeBlockFill,
  OfficeDrawable,
  OfficeErrandKind,
  OfficeErrandSpot,
  OfficeLayout,
  OfficeLod,
  OfficeSeat,
  OfficeSpriteName,
  OfficeSpriteRef,
  OfficeTileRect,
  OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";
import type {
  OfficeDeskState,
  OfficePainter,
  OfficeProjector,
} from "../office-view";

import {
  obliqueIsPlaza,
  obliquePropsIn,
  obliqueReserveLabelSeatId,
} from "./oblique-plan";

/**
 * How far below a desk seat's own tile the desk FACE hangs, in world pixels.
 *
 * Named because three things measure from it: the desk, the dust sheet over an
 * archived one, and the `reserve` lettering that has to clear both.
 */
const DESK_FRONT_Y_OFFSET = 24;

/**
 * How solid an unclaimed desk is.
 *
 * `0.45` was transparent enough to take the sprite's OUTLINE with it - a
 * near-black line at 45% over a dark floor is barely a line - so an empty desk
 * read as a brown bar painted onto the floor rather than as furniture nobody
 * is sitting at. Feedback round 1: "these transparent desks look weird".
 *
 * The dimming itself stays: it is what says the desk is unclaimed on a storey
 * whose occupied desks look otherwise identical. What changes is that the
 * furniture survives it.
 */
const EMPTY_FURNITURE_ALPHA = 0.72;

const STATIC_PROPS: ReadonlySet<OfficeSpriteName> = new Set([
  "face",
  "slab",
  "stairs-side",
  "roof-edge",
  "skybridge",
  "floor-a",
  "floor-b",
  "window",
  "door",
  "partition",
  "board",
  "reception",
  // The civic bay's fittings: its glazed screen, the cross over its doorway and
  // the archive's door. Fixed pieces of the plaza, like the reception counter -
  // the beds and the chairs inside are SEATS and are drawn from `layout.seats`.
  "glass-partition",
  "cross-sign",
  "records-door",
]);
interface ObliqueFixturePart {
  readonly name: OfficeSpriteName;
  readonly col: number;
  readonly row: number;
  readonly anchor: "top" | "bottom";
  /** Depth relative to the action tile's bottom edge, in tiles. */
  readonly depth: number;
}
/** One fixture recipe shared by plan placement and pure world painting. */
export const OBLIQUE_FIXTURES: Readonly<
  Partial<Record<OfficeErrandKind, ReadonlyArray<ObliqueFixturePart>>>
> = {
  cafe: [{ name: "cafe-table", col: 0, row: 0, anchor: "bottom", depth: 0 }],
  coffee: [
    { name: "coffee-machine", col: 0, row: 0, anchor: "bottom", depth: 0 },
  ],
  sofa: [{ name: "sofa", col: 0, row: 0, anchor: "bottom", depth: 0 }],
  pingpong: [
    { name: "pingpong-table", col: 0, row: 0, anchor: "bottom", depth: 0 },
  ],
  nap: [{ name: "sleep-bag", col: 0, row: 0, anchor: "bottom", depth: 0 }],
  read: [
    { name: "bookcase", col: 0, row: -1, anchor: "top", depth: -1 },
    { name: "armchair", col: 0, row: 0, anchor: "bottom", depth: 0 },
  ],
  treadmill: [
    { name: "treadmill", col: 0, row: 0, anchor: "bottom", depth: 0 },
  ],
  cooler: [
    { name: "water-cooler", col: 0, row: 0, anchor: "bottom", depth: 0 },
  ],
  "water-plant": [
    { name: "plant", col: 0, row: 0, anchor: "bottom", depth: 0 },
  ],
  whiteboard: [{ name: "whiteboard", col: 0, row: 0, anchor: "top", depth: 0 }],
};

function projector(layout: OfficeLayout): OfficeProjector {
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
interface BlockRegion {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
  readonly fill: OfficeBlockFill;
}
function clippedBlock(
  region: BlockRegion,
  tiles: OfficeTileRect,
): OfficeDrawable[] {
  const col = Math.max(region.col, tiles.col);
  const row = Math.max(region.row, tiles.row);
  const right = Math.min(region.col + region.cols, tiles.col + tiles.cols);
  const bottom = Math.min(region.row + region.rows, tiles.row + tiles.rows);
  if (right <= col || bottom <= row) return [];
  return [
    {
      kind: "block",
      x: col * OFFICE_TILE,
      y: row * OFFICE_TILE,
      width: (right - col) * OFFICE_TILE,
      height: (bottom - row) * OFFICE_TILE,
      fill: region.fill,
    },
  ];
}
function overviewBlocks(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): OfficeDrawable[] {
  const buildings = layout.signs
    .filter((sign) => sign.kind === "host")
    .flatMap((sign) =>
      clippedBlock(
        {
          col: sign.tile.col,
          row: 0,
          cols: sign.widthTiles,
          rows: sign.tile.row + 1,
          fill: "building",
        },
        tiles,
      ),
    );
  const storeys = layout.floors.flatMap((floor, floorIndex) =>
    clippedBlock(
      {
        ...floor.bounds,
        fill: obliqueIsPlaza(layout, floorIndex) ? "plaza" : "storey",
      },
      tiles,
    ),
  );
  // After the storeys, so a bay inside the plaza is the block a reader sees. At
  // this zoom the ward and the waiting room are the two regions on a plaza
  // worth telling apart from the amenities around them. Walked from the floors'
  // own `civic` rather than from `layout.rooms`, which this view never reads.
  const civic = layout.floors.flatMap((floor) =>
    floor.civic.flatMap((room) =>
      clippedBlock({ ...room.bounds, fill: "civic" }, tiles),
    ),
  );
  return [...buildings, ...storeys, ...civic];
}
/**
 * THE GROUND A CIVIC ROOM STANDS ON, tinted so the room has an edge.
 *
 * Every plaza room is `enclosure: "open"` - the waiting room IS a row of
 * chairs on the walk row, the front desk IS a counter and the tile in front of
 * it - so until now the only thing saying where one ended was its sign. A
 * reader seeing seated agents a row below the `WAITING ROOM` plate had no way
 * to tell they were at cubbies on the plaza, and feedback round 1 asked
 * exactly that: "some agents are working from the waiting room?".
 *
 * The same `civic` fill the overview block map already uses, at an alpha that
 * reads as floor rather than as a panel. Emitted into the FLOOR stream, which
 * puts it under every prop and character - it is ground, not a highlight - and
 * it costs one filled rect per room per frame because a block does not bake
 * into the static layer (only sprites do).
 */
const CIVIC_GROUND_ALPHA = 0.3;

function civicGround(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): OfficeDrawable[] {
  return layout.floors.flatMap((storey) =>
    storey.civic.flatMap((room) =>
      clippedBlock({ ...room.bounds, fill: "civic" }, tiles).map((block) => ({
        ...block,
        alpha: CIVIC_GROUND_ALPHA,
      })),
    ),
  );
}

function floor(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
  lod: OfficeLod,
): OfficeDrawable[] {
  if (lod === 0) return overviewBlocks(layout, tiles);
  const props: OfficeDrawable[] = obliquePropsIn(layout, tiles)
    .filter((prop) => STATIC_PROPS.has(prop.sprite.name))
    .map((prop) => ({
      kind: "sprite",
      sprite: prop.sprite,
      x: prop.tile.col * OFFICE_TILE,
      y: prop.tile.row * OFFICE_TILE,
    }));
  // LAST, because a block put before the floor TILES is painted over by them
  // on the host that walks this list in order - the fallback path, where no
  // offscreen surface exists - and invisible there while working everywhere
  // else. Last is the position both paths draw over the tiles from.
  //
  // The two paths do differ on the plaza's fixed PROPS, which are sprites in
  // this same stream: a baking host blits every sprite and then draws this
  // block, so the tint passes over the reception counter and the glass screens;
  // an unbaked host draws them after it. At 0.3 alpha over a counter that is a
  // difference nothing can see, and it is the price of a tint that bakes
  // nowhere - only sprites bake (`officeBakesIntoStaticFloor`).
  return [...props, ...civicGround(layout, tiles)];
}
interface PropPaint {
  readonly ownerAgentId: string | null;
  readonly alpha: number;
}
function entry(
  sprite: OfficeSpriteRef,
  point: { readonly x: number; readonly y: number },
  depth: number,
  paint: PropPaint,
): OfficeWorldDrawable {
  return {
    drawable: { kind: "sprite", sprite, ...point, alpha: paint.alpha },
    depth,
    ownerAgentId: paint.ownerAgentId,
  };
}
/**
 * A crashed screen first, then lit or dark by WHETHER THE AGENT IS HOT - the
 * shared reading of that, not a list of the cold ones spelled out again here.
 *
 * This view's screen really is the hot/cold boolean, which is what makes the
 * shared predicate the right thing to ask; Floor and Mission control light
 * their monitors by their own per-status art rules and are not asking this
 * question at all. Restating the cold members locally passed for as long as
 * the two agreed, and would have gone on passing: a status added to the union
 * and classified cold would be dark everywhere the predicate is read and lit
 * on this one view, with every existing sprite expectation still green.
 */
function screen(state: OfficeDeskState): OfficeSpriteName {
  if (state.status === "failure") return "monitor-crash";
  const lit = isOfficeHotStatus(state.status);
  if (state.modelTier === "small")
    return lit ? "monitor-small-on" : "monitor-small-off";
  if (state.modelTier === "large") {
    if (!lit) return "monitor-wide-off";
    return state.screenFrame === 0 ? "monitor-wide-on" : "monitor-wide-on-b";
  }
  if (!lit) return "monitor-off";
  return state.screenFrame === 0 ? "monitor-on" : "monitor-on-b";
}
function envelopeStack(count: number): OfficeSpriteName {
  if (count === 1) return "envelope-stack-1";
  if (count === 2) return "envelope-stack-2";
  return "envelope-stack-3";
}
/**
 * A CIVIC SEAT IS FURNITURE LIKE ANY OTHER SEAT, so the bed and the chair are
 * drawn from `layout.seats`, the way a desk is. Standing them up as plan props
 * instead would put a seat's art where the per-seat drawable budget cannot
 * count it, and `office-plan-perf`'s denominator is that budget. The turned-down
 * sheet is the one piece that changes: it rides the desk-state cache key, so the
 * ward repaints when a bed is taken and at no other time.
 *
 * Both sprites are exactly their tiles - 32x16 for a two-tile bed, 16x16 for a
 * chair - so the tile's own corner is where they go, with no anchoring.
 */
function civicSeatProps(
  seat: OfficeSeat,
  point: { readonly x: number; readonly y: number },
  foot: number,
  owner: string | null,
): OfficeWorldDrawable[] {
  const bed = seat.kind === "bed";
  const paint = { ownerAgentId: owner, alpha: 1 };
  const civic = [
    entry({ name: bed ? "bed" : "lounge-chair" }, point, foot, paint),
  ];
  if (bed && owner !== null)
    civic.push(entry({ name: "bed-occupied" }, point, foot + 0.1, paint));
  return civic;
}
/** A cubby, tinted to its occupant, boxed up or with a silhouette inside it. */
function cubbySeatProps(
  state: OfficeDeskState,
  point: { readonly x: number; readonly y: number },
  foot: number,
  lod: OfficeLod,
): OfficeWorldDrawable[] {
  const owner = state.agentId;
  const cubby = [
    entry(
      {
        name: "cubby",
        tint:
          state.accentId === null
            ? undefined
            : agentAppearance(state.accentId, "chat", null).shirt,
      },
      point,
      foot + 0.1,
      { ownerAgentId: owner, alpha: 1 },
    ),
  ];
  if (state.sheeted)
    cubby.push(
      entry({ name: "box" }, point, foot + 0.2, {
        ownerAgentId: owner,
        alpha: 1,
      }),
    );
  else if (owner !== null && lod < 2)
    cubby.push(
      entry({ name: "silhouette" }, point, foot, {
        ownerAgentId: owner,
        alpha: 0.55,
      }),
    );
  // The scene supplies the dimmed, front-facing character at close-up.
  return cubby;
}
/**
 * The seat-kind dispatch, and then a desk at length.
 *
 * The two short kinds are lifted out rather than nested here: this view now
 * paints four of them, and the desk alone is already at the complexity the
 * linter allows a function.
 */
function seatProps(
  layout: OfficeLayout,
  seat: OfficeSeat,
  state: OfficeDeskState,
  lod: OfficeLod,
): OfficeWorldDrawable[] {
  if (lod === 0) return [];
  const x = seat.deskTile.col * OFFICE_TILE;
  const y = seat.deskTile.row * OFFICE_TILE;
  const foot = (seat.chairTile.row + 1) * OFFICE_TILE;
  const owner = state.agentId;
  if (seat.kind === "bed" || seat.kind === "lounge")
    return civicSeatProps(seat, { x: x, y: y }, foot, owner);
  if (seat.kind === "cubby")
    return cubbySeatProps(state, { x: x, y: y }, foot, lod);
  const result: OfficeWorldDrawable[] = [
    entry(
      { name: "desk-front" },
      { x: x, y: y + DESK_FRONT_Y_OFFSET },
      foot + 0.1,
      {
        ownerAgentId: owner,
        alpha: owner === null ? EMPTY_FURNITURE_ALPHA : 1,
      },
    ),
  ];
  if (owner === null) {
    // ONCE A STOREY, not once a desk: the storey nominates the seat that says
    // it, and every other empty desk on that floor says it with its own dark,
    // half-lit furniture instead.
    if (
      lod === 2 &&
      obliqueReserveLabelSeatId(layout, seat.floorIndex) === seat.seatId
    )
      result.push({
        drawable: {
          kind: "label",
          text: "reserve",
          ownerAgentId: null,
          x: x + 16,
          // CLEAR OF THE DESK FACE, on the floor among its legs - where the
          // name tag of the agent at the next desk along already lands.
          //
          // `y + 34` put it across the desk's own front panel, where muted
          // grey lettering over the wood read as a name with its bottom half
          // missing (feedback round 1: "lower half of labels on some agents
          // are cut out"). The desk face runs to `y + DESK_FRONT_Y_OFFSET +
          // <sprite height>`, and the gap below it is the scene's own.
          y:
            y +
            DESK_FRONT_Y_OFFSET +
            officeSpriteSize({ name: "desk-front" }).height +
            OFFICE_LABEL_GAP,
          tone: "muted",
          // Nobody's name, so no seat to be fitted to.
          fitTiles: null,
        },
        depth: foot + 0.2,
        ownerAgentId: null,
      });
    return result;
  }
  if (state.sheeted) {
    result.push(
      entry(
        { name: "dust-sheet" },
        { x: x, y: y + DESK_FRONT_Y_OFFSET },
        foot + 0.2,
        {
          ownerAgentId: owner,
          alpha: 1,
        },
      ),
      entry({ name: "box" }, { x: x + 16, y: y + 8 }, foot - 0.1, {
        ownerAgentId: owner,
        alpha: 1,
      }),
    );
    return result;
  }
  const monitor = screen(state);
  const monitorSize = officeSpriteSize({ name: monitor });
  result.push(
    entry(
      { name: monitor },
      { x: x + (32 - monitorSize.width) / 2, y: y },
      y + monitorSize.height,
      { ownerAgentId: owner, alpha: 1 },
    ),
  );
  if (state.status === "working")
    result.push(
      entry({ name: "lamp" }, { x: x + 24, y: y + 6 }, y + 14, {
        ownerAgentId: owner,
        alpha: 1,
      }),
    );
  if (state.openRequests > 0) {
    const stack = envelopeStack(state.openRequests);
    const height = officeSpriteSize({ name: stack }).height;
    result.push(
      entry({ name: stack }, { x: x, y: y + 16 - height }, y + 16, {
        ownerAgentId: owner,
        alpha: 1,
      }),
    );
  }
  result.push(
    entry({ name: "nameplate" }, { x: x + 18, y: y + 28 }, foot + 0.2, {
      ownerAgentId: owner,
      alpha: 1,
    }),
  );
  if (state.harnessId !== null)
    result.push({
      drawable: {
        kind: "logo",
        harnessId: state.harnessId,
        x: x + 24,
        y: y + 30,
      },
      depth: foot + 0.3,
      ownerAgentId: owner,
    });
  return result;
}
function spotProps(
  layout: OfficeLayout,
  spot: OfficeErrandSpot,
  lod: OfficeLod,
): OfficeWorldDrawable[] {
  if (lod === 0 || spot.actionTile === null) return [];
  const bounds = layout.floors[spot.floorIndex].bounds;
  // Aliases point outside the receiving storey, irrespective of object identity.
  if (
    spot.tile.col < bounds.col ||
    spot.tile.col >= bounds.col + bounds.cols ||
    spot.tile.row < bounds.row ||
    spot.tile.row >= bounds.row + bounds.rows
  )
    return [];
  const action = spot.actionTile;
  const firstCol = action.col - (spot.kind === "pingpong" ? 1 : 0);
  if (spot.tile.col !== firstCol) return [];
  const foot = (action.row + 1) * OFFICE_TILE;
  return (OBLIQUE_FIXTURES[spot.kind] ?? []).map((part) => {
    const sprite = { name: part.name };
    const size = officeSpriteSize(sprite);
    const y =
      (action.row + part.row) * OFFICE_TILE +
      (part.anchor === "bottom" ? OFFICE_TILE - size.height : 0);
    return entry(
      sprite,
      { x: (action.col + part.col) * OFFICE_TILE, y },
      foot + part.depth * OFFICE_TILE,
      { ownerAgentId: null, alpha: 1 },
    );
  });
}
export const OBLIQUE_PAINTER: OfficePainter = {
  depth: "world",
  projector,
  floor,
  seatProps,
  /**
   * NOT ASKED, and not because of a pass: this IS a `world` painter, so the
   * scene's depth-ordered hit regions apply to it in full. It paints a civic seat
   * ITSELF (`civicSeatProps`, keyed on `seat.kind`), so a bed and a chair are
   * OWNED drawables in the world stream - each one a region at its own depth,
   * ordered against characters by the same number the frame drew it with. Saying
   * nothing here leaves the seat's whole box on the owner's props, which is what
   * it has always sorted by. The isometric painter is the one whose `seatProps`
   * returns nothing for a civic seat, and so the one that has to answer.
   */
  seatDepth: null,
  spotProps,
  /**
   * NONE. This painter's block is the tile rect itself, scaled by the tile
   * size under an identity projector, so a query tight to the tiles finds
   * every block that covers it.
   */
  blockOverhangPx: () => 0,
};
