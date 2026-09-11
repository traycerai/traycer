/**
 * Playback and scrub-back: a historical cursor must show the same floor
 * whether it is the FIRST thing the scene ever sees, or reached by scrubbing
 * back from somewhere later. The scene's own doc comment states the
 * invariant this suite pins: "A first sync MATERIALIZES the floor as of the
 * cursor; it does not replay the row the cursor happens to be sitting on."
 */
import { describe, expect, it } from "vitest";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import type { OfficeView } from "@/lib/comm-graph/office/views/office-view";
import {
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeFrame,
  type OfficeLayout,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSign,
} from "@/lib/comm-graph/office/office-types";

const APPEARANCE = {
  skin: "#e0b08a",
  hair: "#3a2a1a",
  hairStyle: 0 as const,
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

function testView(
  plan: (agents: ReadonlyArray<OfficeAgentInput>) => OfficeLayout,
): OfficeView {
  return { ...OFFICE_VIEWS.floor, plan: (input) => plan(input.agents) };
}

const WHOLE_WORLD: OfficeRect = { x: 0, y: 0, width: 4000, height: 4000 };

function frameOf(scene: OfficeScene): OfficeFrame {
  return scene.frame(2, WHOLE_WORLD);
}

/** The plan in force. Every case here syncs first, so `null` is a bug in the case. */
function layoutOf(scene: OfficeScene): OfficeLayout {
  const layout = scene.layout();
  if (layout === null) throw new Error("scene has no layout yet");
  return layout;
}

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
    stepMs: 800,
    cursorMs: null,
    clockMs: 0,
    playing: false,
    reducedMotion: false,
    ...overrides,
  };
}

/** The documented visibility rule for a sign - see office-scene.test.ts's own copy. */
function officeSignVisible(
  sign: OfficeSign,
  visibleAgentIds: ReadonlySet<string>,
): boolean {
  return sign.ownerAgentId === null || visibleAgentIds.has(sign.ownerAgentId);
}

function signAt(
  layout: OfficeLayout,
  kind: OfficeSign["kind"],
  tile: { readonly col: number; readonly row: number },
): OfficeSign | undefined {
  return layout.signs.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.tile.col === tile.col &&
      candidate.tile.row === tile.row,
  );
}

