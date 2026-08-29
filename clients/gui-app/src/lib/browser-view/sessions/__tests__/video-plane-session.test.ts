import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import {
  createVideoPlaneSession,
  type VideoPlaneSession,
  type VideoPlaneView,
} from "@/lib/browser-view/sessions/video-plane-session";
import {
  acquireBrowserMediaEntry,
  type MediaPeer,
  type MediaPeerHandlers,
  type WebrtcIceCandidate,
  type WebrtcSignalPort,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * The tile's plane machine driven against the REAL media registry (ticket 09),
 * with only the peer connection faked - jsdom has none, and the seam the
 * registry offers for exactly this is its `createPeer` factory.
 */
interface FakePeer extends MediaPeer {
  readonly handlers: MediaPeerHandlers;
  readonly offers: string[];
  readonly remoteCandidates: WebrtcIceCandidate[];
  closeCount: number;
}

interface PlaneState {
  readonly answers: { negotiationId: number; sdp: string }[];
  readonly states: {
    negotiationId: number;
    state: "live" | "failed";
    reason: string | null;
  }[];
  readonly views: VideoPlaneView[];
  readonly peers: FakePeer[];
  readonly session: VideoPlaneSession;
}

/** jsdom has no `MediaStream`; only its identity is carried through. */
function fakeStream(id: string): MediaStream {
  const partial: Pick<MediaStream, "id"> = { id };
  return partial as MediaStream;
}

let keyCounter = 0;

function setup(): PlaneState {
  const peers: FakePeer[] = [];
  const answers: PlaneState["answers"] = [];
  const states: PlaneState["states"] = [];
  const views: VideoPlaneView[] = [];
  const port: WebrtcSignalPort = {
    sendSdpAnswer: (input) => answers.push({ ...input }),
    sendIceCandidate: () => {},
    sendVideoPlaneState: (input) => states.push({ ...input }),
  };
  keyCounter += 1;
  const media = acquireBrowserMediaEntry({
    key: {
      hostId: "host-1",
      sessionId: `session-${keyCounter}`,
      tabId: "tab-1",
    },
    createPeer: (handlers) => {
      const peer: FakePeer = {
        handlers,
        offers: [],
        remoteCandidates: [],
        closeCount: 0,
        answerOffer: (sdp) => {
          peer.offers.push(sdp);
          return Promise.resolve(`answer-for:${sdp}`);
        },
        addRemoteCandidate: (candidate) => {
          peer.remoteCandidates.push(candidate);
          return Promise.resolve();
        },
        close: () => {
          peer.closeCount += 1;
        },
      };
      peers.push(peer);
      return peer;
    },
  });
  const session = createVideoPlaneSession({
    media,
    port,
    onChange: (view) => views.push(view),
  });
  return { answers, states, views, peers, session };
}

function offerFrame(
  negotiationId: number,
  sdp: string,
): BrowserScreencastServerFrame {
  return { kind: "sdpOffer", hasBinaryPayload: false, negotiationId, sdp };
}

function iceFrame(
  negotiationId: number,
  candidate: string,
): BrowserScreencastServerFrame {
  return {
    kind: "iceCandidate",
    hasBinaryPayload: false,
    negotiationId,
    candidate,
    sdpMid: "0",
    sdpMLineIndex: 0,
  };
}

/** The registry answers through a promise chain; let it settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("video plane session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers an offer and only reports live on the first decoded frame", async () => {
    const plane = setup();

    plane.session.handleServerFrame(offerFrame(3, "offer-sdp"));
    await settle();
    expect(plane.answers).toEqual([
      { negotiationId: 3, sdp: "answer-for:offer-sdp" },
    ]);
    expect(plane.views.at(-1)?.mode).toBe("negotiating");

    // The track alone is not liveness: reporting here would kill the JPEG
    // pump before a single pixel had been decoded.
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    expect(plane.views.at(-1)).toEqual({
      mode: "negotiating",
      media: fakeStream("track"),
    });
    expect(plane.states).toEqual([]);
    expect(plane.session.lastVideoFrameAt()).toBeNull();

    plane.session.noteVideoFrame();

    expect(plane.states).toEqual([
      { negotiationId: 3, state: "live", reason: null },
    ]);
    expect(plane.views.at(-1)?.mode).toBe("video");
    expect(plane.session.lastVideoFrameAt()).not.toBeNull();

    plane.session.noteVideoFrame();
    plane.session.noteVideoFrame();
    expect(plane.states).toHaveLength(1);
  });

  it("reverts to jpeg and stops owning liveness when the peer fails", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(3, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    plane.session.noteVideoFrame();

    plane.peers[0]?.handlers.onFailure("track-ended");

    expect(plane.states.at(-1)).toEqual({
      negotiationId: 3,
      state: "failed",
      reason: "track-ended",
    });
    expect(plane.views.at(-1)).toEqual({ mode: "jpeg", media: null });
    // Liveness goes back to the JPEG pump's clock the moment video stops.
    expect(plane.session.lastVideoFrameAt()).toBeNull();
  });

  it("fails the round when no frame is decoded before the deadline", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(1, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));

    vi.advanceTimersByTime(15_000);

    expect(plane.states).toEqual([
      {
        negotiationId: 1,
        state: "failed",
        reason: "no decoded video frame before deadline",
      },
    ]);
    expect(plane.views.at(-1)).toEqual({ mode: "jpeg", media: null });
  });

  it("keeps a live round past the deadline window", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(1, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    plane.session.noteVideoFrame();

    vi.advanceTimersByTime(60_000);

    expect(plane.states.map((state) => state.state)).toEqual(["live"]);
  });

  it("re-arms the deadline for a superseding round", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(1, "first"));
    await settle();
    vi.advanceTimersByTime(10_000);

    plane.session.handleServerFrame(offerFrame(2, "second"));
    await settle();
    // The first round's remaining 5s must not condemn the fresh one.
    vi.advanceTimersByTime(10_000);
    expect(plane.states).toEqual([]);

    vi.advanceTimersByTime(5_000);
    expect(plane.states).toEqual([
      {
        negotiationId: 2,
        state: "failed",
        reason: "no decoded video frame before deadline",
      },
    ]);
  });

  it("leaves duplicate and stale rounds to the registry", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(4, "offer-sdp"));
    plane.session.handleServerFrame(offerFrame(4, "offer-again"));
    plane.session.handleServerFrame(offerFrame(2, "older-round"));
    await settle();

    expect(plane.peers).toHaveLength(1);
    expect(plane.answers).toEqual([
      { negotiationId: 4, sdp: "answer-for:offer-sdp" },
    ]);
  });

  it("routes trickled candidates for the round in flight", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(4, "offer-sdp"));
    await settle();

    plane.session.handleServerFrame(iceFrame(4, "candidate:remote"));
    plane.session.handleServerFrame(iceFrame(3, "candidate:stale"));

    expect(
      plane.peers[0]?.remoteCandidates.map((entry) => entry.candidate),
    ).toEqual(["candidate:remote"]);
  });

  it("stops publishing and cancels its deadline once closed", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(1, "offer-sdp"));
    await settle();
    const seen = plane.views.length;

    plane.session.close();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    vi.advanceTimersByTime(60_000);

    expect(plane.views).toHaveLength(seen);
    expect(plane.states).toEqual([]);
  });
});
