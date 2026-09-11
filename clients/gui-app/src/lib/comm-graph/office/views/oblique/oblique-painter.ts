/** Oblique art shares the simulation's tile grid; only foreground depth differs. */
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import type {
  OfficeBlockFill,
  OfficeDrawable,
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
  "whiteboard",
  "reception",
  "bookcase",
]);
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
  const storeys = layout.floors.flatMap((floor) =>
    clippedBlock(
      { ...floor.bounds, fill: floor.bounds.rows === 5 ? "plaza" : "storey" },
      tiles,
    ),
  );
  return [...buildings, ...storeys];
}
function floor(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
  lod: OfficeLod,
): OfficeDrawable[] {
  if (lod === 0) return overviewBlocks(layout, tiles);
  return layout.props
    .filter(
      (prop) =>
        STATIC_PROPS.has(prop.sprite.name) &&
        prop.tile.col >= tiles.col &&
        prop.tile.col < tiles.col + tiles.cols &&
        prop.tile.row >= tiles.row &&
        prop.tile.row < tiles.row + tiles.rows,
    )
    .map((prop) => ({
      kind: "sprite",
      sprite: prop.sprite,
      x: prop.tile.col * OFFICE_TILE,
      y: prop.tile.row * OFFICE_TILE,
    }));
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
function screen(state: OfficeDeskState): OfficeSpriteName {
  if (state.status === "failure") return "monitor-crash";
  const lit = state.status !== "idle" && state.status !== "archived";
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
function seatProps(
  _layout: OfficeLayout,
  seat: OfficeSeat,
  state: OfficeDeskState,
  lod: OfficeLod,
): OfficeWorldDrawable[] {
  if (lod === 0) return [];
  const x = seat.deskTile.col * OFFICE_TILE;
  const y = seat.deskTile.row * OFFICE_TILE;
  const foot = (seat.chairTile.row + 1) * OFFICE_TILE;
  const owner = state.agentId;
  if (seat.kind === "cubby") {
    const cubby = [
      entry(
        {
          name: "cubby",
          tint:
            state.accentId === null
              ? undefined
              : agentAppearance(state.accentId, "chat", null).shirt,
        },
        { x: x, y: y },
        foot + 0.1,
        {
          ownerAgentId: owner,
          alpha: 1,
        },
      ),
    ];
    if (state.sheeted)
      cubby.push(
        entry({ name: "box" }, { x: x, y: y }, foot + 0.2, {
          ownerAgentId: owner,
          alpha: 1,
        }),
      );
    else if (owner !== null && lod < 2)
      cubby.push(
        entry({ name: "silhouette" }, { x: x, y: y }, foot, {
          ownerAgentId: owner,
          alpha: 0.55,
        }),
      );
    // The scene supplies the dimmed, front-facing character at close-up.
    return cubby;
  }
  const result: OfficeWorldDrawable[] = [
    entry({ name: "desk-front" }, { x: x, y: y + 24 }, foot + 0.1, {
      ownerAgentId: owner,
      alpha: owner === null ? 0.45 : 1,
    }),
  ];
  if (owner === null) {
    if (lod === 2)
      result.push({
        drawable: {
          kind: "label",
          text: "reserve",
          ownerAgentId: null,
          x: x + 16,
          y: y + 34,
          tone: "muted",
        },
        depth: foot + 0.2,
        ownerAgentId: null,
      });
    return result;
  }
  if (state.sheeted) {
    result.push(
      entry({ name: "dust-sheet" }, { x: x, y: y + 24 }, foot + 0.2, {
        ownerAgentId: owner,
        alpha: 1,
      }),
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
  // A two-seat table is emitted once, by its first approach, never per patron.
  const first = layout.floors[spot.floorIndex].errandSpots.find(
    (candidate) => candidate.fixtureId === spot.fixtureId,
  );
  if (
    first === undefined ||
    first.tile.col !== spot.tile.col ||
    first.tile.row !== spot.tile.row
  )
    return [];
  const action = spot.actionTile;
  const plazaFloorIndex = layout.floors.findIndex(
    (candidate) =>
      candidate.hostId === layout.floors[spot.floorIndex].hostId &&
      candidate.bounds.row <= spot.tile.row &&
      candidate.bounds.row + candidate.bounds.rows > spot.tile.row &&
      candidate.bounds.col <= spot.tile.col &&
      candidate.bounds.col + candidate.bounds.cols > spot.tile.col,
  );
  if (plazaFloorIndex >= 0 && plazaFloorIndex !== spot.floorIndex) return [];
  return layout.props
    .filter(
      (prop) =>
        !STATIC_PROPS.has(prop.sprite.name) &&
        prop.tile.col === action.col &&
        prop.tile.row === action.row,
    )
    .map((prop) => {
      const size = officeSpriteSize(prop.sprite);
      const foot = (prop.tile.row + 1) * OFFICE_TILE;
      return entry(
        prop.sprite,
        { x: prop.tile.col * OFFICE_TILE, y: foot - size.height },
        foot,
        { ownerAgentId: null, alpha: 1 },
      );
    });
}
export const OBLIQUE_PAINTER: OfficePainter = {
  depth: "world",
  projector,
  floor,
  seatProps,
  spotProps,
};
