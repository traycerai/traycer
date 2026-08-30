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
    jpegFrame(7, [1, 2, 3]);
  });
}

async function offer(negotiationId: number): Promise<void> {
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
  });

  it("answers the offer, keeps painting JPEG, and swaps on the first decoded frame", async () => {
    renderTile();
    const stream = liveStream();

    await offer(1);
    expect(sentKinds(stream)).toContain("sdpAnswer");
    expect(planeStates(stream)).toEqual([]);
    // Still the JPEG plane: no black tile while the connection comes up.
    expect(screencastImage()?.hidden).toBe(false);

    const video = attachTrack(0);
    expect(video.className).toContain("opacity-0");
    expect(planeStates(stream)).toEqual([]);
    expect(screencastImage()?.hidden).toBe(false);

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
    expect(screencastImage()?.hidden).toBe(true);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("reports failed and repaints JPEG without waiting for a started frame", async () => {
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

    // G4: `started` is latched host-side and never re-fires, so the resumed
    // JPEG pump has to paint on the frame alone.
    const before = screencastImage()?.src;
    act(() => {
      jpegFrame(8, [9, 9, 9]);
    });
    const after = screencastImage();
    expect(after?.hidden).toBe(false);
    expect(after?.src).not.toBe(before);
  });

  it("snapshots the last decoded video frame into the dormant cache on plane fallback (ticket 13)", async () => {
    stubCanvasPrototype("data:image/jpeg;base64,DORMANT_SNAPSHOT");
    renderTile();
    await offer(1);
    const video = attachTrack(0);
    markDecodedSize(video, 640, 480);
    decodeFrame(video);
    expect(screen.getByText("Live")).toBeTruthy();

    const key = browserPeekFrameKey(peekNode);
    // The JPEG cache write already ran once at mount (`renderTile`'s
    // `jpegFrame(7, ...)`); the video snapshot below must overwrite it.
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
    const stream = liveStream();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(peers).toEqual([]);
    expect(sentKinds(stream)).not.toContain("sdpAnswer");
    expect(planeStates(stream)).toEqual([]);
    expect(screen.queryByTestId("browser-screencast-video")).toBeNull();
  });

  it("ignores a duplicate offer for the round already in flight", async () => {
    renderTile();
    await offer(2);
    await offer(2);

    expect(peers).toHaveLength(1);
  });
});
