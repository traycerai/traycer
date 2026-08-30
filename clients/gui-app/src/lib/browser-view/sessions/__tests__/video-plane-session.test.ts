import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import {
  createVideoPlaneSession,
  type VideoPlaneSession,
  type VideoPlaneView,
} from "@/lib/browser-view/sessions/video-plane-session";
import {
  acquireBrowserMediaEntry,
  activeBrowserMediaKeyIds,
  RELEASE_GRACE_MS,
  type MediaPeer,
  type MediaPeerHandlers,
  type WebrtcIceCandidate,
  type WebrtcSignalPort,
  type WebrtcVideoStatsSample,
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
  /** `null` reads as "no inbound-rtp yet" - `mapWebrtcVideoStats` returns null for it. */
  statsReport: RTCStatsReport | null;
}

/** A minimal `RTCStatsReport`-shaped report: inbound-rtp + a nominated candidate pair. */
function fakeStatsReport(input: {
  readonly framesDecoded: number;
  readonly framesDropped: number;
  readonly packetsLost: number;
  readonly jitter: number;
  readonly roundTripTime: number;
  readonly candidateType: string;
}): RTCStatsReport {
  const map = new Map<string, unknown>([
    [
      "inbound-1",
      {
        type: "inbound-rtp",
        kind: "video",
        framesDecoded: input.framesDecoded,
        framesDropped: input.framesDropped,
        packetsLost: input.packetsLost,
        jitter: input.jitter,
      },
    ],
    [
      "pair-1",
      {
        type: "candidate-pair",
        id: "pair-1",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: input.roundTripTime,
        localCandidateId: "local-1",
      },
    ],
    [
      "local-1",
      {
        type: "local-candidate",
        id: "local-1",
        candidateType: input.candidateType,
      },
    ],
  ]);
  return map;
}

interface PlaneState {
  readonly answers: {
    negotiationId: number;
    sdp: string;
    candidates: readonly WebrtcIceCandidate[];
  }[];
  readonly states: {
    negotiationId: number;
    state: "live" | "failed";
    reason: string | null;
  }[];
  readonly statsFrames: ({ negotiationId: number } & WebrtcVideoStatsSample)[];
  readonly statsSamples: (WebrtcVideoStatsSample | null)[];
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

/** The common case: a subscription with no measured control-plane RTT yet. */
function setup(): PlaneState {
  return setupWithRtt(() => null);
}

function setupWithRtt(readControlPlaneRttMs: () => number | null): PlaneState {
  const peers: FakePeer[] = [];
  const answers: PlaneState["answers"] = [];
  const states: PlaneState["states"] = [];
  const statsFrames: PlaneState["statsFrames"] = [];
  const statsSamples: PlaneState["statsSamples"] = [];
  const views: VideoPlaneView[] = [];
  const port: WebrtcSignalPort = {
    sendSdpAnswer: (input) => answers.push({ ...input }),
    sendIceCandidate: () => {},
    sendVideoPlaneState: (input) => states.push({ ...input }),
    sendVideoStats: (input) => statsFrames.push({ ...input }),
    readControlPlaneRttMs,
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
        statsReport: null,
        answerOffer: (sdp) => {
          peer.offers.push(sdp);
          // Models gathering finishing before the answer settles, same as
          // `webrtc-media-registry.test.ts`'s default harness - the A12
          // batching mechanics are that module's own to pin.
          handlers.onIceGatheringComplete();
          return Promise.resolve(`answer-for:${sdp}`);
        },
        addRemoteCandidate: (candidate) => {
          peer.remoteCandidates.push(candidate);
          return Promise.resolve();
        },
        getStats: () => Promise.resolve(peer.statsReport ?? new Map()),
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
    onVideoStats: (sample) => statsSamples.push(sample),
    readControlPlaneRttMs,
  });
  openSessions.push(session);
  return { answers, states, statsFrames, statsSamples, views, peers, session };
}

/** Every setup takes a registry lease; `afterEach` gives them all back. */
const openSessions: VideoPlaneSession[] = [];

