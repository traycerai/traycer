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
