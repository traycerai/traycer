/**
 * Layered painter for Mission control. Identity projector; lod 0 is one
 * filled rect per console tier.
 */
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import {
  frozenOf,
  originColFor,
  ROWS_PER_TIER,
  seatingWidth,
  TIERS_ORIGIN_ROW,
} from "@/lib/comm-graph/office/views/mission-control/mission-control-plan";
import type {
  OfficeDeskState,
  OfficePainter,
  OfficeProjector,
} from "@/lib/comm-graph/office/views/office-view";
import type {
  OfficeDrawable,
  OfficeErrandSpot,
  OfficeLayout,
  OfficeLod,
  OfficeModelTier,
  OfficeSeat,
  OfficeSpriteName,
  OfficeTilePos,
  OfficeTileRect,
  OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";

const NAMEPLATE_Y_OFFSET = 4;
const LOGO_Y_OFFSET = 1;
const RESERVE_ALPHA = 0.55;
const IDLE_MONITOR_ALPHA = 0.6;
const ARCHIVED_ALPHA = 0.45;

interface ScreenArt {
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

const SCREEN_ART: Readonly<Record<OfficeModelTier, ScreenArt>> = {
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

interface EnvelopeStackArt {
  readonly sprite: OfficeSpriteName;
  readonly xOffset: number;
  readonly yOffset: number;
}

const ENVELOPE_STACKS: ReadonlyArray<EnvelopeStackArt> = [
  { sprite: "envelope-stack-1", xOffset: 1, yOffset: -2 },
  { sprite: "envelope-stack-2", xOffset: 1, yOffset: -4 },
  { sprite: "envelope-stack-3", xOffset: 1, yOffset: -6 },
];

const SPOT_SPRITES: Readonly<
  Partial<Record<OfficeErrandSpot["kind"], OfficeSpriteName>>
> = {
  coffee: "coffee-machine",
  cooler: "water-cooler",
  cafe: "cafe-table",
  sofa: "sofa",
  bin: "bin",
  "water-plant": "plant",
  pingpong: "pingpong-table",
  nap: "sleep-bag",
  read: "armchair",
  treadmill: "treadmill",
  whiteboard: "whiteboard",
};

function worldOf(
  drawable: OfficeDrawable,
  depth: number,
  ownerAgentId: string | null,
): OfficeWorldDrawable {
  return { drawable, depth, ownerAgentId };
}

function identityProjector(layout: OfficeLayout): OfficeProjector {
  return {
    project: (col: number, row: number) => ({
      x: col * OFFICE_TILE,
      y: row * OFFICE_TILE,
    }),
    bounds: {
      x: 0,
      y: 0,
      width: layout.cols * OFFICE_TILE,
      height: layout.rows * OFFICE_TILE,
    },
    seatLift: (_seat: OfficeSeat): number => 0,
  };
}

function floorSpriteAt(col: number, row: number): OfficeSpriteName {
  return (col + row) % 2 === 0 ? "floor-a" : "floor-b";
}

function isSpriteRecord(
  value: unknown,
): value is Readonly<Record<string, OfficeSpriteName>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function floorLookups(layout: OfficeLayout): {
  readonly bandByTile: Readonly<Record<string, OfficeSpriteName>>;
  readonly podByTile: Readonly<Record<string, OfficeSpriteName>>;
} | null {
  const frozen = layout.frozen;
  if (frozen === null || typeof frozen !== "object") return null;
  if (!("bandByTile" in frozen) || !("podByTile" in frozen)) return null;
  if (!isSpriteRecord(frozen.bandByTile)) return null;
  if (!isSpriteRecord(frozen.podByTile)) return null;
  return {
    bandByTile: frozen.bandByTile,
    podByTile: frozen.podByTile,
  };
}

function tileRectsOverlap(
  left: OfficeTileRect,
  right: OfficeTileRect,
): boolean {
  return (
    left.col < right.col + right.cols &&
    left.col + left.cols > right.col &&
    left.row < right.row + right.rows &&
    left.row + left.rows > right.row
  );
}

function blockMap(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): ReadonlyArray<OfficeDrawable> {
  const frozen = frozenOf(layout);
  if (frozen === null) return [];
  const blocks: OfficeDrawable[] = [];
  for (let tier = 0; tier < frozen.tierSeatCounts.length; tier += 1) {
    const count = frozen.tierSeatCounts[tier];
    const bounds: OfficeTileRect = {
      col: originColFor(count, frozen.centerCol),
      row: TIERS_ORIGIN_ROW + tier * ROWS_PER_TIER,
      cols: seatingWidth(count),
      rows: ROWS_PER_TIER,
    };
    if (!tileRectsOverlap(bounds, tiles)) continue;
    blocks.push({
      kind: "block",
      x: bounds.col * OFFICE_TILE,
      y: bounds.row * OFFICE_TILE,
      width: bounds.cols * OFFICE_TILE,
      height: bounds.rows * OFFICE_TILE,
      fill: "storey",
    });
  }
  return blocks;
}

function ownedPropKeys(layout: OfficeLayout): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const floor of layout.floors) {
    for (const spot of floor.errandSpots) {
      const sprite = SPOT_SPRITES[spot.kind];
      if (sprite === undefined) continue;
      const tile = fixtureTile(spot);
      keys.add(`${sprite}:${tile.col},${tile.row}`);
    }
  }
  return keys;
}

function propOverlapsTiles(
  prop: OfficeLayout["props"][number],
  tiles: OfficeTileRect,
): boolean {
  const size = officeSpriteSize(prop.sprite);
  const x = prop.tile.col * OFFICE_TILE;
  const y = prop.tile.row * OFFICE_TILE;
  const left = tiles.col * OFFICE_TILE;
  const top = tiles.row * OFFICE_TILE;
  const right = left + tiles.cols * OFFICE_TILE;
  const bottom = top + tiles.rows * OFFICE_TILE;
  return (
    x < right && x + size.width > left && y < bottom && y + size.height > top
  );
}

function paintUnownedProps(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
): ReadonlyArray<OfficeDrawable> {
  const owned = ownedPropKeys(layout);
  const drawables: OfficeDrawable[] = [];
  for (const prop of layout.props) {
    const key = `${prop.sprite.name}:${prop.tile.col},${prop.tile.row}`;
    if (owned.has(key)) continue;
    if (!propOverlapsTiles(prop, tiles)) continue;
    drawables.push({
      kind: "sprite",
      sprite: prop.sprite,
      x: prop.tile.col * OFFICE_TILE,
      y: prop.tile.row * OFFICE_TILE,
    });
  }
  return drawables;
}

function paintFloor(
  layout: OfficeLayout,
  tiles: OfficeTileRect,
  lod: OfficeLod,
): ReadonlyArray<OfficeDrawable> {
  if (lod === 0) return blockMap(layout, tiles);
  const drawables: OfficeDrawable[] = [];
  const lookups = floorLookups(layout);
  const lastCol = tiles.col + tiles.cols;
  const lastRow = tiles.row + tiles.rows;
  for (let row = tiles.row; row < lastRow; row += 1) {
    if (row < 0 || row >= layout.rows) continue;
    for (let col = tiles.col; col < lastCol; col += 1) {
      if (col < 0 || col >= layout.cols) continue;
      const key = `${col},${row}`;
      const band = lookups === null ? undefined : lookups.bandByTile[key];
      const tinted = lookups === null ? undefined : lookups.podByTile[key];
      let sprite: OfficeSpriteName =
        tinted === undefined ? floorSpriteAt(col, row) : tinted;
      if (band !== undefined) sprite = band;
      drawables.push({
        kind: "sprite",
        sprite: { name: sprite },
        x: col * OFFICE_TILE,
        y: row * OFFICE_TILE,
      });
    }
  }
  drawables.push(...paintUnownedProps(layout, tiles));
  return drawables;
}

function monitorSpriteFor(state: OfficeDeskState): OfficeSpriteName {
  const art = SCREEN_ART[state.modelTier];
  if (state.status === "failure") return "monitor-crash";
  if (state.status === "working" || state.status === "background") {
    if (state.screenFrame === 1 && art.onB !== null) return art.onB;
    return art.on;
  }
  return art.off;
}

function monitorAlphaFor(state: OfficeDeskState): number | undefined {
  if (state.status === "archived") return ARCHIVED_ALPHA;
  if (state.status === "idle") return IDLE_MONITOR_ALPHA;
  return undefined;
}

function envelopeStackFor(openRequests: number): EnvelopeStackArt | null {
  if (openRequests <= 0) return null;
  if (openRequests === 1) return ENVELOPE_STACKS[0];
  if (openRequests === 2) return ENVELOPE_STACKS[1];
  return ENVELOPE_STACKS[2];
}

function paintSeat(
  _layout: OfficeLayout,
  seat: OfficeSeat,
  state: OfficeDeskState,
  lod: OfficeLod,
): ReadonlyArray<OfficeWorldDrawable> {
  if (lod === 0) return [];
  const deskX = seat.deskTile.col * OFFICE_TILE;
  const deskY = seat.deskTile.row * OFFICE_TILE;
  const depth = deskY + OFFICE_TILE;
  const owner = state.agentId;
  const out: OfficeWorldDrawable[] = [];
  if (seat.kind === "console") {
    const stepY = seat.chairTile.row * OFFICE_TILE;
    const stepDepth = stepY - 1;
    out.push(
      worldOf(
        {
          kind: "sprite",
          sprite: { name: "tier-step" },
          x: deskX,
          y: stepY,
        },
        stepDepth,
        owner,
      ),
    );
    out.push(
      worldOf(
        {
          kind: "sprite",
          sprite: { name: "tier-step" },
          x: deskX + OFFICE_TILE,
          y: stepY,
        },
        stepDepth,
        owner,
      ),
    );
  }
  const furniture: OfficeSpriteName =
    seat.kind === "console" ? "console" : "podium";
  const reserve = state.agentId === null;
  out.push(
    worldOf(
      reserve
        ? {
            kind: "sprite",
            sprite: { name: furniture },
            x: deskX,
            y: deskY,
            alpha: RESERVE_ALPHA,
          }
        : {
            kind: "sprite",
            sprite: { name: furniture },
            x: deskX,
            y: deskY,
          },
      depth,
      owner,
    ),
  );
  out.push(
    worldOf(
      {
        kind: "sprite",
        sprite: { name: "chair" },
        x: seat.chairTile.col * OFFICE_TILE,
        y: seat.chairTile.row * OFFICE_TILE,
      },
      seat.chairTile.row * OFFICE_TILE + OFFICE_TILE,
      owner,
    ),
  );
  if (state.sheeted) {
    out.push(
      worldOf(
        {
          kind: "sprite",
          sprite: { name: "dust-sheet" },
          x: deskX,
          y: deskY,
        },
        depth + 1,
        owner,
      ),
    );
    out.push(
      worldOf(
        {
          kind: "sprite",
          sprite: { name: "box" },
          x: (seat.deskTile.col + 1) * OFFICE_TILE,
          y: (seat.deskTile.row + 1) * OFFICE_TILE,
        },
        depth + 1,
        owner,
      ),
    );
    return out;
  }
  if (reserve) {
    if (lod === 2) {
      out.push(
        worldOf(
          {
            kind: "label",
            text: "reserve",
            x: deskX + OFFICE_TILE,
            y: deskY + OFFICE_TILE,
            tone: "muted",
            ownerAgentId: null,
          },
          depth + 1,
          null,
        ),
      );
    }
    return out;
  }
  const art = SCREEN_ART[state.modelTier];
  const screen = monitorSpriteFor(state);
  const crashed = screen === "monitor-crash";
  const alpha = monitorAlphaFor(state);
  out.push(
    worldOf(
      {
        kind: "sprite",
        sprite: { name: screen },
        x: deskX + (crashed ? art.crashXOffset : art.xOffset),
        y: deskY + (crashed ? art.crashYOffset : art.yOffset),
        alpha,
      },
      depth + 1,
      owner,
    ),
  );
  const stack = envelopeStackFor(state.openRequests);
  if (stack !== null) {
    out.push(
      worldOf(
        {
          kind: "sprite",
          sprite: { name: stack.sprite },
          x: deskX + stack.xOffset,
          y: deskY + stack.yOffset,
        },
        depth + 2,
        owner,
      ),
    );
  }
  out.push(
    worldOf(
      {
        kind: "sprite",
        sprite: { name: "nameplate" },
        x: deskX + art.plateXOffset,
        y: deskY + NAMEPLATE_Y_OFFSET,
      },
      depth + 1,
      owner,
    ),
  );
  if (state.harnessId !== null) {
    out.push(
      worldOf(
        {
          kind: "logo",
          harnessId: state.harnessId,
          x: deskX + art.logoXOffset,
          y: deskY + LOGO_Y_OFFSET,
        },
        depth + 1,
        owner,
      ),
    );
  }
  return out;
}

function isFixtureOrigin(spot: OfficeErrandSpot): boolean {
  if (spot.kind === "pingpong") return spot.facing === "right";
  if (spot.kind === "cooler") return spot.facing === "right";
  if (spot.kind === "cafe" || spot.kind === "sofa") {
    return spot.actionTile !== null && spot.tile.col === spot.actionTile.col;
  }
  return true;
}

function fixtureTile(spot: OfficeErrandSpot): OfficeTilePos {
  if (
    spot.kind === "nap" ||
    spot.kind === "read" ||
    spot.kind === "treadmill"
  ) {
    return spot.tile;
  }
  if (spot.actionTile !== null && spot.kind !== "whiteboard") {
    return spot.actionTile;
  }
  if (spot.kind === "pingpong" && spot.actionTile !== null) {
    return spot.actionTile;
  }
  if (spot.kind === "whiteboard" && spot.actionTile !== null) {
    return spot.actionTile;
  }
  return spot.tile;
}

function paintSpot(
  _layout: OfficeLayout,
  spot: OfficeErrandSpot,
  lod: OfficeLod,
): ReadonlyArray<OfficeWorldDrawable> {
  if (lod === 0) return [];
  if (!isFixtureOrigin(spot)) return [];
  const sprite = SPOT_SPRITES[spot.kind];
  if (sprite === undefined) return [];
  const tile = fixtureTile(spot);
  const x = tile.col * OFFICE_TILE;
  const y = tile.row * OFFICE_TILE;
  return [
    worldOf(
      { kind: "sprite", sprite: { name: sprite }, x, y },
      y + OFFICE_TILE,
      null,
    ),
  ];
}

export const MISSION_CONTROL_PAINTER: OfficePainter = {
  depth: "layered",
  projector: identityProjector,
  floor: paintFloor,
  seatProps: paintSeat,
  spotProps: paintSpot,
};
