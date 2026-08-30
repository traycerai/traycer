import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserPeekTile,
  browserPeekFrameKey,
  clearLastBrowserPeekFrame,
  getLastBrowserPeekFrame,
  type BrowserPeekNode,
} from "@/components/epic-canvas/renderers/browser-peek-tile";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import type {
  MediaPeer,
  MediaPeerHandlers,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * The video plane end to end through the REAL hook, controller, transport and
 * media registry: only the peer connection is stood in, through the registry's
 * own `createPeer` seam (jsdom has no `RTCPeerConnection`).
 */
const peers = vi.hoisted(
  () => [] as Array<{ readonly handlers: MediaPeerHandlers; closed: boolean }>,
);

vi.mock("@/lib/browser-view/tiles/webrtc-media-registry", async (original) => {
  const actual =
    await original<
      typeof import("@/lib/browser-view/tiles/webrtc-media-registry")
    >();
  const createBrowserMediaPeer = (handlers: MediaPeerHandlers): MediaPeer => {
    const peer = { handlers, closed: false };
    peers.push(peer);
    return {
      answerOffer: (sdp) => {
        // Models gathering finishing before the answer settles - the A12
        // batching mechanics are `webrtc-media-registry.test.ts`'s to pin.
        handlers.onIceGatheringComplete();
        return Promise.resolve(`answer-for:${sdp}`);
      },
      addRemoteCandidate: () => Promise.resolve(),
      getStats: () => Promise.resolve(new Map()),
      close: () => {
        peer.closed = true;
      },
    };
  };
  return { ...actual, createBrowserMediaPeer };
});

/** jsdom has no `MediaStream`; only its identity travels to `srcObject`. */
function fakeStream(id: string): MediaStream {
  const partial: Pick<MediaStream, "id"> = { id };
  return partial as MediaStream;
}

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-test",
}));

vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () => ({
  useTileBodyVisible: () => hookState.visible,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ hostId: "host-test" }),
}));

vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => hookState.streamClient,
}));

vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () =>
    (_epicId: string, _tabId: string, prepare: () => unknown): unknown =>
      prepare(),
}));

let nodeCounter = 0;
let peekNode: BrowserPeekNode = freshNode();

/**
 * A distinct session id per test: the media registry is module-scoped and its
 * entries outlive a test by the release grace, so a shared key would carry a
 * previous test's round into the next one.
 */
function freshNode(): BrowserPeekNode {
  nodeCounter += 1;
  return {
    id: "browser-peek-headless-1",
    instanceId: "peek-instance-1",
    hostId: "host-test",
    sessionId: `headless-${nodeCounter}`,
    tabId: "headless-tab-1",
    initialUrl: "http://localhost:3000",
  };
}

function liveStream(): FakeStreamSession {
  const stream = hookState.streamClient?.sessions.at(-1);
  if (stream === undefined) throw new Error("expected screencast stream");
  return stream;
}

function sentKinds(stream: FakeStreamSession): string[] {
  return stream.sentFrames.map((frame) => String(frame.kind));
}

function planeStates(
  stream: FakeStreamSession,
): Array<Record<string, unknown>> {
  return stream.sentFrames.filter((frame) => frame.kind === "videoPlaneState");
}

function jpegFrame(sequence: number, bytes: readonly number[]): void {
  liveStream().emit(
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
        timestamp: 1,
      },
    },
    new Uint8Array([...bytes]),
  );
}

/**
 * A subscription on a host that will attempt video: the JPEG cast is off from
 * the start (ticket 26), so nothing paints until a plane does.
 */
function renderTile(): void {
  render(
    <BrowserPeekTile
      viewTabId="view-tab-1"
      paneId="pane-1"
      epicId="epic-1"
      node={peekNode}
    />,
  );
  act(() => {
    liveStream().emitStatus("open");
  });
}

/** The cast's geometry, which the host announces once and never re-sends. */
function emitStarted(): void {
  act(() => {
    liveStream().emit(
      {
        kind: "started",
        hasBinaryPayload: false,
        frameWidth: 800,
        frameHeight: 600,
        deviceScaleFactor: 1,
      },
      null,
    );
  });
}

/** The JPEG plane running: what a fallback (or a host with no video) looks like. */
function paintJpeg(sequence: number, bytes: readonly number[]): void {
  emitStarted();
  act(() => {
    jpegFrame(sequence, bytes);
  });
}

