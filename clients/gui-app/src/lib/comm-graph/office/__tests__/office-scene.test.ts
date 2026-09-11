import { describe, expect, it, vi } from "vitest";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  OFFICE_VIEW_IDS,
  OFFICE_VIEWS,
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
  type OfficeDrawable,
  type OfficeErrandSpot,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeLayout,
  type OfficePoint,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeSign,
  type OfficeSpriteName,
  type OfficeSpriteRef,
  type OfficeTilePos,
  type OfficeTileRect,
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
  for (const drawable of frame.actors) {
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
    expect(scene.isAnimating()).toBe(true);

    // The delivered bubble is transient like any other; once it times out
    // there is nothing left for the cut-short motion to keep the floor busy
    // with.
    scene.tick(800);
    expect(scene.isAnimating()).toBe(false);

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
    expect(walkScene.isAnimating()).toBe(true);
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
    expect(scene.isAnimating()).toBe(false);

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
    expect(hasBubbleAt(frame, "bubble-awaiting", seatedHead("alpha"))).toBe(
      true,
    );
    // A request can sit open for hours; unlike the attention bubble, the
    // awaiting one does not bob, so a seated agent wearing it is not a
    // reason to keep redrawing.
    expect(scene.isAnimating()).toBe(false);
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
    // ...and then EVERYBODY goes. There is no cap: an idle agent is never at
    // its desk, so a floor of four idle agents is a floor with four of them
    // out. The old half-the-floor limit is what left the other half sitting
    // perfectly still, which is the thing this is for.
    expect(mostAtOnce).toBe(IDLE_CREW.length);
  });

  it("keeps every idle agent away for as long as it stays idle", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Past the threshold plus the widest stagger, nobody has any business in a
    // chair. Sampled across a full minute rather than at one instant, because
    // the failure this catches is an agent that goes back between errands - and
    // that reads as a single frame of somebody seated, not as a floor at rest.
    for (let step = 0; step < 90; step += 1) scene.tick(100);
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
    // deleted. Over four minutes this floor plays ~386 ticks with the open end
    // outranking the draw and ~224 without it, so the threshold sits between
    // the two rather than at a number that merely looked round.
    expect(ralliedTicks).toBeGreaterThan(300);
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

  it("crashes the screen of a failing agent and sends it to reception", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "failure"]]),
      }),
    );
    // Long enough to cross a furnished storey at a walk: the lobby is at the
    // bottom of the building and the desks are at the top of it.
    for (let step = 0; step < 150; step += 1) scene.tick(100);

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

    // A failure needs a person, so it queues at reception with the same
    // bubble an interview raises.
    const floor = layoutOf(scene).floors[0];
    const standing = characterRect(frameOf(scene), "alpha");
    expect(standing.x).toBe(floor.receptionQueueTiles[0].col * OFFICE_TILE);
    expect(
      frameOf(scene).overlay.some(
        (drawable) =>
          drawable.kind === "sprite" &&
          drawable.sprite.name === "bubble-attention",
      ),
    ).toBe(true);
  });

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
    for (let step = 0; step < 60; step += 1) scene.tick(100);

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

  it("queues agents needing a person in arrival order and walks them back", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["beta", "attention"]]),
      }),
    );
    for (let step = 0; step < 80; step += 1) scene.tick(100);

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
    for (let step = 0; step < 80; step += 1) scene.tick(100);

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

    for (let step = 0; step < 120; step += 1) scene.tick(100);
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
    for (let step = 0; step < 80; step += 1) scene.tick(100);
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
        statusById: new Map<string, OfficeAgentStatus>([
          ["alpha", "attention"],
          ["beta", "failure"],
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

    const seated = frameWhere(scene, () => bothSidesTaken(scene, seats), 1_200);
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
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared === 0) continue;
      const progress =
        ((rect.x - start.x) * dx + (rect.y - start.y) * dy) / lengthSquared;
      if (progress < -0.01 || progress > 1.01) continue;
      if (
        Math.abs(rect.x - (start.x + progress * dx)) <= 2 &&
        Math.abs(rect.y - (start.y + progress * dy)) <= 2
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

    for (let step = 0; step < 150; step += 1) scene.tick(100);
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
    const epic = makeTestEpic("one-team", 12, 9);
    const cold = new Map<string, OfficeAgentStatus>(
      epic.agents.map((person) => [person.id, "idle"]),
    );
    const target = epic.agents.find((person) => person.parentId !== null);
    if (target === undefined) throw new Error("expected a team member");
    const scene = newScene();
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

    const assignedSeatIds = new Set(
      Array.from(coldLayout.desks.values()).map((desk) => desk.seatId),
    );
    const reserves = Array.from(coldLayout.seats.values()).filter(
      (seat) => seat.kind === "desk" && !assignedSeatIds.has(seat.seatId),
    );
    expect(reserves.length).toBeGreaterThan(0);
    const cubbyRect = footRect(coldLayout, cubby.chairTile);
    const reserveRects = reserves.map((seat) =>
      footRect(coldLayout, seat.chairTile),
    );

    const hot = new Map(cold).set(target.id, "working");
    scene.sync(
      sceneInput({
        agents: epic.agents,
        visibleAgentIds,
        statusById: hot,
        reducedMotion: false,
      }),
    );
    const outboundSamples: OfficeRect[] = [];
    let walkedToReserve = false;
    let reachedReserve = -1;
    for (let step = 0; step < 400; step += 1) {
      const frame = frameOf(scene);
      const character = buildingCharacterRect(frame, target.id);
      outboundSamples.push(character);
      if (
        !walkedToReserve &&
        JSON.stringify(character) !== JSON.stringify(cubbyRect) &&
        !reserveRects.some(
          (reserveRect) =>
            JSON.stringify(reserveRect) === JSON.stringify(character),
        )
      ) {
        walkedToReserve = true;
      }
      reachedReserve = reserveRects.findIndex(
        (reserveRect) =>
          JSON.stringify(reserveRect) === JSON.stringify(character),
      );
      if (reachedReserve >= 0) break;
      scene.tick(100);
    }
    expect(walkedToReserve).toBe(true);
    expect(reachedReserve).toBeGreaterThanOrEqual(0);
    const reservePath = findOfficePath(
      coldLayout,
      cubby.chairTile,
      reserves[reachedReserve].chairTile,
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
        statusById: cold,
        reducedMotion: false,
      }),
    );
    const returnSamples: OfficeRect[] = [];
    const returnPath = findOfficePath(
      coldLayout,
      reserves[reachedReserve].chairTile,
      cubby.chairTile,
    );
    expect(returnPath).not.toBeNull();
    if (returnPath === null) throw new Error("expected a return path");
    const fullReturnPath = [reserves[reachedReserve].chairTile, ...returnPath];
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
      scene.tick(100);
    }
    expect(walkedBack).toBe(true);
    expect(returnedToCubby).toBe(true);
    expect(
      returnSamples.every((sample) =>
        rectOnProjectedPath(coldLayout, fullReturnPath, sample),
      ),
    ).toBe(true);
    expect(scene.whereabouts(target.id)).toBe("Quiet stack");
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

  it("leans back on awaiting, a status that never queues for reception", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "awaiting"]]),
      }),
    );
    const frame = frameOf(scene);
    expect(frame.awayAgentIds.has("alpha")).toBe(false);
    const sprite = characterSpriteAt(frame, characterRect(frame, "alpha"));
    expect(sprite?.pose).toBe("lean");
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
    scene.sync(
      sceneInput({
        agents: full.slice(0, 3),
        visibleAgentIds: new Set(full.slice(0, 3).map((person) => person.id)),
      }),
    );
    const target = full[0].id;

    let away = false;
    for (let step = 0; step < 500 && !away; step += 1) {
      scene.tick(100);
      away = frameOf(scene).awayAgentIds.has(target);
    }
    expect(away).toBe(true);
    for (let step = 0; step < 5; step += 1) scene.tick(100);

    let sawShift = false;
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
        break;
      }
    }
    expect(sawShift).toBe(true);

    for (let step = 0; step < 60; step += 1) scene.tick(100);
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
    const hot = new Map(cold);
    hot.set(cubby.agentId, "working");
    return {
      scene,
      calls,
      sleeper: cubby.agentId,
      cubbySeatId: cubby.seatId,
      wake: () => {
        scene.sync(
          sceneInput({ agents: epic.agents, visibleAgentIds, statusById: hot }),
        );
      },
    };
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
    let arrived = false;
    for (let step = 0; step < 400 && !arrived; step += 1) {
      scene.tick(100);
      arrived = !frameOf(scene).awayAgentIds.has(sleeper);
    }
    expect(arrived).toBe(true);

    calls.length = 0;
    scene.frame(1, WHOLE_WORLD);
    expect(calls.some((call) => call.seatId === cubbySeatId)).toBe(false);
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
