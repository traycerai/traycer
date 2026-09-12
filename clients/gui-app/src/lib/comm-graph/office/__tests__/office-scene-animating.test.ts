import { describe, expect, it } from "vitest";
import { layoutOffice } from "@/lib/comm-graph/office/office-layout";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import { commGraphPairId } from "@/lib/comm-graph/comm-graph-model";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeFrame,
  type OfficeLayout,
  type OfficeRect,
  type OfficeSceneInput,
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
  // DERIVED FROM WHAT THE CASE PASSED, the same way `agents` is. The partition
  // is a function of the statuses, so building it from an empty map while
  // `statusById` arrives through the overrides hands the scene a partition
  // that disagrees with its own statuses - and every case that sets a status
  // to watch the floor move was being read against a partition that had
  // nobody working in it.
  const statusById =
    overrides.statusById ?? new Map<string, OfficeAgentStatus>();
  return {
    agents,
    visibleAgentIds: BOTH,
    statusById,
    partition: partitionOfficePopulation({
      agents,
      statusById,
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
 * A layout offering ONLY these errand kinds. Weights decide between the
 * options a floor has, so pinning the options is the only way to drive one
 * activity - here, the bin toss - without leaving it to chance which errand a
 * character actually goes on.
 */
function onlyKinds(
  kinds: ReadonlyArray<string>,
): (agents: ReadonlyArray<OfficeAgentInput>) => OfficeLayout {
  return (agents) => {
    const base = layoutOffice(agents);
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

/**
 * A single agent, alone on the floor. A lone agent is its own cabin's
 * manager, which is the only desk a bin sits beside, and with nobody else
 * to compete with for the one bin spot it never has to fall back to a
 * corridor stroll instead.
 */
const BIN_CREW: ReadonlyArray<OfficeAgentInput> = [agent("alpha")];
const BIN_IDS: ReadonlySet<string> = new Set(BIN_CREW.map((one) => one.id));
const BIN_LAYOUT: OfficeLayout = layoutOffice(BIN_CREW);

function binCrewSeatedRect(agentId: string): OfficeRect {
  const desk = BIN_LAYOUT.desks.get(agentId);
  if (desk === undefined) throw new Error(`no desk for ${agentId}`);
  return {
    x: desk.chairTile.col * OFFICE_TILE,
    y: desk.chairTile.row * OFFICE_TILE - 4,
    width: OFFICE_CHARACTER_WIDTH,
    height: OFFICE_CHARACTER_HEIGHT,
  };
}

function characterRectOrNull(
  frame: OfficeFrame,
  agentId: string,
): OfficeRect | null {
  const region = frame.hitRegions.find(
    (candidate) =>
      candidate.agentId === agentId &&
      candidate.rect.height === OFFICE_CHARACTER_HEIGHT,
  );
  return region === undefined ? null : region.rect;
}

/** Whether every one of this crew is, this frame, sitting in its own chair. */
function everyoneSeated(
  frame: OfficeFrame,
  crew: ReadonlyArray<OfficeAgentInput>,
): boolean {
  return crew.every((person) => {
    const rect = characterRectOrNull(frame, person.id);
    if (rect === null) return false;
    const seated = binCrewSeatedRect(person.id);
    return rect.x === seated.x && rect.y === seated.y;
  });
}

function paperBallCount(frame: OfficeFrame): number {
  let count = 0;
  for (const drawable of frame.overlay) {
    if (drawable.kind === "sprite" && drawable.sprite.name === "paper-ball") {
      count += 1;
    }
  }
  return count;
}

/**
 * The fixture's OWN agreement, pinned before anything reads it.
 *
 * `input` resolves one status map and hands that same map to the partitioner.
 * Nothing else in this file would notice if the partition were built from an
 * empty map instead: every case below asserts on motion, and a partition with
 * nobody hot in it still produces a floor that moves for other reasons. So the
 * agreement is asserted directly - the members this fixture marks working and
 * attention have to come back hot from the partition it produced.
 */
describe("the animating fixture", () => {
  it("partitions the statuses the case passed in, not an empty map", () => {
    const statusById = new Map<string, OfficeAgentStatus>([
      ["alpha", "working"],
      ["beta", "attention"],
    ]);

    const { partition } = input({ statusById });

    expect(partition.members.get("alpha")?.hot).toBe(true);
    expect(partition.members.get("beta")?.hot).toBe(true);
  });
});

/**
 * The renderer skips a frame entirely when this says nothing is moving, so a
 * false NEGATIVE freezes the floor - which is why the predicate is deliberately
 * conservative and why both directions are pinned here.
 */
describe("OfficeScene.isAnimating", () => {
  it("is false once every character is seated and idle", () => {
    expect(settledScene().isAnimating(2)).toBe(false);
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

    expect(scene.isAnimating(2)).toBe(true);
  });

  it("is true while an agent has a turn running", () => {
    const scene = settledScene();

    scene.sync(
      input({
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "working"]]),
      }),
    );

    // A working desk alternates its screen every frame, so it is never still.
    expect(scene.isAnimating(2)).toBe(true);
  });

  it("is true while an agent is flagged for a person", () => {
    const scene = settledScene();

    scene.sync(
      input({
        statusById: new Map<string, OfficeAgentStatus>([["beta", "attention"]]),
      }),
    );

    // The attention bubble bobs, so a flagged agent animates even seated.
    expect(scene.isAnimating(2)).toBe(true);
  });
});

/**
 * At overview a frame is pips and envelopes only - `frame()` builds nothing
 * else there - so half of what makes the close-up band animate resolves to
 * the same pixels from one overview frame to the next. Each case here pins
 * one of those things on the side of the line it actually belongs on.
 */
describe("OfficeScene.isAnimating band split", () => {
  it("shows a typing agent's alternating screen only at close-up, not at overview", () => {
    const scene = settledScene();
    scene.sync(
      input({
        statusById: new Map<string, OfficeAgentStatus>([["alpha", "working"]]),
      }),
    );

    expect(scene.isAnimating(2)).toBe(true);
    // A typing screen is invisible at overview, so a floor of nothing but
    // working agents must not be redrawn to show it.
    expect(scene.isAnimating(0)).toBe(false);
  });

  it("shows a walker's moving pip at both overview and close-up", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(input({ agents: AGENTS, visibleAgentIds: new Set(["alpha"]) }));
    const createdBeta: CommGraphPulse = {
      kind: "edge",
      edgeId: commGraphPairId("alpha", "beta"),
      pulseKind: "created",
      fromAgentId: "alpha",
      toAgentId: "beta",
    };
    scene.sync(
      input({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        pulse: createdBeta,
        pulseKey: "created-beta",
      }),
    );
    // Still on foot, part-way across the floor.
    scene.tick(100);

    // A walker's pip moves as surely as its sprite, so overview has to redraw
    // it exactly as often as close-up does.
    expect(scene.isAnimating(0)).toBe(true);
    expect(scene.isAnimating(2)).toBe(true);
  });

  it("shows an envelope in flight at both overview and close-up", () => {
    const scene = settledScene();
    const pulse: CommGraphPulse = {
      kind: "edge",
      edgeId: commGraphPairId("alpha", "beta"),
      pulseKind: "request",
      fromAgentId: "alpha",
      toAgentId: "beta",
    };

    scene.sync(input({ pulse, pulseKey: "row-1" }));

    // Overview's overlay is envelopes and nothing else, so an envelope is the
    // one piece of overlay art that has to count at every band.
    expect(scene.isAnimating(0)).toBe(true);
    expect(scene.isAnimating(2)).toBe(true);
  });

  it("shows a bubble and sparkle over a freshly seated arrival only at close-up", () => {
    const scene = new OfficeScene(testView(layoutOffice), null);
    scene.sync(input({ agents: AGENTS, visibleAgentIds: new Set(["alpha"]) }));
    const createdBeta: CommGraphPulse = {
      kind: "edge",
      edgeId: commGraphPairId("alpha", "beta"),
      pulseKind: "created",
      fromAgentId: "alpha",
      toAgentId: "beta",
    };
    // Reduced motion silently seats beta rather than walking or sparkling it
    // in, and delivers its creation pulse in the same sync instead of flying
    // an envelope - so the only things left in play are the bubble and
    // sparkle `deliver` puts on a seated arrival.
    scene.sync(
      input({
        agents: AGENTS,
        visibleAgentIds: BOTH,
        reducedMotion: true,
        pulse: createdBeta,
        pulseKey: "created-beta",
      }),
    );

    expect(scene.isAnimating(2)).toBe(true);
    // Seated and not moving is a still overview pip; a bubble and a sparkle
    // are both overlay art overview does not draw.
    expect(scene.isAnimating(0)).toBe(false);
  });

  it("shows a paper ball still resting on the floor only at close-up, once its thrower is already back at its desk", () => {
    const scene = new OfficeScene(testView(onlyKinds(["bin"])), null);
    scene.sync(input({ agents: BIN_CREW, visibleAgentIds: BIN_IDS }));
    const idle = input({ agents: BIN_CREW, visibleAgentIds: BIN_IDS });
    const working = input({
      agents: BIN_CREW,
      visibleAgentIds: BIN_IDS,
      statusById: new Map<string, OfficeAgentStatus>([["alpha", "working"]]),
    });

    // Errands chain for as long as an agent stays idle and the camera is on
    // it, so left alone it does not walk home on its own - a status change is
    // one of the documented ways to call it back. Firing that the instant a
    // ball is on the floor sends the agent home with a miss still resting
    // behind it: the bin is a few tiles from the desk, well under the three
    // seconds a miss rests for, so within a few rounds the walk back finishes
    // before the ball does. That instant is exactly what the final
    // `paperBalls.length` check in `isAnimating` exists for - every character
    // reports seated, and the only thing left moving is art overview never
    // draws.
    //
    // A SEARCH, NOT A GAMBLE. The scene holds no `Math.random` and reads no
    // clock: every seed in it is an agent's id mixed with `nowMs`, which only
    // the ticks below advance. So the round this lands on is the same round
    // on every machine and every run, and the bound exists to fail with a
    // sentence rather than to hang if a tuning change ever moves it.
    let found: OfficeFrame | null = null;
    for (let attempt = 0; attempt < 50 && found === null; attempt += 1) {
      let ballSeen = false;
      for (let step = 0; step < 200 && !ballSeen; step += 1) {
        scene.tick(100);
        if (paperBallCount(frameOf(scene)) > 0) ballSeen = true;
      }
      if (!ballSeen) continue;
      scene.sync(working);
      for (let step = 0; step < 50 && found === null; step += 1) {
        scene.tick(100);
        const frame = frameOf(scene);
        if (everyoneSeated(frame, BIN_CREW) && paperBallCount(frame) > 0) {
          found = frame;
        }
      }
      // Back to idle so the next attempt gets its own errand to interrupt.
      scene.sync(idle);
    }
    expect(
      found,
      "never caught a resting ball with its thrower already reseated",
    ).not.toBeNull();

    expect(scene.isAnimating(2)).toBe(true);
    expect(scene.isAnimating(0)).toBe(false);
  });

  it("reports a thousand-agent office as still at overview even though everybody is typing", () => {
    const bigCrew: ReadonlyArray<OfficeAgentInput> = Array.from(
      { length: 1_000 },
      (_, index) => agent(`worker-${index}`),
    );
    const bigIds = new Set(bigCrew.map((person) => person.id));
    const statusById = new Map<string, OfficeAgentStatus>(
      bigCrew.map((person) => [person.id, "working"]),
    );
    const scene = new OfficeScene(testView(layoutOffice), null);
    // First sync seats everyone silently - no walk-in to wait out - so this
    // is the floor a viewport would actually be handed the instant it opens.
    scene.sync(input({ agents: bigCrew, visibleAgentIds: bigIds, statusById }));

    // This is the case that stopped a still floor redrawing sixty times a
    // second to show a thousand dots that never move: every one of them is
    // typing, and overview cannot tell.
    expect(scene.isAnimating(0)).toBe(false);
    // The same floor at close-up is a thousand alternating screens, so the
    // false above is the band talking, not a check that broke.
    expect(scene.isAnimating(2)).toBe(true);
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
