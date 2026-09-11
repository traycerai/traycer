import { describe, expect, it } from "vitest";
import {
  isElementVisible,
  officeCatchUpMs,
  OfficeFrameGate,
  OFFICE_FRAME_INTERVAL_MS,
  OFFICE_MAX_FRAME_MS,
  OFFICE_RESUME_CATCH_UP_MS,
  type OfficeFloorMotion,
} from "@/components/epic-canvas/comm-graph/office/office-frame-gate";
import { commGraphPairId } from "@/lib/comm-graph/comm-graph-model";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
  OfficeFrame,
  OfficeRect,
  OfficeSceneInput,
} from "@/lib/comm-graph/office/office-types";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";

const MOVING: OfficeFloorMotion = {
  animating: true,
  minute: 0,
  panning: false,
};
const STILL: OfficeFloorMotion = {
  animating: false,
  minute: 0,
  panning: false,
};

/**
 * The rAF loop these rules govern cannot be exercised through the component:
 * jsdom has no 2d context, so the loop returns before its first frame. The
 * rules are therefore the loop's only testable part, and the loop is wiring
 * around them rather than a second copy of them.
 */
describe("OfficeFrameGate rate cap", () => {
  it("skips frames arriving faster than the drawing rate", () => {
    const gate = new OfficeFrameGate();

    // Three 60Hz-ish frames inside one 30fps interval.
    expect(gate.elapsed(10)).toBeNull();
    expect(gate.elapsed(10)).toBeNull();
    expect(gate.elapsed(10)).toBeNull();
  });

  it("draws one frame per interval, not one per display frame", () => {
    const gate = new OfficeFrameGate();
    let frames = 0;

    // A second of 60Hz vsyncs.
    for (let i = 0; i < 60; i += 1) {
      if (gate.elapsed(16) !== null) frames += 1;
    }

    // 30fps, give or take where the accumulator lands - and emphatically not
    // the 60 the display offered.
    expect(frames).toBeGreaterThanOrEqual(28);
    expect(frames).toBeLessThanOrEqual(31);
  });

  it("hands back the time it swallowed, so the sim keeps real time", () => {
    const gate = new OfficeFrameGate();
    gate.elapsed(10);
    gate.elapsed(10);

    // The two skipped frames are not lost, they are carried - or a character
    // would walk at a third of its speed on a 60Hz display.
    expect(gate.elapsed(16)).toBe(OFFICE_FRAME_INTERVAL_MS);
  });

  it("accounts for every millisecond it is given, across a whole second", () => {
    const gate = new OfficeFrameGate();
    let ticked = 0;

    for (let i = 0; i < 60; i += 1) {
      ticked += gate.elapsed(16) ?? 0;
    }

    // 960ms in, 960ms out bar the slice still in the accumulator. Dropping
    // time here is invisible per frame and shows up as a floor that moves
    // slower the faster the display refreshes.
    expect(ticked).toBeGreaterThan(60 * 16 - OFFICE_FRAME_INTERVAL_MS);
    expect(ticked).toBeLessThanOrEqual(60 * 16);
  });

  it("does not replay the time a sleeping tab was away", () => {
    const gate = new OfficeFrameGate();

    // A tab asleep for a minute reports one enormous frame; ticking the sim
    // with it would fast-forward the whole floor in a single step.
    const elapsed = gate.elapsed(60_000);
    expect(elapsed).not.toBeNull();
    expect(elapsed ?? 0).toBeLessThanOrEqual(OFFICE_MAX_FRAME_MS);
  });

  it("ignores a clock that jumped backwards between frames", () => {
    const gate = new OfficeFrameGate();

    expect(gate.elapsed(-500)).toBeNull();
    // The negative frame contributed nothing rather than eating the budget.
    expect(gate.elapsed(OFFICE_FRAME_INTERVAL_MS)).toBe(
      OFFICE_FRAME_INTERVAL_MS,
    );
  });

  it("draws immediately on resume rather than costing a wait", () => {
    const gate = new OfficeFrameGate();
    gate.elapsed(10);

    gate.resume();

    expect(gate.elapsed(1)).not.toBeNull();
  });

  it("paints the first frame back even when the floor never moved", () => {
    const gate = new OfficeFrameGate();
    // A still floor, drawn once and then skipped - the state a tile is in when
    // it gets hidden.
    expect(gate.shouldDraw(STILL)).toBe(true);
    expect(gate.shouldDraw(STILL)).toBe(false);

    gate.resume();

    // The canvas still holds the pre-pause image, so the idle skip has to
    // stand aside too. Standing aside only for the RATE cap left the tile
    // showing a stale frame until something happened to move.
    expect(gate.elapsed(1)).not.toBeNull();
    expect(gate.shouldDraw(STILL)).toBe(true);
    // ...and settles again straight after, rather than staying awake.
    expect(gate.shouldDraw(STILL)).toBe(false);
  });
});

