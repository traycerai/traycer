import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderPeekTile } from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStreamClient,
  PEEK_NODE,
  hostDirectoryEntryModule,
  hostStreamClientForWithAuthModule,
  liveStream as fixtureLiveStream,
  runnerOpenExternalLinkModule,
  streamAuthRevalidatorModule,
  tabHostIdModule,
  tileRoleRunnerHostModule,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import { BrowserPeekTile } from "@/components/browser-tile/browser-peek-tile";

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
}));

vi.mock("@/providers/use-runner-host", () => tileRoleRunnerHostModule());

vi.mock("@/hooks/runner/use-open-external-link-mutation", () =>
  runnerOpenExternalLinkModule(),
);

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
);


vi.mock("@/hooks/host/use-host-directory-entry", () =>
  hostDirectoryEntryModule(),
);

vi.mock("@/hooks/host/use-host-stream-client-for", () =>
  hostStreamClientForWithAuthModule(hookState),
);

vi.mock("@/lib/host/stream-auth-revalidator", () =>
  streamAuthRevalidatorModule(),
);

const JPEG_SEQ_7 = new Uint8Array([1, 2, 3]);

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

function overlayButton(): HTMLElement {
  return screen.getByRole("button", { name: "Browser screencast controls" });
}

function imeInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "Browser IME input" });
}

function pointerFrames(
  stream: FakeStreamSession,
  type: string,
): Array<Record<string, unknown>> {
  return stream.sentFrames.filter(
    (frame) => frame.kind === "pointer" && frame.type === type,
  );
}

function touchInit(input: {
  readonly clientX: number;
  readonly clientY: number;
  readonly buttons: number;
}): Record<string, unknown> {
  return {
    pointerId: 3,
    pointerType: "touch",
    clientX: input.clientX,
    clientY: input.clientY,
    button: 0,
    buttons: input.buttons,
    detail: 0,
  };
}

function mouseInit(input: {
  readonly clientX: number;
  readonly clientY: number;
  readonly buttons: number;
}): Record<string, unknown> {
  return {
    pointerId: 1,
    pointerType: "mouse",
    clientX: input.clientX,
    clientY: input.clientY,
    button: 0,
    buttons: input.buttons,
    detail: 0,
  };
}

function presentLiveFrame(stream: FakeStreamSession): void {
  act(() => {
    stream.emit(
      {
        kind: "started",
        hasBinaryPayload: false,
        frameWidth: 800,
        frameHeight: 600,
        deviceScaleFactor: 1,
      },
      null,
    );
    stream.emit(
      {
        kind: "frame",
        hasBinaryPayload: true,
        sequence: 7,
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 800,
          deviceHeight: 600,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: 1,
        },
      },
      JPEG_SEQ_7,
    );
  });
  const image = screen.getByAltText<HTMLImageElement>("Browser screencast");
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 600),
  );
  fireEvent.load(image);
}

function renderTile(): FakeStreamSession {
  renderPeekTile(
    <BrowserPeekTile
        scope={{ kind: "epic", epicId: "epic-1" }}
      visible={hookState.visible}
      onConvertToPip={() => {}}
      node={PEEK_NODE}
      completeMeans="ended"
    />,
  );
  const stream = liveStream();
  presentLiveFrame(stream);
  return stream;
}

/** Paints a further frame, which advances the presented sequence. */
function paintNextFrame(stream: FakeStreamSession, sequence: number): void {
  act(() => {
    stream.emit(
      {
        kind: "frame",
        hasBinaryPayload: true,
        sequence,
        metadata: {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 800,
          deviceHeight: 600,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: 2,
        },
      },
      new Uint8Array([9, 9, 9]),
    );
  });
  fireEvent.load(screen.getByAltText<HTMLImageElement>("Browser screencast"));
}

function emitArmed(stream: FakeStreamSession): void {
  act(() => {
    stream.emit({ kind: "armed", hasBinaryPayload: false, armEpoch: 1 }, null);
  });
}

/**
 * The phone's own arm path: the press itself asks for control, and nothing has
 * touched the hidden IME input yet - which is what lets these tests observe
 * whether the gesture ends up focusing it.
 */
function armViaTouchDown(
  stream: FakeStreamSession,
  clientX: number,
  clientY: number,
): void {
  fireEvent.pointerDown(
    overlayButton(),
    touchInit({ clientX, clientY, buttons: 1 }),
  );
  emitArmed(stream);
}

