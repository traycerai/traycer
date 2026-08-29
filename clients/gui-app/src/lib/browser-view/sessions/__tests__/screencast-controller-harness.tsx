import { useRef } from "react";
import { render } from "@testing-library/react";
import type { BrowserScreencastClientFrame } from "@traycer/protocol/host/browser/contracts";
import {
  createScreencastController,
  type ScreencastController,
} from "@/lib/browser-view/sessions/screencast-controller";

export const FRAME_SIZE = { width: 800, height: 600 } as const;

export type PointerFrame = Extract<
  BrowserScreencastClientFrame,
  { readonly kind: "pointer" }
>;

export function pointerFrames(
  sent: readonly BrowserScreencastClientFrame[],
): PointerFrame[] {
  return sent.filter(
    (frame): frame is PointerFrame => frame.kind === "pointer",
  );
}

export interface MountedController {
  readonly controller: ScreencastController;
  /** Frames that went out on the mux (`sendFrame`). */
  readonly sent: BrowserScreencastClientFrame[];
  readonly overlay: HTMLElement;
  readonly image: HTMLImageElement;
  readonly video: HTMLVideoElement;
  readonly imeInput: HTMLInputElement;
}

/**
 * The controller driven through real DOM events on a real overlay button, so
 * pointer capture, the arm buffer and the correlation seam all run as they do
 * in the tile. The image stands in for whatever surface the plane renders -
 * only its box matters to normalization.
 */
export function mountController(): MountedController {
  const sent: BrowserScreencastClientFrame[] = [];
  const captured: { current: ScreencastController | null } = { current: null };

  function Harness(): React.JSX.Element {
    const tileRef = useRef<HTMLDivElement | null>(null);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const overlayButtonRef = useRef<HTMLButtonElement | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const imeInputRef = useRef<HTMLInputElement | null>(null);
    const controllerRef = useRef<ScreencastController | null>(null);
    controllerRef.current ??= createScreencastController({
      refs: {
        tileRef,
        viewportRef,
        overlayButtonRef,
        imageRef,
        videoRef,
        imeInputRef,
      },
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
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the video plane's paint surface, not media content. */}
          <video ref={videoRef} />
          <button
            ref={overlayButtonRef}
            type="button"
            {...controllerRef.current.overlayHandlers}
          />
          <input ref={imeInputRef} {...controllerRef.current.imeHandlers} />
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
  const video = view.container.querySelector("video");
  if (video === null) throw new Error("no video surface");
  video.getBoundingClientRect = () =>
    new DOMRect(0, 0, FRAME_SIZE.width, FRAME_SIZE.height);
  const imeInput = view.container.querySelector("input");
  if (imeInput === null) throw new Error("no IME input");
  return { controller, sent, overlay, image, video, imeInput };
}
