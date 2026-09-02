import { describe, expect, it } from "vitest";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeAppearance,
  type OfficeDrawable,
  type OfficeFrame,
  type OfficeLayout,
  type OfficePoint,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSpriteName,
  type OfficeSpriteRef,
  type OfficeTilePos,
} from "@/lib/comm-graph/office/office-types";

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
  return {
    statusById: new Map<string, OfficeAgentStatus>(),
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

function seatedHead(agentId: string): OfficePoint {
  const desk = layoutOffice(AGENTS).desks.get(agentId);
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

function crewSeatedRect(agentId: string): OfficeRect {
  const desk = layoutOffice(IDLE_CREW).desks.get(agentId);
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
  for (const region of scene.frame().hitRegions) {
    if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
    const desk = scene.layout().desks.get(region.agentId);
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
  const floor = scene.layout().floors[0];
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
 * Every cafeteria doorway on the plan. The door is not carried as a field: it
 * is the one tile of the room's wall ring the grid still says is walkable,
 * which is exactly what the scene paints it from.
 */
function cafeteriaDoorKeys(layout: OfficeLayout): ReadonlyArray<string> {
  const keys: string[] = [];
  for (const entry of layout.floors) {
    const room = entry.cafeteria;
    if (room === null) continue;
    const right = room.col + room.cols - 1;
    const bottom = room.row + room.rows - 1;
    for (let row = room.row; row <= bottom; row += 1) {
      for (let col = room.col; col <= right; col += 1) {
        const onRing =
          row === room.row ||
          row === bottom ||
          col === room.col ||
          col === right;
        if (!onRing || !layout.walkable[row][col]) continue;
        keys.push(`${col},${row}`);
      }
    }
  }
  return keys;
}

/** The agent whose desk this tile is the aisle seat under, if any. */
function hostDeskAt(scene: OfficeScene, tile: OfficeTilePos): string | null {
  for (const desk of scene.layout().desks.values()) {
    if (desk.chairTile.col !== tile.col) continue;
    if (desk.chairTile.row + 1 !== tile.row) continue;
    return desk.agentId;
  }
  return null;
}

/** Which cabin an agent's desk stands in, by that cabin's root. */
function cabinOf(scene: OfficeScene, agentId: string): string | null {
  const desk = scene.layout().desks.get(agentId);
  if (desk === undefined) return null;
  for (const room of scene.layout().rooms) {
    const { col, row, cols, rows } = room.bounds;
    if (desk.deskTile.col < col || desk.deskTile.col >= col + cols) continue;
    if (desk.deskTile.row < row || desk.deskTile.row >= row + rows) continue;
    return room.rootAgentId;
  }
  return null;
}

function headOfRegion(scene: OfficeScene, agentId: string): OfficePoint | null {
  for (const region of scene.frame().hitRegions) {
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));

    const frame = scene.frame();
    expect(characterRect(frame, "alpha")).toEqual(seatedRect("alpha"));
    expect(characterRect(frame, "beta")).toEqual(seatedRect("beta"));
    expect(frame.size).toEqual({
      width: scene.layout().cols * OFFICE_TILE,
      height: scene.layout().rows * OFFICE_TILE,
    });
  });

  it("walks a new agent in from the door on its created pulse", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: CREATED_PULSE,
        pulseKey: "created-beta",
      }),
    );

    const door = scene.layout().doorTile;
    const entering = characterRect(scene.frame(), "beta");
    expect(entering.x).toBe(door.col * OFFICE_TILE);
    expect(entering.y).toBe(door.row * OFFICE_TILE - 4);

    // Three tiles a second, from the entrance through its cabin's own door;
    // six seconds is comfortably past the longest route on this floor.
    for (let step = 0; step < 60; step += 1) scene.tick(100);
    expect(characterRect(scene.frame(), "beta")).toEqual(seatedRect("beta"));
  });

  it("seats a late arrival silently when the timeline is scrubbed", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));
    // Not playing, and the cursor is not sitting on beta's creation - this is
    // the floor being restated, not a reveal.
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));

    expect(characterRect(scene.frame(), "beta")).toEqual(seatedRect("beta"));
  });

  it("removes a character the moment it leaves the visible set", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: ALPHA_ONLY }));

    const frame = scene.frame();
    expect(hasCharacter(frame, "alpha")).toBe(true);
    expect(hasCharacter(frame, "beta")).toBe(false);
  });

  it("spawns exactly one envelope per pulse key and delivers it", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const withPulse = sceneInput({
      agents: AGENTS,
      visibleAgentIds: BOTH,
      pulse: REQUEST_PULSE,
      pulseKey: "row-1",
    });

    scene.sync(withPulse);
    expect(envelopes(scene.frame())).toHaveLength(1);
    // The same row re-supplied across frames must not spawn a second envelope.
    scene.sync(withPulse);
    expect(envelopes(scene.frame())).toHaveLength(1);

    const launched = envelopes(scene.frame())[0];
    expect(launched.pulseKind).toBe("request");
    expect(launched.progress).toBe(0);
    expect(launched.x).toBe(seatedHead("alpha").x);

    scene.tick(300);
    expect(envelopes(scene.frame())).toHaveLength(1);

    scene.tick(400);
    const arrived = scene.frame();
    expect(envelopes(arrived)).toHaveLength(0);
    expect(hasBubbleAt(arrived, "bubble-hello", seatedHead("beta"))).toBe(true);
  });

  it("arcs the envelope above the straight line between the two heads", () => {
    const scene = new OfficeScene(layoutOffice);
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

    const midpoint = envelopes(scene.frame())[0];
    // Both heads sit at the same height, so any lift is the arc alone.
    expect(seatedHead("alpha").y).toBe(seatedHead("beta").y);
    expect(midpoint.y).toBeLessThan(seatedHead("alpha").y);
  });

  it("delivers without a flight when motion is reduced", () => {
    const scene = new OfficeScene(layoutOffice);
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

    const frame = scene.frame();
    expect(envelopes(frame)).toHaveLength(0);
    // Still perceivable: the acknowledgement outlives several frames.
    expect(hasBubbleAt(frame, "bubble-hello", seatedHead("beta"))).toBe(true);
  });

  it("bubbles a standing status when nothing transient is showing", () => {
    const scene = new OfficeScene(layoutOffice);
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

    const frame = scene.frame();
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

  it("finds a character first and its desk second under a point", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));

    const seated = seatedRect("alpha");
    expect(scene.hitTest({ x: seated.x + 8, y: seated.y + 10 })).toBe("alpha");

    const desk = scene.layout().desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk");
    // The desk's right tile is clear of the character box above the chair.
    expect(
      scene.hitTest({
        x: (desk.deskTile.col + 1) * OFFICE_TILE + 8,
        y: desk.deskTile.row * OFFICE_TILE + 4,
      }),
    ).toBe("alpha");

    const lobby = scene.layout().lobbyTile;
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: [longName, BETA], visibleAgentIds: BOTH }));

    const labels: string[] = [];
    for (const drawable of scene.frame().actors) {
      if (drawable.kind === "label") labels.push(drawable.text);
    }
    expect(labels).toHaveLength(2);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(14);
    expect(labels.some((label) => label.endsWith("…"))).toBe(true);
  });

  it("stands every prop on its tile rather than over the row below", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const frame = scene.frame();
    const drawn = [...frame.floor, ...frame.props];

    // Asserted as the invariant, not as the offset formula: whatever the art
    // decides a prop's height is, its FOOT belongs on the tile it occupies.
    for (const prop of scene.layout().props) {
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    const layout = scene.layout();

    const rug = scene
      .frame()
      .floor.find(
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: family, visibleAgentIds: BOTH }));

    const frame = scene.frame();
    const room = scene.layout().rooms[0];
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

    const sign = sprites(frame.props, "sign")[0];
    expect(sign).toBeDefined();
    expect(sign.x).toBe(room.signTile.col * OFFICE_TILE);

    const roomLabel = labels(frame.props)[0];
    expect(roomLabel).toBeDefined();
    // Centred on the sign, sitting on its face, and short enough to fit it.
    expect(roomLabel.x).toBe(
      sign.x + officeSpriteSize({ name: "sign" }).width / 2,
    );
    expect(roomLabel.y).toBeGreaterThan(sign.y);
    expect(roomLabel.y).toBeLessThan(
      sign.y + officeSpriteSize({ name: "sign" }).height,
    );
    expect(roomLabel.tone).toBe("bright");
    expect(roomLabel.text.length).toBeLessThanOrEqual(12);
    expect(roomLabel.text.endsWith("…")).toBe(true);
  });

  it("plates every desk and badges only the agents that carry a harness", () => {
    const badged = agent({ id: "alpha", createdAt: 1, harnessId: "traycer" });
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: [badged, BETA], visibleAgentIds: BOTH }));

    const frame = scene.frame();
    expect(sprites(frame.props, "nameplate")).toHaveLength(2);

    const badges = logos(frame.props);
    expect(badges).toHaveLength(1);
    expect(badges[0].harnessId).toBe("traycer");
    expect(badges[0].alpha).toBeUndefined();

    // The plate is on the desk it belongs to, and the badge is on the plate.
    const desk = scene.layout().desks.get("alpha");
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(
      sceneInput({
        agents: [badged, BETA],
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "archived"]]),
      }),
    );

    const frame = scene.frame();
    // Nobody watched this one leave, so there is no walk to play - just the
    // desk it left behind.
    expect(hasCharacter(frame, "alpha")).toBe(false);
    expect(sprites(frame.props, "dust-sheet")).toHaveLength(1);
    expect(sprites(frame.props, "box")).toHaveLength(1);
    // One plate, one screen, one badge - and all of them beta's.
    expect(logos(frame.props)).toHaveLength(0);
    expect(sprites(frame.props, "nameplate")).toHaveLength(1);
    expect(sprites(frame.props, "monitor-on")).toHaveLength(1);

    const desk = scene.layout().desks.get("alpha");
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
    const scene = new OfficeScene(layoutOffice);
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
      const frame = scene.frame();
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
    const scene = new OfficeScene(layoutOffice);
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

    const frame = scene.frame();
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
    expect(scene.frame().envelopeHitRegions).toHaveLength(0);
    expect(scene.hitTestEnvelope({ x: flying.x, y: flying.y })).toBeNull();
  });

  it("sends an idle agent on an errand, but not before it has been idle", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    let firstBreakMs: number | null = null;
    let mostAtOnce = 0;
    let elapsedMs = 0;
    while (elapsedMs < 60_000) {
      scene.tick(100);
      elapsedMs += 100;
      const away = crewAway(scene.frame());
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Past the threshold plus the widest stagger, nobody has any business in a
    // chair. Sampled across a full minute rather than at one instant, because
    // the failure this catches is an agent that goes back between errands - and
    // that reads as a single frame of somebody seated, not as a floor at rest.
    for (let step = 0; step < 90; step += 1) scene.tick(100);
    let seatedFrames = 0;
    for (let step = 0; step < 600; step += 1) {
      scene.tick(100);
      const away = new Set(crewAway(scene.frame()));
      for (const person of IDLE_CREW) {
        if (!away.has(person.id)) seatedFrames += 1;
      }
    }
    expect(seatedFrames).toBe(0);
  });

  it("chains one errand into the next without going back to the desk", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Every spot alpha comes to a stop on, with the kind the plan gives it.
    const byTile = new Map<string, string>();
    for (const spot of scene.layout().floors[0].errandSpots) {
      byTile.set(`${spot.tile.col},${spot.tile.row}`, spot.kind);
    }
    const kinds: string[] = [];
    let previous = characterRect(scene.frame(), "alpha");
    let moving = true;
    for (let step = 0; step < 2_000; step += 1) {
      scene.tick(100);
      const rect = characterRect(scene.frame(), "alpha");
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
    const scene = new OfficeScene(oneSpot);
    scene.sync(sceneInput({ agents: crowd, visibleAgentIds: ids }));

    for (let step = 0; step < 200; step += 1) scene.tick(100);
    const away = new Set<string>();
    let sat = 0;
    for (let step = 0; step < 300; step += 1) {
      scene.tick(100);
      const frame = scene.frame();
      for (const region of frame.hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        const desk = scene.layout().desks.get(region.agentId);
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Where alpha actually stands, sampled over enough errands that a single
    // destination would have to be the rule rather than a coincidence.
    const spots = new Set(
      scene
        .layout()
        .floors[0].errandSpots.map(
          (spot) => `${spot.tile.col},${spot.tile.row}`,
        ),
    );
    // Every place alpha came to a STOP, in order. A position that repeats
    // across ticks is a linger; anything moving is a tile on the way.
    const visited: string[] = [];
    let previous = characterRect(scene.frame(), "alpha");
    let moving = true;
    for (let step = 0; step < 3_000; step += 1) {
      scene.tick(100);
      const rect = characterRect(scene.frame(), "alpha");
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: crowd, visibleAgentIds: ids }));

    for (let step = 0; step < 2_000; step += 1) {
      scene.tick(100);
      const occupied = new Map<string, string>();
      for (const region of scene.frame().hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        const desk = scene.layout().desks.get(region.agentId);
        if (desk === undefined) continue;
        // Two people in the same chair is impossible; two people on the same
        // errand spot is what the claim exists to prevent.
        if (region.rect.x === desk.chairTile.col * OFFICE_TILE) continue;
        const key = `${region.rect.x},${region.rect.y}`;
        const holder = occupied.get(key);
        expect(holder, `${holder} and ${region.agentId} share ${key}`).toBe(
          undefined,
        );
        occupied.set(key, region.agentId);
      }
    }
  });

  it("throws paper at the bin, misses some of it, and stops throwing", () => {
    const scene = new OfficeScene(onlyKinds(["bin"]));
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Where the bins actually are, so a ball can be shown to be aimed at one
    // rather than merely to exist.
    const bins = scene
      .layout()
      .props.filter((prop) => prop.sprite.name === "bin");
    expect(bins.length).toBeGreaterThan(0);

    let thrown = 0;
    let flew = false;
    let rested = 0;
    let previous: ReadonlyArray<OfficeSpriteDrawable> = [];
    for (let step = 0; step < 900; step += 1) {
      scene.tick(100);
      const balls = paperBalls(scene.frame());
      if (balls.length > previous.length) thrown += balls.length;
      for (const ball of balls) {
        // In the air: no two frames of a flight share a position.
        if (
          previous.some(
            (before) => before.x !== ball.x && before.y === ball.y,
          ) ||
          previous.some((before) => before.x === ball.x && before.y !== ball.y)
        ) {
          flew = true;
        }
        // On the floor: a miss holds one position while it lies there.
        if (
          previous.some((before) => before.x === ball.x && before.y === ball.y)
        ) {
          rested += 1;
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
      quiet = paperBalls(scene.frame()).length === 0 ? quiet + 1 : 0;
    }
    expect(quiet).toBeGreaterThanOrEqual(20);
  });

  it("waters a cabin plant with a can and sparkles it at the end", () => {
    const scene = new OfficeScene(onlyKinds(["water-plant"]));
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    const plants = new Set(
      scene
        .layout()
        .props.filter((prop) => prop.sprite.name === "plant")
        .map((prop) => `${prop.tile.col},${prop.tile.row}`),
    );
    let cans = 0;
    let sparkledPlants = 0;
    for (let step = 0; step < 600; step += 1) {
      scene.tick(100);
      const frame = scene.frame();
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
    const scene = new OfficeScene(onlyKinds(["sofa"]));
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    const seats = scene
      .layout()
      .floors[0].errandSpots.filter((spot) => spot.kind === "sofa");
    expect(seats).toHaveLength(2);

    let sat = false;
    let dozed = false;
    for (let step = 0; step < 900 && !(sat && dozed); step += 1) {
      scene.tick(100);
      const frame = scene.frame();
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
    const scene = new OfficeScene(onlyKinds(["peek"]));
    scene.sync(sceneInput({ agents: families, visibleAgentIds: ids }));

    // Each peek tile belongs to the cabin whose door is the tile above it.
    const doorOwners = new Map<string, string>();
    for (const room of scene.layout().rooms) {
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
    const scene = new OfficeScene(layoutOffice);
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
      const frame = scene.frame();
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // Errands move two people at a time. Without the desk fillers the other
    // half of the floor is a still image, which is the whole complaint.
    const poses = new Set<string>();
    for (let step = 0; step < 400; step += 1) {
      scene.tick(50);
      for (const region of scene.frame().hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        const seated = crewSeatedRect(region.agentId);
        if (region.rect.x !== seated.x || region.rect.y !== seated.y) continue;
        const sprite = characterSpriteAt(scene.frame(), region.rect);
        if (sprite === null) continue;
        poses.add(`${sprite.pose ?? ""}/${sprite.facing ?? ""}`);
      }
    }
    // Sitting, and at least one filler turning the body away from the screen.
    expect(poses.has("sit/up")).toBe(true);
    expect([...poses].some((key) => key.startsWith("stand/"))).toBe(true);
  });

  it("runs no desk filler while an agent is away on an errand", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));

    // The sofa is the one place off a desk where sitting is the activity, so
    // it is the one place `sit` does not mean a filler leaked onto the floor.
    const sofaKeys = new Set(
      scene
        .layout()
        .floors[0].errandSpots.filter((spot) => spot.kind === "sofa")
        .map((spot) => `${spot.tile.col},${spot.tile.row}`),
    );
    expect(sofaKeys.size).toBeGreaterThan(0);

    for (let step = 0; step < 1_500; step += 1) {
      scene.tick(100);
      const frame = scene.frame();
      for (const region of frame.hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        const seated = crewSeatedRect(region.agentId);
        if (region.rect.x === seated.x && region.rect.y === seated.y) continue;
        const key = `${region.rect.x / OFFICE_TILE},${(region.rect.y + 4) / OFFICE_TILE}`;
        if (sofaKeys.has(key)) continue;
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
    const scene = new OfficeScene(spotless);
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
    expect(scene.layout().rooms).toHaveLength(2);
  });

  it("drops an errand the instant a message is in the air", () => {
    const scene = new OfficeScene(layoutOffice);
    const idle = sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS });
    scene.sync(idle);

    // Wait for somebody to be not just away but SETTLED at a spot: an agent
    // that was mid-walk anyway would prove nothing about the linger ending.
    let lingering: string | null = null;
    let previous = new Map<string, string>();
    for (let step = 0; step < 400 && lingering === null; step += 1) {
      scene.tick(100);
      const here = new Map<string, string>();
      for (const region of scene.frame().hitRegions) {
        if (region.rect.height !== OFFICE_CHARACTER_HEIGHT) continue;
        here.set(region.agentId, `${region.rect.x},${region.rect.y}`);
      }
      for (const agentId of crewAway(scene.frame())) {
        if (previous.get(agentId) === here.get(agentId)) lingering = agentId;
      }
      previous = here;
    }
    if (lingering === null) throw new Error("nobody settled at a spot");
    const parked = characterRect(scene.frame(), lingering);

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
    let previousRect = characterRect(scene.frame(), lingering);
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
      const rect = characterRect(scene.frame(), lingering);
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
      const scene = new OfficeScene(layoutOffice);
      scene.sync(sceneInput({ agents: IDLE_CREW, visibleAgentIds: CREW_IDS }));
      const frames: string[] = [];
      for (let step = 0; step < 600; step += 1) {
        scene.tick(100);
        if (step % 7 === 0) frames.push(JSON.stringify(scene.frame()));
      }
      return frames;
    };

    const first = run();
    expect(first.length).toBeGreaterThan(0);
    expect(run()).toEqual(first);
  });

  it("never breaks during playback", () => {
    const scene = new OfficeScene(layoutOffice);
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
      expect(crewAway(scene.frame())).toEqual([]);
    }
  });

  it("sends a wanderer straight back when its status changes", () => {
    const scene = new OfficeScene(layoutOffice);
    const idle = sceneInput({
      agents: IDLE_CREW,
      visibleAgentIds: CREW_IDS,
    });
    scene.sync(idle);

    let away: ReadonlyArray<string> = [];
    for (let step = 0; step < 600 && away.length === 0; step += 1) {
      scene.tick(100);
      away = crewAway(scene.frame());
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

    expect(crewAway(scene.frame())).not.toContain(busy);
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(
      sceneInput({
        agents: crowd,
        visibleAgentIds: new Set(crowd.map((person) => person.id)),
      }),
    );
    const layout = scene.layout();
    expect(layout.rooms).toHaveLength(3);

    // The floor layer is painted in order, so the LAST tile-aligned sprite at
    // a position is the one a viewer actually sees. (The rug is centred on its
    // tile, so it is not tile-aligned and never masks the floor under it.)
    const painted = new Map<string, OfficeSpriteName>();
    for (const drawable of scene.frame().floor) {
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
    for (const key of cafeteriaDoorKeys(layout)) doorways.add(key);
    for (let row = 0; row < layout.rows; row += 1) {
      for (let col = 0; col < layout.cols; col += 1) {
        if (!layout.walkable[row][col]) continue;
        const key = `${col},${row}`;
        if (doorways.has(key)) {
          expect(painted.get(key), key).toBe("door");
          continue;
        }
        // Somewhere a character can stand must look like somewhere a character
        // can stand - a corridor painted as brick reads as a sealed room.
        expect(painted.get(key), key).toMatch(/^floor-[ab]$/);
      }
    }
  });

  it("crashes the screen of a failing agent and sends it to reception", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "failure"]]),
      }),
    );
    for (let step = 0; step < 60; step += 1) scene.tick(100);

    const frame = scene.frame();
    const crashed = sprites(frame.props, "monitor-crash");
    expect(crashed).toHaveLength(1);
    // Static: no alternate frame, and never dimmed the way an idle screen is.
    expect(crashed[0].alpha).toBeUndefined();
    const desk = scene.layout().desks.get("alpha");
    if (desk === undefined) throw new Error("expected a desk");
    expect(crashed[0].x).toBe(desk.deskTile.col * OFFICE_TILE + 3);
    scene.tick(260);
    expect(sprites(scene.frame().props, "monitor-crash")).toHaveLength(1);

    // A failure needs a person, so it queues at reception with the same
    // bubble an interview raises.
    const floor = scene.layout().floors[0];
    const standing = characterRect(scene.frame(), "alpha");
    expect(standing.x).toBe(floor.receptionQueueTiles[0].col * OFFICE_TILE);
    expect(
      scene
        .frame()
        .overlay.some(
          (drawable) =>
            drawable.kind === "sprite" &&
            drawable.sprite.name === "bubble-attention",
        ),
    ).toBe(true);
  });

  it("clears the crash and walks the agent back when the failure resolves", () => {
    const scene = new OfficeScene(layoutOffice);
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

    const frame = scene.frame();
    expect(sprites(frame.props, "monitor-crash")).toHaveLength(0);
    expect(characterRect(frame, "alpha")).toEqual(seatedRect("alpha"));
  });

  it("gives each model tier its own screen at its own offset", () => {
    const crew = [
      agent({ id: "alpha", createdAt: 1, modelTier: "small" }),
      agent({ id: "beta", createdAt: 2, modelTier: "large" }),
    ];
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: crew, visibleAgentIds: BOTH }));

    const frame = scene.frame();
    expect(sprites(frame.props, "monitor-small-on")).toHaveLength(1);
    expect(sprites(frame.props, "monitor-wide-on")).toHaveLength(1);
    expect(sprites(frame.props, "monitor-on")).toHaveLength(0);

    const laptopDesk = scene.layout().desks.get("alpha");
    const wideDesk = scene.layout().desks.get("beta");
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
    const scene = new OfficeScene(layoutOffice);
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
      for (const drawable of scene.frame().props) {
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
    const scene = new OfficeScene(layoutOffice);
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

    const frame = scene.frame();
    expect(sprites(frame.props, "envelope-stack-1")).toHaveLength(1);
    expect(sprites(frame.props, "envelope-stack-2")).toHaveLength(1);
    // Nine is still one pile; the tallest sprite is where the art stops.
    expect(sprites(frame.props, "envelope-stack-3")).toHaveLength(1);

    const desk = scene.layout().desks.get("alpha");
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(
      sceneInput({ agents: AGENTS, visibleAgentIds: BOTH, clockMs: 42_000 }),
    );

    const frame = scene.frame();
    const clocks: Array<Extract<OfficeDrawable, { kind: "clock" }>> = [];
    for (const drawable of frame.overlay) {
      if (drawable.kind === "clock") clocks.push(drawable);
    }
    expect(clocks).toHaveLength(scene.layout().floors.length);
    expect(clocks[0].timeMs).toBe(42_000);

    const face = sprites(frame.props, "clock")[0];
    expect(face).toBeDefined();
    const size = officeSpriteSize({ name: "clock" });
    // CENTER anchored on the face the prop just drew.
    expect(clocks[0].x).toBe(face.x + size.width / 2);
    expect(clocks[0].y).toBe(face.y + size.height / 2);
  });

  it("queues agents needing a person in arrival order and walks them back", () => {
    const scene = new OfficeScene(layoutOffice);
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["beta", "attention"]]),
      }),
    );
    for (let step = 0; step < 80; step += 1) scene.tick(100);

    const floor = scene.layout().floors[0];
    // Beta needed a person first, so it holds the nearest slot even once
    // alpha joins the queue behind it.
    expect(characterRect(scene.frame(), "beta").x).toBe(
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

    const queued = scene.frame();
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
      const frame = scene.frame();
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
    const scene = new OfficeScene(layoutOffice);
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

    const layout = scene.layout();
    const slots = layout.floors[0].receptionQueueTiles;
    const slotKeys = new Set(slots.map((tile) => `${tile.col},${tile.row}`));
    let standing = 0;
    for (const region of scene.frame().hitRegions) {
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(live);
    expect(characterRect(scene.frame(), "alpha")).toEqual(seatedRect("alpha"));

    scene.sync(
      sceneInput({
        agents: [leaver, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 900,
      }),
    );
    // On its feet and heading for the door, not simply switched off in place.
    scene.tick(400);
    expect(characterRect(scene.frame(), "alpha")).not.toEqual(
      seatedRect("alpha"),
    );
    expect(hasCharacter(scene.frame(), "alpha")).toBe(true);

    for (let step = 0; step < 120; step += 1) scene.tick(100);
    const gone = scene.frame();
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
    const returning = scene.frame();
    expect(sprites(returning.props, "dust-sheet")).toHaveLength(0);
    expect(characterRect(returning, "alpha").y).toBe(
      scene.layout().floors[0].doorTile.row * OFFICE_TILE - 4,
    );
    // The walk in ends at the chair. It does not STAY there - an idle agent is
    // never at its desk for long - so what is asserted is that the return
    // completes, not where the character is a dozen seconds later.
    let arrived = false;
    for (let step = 0; step < 120 && !arrived; step += 1) {
      scene.tick(100);
      arrived =
        JSON.stringify(characterRect(scene.frame(), "alpha")) ===
        JSON.stringify(seatedRect("alpha"));
    }
    expect(arrived).toBe(true);
  });

  it("sheets an archived desk with no walk at all when motion is reduced", () => {
    const leaver = agent({ id: "alpha", createdAt: 1, archivedAt: 500 });
    const scene = new OfficeScene(layoutOffice);
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

    const frame = scene.frame();
    expect(hasCharacter(frame, "alpha")).toBe(false);
    expect(sprites(frame.props, "dust-sheet")).toHaveLength(1);
  });

  it("keeps an agent archived only in the future at its desk", () => {
    const later = agent({ id: "alpha", createdAt: 1, archivedAt: 5_000 });
    const scene = new OfficeScene(layoutOffice);
    scene.sync(
      sceneInput({
        agents: [later, BETA],
        visibleAgentIds: BOTH,
        cursorMs: 1_000,
      }),
    );

    // The record says archived; the cursor says not yet, and the floor shows
    // the moment the cursor is on.
    expect(sprites(scene.frame().props, "dust-sheet")).toHaveLength(0);
    expect(characterRect(scene.frame(), "alpha")).toEqual(seatedRect("alpha"));
  });

  it("flies an envelope between the two SEATS, never between two bodies", () => {
    const scene = new OfficeScene(layoutOffice);
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
    expect(characterRect(scene.frame(), "beta")).not.toEqual(
      seatedRect("beta"),
    );
    const launched = envelopes(scene.frame())[0];
    expect(launched.x).toBe(seatedHead("alpha").x);

    // ...and the next message to it does NOT jerk it into the chair to receive.
    // Snapping a walking sprite to a tile reads as a rendering fault; the
    // envelope simply lands on the desk and waits.
    const walking = characterRect(scene.frame(), "beta");
    scene.sync(
      sceneInput({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: REQUEST_PULSE,
        pulseKey: "row-2",
      }),
    );
    expect(characterRect(scene.frame(), "beta")).toEqual(walking);
  });

  it("hurries an agent with a message waiting, and greets it once seated", () => {
    // Two identical walks in from the same door to the same chair. The only
    // difference is a message in the air, so the difference in how long the
    // walk takes IS the hurry.
    const walkInMs = (withMessage: boolean): number => {
      const scene = new OfficeScene(layoutOffice);
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
      const door = scene.layout().doorTile;
      expect(characterRect(scene.frame(), "beta").x).toBe(
        door.col * OFFICE_TILE,
      );
      let seatedAt: number | null = null;
      let greeted = false;
      for (let step = 1; step <= 200; step += 1) {
        scene.tick(50);
        const frame = scene.frame();
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
    const scene = new OfficeScene(layoutOffice);
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
    expect(stacks(scene.frame())).toHaveLength(0);

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

    // Beta is queued and stays queued, so the message waits ON THE DESK - and
    // an unanswered message on a desk is exactly what the pile already draws.
    const waiting = scene.frame();
    expect(characterRect(waiting, "beta")).not.toEqual(seatedRect("beta"));
    const pile = stacks(waiting);
    expect(pile).toHaveLength(1);
    const desk = scene.layout().desks.get("beta");
    if (desk === undefined) throw new Error("expected a desk");
    expect(pile[0].x).toBe(desk.deskTile.col * OFFICE_TILE + 1);
    expect(hasBubbleAt(waiting, "bubble-hello", seatedHead("beta"))).toBe(
      false,
    );

    // Once the person has been, beta walks back - and the greeting fires as it
    // sits, which is when the message is actually picked up.
    scene.sync(sceneInput({ agents: AGENTS, visibleAgentIds: BOTH }));
    for (let step = 0; step < 60; step += 1) {
      scene.tick(100);
      const frame = scene.frame();
      if (
        JSON.stringify(characterRect(frame, "beta")) ===
        JSON.stringify(seatedRect("beta"))
      ) {
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
    const scene = new OfficeScene(layoutOffice);
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
    expect(characterRect(scene.frame(), "beta")).not.toEqual(
      seatedRect("beta"),
    );
    const launched = envelopes(scene.frame()).at(-1);
    if (launched === undefined) throw new Error("expected an envelope");
    expect(launched.x).toBe(seatedHead("beta").x);
  });

  it("leaves a queued agent at reception when a message arrives for it", () => {
    const scene = new OfficeScene(layoutOffice);
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
    const queued = characterRect(scene.frame(), "beta");
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
    expect(characterRect(scene.frame(), "beta")).toEqual(queued);
  });

  it("skips the walk-in entirely once playback runs fast", () => {
    const scene = new OfficeScene(layoutOffice);
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

    const frame = scene.frame();
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
    const scene = new OfficeScene(layoutOffice);
    scene.sync(sceneInput({ agents: crew, visibleAgentIds: ALPHA_ONLY }));
    scene.sync(
      sceneInput({
        agents: crew,
        visibleAgentIds: BOTH,
        pulse: CREATED_PULSE,
        pulseKey: "created-beta",
      }),
    );

    const layout = scene.layout();
    expect(layout.floors).toHaveLength(2);
    const upstairs = layout.floors[1];
    // Beta lives on the second storey, so it comes in through THAT storey's
    // door - never the building's own.
    const entering = characterRect(scene.frame(), "beta");
    expect(entering.x).toBe(upstairs.doorTile.col * OFFICE_TILE);
    expect(entering.y).toBe(upstairs.doorTile.row * OFFICE_TILE - 4);

    for (let step = 0; step < 60; step += 1) scene.tick(100);
    const desk = layout.desks.get("beta");
    if (desk === undefined) throw new Error("expected a desk");
    const seated = characterRect(scene.frame(), "beta");
    expect(seated.x).toBe(desk.chairTile.col * OFFICE_TILE);
    expect(seated.y).toBe(desk.chairTile.row * OFFICE_TILE - 4);
  });

  it("queues each floor at its own reception", () => {
    const crew = [
      agent({ id: "alpha", hostId: "host-a", createdAt: 1 }),
      agent({ id: "beta", hostId: "host-b", createdAt: 2 }),
    ];
    const scene = new OfficeScene(layoutOffice);
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

    const layout = scene.layout();
    const frame = scene.frame();
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
      const scene = new OfficeScene(layoutOffice);
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
      return scene.frame();
    };

    expect(run()).toEqual(run());
  });
});