describe("OfficeFrameGate idle skip", () => {
  it("draws while anything on the floor is moving", () => {
    const gate = new OfficeFrameGate();

    expect(gate.shouldDraw(MOVING)).toBe(true);
    expect(gate.shouldDraw(MOVING)).toBe(true);
  });

  it("stops drawing once the floor settles", () => {
    const gate = new OfficeFrameGate();

    // The first still frame is still painted - it is the one that shows the
    // floor at rest. Only the identical repeats after it are skipped.
    expect(gate.shouldDraw(STILL)).toBe(true);
    expect(gate.shouldDraw(STILL)).toBe(false);
    expect(gate.shouldDraw(STILL)).toBe(false);
  });

  it("redraws a still floor when the wall clock's minute turns over", () => {
    const gate = new OfficeFrameGate();
    gate.shouldDraw(STILL);

    // Otherwise the clock's hands sit at the wrong minute until something
    // else on the floor happens to move.
    expect(gate.shouldDraw({ ...STILL, minute: 1 })).toBe(true);
    expect(gate.shouldDraw({ ...STILL, minute: 1 })).toBe(false);
  });

  it("keeps drawing a still floor while the camera is panning", () => {
    const gate = new OfficeFrameGate();
    gate.shouldDraw(STILL);

    // Nothing on the floor moves during a pan - the VIEW of it does.
    expect(gate.shouldDraw({ ...STILL, panning: true })).toBe(true);
    expect(gate.shouldDraw({ ...STILL, panning: true })).toBe(true);
  });

  it("paints again after the bitmap was cleared under it", () => {
    const gate = new OfficeFrameGate();
    gate.shouldDraw(STILL);
    expect(gate.shouldDraw(STILL)).toBe(false);

    gate.invalidate();

    // A resize, or a device-pixel-ratio change, assigns to the canvas's
    // dimensions - which clears it. The skip's whole premise is that the last
    // frame is still up there, so a still floor would otherwise stay blank.
    expect(gate.shouldDraw(STILL)).toBe(true);
    expect(gate.shouldDraw(STILL)).toBe(false);
  });

  it("resumes drawing when the floor starts moving again", () => {
    const gate = new OfficeFrameGate();
    gate.shouldDraw(STILL);
    expect(gate.shouldDraw(STILL)).toBe(false);

    expect(gate.shouldDraw(MOVING)).toBe(true);
  });
});

describe("officeCatchUpMs", () => {
  it("replays a short pause in full, so the floor resumes mid-stride", () => {
    expect(officeCatchUpMs(400)).toBe(400);
  });

  it("caps a long pause instead of replaying an hour of it", () => {
    expect(officeCatchUpMs(60 * 60_000)).toBe(OFFICE_RESUME_CATCH_UP_MS);
  });

  it("never rewinds the floor when the wall clock moved backwards", () => {
    expect(officeCatchUpMs(-1_000)).toBe(0);
    expect(officeCatchUpMs(0)).toBe(0);
  });
});

describe("isElementVisible", () => {
  it("asks the browser directly where it can", () => {
    const element = document.createElement("div");
    // jsdom implements neither, so both branches are installed explicitly -
    // and this one must win, because a laid-out-but-hidden tile has an empty
    // rect list AND a definitive answer available.
    element.checkVisibility = () => true;
    element.getClientRects = () => document.createElement("p").getClientRects();

    expect(isElementVisible(element)).toBe(true);
  });

  it("believes the browser when it says an element is not rendered", () => {
    const element = document.createElement("div");
    element.checkVisibility = () => false;

    // This is the case the pause exists for: an unselected Traycer tab keeps
    // its tiles mounted under `display:none`, where nothing is painted and no
    // page-level event says so.
    expect(isElementVisible(element)).toBe(false);
  });

  it("falls back to the element's boxes where checkVisibility is missing", () => {
    const element = document.createElement("div");

    // jsdom lays nothing out, so every element reports no boxes - which is
    // the fallback's "not rendered" answer, reached without throwing.
    expect(isElementVisible(element)).toBe(false);
  });
});

