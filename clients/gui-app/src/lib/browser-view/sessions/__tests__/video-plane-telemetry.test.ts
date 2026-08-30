import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import {
  createVideoPlaneSession,
  type VideoPlaneSession,
} from "@/lib/browser-view/sessions/video-plane-session";
import {
  acquireBrowserMediaEntry,
  type MediaDataChannel,
  type MediaPeer,
  type MediaPeerHandlers,
  type WebrtcSignalPort,
  type WebrtcVideoStatsSample,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

/**
 * Ticket 17's telemetry (glass-to-glass latency + DataChannel RTT), driven
 * over the REAL `createVideoPlaneSession`. Harness copied from
 * `video-plane-session.test.ts` - that file is owned by a sibling change in
 * flight, so this is a standalone copy rather than a shared import.
 */
interface FakePeer extends MediaPeer {
  readonly handlers: MediaPeerHandlers;
  closeCount: number;
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

function fakeStatsReport(input: {
  readonly framesDecoded: number;
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
        framesDropped: 0,
        packetsLost: 0,
        jitter: 0,
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
  readonly statsFrames: ({ negotiationId: number } & WebrtcVideoStatsSample)[];
  readonly statsSamples: (WebrtcVideoStatsSample | null)[];
  readonly peers: FakePeer[];
  readonly session: VideoPlaneSession;
}

function fakeStream(id: string): MediaStream {
  const partial: Pick<MediaStream, "id"> = { id };
  return partial as MediaStream;
}

let keyCounter = 0;

function setup(): PlaneState {
  const peers: FakePeer[] = [];
  const statsFrames: PlaneState["statsFrames"] = [];
  const statsSamples: PlaneState["statsSamples"] = [];
  const port: WebrtcSignalPort = {
    sendSdpAnswer: () => {},
    sendIceCandidate: () => {},
    sendVideoPlaneState: () => {},
    sendVideoStats: (input) => statsFrames.push({ ...input }),
    readControlPlaneRttMs: () => null,
  };
  keyCounter += 1;
  const media = acquireBrowserMediaEntry({
    key: {
      hostId: "host-1",
      sessionId: `telemetry-session-${keyCounter}`,
      tabId: "tab-1",
    },
    createPeer: (handlers) => {
      const peer: FakePeer = {
        handlers,
        closeCount: 0,
        statsReport: null,
        answerOffer: (sdp) => Promise.resolve(`answer-for:${sdp}`),
        addRemoteCandidate: () => Promise.resolve(),
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
    onChange: () => {},
    onVideoStats: (sample) => statsSamples.push(sample),
    readControlPlaneRttMs: () => null,
  });
  return { statsFrames, statsSamples, peers, session };
}

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
    roundTripTime: 0.01,
    candidateType: "relay",
  });
  plane.session.noteVideoFrame(null);
  return { reliable, lossy };
}

describe("video plane telemetry (ticket 17)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
