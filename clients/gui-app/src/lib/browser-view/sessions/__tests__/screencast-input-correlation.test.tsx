import { useRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BrowserScreencastClientFrame } from "@traycer/protocol/host/browser/contracts";
import {
  createScreencastController,
  type ScreencastController,
} from "@/lib/browser-view/sessions/screencast-controller";

const FRAME_SIZE = { width: 800, height: 600 } as const;

type PointerFrame = Extract<
  BrowserScreencastClientFrame,
  { readonly kind: "pointer" }
>;

function pointerFrames(
  sent: readonly BrowserScreencastClientFrame[],
): PointerFrame[] {
  return sent.filter(
    (frame): frame is PointerFrame => frame.kind === "pointer",
  );
}

/**
 * The controller driven through real DOM events on a real overlay button, so
 * pointer capture, the arm buffer and the correlation seam all run as they do
 * in the tile. The image stands in for whatever surface the plane renders -
 * only its box matters to normalization.
 */
function mountController(): {
  readonly controller: ScreencastController;
  readonly sent: BrowserScreencastClientFrame[];
  readonly overlay: HTMLElement;
} {
  const sent: BrowserScreencastClientFrame[] = [];
  const captured: { current: ScreencastController | null } = { current: null };

  function Harness(): React.JSX.Element {
    const tileRef = useRef<HTMLDivElement | null>(null);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const overlayButtonRef = useRef<HTMLButtonElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const imeInputRef = useRef<HTMLInputElement | null>(null);
    const controllerRef = useRef<ScreencastController | null>(null);
    controllerRef.current ??= createScreencastController({
      refs: { tileRef, viewportRef, overlayButtonRef, imageRef, imeInputRef },
      sendFrame: (frame) => sent.push(frame),
      listeners: {
        onLocalArmCleared: () => {},
        onComposingChange: () => {},
        onDialogSettled: () => {},
      },
    });
    captured.current = controllerRef.current;
    return (
      <div ref={tileRef}>
        <div ref={viewportRef}>
          <img ref={imageRef} alt="surface" />
          <button
            ref={overlayButtonRef}
            type="button"
            {...controllerRef.current.overlayHandlers}
          />
          <input ref={imeInputRef} />
        </div>
      </div>
    );
  }

  const view = render(<Harness />);
  const image = view.container.querySelector("img");
  if (image === null) throw new Error("no surface element");
  image.getBoundingClientRect = () =>
    new DOMRect(0, 0, FRAME_SIZE.width, FRAME_SIZE.height);
  const overlay = view.container.querySelector("button");
  if (overlay === null) throw new Error("no overlay button");
  if (captured.current === null) throw new Error("controller not created");
  const controller: ScreencastController = captured.current;
  controller.setFrameSize({ ...FRAME_SIZE });
  return { controller, sent, overlay };
}

function clickUnarmed(overlay: HTMLElement): void {
  fireEvent.pointerDown(overlay, {
    pointerId: 1,
    clientX: 200,
    clientY: 300,
    button: 0,
    buttons: 1,
    detail: 1,
  });
  fireEvent.pointerUp(overlay, {
    pointerId: 1,
    clientX: 200,
    clientY: 300,
    button: 0,
    buttons: 0,
    detail: 1,
  });
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