/**
 * The scene input the office canvas builds, trimmed to what these cases
 * change: the agent set, their statuses, and whether motion is reduced.
 */
function input(
  agents: ReadonlyArray<OfficeAgentInput>,
  statuses: ReadonlyMap<string, OfficeAgentStatus>,
  reducedMotion: boolean,
): OfficeSceneInput {
  return {
    agents,
    statusById: statuses,
    partition: partitionOfficePopulation({
      agents,
      statusById: statuses,
      previous: null,
    }),
    visibleAgentIds: new Set(agents.map((agent) => agent.id)),
    activityById: new Map(),
    viewport: { width: 1280, height: 700 },
    openRequestsByReceiver: new Map(),
    pulse: null,
    pulseKey: null,
    stepMs: 0,
    cursorMs: null,
    clockMs: 0,
    playing: false,
    reducedMotion,
  };
}

function whole(scene: OfficeScene): OfficeRect {
  return { x: 0, y: 0, ...scene.worldSize() };
}

interface Motion {
  readonly agentId: string;
  readonly seated: boolean;
  readonly col: number;
  readonly row: number;
}

function isMotion(value: unknown): value is Motion {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentId" in value &&
    typeof value.agentId === "string" &&
    "seated" in value &&
    typeof value.seated === "boolean" &&
    "col" in value &&
    typeof value.col === "number" &&
    "row" in value &&
    typeof value.row === "number"
  );
}

/**
 * The scene's private walker state. Nothing public reports WHERE a walker is,
 * only whether it is seated and where its pip lands in a built frame - and the
 * cases below need to drive a walk to a known point (away from its chair)
 * before watching it settle, which needs the position too.
 */
function motions(scene: OfficeScene): Motion[] {
  const raw: unknown = Reflect.get(scene, "characters");
  if (!(raw instanceof Map)) throw new Error("characters missing");
  const result: Motion[] = [];
  for (const value of raw.values()) {
    if (!isMotion(value)) throw new Error("motion shape changed");
    result.push({
      agentId: value.agentId,
      seated: value.seated,
      col: value.col,
      row: value.row,
    });
  }
  return result;
}

/**
 * The gate driven the way the canvas actually drives it, not through
 * `shouldDraw` alone: `gate.elapsed` gates the tick, `scene.tick` advances the
 * simulation, `scene.isAnimating` reads the state THAT tick just produced, and
 * only then does `gate.shouldDraw` decide whether this frame paints. F1 lived
 * in that order - the tick that lands a walker in its chair or takes an
 * envelope off the floor is the tick after which `isAnimating` answers false,
 * so a gate asked only the fresh answer refuses the very frame that would show
 * the change, leaving the canvas a frame short of it. `OfficeFrameGate`'s
 * `wasAnimating` latch (see its own file) is what these cases pin.
 */
