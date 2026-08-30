import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserVideoStatsOverlay } from "@/components/epic-canvas/renderers/browser-video-stats-overlay";
import type {
  ScreencastDialog,
  ScreencastImeHandlers,
  ScreencastOverlayHandlers,
  ScreencastSessionRefs,
} from "@/lib/browser-view/sessions/screencast-controller";
import type { ScreencastSession } from "@/lib/browser-view/sessions/use-screencast-session";
import { EMPTY_SCREENCAST_NAV_STATE } from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";

/**
 * The input->photon probe honesty test (ticket 17): the clock must stop on
 * the first frame CAPTURED after the click, never on a frame merely
 * *observed* after it - that frame was already in flight when the click
 * landed, and reading it would report a decode interval as a round trip.
 *
 * jsdom has no `requestVideoFrameCallback`, so the `<video>` here is a plain
 * detached element with the callback monkey-patched to a manually-driven
 * queue - the same seam `browser-peek-tile-video-plane.test.tsx` notes jsdom
 * lacks.
 */
interface FakeVideoFrameCallback {
  driveFrame(now: number, captureTime: number | undefined): void;
}

function fakeVideoElement(): HTMLVideoElement & FakeVideoFrameCallback {
  const video = document.createElement("video") as HTMLVideoElement &
    FakeVideoFrameCallback;
  let handleCounter = 0;
  let pending: VideoFrameRequestCallback | null = null;
  video.requestVideoFrameCallback = (callback) => {
    pending = callback;
    handleCounter += 1;
    return handleCounter;
  };
  video.cancelVideoFrameCallback = () => {
    pending = null;
  };
  video.driveFrame = (now, captureTime) => {
    const callback = pending;
    if (callback === null) return;
    const partial: Pick<VideoFrameCallbackMetadata, "captureTime"> = {
      captureTime,
    };
    act(() => {
      callback(now, partial as VideoFrameCallbackMetadata);
    });
  };
  return video;
}

const noopOverlayHandlers: ScreencastOverlayHandlers = {
  onFocus: () => {},
  onPointerEnter: () => {},
  onPointerDown: () => {},
  onPointerMove: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {},
  onContextMenu: () => {},
};

const noopImeHandlers: ScreencastImeHandlers = {
  onFocus: () => {},
  onKeyDown: () => {},
  onKeyUp: () => {},
  onPaste: () => {},
  onCompositionStart: () => {},
  onCompositionEnd: () => {},
  onInput: () => {},
};

function buildFakeSession(input: {
  readonly button: HTMLButtonElement;
  readonly video: HTMLVideoElement;
}): ScreencastSession {
  const refs: ScreencastSessionRefs = {
    tileRef: { current: null },
    viewportRef: { current: null },
    overlayButtonRef: { current: input.button },
    imageRef: { current: null },
    videoRef: { current: input.video },
    imeInputRef: { current: null },
  };
  return {
    refs,
    image: null,
    video: { mode: "video", media: null, active: true },
    videoStats: null,
    lifecycle: "live",
    details: null,
    frameSize: null,
    navState: EMPTY_SCREENCAST_NAV_STATE,
    armedEpoch: null,
    dialog: null as ScreencastDialog | null,
    composing: false,
    disarm: () => {},
    requestNav: () => {},
    releaseForwardedPageKeys: () => {},
    respondToDialog: () => {},
    notePresented: () => {},
    agentCursor: null,
    overlayHandlers: noopOverlayHandlers,
    imeHandlers: noopImeHandlers,
  };
}

function readout(): string {
  return screen.getByText(/input→frame:/).textContent;
}

describe("BrowserVideoStatsOverlay input->photon probe", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not stop the clock on a frame captured before the pointerdown", () => {
    const button = document.createElement("button");
    const video = fakeVideoElement();
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const session = buildFakeSession({ button, video });

    render(<BrowserVideoStatsOverlay session={session} />);

    fireEvent.pointerDown(button);
    video.driveFrame(1_010, 999);

    expect(readout()).toBe("input→frame: -");
  });

  it("stops the clock on the first frame captured after the pointerdown", () => {
    const button = document.createElement("button");
    const video = fakeVideoElement();
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const session = buildFakeSession({ button, video });

    render(<BrowserVideoStatsOverlay session={session} />);

    fireEvent.pointerDown(button);
    video.driveFrame(1_010, 999);
    expect(readout()).toBe("input→frame: -");

    video.driveFrame(1_050, 1_001);
    expect(readout()).toBe("input→frame: 50ms");
  });

  it("never resolves when the stream's metadata carries no captureTime", () => {
    const button = document.createElement("button");
    const video = fakeVideoElement();
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const session = buildFakeSession({ button, video });

    render(<BrowserVideoStatsOverlay session={session} />);

    fireEvent.pointerDown(button);
    video.driveFrame(1_010, undefined);
    video.driveFrame(1_020, undefined);
    video.driveFrame(1_030, undefined);

    expect(readout()).toBe("input→frame: -");
  });
});
