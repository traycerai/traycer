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

    // Three tiles a second over a short route; two seconds is comfortably past.
    for (let step = 0; step < 20; step += 1) scene.tick(100);
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