describe("OfficeFrameGate through the scene's real tick-then-ask loop", () => {
  it("paints an envelope's delivery, not a frame still holding it in flight", () => {
    const epic = makeTestEpic("triage", 2, 1);
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    const from = epic.agents[0].id;
    const to = epic.agents[1].id;
    const initial = input(
      epic.agents,
      new Map(epic.agents.map((agent) => [agent.id, "working" as const])),
      false,
    );
    scene.sync(initial);
    scene.sync({
      ...initial,
      pulse: {
        kind: "edge",
        edgeId: commGraphPairId(from, to),
        pulseKind: "request",
        fromAgentId: from,
        toAgentId: to,
      },
      pulseKey: "request-1",
    });
    expect(scene.isAnimating(0)).toBe(true);

    const gate = new OfficeFrameGate();
    let drawn = scene.frame(0, whole(scene));
    for (let step = 0; step < 100; step += 1) {
      const elapsed = gate.elapsed(100);
      if (elapsed === null) continue;
      scene.tick(elapsed);
      if (
        gate.shouldDraw({
          animating: scene.isAnimating(0),
          minute: 0,
          panning: false,
        })
      ) {
        drawn = scene.frame(0, whole(scene));
      }
    }

    // Anti-vacuity: the envelope has to have actually been delivered, or the
    // comparison below is comparing a still frame to itself.
    expect(scene.isAnimating(0)).toBe(false);
    const settled = scene.frame(0, whole(scene));
    expect(drawn.overlay).toEqual(settled.overlay);
  });

  it("shows a returning walker's pip in its chair on the last frame drawn", () => {
    const epic = makeTestEpic("triage", 1, 1);
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    scene.sync(input(epic.agents, new Map(), false));
    const id = epic.agents[0].id;
    // An idle agent takes unprompted errands away from its desk; run the
    // floor until this one is genuinely away, which is the walk this case
    // needs to watch settle.
    for (let step = 0; step < 400; step += 1) {
      scene.frame(0, whole(scene));
      scene.tick(100);
      const moving = motions(scene)[0];
      const chairCol =
        scene.layout()?.desks.get(id)?.chairTile.col ?? moving.col;
      if (!moving.seated && Math.abs(moving.col - chairCol) > 1) break;
    }
    expect(motions(scene)[0].seated).toBe(false);
    scene.sync(input(epic.agents, new Map([[id, "working"]]), false));

    const gate = new OfficeFrameGate();
    let drawn: OfficeFrame | null = null;
    let movingFrames = 0;
    for (let step = 0; step < 1000; step += 1) {
      const elapsed = gate.elapsed(100);
      if (elapsed === null) continue;
      scene.tick(elapsed);
      const animating = scene.isAnimating(0);
      if (gate.shouldDraw({ animating, minute: 0, panning: false })) {
        drawn = scene.frame(0, whole(scene));
      }
      if (!motions(scene)[0].seated) movingFrames += 1;
      else break;
    }
    // Anti-vacuity: there has to have been a walk in progress to settle, or
    // this proves nothing about the settling frame.
    expect(movingFrames).toBeGreaterThan(0);
    const settled = scene.frame(0, whole(scene));
    expect(drawn?.actors).toEqual(settled.actors);
  });

  it("goes quiescent once the floor settles, rather than drawing forever", () => {
    // THE NEGATIVE. "Draw every frame at overview" would also make the two
    // cases above pass, so this pins the other half: once the floor is
    // genuinely still, the gate keeps refusing it on every later ask, not
    // just the first one - a count over many iterations, not a single read.
    const epic = makeTestEpic("triage", 2, 1);
    const scene = new OfficeScene(OFFICE_VIEWS.floor, null);
    const from = epic.agents[0].id;
    const to = epic.agents[1].id;
    const initial = input(
      epic.agents,
      new Map(epic.agents.map((agent) => [agent.id, "working" as const])),
      false,
    );
    scene.sync(initial);
    scene.sync({
      ...initial,
      pulse: {
        kind: "edge",
        edgeId: commGraphPairId(from, to),
        pulseKind: "request",
        fromAgentId: from,
        toAgentId: to,
      },
      pulseKey: "request-1",
    });

    const gate = new OfficeFrameGate();
    let draws = 0;
    for (let step = 0; step < 400; step += 1) {
      const elapsed = gate.elapsed(100);
      if (elapsed === null) continue;
      scene.tick(elapsed);
      if (
        gate.shouldDraw({
          animating: scene.isAnimating(0),
          minute: 0,
          panning: false,
        })
      ) {
        draws += 1;
      }
    }
    const drawsOnceSettled = draws;
    expect(scene.isAnimating(0)).toBe(false);
    // More than one: the envelope's arrival drew, and the settling frame drew
    // after it - a gate stuck refusing from the first ask would also read 0
    // or 1 here, which is why a single `false` cannot stand in for this.
    expect(drawsOnceSettled).toBeGreaterThan(1);

    // The same length of time again with nothing left to animate. A "draw
    // every frame" stand-in for the fix passes both cases above and fails
    // exactly here.
    for (let step = 0; step < 400; step += 1) {
      const elapsed = gate.elapsed(100);
      if (elapsed === null) continue;
      scene.tick(elapsed);
      if (
        gate.shouldDraw({
          animating: scene.isAnimating(0),
          minute: 0,
          panning: false,
        })
      ) {
        draws += 1;
      }
    }
    expect(draws).toBe(drawsOnceSettled);
  });
});
