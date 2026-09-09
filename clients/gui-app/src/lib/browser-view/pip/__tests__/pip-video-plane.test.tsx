import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakeMediaPeer,
  fakeMediaStream,
} from "@/components/epic-canvas/renderers/__tests__/browser-peek-tile-stream-fixture";
import { usePipSharedVideoStream } from "@/lib/browser-view/pip/pip-video-plane";
import {
  acquireBrowserMediaEntry,
  activeBrowserMediaKeyIds,
  browserMediaKeyId,
  type BrowserMediaEntry,
  type MediaPeerHandlers,
  type WebrtcSignalPort,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * PiP against the REAL module-scoped registry - the point of the ticket is
 * that PiP is a second consumer of the tile's entry, so a fake registry would
 * assert nothing. Only the peer connection is stood in (jsdom has no
 * `RTCPeerConnection`), through the registry's own `createPeer` seam.
 */
const peers: Array<{ readonly handlers: MediaPeerHandlers; closed: boolean }> =
  [];
const createFakePeer = createFakeMediaPeer(peers);

interface RecorderPort {
  readonly port: WebrtcSignalPort;
  readonly sendSdpAnswerCalls: number[];
  readonly sendVideoPlaneStateCalls: number[];
}

function recorderPort(): RecorderPort {
  const sendSdpAnswerCalls: number[] = [];
  const sendVideoPlaneStateCalls: number[] = [];
  return {
    port: {
      sendSdpAnswer: () => {
        sendSdpAnswerCalls.push(1);
      },
      sendIceCandidate: () => undefined,
      sendVideoPlaneState: () => {
        sendVideoPlaneStateCalls.push(1);
      },
      sendVideoStats: () => undefined,
      readControlPlaneRttMs: () => null,
    },
    sendSdpAnswerCalls,
    sendVideoPlaneStateCalls,
  };
}

/** Every value the hook returned, in render order - not just the committed one. */
const renderedStreamIds: string[] = [];

function PipProbe(props: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}) {
  const stream = usePipSharedVideoStream(props);
  renderedStreamIds.push(stream?.id ?? "");
  return <div data-testid="pip-probe" data-stream-id={stream?.id ?? ""} />;
}

function probeStreamId(): string {
  return screen.getByTestId("pip-probe").dataset.streamId ?? "";
}

interface TileHandle {
  readonly entry: BrowserMediaEntry;
  readonly recorder: RecorderPort;
  readonly release: () => void;
}

/**
 * The tile's acquire. It has to happen before PiP's in every case here: the
 * record keeps the FIRST acquirer's peer factory, and PiP hands over the real
 * `createBrowserMediaPeer` (identical to the tile's in production, but jsdom
 * has no `RTCPeerConnection` to build).
 */
function tileAcquire(key: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}): TileHandle {
  const handle = acquireBrowserMediaEntry({ key, createPeer: createFakePeer });
  return {
    entry: handle.entry,
    recorder: recorderPort(),
    release: handle.release,
  };
}

/** The tile's negotiation: offer, answer, inbound track. */
async function tileNegotiate(
  tile: TileHandle,
  streamId: string,
): Promise<void> {
  await act(async () => {
    tile.entry.acceptOffer({
      negotiationId: 1,
      sdp: "offer-1",
      port: tile.recorder.port,
      iceServers: [],
    });
    await Promise.resolve();
  });
  act(() => {
    peers.at(-1)?.handlers.onStream(fakeMediaStream(streamId));
  });
}

async function tileWithLiveTrack(input: {
  readonly key: {
    readonly hostId: string;
    readonly sessionId: string;
    readonly tabId: string;
  };
  readonly streamId: string;
}): Promise<TileHandle> {
  const tile = tileAcquire(input.key);
  await tileNegotiate(tile, input.streamId);
  return tile;
}

afterEach(() => {
  cleanup();
  peers.length = 0;
  renderedStreamIds.length = 0;
  vi.useRealTimers();
});