function emitCaptureMode(mode: "jpeg" | "video"): void {
  act(() => {
    liveStream().emit(
      { kind: "captureMode", hasBinaryPayload: false, mode },
      null,
    );
  });
}

/**
 * The host's round start: the cast stops, the pump re-mints the viewport epoch
 * input now correlates against, then the offer arrives.
 */
async function offer(negotiationId: number): Promise<void> {
  emitCaptureMode("video");
  act(() => {
    liveStream().emit(
      { kind: "viewportEpoch", hasBinaryPayload: false, epoch: 9 },
      null,
    );
  });
  await act(async () => {
    liveStream().emit(
      {
        kind: "sdpOffer",
        hasBinaryPayload: false,
        negotiationId,
        sdp: `offer-${negotiationId}`,
        iceServers: [],
      },
      null,
    );
    await Promise.resolve();
  });
}

/** Armed, with the overlay button given a real box to normalize against. */
function armTile(): HTMLElement {
  const button = screen.getByRole("button", {
    name: "Browser screencast controls",
  });
  act(() => {
    fireEvent.focus(button);
    liveStream().emit(
      { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
      null,
    );
  });
  return button;
}

function clickTile(button: HTMLElement): void {
  const init = { pointerId: 1, clientX: 400, clientY: 300, detail: 0 };
  fireEvent.pointerDown(button, { ...init, button: 0, buttons: 1 });
  fireEvent.pointerUp(button, { ...init, button: 0, buttons: 0 });
}

function pointerFrames(): Array<Record<string, unknown>> {
  return liveStream().sentFrames.filter((frame) => frame.kind === "pointer");
}

/** jsdom lays nothing out; the plane's own box is what normalization reads. */
function giveSurfaceABox(element: HTMLElement): void {
  element.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
}

/**
 * An occluded window, which is what a backgrounded desktop app is: the page
 * keeps running and keeps receiving, it just stops presenting.
 */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  act(() => {
    fireEvent(document, new Event("visibilitychange"));
  });
}

function restoreVisibility(): void {
  // Deleting the own property hands `visibilityState` back to the prototype.
  Reflect.deleteProperty(document, "visibilityState");
}

/**
 * jsdom loads no resources, so an `<img>` never completes on its own - which
 * is exactly the state a frame decoded inside a hidden window leaves behind:
 * pixels are there, the load event the tile listens for is not.
 */
function markImageComplete(image: HTMLImageElement): void {
  Object.defineProperty(image, "complete", {
    configurable: true,
    value: true,
  });
}

function loaderShown(): boolean {
  return screen.queryByTestId("screencast-connecting") !== null;
}

/** The tile mounts the element on `ontrack`; a decoded frame makes it live. */
function attachTrack(index: number): HTMLVideoElement {
  act(() => {
    peers[index]?.handlers.onStream(fakeStream(`track-${index}`));
  });
  const video = screen.getByTestId("browser-screencast-video");
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error("expected a video element");
  }
  return video;
}

function decodeFrame(video: HTMLVideoElement): void {
  // jsdom has no `requestVideoFrameCallback`, so the hook's media-progress
  // fallback is what carries liveness here.
  act(() => {
    fireEvent.timeUpdate(video);
  });
}

function screencastImage(): HTMLImageElement | null {
  const image = screen.queryByAltText("Browser screencast");
  return image instanceof HTMLImageElement ? image : null;
}

/**
 * jsdom's `<video>` always reports 0x0 - a decoded frame here is simulated,
 * not real, so `snapshotVideoFrameIntoPeekCache`'s dimension guard passes.
 */
function markDecodedSize(
  video: HTMLVideoElement,
  width: number,
  height: number,
): void {
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: width },
    videoHeight: { configurable: true, value: height },
  });
}

/**
 * jsdom has no canvas 2D backend - stubbed the same way
 * `browser-peek-tile-video-snapshot.test.ts` stubs it, so this suite can
 * assert the hook actually reaches `snapshotVideoFrameIntoPeekCache` at the
 * right teardown moment, not just that the pure function's guards hold in
 * isolation.
 */
function stubCanvasPrototype(dataUrl: string): void {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ drawImage: () => {} }),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: () => dataUrl,
  });
}

