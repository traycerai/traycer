import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserScreencastServerFrame,
  BrowserVideoPlaneFailureReason,
} from "@traycer/protocol/host/browser/contracts";
import {
  createVideoPlaneSession,
  type VideoPlaneSession,
  type VideoPlaneView,
} from "@/lib/browser-view/sessions/video-plane-session";
import { isVideoPlaneStale } from "@/lib/browser-view/sessions/use-screencast-session";
import {
  acquireBrowserMediaEntry,
  activeBrowserMediaKeyIds,
  RELEASE_GRACE_MS,
  type MediaDataChannel,
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

interface FakeChannel extends MediaDataChannel {
  readonly sent: string[];
  open: boolean;
}

function fakeChannel(label: string): FakeChannel {
  const channel: FakeChannel = {
    label,
    sent: [],
    open: true,
    isOpen: () => channel.open,
    send: (payload) => {
      channel.sent.push(payload);
    },
    close: () => {
      channel.open = false;
    },
    onStateChange: null,
  };
  return channel;
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
    /** Closed enum on the wire; the free-form half rides `detail`. */
    reason: BrowserVideoPlaneFailureReason | null;
    detail: string | null;
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

/**
 * The host's answer to a DataChannel ping. NOT `pong`: that kind belongs to
 * the stream transport's heartbeat, which swallows it client-side before this
 * handler ever runs (ticket 18 - it is why this measurement read null in
 * production while this test was green against the wrong frame).
 */
function inputPongFrame(): BrowserScreencastServerFrame {
  return { kind: "inputPong", hasBinaryPayload: false };
}

function frameMetadata(input: {
  readonly captureTime: number;
  readonly receiveTime: number;
  readonly expectedDisplayTime: number;
}): VideoFrameCallbackMetadata {
  const partial: Pick<
    VideoFrameCallbackMetadata,
    "captureTime" | "receiveTime" | "expectedDisplayTime"
  > = input;
  return partial as VideoFrameCallbackMetadata;
}

/** The registry answers through a promise chain; let it settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Answers the offer, opens both input channels, and reports the first frame live. */
async function goLive(
  plane: PlaneState,
  negotiationId: number,
): Promise<{ readonly reliable: FakeChannel; readonly lossy: FakeChannel }> {
  plane.session.handleServerFrame(offerFrame(negotiationId, "offer-sdp"));
  await settle();
  const peer = plane.peers[0];
  peer.handlers.onStream(fakeStream("track"));
  const reliable = fakeChannel("input-reliable");
  const lossy = fakeChannel("input-lossy");
  peer.handlers.onDataChannel(reliable);
  peer.handlers.onDataChannel(lossy);
  peer.statsReport = fakeStatsReport({
    framesDecoded: 1,
    framesDropped: 0,
    packetsLost: 0,
    jitter: 0,
    roundTripTime: 0.01,
    candidateType: "relay",
  });
  plane.session.noteVideoFrame(null);
  return { reliable, lossy };
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
      { negotiationId: 3, state: "live", reason: null, detail: null },
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

  it("delegates duplicate and stale rounds to the registry", async () => {
    // The session forwards every offer verbatim; the round rules live in the
    // registry. Mutation: adding a same-id or monotonic guard HERE - the
    // second copy would drift from the registry's and silently drop a
    // legitimate same-id ICE-restart re-offer (the case below).
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
      { negotiationId: 3, state: "live", reason: null, detail: null },
      { negotiationId: 3, state: "live", reason: null, detail: null },
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
      detail: null,
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
        reason: "no-first-frame",
        detail: null,
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
        reason: "no-first-frame",
        detail: null,
      },
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
        reason: "no-first-frame",
        detail: null,
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
        reason: "no-first-frame",
        detail: null,
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

  /**
   * Ticket 17's telemetry (glass-to-glass latency + DataChannel RTT), driven
   * over the same real `createVideoPlaneSession` harness above. The
   * stale/duplicate-round rule itself is pinned once, at the registry layer
   * (`webrtc-media-registry.test.ts`) - nothing here re-pins it.
   */
  describe("telemetry (ticket 17)", () => {
    it("carries the real glass-to-glass median/p95 once frames report timings", async () => {
      const plane = setup();
      await goLive(plane, 1);

      plane.session.noteVideoFrame(
        frameMetadata({
          captureTime: 0,
          receiveTime: 20,
          expectedDisplayTime: 50,
        }),
      );
      plane.session.noteVideoFrame(
        frameMetadata({
          captureTime: 0,
          receiveTime: 20,
          expectedDisplayTime: 50,
        }),
      );

      await settle();
      vi.advanceTimersByTime(5_000);
      await settle();

      const frame = plane.statsFrames.at(-1);
      expect(frame?.glassToGlassMs).toBe(50);
      expect(frame?.glassToGlassP95Ms).toBe(50);
      expect(frame?.networkPlusJitterMs).toBe(20);
      expect(frame?.decodeCompositeMs).toBe(30);
    });

    it("keeps every latency field null for metadata-less frames, never NaN", async () => {
      const plane = setup();
      await goLive(plane, 1);
      plane.session.noteVideoFrame(null);
      plane.session.noteVideoFrame(null);

      await settle();
      vi.advanceTimersByTime(5_000);
      await settle();

      const frame = plane.statsFrames.at(-1);
      expect(frame?.glassToGlassMs).toBeNull();
      expect(frame?.glassToGlassP95Ms).toBeNull();
      expect(frame?.networkPlusJitterMs).toBeNull();
      expect(frame?.decodeCompositeMs).toBeNull();
    });

    it("abandons a still-outstanding ping after one tick and sends a replacement the tick after", async () => {
      const plane = setup();
      const { reliable } = await goLive(plane, 1);

      // `goLive`'s own `publish()` already ran the round's first sample tick,
      // which sent the first ping (no pong ever arrives in this test).
      await settle();
      expect(reliable.sent).toHaveLength(1);
      const firstPayload: unknown = JSON.parse(reliable.sent[0] ?? "");
      expect(firstPayload).toEqual({ kind: "ping", hasBinaryPayload: false });

      // Tick 2: the ping from tick 1 is still outstanding - abandoned, not
      // replaced, since a late pong next to a fresh ping could not be told
      // apart (no correlation id on the wire).
      vi.advanceTimersByTime(5_000);
      await settle();
      expect(reliable.sent).toHaveLength(1);

      // Tick 3: the abandoned slot is empty again, so a replacement goes out.
      vi.advanceTimersByTime(5_000);
      await settle();
      expect(reliable.sent).toHaveLength(2);
    });

    it("reports a finite dataChannelRttMs on the sample after an inputPong lands", async () => {
      const plane = setup();
      await goLive(plane, 1);

      // `goLive`'s own `publish()` already sent the round's first ping.
      await settle();
      expect(plane.statsSamples.at(-1)?.dataChannelRttMs).toBeNull();

      plane.session.handleServerFrame(inputPongFrame());

      vi.advanceTimersByTime(5_000);
      await settle();

      const rtt = plane.statsSamples.at(-1)?.dataChannelRttMs ?? null;
      expect(rtt).not.toBeNull();
      expect(Number.isFinite(rtt)).toBe(true);
      expect(rtt).toBeGreaterThanOrEqual(0);
    });

    it("never pings, and dataChannelRttMs stays null, while inputReady is false", async () => {
      const plane = setup();
      plane.session.handleServerFrame(offerFrame(1, "offer-sdp"));
      await settle();
      const peer = plane.peers[0];
      peer.handlers.onStream(fakeStream("track"));
      // No `onDataChannel` calls here - channels never open, so `inputReady`
      // stays false and `sendInput` (and thus the ping) is refused.
      peer.statsReport = fakeStatsReport({
        framesDecoded: 1,
        framesDropped: 0,
        packetsLost: 0,
        jitter: 0,
        roundTripTime: 0.01,
        candidateType: "relay",
      });
      plane.session.noteVideoFrame(null);

      await settle();
      vi.advanceTimersByTime(5_000);
      await settle();

      expect(plane.statsSamples.at(-1)?.dataChannelRttMs).toBeNull();
    });
  });
});

/** `VIEWER_CONTROL_PLANE_DEADLINES.staleWithoutFrame`'s floor. */
const STALE_AFTER_MS = 8_000;

/**
 * The post-occlusion window: the tile was hidden for minutes, came back at
 * `visibleSince`, and the last PRESENTED frame predates the whole stretch.
 */
const RETURN = {
  visibleSince: 100_000,
  videoFrameAt: 20_000,
  now: 100_000 + STALE_AFTER_MS,
} as const;

describe("isVideoPlaneStale", () => {
  it("does not declare a decoding stream dead when compositing has not resumed", () => {
    // `requestVideoFrameCallback` is exactly what is fragile across the
    // visible edge, so decode progress - not presentation - is the evidence.
    expect(
      isVideoPlaneStale({
        ...RETURN,
        decodeAdvancedAt: RETURN.now - 1_000,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(false);
  });

  it("still declares a stream dead when decoding actually stopped", () => {
    expect(
      isVideoPlaneStale({
        ...RETURN,
        decodeAdvancedAt: RETURN.visibleSince - 40_000,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(true);
    // No stats sample at all is no evidence, not evidence of life.
    expect(
      isVideoPlaneStale({
        ...RETURN,
        decodeAdvancedAt: null,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(true);
  });

  it("never judges a round over the window it was hidden for", () => {
    // Decode and presentation both predate the return, but the tile has only
    // been observable for a moment: the clock runs from `visibleSince`.
    expect(
      isVideoPlaneStale({
        ...RETURN,
        now: RETURN.visibleSince + 1_000,
        decodeAdvancedAt: 20_000,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(false);
  });

  it("counts presentation too, once it is the fresher signal", () => {
    expect(
      isVideoPlaneStale({
        visibleSince: RETURN.visibleSince,
        videoFrameAt: RETURN.now - 500,
        decodeAdvancedAt: 20_000,
        now: RETURN.now,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).toBe(false);
  });
});