function offerFrame(
  negotiationId: number,
  sdp: string,
): BrowserScreencastServerFrame {
  return {
    kind: "sdpOffer",
    hasBinaryPayload: false,
    negotiationId,
    sdp,
    iceServers: [],
  };
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
    for (const session of openSessions) session.close();
    openSessions.length = 0;
    // The registry disposes a released entry after its grace window.
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(activeBrowserMediaKeyIds()).toEqual([]);
    vi.useRealTimers();
  });

  it("answers an offer and only reports live on the first decoded frame", async () => {
    const plane = setup();

    plane.session.handleServerFrame(offerFrame(3, "offer-sdp"));
    await settle();
    expect(plane.answers).toEqual([
      { negotiationId: 3, sdp: "answer-for:offer-sdp", candidates: [] },
    ]);
    expect(plane.views.at(-1)).toEqual({ media: null, active: false });

    // The track alone is not liveness: the element mounts to decode, but the
    // tile stays on its connecting loader until a pixel actually lands.
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    expect(plane.views.at(-1)).toEqual({
      media: fakeStream("track"),
      active: false,
    });
    expect(plane.states).toEqual([]);
    expect(plane.session.lastVideoFrameAt()).toBeNull();

    plane.session.noteVideoFrame(null);

    expect(plane.states).toEqual([
      { negotiationId: 3, state: "live", reason: null },
    ]);
    expect(plane.views.at(-1)).toEqual({
      media: fakeStream("track"),
      active: true,
    });
    expect(plane.session.lastVideoFrameAt()).not.toBeNull();

    plane.session.noteVideoFrame(null);
    plane.session.noteVideoFrame(null);
    expect(plane.states).toHaveLength(1);
  });

  it("re-reports live after a same-id ICE-restart re-offer heals", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(3, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    plane.session.noteVideoFrame(null);
    expect(plane.states).toHaveLength(1);

    // The host restarts ICE on the SAME negotiationId; its restart deadline
    // is cancelled only by a fresh `live`, so the first decoded frame after
    // the restart must re-report it - and only once.
    plane.session.handleServerFrame(offerFrame(3, "restart-sdp"));
    await settle();
    plane.session.noteVideoFrame(null);
    plane.session.noteVideoFrame(null);

    expect(plane.states).toEqual([
      { negotiationId: 3, state: "live", reason: null },
      { negotiationId: 3, state: "live", reason: null },
    ]);
  });

  it("reverts to jpeg and stops owning liveness when the peer fails", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(3, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    plane.session.noteVideoFrame(null);

    plane.peers[0]?.handlers.onFailure("track-ended");

    expect(plane.states.at(-1)).toEqual({
      negotiationId: 3,
      state: "failed",
      reason: "track-ended",
    });
    expect(plane.views.at(-1)).toEqual({ media: null, active: false });
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
    expect(plane.views.at(-1)).toEqual({ media: null, active: false });
  });

  it("keeps a live round past the deadline window", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(1, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    plane.session.noteVideoFrame(null);

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
      { negotiationId: 4, sdp: "answer-for:offer-sdp", candidates: [] },
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

  it("samples getStats every 5s while live and sends the round's negotiationId", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(3, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    plane.session.noteVideoFrame(null);
    const peer = plane.peers[0];
    peer.statsReport = fakeStatsReport({
      framesDecoded: 150,
      framesDropped: 1,
      packetsLost: 0,
      jitter: 0.004,
      roundTripTime: 0.042,
      candidateType: "relay",
    });

    // The live-round entry publish() already ran a sample; advancing one
    // more interval is the cadence assertion.
    await settle();
    vi.advanceTimersByTime(5_000);
    await settle();

    expect(plane.statsFrames.at(-1)).toEqual({
      negotiationId: 3,
      framesDecoded: 150,
      framesDropped: 1,
      packetsLost: 0,
      jitterMs: 4,
      roundTripTimeMs: 42,
      // No rVFC metadata was fed and the channels are not up, so ticket 17's
      // timings have nothing to report - null, and not a fabricated zero.
      glassToGlassMs: null,
      glassToGlassP95Ms: null,
      networkPlusJitterMs: null,
      decodeCompositeMs: null,
      dataChannelRttMs: null,
      iceCandidatePairType: "relay",
    });
    expect(plane.statsSamples.at(-1)).toEqual({
      framesDecoded: 150,
      framesDropped: 1,
      packetsLost: 0,
      jitterMs: 4,
      roundTripTimeMs: 42,
      glassToGlassMs: null,
      glassToGlassP95Ms: null,
      networkPlusJitterMs: null,
      decodeCompositeMs: null,
      dataChannelRttMs: null,
      iceCandidatePairType: "relay",
    });

    peer.statsReport = fakeStatsReport({
      framesDecoded: 300,
      framesDropped: 1,
      packetsLost: 0,
      jitter: 0.003,
      roundTripTime: 0.04,
      candidateType: "relay",
    });
    vi.advanceTimersByTime(5_000);
    await settle();

    expect(plane.statsFrames).toHaveLength(2);
    expect(plane.statsFrames.at(-1)?.framesDecoded).toBe(300);
  });

  it("stops sampling stats once the round is no longer live", async () => {
    const plane = setup();
    plane.session.handleServerFrame(offerFrame(1, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));
    plane.session.noteVideoFrame(null);
    await settle();
    const sampledWhileLive = plane.statsFrames.length;

    plane.peers[0]?.handlers.onFailure("track-ended");
    vi.advanceTimersByTime(20_000);
    await settle();

    expect(plane.statsFrames).toHaveLength(sampledWhileLive);
  });

  it("arms the first-frame deadline at 6x the measured rtt, not the 15s floor (ticket 18)", async () => {
    // rtt clamps at 3000ms, so the deadline is 6 * 3000 = 18000ms, above the
    // 15000ms floor a null rtt would use.
    const plane = setupWithRtt(() => 3_000);
    plane.session.handleServerFrame(offerFrame(1, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));

    vi.advanceTimersByTime(15_000);
    expect(plane.states).toEqual([]);

    vi.advanceTimersByTime(2_999);
    expect(plane.states).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(plane.states).toEqual([
      {
        negotiationId: 1,
        state: "failed",
        reason: "no decoded video frame before deadline",
      },
    ]);
  });

  it("arms the first-frame deadline at exactly the 15000ms floor with no measured rtt", async () => {
    const plane = setupWithRtt(() => null);
    plane.session.handleServerFrame(offerFrame(1, "offer-sdp"));
    await settle();
    plane.peers[0]?.handlers.onStream(fakeStream("track"));

    vi.advanceTimersByTime(14_999);
    expect(plane.states).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(plane.states).toEqual([
      {
        negotiationId: 1,
        state: "failed",
        reason: "no decoded video frame before deadline",
      },
    ]);
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