describe("OfficeScene replay", () => {
  it("gives the same as-of display opening at a historical cursor as reaching it by scrubbing back from live", () => {
    const alpha = agent({ id: "alpha", createdAt: 1 });
    const beta = agent({ id: "beta", createdAt: 2 });
    const family = [alpha, beta];
    const both = new Set(["alpha", "beta"]);

    const opensAtCursor = new OfficeScene(testView(layoutOffice), null);
    opensAtCursor.sync(
      sceneInput({
        agents: family,
        visibleAgentIds: new Set(["alpha"]),
        cursorMs: 5,
      }),
    );

    const reachesFromLive = new OfficeScene(testView(layoutOffice), null);
    reachesFromLive.sync(
      sceneInput({ agents: family, visibleAgentIds: both, cursorMs: null }),
    );
    reachesFromLive.tick(500);
    reachesFromLive.sync(
      sceneInput({
        agents: family,
        visibleAgentIds: new Set(["alpha"]),
        cursorMs: 5,
      }),
    );

    expect(frameOf(reachesFromLive).hitRegions).toEqual(
      frameOf(opensAtCursor).hitRegions,
    );
    expect(frameOf(reachesFromLive).awayAgentIds).toEqual(
      frameOf(opensAtCursor).awayAgentIds,
    );
  });

  it("gives the same as-of display for a cursor that falls mid-scrub as it does opening there directly", () => {
    // A three-row timeline; scrubbing from the END back to the MIDDLE must
    // show exactly what opening fresh at the middle would.
    const alpha = agent({ id: "alpha", createdAt: 1 });
    const beta = agent({ id: "beta", createdAt: 2 });
    const gamma = agent({ id: "gamma", createdAt: 3 });
    const family = [alpha, beta, gamma];
    const midCursorIds = new Set(["alpha", "beta"]);
    const liveIds = new Set(["alpha", "beta", "gamma"]);

    const direct = new OfficeScene(testView(layoutOffice), null);
    direct.sync(
      sceneInput({
        agents: family,
        visibleAgentIds: midCursorIds,
        cursorMs: 200,
      }),
    );

    const scrubbed = new OfficeScene(testView(layoutOffice), null);
    scrubbed.sync(
      sceneInput({ agents: family, visibleAgentIds: liveIds, cursorMs: 300 }),
    );
    scrubbed.tick(1000);
    scrubbed.sync(
      sceneInput({
        agents: family,
        visibleAgentIds: midCursorIds,
        cursorMs: 200,
      }),
    );

    expect(frameOf(scrubbed).hitRegions).toEqual(frameOf(direct).hitRegions);
  });

  it("holds no sign visible for a root that does not exist yet at the cursor, even though the plan already placed it", () => {
    const root = agent({ id: "root", name: "Future Team", createdAt: 1 });
    const child = agent({
      id: "child",
      name: "Future Lead",
      parentId: "root",
      createdAt: 2,
    });
    const family = [root, child];

    const scene = new OfficeScene(testView(layoutOffice), null);
    // Both exist as of the epic, but the cursor is BEFORE either was created:
    // nobody is visible yet, though the plan still ran over the whole set.
    scene.sync(
      sceneInput({
        agents: family,
        visibleAgentIds: new Set<string>(),
        cursorMs: 0,
      }),
    );

    const layout = layoutOf(scene);
    expect(layout.desks.size).toBe(2);
    const room = layout.rooms[0];
    expect(room).toBeDefined();
    const sign = signAt(layout, "room", room.signTile);
    if (sign === undefined)
      throw new Error("expected the plan to place a sign");
    expect(sign.ownerAgentId).toBe("root");

    // The plan holds the sign (a plan fact); nothing at the cursor may show
    // it (a cursor fact) while its owner does not exist there yet.
    expect(officeSignVisible(sign, new Set<string>())).toBe(false);

    // No character exists for either agent at this cursor - no claim, no
    // hit region, nothing away.
    expect(frameOf(scene).hitRegions).toHaveLength(0);
    expect(frameOf(scene).awayAgentIds.size).toBe(0);

    // Scrubbing forward past both creations reveals them and their sign.
    const allIds = new Set(["root", "child"]);
    scene.sync(
      sceneInput({ agents: family, visibleAgentIds: allIds, cursorMs: 900 }),
    );
    expect(officeSignVisible(sign, allIds)).toBe(true);
    expect(frameOf(scene).hitRegions.length).toBeGreaterThan(0);
  });

  it("archives an agent, walks it out and sheets its desk, then reverses all of it on a scrub back across the same cursor", () => {
    const leaver = agent({ id: "alpha", createdAt: 1, archivedAt: 500 });
    const beta = agent({ id: "beta", createdAt: 2 });
    const family = [leaver, beta];
    const both = new Set(["alpha", "beta"]);

    // A CHARACTER hit region, distinguished from the seat's own (which stays
    // hit-testable - a sheeted, empty desk - even once nobody is in it).
    function hasCharacterRegion(
      frame: ReturnType<typeof frameOf>,
      agentId: string,
    ): boolean {
      return frame.hitRegions.some(
        (region) => region.agentId === agentId && region.rect.width === 16,
      );
    }

    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(
      sceneInput({ agents: family, visibleAgentIds: both, cursorMs: 100 }),
    );
    expect(hasCharacterRegion(frameOf(scene), "alpha")).toBe(true);

    // Cross the archival: alpha walks out and its desk takes the dust sheet.
    scene.sync(
      sceneInput({ agents: family, visibleAgentIds: both, cursorMs: 900 }),
    );
    for (let step = 0; step < 150; step += 1) scene.tick(100);
    const archived = frameOf(scene);
    expect(hasCharacterRegion(archived, "alpha")).toBe(false);
    const dustSheets = archived.props.filter(
      (drawable) =>
        drawable.kind === "sprite" && drawable.sprite.name === "dust-sheet",
    );
    expect(dustSheets).toHaveLength(1);

    // Scrub back across the same cursor: un-archived, and it walks back in.
    scene.sync(
      sceneInput({ agents: family, visibleAgentIds: both, cursorMs: 100 }),
    );
    for (let step = 0; step < 150; step += 1) scene.tick(100);
    const restored = frameOf(scene);
    expect(hasCharacterRegion(restored, "alpha")).toBe(true);
    expect(restored.awayAgentIds.has("alpha")).toBe(false);
  });
});