describe("PiP shared video stream", () => {
  it("attaches the tile's existing stream without negotiating", async () => {
    const key = {
      hostId: "host-a",
      sessionId: "session-a",
      tabId: "tab-a",
    };
    const tile = await tileWithLiveTrack({ key, streamId: "track-a" });
    const peersAfterTile = peers.length;

    render(<PipProbe {...key} />);

    expect(probeStreamId()).toBe("track-a");
    // PiP is a passive attacher: no second peer, no second answer, and no
    // liveness report of its own against the shared entry.
    expect(peers.length).toBe(peersAfterTile);
    expect(tile.recorder.sendSdpAnswerCalls.length).toBe(1);
    expect(tile.recorder.sendVideoPlaneStateCalls.length).toBe(0);

    tile.release();
  });

  it("picks up a track that arrives after it mounted", async () => {
    const key = {
      hostId: "host-b",
      sessionId: "session-b",
      tabId: "tab-b",
    };
    const tile = tileAcquire(key);
    render(<PipProbe {...key} />);
    expect(probeStreamId()).toBe("");

    await tileNegotiate(tile, "track-b");

    expect(probeStreamId()).toBe("track-b");
    tile.release();
  });

  it("keeps its JPEG path when no stream exists", () => {
    // No tile ever negotiated for this key, so the registry record PiP creates
    // is idle. Nothing here builds a peer - `createBrowserMediaPeer` would
    // throw in jsdom if the passive attacher ever called `acceptOffer`.
    render(<PipProbe hostId="host-c" sessionId="session-c" tabId="tab-c" />);

    expect(probeStreamId()).toBe("");
    expect(peers).toHaveLength(0);
  });

  it("never paints the previous tab's track for one render after a tab switch", async () => {
    // M12: React reads the snapshot during a render whose key has already
    // changed but whose subscription effect has not re-run yet, so `entryRef`
    // still holds the OUTGOING tab's entry. Mutation: dropping the
    // `held.key !== key` guard in `readStream` - the committed DOM still ends
    // up empty, so only the per-render trace catches the wrong tab's pixels.
    const live = { hostId: "host-e", sessionId: "session-e", tabId: "tab-e" };
    const idle = { hostId: "host-e", sessionId: "session-e", tabId: "tab-f" };
    const tile = await tileWithLiveTrack({ key: live, streamId: "track-e" });
    const view = render(<PipProbe {...live} />);
    expect(probeStreamId()).toBe("track-e");

    renderedStreamIds.length = 0;
    act(() => {
      view.rerender(<PipProbe {...idle} />);
    });

    expect(renderedStreamIds).not.toContain("track-e");
    expect(probeStreamId()).toBe("");
    tile.release();
    view.unmount();
  });

  it("holds the entry open when the tile closes, and releases on its own close", async () => {
    vi.useFakeTimers();
    const key = {
      hostId: "host-d",
      sessionId: "session-d",
      tabId: "tab-d",
    };
    const tile = await tileWithLiveTrack({ key, streamId: "track-d" });
    const view = render(<PipProbe {...key} />);
    expect(probeStreamId()).toBe("track-d");

    // Tile closed, PiP remains: the refcount keeps the entry (and its peer
    // connection object) alive past the grace window, and nobody negotiates a
    // new round on it. In production the HOST then closes the capture helper
    // that has no non-idle viewer left, the track ends, and the registry's own
    // failure path drops PiP back to JPEG (asserted below) with no gap, since
    // PiP's own JPEG pump was never capture-disabled.
    act(() => {
      tile.release();
      vi.advanceTimersByTime(5_000);
    });
    expect(activeBrowserMediaKeyIds()).toContain(browserMediaKeyId(key));
    expect(probeStreamId()).toBe("track-d");

    act(() => {
      peers.at(-1)?.handlers.onFailure("track-ended");
    });
    expect(probeStreamId()).toBe("");

    act(() => {
      view.unmount();
      vi.advanceTimersByTime(5_000);
    });
    expect(activeBrowserMediaKeyIds()).not.toContain(browserMediaKeyId(key));
  });
});