const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);
const originalToDataURL = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "toDataURL",
);

function restoreCanvasPrototype(): void {
  if (originalGetContext !== undefined) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "getContext",
      originalGetContext,
    );
  }
  if (originalToDataURL !== undefined) {
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "toDataURL",
      originalToDataURL,
    );
  }
}

describe("BrowserPeekTile video plane", () => {
  beforeEach(() => {
    peers.length = 0;
    peekNode = freshNode();
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    clearLastBrowserPeekFrame(browserPeekFrameKey(peekNode));
    restoreCanvasPrototype();
    restoreVisibility();
  });

  it("holds the connecting loader through negotiation, then paints video with no JPEG underneath", async () => {
    renderTile();
    const stream = liveStream();
    expect(loaderShown()).toBe(true);

    await offer(1);
    expect(sentKinds(stream)).toContain("sdpAnswer");
    expect(planeStates(stream)).toEqual([]);
    expect(loaderShown()).toBe(true);
    expect(screencastImage()).toBeNull();

    const video = attachTrack(0);
    // Mounted to decode, still invisible - over the loader, never over a JPEG
    // frame the host is no longer producing.
    expect(video.className).toContain("opacity-0");
    expect(planeStates(stream)).toEqual([]);
    expect(loaderShown()).toBe(true);
    expect(screencastImage()).toBeNull();

    decodeFrame(video);

    expect(planeStates(stream)).toEqual([
      {
        kind: "videoPlaneState",
        hasBinaryPayload: false,
        negotiationId: 1,
        state: "live",
        reason: null,
      },
    ]);
    expect(video.className).not.toContain("opacity-0");
    expect(screencastImage()).toBeNull();
    expect(loaderShown()).toBe(false);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("drops the JPEG frame for the loader when a renegotiation stops the cast, then paints video", async () => {
    renderTile();
    paintJpeg(7, [1, 2, 3]);
    expect(screencastImage()).not.toBeNull();
    expect(loaderShown()).toBe(false);

    // The host stopped the cast to attempt video: the frame on screen is the
    // last of a plane that is no longer producing, so it goes.
    await offer(1);
    expect(screencastImage()).toBeNull();
    expect(loaderShown()).toBe(true);

    const video = attachTrack(0);
    decodeFrame(video);
    expect(loaderShown()).toBe(false);
    expect(screencastImage()).toBeNull();
    expect(video.className).not.toContain("opacity-0");
  });

  it("falls back to the loader, then to JPEG once frames actually arrive", async () => {
    renderTile();
    await offer(1);
    const video = attachTrack(0);
    decodeFrame(video);

    act(() => {
      peers[0]?.handlers.onFailure("track-ended");
    });
    // The host restarts its capture on the fallback, which takes a moment;
    // until a frame lands there is nothing honest to paint.
    emitCaptureMode("jpeg");
    expect(screen.queryByTestId("browser-screencast-video")).toBeNull();
    expect(screencastImage()).toBeNull();
    expect(loaderShown()).toBe(true);

    paintJpeg(8, [9, 9, 9]);
    expect(screencastImage()).not.toBeNull();
    expect(loaderShown()).toBe(false);
  });

  it("reports failed and repaints JPEG on the frame alone", async () => {
    renderTile();
    const stream = liveStream();
    await offer(1);
    const video = attachTrack(0);
    decodeFrame(video);

    act(() => {
      peers[0]?.handlers.onFailure("track-ended");
    });

    expect(planeStates(stream).at(-1)).toEqual({
      kind: "videoPlaneState",
      hasBinaryPayload: false,
      negotiationId: 1,
      state: "failed",
      reason: "track-ended",
    });
    expect(peers[0]?.closed).toBe(true);
    expect(screen.queryByTestId("browser-screencast-video")).toBeNull();

    // `started` is latched host-side and does not re-fire for a cast that has
    // already run once, so a resumed pump has to paint on the frame alone.
    act(() => {
      jpegFrame(8, [9, 9, 9]);
    });
    expect(screencastImage()).not.toBeNull();
    expect(loaderShown()).toBe(false);
  });

  it("snapshots the last decoded video frame into the dormant cache on plane fallback (ticket 13)", async () => {
    stubCanvasPrototype("data:image/jpeg;base64,DORMANT_SNAPSHOT");
    renderTile();
    paintJpeg(7, [1, 2, 3]);
    await offer(1);
    const video = attachTrack(0);
    markDecodedSize(video, 640, 480);
    decodeFrame(video);
    expect(screen.getByText("Live")).toBeTruthy();

    const key = browserPeekFrameKey(peekNode);
    // The JPEG cache write already ran once (`paintJpeg` above); the video
    // snapshot below must overwrite it.
    const beforeFallback = getLastBrowserPeekFrame(key)?.src;

    act(() => {
      peers[0]?.handlers.onFailure("track-ended");
    });

    // B1 regression: the video plane's own state (and `videoActive`) has
    // already flipped to JPEG by the time this teardown runs - the same
    // commit that unmounts `<video>`. Only a snapshot taken from the value
    // as of the render being torn down, not the new one, lands here.
    expect(screen.queryByTestId("browser-screencast-video")).toBeNull();
    expect(getLastBrowserPeekFrame(key)?.src).toBe(
      "data:image/jpeg;base64,DORMANT_SNAPSHOT",
    );
    expect(getLastBrowserPeekFrame(key)?.src).not.toBe(beforeFallback);
  });

  it("keeps a video tile live past the JPEG stale window", async () => {
    // Installed BEFORE the tile mounts: the 8s stale interval is created at
    // mount, and a real one would never fire under `advanceTimersByTime`.
    vi.useFakeTimers();
    renderTile();
    await offer(1);
    const video = attachTrack(0);
    decodeFrame(video);

    // No JPEG frame can arrive - the host turned the pump off - so the 8s
    // stale timer would condemn a perfectly healthy tile (G3).
    for (let elapsed = 0; elapsed < 12_000; elapsed += 1_000) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      decodeFrame(video);
    }

    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.queryByText("Stale")).toBeNull();
  });

  it("reports failed and goes stale when the video track freezes", async () => {
    // Installed BEFORE the tile mounts: the 8s stale interval is created at
    // mount, and a real one would never fire under `advanceTimersByTime`.
    vi.useFakeTimers();
    renderTile();
    const stream = liveStream();
    await offer(1);
    const video = attachTrack(0);
    decodeFrame(video);

    act(() => {
      vi.advanceTimersByTime(12_000);
    });

    expect(screen.getByText("Stale")).toBeTruthy();
    // The frozen track is the one failure no deadline covers; without the
    // report the host's JPEG pump stays off and the tile has no plane at all.
    expect(planeStates(stream).at(-1)).toEqual({
      kind: "videoPlaneState",
      hasBinaryPayload: false,
      negotiationId: 1,
      state: "failed",
      reason: "video frames stopped",
    });
    expect(screen.queryByTestId("browser-screencast-video")).toBeNull();
  });

  it("stays on JPEG when the host advertises video but never offers", () => {
    vi.useFakeTimers();
    renderTile();
    paintJpeg(7, [1, 2, 3]);
    const stream = liveStream();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(peers).toEqual([]);
    expect(sentKinds(stream)).not.toContain("sdpAnswer");
    expect(planeStates(stream)).toEqual([]);
    expect(screen.queryByTestId("browser-screencast-video")).toBeNull();
    // Never offered means the cast never stopped: the JPEG plane keeps it.
    expect(screencastImage()).not.toBeNull();
    expect(loaderShown()).toBe(false);
  });

  it("withholds pointer input until the video plane has decoded a frame", async () => {
    renderTile();
    // Geometry without pixels: the frame size is known all the way through, so
    // the ONLY thing withholding a pointer below is the missing paint surface.
    emitStarted();
    await offer(1);
    const button = armTile();
    giveSurfaceABox(button);

    // (a) The connecting loader: no plane at all, nothing to aim at.
    clickTile(button);
    expect(pointerFrames()).toEqual([]);

    // (b) The track arrived and the element is mounted, but it has decoded
    // nothing - it is a blank box over the same loader, not a surface.
    const video = attachTrack(0);
    giveSurfaceABox(video);
    markDecodedSize(video, 800, 600);
    act(() => {
      fireEvent(video, new Event("resize"));
    });
    clickTile(button);
    expect(pointerFrames()).toEqual([]);

    // (c) The first decoded frame is the boundary: now there are pixels the
    // viewer can see, and a pointer means something.
    decodeFrame(video);
    clickTile(button);
    expect(pointerFrames().map((frame) => frame.type)).toEqual(["down", "up"]);
  });

  it("ignores a duplicate offer for the round already in flight", async () => {
    renderTile();
    await offer(2);
    await offer(2);

    expect(peers).toHaveLength(1);
  });

  it("does not condemn a live round while the window cannot see it", async () => {
    vi.useFakeTimers();
    renderTile();
    const stream = liveStream();
    await offer(1);
    const video = attachTrack(0);
    decodeFrame(video);
    expect(planeStates(stream)).toHaveLength(1);

    // Occluded: frame presentation stops on a track that is still arriving and
    // still decoding, so the only liveness signal this side has goes quiet for
    // reasons that say nothing about the stream. Judging it here tears down a
    // healthy round and strands the viewer on a plane it must renegotiate.
    setVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(planeStates(stream)).toHaveLength(1);
    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.getByText("Live")).toBeTruthy();

    // Back on screen, still frozen: the clock restarts from the return, so a
    // round that really is dead is caught one window later - never on the
    // strength of the hidden stretch alone.
    setVisibility("visible");
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(planeStates(stream)).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(planeStates(stream).at(-1)).toEqual({
      kind: "videoPlaneState",
      hasBinaryPayload: false,
      negotiationId: 1,
      state: "failed",
      reason: "video frames stopped",
    });
  });

  it("still calls a JPEG tile stale while the window is hidden", () => {
    vi.useFakeTimers();
    renderTile();
    paintJpeg(1, [1, 2, 3]);

    // JPEG liveness is stamped when a frame ARRIVES, not when it paints, so
    // it carries the same meaning to a hidden window: frames that stopped
    // coming stopped for a reason nobody is looking away from.
    setVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(12_000);
    });

    expect(screen.getByText("Stale")).toBeTruthy();
  });

  it("gives a round a full window of observable time after the window returns", async () => {
    vi.useFakeTimers();
    renderTile();
    const stream = liveStream();
    await offer(1);
    // A round whose channels opened but whose media never flows: only the
    // first-frame deadline bounds it, and it is fed by frame presentation.
    attachTrack(0);

    setVisibility("hidden");
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(planeStates(stream)).toEqual([]);

    // Back on screen almost two windows in. Restarting the clock blind while
    // hidden would leave one about to expire, condemning the round seconds
    // after the viewer could first have seen anything - on a first-attempt
    // round that is a bare loader, with the JPEG cast stopped underneath.
    setVisibility("visible");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(planeStates(stream)).toEqual([]);

    // The window is measured from the return, and a round that still has not
    // painted by the end of it is still judged.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(planeStates(stream).at(-1)).toEqual({
      kind: "videoPlaneState",
      hasBinaryPayload: false,
      negotiationId: 1,
      state: "failed",
      reason: "no decoded video frame before deadline",
    });
  });

  it("restores JPEG input after a fallback whose frame landed while hidden", async () => {
    vi.useFakeTimers();
    renderTile();
    await offer(1);
    const video = attachTrack(0);
    decodeFrame(video);
    const button = armTile();
    giveSurfaceABox(button);

    // The round dies and the host turns its JPEG pump back on. By the time the
    // frame that follows arrives the window is occluded, so it decodes with no
    // `<img>` load event reaching the tile - and a resting page sends no second
    // frame to try again with.
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.queryByTestId("browser-screencast-video")).toBeNull();
    setVisibility("hidden");
    emitCaptureMode("jpeg");
    paintJpeg(37, [1, 2, 3]);
    const image = screencastImage();
    if (image === null) throw new Error("expected the JPEG plane to paint");
    giveSurfaceABox(image);
    markImageComplete(image);

    // The field symptom: the host still holds the arm, and every click is
    // dropped here with nothing to correlate it against.
    clickTile(button);
    expect(pointerFrames()).toEqual([]);

    // Coming back reads the sequence off the element that already decoded,
    // rather than waiting on a load event that has been and gone.
    setVisibility("visible");
    clickTile(button);

    expect(pointerFrames().map((frame) => frame.type)).toEqual(["down", "up"]);
    expect(pointerFrames()[0]?.castSequence).toBe(37);
  });
});
