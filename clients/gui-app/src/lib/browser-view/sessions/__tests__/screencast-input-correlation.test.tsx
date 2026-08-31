import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  FRAME_SIZE,
  firePointerPress,
  mountController,
  pointerFrames,
} from "@/lib/browser-view/sessions/__tests__/screencast-controller-harness";

const CLICK_POINT = { clientX: 200, clientY: 300 } as const;

function clickUnarmed(overlay: HTMLElement): void {
  firePointerPress(overlay, CLICK_POINT);
}

/** A finger's tap - translated on its own path, not through the arm buffer. */
function tapUnarmed(overlay: HTMLElement): void {
  const touch = { pointerId: 2, pointerType: "touch", ...CLICK_POINT };
  fireEvent.pointerDown(overlay, { ...touch, button: 0, buttons: 1 });
  fireEvent.pointerUp(overlay, { ...touch, button: 0, buttons: 0 });
}

describe("screencast input correlation", () => {
  it("replays the arming click against the viewport epoch in video mode", () => {
    const { controller, sent, overlay } = mountController();
    controller.setCaptureMode("video");
    controller.noteViewportEpoch(4);

    // A video tile paints no JPEG frame, so nothing ever latches a presented
    // sequence: the epoch is the only surface this click can name.
    clickUnarmed(overlay);
    expect(pointerFrames(sent)).toEqual([]);

    controller.noteArmed(1);

    expect(pointerFrames(sent).map((frame) => frame.type)).toEqual([
      "down",
      "up",
    ]);
    for (const frame of pointerFrames(sent)) {
      expect(frame.viewportEpoch).toBe(4);
      expect(frame.castSequence).toBeNull();
      expect(frame.normalizedX).toBeCloseTo(0.25);
      expect(frame.normalizedY).toBeCloseTo(0.5);
    }
  });

  it("normalizes against the video element while the video plane paints", () => {
    const { controller, sent, overlay, video, setVideoPainting } =
      mountController();
    setVideoPainting(true);
    // Deliberately a different box from the image, so a frame normalized
    // against the wrong surface is visible in the numbers.
    video.getBoundingClientRect = () =>
      new DOMRect(0, 0, FRAME_SIZE.width / 2, FRAME_SIZE.height / 2);
    controller.setCaptureMode("video");
    controller.noteViewportEpoch(4);
    // The video box is half the image's, so the same click lands at twice the
    // normalized offset - proof the video surface is the one measured.
    controller.setFrameSize({
      width: FRAME_SIZE.width / 2,
      height: FRAME_SIZE.height / 2,
    });

    clickUnarmed(overlay);
    controller.noteArmed(1);

    for (const frame of pointerFrames(sent)) {
      expect(frame.normalizedX).toBeCloseTo(0.5);
      expect(frame.normalizedY).toBeCloseTo(1);
    }
    expect(pointerFrames(sent)).toHaveLength(2);
  });

  it("drops the arming click when the epoch moved while arming", () => {
    const { controller, sent, overlay } = mountController();
    controller.setCaptureMode("video");
    controller.noteViewportEpoch(4);

    clickUnarmed(overlay);
    controller.noteViewportEpoch(5);
    controller.noteArmed(1);

    expect(pointerFrames(sent)).toEqual([]);
  });

  it("sends nothing while no epoch is confirmed in video mode", () => {
    const { controller, sent, overlay } = mountController();
    controller.setCaptureMode("video");

    clickUnarmed(overlay);
    controller.noteArmed(1);

    expect(pointerFrames(sent)).toEqual([]);
  });

  it("keeps the JPEG plane on its painted-frame correlation", () => {
    const { controller, sent, overlay } = mountController();
    // An epoch is announced on every plane; a JPEG tile must ignore it and
    // keep correlating against what it painted.
    controller.noteViewportEpoch(4);
    controller.notePresentedSequence(7);

    clickUnarmed(overlay);
    controller.noteArmed(1);

    expect(pointerFrames(sent).map((frame) => frame.type)).toEqual([
      "down",
      "up",
    ]);
    for (const frame of pointerFrames(sent)) {
      expect(frame.castSequence).toBe(7);
      expect(frame.viewportEpoch).toBeNull();
    }
  });

  it("drops the arming click when the painted frame moved on, epoch or not", () => {
    const { controller, sent, overlay } = mountController();
    controller.noteViewportEpoch(4);
    controller.notePresentedSequence(7);

    clickUnarmed(overlay);
    controller.notePresentedSequence(8);
    controller.noteArmed(1);

    expect(pointerFrames(sent)).toEqual([]);
  });
  it("drops a gesture buffered on the other plane's token space", () => {
    // castSequence 7 and epoch 7 are different numbers that happen to be
    // equal; a press buffered under one must never replay under the other.
    const { controller, sent, overlay } = mountController();
    controller.notePresentedSequence(7);

    clickUnarmed(overlay);
    controller.setCaptureMode("video");
    controller.noteViewportEpoch(7);
    controller.noteArmed(1);

    expect(pointerFrames(sent)).toEqual([]);
  });

  it("drops a queued tap buffered on the other plane's token space", () => {
    // The finger's half of the case above: a tap waiting on `armed` carries
    // the JPEG plane's castSequence, which must not match an equal epoch.
    const { controller, sent, overlay } = mountController();
    controller.notePresentedSequence(7);

    tapUnarmed(overlay);
    controller.setCaptureMode("video");
    controller.noteViewportEpoch(7);
    controller.noteArmed(1);

    expect(pointerFrames(sent)).toEqual([]);
  });

  it("keeps a buffered gesture when the mode frame repeats the current mode", () => {
    const { controller, sent, overlay } = mountController();
    controller.notePresentedSequence(7);

    clickUnarmed(overlay);
    controller.setCaptureMode("jpeg");
    controller.noteArmed(1);

    expect(pointerFrames(sent).map((frame) => frame.type)).toEqual([
      "down",
      "up",
    ]);
  });
});
