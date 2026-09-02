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
  type OfficePoint,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSpriteName,
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
    pulse: null,
    pulseKey: null,
    // 800ms steps put the envelope's clamped flight at 600ms.
    stepMs: 800,
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

  it("ghosts an archived agent's badge", () => {
    const badged = agent({
      id: "alpha",
      createdAt: 1,
      harnessId: "traycer",
      archived: true,
    });
    const scene = new OfficeScene(layoutOffice);
    scene.sync(
      sceneInput({
        agents: [badged, BETA],
        visibleAgentIds: BOTH,
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "archived"]]),
      }),
    );

    expect(logos(scene.frame().props)[0].alpha).toBe(0.45);
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

  it("sends a long-idle agent for a coffee, but not before it has been idle", () => {
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

    // Stillness is the whole trigger, so a break that starts early would be
    // reporting something the floor has not earned yet.
    expect(firstBreakMs).not.toBeNull();
    expect(firstBreakMs).toBeGreaterThanOrEqual(25_000);
    // ...and a floor where everyone stands up reads as an evacuation. Four
    // agents all cross the threshold here, so the cap is what holds it at two
    // rather than the stagger happening to space them out.
    expect(mostAtOnce).toBe(2);
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
      `${layout.doorTile.col},${layout.doorTile.row}`,
      ...layout.rooms.map(
        (room) => `${room.doorTile.col},${room.doorTile.row}`,
      ),
    ]);
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
