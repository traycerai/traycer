import { describe, expect, it } from "vitest";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { commGraphPairId } from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
  OfficeSceneInput,
} from "@/lib/comm-graph/office/office-types";

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
  return {
    agents: AGENTS,
    visibleAgentIds: BOTH,
    statusById: new Map<string, OfficeAgentStatus>(),
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
  const scene = new OfficeScene(layoutOffice);
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
