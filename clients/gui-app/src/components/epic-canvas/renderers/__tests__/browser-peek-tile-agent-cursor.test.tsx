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
  type BrowserPeekNode,
} from "@/components/epic-canvas/renderers/browser-peek-tile";
import { AGENT_CURSOR_LINGER_MS } from "@/components/epic-canvas/renderers/agent-cursor-overlay";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import type {
  MediaPeer,
  MediaPeerHandlers,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * Ticket 10, the client half: the agent ghost cursor through the REAL hook,
 * transport and tile - the host's normalized coordinates in, a positioned
 * overlay out, on both display planes.
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

function freshNode(): BrowserPeekNode {
  nodeCounter += 1;
  return {
    id: "browser-peek-headless-1",
    instanceId: "peek-instance-1",
    hostId: "host-test",
    sessionId: `headless-cursor-${nodeCounter}`,
    tabId: "headless-tab-1",
    initialUrl: "http://localhost:3000",
  };
}

function liveStream(): FakeStreamSession {
  const stream = hookState.streamClient?.sessions.at(-1);
  if (stream === undefined) throw new Error("expected screencast stream");
  return stream;
}

/** The overlay measures its own box; jsdom reports zero without this. */
function sizeOverlay(width: number, height: number): void {
  const overlay = screen.getByTestId("browser-agent-cursor-overlay");
  Object.defineProperty(overlay, "clientWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(overlay, "clientHeight", {
    configurable: true,
    value: height,
  });
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
    liveStream().emit(
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
      new Uint8Array([1, 2, 3]),
    );
  });
}

function emitCursor(input: {
  readonly type: "move" | "down" | "up";
  readonly epoch: number;
  readonly normalizedX: number;
  readonly normalizedY: number;
}): void {
  act(() => {
    liveStream().emit(
      {
        kind: "agentCursor",
        hasBinaryPayload: false,
        label: "Log in",
        ...input,
      },
      null,
    );
  });
}

function cursorMarker(): HTMLElement | null {
  return screen.queryByTestId("browser-agent-cursor");
}

/** Puts the tile on the video plane with a decoded 800x600 track. */
async function switchToVideoPlane(): Promise<void> {
  await act(async () => {
    liveStream().emit(
      {
        kind: "sdpOffer",
        hasBinaryPayload: false,
        negotiationId: 1,
        sdp: "o",
        iceServers: [],
      },
      null,
    );
    await Promise.resolve();
  });
  act(() => {
    peers[0]?.handlers.onStream(fakeStream("track-0"));
  });
  const video = screen.getByTestId("browser-screencast-video");
  Object.defineProperty(video, "videoWidth", {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(video, "videoHeight", {
    configurable: true,
    value: 600,
  });
  act(() => {
    fireEvent.loadedMetadata(video);
    fireEvent.timeUpdate(video);
  });
  act(() => {
    liveStream().emit(
      { kind: "captureMode", hasBinaryPayload: false, mode: "video" },
      null,
    );
    liveStream().emit(
      { kind: "viewportEpoch", hasBinaryPayload: false, epoch: 3 },
      null,
    );
  });
}

describe("BrowserPeekTile agent ghost cursor", () => {
  beforeEach(() => {
    peers.length = 0;
    peekNode = freshNode();
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("positions the labeled cursor inside the letterboxed surface", () => {
    renderTile();
    sizeOverlay(400, 400);

    // 800x600 contained in 400x400 paints 400x300 with a 50px band above it.
    emitCursor({ type: "move", epoch: 0, normalizedX: 0.5, normalizedY: 0.5 });

    const marker = cursorMarker();
    expect(marker?.style.transform).toBe("translate(200px, 200px)");
    expect(screen.getByText("Log in")).toBeTruthy();
    expect(marker?.dataset.visible).toBe("true");
    expect(screen.queryByTestId("browser-agent-cursor-ripple")).toBeNull();
  });

  it("ripples on a press", () => {
    renderTile();
    sizeOverlay(400, 400);

    emitCursor({ type: "down", epoch: 0, normalizedX: 0.25, normalizedY: 0.5 });

    expect(screen.getByTestId("browser-agent-cursor-ripple")).toBeTruthy();
    expect(cursorMarker()?.style.transform).toBe("translate(100px, 200px)");
  });

  it("fades out once the agent stops pointing", () => {
    vi.useFakeTimers();
    try {
      renderTile();
      sizeOverlay(400, 400);
      emitCursor({
        type: "move",
        epoch: 0,
        normalizedX: 0.5,
        normalizedY: 0.5,
      });
      expect(cursorMarker()?.dataset.visible).toBe("true");

      act(() => {
        vi.advanceTimersByTime(AGENT_CURSOR_LINGER_MS);
      });

      expect(cursorMarker()?.dataset.visible).toBe("false");
      expect(cursorMarker()?.className).toContain("opacity-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws a cursor stamped with any epoch while the JPEG plane paints", () => {
    renderTile();
    sizeOverlay(400, 400);

    // No viewport epoch was ever announced: a JPEG tile has none, and a
    // cursor overlay has nothing to correlate per frame.
    emitCursor({ type: "move", epoch: 99, normalizedX: 0.5, normalizedY: 0.5 });

    expect(cursorMarker()).not.toBeNull();
  });

  it("ignores a superseded epoch once the video plane is painting", async () => {
    renderTile();
    await switchToVideoPlane();
    sizeOverlay(400, 400);

    emitCursor({ type: "move", epoch: 2, normalizedX: 0.5, normalizedY: 0.5 });
    expect(cursorMarker()).toBeNull();

    emitCursor({ type: "move", epoch: 3, normalizedX: 0.5, normalizedY: 0.5 });
    expect(cursorMarker()?.style.transform).toBe("translate(200px, 200px)");
  });
});