describe("BrowserPeekTile touch translation", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("turns a finger drag into wheel frames instead of a mouse drag", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 400);
    const button = overlayButton();

    // Past the slop, then a second move that scrolls from there.
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 380, buttons: 1 }),
    );
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 350, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 400, clientY: 350, buttons: 0 }),
    );

    const wheels = pointerFrames(stream, "wheel");
    expect(wheels).toHaveLength(2);
    // Dragging the finger UP scrolls the page DOWN, so the deltas are the
    // negated finger travel.
    expect(wheels[0].deltaY).toBe(20);
    expect(wheels[1].deltaY).toBe(30);
    expect(wheels.every((frame) => frame.deltaX === 0)).toBe(true);
    // The synthesized wheel must not claim a held button, which the page would
    // read as a selection drag.
    expect(wheels.every((frame) => frame.buttons === 0)).toBe(true);
    expect(pointerFrames(stream, "down")).toHaveLength(0);
    expect(pointerFrames(stream, "up")).toHaveLength(0);
    expect(pointerFrames(stream, "move")).toHaveLength(0);
  });

  it("turns a finger tap into a click", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 300);
    const button = overlayButton();

    // Inside the slop: a finger is never perfectly still.
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 403, clientY: 302, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 403, clientY: 302, buttons: 0 }),
    );

    expect(pointerFrames(stream, "wheel")).toHaveLength(0);
    const downs = pointerFrames(stream, "down");
    const ups = pointerFrames(stream, "up");
    expect(downs).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect(downs[0].button).toBe("left");
    expect(ups[0].button).toBe("left");
    expect(document.activeElement).toBe(imeInput());
  });

  it("leaves the keyboard alone while a finger is scrolling", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 400);
    const button = overlayButton();

    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 300, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 400, clientY: 300, buttons: 0 }),
    );

    // Focusing the hidden IME input is what raises a phone's keyboard, so a
    // scroll must not end in it.
    expect(document.activeElement).not.toBe(imeInput());
  });

  it("delivers a swipe that started before the host armed the tile", () => {
    const stream = renderTile();
    const button = overlayButton();

    // The whole gesture happens inside the arm round trip - the ordinary case
    // for a first swipe on a freshly-opened tile over a relay.
    fireEvent.pointerDown(
      button,
      touchInit({ clientX: 400, clientY: 400, buttons: 1 }),
    );
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 370, buttons: 1 }),
    );
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 340, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 400, clientY: 340, buttons: 0 }),
    );
    expect(pointerFrames(stream, "wheel")).toHaveLength(0);

    emitArmed(stream);

    const wheels = pointerFrames(stream, "wheel");
    expect(wheels).toHaveLength(1);
    expect(wheels[0].deltaY).toBe(60);
    // A scroll is not a tap: no click may be synthesized from it.
    expect(pointerFrames(stream, "down")).toHaveLength(0);
  });

  it("replays a buffered swipe before the tap that followed it", () => {
    const stream = renderTile();
    const button = overlayButton();

    // Swipe, then tap, both inside the arm round trip. The page has to see them
    // in the finger's order: a tap replayed first would land on whatever was
    // under it BEFORE the scroll moved the page.
    fireEvent.pointerDown(
      button,
      touchInit({ clientX: 400, clientY: 400, buttons: 1 }),
    );
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 340, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 400, clientY: 340, buttons: 0 }),
    );
    fireEvent.pointerDown(
      button,
      touchInit({ clientX: 300, clientY: 300, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 300, clientY: 300, buttons: 0 }),
    );

    emitArmed(stream);

    const ordered = stream.sentFrames
      .filter((frame) => frame.kind === "pointer")
      .map((frame) => frame.type);
    expect(ordered).toEqual(["wheel", "down", "up"]);
  });

  it("replays a buffered tap before the swipe that followed it", () => {
    const stream = renderTile();
    const button = overlayButton();

    // The mirror of the test above: tap FIRST, then swipe, both pre-arm.
    fireEvent.pointerDown(
      button,
      touchInit({ clientX: 300, clientY: 300, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 300, clientY: 300, buttons: 0 }),
    );
    fireEvent.pointerDown(
      button,
      touchInit({ clientX: 400, clientY: 400, buttons: 1 }),
    );
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 340, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 400, clientY: 340, buttons: 0 }),
    );

    emitArmed(stream);

    const ordered = stream.sentFrames
      .filter((frame) => frame.kind === "pointer")
      .map((frame) => frame.type);
    expect(ordered).toEqual(["down", "up", "wheel"]);
  });

  it("keeps both pre-arm taps rather than dropping them as one gesture", () => {
    const stream = renderTile();
    const button = overlayButton();

    for (const [x, y] of [
      [300, 300],
      [100, 100],
    ]) {
      fireEvent.pointerDown(
        button,
        touchInit({ clientX: x, clientY: y, buttons: 1 }),
      );
      fireEvent.pointerUp(
        button,
        touchInit({ clientX: x, clientY: y, buttons: 0 }),
      );
    }

    emitArmed(stream);

    // Two taps far apart are two gestures. Neither may cancel the other.
    expect(pointerFrames(stream, "down")).toHaveLength(2);
    expect(pointerFrames(stream, "up")).toHaveLength(2);
  });

  it("drops a queued tap whose frame repainted, but still replays the scroll", () => {
    const stream = renderTile();
    const button = overlayButton();

    fireEvent.pointerDown(
      button,
      touchInit({ clientX: 400, clientY: 400, buttons: 1 }),
    );
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 340, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 400, clientY: 340, buttons: 0 }),
    );
    fireEvent.pointerDown(
      button,
      touchInit({ clientX: 300, clientY: 300, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 300, clientY: 300, buttons: 0 }),
    );

    // A new frame paints before the host answers the arm. The tap's
    // coordinates were normalized against the OLD frame, so replaying it now
    // would click whatever moved into that spot; a scroll delta is still
    // right whatever repainted underneath.
    paintNextFrame(stream, 8);
    emitArmed(stream);

    expect(pointerFrames(stream, "wheel")).toHaveLength(1);
    expect(pointerFrames(stream, "down")).toHaveLength(0);
    expect(pointerFrames(stream, "up")).toHaveLength(0);
  });

  it("does not let a discarded tap inflate the next tap's click count", () => {
    const stream = renderTile();
    const button = overlayButton();

    // Tap 1 is queued against frame 7, then frame 8 paints, so tap 1 is stale
    // and never reaches the page. Tap 2, nearby and inside the multi-click
    // window, must therefore land as a FIRST click - the page saw no first
    // click to continue.
    const tapAt = (x: number, y: number): void => {
      fireEvent.pointerDown(
        button,
        touchInit({ clientX: x, clientY: y, buttons: 1 }),
      );
      fireEvent.pointerUp(
        button,
        touchInit({ clientX: x, clientY: y, buttons: 0 }),
      );
    };

    tapAt(400, 300);
    paintNextFrame(stream, 8);
    tapAt(401, 301);
    emitArmed(stream);

    const downs = pointerFrames(stream, "down");
    expect(downs).toHaveLength(1);
    expect(downs[0].clickCount).toBe(1);

    // And the discard must not leave the counter primed either: a further tap
    // after arming is still a first click, not a third.
    tapAt(402, 302);
    const afterArm = pointerFrames(stream, "down");
    expect(afterArm).toHaveLength(2);
    expect(afterArm[1].clickCount).toBe(1);
  });

  it("refuses an armed tap whose frame repainted between press and release", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 300);
    const button = overlayButton();
    // The press already happened above, against frame 7. Repaint underneath the
    // finger, then lift.
    paintNextFrame(stream, 8);
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 400, clientY: 300, buttons: 0 }),
    );

    // Nothing is sent. The armed path used to deliver here while the queued
    // path refused the identical situation, which made the answer depend on
    // whether the host had answered the arm yet.
    expect(pointerFrames(stream, "down")).toHaveLength(0);
    expect(pointerFrames(stream, "up")).toHaveLength(0);
    // And no keyboard: focusing the hidden input before the tap was validated
    // left the phone's keyboard covering the screen for a click the page never
    // received.
    expect(document.activeElement).not.toBe(imeInput());
  });

  it("carries the frame under the press when nothing repainted", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 300);
    fireEvent.pointerUp(
      overlayButton(),
      touchInit({ clientX: 400, clientY: 300, buttons: 0 }),
    );

    const downs = pointerFrames(stream, "down");
    expect(downs).toHaveLength(1);
    expect(downs[0].castSequence).toBe(7);
  });

  it("drops a queued tap whose frame repainted between press and release", () => {
    const stream = renderTile();
    const button = overlayButton();

    // Whole gesture inside the arm window, with a repaint mid-gesture.
    fireEvent.pointerDown(
      button,
      touchInit({ clientX: 400, clientY: 300, buttons: 1 }),
    );
    paintNextFrame(stream, 8);
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 400, clientY: 300, buttons: 0 }),
    );
    emitArmed(stream);

    // The press was aimed at frame 7, which is no longer presented, so the tap
    // is refused rather than clicking whatever moved into that spot.
    expect(pointerFrames(stream, "down")).toHaveLength(0);
    expect(pointerFrames(stream, "up")).toHaveLength(0);
  });

  it("treats a flick reported only on release as a scroll, not a tap", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 400);

    // No `pointermove` at all - browsers coalesce them, and a fast flick can
    // report none before the release. The travel is only visible on the up.
    fireEvent.pointerUp(
      overlayButton(),
      touchInit({ clientX: 400, clientY: 300, buttons: 0 }),
    );

    const wheels = pointerFrames(stream, "wheel");
    expect(wheels).toHaveLength(1);
    expect(wheels[0].deltaY).toBe(100);
    // Judging on the move handler alone would have made this a click at the
    // touch-down point, and raised the keyboard over a scroll.
    expect(pointerFrames(stream, "down")).toHaveLength(0);
    expect(document.activeElement).not.toBe(imeInput());
  });

  it("delivers the last segment of a scroll that ends on release", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 400);
    const button = overlayButton();

    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 370, buttons: 1 }),
    );
    // The remaining travel is reported only by the release.
    fireEvent.pointerUp(
      button,
      touchInit({ clientX: 400, clientY: 340, buttons: 0 }),
    );

    const wheels = pointerFrames(stream, "wheel");
    expect(wheels).toHaveLength(2);
    expect(wheels[0].deltaY).toBe(30);
    // The tail is scroll the user performed; dropping it stops the page short.
    expect(wheels[1].deltaY).toBe(30);
  });

  it("keeps the primary finger scrolling when a second one is cancelled", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 400);
    const button = overlayButton();

    fireEvent.pointerDown(button, {
      ...touchInit({ clientX: 200, clientY: 200, buttons: 1 }),
      pointerId: 4,
    });
    fireEvent.pointerCancel(button, {
      ...touchInit({ clientX: 200, clientY: 200, buttons: 0 }),
      pointerId: 4,
    });
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 350, buttons: 1 }),
    );

    const wheels = pointerFrames(stream, "wheel");
    expect(wheels).toHaveLength(1);
    expect(wheels[0].deltaY).toBe(50);
  });

  it("ends the gesture when the finger that owns it is cancelled", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 400);
    const button = overlayButton();

    fireEvent.pointerCancel(
      button,
      touchInit({ clientX: 400, clientY: 400, buttons: 0 }),
    );
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 350, buttons: 1 }),
    );

    expect(pointerFrames(stream, "wheel")).toHaveLength(0);
  });

  it("ignores a second finger rather than tearing the gesture between two origins", () => {
    const stream = renderTile();
    armViaTouchDown(stream, 400, 400);
    const button = overlayButton();

    fireEvent.pointerDown(button, {
      ...touchInit({ clientX: 200, clientY: 200, buttons: 1 }),
      pointerId: 4,
    });
    fireEvent.pointerMove(button, {
      ...touchInit({ clientX: 200, clientY: 100, buttons: 1 }),
      pointerId: 4,
    });
    fireEvent.pointerMove(
      button,
      touchInit({ clientX: 400, clientY: 350, buttons: 1 }),
    );

    const wheels = pointerFrames(stream, "wheel");
    expect(wheels).toHaveLength(1);
    expect(wheels[0].deltaY).toBe(50);
  });

  it("still sends a mouse drag as pointer moves", () => {
    const stream = renderTile();
    // The desktop arm path, untouched: focus asks for control.
    fireEvent.focus(overlayButton());
    emitArmed(stream);
    const button = overlayButton();

    fireEvent.pointerDown(
      button,
      mouseInit({ clientX: 400, clientY: 400, buttons: 1 }),
    );
    fireEvent.pointerMove(
      button,
      mouseInit({ clientX: 400, clientY: 300, buttons: 1 }),
    );
    fireEvent.pointerUp(
      button,
      mouseInit({ clientX: 400, clientY: 300, buttons: 0 }),
    );

    expect(pointerFrames(stream, "wheel")).toHaveLength(0);
    expect(pointerFrames(stream, "down")).toHaveLength(1);
  });
});
