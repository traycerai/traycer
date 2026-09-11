import { describe, expect, it } from "vitest";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { commGraphPairId } from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
  OfficeLayout,
  OfficeRect,
  OfficeSceneInput,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeView } from "@/lib/comm-graph/office/views/office-view";

/** The Floor's painter, wrapped around a plain layout function. */
function testView(
  plan: (agents: ReadonlyArray<OfficeAgentInput>) => OfficeLayout,
): OfficeView {
  return { ...OFFICE_VIEWS.floor, plan: (planInput) => plan(planInput.agents) };
}

/** Large enough to hold every fixture in this file with room to spare. */
const WHOLE_WORLD: OfficeRect = { x: 0, y: 0, width: 4000, height: 4000 };

function frameOf(scene: OfficeScene) {
  return scene.frame(2, WHOLE_WORLD);
}

function agent(id: string): OfficeAgentInput {
  return {
    id,
    name: id,
    kind: "chat",
    hostId: null,
    archivedAt: null,
    modelTier: "medium",
    harnessId: null,
    model: null,
    parentId: null,
    archived: false,
    createdAt: 0,
    appearance: agentAppearance(id, "chat", null),
  };
}

const AGENTS = [agent("alpha"), agent("beta")];
const BOTH = new Set(["alpha", "beta"]);

function input(overrides: Partial<OfficeSceneInput>): OfficeSceneInput {
  const agents = overrides.agents ?? AGENTS;
  return {
    agents,
    visibleAgentIds: BOTH,
    statusById: new Map<string, OfficeAgentStatus>(),
    partition: partitionOfficePopulation({
      agents,
      statusById: new Map(),
      previous: null,
    }),
    activityById: new Map<string, number>(),
    viewport: { width: 1000, height: 700 },
    pulse: null,
    pulseKey: null,
    stepMs: 800,
    cursorMs: null,
    clockMs: 0,
    openRequestsByReceiver: new Map(),
    playing: false,
    reducedMotion: false,
    ...overrides,
  };
}

/** A settled floor: everyone seated, nothing in flight, nobody flagged. */
function settledScene(): OfficeScene {
  const scene = new OfficeScene(testView(layoutOffice), null);
  scene.sync(input({}));
  // Long enough for the walk-in to finish and for every character to be in
  // its chair; short of the idle threshold that sends anyone on an errand.
  scene.tick(1000);
  return scene;
}

/**
 * The renderer skips a frame entirely when this says nothing is moving, so a
 * false NEGATIVE freezes the floor - which is why the predicate is deliberately
 * conservative and why both directions are pinned here.
 */
describe("OfficeScene.isAnimating", () => {
  it("is false once every character is seated and idle", () => {
    expect(settledScene().isAnimating()).toBe(false);
  });

  it("is true while an envelope is in flight", () => {
    const scene = settledScene();
    const pulse: CommGraphPulse = {
      kind: "edge",
      edgeId: commGraphPairId("alpha", "beta"),
      pulseKind: "request",
      fromAgentId: "alpha",
      toAgentId: "beta",
    };

    scene.sync(input({ pulse, pulseKey: "row-1" }));

    expect(scene.isAnimating()).toBe(true);
  });

  it("is true while an agent has a turn running", () => {
    const scene = settledScene();

    scene.sync(
      input({
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "working"]]),
      }),
    );

    // A working desk alternates its screen every frame, so it is never still.
    expect(scene.isAnimating()).toBe(true);
  });

  it("is true while an agent is flagged for a person", () => {
    const scene = settledScene();

    scene.sync(
      input({
        statusById: new Map<string, OfficeAgentStatus>([["beta", "attention"]]),
      }),
    );

    // The attention bubble bobs, so a flagged agent animates even seated.
    expect(scene.isAnimating()).toBe(true);
  });
});

/**
 * The renderer caches an entire painted floor against this number, so a
 * version that moves when the floor did not costs a full repaint, and one that
 * stays put when the floor changed leaves the old floor on screen.
 */
describe("OfficeScene frame().staticVersion", () => {
  it("holds still across ticks while nothing about the floor changes", () => {
    const scene = settledScene();
    const before = frameOf(scene).staticVersion;

    for (let step = 0; step < 40; step += 1) scene.tick(100);
    scene.sync(
      input({
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "working"]]),
      }),
    );
    scene.tick(500);

    // Characters walked, a status changed, envelopes may have flown - none of
    // that is the FLOOR.
    expect(frameOf(scene).staticVersion).toBe(before);
  });

  it("moves when the set of agents relaid the floor out", () => {
    const scene = settledScene();
    const before = frameOf(scene).staticVersion;

    scene.sync(input({ agents: [...AGENTS, agent("gamma")] }));

    expect(frameOf(scene).staticVersion).not.toBe(before);
  });

  it("hands back the very same floor array while the version holds", () => {
    const scene = settledScene();
    const first = frameOf(scene).floor;

    scene.tick(200);

    // Identity, not equality: rebuilding thousands of tile drawables to
    // produce an identical array was the largest allocation the office made.
    expect(frameOf(scene).floor).toBe(first);
  });

  it("builds a new floor once the layout is replaced", () => {
    const scene = settledScene();
    const first = frameOf(scene).floor;

    scene.sync(input({ agents: [...AGENTS, agent("gamma")] }));

    expect(frameOf(scene).floor).not.toBe(first);
  });
});
