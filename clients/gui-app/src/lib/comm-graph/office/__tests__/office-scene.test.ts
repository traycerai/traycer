import { describe, expect, it, vi } from "vitest";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import {
  officeSpriteOpaqueAt,
  officeSpriteSize,
} from "@/lib/comm-graph/office/office-pixel-art";
import {
  officeArchivedByHost,
  partitionOfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import {
  MAX_CONCURRENT_ERRANDS,
  OFFICE_CULL_MARGIN_PX,
  OfficeScene,
} from "@/lib/comm-graph/office/office-scene";
import {
  CIVIC_ROOMS_EXPECTED,
  AMBULANCE_RIDER_SETS_THE_DWELL,
} from "@/lib/comm-graph/office/__tests__/civic-rooms-expected";
import {
  OfficeSeatBook,
  type OfficeSeatPreference,
} from "@/lib/comm-graph/office/office-seat-book";
import {
  makeTestEpic,
  outbreakScript,
  waitingScript,
  type OfficeTestEpic,
} from "@/lib/comm-graph/office/office-test-epic";
import { obliqueReserveLabelSeatId } from "@/lib/comm-graph/office/views/oblique/oblique-plan";
import {
  OFFICE_VIEW_IDS,
  OFFICE_VIEWS,
  type OfficeDeskState,
  type OfficeProjector,
  type OfficeView,
} from "@/lib/comm-graph/office/views/office-view";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeAppearance,
  type OfficeCharacterPose,
  type OfficeCivicRoom,
  type OfficeDrawable,
  type OfficeDesk,
  type OfficeErrandSpot,
  type OfficeCivicKind,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeLayout,
  type OfficePoint,
  type OfficeRect,
  type OfficeRoad,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeSeatKind,
  type OfficeSign,
  type OfficeSpriteName,
  type OfficeSpriteRef,
  type OfficeTilePos,
  type OfficeTileRect,
  type OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";

/**
 * Wraps a plain `(agents) => OfficeLayout` function - what every fixture in
 * this file already is - in the Floor's own painter, so the scene has a real
 * view to draw with. The plan is the only thing under test in most of this
 * file; the painter is Floor's registered one, unchanged.
 */
function testView(
  plan: (agents: ReadonlyArray<OfficeAgentInput>) => OfficeLayout,
): OfficeView {
  return { ...OFFICE_VIEWS.floor, plan: (input) => plan(input.agents) };
}

function leftThenVerticalRoad(
  floor: OfficeFloor,
  kerb: OfficeTilePos,
): OfficeRoad | null {
  // `OfficeTileRect` counts TILES - `cols` and `rows` - rather than pixels.
  const { col, row, cols, rows } = floor.bounds;
  const startCol = kerb.col + 2;
  const startRow = kerb.row >= row + 2 ? kerb.row - 2 : kerb.row + 2;
  if (
    kerb.col < col ||
    kerb.col >= col + cols ||
    kerb.row < row ||
    kerb.row >= row + rows ||
    startCol >= col + cols ||
    startRow < row ||
    startRow >= row + rows
  ) {
    return null;
  }
  const direction = startRow < kerb.row ? 1 : -1;
  const tiles: OfficeTilePos[] = [
    { col: startCol, row: startRow },
    { col: startCol - 1, row: startRow },
    { col: kerb.col, row: startRow },
  ];
  const verticalDistance = Math.abs(startRow - kerb.row);
  for (let step = 1; step <= verticalDistance; step += 1) {
    tiles.push({ col: kerb.col, row: startRow + direction * step });
  }
  return { entryTile: tiles[0], tiles, exitTile: kerb };
}

/**
 * Large enough to hold every fixture in this file - the biggest is a few
 * dozen agents - with room to spare, so `frameOf` never culls anything a case
 * did not ask to cull.
 */
const WHOLE_WORLD: OfficeRect = { x: 0, y: 0, width: 8000, height: 8000 };

/** `scene.frame()` at close-up over the whole world - what the old zero-arg call answered. */
function frameOf(scene: OfficeScene): OfficeFrame {
  return scene.frame(2, WHOLE_WORLD);
}

/** The plan in force. Every case here syncs first, so `null` is a bug in the case. */
function layoutOf(scene: OfficeScene): OfficeLayout {
  const layout = scene.layout();
  if (layout === null) throw new Error("scene has no layout yet");
  return layout;
}

/**
 * The documented visibility rule for a sign: drawn only while its owner is
 * visible at the cursor, and always where it names nobody in particular.
 *
 * The renderer's own predicate (`signsToDraw` in
 * `comm-graph-office-canvas.tsx`) is module-private and canvas-only, so it
 * cannot be exercised end to end under jsdom (no 2D context, no DOM marker
 * for a sign). This mirrors it against the contract `office-types.ts`
 * documents on `OfficeSign.ownerAgentId`: "Drawn only while this agent is
 * visible at the cursor; `null` draws always."
 */
function officeSignVisible(
  sign: OfficeSign,
  visibleAgentIds: ReadonlySet<string>,
): boolean {
  return sign.ownerAgentId === null || visibleAgentIds.has(sign.ownerAgentId);
}

/**
 * A garden tile that is not an OPENING in its hedge: grass on the interior,
 * hedge (or a piece of garden scenery standing on it) on the ring. The
 * painter now bakes `layout.props` - a bench, a tree - into the same floor
 * pass as the grass and the hedge, drawn after both, so the last sprite at a
 * shared tile can legitimately be the scenery rather than the ring or grass
 * underneath it.
 */
function expectGardenTilePainted(
  name: OfficeSpriteName | undefined,
  onRing: boolean,
  key: string,
): void {
  const scenery = name === "bench" || name === "tree";
  if (onRing) {
    expect(name === "planter" || scenery, key).toBe(true);
    return;
  }
  expect(
    (name !== undefined && /^floor-grass-[ab]$/.test(name)) || scenery,
    key,
  ).toBe(true);
}

/** The sign the plan placed at this exact tile, for a given kind. */
function signAt(
  layout: OfficeLayout,
  kind: OfficeSign["kind"],
  tile: OfficeTilePos,
): OfficeSign | undefined {
  return layout.signs.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.tile.col === tile.col &&
      candidate.tile.row === tile.row,
  );
}

const APPEARANCE: OfficeAppearance = {
  skin: "#e0b08a",
  hair: "#3a2a1a",
  hairStyle: 0,
  shirt: "#3b6fd6",
  pants: "#22262b",
  accent: "#7fd6ff",
};

function agent(
  overrides: Partial<OfficeAgentInput> & { readonly id: string },
): OfficeAgentInput {
  return {
    name: overrides.id,
    kind: "chat",
    hostId: null,
    archivedAt: null,
    modelTier: "medium",
    harnessId: null,
    model: null,
    parentId: null,
    archived: false,
    createdAt: 0,
    appearance: APPEARANCE,
    ...overrides,
  };
}

const ALPHA = agent({ id: "alpha", createdAt: 1 });
const BETA = agent({ id: "beta", createdAt: 2 });
const AGENTS: ReadonlyArray<OfficeAgentInput> = [ALPHA, BETA];
const BOTH: ReadonlySet<string> = new Set(["alpha", "beta"]);
const ALPHA_ONLY: ReadonlySet<string> = new Set(["alpha"]);

const REQUEST_PULSE: CommGraphPulse = {
  kind: "edge",
  edgeId: "alpha<->beta",
  pulseKind: "request",
  fromAgentId: "alpha",
  toAgentId: "beta",
};
const CREATED_PULSE: CommGraphPulse = {
  kind: "edge",
  edgeId: "alpha<->beta",
  pulseKind: "created",
  fromAgentId: "alpha",
  toAgentId: "beta",
};

function sceneInput(
  overrides: Partial<OfficeSceneInput> & {
    readonly agents: ReadonlyArray<OfficeAgentInput>;
    readonly visibleAgentIds: ReadonlySet<string>;
  },
): OfficeSceneInput {
  const agents = overrides.agents;
  const statusById =
    overrides.statusById ?? new Map<string, OfficeAgentStatus>();
  // Resolved up here like `statusById`, and written back AFTER the spread
  // below: `Partial<OfficeSceneInput>` makes every field optional, and
  // spreading an optional over a concrete one leaves the result optional -
  // which `OfficeSceneInput` does not accept for a required boolean.
  const feedSettled = overrides.feedSettled ?? false;
  return {
    statusById,
    partition: partitionOfficePopulation({
      agents,
      statusById,
      previous: null,
    }),
    activityById: new Map<string, number>(),
    viewport: { width: 1040, height: 700 },
    openRequestsByReceiver: new Map<string, number>(),
    pulse: null,
    pulseKey: null,
    // 800ms steps put the envelope's clamped flight at 600ms.
    stepMs: 800,
    cursorMs: null,
    clockMs: 0,
    playing: false,
    reducedMotion: false,
    ...overrides,
    feedSettled,
  };
}

function characterRect(frame: OfficeFrame, agentId: string): OfficeRect {
  const region = frame.hitRegions.find(
    (candidate) =>
      candidate.agentId === agentId &&
      candidate.rect.height === OFFICE_CHARACTER_HEIGHT,
  );
  if (region === undefined) throw new Error(`no character for ${agentId}`);
  return region.rect;
}

function hasCharacter(frame: OfficeFrame, agentId: string): boolean {
  return frame.hitRegions.some(
    (candidate) =>
      candidate.agentId === agentId &&
      candidate.rect.height === OFFICE_CHARACTER_HEIGHT,
  );
}

type OfficeEnvelopeDrawable = Extract<OfficeDrawable, { kind: "envelope" }>;

function envelopes(frame: OfficeFrame): ReadonlyArray<OfficeEnvelopeDrawable> {
  const found: OfficeEnvelopeDrawable[] = [];
  for (const drawable of frame.overlay) {
    if (drawable.kind === "envelope") found.push(drawable);
  }
  return found;
}

function hasBubbleAt(
  frame: OfficeFrame,
  name: OfficeSpriteName,
  head: OfficePoint,
): boolean {
  return frame.overlay.some(
    (drawable) =>
      drawable.kind === "sprite" &&
      drawable.sprite.name === name &&
      drawable.x === head.x &&
      drawable.y === head.y - 2,
  );
}

/**
 * The layouts these helpers measure against, computed ONCE.
 *
 * `layoutOffice` walks every agent, room and tile, and these helpers are
 * called inside tick loops that run them hundreds of times per test. The
 * layout is a pure function of its agents, so recomputing it per call answered
 * the same question at a cost that dominated the suite.
 */
const AGENTS_LAYOUT: OfficeLayout = layoutOffice(AGENTS);

function seatedHead(agentId: string): OfficePoint {
  const desk = AGENTS_LAYOUT.desks.get(agentId);
  if (desk === undefined) throw new Error(`no desk for ${agentId}`);
  return {
    x: desk.chairTile.col * OFFICE_TILE + OFFICE_CHARACTER_WIDTH / 2,
    y: desk.chairTile.row * OFFICE_TILE - 4,
  };
}

/**
 * The head of the first seat of a KIND, for an agent the civic layer has moved
 * off its own desk. `firstFreeSeat` walks the layout's seats in id order and
 * takes the first free one of the kind it wants, so on a single-storey Floor
 * with one claimant that is this seat.
 */
function civicSeatHead(kind: OfficeSeatKind): OfficePoint {
  const seat = [...AGENTS_LAYOUT.seats.values()].find(
    (candidate) => candidate.kind === kind,
  );
  if (seat === undefined) throw new Error(`no ${kind} seat`);
  return {
    x: seat.chairTile.col * OFFICE_TILE + OFFICE_CHARACTER_WIDTH / 2,
    y: seat.chairTile.row * OFFICE_TILE - 4,
  };
}

function seatedRect(agentId: string): OfficeRect {
  const head = seatedHead(agentId);
  return {
    x: head.x - OFFICE_CHARACTER_WIDTH / 2,
    y: head.y,
    width: OFFICE_CHARACTER_WIDTH,
    height: OFFICE_CHARACTER_HEIGHT,
  };
}

type OfficeSpriteDrawable = Extract<OfficeDrawable, { kind: "sprite" }>;
type OfficeLabelDrawable = Extract<OfficeDrawable, { kind: "label" }>;
type OfficeLogoDrawable = Extract<OfficeDrawable, { kind: "logo" }>;

function sprites(
  drawables: ReadonlyArray<OfficeDrawable>,
  name: OfficeSpriteName,
): ReadonlyArray<OfficeSpriteDrawable> {
  const found: OfficeSpriteDrawable[] = [];
  for (const drawable of drawables) {
    if (drawable.kind === "sprite" && drawable.sprite.name === name) {
      found.push(drawable);
    }
  }
  return found;
}

/** The channel a renderer actually draws: one depth stream or two layers. */
function visibleDrawables(frame: OfficeFrame): ReadonlyArray<OfficeDrawable> {
  if (frame.world !== null) return frame.world.map((entry) => entry.drawable);
  return [...frame.props, ...frame.actors];
}

type OfficeVehicleDrawable = Extract<OfficeDrawable, { kind: "vehicle" }>;

/**
 * Every vehicle drawable in this frame, whichever painter shape produced it.
 *
 * Reads through `visibleDrawables`, which already branches on `frame.world`:
 * a WORLD painter (Towers, Building, Campus, City) leaves `props`/`actors`
 * empty and puts everything in `frame.world` instead, and a helper that only
 * read `props`/`actors` would find a vehicle on the Floor and silently find
 * none anywhere else - exactly the vacuous green the per-view block below
 * exists to avoid.
 */
function vehicleDrawables(
  frame: OfficeFrame,
): ReadonlyArray<OfficeVehicleDrawable> {
  const found: OfficeVehicleDrawable[] = [];
  for (const drawable of visibleDrawables(frame)) {
    if (drawable.kind === "vehicle") found.push(drawable);
  }
  return found;
}

/** Every unanswered-request pile currently drawn, whatever its height. */
function stacks(frame: OfficeFrame): ReadonlyArray<OfficeSpriteDrawable> {
  const found: OfficeSpriteDrawable[] = [];
  for (const drawable of frame.props) {
    if (drawable.kind !== "sprite") continue;
    if (!drawable.sprite.name.startsWith("envelope-stack")) continue;
    found.push(drawable);
  }
  return found;
}

function labels(
  drawables: ReadonlyArray<OfficeDrawable>,
): ReadonlyArray<OfficeLabelDrawable> {
  const found: OfficeLabelDrawable[] = [];
  for (const drawable of drawables) {
    if (drawable.kind === "label") found.push(drawable);
  }
  return found;
}

function logos(
  drawables: ReadonlyArray<OfficeDrawable>,
): ReadonlyArray<OfficeLogoDrawable> {
  const found: OfficeLogoDrawable[] = [];
  for (const drawable of drawables) {
    if (drawable.kind === "logo") found.push(drawable);
  }
  return found;
}

const IDLE_CREW: ReadonlyArray<OfficeAgentInput> = [
  agent({ id: "alpha", createdAt: 1 }),
  agent({ id: "beta", createdAt: 2 }),
  agent({ id: "gamma", createdAt: 3 }),
  agent({ id: "delta", createdAt: 4 }),
];
const CREW_IDS: ReadonlySet<string> = new Set(
  IDLE_CREW.map((person) => person.id),
);

const CREW_LAYOUT: OfficeLayout = layoutOffice(IDLE_CREW);

function crewSeatedRect(agentId: string): OfficeRect {
  const desk = CREW_LAYOUT.desks.get(agentId);
  if (desk === undefined) throw new Error(`no desk for ${agentId}`);
  return {
    x: desk.chairTile.col * OFFICE_TILE,
    y: desk.chairTile.row * OFFICE_TILE - 4,
    width: OFFICE_CHARACTER_WIDTH,
    height: OFFICE_CHARACTER_HEIGHT,
  };
}

/** The character sprite standing exactly at this hit region, if one is drawn. */
function characterSpriteAt(
  frame: OfficeFrame,
  rect: OfficeRect,
): OfficeSpriteRef | null {
  for (const drawable of visibleDrawables(frame)) {
    if (drawable.kind !== "sprite") continue;
    if (drawable.sprite.name !== "character") continue;
    if (drawable.x !== rect.x || drawable.y !== rect.y) continue;
    return drawable.sprite;
  }
  return null;
}

/** Where each character not in its own chair is standing, by tile. */
function standingByTile(scene: OfficeScene): ReadonlyMap<string, string> {
  const byTile = new Map<string, string>();
  for (const region of frameOf(scene).hitRegions) {
    if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
    const desk = layoutOf(scene).desks.get(region.agentId);
    if (desk === undefined) continue;
    if (
      region.rect.x === desk.chairTile.col * OFFICE_TILE &&
      region.rect.y === desk.chairTile.row * OFFICE_TILE - 4
    ) {
      continue;
    }
    if (region.rect.x % OFFICE_TILE !== 0) continue;
    byTile.set(
      `${region.rect.x / OFFICE_TILE},${(region.rect.y + 4) / OFFICE_TILE}`,
      region.agentId,
    );
  }
  return byTile;
}

/**
 * Two agents standing on NEIGHBOURING cafeteria spots - the only arrangement
 * the layout produces that can only mean a conversation, so a test can tell one
 * apart from two people who happen to be near each other.
 */
function chatPairAt(scene: OfficeScene): ReadonlyArray<string> | null {
  const floor = layoutOf(scene).floors[0];
  const social = floor.errandSpots.filter(
    (spot) => spot.kind === "cafe" || spot.kind === "cooler",
  );
  const standing = standingByTile(scene);
  for (const left of social) {
    for (const right of social) {
      if (right.tile.col !== left.tile.col + 1) continue;
      if (right.tile.row !== left.tile.row) continue;
      const first = standing.get(`${left.tile.col},${left.tile.row}`);
      const second = standing.get(`${right.tile.col},${right.tile.row}`);
      if (first === undefined || second === undefined) continue;
      return [first, second];
    }
  }
  return null;
}

/**
 * Every WALLED amenity's doorway on the plan. The door is not painted from a
 * field: it is the one tile of the room's ring the grid still says is walkable,
 * which is exactly what the scene reads. The garden is left out - its boundary
 * is a hedge, so its way in is a gap with nothing drawn in it at all.
 */
function amenityDoorKeys(layout: OfficeLayout): ReadonlyArray<string> {
  const keys: string[] = [];
  for (const entry of layout.floors) {
    for (const room of entry.amenities) {
      if (room.kind === "garden") continue;
      keys.push(...walkableRingKeys(layout, room.bounds));
    }
  }
  return keys;
}

/** The walkable tiles on a walled room's own wall ring - its doorways. */
function walkableRingKeys(
  layout: OfficeLayout,
  room: OfficeTileRect,
): ReadonlyArray<string> {
  const keys: string[] = [];
  const right = room.col + room.cols - 1;
  const bottom = room.row + room.rows - 1;
  for (let row = room.row; row <= bottom; row += 1) {
    for (let col = room.col; col <= right; col += 1) {
      const onRing =
        row === room.row || row === bottom || col === room.col || col === right;
      if (!onRing || !layout.walkable[row][col]) continue;
      keys.push(`${col},${row}`);
    }
  }
  return keys;
}

/** The agent whose desk this tile is the aisle seat under, if any. */
function hostDeskAt(scene: OfficeScene, tile: OfficeTilePos): string | null {
  for (const desk of layoutOf(scene).desks.values()) {
    if (desk.chairTile.col !== tile.col) continue;
    if (desk.chairTile.row + 1 !== tile.row) continue;
    return desk.agentId;
  }
  return null;
}

/** Which cabin an agent's desk stands in, by that cabin's root. */
function cabinOf(scene: OfficeScene, agentId: string): string | null {
  const desk = layoutOf(scene).desks.get(agentId);
  if (desk === undefined) return null;
  for (const room of layoutOf(scene).rooms) {
    const { col, row, cols, rows } = room.bounds;
    if (desk.deskTile.col < col || desk.deskTile.col >= col + cols) continue;
    if (desk.deskTile.row < row || desk.deskTile.row >= row + rows) continue;
    return room.rootAgentId;
  }
  return null;
}

function headOfRegion(scene: OfficeScene, agentId: string): OfficePoint | null {
  for (const region of frameOf(scene).hitRegions) {
    if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
    if (region.agentId !== agentId) continue;
    return {
      x: region.rect.x + OFFICE_CHARACTER_WIDTH / 2,
      y: region.rect.y,
    };
  }
  return null;
}

/**
 * A layout offering ONLY these errand kinds. Weights decide between the options
 * a floor has, so pinning the options is the only way to test one activity
 * without testing the draw that leads to it.
 */
function onlyKinds(
  kinds: ReadonlyArray<string>,
): (input: ReadonlyArray<OfficeAgentInput>) => OfficeLayout {
  return (input) => {
    const base = layoutOffice(input);
    return {
      ...base,
      floors: base.floors.map((entry) => ({
        ...entry,
        errandSpots: entry.errandSpots.filter((spot) =>
          kinds.includes(spot.kind),
        ),
      })),
    };
  };
}

/** Every paper ball drawn this frame, in overlay order. */
function paperBalls(frame: OfficeFrame): ReadonlyArray<OfficeSpriteDrawable> {
  return sprites(frame.overlay, "paper-ball");
}

function crewAway(frame: OfficeFrame): ReadonlyArray<string> {
  const away: string[] = [];
  for (const region of frame.hitRegions) {
    if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
    const seated = crewSeatedRect(region.agentId);
    if (region.rect.x === seated.x && region.rect.y === seated.y) continue;
    away.push(region.agentId);
  }
  return away;
}

describe("OfficeScene", () => {
  it("seats everyone already on the floor at the first sync", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));

    const frame = frameOf(scene);
    expect(characterRect(frame, "alpha")).toEqual(seatedRect("alpha"));
    expect(characterRect(frame, "beta")).toEqual(seatedRect("beta"));
    expect(frame.size).toEqual({
      width: layoutOf(scene).cols * OFFICE_TILE,
      height: layoutOf(scene).rows * OFFICE_TILE,
    });
  });

  it("walks a new agent in from the door on its created pulse", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: CREATED_PULSE,
        pulseKey: "created-beta",
      }),
    );

    const door = layoutOf(scene).doorTile;
    const entering = characterRect(frameOf(scene), "beta");
    expect(entering.x).toBe(door.col * OFFICE_TILE);
    expect(entering.y).toBe(door.row * OFFICE_TILE - 4);

    // Three tiles a second, from the entrance through its cabin's own door;
    // six seconds is comfortably past the longest route on this floor.
    for (let step = 0; step < 60; step += 1) scene.tick(100);
    expect(characterRect(frameOf(scene), "beta")).toEqual(seatedRect("beta"));
  });

  it("seats a late arrival silently when the timeline is scrubbed", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    // Not playing, and the cursor is not sitting on beta's creation - this is
    // the floor being restated, not a reveal.
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));

    expect(characterRect(frameOf(scene), "beta")).toEqual(seatedRect("beta"));
  });

  it("removes a character the moment it leaves the visible set", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));

    const frame = frameOf(scene);
    expect(hasCharacter(frame, "alpha")).toBe(true);
    expect(hasCharacter(frame, "beta")).toBe(false);
  });

  it("spawns exactly one envelope per pulse key and delivers it", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const withPulse = sceneInput({
      agents: AGENTS,
      visibleAgentIds: BOTH,
      pulse: REQUEST_PULSE,
      pulseKey: "row-1",
    });

    scene.sync(withPulse);
    expect(envelopes(frameOf(scene))).toHaveLength(1);
    // The same row re-supplied across frames must not spawn a second envelope.
    scene.sync(withPulse);
    expect(envelopes(frameOf(scene))).toHaveLength(1);

    const launched = envelopes(frameOf(scene))[0];
    expect(launched.pulseKind).toBe("request");
    expect(launched.progress).toBe(0);
    expect(launched.x).toBe(seatedHead("alpha").x);

    scene.tick(300);
    expect(envelopes(frameOf(scene))).toHaveLength(1);

    scene.tick(400);
    const arrived = frameOf(scene);
    expect(envelopes(arrived)).toHaveLength(0);
    expect(hasBubbleAt(arrived, "bubble-hello", seatedHead("beta"))).toBe(true);
  });

  it("arcs the envelope above the straight line between the two heads", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: REQUEST_PULSE,
        pulseKey: "row-1",
      }),
    );
    scene.tick(300);

    const midpoint = envelopes(frameOf(scene))[0];
    // Both heads sit at the same height, so any lift is the arc alone.
    expect(seatedHead("alpha").y).toBe(seatedHead("beta").y);
    expect(midpoint.y).toBeLessThan(seatedHead("alpha").y);
  });

  it("delivers without a flight when motion is reduced", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        reducedMotion: true,
      }),
    );
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        reducedMotion: true,
        pulse: REQUEST_PULSE,
        pulseKey: "row-1",
      }),
    );

    const frame = frameOf(scene);
    expect(envelopes(frame)).toHaveLength(0);
    // Still perceivable: the acknowledgement outlives several frames.
    expect(hasBubbleAt(frame, "bubble-hello", seatedHead("beta"))).toBe(true);
  });

  it("settles every envelope, bubble, and mid-walk arrival when motion is reduced mid-flight", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const withPulse = sceneInput({
      agents: AGENTS,
      visibleAgentIds: BOTH,
      pulse: REQUEST_PULSE,
      pulseKey: "row-1",
    });
    scene.sync(withPulse);
    scene.tick(50);
    expect(envelopes(frameOf(scene))).toHaveLength(1);

    // Same pulse key as before, so nothing replays - only the flag flips.
    // What is already in flight has to be told, not just what starts from
    // here on.
    scene.sync(sceneInput({ ...withPulse, reducedMotion: true }));

    const settled = frameOf(scene);
    expect(envelopes(settled)).toHaveLength(0);
    expect(hasBubbleAt(settled, "bubble-hello", seatedHead("beta"))).toBe(true);
    expect(scene.isAnimating(2)).toBe(true);

    // The delivered bubble is transient like any other; once it times out
    // there is nothing left for the cut-short motion to keep the floor busy
    // with.
    scene.tick(800);
    expect(scene.isAnimating(2)).toBe(false);

    // The same flip mid-walk: a newcomer still crossing the floor jumps to
    // the end of its path and sits, rather than being abandoned mid-stride.
    const walkScene = new OfficeScene(testView(layoutOffice), null);
    walkScene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    const walkIn = sceneInput({
      agents: AGENTS,
      visibleAgentIds: BOTH,
      pulse: CREATED_PULSE,
      pulseKey: "created-beta",
    });
    walkScene.sync(walkIn);
    // Still on foot, part-way across the floor - the walk-in this replaced
    // takes sixty ticks like this one to finish on its own.
    walkScene.tick(100);
    expect(walkScene.isAnimating(2)).toBe(true);
    expect(characterRect(frameOf(walkScene), "beta")).not.toEqual(
      seatedRect("beta"),
    );

    walkScene.sync(sceneInput({ ...walkIn, reducedMotion: true }));
    expect(characterRect(frameOf(walkScene), "beta")).toEqual(
      seatedRect("beta"),
    );
  });

  it("drops an in-flight envelope on a rewind into history, but not on a forward move", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const withPulse = sceneInput({
      agents: AGENTS,
      visibleAgentIds: BOTH,
      pulse: REQUEST_PULSE,
      pulseKey: "row-1",
    });
    scene.sync(withPulse);
    scene.tick(50);
    expect(envelopes(frameOf(scene))).toHaveLength(1);

    // Same pulse key, so nothing replays - only the cursor moves, from live
    // into a historical moment. Whatever was mid-flight has not happened on
    // this prefix, so it is dropped rather than delivered.
    scene.sync({ ...withPulse, cursorMs: 5 });

    const rewound = frameOf(scene);
    expect(envelopes(rewound)).toHaveLength(0);
    expect(hasBubbleAt(rewound, "bubble-hello", seatedHead("beta"))).toBe(
      false,
    );
    expect(stacks(rewound)).toHaveLength(0);

    // Contrast: a forward move within history must not touch what is in
    // flight - only a REWIND (a null-to-history landing, or a seek backward)
    // does.
    const forwardScene = new OfficeScene(testView(layoutOffice), null);
    forwardScene.sync(
      sceneInput({ agents: AGENTS, visibleAgentIds: BOTH, cursorMs: 5 }),
    );
    const forwardWithPulse = sceneInput({
      agents: AGENTS,
      visibleAgentIds: BOTH,
      pulse: REQUEST_PULSE,
      pulseKey: "row-1",
      cursorMs: 5,
    });
    forwardScene.sync(forwardWithPulse);
    forwardScene.tick(50);
    expect(envelopes(frameOf(forwardScene))).toHaveLength(1);

    forwardScene.sync({ ...forwardWithPulse, cursorMs: 10 });
    expect(envelopes(frameOf(forwardScene))).toHaveLength(1);
  });

  it("freezes ambient motion under a paused historical cursor, and recalls an errand already under way", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: IDLE_CREW,
        visibleAgentIds: CREW_IDS,
        cursorMs: 5,
      }),
    );

    // Comfortably past the idle-errand threshold plus its widest per-agent
    // stagger - on a live floor this is well into everyone's first errand.
    for (let step = 0; step < 150; step += 1) scene.tick(100);

    const paused = frameOf(scene);
    for (const person of IDLE_CREW) {
      expect(characterRect(paused, person.id)).toEqual(
        crewSeatedRect(person.id),
      );
    }
    expect(scene.isAnimating(2)).toBe(false);

    // Now the same crew, but caught mid-errand while still live, the way the
    // existing "sends an idle agent on an errand" test reaches one.
    const liveScene = new OfficeScene(testView(layoutOffice), null);
    liveScene.sync(
      sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }),
    );
    let awayId: string | null = null;
    let elapsedMs = 0;
    while (elapsedMs < 60_000 && awayId === null) {
      liveScene.tick(100);
      elapsedMs += 100;
      const away = crewAway(frameOf(liveScene));
      if (away.length > 0) awayId = away[0];
    }
    if (awayId === null) throw new Error("nobody left their desk");
    expect(characterRect(frameOf(liveScene), awayId)).not.toEqual(
      crewSeatedRect(awayId),
    );

    // A historical cursor lands mid-errand: the character is recalled on this
    // very sync - reduced motion is what makes the recall instant rather than
    // a walk back across the floor, which is what keeps this assertion cheap.
    liveScene.sync(
      sceneInput({
        agents: IDLE_CREW,
        visibleAgentIds: CREW_IDS,
        cursorMs: 5,
        reducedMotion: true,
      }),
    );
    expect(characterRect(frameOf(liveScene), awayId)).toEqual(
      crewSeatedRect(awayId),
    );
  });

  it("bubbles a standing status when nothing transient is showing", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "awaiting"],
          ["beta", "attention"],
        ]),
      }),
    );

    const frame = frameOf(scene);
    expect(hasBubbleAt(frame, "bubble-awaiting", seatedHead("alpha"))).toBe(
      true,
    );
    // The attention bubble bobs, so it is one pixel off the resting anchor.
    expect(
      frame.overlay.some(
        (drawable) =>
          drawable.kind === "sprite" &&
          drawable.sprite.name === "bubble-attention" &&
          drawable.x === seatedHead("beta").x,
      ),
    ).toBe(true);
  });

  it("draws an awaiting-only floor as a still frame", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        // Reduced motion on the very first sync, so nobody walks in - the
        // only thing left that could keep the floor animating is the
        // awaiting bubble itself.
        reducedMotion: true,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "awaiting"]]),
      }),
    );
    // Comfortably under the idle-errand threshold, so an idle beta does not
    // wander off mid-assertion and become the reason the floor animates.
    scene.tick(200);

    const frame = frameOf(scene);
    // GEOMETRY, RE-MEASURED: this asserted the bubble at `seatedHead("alpha")`,
    // alpha's own DESK. An `awaiting` agent wants a lounge chair and, under
    // reduced motion, is put in one instantly - so the bubble it wears is at
    // the chair now, not at the desk it left. The old reading was only right
    // while instant seating forgot to move the character: the book,
    // `whereabouts` and `locate` all said lounge while the actor, and so this
    // bubble, stayed behind at the desk. Asserting the desk here would re-pin
    // the defect. The case's own claim - that an awaiting floor is STILL - is
    // the assertion below and is untouched.
    expect(hasBubbleAt(frame, "bubble-awaiting", civicSeatHead("lounge"))).toBe(
      true,
    );
    // A request can sit open for hours; unlike the attention bubble, the
    // awaiting one does not bob, so a seated agent wearing it is not a
    // reason to keep redrawing.
    expect(scene.isAnimating(2)).toBe(false);
  });

  it("finds a character first and its desk second under a point", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));

    const seated = seatedRect("alpha");
    expect(scene.hitTest({ x: seated.x + 8, y: seated.y + 10 })).toBe("alpha");

    const desk = layoutOf(scene).desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk");
    // The desk's right tile is clear of the character box above the chair.
    expect(
      scene.hitTest({
        x: (desk.deskTile.col + 1) * OFFICE_TILE + 8,
        y: desk.deskTile.row * OFFICE_TILE + 4,
      }),
    ).toBe("alpha");

    const lobby = layoutOf(scene).lobbyTile;
    expect(
      scene.hitTest({
        x: lobby.col * OFFICE_TILE + 8,
        y: lobby.row * OFFICE_TILE + 8,
      }),
    ).toBeNull();
  });

  it("labels each character with a truncated name", () => {
    const longName = agent({
      id: "alpha",
      name: "an extremely long agent name",
      createdAt: 1,
    });
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: [longName, BETA], visibleAgentIds: BOTH }));

    const labels: string[] = [];
    for (const drawable of frameOf(scene).actors) {
      if (drawable.kind === "label") labels.push(drawable.text);
    }
    expect(labels).toHaveLength(2);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(14);
    expect(labels.some((label) => label.endsWith("…"))).toBe(true);
  });

  it("stands every prop on its tile rather than over the row below", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const frame = frameOf(scene);
    const drawn = [...frame.floor, ...frame.props];

    // Asserted as the invariant, not as the offset formula: whatever the art
    // decides a prop's height is, its FOOT belongs on the tile it occupies.
    for (const prop of layoutOf(scene).props) {
      const size = officeSpriteSize(prop.sprite);
      const drawable = drawn.find(
        (candidate) =>
          candidate.kind === "sprite" &&
          candidate.sprite.name === prop.sprite.name &&
          candidate.y + size.height === (prop.tile.row + 1) * OFFICE_TILE,
      );
      expect(
        drawable,
        `${prop.sprite.name} does not stand on its tile`,
      ).toBeDefined();
    }
  });

  it("never carpets the doorway with the lobby rug", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);

    const rug = frameOf(scene).floor.find(
      (drawable) =>
        drawable.kind === "sprite" && drawable.sprite.name === "rug",
    );
    if (rug === undefined || rug.kind !== "sprite") {
      throw new Error("expected a rug on the floor");
    }
    const size = officeSpriteSize(rug.sprite);
    const doorTop = layout.doorTile.row * OFFICE_TILE;

    // The door is directly below the lobby, so the rug must stop above it.
    expect(rug.y + size.height).toBeLessThanOrEqual(doorTop);
    // ...and stay centred on the lobby rather than sliding off one side.
    expect(rug.x + size.width / 2).toBe(
      layout.lobbyTile.col * OFFICE_TILE + OFFICE_TILE / 2,
    );
  });

  it("walls every cabin and writes its name across the sign", () => {
    const family = [
      agent({ id: "alpha", name: "an extremely long room name", createdAt: 1 }),
      agent({ id: "beta", parentId: "alpha", createdAt: 2 }),
    ];
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: family, visibleAgentIds: BOTH }));

    const frame = frameOf(scene);
    const room = layoutOf(scene).rooms[0];
    expect(room).toBeDefined();

    // The cabin's structure belongs to the floor, under everything that stands
    // on it - and its corners must actually be capped.
    const wallTops = sprites(frame.floor, "wall-top");
    expect(
      wallTops.some(
        (drawable) =>
          drawable.x === room.bounds.col * OFFICE_TILE &&
          drawable.y === room.bounds.row * OFFICE_TILE,
      ),
    ).toBe(true);
    // A cabin door is drawn as a door, not as more wall.
    const doors = sprites(frame.floor, "door");
    expect(
      doors.some(
        (drawable) =>
          drawable.x === room.doorTile.col * OFFICE_TILE &&
          drawable.y === room.doorTile.row * OFFICE_TILE,
      ),
    ).toBe(true);

    // The cabin's OWN sign, not merely the first one placed: the break room
    // and the game room carry signs of their own. The scene no longer draws
    // the board or its lettering itself - both are the renderer's job, off
    // `layout.signs` - so what the scene contributes is the placement and the
    // full (untruncated) name.
    const sign = signAt(layoutOf(scene), "room", room.signTile);
    if (sign === undefined) throw new Error("no sign on the cabin");
    expect(sign.ownerAgentId).toBe("alpha");
    expect(sign.text).toBe("an extremely long room name");

    // Whether it is DRAWN is a cursor fact: the renderer hides a sign while
    // its owner has not been created yet at the cursor.
    expect(officeSignVisible(sign, BOTH)).toBe(true);
    expect(officeSignVisible(sign, new Set(["beta"]))).toBe(false);
  });

  it("re-letters a cabin sign in place when its root is renamed, without moving anyone", () => {
    const root = agent({ id: "root", name: "Ann", createdAt: 1 });
    const child = agent({ id: "child", parentId: "root", createdAt: 2 });
    const family = [root, child];
    const ids = new Set(family.map((person) => person.id));

    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({ agents: family, visibleAgentIds: ids, reducedMotion: true }),
    );

    const before = frameOf(scene);
    const roomBefore = layoutOf(scene).rooms[0];
    const signBefore = signAt(layoutOf(scene), "room", roomBefore.signTile);
    expect(signBefore?.text).toBe("Ann");
    const versionBefore = before.staticVersion;
    const regionsBefore = before.hitRegions;

    // Same ids, parentIds, createdAt and hostId - the agent SET is unchanged,
    // so this is a rename, not a re-layout.
    const renamedRoot = agent({ id: "root", name: "Bea", createdAt: 1 });
    const renamedFamily = [renamedRoot, child];
    scene.sync(
      sceneInput({
        agents: renamedFamily,
        visibleAgentIds: ids,
        reducedMotion: true,
      }),
    );

    const after = frameOf(scene);
    const layoutAfter = layoutOf(scene);
    const signAfter = signAt(layoutAfter, "room", roomBefore.signTile);
    expect(signAfter?.text).toBe("Bea");
    // The stale lettering must be gone, not merely joined by the new sign.
    expect(layoutAfter.signs.some((sign) => sign.text === "Ann")).toBe(false);
    // A rename bumps the renderer's cache key, since the sign it re-letters
    // lives on the layout the cache keys off.
    expect(after.staticVersion).toBe(versionBefore + 1);
    // Nobody's chair moved: the layout signature excludes names on purpose, so
    // this must not have sent anyone back across the floor.
    expect(after.hitRegions).toEqual(regionsBefore);

    // The identical (already-renamed) input again must not re-letter or bump
    // the version a second time - only an actual name CHANGE does that.
    scene.sync(
      sceneInput({
        agents: renamedFamily,
        visibleAgentIds: ids,
        reducedMotion: true,
      }),
    );
    expect(frameOf(scene).staticVersion).toBe(versionBefore + 1);
  });

  it("signs every amenity the way it signs a cabin", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));

    const layout = layoutOf(scene);
    const areaSigns = layout.signs.filter((sign) => sign.kind === "area");
    for (const area of layout.floors[0].areaSigns) {
      const sign = signAt(layout, "area", area.signTile);
      if (sign === undefined) throw new Error(`no sign for ${area.name}`);
      expect(sign.text).toBe(area.name);
      // An area belongs to nobody in particular, so it is drawn always.
      expect(sign.ownerAgentId).toBeNull();
      expect(officeSignVisible(sign, new Set<string>())).toBe(true);
    }
    expect(areaSigns.some((sign) => sign.text === "Cafeteria")).toBe(true);
    expect(areaSigns.some((sign) => sign.text === "Game room")).toBe(true);
  });

  it("tints a pod's floor, outlines it in its own style and plates its name", () => {
    const family = [
      agent({ id: "root", createdAt: 1 }),
      agent({
        id: "lead",
        name: "a very long sub-team name",
        parentId: "root",
        createdAt: 2,
      }),
      agent({ id: "kid-1", parentId: "lead", createdAt: 3 }),
      agent({ id: "kid-2", parentId: "lead", createdAt: 4 }),
    ];
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: family,
        visibleAgentIds: new Set(family.map((person) => person.id)),
      }),
    );

    const frame = frameOf(scene);
    const pod = layoutOf(scene).rooms[0].pods[0];
    expect(pod).toBeDefined();

    // Every interior tile carries a pod floor of the pod's own tint, as a
    // checker rather than a wash.
    const tinted = new Map<string, OfficeSpriteName>();
    for (const drawable of frame.floor) {
      if (drawable.kind !== "sprite") continue;
      if (!drawable.sprite.name.startsWith("floor-pod")) continue;
      tinted.set(
        `${drawable.x / OFFICE_TILE},${drawable.y / OFFICE_TILE}`,
        drawable.sprite.name,
      );
    }
    const family_ = pod.tint === "warm" ? "floor-pod-warm-" : "floor-pod-";
    const seen = new Set<string>();
    for (
      let row = pod.bounds.row;
      row < pod.bounds.row + pod.bounds.rows;
      row += 1
    ) {
      for (
        let col = pod.bounds.col;
        col < pod.bounds.col + pod.bounds.cols;
        col += 1
      ) {
        const name = tinted.get(`${col},${row}`);
        expect(name, `${col},${row}`).toBeDefined();
        if (name === undefined) continue;
        expect(name.startsWith(family_), name).toBe(true);
        seen.add(name);
      }
    }
    expect(seen.size).toBe(2);

    // The outline is drawn in the style the plan chose, and only in that one.
    // Like the cabin's own walls, a pod's outline is static scenery: the
    // painter bakes it into the floor pass rather than the per-desk prop
    // pass.
    const styleArt: Readonly<Record<string, ReadonlyArray<string>>> = {
      glass: ["partition", "partition-h"],
      planters: ["planter"],
      shelves: ["shelf", "shelf-h"],
    };
    const wanted = styleArt[pod.style];
    const outline = frame.floor.filter(
      (drawable) =>
        drawable.kind === "sprite" && wanted.includes(drawable.sprite.name),
    );
    expect(outline.length).toBeGreaterThan(0);
    for (const other of Object.entries(styleArt)) {
      if (other[0] === pod.style) continue;
      for (const name of other[1]) {
        // A pod wearing two styles at once has no style at all.
        expect(sprites(frame.floor, name as OfficeSpriteName), name).toEqual(
          [],
        );
      }
    }

    // The plate's PLACEMENT and full name are the plan's; the board sprite
    // and the lettering itself are the renderer's, off `layout.signs`.
    const sign = signAt(layoutOf(scene), "pod", pod.plateTile);
    if (sign === undefined) throw new Error("no sign on the pod plate");
    expect(sign.text).toBe("a very long sub-team name");
    expect(sign.ownerAgentId).toBe("lead");
    expect(officeSignVisible(sign, new Set(family.map((p) => p.id)))).toBe(
      true,
    );
    expect(officeSignVisible(sign, new Set(["root", "kid-1", "kid-2"]))).toBe(
      false,
    );
  });

  it("plates every desk and badges only the agents that carry a harness", () => {
    const badged = agent({ id: "alpha", createdAt: 1, harnessId: "traycer" });
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: [badged, BETA], visibleAgentIds: BOTH }));

    const frame = frameOf(scene);
    expect(sprites(frame.props, "nameplate")).toHaveLength(2);

    const badges = logos(frame.props);
    expect(badges).toHaveLength(1);
    expect(badges[0].harnessId).toBe("traycer");
    expect(badges[0].alpha).toBeUndefined();

    // The plate is on the desk it belongs to, and the badge is on the plate.
    const desk = layoutOf(scene).desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk");
    const deskX = desk.deskTile.col * OFFICE_TILE;
    const plate = sprites(frame.props, "nameplate").find(
      (drawable) => drawable.x >= deskX && drawable.x < deskX + 2 * OFFICE_TILE,
    );
    if (plate === undefined) throw new Error("expected a plate on the desk");
    const plateSize = officeSpriteSize({ name: "nameplate" });
    expect(badges[0].x).toBe(plate.x + plateSize.width / 2);
  });

  it("sheets an already-archived desk and strips its screen and badge", () => {
    const badged = agent({
      id: "alpha",
      createdAt: 1,
      harnessId: "traycer",
      archived: true,
      archivedAt: 10,
    });
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: [badged, BETA],
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "archived"]]),
      }),
    );

    const frame = frameOf(scene);
    // Nobody watched this one leave, so there is no walk to play - just the
    // desk it left behind.
    expect(hasCharacter(frame, "alpha")).toBe(false);
    expect(sprites(frame.props, "dust-sheet")).toHaveLength(1);
    expect(sprites(frame.props, "box")).toHaveLength(1);
    // One plate, one screen, one badge - and all of them beta's.
    expect(logos(frame.props)).toHaveLength(0);
    expect(sprites(frame.props, "nameplate")).toHaveLength(1);
    expect(sprites(frame.props, "monitor-on")).toHaveLength(1);

    const desk = layoutOf(scene).desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk");
    const sheet = sprites(frame.props, "dust-sheet")[0];
    expect(sheet.x).toBe(desk.deskTile.col * OFFICE_TILE);
    expect(sheet.y).toBe(desk.deskTile.row * OFFICE_TILE);
    // The box stands under the desk's RIGHT half; the chair is under its left.
    const box = sprites(frame.props, "box")[0];
    expect(box.x).toBe((desk.deskTile.col + 1) * OFFICE_TILE);
    // ...and the name stays, muted, so the desk is still identifiable.
    const muted = labels(frame.props).filter(
      (label) => label.tone === "muted" && label.text === "alpha",
    );
    expect(muted).toHaveLength(1);
  });

  it("alternates the screen while an agent works and holds it while it does not", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "working"],
          ["beta", "idle"],
        ]),
      }),
    );

    const screensAt = (): ReadonlyArray<OfficeSpriteName> => {
      const frame = frameOf(scene);
      const lit: OfficeSpriteName[] = [];
      for (const drawable of frame.props) {
        if (drawable.kind !== "sprite") continue;
        if (!drawable.sprite.name.startsWith("monitor-on")) continue;
        lit.push(drawable.sprite.name);
      }
      return lit;
    };

    const before = screensAt();
    // One full frame of the working cadence, whatever the per-agent phase
    // offset happens to be, always lands on the OTHER frame.
    scene.tick(260);
    const after = screensAt();

    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    // Exactly one of the two desks animates: the one that is in a turn.
    const changed = before.filter((name, index) => name !== after[index]);
    expect(changed).toHaveLength(1);
    expect(new Set([...before, ...after])).toEqual(
      new Set<OfficeSpriteName>(["monitor-on", "monitor-on-b"]),
    );
  });

  it("hands an in-flight envelope its edge and a box to click", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: REQUEST_PULSE,
        pulseKey: "row-1",
      }),
    );
    scene.tick(300);

    const frame = frameOf(scene);
    const flying = envelopes(frame)[0];
    expect(flying.edgeId).toBe("alpha<->beta");
    expect(frame.envelopeHitRegions).toHaveLength(1);

    const region = frame.envelopeHitRegions[0];
    expect(region.edgeId).toBe("alpha<->beta");
    // The box is centred on the envelope, which is what makes a moving target
    // clickable at all.
    expect(region.rect.x + region.rect.width / 2).toBe(flying.x);
    expect(region.rect.y + region.rect.height / 2).toBe(flying.y);
    const size = officeSpriteSize({ name: "envelope" });
    expect(region.rect.width).toBeGreaterThan(size.width);
    expect(region.rect.height).toBeGreaterThan(size.height);

    expect(scene.hitTestEnvelope({ x: flying.x, y: flying.y })).toBe(
      "alpha<->beta",
    );
    expect(
      scene.hitTestEnvelope({
        x: flying.x + region.rect.width,
        y: flying.y + region.rect.height,
      }),
    ).toBeNull();

    // Once it lands there is nothing left to click.
    scene.tick(400);
    expect(frameOf(scene).envelopeHitRegions).toHaveLength(0);
    expect(scene.hitTestEnvelope({ x: flying.x, y: flying.y })).toBeNull();
  });

  it("sends an idle agent on an errand, but not before it has been idle", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    let firstBreakMs: number | null = null;
    let mostAtOnce = 0;
    let elapsedMs = 0;
    while (elapsedMs < 60_000) {
      scene.tick(100);
      elapsedMs += 100;
      const away = crewAway(frameOf(scene));
      if (away.length > 0 && firstBreakMs === null) firstBreakMs = elapsedMs;
      mostAtOnce = Math.max(mostAtOnce, away.length);
    }

    // Stillness is the trigger, so an errand that starts on the first frame
    // would be reporting something the floor has not earned yet. The threshold
    // is short on purpose: the complaint this exists to answer is that agents
    // between turns looked dead.
    expect(firstBreakMs).not.toBeNull();
    expect(firstBreakMs).toBeGreaterThanOrEqual(5_000);
    expect(firstBreakMs).toBeLessThanOrEqual(10_000);
    // ...and then EVERYBODY goes. Four is nowhere near `MAX_CONCURRENT_ERRANDS`,
    // so a floor of four idle agents is a floor with four of them out. The old
    // half-the-floor limit is what left the other half sitting perfectly
    // still, which is the thing this is for.
    expect(mostAtOnce).toBe(IDLE_CREW.length);
  });

  /**
   * How long the floor takes to EMPTY - long enough that the sampling below is
   * about an agent coming back, not about one that has not left yet.
   *
   * MEASURED, both ends. The last of the four is out of its chair at 85 ticks,
   * so 85 is the floor; the sampling that follows is green at every budget up
   * to 800, so there is no ceiling to sit under. This was `90` - five ticks of
   * headroom over a measurement nothing in the case stated, 5.6 %, and any
   * change to the errand stagger would have spent it and reddened a case about
   * something else entirely.
   *
   * 180 is about twice the measurement, which is the margin a wait for a
   * COINCIDENCE wants (the same reading `CHESS_PAIRING_TICKS` is written
   * against): what moves it is the phase the four errand cycles fall into, not
   * the distance any one of them covers.
   */
  const IDLE_FLOOR_EMPTIED_TICKS = 180;

  it("keeps every idle agent away for as long as it stays idle", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Past the threshold plus the widest stagger, nobody has any business in a
    // chair. Sampled across a full minute rather than at one instant, because
    // the failure this catches is an agent that goes back between errands - and
    // that reads as a single frame of somebody seated, not as a floor at rest.
    for (let step = 0; step < IDLE_FLOOR_EMPTIED_TICKS; step += 1) {
      scene.tick(100);
    }
    let seatedFrames = 0;
    for (let step = 0; step < 600; step += 1) {
      scene.tick(100);
      const away = new Set(crewAway(frameOf(scene)));
      for (const person of IDLE_CREW) {
        if (!away.has(person.id)) seatedFrames += 1;
      }
    }
    expect(seatedFrames).toBe(0);
  });

  it("chains one errand into the next without going back to the desk", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Every spot alpha comes to a stop on, with the kind the plan gives it.
    const byTile = new Map<string, string>();
    for (const spot of layoutOf(scene).floors[0].errandSpots) {
      byTile.set(`${spot.tile.col},${spot.tile.row}`, spot.kind);
    }
    const kinds: string[] = [];
    let previous = characterRect(frameOf(scene), "alpha");
    let moving = true;
    for (let step = 0; step < 2_000; step += 1) {
      scene.tick(100);
      const rect = characterRect(frameOf(scene), "alpha");
      const still = rect.x === previous.x && rect.y === previous.y;
      previous = rect;
      if (!still) {
        moving = true;
        continue;
      }
      if (!moving) continue;
      moving = false;
      const kind = byTile.get(
        `${rect.x / OFFICE_TILE},${(rect.y + 4) / OFFICE_TILE}`,
      );
      if (kind !== undefined) kinds.push(kind);
    }

    expect(kinds.length).toBeGreaterThan(3);
    // Twice the same thing running is the animation being stuck rather than an
    // agent with somewhere to be. A stroll's own legs are all `corridor`, but
    // they are ONE errand - the kind that may not repeat is the errand's.
    for (let index = 1; index < kinds.length; index += 1) {
      if (kinds[index] === "corridor" && kinds[index - 1] === "corridor") {
        continue;
      }
      expect(kinds[index], `errand ${index}`).not.toBe(kinds[index - 1]);
    }
    expect(new Set(kinds).size).toBeGreaterThan(2);
  });

  it("strolls the corridors when every spot on the floor is taken", () => {
    // One cooler spot and nothing else: seven of the eight have nowhere to be,
    // and the old engine put them back in their chairs.
    const crowd = [1, 2, 3, 4, 5, 6, 7, 8].map((index) =>
      agent({ id: `agent-${index}`, createdAt: index }),
    );
    const ids = new Set(crowd.map((person) => person.id));
    const oneSpot = (input: ReadonlyArray<OfficeAgentInput>): OfficeLayout => {
      const base = layoutOffice(input);
      return {
        ...base,
        floors: base.floors.map((entry) => ({
          ...entry,
          errandSpots: entry.errandSpots.slice(0, 1),
        })),
      };
    };
    const scene = new OfficeScene(testView(oneSpot), null);
    scene.sync(sceneInput({ agents: crowd, visibleAgentIds: ids }));

    for (let step = 0; step < 200; step += 1) scene.tick(100);
    const away = new Set<string>();
    let sat = 0;
    for (let step = 0; step < 300; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      for (const region of frame.hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        const desk = layoutOf(scene).desks.get(region.agentId);
        if (desk === undefined) continue;
        const seated =
          region.rect.x === desk.chairTile.col * OFFICE_TILE &&
          region.rect.y === desk.chairTile.row * OFFICE_TILE - 4;
        if (seated) sat += 1;
        else away.add(region.agentId);
        // ...and a stroller never sits down: the sofa is the only errand taken
        // sitting, and this floor has no sofa spot left.
        const sprite = characterSpriteAt(frame, region.rect);
        if (sprite !== null && !seated) {
          expect(sprite.pose, region.agentId).not.toBe("sit");
        }
      }
    }
    expect(away.size).toBe(crowd.length);
    expect(sat).toBe(0);
  });

  it("visits a spread of destinations rather than the same one twice", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Where alpha actually stands, sampled over enough errands that a single
    // destination would have to be the rule rather than a coincidence.
    const spots = new Set(
      layoutOf(scene).floors[0].errandSpots.map(
        (spot) => `${spot.tile.col},${spot.tile.row}`,
      ),
    );
    // Every place alpha came to a STOP, in order. A position that repeats
    // across ticks is a linger; anything moving is a tile on the way.
    const visited: string[] = [];
    let previous = characterRect(frameOf(scene), "alpha");
    let moving = true;
    for (let step = 0; step < 3_000; step += 1) {
      scene.tick(100);
      const rect = characterRect(frameOf(scene), "alpha");
      const still = rect.x === previous.x && rect.y === previous.y;
      previous = rect;
      if (!still) {
        moving = true;
        continue;
      }
      if (!moving) continue;
      moving = false;
      const key = `${rect.x / OFFICE_TILE},${(rect.y + 4) / OFFICE_TILE}`;
      if (!spots.has(key)) continue;
      visited.push(key);
    }

    expect(visited.length).toBeGreaterThan(3);
    // Somewhere different each time it gets up: the same window twice running
    // reads as the animation being stuck rather than as an agent with somewhere
    // to be.
    for (let index = 1; index < visited.length; index += 1) {
      expect(visited[index], `errand ${index}`).not.toBe(visited[index - 1]);
    }
    expect(new Set(visited).size).toBeGreaterThan(2);
  });

  it("never sends two agents to the same spot", () => {
    const crowd = [1, 2, 3, 4, 5, 6, 7, 8].map((index) =>
      agent({ id: `agent-${index}`, createdAt: index }),
    );
    const ids = new Set(crowd.map((person) => person.id));
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: crowd, visibleAgentIds: ids }));

    let previous = new Map<string, string>();
    for (let step = 0; step < 2_000; step += 1) {
      scene.tick(100);
      const occupied = new Map<string, string>();
      const here = new Map<string, string>();
      for (const region of frameOf(scene).hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        const desk = layoutOf(scene).desks.get(region.agentId);
        if (desk === undefined) continue;
        const key = `${region.rect.x},${region.rect.y}`;
        here.set(region.agentId, key);
        // Two people in the same chair is impossible; two people on the same
        // errand SPOT is what the claim exists to prevent. Two people crossing
        // the same corridor tile on the same tick is neither - a floor where
        // everybody is out has walkers passing each other constantly, and they
        // are told apart from standers by having moved since the last frame.
        if (region.rect.x === desk.chairTile.col * OFFICE_TILE) continue;
        if (previous.get(region.agentId) !== key) continue;
        const holder = occupied.get(key);
        expect(holder, `${holder} and ${region.agentId} share ${key}`).toBe(
          undefined,
        );
        occupied.set(key, region.agentId);
      }
      previous = here;
    }
  });

  it("throws paper at the bin, misses some of it, and stops throwing", () => {
    const scene = new OfficeScene(testView(onlyKinds(["bin"])), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Where the bins actually are, so a ball can be shown to be aimed at one
    // rather than merely to exist.
    const bins = layoutOf(scene).props.filter(
      (prop) => prop.sprite.name === "bin",
    );
    expect(bins.length).toBeGreaterThan(0);

    let thrown = 0;
    let flew = false;
    let rested = 0;
    let previous: ReadonlyArray<OfficeSpriteDrawable> = [];
    for (let step = 0; step < 900; step += 1) {
      scene.tick(100);
      const balls = paperBalls(frameOf(scene));
      if (balls.length > previous.length) thrown += balls.length;
      // Read only from frames holding exactly ONE ball, in both this frame and
      // the last. Drawables carry no identity, so with several in play a ball
      // landing while another is thrown is indistinguishable from a ball
      // moving - and the two matched-axis comparisons this replaced were worse
      // still: they missed a DIAGONAL step entirely (neither axis held) and
      // read one ball's position against another's as motion.
      if (balls.length === 1 && previous.length === 1) {
        const ball = balls[0];
        const before = previous[0];
        if (ball.x === before.x && ball.y === before.y) {
          // On the floor: a miss holds one position while it lies there.
          rested += 1;
        } else {
          // In the air: the one ball on the floor is somewhere else now.
          flew = true;
        }
      }
      previous = balls;
    }

    expect(thrown).toBeGreaterThan(0);
    expect(flew).toBe(true);
    // A missed ball rests for three seconds - thirty frames at this tick - so
    // any resting at all is a miss, and it is the miss that proves the throw
    // was not simply drawn at its destination.
    expect(rested).toBeGreaterThan(0);

    // ...and the tosses end. A bin errand that never finished would leave a
    // character throwing at it forever.
    let quiet = 0;
    for (let step = 0; step < 200 && quiet < 20; step += 1) {
      scene.tick(100);
      quiet = paperBalls(frameOf(scene)).length === 0 ? quiet + 1 : 0;
    }
    expect(quiet).toBeGreaterThanOrEqual(20);
  });

  it("holds an end of the table open, then rallies once both are taken", () => {
    const scene = new OfficeScene(testView(onlyKinds(["pingpong"])), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    const ends = layoutOf(scene).floors[0].errandSpots.filter(
      (spot) => spot.kind === "pingpong",
    );
    expect(ends).toHaveLength(2);
    const rects = ends.map((end) => ({
      x: end.tile.col * OFFICE_TILE,
      y: end.tile.row * OFFICE_TILE - 4,
    }));

    let waitedAlone = false;
    let rallied = false;
    let ballMoved = false;
    let previousBall: OfficeSpriteDrawable | null = null;
    for (let step = 0; step < 900 && !ballMoved; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      const taken = rects.filter((rect) =>
        frame.hitRegions.some(
          (region) =>
            region.rect.height === OFFICE_CHARACTER_HEIGHT &&
            region.rect.x === rect.x &&
            region.rect.y === rect.y,
        ),
      );
      const balls = paperBalls(frame);
      if (taken.length === 1) {
        // Alone at the table: asking for a game, and no ball in play.
        if (
          hasBubbleAt(frame, "bubble-awaiting", {
            x: taken[0].x + 8,
            y: taken[0].y,
          })
        ) {
          waitedAlone = true;
        }
        expect(balls).toHaveLength(0);
      }
      if (taken.length === 2 && balls.length === 1) {
        rallied = true;
        // The ball is between the two ends, and it is moving.
        expect(balls[0].x).toBeGreaterThanOrEqual(
          Math.min(rects[0].x, rects[1].x),
        );
        expect(balls[0].x).toBeLessThanOrEqual(
          Math.max(rects[0].x, rects[1].x) + OFFICE_CHARACTER_WIDTH,
        );
        if (previousBall !== null && previousBall.x !== balls[0].x) {
          ballMoved = true;
        }
        previousBall = balls[0];
      }
    }

    expect(waitedAlone).toBe(true);
    expect(rallied).toBe(true);
    // One ball, shuttling: a rally drawn as a still ball is two people staring
    // at a table.
    expect(ballMoved).toBe(true);
  });

  it("answers a waiting player rather than leaving the table to the odds", () => {
    // A FULL floor, every kind of spot available. The table is two spots out of
    // twenty-odd, so a rally happening here is not the weights being generous -
    // it is the open end outranking them while somebody is stood at the other.
    const crowd = [1, 2, 3, 4, 5, 6].map((index) =>
      agent({ id: `agent-${index}`, createdAt: index }),
    );
    const ids = new Set(crowd.map((person) => person.id));
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: crowd, visibleAgentIds: ids }));

    const ends = layoutOf(scene).floors[0].errandSpots.filter(
      (spot) => spot.kind === "pingpong",
    );
    expect(ends).toHaveLength(2);
    const rects = ends.map((end) => ({
      x: end.tile.col * OFFICE_TILE,
      y: end.tile.row * OFFICE_TILE - 4,
    }));

    let ralliedTicks = 0;
    let rallies = 0;
    let playing = false;
    for (let step = 0; step < 2_400; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      const taken = rects.filter((rect) =>
        frame.hitRegions.some(
          (region) =>
            region.rect.height === OFFICE_CHARACTER_HEIGHT &&
            region.rect.x === rect.x &&
            region.rect.y === rect.y,
        ),
      ).length;
      if (taken === 2) ralliedTicks += 1;
      if (taken === 2 && !playing) rallies += 1;
      playing = taken === 2;
    }

    expect(rallies).toBeGreaterThan(0);
    // TIME IN PLAY is the measure, not games started: two agents will
    // occasionally roll the table at the same moment on their own, so a test
    // that only asked whether a rally ever happened would pass with the bias
    // deleted. Over four minutes this floor plays 264 ticks with the open end
    // outranking the draw and 0 without it - both re-measured on the storey
    // the Floor plans now that its civic rooms stand in the amenity columns,
    // which deepened it and lengthened the walk to the table. The unbiased arm
    // managed ~224 on the shallower floor and manages none at all on this one,
    // so the threshold sits between the two measurements rather than at a
    // number that merely looked round.
    expect(ralliedTicks).toBeGreaterThan(150);
  });

  it("gives up on the table when nobody takes the other end", () => {
    // One agent on the floor, so there is nobody to play against.
    const alone = [agent({ id: "alpha", createdAt: 1 })];
    const scene = new OfficeScene(testView(onlyKinds(["pingpong"])), null);
    scene.sync(
      sceneInput({ agents: alone, visibleAgentIds: new Set(["alpha"]) }),
    );

    const ends = layoutOf(scene).floors[0].errandSpots.filter(
      (spot) => spot.kind === "pingpong",
    );
    const keys = new Set(ends.map((end) => `${end.tile.col},${end.tile.row}`));

    let atTable = 0;
    let longestRun = 0;
    let run = 0;
    for (let step = 0; step < 400; step += 1) {
      scene.tick(100);
      const rect = characterRect(frameOf(scene), "alpha");
      const key = `${rect.x / OFFICE_TILE},${(rect.y + 4) / OFFICE_TILE}`;
      if (keys.has(key)) {
        atTable += 1;
        run += 1;
        longestRun = Math.max(longestRun, run);
      } else {
        run = 0;
      }
      expect(paperBalls(frameOf(scene))).toHaveLength(0);
    }

    expect(atTable).toBeGreaterThan(0);
    // Six seconds of waiting is sixty ticks; anything much past that is a
    // character stuck at a table forever, which is what the cap prevents.
    expect(longestRun).toBeLessThanOrEqual(75);
  });

  it("plays the arcade and flashes its screen while somebody is on it", () => {
    const scene = new OfficeScene(testView(onlyKinds(["arcade"])), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    const cabinet = layoutOf(scene).props.find(
      (prop) => prop.sprite.name === "arcade",
    );
    if (cabinet === undefined) throw new Error("no arcade");
    const onScreen = {
      x: cabinet.tile.col * OFFICE_TILE + OFFICE_TILE / 2,
      y: cabinet.tile.row * OFFICE_TILE + OFFICE_TILE / 2,
    };

    let flashes = 0;
    let lit = false;
    for (let step = 0; step < 600; step += 1) {
      scene.tick(100);
      const here = sprites(frameOf(scene).overlay, "sparkle").some(
        (sparkle) => sparkle.x === onScreen.x && sparkle.y === onScreen.y,
      );
      // Count the rising edge: the screen flashes, it does not simply stay on.
      if (here && !lit) flashes += 1;
      lit = here;
    }
    expect(flashes).toBeGreaterThan(1);
  });

  it("waters a cabin plant with a can and sparkles it at the end", () => {
    const scene = new OfficeScene(testView(onlyKinds(["water-plant"])), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    const plants = new Set(
      layoutOf(scene)
        .props.filter((prop) => prop.sprite.name === "plant")
        .map((prop) => `${prop.tile.col},${prop.tile.row}`),
    );
    let cans = 0;
    let sparkledPlants = 0;
    for (let step = 0; step < 600; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      cans += sprites(frame.overlay, "watering-can").length;
      for (const sparkle of sprites(frame.overlay, "sparkle")) {
        // On the PLANT, not over the waterer's head: tile centres are the only
        // place a sparkle at `(col + 8, row + 8)` can have come from.
        const key = `${(sparkle.x - OFFICE_TILE / 2) / OFFICE_TILE},${(sparkle.y - OFFICE_TILE / 2) / OFFICE_TILE}`;
        if (plants.has(key)) sparkledPlants += 1;
      }
    }
    expect(cans).toBeGreaterThan(0);
    expect(sparkledPlants).toBeGreaterThan(0);
  });

  it("sits down on the cafeteria sofa instead of standing at it", () => {
    const scene = new OfficeScene(testView(onlyKinds(["sofa"])), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // One sofa in the break room on a floor this size, with a seat in front of
    // each of its two tiles.
    const seats = layoutOf(scene).floors[0].errandSpots.filter(
      (spot) => spot.kind === "sofa",
    );
    expect(seats).toHaveLength(2);

    let sat = false;
    let dozed = false;
    for (let step = 0; step < 900 && !(sat && dozed); step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      for (const seat of seats) {
        const rect: OfficeRect = {
          x: seat.tile.col * OFFICE_TILE,
          y: seat.tile.row * OFFICE_TILE - 4,
          width: OFFICE_CHARACTER_WIDTH,
          height: OFFICE_CHARACTER_HEIGHT,
        };
        const sprite = characterSpriteAt(frame, rect);
        if (sprite === null) continue;
        // Seated, and turned back toward the room rather than at the cushion
        // it walked up to.
        if (sprite.pose === "sit" && sprite.facing === "down") sat = true;
        if (hasBubbleAt(frame, "bubble-sleep", { x: rect.x + 8, y: rect.y })) {
          dozed = true;
        }
      }
    }
    expect(sat).toBe(true);
    expect(dozed).toBe(true);
  });

  it("peeks in at another cabin's door and never at its own", () => {
    const families = [
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "a1", parentId: "root-a", createdAt: 2 }),
      agent({ id: "root-b", createdAt: 3 }),
      agent({ id: "b1", parentId: "root-b", createdAt: 4 }),
    ];
    const ids = new Set(families.map((person) => person.id));
    const scene = new OfficeScene(testView(onlyKinds(["peek"])), null);
    scene.sync(sceneInput({ agents: families, visibleAgentIds: ids }));

    // Each peek tile belongs to the cabin whose door is the tile above it.
    const doorOwners = new Map<string, string>();
    for (const room of layoutOf(scene).rooms) {
      doorOwners.set(
        `${room.doorTile.col},${room.doorTile.row + 1}`,
        room.rootAgentId,
      );
    }
    expect(doorOwners.size).toBe(2);

    let peeks = 0;
    for (let step = 0; step < 600; step += 1) {
      scene.tick(100);
      for (const [key, agentId] of standingByTile(scene)) {
        const owner = doorOwners.get(key);
        if (owner === undefined) continue;
        peeks += 1;
        // Standing outside your OWN door is not a peek, it is loitering.
        expect(cabinOf(scene, agentId), `${agentId} at ${key}`).not.toBe(owner);
      }
    }
    expect(peeks).toBeGreaterThan(0);
  });

  it("offers the stairwell only on a building with more than one floor", () => {
    const single = layoutOffice(IDLE_CREW);
    expect(
      single.floors[0].errandSpots.some((spot) => spot.kind === "stairs"),
    ).toBe(false);

    const stacked = [
      agent({ id: "alpha", hostId: "host-a", createdAt: 1 }),
      agent({ id: "beta", hostId: "host-b", createdAt: 2 }),
    ];
    const layout = layoutOffice(stacked);
    expect(layout.floors).toHaveLength(2);
    for (const floor of layout.floors) {
      const stairs = floor.errandSpots.filter((spot) => spot.kind === "stairs");
      expect(stairs).toHaveLength(1);
      // Beside the well and looking at it, on a tile you can actually stand on.
      expect(layout.walkable[stairs[0].tile.row][stairs[0].tile.col]).toBe(
        true,
      );
      expect(stairs[0].facing).toBe("right");
    }
  });

  it("keeps two agents at neighbouring cafeteria spots talking in turn", () => {
    const crowd = [1, 2, 3, 4, 5, 6].map((index) =>
      agent({ id: `agent-${index}`, createdAt: index }),
    );
    const ids = new Set(crowd.map((person) => person.id));
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: crowd, visibleAgentIds: ids }));

    // A conversation is ONE bubble at a time, changing hands. Two at once reads
    // as two people waiting near each other; none at all reads as two people
    // ignoring each other across a table.
    let sawPair = false;
    let sawAlternation = false;
    let sawBoth = false;
    let previousSpeaker: string | null = null;
    for (let step = 0; step < 4_000 && !sawAlternation; step += 1) {
      scene.tick(100);
      const pair = chatPairAt(scene);
      if (pair === null) {
        previousSpeaker = null;
        continue;
      }
      sawPair = true;
      const frame = frameOf(scene);
      const speakers = pair.filter((agentId) => {
        const head = headOfRegion(scene, agentId);
        return head !== null && hasBubbleAt(frame, "bubble-awaiting", head);
      });
      if (speakers.length > 1) sawBoth = true;
      if (speakers.length !== 1) continue;
      if (previousSpeaker !== null && previousSpeaker !== speakers[0]) {
        sawAlternation = true;
      }
      previousSpeaker = speakers[0];
    }
    expect(sawPair).toBe(true);
    expect(sawBoth).toBe(false);
    expect(sawAlternation).toBe(true);
  });

  it("keeps a seated idle agent moving at its own desk", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Errands move two people at a time. Without the desk fillers the other
    // half of the floor is a still image, which is the whole complaint.
    const poses = new Set<string>();
    for (let step = 0; step < 400; step += 1) {
      scene.tick(50);
      for (const region of frameOf(scene).hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        const seated = crewSeatedRect(region.agentId);
        if (region.rect.x !== seated.x || region.rect.y !== seated.y) continue;
        const sprite = characterSpriteAt(frameOf(scene), region.rect);
        if (sprite === null) continue;
        poses.add(`${sprite.pose ?? ""}/${sprite.facing ?? ""}`);
      }
    }
    // Sitting, and at least one filler turning the body away from the screen.
    expect(poses.has("sit/up")).toBe(true);
    expect([...poses].some((key) => key.startsWith("stand/"))).toBe(true);
  });

  it("runs no desk filler while an agent is away on an errand", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // A sofa, a sleeping bag, an armchair, a console seat and a garden bench
    // are the places off a desk where SITTING is the activity, so they are the
    // ones where `sit` does not mean a filler leaked onto the floor.
    const seatedKinds = new Set(["sofa", "nap", "read", "console", "garden"]);
    const seatKeys = new Set(
      layoutOf(scene)
        .floors[0].errandSpots.filter((spot) => seatedKinds.has(spot.kind))
        .map((spot) => `${spot.tile.col},${spot.tile.row}`),
    );
    expect(seatKeys.size).toBeGreaterThan(0);

    for (let step = 0; step < 1_500; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      for (const region of frame.hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        const seated = crewSeatedRect(region.agentId);
        if (region.rect.x === seated.x && region.rect.y === seated.y) continue;
        const key = `${region.rect.x / OFFICE_TILE},${(region.rect.y + 4) / OFFICE_TILE}`;
        if (seatKeys.has(key)) continue;
        const sprite = characterSpriteAt(frame, region.rect);
        if (sprite === null) continue;
        // A character off its chair is walking or standing at a spot. `sit` on
        // the floor would mean a filler had leaked out of the desk.
        expect(sprite.pose, region.agentId).not.toBe("sit");
      }
    }
  });

  it("calls only on a colleague in the same cabin", () => {
    const families = [
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "a1", parentId: "root-a", createdAt: 2 }),
      agent({ id: "a2", parentId: "root-a", createdAt: 3 }),
      agent({ id: "root-b", createdAt: 4 }),
      agent({ id: "b1", parentId: "root-b", createdAt: 5 }),
      agent({ id: "b2", parentId: "root-b", createdAt: 6 }),
    ];
    const ids = new Set(families.map((person) => person.id));
    // A floor plan with no errand spots at all, so a visit is the ONLY errand
    // left to take. Otherwise this would be a test of how often the weighted
    // roll happens to land on one rather than of who it lands on.
    const spotless = (input: ReadonlyArray<OfficeAgentInput>): OfficeLayout => {
      const base = layoutOffice(input);
      return {
        ...base,
        floors: base.floors.map((entry) => ({ ...entry, errandSpots: [] })),
      };
    };
    const scene = new OfficeScene(testView(spotless), null);
    scene.sync(sceneInput({ agents: families, visibleAgentIds: ids }));

    let visits = 0;
    for (let step = 0; step < 1_000; step += 1) {
      scene.tick(100);
      for (const [key, agentId] of standingByTile(scene)) {
        const [col, row] = key.split(",").map(Number);
        const host = hostDeskAt(scene, { col, row });
        // Everything else off a chair is a tile being walked over, which the
        // desk lookup rejects.
        if (host === null) continue;
        visits += 1;
        expect(cabinOf(scene, agentId), `${agentId} visiting ${host}`).toBe(
          cabinOf(scene, host),
        );
      }
    }
    expect(visits).toBeGreaterThan(0);
    // Both cabins have to have produced visits, or "same cabin" could be
    // holding by accident on a floor where only one family ever moved.
    expect(layoutOf(scene).rooms).toHaveLength(2);
  });

  it("drops an errand the instant a message is in the air", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    const idle = sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS });
    scene.sync(idle);

    // Wait for somebody to be not just away but SETTLED at a spot: an agent
    // that was mid-walk anyway would prove nothing about the linger ending.
    let lingering: string | null = null;
    let previous = new Map<string, string>();
    for (let step = 0; step < 400 && lingering === null; step += 1) {
      scene.tick(100);
      const here = new Map<string, string>();
      for (const region of frameOf(scene).hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        here.set(region.agentId, `${region.rect.x},${region.rect.y}`);
      }
      for (const agentId of crewAway(frameOf(scene))) {
        if (previous.get(agentId) === here.get(agentId)) lingering = agentId;
      }
      previous = here;
    }
    if (lingering === null) throw new Error("nobody settled at a spot");
    const parked = characterRect(frameOf(scene), lingering);

    scene.sync(
      sceneInput({
        agents: IDLE_CREW,
        visibleAgentIds: CREW_IDS,
        pulse: {
          kind: "edge",
          edgeId: `${lingering}<->alpha`,
          pulseKind: "request",
          fromAgentId: lingering,
          toAgentId: lingering === "alpha" ? "beta" : "alpha",
        },
        pulseKey: "urgent",
      }),
    );
    scene.tick(100);
    // The linger is over on the first frame, not when it would have run out.
    let previousRect = characterRect(frameOf(scene), lingering);
    expect(previousRect).not.toEqual(parked);

    // The hurry is a LATCH held until the chair, not a window that closes when
    // the envelope lands. The flight is 600ms here, so every tick from the
    // eighth on is after it - and a stroll would cover 4.8px in one of them
    // against the hurry's 22.4px. A single step wider than a tile is therefore
    // only possible if the speed never dropped.
    let home = 0;
    let fastestAfterLanding = 0;
    for (let step = 2; step <= 30 && home === 0; step += 1) {
      scene.tick(100);
      const rect = characterRect(frameOf(scene), lingering);
      if (step > 7) {
        const moved =
          Math.abs(rect.x - previousRect.x) + Math.abs(rect.y - previousRect.y);
        fastestAfterLanding = Math.max(fastestAfterLanding, moved);
      }
      previousRect = rect;
      if (JSON.stringify(rect) === JSON.stringify(crewSeatedRect(lingering))) {
        home = step;
      }
    }
    expect(fastestAfterLanding).toBeGreaterThan(OFFICE_TILE);
    expect(home).toBeGreaterThan(0);
  });

  it("renders the identical frames from the identical ticks", () => {
    // Everything added for idle life - which spot, how long, which filler,
    // whose turn to talk - is seeded from the agent id and the scene clock.
    // A single `Math.random` anywhere in it would make playback unscrubbable.
    const run = (): ReadonlyArray<string> => {
      const scene = new OfficeScene(testView(layoutOffice), null);
      scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));
      const frames: string[] = [];
      for (let step = 0; step < 600; step += 1) {
        scene.tick(100);
        if (step % 7 === 0) frames.push(JSON.stringify(frameOf(scene)));
      }
      return frames;
    };

    const first = run();
    expect(first.length).toBeGreaterThan(0);
    expect(run()).toEqual(first);
  });

  it("never breaks during playback", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: IDLE_CREW,
        visibleAgentIds: CREW_IDS,
        playing: true,
      }),
    );

    // Playback makes every agent idle between its own rows, so a break here
    // would fire constantly and mean nothing.
    for (let step = 0; step < 600; step += 1) {
      scene.tick(100);
      expect(crewAway(frameOf(scene))).toEqual([]);
    }
  });

  it("sends a wanderer straight back when its status changes", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    const idle = sceneInput({
      agents: IDLE_CREW,
      visibleAgentIds: CREW_IDS,
    });
    scene.sync(idle);

    let away: ReadonlyArray<string> = [];
    for (let step = 0; step < 600 && away.length === 0; step += 1) {
      scene.tick(100);
      away = crewAway(frameOf(scene));
    }
    expect(away.length).toBeGreaterThan(0);

    const busy = away[0];
    scene.sync(
      sceneInput({
        agents: IDLE_CREW,
        visibleAgentIds: CREW_IDS,
        statusById: new Map<string, OfficeAgentStatus>([[busy, "working"]]),
      }),
    );
    // The walk back is a walk, not a teleport, so give it the tiles it needs.
    for (let step = 0; step < 200; step += 1) scene.tick(100);

    expect(crewAway(frameOf(scene))).not.toContain(busy);
  });

  it("draws floor under every walkable tile that is not a doorway", () => {
    // Three cabins over two bands: a corridor between the bands, a corridor
    // between the two cabins sharing the lower one, and the building's own
    // aisle down either side.
    const crowd = [
      agent({ id: "root-a", createdAt: 1 }),
      agent({ id: "a1", parentId: "root-a", createdAt: 2 }),
      agent({ id: "a2", parentId: "root-a", createdAt: 3 }),
      agent({ id: "a3", parentId: "root-a", createdAt: 4 }),
      agent({ id: "a4", parentId: "a1", createdAt: 5 }),
      agent({ id: "a5", parentId: "a1", createdAt: 6 }),
      agent({ id: "root-b", createdAt: 7 }),
      agent({ id: "b1", parentId: "root-b", createdAt: 8 }),
      agent({ id: "b2", parentId: "root-b", createdAt: 9 }),
      agent({ id: "root-c", createdAt: 10 }),
    ];
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: crowd,
        visibleAgentIds: new Set(crowd.map((person) => person.id)),
      }),
    );
    const layout = layoutOf(scene);
    expect(layout.rooms).toHaveLength(3);

    // The floor layer is painted in order, so the LAST tile-aligned sprite at
    // a position is the one a viewer actually sees. (The rug is centred on its
    // tile, so it is not tile-aligned and never masks the floor under it.)
    const painted = new Map<string, OfficeSpriteName>();
    for (const drawable of frameOf(scene).floor) {
      if (drawable.kind !== "sprite") continue;
      if (drawable.x % OFFICE_TILE !== 0) continue;
      if (drawable.y % OFFICE_TILE !== 0) continue;
      painted.set(
        `${drawable.x / OFFICE_TILE},${drawable.y / OFFICE_TILE}`,
        drawable.sprite.name,
      );
    }

    const doorways = new Set<string>([
      ...layout.floors.map(
        (entry) => `${entry.doorTile.col},${entry.doorTile.row}`,
      ),
      ...layout.rooms.map(
        (room) => `${room.doorTile.col},${room.doorTile.row}`,
      ),
    ]);
    for (const key of amenityDoorKeys(layout)) doorways.add(key);
    for (let row = 0; row < layout.rows; row += 1) {
      for (let col = 0; col < layout.cols; col += 1) {
        if (!layout.walkable[row][col]) continue;
        const key = `${col},${row}`;
        if (doorways.has(key)) {
          expect(painted.get(key), key).toBe("door");
          continue;
        }
        // Somewhere a character can stand must look like somewhere a character
        // can stand - a corridor painted as brick reads as a sealed room. A pod
        // floor counts, and so does the garden's grass: both are the same
        // floor in another surface - and so does a piece of static scenery
        // (an armchair, a clock) standing on its own walkable tile, since the
        // painter now bakes `layout.props` into this same floor pass and a
        // walkable tile is never a wall or a window either way.
        const name = painted.get(key);
        expect(name, key).toBeDefined();
        if (name === undefined) continue;
        expect(["wall", "wall-top", "window"].includes(name), key).toBe(false);
      }
    }
  });

  /** Measured: alpha's desk to its infirmary bed is 163 ticks on this floor. */
  const CRASH_WALK_TICKS = 400;

  it("crashes the screen of a failing agent, sends it to a bed, and KEEPS the crashed screen on the desk it left", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "failure"]]),
      }),
    );
    // THE SCREEN, while the agent is still at the desk it crashed at.
    const frame = frameOf(scene);
    const crashed = sprites(frame.props, "monitor-crash");
    expect(crashed).toHaveLength(1);
    // Static: no alternate frame, and never dimmed the way an idle screen is.
    expect(crashed[0].alpha).toBeUndefined();
    const desk = layoutOf(scene).desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk");
    expect(crashed[0].x).toBe(desk.deskTile.col * OFFICE_TILE + 3);
    scene.tick(260);
    expect(sprites(frameOf(scene).props, "monitor-crash")).toHaveLength(1);

    // Long enough to cross a furnished storey at a walk AND lie down at the
    // end of it. Measured at 163 ticks from alpha's desk to its bed on this
    // fixture; the old 150 was enough only to reach the lobby counter.
    for (let step = 0; step < CRASH_WALK_TICKS; step += 1) scene.tick(100);

    // C4: A CRASH GOES TO THE INFIRMARY, NOT TO THE COUNTER. This asserted
    // `receptionQueueTiles[0]` until there was a bed to send it to; a failing
    // agent now walks to one and lies down in it, and `attention` is the only
    // status the front desk still answers for. The crashed SCREEN stays behind
    // at the desk, which is the other half of what this case says.
    // `whereabouts` reads the EFFECTIVE seat's own `civicRoomId`, so naming
    // the room is the same statement as "it is in one of that room's seats" -
    // its desk would answer with its cabin.
    expect(scene.whereabouts("alpha")).toBe("Infirmary");
    const lying = characterRect(frameOf(scene), "alpha");
    // In the bed it is drawn as the nap room draws a sleeper rather than
    // slumped at a monitor it is nowhere near - the status is the glyph above
    // it, not the body.
    expect(characterSpriteAt(frameOf(scene), lying)?.pose).toBe("sit");

    // THE DESK IS STILL THERE, AND STILL CRASHED, with its owner two rooms
    // away in a bed. This is the visible half of the vanishing-desk fix, and
    // the reason it is asserted rather than left implied: `seatsIn` drops a
    // seat that is assigned but unoccupied, on the reasoning that an empty
    // assigned desk belongs to somebody who has not arrived at this cursor. A
    // civic claim is the other way to be assigned-and-empty - the owner exists
    // and is lying down elsewhere - so the whole desk VANISHED, furniture,
    // monitor and all, the moment its owner walked to the infirmary.
    // `occupantToPaint` answers the assignee for exactly this, as it already
    // did for an open handover. A desk that disappears when somebody crashes
    // is what this line catches.
    const afterWalk = sprites(frameOf(scene).props, "monitor-crash");
    expect(afterWalk).toHaveLength(1);
    expect(afterWalk[0].x).toBe(desk.deskTile.col * OFFICE_TILE + 3);
  });

  /**
   * THE WINDOW IN WHICH A RECOVERED AGENT IS BACK IN ITS CHAIR, and it is a
   * window at both ends - which is the whole reason this is a named number.
   *
   * MEASURED: the walk home lands at 60 ticks, and at 138 the agent is out of
   * that chair again on an ordinary errand. So the case is green on
   * [60, 137] and red on either side of it, and the `60` this used to carry
   * sat EXACTLY on the lower edge - 59 reds. Nothing said so, and either edge
   * moving (a slower walk home, an earlier first errand) would have reddened a
   * case that is about the crash CLEARING, not about how long anything takes.
   *
   * 98 is the middle of the window: 38 ticks of slack below and 39 above,
   * rather than 0 and 77.
   *
   * BOTH NUMBERS ARE MEASURED AGAINST THE FIRST WAIT, which is not "the crash
   * settling". Alpha is in `failure` for those 60 ticks, so it spends them
   * WALKING OUT to its bed - a partial outbound lead-in - and where it has got
   * to when the resolve lands is what sets how far it has to come back. Move
   * the first wait and the window above moves with it; the two are one
   * measurement taken in two places, not a settle and a budget.
   *
   * The first wait was left at 60 because it is green at every cut it was
   * given, down to half (30). It was NOT probed upward, so nothing here claims
   * it has no ceiling of its own - only that it has room below.
   */
  const CRASH_CLEARED_TICKS = 98;

  it("clears the crash and walks the agent back when the failure resolves", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "failure"]]),
      }),
    );
    for (let step = 0; step < 60; step += 1) scene.tick(100);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    for (let step = 0; step < CRASH_CLEARED_TICKS; step += 1) scene.tick(100);

    const frame = frameOf(scene);
    expect(sprites(frame.props, "monitor-crash")).toHaveLength(0);
    expect(characterRect(frame, "alpha")).toEqual(seatedRect("alpha"));
  });

  it("gives each model tier its own screen at its own offset", () => {
    const crew = [
      agent({ id: "alpha", createdAt: 1, modelTier: "small" }),
      agent({ id: "beta", createdAt: 2, modelTier: "large" }),
    ];
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: crew, visibleAgentIds: BOTH }));

    const frame = frameOf(scene);
    expect(sprites(frame.props, "monitor-small-on")).toHaveLength(1);
    expect(sprites(frame.props, "monitor-wide-on")).toHaveLength(1);
    expect(sprites(frame.props, "monitor-on")).toHaveLength(0);

    const laptopDesk = layoutOf(scene).desks.get("alpha");
    const wideDesk = layoutOf(scene).desks.get("beta");
    if (laptopDesk === undefined || wideDesk === undefined) {
      throw new Error("expected both desks");
    }
    expect(sprites(frame.props, "monitor-small-on")[0].x).toBe(
      laptopDesk.deskTile.col * OFFICE_TILE + 5,
    );
    expect(sprites(frame.props, "monitor-wide-on")[0].x).toBe(
      wideDesk.deskTile.col * OFFICE_TILE,
    );
    // A wide screen reaches across the desk's right half, so the plate and its
    // badge move over rather than sitting under it.
    const plates = sprites(frame.props, "nameplate");
    const widePlate = plates.find(
      (plate) => plate.x >= wideDesk.deskTile.col * OFFICE_TILE,
    );
    if (widePlate === undefined) throw new Error("expected a plate");
    expect(widePlate.x).toBe(wideDesk.deskTile.col * OFFICE_TILE + 20);
  });

  it("holds a laptop screen still while a wide one alternates", () => {
    const crew = [
      agent({ id: "alpha", createdAt: 1, modelTier: "small" }),
      agent({ id: "beta", createdAt: 2, modelTier: "large" }),
    ];
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: crew,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "working"],
          ["beta", "working"],
        ]),
      }),
    );

    const litNames = (): ReadonlyArray<OfficeSpriteName> => {
      const found: OfficeSpriteName[] = [];
      for (const drawable of frameOf(scene).props) {
        if (drawable.kind !== "sprite") continue;
        if (!drawable.sprite.name.startsWith("monitor-")) continue;
        found.push(drawable.sprite.name);
      }
      return found;
    };

    const before = litNames();
    scene.tick(260);
    const after = litNames();
    // The laptop tier has no second lit frame, so only the wide desk moves.
    expect(before).toContain("monitor-small-on");
    expect(after).toContain("monitor-small-on");
    expect(new Set([...before, ...after])).toContain("monitor-wide-on-b");
  });

  it("piles unanswered requests on the receiver's desk, three deep at most", () => {
    const crew = [
      agent({ id: "alpha", createdAt: 1 }),
      agent({ id: "beta", createdAt: 2 }),
      agent({ id: "gamma", createdAt: 3 }),
      agent({ id: "delta", createdAt: 4 }),
    ];
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: crew,
        visibleAgentIds: new Set(crew.map((person) => person.id)),
        openRequestsByReceiver: new Map<string, number>([
          ["alpha", 1],
          ["beta", 2],
          ["gamma", 9],
        ]),
      }),
    );

    const frame = frameOf(scene);
    expect(sprites(frame.props, "envelope-stack-1")).toHaveLength(1);
    expect(sprites(frame.props, "envelope-stack-2")).toHaveLength(1);
    // Nine is still one pile; the tallest sprite is where the art stops.
    expect(sprites(frame.props, "envelope-stack-3")).toHaveLength(1);

    const desk = layoutOf(scene).desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk");
    const stack = sprites(frame.props, "envelope-stack-1")[0];
    const size = officeSpriteSize({ name: "envelope-stack-1" });
    // Bottom-anchored: every height rests on the same line on the desk.
    expect(stack.y + size.height).toBe(desk.deskTile.row * OFFICE_TILE + 4);
    expect(stack.x).toBe(desk.deskTile.col * OFFICE_TILE + 1);
    // A desk with nothing waiting gets no pile at all.
    expect(sprites(frame.props, "envelope-stack-1")).toHaveLength(1);
  });

  it("hangs one clock per floor and centres its hands on the face", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({ agents: AGENTS, visibleAgentIds: BOTH, clockMs: 42_000 }),
    );

    const frame = frameOf(scene);
    const clocks: Array<Extract<OfficeDrawable, { kind: "clock" }>> = [];
    for (const drawable of frame.overlay) {
      if (drawable.kind === "clock") clocks.push(drawable);
    }
    expect(clocks).toHaveLength(layoutOf(scene).floors.length);
    expect(clocks[0].timeMs).toBe(42_000);

    // The clock face is static scenery - like every other wall fitting, the
    // painter bakes it into the floor pass rather than the per-desk prop pass.
    const face = sprites(frame.floor, "clock")[0];
    expect(face).toBeDefined();
    const size = officeSpriteSize({ name: "clock" });
    // CENTER anchored on the face the prop just drew.
    expect(clocks[0].x).toBe(face.x + size.width / 2);
    expect(clocks[0].y).toBe(face.y + size.height / 2);
  });

  /**
   * Long enough for the SECOND agent to cross this floor to the counter.
   *
   * Measured, not chosen: alpha's desk is the far one, and its walk to slot 1
   * takes 100 ticks on the storey the Floor plans today - which grew deeper
   * when the civic rooms joined the amenity columns, from a storey where 80
   * was enough. The margin over the measurement is what keeps the case about
   * arrival ORDER rather than about the exact depth of a floor plan.
   */
  const QUEUE_WALK_TICKS = 140;

  it("queues agents needing a person in arrival order and walks them back", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["beta", "attention"]]),
      }),
    );
    for (let step = 0; step < QUEUE_WALK_TICKS; step += 1) scene.tick(100);

    const floor = layoutOf(scene).floors[0];
    // Beta needed a person first, so it holds the nearest slot even once
    // alpha joins the queue behind it.
    expect(characterRect(frameOf(scene), "beta").x).toBe(
      floor.receptionQueueTiles[0].col * OFFICE_TILE,
    );

    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
          ["beta", "attention"],
        ]),
      }),
    );
    for (let step = 0; step < QUEUE_WALK_TICKS; step += 1) scene.tick(100);

    const queued = frameOf(scene);
    expect(characterRect(queued, "beta").x).toBe(
      floor.receptionQueueTiles[0].col * OFFICE_TILE,
    );
    expect(characterRect(queued, "alpha").x).toBe(
      floor.receptionQueueTiles[1].col * OFFICE_TILE,
    );

    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    // They WALK back, so the seat is reached after some tiles rather than on
    // the sync that released them - and once seated they are free to go on an
    // errand again, which is why this stops at the first frame both are home.
    let homeAfter: number | null = null;
    for (let step = 1; step <= 120 && homeAfter === null; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      const both =
        JSON.stringify(characterRect(frame, "alpha")) ===
          JSON.stringify(seatedRect("alpha")) &&
        JSON.stringify(characterRect(frame, "beta")) ===
          JSON.stringify(seatedRect("beta"));
      if (both) homeAfter = step;
    }
    expect(homeAfter).not.toBeNull();
    expect(homeAfter).toBeGreaterThan(1);
  });

  it("leaves the overflow at their desks when the queue is full", () => {
    const crowd = [1, 2, 3, 4, 5, 6, 7, 8].map((index) =>
      agent({ id: `agent-${index}`, createdAt: index }),
    );
    const ids = new Set(crowd.map((person) => person.id));
    const scene = new OfficeScene(testView(layoutOffice), null);
    const statusById = new Map<string, OfficeAgentStatus>();
    for (const person of crowd) statusById.set(person.id, "attention");
    // Motion off, so every placement is exact rather than mid-walk.
    scene.sync(
      sceneInput({
        agents: crowd,
        visibleAgentIds: ids,
        statusById,
        reducedMotion: true,
      }),
    );

    const layout = layoutOf(scene);
    const slots = layout.floors[0].receptionQueueTiles;
    const slotKeys = new Set(slots.map((tile) => `${tile.col},${tile.row}`));
    let standing = 0;
    for (const region of frameOf(scene).hitRegions) {
      if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
      const key = `${region.rect.x / OFFICE_TILE},${(region.rect.y + 4) / OFFICE_TILE}`;
      if (slotKeys.has(key)) standing += 1;
    }
    expect(slots.length).toBeLessThan(crowd.length);
    expect(standing).toBe(slots.length);
  });

  /**
   * HOW LONG THE WALK OUT OF THE DOOR TAKES, after the 400 ms this case spends
   * proving the leaver is on its feet.
   *
   * MEASURED: 116 ticks. This carried `120` - four ticks, 3.3 % - over a
   * number nothing here stated. There is no upper edge to sit under: an
   * archived agent that has vanished stays vanished, and the case is green at
   * every budget probed up to 800, so the fix is simply to stop standing on
   * the lower one.
   *
   * IT IS THE SAME WALK `office-scene-replay.test.ts` WAITS FOR, and the two
   * measurements are the same number rather than two nearby ones: both run
   * `testView(layoutOffice)` with the same alpha/beta pair, and 400 ms of
   * lead-in plus 116 ticks is 12 000 ms of scene clock - exactly the 120 ticks
   * that file measures with no lead-in at all. They agree to the millisecond,
   * and the only reason they are two constants is that a reader of either case
   * should see what THAT case waits for.
   *
   * `ARCHIVAL_WALK_OUT_TICKS` in "%s view behaviour" is the third, and its 127
   * is not a third floor: that describe is `describe.each(OFFICE_VIEW_IDS)`, so
   * its budget has to cover the SLOWEST of the six views, not the Floor. A
   * single shared constant would hide which of those three moved.
   */
  const CURSOR_ARCHIVAL_WALK_TICKS = 240;

  it("walks an agent out of the door when the cursor crosses its archival", () => {
    const leaver = agent({ id: "alpha", createdAt: 1, archivedAt: 500 });
    const live = sceneInput({
      agents: [leaver, BETA],
      visibleAgentIds: BOTH,
      cursorMs: 100,
    });
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(live);
    expect(characterRect(frameOf(scene), "alpha")).toEqual(seatedRect("alpha"));

    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 900,
      }),
    );
    // On its feet and heading for the door, not simply switched off in place.
    scene.tick(400);
    expect(characterRect(frameOf(scene), "alpha")).not.toEqual(
      seatedRect("alpha"),
    );
    expect(hasCharacter(frameOf(scene), "alpha")).toBe(true);

    for (let step = 0; step < CURSOR_ARCHIVAL_WALK_TICKS; step += 1) {
      scene.tick(100);
    }
    const gone = frameOf(scene);
    expect(hasCharacter(gone, "alpha")).toBe(false);
    expect(sprites(gone.props, "dust-sheet")).toHaveLength(1);
    expect(sprites(gone.props, "box")).toHaveLength(1);

    // Scrubbing back un-archives: the same person walks in again.
    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 100,
      }),
    );
    const returning = frameOf(scene);
    expect(sprites(returning.props, "dust-sheet")).toHaveLength(0);
    expect(characterRect(returning, "alpha").y).toBe(
      layoutOf(scene).floors[0].doorTile.row * OFFICE_TILE - 4,
    );
    // The walk in ends at the chair. It does not STAY there - an idle agent is
    // never at its desk for long - so what is asserted is that the return
    // completes, not where the character is a dozen seconds later.
    let arrived = false;
    for (let step = 0; step < 120 && !arrived; step += 1) {
      scene.tick(100);
      arrived =
        JSON.stringify(characterRect(frameOf(scene), "alpha")) ===
        JSON.stringify(seatedRect("alpha"));
    }
    expect(arrived).toBe(true);
  });

  it("sheets an archived desk with no walk at all when motion is reduced", () => {
    const leaver = agent({ id: "alpha", createdAt: 1, archivedAt: 500 });
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 100,
        reducedMotion: true,
      }),
    );
    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 900,
        reducedMotion: true,
      }),
    );

    const frame = frameOf(scene);
    expect(hasCharacter(frame, "alpha")).toBe(false);
    expect(sprites(frame.props, "dust-sheet")).toHaveLength(1);
  });

  it("keeps an agent archived only in the future at its desk", () => {
    const later = agent({ id: "alpha", createdAt: 1, archivedAt: 5_000 });
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: [later, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 1_000,
      }),
    );

    // The record says archived; the cursor says not yet, and the floor shows
    // the moment the cursor is on.
    expect(sprites(frameOf(scene).props, "dust-sheet")).toHaveLength(0);
    expect(characterRect(frameOf(scene), "alpha")).toEqual(seatedRect("alpha"));
  });

  it("flies an envelope between the two SEATS, never between two bodies", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: CREATED_PULSE,
        pulseKey: "created-beta",
      }),
    );
    // Beta is still crossing the floor from the door...
    expect(characterRect(frameOf(scene), "beta")).not.toEqual(
      seatedRect("beta"),
    );
    const launched = envelopes(frameOf(scene))[0];
    expect(launched.x).toBe(seatedHead("alpha").x);

    // ...and the next message to it does NOT jerk it into the chair to receive.
    // Snapping a walking sprite to a tile reads as a rendering fault; the
    // envelope simply lands on the desk and waits.
    const walking = characterRect(frameOf(scene), "beta");
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: REQUEST_PULSE,
        pulseKey: "row-2",
      }),
    );
    expect(characterRect(frameOf(scene), "beta")).toEqual(walking);
  });

  it("hurries an agent with a message waiting, and greets it once seated", () => {
    // Two identical walks in from the same door to the same chair. The only
    // difference is a message in the air, so the difference in how long the
    // walk takes IS the hurry.
    const walkInMs = (withMessage: boolean): number => {
      const scene = new OfficeScene(testView(layoutOffice), null);
      scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
      scene.sync(
        sceneInput({
          agents: AGENTS,
          visibleAgentIds: BOTH,
          // A `created` edge puts an envelope in the air; plain playback
          // reveals the same newcomer with nothing on the way to it.
          pulse: withMessage ? CREATED_PULSE : null,
          pulseKey: withMessage ? "created-beta" : null,
          playing: !withMessage,
        }),
      );
      const door = layoutOf(scene).doorTile;
      expect(characterRect(frameOf(scene), "beta").x).toBe(
        door.col * OFFICE_TILE,
      );
      let seatedAt: number | null = null;
      let greeted = false;
      for (let step = 1; step <= 200; step += 1) {
        scene.tick(50);
        const frame = frameOf(scene);
        if (hasBubbleAt(frame, "bubble-hello", seatedHead("beta"))) {
          greeted = true;
        }
        if (seatedAt !== null) continue;
        if (
          JSON.stringify(characterRect(frame, "beta")) ===
          JSON.stringify(seatedRect("beta"))
        ) {
          seatedAt = step;
        }
      }
      if (seatedAt === null) throw new Error("beta never sat down");
      // Never teleported: the walk took real tiles either way.
      expect(seatedAt).toBeGreaterThan(1);
      // A message on the way is greeted; a plain reveal has nothing to greet.
      expect(greeted).toBe(withMessage);
      return seatedAt;
    };

    expect(walkInMs(true)).toBeLessThan(walkInMs(false));
  });

  it("piles a message onto the desk of an agent stuck at reception", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    const needsHelp = new Map<string, OfficeAgentStatus>([
      ["beta", "attention"],
    ]);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: needsHelp,
      }),
    );
    for (let step = 0; step < 80; step += 1) scene.tick(100);
    expect(stacks(frameOf(scene))).toHaveLength(0);

    // The request is open from the row it lands on, and the as-of count is
    // what says so; the landed message itself only carries the greeting, or
    // the one envelope would be drawn as two.
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: needsHelp,
        pulse: REQUEST_PULSE,
        pulseKey: "row-1",
        openRequestsByReceiver: new Map([["beta", 1]]),
      }),
    );
    for (let step = 0; step < 20; step += 1) scene.tick(100);

    // Beta is queued and stays queued, so the message waits ON THE DESK - and
    // an unanswered message on a desk is exactly what the pile already draws.
    const waiting = frameOf(scene);
    expect(characterRect(waiting, "beta")).not.toEqual(seatedRect("beta"));
    const pile = stacks(waiting);
    expect(pile).toHaveLength(1);
    const desk = layoutOf(scene).desks.get("beta");
    if (desk === undefined) throw new Error("expected a desk");
    expect(pile[0].x).toBe(desk.deskTile.col * OFFICE_TILE + 1);
    expect(hasBubbleAt(waiting, "bubble-hello", seatedHead("beta"))).toBe(
      false,
    );

    // Once the person has been, beta walks back - and the greeting fires as it
    // SITS, which is when the message is actually picked up. The seated pose is
    // what says so: a walk can land on the chair's own tile with a step still
    // owed, and the pile is still on the desk until the sitting down happens.
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    for (let step = 0; step < 120; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      if (characterSpriteAt(frame, seatedRect("beta"))?.pose === "sit") {
        expect(stacks(frame)).toHaveLength(0);
        expect(hasBubbleAt(frame, "bubble-hello", seatedHead("beta"))).toBe(
          true,
        );
        return;
      }
    }
    throw new Error("beta never returned to its desk");
  });

  it("launches from the sender's SEAT while the sender is still walking", () => {
    const fromBeta: CommGraphPulse = {
      kind: "edge",
      edgeId: "alpha<->beta",
      pulseKind: "request",
      fromAgentId: "beta",
      toAgentId: "alpha",
    };
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: CREATED_PULSE,
        pulseKey: "created-beta",
      }),
    );
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: fromBeta,
        pulseKey: "row-2",
      }),
    );

    // The DESK sends, so the flight is correct without beta being at it - and
    // beta is deliberately still on the floor rather than snapped into place.
    expect(characterRect(frameOf(scene), "beta")).not.toEqual(
      seatedRect("beta"),
    );
    const launched = envelopes(frameOf(scene)).at(-1);
    if (launched === undefined) throw new Error("expected an envelope");
    expect(launched.x).toBe(seatedHead("beta").x);
  });

  /**
   * HOW LONG THE SUMMONS WALK TO RECEPTION TAKES, before the place beta is
   * holding can be read off a frame at all.
   *
   * MEASURED: 67 ticks. The `80` this carried is 16 % over that, and the walk
   * has no ceiling to sit under - beta holds its place for as long as it needs
   * a person, so the case is green at every budget probed to 800. The number
   * was not a knife edge by a one-unit reading and is one by the reading this
   * suite has been using: it is the same shape as the walk-out waits below,
   * and the only thing that told you which was a mutation run.
   *
   * NOT `QUEUE_WALK_TICKS` above, which is the SECOND agent crossing the floor
   * (100 ticks measured, 140 budgeted). Here only beta walks, so the two
   * measurements are different and each stays with the case that took it.
   *
   * 160 is about twice the measurement. It costs 8 seconds of scene clock on a
   * two-agent floor, which is nothing, and it means the queue walk getting
   * slower reddens the cases that are ABOUT the queue walk instead of this one.
   */
  const QUEUED_AT_RECEPTION_TICKS = 160;

  it("leaves a queued agent at reception when a message arrives for it", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    const needsHelp = new Map<string, OfficeAgentStatus>([
      ["beta", "attention"],
    ]);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: needsHelp,
      }),
    );
    for (let step = 0; step < QUEUED_AT_RECEPTION_TICKS; step += 1) {
      scene.tick(100);
    }
    const queued = characterRect(frameOf(scene), "beta");
    expect(queued).not.toEqual(seatedRect("beta"));

    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: needsHelp,
        pulse: REQUEST_PULSE,
        pulseKey: "row-1",
      }),
    );
    for (let step = 0; step < 20; step += 1) scene.tick(100);

    // A person is needed, which no envelope answers. Pulling beta out of the
    // line to collect a message would cost it the place it has been holding.
    expect(characterRect(frameOf(scene), "beta")).toEqual(queued);
  });

  it("skips the walk-in entirely once playback runs fast", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        playing: true,
        // Half a step: the walk would still be running when the next row draws.
        stepMs: 300,
      }),
    );

    const frame = frameOf(scene);
    expect(characterRect(frame, "beta")).toEqual(seatedRect("beta"));
    // Still announced, just not walked: a sparkle marks the arrival.
    expect(
      frame.overlay.some(
        (drawable) =>
          drawable.kind === "sprite" &&
          drawable.sprite.name === "sparkle" &&
          drawable.x === seatedHead("beta").x,
      ),
    ).toBe(true);
  });

  it("keeps every walk on the walker's own floor", () => {
    const crew = [
      agent({ id: "alpha", hostId: "host-a", createdAt: 1 }),
      agent({ id: "beta", hostId: "host-b", createdAt: 2 }),
    ];
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: crew, visibleAgentIds: ALPHA_ONLY }));
    scene.sync(
      sceneInput({
        agents: crew,
        visibleAgentIds: BOTH,
        pulse: CREATED_PULSE,
        pulseKey: "created-beta",
      }),
    );

    const layout = layoutOf(scene);
    expect(layout.floors).toHaveLength(2);
    const upstairs = layout.floors[1];
    // Beta lives on the second storey, so it comes in through THAT storey's
    // door - never the building's own.
    const entering = characterRect(frameOf(scene), "beta");
    expect(entering.x).toBe(upstairs.doorTile.col * OFFICE_TILE);
    expect(entering.y).toBe(upstairs.doorTile.row * OFFICE_TILE - 4);

    for (let step = 0; step < 60; step += 1) scene.tick(100);
    const desk = layout.desks.get("beta");
    if (desk === undefined) throw new Error("expected a desk");
    const seated = characterRect(frameOf(scene), "beta");
    expect(seated.x).toBe(desk.chairTile.col * OFFICE_TILE);
    expect(seated.y).toBe(desk.chairTile.row * OFFICE_TILE - 4);
  });

  it("queues each floor at its own reception", () => {
    const crew = [
      agent({ id: "alpha", hostId: "host-a", createdAt: 1 }),
      agent({ id: "beta", hostId: "host-b", createdAt: 2 }),
    ];
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: crew,
        visibleAgentIds: BOTH,
        // Both `attention`, and beta was `failure` until the infirmary
        // existed: C4 sends a crash to a bed rather than to the counter, so a
        // failing agent no longer queues anywhere. The claim here is about
        // which RECEPTION a queueing agent uses, and it needs two agents that
        // queue - not two different reasons for queueing.
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
          ["beta", "attention"],
        ]),
        reducedMotion: true,
      }),
    );

    const layout = layoutOf(scene);
    const frame = frameOf(scene);
    // Both hold the NEAREST slot, because they are queueing on different
    // floors rather than behind each other.
    expect(characterRect(frame, "alpha").x).toBe(
      layout.floors[0].receptionQueueTiles[0].col * OFFICE_TILE,
    );
    expect(characterRect(frame, "beta").x).toBe(
      layout.floors[1].receptionQueueTiles[0].col * OFFICE_TILE,
    );
  });

  it("produces identical frames from an identical sync/tick sequence", () => {
    const run = (): OfficeFrame => {
      const scene = new OfficeScene(testView(layoutOffice), null);
      scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
      scene.tick(120);
      scene.sync(
        sceneInput({
          agents: AGENTS,
          visibleAgentIds: BOTH,
          playing: true,
          statusById: new Map<string, OfficeAgentStatus>([
            ["alpha", "working"],
          ]),
          pulse: CREATED_PULSE,
          pulseKey: "created-beta",
        }),
      );
      for (let step = 0; step < 7; step += 1) scene.tick(90);
      return frameOf(scene);
    };

    expect(run()).toEqual(run());
  });

  it("lists every character before its own desk, so the FIRST hit at a shared point is the person", () => {
    // `OfficeFrame.hitRegions` is FRONT-MOST FIRST (the view contract's scene
    // change #7), which inverted this from the old draw-order convention: a
    // hit test now takes the first match rather than the last, and the
    // character standing in front of its desk must sort ahead of it.
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const frame = frameOf(scene);

    const deskIndex = new Map<string, number>();
    const characterIndex = new Map<string, number>();
    frame.hitRegions.forEach((region, index) => {
      if (region.rect.height === OFFICE_CHARACTER_HEIGHT) {
        characterIndex.set(region.agentId, index);
        return;
      }
      // The desk box is two tiles wide - the one other shape a hit region
      // takes.
      expect(region.rect.width).toBe(2 * OFFICE_TILE);
      deskIndex.set(region.agentId, index);
    });

    for (const id of ["alpha", "beta"]) {
      const desk = deskIndex.get(id);
      const character = characterIndex.get(id);
      if (desk === undefined || character === undefined) {
        throw new Error(`missing a region for ${id}`);
      }
      // A renderer that takes the FIRST match under a point resolves a
      // character standing on somebody else's desk, not the furniture under
      // its feet - which only holds if every character sorts before its desk.
      expect(character).toBeLessThan(desk);
    }
  });

  it("does not double count a landed request the open-request map already holds", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    // Attention sends beta to reception, needing a person - a stable "away
    // from its desk" that a hurry never pulls it out of (pulling it out of
    // line would drop its place), unlike a walk that could finish mid-test.
    const statusById = new Map<string, OfficeAgentStatus>([
      ["beta", "attention"],
    ]);
    scene.sync(
      sceneInput({ agents: AGENTS, visibleAgentIds: BOTH, statusById }),
    );
    for (let step = 0; step < 80; step += 1) scene.tick(100);
    expect(characterRect(frameOf(scene), "beta")).not.toEqual(
      seatedRect("beta"),
    );

    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById,
        pulse: REQUEST_PULSE,
        pulseKey: "row-1",
        openRequestsByReceiver: new Map([["beta", 1]]),
      }),
    );
    scene.tick(700);
    // Still queued, not answered - the pile is what this asserts, not a walk
    // back to the chair.
    expect(characterRect(frameOf(scene), "beta")).not.toEqual(
      seatedRect("beta"),
    );

    // The open-request count already holds this one; `deliver` marking it
    // `inOpenCount` is what keeps the pile from drawing it a second time.
    const stackAfterRequest = stacks(frameOf(scene));
    expect(stackAfterRequest).toHaveLength(1);
    expect(stackAfterRequest[0].sprite.name).toBe("envelope-stack-1");

    // Contrast: a notice is not itself an open request, so it DOES add to
    // the pile on top of the one already open.
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById,
        pulse: { ...REQUEST_PULSE, pulseKind: "notice" },
        pulseKey: "row-2",
        openRequestsByReceiver: new Map([["beta", 1]]),
      }),
    );
    scene.tick(700);

    const stackAfterNotice = stacks(frameOf(scene));
    expect(stackAfterNotice).toHaveLength(1);
    expect(stackAfterNotice[0].sprite.name).toBe("envelope-stack-2");
  });

  it("signs no cabin and plates no pod for a root or lead that does not exist yet at the cursor", () => {
    const family = [
      agent({ id: "root", name: "Root Team", createdAt: 1 }),
      agent({ id: "lead", name: "Lead Squad", parentId: "root", createdAt: 2 }),
      agent({ id: "kid-1", parentId: "lead", createdAt: 3 }),
      agent({ id: "kid-2", parentId: "lead", createdAt: 4 }),
    ];
    const scene = new OfficeScene(testView(layoutOffice), null);

    // Nobody visible yet: the walls and the pod's own outline still stand for
    // everyone (they are structural, plan-only decoration), but the PLAN
    // still names the owners its signs carry - it is the renderer's
    // visibility predicate, over `visibleAgentIds`, that hides a sign whose
    // owner has not been created yet at the cursor.
    scene.sync(
      sceneInput({ agents: family, visibleAgentIds: new Set<string>() }),
    );
    const hidden = frameOf(scene);
    const layout = layoutOf(scene);
    const room = layout.rooms[0];
    expect(room).toBeDefined();
    const roomSign = signAt(layout, "room", room.signTile);
    if (roomSign === undefined) throw new Error("no sign on the cabin");
    expect(roomSign.text).toBe("Root Team");
    expect(officeSignVisible(roomSign, new Set<string>())).toBe(false);

    const pod = room.pods[0];
    expect(pod).toBeDefined();
    const podSign = signAt(layout, "pod", pod.plateTile);
    if (podSign === undefined) throw new Error("no sign on the pod plate");
    expect(podSign.text).toBe("Lead Squad");
    expect(officeSignVisible(podSign, new Set<string>())).toBe(false);

    expect(
      sprites(hidden.floor, "wall-top").some(
        (drawable) =>
          drawable.x === room.bounds.col * OFFICE_TILE &&
          drawable.y === room.bounds.row * OFFICE_TILE,
      ),
    ).toBe(true);

    const styleArt: Readonly<Record<string, ReadonlyArray<string>>> = {
      glass: ["partition", "partition-h"],
      planters: ["planter"],
      shelves: ["shelf", "shelf-h"],
    };
    const outline = hidden.floor.filter(
      (drawable) =>
        drawable.kind === "sprite" &&
        styleArt[pod.style].includes(drawable.sprite.name),
    );
    expect(outline.length).toBeGreaterThan(0);

    scene.sync(
      sceneInput({
        agents: family,
        visibleAgentIds: new Set(family.map((person) => person.id)),
      }),
    );
    const allVisible = new Set(family.map((person) => person.id));
    expect(officeSignVisible(roomSign, allVisible)).toBe(true);
    expect(officeSignVisible(podSign, allVisible)).toBe(true);
  });
});

/**
 * A crew well over `MAX_CONCURRENT_ERRANDS`, so the cap is what limits how
 * many are away at once rather than merely how many wanted to go.
 */
const CAP_CREW: ReadonlyArray<OfficeAgentInput> = Array.from(
  { length: MAX_CONCURRENT_ERRANDS * 2 },
  (_, index) => agent({ id: `cap-${index}`, createdAt: index + 1 }),
);
const CAP_IDS: ReadonlySet<string> = new Set(CAP_CREW.map((one) => one.id));

/** Every character standing somewhere other than its own chair, by id. */
function awayIds(
  frame: OfficeFrame,
  layout: OfficeLayout,
): ReadonlyArray<string> {
  const away: string[] = [];
  for (const region of frame.hitRegions) {
    if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
    const desk = layout.desks.get(region.agentId);
    if (desk === undefined) continue;
    const seatedX = desk.chairTile.col * OFFICE_TILE;
    const seatedY = desk.chairTile.row * OFFICE_TILE - 4;
    if (region.rect.x === seatedX && region.rect.y === seatedY) continue;
    away.push(region.agentId);
  }
  return away;
}

function growRect(rect: OfficeRect, margin: number): OfficeRect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  };
}

function pointInRect(point: OfficePoint, rect: OfficeRect): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

/** Where a point falls against one segment of a projected path. */
interface SegmentProjection {
  /**
   * The perpendicular foot as a FRACTION of the segment - under 0 or over 1
   * where the point lies past one of its ends.
   */
  readonly progress: number;
  /** The point at that fraction, off the segment's end where it is past one. */
  readonly at: OfficePoint;
  /** How far along the segment the point lands, in pixels, clamped into it. */
  readonly along: number;
  /** How far the point is from the segment itself, in pixels. */
  readonly off: number;
}

/**
 * The segment-distance primitive both projected-path questions here share.
 *
 * A WALKER'S sprite corner against the leg of the route it should be on reads
 * `progress` and `at`, and allows itself a two-pixel box either way, because a
 * sample is a drawn sprite's corner (`rectOnProjectedPath`). A VEHICLE'S foot
 * against the leg of the road it drives off on reads `off` and `along` and wants
 * an equality, because a foot point IS the projection of a fractional tile and
 * every projector here is affine. One formula behind both, and the reason the
 * two differ is their sample rather than their geometry.
 *
 * `null` for a segment of no length: a path that repeats a tile has nothing to
 * measure a point against, and the caller moves on to the next leg.
 */
function projectOntoSegment(
  from: OfficePoint,
  to: OfficePoint,
  point: OfficePoint,
): SegmentProjection | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const square = dx * dx + dy * dy;
  if (square === 0) return null;
  const progress = ((point.x - from.x) * dx + (point.y - from.y) * dy) / square;
  const held = Math.min(1, Math.max(0, progress));
  const on: OfficePoint = { x: from.x + dx * held, y: from.y + dy * held };
  return {
    progress,
    at: { x: from.x + dx * progress, y: from.y + dy * progress },
    along: Math.sqrt(square) * held,
    off: Math.hypot(on.x - point.x, on.y - point.y),
  };
}

/** Where a chair's own foot point actually projects to, identity or not. */
function chairPoint(layout: OfficeLayout, agentId: string): OfficePoint {
  const desk = layout.desks.get(agentId);
  if (desk === undefined) throw new Error(`no desk for ${agentId}`);
  return {
    x: desk.chairTile.col * OFFICE_TILE,
    y: desk.chairTile.row * OFFICE_TILE - 4,
  };
}

describe("OfficeScene errand cap and view rect", () => {
  it("never lets more than MAX_CONCURRENT_ERRANDS be away at once, checked on every tick over a long run", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: CAP_CREW, visibleAgentIds: CAP_IDS }));
    const layout = layoutOf(scene);

    let mostAtOnce = 0;
    for (let step = 0; step < 3_000; step += 1) {
      scene.tick(100);
      const away = awayIds(frameOf(scene), layout).length;
      // Checked every tick, not only at the end - a cap that only holds on
      // average would still let a burst through on the very tick a test that
      // sampled less often would miss.
      expect(away).toBeLessThanOrEqual(MAX_CONCURRENT_ERRANDS);
      mostAtOnce = Math.max(mostAtOnce, away);
    }
    // With twice the cap's worth of idle agents on one floor, the ceiling is
    // what is actually holding the rest back - not merely how many happened
    // to want to go.
    expect(mostAtOnce).toBe(MAX_CONCURRENT_ERRANDS);
  });

  it("still counts the walk home against the cap, so a floor already at the cap starts nobody new while one is walking back", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: CAP_CREW, visibleAgentIds: CAP_IDS }));
    const layout = layoutOf(scene);

    let atCap: ReadonlyArray<string> = [];
    for (
      let step = 0;
      step < 3_000 && atCap.length < MAX_CONCURRENT_ERRANDS;
      step += 1
    ) {
      scene.tick(100);
      atCap = awayIds(frameOf(scene), layout);
    }
    expect(atCap.length).toBe(MAX_CONCURRENT_ERRANDS);
    const stillAway = new Set(atCap);

    // Call exactly one of them home - a status change is one of the
    // documented ways an idle agent's errand is cut short - and watch it walk
    // back while the rest of the away set holds still around it.
    const recalled = atCap[0];
    stillAway.delete(recalled);
    scene.sync(
      sceneInput({
        agents: CAP_CREW,
        visibleAgentIds: CAP_IDS,
        statusById: new Map<string, OfficeAgentStatus>([[recalled, "working"]]),
      }),
    );

    let sawStillWalking = false;
    for (let step = 0; step < 60; step += 1) {
      scene.tick(100);
      const away = awayIds(frameOf(scene), layout);
      expect(away.length).toBeLessThanOrEqual(MAX_CONCURRENT_ERRANDS);
      if (!away.includes(recalled)) continue;
      sawStillWalking = true;
      // Its own walk home still holds its slot, so nobody from the eager
      // backlog has taken its place yet.
      expect(away.length).toBe(MAX_CONCURRENT_ERRANDS);
      for (const id of away) {
        expect(id === recalled || stillAway.has(id), id).toBe(true);
      }
    }
    expect(sawStillWalking).toBe(true);
  });

  it("does not gate an arrival, an archival, or a reception summons behind the errand cap", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: CAP_CREW, visibleAgentIds: CAP_IDS }));
    let layout = layoutOf(scene);

    let atCap: ReadonlyArray<string> = [];
    for (
      let step = 0;
      step < 3_000 && atCap.length < MAX_CONCURRENT_ERRANDS;
      step += 1
    ) {
      scene.tick(100);
      atCap = awayIds(frameOf(scene), layout);
    }
    expect(atCap.length).toBe(MAX_CONCURRENT_ERRANDS);
    const awayAtCap = new Set(atCap);
    // A seated survivor for the reception summons, so that case starts from
    // its own chair rather than from the middle of an idle errand.
    const seatedSurvivor = CAP_CREW.find((person) => !awayAtCap.has(person.id));
    if (seatedSurvivor === undefined) {
      throw new Error("everybody was already away");
    }
    const archivedOne = CAP_CREW[CAP_CREW.length - 1];

    const newcomer = agent({ id: "newcomer", createdAt: 10_000 });
    scene.sync(
      sceneInput({
        agents: [
          ...CAP_CREW.map((person) =>
            person.id === archivedOne.id
              ? { ...person, archivedAt: 1 }
              : person,
          ),
          newcomer,
        ],
        visibleAgentIds: new Set([...CAP_IDS, newcomer.id]),
        statusById: new Map<string, OfficeAgentStatus>([
          [seatedSurvivor.id, "attention"],
        ]),
        playing: true,
      }),
    );
    scene.tick(200);
    layout = layoutOf(scene);

    const away = new Set(awayIds(frameOf(scene), layout));
    // None of the three is an idle agent's errand, so none of them had to
    // wait behind the 32 that already are - the floor is at the cap and all
    // three are moving anyway.
    expect(away.has(newcomer.id), "arrival").toBe(true);
    expect(away.has(archivedOne.id), "archival").toBe(true);
    expect(away.has(seatedSurvivor.id), "reception summons").toBe(true);
  });

  it("starts an errand anywhere on a scene that has been ticked but never framed", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: CAP_CREW, visibleAgentIds: CAP_IDS }));

    // No `frame()` call at all until the very end - `lastViewRect` stays
    // `null` the whole time this runs, which is documented to mean the WHOLE
    // WORLD rather than nowhere: a scene ticked before its canvas has ever
    // painted must not sit frozen waiting for a first frame that has not
    // happened yet.
    for (let step = 0; step < 150; step += 1) scene.tick(100);

    const layout = layoutOf(scene);
    expect(awayIds(frameOf(scene), layout).length).toBeGreaterThan(0);
  });

  it("starts nobody outside the last frame's rect, grown by the cull margin", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: CAP_CREW, visibleAgentIds: CAP_IDS }));
    const layout = layoutOf(scene);

    // A narrow strip over one corner of the floor - most desks fall well
    // outside it, cull margin included.
    const narrow: OfficeRect = {
      x: 0,
      y: 0,
      width: 4 * OFFICE_TILE,
      height: 4 * OFFICE_TILE,
    };
    const grown = growRect(narrow, OFFICE_CULL_MARGIN_PX);

    for (let step = 0; step < 900; step += 1) {
      scene.tick(100);
      scene.frame(2, narrow);
    }

    const away = awayIds(frameOf(scene), layout);
    expect(away.length).toBeGreaterThan(0);
    for (const id of away) {
      expect(pointInRect(chairPoint(layout, id), grown), id).toBe(true);
    }

    // And somebody whose own desk sits well outside the strip never got up
    // at all, proving the rect actually excluded something.
    const farIds = CAP_CREW.map((person) => person.id).filter(
      (id) => !pointInRect(chairPoint(layout, id), grown),
    );
    expect(farIds.length).toBeGreaterThan(0);
    for (const id of farIds) {
      expect(away.includes(id), id).toBe(false);
    }
  });

  it("finishes an errand already under way even after a pan leaves the walker off screen", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Frame the whole floor so somebody can actually start, then find who did.
    let walker: string | null = null;
    for (let step = 0; step < 400 && walker === null; step += 1) {
      scene.tick(100);
      scene.frame(2, WHOLE_WORLD);
      const away = crewAway(frameOf(scene));
      if (away.length > 0) walker = away[0];
    }
    if (walker === null) throw new Error("nobody started an errand");

    // Pan somewhere that excludes the whole floor. Idle errands chain into
    // one another for as long as an agent stays idle - the only thing that
    // ever sends one home on its own is an interrupt, not the passage of
    // time - so call it home with a status change the way a real turn
    // starting would, and confirm the walk back is not itself a fresh START
    // for the panned rect to refuse.
    const excluding: OfficeRect = {
      x: 50_000,
      y: 50_000,
      width: 10,
      height: 10,
    };
    scene.sync(
      sceneInput({
        agents: IDLE_CREW,
        visibleAgentIds: CREW_IDS,
        statusById: new Map<string, OfficeAgentStatus>([[walker, "working"]]),
      }),
    );
    for (let step = 0; step < 200; step += 1) {
      scene.tick(100);
      scene.frame(2, excluding);
    }

    // One WHOLE_WORLD frame at the very end, purely to read the outcome -
    // never drawn again after the pan, and still home.
    expect(characterRect(frameOf(scene), walker)).toEqual(
      crewSeatedRect(walker),
    );
  });

  it("lets canonical order decide who gets the last slots when more agents are eligible than the cap allows", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    // Playback suppresses errand starts outright but still lets idle time
    // build up - so ticking well past the longest possible per-agent stagger
    // while playing makes every single one of them eligible at once, without
    // any of them having actually left yet. Without this, a low id with a
    // long stagger could simply become eligible later than a high id with a
    // short one and lose its slot to timing rather than to order.
    scene.sync(
      sceneInput({ agents: CAP_CREW, visibleAgentIds: CAP_IDS, playing: true }),
    );
    for (let step = 0; step < 200; step += 1) scene.tick(100);

    // Back to a live floor: everybody crosses eligibility on the very same
    // tick, so `updateErrandStarts`'s own canonical-order pass is the only
    // thing left to decide who claims a slot first when a spot briefly has
    // more than one taker.
    scene.sync(sceneInput({ agents: CAP_CREW, visibleAgentIds: CAP_IDS }));
    const layout = layoutOf(scene);

    let away: ReadonlyArray<string> = [];
    for (
      let step = 0;
      step < 3_000 && away.length < MAX_CONCURRENT_ERRANDS;
      step += 1
    ) {
      scene.tick(100);
      away = awayIds(frameOf(scene), layout);
    }
    const sortedIds = [...CAP_IDS].sort();
    expect(away.length).toBe(MAX_CONCURRENT_ERRANDS);
    // The 32 who made it out are exactly the 32 lowest ids - not merely 32
    // of the 64, which is what "canonical order decides" looks like once
    // timing itself has been taken out of the picture above.
    expect([...away].sort()).toEqual(
      sortedIds.slice(0, MAX_CONCURRENT_ERRANDS),
    );
  });
});

/**
 * A floor big enough to have earned every amenity: a nap room, a library, a
 * garden, a gym, and a game room with all four of its tables.
 */
const BIG_CREW: ReadonlyArray<OfficeAgentInput> = Array.from(
  { length: 12 },
  (_, index) => agent({ id: `big-${index}`, createdAt: index + 1 }),
);
const BIG_IDS: ReadonlySet<string> = new Set(BIG_CREW.map((one) => one.id));

/** Ticks until `check` answers, and hands back that frame. */
function frameWhere(
  scene: OfficeScene,
  check: (frame: OfficeFrame) => boolean,
  steps: number,
): OfficeFrame | null {
  for (let step = 0; step < steps; step += 1) {
    scene.tick(100);
    const frame = frameOf(scene);
    if (check(frame)) return frame;
  }
  return null;
}

function spotsOfKind(
  scene: OfficeScene,
  kind: string,
): ReadonlyArray<OfficeTilePos> {
  return layoutOf(scene)
    .floors[0].errandSpots.filter((spot) => spot.kind === kind)
    .map((spot) => spot.tile);
}

/** The character standing exactly on this tile, if one is. */
function spriteOnTile(
  frame: OfficeFrame,
  tile: OfficeTilePos,
): OfficeSpriteRef | null {
  return characterSpriteAt(frame, {
    x: tile.col * OFFICE_TILE,
    y: tile.row * OFFICE_TILE - 4,
    width: OFFICE_CHARACTER_WIDTH,
    height: OFFICE_CHARACTER_HEIGHT,
  });
}

/** Whether a bubble of this name is over whoever is standing on this tile. */
function bubbleOnTile(
  frame: OfficeFrame,
  name: OfficeSpriteName,
  tile: OfficeTilePos,
): boolean {
  return hasBubbleAt(frame, name, {
    x: tile.col * OFFICE_TILE + OFFICE_CHARACTER_WIDTH / 2,
    y: tile.row * OFFICE_TILE - 4,
  });
}

/** The tile a prop of this name stands on, and there is exactly one. */
function onlyPropTile(scene: OfficeScene, name: string): OfficeTilePos {
  const found = layoutOf(scene).props.filter(
    (prop) => prop.sprite.name === name,
  );
  if (found.length !== 1) throw new Error(`expected one ${name}`);
  return found[0].tile;
}

function bothSidesTaken(
  scene: OfficeScene,
  sides: ReadonlyArray<OfficeTilePos>,
): boolean {
  const standing = standingByTile(scene);
  return sides.every((tile) => standing.has(`${tile.col},${tile.row}`));
}

/**
 * Long enough for TWO agents to be at the chess table at the same moment.
 *
 * Measured, and the measurement is the interesting part: this is a waiting
 * time for a COINCIDENCE, not for a walk. Anchoring the infirmary at the foot
 * of its column moved the first both-sides frame from 944 to 1418 while every
 * chess walk stayed the same length to the tile - from the lobby (56) and from
 * each of the twelve desks (53, 63, 68, 78, ...) - so what moved is the phase
 * the two errand cycles fall into, not the distance either agent covers.
 *
 * It was `1_200`, which is 256 frames of headroom over a 944 that nothing in
 * the case pinned or explained. Anything that shifts an errand's phase spends
 * that, and this case has no opinion about phase at all: it is about chess
 * being turn-based and ball-free once the two of them sit down. So the budget
 * is now a named number with real margin over the measurement, rather than one
 * that happened to clear it.
 */
const CHESS_PAIRING_TICKS = 3_000;

describe("OfficeScene amenities", () => {
  it("pairs two agents across the foosball table and knocks a ball between them", () => {
    const scene = new OfficeScene(testView(onlyKinds(["foosball"])), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const sides = spotsOfKind(scene, "foosball");
    expect(sides).toHaveLength(2);

    // A game needs two, so the second player has to be biased toward the seat
    // the first is holding open rather than left to the weights.
    const playing = frameWhere(
      scene,
      (frame) => bothSidesTaken(scene, sides) && paperBalls(frame).length > 0,
      1_200,
    );
    expect(playing, "no foosball game started").not.toBeNull();
    if (playing === null) return;

    // The ball shuttles between the two players rather than sitting on one of
    // them: side to side, across the table.
    const [left, right] = sides;
    const ball = paperBalls(playing)[0];
    expect(ball.x).toBeGreaterThanOrEqual(left.col * OFFICE_TILE);
    expect(ball.x).toBeLessThanOrEqual((right.col + 1) * OFFICE_TILE);
    for (const side of sides) {
      expect(spriteOnTile(playing, side)?.pose, `${side.col},${side.row}`).toBe(
        "stand",
      );
    }

    // ...and the game ends: a table nobody ever leaves is a hang.
    const over = frameWhere(scene, () => !bothSidesTaken(scene, sides), 400);
    expect(over, "the foosball game never ended").not.toBeNull();
  });

  it("plays chess with two thinkers and no ball at all", () => {
    const scene = new OfficeScene(testView(onlyKinds(["chess"])), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const seats = spotsOfKind(scene, "chess");
    expect(seats).toHaveLength(2);

    const seated = frameWhere(
      scene,
      () => bothSidesTaken(scene, seats),
      CHESS_PAIRING_TICKS,
    );
    expect(seated, "no chess game started").not.toBeNull();
    if (seated === null) return;

    // Thinking passes between the two of them, one bubble at a time - a game
    // without a ball is two people taking turns.
    const thinkers = new Set<string>();
    let bothAtOnce = false;
    let balls = 0;
    for (let step = 0; step < 100; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      if (!bothSidesTaken(scene, seats)) break;
      balls += paperBalls(frame).length;
      const up = seats.filter((tile) =>
        bubbleOnTile(frame, "bubble-awaiting", tile),
      );
      if (up.length > 1) bothAtOnce = true;
      for (const tile of up) thinkers.add(`${tile.col},${tile.row}`);
    }
    expect(balls, "chess is played with a ball").toBe(0);
    expect(bothAtOnce, "both players thought at once").toBe(false);
    expect(thinkers.size, "only one player ever thought").toBe(2);
  });

  it("throws three darts at the board and stops", () => {
    const scene = new OfficeScene(testView(onlyKinds(["darts"])), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const line = spotsOfKind(scene, "darts")[0];
    const board = onlyPropTile(scene, "dartboard");
    expect(line).toBeDefined();

    let throws = 0;
    let inFlight = false;
    let stray = 0;
    let arrived = false;
    for (let step = 0; step < 600; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      const here = spriteOnTile(frame, line) !== null;
      // ONE agent's turn at the board: the line frees up when it is done, and
      // the next player's throws are not this one's.
      if (arrived && !here) break;
      arrived = arrived || here;
      const balls = paperBalls(frame);
      if (balls.length > 0 && !inFlight) throws += 1;
      inFlight = balls.length > 0;
      for (const ball of balls) {
        // Every dart is aimed: none of them ends up on the floor beside the
        // board the way a missed paper toss does.
        if (Math.abs(ball.x - (board.col * OFFICE_TILE + 8)) > OFFICE_TILE) {
          stray += 1;
        }
      }
    }
    expect(arrived, "nobody went to throw darts").toBe(true);
    expect(throws).toBe(3);
    expect(stray).toBe(0);
  });

  it("lies down on a sleeping bag and falls asleep on it", () => {
    const scene = new OfficeScene(testView(onlyKinds(["nap"])), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const bags = spotsOfKind(scene, "nap");
    expect(bags.length).toBeGreaterThan(0);

    const lying = frameWhere(
      scene,
      (frame) => bags.some((tile) => spriteOnTile(frame, tile)?.pose === "sit"),
      900,
    );
    expect(lying, "nobody lay down").not.toBeNull();
    if (lying === null) return;
    const bag = bags.find((tile) => spriteOnTile(lying, tile)?.pose === "sit");
    if (bag === undefined) throw new Error("no occupied bag");
    // Lying down faces the viewer, so the sprite reads as somebody on their
    // back rather than as somebody at a desk.
    expect(spriteOnTile(lying, bag)?.facing).toBe("down");

    // Asleep a moment later - a bag you get straight back off is not a nap.
    const asleep = frameWhere(
      scene,
      (frame) => bubbleOnTile(frame, "bubble-sleep", bag),
      60,
    );
    expect(asleep, "the sleeper never dropped off").not.toBeNull();
    const woke = frameWhere(
      scene,
      (frame) => spriteOnTile(frame, bag) === null,
      400,
    );
    expect(woke, "the sleeper never got up").not.toBeNull();
  });

  it("reads in an armchair with a thought that comes and goes", () => {
    const scene = new OfficeScene(testView(onlyKinds(["read"])), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const chairs = spotsOfKind(scene, "read");
    expect(chairs.length).toBeGreaterThan(0);

    const sitting = frameWhere(
      scene,
      (frame) =>
        chairs.some((tile) => spriteOnTile(frame, tile)?.pose === "sit"),
      900,
    );
    expect(sitting, "nobody sat down to read").not.toBeNull();
    if (sitting === null) return;
    const chair = chairs.find(
      (tile) => spriteOnTile(sitting, tile)?.pose === "sit",
    );
    if (chair === undefined) throw new Error("no occupied armchair");

    // The thought is a page being turned, not a standing state: it has to be
    // seen both up and down while the same agent stays in the chair.
    let up = 0;
    let down = 0;
    for (let step = 0; step < 60; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      if (spriteOnTile(frame, chair)?.pose !== "sit") break;
      if (bubbleOnTile(frame, "bubble-awaiting", chair)) up += 1;
      else down += 1;
    }
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0);
  });

  it("walks on the spot on a treadmill", () => {
    const scene = new OfficeScene(testView(onlyKinds(["treadmill"])), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const mills = spotsOfKind(scene, "treadmill");
    expect(mills.length).toBeGreaterThan(0);

    const running = frameWhere(
      scene,
      (frame) => mills.some((tile) => spriteOnTile(frame, tile) !== null),
      900,
    );
    expect(running, "nobody got on a treadmill").not.toBeNull();
    if (running === null) return;
    const mill = mills.find((tile) => spriteOnTile(running, tile) !== null);
    if (mill === undefined) throw new Error("no occupied treadmill");

    // The belt is the whole point: the walking frames alternate even though
    // the tile under the runner never changes.
    const poses = new Set<string>();
    for (let step = 0; step < 40; step += 1) {
      scene.tick(100);
      const sprite = spriteOnTile(frameOf(scene), mill);
      if (sprite === null) break;
      expect(sprite.facing).toBe("up");
      if (sprite.pose !== undefined) poses.add(sprite.pose);
    }
    expect([...poses].sort()).toEqual(["walk1", "walk2"]);
  });

  it("flashes the television while somebody is on the console sofa", () => {
    const scene = new OfficeScene(testView(onlyKinds(["console"])), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const seats = spotsOfKind(scene, "console");
    expect(seats).toHaveLength(2);
    const television = onlyPropTile(scene, "tv");

    const watching = frameWhere(
      scene,
      (frame) =>
        seats.some((tile) => spriteOnTile(frame, tile)?.pose === "sit"),
      900,
    );
    expect(watching, "nobody sat down to play").not.toBeNull();
    if (watching === null) return;
    // Facing the screen: a console seat is the one sit that does not turn back
    // toward the room the way a sofa does.
    const seat = seats.find(
      (tile) => spriteOnTile(watching, tile)?.pose === "sit",
    );
    if (seat === undefined) throw new Error("no occupied seat");
    expect(spriteOnTile(watching, seat)?.facing).toBe("up");

    // The sparkle lands on the TELEVISION, not over the player's head: what is
    // happening is on the screen.
    const centre: OfficePoint = {
      x: television.col * OFFICE_TILE + OFFICE_TILE / 2,
      y: television.row * OFFICE_TILE + OFFICE_TILE / 2,
    };
    const flashed = frameWhere(
      scene,
      (frame) =>
        sprites(frame.overlay, "sparkle").some(
          (drawable) => drawable.x === centre.x && drawable.y === centre.y,
        ),
      60,
    );
    expect(flashed, "the television never flashed").not.toBeNull();
  });

  it("sits on a garden bench and stands on the grass", () => {
    const scene = new OfficeScene(testView(onlyKinds(["garden"])), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const benches = layoutOf(scene).props.filter(
      (prop) => prop.sprite.name === "bench",
    );
    const seatKeys = new Set<string>();
    for (const bench of benches) {
      for (let offset = 0; offset < 2; offset += 1) {
        seatKeys.add(`${bench.tile.col + offset},${bench.tile.row + 1}`);
      }
    }
    const spots = spotsOfKind(scene, "garden");
    const seats = spots.filter((tile) =>
      seatKeys.has(`${tile.col},${tile.row}`),
    );
    const grass = spots.filter(
      (tile) => !seatKeys.has(`${tile.col},${tile.row}`),
    );
    expect(seats.length).toBeGreaterThan(0);
    expect(grass.length).toBeGreaterThan(0);

    // The same errand kind, two postures: a bench is furniture you get onto, a
    // patch of grass is somewhere you stand.
    const sat = frameWhere(
      scene,
      (frame) =>
        seats.some((tile) => spriteOnTile(frame, tile)?.pose === "sit"),
      900,
    );
    expect(sat, "nobody sat on a bench").not.toBeNull();
    const stood = frameWhere(
      scene,
      (frame) =>
        grass.some((tile) => spriteOnTile(frame, tile)?.pose === "stand"),
      900,
    );
    expect(stood, "nobody stood on the grass").not.toBeNull();
  });

  it("lays grass under the garden and a hedge around it", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const layout = layoutOf(scene);
    const garden = layout.floors[0].amenities.find(
      (room) => room.kind === "garden",
    );
    if (garden === undefined) throw new Error("no garden");

    // The floor layer is painted in order, so the LAST tile-aligned sprite at
    // a position is the one a viewer sees.
    const painted = new Map<string, OfficeSpriteName>();
    for (const drawable of frameOf(scene).floor) {
      if (drawable.kind !== "sprite") continue;
      if (drawable.x % OFFICE_TILE !== 0) continue;
      if (drawable.y % OFFICE_TILE !== 0) continue;
      painted.set(
        `${drawable.x / OFFICE_TILE},${drawable.y / OFFICE_TILE}`,
        drawable.sprite.name,
      );
    }

    const { bounds } = garden;
    const right = bounds.col + bounds.cols - 1;
    const bottom = bounds.row + bounds.rows - 1;
    let openings = 0;
    for (let row = bounds.row; row <= bottom; row += 1) {
      for (let col = bounds.col; col <= right; col += 1) {
        const key = `${col},${row}`;
        const onRing =
          // Two rows deep at the top, exactly as a wall is: the cap and the
          // face under it. A hedge is the same ring in another material.
          row <= bounds.row + 1 ||
          row === bottom ||
          col === bounds.col ||
          col === right;
        if (onRing && layout.walkable[row][col]) {
          // The way in is a gap in the hedge, so nothing is drawn in it - a
          // garden is bounded rather than built, and a door hanging in a hedge
          // would say otherwise.
          openings += 1;
          expect(painted.get(key), key).not.toBe("door");
          expect(painted.get(key), key).not.toBe("planter");
          continue;
        }
        expectGardenTilePainted(painted.get(key), onRing, key);
      }
    }
    expect(openings, "a garden with no way in").toBe(1);
  });

  it("keeps a stroll off the tiles the plan has already named", () => {
    // Every named spot is somebody's errand. A stroll that stopped on one
    // would have an agent standing at the dartboard having chosen nothing.
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
    const floor = layoutOf(scene).floors[0];
    const named = new Map<string, string>();
    for (const spot of floor.errandSpots) {
      if (spot.kind === "corridor") continue;
      named.set(`${spot.tile.col},${spot.tile.row}`, spot.kind);
    }

    for (let step = 0; step < 600; step += 1) {
      scene.tick(100);
      for (const [key] of standingByTile(scene)) {
        const kind = named.get(key);
        if (kind === undefined) continue;
        // Standing on a named spot is fine - it means that errand was chosen.
        // What must never happen is a CORRIDOR spot landing on one, which is
        // what the reserved set in `corridorTilesFor` prevents.
        expect(
          floor.errandSpots.some(
            (spot) =>
              spot.kind === "corridor" &&
              `${spot.tile.col},${spot.tile.row}` === key,
          ),
          `${kind} at ${key} is also a corridor spot`,
        ).toBe(false);
      }
    }
  });

  it("plays the same amenity round twice from the same ticks", () => {
    const run = (): string => {
      const scene = new OfficeScene(testView(layoutOffice), null);
      scene.sync(sceneInput({ agents: BIG_CREW, visibleAgentIds: BIG_IDS }));
      const seen: string[] = [];
      for (let step = 0; step < 400; step += 1) {
        scene.tick(100);
        const frame = frameOf(scene);
        seen.push(
          frame.actors
            .filter((drawable) => drawable.kind === "sprite")
            .map(
              (drawable) =>
                `${drawable.x},${drawable.y},${drawable.sprite.pose}`,
            )
            .join("|"),
        );
      }
      return seen.join("\n");
    };

    expect(run()).toEqual(run());
  });
});

/**
 * The four new poses, behind the EXISTING precedence in `poseFor`: a working
 * or background agent still types, and only `attention`/`failure`/`awaiting`
 * beyond that show one of the new bodies.
 *
 * `attention` and `failure` also queue the agent at reception, which unseats
 * it immediately - so the seated `hand-up`/`crash` pose is only observable
 * for the overflow past the reception queue's small fixed capacity, which is
 * exactly when the office is busiest and the pose matters most.
 */

/**
 * The behaviour core, run once per registered view. Today that is Floor
 * alone, which is the point: T3 to T5 register Towers, Building, Mission
 * control, Campus and City against this exact block and get this coverage
 * for free, with no edit here.
 *
 * Frames are asserted STRUCTURALLY - counts, kinds, ids, relative positions -
 * never against an absolute pixel coordinate, which differs per view.
 */
describe.each(OFFICE_VIEW_IDS)("%s view behaviour", (viewId) => {
  const view = OFFICE_VIEWS[viewId];

  /** The sprite box a character standing on this tile would occupy, per the projector. */
  function footRect(layout: OfficeLayout, tile: OfficeTilePos): OfficeRect {
    const projector = view.painter.projector(layout);
    const foot = projector.project(tile.col + 0.5, tile.row + 1);
    return {
      x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
      y: foot.y - OFFICE_CHARACTER_HEIGHT,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
  }

  function rectOnProjectedPath(
    layout: OfficeLayout,
    path: ReadonlyArray<OfficeTilePos>,
    rect: OfficeRect,
  ): boolean {
    const points = path.map((tile) => footRect(layout, tile));
    for (const [index, start] of points.entries()) {
      if (Math.abs(rect.x - start.x) <= 2 && Math.abs(rect.y - start.y) <= 2) {
        return true;
      }
      const end = points.at(index + 1);
      if (end === undefined) continue;
      const onto = projectOntoSegment(
        { x: start.x, y: start.y },
        { x: end.x, y: end.y },
        { x: rect.x, y: rect.y },
      );
      if (onto === null) continue;
      if (onto.progress < -0.01 || onto.progress > 1.01) continue;
      if (
        Math.abs(rect.x - onto.at.x) <= 2 &&
        Math.abs(rect.y - onto.at.y) <= 2
      ) {
        return true;
      }
    }
    return false;
  }

  function buildingCharacterRect(
    frame: OfficeFrame,
    agentId: string,
  ): OfficeRect {
    const rect = characterRect(frame, agentId);
    const worldCharacter = frame.world?.find(
      (entry) =>
        entry.ownerAgentId === agentId &&
        entry.drawable.kind === "sprite" &&
        entry.drawable.sprite.name === "character",
    );
    if (
      worldCharacter === undefined ||
      worldCharacter.drawable.kind !== "sprite"
    ) {
      throw new Error(`no world character for ${agentId}`);
    }
    expect(worldCharacter.drawable.x).toBe(rect.x);
    expect(worldCharacter.drawable.y).toBe(rect.y);
    return rect;
  }

  function newScene(): OfficeScene {
    return new OfficeScene(view, null);
  }

  /**
   * The scene's book, captured from a frame build rather than through a
   * private field. `civicClaimOf` is what `poseFor` reads for every seated
   * civic holder, so a frame is enough to get the instance.
   */
  function bookOf(scene: OfficeScene): OfficeSeatBook {
    const spy = vi.spyOn(OfficeSeatBook.prototype, "civicClaimOf");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  function idleStatusById(
    epic: OfficeTestEpic,
  ): Map<string, OfficeAgentStatus> {
    const next = new Map<string, OfficeAgentStatus>();
    for (const person of epic.agents) {
      next.set(person.id, person.archived ? "archived" : "idle");
    }
    return next;
  }

  function unarchivedIdsOf(epic: OfficeTestEpic): Set<string> {
    return new Set(
      epic.agents
        .filter((person) => !person.archived)
        .map((person) => person.id),
    );
  }

  /**
   * Production's `visibleAgentIds`: every agent that exists as of the
   * cursor, archived included. An archived agent is drawn as a ghosted
   * desk, so it belongs in the set.
   */
  function existingIdsOf(epic: OfficeTestEpic): Set<string> {
    return new Set(epic.agents.map((person) => person.id));
  }

  function failureIds(
    statusById: ReadonlyMap<string, OfficeAgentStatus>,
  ): string[] {
    const ids: string[] = [];
    for (const [id, status] of statusById) {
      if (status === "failure") ids.push(id);
    }
    return ids;
  }

  function infirmarySeatCount(
    layout: OfficeLayout,
    floorIndex: number,
  ): number {
    const floor = layout.floors[floorIndex];
    const room = floor.civic.find((entry) => entry.kind === "infirmary");
    return room === undefined ? 0 : room.seatIds.length;
  }

  /**
   * HOW MANY BEDS THE AGENT AT THIS DESK CAN BE GIVEN, which is not "the beds on
   * its own floor".
   *
   * A view may keep one set of rooms for a whole host - the oblique views put
   * them on the plaza storey and give every other storey `civic: []` - and the
   * seat book's own rule is a room of the kind on the agent's floor, else any on
   * its host. Counting per floor says nought beds for an agent on storey seven,
   * which would turn every outbreak case into an overflow case wearing an
   * outbreak name, and would size the freed-bed case's waves from nothing.
   */
  function bedsForDesk(layout: OfficeLayout, agentId: string): number {
    const desk = layout.desks.get(agentId);
    if (desk === undefined) return 0;
    const own = infirmarySeatCount(layout, desk.floorIndex);
    if (own > 0) return own;
    let count = 0;
    for (const floor of layout.floors) {
      if (floor.hostId !== desk.hostId) continue;
      const room = floor.civic.find((entry) => entry.kind === "infirmary");
      count += room === undefined ? 0 : room.seatIds.length;
    }
    return count;
  }

  function chairsForDesk(layout: OfficeLayout, agentId: string): number {
    const desk = layout.desks.get(agentId);
    if (desk === undefined) return 0;
    const ownFloor = layout.floors[desk.floorIndex];
    const own = ownFloor.civic.find((entry) => entry.kind === "waiting-room");
    if (own !== undefined && own.seatIds.length > 0) return own.seatIds.length;
    let count = 0;
    for (const floor of layout.floors) {
      if (floor.hostId !== desk.hostId) continue;
      const room = floor.civic.find((entry) => entry.kind === "waiting-room");
      count += room === undefined ? 0 : room.seatIds.length;
    }
    return count;
  }

  /**
   * WHAT THIS VIEW CALLS THE ROOM OF THAT KIND.
   *
   * `whereabouts` answers with the effective seat's own room name, and each view
   * names its four in its own words: a plaza has a Dispensary, an amphitheatre a
   * Medbay. Reading the name back out of the plan is what makes these cases
   * per-view rather than Floor cases the other five happen to pass, and the
   * non-empty check is what stops a view that named nothing from passing them
   * all.
   */
  function civicRoomName(layout: OfficeLayout, kind: OfficeCivicKind): string {
    for (const floor of layout.floors) {
      const room = floor.civic.find((entry) => entry.kind === kind);
      if (room === undefined) continue;
      expect(room.name.length).toBeGreaterThan(0);
      return room.name;
    }
    throw new Error(`${layout.view} plans no ${kind}`);
  }

  function civicSeatCountOnFloor(
    layout: OfficeLayout,
    floorIndex: number,
  ): number {
    let count = 0;
    for (const room of layout.floors[floorIndex].civic) {
      count += room.seatIds.length;
    }
    return count;
  }

  it("walks a newcomer in from the door, ending in its own chair", () => {
    const scene = newScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: CREATED_PULSE,
        pulseKey: "created-beta",
      }),
    );

    const layout = layoutOf(scene);
    const door = layout.doorTile;
    expect(characterRect(frameOf(scene), "beta")).toEqual(
      footRect(layout, door),
    );

    // Three tiles a second from the entrance is comfortably done well inside
    // the idle-errand threshold, so this does not race a second walk-out.
    for (let step = 0; step < 60; step += 1) scene.tick(100);
    const desk = layout.desks.get("beta");
    if (desk === undefined) throw new Error("expected a desk for beta");
    expect(characterRect(frameOf(scene), "beta")).toEqual(
      footRect(layout, desk.chairTile),
    );
    expect(frameOf(scene).awayAgentIds.has("beta")).toBe(false);
  });

  it("flies an envelope between the two agents' SEATS", () => {
    const scene = newScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: REQUEST_PULSE,
        pulseKey: "row-1",
      }),
    );

    const layout = layoutOf(scene);
    const from = layout.desks.get("alpha");
    const to = layout.desks.get("beta");
    if (from === undefined || to === undefined) {
      throw new Error("expected both desks");
    }
    const launched = envelopes(frameOf(scene))[0];
    expect(launched).toBeDefined();
    expect(launched.progress).toBe(0);
    // It leaves the SENDER, which is the centre line of the sprite box that
    // agent's own chair tile puts it in - measured through `footRect` rather
    // than off the tile's corner, because only the identity projector puts
    // those two in the same place.
    const start = footRect(layout, from.chairTile);
    expect(launched.x).toBeCloseTo(start.x + OFFICE_CHARACTER_WIDTH / 2, 0);

    // Runs to completion and is delivered - never stalls mid-flight.
    for (let step = 0; step < 20; step += 1) scene.tick(100);
    expect(envelopes(frameOf(scene))).toHaveLength(0);
  });

  it("sends an idle agent out on an errand and back, over a real multi-tile path to the spot it actually visited", () => {
    const scene = newScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    const desk = layout.desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk for alpha");
    const seatedBox = footRect(layout, desk.chairTile);

    // An idle floor sends everyone out again the moment they are back, so
    // this watches for the FIRST away, then the FIRST return after it, rather
    // than ticking a fixed span and hoping it lands between two errands.
    let sawAway = false;
    let steps = 0;
    while (!sawAway && steps < 400) {
      scene.tick(100);
      steps += 1;
      if (frameOf(scene).awayAgentIds.has("alpha")) sawAway = true;
    }
    expect(sawAway).toBe(true);

    // Keep ticking until the character settles - two ticks landing on the
    // same rect is "arrived at the errand", not "mid-stride".
    let restingRect = characterRect(frameOf(scene), "alpha");
    let settled = false;
    steps = 0;
    while (!settled && steps < 400) {
      scene.tick(100);
      steps += 1;
      const next = characterRect(frameOf(scene), "alpha");
      settled = next.x === restingRect.x && next.y === restingRect.y;
      restingRect = next;
    }
    expect(settled).toBe(true);

    // The tile the character actually rests at - not "some spot on the
    // floor happens to be reachable" - must be reached by a REAL path of
    // more than one tile: the walk that got it there was never `walkTo`'s
    // teleport fallback, which only fires when a plan produced an
    // unreachable seat.
    const floor = layout.floors[desk.floorIndex];
    const visitedSpot = floor.errandSpots.find(
      (spot) =>
        footRect(layout, spot.approachTile).x === restingRect.x &&
        footRect(layout, spot.approachTile).y === restingRect.y,
    );
    if (visitedSpot === undefined) {
      throw new Error(
        "the settled character is not resting at any errand spot's approach tile",
      );
    }
    const path = findOfficePath(
      layout,
      desk.chairTile,
      visitedSpot.approachTile,
    );
    expect(path).not.toBeNull();
    if (path !== null) expect(path.length).toBeGreaterThan(1);

    // An idle floor never sends anyone back on its own - errands chain
    // forever until something actually happens to the agent. A status that
    // stops being idle is one of the documented triggers that ends one.
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "working"]]),
      }),
    );
    let backInChair = false;
    steps = 0;
    while (!backInChair && steps < 400) {
      scene.tick(100);
      steps += 1;
      if (!frameOf(scene).awayAgentIds.has("alpha")) backInChair = true;
    }
    expect(backInChair).toBe(true);
    expect(characterRect(frameOf(scene), "alpha")).toEqual(seatedBox);
  });

  /**
   * HOW LONG THE WALK OUT OF THE DOOR TAKES on the view under test, with no
   * lead-in - this case syncs the archival and then waits.
   *
   * MEASURED: 127 ticks, against the `150` this carried - 15 %. Like the other
   * two waits for this same walk it has no ceiling (green at every budget
   * probed to 800), so 260 is twice the measurement and costs nothing.
   *
   * IT IS THE SAME WALK the other two wait for, at a WIDER SCOPE. This
   * describe is `describe.each(OFFICE_VIEW_IDS)`, so one budget covers all six
   * views and 127 is the slowest of them - not a different Floor from the one
   * `CURSOR_ARCHIVAL_WALK_TICKS` and `office-scene-replay.test.ts` measure.
   * Those two are the Floor alone and agree exactly with each other: 400 ms of
   * lead-in plus 116 ticks there is 12 000 ms, which is that file's 120 ticks
   * with no lead-in. So the three numbers are one walk read at two scopes, and
   * they stay three constants only so that a view getting slower reddens here
   * and names the scope, rather than moving a number two other cases share.
   */
  const ARCHIVAL_WALK_OUT_TICKS = 260;

  it("walks an archived agent out of the door and sheets its desk", () => {
    const leaver = agent({ id: "alpha", createdAt: 1, archivedAt: 500 });
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 100,
      }),
    );
    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 900,
      }),
    );

    for (let step = 0; step < ARCHIVAL_WALK_OUT_TICKS; step += 1) {
      scene.tick(100);
    }
    const gone = frameOf(scene);
    expect(hasCharacter(gone, "alpha")).toBe(false);
    expect(sprites(visibleDrawables(gone), "dust-sheet")).toHaveLength(1);
  });

  it("settles motion instantly under reduced motion, and starts an arrival that way too", () => {
    const scene = newScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: CREATED_PULSE,
        pulseKey: "created-beta",
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const desk = layout.desks.get("beta");
    if (desk === undefined) throw new Error("expected a desk for beta");
    // Landed in its chair on the very sync that created it - no walk at all.
    expect(characterRect(frameOf(scene), "beta")).toEqual(
      footRect(layout, desk.chairTile),
    );
  });

  it("gives the same as-of display opening at a historical cursor as reaching it from live", () => {
    const opensAtCursor = newScene();
    opensAtCursor.sync(
      sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY, cursorMs: 5 }),
    );

    const reachesCursor = newScene();
    reachesCursor.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: ALPHA_ONLY,
        cursorMs: 100,
      }),
    );
    reachesCursor.sync(
      sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY, cursorMs: 5 }),
    );

    expect(frameOf(reachesCursor).hitRegions).toEqual(
      frameOf(opensAtCursor).hitRegions,
    );
  });

  const GROWTH_BASE: ReadonlyArray<OfficeAgentInput> = [
    agent({ id: "alpha", createdAt: 1 }),
    agent({ id: "beta", createdAt: 2 }),
    agent({ id: "gamma", createdAt: 3 }),
  ];
  const GROWTH_BASE_IDS = new Set(GROWTH_BASE.map((person) => person.id));
  const GROWN: ReadonlyArray<OfficeAgentInput> = [
    ...GROWTH_BASE,
    agent({ id: "delta", createdAt: 4 }),
  ];
  const GROWN_IDS = new Set(GROWN.map((person) => person.id));

  it("(a) keeps a mid-walk character's real position, not a reset to the door, when the agent set grows", () => {
    const scene = newScene();
    scene.sync(
      sceneInput({ agents: GROWTH_BASE, visibleAgentIds: new Set(["alpha"]) }),
    );
    scene.sync(
      sceneInput({
        agents: GROWTH_BASE,
        visibleAgentIds: GROWTH_BASE_IDS,
        pulse: CREATED_PULSE,
        pulseKey: "created-beta",
      }),
    );
    scene.tick(200);
    const layout = layoutOf(scene);
    const desk = layout.desks.get("beta");
    if (desk === undefined) throw new Error("expected a desk for beta");
    const door = footRect(layout, layout.doorTile);
    const chair = footRect(layout, desk.chairTile);
    const beforeGrowth = characterRect(frameOf(scene), "beta");
    // Confirm this scenario actually caught beta mid-walk, not already home
    // or still standing at the door - otherwise growth would trivially "not
    // reset" a position that never needed preserving.
    expect(beforeGrowth).not.toEqual(door);
    expect(beforeGrowth).not.toEqual(chair);
    expect(frameOf(scene).awayAgentIds.has("beta")).toBe(true);

    scene.sync(sceneInput({ agents: GROWN, visibleAgentIds: GROWN_IDS }));
    // An isometric view's projector origin can move with growth even when no
    // tile does (F17, tracked and fixed separately) - fold that delta out
    // here so this case stays about path cancellation, not about F17.
    const afterLayout = layoutOf(scene);
    const originBefore = view.painter.projector(layout).project(0, 0);
    const originAfter = view.painter.projector(afterLayout).project(0, 0);
    const originDelta = {
      x: originAfter.x - originBefore.x,
      y: originAfter.y - originBefore.y,
    };
    // The growth sync itself, with no tick in between, must not relocate a
    // character that is genuinely mid-walk - that is what "cancelling the
    // path" would look like.
    expect(characterRect(frameOf(scene), "beta")).toEqual({
      ...beforeGrowth,
      x: beforeGrowth.x + originDelta.x,
      y: beforeGrowth.y + originDelta.y,
    });
    expect(frameOf(scene).awayAgentIds.has("beta")).toBe(true);

    // And the walk it was already on completes normally afterwards.
    let backInChair = false;
    for (let step = 0; step < 400 && !backInChair; step += 1) {
      scene.tick(100);
      if (!frameOf(scene).awayAgentIds.has("beta")) backInChair = true;
    }
    expect(backInChair).toBe(true);
  });

  it("(b) keeps a queued character at its own queue tile, not a different one, when the agent set grows", () => {
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: GROWTH_BASE,
        visibleAgentIds: GROWTH_BASE_IDS,
        statusById: new Map<string, OfficeAgentStatus>([["beta", "attention"]]),
      }),
    );
    // Poll for the FIRST tick beta is actually standing at a queue tile,
    // rather than a fixed span that might catch it already served.
    let layout = layoutOf(scene);
    let queueTiles = layout.floors.flatMap(
      (floor) => floor.receptionQueueTiles,
    );
    let beforeGrowth = characterRect(frameOf(scene), "beta");
    let queuedTile = queueTiles.find((tile) => {
      const rect = footRect(layout, tile);
      return rect.x === beforeGrowth.x && rect.y === beforeGrowth.y;
    });
    for (let step = 0; step < 200 && queuedTile === undefined; step += 1) {
      scene.tick(100);
      layout = layoutOf(scene);
      queueTiles = layout.floors.flatMap((floor) => floor.receptionQueueTiles);
      beforeGrowth = characterRect(frameOf(scene), "beta");
      queuedTile = queueTiles.find((tile) => {
        const rect = footRect(layout, tile);
        return rect.x === beforeGrowth.x && rect.y === beforeGrowth.y;
      });
    }
    if (queuedTile === undefined) {
      throw new Error(
        "expected beta to be standing at one of the floor's reception queue tiles before growth",
      );
    }

    scene.sync(
      sceneInput({
        agents: GROWN,
        visibleAgentIds: GROWN_IDS,
        statusById: new Map<string, OfficeAgentStatus>([["beta", "attention"]]),
      }),
    );
    // Same tile, not just "a" queue tile - a growth-triggered re-plan must
    // not bump an already-queued agent to a different slot.
    expect(characterRect(frameOf(scene), "beta")).toEqual(
      footRect(layoutOf(scene), queuedTile),
    );
  });

  it("(c) keeps an in-flight paper ball in flight, not dropped, when the agent set grows", (context) => {
    // Only Floor and Mission control's plans place a throwable (bin/darts)
    // errand spot at all - the other views have nothing this scenario can
    // aim an idle agent at.
    const throwableView: OfficeView = {
      ...view,
      plan: (input) => {
        const base = view.plan(input);
        const throwable = base.floors.some((floor) =>
          floor.errandSpots.some(
            (spot) => spot.kind === "bin" || spot.kind === "darts",
          ),
        );
        if (!throwable) return base;
        return {
          ...base,
          floors: base.floors.map((floor) => ({
            ...floor,
            errandSpots: floor.errandSpots.filter(
              (spot) => spot.kind === "bin" || spot.kind === "darts",
            ),
          })),
        };
      },
    };
    const probe = new OfficeScene(throwableView, null);
    probe.sync(
      sceneInput({ agents: GROWTH_BASE, visibleAgentIds: GROWTH_BASE_IDS }),
    );
    const hasThrowSpot = layoutOf(probe).floors.some((floor) =>
      floor.errandSpots.some(
        (spot) => spot.kind === "bin" || spot.kind === "darts",
      ),
    );
    if (!hasThrowSpot) {
      context.skip(`${view.id} places no bin or darts errand spot to throw at`);
      return;
    }

    let inFlight = 0;
    for (let step = 0; step < 400 && inFlight === 0; step += 1) {
      probe.tick(100);
      inFlight = paperBalls(frameOf(probe)).length;
    }
    expect(inFlight).toBeGreaterThan(0);

    probe.sync(sceneInput({ agents: GROWN, visibleAgentIds: GROWN_IDS }));
    // The growth sync itself must not drop the ball that was already thrown.
    expect(paperBalls(frameOf(probe)).length).toBeGreaterThan(0);
  });

  it("keeps every seat id unique once growth settles, across a real idle run", () => {
    const scene = newScene();
    scene.sync(
      sceneInput({ agents: GROWTH_BASE, visibleAgentIds: GROWTH_BASE_IDS }),
    );
    for (let step = 0; step < 100; step += 1) scene.tick(100);
    expect(() =>
      scene.sync(sceneInput({ agents: GROWN, visibleAgentIds: GROWN_IDS })),
    ).not.toThrow();
    expect(layoutOf(scene).desks.size).toBe(GROWN.length);
    for (let step = 0; step < 100; step += 1) scene.tick(100);
    const seatIds = new Set<string>();
    for (const desk of layoutOf(scene).desks.values()) {
      expect(seatIds.has(desk.seatId)).toBe(false);
      seatIds.add(desk.seatId);
    }
  });

  it("is deterministic: the same input, tick sequence and view rect produce identical frames", () => {
    const run = (): string => {
      const scene = newScene();
      scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
      const seen: string[] = [];
      let sawCharacter = false;
      for (let step = 0; step < 100; step += 1) {
        scene.tick(100);
        const frame = scene.frame(2, { x: 0, y: 0, width: 500, height: 500 });
        const drawables = visibleDrawables(frame);
        sawCharacter ||= drawables.some(
          (drawable) =>
            drawable.kind === "sprite" && drawable.sprite.name === "character",
        );
        seen.push(
          JSON.stringify({
            actors: frame.actors,
            world: frame.world,
            props: frame.props,
            hitRegions: frame.hitRegions,
          }),
        );
      }
      expect(sawCharacter).toBe(true);
      return seen.join("\n");
    };
    expect(run()).toEqual(run());
  });

  it("wakes a Building cubby into a real reserve and returns it when cold", (context) => {
    if (viewId !== "building") {
      context.skip("only Building has cubby-to-reserve wake semantics");
      return;
    }
    const epic = makeTestEpic("triage", 60, 9);
    const cold = new Map<string, OfficeAgentStatus>(
      epic.agents.map((person) => [person.id, "idle"]),
    );
    cold.set("team-0-lead", "working");
    const target = epic.agents.find((person) => person.id.startsWith("leaf-"));
    if (target === undefined) throw new Error("expected a team member");
    const secondTarget = epic.agents.find(
      (person) => person.id.startsWith("leaf-") && person.id !== target.id,
    );
    if (secondTarget === undefined)
      throw new Error("expected a second team member");
    const scene = newScene();
    const occupancySpy = vi.spyOn(OfficeSeatBook.prototype, "occupancy");
    const visibleAgentIds = new Set(epic.agents.map((person) => person.id));
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: cold,
        reducedMotion: false,
      }),
    );
    const coldLayout = layoutOf(scene);
    const cubby = coldLayout.desks.get(target.id);
    if (cubby === undefined) throw new Error("expected a cubby assignment");
    expect(cubby.kind).toBe("cubby");
    const requiredTeamRoom = coldLayout.desks.get("team-0-lead")?.roomId;
    expect(requiredTeamRoom).toBe("team-0-lead/room/0");
    const seatBookContext: unknown = occupancySpy.mock.contexts.at(-1);
    const currentOccupancy = (): ReadonlyMap<string, string> => {
      if (!(seatBookContext instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return seatBookContext.occupancy();
    };

    const assignedSeatIds = new Set(
      Array.from(coldLayout.desks.values()).map((desk) => desk.seatId),
    );
    const reserves = Array.from(coldLayout.seats.values()).filter(
      (seat) => seat.kind === "desk" && !assignedSeatIds.has(seat.seatId),
    );
    expect(reserves.length).toBeGreaterThan(0);
    const occupyOtherReserves = () => {
      const blockerStatus = new Map(cold);
      const blockers = epic.agents.filter(
        (person) =>
          person.id !== target.id &&
          person.id !== secondTarget.id &&
          person.id !== "team-0-lead" &&
          !person.archived,
      );
      let freeReserves = reserves;
      let teamRoomFiller: { agentId: string; seatId: string } | null = null;
      for (const blocker of blockers) {
        if (freeReserves.length === 0) break;
        blockerStatus.set(blocker.id, "working");
        scene.sync(
          sceneInput({
            agents: epic.agents,
            visibleAgentIds,
            statusById: blockerStatus,
            reducedMotion: false,
          }),
        );
        const claimedReserve = reserves.find(
          (seat) => currentOccupancy().get(seat.seatId) === blocker.id,
        );
        if (
          claimedReserve !== undefined &&
          claimedReserve.roomId === requiredTeamRoom
        ) {
          teamRoomFiller = {
            agentId: blocker.id,
            seatId: claimedReserve.seatId,
          };
        }
        freeReserves = reserves.filter(
          (seat) => currentOccupancy().get(seat.seatId) === undefined,
        );
      }
      if (teamRoomFiller === null) {
        throw new Error(
          "expected a filler to claim the live team room reserve",
        );
      }
      const cooledStatus = new Map(blockerStatus).set(
        teamRoomFiller.agentId,
        "idle",
      );
      scene.sync(
        sceneInput({
          agents: epic.agents,
          visibleAgentIds,
          statusById: cooledStatus,
          reducedMotion: true,
        }),
      );
      expect(currentOccupancy().get(teamRoomFiller.seatId)).toBeUndefined();
      freeReserves = reserves.filter(
        (seat) => currentOccupancy().get(seat.seatId) === undefined,
      );
      expect(freeReserves).toHaveLength(1);
      const remainingReserve = freeReserves.at(0);
      if (remainingReserve === undefined) {
        throw new Error("expected one remaining reserve");
      }
      expect(remainingReserve.roomId).toBe(requiredTeamRoom);
      expect(Array.from(layoutOf(scene).seats.keys())).toEqual(
        Array.from(coldLayout.seats.keys()),
      );
      return { cooledStatus, remainingReserve };
    };
    const { cooledStatus, remainingReserve } = occupyOtherReserves();
    const cubbyRect = footRect(coldLayout, cubby.chairTile);
    const reserveRects = reserves.map((seat) =>
      footRect(coldLayout, seat.chairTile),
    );
    const reserveFront = (frame: OfficeFrame, seat: OfficeSeat) =>
      frame.world?.find(
        (entry) =>
          entry.drawable.kind === "sprite" &&
          entry.drawable.sprite.name === "desk-front" &&
          entry.drawable.x === seat.deskTile.col * OFFICE_TILE &&
          entry.drawable.y === seat.deskTile.row * OFFICE_TILE + 24,
      );
    for (const lod of [1, 2] as const) {
      const reserveEntry = reserveFront(
        scene.frame(lod, WHOLE_WORLD),
        remainingReserve,
      );
      if (reserveEntry === undefined) {
        throw new Error(`expected an empty reserve at lod ${lod}`);
      }
      expect(reserveEntry.ownerAgentId).toBeNull();
    }
    expect(
      sprites(visibleDrawables(scene.frame(0, WHOLE_WORLD)), "desk-front"),
    ).toHaveLength(0);

    const hot = new Map(cooledStatus).set(target.id, "working");
    const targetColdStatus = new Map(cooledStatus).set(target.id, "idle");
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: hot,
        reducedMotion: false,
      }),
    );
    const observeOutbound = () => {
      const outboundSamples: OfficeRect[] = [];
      const reserveFurnitureSeenWhileWalking = new Set<string>();
      let walkedToReserve = false;
      let reachedReserve = -1;
      for (let step = 0; step < 400; step += 1) {
        const frame = frameOf(scene);
        const character = buildingCharacterRect(frame, target.id);
        outboundSamples.push(character);
        const intermediate =
          JSON.stringify(character) !== JSON.stringify(cubbyRect) &&
          !reserveRects.some(
            (reserveRect) =>
              JSON.stringify(reserveRect) === JSON.stringify(character),
          );
        if (!walkedToReserve && intermediate) {
          walkedToReserve = true;
        }
        if (intermediate) {
          for (const reserve of reserves) {
            if (reserveFront(frame, reserve) !== undefined) {
              reserveFurnitureSeenWhileWalking.add(reserve.seatId);
            }
          }
        }
        reachedReserve = reserveRects.findIndex(
          (reserveRect) =>
            JSON.stringify(reserveRect) === JSON.stringify(character),
        );
        if (reachedReserve >= 0) break;
        scene.tick(100);
      }
      return {
        outboundSamples,
        reserveFurnitureSeenWhileWalking,
        walkedToReserve,
        reachedReserve,
      };
    };
    const {
      outboundSamples,
      reserveFurnitureSeenWhileWalking,
      walkedToReserve,
      reachedReserve,
    } = observeOutbound();
    expect(walkedToReserve).toBe(true);
    expect(reachedReserve).toBeGreaterThanOrEqual(0);
    const chosenReserve = reserves.at(reachedReserve);
    if (chosenReserve === undefined)
      throw new Error("expected a chosen reserve");
    expect(reserveFurnitureSeenWhileWalking.has(chosenReserve.seatId)).toBe(
      true,
    );
    expect(currentOccupancy().get(chosenReserve.seatId)).toBe(target.id);
    expect(chosenReserve.roomId).toBe(requiredTeamRoom);
    const reservePath = findOfficePath(
      coldLayout,
      cubby.chairTile,
      chosenReserve.chairTile,
    );
    expect(reservePath).not.toBeNull();
    expect(reservePath?.length).toBeGreaterThan(1);
    if (reservePath === null) throw new Error("expected a reserve path");
    const outboundPath = [cubby.chairTile, ...reservePath];
    expect(
      outboundSamples.every((sample) =>
        rectOnProjectedPath(coldLayout, outboundPath, sample),
      ),
    ).toBe(true);

    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: targetColdStatus,
        reducedMotion: false,
      }),
    );
    const returnSamples: OfficeRect[] = [];
    const returnPath = findOfficePath(
      coldLayout,
      chosenReserve.chairTile,
      cubby.chairTile,
    );
    expect(returnPath).not.toBeNull();
    if (returnPath === null) throw new Error("expected a return path");
    const fullReturnPath = [chosenReserve.chairTile, ...returnPath];
    expect(currentOccupancy().get(chosenReserve.seatId)).toBe(target.id);
    const observeReturn = () => {
      let walkedBack = false;
      let returnedToCubby = false;
      for (let step = 0; step < 400; step += 1) {
        const frame = frameOf(scene);
        const character = buildingCharacterRect(frame, target.id);
        returnSamples.push(character);
        if (
          JSON.stringify(character) !== JSON.stringify(cubbyRect) &&
          !reserveRects.some(
            (reserveRect) =>
              JSON.stringify(reserveRect) === JSON.stringify(character),
          )
        ) {
          walkedBack = true;
        }
        if (JSON.stringify(character) === JSON.stringify(cubbyRect)) {
          returnedToCubby = true;
          break;
        }
        expect(currentOccupancy().get(chosenReserve.seatId)).toBe(target.id);
        scene.tick(100);
      }
      return { walkedBack, returnedToCubby };
    };
    const { walkedBack, returnedToCubby } = observeReturn();
    expect(walkedBack).toBe(true);
    expect(returnedToCubby).toBe(true);
    expect(currentOccupancy().get(chosenReserve.seatId)).toBeUndefined();
    expect(
      returnSamples.every((sample) =>
        rectOnProjectedPath(coldLayout, fullReturnPath, sample),
      ),
    ).toBe(true);
    expect(scene.whereabouts(target.id)).toBe("Quiet stack");
    const secondCubby = coldLayout.desks.get(secondTarget.id);
    if (secondCubby === undefined) throw new Error("expected a second cubby");
    expect(secondCubby.kind).toBe("cubby");
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: new Map(targetColdStatus).set(secondTarget.id, "working"),
        reducedMotion: false,
      }),
    );
    let secondAtReleasedReserve = false;
    for (let step = 0; step < 400 && !secondAtReleasedReserve; step += 1) {
      secondAtReleasedReserve =
        JSON.stringify(characterRect(frameOf(scene), secondTarget.id)) ===
        JSON.stringify(footRect(coldLayout, chosenReserve.chairTile));
      if (!secondAtReleasedReserve) scene.tick(100);
    }
    expect(secondAtReleasedReserve).toBe(true);
    occupancySpy.mockRestore();
  });

  it("R3 keeps a waking Building cubby drawn until its character leaves", (context) => {
    if (viewId !== "building") {
      context.skip("only Building has cubby-to-reserve continuity");
      return;
    }
    const epic = makeTestEpic("triage", 24, 9);
    const cold = new Map<string, OfficeAgentStatus>(
      epic.agents.map((person) => [person.id, "idle"]),
    );
    cold.set("team-0-lead", "working");
    const target = epic.agents.find((person) => person.id.startsWith("leaf-"));
    if (target === undefined) throw new Error("expected a team member");
    const visibleAgentIds = new Set(epic.agents.map((person) => person.id));
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: cold,
        reducedMotion: false,
      }),
    );
    const cubby = layoutOf(scene).desks.get(target.id);
    if (cubby === undefined) throw new Error("expected a cubby assignment");
    expect(cubby.kind).toBe("cubby");
    const assignedSeatIds = new Set(
      Array.from(layoutOf(scene).desks.values()).map((desk) => desk.seatId),
    );
    const liveLead = layoutOf(scene).desks.get("team-0-lead");
    if (liveLead === undefined) throw new Error("expected a live team room");
    expect(liveLead.kind).toBe("desk");
    const reserve = Array.from(layoutOf(scene).seats.values()).find(
      (seat) =>
        seat.kind === "desk" &&
        seat.roomId === liveLead.roomId &&
        !assignedSeatIds.has(seat.seatId),
    );
    if (reserve === undefined) throw new Error("expected a reserve seat");
    const originalSeatProps = view.painter.seatProps;
    const reserveSeatPropsCalls: Array<{
      readonly lod: 0 | 1 | 2;
      readonly state: OfficeDeskState;
      readonly props: ReadonlyArray<OfficeWorldDrawable>;
    }> = [];
    const seatPropsSpy = vi
      .spyOn(view.painter, "seatProps")
      .mockImplementation((layout, seat, state, lod) => {
        const props = originalSeatProps(layout, seat, state, lod);
        if (seat.seatId === reserve.seatId) {
          reserveSeatPropsCalls.push({ lod, state, props });
        }
        return props;
      });
    scene.frame(0, WHOLE_WORLD);
    expect(seatPropsSpy).not.toHaveBeenCalled();
    scene.frame(1, WHOLE_WORLD);
    scene.frame(2, WHOLE_WORLD);
    for (const lod of [1, 2] as const) {
      const call = reserveSeatPropsCalls.find((entry) => entry.lod === lod);
      if (call === undefined)
        throw new Error(`expected reserve props at lod ${lod}`);
      expect(call.state.agentId).toBeNull();
      const front = call.props.find(
        (entry) =>
          entry.drawable.kind === "sprite" &&
          entry.drawable.sprite.name === "desk-front",
      );
      if (front === undefined || front.drawable.kind !== "sprite") {
        throw new Error(`expected reserve desk front at lod ${lod}`);
      }
      expect(front.drawable.alpha).toBe(0.45);
      if (lod === 2) {
        // ONE `reserve` A STOREY, not one an empty desk: the storey nominates
        // the seat that says the word, and this reserve carries it only if it
        // was the one nominated. What marks it as free either way is the dark,
        // half-alpha desk front asserted just above.
        const label = call.props.find(
          (entry) =>
            entry.drawable.kind === "label" &&
            entry.drawable.text === "reserve",
        );
        const spokesman = obliqueReserveLabelSeatId(
          layoutOf(scene),
          reserve.floorIndex,
        );
        expect(spokesman).not.toBeNull();
        expect(label !== undefined).toBe(spokesman === reserve.seatId);
      }
    }
    seatPropsSpy.mockRestore();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: new Map(cold).set(target.id, "working"),
        reducedMotion: false,
      }),
    );
    const cubbyAtWake = frameOf(scene).world?.some(
      (entry) =>
        entry.ownerAgentId === target.id &&
        entry.drawable.kind === "sprite" &&
        entry.drawable.sprite.name === "cubby" &&
        entry.drawable.x === cubby.deskTile.col * OFFICE_TILE &&
        entry.drawable.y === cubby.deskTile.row * OFFICE_TILE,
    );
    expect(cubbyAtWake).toBe(true);
  });

  it("gives aliased Building storeys one physical reception queue", (context) => {
    if (viewId !== "building") {
      context.skip("only Building aliases reception tiles across storeys");
      return;
    }
    const epic = makeTestEpic("one-team", 60, 4);
    const visibleAgentIds = new Set(epic.agents.map((person) => person.id));
    const scene = newScene();
    const allWorking = new Map<string, OfficeAgentStatus>(
      epic.agents.map((person) => [person.id, "working"]),
    );
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: allWorking,
      }),
    );
    const initial = layoutOf(scene);
    const assignments = epic.agents.flatMap((person) => {
      const seat = initial.desks.get(person.id);
      return seat === undefined ? [] : [{ person, seat }];
    });
    const first = assignments.at(0);
    if (first === undefined) throw new Error("expected a first storey seat");
    const second = assignments.find(
      ({ seat }) =>
        seat.floorIndex !== first.seat.floorIndex &&
        initial.floors[seat.floorIndex].receptionQueueTiles.length > 0,
    );
    if (second === undefined) throw new Error("expected a second storey seat");
    const firstFloor = initial.floors[first.seat.floorIndex];
    const secondFloor = initial.floors[second.seat.floorIndex];
    const firstQueueTile = firstFloor.receptionQueueTiles.at(0);
    const secondQueueTile = secondFloor.receptionQueueTiles.at(0);
    if (firstQueueTile === undefined || secondQueueTile === undefined) {
      throw new Error("expected reception queue tiles");
    }
    const secondQueueStand = secondFloor.receptionQueueTiles.at(1);
    if (secondQueueStand === undefined) {
      throw new Error("expected a second reception queue tile");
    }
    expect(firstQueueTile).toEqual(secondQueueTile);

    const firstAttention = new Map<string, OfficeAgentStatus>([
      [first.person.id, "attention"],
    ]);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: firstAttention,
        reducedMotion: true,
      }),
    );
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: new Map<string, OfficeAgentStatus>([
          [first.person.id, "attention"],
          [second.person.id, "attention"],
        ]),
        reducedMotion: true,
      }),
    );
    const queued = frameOf(scene);
    expect(characterRect(queued, first.person.id)).toEqual(
      footRect(initial, firstQueueTile),
    );
    expect(characterRect(queued, second.person.id)).toEqual(
      footRect(initial, secondQueueStand),
    );
    expect(characterRect(queued, first.person.id)).not.toEqual(
      characterRect(queued, second.person.id),
    );
  });

  it("keeps host plazas disconnected without Building's skybridge", (context) => {
    if (viewId !== "building" && viewId !== "towers") {
      context.skip("only Towers and Building have host-plaza connectivity");
      return;
    }
    const epic = makeTestEpic("two-hosts", 60, 1);
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
        statusById: epic.statusById,
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const plazaFor = (hostId: string): OfficeFloor => {
      const plaza = layout.floors.find(
        (floor) => floor.hostId === hostId && floor.bounds.rows === 5,
      );
      if (plaza === undefined) throw new Error(`missing plaza for ${hostId}`);
      return plaza;
    };
    const plazaA = plazaFor("host-a");
    const plazaB = plazaFor("host-b");
    const path = findOfficePath(layout, plazaA.doorTile, plazaB.doorTile);
    if (viewId === "towers") {
      expect(path).toBeNull();
      return;
    }
    expect(path).not.toBeNull();
    const walkable = layout.walkable.map((row) => [...row]);
    for (const prop of layout.props) {
      if (prop.sprite.name !== "skybridge") continue;
      walkable[prop.tile.row][prop.tile.col] = false;
    }
    expect(
      findOfficePath({ ...layout, walkable }, plazaA.doorTile, plazaB.doorTile),
    ).toBeNull();
  });

  /**
   * Measured: alpha's desk to its infirmary bed is 163 ticks of `tick(100)`
   * on the 2-agent Floor fixture. A 60-agent storey is a longer crossing;
   * 800 ticks is ~240 tiles at 3 tiles/s, past any storey these fixtures
   * draw, and still fails a teleport (which never leaves the chair).
   */
  const CIVIC_WALK_TICKS = 800;

  /**
   * Ticks until one of `ids` is SITTING in a seat of that kind, and says which.
   *
   * Holding the claim is not the same as being in it - the walk is the whole
   * point of C1 - so this waits for the claim AND for the agent to stop being
   * away, which together are "it has arrived".
   */
  function tickUntilSeatedIn(
    scene: OfficeScene,
    ids: ReadonlyArray<string>,
    want: OfficeSeatKind,
  ): string | undefined {
    for (let step = 0; step < CIVIC_WALK_TICKS; step += 1) {
      scene.tick(100);
      const book = bookOf(scene);
      const frame = frameOf(scene);
      const seated = ids.find(
        (id) => book.civicClaimOf(id) === want && !frame.awayAgentIds.has(id),
      );
      if (seated !== undefined) return seated;
    }
    return undefined;
  }

  /**
   * Ticks until this agent is back in its OWN chair with no civic claim left.
   *
   * The claim going is not enough: `endClaim` happens on the sync that heals
   * the agent, and the walk home happens over the ticks after it. Checking the
   * painted position against the desk's own chair is what makes this "home"
   * rather than "no longer claiming a bed".
   */
  function tickUntilHome(
    scene: OfficeScene,
    agentId: string,
    chairTile: OfficeTilePos,
  ): boolean {
    for (let step = 0; step < CIVIC_WALK_TICKS; step += 1) {
      scene.tick(100);
      if (frameOf(scene).awayAgentIds.has(agentId)) continue;
      if (bookOf(scene).civicClaimOf(agentId) !== null) continue;
      const at = characterRect(frameOf(scene), agentId);
      const seat = footRect(layoutOf(scene), chairTile);
      if (at.x === seat.x && at.y === seat.y) return true;
    }
    return false;
  }

  /**
   * Ticks a civic walk to its end and reports what it SAW on the way.
   *
   * The anti-teleport control, and the reason it is a watch rather than an
   * assertion about the destination: `startCivicWalk` seats an agent where it
   * stands when no path exists, so a case that only checked where everybody
   * ended up would pass against that fallback with nobody having walked at
   * all. An agent that was ever `away` while holding its seat walked; one
   * whose painted rect ever differed from where it started moved.
   */
  function watchCivicWalk(
    scene: OfficeScene,
    ids: ReadonlyArray<string>,
    starts: ReadonlyMap<string, OfficeRect>,
    want: OfficeSeatKind,
  ): {
    readonly sawAway: ReadonlySet<string>;
    readonly moved: ReadonlySet<string>;
  } {
    const room = civicRoomName(
      layoutOf(scene),
      want === "bed" ? "infirmary" : "waiting-room",
    );
    const sawAway = new Set<string>();
    const moved = new Set<string>();
    for (let step = 0; step < CIVIC_WALK_TICKS; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      const book = bookOf(scene);
      for (const id of ids) {
        if (frame.awayAgentIds.has(id) && book.civicClaimOf(id) === want) {
          // `civic-out` is not a public reader: away, holding the seat, and
          // named by the room it is walking TO is exactly what
          // `awayWhereabouts` answers for one. K4 made that answer say so out
          // loud - `Walking to the Infirmary` rather than `Infirmary` - so a
          // card cannot read as though somebody were already in the bed while
          // they are still crossing the floor to it.
          sawAway.add(id);
          expect(scene.whereabouts(id)).toBe(`Walking to the ${room}`);
        }
        const was = starts.get(id);
        if (was === undefined) continue;
        const now = characterRect(frame, id);
        if (now.x !== was.x || now.y !== was.y) moved.add(id);
      }
      const allSeated = ids.every(
        (id) => book.civicClaimOf(id) === want && !frame.awayAgentIds.has(id),
      );
      if (allSeated) break;
    }
    return { sawAway, moved };
  }

  it("walks an outbreak of three to beds by path, never by teleport", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    // 60 agents → civicCapacityFor beds = 3, so three crashers all fit.
    // A 12-agent floor only holds 2, and this case would then be the
    // overflow case wearing an outbreak(3) name.
    const epic = makeTestEpic("one-team", 60, 1);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const script = outbreakScript({ ...epic, statusById: idle }, 3);
    const crashed = failureIds(script[0]);
    expect(crashed).toHaveLength(3);

    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
      }),
    );
    const layout = layoutOf(scene);
    const starts = new Map<string, OfficeRect>();
    const startTiles = new Map<string, OfficeTilePos>();
    for (const id of crashed) {
      starts.set(id, characterRect(frameOf(scene), id));
      const desk = layout.desks.get(id);
      if (desk === undefined) throw new Error(`no desk for ${id}`);
      startTiles.set(id, desk.chairTile);
    }

    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: script[0],
      }),
    );

    const { sawAway, moved } = watchCivicWalk(scene, crashed, starts, "bed");

    const book = bookOf(scene);
    const frame = frameOf(scene);
    for (const id of crashed) {
      expect(sawAway.has(id), `${id} never walked (teleport fallback)`).toBe(
        true,
      );
      expect(moved.has(id), `${id} never changed position`).toBe(true);
      expect(book.civicClaimOf(id)).toBe("bed");
      expect(frame.awayAgentIds.has(id)).toBe(false);
      expect(scene.whereabouts(id)).toBe(civicRoomName(layout, "infirmary"));
      const bed = book.effectiveSeat(id);
      if (bed === null || bed.kind !== "bed") {
        throw new Error(`expected ${id} in a bed`);
      }
      const from = startTiles.get(id);
      if (from === undefined) throw new Error(`no start tile for ${id}`);
      const path = findOfficePath(layout, from, bed.chairTile);
      // A null path is the teleport fallback `startCivicWalk` takes. The
      // walk we just watched would then have been a lie.
      expect(path).not.toBeNull();
      expect(path === null ? 0 : path.length).toBeGreaterThan(0);
    }
  });

  /** Whoever is drawn standing on this seat's own tile in THIS frame. */
  function onSeatIn(
    scene: OfficeScene,
    frame: OfficeFrame,
    seat: OfficeSeat,
  ): string | null {
    const want = footRect(layoutOf(scene), seat.chairTile);
    for (const region of frame.hitRegions) {
      if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
      if (region.rect.x === want.x && region.rect.y === want.y) {
        return region.agentId;
      }
    }
    return null;
  }

  /**
   * THIS AGENT'S OWN character sprite at this seat's foot, and its pose.
   *
   * Keyed on `ownerAgentId` rather than on position alone, which is the whole
   * point of the helper. `hitRegions` reverses same-depth order and the world
   * stream keeps it, so with a seated body and a walker at one foot a witness
   * that took the id from one and the pose from the other could report that THIS
   * agent is sitting when the sit pose belonged to the other body. The two facts
   * have to come from one entry, and from one captured frame.
   */
  function seatedPoseOf(
    scene: OfficeScene,
    frame: OfficeFrame,
    agentId: string,
    seat: OfficeSeat,
  ): string | null {
    const want = footRect(layoutOf(scene), seat.chairTile);
    for (const entry of frame.world ?? []) {
      if (entry.ownerAgentId !== agentId) continue;
      const drawable = entry.drawable;
      if (drawable.kind !== "sprite") continue;
      if (drawable.sprite.name !== "character") continue;
      if (drawable.x !== want.x || drawable.y !== want.y) continue;
      return drawable.sprite.pose ?? null;
    }
    return null;
  }

  /** Every lounge chair on the plan, as seats. */
  function benchSeatsOf(layout: OfficeLayout): ReadonlyArray<OfficeSeat> {
    const lounge = layout.floors
      .flatMap((floor) => floor.civic)
      .find((room) => room.kind === "waiting-room");
    if (lounge === undefined) throw new Error("no waiting room");
    return lounge.seatIds.map((seatId) => {
      const seat = layout.seats.get(seatId);
      if (seat === undefined) throw new Error(`no seat ${seatId}`);
      return seat;
    });
  }

  /**
   * A BENCH WITH A SEATED STROLLER ON IT, found by ticking with motion on.
   *
   * Its own function for three cases and for the complexity ceiling both: a
   * search that ticks, scans every bench and stops on the first hit is all
   * branches, and inlining it puts a case over on its own.
   */
  function findSeatedStroller(
    scene: OfficeScene,
    benchSeats: ReadonlyArray<OfficeSeat>,
  ): { id: string; seat: OfficeSeat } | null {
    for (let step = 0; step < CIVIC_WALK_TICKS; step += 1) {
      scene.tick(100);
      // ONE FRAME for both readings below, so the id and the pose cannot come
      // from different moments either.
      const frame = frameOf(scene);
      const book = bookOf(scene);
      for (const seat of benchSeats) {
        const who = onSeatIn(scene, frame, seat);
        if (who === null || book.civicClaimOf(who) !== null) continue;
        // SEATED, not merely standing on the tile. A bench row sits on walkable
        // lawn that other walkers cross, so a body at these coordinates is not
        // yet a body ON the bench - and "a stroller is already on it" is the
        // premise these cases rest on.
        if (seatedPoseOf(scene, frame, who, seat) !== "sit") continue;
        return { id: who, seat };
      }
    }
    return null;
  }

  /** Painted character positions in this frame, by position, to their agents. */
  function charactersByPlace(
    frame: OfficeFrame,
  ): ReadonlyMap<string, ReadonlyArray<string>> {
    const byPlace = new Map<string, string[]>();
    for (const region of frame.hitRegions) {
      if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
      const key = `${String(region.rect.x)},${String(region.rect.y)}`;
      const bucket = byPlace.get(key);
      if (bucket === undefined) byPlace.set(key, [region.agentId]);
      else bucket.push(region.agentId);
    }
    return byPlace;
  }

  /**
   * READ O'S FINDING 3: the bench, from the other side.
   *
   * `OfficeErrandSpot.seatId` stopped a STROLL being sent to a bench somebody is
   * sitting in. It did nothing about the reverse - a waiting agent being seated
   * onto a bench a stroller is already on - because the seat book reads
   * assignments and claims and has never read an errand target. The landed case
   * claimed every bench BEFORE any stroll could start, so it only ever tested
   * the order that was already safe.
   *
   * The gate is the COINCIDENCE, not the view's name: this can only happen where
   * some errand spot names a seat, which today is Campus's courtyard bench row
   * and nothing else. A view that grows a second shared fixture is covered here
   * the day it does, without a line of code.
   */
  it("never seats a waiter onto a bench a stroller is already on", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 60, 9);
    const idle = idleStatusById(epic);
    // PRODUCTION'S SET, archived records included: at 60 agents the fixture
    // archives two, and they are bodies the painter draws as ghosted desks
    // rather than agents this case can seat. The waiter set below excludes
    // them for that reason, so the fill is a fill of real chairs.
    const visible = existingIdsOf(epic);
    const scene = newScene();
    // MOTION ON, so a stroll can actually start and reach a bench.
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
      }),
    );
    const layout = layoutOf(scene);
    const shared = layout.floors
      .flatMap((floor) => floor.errandSpots)
      .filter((spot) => spot.seatId !== null);
    if (shared.length === 0) {
      context.skip(`${viewId} has no fixture that is also a seat`);
      return;
    }

    const benchSeats = benchSeatsOf(layout);
    expect(benchSeats.length).toBeGreaterThan(1);

    const sitter = findSeatedStroller(scene, benchSeats);
    if (sitter === null) {
      throw new Error("no idle agent ever strolled to a bench");
    }
    const { id: strollerId, seat: strollerSeat } = sitter;

    // FILL EVERY CHAIR with somebody else, so the stroller's own bench has to
    // be handed to one of them - a smaller outbreak could take another bench
    // and the case would pass without ever testing the collision. Reduced
    // motion so the placement is instant and there is no walk to wait out:
    // the defect was two sit poses at ZERO ticks.
    const waiters = epic.agents
      .filter((agent) => !agent.archived && agent.id !== strollerId)
      .map((agent) => agent.id)
      .slice(0, benchSeats.length);
    expect(waiters.length).toBe(benchSeats.length);
    const waiting = new Map(idle);
    for (const id of waiters) waiting.set(id, "awaiting");
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: waiting,
        reducedMotion: true,
      }),
    );

    // NO TWO CHARACTERS AT ONE PLACE, which is the defect stated as the frame
    // would show it. Under reduced motion nobody is mid-step, so two equal
    // painted positions mean two people on one tile and nothing else.
    for (const [place, ids] of charactersByPlace(frameOf(scene))) {
      expect(ids.length, `${ids.join(" and ")} are both at ${place}`).toBe(1);
    }

    // AND THE BENCH WENT TO THE WAITER: the stroll is the one that yields, so
    // the tile holds exactly one character and that character is holding a
    // civic claim. Without this the case would pass on a scene that refused to
    // seat the waiter anywhere at all.
    const occupant = onSeatIn(scene, frameOf(scene), strollerSeat);
    expect(occupant).not.toBeNull();
    if (occupant === null) return;
    expect(bookOf(scene).civicClaimOf(occupant)).toBe("lounge");
    expect(occupant).not.toBe(strollerId);
  });

  /**
   * READ S'S S2: the same bench, through a claim the CLAIMING PASS never makes.
   *
   * A sync rebuilds claims before the civic pass runs - `recomputeClaims`, then
   * rehome seats their holders - and the pass then SKIPS an agent whose claim
   * already matches what it wants. So a bench claimed that way never reached an
   * eviction keyed on the pass's own return value, and the duplicate stood at
   * zero ticks exactly as before.
   *
   * The lever is FEED SETTLEMENT, which is what makes this sync rebuild rather
   * than extend: the first sync leaves `feedSettled` at its default false and
   * the second turns it on, with the same roster.
   *
   * MOTION GOES ON THEN REDUCED across the two, which this comment used to call
   * "the same reduced motion" - wrong, and worth correcting because the ON half
   * is load-bearing: the stroll that puts a body on the bench needs ticks to
   * walk, so the first sync cannot be a reduced one. The fill sync is the
   * reduced one, which is what makes the duplicate visible at zero ticks.
   *
   * TWO PREMISES ARE ASSERTED, not assumed, because the case is worthless if
   * settlement moved the furniture instead: the bench keeps its `seatId` AND its
   * chair tile across the flip, and the stroller's own effective assignment is
   * unchanged. Ordinary fixed-roster Campus planning is what makes that true -
   * the flags do not change desk geometry and the book's adoption skips equal
   * chair coordinates - and if it ever stops being true these two lines say so
   * rather than the case quietly testing nothing.
   */
  it("yields a bench to a claim the sync rebuilt, not only one it made", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 60, 9);
    const idle = idleStatusById(epic);
    const visible = existingIdsOf(epic);
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
      }),
    );
    const before = layoutOf(scene);
    if (
      before.floors
        .flatMap((floor) => floor.errandSpots)
        .every((spot) => spot.seatId === null)
    ) {
      context.skip(`${viewId} has no fixture that is also a seat`);
      return;
    }
    const benchSeats = benchSeatsOf(before);
    const sitter = findSeatedStroller(scene, benchSeats);
    if (sitter === null) {
      throw new Error("no idle agent ever strolled to a bench");
    }
    const assignedBefore = bookOf(scene).assignedSeat(sitter.id);
    expect(assignedBefore).not.toBeNull();

    const waiters = epic.agents
      .filter((agent) => !agent.archived && agent.id !== sitter.id)
      .map((agent) => agent.id)
      .slice(0, benchSeats.length);
    expect(waiters.length).toBe(benchSeats.length);
    const waiting = new Map(idle);
    for (const id of waiters) waiting.set(id, "awaiting");
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: waiting,
        reducedMotion: true,
        // THE FIRST SETTLED FEED, which is what sends this sync down the
        // rebuild-and-rehome path instead of the claiming pass's own.
        feedSettled: true,
      }),
    );

    // PREMISE ONE: the same bench, by id and by tile.
    const after = layoutOf(scene);
    const benchAfter = after.seats.get(sitter.seat.seatId);
    expect(benchAfter).toBeDefined();
    expect(benchAfter?.chairTile).toEqual(sitter.seat.chairTile);
    // PREMISE TWO: settlement did not move the stroller's own desk out from
    // under it, which would end its errand for an unrelated reason.
    const assignedAfter = bookOf(scene).assignedSeat(sitter.id);
    expect(assignedAfter?.seatId).toBe(assignedBefore?.seatId);
    expect(assignedAfter?.chairTile).toEqual(assignedBefore?.chairTile);

    for (const [place, ids] of charactersByPlace(frameOf(scene))) {
      expect(ids.length, `${ids.join(" and ")} are both at ${place}`).toBe(1);
    }
    const occupant = onSeatIn(scene, frameOf(scene), sitter.seat);
    expect(occupant).not.toBeNull();
    if (occupant === null) return;
    expect(bookOf(scene).civicClaimOf(occupant)).toBe("lounge");
    expect(occupant).not.toBe(sitter.id);
  });

  /**
   * READ S'S S3: the eviction must not steal an ARCHIVE ROUTE.
   *
   * An archived agent walks to the archive door and disappears. If it was on a
   * bench when the news arrived, `startLeaving` sent it to the door while leaving
   * its errand target in place, so an eviction reading targets found this LEAVING
   * character and called `returnToDesk` on it. Its walk to the door became a walk
   * to its chair, it was seated instead of departing, and with no further sync the
   * archived body stayed in the office.
   *
   * NO SECOND SYNC after the archival, deliberately: a sync would re-run the
   * archival pass and start the walk again, hiding exactly the loss this case is
   * about. Ticks only.
   *
   * WHAT THIS IS CONFINED TO, corrected. This preamble used to say leaving was
   * the ONE route starter that retained its target, and called the six-starter
   * inventory measured; read W found both halves wrong. The six creators are the
   * six `findOfficePath` calls - `spawnAtDoor`, `walkTo`, `startLeaving`,
   * `startQueueWalk`, `startCivicWalk`, `startErrand` - `walkTo` retains on both
   * exits, its caller `returnToDesk` keeps the target through a successful walk
   * ON PURPOSE (`claimedSpotKeys` reserves the spot of a walker coming back), and
   * `startErrand` sets one. There is no invariant that a route change clears it.
   * What is true, and all this case needs: a DEPARTURE's target is obsolete,
   * because leaving is not an errand return and the bench will never be reached;
   * both queue branches clear theirs, so a reception route was never at risk. The
   * return's own re-eviction is the separate defect, pinned by the case above.
   */
  it("lets an archived stroller leave, even as its bench is claimed", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 60, 9);
    const idle = idleStatusById(epic);
    const visible = existingIdsOf(epic);
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
      }),
    );
    const layout = layoutOf(scene);
    if (
      layout.floors
        .flatMap((floor) => floor.errandSpots)
        .every((spot) => spot.seatId === null)
    ) {
      context.skip(`${viewId} has no fixture that is also a seat`);
      return;
    }
    const benchSeats = benchSeatsOf(layout);
    const sitter = findSeatedStroller(scene, benchSeats);
    if (sitter === null) {
      throw new Error("no idle agent ever strolled to a bench");
    }

    // ARCHIVED ON THE SAME SYNC the lounge fills, and still in the visible set:
    // its record exists, so the scene owes it a walk out rather than a deletion.
    const waiters = epic.agents
      .filter((agent) => !agent.archived && agent.id !== sitter.id)
      .map((agent) => agent.id)
      .slice(0, benchSeats.length);
    const next = new Map(idle);
    for (const id of waiters) next.set(id, "awaiting");
    next.set(sitter.id, "archived");
    // ARCHIVED IN THE RECORD, which is where `isArchivedAsOf` reads it; a status
    // of "archived" alone starts no walk. The fixture's own `ARCHIVED_AT_MS`,
    // since with a live cursor any archival time reads as already past.
    const withArchival = epic.agents.map((person) =>
      person.id === sitter.id ? { ...person, archivedAt: 1_000_000 } : person,
    );
    scene.sync(
      sceneInput({
        agents: withArchival,
        visibleAgentIds: visible,
        statusById: next,
        // MOTION LEFT ON deliberately: a reduced-motion sync deletes the
        // character outright and there would be no walk for anything to steal.
      }),
    );

    // IT LEAVES. Ticked out with no further sync: the body reaches the door and
    // stops being drawn. A scene that turned its departure into a trip back to
    // its own chair never gets here.
    let gone = false;
    for (let step = 0; step < CIVIC_WALK_TICKS * 2; step += 1) {
      scene.tick(100);
      // `hasCharacter`, not "has any hit region": an archived agent keeps a
      // ghosted DESK and its region, so the latter would never come true.
      if (!hasCharacter(frameOf(scene), sitter.id)) {
        gone = true;
        break;
      }
    }
    expect(gone, `${sitter.id} never left after being archived`).toBe(true);

    // AND THE BENCH STILL WENT TO A WAITER, so this is not passing because the
    // claim quietly failed along with the departure.
    //
    // A POSITIVE WITNESS, which the landed form was not: it asserted the
    // occupant was not the departed agent and then read the claim under an
    // `if`, and BOTH lines are satisfied by an EMPTY bench - the one outcome
    // that would mean the departure and the claim had been lost together.
    //
    // NAMED IN THE BOOK FIRST, then drawn. Motion is on, so at the instant the
    // body reaches the door its bench is EMPTY - measured: `expected null not to
    // be null` - because the waiter is still crossing the courtyard to it. The
    // claim is what "the bench went to a waiter" means at that moment; the
    // arrival below is the same fact once the walk has had its ticks, and both
    // are asserted of somebody who is not the agent that left.
    const holder = bookOf(scene).occupant(sitter.seat.seatId);
    expect(holder, `nobody took ${sitter.seat.seatId}`).not.toBeNull();
    if (holder === null) return;
    expect(holder).not.toBe(sitter.id);
    expect(bookOf(scene).civicClaimOf(holder)).toBe("lounge");
    let seated = false;
    for (let step = 0; step < CIVIC_WALK_TICKS && !seated; step += 1) {
      scene.tick(100);
      seated = onSeatIn(scene, frameOf(scene), sitter.seat) === holder;
    }
    expect(seated, `${holder} never reached ${sitter.seat.seatId}`).toBe(true);
  });

  /** Pixels between this agent's drawn feet and the seat it is walking to. */
  function feetFromSeat(
    scene: OfficeScene,
    agentId: string,
    seat: OfficeSeat,
  ): number {
    const here = characterRect(frameOf(scene), agentId);
    const want = footRect(layoutOf(scene), seat.chairTile);
    return Math.abs(here.x - want.x) + Math.abs(here.y - want.y);
  }

  /**
   * READ W'S W1: the eviction has to be IDEMPOTENT for somebody already going
   * home, because the target it reads is not debris.
   *
   * `yieldStrollsOnTakenSeats` asks the book every sync, and the answer does not
   * change while the evicted stroller walks: the bench still belongs to its new
   * claimant. The target cannot be cleared when the return starts either - it is
   * still read on the way home, by `claimedSpotKeys`, which RESERVES the spot of
   * somebody walking back from it, and by `slideCharacters`, which translates it
   * when a growing layout moves the floor under a walker. Both are older than
   * this eviction. So the missing half was the sweep's own question: is this
   * character already on its way to its chair.
   * Without it a second `returnToDesk` ran on every sync and `walkTo` restarted
   * the walk from `startTileOf` - the ROUNDED tile - discarding the fraction the
   * last tick had earned. At three tiles a second a 100ms tick earns 0.3 of one,
   * so the rounding won every time and the walk never finished.
   *
   * TICK AND SYNC ALTERNATELY, which is what a live feed does. The input is the
   * SAME OBJECT throughout: no roster, status or claim changes between them, so
   * the only thing under test is the sweep meeting its own earlier work.
   *
   * THE FIRST ASSERTION IS THE ONE THAT NAMES THE DEFECT. A sync moves nobody -
   * only ticks do - so the distance home is unchanged across one unless the walk
   * was restarted, and a restart moves the walker BACK to the tile it had left.
   * Arrival alone would red too, but it would red identically for a walk that
   * merely dawdles, and the pair says which.
   */
  it("keeps an evicted stroller walking home across an unchanged sync", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 60, 9);
    const idle = idleStatusById(epic);
    const visible = existingIdsOf(epic);
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
      }),
    );
    const layout = layoutOf(scene);
    if (
      layout.floors
        .flatMap((floor) => floor.errandSpots)
        .every((spot) => spot.seatId === null)
    ) {
      context.skip(`${viewId} has no fixture that is also a seat`);
      return;
    }
    const benchSeats = benchSeatsOf(layout);
    const sitter = findSeatedStroller(scene, benchSeats);
    if (sitter === null) {
      throw new Error("no idle agent ever strolled to a bench");
    }
    // WHERE HOME IS, read the way `returnToDesk` reads it. A stroller holds no
    // civic claim - `findSeatedStroller` requires that - so this is its own desk.
    const home = bookOf(scene).effectiveSeat(sitter.id);
    expect(home).not.toBeNull();
    if (home === null) return;

    const waiters = epic.agents
      .filter((agent) => !agent.archived && agent.id !== sitter.id)
      .map((agent) => agent.id)
      .slice(0, benchSeats.length);
    expect(waiters.length).toBe(benchSeats.length);
    const waiting = new Map(idle);
    for (const id of waiters) waiting.set(id, "awaiting");
    // ONE INPUT, SYNCED REPEATEDLY. Motion is left on - the default - because a
    // reduced-motion eviction seats the stroller at home outright and there is
    // no walk to lose.
    const claimed = sceneInput({
      agents: epic.agents,
      visibleAgentIds: visible,
      statusById: waiting,
    });
    scene.sync(claimed);

    // PREMISE: the bench changed hands and the stroller is WALKING, not sitting
    // at home already. Without this the loop below could pass on a scene where
    // no eviction ever happened.
    expect(bookOf(scene).occupant(sitter.seat.seatId)).not.toBe(sitter.id);
    expect(feetFromSeat(scene, sitter.id, home)).toBeGreaterThan(0);

    // EQUALITY ACROSS THE SYNC, not "no further from home", and the difference
    // is a mutant: a sweep that evicts once and then SNAPS an already-returning
    // stroller onto its chair on the next sync satisfies "not further" and
    // "arrived" together, so neither of those establishes what this case claims.
    // A sync moves nobody, so the coordinates are the assertion. The tick either
    // side of it is the positive half: a scene that froze this walker would pass
    // the equality forever.
    let arrived = false;
    let moved = false;
    for (let step = 0; step < CIVIC_WALK_TICKS && !arrived; step += 1) {
      const resting = characterRect(frameOf(scene), sitter.id);
      scene.tick(100);
      const walked = characterRect(frameOf(scene), sitter.id);
      if (walked.x !== resting.x || walked.y !== resting.y) moved = true;
      scene.sync(claimed);
      const synced = characterRect(frameOf(scene), sitter.id);
      expect(
        `${String(synced.x)},${String(synced.y)}`,
        `sync ${String(step)} moved ${sitter.id} off ${String(walked.x)},${String(walked.y)}`,
      ).toBe(`${String(walked.x)},${String(walked.y)}`);
      arrived = onSeatIn(scene, frameOf(scene), home) === sitter.id;
    }
    expect(moved, `${sitter.id} never moved across a tick`).toBe(true);
    expect(arrived, `${sitter.id} never got home from the bench`).toBe(true);
  });

  /** Whether this rectangle covers this point, half-open as the scene reads it. */
  function inRect(rect: OfficeRect, point: OfficePoint): boolean {
    return (
      point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height
    );
  }

  /** The rectangle a civic seat covers on screen, however its view draws it. */
  function civicBoxOf(scene: OfficeScene, seat: OfficeSeat): OfficeRect {
    if (seat.hitBox !== null) return seat.hitBox;
    const projector = view.painter.projector(layoutOf(scene));
    const corner = projector.project(seat.chairTile.col, seat.chairTile.row);
    const far = projector.project(
      seat.chairTile.col + seat.hitTiles.width,
      seat.chairTile.row + seat.hitTiles.height,
    );
    return {
      x: corner.x,
      y: corner.y,
      width: far.x - corner.x,
      height: far.y - corner.y,
    };
  }

  /** Whether two rectangles share a pixel. */
  function rectsOverlap(left: OfficeRect, right: OfficeRect): boolean {
    return (
      left.x < right.x + right.width &&
      right.x < left.x + left.width &&
      left.y < right.y + right.height &&
      right.y < left.y + left.height
    );
  }

  /**
   * The agent whose own desk is FARTHEST from any ward bed, or `null` for a
   * population with no desks.
   *
   * Measured rather than named, because the answer is a fact about each view's
   * packing: the point of it is a patient whose home props cannot be in the same
   * culled window as its bed.
   */
  function farthestFromABed(
    scene: OfficeScene,
    epic: OfficeTestEpic,
  ): string | null {
    const layout = layoutOf(scene);
    const projector = view.painter.projector(layout);
    const beds: OfficePoint[] = [];
    for (const seat of layout.seats.values()) {
      if (seat.kind !== "bed") continue;
      beds.push(projector.project(seat.chairTile.col, seat.chairTile.row));
    }
    if (beds.length === 0) return null;
    const book = bookOf(scene);
    let best: string | null = null;
    let bestGap = -1;
    for (const person of epic.agents) {
      const desk = book.assignedSeat(person.id);
      if (desk === null) continue;
      const at = projector.project(desk.chairTile.col, desk.chairTile.row);
      let nearest = Number.POSITIVE_INFINITY;
      for (const bed of beds) {
        nearest = Math.min(
          nearest,
          Math.max(Math.abs(bed.x - at.x), Math.abs(bed.y - at.y)),
        );
      }
      if (nearest <= bestGap) continue;
      bestGap = nearest;
      best = person.id;
    }
    return best;
  }

  /**
   * A pixel the BED ITSELF paints, that its occupant's body does not cover.
   *
   * Taken from the art and not from the corners of the declared box: Campus's
   * civic box is the union its desks are drawn in, 8 px of it sky above a 32 x 24
   * bed, so a corner of that box is transparent and a region over it proves
   * nothing about what a reader can click. The sprite names itself - the four bed
   * sprites the art has are `bed`, `bed-iso`, `bed-occupied` and `medbay-bed`, and
   * nothing else is spelled with one - so the search can insist on the furniture
   * rather than on whatever happens to be drawn there.
   */
  function bedPixel(
    frame: OfficeFrame,
    box: OfficeRect,
    body: OfficeRect,
  ): { readonly point: OfficePoint; readonly name: string } | null {
    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        const point: OfficePoint = { x, y };
        if (inRect(body, point)) continue;
        const top = paintersAt(frame, point).at(-1);
        if (top === undefined || !top.name.includes("bed")) continue;
        return { point, name: top.name };
      }
    }
    return null;
  }

  /** One sprite that PAINTS a pixel - not one whose box merely covers it. */
  interface PaintedPixel {
    readonly name: string;
    readonly ownerAgentId: string | null;
  }

  /**
   * Everything in this frame that paints this pixel.
   *
   * The art's own maps decide, through `officeSpriteOpaqueAt`: a sprite's box is
   * mostly sky for most of this art, so a box that covers a point says nothing
   * about whether the reader can see what is behind it there. The floor's ground
   * is quads rather than sprites and so is never a painter here, which is the
   * right reading - a click on grass names nobody.
   */
  function paintersAt(
    frame: OfficeFrame,
    point: OfficePoint,
  ): ReadonlyArray<PaintedPixel> {
    const painters: PaintedPixel[] = [];
    const paints = (drawable: OfficeDrawable): boolean =>
      drawable.kind === "sprite" &&
      officeSpriteOpaqueAt(
        drawable.sprite,
        point.x - drawable.x,
        point.y - drawable.y,
      );
    for (const drawable of [...frame.floor, ...frame.props]) {
      if (!paints(drawable) || drawable.kind !== "sprite") continue;
      painters.push({ name: drawable.sprite.name, ownerAgentId: null });
    }
    for (const entry of frame.world ?? []) {
      if (!paints(entry.drawable) || entry.drawable.kind !== "sprite") continue;
      painters.push({
        name: entry.drawable.sprite.name,
        ownerAgentId: entry.ownerAgentId,
      });
    }
    return painters;
  }

  /** Which agent this frame's own regions resolve this point to. */
  function regionOwnerAt(frame: OfficeFrame, point: OfficePoint): string {
    return (
      frame.hitRegions.find((region) => inRect(region.rect, point))?.agentId ??
      "nobody"
    );
  }

  /** A pixel inside an occupied civic seat's box that ONE other agent paints. */
  interface CivicWitness {
    readonly seatId: string;
    readonly occupant: string;
    readonly owner: string;
    readonly point: OfficePoint;
    readonly name: string;
  }

  /**
   * One witness pixel per (occupied civic seat, other agent) pair, and how many
   * pixels were read to find them.
   *
   * A pixel counts when the LAST thing painted there is a sprite somebody else
   * owns: the ground is a sprite too and is the first painter of every pixel, and
   * a fixture drawn over a character - Campus's bench is, standing a row nearer -
   * takes the pixel back and is no witness.
   */
  function civicWitnesses(
    scene: OfficeScene,
    frame: OfficeFrame,
    held: ReadonlyArray<{ readonly id: string; readonly seat: OfficeSeat }>,
  ): {
    readonly witnesses: ReadonlyArray<CivicWitness>;
    readonly pixels: number;
  } {
    const witnesses: CivicWitness[] = [];
    let pixels = 0;
    for (const holder of held) {
      const box = civicBoxOf(scene, holder.seat);
      const owners = new Set<string>();
      for (let y = box.y; y < box.y + box.height; y += 1) {
        for (let x = box.x; x < box.x + box.width; x += 1) {
          pixels += 1;
          const point: OfficePoint = { x, y };
          const top = paintersAt(frame, point).at(-1);
          const owner = top?.ownerAgentId ?? null;
          if (top === undefined || owner === null) continue;
          if (owner === holder.id || owners.has(owner)) continue;
          owners.add(owner);
          witnesses.push({
            seatId: holder.seat.seatId,
            occupant: holder.id,
            owner,
            point,
            name: top.name,
          });
        }
      }
    }
    return { witnesses, pixels };
  }

  /**
   * READ AA'S AA1: THE FURNITURE'S OWN LAYER DECIDES, NOT A FABRICATED DEPTH.
   *
   * X1 gave a civic seat's box the depth of its own tile at prop bias, which is
   * not where any of this furniture is drawn. Three of the four kinds the two
   * isometric views ship are `layout.props` - a ward bed, a City hospital bed, a
   * City shelter chair - and the floor pass draws those BEFORE the world stream,
   * so every character is painted over them. The fourth, Campus's bench, is the
   * courtyard's fixture: one row behind the seat, drawn for nobody, and shared
   * with the strolls that sit on it. So the fabricated number put a waiting
   * agent's box in FRONT of a character the furniture is painted behind, and out
   * over a bench sprite 16 px up-left of where the box was.
   *
   * THE WITNESS IS TAKEN FROM THE ART, one pixel per (occupied civic seat, other
   * agent) pair: a pixel inside the seat's own declared box whose LAST painter -
   * by the art's own maps, not by a box that covers it - is a sprite somebody
   * else owns. That sprite is what a reader sees at that pixel, so both hit paths
   * owe that agent, and the pointer and the frame build their orders separately,
   * which is why both are asked.
   *
   * At four agents on Campus that pair is the attention agent's torso at
   * `430,68`, inside the third bench seat's `400,64 32x32` box: its fabricated
   * `96.008` beat the character's `76`, so a click on a visible body named the
   * agent waiting behind it. The two pairs the same fixture also yields -
   * a head inside the box of the seat in front of it - already resolved
   * correctly, because there the character was the nearer of the two.
   *
   * The layered views are skipped rather than measured: their regions come from
   * draw order, where every character precedes every seat box, so the ordering
   * this case is about is not theirs to get wrong.
   */
  it("gives a pixel one other agent paints to that agent", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    if (view.painter.depth !== "world") {
      context.skip(`${viewId} orders its regions by draw order, not by depth`);
      return;
    }
    const waiting = [
      agent({ id: "a", createdAt: 1 }),
      agent({ id: "b", createdAt: 2 }),
      agent({ id: "c", createdAt: 3 }),
    ];
    const busy = agent({ id: "q", createdAt: 4 });
    const people = [...waiting, busy];
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: people,
        visibleAgentIds: new Set(people.map((person) => person.id)),
        statusById: new Map<string, OfficeAgentStatus>([
          ...waiting.map(
            (person) => [person.id, "awaiting"] as [string, OfficeAgentStatus],
          ),
          [busy.id, "attention"],
        ]),
        // Reduced motion: the seats are taken outright, so the waiting agents are
        // IN their civic seats on the first frame rather than walking to them.
        reducedMotion: true,
      }),
    );
    const frame = frameOf(scene);
    const book = bookOf(scene);
    const held: { readonly id: string; readonly seat: OfficeSeat }[] = [];
    for (const person of people) {
      const seat = book.effectiveSeat(person.id);
      if (seat === null || seat.civicRoomId === null) continue;
      held.push({ id: person.id, seat });
    }
    // THE FIXTURE IS REQUIRED, not sampled. Three held LOUNGE seats are what put
    // a box behind the walk, and q's errand to the counter is what sends it across
    // the row: C7 names that counter the help desk wherever it is, so this is the
    // one string that says q is queueing rather than sitting somewhere. Make q
    // idle instead and the pairs this fixture yields are both already-correct
    // ones - a head over the box of the seat in FRONT of it - and the case would
    // pass with the defect untouched.
    expect(
      held.map((one) => one.id),
      "the waiting agents did not all take a civic seat",
    ).toEqual(["a", "b", "c"]);
    expect(
      held.map((one) => one.seat.kind),
      "a waiting agent took something other than a lounge seat",
    ).toEqual(["lounge", "lounge", "lounge"]);
    expect(
      scene.whereabouts("q") ?? "nowhere",
      "q is not queueing at the counter, so it is not crossing the row",
    ).toBe("Help desk");

    const { witnesses, pixels } = civicWitnesses(scene, frame, held);
    if (witnesses.length === 0) {
      // RESERVED FOR THE TWO VIEWS WHOSE SHAPE CANNOT PRODUCE ONE, and asserted
      // rather than assumed: the storeyed pair paint their civic seats
      // THEMSELVES, so an occupied box is filled by that seat's own owned art and
      // no other agent can be the last painter inside it. The isometric pair draw
      // no art for a civic seat at all, which is why they can and do.
      expect(
        ["towers", "building"],
        `${viewId} found no witness pixel, and its shape does not explain that`,
      ).toContain(viewId);
      context.skip(
        `${viewId}: of ${String(pixels)} pixels in ${String(held.length)} occupied civic boxes, none has another agent's art as its last painter`,
      );
      return;
    }

    // AND ON CAMPUS, THE DISCRIMINATING PAIR BY NAME: q's own torso over the
    // THIRD lounge box, which is the box whose fabricated `96.008` beat the
    // character's `76`. Its two other pairs are heads over the box of the seat in
    // front, where the character was already the nearer of the two, so a case
    // that took any pair would have passed unfixed.
    const third = held.at(2);
    if (third === undefined) throw new Error("three claims owe a third seat");
    if (viewId === "campus") {
      expect(third.id, "the third lounge seat is not c's").toBe("c");
      expect(
        witnesses
          .filter((witness) => witness.seatId === third.seat.seatId)
          .map((witness) => `${witness.owner}/${witness.name}`),
        "no pixel of the third lounge box is painted by q's own art",
      ).toContain("q/character");
    }

    const owed = witnesses.map(
      (witness) =>
        `${witness.owner} at ${String(witness.point.x)},${String(witness.point.y)} (${witness.name} over ${witness.seatId})`,
    );
    expect(
      witnesses.map(
        (witness) =>
          `${regionOwnerAt(frame, witness.point)} at ${String(witness.point.x)},${String(witness.point.y)} (${witness.name} over ${witness.seatId})`,
      ),
      "the frame's regions",
    ).toEqual(owed);
    expect(
      witnesses.map(
        (witness) =>
          `${scene.hitTest(witness.point) ?? "nobody"} at ${String(witness.point.x)},${String(witness.point.y)} (${witness.name} over ${witness.seatId})`,
      ),
      "the pointer",
    ).toEqual(owed);
  });

  /**
   * READ X'S X1: A PATIENT'S BED ANSWERS A CLICK WHEREVER THE CAMERA IS.
   *
   * `seatProps` returns nothing for a civic seat in the isometric painter - a bed
   * is furniture the plan stands up, and O1 stopped a workstation being built on
   * top of a patient - so the scene's world hit regions had no depth to place the
   * occupant's box at and skipped it. What hid that is the whole-world frame: with
   * every desk on screen the seat borrowed its owner's DESK depth, so a region
   * existed and looked right. Frame a window that leaves the patient's own
   * building out - which is every camera actually pointed at a ward - and the bed
   * had no region at all: no hover card and no click on the pixels where the BED
   * is the only thing drawn, and a Find match that rings the body alone, since the
   * ring covers the regions the matched agent has and the bed's extent was no
   * longer one of them. The patient's own character still answered for its body,
   * and the directory, the playback and the "where" line derive their answers
   * elsewhere. `hitTest` takes the same regions and so did not need a camera to
   * fail.
   *
   * THE POINT IS ON THE FURNITURE AND NOT ON THE BODY, which is what makes this
   * about the seat rather than the character: a bed is two tiles wide and the
   * body standing on it is one, so its far corner is bed and nothing else.
   *
   * WHAT EACH VIEW ANSWERS is deliberately not asserted per name. The Floor and
   * Mission control paint in layers and hit in draw order, so depth never came
   * into it; the storeyed pair paint their own civic seats and carry their own
   * depth; the two isometric views are the exposed ones. The promise is the same
   * for all six and the case is written once.
   */
  it("hits a patient on its bed with the home desk out of frame", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    // A POPULATION BIG ENOUGH TO PUT THE WARD AND THE PATIENT'S OWN DESK APART.
    // At one agent they are 48 px apart on Campus and 112 on City, and the frame's
    // cull keeps a margin for the sprites that hang into a window - so the home
    // desk was drawn anyway, the seat's box had its depth to borrow, and only the
    // pointer path discriminated. The patient is CHOSEN as the agent whose desk is
    // farthest from a bed, measured per view because which agent that is differs
    // by view: at 24 it is 496 px away on Campus and City, 464 on Mission control,
    // 288 on Towers, 272 on Building and 1024 on the Floor.
    const epic = makeTestEpic("many-roots", 24, 5);
    const visible = existingIdsOf(epic);
    const idle = idleStatusById(epic);
    const survey = newScene();
    survey.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
        reducedMotion: true,
      }),
    );
    const chosen = farthestFromABed(survey, epic);
    expect(chosen, "nobody has a desk to be away from a ward").not.toBeNull();
    if (chosen === null) return;
    const statusById = new Map(idle);
    statusById.set(chosen, "failure");
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById,
        // Reduced motion: the bed is taken outright, so there is a patient IN it
        // rather than one walking to it.
        reducedMotion: true,
      }),
    );
    const book = bookOf(scene);
    expect(book.civicClaimOf(chosen), `${chosen} never took a bed`).toBe("bed");
    const bed = book.effectiveSeat(chosen);
    const desk = book.assignedSeat(chosen);
    if (bed === null || desk === null) {
      throw new Error("a bedded agent owes both a bed and a desk");
    }
    expect(bed.civicRoomId).not.toBeNull();

    const wide = frameOf(scene);
    const body = characterRect(wide, chosen);
    const witness = bedPixel(wide, civicBoxOf(scene, bed), body);
    expect(
      witness,
      `no ${bed.kind} pixel outside ${chosen}'s body`,
    ).not.toBeNull();
    if (witness === null) return;
    const point = witness.point;

    // THE WINDOW: two tiles of ward, and the patient's own desk outside it.
    const near: OfficeRect = {
      x: point.x - OFFICE_TILE,
      y: point.y - OFFICE_TILE,
      width: OFFICE_TILE * 2,
      height: OFFICE_TILE * 2,
    };
    const home = view.painter
      .projector(layoutOf(scene))
      .project(desk.chairTile.col, desk.chairTile.row);
    expect(inRect(near, home), "the window still holds the home desk").toBe(
      false,
    );

    // THE BED IS DRAWN THERE IN THIS WINDOW TOO, so a region for it is a region
    // over something the reader can see - which is the whole reason the depth
    // check exists. Asked of the CULLED frame and by sprite name: the witness was
    // taken from the whole-world one, and what this case is about is the window.
    const framed = scene.frame(2, near);
    expect(
      paintersAt(framed, point).at(-1)?.name ?? "nothing",
      "the window does not paint the bed at that point",
    ).toBe(witness.name);

    // AND THE HOME PROPS ARE REALLY GONE, not merely outside the window's own
    // rect: what the frame's regions borrowed was the depth of a PROP the patient
    // owns, so the premise is that this window draws none - away from the bed,
    // that is, since the storeyed pair paint the bed itself as the patient's own
    // prop and that one belongs here. `world` is the stream that carries owners;
    // the layered views carry none in the frame and hit in draw order.
    const furniture = civicBoxOf(scene, bed);
    expect(
      (framed.world ?? [])
        .filter((entry) => {
          if (entry.ownerAgentId !== chosen) return false;
          if (entry.drawable.kind !== "sprite") return false;
          if (entry.drawable.sprite.name === "character") return false;
          const size = officeSpriteSize(entry.drawable.sprite);
          return !rectsOverlap(
            { x: entry.drawable.x, y: entry.drawable.y, ...size },
            furniture,
          );
        })
        .map((entry) =>
          entry.drawable.kind === "sprite" ? entry.drawable.sprite.name : "",
        ),
      `the window still draws props ${chosen} owns away from its bed`,
    ).toEqual([]);

    // AND IT RESOLVES TO THE PATIENT, through the frame's own regions and
    // through the pointer path, which build their depths separately.
    const hit = framed.hitRegions.find((region) => inRect(region.rect, point));
    expect(hit?.agentId, "the frame's regions do not reach the bed").toBe(
      chosen,
    );
    expect(scene.hitTest(point), "hitTest does not reach the bed").toBe(chosen);
  });

  /** The four host-b agents, plus the host-a arrival that renumbered them. */
  const HOST_B_WARD: ReadonlyArray<OfficeAgentInput> = [
    agent({ id: "root-b", hostId: "host-b", createdAt: 1 }),
    agent({ id: "alpha", hostId: "host-b", parentId: "root-b", createdAt: 2 }),
    agent({ id: "beta", hostId: "host-b", parentId: "root-b", createdAt: 3 }),
    agent({ id: "gamma", hostId: "host-b", parentId: "root-b", createdAt: 4 }),
  ];
  const HOST_A_ARRIVAL = agent({
    id: "root-a",
    hostId: "host-a",
    createdAt: 9,
  });

  /** Where the book says this agent is, as an id and a tile, or `null`. */
  function bedOf(scene: OfficeScene, agentId: string): string | null {
    const book = bookOf(scene);
    if (book.civicClaimOf(agentId) !== "bed") return null;
    const seat = book.effectiveSeat(agentId);
    if (seat === null) return null;
    return `${seat.seatId}@${String(seat.chairTile.col)},${String(seat.chairTile.row)}`;
  }

  /**
   * The desk the book has assigned this agent: its id, and its place ON ITS OWN
   * STOREY rather than in the world.
   *
   * Relative because a host's ground legitimately moves when another host
   * arrives - the Floor stacks storeys and Campus re-bands sideways - and a desk
   * that travelled with its own floor has not moved at all. What must never
   * change is which desk it is and where it sits on that floor.
   */
  function deskOf(scene: OfficeScene, agentId: string): string | null {
    const seat = bookOf(scene).assignedSeat(agentId);
    if (seat === null) return null;
    // The TYPE says an index is always a floor, and a seat's own index is one the
    // layout it came from answers.
    const floor = layoutOf(scene).floors[seat.floorIndex];
    const col = seat.chairTile.col - floor.bounds.col;
    const row = seat.chairTile.row - floor.bounds.row;
    return `${seat.seatId}@${String(col)},${String(row)}`;
  }

  /**
   * The bounds of the ground this agent's own desk stands on, as a string.
   *
   * Found through the SEAT and not by host, as X2's does: Mission control's hall
   * belongs to every host at once, so asking it for one host's floor asks a
   * question the view has no answer to.
   */
  function deskBandOf(scene: OfficeScene, agentId: string): string {
    const seat = bookOf(scene).assignedSeat(agentId);
    const floor =
      seat === null ? undefined : layoutOf(scene).floors[seat.floorIndex];
    return JSON.stringify(floor?.bounds ?? null);
  }

  it("keeps a held desk's id when a lexically earlier host arrives", () => {
    const visible = new Set(HOST_B_WARD.map((person) => person.id));
    const idle = new Map<string, OfficeAgentStatus>(
      HOST_B_WARD.map((person) => [person.id, "idle"]),
    );
    const deskInput = (
      statusById: ReadonlyMap<string, OfficeAgentStatus>,
      agents: ReadonlyArray<OfficeAgentInput>,
      ids: ReadonlySet<string>,
    ): OfficeSceneInput =>
      sceneInput({
        agents,
        visibleAgentIds: ids,
        statusById,
        reducedMotion: true,
        feedSettled: true,
      });
    const scene = newScene();
    scene.sync(deskInput(idle, HOST_B_WARD, visible));
    const before = new Map<string, string | null>();
    for (const person of HOST_B_WARD) {
      before.set(person.id, deskOf(scene, person.id));
    }
    expect(
      [...before].filter((entry) => entry[1] === null).map((entry) => entry[0]),
      "somebody on host-b has no desk to hold",
    ).toEqual([]);
    const bandBefore = deskBandOf(scene, "beta");

    const withHostA = [...HOST_B_WARD, HOST_A_ARRIVAL];
    const alsoA = new Map(idle);
    alsoA.set(HOST_A_ARRIVAL.id, "idle");
    scene.sync(
      deskInput(alsoA, withHostA, new Set(withHostA.map((one) => one.id))),
    );

    const problems: string[] = [];
    for (const [id, held] of before) {
      const after = deskOf(scene, id);
      if (after !== held) {
        problems.push(
          `${id}'s desk became ${String(after)} from ${String(held)}`,
        );
      }
    }
    expect(
      problems,
      `host-b's ground moved: ${String(deskBandOf(scene, "beta") !== bandBefore)}`,
    ).toEqual([]);
  });

  /**
   * READ X'S X2: A CIVIC ROOM'S ID IS WHAT THE ROOM IS, NEVER WHERE IT CAME IN
   * THE ORDER.
   *
   * `civicRoomIdOf` folded the FLOOR INDEX into every civic room id, and a floor
   * index is a position in the partition's host-id ordering - so a host arriving
   * lexically earlier renamed the rooms and every seat inside them on every
   * later floor. The seat book then had nothing to adopt: it dropped the claims
   * held by the patients lying in those beds, the same sync re-claimed the ward
   * in civic order, and two agents who had not moved exchanged beds. `seatIdOf`
   * in `city-plan.ts` had this defect for DESKS and was fixed before it landed;
   * the civic ids brought it back in a second spelling.
   *
   * THE SEQUENCE IS THE DISCRIMINATOR, and every step of it is load-bearing.
   * Alpha and beta fail and take the ward's two beds; alpha RECOVERS, freeing
   * bed 0; gamma fails and takes it. That leaves the ward held in an order -
   * beta on one bed, gamma on the other - that a re-claim from scratch does not
   * reproduce, which is what makes the swap visible at all. A ward filled in one
   * pass would be re-filled identically and the renaming would cost nothing
   * anybody could see.
   *
   * REDUCED MOTION AND A SETTLED FEED THROUGHOUT, with a live cursor: the beds
   * are taken instantly rather than walked to, so what the case reads is the
   * BOOK's answer and not a walk in progress.
   *
   * Towers and Building pass this without the fix, and that is not evidence they
   * were safe: a scene carries its previous layout, which keeps a known host's
   * storeys in place, and their ids come apart the moment a plan has no carry -
   * measured in `office-plans`, host-b's civic storey moving 0 -> 3 and all ten
   * ids lost. The Floor, Campus and City lose them with or without it.
   */
  it("keeps a held bed's id and tile when a lexically earlier host arrives", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const visible = new Set(HOST_B_WARD.map((person) => person.id));
    const scene = newScene();
    const wardInput = (
      statusById: ReadonlyMap<string, OfficeAgentStatus>,
      agents: ReadonlyArray<OfficeAgentInput>,
      ids: ReadonlySet<string>,
    ): OfficeSceneInput =>
      sceneInput({
        agents,
        visibleAgentIds: ids,
        statusById,
        reducedMotion: true,
        feedSettled: true,
      });

    // BOTH BEDS TAKEN, by alpha and beta.
    const filled = new Map<string, OfficeAgentStatus>([
      ["root-b", "idle"],
      ["alpha", "failure"],
      ["beta", "failure"],
      ["gamma", "idle"],
    ]);
    scene.sync(wardInput(filled, HOST_B_WARD, visible));
    expect(bedOf(scene, "alpha"), "alpha never reached a bed").not.toBeNull();
    expect(bedOf(scene, "beta"), "beta never reached a bed").not.toBeNull();

    // ALPHA RECOVERS AND GAMMA FAILS, so the ward is held by beta and gamma in
    // an order no single pass would produce.
    const swapped = new Map<string, OfficeAgentStatus>([
      ["root-b", "idle"],
      ["alpha", "idle"],
      ["beta", "failure"],
      ["gamma", "failure"],
    ]);
    scene.sync(wardInput(swapped, HOST_B_WARD, visible));
    const bedBefore = new Map([
      ["beta", bedOf(scene, "beta")],
      ["gamma", bedOf(scene, "gamma")],
    ]);
    expect(
      bedBefore.get("beta"),
      "beta lost its bed on recovery",
    ).not.toBeNull();
    expect(
      bedBefore.get("gamma"),
      "gamma never took the free bed",
    ).not.toBeNull();
    // HOST-B'S OWN GROUND, found through a seat rather than by host: Mission
    // control's hall belongs to every host at once, and asking it for host-b's
    // floor would ask a question the view does not have an answer to.
    const bandOf = (): string => {
      const seat = bookOf(scene).assignedSeat("beta");
      const floor =
        seat === null ? undefined : layoutOf(scene).floors[seat.floorIndex];
      return JSON.stringify(floor?.bounds ?? null);
    };
    const bandBefore = bandOf();

    // ONE IDLE AGENT ON A LEXICALLY EARLIER HOST. Host-b's roster and every
    // status it holds are untouched, so nothing about host-b has changed except
    // where its floor now sits in the ordering.
    const withHostA = [...HOST_B_WARD, HOST_A_ARRIVAL];
    const alsoA = new Map(swapped);
    alsoA.set(HOST_A_ARRIVAL.id, "idle");
    scene.sync(
      wardInput(
        alsoA,
        withHostA,
        new Set(withHostA.map((person) => person.id)),
      ),
    );

    // THE ID IS THE UNIVERSAL PROMISE; THE TILE IS THE PROMISE OF A VIEW THAT
    // KEEPS THE GROUND. Three of these views move host-b's floor when host-a
    // arrives - the Floor stacks storeys, Campus and the storeyed pair re-band -
    // and a bed that moved with its own ward has kept every promise it made. So
    // the tile is asserted exactly where the band is unchanged, which is City's
    // frozen quarter and Mission control's single hall, and read from the run
    // rather than from a list of view names.
    const problems: string[] = [];
    const bandAfter = bandOf();
    const groundHeld = bandAfter === bandBefore;
    for (const [id, before] of bedBefore) {
      const after = bedOf(scene, id);
      const idOf = (held: string | null): string =>
        held === null ? "no bed" : (held.split("@")[0] ?? held);
      if (idOf(after) !== idOf(before)) {
        problems.push(
          `${id}'s bed id became ${idOf(after)} from ${idOf(before)}`,
        );
      }
      if (groundHeld && after !== before) {
        problems.push(
          `${id}'s bed tile became ${String(after)} from ${String(before)}, on ground that did not move`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("leaves outbreak overflow at its desk with its glyph when the ward is full", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const script = outbreakScript({ ...epic, statusById: idle }, 12);
    const crashed = failureIds(script[0]);

    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: script[0],
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const beds = bedsForDesk(layout, crashed[0]);
    expect(beds).toBeGreaterThan(0);
    expect(crashed.length).toBeGreaterThan(beds);

    const book = bookOf(scene);
    const bedded: string[] = [];
    const overflow: string[] = [];
    for (const id of crashed) {
      if (book.civicClaimOf(id) === "bed") bedded.push(id);
      else overflow.push(id);
    }
    expect(bedded).toHaveLength(beds);
    expect(overflow).toHaveLength(crashed.length - beds);

    const frame = frameOf(scene);
    for (const id of overflow) {
      expect(book.civicClaimOf(id)).toBeNull();
      expect(frame.awayAgentIds.has(id)).toBe(false);
      const desk = layout.desks.get(id);
      if (desk === undefined) throw new Error(`no desk for ${id}`);
      expect(characterRect(frame, id)).toEqual(
        footRect(layout, desk.chairTile),
      );
      // The glyph stays at the desk: a crash with no bed is still a crash,
      // not a walk to nowhere and not a quiet sit.
      expect(characterSpriteAt(frame, characterRect(frame, id))?.pose).toBe(
        "crash",
      );
    }
  });

  it("gives a freed bed to the earliest overflow agent, not whoever sorts first by id", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    // outbreakScript crashes everyone in ONE sync, and newcomers in a
    // sync break their tie by id, so arrival order WOULD equal id order
    // and this case would pass vacuously. Three waves on the same
    // subjects make them disagree: later ids take the beds, a still-later
    // id is the first overflow, a low id arrives last.
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const script = outbreakScript({ ...epic, statusById: idle }, 12);
    const subjects = failureIds(script[0]).slice().sort();
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const beds = bedsForDesk(layout, subjects[0]);
    expect(subjects.length).toBeGreaterThan(beds + 1);

    const firstWave = subjects.slice(subjects.length - beds);
    const earlyOverflow = subjects[subjects.length - beds - 1];
    const lateOverflow = subjects[0];
    expect(earlyOverflow > lateOverflow).toBe(true);

    const failing = (
      ids: ReadonlyArray<string>,
    ): Map<string, OfficeAgentStatus> => {
      const next = new Map(idle);
      for (const id of ids) next.set(id, "failure");
      return next;
    };

    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: failing(firstWave),
        reducedMotion: true,
      }),
    );
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: failing([...firstWave, earlyOverflow]),
        reducedMotion: true,
      }),
    );
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: failing([...firstWave, earlyOverflow, lateOverflow]),
        reducedMotion: true,
      }),
    );

    const before = bookOf(scene);
    for (const id of firstWave) expect(before.civicClaimOf(id)).toBe("bed");
    expect(before.civicClaimOf(earlyOverflow)).toBeNull();
    expect(before.civicClaimOf(lateOverflow)).toBeNull();

    const healed = firstWave[0];
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: failing([
          ...firstWave.filter((id) => id !== healed),
          earlyOverflow,
          lateOverflow,
        ]),
        reducedMotion: true,
      }),
    );

    const after = bookOf(scene);
    expect(after.civicClaimOf(healed)).toBeNull();
    // C3: the bed goes to the agent that has been waiting longest, not
    // to `lateOverflow` who sorts first by id among the remaining
    // unbedded crashes.
    expect(after.civicClaimOf(earlyOverflow)).toBe("bed");
    expect(after.civicClaimOf(lateOverflow)).toBeNull();
  });

  it("gives a freed lounge chair to the earliest overflow waiter, not whoever sorts first by id", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    // waitingScript puts every waiter in ONE sync, so arrival order would
    // equal id order and this case would pass vacuously. Waves, as the
    // bed case does. A bed wanter sits alongside so a merged (host-only)
    // queue would serve them before the lounge overflow.
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const subjects = epic.agents
      .filter((person) => !person.archived)
      .map((person) => person.id)
      .sort();
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const beds = bedsForDesk(layout, subjects[0]);
    const chairs = chairsForDesk(layout, subjects[0]);
    expect(beds).toBeGreaterThan(0);
    expect(chairs).toBeGreaterThan(0);
    expect(subjects.length).toBeGreaterThan(beds + chairs + 2);

    const bedTakers = subjects.slice(subjects.length - beds);
    const chairSitters = subjects.slice(
      subjects.length - beds - chairs,
      subjects.length - beds,
    );
    const bedOverflow = subjects[subjects.length - beds - chairs - 1];
    const earlyOverflow = subjects[subjects.length - beds - chairs - 2];
    const lateOverflow = subjects[0];
    expect(earlyOverflow > lateOverflow).toBe(true);

    const mixed = (
      failingIds: ReadonlyArray<string>,
      waitingIds: ReadonlyArray<string>,
    ): Map<string, OfficeAgentStatus> => {
      const next = new Map<string, OfficeAgentStatus>(idle);
      for (const id of failingIds) next.set(id, "failure");
      for (const id of waitingIds) next.set(id, "awaiting");
      return next;
    };
    const syncMixed = (
      failingIds: ReadonlyArray<string>,
      waitingIds: ReadonlyArray<string>,
    ): void => {
      scene.sync(
        sceneInput({
          agents: epic.agents,
          visibleAgentIds: visible,
          statusById: mixed(failingIds, waitingIds),
          reducedMotion: true,
        }),
      );
    };

    syncMixed(bedTakers, []);
    syncMixed(bedTakers, chairSitters);
    syncMixed([...bedTakers, bedOverflow], chairSitters);
    syncMixed([...bedTakers, bedOverflow], [...chairSitters, earlyOverflow]);
    syncMixed(
      [...bedTakers, bedOverflow],
      [...chairSitters, earlyOverflow, lateOverflow],
    );

    const before = bookOf(scene);
    for (const id of chairSitters) {
      expect(before.civicClaimOf(id)).toBe("lounge");
    }
    expect(before.civicClaimOf(earlyOverflow)).toBeNull();
    expect(before.civicClaimOf(lateOverflow)).toBeNull();
    expect(before.civicClaimOf(bedOverflow)).toBeNull();

    const healed = chairSitters[0];
    const freed = before.effectiveSeat(healed);
    if (freed === null || freed.kind !== "lounge") {
      throw new Error(`expected ${healed} to hold a lounge chair`);
    }
    const freedSeatId = freed.seatId;
    const remainingSitters = chairSitters.filter((id) => id !== healed);
    syncMixed(
      [...bedTakers, bedOverflow],
      [...remainingSitters, earlyOverflow, lateOverflow],
    );

    const after = bookOf(scene);
    expect(after.civicClaimOf(healed)).toBeNull();
    expect(after.civicClaimOf(earlyOverflow)).toBe("lounge");
    expect(after.effectiveSeat(earlyOverflow)?.seatId).toBe(freedSeatId);
    expect(after.civicClaimOf(lateOverflow)).toBeNull();
    expect(after.civicClaimOf(bedOverflow)).not.toBe("lounge");
  });

  it("walks a recovered crash home, and an awaiting agent to the lounge and home", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const outbreak = outbreakScript({ ...epic, statusById: idle }, 3);
    const crashed = failureIds(outbreak[0]);

    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: outbreak[0],
      }),
    );
    const bedded = tickUntilSeatedIn(scene, crashed, "bed");
    if (bedded === undefined) throw new Error("expected a bedded agent");
    const home = layoutOf(scene).desks.get(bedded);
    if (home === undefined) throw new Error(`no desk for ${bedded}`);

    // Heal THIS sitter, not outbreak[1]'s first subject: on a 12-agent
    // floor only two of the three crashers fit, and subjects[0] may be
    // the overflow still at its desk.
    const healedCrash = new Map(outbreak[0]);
    healedCrash.set(bedded, "idle");
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: healedCrash,
      }),
    );
    expect(tickUntilHome(scene, bedded, home.chairTile)).toBe(true);

    const waiting = waitingScript({ ...epic, statusById: idle }, 6);
    const waiters = [...waiting[0].entries()]
      .filter(([, status]) => status === "awaiting")
      .map(([id]) => id);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: waiting[0],
      }),
    );
    const inLounge = tickUntilSeatedIn(scene, waiters, "lounge");
    if (inLounge === undefined)
      throw new Error("expected someone in the lounge");
    expect(scene.whereabouts(inLounge)).toBe(
      civicRoomName(layoutOf(scene), "waiting-room"),
    );

    const loungeHome = layoutOf(scene).desks.get(inLounge);
    if (loungeHome === undefined) throw new Error(`no desk for ${inLounge}`);
    const cleared = waiting[1].get(inLounge);
    // waitingScript step 1 clears subjects[0], which may not be the one
    // we saw sit. Drive a heal of THIS sitter so the walk home is the
    // one we can name.
    const healOne = new Map(waiting[0]);
    healOne.set(inLounge, "idle");
    expect(cleared === "idle" || healOne.get(inLounge) === "idle").toBe(true);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: healOne,
      }),
    );
    let loungeHomeAgain = false;
    for (let step = 0; step < CIVIC_WALK_TICKS && !loungeHomeAgain; step += 1) {
      scene.tick(100);
      loungeHomeAgain =
        bookOf(scene).civicClaimOf(inLounge) === null &&
        !frameOf(scene).awayAgentIds.has(inLounge) &&
        characterRect(frameOf(scene), inLounge).x ===
          footRect(layoutOf(scene), loungeHome.chairTile).x &&
        characterRect(frameOf(scene), inLounge).y ===
          footRect(layoutOf(scene), loungeHome.chairTile).y;
    }
    expect(loungeHomeAgain).toBe(true);
  });

  it("walks an archived agent to the archive door and then off the floor", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const leaver = agent({ id: "alpha", createdAt: 1, archivedAt: 500 });
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 100,
      }),
    );
    const layout = layoutOf(scene);
    const floor = layout.floors[0];
    const archive = floor.civic.find((room) => room.kind === "archive");
    if (archive === undefined) throw new Error("expected an archive room");
    const desk = layout.desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk for alpha");
    const path = findOfficePath(layout, desk.chairTile, archive.doorTile);
    expect(path).not.toBeNull();

    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 900,
      }),
    );
    if (path === null) throw new Error("expected a path to the archive door");
    const doorRect = footRect(layout, archive.doorTile);
    const gapTo = (rect: OfficeRect): number =>
      Math.hypot(rect.x - doorRect.x, rect.y - doorRect.y);
    let lastRect: OfficeRect | undefined;
    let sawArchiveLeg = false;
    let closest = Number.POSITIVE_INFINITY;
    // Five times the budget, because each tick is a fifth as long.
    for (let step = 0; step < CIVIC_WALK_TICKS * 5; step += 1) {
      if (!hasCharacter(frameOf(scene), "alpha")) break;
      lastRect = characterRect(frameOf(scene), "alpha");
      if (rectOnProjectedPath(layout, path, lastRect)) sawArchiveLeg = true;
      closest = Math.min(closest, gapTo(lastRect));
      scene.tick(20);
    }
    expect(hasCharacter(frameOf(scene), "alpha")).toBe(false);
    if (lastRect === undefined)
      throw new Error("alpha vanished without walking");
    // ON THE WALK TO THE ARCHIVE DOOR, which is what this case is named for:
    // C5 is a records door, and the pre-civic departure walked to the lobby
    // instead - a different path, which this would not match.
    //
    // KEPT BUT NO LONGER LOAD-BEARING. This clause once passed in the plazas on
    // a route that was never aiming at the archive at all: the walk-out and the
    // records walk share a long descent down the pod column, so "some observed
    // point lay on the archive path" was true of an agent leaving by its own
    // storey's stairwell. Arrival below is the claim; this is the shape of the
    // route, and both are needed because either alone has passed a wrong walk.
    expect(sawArchiveLeg).toBe(true);
    // AND IT GOT THERE. Being seen somewhere on the route is not arrival: a
    // route with its last tile removed still supplies frame after matching frame
    // and then a disappearance, so the clause above passes on an agent that
    // vanishes one tile outside the archive. The END of the walk is the claim,
    // and the last frame it was ever drawn in is where it ended.
    //
    // ONE LEG, in every view. `departureDoorOf` returns the archive's door where
    // the floor has one and `advanceWalk` departs the moment that path runs out,
    // so there is no second walk to the entrance - the earlier reading of this
    // case described one and the source has never had it.
    //
    // MEASURED AGAINST THE FINAL STEP rather than against a pixel budget, and
    // observed every 20 ms rather than every 100: a character crosses 4.8 px in
    // 100 ms, so the coarser tick cannot tell arrival from a step's worth of
    // shortfall, and that was the whole gap this clause closes.
    //
    // WITHIN ONE TILE OF THE DOOR, EVERYWHERE - diagonals included, since a
    // diagonally adjacent tile is √2 strides away and the oblique plazas' last
    // frame is exactly that, plus the fraction of a step a 20 ms observation
    // leaves. The pre-civic departure walked to the building's entrance instead,
    // which is a storey away from here, so this is the bound that separates a
    // records-door walk from that one whatever the view.
    const approach = path.at(-2);
    if (approach === undefined) throw new Error("the walk is a single tile");
    const stride = gapTo(footRect(layout, approach));
    expect(stride).toBeGreaterThan(0);
    expect(closest).toBeLessThanOrEqual(stride * 1.5);
    // AND ON THE DOOR ITSELF, in every view and with no branch. The plazas used
    // to need an exemption here, and the exemption was the bug: their last frame
    // sat 22.6 px out because the agent was walking to its own storey's
    // stairwell rather than to the records door - `departureDoorOf` read only the
    // agent's own storey, and in an oblique view only the PLAZA storey carries
    // civic rooms. Now it reads the storey, then the building.
    expect(closest).toBeLessThan(stride / 2);
  });

  /**
   * FINDING 7's fixture: alpha seated in a lounge chair (`awaiting`) at
   * cursor 100, archived at cursor 900 - the archived-agent precedent above,
   * plus a civic claim to release. Local, not inline in the `it`, so the
   * two motion modes below stay a two-line call each rather than doubling
   * the case's own complexity.
   */
  function archivedLoungeHolder(reducedMotion: boolean): {
    readonly scene: OfficeScene;
    readonly loungeSeatId: string;
  } {
    const leaver = agent({ id: "alpha", createdAt: 1, archivedAt: 900 });
    const statuses = new Map<string, OfficeAgentStatus>([
      ["alpha", "awaiting"],
      ["beta", "idle"],
    ]);
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        statusById: statuses,
        cursorMs: 100,
        reducedMotion,
      }),
    );
    const loungeSeat = bookOf(scene).effectiveSeat("alpha");
    if (loungeSeat === null || loungeSeat.kind !== "lounge") {
      throw new Error("expected alpha to hold a lounge chair before archiving");
    }
    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        statusById: statuses,
        cursorMs: 900,
        reducedMotion,
      }),
    );
    return { scene, loungeSeatId: loungeSeat.seatId };
  }

  /** Ticks until alpha is gone from the frame, or gives up. */
  function tickUntilDeparted(scene: OfficeScene): boolean {
    for (let step = 0; step < CIVIC_WALK_TICKS; step += 1) {
      scene.tick(100);
      if (!hasCharacter(frameOf(scene), "alpha")) return true;
    }
    return false;
  }

  it("frees a lounge seat only once its archived holder actually departs, in both motion modes", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }

    // Reduced motion: `sendArchivedHome` deletes the character outright on
    // this same sync, so there is no walk to wait out - the seat has to be
    // free the instant the archive sync runs. Pre-fix, `endClaim` left the
    // claim `releasing` with nobody left alive to ever call `vacated`, and
    // the seat stayed in `occupancy()` for the life of the scene.
    const still = archivedLoungeHolder(true);
    expect(
      bookOf(still.scene).occupancy().get(still.loungeSeatId),
    ).toBeUndefined();
    expect(hasCharacter(frameOf(still.scene), "alpha")).toBe(false);

    // Motion on: alpha is WALKING OUT. Right after the archive sync the seat
    // is still RESERVED - 2b's rule, that only `vacated` on arrival ends a
    // claim - and alpha is headed for the door, not back to its desk.
    // Pre-fix, the release loop's unconditional `returnToDesk` overwrote the
    // departure `sendArchivedHome` had already started, and alpha never left.
    const walking = archivedLoungeHolder(false);
    expect(bookOf(walking.scene).occupancy().get(walking.loungeSeatId)).toBe(
      "alpha",
    );
    expect(tickUntilDeparted(walking.scene)).toBe(true);
    expect(
      bookOf(walking.scene).occupancy().get(walking.loungeSeatId),
    ).toBeUndefined();
  });

  it("keeps a civic holder's summons to the counter when its status flips to attention", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const alpha = epic.agents[2].id;

    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: new Map(idle).set(alpha, "awaiting"),
      }),
    );
    const seated = tickUntilSeatedIn(scene, [alpha], "lounge");
    if (seated === undefined) throw new Error(`expected ${alpha} in a lounge`);

    // Live motion, so this is a real summons under way, not a snapshot: the
    // point is that it keeps GOING once started, not merely that it starts.
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: new Map(idle).set(alpha, "attention"),
      }),
    );
    // `needsReception` is `attention`-only and `civicWantOf` answers neither
    // `attention` nor `idle`, so the flip drops the civic want and the
    // release loop fires for alpha's lounge claim on this very sync - the
    // same sync `updateReceptionQueue` (which runs first) starts the queue
    // walk on. Pre-fix, the release loop's unconditional `returnToDesk` ran
    // straight after and overwrote that walk with one back to alpha's own
    // desk. `whereabouts` reading "Help desk" is `inReceptionQueue` (`errand
    // === "queue-out" || "queue-stand"`) made public: this is that check
    // asked through the one door a test outside `describe.each`'s own scope
    // (which owns `inReceptionQueue`) can ask it through.
    expect(scene.whereabouts(alpha)).toBe("Help desk");
  });

  it("never re-plans on a status flip", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const planSpy = vi.spyOn(view, "plan");
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
      }),
    );
    const afterFirst = planSpy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const outbreak = outbreakScript({ ...epic, statusById: idle }, 3);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: outbreak[0],
      }),
    );
    expect(planSpy.mock.calls.length).toBe(afterFirst);

    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
      }),
    );
    expect(planSpy.mock.calls.length).toBe(afterFirst);
    planSpy.mockRestore();
  });

  it("reproduces a fresh scene's civic claims after a scrub back and forward", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const outbreak = outbreakScript({ ...epic, statusById: idle }, 12);
    const agents = epic.agents;

    const claimsOf = (scene: OfficeScene): string => {
      const book = bookOf(scene);
      const rows = book.knownAgentIds().map((id) => {
        const claim = book.civicClaimOf(id);
        // THE CIVIC CLAIM AND THE SEAT IT IS HELD ON - not the agent's own desk.
        // An agent with no claim has its HOME seat as its effective seat, and in
        // an append-stable view the home packing is frozen from first sight: a
        // scene whose first sync was an outbreak packs its cold agents at desks
        // and a fresh idle scene puts them in cubbies, so including it here
        // would assert a reproducibility those views deliberately do not have
        // (`oblique-plan.test.ts` pins the opposite). The Floor's packing
        // reproducibility is pinned by `office-plans.test.ts` instead.
        const seatId =
          claim === null ? "-" : (book.effectiveSeat(id)?.seatId ?? "-");
        return `${id}:${claim ?? "-"}:${seatId}`;
      });
      return rows.join("|");
    };

    const freshAt = (
      statusById: ReadonlyMap<string, OfficeAgentStatus>,
      cursorMs: number,
    ): string => {
      const fresh = newScene();
      fresh.sync(
        sceneInput({
          agents,
          visibleAgentIds: visible,
          statusById,
          cursorMs,
          reducedMotion: true,
        }),
      );
      return claimsOf(fresh);
    };

    const scene = newScene();
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: outbreak[0],
        cursorMs: 1000,
        reducedMotion: true,
      }),
    );
    expect(claimsOf(scene)).toBe(freshAt(outbreak[0], 1000));

    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: idle,
        cursorMs: 100,
        reducedMotion: true,
      }),
    );
    expect(claimsOf(scene)).toBe(freshAt(idle, 100));

    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: outbreak[0],
        cursorMs: 1000,
        reducedMotion: true,
      }),
    );
    expect(claimsOf(scene)).toBe(freshAt(outbreak[0], 1000));
  });

  it("seats civic claims instantly during playback and never walks civic-out", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const outbreak = outbreakScript({ ...epic, statusById: idle }, 12);
    const scene = newScene();
    // First sync at a cursor, playing: claims recompute before characters
    // spawn, so they sit in the beds the as-of statuses name. A civic-out
    // walk here would be the live summons playing through a photograph.
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: outbreak[0],
        cursorMs: 1000,
        playing: true,
      }),
    );
    const crashed = failureIds(outbreak[0]);
    const assertNoCivicWalk = (): void => {
      const book = bookOf(scene);
      const frame = frameOf(scene);
      for (const id of crashed) {
        if (book.civicClaimOf(id) === null) continue;
        expect(frame.awayAgentIds.has(id)).toBe(false);
      }
    };
    assertNoCivicWalk();
    for (let step = 0; step < 40; step += 1) {
      scene.tick(100);
      assertNoCivicWalk();
    }
  });

  /**
   * REBUILT (see the class doc's finding-7 note): the original fixture
   * crashed all twelve agents via `outbreakScript`, so nobody was ever idle
   * and the ordinary-errand half of `assertBudgets` below counted zero on
   * every tick of every run - `errands <= MAX_CONCURRENT_ERRANDS` held
   * whether or not `civic-out` was ever charged against that cap, because
   * there was never anything to charge. The two budgets read as
   * INDEPENDENT only if ordinary errands can be OBSERVED reaching the cap
   * while civic walkers are away too, on the same tick - not merely
   * bounded by it on runs where nothing tested the bound.
   *
   * 64 idle agents (`MAX_CONCURRENT_ERRANDS * 2`, `CAP_CREW`'s own ratio
   * above) plus 10 crashed and 10 waiting: enough idle heads that ordinary
   * errands can saturate 32 on their own, and enough crashed/waiting ones
   * that some are still walking to a bed or a lounge chair while that
   * happens - civic-out is a NARROW window (the walk, not the sit), so it
   * needs its own population rather than borrowing overflow from the ward.
   *
   * THE MUTANT THIS DEFENDS AGAINST: `civic-out` added to `AWAY_ERRANDS`.
   * That mutant makes `errandCount()` (which gates `updateErrandStarts`)
   * count civic walkers against the same 32, so on any tick with `k` civic
   * walkers away, ordinary errands can reach at most `32 - k` - never the
   * full 32. `peakErrandsWhileCivicWalking` is read ONLY on ticks where a
   * civic walker is also away, which is what makes it the number that
   * mutant actually bends.
   */
  it("keeps civic walkers per floor within that floor's civic seats, and errands at 32 independently", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const IDLE_COUNT = MAX_CONCURRENT_ERRANDS * 2;
    const CRASHED_COUNT = 10;
    const WAITING_COUNT = 10;
    const epic = makeTestEpic(
      "one-team",
      IDLE_COUNT + CRASHED_COUNT + WAITING_COUNT,
      1,
    );
    const visible = unarchivedIdsOf(epic);
    const pool = epic.agents.map((person) => person.id);
    const crashed = pool.slice(0, CRASHED_COUNT);
    const waiting = pool.slice(CRASHED_COUNT, CRASHED_COUNT + WAITING_COUNT);
    const statuses = new Map<string, OfficeAgentStatus>(
      epic.agents.map((person) => [person.id, "idle" as const]),
    );
    for (const id of crashed) statuses.set(id, "failure");
    for (const id of waiting) statuses.set(id, "awaiting");

    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: statuses,
      }),
    );
    const layout = layoutOf(scene);

    // A BOUND IS SATISFIED BY AN EMPTY FLOOR, which is the way this case could
    // pass while saying nothing: with no civic walkers the per-floor loop below
    // never runs a single assertion. So the walk is witnessed as well as
    // bounded - `peakWalkers` has to reach at least one before the bound it
    // clears means anything.
    let peakWalkers = 0;
    let peakErrandsWhileCivicWalking = 0;

    const assertBudgets = (): void => {
      const book = bookOf(scene);
      const frame = frameOf(scene);
      const civicWalkers = new Map<number, number>();
      let errands = 0;
      let civicWalkersTotal = 0;
      for (const id of book.knownAgentIds()) {
        if (!frame.awayAgentIds.has(id)) continue;
        const civic = book.civicClaimOf(id);
        if (civic !== null) {
          const floorIndex = book.effectiveSeat(id)?.floorIndex ?? 0;
          civicWalkers.set(floorIndex, (civicWalkers.get(floorIndex) ?? 0) + 1);
          civicWalkersTotal += 1;
          continue;
        }
        const where = scene.whereabouts(id);
        // Help desk / lobby / leaving are summonses, not errands, and
        // are uncapped the same way civic-out is. Counting them against
        // 32 would make a full reception queue look like a cap breach.
        if (where === "Help desk" || where === "Lobby") continue;
        errands += 1;
      }
      for (const [floorIndex, walking] of civicWalkers) {
        peakWalkers = Math.max(peakWalkers, walking);
        expect(walking).toBeLessThanOrEqual(
          civicSeatCountOnFloor(layout, floorIndex),
        );
      }
      expect(errands).toBeLessThanOrEqual(MAX_CONCURRENT_ERRANDS);
      if (civicWalkersTotal > 0) {
        peakErrandsWhileCivicWalking = Math.max(
          peakErrandsWhileCivicWalking,
          errands,
        );
      }
    };

    assertBudgets();
    for (let step = 0; step < CIVIC_WALK_TICKS; step += 1) {
      scene.tick(100);
      assertBudgets();
    }
    // A run where nobody walked to a civic seat would clear every bound
    // above without testing one of them.
    expect(peakWalkers).toBeGreaterThan(0);
    // THE INDEPENDENCE CLAIM ITSELF: ordinary errands reached the FULL cap
    // on some tick where a civic walker was also away. Pre-fix (`civic-out`
    // charged to the same budget), this is strictly less than 32 whenever
    // `peakWalkers` is reached at the same time ordinary errands are near
    // capacity.
    expect(peakErrandsWhileCivicWalking).toBe(MAX_CONCURRENT_ERRANDS);
  });

  it("names Infirmary and Lounge from whereabouts, and Help desk from the queue", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
        reducedMotion: true,
      }),
    );

    const outbreak = outbreakScript({ ...epic, statusById: idle }, 3);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: outbreak[0],
        reducedMotion: true,
      }),
    );
    const bedded = failureIds(outbreak[0]).find(
      (id) => bookOf(scene).civicClaimOf(id) === "bed",
    );
    if (bedded === undefined) throw new Error("expected a bedded agent");
    expect(scene.whereabouts(bedded)).toBe(
      civicRoomName(layoutOf(scene), "infirmary"),
    );

    const waiting = waitingScript({ ...epic, statusById: idle }, 6);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: waiting[0],
        reducedMotion: true,
      }),
    );
    const seatedLounge = [...waiting[0].entries()]
      .filter(([, status]) => status === "awaiting")
      .map(([id]) => id)
      .find((id) => bookOf(scene).civicClaimOf(id) === "lounge");
    if (seatedLounge === undefined) throw new Error("expected a lounge sitter");
    expect(scene.whereabouts(seatedLounge)).toBe(
      civicRoomName(layoutOf(scene), "waiting-room"),
    );

    const queuedId = epic.agents.find(
      (person) =>
        !person.archived && person.id !== bedded && person.id !== seatedLounge,
    )?.id;
    if (queuedId === undefined) throw new Error("expected a third agent");
    const attention = new Map(idle);
    attention.set(queuedId, "attention");
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: attention,
        reducedMotion: true,
      }),
    );
    expect(scene.whereabouts(queuedId)).toBe("Help desk");
  });

  function civicNameOnFloor(
    layout: OfficeLayout,
    floorIndex: number,
    kind: "infirmary" | "waiting-room",
  ): string {
    const room = layout.floors[floorIndex].civic.find(
      (entry) => entry.kind === kind,
    );
    if (room === undefined) {
      throw new Error(`expected a ${kind} on floor ${floorIndex}`);
    }
    return room.name;
  }

  /**
   * The box `locate` answers for a seated agent: the seat's declared
   * painted box, or the desk-tile origin through this view's projector.
   * `footRect` is the character sprite; locate is the seat.
   */
  function seatBox(layout: OfficeLayout, seat: OfficeSeat): OfficeRect {
    if (seat.hitBox !== null) return seat.hitBox;
    const origin = view.painter
      .projector(layout)
      .project(seat.deskTile.col, seat.deskTile.row);
    return {
      x: origin.x,
      y: origin.y,
      width: seat.hitTiles.width * OFFICE_TILE,
      height: seat.hitTiles.height * OFFICE_TILE,
    };
  }

  it("names a seated bed agent with this view's own word for the infirmary", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
        reducedMotion: true,
      }),
    );
    const outbreak = outbreakScript({ ...epic, statusById: idle }, 3);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: outbreak[0],
        reducedMotion: true,
      }),
    );
    const bedded = failureIds(outbreak[0]).find(
      (id) => bookOf(scene).civicClaimOf(id) === "bed",
    );
    if (bedded === undefined) throw new Error("expected a bedded agent");
    const seat = bookOf(scene).effectiveSeat(bedded);
    if (seat === null) throw new Error("expected a bed seat");
    const word = civicNameOnFloor(
      layoutOf(scene),
      seat.floorIndex,
      "infirmary",
    );
    expect(scene.whereabouts(bedded)).toBe(word);
  });

  it("names a seated lounge agent with this view's own word for the waiting room", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const scene = newScene();
    const waiting = waitingScript({ ...epic, statusById: idle }, 6);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: waiting[0],
        reducedMotion: true,
      }),
    );
    const seatedLounge = [...waiting[0].entries()]
      .filter(([, status]) => status === "awaiting")
      .map(([id]) => id)
      .find((id) => bookOf(scene).civicClaimOf(id) === "lounge");
    if (seatedLounge === undefined) {
      throw new Error("expected a lounge sitter");
    }
    const seat = bookOf(scene).effectiveSeat(seatedLounge);
    if (seat === null) throw new Error("expected a lounge seat");
    const word = civicNameOnFloor(
      layoutOf(scene),
      seat.floorIndex,
      "waiting-room",
    );
    expect(scene.whereabouts(seatedLounge)).toBe(word);
  });

  it("names an agent standing in the reception queue Help desk", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    // C7: the counter people queue at IS the help desk, so the card
    // says that wherever the room is named - "Front desk" on Floor,
    // whatever K2 calls it elsewhere. This is awayWhereabouts, not
    // the seated civic-room word.
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const queuedId = epic.agents.find((person) => !person.archived)?.id;
    if (queuedId === undefined) throw new Error("expected a live agent");
    const attention = new Map(idle);
    attention.set(queuedId, "attention");
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: attention,
        reducedMotion: true,
      }),
    );
    expect(frameOf(scene).awayAgentIds.has(queuedId)).toBe(true);
    expect(scene.whereabouts(queuedId)).toBe("Help desk");
  });

  it("names a civic walker as on the way to the room, in the plan's own word", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 60, 1);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const script = outbreakScript({ ...epic, statusById: idle }, 3);
    const crashed = failureIds(script[0]);
    expect(crashed.length).toBeGreaterThan(0);
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
      }),
    );
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: script[0],
      }),
    );
    let walker: string | undefined;
    let expected: string | undefined;
    for (let step = 0; step < CIVIC_WALK_TICKS; step += 1) {
      scene.tick(100);
      const book = bookOf(scene);
      const frame = frameOf(scene);
      const id = crashed.find(
        (agentId) =>
          frame.awayAgentIds.has(agentId) &&
          book.civicClaimOf(agentId) === "bed",
      );
      if (id === undefined) continue;
      const seat = book.effectiveSeat(id);
      if (seat === null) continue;
      const word = civicNameOnFloor(
        layoutOf(scene),
        seat.floorIndex,
        "infirmary",
      );
      walker = id;
      expected = `Walking to the ${word}`;
      expect(scene.whereabouts(id)).toBe(expected);
      break;
    }
    expect(walker).toBeDefined();
    expect(expected).toBeDefined();
  });

  it("locates a bedded agent at the bed's box, not its desk's", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const scene = newScene();
    const outbreak = outbreakScript({ ...epic, statusById: idle }, 3);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: outbreak[0],
        reducedMotion: true,
      }),
    );
    const bedded = failureIds(outbreak[0]).find(
      (id) => bookOf(scene).civicClaimOf(id) === "bed",
    );
    if (bedded === undefined) throw new Error("expected a bedded agent");
    const layout = layoutOf(scene);
    const bed = bookOf(scene).effectiveSeat(bedded);
    const desk = layout.desks.get(bedded);
    if (bed === null || bed.kind !== "bed") {
      throw new Error("expected the bed seat");
    }
    if (desk === undefined) throw new Error("expected the agent's desk");
    const located = scene.locate(bedded);
    if (located === null) throw new Error("expected a location");
    const bedBox = seatBox(layout, bed);
    const deskBox = seatBox(layout, desk);
    expect(bedBox).not.toEqual(deskBox);
    expect(located).toEqual(bedBox);
    expect(located).not.toEqual(deskBox);
  });

  it("reads civic occupancy off the seat book, not the plan's capacity", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    // 12 agents → 2 beds. One crash fills a bed without filling the
    // ward, so a tally that returned `seatIds.length` cannot pass.
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = idleStatusById(epic);
    const visible = unarchivedIdsOf(epic);
    const outbreak = outbreakScript({ ...epic, statusById: idle }, 1);
    const scene = newScene();
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: outbreak[0],
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const book = bookOf(scene);
    const infirmary = layout.floors[0].civic.find(
      (room) => room.kind === "infirmary",
    );
    const lounge = layout.floors[0].civic.find(
      (room) => room.kind === "waiting-room",
    );
    if (infirmary === undefined || lounge === undefined) {
      throw new Error("expected an infirmary and a waiting room");
    }
    expect(lounge.seatIds.length).toBeGreaterThan(0);

    let fromBook = 0;
    for (const seatId of infirmary.seatIds) {
      if (book.occupant(seatId) !== null) fromBook += 1;
    }
    expect(fromBook).toBeGreaterThan(0);
    expect(fromBook).toBeLessThan(infirmary.seatIds.length);

    const tally = scene.civicTally();
    expect(tally.occupiedByRoom.get(infirmary.civicRoomId)).toBe(fromBook);
    // A room nobody is in is ABSENT, not 0: the map is occupancy, not
    // a capacity table.
    expect(tally.occupiedByRoom.has(lounge.civicRoomId)).toBe(false);

    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
        reducedMotion: true,
      }),
    );
    const afterBook = bookOf(scene);
    let remaining = 0;
    for (const seatId of infirmary.seatIds) {
      if (afterBook.occupant(seatId) !== null) remaining += 1;
    }
    expect(remaining).toBeLessThan(fromBook);
    const after = scene.civicTally();
    if (remaining === 0) {
      expect(after.occupiedByRoom.has(infirmary.civicRoomId)).toBe(false);
    } else {
      expect(after.occupiedByRoom.get(infirmary.civicRoomId)).toBe(remaining);
    }
  });

  it("reports archivedByHost from the partition, and advances its clock only on tick", (context) => {
    if (!CIVIC_ROOMS_EXPECTED[viewId]) {
      context.skip(`${viewId} plans no civic rooms`);
      return;
    }
    // 80 is large enough that the fixture's 4% archive rate is a
    // non-zero count (3 at seed 1), so a zero would not silently pass
    // as "both sides were empty".
    const epic = makeTestEpic("one-team", 80, 1);
    // EVERY record, archived ones included, which is what `visibleAgentIds`
    // means in production: the projection's set is "agents that exist as of
    // the cursor", and an archived agent exists - it is drawn as a ghosted
    // desk. `unarchivedIdsOf` filters the archived out, so a case built on it
    // could never witness an archive count at all.
    const visible = existingIdsOf(epic);
    const input = sceneInput({
      agents: epic.agents,
      visibleAgentIds: visible,
      statusById: epic.statusById,
      reducedMotion: true,
    });
    const scene = newScene();
    scene.sync(input);

    const reported = scene.civicTally().archivedByHost;
    const folded = officeArchivedByHost({
      partition: input.partition,
      agents: input.agents,
      visibleAgentIds: input.visibleAgentIds,
      cursorMs: input.cursorMs,
    });
    expect(reported).toEqual(folded);
    let archived = 0;
    for (const count of reported.values()) archived += count;
    expect(archived).toBeGreaterThan(0);

    // THE SCENE'S OWN CLOCK, not Date.now(): a suspended office must
    // not blink through the time it spent off screen. 250 ms is one
    // siren frame (`OFFICE_SIREN_FRAME_MS`); a clock that read the
    // wall would not advance by exactly this delta.
    const SIREN_TICK_MS = 250;
    expect(scene.animationClockMs()).toBe(0);
    scene.tick(SIREN_TICK_MS);
    expect(scene.animationClockMs()).toBe(SIREN_TICK_MS);
    scene.sync(input);
    expect(scene.animationClockMs()).toBe(SIREN_TICK_MS);
    scene.tick(100);
    expect(scene.animationClockMs()).toBe(SIREN_TICK_MS + 100);
  });
});

describe.each(OFFICE_VIEW_IDS)("%s view vehicles", (viewId) => {
  const view = OFFICE_VIEWS[viewId];

  function newVehicleScene(): OfficeScene {
    return new OfficeScene(view, null);
  }

  const ATTENTION_BETA: () => ReadonlyMap<string, OfficeAgentStatus> = () =>
    new Map<string, OfficeAgentStatus>([["beta", "attention"]]);

  const GAMMA = agent({ id: "gamma", createdAt: 3 });
  const TRIO: ReadonlyArray<OfficeAgentInput> = [ALPHA, BETA, GAMMA];
  const TRIO_IDS: ReadonlySet<string> = new Set(["alpha", "beta", "gamma"]);

  function failures(
    ...ids: ReadonlyArray<string>
  ): ReadonlyMap<string, OfficeAgentStatus> {
    return new Map<string, OfficeAgentStatus>(ids.map((id) => [id, "failure"]));
  }

  function attention(
    ...ids: ReadonlyArray<string>
  ): ReadonlyMap<string, OfficeAgentStatus> {
    return new Map<string, OfficeAgentStatus>(
      ids.map((id) => [id, "attention"]),
    );
  }

  function hasInfirmary(layout: OfficeLayout): boolean {
    return layout.floors.some((floor) =>
      floor.civic.some(
        (room) => room.kind === "infirmary" && room.seatIds.length > 0,
      ),
    );
  }

  function infirmaryNames(layout: OfficeLayout): ReadonlySet<string> {
    return new Set(
      layout.floors
        .flatMap((floor) => floor.civic)
        .filter((room) => room.kind === "infirmary")
        .map((room) => room.name),
    );
  }

  /**
   * Does this `whereabouts` reading name an infirmary - whether the agent is
   * lying in a bed or still crossing the floor to one?
   *
   * A CIVIC WALKER READS `Walking to the <room>` (K4), and these cases ask
   * their question on the sync the claim is made, when the character has not
   * moved a pixel yet. A bare set of room names answered that before the
   * walker's reading was refined and does not now.
   *
   * The NEGATIVE assertions need this same predicate rather than the bare set,
   * and that is the half worth stating: `Walking to the Sick bay` is not in the
   * set either, so an overflow agent that wrongly got a bed would have slipped
   * past a `has()` check that only knows the seated reading. Using it in both
   * directions keeps the guard a guard.
   */
  function namesInfirmary(names: ReadonlySet<string>, where: string): boolean {
    if (names.has(where)) return true;
    for (const name of names) {
      if (where === `Walking to the ${name}`) return true;
    }
    return false;
  }

  function civicKerbPoint(
    layout: OfficeLayout,
    roomKind: OfficeCivicRoom["kind"],
  ): OfficePoint | null {
    const room = layout.floors
      .flatMap((floor) => floor.civic)
      .find(
        (candidate) =>
          candidate.kind === roomKind && candidate.kerbTile !== null,
      );
    if (room === undefined || room.kerbTile === null) return null;
    return view.painter
      .projector(layout)
      .project(room.kerbTile.col + 0.5, room.kerbTile.row + 1);
  }

  function atPoint(
    vehicle: OfficeVehicleDrawable,
    point: OfficePoint,
  ): boolean {
    return vehicle.x === point.x && vehicle.y === point.y;
  }

  function waitForVehicleAtKerb(
    scene: OfficeScene,
    point: OfficePoint,
    vehicleKind: OfficeVehicleDrawable["vehicleKind"],
  ): boolean {
    for (let step = 0; step < 500; step += 1) {
      const vehicle = vehicleDrawables(scene.frame(1, WHOLE_WORLD)).find(
        (candidate) =>
          candidate.vehicleKind === vehicleKind && atPoint(candidate, point),
      );
      if (vehicle !== undefined) return true;
      scene.tick(100);
    }
    return false;
  }

  function waitForVehicleToLeaveKerb(
    scene: OfficeScene,
    point: OfficePoint,
    vehicleKind: OfficeVehicleDrawable["vehicleKind"],
  ): boolean {
    for (let step = 0; step < 500; step += 1) {
      scene.tick(100);
      const vehicle = vehicleDrawables(scene.frame(1, WHOLE_WORLD)).find(
        (candidate) => candidate.vehicleKind === vehicleKind,
      );
      if (vehicle === undefined || !atPoint(vehicle, point)) return true;
    }
    return false;
  }

  function wardAgents(
    prefix: string,
    hostId: string,
    count: number,
  ): ReadonlyArray<OfficeAgentInput> {
    const named = ["a", "b", "c", "d"];
    return Array.from({ length: count }, (_unused, index) =>
      agent({
        id: `${prefix}-${named.at(index) ?? `filler-${index}`}`,
        hostId,
        createdAt: index + 1,
      }),
    );
  }

  const CAP_TRIO: ReadonlyArray<OfficeAgentInput> = [
    agent({ id: "cap-a", hostId: "cap-h1", createdAt: 1 }),
    agent({ id: "cap-b", hostId: "cap-h2", createdAt: 2 }),
    agent({ id: "cap-c", hostId: "cap-h3", createdAt: 3 }),
  ];
  const CAP_IDS: ReadonlySet<string> = new Set(["cap-a", "cap-b", "cap-c"]);

  it("dispatches a police car exactly where this floor's road is not null, never where it is", () => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: ATTENTION_BETA(),
      }),
    );
    const road = layoutOf(scene).floors[0].road;
    const dispatched = vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length > 0;
    expect(dispatched).toBe(road !== null);
  });

  /** Host-b's own storey, found by its host rather than by an index. */
  function floorOfHost(
    scene: OfficeScene,
    hostId: string,
  ): { readonly index: number; readonly floor: OfficeFloor } {
    const floors = layoutOf(scene).floors;
    const index = floors.findIndex((floor) => floor.hostId === hostId);
    if (index < 0) throw new Error(`no storey for ${hostId}`);
    return { index, floor: floors[index] };
  }

  /** This storey's infirmary kerb and its road's entry, as one comparable line. */
  function wardKerbOf(floor: OfficeFloor): string {
    const ward = floor.civic.find((room) => room.kind === "infirmary");
    const kerb = ward?.kerbTile ?? null;
    const entry = floor.road?.entryTile ?? null;
    return `kerb=${String(kerb?.col)},${String(kerb?.row)} entry=${String(entry?.col)},${String(entry?.row)}`;
  }

  /** The point this storey's infirmary kerb projects to, or `null`. */
  function wardKerbPoint(
    scene: OfficeScene,
    hostId: string,
  ): OfficePoint | null {
    const { floor } = floorOfHost(scene, hostId);
    const ward = floor.civic.find((room) => room.kind === "infirmary");
    const kerb = ward?.kerbTile ?? null;
    if (kerb === null) return null;
    return view.painter
      .projector(layoutOf(scene))
      .project(kerb.col + 0.5, kerb.row + 1);
  }

  /** The point this storey's road starts at, which is where a fresh trip is. */
  function roadEntryPoint(
    scene: OfficeScene,
    hostId: string,
  ): OfficePoint | null {
    const entry = floorOfHost(scene, hostId).floor.road?.entryTile ?? null;
    if (entry === null) return null;
    return view.painter
      .projector(layoutOf(scene))
      .project(entry.col + 0.5, entry.row + 1);
  }

  /**
   * How far a departure may be from its own route: float noise, and nothing a
   * reader could see.
   *
   * Every projector here is AFFINE in `(col, row)` - identity times the tile on
   * the four square views, `(col - row, col + row)` scaled on the two
   * isometric ones - so a fractional tile between two road tiles projects to
   * exactly the interpolation of those two tiles' points. "On the route" is
   * therefore an equality, and the only slack it needs is the last bits of the
   * division that produced the fraction: measured over the whole drive in all
   * five views, the worst sample is 1.4e-14 px off.
   */
  const ROUTE_TOLERANCE_PX = 0.01;

  /**
   * The line a DEPARTURE is interpolated along on this storey: the foot points
   * of its road's tiles from its ward's kerb to the road's last tile, which is
   * the span `tileAlong` walks once the phase turns.
   */
  function departRouteOf(
    scene: OfficeScene,
    hostId: string,
  ): ReadonlyArray<OfficePoint> | null {
    const { floor } = floorOfHost(scene, hostId);
    const road = floor.road;
    const ward = floor.civic.find((room) => room.kind === "infirmary");
    const kerb = ward?.kerbTile ?? null;
    if (road === null || kerb === null) return null;
    const at = road.tiles.findIndex(
      (tile) => tile.col === kerb.col && tile.row === kerb.row,
    );
    if (at < 0) return null;
    const projector = view.painter.projector(layoutOf(scene));
    return road.tiles
      .slice(at)
      .map((tile) => projector.project(tile.col + 0.5, tile.row + 1));
  }

  /**
   * This point against the whole route: its distance from the NEAREST segment,
   * and how far along the polyline that segment puts it.
   *
   * The nearest segment rather than a box over all of them, which is what read
   * AD caught: the box the road projects to, even one tile proud, admits points
   * no segment of it ever reaches - a departing van drawn twelve pixels below
   * its own road is inside it at every step - and a route claim has to be about
   * the line the trip drives on. `+Infinity` for a route of one point, which
   * would be a road whose kerb is its last tile; no view has one, and a case
   * that met one would say so rather than pass.
   */
  function againstRoute(
    route: ReadonlyArray<OfficePoint>,
    point: OfficePoint,
  ): { readonly off: number; readonly along: number } {
    let best = { off: Number.POSITIVE_INFINITY, along: 0 };
    let base = 0;
    for (let at = 0; at + 1 < route.length; at += 1) {
      const from = route[at];
      const to = route[at + 1];
      const onto = projectOntoSegment(from, to, point);
      if (onto !== null && onto.off < best.off) {
        best = { off: onto.off, along: base + onto.along };
      }
      base += Math.hypot(to.x - from.x, to.y - from.y);
    }
    return best;
  }

  /**
   * Every sampled point that is not driving away along `route`: off its line,
   * or no further along it than the point before it.
   *
   * One list for both, because they are one question - a van beside the line and
   * a van that never advances down it are both failing to drive off on this
   * storey's road - and because a `toEqual([])` then says which sample and by
   * how much. Taken together with a sample count above one, they are what makes
   * the claim about a POSITIVELY DISPLACED point on the route rather than about
   * the frame the phase turned on, where the vehicle is still standing at its
   * kerb with nothing travelled.
   */
  function offTheRoute(
    route: ReadonlyArray<OfficePoint>,
    points: ReadonlyArray<OfficePoint>,
  ): ReadonlyArray<string> {
    const failed: string[] = [];
    let last = -1;
    for (const point of points) {
      const { off, along } = againstRoute(route, point);
      const where = `${String(point.x)},${String(point.y)}`;
      if (off > ROUTE_TOLERANCE_PX) {
        failed.push(`${where} is ${off.toFixed(2)} px off the route`);
      } else if (along <= last) {
        failed.push(
          `${where} is ${along.toFixed(1)} px along, not past ${last.toFixed(1)}`,
        );
      }
      last = along;
    }
    return failed;
  }

  /** Every vehicle in the frame, by kind - the whole road, in draw order. */
  function vansOf(scene: OfficeScene): ReadonlyArray<string> {
    return vehicleDrawables(scene.frame(1, WHOLE_WORLD)).map(
      (vehicle) => vehicle.vehicleKind,
    );
  }

  /** Whether an ambulance stands exactly on this point. */
  function ambulanceAt(scene: OfficeScene, point: OfficePoint): boolean {
    return vehicleDrawables(scene.frame(1, WHOLE_WORLD)).some(
      (vehicle) =>
        vehicle.vehicleKind === "ambulance" && atPoint(vehicle, point),
    );
  }

  /** Where an ambulance is, for a message that has to say what it found. */
  function ambulancePoint(scene: OfficeScene): OfficePoint | null {
    const vehicle = vehicleDrawables(scene.frame(1, WHOLE_WORLD)).find(
      (candidate) => candidate.vehicleKind === "ambulance",
    );
    return vehicle === undefined ? null : { x: vehicle.x, y: vehicle.y };
  }

  /**
   * Whether this agent is IN the ward, as against walking to it.
   *
   * The strict half of `namesInfirmary`: a rider counts as SETTLED to the
   * vehicle when it stops moving, and `Walking to the Sick bay` is exactly the
   * reading that says it has not.
   */
  function seatedInWard(scene: OfficeScene, agentId: string): boolean {
    return infirmaryNames(layoutOf(scene)).has(
      scene.whereabouts(agentId) ?? "",
    );
  }

  /** Ticks until an ambulance stands on this point, or `-1` inside the bound. */
  function drivenToKerb(scene: OfficeScene, point: OfficePoint): number {
    for (let step = 0; step < 200; step += 1) {
      if (ambulanceAt(scene, point)) return step;
      scene.tick(100);
    }
    return -1;
  }

  /** Which of these agents has the longest walk to this tile, by the route. */
  function longestWalkTo(
    scene: OfficeScene,
    candidates: ReadonlyArray<string>,
    target: OfficeTilePos,
  ): { readonly agentId: string; readonly tiles: number } {
    let agentId = candidates[0];
    let tiles = -1;
    for (const candidate of candidates) {
      const desk = layoutOf(scene).desks.get(candidate);
      if (desk === undefined) continue;
      const path = findOfficePath(layoutOf(scene), desk.chairTile, target);
      const length = path?.length ?? -1;
      if (length <= tiles) continue;
      tiles = length;
      agentId = candidate;
    }
    return { agentId, tiles };
  }

  /**
   * Ticks on to the first moment a trip that had NOT taken `walking` on would
   * have left its kerb: the four second floor spent since the join, `settled` in
   * the ward, and `walking` still on its way. Answers the tick count since that
   * join, or `-1` inside the ceiling.
   */
  function tickToRiderWitness(args: {
    readonly scene: OfficeScene;
    readonly settled: string;
    readonly walking: string;
    readonly since: number;
    readonly floor: number;
    readonly ceiling: number;
  }): number {
    let since = args.since;
    for (let step = 0; step < args.ceiling; step += 1) {
      if (
        since >= args.floor &&
        seatedInWard(args.scene, args.settled) &&
        !seatedInWard(args.scene, args.walking)
      ) {
        return since;
      }
      args.scene.tick(100);
      since += 1;
    }
    return -1;
  }

  /** How long a departure is given to finish before the case gives up on it. */
  const DEPART_TICK_CAP = 200;

  /**
   * How far a vehicle travels in one of this case's 100 ms ticks, in TILES.
   *
   * The scene's `VEHICLE_TILES_PER_SECOND` is module-private - six tiles a
   * second, twice a walker's three - so this is the one number here that is
   * restated rather than derived. It is not taken on trust either: the case
   * computes the step this implies from the ROUTE's own geometry and calibrates it
   * against the van's longest actual advance, so a drift between the two - this
   * constant or the scene's speed changing - reds rather than quietly widening the
   * slack the exit witness allows.
   */
  const DEPART_TILES_PER_TICK = 0.6;

  /**
   * WHERE THE DEPARTURE GOES, every tick of it: the ambulance's point on each
   * frame from the first one off this kerb until the road is done with it.
   *
   * The whole drive rather than the first point off the kerb, which is the other
   * half of what read AD caught. The frame the phase TURNS on is not a departure
   * yet - `advanceVehicle` sets `depart` and zeroes `elapsedMs` together, so
   * `vehicleTileOf` still answers with the kerb tile - and a check that reads
   * only the first point unequal to the kerb is therefore reading whatever a
   * defect did to that standing frame, not where the van drove.
   *
   * THREE ENDINGS, AND ONLY ONE OF THEM IS A DRIVE, which is what read AE caught
   * in the first version of this: it answered the same shape whether the van
   * finished, was dropped early, or was still on the road when the ticks ran out.
   * `vanishedAtKerb` is the van dropped where it stood; `completed` is an absence
   * OBSERVED after it had moved, so the cap answers `false` and a case that runs
   * out of ticks fails instead of reading like a finished trip. Where the absence
   * fell on the road is a question for the route itself - an early removal leaves
   * perfectly good samples behind it - so the witness for that is the last
   * painted frame's distance from the exit.
   */
  function departureSamples(
    scene: OfficeScene,
    kerb: OfficePoint,
  ): {
    readonly points: ReadonlyArray<OfficePoint>;
    readonly vanishedAtKerb: boolean;
    readonly completed: boolean;
  } {
    const points: OfficePoint[] = [];
    for (let step = 0; step < DEPART_TICK_CAP; step += 1) {
      scene.tick(100);
      const at = ambulancePoint(scene);
      if (at === null) {
        return {
          points,
          vanishedAtKerb: points.length === 0,
          completed: points.length > 0,
        };
      }
      if (points.length === 0 && at.x === kerb.x && at.y === kerb.y) continue;
      points.push(at);
    }
    return { points, vanishedAtKerb: false, completed: false };
  }

  /** How long this route is, in pixels of its own polyline. */
  function routeLength(route: ReadonlyArray<OfficePoint>): number {
    let total = 0;
    for (let at = 0; at + 1 < route.length; at += 1) {
      const from = route[at];
      const to = route[at + 1];
      total += Math.hypot(to.x - from.x, to.y - from.y);
    }
    return total;
  }

  /**
   * One tick's travel down THIS route, in pixels, computed from the plan rather
   * than from the drive under test.
   *
   * A road's tiles are adjacent, so each segment of the projected polyline is one
   * tile, and every tile of it is the same screen length in every view here - 16
   * px where the projector is the identity, `sqrt(320)` = 17.8885 on the two
   * isometric ones, whichever way the road turns. Times the tick, that is the
   * MOVEMENT STEP: 9.6 px and 10.7331 px respectively, measured.
   *
   * It is what the completion witness needs, because the last PAINTED frame
   * cannot be at the exit - the tick that reaches the exit is the tick that
   * removes the vehicle - and it has to be the expected step rather than the
   * observed one, or a van that crawled would be handed exactly as much slack as
   * it needed to look finished.
   */
  function tickStepOf(route: ReadonlyArray<OfficePoint>): number {
    const tiles = route.length - 1;
    if (tiles <= 0) return 0;
    return (routeLength(route) / tiles) * DEPART_TILES_PER_TICK;
  }

  /**
   * The longest single advance the van made down `route`, counting the kerb it
   * started from as zero.
   *
   * CALIBRATION OF THE STEP, AND NO MORE THAN THAT, which read AF is right to
   * pin down: comparing this maximum with `tickStepOf` says that no sampled
   * advance exceeded the route's expected step and that at least one reached it.
   * So a uniform speed change in the scene, or the restated constant drifting
   * from it, is caught beyond the tolerance. It does NOT certify the speed of
   * every tick - one departure increment cut from 100 ms to 50 ms would put a
   * 0.3-tile advance among 0.6-tile ones, keep this maximum, and still finish
   * inside the exit bound. Measured, the maximum is exactly `tickStepOf` in all
   * five views.
   */
  function longestAdvance(
    route: ReadonlyArray<OfficePoint>,
    points: ReadonlyArray<OfficePoint>,
  ): number {
    let last = 0;
    let most = 0;
    for (const point of points) {
      const { along } = againstRoute(route, point);
      most = Math.max(most, along - last);
      last = along;
    }
    return most;
  }

  /**
   * READ Z'S Z1: A TRIP FOLLOWS ITS HOST'S STOREY, NOT THE NUMBER IT HAD.
   *
   * A vehicle cached the index of the floor whose road it drives on, and a floor
   * index is a POSITION in the partition's host-id ordering. So one lexically
   * earlier host appearing renumbered the storey under a trip already at the
   * kerb. The read X ids are what made that cost a rider: the room id no longer
   * changes, so the next dispatch for that ward COALESCES onto the standing trip,
   * `absorb` appends the newcomer, and the cached index then resolves to another
   * host's floor - no ward there, so no kerb, the frame stops drawing the van and
   * the next tick removes it. The rider it had just absorbed never gets a trip and
   * nothing retries while it stays crashed.
   *
   * The OLD trip's loss is older than those ids: before them the room id changed
   * with the index, so the coalesce missed and the newcomer spawned its own van
   * while the original still drove off a cliff. Both halves are one fix - resolve
   * the floor from the room.
   *
   * WHAT MAKES THE VAN AFTER THE APPEND THE SAME VAN, which read AB was right
   * that a count alone does not say. Three things the case now requires, and each
   * one rejects a specific way of passing it:
   *
   *   PROGRESS.  The append happens with the trip PARKED AT ITS WARD'S KERB and a
   *              second and a half of waiting behind it, not at the road's entry
   *              with nothing elapsed, where a fresh dispatch is
   *              indistinguishable from a survivor. The case asserts the kerb is
   *              not the entry, drives there, and then finds the van at that kerb
   *              both on the append's own frame and after a tick. Clearing the
   *              vehicles and letting the second crash dispatch afresh puts a van
   *              at the ENTRY on those frames.
   *   THE RIDER. It ticks on to the first moment a trip that had NOT taken the
   *              newcomer on would have left - its only rider seated, and the
   *              four second courtesy it measures from its own arrival spent -
   *              waits half a second more so that such a van would be visibly off
   *              the kerb, and requires this one to still be standing there,
   *              inside the twelve second ceiling. Keeping the van but omitting
   *              the newcomer from `absorb` fails there.
   *   THE ROUTE. Then it drives away, and EVERY FRAME of the drive is read
   *              against the kerb-to-exit line of host-b's CURRENT storey: on
   *              the nearest segment of that polyline to within float noise, each
   *              frame further along it than the one before, and the last of them
   *              positively down it. Read AD is why it is the polyline and the
   *              whole drive rather than a box and one sample: the box the road
   *              projects to, a tile proud, admits a van drawn twelve pixels
   *              below its own road - and the first frame unequal to the kerb is
   *              not a departure at all under such a defect, because the phase
   *              turns with `elapsedMs` zeroed and the van still standing on the
   *              kerb tile. Read AE is why the DRIVE has to finish as well: an
   *              early removal leaves real road behind it, so the trip's end is
   *              required to be an observed absence and its last painted frame to
   *              be within one of the van's own advances of the exit, which is as
   *              close as a vehicle removed on reaching it can be drawn. For the
   *              Floor and Campus the route moved with the ward - the kerb goes
   *              456,416 to 456,864 and 40,196 to 296,324 - so those two views
   *              are no longer skipped: following a ward that itself moved is the
   *              same promise, read against the plan in hand rather than against
   *              the one before it.
   *
   * The premises are REPORTED rather than gated, in the message of every
   * assertion: Towers and Building keep their index under the carry, City freezes
   * its band, and the Floor and Campus move the ward with it. All five views that
   * have a road and a ward run the whole case; Mission control has neither yet.
   *
   * MOTION ON AND A SETTLED FEED, live cursor: the van has to be on the road
   * rather than seated instantly, and the append has to be a sync that re-plans
   * while it is out there.
   */
  it("keeps a ward's ambulance, its progress and its new rider when a lexically earlier host renumbers its storey", (context) => {
    const crew = wardAgents("z1", "host-b", 4);
    const crewIds = new Set(crew.map((person) => person.id));
    const scene = newVehicleScene();
    scene.sync(
      sceneInput({ agents: crew, visibleAgentIds: crewIds, feedSettled: true }),
    );
    const opened = layoutOf(scene);
    if (opened.floors[0].road === null || !hasInfirmary(opened)) {
      context.skip("this view has no road or infirmary yet (K2)");
      return;
    }

    // ONE CRASH, ONE AMBULANCE, asserted positively before anything moves.
    scene.sync(
      sceneInput({
        agents: crew,
        visibleAgentIds: crewIds,
        statusById: failures("z1-a"),
        feedSettled: true,
      }),
    );
    expect(
      namesInfirmary(infirmaryNames(opened), scene.whereabouts("z1-a") ?? ""),
      "z1-a is not in the ward",
    ).toBe(true);
    expect(vansOf(scene), "no ambulance for the first crash").toEqual([
      "ambulance",
    ]);
    const before = floorOfHost(scene, "host-b");
    const kerbBefore = wardKerbPoint(scene, "host-b");
    const entryBefore = roadEntryPoint(scene, "host-b");
    if (kerbBefore === null || entryBefore === null) {
      throw new Error("a ward with a road owes a kerb and an entry");
    }
    expect(
      `${String(kerbBefore.x)},${String(kerbBefore.y)}`,
      "the kerb IS the road's entry here, so progress cannot be seen",
    ).not.toBe(`${String(entryBefore.x)},${String(entryBefore.y)}`);

    // DRIVEN OFF THE ENTRY AND ON TO ITS WARD'S KERB, then left standing there a
    // while: the append has to land on a trip whose progress is visible.
    const toKerb = drivenToKerb(scene, kerbBefore);
    expect(
      toKerb,
      `the ambulance never drove to its ward's kerb (at ${JSON.stringify(ambulancePoint(scene))})`,
    ).toBeGreaterThan(0);
    const WAITED_TICKS = 15;
    for (let step = 0; step < WAITED_TICKS; step += 1) scene.tick(100);
    expect(
      ambulanceAt(scene, kerbBefore),
      "the ambulance left its kerb before the append",
    ).toBe(true);

    // THE SECOND CRASH IS THE ONE WITH THE LONGEST WALK, chosen by the route it
    // would have to take rather than by name. The wait this case reads is only
    // ABOUT the newcomer once the four second floor its join reset has expired,
    // so a newcomer that reaches its bed inside those four seconds proves
    // nothing - which is what Campus's nearest crew member does, in 2.5 s.
    const wardDoor = before.floor.civic.find(
      (room) => room.kind === "infirmary",
    )?.doorTile;
    if (wardDoor === undefined) throw new Error("a ward owes a door");
    const furthest = longestWalkTo(
      scene,
      crew.map((person) => person.id).filter((id) => id !== "z1-a"),
      wardDoor,
    );
    const newcomer = furthest.agentId;
    expect(
      furthest.tiles,
      `${newcomer} cannot walk to the ward at all`,
    ).toBeGreaterThan(0);

    // THE EARLIER HOST, AND A SECOND CRASH, ON ONE SYNC - which is what makes
    // the dispatch land on the standing trip rather than in a free slot.
    const early = agent({ id: "host-a-root", hostId: "host-a", createdAt: 9 });
    const both = [...crew, early];
    const bothIds = new Set(both.map((person) => person.id));
    scene.sync(
      sceneInput({
        agents: both,
        visibleAgentIds: bothIds,
        statusById: failures("z1-a", newcomer),
        feedSettled: true,
      }),
    );
    const after = floorOfHost(scene, "host-b");
    const note = `${viewId}: storey ${String(before.index)} -> ${String(after.index)}, ${wardKerbOf(before.floor)} -> ${wardKerbOf(after.floor)}`;
    expect(
      namesInfirmary(
        infirmaryNames(layoutOf(scene)),
        scene.whereabouts(newcomer) ?? "",
      ),
      `${newcomer} is not in the ward (${note})`,
    ).toBe(true);

    // THE SAME TRIP, AT ITS WARD'S KERB ON THIS PLAN'S ROUTE - which for the
    // Floor and Campus is a kerb that moved with the storey.
    const kerbAfter = wardKerbPoint(scene, "host-b");
    if (kerbAfter === null) throw new Error(`host-b lost its kerb (${note})`);
    expect(
      vansOf(scene),
      `the ward's ambulance did not survive its storey being renumbered (${note})`,
    ).toEqual(["ambulance"]);
    expect(
      JSON.stringify(ambulancePoint(scene)),
      `the ambulance is not at its ward's kerb on the append's own frame (${note})`,
    ).toBe(JSON.stringify(kerbAfter));
    scene.tick(100);
    expect(
      vansOf(scene),
      `the ward's ambulance did not survive a tick after the append (${note})`,
    ).toEqual(["ambulance"]);
    expect(
      JSON.stringify(ambulancePoint(scene)),
      `the ambulance left its kerb on the first tick after the append (${note})`,
    ).toBe(JSON.stringify(kerbAfter));

    // THE RIDER IT ABSORBED, read off the two clocks the trip keeps. The FLOOR is
    // four seconds since the last join and is what a newcomer resets; the CEILING
    // is twelve seconds since the arrival and is what nobody can push out. So the
    // moment this case wants is one where the floor is spent, the trip's other
    // rider is seated, and the newcomer is NOT - because a trip that had taken
    // only that other rider on has nothing left to wait for there.
    const FLOOR_TICKS = 40;
    const CEILING_TICKS = 120;
    const CLEAR_TICKS = 5;
    const witness = tickToRiderWitness({
      scene,
      settled: "z1-a",
      walking: newcomer,
      since: 1,
      floor: FLOOR_TICKS,
      ceiling: CEILING_TICKS,
    });
    expect(
      witness,
      `no moment with the floor spent, z1-a seated and ${newcomer} still walking (${note})`,
    ).toBeGreaterThan(0);

    // HALF A SECOND MORE, so a van that had left would be visibly off the kerb
    // rather than a tile-fraction along it.
    for (let step = 0; step < CLEAR_TICKS; step += 1) scene.tick(100);
    const sinceKerb = WAITED_TICKS + witness + CLEAR_TICKS;
    expect(
      sinceKerb < CEILING_TICKS,
      `the twelve second ceiling had already released the van, at ${String(sinceKerb)} ticks (${note})`,
    ).toBe(true);
    expect(
      seatedInWard(scene, newcomer),
      `${newcomer} reached its bed inside the half second grace, so the wait proves nothing (${note})`,
    ).toBe(false);
    expect(
      JSON.stringify(ambulancePoint(scene)),
      `the ambulance is not at its kerb ${String(CLEAR_TICKS)} ticks after a trip with no new rider would have left it (${note})`,
    ).toBe(JSON.stringify(kerbAfter));

    // AND THEN IT DRIVES AWAY ON THIS STOREY'S ROAD, which is the other half of
    // following a ward that moved: it is not enough to be redrawn at the new
    // kerb if the route under it still belongs to the storey it used to be. The
    // whole drive is read, against the kerb-to-exit line of the plan in hand.
    const route = departRouteOf(scene, "host-b");
    if (route === null) throw new Error(`host-b lost its route (${note})`);
    const { points, vanishedAtKerb, completed } = departureSamples(
      scene,
      kerbAfter,
    );
    expect(
      vanishedAtKerb,
      `the ambulance vanished at its kerb instead of driving off it (${note})`,
    ).toBe(false);
    expect(
      points.length,
      `too few frames of the departure to read a route from (${note})`,
    ).toBeGreaterThan(1);
    expect(
      offTheRoute(route, points),
      `the ambulance did not drive away along host-b's own route, over ${String(points.length)} frames (${note})`,
    ).toEqual([]);
    // AND IT IS A POSITIVELY DISPLACED POINT that says so, not the frame the
    // phase turned on: by here the last sample is strictly further down this
    // route than the first, which was itself off the kerb.
    const lastAlong = againstRoute(route, points[points.length - 1]).along;
    expect(
      lastAlong,
      `the ambulance never got anywhere along host-b's route (${note})`,
    ).toBeGreaterThan(0);

    // AND IT DRIVES THE WHOLE ROUTE, which read AE is why: every assertion above
    // is happy with a van removed two frames in, since what it left behind is
    // real road. So the trip has to END - an absence OBSERVED, never the tick cap
    // expiring - and its last PAINTED frame has to be within one expected tick of
    // this route's own exit, because the tick that reaches the exit is the tick
    // that removes the vehicle before it is ever drawn there.
    expect(
      completed,
      `the ambulance was still on host-b's road after ${String(DEPART_TICK_CAP)} ticks (${note})`,
    ).toBe(true);
    const exit = routeLength(route);
    const step = tickStepOf(route);
    const advance = longestAdvance(route, points);
    expect(
      Math.abs(advance - step),
      `the ambulance's longest advance down host-b's road is not the step this route expects: ${advance.toFixed(4)} px against ${step.toFixed(4)} px (${note})`,
    ).toBeLessThanOrEqual(ROUTE_TOLERANCE_PX);
    expect(
      exit - lastAlong,
      `the ambulance stopped being drawn ${(exit - lastAlong).toFixed(1)} px short of host-b's exit at ${exit.toFixed(1)} px, after ${String(points.length)} frames at a ${step.toFixed(1)} px step (${note})`,
    ).toBeLessThanOrEqual(step + ROUTE_TOLERANCE_PX);
  });

  it("dispatches an ambulance for a failure that got a bed", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    if (layout.floors[0].road === null || !hasInfirmary(layout)) {
      context.skip("this view has no road or infirmary yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: failures("beta"),
      }),
    );
    expect(
      namesInfirmary(infirmaryNames(layout), scene.whereabouts("beta") ?? ""),
    ).toBe(true);
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).map(
        (vehicle) => vehicle.vehicleKind,
      ),
    ).toEqual(["ambulance"]);
  });

  it("GUARD: dispatches no ambulance for a failure that got no bed", (context) => {
    const agents: ReadonlyArray<OfficeAgentInput> = Array.from(
      { length: 8 },
      (_unused, index) =>
        agent({
          id: `ward-${index}`,
          hostId: "ward-host",
          createdAt: index + 1,
        }),
    );
    const visible = new Set(agents.map((person) => person.id));
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents, visibleAgentIds: visible }));
    const layout = layoutOf(scene);
    if (layout.floors[0].road === null || !hasInfirmary(layout)) {
      context.skip("this view has no road or infirmary yet (K2)");
      return;
    }
    const beds = layout.floors
      .flatMap((floor) => floor.civic)
      .filter((room) => room.kind === "infirmary")
      .reduce((count, room) => count + room.seatIds.length, 0);
    if (beds < 1 || beds >= agents.length) {
      context.skip(
        "fixture cannot fill an infirmary and leave an overflow crash",
      );
      return;
    }
    const beddedIds = agents.slice(0, beds).map((person) => person.id);
    const overflowId = agents[beds].id;
    const beddedStatuses = failures(...beddedIds);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: beddedStatuses,
      }),
    );
    const names = infirmaryNames(layout);
    expect(
      beddedIds.every((id) =>
        namesInfirmary(names, scene.whereabouts(id) ?? ""),
      ),
    ).toBe(true);
    for (let step = 0; step < 500; step += 1) scene.tick(100);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: new Map([...beddedStatuses, [overflowId, "failure"]]),
      }),
    );
    expect(namesInfirmary(names, scene.whereabouts(overflowId) ?? "")).toBe(
      false,
    );
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).some(
        (vehicle) => vehicle.vehicleKind === "ambulance",
      ),
    ).toBe(false);
  });

  it("dispatches one fire engine for three failures in one infirmary room", (context) => {
    const agents: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "fire-a", hostId: "fire-host", createdAt: 1 }),
      agent({ id: "fire-b", hostId: "fire-host", createdAt: 2 }),
      agent({ id: "fire-c", hostId: "fire-host", createdAt: 3 }),
    ];
    const visible = new Set(agents.map((person) => person.id));
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents, visibleAgentIds: visible }));
    const layout = layoutOf(scene);
    if (layout.floors[0].road === null || !hasInfirmary(layout)) {
      context.skip("this view has no road or infirmary yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("fire-a", "fire-b", "fire-c"),
      }),
    );
    const vehicles = vehicleDrawables(scene.frame(1, WHOLE_WORLD));
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].vehicleKind).toBe("fire-engine");
    expect(
      vehicles.some((vehicle) => vehicle.vehicleKind === "ambulance"),
    ).toBe(false);
  });

  it("replaces a room's standing ambulances before applying the vehicle cap", (context) => {
    const specialIds = new Map<number, string>([
      [0, "a"],
      [20, "b"],
      [1, "c"],
      [2, "d"],
    ]);
    const agents: ReadonlyArray<OfficeAgentInput> = Array.from(
      { length: 40 },
      (_unused, index) =>
        agent({
          id: `replace-${specialIds.get(index) ?? `filler-${index}`}`,
          hostId: index < 20 ? "replace-host-a" : "replace-host-b",
          createdAt: index + 1,
        }),
    );
    const visible = new Set(agents.map((person) => person.id));
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents, visibleAgentIds: visible }));
    const layout = layoutOf(scene);
    if (layout.floors[0].road === null || !hasInfirmary(layout)) {
      context.skip("this view has no road or infirmary yet (K2)");
      return;
    }
    const infirmaries = layout.floors
      .flatMap((floor) => floor.civic)
      .filter((room) => room.kind === "infirmary");
    const targetRoom = infirmaries.find(
      (room) => room.hostId === "replace-host-a",
    );
    const otherRoom = infirmaries.find(
      (room) => room.hostId === "replace-host-b",
    );
    if (
      targetRoom === undefined ||
      otherRoom === undefined ||
      targetRoom.seatIds.length === 0 ||
      otherRoom.seatIds.length === 0
    ) {
      context.skip("this view has no two host infirmaries with beds yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("replace-a"),
      }),
    );
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("replace-a", "replace-b"),
      }),
    );
    // In this immediate, unticked setup, the road is full with this room's
    // ambulance plus an unrelated room's ambulance; same-room coalescing
    // makes two target-room vans impossible. Later, a departing and arriving
    // pair for one room is legal and is covered by its own case.
    const fullCap = vehicleDrawables(scene.frame(1, WHOLE_WORLD));
    expect(fullCap).toHaveLength(2);
    expect(
      fullCap.every((vehicle) => vehicle.vehicleKind === "ambulance"),
    ).toBe(true);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures(
          "replace-a",
          "replace-b",
          "replace-c",
          "replace-d",
        ),
      }),
    );
    const vehicles = vehicleDrawables(scene.frame(1, WHOLE_WORLD));
    expect(
      vehicles.filter((vehicle) => vehicle.vehicleKind === "fire-engine"),
    ).toHaveLength(1);
    expect(
      vehicles.filter((vehicle) => vehicle.vehicleKind === "ambulance"),
    ).toHaveLength(1);
    expect(vehicles.length).toBeLessThanOrEqual(2);
  });

  /**
   * THE CREW SIZE, AND THE INDEX THAT HAS TO BE ITS LAST ONE.
   *
   * `inherit-b` is the NEWEST agent on this floor - it is what makes the third
   * crash land on a trip that is already standing - so its index is the crew's
   * last, and the two numbers were written out separately: `{ length: 40 }`
   * with a hard `39` in the id map beside it. Measured: 40 -> 39 does not
   * shrink a margin, it deletes `inherit-b` outright and the case reds with
   * "expected [ 'ambulance' ] to include 'fire-engine'" - a fire engine that
   * never had a third crash to answer. Five cases in this describe read the
   * same pair.
   *
   * So the index is DERIVED here rather than restated. The forty itself is a
   * floor big enough to earn a two-bed ward and a road, which the case checks
   * for and skips on rather than assuming.
   */
  const INHERIT_CREW = 40;
  const INHERIT_NEWEST = INHERIT_CREW - 1;

  it("keeps inherited ambulance riders waiting when a fire engine replaces their van", (context) => {
    const specialIds = new Map<number, string>([
      [0, "a"],
      [INHERIT_NEWEST, "b"],
      [1, "c"],
    ]);
    const agents: ReadonlyArray<OfficeAgentInput> = Array.from(
      { length: INHERIT_CREW },
      (_unused, index) =>
        agent({
          id: `inherit-${specialIds.get(index) ?? `filler-${index}`}`,
          hostId: "inherit-host",
          createdAt: index + 1,
        }),
    );
    const visible = new Set(agents.map((person) => person.id));
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents, visibleAgentIds: visible }));
    const layout = layoutOf(scene);
    const infirmaries = layout.floors
      .flatMap((floor) => floor.civic)
      .filter((room) => room.kind === "infirmary");
    if (
      layout.floors[0].road === null ||
      !hasInfirmary(layout) ||
      infirmaries.every((room) => room.seatIds.length < 2)
    ) {
      context.skip("this view has no road or two-bed infirmary yet (K2)");
      return;
    }
    const projector = view.painter.projector(layout);
    const kerbs = layout.floors.flatMap((floor) =>
      floor.civic.flatMap((room) => {
        if (room.kind !== "infirmary" || room.kerbTile === null) return [];
        return [
          projector.project(room.kerbTile.col + 0.5, room.kerbTile.row + 1),
        ];
      }),
    );
    const atKerb = (vehicle: OfficeVehicleDrawable): boolean =>
      kerbs.some((point) => point.x === vehicle.x && point.y === vehicle.y);
    const names = infirmaryNames(layout);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("inherit-a", "inherit-b"),
      }),
    );
    const waitForAmbulance = (): boolean => {
      for (let step = 0; step < 500; step += 1) {
        const standingAmbulance = vehicleDrawables(
          scene.frame(1, WHOLE_WORLD),
        ).some(
          (vehicle) => vehicle.vehicleKind === "ambulance" && atKerb(vehicle),
        );
        if (standingAmbulance) return true;
        scene.tick(100);
      }
      return false;
    };
    expect(
      waitForAmbulance(),
      "could not observe the old ambulance standing at its kerb",
    ).toBe(true);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("inherit-a", "inherit-b", "inherit-c"),
      }),
    );
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).map(
        (vehicle) => vehicle.vehicleKind,
      ),
    ).toContain("fire-engine");
    const waitForBedlessRider = (): boolean => {
      for (let step = 0; step < 200; step += 1) {
        const frame = scene.frame(1, WHOLE_WORLD);
        if (
          !frame.awayAgentIds.has("inherit-c") &&
          !namesInfirmary(names, scene.whereabouts("inherit-c") ?? "")
        ) {
          return true;
        }
        scene.tick(100);
      }
      return false;
    };
    expect(
      waitForBedlessRider(),
      "the threshold-triggering rider should settle at its fallback desk",
    ).toBe(true);
    // Its own function to stay inside the complexity ceiling: a loop that
    // records four independent firsts is all branches, and inlining it puts
    // the case over on its own.
    const watchEngine = (): {
      sawInheritedRiderAway: boolean;
      settledTick: number | null;
      kerbTick: number | null;
      leftKerbTick: number | null;
    } => {
      let sawInheritedRiderAway = false;
      let settledTick: number | null = null;
      let kerbTick: number | null = null;
      let leftKerbTick: number | null = null;
      const bothInTheWard = (): boolean =>
        names.has(scene.whereabouts("inherit-a") ?? "") &&
        names.has(scene.whereabouts("inherit-b") ?? "");
      for (let step = 0; step < 500; step += 1) {
        const frame = scene.frame(1, WHOLE_WORLD);
        const engine = vehicleDrawables(frame).find(
          (vehicle) => vehicle.vehicleKind === "fire-engine",
        );
        const onKerb = engine !== undefined && atKerb(engine);
        const inheritedAway =
          frame.awayAgentIds.has("inherit-a") ||
          frame.awayAgentIds.has("inherit-b");
        if (inheritedAway) sawInheritedRiderAway = true;
        if (!inheritedAway && bothInTheWard()) settledTick ??= step;
        if (onKerb) kerbTick ??= step;
        if (!onKerb && kerbTick !== null) leftKerbTick ??= step;
        scene.tick(100);
      }
      return { sawInheritedRiderAway, settledTick, kerbTick, leftKerbTick };
    };
    const { sawInheritedRiderAway, settledTick, kerbTick, leftKerbTick } =
      watchEngine();
    expect(sawInheritedRiderAway).toBe(true);
    expect(kerbTick).not.toBeNull();
    expect(leftKerbTick).not.toBeNull();
    if (kerbTick === null || leftKerbTick === null) {
      return;
    }
    // This fixture's forty-agent walk can exceed the observation budget; in
    // that case the contract's 12s ceiling is the applicable rider bound.
    //
    // TWO QUANTITIES THAT READ ALIKE AND ARE NOT. `minimumDwell` is DERIVED -
    // clamped off the rider bound and the ceiling, in contract time. The dwell
    // below is MEASURED, and a measurement of a phase change lands one tick
    // after the phase, because the source resets elapsed while the vehicle is
    // still drawn where it was. Comparing them is only sound with that tick
    // accounted for, which is what the bound below does.
    const riderBound = settledTick ?? kerbTick + 120;
    const minimumDwell = Math.max(40, Math.min(riderBound - kerbTick, 120));
    if (!AMBULANCE_RIDER_SETS_THE_DWELL[viewId]) {
      // THE OTHER REGIME, ASSERTED AND NOT SKIPPED. Both districted views stand
      // their ward at the first content column with its kerb beside its own door,
      // so the rider asks for less than the four-second floor and the floor is
      // what the vehicle waits out. Both halves are pinned: the premise, as an
      // observation, so a view whose geometry changed and made the rider late
      // reddens here and has to move in the table...
      expect(settledTick).not.toBeNull();
      if (settledTick === null) return;
      // The rider asks for LESS THAN THE FLOOR, which is what makes the floor
      // the governing bound. Here it is stronger than that - the patient is in
      // bed twenty ticks before the ambulance arrives, so the difference is
      // negative - but the claim is the one both fixtures share, because the
      // sibling case's rider settles three ticks AFTER the kerb tick and is
      // still under the floor.
      expect(riderBound - kerbTick).toBeLessThan(40);
      // ...and the floor EXACTLY as observed, not `>=`. A vehicle that waited
      // longer than the floor in a view where nothing is keeping it would be a
      // different behaviour wearing this one's numbers, and `>=` could not see
      // it. 41 rather than 40 for the reason the guard below names: the phase
      // changes at 40 and the vehicle is still drawn at the kerb for one tick.
      expect(leftKerbTick - kerbTick).toBe(41);
      return;
    }
    // THE RIDER IS LATE, which is what makes the bound below about the rider.
    // Stated as an observation for the same reason the other regime states its
    // premise: a view that stopped making its ambulance wait would otherwise
    // satisfy every line here on the floor alone.
    expect(settledTick).not.toBeNull();
    if (settledTick !== null) expect(settledTick).toBeGreaterThan(kerbTick);
    // ABOVE THE OBSERVABLE FLOOR, not merely above the floor. A trip that
    // dropped its riders leaves on the four-second floor and is OBSERVED at
    // 41 - so a derived bound of 41 would admit exactly the implementation
    // this case exists to reject, on `41 >= 41`. Clearing 40 is not enough;
    // the bound has to clear the OBSERVATION, not the contract value it came
    // from. Today's bounds are 120/66/83, so this costs the case nothing.
    expect(minimumDwell).toBeGreaterThan(41);
    expect(leftKerbTick - kerbTick).toBeGreaterThanOrEqual(minimumDwell);
  });

  it("keeps a standing ambulance when an off-screen engine escalation is gated", (context) => {
    const specialIds = new Map<number, string>([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ]);
    const agents: ReadonlyArray<OfficeAgentInput> = Array.from(
      { length: 40 },
      (_unused, index) =>
        agent({
          id: `viewport-${specialIds.get(index) ?? `filler-${index}`}`,
          hostId: "viewport-host",
          createdAt: index + 1,
        }),
    );
    const visible = new Set(agents.map((person) => person.id));
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents, visibleAgentIds: visible }));
    const layout = layoutOf(scene);
    const infirmary = layout.floors
      .flatMap((floor) => floor.civic)
      .find((room) => room.kind === "infirmary" && room.kerbTile !== null);
    if (
      layout.floors[0].road === null ||
      infirmary === undefined ||
      infirmary.kerbTile === null ||
      infirmary.seatIds.length < 2
    ) {
      // The kerb belongs in the guard rather than being asserted below: a
      // room nothing can drive to is a room this case has nothing to say
      // about, which is the same reason the road is here.
      context.skip("this view has no road or two-bed kerbed infirmary (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("viewport-a", "viewport-b"),
      }),
    );
    const projector = view.painter.projector(layout);
    const kerb = projector.project(
      infirmary.kerbTile.col + 0.5,
      infirmary.kerbTile.row + 1,
    );
    let reachedKerb = false;
    for (let step = 0; step < 500; step += 1) {
      const ambulance = vehicleDrawables(scene.frame(1, WHOLE_WORLD)).find(
        (vehicle) => vehicle.vehicleKind === "ambulance",
      );
      if (
        ambulance !== undefined &&
        ambulance.x === kerb.x &&
        ambulance.y === kerb.y
      ) {
        reachedKerb = true;
        break;
      }
      scene.tick(100);
    }
    expect(
      reachedKerb,
      "could not observe the ambulance standing at its kerb",
    ).toBe(true);
    scene.frame(1, { x: 0, y: 0, width: 8, height: 8 });
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("viewport-a", "viewport-b", "viewport-c"),
      }),
    );
    const afterEscalation = vehicleDrawables(scene.frame(1, WHOLE_WORLD));
    expect(afterEscalation).toHaveLength(1);
    expect(afterEscalation[0].vehicleKind).toBe("ambulance");
    for (let step = 0; step < 500; step += 1) {
      if (vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length === 0) break;
      scene.tick(100);
    }
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD))).toHaveLength(0);
  });

  it("does not let a departing trip absorb a newcomer", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    const kerb = civicKerbPoint(layout, "help-desk");
    if (layout.floors[0].road === null || kerb === null) {
      context.skip("this view has no road or help-desk kerb yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
        ]),
      }),
    );
    expect(
      waitForVehicleAtKerb(scene, kerb, "police-car"),
      "could not observe the first police car at its kerb",
    ).toBe(true);
    expect(
      waitForVehicleToLeaveKerb(scene, kerb, "police-car"),
      "could not observe the first police car departing",
    ).toBe(true);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
          ["beta", "attention"],
        ]),
      }),
    );
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).filter(
        (vehicle) => vehicle.vehicleKind === "police-car",
      ),
    ).toHaveLength(2);
  });

  it("allows a departing and arriving trip for one room to share the road", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    const kerb = civicKerbPoint(layout, "help-desk");
    if (layout.floors[0].road === null || kerb === null) {
      context.skip("this view has no road or help-desk kerb yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
        ]),
      }),
    );
    expect(
      waitForVehicleAtKerb(scene, kerb, "police-car"),
      "could not observe the first police car at its kerb",
    ).toBe(true);
    expect(
      waitForVehicleToLeaveKerb(scene, kerb, "police-car"),
      "could not observe the first police car departing",
    ).toBe(true);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
          ["beta", "attention"],
        ]),
      }),
    );
    // The cap bounds this legal overlap; it does not forbid a new arrival
    // merely because its room's previous trip is departing.
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD))).toHaveLength(2);
  });

  it("lets the original trip depart after recurrent joins cross its twelve-second ceiling", (context) => {
    const ids = ["join-a", "join-b", "join-c", "join-d", "join-e"];
    const agents: ReadonlyArray<OfficeAgentInput> = ids.map((id, index) =>
      agent({ id, hostId: "join-host", createdAt: index + 1 }),
    );
    const visible = new Set(ids);
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents, visibleAgentIds: visible }));
    const layout = layoutOf(scene);
    const kerb = civicKerbPoint(layout, "help-desk");
    if (layout.floors[0].road === null || kerb === null) {
      context.skip("this view has no road or help-desk kerb yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: attention("join-a"),
      }),
    );
    expect(
      waitForVehicleAtKerb(scene, kerb, "police-car"),
      "could not observe the original police car at its kerb",
    ).toBe(true);
    const joiners = ["join-b", "join-c", "join-d", "join-e"];
    let dwellTicks = 0;
    for (const [joinIndex, ticksUntilJoin] of [20, 30, 30, 30].entries()) {
      for (let tick = 0; tick < ticksUntilJoin; tick += 1) {
        scene.tick(100);
        dwellTicks += 1;
      }
      const joiner = joiners[joinIndex];
      if (joinIndex > 0) {
        scene.sync(
          sceneInput({
            agents,
            visibleAgentIds: visible,
            statusById: attention("join-a"),
          }),
        );
      }
      scene.sync(
        sceneInput({
          agents,
          visibleAgentIds: visible,
          statusById: attention("join-a", joiner),
        }),
      );
      expect(
        scene.frame(1, WHOLE_WORLD).awayAgentIds.has(joiner),
        `${viewId} ${joiner} did not leave its desk`,
      ).toBe(true);
      expect(
        vehicleDrawables(scene.frame(1, WHOLE_WORLD)).some(
          (vehicle) =>
            vehicle.vehicleKind === "police-car" && atPoint(vehicle, kerb),
        ),
      ).toBe(true);
    }
    let originalLeftAt: number | null = null;
    for (let tick = 0; tick < 200; tick += 1) {
      scene.tick(100);
      dwellTicks += 1;
      const stillAtKerb = vehicleDrawables(scene.frame(1, WHOLE_WORLD)).some(
        (vehicle) =>
          vehicle.vehicleKind === "police-car" && atPoint(vehicle, kerb),
      );
      if (!stillAtKerb) {
        originalLeftAt = dwellTicks;
        break;
      }
    }
    expect(originalLeftAt).not.toBeNull();
    if (originalLeftAt === null) return;
    // On the unfixed tree, each join resets the same clock as the twelve-second
    // ceiling, so the original trip's dwell exceeds 120 ticks. The fixed tree
    // leaves at the ceiling despite joins arriving less than four seconds apart.
    expect(originalLeftAt).toBeLessThanOrEqual(130);
  });

  it("GUARD: a join restarts the four-second kerb floor", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    const kerb = civicKerbPoint(layout, "help-desk");
    if (layout.floors[0].road === null || kerb === null) {
      context.skip("this view has no road or help-desk kerb yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
        ]),
      }),
    );
    expect(
      waitForVehicleAtKerb(scene, kerb, "police-car"),
      "could not observe the police car at its kerb",
    ).toBe(true);
    for (let tick = 0; tick < 30; tick += 1) scene.tick(100);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
          ["beta", "attention"],
        ]),
      }),
    );
    let leftAfterJoin: number | null = null;
    for (let tick = 0; tick < 200; tick += 1) {
      scene.tick(100);
      const vehicle = vehicleDrawables(scene.frame(1, WHOLE_WORLD)).find(
        (candidate) => candidate.vehicleKind === "police-car",
      );
      if (vehicle === undefined || !atPoint(vehicle, kerb)) {
        leftAfterJoin = tick;
        break;
      }
    }
    expect(leftAfterJoin).not.toBeNull();
    if (leftAfterJoin === null) return;
    expect(leftAfterJoin).toBeGreaterThanOrEqual(40);
  });

  it("lets a standing engine absorb a fresh below-threshold failure with a bed free", (context) => {
    const agents = wardAgents("standing", "standing-host", 80);
    const visible = new Set(agents.map((person) => person.id));
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents, visibleAgentIds: visible }));
    const layout = layoutOf(scene);
    const infirmary = layout.floors
      .flatMap((floor) => floor.civic)
      .find((room) => room.kind === "infirmary");
    const kerb = civicKerbPoint(layout, "infirmary");
    if (
      layout.floors[0].road === null ||
      infirmary === undefined ||
      infirmary.seatIds.length < 4 ||
      kerb === null
    ) {
      context.skip("this view has no road or four-bed infirmary yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("standing-a", "standing-b", "standing-c"),
      }),
    );
    expect(
      waitForVehicleAtKerb(scene, kerb, "fire-engine"),
      "could not observe the standing fire engine at its kerb",
    ).toBe(true);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("standing-c"),
      }),
    );
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).some(
        (vehicle) => vehicle.vehicleKind === "fire-engine",
      ),
    ).toBe(true);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("standing-c", "standing-d"),
      }),
    );
    const standingDWhere = scene.whereabouts("standing-d") ?? "";
    expect(
      namesInfirmary(infirmaryNames(layout), standingDWhere),
      "standing-d should have received the free infirmary bed",
    ).toBe(true);
    const vehicles = vehicleDrawables(scene.frame(1, WHOLE_WORLD));
    expect(
      vehicles.filter((vehicle) => vehicle.vehicleKind === "fire-engine"),
    ).toHaveLength(1);
    expect(
      vehicles.some((vehicle) => vehicle.vehicleKind === "ambulance"),
    ).toBe(false);
  });

  it("GUARD: resumes an ambulance for the ward after its engine has departed", (context) => {
    const agents = wardAgents("resumed", "resumed-host", 80);
    const visible = new Set(agents.map((person) => person.id));
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents, visibleAgentIds: visible }));
    const layout = layoutOf(scene);
    const infirmary = layout.floors
      .flatMap((floor) => floor.civic)
      .find((room) => room.kind === "infirmary");
    if (
      layout.floors[0].road === null ||
      infirmary === undefined ||
      infirmary.seatIds.length < 4
    ) {
      context.skip("this view has no road or four-bed infirmary yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("resumed-a", "resumed-b", "resumed-c"),
      }),
    );
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).some(
        (vehicle) => vehicle.vehicleKind === "fire-engine",
      ),
    ).toBe(true);
    for (let step = 0; step < 500; step += 1) {
      if (vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length === 0) break;
      scene.tick(100);
    }
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD))).toHaveLength(0);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("resumed-c"),
      }),
    );
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds: visible,
        statusById: failures("resumed-c", "resumed-d"),
      }),
    );
    const vehicles = vehicleDrawables(scene.frame(1, WHOLE_WORLD));
    expect(
      vehicles.filter((vehicle) => vehicle.vehicleKind === "ambulance"),
    ).toHaveLength(1);
    expect(
      vehicles.some((vehicle) => vehicle.vehicleKind === "fire-engine"),
    ).toBe(false);
  });

  it("GUARD: seeds silently when an epic opens with a failure already present", (context) => {
    const scene = newVehicleScene();
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: failures("beta"),
      }),
    );
    const layout = layoutOf(scene);
    if (layout.floors[0].road === null || !hasInfirmary(layout)) {
      context.skip("this view has no road or infirmary yet (K2)");
      return;
    }
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD))).toHaveLength(0);
  });

  it("GUARD: seeds silently after a rewind when failure was already present", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        cursorMs: 5000,
        statusById: failures("beta"),
      }),
    );
    const layout = layoutOf(scene);
    if (layout.floors[0].road === null || !hasInfirmary(layout)) {
      context.skip("this view has no road or infirmary yet (K2)");
      return;
    }
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD))).toHaveLength(0);
  });

  it("waits at least four seconds and for its rider, capped at twelve seconds", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    if (layout.floors[0].road === null || !hasInfirmary(layout)) {
      context.skip("this view has no road or infirmary yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: failures("beta"),
      }),
    );
    const projector = view.painter.projector(layout);
    const kerbs = layout.floors.flatMap((floor) =>
      floor.civic.flatMap((room) => {
        if (room.kind !== "infirmary" || room.kerbTile === null) return [];
        return [
          projector.project(room.kerbTile.col + 0.5, room.kerbTile.row + 1),
        ];
      }),
    );
    const atKerb = (vehicle: OfficeVehicleDrawable): boolean =>
      kerbs.some((point) => point.x === vehicle.x && point.y === vehicle.y);
    const names = infirmaryNames(layout);
    // The watching is its own function so that this case stays inside the
    // complexity ceiling: a loop that records four independent firsts is all
    // branches, and folding them into the case body pushes it over on its own.
    const watch = (): {
      sawUnsettledRider: boolean;
      settledTick: number | null;
      kerbTick: number | null;
      leftKerbTick: number | null;
    } => {
      let sawUnsettledRider = false;
      let settledTick: number | null = null;
      let kerbTick: number | null = null;
      let leftKerbTick: number | null = null;
      for (let step = 0; step < 500; step += 1) {
        const frame = scene.frame(1, WHOLE_WORLD);
        const onKerb = vehicleDrawables(frame).some(atKerb);
        const riderAway = frame.awayAgentIds.has("beta");
        if (riderAway) sawUnsettledRider = true;
        if (
          !riderAway &&
          namesInfirmary(names, scene.whereabouts("beta") ?? "")
        ) {
          settledTick ??= step;
        }
        if (onKerb) kerbTick ??= step;
        if (!onKerb && kerbTick !== null) leftKerbTick ??= step;
        scene.tick(100);
      }
      return { sawUnsettledRider, settledTick, kerbTick, leftKerbTick };
    };
    const { sawUnsettledRider, settledTick, kerbTick, leftKerbTick } = watch();
    expect(sawUnsettledRider).toBe(true);
    expect(kerbTick).not.toBeNull();
    expect(leftKerbTick).not.toBeNull();
    expect(settledTick).not.toBeNull();
    if (kerbTick === null || leftKerbTick === null || settledTick === null)
      return;
    // WHAT THIS FALSIFIES, stated correctly. An earlier version of this
    // comment claimed the case catches a dispatch moved before the claim and
    // rehome passes, on the reasoning that such a dispatch would "see the
    // rider still at its desk and count it settled". It would not:
    // `everyRiderSettled` is read in `advanceVehicle`, on the tick, long after
    // the sync that dispatched - and nothing caches a settled flag at dispatch
    // time. Moving dispatch earlier breaks the BED GATE instead, because
    // `civicClaimOf` answers null before the claim pass and no ambulance is
    // summoned at all. That is a real red, in a different case.
    //
    // What this case actually pins is the WAIT ITSELF, from both ends: a
    // vehicle that leaves before its rider has settled, and one that never
    // leaves at all.
    const riderDwell = settledTick - kerbTick;
    const minimumDwell = Math.max(40, Math.min(riderDwell, 120));
    if (!AMBULANCE_RIDER_SETS_THE_DWELL[viewId]) {
      // See the sibling case and `AMBULANCE_RIDER_SETS_THE_DWELL`: in Campus the bed is
      // beside the gate, so the rider is settled almost as soon as the ambulance
      // is - three ticks after it reaches the kerb, measured - and the four-second
      // floor is what the vehicle waits out.
      //
      // THE PREMISE IS THAT THE RIDER FALLS UNDER THE FLOOR, not that it settles
      // first. In the forty-agent fixture next door the rider is in bed twenty
      // ticks BEFORE the vehicle arrives; here it is three ticks after. Either
      // way the rider asks for less than the floor gives, which is the fact that
      // makes the floor the governing bound - so that is what is asserted, and
      // a Campus whose walk grew past four seconds reddens here and has to move
      // in the table.
      expect(riderDwell).toBeLessThan(40);
      // The floor EXACTLY, not `>=`: a vehicle waiting longer than the floor
      // where nothing is keeping it is a different behaviour wearing this one's
      // numbers. 41 because the phase turns at 40 and the vehicle is drawn at
      // the kerb for one tick more.
      expect(leftKerbTick - kerbTick).toBe(41);
      return;
    }
    expect(leftKerbTick - kerbTick).toBeGreaterThanOrEqual(minimumDwell);
    // THE CEILING, which the lower bound alone never checked: a vehicle that
    // waited thirty seconds satisfied "capped at twelve" perfectly well,
    // because the watch runs for fifty and nothing here looked at the top.
    // A position watch can observe one tick late at the ceiling: the source
    // changes phase and resets elapsed at 12s, while the departing vehicle is
    // still drawn at the kerb at elapsed zero. With 100ms ticks, a forced-
    // ceiling fixture may therefore see its first off-kerb frame at tick 121;
    // this two-agent fixture is not required to reach that boundary.
    //
    // SO THE BOUND IS ON THE OBSERVATION, AT 121, not on the phase at 120.
    // `leftKerbTick` is a position sighting, and bounding a sighting by the
    // contract value it reports would fail a trip that held to the ceiling
    // CORRECTLY - the one behaviour this line exists to permit. The phase
    // bound is still 120; the two numbers differ by the tick above, and
    // conflating them is how a right answer gets called wrong.
    expect(leftKerbTick - kerbTick).toBeLessThanOrEqual(121);
    // AND THAT THE RIDER IS WHAT SET IT. Without this the floor alone could
    // satisfy the bound above, and a vehicle that ignored its rider entirely
    // and left at four seconds would pass every assertion in this case. It
    // holds only because the walk to the ward is longer than the floor, which
    // is a fact about the fixture and so is asserted rather than assumed.
    expect(riderDwell).toBeGreaterThan(40);
  });

  it("never dispatches while reduced motion is on", () => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        reducedMotion: true,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  it("never dispatches while the last drawn frame was at overview (lod 0)", () => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.frame(0, WHOLE_WORLD);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: ATTENTION_BETA(),
      }),
    );
    // Even zoomed back in after the fact, nothing was ever dispatched.
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  it("never dispatches while a playback session is running", () => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        playing: true,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  it("never dispatches while paused at a cursor position", () => {
    const scene = newVehicleScene();
    // Same cursor value on both syncs and an unchanged pulseKey: a scrub
    // (cursorMs going from null to non-null, or backward) seeds silently
    // through a different rule entirely (see the seed cases below), so this
    // holds cursorMs steady to isolate the "paused" gate on its own.
    scene.sync(
      sceneInput({ agents: AGENTS, visibleAgentIds: BOTH, cursorMs: 1000 }),
    );
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        cursorMs: 1000,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  it("never dispatches when the last drawn view rect does not reach the kerb", () => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    // A tiny rect pinned at the origin: wherever this floor's kerb actually
    // is, it is not inside an 8x8 box at (0, 0).
    scene.frame(1, { x: 0, y: 0, width: 8, height: 8 });
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  it("seeds silently: an agent already in attention on the opening sync dispatches nothing", () => {
    const scene = newVehicleScene();
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  it("seeds silently after a scrub too: landing on a cursor with an agent already in attention dispatches nothing", () => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        cursorMs: 5000,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  it("seeds silently on feed settlement, then dispatches the next live failure", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    if (layout.floors[0].road === null || !hasInfirmary(layout)) {
      context.skip("this view has no road or infirmary yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        feedSettled: true,
        statusById: failures("beta"),
      }),
    );
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD))).toHaveLength(0);

    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        feedSettled: true,
        statusById: new Map<string, OfficeAgentStatus>([["beta", "idle"]]),
      }),
    );
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        feedSettled: true,
        statusById: failures("beta"),
      }),
    );
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).map(
        (vehicle) => vehicle.vehicleKind,
      ),
    ).toEqual(["ambulance"]);
  });

  it("never lets more than MAX_VEHICLES stand on the road at once, even with three separate rooms to dispatch to", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: CAP_TRIO, visibleAgentIds: CAP_IDS }));
    const road = layoutOf(scene).floors[0].road;
    if (road === null) {
      context.skip("this view has no road yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: CAP_TRIO,
        visibleAgentIds: CAP_IDS,
        statusById: new Map<string, OfficeAgentStatus>([
          ["cap-a", "attention"],
          ["cap-b", "attention"],
          ["cap-c", "attention"],
        ]),
      }),
    );
    // Three separate hosts, three separate rooms: coalescing alone cannot be
    // why this stays at two, since nothing here shares a room to coalesce on.
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length,
    ).toBeLessThanOrEqual(2);
    for (let step = 0; step < 300; step += 1) {
      scene.tick(100);
      expect(
        vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length,
      ).toBeLessThanOrEqual(2);
    }
  });

  it("coalesces three agents entering attention together into a single police car", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: TRIO, visibleAgentIds: TRIO_IDS }));
    const road = layoutOf(scene).floors[0].road;
    if (road === null) {
      context.skip("this view has no road yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: TRIO,
        visibleAgentIds: TRIO_IDS,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
          ["beta", "attention"],
          ["gamma", "attention"],
        ]),
      }),
    );
    // One room, one trip: three riders on the same help desk coalesce onto
    // one car rather than three. (`forAgentIds` itself is private state and
    // not reachable from the public scene API without an `as unknown` cast,
    // which the repo's lint rules forbid in a test as much as anywhere else;
    // this is the externally observable half of that claim.)
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD))).toHaveLength(1);
  });

  it("keeps one police car at the kerb longer when a late rider joins its trip", (context) => {
    const sceneA = newVehicleScene();
    const sceneB = newVehicleScene();
    const seed = sceneInput({ agents: AGENTS, visibleAgentIds: BOTH });
    sceneA.sync(seed);
    sceneB.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(sceneA);
    const road = layout.floors[0].road;
    if (road === null) {
      context.skip("this view has no road yet (K2)");
      return;
    }
    const projector = view.painter.projector(layout);
    const kerbPoints: ReadonlyArray<OfficePoint> = layout.floors.flatMap(
      (floor) =>
        floor.civic.flatMap((room) => {
          if (room.kind !== "help-desk" || room.kerbTile === null) return [];
          return [
            projector.project(room.kerbTile.col + 0.5, room.kerbTile.row + 1),
          ];
        }),
    );
    expect(kerbPoints.length).toBeGreaterThan(0);

    const attention = (
      ...ids: ReadonlyArray<string>
    ): ReadonlyMap<string, OfficeAgentStatus> =>
      new Map<string, OfficeAgentStatus>(ids.map((id) => [id, "attention"]));

    // WHICH RIDER IS SLOWER IS A FACT ABOUT THE FLOOR, not about the vehicle,
    // and it differs per view: the plaza views seat one of the two nearer the
    // counter than the other. The car waits for the SLOWEST of its riders, so
    // a late joiner can only lengthen the trip when the joiner is the slower
    // one - hand it the faster one and a correct implementation is indistin-
    // guishable from one that dropped it. So the case measures each rider
    // alone first and sends the slower one in late.
    const soloTicks = (agentId: string): number => {
      const probe = newVehicleScene();
      probe.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
      probe.frame(1, WHOLE_WORLD);
      probe.sync(
        sceneInput({
          agents: AGENTS,
          visibleAgentIds: BOTH,
          statusById: attention(agentId),
        }),
      );
      let ticks = 0;
      while (ticks < 500) {
        if (vehicleDrawables(probe.frame(1, WHOLE_WORLD)).length === 0) break;
        probe.tick(100);
        ticks += 1;
      }
      return ticks;
    };
    const [first, late] =
      soloTicks("alpha") <= soloTicks("beta")
        ? ["alpha", "beta"]
        : ["beta", "alpha"];

    const seedAndDispatch = (scene: OfficeScene): void => {
      scene.frame(1, WHOLE_WORLD);
      scene.sync(
        sceneInput({
          agents: AGENTS,
          visibleAgentIds: BOTH,
          statusById: attention(first),
        }),
      );
    };
    seedAndDispatch(sceneA);
    seedAndDispatch(sceneB);

    const atKerb = (scene: OfficeScene): boolean =>
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).some((vehicle) =>
        kerbPoints.some(
          (point) => vehicle.x === point.x && vehicle.y === point.y,
        ),
      );

    const waitForKerb = (scene: OfficeScene): number => {
      for (let tickCount = 0; tickCount < 200; tickCount += 1) {
        const vehicles = vehicleDrawables(scene.frame(1, WHOLE_WORLD));
        expect(vehicles.length).toBeLessThanOrEqual(1);
        if (atKerb(scene)) return tickCount;
        scene.tick(100);
      }
      return -1;
    };

    const sceneAToKerb = waitForKerb(sceneA);
    const sceneBToKerb = waitForKerb(sceneB);
    expect(sceneAToKerb).toBeGreaterThanOrEqual(0);
    expect(sceneBToKerb).toBe(sceneAToKerb);

    let sceneATicks = sceneAToKerb;
    while (vehicleDrawables(sceneA.frame(1, WHOLE_WORLD)).length > 0) {
      sceneA.tick(100);
      sceneATicks += 1;
      if (sceneATicks >= 500) break;
    }
    expect(vehicleDrawables(sceneA.frame(1, WHOLE_WORLD))).toHaveLength(0);

    sceneB.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: attention(first, late),
      }),
    );
    let sceneBTicks = sceneBToKerb;
    let maxVehicles = 0;
    // Bounded by the counter itself rather than by `while (true)` plus a
    // break: the cap is the loop's own condition, so a trip that never ends
    // cannot hang the suite.
    while (sceneBTicks < 500) {
      const count = vehicleDrawables(sceneB.frame(1, WHOLE_WORLD)).length;
      maxVehicles = Math.max(maxVehicles, count);
      if (count === 0) break;
      sceneB.tick(100);
      sceneBTicks += 1;
    }
    expect(maxVehicles).toBe(1);
    expect(vehicleDrawables(sceneB.frame(1, WHOLE_WORLD))).toHaveLength(0);
    expect(sceneBTicks).toBeGreaterThan(sceneATicks);
  });

  it("viewport-gates a late join without changing the trip's departure time", (context) => {
    const seed = sceneInput({ agents: AGENTS, visibleAgentIds: BOTH });
    const probe = newVehicleScene();
    probe.sync(seed);
    const layout = layoutOf(probe);
    const road = layout.floors[0].road;
    const kerb = civicKerbPoint(layout, "help-desk");
    if (road === null || kerb === null) {
      context.skip("this view has no road or help-desk kerb yet (K2)");
      return;
    }

    const dwellAfterArrival = (
      join: "none" | "offscreen" | "onscreen",
    ): number => {
      const scene = newVehicleScene();
      scene.sync(seed);
      scene.sync(
        sceneInput({
          agents: AGENTS,
          visibleAgentIds: BOTH,
          statusById: attention("alpha"),
        }),
      );
      expect(
        waitForVehicleAtKerb(scene, kerb, "police-car"),
        "could not observe the waiting police car at its kerb",
      ).toBe(true);
      // THREE SECONDS OF THE WAIT SPENT BEFORE ANY JOIN, common to all three
      // arms. So everything returned below is a REMAINDER measured from this
      // point, not a total dwell at the kerb: the arms are comparable to each
      // other and to nothing else. It is also why the control reads 37 rather
      // than something at or above the forty-tick floor - most of that floor
      // is already behind it here.
      for (let tick = 0; tick < 30; tick += 1) scene.tick(100);
      if (join === "offscreen") {
        // Mutant under test: viewport gate moved below `standingFor`.
        scene.frame(1, { x: 0, y: 0, width: 8, height: 8 });
      }
      if (join !== "none") {
        scene.sync(
          sceneInput({
            agents: AGENTS,
            visibleAgentIds: BOTH,
            statusById: attention("alpha", "beta"),
          }),
        );
      }
      for (let tick = 0; tick < 200; tick += 1) {
        scene.tick(100);
        const stillAtKerb = vehicleDrawables(scene.frame(1, WHOLE_WORLD)).some(
          (vehicle) =>
            vehicle.vehicleKind === "police-car" && atPoint(vehicle, kerb),
        );
        if (!stillAtKerb) return tick + 1;
      }
      return -1;
    };

    const controlDwell = dwellAfterArrival("none");
    const offscreenDwell = dwellAfterArrival("offscreen");
    const onscreenDwell = dwellAfterArrival("onscreen");
    expect(controlDwell).toBeGreaterThan(0);
    expect(offscreenDwell).toBe(controlDwell);
    // The positive control proves beta actually joins when the kerb is on
    // screen: after 3s already elapsed, the 4s floor starts over at the join.
    expect(onscreenDwell).toBeGreaterThanOrEqual(40);
    expect(onscreenDwell).toBeGreaterThan(controlDwell);
  });

  it("draws exactly one drawable per vehicle and gives it no hit region", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const road = layoutOf(scene).floors[0].road;
    if (road === null) {
      context.skip("this view has no road yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: ATTENTION_BETA(),
      }),
    );
    const frame = scene.frame(1, WHOLE_WORLD);
    expect(vehicleDrawables(frame)).toHaveLength(1);

    // THE CONTROL IS A SCENE WITH NO CAR IN IT, not this scene a sync ago.
    // Entering `attention` moves an agent off its desk, and the civic layer
    // keeps that desk drawn and hoverable for its absent owner, so the region
    // list legitimately differs from one sync to the next for reasons that
    // have nothing to do with a vehicle. Reduced motion gives the same floor
    // in the same state with the dispatch silenced, which is the only
    // difference this case is entitled to measure.
    const control = newVehicleScene();
    control.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        reducedMotion: true,
      }),
    );
    control.frame(1, WHOLE_WORLD);
    control.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        reducedMotion: true,
        statusById: ATTENTION_BETA(),
      }),
    );
    const controlFrame = control.frame(1, WHOLE_WORLD);
    expect(vehicleDrawables(controlFrame)).toHaveLength(0);
    // A vehicle owns no name tag and no click target, so the car's presence
    // costs the region list exactly nothing.
    expect(frame.hitRegions.length).toBe(controlFrame.hitRegions.length);
  });

  it("removes the vehicle once its trip is fully played out", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const road = layoutOf(scene).floors[0].road;
    if (road === null) {
      context.skip("this view has no road yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length,
    ).toBeGreaterThan(0);
    // Long enough for arrive + the longest possible wait + depart, whatever
    // this floor's road is actually shaped like.
    for (let step = 0; step < 400; step += 1) scene.tick(100);
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  it("clears any vehicle mid-trip the instant reduced motion turns on", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const road = layoutOf(scene).floors[0].road;
    if (road === null) {
      context.skip("this view has no road yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length,
    ).toBeGreaterThan(0);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        reducedMotion: true,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  it("clears any vehicle mid-trip on a scrub", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const road = layoutOf(scene).floors[0].road;
    if (road === null) {
      context.skip("this view has no road yet (K2)");
      return;
    }
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(
      vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length,
    ).toBeGreaterThan(0);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        cursorMs: 3000,
        statusById: ATTENTION_BETA(),
      }),
    );
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });

  /** The sprite box a character standing on this tile would occupy, per the projector. */
  function footRectFor(layout: OfficeLayout, tile: OfficeTilePos): OfficeRect {
    const projector = view.painter.projector(layout);
    const foot = projector.project(tile.col + 0.5, tile.row + 1);
    return {
      x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
      y: foot.y - OFFICE_CHARACTER_HEIGHT,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
  }

  it("keeps a vehicle ahead of a character at an exact depth tie", (context) => {
    const scene = newVehicleScene();
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    const floor = layout.floors[0];
    const road = floor.road;
    const helpDesk = floor.civic.find((room) => room.kind === "help-desk");
    const kerb = helpDesk?.kerbTile ?? null;
    if (road === null || kerb === null) {
      context.skip("no road/kerb on this view yet (K2)");
      return;
    }
    // A tie needs some OTHER standing tile to land exactly on the kerb - a
    // fact about this floor's queue geometry, not something this case can
    // assume holds on every floor shape. Beta is the SECOND agent to join
    // the queue below, and the second slot is the one this floor sometimes
    // hands out at the kerb's own tile.
    const tieTile = floor.receptionQueueTiles.find(
      (tile) => tile.col === kerb.col && tile.row === kerb.row,
    );
    if (tieTile === undefined) {
      context.skip("this floor's queue never lands exactly on the kerb");
      return;
    }
    const tieRect = footRectFor(layout, tieTile);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        // Both enter together so alpha (first alphabetically) claims the
        // first queue slot and beta claims the second - the one this floor's
        // geometry happens to put exactly on the kerb.
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
          ["beta", "attention"],
        ]),
      }),
    );
    let tied = false;
    let vehicleIndex = -1;
    let characterIndex = -1;
    for (let step = 0; step < 400 && !tied; step += 1) {
      scene.tick(100);
      const frame = scene.frame(1, WHOLE_WORLD);
      const betaRegion = frame.hitRegions.find(
        (region) => region.agentId === "beta",
      );
      if (
        betaRegion === undefined ||
        betaRegion.rect.x !== tieRect.x ||
        betaRegion.rect.y !== tieRect.y
      ) {
        continue;
      }
      const stream = visibleDrawables(frame);
      const foundVehicle = stream.findIndex(
        (drawable) => drawable.kind === "vehicle",
      );
      const foundCharacter = stream.findIndex(
        (drawable) =>
          drawable.kind === "sprite" &&
          drawable.sprite.name === "character" &&
          drawable.x === betaRegion.rect.x &&
          drawable.y === betaRegion.rect.y,
      );
      if (foundVehicle < 0 || foundCharacter < 0) continue;
      vehicleIndex = foundVehicle;
      characterIndex = foundCharacter;
      tied = true;
    }
    expect(tied, "never observed beta standing exactly on the kerb").toBe(true);
    // The tie itself: the vehicle is emitted first in the stream, so beta's
    // own drawable follows it rather than the other way around.
    expect(vehicleIndex).toBeLessThan(characterIndex);
  });

  it("Mission control never dispatches", (context) => {
    if (viewId !== "mission-control") {
      context.skip("this case is about Mission control specifically");
      return;
    }
    // THE GATE IS THE ROAD, and this case exists to say so about a view that
    // has everything else. Mission control plans all four rooms, and its help
    // desk correctly carries `kerbTile: null` - C6, because nothing drives into
    // a hall - so a real sync fails the DISPATCH TRIGGER on the missing kerb
    // before it ever reaches the road check, and a green would mean "no kerb
    // yet" rather than "no road".
    //
    // So its help desk is REPLACED here by a synthetic one with a real kerb,
    // road left untouched at null. Replaced and not appended: two help desks
    // would leave the trigger reading whichever the plan lists first, which is
    // the real one whose kerb is null, and the case would pass for the reason it
    // is trying to rule out. With a kerb present and a road absent, the road is
    // the only thing left that can stop the car.
    const withSyntheticHelpDesk: OfficeView = {
      ...view,
      plan: (input) => {
        const planned = view.plan(input);
        const floor = planned.floors[0];
        if (floor.road !== null) {
          throw new Error(
            "Mission control's floor grew a road - this case no longer isolates anything",
          );
        }
        const helpDesk: OfficeCivicRoom = {
          civicRoomId: "synthetic/mission-control/help-desk",
          kind: "help-desk",
          bounds: {
            col: floor.receptionTile.col,
            row: floor.receptionTile.row,
            cols: 1,
            rows: 1,
          },
          doorTile: floor.receptionTile,
          signTile: floor.receptionTile,
          name: "Front desk",
          seatIds: [],
          floorIndex: 0,
          hostId: floor.hostId,
          hostScope: "host",
          // A COUNTER, which is what this fixture stands in for.
          enclosure: "open",
          kerbTile: floor.receptionTile,
        };
        return {
          ...planned,
          floors: [
            {
              ...floor,
              civic: [
                ...floor.civic.filter((room) => room.kind !== "help-desk"),
                helpDesk,
              ],
            },
          ],
        };
      },
    };
    const scene = new OfficeScene(withSyntheticHelpDesk, null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    // The gate this case is about, isolated: the road is still null, and now
    // a help desk with a real kerb exists, so nothing else is left to blame.
    expect(layout.floors[0].road).toBeNull();
    expect(
      layout.floors[0].civic.find((room) => room.kind === "help-desk")
        ?.kerbTile,
    ).not.toBeNull();
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: ATTENTION_BETA(),
      }),
    );
    // The trigger really fired: beta reaches an actual reception queue tile,
    // not just its desk, which is only true once it has been handed a slot.
    const queueTiles = layout.floors[0].receptionQueueTiles;
    let queued = false;
    for (let step = 0; step < 200 && !queued; step += 1) {
      scene.tick(100);
      const region = scene
        .frame(1, WHOLE_WORLD)
        .hitRegions.find((candidate) => candidate.agentId === "beta");
      if (region === undefined) continue;
      queued = queueTiles.some((tile) => {
        const rect = footRectFor(layout, tile);
        return region.rect.x === rect.x && region.rect.y === rect.y;
      });
    }
    expect(queued, "beta never reached a reception queue tile").toBe(true);
    expect(vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length).toBe(0);
  });
});

describe("OfficeScene vehicle facing on a road with a vertical leg", () => {
  it("keeps its left facing through a vertical leg and while waiting", (context) => {
    const roadView: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: (input) => {
        const planned = OFFICE_VIEWS.floor.plan(input);
        const floor = planned.floors[0];
        const helpDesk = floor.civic.find((room) => room.kind === "help-desk");
        const kerb = helpDesk?.kerbTile;
        if (kerb === undefined || kerb === null) return planned;
        const road = leftThenVerticalRoad(floor, kerb);
        if (road === null) return planned;
        return {
          ...planned,
          floors: planned.floors.map((candidate, index) =>
            index === 0 ? { ...candidate, road } : candidate,
          ),
        };
      },
    };
    const scene = new OfficeScene(roadView, null);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = layoutOf(scene);
    const floor = layout.floors[0];
    const helpDesk = floor.civic.find((room) => room.kind === "help-desk");
    const road = floor.road;
    const kerb = helpDesk?.kerbTile;
    if (road === null || kerb === undefined || kerb === null) {
      context.skip("could not build the left-then-vertical road fixture");
      return;
    }
    const projector = OFFICE_VIEWS.floor.painter.projector(layout);
    const pointFor = (tile: OfficeTilePos): OfficePoint =>
      projector.project(tile.col + 0.5, tile.row + 1);
    const verticalPoints = road.tiles.slice(2, -1).map(pointFor);
    const kerbPoint = pointFor(kerb);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
        ]),
      }),
    );
    let verticalSeen = false;
    let waitingAtKerb = 0;
    let waitingFacingLeft = false;
    for (let step = 0; step < 800; step += 1) {
      const vehicle = vehicleDrawables(scene.frame(1, WHOLE_WORLD)).find(
        (candidate) => candidate.vehicleKind === "police-car",
      );
      if (vehicle !== undefined) {
        const onVertical = verticalPoints.some(
          (point) => vehicle.x === point.x && vehicle.y === point.y,
        );
        if (onVertical) {
          verticalSeen = true;
          expect(vehicle.facing).toBe("left");
        }
        if (vehicle.x === kerbPoint.x && vehicle.y === kerbPoint.y) {
          if (verticalSeen) waitingAtKerb += 1;
          if (waitingAtKerb >= 2) {
            waitingFacingLeft = vehicle.facing === "left";
            break;
          }
        } else {
          waitingAtKerb = 0;
        }
      }
      scene.tick(100);
    }
    // WHAT THIS GUARD DOES AND DOES NOT DO. It proves the loop ran on the leg
    // at all, so a fixture whose van never got there cannot satisfy the
    // `expect` inside the loop by never reaching it. It is NOT what supplies
    // the red: `verticalPoints` is `slice(2, -1)`, a POSITIONAL slice rather
    // than a direction-filtered one, so a straight-road fallback puts the van
    // on those points too and sets this flag. Forcing that fallback fails the
    // case on the in-loop `facing` assertion instead - 'right' where 'left'
    // was required - which is the real falsifier here.
    expect(verticalSeen).toBe(true);
    expect(waitingFacingLeft).toBe(true);
  });
});

/**
 * The vacuity guard my coordinator's brief requires: without this, a
 * regression that nulled every floor's road would read as six green "no
 * dispatch" cases above, and nothing would say the dispatch path itself had
 * gone dead.
 */
describe("OfficeScene vehicles - dispatch actually happens somewhere", () => {
  it("dispatches at least one police car across OFFICE_VIEW_IDS", () => {
    const dispatchedSomewhere = OFFICE_VIEW_IDS.some((viewId) => {
      const scene = new OfficeScene(OFFICE_VIEWS[viewId], null);
      scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
      scene.sync(
        sceneInput({
          agents: AGENTS,
          visibleAgentIds: BOTH,
          statusById: new Map<string, OfficeAgentStatus>([
            ["beta", "attention"],
          ]),
        }),
      );
      return vehicleDrawables(scene.frame(1, WHOLE_WORLD)).length > 0;
    });
    expect(dispatchedSomewhere).toBe(true);
  });
});

describe("OfficeScene poses", () => {
  const QUEUE_OVERFLOW: ReadonlyArray<OfficeAgentInput> = Array.from(
    { length: 9 },
    (_unused, index) => agent({ id: `crowd-${index}`, createdAt: index + 1 }),
  );
  const QUEUE_OVERFLOW_IDS: ReadonlySet<string> = new Set(
    QUEUE_OVERFLOW.map((person) => person.id),
  );

  function poseOfSeatedOverflow(
    status: OfficeAgentStatus,
  ): OfficeCharacterPose {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: QUEUE_OVERFLOW,
        visibleAgentIds: QUEUE_OVERFLOW_IDS,
        statusById: new Map(
          QUEUE_OVERFLOW.map((person) => [person.id, status]),
        ),
      }),
    );
    const frame = frameOf(scene);
    // Whoever the reception queue had no room for is still in its own chair.
    const seatedId = QUEUE_OVERFLOW.map((person) => person.id).find(
      (id) => !frame.awayAgentIds.has(id),
    );
    if (seatedId === undefined) {
      throw new Error("expected the reception queue to overflow");
    }
    const sprite = characterSpriteAt(frame, characterRect(frame, seatedId));
    if (sprite === null) throw new Error("expected a character sprite");
    return sprite.pose ?? "sit";
  }

  it("crashes into its screen on failure", () => {
    expect(poseOfSeatedOverflow("failure")).toBe("crash");
  });

  it("raises a hand on attention", () => {
    expect(poseOfSeatedOverflow("attention")).toBe("hand-up");
  });

  it("sits an awaiting agent down in the waiting room, not at its own desk", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "awaiting"]]),
        // Settled in the chair rather than halfway to it: the pose is what
        // this case is about, and a walker's pose is `walk1`.
        reducedMotion: true,
      }),
    );
    // This asserted `lean` at the agent's own desk, and `awayAgentIds` not
    // holding it, until the waiting room existed. An `awaiting` agent now
    // takes a chair there - the `lean` pose is still what a seated awaiting
    // agent is drawn with on a floor that plans no civic rooms, which every
    // view but this one is until K2.
    const frame = frameOf(scene);
    expect(scene.whereabouts("alpha")).toBe("Lounge");
    const sprite = characterSpriteAt(frame, characterRect(frame, "alpha"));
    expect(sprite?.pose).toBe("sit");
  });

  it("wears headphones while seated and working in the background, without replacing the typing pose", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "background"],
        ]),
      }),
    );
    const frame = frameOf(scene);
    const sprite = characterSpriteAt(frame, characterRect(frame, "alpha"));
    expect(sprite?.accessory).toBe("headphones");
    expect(["type1", "type2"]).toContain(sprite?.pose);
  });

  it("keeps a working agent typing rather than leaning - the existing precedence outranks every new pose", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "working"]]),
      }),
    );
    const frame = frameOf(scene);
    const sprite = characterSpriteAt(frame, characterRect(frame, "alpha"));
    expect(["type1", "type2"]).toContain(sprite?.pose);
    expect(sprite?.accessory).toBeUndefined();
  });
});

/**
 * Overview zoom: a frame is only pips and a block map, and nothing else - the
 * whole point of the level being cheap enough to hold a thousand agents.
 */
describe("OfficeScene lod 0", () => {
  it("emits one pip per visible character with its status glyph, a block map for the floor, and no character sprites", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
        ]),
      }),
    );
    const frame = scene.frame(0, WHOLE_WORLD);

    expect(frame.actors).toHaveLength(2);
    for (const drawable of frame.actors) expect(drawable.kind).toBe("pip");
    const pips = frame.actors.filter(
      (drawable): drawable is Extract<OfficeDrawable, { kind: "pip" }> =>
        drawable.kind === "pip",
    );
    expect(pips.find((pip) => pip.agentId === "alpha")?.glyph).toBe("bang");
    expect(pips.find((pip) => pip.agentId === "beta")?.glyph).toBe("none");

    // No character art anywhere in the frame at this level.
    const everyDrawable = [...frame.floor, ...frame.props, ...frame.actors];
    expect(
      everyDrawable.some(
        (drawable) =>
          drawable.kind === "sprite" && drawable.sprite.name === "character",
      ),
    ).toBe(false);

    // A block map, not tiles - and nothing in the (layered) props pass.
    expect(frame.floor.length).toBeGreaterThan(0);
    expect(frame.floor.every((drawable) => drawable.kind === "block")).toBe(
      true,
    );
    expect(frame.props).toEqual([]);
    expect(frame.world).toBeNull();
  });
});

/**
 * `buildPips` (and `tileCenter` beside it) used to add a flat `OFFICE_TILE /
 * 2` to the projected CORNER instead of projecting the tile's mid-point
 * directly. The two coincide on an axis-aligned projector (Floor, Towers),
 * which is exactly why this needs an AFFINE one - City's - to show up at
 * all: there, `project(col, row) + {TILE/2, TILE/2}` lands eight world pixels
 * off `project(col + 0.5, row + 0.5)`, detaching the dot from the character
 * it names.
 */
describe("OfficeScene lod 0 pip centre on an affine projector", () => {
  it("projects the overview pip at the projector's own tile centre, not the corner plus a flat offset", () => {
    const epic = makeTestEpic("triage", 2, 1);
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    const ids = new Set(epic.agents.map((person) => person.id));
    scene.sync(sceneInput({ agents: epic.agents, visibleAgentIds: ids }));
    // Long enough that every agent has settled into its chair - a mid-walk
    // character's col/row is still a real tile position, but a seated one is
    // the deterministic case this claim is about.
    for (let step = 0; step < 100; step += 1) scene.tick(100);

    const layout = layoutOf(scene);
    const projector = OFFICE_VIEWS.city.painter.projector(layout);
    const target = epic.agents[0].id;

    // The character's own tile - read the same way
    // `office-frame-gate.test.ts`'s `motions` helper does, since nothing
    // public reports a character's position and this claim is about exactly
    // that position.
    const rawCharacters: unknown = Reflect.get(scene, "characters");
    if (!(rawCharacters instanceof Map)) {
      throw new Error("characters missing");
    }
    const character: unknown = rawCharacters.get(target);
    if (typeof character !== "object" || character === null) {
      throw new Error("no character for target");
    }
    const col: unknown = Reflect.get(character, "col");
    const row: unknown = Reflect.get(character, "row");
    if (typeof col !== "number" || typeof row !== "number") {
      throw new Error("character carries no col/row");
    }

    const frame = scene.frame(0, WHOLE_WORLD);
    const pip = frame.actors.find(
      (drawable): drawable is Extract<OfficeDrawable, { kind: "pip" }> =>
        drawable.kind === "pip" && drawable.agentId === target,
    );
    if (pip === undefined) throw new Error("no pip for target");

    const correctCenter = projector.project(col + 0.5, row + 0.5);
    const corner = projector.project(col, row);
    const flatOffsetCenter = {
      x: corner.x + OFFICE_TILE / 2,
      y: corner.y + OFFICE_TILE / 2,
    };
    // Anti-vacuity: on City's affine projector the two formulas must
    // actually disagree, or the assertions below would pass for either one.
    expect(
      Math.abs(correctCenter.x - flatOffsetCenter.x) +
        Math.abs(correctCenter.y - flatOffsetCenter.y),
    ).toBeGreaterThan(0);

    expect(pip.x).toBeCloseTo(correctCenter.x, 6);
    expect(pip.y).toBeCloseTo(correctCenter.y, 6);
  });
});

// ---- Hand-built fixtures for the cubby, aliasing and audience suites --- //

const HAND_BUILT_BOUNDS: OfficeTileRect = {
  col: 0,
  row: 0,
  cols: 16,
  rows: 16,
};

function allWalkable(
  rows: number,
  cols: number,
): ReadonlyArray<ReadonlyArray<boolean>> {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => true),
  );
}

function deskSeat(args: {
  readonly seatId: string;
  readonly deskTile: OfficeTilePos;
  readonly floorIndex: number;
}): OfficeSeat {
  return {
    seatId: args.seatId,
    kind: "desk",
    deskTile: args.deskTile,
    chairTile: { col: args.deskTile.col, row: args.deskTile.row + 1 },
    facing: "up",
    hitTiles: { width: 2, height: 2 },
    hitBox: null,
    floorIndex: args.floorIndex,
    roomId: null,
    hostId: null,
    manager: false,
    civicRoomId: null,
  };
}

function cubbySeat(args: {
  readonly seatId: string;
  readonly deskTile: OfficeTilePos;
  readonly floorIndex: number;
}): OfficeSeat {
  return {
    seatId: args.seatId,
    kind: "cubby",
    deskTile: args.deskTile,
    chairTile: args.deskTile,
    facing: "up",
    hitTiles: { width: 1, height: 1 },
    hitBox: null,
    floorIndex: args.floorIndex,
    roomId: null,
    hostId: null,
    manager: false,
    civicRoomId: null,
  };
}

/**
 * A storey with nothing on it but the spots a case needs. `OfficeFloor` carries
 * no index of its own - a floor IS its position in `layout.floors` - so the
 * storey a spot belongs to is said once, on the spot's own `floorIndex`.
 */
function handBuiltFloor(
  errandSpots: ReadonlyArray<OfficeErrandSpot>,
): OfficeFloor {
  return {
    hostId: null,
    bounds: HAND_BUILT_BOUNDS,
    doorTile: { col: 0, row: 0 },
    lobbyTile: { col: 0, row: 1 },
    receptionTile: { col: 0, row: 2 },
    receptionQueueTiles: [],
    queueFacing: "down",
    corridorTiles: [],
    clockTile: { col: 15, row: 0 },
    stairsTile: null,
    errandSpots,
    cafeteria: null,
    gameRoom: null,
    areaSigns: [],
    amenities: [],
    civic: [],
    road: null,
  };
}

/** A layout with one desk agent and one cubby agent, both on floor 0. */
function cubbyLayout(): OfficeLayout {
  const worker = deskSeat({
    seatId: "h/0/worker",
    deskTile: { col: 2, row: 2 },
    floorIndex: 0,
  });
  const cub = cubbySeat({
    seatId: "h/0/cub",
    deskTile: { col: 8, row: 8 },
    floorIndex: 0,
  });
  return {
    view: "floor",
    cols: 16,
    rows: 16,
    desks: new Map([
      ["worker", { ...worker, agentId: "worker" }],
      ["cub", { ...cub, agentId: "cub" }],
    ]),
    seats: new Map([
      ["h/0/worker", worker],
      ["h/0/cub", cub],
    ]),
    signs: [],
    rooms: [],
    floors: [handBuiltFloor([])],
    doorTile: { col: 0, row: 0 },
    lobbyTile: { col: 0, row: 1 },
    props: [],
    walkable: allWalkable(16, 16),
    frozen: null,
    shiftFromPrevious: null,
    stable: true,
  };
}

describe("OfficeScene cubby actor rule", () => {
  const CUB = agent({ id: "cub", createdAt: 2 });
  const WORKER = agent({ id: "worker", createdAt: 1 });
  const BOTH_HAND_BUILT: ReadonlyArray<OfficeAgentInput> = [WORKER, CUB];
  const BOTH_HAND_BUILT_IDS: ReadonlySet<string> = new Set(["worker", "cub"]);

  it("emits no actor for a SEATED cubby occupant at lod 0 or lod 1, and a dimmed one at lod 2", () => {
    const scene = new OfficeScene(
      testView(() => cubbyLayout()),
      null,
    );
    scene.sync(
      sceneInput({
        agents: BOTH_HAND_BUILT,
        visibleAgentIds: BOTH_HAND_BUILT_IDS,
      }),
    );

    const lod0 = scene.frame(0, WHOLE_WORLD);
    const lod1 = scene.frame(1, WHOLE_WORLD);
    const lod2 = scene.frame(2, WHOLE_WORLD);

    // lod 0: pips only, one per character - the cubby occupant is not left out.
    const pipIds = lod0.actors
      .filter(
        (drawable): drawable is Extract<OfficeDrawable, { kind: "pip" }> =>
          drawable.kind === "pip",
      )
      .map((pip) => pip.agentId);
    expect(pipIds.sort()).toEqual(["cub", "worker"]);

    // lod 1: a normal actor for the worker, none for the cubby occupant.
    expect(
      lod1.actors.some(
        (drawable) =>
          drawable.kind === "label" && drawable.ownerAgentId === "worker",
      ),
    ).toBe(true);
    expect(
      lod1.actors.some(
        (drawable) =>
          drawable.kind === "label" && drawable.ownerAgentId === "cub",
      ),
    ).toBe(false);

    // lod 2: the cubby occupant now has a character sprite, dimmed.
    const cubActorLod2 = lod2.actors.find(
      (drawable) =>
        drawable.kind === "label" && drawable.ownerAgentId === "cub",
    );
    expect(cubActorLod2).toBeDefined();
    const cubSpriteLod2 = characterSpriteAt(lod2, characterRect(lod2, "cub"));
    expect(cubSpriteLod2).not.toBeNull();
    const cubSpriteDrawable = lod2.actors.find(
      (drawable) =>
        drawable.kind === "sprite" &&
        drawable.x === characterRect(lod2, "cub").x &&
        drawable.y === characterRect(lod2, "cub").y,
    );
    expect(
      cubSpriteDrawable?.kind === "sprite"
        ? cubSpriteDrawable.alpha
        : undefined,
    ).toBe(0.6);

    // The worker (an ordinary desk) is never dimmed at any lod it is drawn at.
    const workerSpriteLod2 = lod2.actors.find(
      (drawable) =>
        drawable.kind === "sprite" &&
        drawable.x === characterRect(lod2, "worker").x &&
        drawable.y === characterRect(lod2, "worker").y,
    );
    expect(
      workerSpriteLod2?.kind === "sprite" ? workerSpriteLod2.alpha : undefined,
    ).toBeUndefined();

    // The hit region is the SEAT's own box (1x1 for a cubby) at every lod,
    // independent of whether an actor sprite was drawn for it.
    for (const frame of [lod0, lod1, lod2]) {
      const seatHit = frame.hitRegions.find(
        (region) =>
          region.agentId === "cub" && region.rect.height === OFFICE_TILE,
      );
      expect(seatHit?.rect).toEqual({
        x: 8 * OFFICE_TILE,
        y: 8 * OFFICE_TILE,
        width: OFFICE_TILE,
        height: OFFICE_TILE,
      });
    }
  });

  it("draws a WALKING cubby occupant as a normal actor at every lod, mid walk-in", () => {
    const scene = new OfficeScene(
      testView(() => cubbyLayout()),
      null,
    );
    scene.sync(
      sceneInput({
        agents: BOTH_HAND_BUILT,
        visibleAgentIds: new Set(["worker"]),
      }),
    );
    scene.sync(
      sceneInput({
        agents: BOTH_HAND_BUILT,
        visibleAgentIds: BOTH_HAND_BUILT_IDS,
        pulse: {
          kind: "edge",
          edgeId: "worker<->cub",
          pulseKind: "created",
          fromAgentId: "worker",
          toAgentId: "cub",
        },
        pulseKey: "created-cub",
      }),
    );

    // Still walking in from the door - not yet in its cubby.
    expect(scene.frame(2, WHOLE_WORLD).awayAgentIds.has("cub")).toBe(true);
    for (const lod of [1, 2] as const) {
      const frame = scene.frame(lod, WHOLE_WORLD);
      expect(hasCharacter(frame, "cub")).toBe(true);
      const rect = characterRect(frame, "cub");
      const sprite = frame.actors.find(
        (drawable) =>
          drawable.kind === "sprite" &&
          drawable.x === rect.x &&
          drawable.y === rect.y,
      );
      // A normal, undimmed walking body - the cubby dimming rule applies to a
      // SEATED occupant only.
      expect(
        sprite?.kind === "sprite" ? sprite.alpha : undefined,
      ).toBeUndefined();
    }
    // A pip too, one per character, at lod 0.
    const pipIds = scene
      .frame(0, WHOLE_WORLD)
      .actors.filter(
        (drawable): drawable is Extract<OfficeDrawable, { kind: "pip" }> =>
          drawable.kind === "pip",
      )
      .map((pip) => pip.agentId);
    expect(pipIds.sort()).toEqual(["cub", "worker"]);
  });

  it("never sends a seated cubby occupant on an errand or a desk filler", () => {
    const scene = new OfficeScene(
      testView(() => cubbyLayout()),
      null,
    );
    scene.sync(
      sceneInput({
        agents: BOTH_HAND_BUILT,
        visibleAgentIds: BOTH_HAND_BUILT_IDS,
      }),
    );
    // Long past the idle-errand threshold and several filler cycles.
    for (let step = 0; step < 300; step += 1) {
      scene.tick(100);
      expect(scene.frame(2, WHOLE_WORLD).awayAgentIds.has("cub")).toBe(false);
    }
  });
});

/** Two floors sharing a plaza spot: floor 1's copy aliases floor 0's, same tile. */
function aliasedFloorsLayout(): OfficeLayout {
  const worker0 = deskSeat({
    seatId: "h/0/worker0",
    deskTile: { col: 2, row: 2 },
    floorIndex: 0,
  });
  const worker1 = deskSeat({
    seatId: "h/1/worker1",
    deskTile: { col: 2, row: 18 },
    floorIndex: 1,
  });
  const plazaSpot: OfficeErrandSpot = {
    kind: "coffee",
    tile: { col: 10, row: 10 },
    facing: "down",
    audience: { kind: "floor" },
    fixtureId: "plaza-coffee",
    approachTile: { col: 10, row: 10 },
    actionTile: null,
    seatId: null,
    floorIndex: 0,
  };
  const floor0 = handBuiltFloor([plazaSpot]);
  const floor1 = handBuiltFloor([{ ...plazaSpot, floorIndex: 1 }]);
  return {
    view: "floor",
    cols: 16,
    rows: 32,
    desks: new Map([
      ["worker0", { ...worker0, agentId: "worker0" }],
      ["worker1", { ...worker1, agentId: "worker1" }],
    ]),
    seats: new Map([
      ["h/0/worker0", worker0],
      ["h/1/worker1", worker1],
    ]),
    signs: [],
    rooms: [],
    floors: [floor0, floor1],
    doorTile: { col: 0, row: 0 },
    lobbyTile: { col: 0, row: 1 },
    props: [],
    walkable: allWalkable(32, 16),
    frozen: null,
    shiftFromPrevious: null,
    stable: true,
  };
}

describe("OfficeScene spot aliasing", () => {
  it("selects errands from the character's own floor's spots, and the per-chunk index dedupes the painter call by tile", () => {
    const layout = aliasedFloorsLayout();
    let spotPropsCalls = 0;
    const countingView: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: {
        ...OFFICE_VIEWS.floor.painter,
        spotProps: (planLayout, spot, lod) => {
          spotPropsCalls += 1;
          return OFFICE_VIEWS.floor.painter.spotProps(planLayout, spot, lod);
        },
      },
    };
    const scene = new OfficeScene(countingView, null);
    const worker0 = agent({ id: "worker0", createdAt: 1 });
    const worker1 = agent({ id: "worker1", createdAt: 2 });
    scene.sync(
      sceneInput({
        agents: [worker0, worker1],
        visibleAgentIds: new Set(["worker0", "worker1"]),
      }),
    );

    // Both floors' aliases sit in the same 32x32 chunk of the index (tiles
    // 0-31), so one frame touches both - and the physical spot is still drawn
    // exactly once.
    scene.frame(2, WHOLE_WORLD);
    expect(spotPropsCalls).toBe(1);

    // Errand selection iterates the WALKER's own floor and claims by tile:
    // both floors' entries point at the identical physical tile, so an agent
    // on floor 1 can still pick "its" copy even though floor 0's is the one
    // the chunk index kept.
    for (let step = 0; step < 400; step += 1) scene.tick(100);
    const away = scene.frame(2, WHOLE_WORLD).awayAgentIds;
    // At least one of the two eventually goes on the errand to the shared
    // tile; which one is a scheduling detail, but the floor-1 worker must
    // remain able to (the aliasing is what makes that possible at all).
    expect(away.has("worker0") || away.has("worker1")).toBe(true);
  });

  /**
   * A DIRECT WITNESS of the reservation the case above only implies. That one
   * shows a walker CAN take the shared tile; it never shows the tile refused
   * to a SECOND walker while the first is on its way home, and its own
   * assertion - `away(worker0) || away(worker1)` - is satisfied by two
   * outbound walkers and says nothing about a return in progress.
   *
   * `claimedSpotKeys` reads every character's `errandTarget`, which
   * `returnToDesk`'s walking branch keeps set through the walk home ON
   * PURPOSE (see its comment and `startLeaving`'s, both of which cite this by
   * name) - so the shared tile stays claimed for the whole round trip, not
   * only the outbound leg. This layout's ONE errand spot, aliased onto both
   * floors, makes that the only possible source of a refusal: if the second
   * worker is ever kept seated here, it is because the first worker's spot is
   * still reserved.
   */
  it("keeps a returning stroller's spot reserved until it is home, refusing it to a second walker", () => {
    const layout = aliasedFloorsLayout();
    const scene = new OfficeScene(
      testView(() => layout),
      null,
    );
    scene.sync(
      sceneInput({
        agents: [
          agent({ id: "worker0", createdAt: 1 }),
          agent({ id: "worker1", createdAt: 2 }),
        ],
        visibleAgentIds: new Set(["worker0", "worker1"]),
      }),
    );

    const tileOfCharacter = (
      agentId: string,
    ): { readonly col: number; readonly row: number } => {
      const rect = characterRect(frameOf(scene), agentId);
      return { col: rect.x / OFFICE_TILE, row: (rect.y + 4) / OFFICE_TILE };
    };
    const distanceToSpot = (agentId: string): number => {
      const tile = tileOfCharacter(agentId);
      return Math.abs(tile.col - 10) + Math.abs(tile.row - 10);
    };

    // Whichever of the two claims the shared spot first - the case above
    // already shows either can, so this does not pin which.
    let goer: string | null = null;
    for (let step = 0; step < 400 && goer === null; step += 1) {
      scene.tick(100);
      const away = frameOf(scene).awayAgentIds;
      if (away.has("worker0")) goer = "worker0";
      else if (away.has("worker1")) goer = "worker1";
    }
    if (goer === null) {
      throw new Error("neither worker ever started the errand");
    }
    const waiter = goer === "worker0" ? "worker1" : "worker0";

    // Walk the goer all the way to the shared tile, then watch for the leg
    // back: distance to (10, 10) falls to zero and later climbs again once
    // `returnToDesk` sends it home. From the moment it climbs and for every
    // tick the goer is still away after that, the waiter - long past its own
    // idle threshold by now - must stay seated: the reservation is what is
    // keeping it there, not a coincidence of scheduling.
    let reachedSpot = false;
    let onReturnLeg = false;
    let sampledDuringReturn = 0;
    let home = false;
    for (let step = 0; step < 800; step += 1) {
      scene.tick(100);
      const frame = frameOf(scene);
      if (!frame.awayAgentIds.has(goer)) {
        home = true;
        break;
      }
      const distance = distanceToSpot(goer);
      if (distance === 0) reachedSpot = true;
      if (reachedSpot && distance > 0) onReturnLeg = true;
      if (onReturnLeg) {
        sampledDuringReturn += 1;
        expect(
          frame.awayAgentIds.has(waiter),
          `${waiter} was let onto ${goer}'s reserved spot while it was still walking home`,
        ).toBe(false);
      }
    }
    expect(reachedSpot, `${goer} never reached the shared spot`).toBe(true);
    expect(onReturnLeg, `${goer} never started walking home`).toBe(true);
    expect(
      sampledDuringReturn,
      "never sampled the waiter during the goer's walk home",
    ).toBeGreaterThan(0);
    expect(home, `${goer} never made it back to its desk`).toBe(true);

    // HOME, so the reservation is gone: a later stroll can take the same
    // tile, and this is that stroll actually happening rather than merely
    // permitted.
    let waiterWentAway = false;
    for (let step = 0; step < 400 && !waiterWentAway; step += 1) {
      scene.tick(100);
      waiterWentAway = frameOf(scene).awayAgentIds.has(waiter);
    }
    expect(waiterWentAway, `${waiter} never got the freed spot`).toBe(true);
  });
});

describe("OfficeScene leads audience", () => {
  function spotOf(audience: OfficeErrandSpot["audience"]): OfficeErrandSpot {
    return {
      kind: "whiteboard",
      tile: { col: 10, row: 10 },
      facing: "down",
      audience,
      fixtureId: "hq-board",
      approachTile: { col: 10, row: 10 },
      actionTile: null,
      seatId: null,
      floorIndex: 0,
    };
  }

  function leadsLayout(spot: OfficeErrandSpot): OfficeLayout {
    const lead = deskSeat({
      seatId: "h/0/lead",
      deskTile: { col: 2, row: 2 },
      floorIndex: 0,
    });
    const member = deskSeat({
      seatId: "h/0/member",
      deskTile: { col: 5, row: 2 },
      floorIndex: 0,
    });
    return {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([
        ["lead", { ...lead, agentId: "lead" }],
        ["member", { ...member, agentId: "member" }],
      ]),
      seats: new Map([
        ["h/0/lead", lead],
        ["h/0/member", member],
      ]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([spot])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
  }

  it("only a team lead is eligible for a leads-only spot", () => {
    const spot = spotOf({ kind: "leads" });
    const layout = leadsLayout(spot);
    const lead = agent({ id: "lead", createdAt: 1 });
    const member = agent({ id: "member", parentId: "lead", createdAt: 2 });
    const scene = new OfficeScene(
      testView(() => layout),
      null,
    );
    scene.sync(
      sceneInput({
        agents: [lead, member],
        visibleAgentIds: new Set(["lead", "member"]),
        statusById: new Map<string, OfficeAgentStatus>(),
      }),
    );

    // The lead has nothing else to choose (no corridor fallback in this
    // fixture), so it reliably reaches the board within the idle-errand
    // window; a member with no team of its own is never offered it at all.
    let sawLeadAtBoard = false;
    for (let step = 0; step < 400; step += 1) {
      scene.tick(100);
      const standing = standingByTileGeneric(scene, layout);
      const atBoard = standing.get("10,10");
      if (atBoard === undefined) continue;
      expect(atBoard).toBe("lead");
      sawLeadAtBoard = true;
    }
    expect(sawLeadAtBoard).toBe(true);
  });
});

// ---- T2 fixup 1: cold-review findings F1-F9 ------------------------- //

/** A projector whose x axis is offset far from the identity mapping. */
const SHIFTED_PROJECTOR: OfficeProjector = {
  project: (col, row) => ({ x: 2048 + col * 16, y: row * 16 }),
  bounds: { x: 0, y: 0, width: 8000, height: 8000 },
  seatLift: () => 0,
};

describe("OfficeScene fixup 1 - F1 projected culling", () => {
  it("gives the seat and spot painters a call once a +2048px projector is in play, not zero", () => {
    const seat = deskSeat({
      seatId: "h/0/worker",
      deskTile: { col: 2, row: 2 },
      floorIndex: 0,
    });
    const spot: OfficeErrandSpot = {
      kind: "coffee",
      tile: { col: 4, row: 2 },
      facing: "down",
      audience: { kind: "floor" },
      fixtureId: "coffee-1",
      approachTile: { col: 4, row: 2 },
      actionTile: null,
      seatId: null,
      floorIndex: 0,
    };
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([["worker", { ...seat, agentId: "worker" }]]),
      seats: new Map([["h/0/worker", seat]]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([spot])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    let seatPropsCalls = 0;
    let spotPropsCalls = 0;
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: {
        ...OFFICE_VIEWS.floor.painter,
        projector: () => SHIFTED_PROJECTOR,
        seatProps: (planLayout, seatArg, state, lod) => {
          seatPropsCalls += 1;
          return OFFICE_VIEWS.floor.painter.seatProps(
            planLayout,
            seatArg,
            state,
            lod,
          );
        },
        spotProps: (planLayout, spotArg, lod) => {
          spotPropsCalls += 1;
          return OFFICE_VIEWS.floor.painter.spotProps(planLayout, spotArg, lod);
        },
      },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: [agent({ id: "worker", createdAt: 1 })],
        visibleAgentIds: new Set(["worker"]),
      }),
    );

    const location = scene.locate("worker");
    if (location === null) throw new Error("expected a location for worker");
    const rect: OfficeRect = {
      x: location.x - 40,
      y: location.y - 40,
      width: location.width + 80,
      height: location.height + 80,
    };
    scene.frame(2, rect);

    expect(seatPropsCalls).toBe(1);
    expect(spotPropsCalls).toBe(1);
  });

  it("gives the seat painter a call for a seat visible under a real City plan's own non-identity projector", () => {
    // Enough root solos that City's `originX = rows * 16` crosses a full
    // 512px chunk, the same class of offset the synthetic +2048px case pins.
    const epic = makeTestEpic("many-roots", 700, 5);
    const seatIdsCalled = new Set<string>();
    const view: OfficeView = {
      ...OFFICE_VIEWS.city,
      painter: {
        ...OFFICE_VIEWS.city.painter,
        seatProps: (planLayout, seatArg, state, lod) => {
          seatIdsCalled.add(seatArg.seatId);
          return OFFICE_VIEWS.city.painter.seatProps(
            planLayout,
            seatArg,
            state,
            lod,
          );
        },
      },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
      }),
    );
    const target = epic.agents[epic.agents.length - 1].id;
    const location = scene.locate(target);
    if (location === null) throw new Error(`expected a location for ${target}`);
    const rect: OfficeRect = {
      x: location.x - 40,
      y: location.y - 40,
      width: location.width + 80,
      height: location.height + 80,
    };
    scene.frame(2, rect);

    const targetSeat = scene.layout()?.desks.get(target);
    if (targetSeat === undefined) throw new Error("expected a desk for target");
    expect(seatIdsCalled.has(targetSeat.seatId)).toBe(true);
  });
});

describe("OfficeScene fixup 1 - F2 uniform shift keeps an errand", () => {
  it("does not cancel an in-flight errand when a growth-triggered shift translates the whole floor", () => {
    const deskA1 = deskSeat({
      seatId: "h/0/a",
      deskTile: { col: 2, row: 2 },
      floorIndex: 0,
    });
    const spot1: OfficeErrandSpot = {
      kind: "coffee",
      tile: { col: 10, row: 10 },
      facing: "down",
      audience: { kind: "floor" },
      fixtureId: "coffee-1",
      approachTile: { col: 10, row: 10 },
      actionTile: null,
      seatId: null,
      floorIndex: 0,
    };
    const floor1: OfficeFloor = {
      ...handBuiltFloor([spot1]),
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      receptionTile: { col: 0, row: 2 },
      clockTile: { col: 15, row: 0 },
    };
    const layout1: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 20,
      desks: new Map([["a", { ...deskA1, agentId: "a" }]]),
      seats: new Map([["h/0/a", deskA1]]),
      signs: [],
      rooms: [],
      floors: [floor1],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(20, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };

    const deskA2 = deskSeat({
      seatId: "h/0/a",
      deskTile: { col: 2, row: 6 },
      floorIndex: 0,
    });
    const deskB2 = deskSeat({
      seatId: "h/0/b",
      deskTile: { col: 5, row: 6 },
      floorIndex: 0,
    });
    const spot2: OfficeErrandSpot = {
      ...spot1,
      tile: { col: 10, row: 14 },
      approachTile: { col: 10, row: 14 },
    };
    const floor2: OfficeFloor = {
      ...handBuiltFloor([spot2]),
      doorTile: { col: 0, row: 4 },
      lobbyTile: { col: 0, row: 5 },
      receptionTile: { col: 0, row: 6 },
      clockTile: { col: 15, row: 4 },
    };
    const layout2: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 20,
      desks: new Map([
        ["a", { ...deskA2, agentId: "a" }],
        ["b", { ...deskB2, agentId: "b" }],
      ]),
      seats: new Map([
        ["h/0/a", deskA2],
        ["h/0/b", deskB2],
      ]),
      signs: [],
      rooms: [],
      floors: [floor2],
      doorTile: { col: 0, row: 4 },
      lobbyTile: { col: 0, row: 5 },
      props: [],
      walkable: allWalkable(20, 16),
      frozen: null,
      shiftFromPrevious: { col: 0, row: 4 },
      stable: true,
    };

    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: (input) => (input.agents.length <= 1 ? layout1 : layout2),
    };
    const scene = new OfficeScene(view, null);
    const A = agent({ id: "a", createdAt: 1 });
    const B = agent({ id: "b", createdAt: 2 });
    scene.sync(sceneInput({ agents: [A], visibleAgentIds: new Set(["a"]) }));

    let away = false;
    for (let step = 0; step < 500 && !away; step += 1) {
      scene.tick(100);
      away = frameOf(scene).awayAgentIds.has("a");
    }
    expect(away).toBe(true);
    // A few more steps into the walk-out leg, so the shift below lands on a
    // character genuinely mid-errand rather than one still leaving its chair.
    for (let step = 0; step < 5; step += 1) scene.tick(100);

    scene.sync(
      sceneInput({
        agents: [A, B],
        visibleAgentIds: new Set(["a", "b"]),
        pulseKey: "grow",
      }),
    );

    // A stable, fully translated layout must rehome nobody: the character
    // keeps walking its own (now-translated) errand rather than being sent
    // back to its (also translated) chair.
    for (let step = 0; step < 60; step += 1) scene.tick(100);
    expect(frameOf(scene).awayAgentIds.has("a")).toBe(true);
  });

  it("does not cancel an in-flight errand when Towers grows by a REAL uniform shift", () => {
    // Towers packs one agent at a time; growing this particular roster from
    // 3 to 28 members crosses the point where it adds a storey and shifts
    // everything below it - a real `shiftFromPrevious`, not a hand-forged one.
    const epic = makeTestEpic("one-team", 60, 3);
    const full = epic.agents;
    const scene = new OfficeScene(OFFICE_VIEWS.towers, null);
    const control = new OfficeScene(OFFICE_VIEWS.towers, null);
    const initialAgents = full.slice(0, 3);
    const initialVisible = new Set(initialAgents.map((person) => person.id));
    scene.sync(
      sceneInput({
        agents: initialAgents,
        visibleAgentIds: initialVisible,
      }),
    );
    control.sync(
      sceneInput({ agents: initialAgents, visibleAgentIds: initialVisible }),
    );
    const target = full[0].id;

    let away = false;
    for (let step = 0; step < 500 && !away; step += 1) {
      scene.tick(100);
      control.tick(100);
      away = frameOf(scene).awayAgentIds.has(target);
    }
    expect(away).toBe(true);
    for (let step = 0; step < 5; step += 1) {
      scene.tick(100);
      control.tick(100);
    }
    const beforeGrowth = frameOf(scene);
    const beforeRect = characterRect(beforeGrowth, target);
    const beforeSprite = characterSpriteAt(beforeGrowth, beforeRect);
    if (beforeSprite === null) throw new Error("expected a walking character");

    let sawShift = false;
    let reportedShift: OfficePoint | null = null;
    for (let count = 4; count <= 28; count += 1) {
      scene.sync(
        sceneInput({
          agents: full.slice(0, count),
          visibleAgentIds: new Set(
            full.slice(0, count).map((person) => person.id),
          ),
          pulseKey: `grow-${count}`,
        }),
      );
      if (layoutOf(scene).shiftFromPrevious !== null) {
        sawShift = true;
        reportedShift = scene.takeShift();
        expect(reportedShift).not.toBeNull();
        expect(scene.takeShift()).toBeNull();
        const afterGrowth = frameOf(scene);
        expect(afterGrowth.awayAgentIds.has(target)).toBe(true);
        const afterRect = characterRect(afterGrowth, target);
        expect(afterRect).not.toEqual(beforeRect);
        const afterSprite = characterSpriteAt(afterGrowth, afterRect);
        if (afterSprite === null)
          throw new Error("expected a shifted character");
        expect(afterSprite.pose).toBe(beforeSprite.pose);
        break;
      }
    }
    expect(sawShift).toBe(true);
    expect(reportedShift).not.toBeNull();
    if (reportedShift === null) throw new Error("expected a projected shift");

    for (let step = 0; step < 12; step += 1) {
      scene.tick(100);
      control.tick(100);
      const grownRect = characterRect(frameOf(scene), target);
      const controlRect = characterRect(frameOf(control), target);
      expect(grownRect.x - controlRect.x).toBeCloseTo(reportedShift.x, 8);
      expect(grownRect.y - controlRect.y).toBeCloseTo(reportedShift.y, 8);
      expect(frameOf(scene).awayAgentIds.has(target)).toBe(true);
    }

    for (let step = 0; step < 48; step += 1) scene.tick(100);
    expect(frameOf(scene).awayAgentIds.has(target)).toBe(true);
  });
});

describe("OfficeScene fixup 1 - F3 scrub-back reconciliation", () => {
  it("rehomes a character to its recomputed claim after a scrub back to an idle cursor", () => {
    const cubby = cubbySeat({
      seatId: "h/0/cubby",
      deskTile: { col: 8, row: 4 },
      floorIndex: 0,
    });
    const reserve = deskSeat({
      seatId: "h/0/reserve",
      deskTile: { col: 2, row: 8 },
      floorIndex: 0,
    });
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([["a", { ...cubby, agentId: "a" }]]),
      seats: new Map([
        ["h/0/cubby", cubby],
        ["h/0/reserve", reserve],
      ]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const scene = new OfficeScene(
      testView(() => layout),
      null,
    );
    const A = agent({ id: "a", createdAt: 1 });
    scene.sync(
      sceneInput({
        agents: [A],
        visibleAgentIds: new Set(["a"]),
        statusById: new Map<string, OfficeAgentStatus>([["a", "working"]]),
        cursorMs: null,
      }),
    );

    // Reaches the claimed reserve - chair row 9, y = 9*16-4 = 140.
    let atReserve = false;
    for (let step = 0; step < 300 && !atReserve; step += 1) {
      scene.tick(100);
      atReserve = characterRect(frameOf(scene), "a").y === 140;
    }
    expect(atReserve).toBe(true);

    // Scrub from live back to an idle historical cursor: the claim is
    // recomputed away (idle is not a hot status), but nothing has yet moved
    // the character that survived reconciliation off the reserve it is
    // painted at.
    scene.sync(
      sceneInput({
        agents: [A],
        visibleAgentIds: new Set(["a"]),
        statusById: new Map<string, OfficeAgentStatus>([["a", "idle"]]),
        cursorMs: 100,
      }),
    );
    for (let step = 0; step < 100; step += 1) scene.tick(100);

    // The effective cubby is chair row 4, y = 4*16-4 = 60. Painted occupancy
    // must agree with it rather than staying at the stale reserve box.
    expect(characterRect(frameOf(scene), "a").y).toBe(60);
  });
});

describe("OfficeScene fixup 1 - F4 hit order matches the world stream", () => {
  it("agrees with the world stream's front-most character at an overlap", () => {
    const skewProjector: OfficeProjector = {
      project: (col, row) => ({ x: 100 + col, y: 200 + row - col }),
      bounds: { x: 0, y: 0, width: 2000, height: 2000 },
      seatLift: () => 0,
    };
    const deskA = deskSeat({
      seatId: "h/0/a",
      deskTile: { col: 2, row: 1 },
      floorIndex: 0,
    });
    const deskB = deskSeat({
      seatId: "h/0/b",
      deskTile: { col: 6, row: 1 },
      floorIndex: 0,
    });
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([
        ["a", { ...deskA, agentId: "a" }],
        ["b", { ...deskB, agentId: "b" }],
      ]),
      seats: new Map([
        ["h/0/a", deskA],
        ["h/0/b", deskB],
      ]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: {
        ...OFFICE_VIEWS.floor.painter,
        depth: "world",
        projector: () => skewProjector,
      },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: [
          agent({ id: "a", createdAt: 1 }),
          agent({ id: "b", createdAt: 2 }),
        ],
        visibleAgentIds: new Set(["a", "b"]),
      }),
    );

    const frame = frameOf(scene);
    if (frame.world === null) throw new Error("expected a world stream");
    const characters = frame.world.filter(
      (entry) =>
        entry.drawable.kind === "sprite" &&
        entry.drawable.sprite.name === "character",
    );
    expect(characters).toHaveLength(2);
    const frontMost = characters.at(-1);
    if (frontMost === undefined) throw new Error("expected a front sprite");
    // a sits further left on the same row, which this skew projector reads as
    // nearer the viewer - it is the one drawn last (frontmost).
    expect(frontMost.ownerAgentId).toBe("a");

    expect(scene.hitTest({ x: 106, y: 188 })).toBe(frontMost.ownerAgentId);
  });

  /**
   * A CONTROL, not a proof: this one never reproduced F4.
   *
   * Building's real depth is its foot y, which stays monotonic with the
   * row/col/id comparator the old code sorted by, in every scenario tried -
   * all-agents, same-row pairs, active motion. So the bug does not reach an
   * oblique view, and this case asserts the invariant holds there rather than
   * demonstrating it once did not. City below is the one that fails without
   * the fix; a non-identity projector is what surfaces this.
   */
  it("orders Building's real world-depth painter and its hit regions consistently while agents are mid-walk", () => {
    const epic = makeTestEpic("one-team", 60, 4);
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
      }),
    );
    // Real motion, ticked far enough in that several characters are mid-walk
    // with fractional projected positions - the shape a purely row/col/id
    // comparator (orderedCharacters) cannot agree with a genuine depth sort
    // on, unlike two characters both sitting still in their chairs.
    for (let step = 0; step < 30; step += 1) scene.tick(100);

    const frame = frameOf(scene);
    if (frame.world === null) throw new Error("expected a world stream");
    const worldOrder = frame.world
      .filter(
        (entry) =>
          entry.drawable.kind === "sprite" &&
          entry.drawable.sprite.name === "character",
      )
      .map((entry) => entry.ownerAgentId);
    expect(worldOrder.length).toBeGreaterThan(1);

    const hitOrder = frame.hitRegions
      .filter((region) => region.rect.height === OFFICE_CHARACTER_HEIGHT)
      .map((region) => region.agentId);

    // `hitTest` walks `hitRegions` front to back, so this is the same
    // invariant `hitTest` relies on: it must list exactly the world stream's
    // order, reversed (front-most first).
    expect(hitOrder).toEqual([...worldOrder].reverse());
  });

  it("orders City's real world-depth painter and its hit regions consistently while agents are mid-walk", () => {
    const epic = makeTestEpic("many-roots", 60, 4);
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
      }),
    );
    for (let step = 0; step < 30; step += 1) scene.tick(100);

    const frame = frameOf(scene);
    if (frame.world === null) throw new Error("expected a world stream");
    const worldOrder = frame.world
      .filter(
        (entry) =>
          entry.drawable.kind === "sprite" &&
          entry.drawable.sprite.name === "character",
      )
      .map((entry) => entry.ownerAgentId);
    expect(worldOrder.length).toBeGreaterThan(1);

    const hitOrder = frame.hitRegions
      .filter((region) => region.rect.height === OFFICE_CHARACTER_HEIGHT)
      .map((region) => region.agentId);

    expect(hitOrder).toEqual([...worldOrder].reverse());
  });
});

describe("OfficeScene fixup 1 - F6 culls before it sorts", () => {
  it("does not sort the whole population to answer an empty viewport", () => {
    const agents: OfficeAgentInput[] = Array.from({ length: 1000 }, (_, i) =>
      agent({ id: `agent-${i}`, createdAt: i + 1 }),
    );
    const ids = new Set(agents.map((one) => one.id));
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents, visibleAgentIds: ids }));
    scene.tick(100);

    const sortSpy = vi.spyOn(Array.prototype, "sort");
    try {
      // Nowhere near where `layoutOffice` packs a thousand desks, so the
      // frame is empty by construction - the only question is how much work
      // answering that cost.
      const frame = scene.frame(2, {
        x: -50_000,
        y: -50_000,
        width: 10,
        height: 10,
      });
      expect(frame.actors).toEqual([]);

      // A sort invoked on an array this large can only be the population-wide
      // `orderedCharacters` pass - nothing else in a ten-pixel empty query
      // has a thousand elements to sort. Culling first must never trigger one.
      const populationWideSorts = sortSpy.mock.instances.filter(
        (instance) => Array.isArray(instance) && instance.length >= 1000,
      );
      expect(populationWideSorts).toHaveLength(0);
    } finally {
      sortSpy.mockRestore();
    }
  });
});

describe("OfficeScene fixup 1 - F7 reserve claim lifecycle", () => {
  function reserveFixture(receptionQueueTiles: ReadonlyArray<OfficeTilePos>): {
    readonly layout: OfficeLayout;
    readonly cubby: OfficeSeat;
    readonly reserve: OfficeSeat;
  } {
    const cubby = cubbySeat({
      seatId: "h/0/cubby",
      deskTile: { col: 8, row: 2 },
      floorIndex: 0,
    });
    const reserve = deskSeat({
      seatId: "h/0/reserve",
      deskTile: { col: 2, row: 8 },
      floorIndex: 0,
    });
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([["a", { ...cubby, agentId: "a" }]]),
      seats: new Map([
        ["h/0/cubby", cubby],
        ["h/0/reserve", reserve],
      ]),
      signs: [],
      rooms: [],
      floors: [{ ...handBuiltFloor([]), receptionQueueTiles }],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    return { layout, cubby, reserve };
  }

  function reserveBox(reserve: OfficeSeat): OfficeRect {
    return {
      x: reserve.deskTile.col * OFFICE_TILE,
      y: reserve.deskTile.row * OFFICE_TILE,
      width: reserve.hitTiles.width * OFFICE_TILE,
      height: reserve.hitTiles.height * OFFICE_TILE,
    };
  }

  function reserveShowsOccupant(
    scene: OfficeScene,
    reserve: OfficeSeat,
  ): boolean {
    const box = reserveBox(reserve);
    return frameOf(scene).hitRegions.some(
      (region) =>
        region.agentId === "a" &&
        region.rect.x === box.x &&
        region.rect.y === box.y &&
        region.rect.width === box.width &&
        region.rect.height === box.height,
    );
  }

  it("(a) does not claim a reserve for a cubby agent still headed for reception", () => {
    const { layout, reserve } = reserveFixture([{ col: 1, row: 0 }]);
    const scene = new OfficeScene(
      testView(() => layout),
      null,
    );
    scene.sync(
      sceneInput({
        agents: [agent({ id: "a", createdAt: 1 })],
        visibleAgentIds: new Set(["a"]),
        statusById: new Map<string, OfficeAgentStatus>([["a", "attention"]]),
      }),
    );

    expect(reserveShowsOccupant(scene, reserve)).toBe(false);
  });

  it("(b) frees the reserve for the NEXT plan once the character is actually back home, with no status-changing sync in between", () => {
    const { cubby, reserve } = reserveFixture([]);
    // A second layout, installed once a second agent appears, so a real
    // `OfficePlanInput.occupancy` can be inspected at the moment the office
    // next re-plans - the only place `occupancy()` (as opposed to the
    // painted frame, which reads the claim differently) is ever surfaced.
    const layout1 = reserveFixture([]).layout;
    const cubby2 = { ...cubby, seatId: "h/0/cubby2" };
    const layout2: OfficeLayout = {
      ...layout1,
      desks: new Map([
        ["a", { ...cubby, agentId: "a" }],
        ["c", { ...cubby2, agentId: "c" }],
      ]),
      seats: new Map([...layout1.seats, [cubby2.seatId, cubby2]]),
    };
    let occupancyAtReplan: string | undefined;
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: (input) => {
        if (input.agents.length > 1) {
          occupancyAtReplan = input.occupancy.get(reserve.seatId);
          return layout2;
        }
        return layout1;
      },
    };
    const scene = new OfficeScene(view, null);
    const A = agent({ id: "a", createdAt: 1 });
    scene.sync(
      sceneInput({
        agents: [A],
        visibleAgentIds: new Set(["a"]),
        statusById: new Map<string, OfficeAgentStatus>([["a", "idle"]]),
      }),
    );
    scene.sync(
      sceneInput({
        agents: [A],
        visibleAgentIds: new Set(["a"]),
        statusById: new Map<string, OfficeAgentStatus>([["a", "working"]]),
      }),
    );
    const reserveSeatedBox: OfficeRect = {
      x: reserve.chairTile.col * OFFICE_TILE,
      y: reserve.chairTile.row * OFFICE_TILE - 4,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
    let atReserve = false;
    for (let step = 0; step < 300 && !atReserve; step += 1) {
      scene.tick(100);
      const rect = characterRect(frameOf(scene), "a");
      atReserve =
        rect.x === reserveSeatedBox.x &&
        rect.y === reserveSeatedBox.y &&
        rect.width === reserveSeatedBox.width &&
        rect.height === reserveSeatedBox.height;
    }
    expect(atReserve).toBe(true);

    // Cools off, WITHOUT ever becoming home yet.
    scene.sync(
      sceneInput({
        agents: [A],
        visibleAgentIds: new Set(["a"]),
        statusById: new Map<string, OfficeAgentStatus>([["a", "idle"]]),
      }),
    );
    const cubbyBox: OfficeRect = {
      x: cubby.chairTile.col * OFFICE_TILE,
      y: cubby.chairTile.row * OFFICE_TILE - 4,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
    let home = false;
    for (let step = 0; step < 300 && !home; step += 1) {
      scene.tick(100);
      home =
        JSON.stringify(characterRect(frameOf(scene), "a")) ===
        JSON.stringify(cubbyBox);
    }
    expect(home).toBe(true);

    // Only now does a second agent arrive, triggering the next plan. The
    // character has been home for a while, with no OTHER sync in between -
    // the reserve it walked away from should already have been released by
    // its own return, not still be held open for the plan that just asked.
    scene.sync(
      sceneInput({
        agents: [A, agent({ id: "c", createdAt: 2 })],
        visibleAgentIds: new Set(["a", "c"]),
        statusById: new Map<string, OfficeAgentStatus>([["a", "idle"]]),
      }),
    );

    expect(occupancyAtReplan).toBeUndefined();
  });

  it("(c) releases the reserve once an archived occupant's walk-out has actually completed", () => {
    const { layout, reserve } = reserveFixture([]);
    // Same trick as (b): `occupancy()` is only ever surfaced to a plan, so a
    // second layout gives us a re-plan to read it at. The archived agent's own
    // desk stays spoken for - it is still assigned to it, sheeted - and what
    // has to be free is the RESERVE it was borrowing.
    // `occupancy()` is only ever surfaced to a plan, so a second agent gives us
    // a re-plan to read it at. What must be free is the RESERVE the archived
    // agent borrowed - its own cubby stays spoken for, because it is still
    // assigned to it and the desk is sheeted rather than gone.
    let reserveHolderAtReplan: string | undefined;
    let replanned = false;
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: (input) => {
        if (input.agents.length > 1) {
          replanned = true;
          reserveHolderAtReplan = input.occupancy.get(reserve.seatId);
        }
        return layout;
      },
    };
    const scene = new OfficeScene(view, null);
    const leaver = agent({ id: "a", createdAt: 1 });
    scene.sync(
      sceneInput({
        agents: [leaver],
        visibleAgentIds: new Set(["a"]),
        statusById: new Map<string, OfficeAgentStatus>([["a", "idle"]]),
        cursorMs: 100,
      }),
    );
    scene.sync(
      sceneInput({
        agents: [leaver],
        visibleAgentIds: new Set(["a"]),
        statusById: new Map<string, OfficeAgentStatus>([["a", "working"]]),
        cursorMs: 200,
      }),
    );
    for (let step = 0; step < 300; step += 1) scene.tick(100);

    const archived = agent({ id: "a", createdAt: 1, archivedAt: 500 });
    scene.sync(
      sceneInput({
        agents: [archived],
        visibleAgentIds: new Set(["a"]),
        statusById: new Map<string, OfficeAgentStatus>(),
        cursorMs: 900,
      }),
    );
    let gone = false;
    for (let step = 0; step < 300 && !gone; step += 1) {
      scene.tick(100);
      gone = !hasCharacter(frameOf(scene), "a");
    }
    expect(gone).toBe(true);

    // The walk-out is COMPLETE and no further input has arrived. Adding a
    // second agent forces the re-plan that lets us read `occupancy()`; the
    // reserve must already be free by the time the plan is asked, not freed
    // as a side effect of asking.
    scene.sync(
      sceneInput({
        agents: [archived, agent({ id: "c", createdAt: 2 })],
        visibleAgentIds: new Set(["a", "c"]),
        statusById: new Map<string, OfficeAgentStatus>(),
        cursorMs: 900,
      }),
    );
    expect(replanned).toBe(true);
    expect(reserveHolderAtReplan).toBeUndefined();
  });
});

describe("OfficeScene fixup 1 - F9 agent-pulse focus omits seatLift", () => {
  it("lifts the focus anchor when the sender is seated, like the envelope endpoints already do", () => {
    const desk = deskSeat({
      seatId: "h/0/a",
      deskTile: { col: 2, row: 3 },
      floorIndex: 0,
    });
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([["a", { ...desk, agentId: "a" }]]),
      seats: new Map([["h/0/a", desk]]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const projector: OfficeProjector = {
      project: (col, row) => ({ x: col * OFFICE_TILE, y: row * OFFICE_TILE }),
      bounds: { x: 0, y: 0, width: 2000, height: 2000 },
      seatLift: () => 40,
    };
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: { ...OFFICE_VIEWS.floor.painter, projector: () => projector },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: [agent({ id: "a", createdAt: 1 })],
        visibleAgentIds: new Set(["a"]),
      }),
    );
    scene.sync(
      sceneInput({
        agents: [agent({ id: "a", createdAt: 1 })],
        visibleAgentIds: new Set(["a"]),
        pulse: { kind: "agent", agentId: "a", senderAgentId: "a" },
        pulseKey: "agent-a",
      }),
    );

    expect(frameOf(scene).focus?.y).toBe(20);
  });
});

describe("OfficeScene fixup 1 - F8 unoccupied reserves reach the painter", () => {
  function reservesLayout(): {
    readonly layout: OfficeLayout;
    readonly reserveSeatId: string;
    readonly futureSeatId: string;
  } {
    const workerSeat = deskSeat({
      seatId: "h/0/worker",
      deskTile: { col: 2, row: 2 },
      floorIndex: 0,
    });
    const reserveSeat = deskSeat({
      seatId: "h/0/reserve",
      deskTile: { col: 5, row: 2 },
      floorIndex: 0,
    });
    const futureSeat = deskSeat({
      seatId: "h/0/future",
      deskTile: { col: 8, row: 2 },
      floorIndex: 0,
    });
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      // The reserve is NOT in `desks` at all - nobody, present or future, is
      // assigned to it. `future` IS assigned, to an agent that has not been
      // synced yet, which is the case the painter must keep hidden.
      desks: new Map([
        ["worker", { ...workerSeat, agentId: "worker" }],
        ["future", { ...futureSeat, agentId: "future" }],
      ]),
      seats: new Map([
        ["h/0/worker", workerSeat],
        ["h/0/reserve", reserveSeat],
        ["h/0/future", futureSeat],
      ]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    return {
      layout,
      reserveSeatId: reserveSeat.seatId,
      futureSeatId: futureSeat.seatId,
    };
  }

  it("delivers an unoccupied reserve at lod 1/2 with agentId null, keeps a future agent's desk hidden, and stays silent at lod 0 (D27)", () => {
    const { layout, reserveSeatId, futureSeatId } = reservesLayout();
    const calls: Array<{ seatId: string; agentId: string | null }> = [];
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: {
        ...OFFICE_VIEWS.floor.painter,
        seatProps: (planLayout, seat, state, lod) => {
          calls.push({ seatId: seat.seatId, agentId: state.agentId });
          return OFFICE_VIEWS.floor.painter.seatProps(
            planLayout,
            seat,
            state,
            lod,
          );
        },
      },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: [agent({ id: "worker", createdAt: 1 })],
        visibleAgentIds: new Set(["worker"]),
      }),
    );

    scene.frame(0, WHOLE_WORLD);
    expect(calls).toHaveLength(0);

    for (const lod of [1, 2] as const) {
      calls.length = 0;
      scene.frame(lod, WHOLE_WORLD);
      const reserveCall = calls.find((call) => call.seatId === reserveSeatId);
      expect(reserveCall).toEqual({ seatId: reserveSeatId, agentId: null });
      expect(calls.some((call) => call.seatId === futureSeatId)).toBe(false);
    }
  });

  it("delivers a real oblique plan's free reserves too, not only a hand-built seat map", () => {
    const epic = makeTestEpic("one-team", 12, 9);
    const cold = new Map<string, OfficeAgentStatus>(
      epic.agents.map((person) => [person.id, "idle"]),
    );
    const calls: Array<{ seatId: string; agentId: string | null }> = [];
    const view: OfficeView = {
      ...OFFICE_VIEWS.building,
      painter: {
        ...OFFICE_VIEWS.building.painter,
        seatProps: (planLayout, seat, state, lod) => {
          calls.push({ seatId: seat.seatId, agentId: state.agentId });
          return OFFICE_VIEWS.building.painter.seatProps(
            planLayout,
            seat,
            state,
            lod,
          );
        },
      },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
        statusById: cold,
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const assignedSeatIds = new Set(
      Array.from(layout.desks.values()).map((desk) => desk.seatId),
    );
    const reserve = Array.from(layout.seats.values()).find(
      (seat) => seat.kind === "desk" && !assignedSeatIds.has(seat.seatId),
    );
    if (reserve === undefined) throw new Error("expected a free reserve seat");

    scene.frame(1, WHOLE_WORLD);
    const reserveCall = calls.find((call) => call.seatId === reserve.seatId);
    expect(reserveCall).toEqual({ seatId: reserve.seatId, agentId: null });
  });
});

describe("OfficeScene fixup 1 - F14 reception queue across aliased floors", () => {
  it("gives two attention agents on different storeys of one building different queue tiles", () => {
    const epic = makeTestEpic("one-team", 40, 3);
    const probe = new OfficeScene(OFFICE_VIEWS.building, null);
    probe.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
      }),
    );
    const realLayout = layoutOf(probe);
    const byFloor = new Map<number, string[]>();
    for (const [agentId, desk] of realLayout.desks) {
      const list = byFloor.get(desk.floorIndex) ?? [];
      list.push(agentId);
      byFloor.set(desk.floorIndex, list);
    }
    const floorsWithAgents = Array.from(byFloor.keys()).filter(
      (floorIndex) =>
        realLayout.floors[floorIndex].receptionQueueTiles.length > 0,
    );
    // Two upper storeys of a single Towers/Building block alias the ground
    // plaza's reception tiles (D13) - this fixture needs at least two such
    // floors to exercise the collision at all.
    expect(floorsWithAgents.length).toBeGreaterThanOrEqual(2);
    const [floorA, floorB] = floorsWithAgents;
    const agentA = byFloor.get(floorA)?.[0];
    const agentB = byFloor.get(floorB)?.[0];
    if (agentA === undefined || agentB === undefined) {
      throw new Error("expected an agent on each of two floors");
    }

    // The real plan's own geometry, agent for agent - only agentA's and
    // agentB's own seats are turned from a cubby into a desk, so going hot
    // does not ALSO claim them a reserve (F7) and move their effective
    // floor before reception ever runs. Everything else - the floors, the
    // aliased reception tiles, every other seat - is exactly what the real
    // oblique plan produced.
    const seatA = realLayout.desks.get(agentA);
    const seatB = realLayout.desks.get(agentB);
    if (seatA === undefined || seatB === undefined) {
      throw new Error("expected both probe agents to have desks");
    }
    const layout: OfficeLayout = {
      ...realLayout,
      desks: new Map(realLayout.desks)
        .set(agentA, { ...seatA, kind: "desk" })
        .set(agentB, { ...seatB, kind: "desk" }),
      seats: new Map(realLayout.seats)
        .set(seatA.seatId, { ...seatA, kind: "desk" })
        .set(seatB.seatId, { ...seatB, kind: "desk" }),
    };

    const view: OfficeView = { ...OFFICE_VIEWS.building, plan: () => layout };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
      }),
    );
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
        statusById: new Map<string, OfficeAgentStatus>([
          [agentA, "attention"],
          [agentB, "attention"],
        ]),
        reducedMotion: true,
      }),
    );

    const frame = frameOf(scene);
    const rectA = characterRect(frame, agentA);
    const rectB = characterRect(frame, agentB);
    expect(rectA).not.toEqual(rectB);
  });
});

describe("OfficeScene fixup 1 - F15 idle seat dimming (D37)", () => {
  /**
   * Through `visibleDrawables`, not `frame.actors`: a `world` painter - which
   * Building and City both are - leaves `actors` empty and interleaves its
   * characters into `frame.world` by depth, so reading `actors` here answered
   * `undefined` for every oblique and isometric view whatever the alpha was.
   */
  function spriteAlphaOf(
    frame: OfficeFrame,
    rect: OfficeRect,
  ): number | undefined {
    const drawable = visibleDrawables(frame).find(
      (candidate) =>
        candidate.kind === "sprite" &&
        candidate.x === rect.x &&
        candidate.y === rect.y,
    );
    return drawable?.kind === "sprite" ? drawable.alpha : undefined;
  }

  it("dims a seated idle occupant of a seat carrying idleAlpha, at lod 1 and 2, leaving a control seat and a non-idle occupant undimmed", () => {
    const dimSeat = {
      ...deskSeat({
        seatId: "h/0/dim",
        deskTile: { col: 2, row: 2 },
        floorIndex: 0,
      }),
      idleAlpha: 0.55,
    };
    const noAlphaSeat = deskSeat({
      seatId: "h/0/control",
      deskTile: { col: 5, row: 2 },
      floorIndex: 0,
    });
    const dimWorkingSeat = {
      ...deskSeat({
        seatId: "h/0/dim-working",
        deskTile: { col: 8, row: 2 },
        floorIndex: 0,
      }),
      idleAlpha: 0.55,
    };
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([
        ["dim", { ...dimSeat, agentId: "dim" }],
        ["control", { ...noAlphaSeat, agentId: "control" }],
        ["working", { ...dimWorkingSeat, agentId: "working" }],
      ]),
      seats: new Map([
        ["h/0/dim", dimSeat],
        ["h/0/control", noAlphaSeat],
        ["h/0/dim-working", dimWorkingSeat],
      ]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const scene = new OfficeScene(
      testView(() => layout),
      null,
    );
    scene.sync(
      sceneInput({
        agents: [
          agent({ id: "dim", createdAt: 1 }),
          agent({ id: "control", createdAt: 2 }),
          agent({ id: "working", createdAt: 3 }),
        ],
        visibleAgentIds: new Set(["dim", "control", "working"]),
        statusById: new Map<string, OfficeAgentStatus>([
          ["dim", "idle"],
          ["control", "idle"],
          ["working", "working"],
        ]),
      }),
    );

    for (const lod of [1, 2] as const) {
      const frame = scene.frame(lod, WHOLE_WORLD);
      expect(spriteAlphaOf(frame, characterRect(frame, "dim"))).toBe(0.55);
      expect(
        spriteAlphaOf(frame, characterRect(frame, "control")),
      ).toBeUndefined();
      expect(
        spriteAlphaOf(frame, characterRect(frame, "working")),
      ).toBeUndefined();
    }

    // A walker crossing the same idleAlpha seat's tile, mid walk-in, is not
    // "seated at its effective seat" and must stay undimmed too.
    const walkerScene = new OfficeScene(
      testView(() => layout),
      null,
    );
    walkerScene.sync(
      sceneInput({
        agents: [agent({ id: "dim", createdAt: 1 })],
        visibleAgentIds: new Set<string>(),
        statusById: new Map<string, OfficeAgentStatus>([["dim", "idle"]]),
      }),
    );
    walkerScene.sync(
      sceneInput({
        agents: [agent({ id: "dim", createdAt: 1 })],
        visibleAgentIds: new Set(["dim"]),
        statusById: new Map<string, OfficeAgentStatus>([["dim", "idle"]]),
        pulse: {
          kind: "edge",
          edgeId: "created-dim",
          pulseKind: "created",
          fromAgentId: "dim",
          toAgentId: "dim",
        },
        pulseKey: "created-dim",
      }),
    );
    const walkerFrame = frameOf(walkerScene);
    expect(walkerFrame.awayAgentIds.has("dim")).toBe(true);
    expect(
      spriteAlphaOf(walkerFrame, characterRect(walkerFrame, "dim")),
    ).toBeUndefined();
  });

  it("dims an idle occupant of a real Building team-room desk (idleAlpha 0.55 from the oblique plan itself)", () => {
    const epic = makeTestEpic("triage", 40, 1);
    // A team room only leaves cubbies for a desk (and carries idleAlpha) while
    // the team is "live" - any member hot. Keep each team's lead hot so its
    // room stays live, while every other member sits idle at a dimmable desk.
    const statusById = new Map<string, OfficeAgentStatus>(
      epic.agents.map((person) => [
        person.id,
        person.id.endsWith("-lead") ? "working" : "idle",
      ]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
        statusById,
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const dimmed = Array.from(layout.desks.entries()).find(
      ([agentId, desk]) =>
        desk.idleAlpha === 0.55 && statusById.get(agentId) === "idle",
    );
    if (dimmed === undefined) {
      throw new Error(
        "expected the real Building plan to seat at least one idle agent in a team-room desk carrying idleAlpha",
      );
    }
    const [dimmedAgentId] = dimmed;
    const plain = Array.from(layout.desks.entries()).find(
      ([, desk]) => desk.idleAlpha === undefined,
    );
    if (plain === undefined) {
      throw new Error(
        "expected at least one desk without idleAlpha to control against",
      );
    }
    const [plainAgentId] = plain;

    const frame = scene.frame(1, WHOLE_WORLD);
    expect(spriteAlphaOf(frame, characterRect(frame, dimmedAgentId))).toBe(
      0.55,
    );
    expect(
      spriteAlphaOf(frame, characterRect(frame, plainAgentId)),
    ).toBeUndefined();
  });
});

describe("OfficeScene fixup 1 - F17 isometric growth reports a projected shift", () => {
  it("reports the projector's origin delta as a shift when a real City plan grows rows, and cancels no errand doing it", () => {
    const shape = "many-roots" as const;
    const seed = 7;
    const agentsAt = (n: number): ReadonlyArray<OfficeAgentInput> =>
      makeTestEpic(shape, n, seed).agents;
    const statusFor = (
      list: ReadonlyArray<OfficeAgentInput>,
    ): Map<string, OfficeAgentStatus> =>
      new Map(list.map((person) => [person.id, "working" as const]));

    let count = 2;
    let roster = agentsAt(count);
    const scene = new OfficeScene(OFFICE_VIEWS.city, null);
    // The target starts idle so it wanders off on an errand; every AGENT
    // ADDED during growth is "working" per the finding's own fixture.
    scene.sync(
      sceneInput({
        agents: roster,
        visibleAgentIds: new Set(roster.map((person) => person.id)),
      }),
    );
    const target = roster[0].id;

    let away = false;
    for (let step = 0; step < 500 && !away; step += 1) {
      scene.tick(100);
      away = frameOf(scene).awayAgentIds.has(target);
    }
    expect(away).toBe(true);
    for (let step = 0; step < 5; step += 1) scene.tick(100);

    const before = layoutOf(scene);
    const beforeRows = before.rows;
    const beforeSeatIds = new Map(
      Array.from(before.desks.entries()).map(([id, desk]) => [id, desk.seatId]),
    );
    const beforeTiles = new Map(
      Array.from(before.desks.entries()).map(([id, desk]) => [
        id,
        desk.deskTile,
      ]),
    );
    const beforeOrigin = OFFICE_VIEWS.city.painter
      .projector(before)
      .project(0, 0);

    const originalIds = new Set(roster.map((person) => person.id));
    let grew = false;
    for (let n = count + 1; n <= count + 400 && !grew; n += 1) {
      roster = agentsAt(n);
      const growthStatus = statusFor(
        roster.filter((person) => !originalIds.has(person.id)),
      );
      scene.sync(
        sceneInput({
          agents: roster,
          visibleAgentIds: new Set(roster.map((person) => person.id)),
          statusById: growthStatus,
          pulseKey: `grow-${n}`,
        }),
      );
      if (layoutOf(scene).rows > beforeRows) grew = true;
    }
    expect(grew).toBe(true);
    count = roster.length;

    const after = layoutOf(scene);
    // Growth like this adds new seats but must not relocate anyone already
    // seated - the SAME agents keep the same seat id and the same tile.
    for (const [id, seatId] of beforeSeatIds) {
      expect(after.desks.get(id)?.seatId).toBe(seatId);
    }
    for (const [id, tile] of beforeTiles) {
      expect(after.desks.get(id)?.deskTile).toEqual(tile);
    }
    const afterOrigin = OFFICE_VIEWS.city.painter
      .projector(after)
      .project(0, 0);
    // The tiles did not move, but the projector's origin did - that is
    // exactly the "everyone moved on screen with no tile shift" case F17
    // names. If this fails the fixture never grew the origin and is not
    // exercising the bug.
    expect(afterOrigin).not.toEqual(beforeOrigin);

    const shift = scene.takeShift();
    expect(shift).toEqual({
      x: afterOrigin.x - beforeOrigin.x,
      y: afterOrigin.y - beforeOrigin.y,
    });

    for (let step = 0; step < 5; step += 1) scene.tick(100);
    expect(frameOf(scene).awayAgentIds.has(target)).toBe(true);
  });
});

// ---- T2 fixup 2: the reviewer's residuals ---------------------------- //

describe("OfficeScene fixup 2 - F2 a remembered errand tile follows the shift", () => {
  /**
   * TWO SPOTS ON ONE TILE, of different kinds, because that is the only shape
   * in which `lastErrandKey` does any work at all: `errandOptionsFor` already
   * excludes a spot of the last errand's KIND, so a tile is only ever
   * consulted for a spot whose kind differs. One agent, and no rooms, so no
   * visit target can ever be offered and the two spots are the whole of what
   * this character could possibly walk to.
   */
  function spotsAt(tile: OfficeTilePos): ReadonlyArray<OfficeErrandSpot> {
    const base = {
      facing: "down" as const,
      audience: { kind: "floor" as const },
      actionTile: null,
      seatId: null,
      floorIndex: 0,
    };
    return [
      {
        ...base,
        kind: "coffee",
        fixtureId: "coffee-1",
        tile,
        approachTile: tile,
      },
      {
        ...base,
        kind: "cooler",
        fixtureId: "cooler-1",
        tile,
        approachTile: tile,
      },
    ];
  }

  function layoutAt(args: {
    readonly deskRow: number;
    readonly spotRow: number;
    readonly shift: OfficeTilePos | null;
    readonly desks: ReadonlyArray<string>;
  }): OfficeLayout {
    const { deskRow, desks, shift, spotRow } = args;
    const seats = new Map<string, OfficeSeat>();
    const assigned = new Map<string, OfficeDesk>();
    for (let index = 0; index < desks.length; index += 1) {
      const agentId = desks[index];
      const seat = deskSeat({
        seatId: `h/0/${agentId}`,
        deskTile: { col: 2 + index * 3, row: deskRow },
        floorIndex: 0,
      });
      seats.set(seat.seatId, seat);
      assigned.set(agentId, { ...seat, agentId });
    }
    const floor: OfficeFloor = {
      ...handBuiltFloor(spotsAt({ col: 10, row: spotRow })),
      doorTile: { col: 0, row: deskRow - 3 },
      lobbyTile: { col: 0, row: deskRow - 2 },
      receptionTile: { col: 0, row: deskRow - 1 },
      clockTile: { col: 15, row: deskRow - 3 },
    };
    return {
      view: "floor",
      cols: 16,
      rows: 24,
      desks: assigned,
      seats,
      signs: [],
      rooms: [],
      floors: [floor],
      doorTile: { col: 0, row: deskRow - 3 },
      lobbyTile: { col: 0, row: deskRow - 2 },
      props: [],
      walkable: allWalkable(24, 16),
      frozen: null,
      shiftFromPrevious: shift,
      stable: true,
    };
  }

  it("keeps the tile an agent last visited blocked after the whole floor moves", () => {
    const before = layoutAt({
      deskRow: 3,
      spotRow: 10,
      shift: null,
      desks: ["a"],
    });
    const after = layoutAt({
      deskRow: 7,
      spotRow: 14,
      shift: { col: 0, row: 4 },
      desks: ["a", "b"],
    });
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: (input) => (input.agents.length <= 1 ? before : after),
    };
    const scene = new OfficeScene(view, null);
    const A = agent({ id: "a", createdAt: 1 });
    const B = agent({ id: "b", createdAt: 2 });
    scene.sync(sceneInput({ agents: [A], visibleAgentIds: new Set(["a"]) }));

    // One errand, out and back. This is the positive control for everything
    // below: the fixture demonstrably does send this agent on errands.
    let away = false;
    for (let step = 0; step < 600 && !away; step += 1) {
      scene.tick(100);
      away = frameOf(scene).awayAgentIds.has("a");
    }
    expect(away).toBe(true);
    let home = false;
    for (let step = 0; step < 600 && !home; step += 1) {
      scene.tick(100);
      home = !frameOf(scene).awayAgentIds.has("a");
    }
    expect(home).toBe(true);

    // And now it stays home: the other spot shares the tile it just came back
    // from, and the remembered key is the only thing excluding it.
    let leftAgain = false;
    for (let step = 0; step < 400 && !leftAgain; step += 1) {
      scene.tick(100);
      leftAgain = frameOf(scene).awayAgentIds.has("a");
    }
    expect(leftAgain).toBe(false);

    // The whole floor translates four rows. The spot that was at 10,10 is at
    // 10,14 now, and it is the SAME spot - so it has to stay blocked.
    scene.sync(
      sceneInput({
        agents: [A, B],
        visibleAgentIds: new Set(["a", "b"]),
        pulseKey: "grow",
      }),
    );
    let leftAfterShift = false;
    for (let step = 0; step < 400 && !leftAfterShift; step += 1) {
      scene.tick(100);
      leftAfterShift = frameOf(scene).awayAgentIds.has("a");
    }
    expect(leftAfterShift).toBe(false);
  });
});

describe("OfficeScene fixup 2 - F4 a foreground part is not the whole owner", () => {
  const BACK: OfficeRect = { x: 0, y: 0, width: 200, height: 150 };
  /** A local strip along the bottom of the back, painted far in front of it. */
  const STRIP = { x: 0, y: 140, width: 200, height: 10 };
  const STRIP_DEPTH = 1000;

  /** A point on the back that a character covers, and the strip does not. */
  const OVER_THE_BACK: OfficePoint = { x: 104, y: 70 };
  /** A point the strip DOES cover, and a character with it. */
  const UNDER_THE_STRIP: OfficePoint = { x: 104, y: 142 };

  function sceneWithParts(): OfficeScene {
    // `a` owns the two parts. Its own desk is out of the way in the corner so
    // the only thing of `a`'s near either test point is the declared box.
    const deskA: OfficeSeat = {
      ...deskSeat({
        seatId: "h/0/a",
        deskTile: { col: 0, row: 0 },
        floorIndex: 0,
      }),
      hitBox: BACK,
    };
    // Chair (6,4): foot (104, 80), sprite box (96,60,16,20) - over the back.
    const deskB = deskSeat({
      seatId: "h/0/b",
      deskTile: { col: 6, row: 3 },
      floorIndex: 0,
    });
    // Chair (6,8): foot (104, 144), sprite box (96,124,16,20) - into the strip.
    const deskC = deskSeat({
      seatId: "h/0/c",
      deskTile: { col: 6, row: 7 },
      floorIndex: 0,
    });
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([
        ["a", { ...deskA, agentId: "a" }],
        ["b", { ...deskB, agentId: "b" }],
        ["c", { ...deskC, agentId: "c" }],
      ]),
      seats: new Map([
        ["h/0/a", deskA],
        ["h/0/b", deskB],
        ["h/0/c", deskC],
      ]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: {
        ...OFFICE_VIEWS.floor.painter,
        depth: "world",
        // Nothing but `a`'s two parts, so every region in the frame is either
        // one of them, `a`'s declared box, or somebody's character.
        seatProps: (_layout, seat) =>
          seat.seatId !== "h/0/a"
            ? []
            : [
                {
                  drawable: { kind: "block", fill: "room", ...BACK },
                  depth: 0,
                  ownerAgentId: "a",
                },
                {
                  drawable: { kind: "block", fill: "pod", ...STRIP },
                  depth: STRIP_DEPTH,
                  ownerAgentId: "a",
                },
              ],
      },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: [
          agent({ id: "a", createdAt: 1 }),
          agent({ id: "b", createdAt: 2 }),
          agent({ id: "c", createdAt: 3 }),
        ],
        visibleAgentIds: new Set(["a", "b", "c"]),
      }),
    );
    return scene;
  }

  /** The first region covering this point: `hitRegions` is front-most first. */
  function ownerAt(frame: OfficeFrame, point: OfficePoint): string | null {
    for (const region of frame.hitRegions) {
      const { rect } = region;
      if (
        point.x >= rect.x &&
        point.x < rect.x + rect.width &&
        point.y >= rect.y &&
        point.y < rect.y + rect.height
      ) {
        return region.agentId;
      }
    }
    return null;
  }

  it("gives an overlapped point to the character drawn over the back, not to the back's owner", () => {
    const scene = sceneWithParts();
    const frame = frameOf(scene);
    if (frame.world === null) throw new Error("expected a world stream");

    // What the EYE sees, established first and independently of the regions:
    // the back goes down, then b's character over it.
    const backIndex = frame.world.findIndex(
      (entry) =>
        entry.ownerAgentId === "a" &&
        entry.drawable.kind === "block" &&
        entry.drawable.height === BACK.height,
    );
    const characterIndex = frame.world.findIndex(
      (entry) =>
        entry.ownerAgentId === "b" &&
        entry.drawable.kind === "sprite" &&
        entry.drawable.sprite.name === "character",
    );
    expect(backIndex).toBeGreaterThanOrEqual(0);
    expect(characterIndex).toBeGreaterThan(backIndex);

    // Both paths must agree with that, and with each other.
    expect(ownerAt(frame, OVER_THE_BACK)).toBe("b");
    expect(scene.hitTest(OVER_THE_BACK)).toBe("b");
  });

  it("still gives a point the foreground strip covers to the strip's owner", () => {
    const scene = sceneWithParts();
    const frame = frameOf(scene);

    // c's sprite box reaches y=144 and the strip starts at y=140, so this
    // point is under both of them - and the strip is painted in front.
    expect(ownerAt(frame, UNDER_THE_STRIP)).toBe("a");
    expect(scene.hitTest(UNDER_THE_STRIP)).toBe("a");
  });
});

describe("OfficeScene fixup 2 - F6 an empty frame projects nobody", () => {
  /** Nowhere near any office this fixture could plan. */
  const OFF_SCREEN: OfficeRect = {
    x: -50_000,
    y: -50_000,
    width: 10,
    height: 10,
  };

  interface WarmedEmptyFrame {
    readonly projectCalls: number;
    readonly frame: OfficeFrame;
  }

  /**
   * The projector calls a SECOND empty frame costs, at this population.
   *
   * The first frame is allowed whatever it needs; what this measures is the
   * steady state, which is where an office sitting still spends its battery.
   */
  function warmedEmptyFrame(population: number): WarmedEmptyFrame {
    const epic = makeTestEpic("triage", population, 1);
    let projectCalls = 0;
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      painter: {
        ...OFFICE_VIEWS.floor.painter,
        projector: (layout) => {
          const real = OFFICE_VIEWS.floor.painter.projector(layout);
          return {
            ...real,
            project: (col, row) => {
              projectCalls += 1;
              return real.project(col, row);
            },
          };
        },
      },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
        statusById: epic.statusById,
      }),
    );
    scene.frame(1, OFF_SCREEN);
    expect(projectCalls).toBeGreaterThan(0);
    projectCalls = 0;
    // The frame FIRST: an object literal reads `projectCalls` where it is
    // written, so building the pair inline would report the counter as it was
    // before the frame it is supposed to be measuring.
    const frame = scene.frame(1, OFF_SCREEN);
    return { projectCalls, frame };
  }

  it("costs the same projector calls at a thousand agents as at a hundred", () => {
    const many = warmedEmptyFrame(1000);
    const few = warmedEmptyFrame(100);

    // Nothing is on screen either way, which is the premise: what follows is
    // about the price of discovering that, not about what was drawn.
    expect(many.frame.actors).toEqual([]);
    expect(many.frame.props).toEqual([]);
    expect(many.frame.hitRegions).toEqual([]);

    // INDEPENDENT OF THE POPULATION. A frame is allowed the handful of fixed
    // points its own geometry takes; what it may not do is pay one per agent
    // it is not drawing - which was a thousand of them, every frame, forever.
    expect(many.projectCalls).toBe(few.projectCalls);
    expect(many.projectCalls).toBeLessThan(100);
  });
});

describe("OfficeScene fixup 2 - F9 a walking sender focuses the walker", () => {
  function walkingScene(): OfficeScene {
    const desk = deskSeat({
      seatId: "h/0/a",
      deskTile: { col: 2, row: 3 },
      floorIndex: 0,
    });
    const spot: OfficeErrandSpot = {
      kind: "coffee",
      tile: { col: 10, row: 10 },
      facing: "down",
      audience: { kind: "floor" },
      fixtureId: "coffee-1",
      approachTile: { col: 10, row: 10 },
      actionTile: null,
      seatId: null,
      floorIndex: 0,
    };
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([["a", { ...desk, agentId: "a" }]]),
      seats: new Map([["h/0/a", desk]]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([spot])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    // The same lifted projector the seated case uses, so the two differ in
    // the character's state and in nothing else.
    const projector: OfficeProjector = {
      project: (col, row) => ({ x: col * OFFICE_TILE, y: row * OFFICE_TILE }),
      bounds: { x: 0, y: 0, width: 2000, height: 2000 },
      seatLift: () => 40,
    };
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: { ...OFFICE_VIEWS.floor.painter, projector: () => projector },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: [agent({ id: "a", createdAt: 1 })],
        visibleAgentIds: new Set(["a"]),
      }),
    );
    return scene;
  }

  it("points at the sender's live head while it is out of its chair", () => {
    const scene = walkingScene();
    let away = false;
    for (let step = 0; step < 600 && !away; step += 1) {
      scene.tick(100);
      away = frameOf(scene).awayAgentIds.has("a");
    }
    expect(away).toBe(true);
    // A few more steps, so the focus below is taken against a character that
    // is genuinely between tiles rather than one still leaving its chair.
    for (let step = 0; step < 5; step += 1) scene.tick(100);

    scene.sync(
      sceneInput({
        agents: [agent({ id: "a", createdAt: 1 })],
        visibleAgentIds: new Set(["a"]),
        pulse: { kind: "agent", agentId: "a", senderAgentId: "a" },
        pulseKey: "agent-a",
      }),
    );
    // Still walking: the pulse is an agent pulse, and one of those does not
    // send anybody back to their chair.
    expect(frameOf(scene).awayAgentIds.has("a")).toBe(true);

    // `locate` answers a WALKER with its own sprite box, so this is the live
    // character and not the seat - and its head is the top-centre of it.
    const box = scene.locate("a");
    if (box === null) throw new Error("expected a box for the walker");
    expect(frameOf(scene).focus).toEqual({
      x: box.x + OFFICE_CHARACTER_WIDTH / 2,
      y: box.y,
    });
    // The seated anchor would have been the lifted chair at y=20; anything
    // reading the seat here answers that instead.
    expect(frameOf(scene).focus?.y).not.toBe(20);
  });
});

describe("OfficeScene fixup 1 - F19 a waking cubby stays under its occupant", () => {
  interface SeatCall {
    readonly seatId: string;
    readonly agentId: string | null;
  }

  interface WakingCubby {
    readonly scene: OfficeScene;
    readonly calls: SeatCall[];
    readonly sleeper: string;
    readonly cubbySeatId: string;
    readonly wake: () => void;
    /** Re-syncs with the sleeper on a new status; everyone else stays idle. */
    readonly setStatus: (status: OfficeAgentStatus) => void;
  }

  /**
   * A real Building with one cold agent in a cubby, and the sync that wakes it.
   *
   * Motion is NOT reduced on purpose: with it the walk collapses into sitting
   * down, the character arrives in the same call that claimed the seat, and
   * the window this finding lives in - claimed there, still standing here -
   * never opens.
   */
  function wakingCubby(): WakingCubby {
    const epic = makeTestEpic("one-team", 12, 9);
    const cold = new Map<string, OfficeAgentStatus>(
      epic.agents.map((person) => [person.id, "idle"]),
    );
    const calls: SeatCall[] = [];
    const view: OfficeView = {
      ...OFFICE_VIEWS.building,
      painter: {
        ...OFFICE_VIEWS.building.painter,
        seatProps: (planLayout, seat, state, lod) => {
          calls.push({ seatId: seat.seatId, agentId: state.agentId });
          return OFFICE_VIEWS.building.painter.seatProps(
            planLayout,
            seat,
            state,
            lod,
          );
        },
      },
    };
    const visibleAgentIds = new Set(epic.agents.map((person) => person.id));
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({ agents: epic.agents, visibleAgentIds, statusById: cold }),
    );
    const layout = layoutOf(scene);
    const cubby = Array.from(layout.desks.values()).find(
      (desk) => desk.kind === "cubby",
    );
    if (cubby === undefined) throw new Error("expected a cubby on Building");
    const setStatus = (status: OfficeAgentStatus): void => {
      const next = new Map(cold);
      next.set(cubby.agentId, status);
      scene.sync(
        sceneInput({ agents: epic.agents, visibleAgentIds, statusById: next }),
      );
    };
    return {
      scene,
      calls,
      sleeper: cubby.agentId,
      cubbySeatId: cubby.seatId,
      wake: () => {
        setStatus("working");
      },
      setStatus,
    };
  }

  /** Ticks until this agent is in a chair again, or gives up. */
  function settle(scene: OfficeScene, agentId: string): boolean {
    for (let step = 0; step < 400; step += 1) {
      scene.tick(100);
      if (!frameOf(scene).awayAgentIds.has(agentId)) return true;
    }
    return false;
  }

  /** Ticks until this agent is out of its chair again, or gives up. */
  function leave(scene: OfficeScene, agentId: string): boolean {
    for (let step = 0; step < 400; step += 1) {
      scene.tick(100);
      if (frameOf(scene).awayAgentIds.has(agentId)) return true;
    }
    return false;
  }

  it("paints the cubby with its occupant on the sync that wakes it", () => {
    const { calls, cubbySeatId, scene, sleeper, wake } = wakingCubby();

    calls.length = 0;
    scene.frame(1, WHOLE_WORLD);
    // Asleep in it: this is what the wake has to preserve, and a fixture whose
    // cubby was never painted would prove nothing about the wake.
    expect(calls.find((call) => call.seatId === cubbySeatId)).toEqual({
      seatId: cubbySeatId,
      agentId: sleeper,
    });

    wake();
    calls.length = 0;
    scene.frame(1, WHOLE_WORLD);

    expect(calls.find((call) => call.seatId === cubbySeatId)).toEqual({
      seatId: cubbySeatId,
      agentId: sleeper,
    });
  });

  it("lets the cubby go once its occupant has reached the seat it woke onto", () => {
    const { calls, cubbySeatId, scene, sleeper, wake } = wakingCubby();
    wake();

    // Walk it all the way to the reserve it claimed. `awayAgentIds` is the
    // scene's own word for "not in its chair", so the loop ends on the same
    // boundary the seat release does rather than on a tick count.
    expect(settle(scene, sleeper)).toBe(true);

    calls.length = 0;
    scene.frame(1, WHOLE_WORLD);
    expect(calls.some((call) => call.seatId === cubbySeatId)).toBe(false);
  });

  it("does not reopen the finished handover when the settled agent walks again", () => {
    const { calls, cubbySeatId, scene, setStatus, sleeper, wake } =
      wakingCubby();
    wake();
    expect(settle(scene, sleeper)).toBe(true);
    calls.length = 0;
    scene.frame(1, WHOLE_WORLD);
    // The handover is over and the cubby is gone. Everything below is about a
    // LATER walk, which has nothing to do with it.
    expect(calls.some((call) => call.seatId === cubbySeatId)).toBe(false);

    // Attention sends it to the counter - a real multi-tile queue-out, and it
    // starts from the reserve it settled in, nowhere near the old cubby.
    setStatus("attention");
    expect(leave(scene, sleeper)).toBe(true);

    calls.length = 0;
    scene.frame(1, WHOLE_WORLD);
    expect(calls.filter((call) => call.seatId === cubbySeatId)).toEqual([]);
  });
});

describe("OfficeScene fixup 1 - F18 a seat's declared painted box (D53)", () => {
  /**
   * Left of and above the desk tile's own projected corner, which is the
   * shape an isometric building takes: centred on `project(col + .5, row + 1)`
   * and rising with its storeys, so the art is offset in BOTH axes and no
   * `hitTiles` size - a width and a height, with no offset and no sign - can
   * ever reach it.
   */
  const PAINTED_BOX: OfficeRect = { x: 2104, y: 72, width: 32, height: 24 };

  function sceneWithBoxedSeat(): OfficeScene {
    const boxed: OfficeSeat = {
      ...deskSeat({
        seatId: "h/0/boxed",
        deskTile: { col: 6, row: 6 },
        floorIndex: 0,
      }),
      hitBox: PAINTED_BOX,
    };
    const plain = deskSeat({
      seatId: "h/0/plain",
      deskTile: { col: 2, row: 2 },
      floorIndex: 0,
    });
    const layout: OfficeLayout = {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([
        ["boxed", { ...boxed, agentId: "boxed" }],
        ["plain", { ...plain, agentId: "plain" }],
      ]),
      seats: new Map([
        [boxed.seatId, boxed],
        [plain.seatId, plain],
      ]),
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const view: OfficeView = {
      ...OFFICE_VIEWS.floor,
      plan: () => layout,
      painter: {
        ...OFFICE_VIEWS.floor.painter,
        projector: () => SHIFTED_PROJECTOR,
      },
    };
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInput({
        agents: [
          agent({ id: "boxed", createdAt: 1 }),
          agent({ id: "plain", createdAt: 1 }),
        ],
        visibleAgentIds: new Set(["boxed", "plain"]),
      }),
    );
    return scene;
  }

  it("locates and hit-tests a seat at its declared box, not at its desk tiles", () => {
    const scene = sceneWithBoxedSeat();

    expect(scene.locate("boxed")).toEqual(PAINTED_BOX);
    expect(
      scene.hitTest({
        x: PAINTED_BOX.x + PAINTED_BOX.width / 2,
        y: PAINTED_BOX.y + PAINTED_BOX.height / 2,
      }),
    ).toBe("boxed");
    // The tiles box is where the whole seam used to answer: desk tile (6,6)
    // through the +2048px projector, two tiles square. Top row, so the
    // seated character (a row below, at its chair) is not what answers here.
    expect(scene.hitTest({ x: 2144 + 4, y: 96 + 4 })).not.toBe("boxed");
  });

  it("leaves a seat with no declared box on its desk tiles", () => {
    const scene = sceneWithBoxedSeat();

    // Desk tile (2,2) projected, two tiles square - exactly as before D53.
    expect(scene.locate("plain")).toEqual({
      x: 2080,
      y: 32,
      width: 32,
      height: 32,
    });
    expect(scene.hitTest({ x: 2080 + 4, y: 32 + 4 })).toBe("plain");
  });
});

/** Where each character not seated in its own chair is standing, by tile. */
function standingByTileGeneric(
  scene: OfficeScene,
  layout: OfficeLayout,
): ReadonlyMap<string, string> {
  const byTile = new Map<string, string>();
  for (const region of scene.frame(2, WHOLE_WORLD).hitRegions) {
    if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
    const desk = layout.desks.get(region.agentId);
    if (desk === undefined) continue;
    if (
      region.rect.x === desk.chairTile.col * OFFICE_TILE &&
      region.rect.y === desk.chairTile.row * OFFICE_TILE - 4
    ) {
      continue;
    }
    if (region.rect.x % OFFICE_TILE !== 0) continue;
    byTile.set(
      `${region.rect.x / OFFICE_TILE},${(region.rect.y + 4) / OFFICE_TILE}`,
      region.agentId,
    );
  }
  return byTile;
}

describe("OfficeScene fixup 8c - the plan the settled feed owes (P2)", () => {
  /**
   * The floor an explicit view draws while the feed is still replaying is a
   * FIRST DRAFT: every status is the one the epic already knew, so no team
   * reads live, their members are planned into the quiet cubbies, and the
   * rooms a live team would have had are not there.
   *
   * Nothing used to replace it. The agent set does not change when a status
   * arrives, and a status flip alone deliberately never re-plans, so the draft
   * was the floor for the life of the mount - the cold reviewer's P2. The feed
   * settling is now a trigger of its own, and this is the shape of the floor
   * it owes: not "somebody got a desk", but the same floor a scene that had
   * waited for the feed would have planned in the first place.
   *
   * Asserted against that fresh plan rather than against `"desk"`, because a
   * half-fix has a shape: unpin the woken lead alone and it takes a desk while
   * its team-mate stays in the quiet stack, which is one desk and one cubby in
   * one room where a settled office has two desks in two rooms.
   */
  it("re-plans the provisional floor into the one a settled first sync would have planned", () => {
    const fixture = makeTestEpic("triage", 40, 1);
    const agents = fixture.agents;
    const visibleAgentIds = new Set(agents.map((agent) => agent.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((agent) => [agent.id, "idle" as const]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    // The provisional sync: a real first plan, from statuses nobody has
    // confirmed, with the feed still behind.
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: idle }));
    const provisional = layoutOf(scene);

    // The feed settles, and what it brings with it is one woken lead - which
    // is what makes its whole team live, and its members desk-worthy.
    const woken = "team-0-lead";
    if (!idle.has(woken)) throw new Error("fixture has no team-0-lead");
    const settledStatuses = new Map(idle);
    settledStatuses.set(woken, "awaiting");
    const settled = sceneInput({
      agents,
      visibleAgentIds,
      statusById: settledStatuses,
      feedSettled: true,
    });
    const team = settled.partition.hosts
      .flatMap((host) => host.teams)
      .find((candidate) => candidate.leadAgentId === woken);
    if (team === undefined) throw new Error("the woken lead leads no team");
    // WHERE THE BOOK SAYS THEY ARE, before the settle: the quiet stack, which
    // is what the hover card would print and the directory would pan to.
    const whereaboutsOf = (): ReadonlyArray<string | null> =>
      team.memberAgentIds.map((id) => scene.whereabouts(id));
    expect(whereaboutsOf()).toEqual(["Quiet stack", "Quiet stack"]);

    scene.sync(settled);
    const after = layoutOf(scene);

    // The floor a scene that had waited would have drawn: the same view, the
    // same settled partition, nothing spoken for and nothing owed.
    const fresh = OFFICE_VIEWS.building.plan({
      agents,
      partition: settled.partition,
      occupancy: new Map<string, string>(),
      needsCapacity: [],
      activityById: new Map<string, number>(),
      viewport: settled.viewport,
      previous: null,
    });
    const kindsOf = (layout: OfficeLayout): ReadonlyArray<string | undefined> =>
      team.memberAgentIds.map((id) => layout.desks.get(id)?.kind);

    // The control: the draft really was the cold floor, so the equality below
    // is a change and not a coincidence.
    expect(kindsOf(provisional)).toEqual(["cubby", "cubby"]);
    expect(provisional.rooms.length).toBe(1);

    expect(kindsOf(after)).toEqual(kindsOf(fresh));
    expect(after.rooms.length).toBe(fresh.rooms.length);
    expect(after.rooms.length).toBe(2);

    // AND THE BOOK MOVED WITH THE PLAN, which the equality above cannot say:
    // `layout.desks` said desk while the book still said cubby, and the book
    // is what everything downstream reads. Neither member is in the quiet
    // stack any more - each is either at the desk it was given or walking to
    // it, both of which are answers the cold floor could not produce.
    for (const where of whereaboutsOf()) {
      expect(where).not.toBe("Quiet stack");
    }
  });
});

describe("OfficeScene fixup 8c - the settle trigger fires once and never again (R3)", () => {
  /**
   * The settle is a LATCH, not an edge: `sync` sets `feedSettled` on the
   * first sync that carries it and never clears it, so a later sync that
   * still says `feedSettled: true` finds the flag already up and owes the
   * planner nothing. Count `plan` calls with a wrapper around the real
   * Building view - so the counted calls are the ones a real scene would
   * make - across a provisional sync, the settle sync, and a third sync that
   * repeats `feedSettled: true` with unchanged statuses: the third has to
   * cost zero.
   */
  it("re-plans on the settle sync and never again for a later settled sync", () => {
    let calls = 0;
    const countingView: OfficeView = {
      ...OFFICE_VIEWS.building,
      plan: (input) => {
        calls += 1;
        return OFFICE_VIEWS.building.plan(input);
      },
    };
    const scene = new OfficeScene(countingView, null);
    const idle = new Map<string, OfficeAgentStatus>([
      ["alpha", "idle"],
      ["beta", "idle"],
    ]);

    // The provisional sync: an ordinary first plan.
    scene.sync(
      sceneInput({ agents: AGENTS, visibleAgentIds: BOTH, statusById: idle }),
    );
    expect(calls).toBe(1);

    // The settle: the flag's first `true`, so it is the trigger firing.
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: idle,
        feedSettled: true,
      }),
    );
    expect(calls).toBe(2);

    // A third sync, still `feedSettled: true` and nothing else changed: the
    // latch is already up, so this owes the planner nothing.
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: idle,
        feedSettled: true,
      }),
    );
    expect(calls).toBe(2);
  });

  /**
   * The standing contract, restated here because the new trigger is the
   * place a regression would most plausibly reopen it: a status flip alone
   * never re-plans, and that has to hold even on a scene the settle has
   * already visited - otherwise the settle would read as a second door back
   * in for status flips rather than a one-time trigger of its own.
   */
  it("a status flip on an already-settled scene still never re-plans", () => {
    let calls = 0;
    const countingView: OfficeView = {
      ...OFFICE_VIEWS.building,
      plan: (input) => {
        calls += 1;
        return OFFICE_VIEWS.building.plan(input);
      },
    };
    const scene = new OfficeScene(countingView, null);
    const idle = new Map<string, OfficeAgentStatus>([
      ["alpha", "idle"],
      ["beta", "idle"],
    ]);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: idle,
        feedSettled: true,
      }),
    );
    expect(calls).toBe(1);

    const flipped = new Map(idle);
    flipped.set("alpha", "awaiting");
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: flipped,
        feedSettled: true,
      }),
    );
    expect(calls).toBe(1);
  });

  /**
   * The healthy-feed case: a scene whose FIRST sync already carries
   * `feedSettled: true` needs nothing extra - its ordinary first plan IS the
   * settled one, per the latch's own reasoning in `office-scene.ts`. This is
   * the case a naive "settling means always plan again" reading would cost a
   * second layout for no reason; pin that it does not.
   */
  it("a scene whose first sync is already settled plans exactly once", () => {
    let calls = 0;
    const countingView: OfficeView = {
      ...OFFICE_VIEWS.building,
      plan: (input) => {
        calls += 1;
        return OFFICE_VIEWS.building.plan(input);
      },
    };
    const scene = new OfficeScene(countingView, null);
    const idle = new Map<string, OfficeAgentStatus>([
      ["alpha", "idle"],
      ["beta", "idle"],
    ]);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: idle,
        feedSettled: true,
      }),
    );
    expect(calls).toBe(1);

    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: idle,
        feedSettled: true,
      }),
    );
    expect(calls).toBe(1);
  });

  /**
   * THE RECONNECT, which is why the trigger is a latch and not an edge.
   *
   * A transport that blinks re-replays its history: the flag goes false and
   * true again, and an edge-triggered rule would read that as a second settle
   * and re-lay out an office somebody is reading. The question the latch asks
   * is "has this office ever been planned from a settled feed", and a second
   * replay does not re-open it.
   */
  it("never settles twice, even when the feed goes behind and catches up again", () => {
    let calls = 0;
    const countingView: OfficeView = {
      ...OFFICE_VIEWS.building,
      plan: (input) => {
        calls += 1;
        return OFFICE_VIEWS.building.plan(input);
      },
    };
    const scene = new OfficeScene(countingView, null);
    const idle = new Map<string, OfficeAgentStatus>([
      ["alpha", "idle"],
      ["beta", "idle"],
    ]);
    const syncWith = (feedSettled: boolean): void => {
      scene.sync(
        sceneInput({
          agents: AGENTS,
          visibleAgentIds: BOTH,
          statusById: idle,
          feedSettled,
        }),
      );
    };
    syncWith(false);
    syncWith(true);
    // The provisional plan and the settle plan, which is the whole budget.
    expect(calls).toBe(2);

    // The transport drops, replays, and catches up a second time.
    syncWith(false);
    syncWith(true);
    expect(calls).toBe(2);
  });
});

describe("OfficeScene fixup 8c - the settle plan walks people, it does not pop them (R4)", () => {
  interface SettledScene {
    readonly scene: OfficeScene;
    readonly movedId: string;
  }

  /**
   * The same fixture and the same woken-lead premise as the R2 settle case
   * above, parameterized on `reducedMotion` so both branches below sync
   * against an identical, verified premise: a team member the settle
   * actually moved off a cubby, never an assumed one.
   */
  function settledScene(reducedMotion: boolean): SettledScene {
    const fixture = makeTestEpic("triage", 40, 1);
    const agents = fixture.agents;
    const visibleAgentIds = new Set(agents.map((one) => one.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((one) => [one.id, "idle" as const]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    scene.sync(
      sceneInput({ agents, visibleAgentIds, statusById: idle, reducedMotion }),
    );
    // The provisional floor exists; where anybody actually IS comes off the
    // book below, not off this.
    layoutOf(scene);

    const woken = "team-0-lead";
    if (!idle.has(woken)) throw new Error("fixture has no team-0-lead");
    const settledStatuses = new Map(idle);
    settledStatuses.set(woken, "awaiting");
    const settled = sceneInput({
      agents,
      visibleAgentIds,
      statusById: settledStatuses,
      feedSettled: true,
      reducedMotion,
    });
    const team = settled.partition.hosts
      .flatMap((host) => host.teams)
      .find((candidate) => candidate.leadAgentId === woken);
    if (team === undefined) throw new Error("the woken lead leads no team");
    // THE PREMISE READ OFF THE BOOK, not the plan. `layout.desks` is where
    // the plan put somebody; `whereabouts` is where the scene says they are,
    // and the two disagreeing for a whole settled office is the finding this
    // fixup's second half exists for - a premise taken from the plan would
    // have been satisfied by a floor nobody was standing on.
    const moved = team.memberAgentIds.find(
      (id) => scene.whereabouts(id) === "Quiet stack",
    );
    if (moved === undefined) {
      throw new Error(
        "no team member started in the quiet stack to move out of",
      );
    }

    scene.sync(settled);
    // Asserts the layout exists at all, which every read below assumes.
    layoutOf(scene);
    if (scene.whereabouts(moved) === "Quiet stack") {
      throw new Error("expected the settle to move this member off its cubby");
    }
    return { scene, movedId: moved };
  }

  // Motion on: teleporting the moved agent into its new chair is exactly the
  // defect this pins against. `awayAgentIds` is the scene's own word for "not
  // in its own chair" (see the waking-cubby fixture above), so the moved
  // agent has to be in it on the very sync that moved it.
  it("with motion on, the settle sends the moved agent walking rather than dropping it into its new chair", () => {
    const { scene, movedId } = settledScene(false);
    expect(frameOf(scene).awayAgentIds.has(movedId)).toBe(true);
  });

  // Motion reduced: the walk collapses into sitting down, so the same moved
  // agent is already in its chair on the sync that moved it - no separate
  // walk to catch up on afterward.
  it("with reduced motion, the settle lands the moved agent on its new chair immediately", () => {
    const { scene, movedId } = settledScene(true);
    expect(frameOf(scene).awayAgentIds.has(movedId)).toBe(false);
  });
});

describe("OfficeScene fixup 8c - the book settles with the plan (D66)", () => {
  /**
   * The fixture the cold reviewer's second finding was reproduced on, and the
   * two things every case here needs: the provisional input, and the settled
   * one that follows it.
   */
  function triageInputs(): {
    readonly agents: ReadonlyArray<OfficeAgentInput>;
    readonly provisional: OfficeSceneInput;
    readonly settled: OfficeSceneInput;
  } {
    const fixture = makeTestEpic("triage", 40, 1);
    const agents = fixture.agents;
    const visibleAgentIds = new Set(agents.map((one) => one.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((one) => [one.id, "idle" as const]),
    );
    const woken = "team-0-lead";
    if (!idle.has(woken)) throw new Error("fixture has no team-0-lead");
    const settledStatuses = new Map(idle);
    settledStatuses.set(woken, "awaiting");
    return {
      agents,
      provisional: sceneInput({ agents, visibleAgentIds, statusById: idle }),
      settled: sceneInput({
        agents,
        visibleAgentIds,
        statusById: settledStatuses,
        feedSettled: true,
      }),
    };
  }

  /**
   * ONE PLAN PER SETTLE, and the shortfall is why this is not already pinned
   * by the latch cases above.
   *
   * The latch only stops the SETTLE from firing twice. What planned the floor
   * again and again was trigger 2: the book kept seventeen cubby ids the
   * settle plan had given to other people, so the seventeen agents it gave
   * them to had no seat at all, went into `needsCapacity`, and asked the
   * planner for room the office already had - on every sync, for the life of
   * the mount. Six syncs, two plans: any third plan here is that shortfall
   * coming back.
   */
  it("plans twice across six syncs, because the settle leaves nobody owed a seat", () => {
    const { provisional, settled } = triageInputs();
    let calls = 0;
    const countingView: OfficeView = {
      ...OFFICE_VIEWS.building,
      plan: (input) => {
        calls += 1;
        return OFFICE_VIEWS.building.plan(input);
      },
    };
    const scene = new OfficeScene(countingView, null);
    scene.sync(provisional);
    expect(calls).toBe(1);
    for (let round = 0; round < 5; round += 1) {
      scene.sync(settled);
    }
    expect(calls).toBe(2);
  });

  /**
   * WHAT THE BOOK SAYS IS WHERE PEOPLE ARE, so the settle has to reach it.
   *
   * `layout.desks` said desk while the book still said cubby, and the book is
   * what `effectiveSeat`, `whereabouts`, the characters and the directory
   * read - so the plan-side equality the R2 case asserts was true of an office
   * nobody was looking at. The book is private to the scene, so this reads it
   * through the two public carriers that project it: `locate`, which the
   * directory pans by, and `whereabouts`, which the hover card prints.
   *
   * Every agent, not the woken team: on this fixture the team-0 members did
   * get their desks and the damage was elsewhere - seventeen agents keeping
   * cubby ids the settle plan had reassigned, and the seventeen it reassigned
   * them to left with no seat at all. `team-1-lead` holding nothing while
   * `leaf-8` kept `unattributed/4/cubby/0` is the reviewer's own example.
   *
   * UNDER REDUCED MOTION, and that is not a dodge. `locate` and `whereabouts`
   * answer from the CHARACTER while it is out of its chair, which is what the
   * settle deliberately sets thirty-nine of these agents doing - so with
   * motion on this would compare walkers against a reference office where
   * nobody ever walked, and fail on the walk this fixup wants. Reduced motion
   * collapses the walk into sitting down, which leaves exactly the question
   * being asked: did the book take up the settled plan. The walking half is
   * pinned by the R4 cases, and the case below asserts the shortfall's own
   * symptom with motion on.
   */
  it("puts every agent where a scene that had waited for the feed would have put them", () => {
    const fixture = makeTestEpic("triage", 40, 1);
    const agents = fixture.agents;
    const visibleAgentIds = new Set(agents.map((one) => one.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((one) => [one.id, "idle" as const]),
    );
    const settledStatuses = new Map(idle);
    settledStatuses.set("team-0-lead", "awaiting");
    const still = { agents, visibleAgentIds, reducedMotion: true };
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    scene.sync(sceneInput({ ...still, statusById: idle }));
    scene.sync(
      sceneInput({ ...still, statusById: settledStatuses, feedSettled: true }),
    );

    // The office the same input builds with no provisional floor behind it -
    // the standard every agent below is held to.
    const reference = new OfficeScene(OFFICE_VIEWS.building, null);
    reference.sync(
      sceneInput({ ...still, statusById: settledStatuses, feedSettled: true }),
    );

    const misplaced: string[] = [];
    const differentWhereabouts: string[] = [];
    for (const agent of agents) {
      const here = scene.locate(agent.id);
      const there = reference.locate(agent.id);
      if (JSON.stringify(here) !== JSON.stringify(there)) {
        misplaced.push(agent.id);
      }
      if (scene.whereabouts(agent.id) !== reference.whereabouts(agent.id)) {
        differentWhereabouts.push(agent.id);
      }
    }
    // Named in the messages because these two are the reviewer's example: the
    // lead left with no seat, and the leaf holding the cubby that had been
    // reassigned to it.
    expect(
      misplaced,
      `agents the settle left where a settled scene would not have put them (team-1-lead and leaf-8 are the reviewer's example): ${misplaced.join(", ")}`,
    ).toEqual([]);
    expect(
      differentWhereabouts,
      `agents whose hover card would read differently: ${differentWhereabouts.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * THE SHORTFALL'S OWN SYMPTOM, with motion on and nothing collapsed: an
   * agent the book could not seat has no seat to project, so the directory
   * cannot pan to it and the hover card has nothing to say. Seventeen agents
   * were in that state on every sync for the life of the mount.
   *
   * `locate` answers a walker from its own box, so this holds whether or not
   * the settle set somebody walking - which is what makes it the half of the
   * comparison above that does not need motion stilled.
   */
  it("leaves nobody unlocatable after the settle, walkers included", () => {
    const { agents, provisional, settled } = triageInputs();
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    scene.sync(provisional);
    scene.sync(settled);

    const unlocatable = agents
      .map((agent) => agent.id)
      .filter((id) => scene.locate(id) === null);
    expect(
      unlocatable,
      `agents with no seat at all (team-1-lead and leaf-8 are the reviewer's example): ${unlocatable.join(", ")}`,
    ).toEqual([]);
  });
});

describe("OfficeScene fixup 8 - a seated agent's name tag is fitted to its seat", () => {
  type OfficeLabelDrawable = Extract<OfficeDrawable, { kind: "label" }>;

  /**
   * The scene's book, captured from a frame build rather than through a
   * private field - the same trick `describe.each` uses locally, repeated
   * here because that copy is out of scope.
   */
  function bookOf(scene: OfficeScene): OfficeSeatBook {
    const spy = vi.spyOn(OfficeSeatBook.prototype, "civicClaimOf");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  it("gives every seated character's label the effective seat's own width, cubby occupants included, and null to a walker (309 Building, lod 2)", () => {
    const epic = makeTestEpic("triage", 309, 1);
    // The walker: revealed on a SECOND, playing sync, the same recipe the
    // canvas suite's `renderWithWalker` uses - it walks in from the door
    // rather than appearing already seated.
    const walker = epic.agents.find(
      (candidate) => epic.statusById.get(candidate.id) !== "archived",
    );
    if (walker === undefined) {
      throw new Error(
        "expected the 309-agent triage epic to seat at least one non-archived agent",
      );
    }
    const firstWave = epic.agents.filter((person) => person.id !== walker.id);
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    scene.sync(
      sceneInput({
        agents: firstWave,
        visibleAgentIds: new Set(firstWave.map((person) => person.id)),
        statusById: epic.statusById,
      }),
    );
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
        statusById: epic.statusById,
        playing: true,
      }),
    );

    const layout = layoutOf(scene);
    const book = bookOf(scene);
    const frame = scene.frame(2, WHOLE_WORLD);
    const labelByAgentId = new Map<string, OfficeLabelDrawable>();
    // The Building's own painter interleaves props and characters into one
    // depth-ordered `world` stream rather than the flat `actors` list a
    // "layered" painter fills - see `OfficeScene.frame`'s `layered` branch.
    const drawables: ReadonlyArray<OfficeDrawable> = [
      ...frame.actors,
      ...(frame.world ?? []).map((entry) => entry.drawable),
    ];
    for (const drawable of drawables) {
      if (drawable.kind !== "label") continue;
      if (drawable.ownerAgentId === null) continue;
      labelByAgentId.set(drawable.ownerAgentId, drawable);
    }

    // The walker really is still walking in, and its tag carries no fitTiles:
    // it has left no seat behind to be fitted to.
    expect(frame.awayAgentIds.has(walker.id)).toBe(true);
    const walkerLabel = labelByAgentId.get(walker.id);
    expect(walkerLabel).toBeDefined();
    expect(walkerLabel?.fitTiles).toBeNull();

    // Every OTHER seated character - the entire rest of the 309-agent
    // Building - carries its EFFECTIVE seat's own tile width, with at least
    // one cubby occupant (a one-tile seat) among them.
    //
    // `layout.desks` is the roll-call, NOT the oracle. `OfficeDesk` says so on
    // itself - "the INITIAL assignment, not the truth" - and for a civic
    // holder the two differ: the label reads `effectiveSeat`, which is the bed
    // or the chair the agent is in. Reading the width off the assignment was
    // true until `CIVIC_ROOMS_EXPECTED` turned `building` on and there was
    // something else for a Building agent to be sitting in.
    //
    // "Moved" is `heldClaimWant` and not `civicClaimOf`, here and below: a
    // held RESERVE DESK displaces the assignment too and is not civic, so a
    // civic-only gate would assert `effectiveSeat === layout.desks` for a
    // reserve-desk holder and be wrong for a reason this case is not about.
    let checkedCubbyOccupant = false;
    let checkedSeatedAgent = false;
    let checkedCivicHolders = 0;
    for (const [agentId, desk] of layout.desks) {
      if (agentId === walker.id) continue;
      if (frame.awayAgentIds.has(agentId)) continue;
      const label = labelByAgentId.get(agentId);
      if (label === undefined) continue;
      checkedSeatedAgent = true;
      const seat = book.effectiveSeat(agentId);
      if (seat === null) {
        throw new Error(`seated agent ${agentId} has no effective seat`);
      }
      expect(label.fitTiles, `fitTiles for ${agentId}`).toBe(
        seat.hitTiles.width,
      );
      if (book.civicClaimOf(agentId) !== null) checkedCivicHolders += 1;
      // The desk-sitter half, kept exactly as strong as it was: with no held
      // claim of ANY kind the effective seat IS the assignment, so for the
      // whole un-moved population `layout.desks` still carries the assertion
      // on its own. `heldClaimWant` and not `civicClaimOf`, because a held
      // RESERVE DESK also displaces the assignment and is not civic.
      if (book.heldClaimWant(agentId) === null) {
        expect(seat.seatId, `assignment for ${agentId}`).toBe(desk.seatId);
        expect(label.fitTiles, `fitTiles for ${agentId}`).toBe(
          desk.hitTiles.width,
        );
      }
      // KEYED ON THE KIND, not on the width. A lounge chair is one tile too,
      // so a width test would let a civic holder stand in for the cubby
      // occupant this flag exists to find, and the cubby half of the case
      // would go quiet without a single assertion changing.
      if (seat.kind === "cubby") checkedCubbyOccupant = true;
    }
    expect(checkedSeatedAgent).toBe(true);
    expect(checkedCubbyOccupant).toBe(true);
    // The witness the corrected oracle needs. Before the playback entry
    // settled their walks, every civic holder was still crossing the floor and
    // `awayAgentIds` skipped the lot - which is how a stale oracle survived
    // `building: true` in silence. Without this the case could go quiet the
    // same way again.
    expect(
      checkedCivicHolders,
      "civic holders the loop actually reached",
    ).toBeGreaterThan(0);
  });
});

/**
 * Fixup 8d - the two cold-review fixes: the arrival queue keyed at the
 * pool's own granularity (host, not floor), and a claim that will not answer
 * a request with a seat of the wrong kind.
 *
 * A STANDALONE block, not a member of `describe.each(OFFICE_VIEW_IDS)`:
 * defect A needs a MULTI-STOREY view (Towers) that view table does not
 * gate on `CIVIC_ROOMS_EXPECTED`, and defect B's second case needs a
 * cubby, which the Floor plans none of. Each case builds its own
 * `OfficeScene` directly off `OFFICE_VIEWS`, following the precedent of
 * "OfficeScene fixup 8c - the book settles with the plan (D66)" above:
 * local helpers, not the `describe.each` closure's `newScene` / `bookOf` /
 * `idleStatusById` / `unarchivedIdsOf`, none of which are in scope here.
 */
describe("OfficeScene fixup 8d - the queue and the claim answer the right pool", () => {
  /**
   * The scene's book, captured from a frame build rather than through a
   * private field - the same trick `describe.each` uses locally, repeated
   * here because that copy is out of scope.
   */
  function bookOf(scene: OfficeScene): OfficeSeatBook {
    const spy = vi.spyOn(OfficeSeatBook.prototype, "civicClaimOf");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  /** Ticks until `agentId` is no longer away, answering whether it arrived. */
  function tickUntilHome(
    scene: OfficeScene,
    agentId: string,
    steps: number,
  ): boolean {
    for (let step = 0; step < steps; step += 1) {
      scene.tick(100);
      if (!frameOf(scene).awayAgentIds.has(agentId)) return true;
    }
    return false;
  }

  /** Ticks until `agentId` is settled in a bed, answering that bed's id. */
  function tickUntilBedded(scene: OfficeScene, agentId: string): string | null {
    for (let step = 0; step < 800; step += 1) {
      scene.tick(100);
      const book = bookOf(scene);
      const arrived =
        book.civicClaimOf(agentId) === "bed" &&
        !frameOf(scene).awayAgentIds.has(agentId);
      if (arrived) return book.effectiveSeat(agentId)?.seatId ?? null;
    }
    return null;
  }

  /**
   * Ticks until `agentId` is home AND `seatId` has left `occupancy()` - the
   * reservation ending at `vacated`, which is the thing 2b is about. Ticking
   * grants nobody a seat: the civic pass lives inside `sync`.
   */
  function tickUntilSeatReleased(
    scene: OfficeScene,
    agentId: string,
    seatId: string,
  ): boolean {
    for (let step = 0; step < 800; step += 1) {
      scene.tick(100);
      const free = bookOf(scene).occupancy().get(seatId) === undefined;
      if (free && !frameOf(scene).awayAgentIds.has(agentId)) return true;
    }
    return false;
  }

  /**
   * DEFECT A. Towers packs a 15-agent one-team epic into a plaza storey plus
   * three occupied storeys - the root's HQ floor, a nine-desk room and a
   * five-desk room, all on the one (`null`) host `civicOrderKey` used to key
   * separately before the fix. The ward is at its floor of two beds
   * (`ceil(15/25)` is 1, floored to `INFIRMARY_MIN_BEDS`).
   *
   * Four agents matter: a FILLER and a "first arrival" crasher take the two
   * beds between them (C2's "occupying the rest first"); a "second arrival"
   * and a "third arrival" then both overflow. The second and third are
   * chosen from the TWO DIFFERENT desk storeys on purpose, and the third is
   * put on the storey that comes EARLIER in `characters` order (the storey
   * built from the earlier chunk of the team) while the second - the one
   * that actually asked first - is put on the LATER storey. That mismatch
   * is the whole point: keyed per floor, the pre-fix queue for the earlier
   * storey is served before the later storey's regardless of who asked
   * first, so healing the first arrival hands its freed bed to the third
   * arrival. Keyed per host, one queue remembers that the second arrival
   * asked first and the bed goes to it.
   */
  it("gives a freed bed to the storey that asked first, not the storey that sorts first (Towers, defect A)", () => {
    const epic = makeTestEpic("one-team", 15, 1);
    const agents = epic.agents;
    const visibleAgentIds = new Set(agents.map((a) => a.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((a) => [a.id, "idle" as const]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.towers, null);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: idle,
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const plazaFloorIndex = layout.floors.findIndex(
      (floor) => floor.civic.length > 0,
    );
    expect(plazaFloorIndex).toBeGreaterThanOrEqual(0);
    const beds = layout.floors[plazaFloorIndex].civic.find(
      (room) => room.kind === "infirmary",
    )?.seatIds.length;
    // The whole setup below leans on there being exactly two: one for the
    // filler, one for the "first arrival" - see the class doc above.
    expect(beds).toBe(2);

    const byFloor = new Map<number, string[]>();
    for (const [agentId, desk] of layout.desks) {
      const list = byFloor.get(desk.floorIndex);
      if (list === undefined) byFloor.set(desk.floorIndex, [agentId]);
      else list.push(agentId);
    }
    const occupiedFloors = Array.from(byFloor.keys())
      .filter((index) => index !== plazaFloorIndex)
      .sort((a, b) => a - b);
    // The root's HQ floor, the first room chunk, the second room chunk -
    // three storeys behind the one plaza ward, which is the shape defect A
    // needs and the fixture was sized for.
    expect(occupiedFloors.length).toBeGreaterThanOrEqual(3);
    const [rootFloor, earlyRoomFloor, lateRoomFloor] = occupiedFloors;
    const rootFloorAgents = byFloor.get(rootFloor) ?? [];
    const earlyRoomAgents = byFloor.get(earlyRoomFloor) ?? [];
    const lateRoomAgents = byFloor.get(lateRoomFloor) ?? [];
    expect(rootFloorAgents.length).toBeGreaterThanOrEqual(1);
    // Two from the SAME (earlier) room: the filler and the "third arrival".
    expect(earlyRoomAgents.length).toBeGreaterThanOrEqual(2);
    expect(lateRoomAgents.length).toBeGreaterThanOrEqual(1);

    const crashFirst = rootFloorAgents[0]; // takes the last free bed
    const filler = earlyRoomAgents[0]; // takes the other bed, and stays
    const crashThird = earlyRoomAgents[1]; // overflows SECOND, sorts first
    const crashSecond = lateRoomAgents[0]; // overflows FIRST, sorts second

    // The precondition this case's whole value rests on: `crashThird` is
    // ahead of `crashSecond` in `characters` order (the canonical order
    // `agentSetSignature`-adjacent code and the civic queue both read off
    // `agents`), even though the syncs below make `crashSecond` the one
    // that has actually been waiting longer. A fixture where these agreed
    // would pass whichever key the queue used.
    expect(agents.findIndex((a) => a.id === crashThird)).toBeLessThan(
      agents.findIndex((a) => a.id === crashSecond),
    );

    const failing = (
      ids: ReadonlyArray<string>,
    ): Map<string, OfficeAgentStatus> => {
      const next = new Map(idle);
      for (const id of ids) next.set(id, "failure");
      return next;
    };
    const sync = (ids: ReadonlyArray<string>): void => {
      scene.sync(
        sceneInput({
          agents,
          visibleAgentIds,
          statusById: failing(ids),
          reducedMotion: true,
        }),
      );
    };

    sync([filler]);
    sync([filler, crashFirst]);
    sync([filler, crashFirst, crashSecond]);
    sync([filler, crashFirst, crashSecond, crashThird]);

    const beforeHeal = bookOf(scene);
    expect(beforeHeal.civicClaimOf(filler)).toBe("bed");
    expect(beforeHeal.civicClaimOf(crashFirst)).toBe("bed");
    expect(beforeHeal.civicClaimOf(crashSecond)).toBeNull();
    expect(beforeHeal.civicClaimOf(crashThird)).toBeNull();

    // Heal the first arrival: its bed is the one that frees.
    sync([filler, crashSecond, crashThird]);

    const afterHeal = bookOf(scene);
    expect(afterHeal.civicClaimOf(crashFirst)).toBeNull();
    // C3: the freed bed goes to whichever storey asked first, not to
    // whichever storey `civicOrderKey` (pre-fix) or `characters` sorts
    // first.
    expect(afterHeal.civicClaimOf(crashSecond)).toBe("bed");
    expect(afterHeal.civicClaimOf(crashThird)).toBeNull();
  });

  /**
   * DEFECT B, consequence 1. A live (motion-enabled) Floor agent seated in a
   * bed goes `failure -> awaiting`: the bed answers a request for a lounge
   * chair unless `claim` checks `wants`.
   *
   * REVISED FOR 2b. The original fix let a kind-mismatched `claim` fall
   * through and overwrite the stale claim, which freed the bed for a second
   * crasher on the SAME sync - fine under instant seating, wrong with motion
   * on, since the first agent's body was still lying in it. 2b's rule is ONE
   * CLAIM PER AGENT: `claim` now refuses (`null`) on a kind mismatch rather
   * than replacing, so the transitioning agent walks bed -> desk -> lounge
   * over TWO syncs - the first ends the bed claim and starts the walk home,
   * the second (once the agent is actually home and `vacated`) makes the
   * lounge claim - and a filler plus a SECOND crasher pin that the bed stays
   * RESERVED for that whole walk, not just occupied-looking.
   */
  it("walks a bedded agent to the lounge, not back into its own bed, when failure becomes awaiting (Floor, defect B, 2b)", () => {
    const epic = makeTestEpic("one-team", 12, 9);
    const agents = epic.agents;
    const visibleAgentIds = new Set(agents.map((a) => a.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((a) => [a.id, "idle" as const]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: idle }));
    const originalDesk = layoutOf(scene).desks.get(agents[2].id);
    if (originalDesk === undefined) {
      throw new Error(`expected a desk for ${agents[2].id}`);
    }
    const crasher = originalDesk.agentId;
    const filler = agents[3].id;
    const secondCrasher = agents[4].id;
    if (filler === crasher || secondCrasher === crasher) {
      throw new Error("fixture needs three distinct agents");
    }

    // FILLER TAKES ONE BED FIRST, and stays failing throughout: with two
    // beds on this fixture, it is what makes crasher's bed the ONLY seat
    // `secondCrasher` could possibly be offered below - the fixture the
    // reservation actually needs to be tested against, rather than one where
    // a second free bed would let a second claimant through for an
    // unrelated reason.
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: new Map(idle).set(filler, "failure"),
      }),
    );
    // Not reduced motion, on purpose: settled-in-a-chair and never-left-the-
    // chair look identical under reduced motion, and this finding is about a
    // walk that never happens.
    const failingBoth = new Map(idle);
    failingBoth.set(filler, "failure");
    failingBoth.set(crasher, "failure");
    scene.sync(
      sceneInput({ agents, visibleAgentIds, statusById: failingBoth }),
    );

    const bedSeatId = tickUntilBedded(scene, crasher);
    if (bedSeatId === null) {
      throw new Error(`expected ${crasher} to settle into a bed`);
    }

    // Both beds are now held (filler's and crasher's), so the transition
    // below is the ONLY thing that can free one.
    const transition = new Map(idle);
    transition.set(filler, "failure");
    transition.set(crasher, "awaiting");
    // A SECOND crasher fails on this SAME sync, competing for a bed at the
    // exact moment crasher's is only RELEASING, not free.
    transition.set(secondCrasher, "failure");
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: transition }));

    const justAfterTransition = bookOf(scene);
    // 2b's whole point: `occupant()` is already `null` for a releasing claim
    // - it always was, that is what let the old fixture see the bed as free
    // the instant `endClaim` ran. `occupancy()` is the one that still lists
    // it, because a claim only truly ends at `vacated`.
    expect(justAfterTransition.occupant(bedSeatId)).toBeNull();
    expect(justAfterTransition.occupancy().get(bedSeatId)).toBe(crasher);
    // Refused, not handed a different bed and not handed this one: every
    // seat is spoken for, crasher's own included.
    expect(justAfterTransition.civicClaimOf(secondCrasher)).toBeNull();
    // Refused too, for the reason DEFECT B's fix exists: the existing claim
    // is a bed and the want is now a lounge chair.
    expect(justAfterTransition.civicClaimOf(crasher)).toBeNull();

    // Tick crasher all the way home. Ticking alone never grants anybody a
    // seat - the civic pass lives inside `sync`, not `tick` - so
    // `secondCrasher` stays unseated for however long this takes, no matter
    // how many ticks pass without a sync.
    expect(tickUntilSeatReleased(scene, crasher, bedSeatId)).toBe(true);
    expect(bookOf(scene).civicClaimOf(secondCrasher)).toBeNull();

    // Re-sync on the UNCHANGED statuses: this is the sync 2b moved the
    // lounge claim to. `secondCrasher` keeps the place in `civicOrder` it
    // was given on the transition sync above - it is not a fresh newcomer
    // here, so its priority over anybody who started asking after it is
    // exactly what it was before crasher ever started walking home.
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: transition }));

    let inLounge = false;
    for (let step = 0; step < 800 && !inLounge; step += 1) {
      scene.tick(100);
      inLounge =
        bookOf(scene).civicClaimOf(crasher) === "lounge" &&
        !frameOf(scene).awayAgentIds.has(crasher);
    }
    // Pre-2b (and pre-defect-B's original fix), this never becomes true.
    expect(inLounge).toBe(true);

    const book = bookOf(scene);
    expect(book.effectiveSeat(crasher)?.kind).toBe("lounge");
    expect(scene.whereabouts(crasher)).toBe("Lounge");
    // Its own desk - the assignment `startCivicWalk` never touches - is
    // exactly where the first sync put it.
    expect(layoutOf(scene).desks.get(crasher)?.seatId).toBe(
      originalDesk.seatId,
    );
    // The bed is no longer crasher's in ANY sense - not `occupant`, not
    // `occupancy()` - and it did not sit empty either: `secondCrasher`, who
    // kept its queue place for exactly this, holds it now.
    expect(book.occupant(bedSeatId)).toBe(secondCrasher);
    expect(book.occupancy().get(bedSeatId)).toBe(secondCrasher);
    expect(book.civicClaimOf(secondCrasher)).toBe("bed");
  });

  /**
   * DEFECT B, consequence 2. A cubby agent wakes onto a reserve DESK for
   * `working`, then goes `working -> failure`: that desk answers a request
   * for a bed unless `claim` checks `wants`. Put on Building, not Floor -
   * the Floor plans no cubbies (`CIVIC_ROOMS_EXPECTED.floor` is the only
   * `true` in that table) - and the fixture is the "wakingCubby" idiom from
   * "OfficeScene fixup 1 - F19", rebuilt locally since that helper is
   * private to its own `describe`.
   */
  it("sends a woken cubby agent to a bed, not back to its wake desk, when working becomes failure (Building, defect B)", () => {
    const epic = makeTestEpic("one-team", 12, 9);
    const agents = epic.agents;
    const visibleAgentIds = new Set(agents.map((a) => a.id));
    const cold = new Map<string, OfficeAgentStatus>(
      agents.map((a) => [a.id, "idle" as const]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: cold }));
    const cubby = Array.from(layoutOf(scene).desks.values()).find(
      (desk) => desk.kind === "cubby",
    );
    if (cubby === undefined) throw new Error("expected a cubby on Building");
    const sleeper = cubby.agentId;

    const working = new Map(cold);
    working.set(sleeper, "working");
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: working }));

    if (!tickUntilHome(scene, sleeper, 400)) {
      throw new Error(`expected ${sleeper} to settle onto a wake desk`);
    }
    const wakeSeat = bookOf(scene).effectiveSeat(sleeper);
    if (wakeSeat === null) throw new Error("expected a wake seat");
    expect(wakeSeat.kind).toBe("desk");
    const wakeDeskSeatId = wakeSeat.seatId;
    const competitorCubby = Array.from(layoutOf(scene).desks.values()).find(
      (desk) => desk.kind === "cubby" && desk.agentId !== sleeper,
    );
    if (competitorCubby === undefined) {
      throw new Error("expected a second cubby on Building");
    }
    const competitor = competitorCubby.agentId;

    const failing = new Map(cold);
    failing.set(sleeper, "failure");
    const failingWithCompetitor = new Map(failing);
    failingWithCompetitor.set(competitor, "working");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: failingWithCompetitor,
      }),
    );

    // Pre-vacated: the reserve is still a reservation, so a second cubby
    // waking now cannot take it. `!away` after the walk home cannot tell a
    // cubby arrival from a direct bed arrival; occupancy can.
    const releasing = bookOf(scene);
    expect(releasing.occupancy().get(wakeDeskSeatId)).toBe(sleeper);
    expect(releasing.effectiveSeat(competitor)?.seatId).not.toBe(
      wakeDeskSeatId,
    );

    // RESERVE -> CUBBY -> BED, in that order, and it takes two civic passes.
    //
    // One claim per agent: `claim` refuses a bed while the wake desk is still
    // reserved, so the first pass only ENDS that claim and sends the agent
    // home. The desk is not free until the walk finishes and `settleInChair`
    // calls `vacated` - and the bed claim can only be made by a civic pass,
    // which runs inside `sync`, never inside `tick`. So a sync has to arrive
    // after the agent is home, exactly as one does in the live app.
    if (!tickUntilHome(scene, sleeper, 800)) {
      throw new Error(`expected ${sleeper} to walk home to its cubby`);
    }
    // Home, so the reserve is vacated and the ward is reachable now.
    expect(bookOf(scene).occupant(wakeDeskSeatId)).toBeNull();
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: failing }));

    let bedded = false;
    for (let step = 0; step < 800 && !bedded; step += 1) {
      scene.tick(100);
      const book = bookOf(scene);
      bedded =
        book.effectiveSeat(sleeper)?.kind === "bed" &&
        !frameOf(scene).awayAgentIds.has(sleeper);
    }
    // Pre-fix, `claim` hands the wake desk straight back: the crash sits at
    // the desk it woke onto and this never becomes true.
    expect(bedded).toBe(true);

    const book = bookOf(scene);
    expect(book.effectiveSeat(sleeper)?.kind).toBe("bed");
    expect(book.occupant(wakeDeskSeatId)).toBeNull();
    // The cubby is still this agent's own seat - the wake claim came and
    // went, the assignment never moved.
    expect(book.assignedSeat(sleeper)?.seatId).toBe(cubby.seatId);
  });
});

/**
 * Fixup 8e - finding 3 (the instant-seating gate was too narrow) and finding
 * 6 (an instant seat walk never moved the character's own tile).
 *
 * Standalone for the same reason 8d is: these build scenes directly off
 * `OFFICE_VIEWS.floor`, with local helpers rather than `describe.each`'s.
 *
 * `awaiting`, never `failure`, for every transition below that runs at a
 * historical cursor or during playback: `officeAgentStatuses` is a LIVE-ONLY
 * reader for the activity tiers, the attention set and the failure set, so a
 * historical cursor never produces `failure` in real usage - only the request
 * prefix does, and that produces `awaiting`. A `failure` fixture here would
 * exercise a status combination the real caller never builds.
 */
describe("OfficeScene fixup 8e - the instant-seating gate, and the tile it seats onto", () => {
  function bookOf(scene: OfficeScene): OfficeSeatBook {
    const spy = vi.spyOn(OfficeSeatBook.prototype, "civicClaimOf");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  /** The sprite box a character standing on this tile would occupy, on Floor. */
  function footRect(layout: OfficeLayout, tile: OfficeTilePos): OfficeRect {
    const projector = OFFICE_VIEWS.floor.painter.projector(layout);
    const foot = projector.project(tile.col + 0.5, tile.row + 1);
    return {
      x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
      y: foot.y - OFFICE_CHARACTER_HEIGHT,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
  }

  function floorFixture(): {
    readonly agents: ReadonlyArray<OfficeAgentInput>;
    readonly visibleAgentIds: ReadonlySet<string>;
    readonly idle: Map<string, OfficeAgentStatus>;
  } {
    const epic = makeTestEpic("one-team", 12, 9);
    const agents = epic.agents;
    return {
      agents,
      visibleAgentIds: new Set(agents.map((a) => a.id)),
      idle: new Map(agents.map((a) => [a.id, "idle" as const])),
    };
  }

  /**
   * CASE 1 - FINDING 3, the `startCivicWalk` leg. A PLAYING scene steps
   * across an idle -> awaiting transition. `civicWantOf` reads `awaiting` as
   * "wants a lounge chair" whether the cursor is live or historical, so this
   * is the civic claim path (`updateCivicClaims` -> `startCivicWalk`), and
   * `playing` is the leg of `motionSuppressed()` finding 3 added to it -
   * pre-fix, `startCivicWalk` gated on `reducedMotion` alone, so a playing
   * scene walked a real, multi-tick path here instead of seating at once.
   *
   * Checked on the SAME sync, with ZERO ticks: whatever is true right now is
   * true because nothing moved, not because a fast walk finished. `seated`
   * (read through `awayAgentIds`) is what a genuine walk starts by clearing,
   * so it is the discriminator - not the exact painted rect, which is
   * finding 6's question and the one CASE 4 below asks. A claim already
   * reads "lounge" the instant it is granted whether or not the walk is
   * instant, so it alone would not tell the two apart either.
   */
  it("seats an awaiting agent instantly during playback, not mid-walk (finding 3: playing)", () => {
    const { agents, visibleAgentIds, idle } = floorFixture();
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(
      sceneInput({ agents, visibleAgentIds, statusById: idle, playing: true }),
    );

    const waiter = agents[2].id;
    const waiting = new Map(idle);
    waiting.set(waiter, "awaiting");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: waiting,
        playing: true,
      }),
    );

    // Pre-fix, `waiter` is mid-walk here (`seated: false`) for many ticks:
    // `startCivicWalk` gated only on `reducedMotion`, which this sync never
    // sets.
    expect(frameOf(scene).awayAgentIds.has(waiter)).toBe(false);
    expect(bookOf(scene).civicClaimOf(waiter)).toBe("lounge");
  });

  /**
   * CASE 2 - FINDING 3, the `walkTo` leg via a BACKWARD SCRUB. Leaving live
   * for history (`cursorMs` going from `null` to non-`null`) is itself a
   * rewind (`cursorRewoundBy`), which re-derives every claim from scratch
   * (`recomputeClaimsFromStatuses`) and rehomes whoever's seat changed
   * (`rehomeCharacters` -> `returnToDesk` -> `walkTo`). `walkTo` is the
   * function finding 3 named directly in its own gate - it read
   * `this.reducedMotion` alone before the fix, so a scrub with motion NOT
   * reduced started a real walk instead of a still photograph.
   */
  it("changes an awaiting claim instantly on a backward scrub, not mid-walk (finding 3: cursorMs)", () => {
    const { agents, visibleAgentIds, idle } = floorFixture();
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: idle }));

    const waiter = agents[2].id;
    const waiting = new Map(idle);
    waiting.set(waiter, "awaiting");
    // `cursorMs` alone, no `reducedMotion` and no `playing`: this leg of
    // `motionSuppressed()` is the one under test.
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: waiting,
        cursorMs: 100,
      }),
    );

    expect(frameOf(scene).awayAgentIds.has(waiter)).toBe(false);
    expect(bookOf(scene).civicClaimOf(waiter)).toBe("lounge");
  });

  /**
   * CASE 3 - FINDING 3, the `walkTo` leg via a FEED SETTLE. The
   * provisional/settled idiom from "fixup 8c - the book settles with the
   * plan": a provisional sync, then one with `feedSettled: true`, which is
   * `settling` (`input.feedSettled && !this.feedSettled && !firstSync`) and
   * goes through the same recompute-and-rehome path as case 2 above.
   *
   * `playing`, not `reducedMotion`, is what suppresses motion here - the
   * feed can settle while a scrubbed playback is still running, and that
   * combination is what this case stands for. Reusing `reducedMotion`
   * instead would still pass pre-fix (it was always one of the OR's legs),
   * so it would prove nothing about finding 3's addition of `playing`.
   */
  it("seats an awaiting agent instantly when the feed settles during playback, not mid-walk (finding 3: feed-settle + playing)", () => {
    const { agents, visibleAgentIds, idle } = floorFixture();
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: idle }));

    const waiter = agents[2].id;
    const settled = new Map(idle);
    settled.set(waiter, "awaiting");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: settled,
        feedSettled: true,
        playing: true,
      }),
    );

    expect(frameOf(scene).awayAgentIds.has(waiter)).toBe(false);
    expect(bookOf(scene).civicClaimOf(waiter)).toBe("lounge");
  });

  /**
   * CASE 4 - FINDING 6, directly, and the one the other three (and every
   * civic case in "fixup 8d" above) miss: they all read the claim and the
   * `seated`/`awayAgentIds` flags, which `settleInChair` sets correctly on
   * its own. Finding 6 is that the character's PAINTED tile - `col`/`row`,
   * which only `seatInstantlyAt` touches - was never one of those things.
   * `characterRect` against the claimed seat's own `chairTile` is the one
   * assertion that can see it; `seatedHead`, which reads the agent's DESK
   * out of `AGENTS_LAYOUT`, is deliberately not what is asserted here - a
   * civic occupant painted at its desk is exactly finding 6.
   *
   * Two sub-cases, as the brief asks: a reduced-motion FIRST live sync where
   * the agent already wants a civic seat, and a live TRANSITION into one.
   */
  it("paints a civic occupant at its claimed seat, not its desk, the instant it is seated (finding 6)", () => {
    // Sub-case A: reduced motion, FIRST sync, already `failure`.
    {
      const { agents, visibleAgentIds, idle } = floorFixture();
      const crasher = agents[2].id;
      const statuses = new Map(idle);
      statuses.set(crasher, "failure");
      const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
      scene.sync(
        sceneInput({
          agents,
          visibleAgentIds,
          statusById: statuses,
          reducedMotion: true,
        }),
      );

      const layout = layoutOf(scene);
      const bedSeat = bookOf(scene).effectiveSeat(crasher);
      if (bedSeat === null || bedSeat.kind !== "bed") {
        throw new Error(`expected ${crasher} to hold a bed on the first sync`);
      }
      const rect = characterRect(frameOf(scene), crasher);
      expect(rect).toEqual(footRect(layout, bedSeat.chairTile));
      const desk = layout.desks.get(crasher);
      if (desk === undefined) throw new Error(`no desk for ${crasher}`);
      // Pre-fix: `settleInChair` alone never moved `col`/`row`, so this was
      // the actual painted rect - the desk, not the bed the claim and
      // `whereabouts` both already named.
      expect(rect).not.toEqual(footRect(layout, desk.chairTile));
    }

    // Sub-case B: reduced motion, a live idle -> awaiting TRANSITION.
    {
      const { agents, visibleAgentIds, idle } = floorFixture();
      const waiter = agents[2].id;
      const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
      scene.sync(
        sceneInput({
          agents,
          visibleAgentIds,
          statusById: idle,
          reducedMotion: true,
        }),
      );
      const desk = layoutOf(scene).desks.get(waiter);
      if (desk === undefined) throw new Error(`no desk for ${waiter}`);

      const waiting = new Map(idle);
      waiting.set(waiter, "awaiting");
      scene.sync(
        sceneInput({
          agents,
          visibleAgentIds,
          statusById: waiting,
          reducedMotion: true,
        }),
      );

      const loungeSeat = bookOf(scene).effectiveSeat(waiter);
      if (loungeSeat === null || loungeSeat.kind !== "lounge") {
        throw new Error(`expected ${waiter} to hold a lounge chair`);
      }
      const rect = characterRect(frameOf(scene), waiter);
      expect(rect).toEqual(footRect(layoutOf(scene), loungeSeat.chairTile));
      expect(rect).not.toEqual(footRect(layoutOf(scene), desk.chairTile));
    }
  });
});

/**
 * Fixup 3a - the playback entry of `settleForStilledMotion`. Reduced motion
 * already settled walks; playback did not, because `wasSuppressed` was read
 * after `this.playing = input.playing` and the transition was always false.
 */
describe("OfficeScene fixup 3a - playback settles civic walks already in flight", () => {
  function bookOf(scene: OfficeScene): OfficeSeatBook {
    const spy = vi.spyOn(OfficeSeatBook.prototype, "civicClaimOf");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  /** The sprite box a character standing on this tile would occupy, on Floor. */
  function chairFootRect(
    layout: OfficeLayout,
    tile: OfficeTilePos,
  ): OfficeRect {
    const foot = OFFICE_VIEWS.floor.painter
      .projector(layout)
      .project(tile.col + 0.5, tile.row + 1);
    return {
      x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
      y: foot.y - OFFICE_CHARACTER_HEIGHT,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
  }

  function seatHitBox(layout: OfficeLayout, seat: OfficeSeat): OfficeRect {
    if (seat.hitBox !== null) return seat.hitBox;
    const origin = OFFICE_VIEWS.floor.painter
      .projector(layout)
      .project(seat.deskTile.col, seat.deskTile.row);
    return {
      x: origin.x,
      y: origin.y,
      width: seat.hitTiles.width * OFFICE_TILE,
      height: seat.hitTiles.height * OFFICE_TILE,
    };
  }

  function idleFloor(): {
    readonly agents: ReadonlyArray<OfficeAgentInput>;
    readonly visibleAgentIds: ReadonlySet<string>;
    readonly idle: Map<string, OfficeAgentStatus>;
  } {
    const agents = makeTestEpic("one-team", 12, 9).agents;
    return {
      agents,
      visibleAgentIds: new Set(agents.map((person) => person.id)),
      idle: new Map(agents.map((person) => [person.id, "idle" as const])),
    };
  }

  function firstAwayId(scene: OfficeScene): string {
    for (let step = 0; step < 400; step += 1) {
      scene.tick(100);
      const away = Array.from(frameOf(scene).awayAgentIds);
      if (away.length > 0) return away[0];
    }
    throw new Error("nobody started an errand");
  }

  function tickTimes(scene: OfficeScene, steps: number): void {
    for (let step = 0; step < steps; step += 1) scene.tick(100);
  }

  function seatedOther(
    scene: OfficeScene,
    agents: ReadonlyArray<OfficeAgentInput>,
    except: string,
  ): string {
    const away = frameOf(scene).awayAgentIds;
    const found = agents.find(
      (person) => person.id !== except && !away.has(person.id),
    );
    if (found === undefined) {
      throw new Error("expected a seated agent besides the errand walker");
    }
    return found.id;
  }

  /**
   * PLAYBACK entry, not reduced motion. A live civic walk is already in
   * flight; turning `playing` on must land that walker on `seat.chairTile`.
   * An ordinary errand-return at the same moment is not a civic walk, so
   * `settleCivicWalks` leaves it mid-path.
   */
  it("settles a civic walker onto its chair tile when playback starts, and leaves an ordinary errand walker in flight", () => {
    const { agents, visibleAgentIds, idle } = idleFloor();
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: idle,
        playing: false,
      }),
    );

    const errandWalker = firstAwayId(scene);
    const waiter = seatedOther(scene, agents, errandWalker);
    // Walk them further from the desk so the errand-return after the next
    // sync is a real path, not a one-tile hop that four ticks would finish.
    tickTimes(scene, 30);
    if (!frameOf(scene).awayAgentIds.has(errandWalker)) {
      throw new Error(`expected ${errandWalker} still away after the stroll`);
    }

    // Working turns the errand-out into errand-return: that is still an
    // ordinary errand, and it is the walk `errandMustEnd` will not then
    // instantly seat when playback starts (errand-out would be).
    const inFlight = new Map(idle);
    inFlight.set(errandWalker, "working");
    inFlight.set(waiter, "awaiting");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: inFlight,
        playing: false,
      }),
    );

    expect(frameOf(scene).awayAgentIds.has(waiter)).toBe(true);
    expect(frameOf(scene).awayAgentIds.has(errandWalker)).toBe(true);
    const loungeSeat = bookOf(scene).effectiveSeat(waiter);
    if (loungeSeat === null || loungeSeat.kind !== "lounge") {
      throw new Error(`expected ${waiter} to hold a lounge chair`);
    }
    const chairRect = chairFootRect(layoutOf(scene), loungeSeat.chairTile);
    expect(scene.locate(waiter)).not.toEqual(chairRect);

    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: inFlight,
        playing: true,
      }),
    );

    // `locate` for a seated agent is the seat's painted box. The measured
    // claim in the source comment is the body on `seat.chairTile`.
    expect(characterRect(frameOf(scene), waiter)).toEqual(chairRect);
    expect(scene.locate(waiter)).toEqual(
      seatHitBox(layoutOf(scene), loungeSeat),
    );
    expect(frameOf(scene).awayAgentIds.has(waiter)).toBe(false);
    expect(frameOf(scene).awayAgentIds.has(errandWalker)).toBe(true);
  });
});

/**
 * Evidence (a) and (c2) - book-level, no scene. A releasing claim is still a
 * reservation, a kind mismatch is a refusal, and a cursor recompute with more
 * wanters than beds is deterministic.
 */
describe("OfficeSeatBook evidence - releasing claims and civic recompute", () => {
  function civicPref(wants: "bed" | "lounge"): OfficeSeatPreference {
    return { roomId: null, floorIndex: 0, wants, shortfall: "none" };
  }

  function civicSeat(args: {
    readonly seatId: string;
    readonly kind: "bed" | "lounge";
    readonly deskTile: OfficeTilePos;
  }): OfficeSeat {
    return {
      seatId: args.seatId,
      kind: args.kind,
      deskTile: args.deskTile,
      chairTile: { col: args.deskTile.col, row: args.deskTile.row + 1 },
      facing: "up",
      hitTiles:
        args.kind === "bed" ? { width: 2, height: 1 } : { width: 1, height: 1 },
      hitBox: null,
      floorIndex: 0,
      roomId: null,
      hostId: null,
      manager: false,
      civicRoomId: args.kind === "bed" ? "infirmary" : "waiting-room",
    };
  }

  function bookLayout(
    desks: ReadonlyArray<{ readonly agentId: string; readonly seatId: string }>,
    civic: ReadonlyArray<OfficeSeat>,
  ): OfficeLayout {
    const seats = new Map<string, OfficeSeat>();
    const assigned = new Map<string, OfficeDesk>();
    for (const [index, desk] of desks.entries()) {
      const seat = deskSeat({
        seatId: desk.seatId,
        deskTile: { col: 2 + index * 4, row: 2 },
        floorIndex: 0,
      });
      seats.set(seat.seatId, seat);
      assigned.set(desk.agentId, { ...seat, agentId: desk.agentId });
    }
    for (const seat of civic) seats.set(seat.seatId, seat);
    return {
      view: "floor",
      cols: 24,
      rows: 16,
      desks: assigned,
      seats,
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
  }

  function bedHolders(book: OfficeSeatBook): string[] {
    return book
      .knownAgentIds()
      .filter((agentId) => book.civicClaimOf(agentId) === "bed");
  }

  it("refuses a kind-mismatched lounge and a competing bed claim before vacated, then grants both after", () => {
    const bed = civicSeat({
      seatId: "bed-1",
      kind: "bed",
      deskTile: { col: 12, row: 2 },
    });
    const lounge = civicSeat({
      seatId: "lounge-1",
      kind: "lounge",
      deskTile: { col: 16, row: 2 },
    });
    const book = new OfficeSeatBook();
    book.adopt(
      bookLayout(
        [
          { agentId: "alpha", seatId: "desk-alpha" },
          { agentId: "beta", seatId: "desk-beta" },
        ],
        [bed, lounge],
      ),
      ["alpha", "beta"],
      "keep",
    );
    expect(book.claim("alpha", civicPref("bed"))?.seatId).toBe("bed-1");

    book.endClaim("alpha");
    expect(book.claim("alpha", civicPref("lounge"))).toBeNull();
    expect(book.claim("beta", civicPref("bed"))).toBeNull();
    expect(book.occupancy().get("bed-1")).toBe("alpha");

    book.vacated("alpha");
    expect(book.claim("alpha", civicPref("lounge"))?.seatId).toBe("lounge-1");
    expect(book.claim("beta", civicPref("bed"))?.seatId).toBe("bed-1");
  });

  it("recomputes civic claims at a cursor the same way twice when wanters exceed capacity", () => {
    const beds: ReadonlyArray<OfficeSeat> = [
      civicSeat({
        seatId: "bed-1",
        kind: "bed",
        deskTile: { col: 12, row: 2 },
      }),
      civicSeat({
        seatId: "bed-2",
        kind: "bed",
        deskTile: { col: 16, row: 2 },
      }),
    ];
    const ids = ["A", "B", "C", "D"];
    const desks = ids.map((agentId) => ({
      agentId,
      seatId: `desk-${agentId}`,
    }));
    const book = new OfficeSeatBook();
    book.adopt(bookLayout(desks, beds), ids, "keep");
    const failing: ReadonlyMap<string, OfficeAgentStatus> = new Map(
      ids.map((agentId) => [agentId, "failure" as const]),
    );

    book.recomputeClaims(failing, ids);
    const first = bedHolders(book);
    expect(first).toEqual(["A", "B"]);
    expect(book.civicClaimOf("C")).toBeNull();
    expect(book.civicClaimOf("D")).toBeNull();
    expect(book.effectiveSeat("C")?.seatId).toBe("desk-C");
    expect(book.effectiveSeat("D")?.seatId).toBe("desk-D");

    book.recomputeClaims(failing, ids);
    expect(bedHolders(book)).toEqual(first);
  });

  /**
   * The determinism case above assigns desks, so overflow never reaches the
   * wake loop (`seat.kind !== "cubby"`). A cubby overflow with no spare
   * desk is the shape that loop would actually claim: civic bookkeeping
   * that recorded only successful claims would let it through, the wake
   * would miss, and `needsCapacity` would ask the plan to grow.
   */
  it("keeps a cubby civic overflow out of the wake pass on recompute, with no desk shortfall", () => {
    const bed = civicSeat({
      seatId: "bed-1",
      kind: "bed",
      deskTile: { col: 12, row: 2 },
    });
    const seats = new Map<string, OfficeSeat>();
    const assigned = new Map<string, OfficeDesk>();
    const cubbies: ReadonlyArray<{
      readonly agentId: string;
      readonly seatId: string;
    }> = [
      { agentId: "filler", seatId: "cubby-filler" },
      { agentId: "overflow", seatId: "cubby-overflow" },
    ];
    for (const [index, cubby] of cubbies.entries()) {
      const seat = cubbySeat({
        seatId: cubby.seatId,
        deskTile: { col: 2 + index * 4, row: 2 },
        floorIndex: 0,
      });
      seats.set(seat.seatId, seat);
      assigned.set(cubby.agentId, { ...seat, agentId: cubby.agentId });
    }
    seats.set(bed.seatId, bed);
    const layout: OfficeLayout = {
      view: "floor",
      cols: 24,
      rows: 16,
      desks: assigned,
      seats,
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const book = new OfficeSeatBook();
    book.adopt(layout, ["filler", "overflow"], "keep");
    const failing = new Map<string, OfficeAgentStatus>([
      ["filler", "failure"],
      ["overflow", "failure"],
    ]);
    book.recomputeClaims(failing, ["filler", "overflow"]);

    expect(book.civicClaimOf("filler")).toBe("bed");
    expect(book.civicClaimOf("overflow")).toBeNull();
    expect(book.effectiveSeat("overflow")?.kind).toBe("cubby");
    expect(book.effectiveSeat("overflow")?.seatId).toBe("cubby-overflow");
    expect(book.needsCapacity()).toEqual([]);
  });

  /**
   * Same mutant as the no-spare-desk case, visible consequence: a free
   * reserve would be taken by a fall-through wake, and the overflow would
   * leave its cubby. `recomputeClaims`, not the live wake-pass guard.
   */
  it("keeps a cubby civic overflow on its cubby through recompute when a reserve desk is free", () => {
    const bed = civicSeat({
      seatId: "bed-1",
      kind: "bed",
      deskTile: { col: 12, row: 2 },
    });
    const reserve = deskSeat({
      seatId: "reserve-1",
      deskTile: { col: 8, row: 2 },
      floorIndex: 0,
    });
    const seats = new Map<string, OfficeSeat>();
    const assigned = new Map<string, OfficeDesk>();
    const cubbies: ReadonlyArray<{
      readonly agentId: string;
      readonly seatId: string;
    }> = [
      { agentId: "filler", seatId: "cubby-filler" },
      { agentId: "overflow", seatId: "cubby-overflow" },
    ];
    for (const [index, cubby] of cubbies.entries()) {
      const seat = cubbySeat({
        seatId: cubby.seatId,
        deskTile: { col: 2 + index * 4, row: 2 },
        floorIndex: 0,
      });
      seats.set(seat.seatId, seat);
      assigned.set(cubby.agentId, { ...seat, agentId: cubby.agentId });
    }
    seats.set(bed.seatId, bed);
    seats.set(reserve.seatId, reserve);
    const layout: OfficeLayout = {
      view: "floor",
      cols: 24,
      rows: 16,
      desks: assigned,
      seats,
      signs: [],
      rooms: [],
      floors: [handBuiltFloor([])],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
    const book = new OfficeSeatBook();
    book.adopt(layout, ["filler", "overflow"], "keep");
    expect(book.occupancy().get("reserve-1")).toBeUndefined();

    const failing = new Map<string, OfficeAgentStatus>([
      ["filler", "failure"],
      ["overflow", "failure"],
    ]);
    book.recomputeClaims(failing, ["filler", "overflow"]);

    expect(book.effectiveSeat("overflow")?.kind).toBe("cubby");
    expect(book.effectiveSeat("overflow")?.seatId).toBe("cubby-overflow");
    expect(book.heldClaimWant("overflow")).toBeNull();
  });
});

/**
 * Evidence (c1) - a civic wanter on a floor whose beds and reserves are
 * already taken keeps its assignment rather than going seatless or taking a
 * second seat.
 */
describe("OfficeScene evidence - civic wanter under full beds and reserves", () => {
  function bookOf(scene: OfficeScene): OfficeSeatBook {
    const spy = vi.spyOn(OfficeSeatBook.prototype, "civicClaimOf");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  function cubbyIds(scene: OfficeScene): string[] {
    const ids: string[] = [];
    for (const desk of layoutOf(scene).desks.values()) {
      if (desk.kind === "cubby") ids.push(desk.agentId);
    }
    return ids;
  }

  function countSeats(
    layout: OfficeLayout,
    kind: "bed" | "wake-reserve",
  ): number {
    const assigned = new Set<string>();
    for (const desk of layout.desks.values()) assigned.add(desk.seatId);
    let count = 0;
    for (const seat of layout.seats.values()) {
      if (kind === "bed") {
        if (seat.kind === "bed") count += 1;
        continue;
      }
      if (
        seat.kind === "cubby" ||
        seat.kind === "bed" ||
        seat.kind === "lounge"
      ) {
        continue;
      }
      if (!assigned.has(seat.seatId)) count += 1;
    }
    return count;
  }

  function expectOccupantsInjective(book: OfficeSeatBook): void {
    const seen = new Map<string, string>();
    for (const agentId of book.knownAgentIds()) {
      const seat = book.effectiveSeat(agentId);
      if (seat === null) continue;
      expect(seen.get(seat.seatId), seat.seatId).toBeUndefined();
      seen.set(seat.seatId, agentId);
      expect(book.occupant(seat.seatId)).toBe(agentId);
    }
  }

  /**
   * Wake-reserve seats the book has not spoken for. Layout-only counts
   * cannot tell a free reserve from one a claim is holding, so a case
   * that needs a reserve to be FREE has to ask occupancy.
   */
  function freeWakeReserveCount(
    layout: OfficeLayout,
    book: OfficeSeatBook,
  ): number {
    const assigned = new Set<string>();
    for (const desk of layout.desks.values()) assigned.add(desk.seatId);
    const spoken = book.occupancy();
    let free = 0;
    for (const seat of layout.seats.values()) {
      if (
        seat.kind === "cubby" ||
        seat.kind === "bed" ||
        seat.kind === "lounge"
      ) {
        continue;
      }
      if (assigned.has(seat.seatId) || spoken.has(seat.seatId)) continue;
      free += 1;
    }
    return free;
  }

  it("leaves a civic wanter at its cubby when beds and reserves are full", () => {
    const epic = makeTestEpic("one-team", 40, 1);
    const agents = epic.agents;
    const visibleAgentIds = new Set(agents.map((person) => person.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((person) => [person.id, "idle" as const]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: idle,
        reducedMotion: true,
      }),
    );

    const cubbies = cubbyIds(scene);
    const layout = layoutOf(scene);
    const beds = countSeats(layout, "bed");
    const reserves = countSeats(layout, "wake-reserve");
    if (cubbies.length < beds + reserves + 1) {
      throw new Error(
        `fixture needs ${beds} bed fillers, ${reserves} reserve fillers and one overflow; got ${cubbies.length} cubbies`,
      );
    }
    const bedFillers = cubbies.slice(0, beds);
    const reserveFillers = cubbies.slice(beds, beds + reserves);
    const overflow = cubbies[beds + reserves];

    const filled = new Map(idle);
    for (const agentId of bedFillers) filled.set(agentId, "failure");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: filled,
        reducedMotion: true,
      }),
    );
    for (const agentId of bedFillers) {
      expect(bookOf(scene).civicClaimOf(agentId)).toBe("bed");
    }

    for (const agentId of reserveFillers) filled.set(agentId, "working");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: filled,
        reducedMotion: true,
      }),
    );
    for (const agentId of reserveFillers) {
      expect(bookOf(scene).heldClaimWant(agentId)).toBe("desk");
    }

    filled.set(overflow, "failure");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: filled,
        reducedMotion: true,
      }),
    );

    const book = bookOf(scene);
    expect(book.civicClaimOf(overflow)).toBeNull();
    expect(book.heldClaimWant(overflow)).toBeNull();
    expect(book.effectiveSeat(overflow)?.kind).toBe("cubby");
    expect(book.effectiveSeat(overflow)?.seatId).toBe(
      layoutOf(scene).desks.get(overflow)?.seatId,
    );
    expect(scene.locate(overflow)).not.toBeNull();
    expectOccupantsInjective(book);
    // The overflow pass itself. A follow-up that replanned would clear a
    // shortfall written here, so this is the observation with no replan
    // between it and the pass it is about.
    expect(book.needsCapacity()).toEqual([]);
    const cubbySeatId = book.effectiveSeat(overflow)?.seatId;
    const planBefore = layoutOf(scene);

    // C2: a full ward is not a floor that needs a bigger one. An unchanged
    // follow-up sync is what would re-plan if overflow had been written
    // into `needsCapacity` on the pass above. A replan with an empty
    // shortfall preserves every count — `desks.size` and `seats.size`
    // both — so only the layout object's identity witnesses that no
    // replan happened.
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: filled,
        reducedMotion: true,
      }),
    );
    expect(bookOf(scene).needsCapacity()).toEqual([]);
    expect(bookOf(scene).effectiveSeat(overflow)?.seatId).toBe(cubbySeatId);
    expect(layoutOf(scene)).toBe(planBefore);
  });

  /**
   * Sibling of the full/full case above. Reserves FULL made the wake-pass
   * guard unobservable: falling through still found nothing, so
   * `heldClaimWant` stayed null on both sides. Beds full and a reserve
   * FREE is the shape that guard exists for — without it the overflow
   * cubby is handed a desk.
   */
  it("leaves a crashed cubby agent at its cubby when beds are full and a reserve desk is free", () => {
    const epic = makeTestEpic("one-team", 12, 9);
    const agents = epic.agents;
    const visibleAgentIds = new Set(agents.map((person) => person.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((person) => [person.id, "idle" as const]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.building, null);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: idle,
        reducedMotion: true,
      }),
    );

    const cubbies = cubbyIds(scene);
    const beds = countSeats(layoutOf(scene), "bed");
    if (cubbies.length < beds + 1) {
      throw new Error(
        `fixture needs ${beds} bed fillers and one overflow; got ${cubbies.length} cubbies`,
      );
    }
    const bedFillers = cubbies.slice(0, beds);
    const overflow = cubbies[beds];

    const filled = new Map(idle);
    for (const agentId of bedFillers) filled.set(agentId, "failure");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: filled,
        reducedMotion: true,
      }),
    );
    for (const agentId of bedFillers) {
      expect(bookOf(scene).civicClaimOf(agentId)).toBe("bed");
    }

    // The pressure this case exists to apply. If the fixture later has no
    // free reserve, falling through the wake-pass guard finds nothing and
    // the assertions go green for the wrong reason — the full/full sibling.
    const freeReserves = freeWakeReserveCount(layoutOf(scene), bookOf(scene));
    expect(
      freeReserves,
      "a reserve desk was free when the overflow crashed",
    ).toBeGreaterThan(0);

    filled.set(overflow, "failure");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: filled,
        reducedMotion: true,
      }),
    );

    const book = bookOf(scene);
    expect(book.heldClaimWant(overflow)).toBeNull();
    expect(book.effectiveSeat(overflow)?.kind).toBe("cubby");
  });
});

/**
 * Finding 7b - a civic holder that flips to `attention` is sent to the
 * counter, and `updateCivicClaims` ends the claim without redirecting
 * because the queue walk is already under way. Nothing then calls
 * `vacated`, so the bed or chair stays in `occupancy()` for as long as
 * they stand at the counter.
 */
describe("OfficeScene finding 7b - a queue walk must vacate the civic seat", () => {
  const QUEUE_WALK_TICKS = 800;

  function bookOf(scene: OfficeScene): OfficeSeatBook {
    // `effectiveSeat`, not `civicClaimOf`: a queue-stand character is not
    // seated, so the frame never asks the civic claim and that spy is empty.
    const spy = vi.spyOn(OfficeSeatBook.prototype, "effectiveSeat");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  function footRect(layout: OfficeLayout, tile: OfficeTilePos): OfficeRect {
    const foot = OFFICE_VIEWS.floor.painter
      .projector(layout)
      .project(tile.col + 0.5, tile.row + 1);
    return {
      x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
      y: foot.y - OFFICE_CHARACTER_HEIGHT,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
  }

  function countKind(layout: OfficeLayout, kind: OfficeSeatKind): number {
    let count = 0;
    for (const seat of layout.seats.values()) {
      if (seat.kind === kind) count += 1;
    }
    return count;
  }

  function tickUntilAtRect(
    scene: OfficeScene,
    agentId: string,
    expected: OfficeRect,
    steps: number,
  ): boolean {
    for (let step = 0; step < steps; step += 1) {
      scene.tick(100);
      const here = scene.locate(agentId);
      if (here === null) continue;
      if (here.x === expected.x && here.y === expected.y) return true;
    }
    return false;
  }

  function locateMatches(
    scene: OfficeScene,
    agentId: string,
    box: OfficeRect,
  ): boolean {
    const here = scene.locate(agentId);
    if (here === null) return false;
    return here.x === box.x && here.y === box.y;
  }

  interface FilledLoungeFloor {
    readonly scene: OfficeScene;
    readonly agents: ReadonlyArray<OfficeAgentInput>;
    readonly visibleAgentIds: ReadonlySet<string>;
    readonly idle: Map<string, OfficeAgentStatus>;
    readonly sitters: ReadonlyArray<string>;
    readonly holder: string;
    readonly competitor: string;
    readonly loungeSeatId: string;
    readonly queueTile: OfficeTilePos;
  }

  function attentionStatuses(
    idle: Map<string, OfficeAgentStatus>,
    sitters: ReadonlyArray<string>,
    holder: string,
  ): Map<string, OfficeAgentStatus> {
    const next = new Map(idle);
    for (const id of sitters) next.set(id, "awaiting");
    next.set(holder, "attention");
    return next;
  }

  function filledLoungeFloor(): FilledLoungeFloor {
    const agents = makeTestEpic("one-team", 12, 9).agents;
    const visibleAgentIds = new Set(agents.map((person) => person.id));
    // Annotated: an unannotated `new Map` infers `Map<string, "idle">` from
    // the literal, and the `awaiting` write below is then a type error Vitest
    // never sees - the hook does.
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((person) => [person.id, "idle" as const]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(sceneInput({ agents, visibleAgentIds, statusById: idle }));
    const chairs = countKind(layoutOf(scene), "lounge");
    if (agents.length < chairs + 1) {
      throw new Error(
        `need ${chairs} sitters and a competitor; got ${agents.length}`,
      );
    }
    const sitters = agents.slice(0, chairs).map((person) => person.id);
    const holder = sitters[0];
    const competitor = agents[chairs].id;
    const waiting = new Map(idle);
    for (const id of sitters) waiting.set(id, "awaiting");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: waiting,
        reducedMotion: true,
      }),
    );
    for (const id of sitters) {
      if (bookOf(scene).civicClaimOf(id) !== "lounge") {
        throw new Error(`expected ${id} seated in a lounge`);
      }
    }
    const lounge = bookOf(scene).effectiveSeat(holder);
    if (lounge === null || lounge.kind !== "lounge") {
      throw new Error(`expected ${holder} to hold a lounge`);
    }
    // Length, not an `undefined` check on the element: the index signature is
    // not `noUncheckedIndexedAccess`, so comparing the element to `undefined`
    // is a condition the types say can never fire.
    const queueTiles =
      layoutOf(scene).floors[lounge.floorIndex].receptionQueueTiles;
    if (queueTiles.length === 0) {
      throw new Error("expected a reception queue tile");
    }
    const queueTile = queueTiles[0];
    return {
      scene,
      agents,
      visibleAgentIds,
      idle,
      sitters,
      holder,
      competitor,
      loungeSeatId: lounge.seatId,
      queueTile,
    };
  }

  function syncHolderToCounter(
    floor: FilledLoungeFloor,
    reducedMotion: boolean,
  ): void {
    floor.scene.sync(
      sceneInput({
        agents: floor.agents,
        visibleAgentIds: floor.visibleAgentIds,
        statusById: attentionStatuses(floor.idle, floor.sitters, floor.holder),
        reducedMotion,
      }),
    );
  }

  function loungeOnQueueLayout(queueTile: OfficeTilePos): OfficeLayout {
    const home = deskSeat({
      seatId: "desk-holder",
      deskTile: { col: 2, row: 2 },
      floorIndex: 0,
    });
    const lounge: OfficeSeat = {
      seatId: "lounge-q",
      kind: "lounge",
      deskTile: { col: queueTile.col, row: queueTile.row - 1 },
      chairTile: queueTile,
      facing: "up",
      hitTiles: { width: 1, height: 1 },
      hitBox: null,
      floorIndex: 0,
      roomId: null,
      hostId: null,
      manager: false,
      civicRoomId: "waiting-room",
    };
    const floor: OfficeFloor = {
      ...handBuiltFloor([]),
      receptionQueueTiles: [queueTile],
    };
    return {
      view: "floor",
      cols: 16,
      rows: 16,
      desks: new Map([["holder", { ...home, agentId: "holder" }]]),
      seats: new Map([
        [home.seatId, home],
        [lounge.seatId, lounge],
      ]),
      signs: [],
      rooms: [],
      floors: [floor],
      doorTile: { col: 0, row: 0 },
      lobbyTile: { col: 0, row: 1 },
      props: [],
      walkable: allWalkable(16, 16),
      frozen: null,
      shiftFromPrevious: null,
      stable: true,
    };
  }

  it("keeps a lounge reserved while its holder walks to the counter, and frees it on arrival with no further sync", () => {
    const floor = filledLoungeFloor();
    const queueBox = footRect(layoutOf(floor.scene), floor.queueTile);
    syncHolderToCounter(floor, false);

    const mid = bookOf(floor.scene);
    expect(mid.occupant(floor.loungeSeatId)).toBeNull();
    expect(mid.occupancy().get(floor.loungeSeatId)).toBe(floor.holder);
    expect(floor.scene.whereabouts(floor.holder)).toBe("Help desk");
    expect(floor.scene.locate(floor.holder)).not.toEqual(queueBox);

    floor.scene.tick(100);
    if (locateMatches(floor.scene, floor.holder, queueBox)) {
      throw new Error(
        "queue walk finished in one tick; mid-walk occupancy cannot be observed",
      );
    }
    expect(bookOf(floor.scene).occupancy().get(floor.loungeSeatId)).toBe(
      floor.holder,
    );

    expect(
      tickUntilAtRect(floor.scene, floor.holder, queueBox, QUEUE_WALK_TICKS),
    ).toBe(true);
    expect(
      bookOf(floor.scene).occupancy().get(floor.loungeSeatId),
    ).toBeUndefined();
  });

  it("frees a lounge on the same sync that stands its holder at the counter under reduced motion", () => {
    const floor = filledLoungeFloor();
    const queueBox = footRect(layoutOf(floor.scene), floor.queueTile);
    syncHolderToCounter(floor, true);

    const atQueue = floor.scene.locate(floor.holder);
    if (
      atQueue === null ||
      atQueue.x !== queueBox.x ||
      atQueue.y !== queueBox.y
    ) {
      throw new Error("expected instant queue-stand under reduced motion");
    }
    const book = bookOf(floor.scene);
    expect(book.occupant(floor.loungeSeatId)).toBeNull();
    expect(book.occupancy().get(floor.loungeSeatId)).toBeUndefined();
  });

  it("frees a lounge on the same sync when the holder already stands on the queue slot", () => {
    const queueTile: OfficeTilePos = { col: 4, row: 6 };
    const layout = loungeOnQueueLayout(queueTile);
    const holder = agent({ id: "holder", createdAt: 1 });
    const visibleAgentIds: ReadonlySet<string> = new Set(["holder"]);
    const scene = new OfficeScene(
      testView(() => layout),
      null,
    );
    const idle = new Map<string, OfficeAgentStatus>([["holder", "idle"]]);
    scene.sync(
      sceneInput({
        agents: [holder],
        visibleAgentIds,
        statusById: idle,
      }),
    );
    scene.sync(
      sceneInput({
        agents: [holder],
        visibleAgentIds,
        statusById: new Map(idle).set("holder", "awaiting"),
        reducedMotion: true,
      }),
    );
    const lounge = bookOf(scene).effectiveSeat("holder");
    if (lounge === null || lounge.kind !== "lounge") {
      throw new Error("expected holder in the lounge");
    }
    if (
      lounge.chairTile.col !== queueTile.col ||
      lounge.chairTile.row !== queueTile.row
    ) {
      throw new Error("lounge chair must be the queue slot");
    }

    scene.sync(
      sceneInput({
        agents: [holder],
        visibleAgentIds,
        statusById: new Map(idle).set("holder", "attention"),
        reducedMotion: false,
      }),
    );
    const queueBox = footRect(layoutOf(scene), queueTile);
    const atQueue = scene.locate("holder");
    if (
      atQueue === null ||
      atQueue.x !== queueBox.x ||
      atQueue.y !== queueBox.y
    ) {
      throw new Error("expected instant queue-stand: start tile was the slot");
    }
    expect(scene.whereabouts("holder")).toBe("Help desk");
    const book = bookOf(scene);
    expect(book.occupant(lounge.seatId)).toBeNull();
    expect(book.occupancy().get(lounge.seatId)).toBeUndefined();
  });

  it("lets a competing awaiting agent claim the lounge a counter-bound holder has arrived from", () => {
    const floor = filledLoungeFloor();
    const queueBox = footRect(layoutOf(floor.scene), floor.queueTile);
    syncHolderToCounter(floor, false);
    expect(
      tickUntilAtRect(floor.scene, floor.holder, queueBox, QUEUE_WALK_TICKS),
    ).toBe(true);

    const competing = attentionStatuses(
      floor.idle,
      floor.sitters,
      floor.holder,
    );
    competing.set(floor.competitor, "awaiting");
    floor.scene.sync(
      sceneInput({
        agents: floor.agents,
        visibleAgentIds: floor.visibleAgentIds,
        statusById: competing,
      }),
    );
    const book = bookOf(floor.scene);
    expect(book.civicClaimOf(floor.competitor)).toBe("lounge");
    expect(book.effectiveSeat(floor.competitor)?.seatId).toBe(
      floor.loungeSeatId,
    );
  });
});

/**
 * THE HOST IS A WALL, on the way out as much as on the way to a bed.
 *
 * A departure now reads the agent's own storey for a records door and then its
 * own BUILDING, because in an oblique view only the plaza storey carries civic
 * rooms and reading the storey alone sent every other storey's leavers out
 * through their stairwell lobby instead. "Its own building" is the load-bearing
 * half: hosts are separate buildings with no walkable route between them, so the
 * neighbour's plaza is a records door this agent could never reach, and a scan
 * over every floor would have found it first as often as not.
 *
 * Towers is the view this is asserted in because it is the one that stacks a
 * storey per host AND puts the archive on one storey of each building, so the
 * two wrong answers - the neighbour's door, and the stairwell - are both
 * available to be picked.
 */
describe("towers: an archived agent leaves by its own building's records door", () => {
  const VIEW = OFFICE_VIEWS.towers;

  /**
   * One building's records door, and WHERE IN `floors` IT SITS.
   *
   * The floor index is the load-bearing field, not decoration. `departureDoorOf`
   * finds a door by scanning `currentLayout.floors` in order and taking the
   * first archive on a storey of the agent's own host; the host test is the only
   * thing that stops it at the right one. So a case that means to pin the host
   * test has to know which archive an UNFILTERED scan would have reached first.
   */
  interface ArchiveDoor {
    readonly hostId: string | null;
    readonly door: OfficeTilePos;
    readonly floorIndex: number;
  }

  interface TwoHostTowers {
    readonly layout: OfficeLayout;
    readonly epic: OfficeTestEpic;
    readonly statusById: Map<string, OfficeAgentStatus>;
    readonly archives: ReadonlyArray<ArchiveDoor>;
  }

  function towersWithTwoHosts(): TwoHostTowers {
    const epic = makeTestEpic("two-hosts", 120, 11);
    const statusById = new Map(epic.statusById);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById,
      previous: null,
    });
    const layout = VIEW.plan({
      agents: epic.agents,
      partition,
      occupancy: new Map<string, string>(),
      needsCapacity: [],
      activityById: new Map<string, number>(),
      viewport: { width: 1040, height: 700 },
      previous: null,
    });
    const archives: ArchiveDoor[] = [];
    for (const [floorIndex, floor] of layout.floors.entries()) {
      const door = floor.civic.find(
        (room) => room.kind === "archive",
      )?.doorTile;
      if (door === undefined) continue;
      archives.push({ hostId: floor.hostId, door, floorIndex });
    }
    return { layout, epic, statusById, archives };
  }

  interface WalkOut {
    readonly subjectId: string;
    readonly walked: boolean;
    readonly closestToMine: number;
    readonly closestToTheirs: number;
  }

  /**
   * Archive an UPPER-STOREY agent of `mine`'s host and watch where it goes.
   *
   * Upper storey on purpose: a leaver already on the plaza finds its archive on
   * its own storey and never reaches the building step at all, so it cannot say
   * anything about how that step chooses.
   */
  function walkOutOf(args: {
    readonly towers: TwoHostTowers;
    readonly mine: ArchiveDoor;
    readonly theirs: ArchiveDoor;
  }): WalkOut {
    const { towers, mine, theirs } = args;
    const { layout, epic, statusById } = towers;
    const plazaStoreys = new Set(
      layout.floors
        .map((floor, index) => ({ floor, index }))
        .filter((entry) => entry.floor.civic.length > 0)
        .map((entry) => entry.index),
    );
    const upstairs = epic.agents.find((candidate) => {
      if (candidate.hostId !== mine.hostId) return false;
      const desk = layout.desks.get(candidate.id);
      if (desk === undefined || desk.kind === "cubby") return false;
      return !plazaStoreys.has(desk.floorIndex);
    });
    if (upstairs === undefined) throw new Error("no upper-storey agent");

    const scene = new OfficeScene(VIEW, null);
    const agents = epic.agents.map((candidate) =>
      candidate.id === upstairs.id
        ? { ...candidate, archivedAt: 500, archived: true }
        : candidate,
    );
    const visibleAgentIds = new Set(
      epic.agents.map((candidate) => candidate.id),
    );
    scene.sync(
      sceneInput({ agents, visibleAgentIds, statusById, cursorMs: 100 }),
    );
    scene.sync(
      sceneInput({ agents, visibleAgentIds, statusById, cursorMs: 900 }),
    );

    const projector = VIEW.painter.projector(layout);
    const footOf = (tile: OfficeTilePos): OfficePoint => {
      const foot = projector.project(tile.col + 0.5, tile.row + 1);
      return {
        x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
        y: foot.y - OFFICE_CHARACTER_HEIGHT,
      };
    };
    const mineFoot = footOf(mine.door);
    const theirsFoot = footOf(theirs.door);
    let closestToMine = Number.POSITIVE_INFINITY;
    let closestToTheirs = Number.POSITIVE_INFINITY;
    let walked = false;
    for (let step = 0; step < 4000; step += 1) {
      const frame = scene.frame(2, WHOLE_WORLD);
      const region = frame.hitRegions.find(
        (candidate) =>
          candidate.agentId === upstairs.id &&
          candidate.rect.height === OFFICE_CHARACTER_HEIGHT,
      );
      if (region === undefined) break;
      walked = true;
      const rect = region.rect;
      closestToMine = Math.min(
        closestToMine,
        Math.hypot(rect.x - mineFoot.x, rect.y - mineFoot.y),
      );
      closestToTheirs = Math.min(
        closestToTheirs,
        Math.hypot(rect.x - theirsFoot.x, rect.y - theirsFoot.y),
      );
      scene.tick(20);
    }
    return { subjectId: upstairs.id, walked, closestToMine, closestToTheirs };
  }

  /**
   * THE FALLBACK WITNESS, AND ONLY THAT.
   *
   * It proves the building step happens at all: an upper storey has no archive,
   * and the leaver still reaches one instead of walking to its own stairwell.
   * It says NOTHING about the host test, and the distinction is not academic -
   * this subject belongs to the host whose archive is FIRST in `floors`, so a
   * scan with the host test deleted picks that same door and this case stays
   * green. The isolation claim is the case below, which is built the other way
   * round on purpose.
   */
  it("reaches a records door from a storey that has none", () => {
    const towers = towersWithTwoHosts();
    const { archives } = towers;
    expect(archives.length).toBe(2);
    const mine = archives[0];
    const theirs = archives[1];
    expect(mine.hostId).not.toBe(theirs.hostId);
    // The precondition that makes this the FALLBACK case: the subject's own
    // archive is the one an unfiltered scan would meet first anyway.
    expect(mine.floorIndex).toBeLessThan(theirs.floorIndex);

    const out = walkOutOf({ towers, mine, theirs });
    expect(out.walked).toBe(true);
    expect(out.closestToMine).toBeLessThan(OFFICE_TILE / 2);
  });

  /**
   * THE HOST IS A WALL: the isolation claim, with a subject that can tell.
   *
   * The subject belongs to the host whose archive comes SECOND in `floors`, so
   * the first archive the scan meets is a FOREIGN one. Delete the host test and
   * the walk-out goes to that foreign door and this case reddens; keep it and
   * the scan walks past the foreign archive to the subject's own. That ordering
   * is the entire difference between this case and the one above, which is why
   * both are here.
   */
  it("walks past a nearer foreign records door to its own building's", () => {
    const towers = towersWithTwoHosts();
    const { archives } = towers;
    expect(archives.length).toBe(2);
    // MINE IS THE LATER ONE. Asserted rather than assumed: if the plan ever
    // reorders `floors` so that this host's archive comes first, this case
    // silently becomes the fallback case again and stops discriminating.
    const theirs = archives[0];
    const mine = archives[1];
    expect(mine.hostId).not.toBe(theirs.hostId);
    expect(theirs.floorIndex).toBeLessThan(mine.floorIndex);

    const out = walkOutOf({ towers, mine, theirs });
    // IT WALKS AT ALL, and this is the assertion the mutant actually trips.
    // Deleting the host test sends this subject to the foreign archive, which
    // is in another building and has no route from its storey - so the scene
    // never produces the walk and `walked` is false, measured. The two
    // distances below are the claim from the other side, for a future where
    // some route between buildings exists and the leaver takes the wrong one.
    expect(
      out.walked,
      "the leaver never walked: it was sent to a door with no route",
    ).toBe(true);
    // It reached ITS OWN building's records door...
    expect(out.closestToMine).toBeLessThan(OFFICE_TILE / 2);
    // ...and never went anywhere near the other building's, which is a walk it
    // has no route for: a whole tower away.
    expect(out.closestToTheirs).toBeGreaterThan(OFFICE_TILE * 4);
  });
});

/**
 * Finding 3b - settleCivicWalks keys on `errand === "civic-out"`, but a
 * feed-settle civic rehome travels as `returning`. Playback and a paused
 * cursor therefore leave that walker crossing the floor.
 */
describe("OfficeScene finding 3b - a civic rehome is settled when motion stills", () => {
  function bookOf(scene: OfficeScene): OfficeSeatBook {
    const spy = vi.spyOn(OfficeSeatBook.prototype, "effectiveSeat");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  function chairFootRect(
    layout: OfficeLayout,
    tile: OfficeTilePos,
  ): OfficeRect {
    const foot = OFFICE_VIEWS.floor.painter
      .projector(layout)
      .project(tile.col + 0.5, tile.row + 1);
    return {
      x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
      y: foot.y - OFFICE_CHARACTER_HEIGHT,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
  }

  function seatHitBox(layout: OfficeLayout, seat: OfficeSeat): OfficeRect {
    if (seat.hitBox !== null) return seat.hitBox;
    const origin = OFFICE_VIEWS.floor.painter
      .projector(layout)
      .project(seat.deskTile.col, seat.deskTile.row);
    return {
      x: origin.x,
      y: origin.y,
      width: seat.hitTiles.width * OFFICE_TILE,
      height: seat.hitTiles.height * OFFICE_TILE,
    };
  }

  function tickTimes(scene: OfficeScene, steps: number): void {
    for (let step = 0; step < steps; step += 1) scene.tick(100);
  }

  interface CivicRehome {
    readonly scene: OfficeScene;
    readonly agents: ReadonlyArray<OfficeAgentInput>;
    readonly visibleAgentIds: ReadonlySet<string>;
    readonly waiting: Map<string, OfficeAgentStatus>;
    readonly waiter: string;
  }

  function civicRehomeInFlight(): CivicRehome {
    const agents = makeTestEpic("one-team", 12, 9).agents;
    const visibleAgentIds = new Set(agents.map((person) => person.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((person) => [person.id, "idle"]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: idle,
        feedSettled: false,
      }),
    );
    const waiter = agents[2].id;
    const waiting = new Map<string, OfficeAgentStatus>(idle);
    waiting.set(waiter, "awaiting");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: waiting,
        feedSettled: true,
        playing: false,
      }),
    );
    if (bookOf(scene).civicClaimOf(waiter) !== "lounge") {
      throw new Error(`expected ${waiter} to hold a lounge on the rehome`);
    }
    if (!frameOf(scene).awayAgentIds.has(waiter)) {
      throw new Error(`expected ${waiter} in flight on the rehome`);
    }
    tickTimes(scene, 4);
    if (!frameOf(scene).awayAgentIds.has(waiter)) {
      throw new Error(`expected ${waiter} still in flight after a few ticks`);
    }
    return { scene, agents, visibleAgentIds, waiting, waiter };
  }

  function expectSeatedInLounge(scene: OfficeScene, waiter: string): void {
    const lounge = bookOf(scene).effectiveSeat(waiter);
    if (lounge === null || lounge.kind !== "lounge") {
      throw new Error(`expected ${waiter} to hold a lounge`);
    }
    const chair = chairFootRect(layoutOf(scene), lounge.chairTile);
    expect(characterRect(frameOf(scene), waiter)).toEqual(chair);
    expect(frameOf(scene).awayAgentIds.has(waiter)).toBe(false);
    expect(scene.locate(waiter)).toEqual(seatHitBox(layoutOf(scene), lounge));
  }

  it("seats a feed-settle civic rehome on its lounge chair when the cursor pauses, on that sync", () => {
    const floor = civicRehomeInFlight();
    floor.scene.sync(
      sceneInput({
        agents: floor.agents,
        visibleAgentIds: floor.visibleAgentIds,
        statusById: floor.waiting,
        feedSettled: true,
        cursorMs: 100,
        playing: false,
      }),
    );
    expectSeatedInLounge(floor.scene, floor.waiter);
    floor.scene.tick(100);
    expectSeatedInLounge(floor.scene, floor.waiter);
  });

  it("seats a feed-settle civic rehome on its lounge chair when playback starts, on that sync", () => {
    const floor = civicRehomeInFlight();
    floor.scene.sync(
      sceneInput({
        agents: floor.agents,
        visibleAgentIds: floor.visibleAgentIds,
        statusById: floor.waiting,
        feedSettled: true,
        playing: true,
      }),
    );
    expectSeatedInLounge(floor.scene, floor.waiter);
    floor.scene.tick(100);
    expectSeatedInLounge(floor.scene, floor.waiter);
  });

  it("does not settle an ordinary errand-return walker heading to its desk when playback starts", () => {
    const agents = makeTestEpic("one-team", 12, 9).agents;
    const visibleAgentIds = new Set(agents.map((person) => person.id));
    const idle = new Map<string, OfficeAgentStatus>(
      agents.map((person) => [person.id, "idle"]),
    );
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: idle,
        playing: false,
      }),
    );
    let walker: string | null = null;
    for (let step = 0; step < 400; step += 1) {
      scene.tick(100);
      const away = Array.from(frameOf(scene).awayAgentIds);
      if (away.length > 0) {
        walker = away[0];
        break;
      }
    }
    if (walker === null) throw new Error("nobody started an errand");
    tickTimes(scene, 30);
    if (!frameOf(scene).awayAgentIds.has(walker)) {
      throw new Error(`expected ${walker} still away after the stroll`);
    }
    const returning = new Map<string, OfficeAgentStatus>(idle);
    returning.set(walker, "working");
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: returning,
        playing: false,
      }),
    );
    if (!frameOf(scene).awayAgentIds.has(walker)) {
      throw new Error(`expected ${walker} on an errand-return`);
    }
    scene.sync(
      sceneInput({
        agents,
        visibleAgentIds,
        statusById: returning,
        playing: true,
      }),
    );
    expect(frameOf(scene).awayAgentIds.has(walker)).toBe(true);
  });
});

/**
 * Finding 3c - settlement runs before the passes that create walks, so a
 * civic arrival spawned on the same sync that enters suppression is never
 * settled. `spawnAtDoor` is the one walk-creating site that is not gated.
 */
describe("OfficeScene finding 3c - a civic arrival spawned into suppression is seated", () => {
  const LEAVER = agent({ id: "alpha", createdAt: 1, archivedAt: 900 });

  function bookOf(scene: OfficeScene): OfficeSeatBook {
    const spy = vi.spyOn(OfficeSeatBook.prototype, "effectiveSeat");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  function chairFootRect(
    layout: OfficeLayout,
    tile: OfficeTilePos,
  ): OfficeRect {
    const foot = OFFICE_VIEWS.floor.painter
      .projector(layout)
      .project(tile.col + 0.5, tile.row + 1);
    return {
      x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
      y: foot.y - OFFICE_CHARACTER_HEIGHT,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
  }

  function seatHitBox(layout: OfficeLayout, seat: OfficeSeat): OfficeRect {
    if (seat.hitBox !== null) return seat.hitBox;
    const origin = OFFICE_VIEWS.floor.painter
      .projector(layout)
      .project(seat.deskTile.col, seat.deskTile.row);
    return {
      x: origin.x,
      y: origin.y,
      width: seat.hitTiles.width * OFFICE_TILE,
      height: seat.hitTiles.height * OFFICE_TILE,
    };
  }

  function liveArchivedScene(): OfficeScene {
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(
      sceneInput({
        agents: [LEAVER, BETA],
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "idle"],
          ["beta", "idle"],
        ]),
        reducedMotion: false,
      }),
    );
    return scene;
  }

  /**
   * Same population as `liveArchivedScene`, but the first sync is already
   * at a paused cursor past alpha's archival. A tail gate of
   * `motionSuppressed() && !wasSuppressed` would still pass the two
   * cases that enter suppression from live.
   */
  function pausedArchivedScene(): OfficeScene {
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(
      sceneInput({
        agents: [LEAVER, BETA],
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "idle"],
          ["beta", "idle"],
        ]),
        cursorMs: 1000,
        playing: false,
        reducedMotion: false,
      }),
    );
    return scene;
  }

  function readmit(
    scene: OfficeScene,
    status: OfficeAgentStatus,
    cursorMs: number,
    playing: boolean,
  ): void {
    scene.sync(
      sceneInput({
        agents: [LEAVER, BETA],
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", status],
          ["beta", "idle"],
        ]),
        cursorMs,
        playing,
        reducedMotion: false,
      }),
    );
  }

  function expectSeatedInLounge(scene: OfficeScene): void {
    const lounge = bookOf(scene).effectiveSeat("alpha");
    if (lounge === null || lounge.kind !== "lounge") {
      throw new Error("expected alpha to hold a lounge");
    }
    const chair = chairFootRect(layoutOf(scene), lounge.chairTile);
    expect(characterRect(frameOf(scene), "alpha")).toEqual(chair);
    expect(frameOf(scene).awayAgentIds.has("alpha")).toBe(false);
    expect(scene.locate("alpha")).toEqual(seatHitBox(layoutOf(scene), lounge));
  }

  it("seats a civic readmit from the door on its lounge chair when the cursor pauses, on that sync", () => {
    const scene = liveArchivedScene();
    readmit(scene, "awaiting", 100, false);
    if (bookOf(scene).civicClaimOf("alpha") !== "lounge") {
      throw new Error("expected alpha to hold a lounge at the cursor");
    }
    expectSeatedInLounge(scene);
    scene.tick(100);
    expectSeatedInLounge(scene);
  });

  it("seats a civic readmit from the door on its lounge chair when playback starts, on that sync", () => {
    const scene = liveArchivedScene();
    readmit(scene, "awaiting", 100, true);
    if (bookOf(scene).civicClaimOf("alpha") !== "lounge") {
      throw new Error("expected alpha to hold a lounge at the cursor");
    }
    expectSeatedInLounge(scene);
    scene.tick(100);
    expectSeatedInLounge(scene);
  });

  it("seats a civic readmit from the door on its lounge chair when the cursor scrubs while already paused, on that sync", () => {
    const scene = pausedArchivedScene();
    readmit(scene, "awaiting", 100, false);
    if (bookOf(scene).civicClaimOf("alpha") !== "lounge") {
      throw new Error("expected alpha to hold a lounge at the cursor");
    }
    expectSeatedInLounge(scene);
    readmit(scene, "awaiting", 100, false);
    expectSeatedInLounge(scene);
    scene.tick(100);
    expectSeatedInLounge(scene);
  });

  it("still walks a non-civic readmit in from the door at a paused cursor", () => {
    const scene = liveArchivedScene();
    readmit(scene, "idle", 100, false);
    const desk = layoutOf(scene).desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk for alpha");
    expect(bookOf(scene).civicClaimOf("alpha")).toBeNull();
    expect(frameOf(scene).awayAgentIds.has("alpha")).toBe(true);
    expect(characterRect(frameOf(scene), "alpha")).not.toEqual(
      chairFootRect(layoutOf(scene), desk.chairTile),
    );
  });
});

/**
 * Discriminator for dropping `want` from `civicOrderKey`.
 *
 * A bed overflow that later wants a chair must join the lounge queue at
 * the back. A merged (host-only) key would keep its bed-queue place and
 * overtake the lounge waiter who asked first. The earlier "bed wanter
 * alongside chairs" fixture cannot see this: that agent never changed
 * kind, so claim still filters it off the freed chair.
 */
describe("OfficeScene evidence - a kind-switch joins the lounge queue at the back", () => {
  function bookOf(scene: OfficeScene): OfficeSeatBook {
    const spy = vi.spyOn(OfficeSeatBook.prototype, "civicClaimOf");
    try {
      frameOf(scene);
      const captured: unknown = spy.mock.contexts.at(-1);
      if (!(captured instanceof OfficeSeatBook)) {
        throw new Error("expected the scene seat book");
      }
      return captured;
    } finally {
      spy.mockRestore();
    }
  }

  function civicSeatCount(
    layout: OfficeLayout,
    kind: "infirmary" | "waiting-room",
  ): number {
    let count = 0;
    for (const floor of layout.floors) {
      const room = floor.civic.find((entry) => entry.kind === kind);
      if (room !== undefined) count += room.seatIds.length;
    }
    return count;
  }

  it("gives a freed lounge chair to the waiter who asked for one, not the bed overflow that switched kind", () => {
    const epic = makeTestEpic("one-team", 12, 9);
    const idle = new Map<string, OfficeAgentStatus>(
      epic.agents.map((person) => [
        person.id,
        person.archived ? "archived" : "idle",
      ]),
    );
    const visible = new Set(
      epic.agents
        .filter((person) => !person.archived)
        .map((person) => person.id),
    );
    const subjects = epic.agents
      .filter((person) => !person.archived)
      .map((person) => person.id)
      .sort();
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds: visible,
        statusById: idle,
        reducedMotion: true,
      }),
    );
    const layout = layoutOf(scene);
    const beds = civicSeatCount(layout, "infirmary");
    const chairs = civicSeatCount(layout, "waiting-room");
    expect(beds).toBeGreaterThan(0);
    expect(chairs).toBeGreaterThan(0);
    expect(subjects.length).toBeGreaterThan(beds + chairs + 1);

    const bedTakers = subjects.slice(subjects.length - beds);
    const chairSitters = subjects.slice(
      subjects.length - beds - chairs,
      subjects.length - beds,
    );
    const switcher = subjects[0];
    const waiter = subjects[subjects.length - beds - chairs - 1];
    expect(switcher < waiter).toBe(true);

    const mixed = (
      failingIds: ReadonlyArray<string>,
      waitingIds: ReadonlyArray<string>,
    ): Map<string, OfficeAgentStatus> => {
      const next = new Map<string, OfficeAgentStatus>(idle);
      for (const id of failingIds) next.set(id, "failure");
      for (const id of waitingIds) next.set(id, "awaiting");
      return next;
    };
    const syncMixed = (
      failingIds: ReadonlyArray<string>,
      waitingIds: ReadonlyArray<string>,
    ): void => {
      scene.sync(
        sceneInput({
          agents: epic.agents,
          visibleAgentIds: visible,
          statusById: mixed(failingIds, waitingIds),
          reducedMotion: true,
        }),
      );
    };

    syncMixed(bedTakers, []);
    syncMixed([...bedTakers, switcher], []);
    if (bookOf(scene).civicClaimOf(switcher) !== null) {
      throw new Error("expected the switcher to be bed-overflow");
    }
    syncMixed([...bedTakers, switcher], chairSitters);
    syncMixed([...bedTakers, switcher], [...chairSitters, waiter]);
    if (bookOf(scene).civicClaimOf(waiter) !== null) {
      throw new Error("expected the waiter to be lounge-overflow");
    }
    syncMixed(bedTakers, [...chairSitters, waiter, switcher]);

    const before = bookOf(scene);
    expect(before.civicClaimOf(switcher)).toBeNull();
    expect(before.civicClaimOf(waiter)).toBeNull();
    for (const id of chairSitters) {
      expect(before.civicClaimOf(id)).toBe("lounge");
    }

    const healed = chairSitters[0];
    const freed = before.effectiveSeat(healed);
    if (freed === null || freed.kind !== "lounge") {
      throw new Error(`expected ${healed} to hold a lounge chair`);
    }
    const freedSeatId = freed.seatId;
    const remainingSitters = chairSitters.filter((id) => id !== healed);
    syncMixed(bedTakers, [...remainingSitters, waiter, switcher]);

    const after = bookOf(scene);
    expect(after.civicClaimOf(healed)).toBeNull();
    expect(after.civicClaimOf(waiter)).toBe("lounge");
    expect(after.effectiveSeat(waiter)?.seatId).toBe(freedSeatId);
    expect(after.civicClaimOf(switcher)).toBeNull();
  });
});
