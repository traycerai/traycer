import { describe, expect, it } from "vitest";
import {
  browserScreencastClientFrameSchema,
  browserScreencastServerFrameSchema,
  browserScreencastV1,
} from "@traycer/protocol/host/browser/contracts";

function parsesClient(frame: unknown): boolean {
  return (
    browserScreencastClientFrameSchema.safeParse(frame).success &&
    browserScreencastV1.clientFrameSchema.safeParse(frame).success
  );
}

function parsesServer(frame: unknown): boolean {
  return (
    browserScreencastServerFrameSchema.safeParse(frame).success &&
    browserScreencastV1.serverFrameSchema.safeParse(frame).success
  );
}

describe("browser.screencast@1.0 WebRTC video-plane frames", () => {
  it("round-trips the host offer + trickle ICE (host is the offerer)", () => {
    expect(
      parsesServer({
        kind: "sdpOffer",
        hasBinaryPayload: false,
        negotiationId: 1,
        sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
      }),
    ).toBe(true);
    expect(
      parsesServer({
        kind: "iceCandidate",
        hasBinaryPayload: false,
        negotiationId: 1,
        candidate: "candidate:1 1 UDP 2113937151 10.0.0.1 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      }),
    ).toBe(true);
    expect(
      parsesServer({
        kind: "iceCandidate",
        hasBinaryPayload: false,
        negotiationId: 1,
        candidate: "",
        sdpMid: null,
        sdpMLineIndex: null,
      }),
    ).toBe(true);
  });

  it("defaults sdpOffer.iceServers to [] for an older host that sends none", () => {
    const parsed = browserScreencastServerFrameSchema.parse({
      kind: "sdpOffer",
      hasBinaryPayload: false,
      negotiationId: 1,
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
    });
    expect(parsed).toMatchObject({ iceServers: [] });
  });

  it("round-trips a sdpOffer carrying a TURN entry", () => {
    const turnServer = {
      urls: [
        "turn:turn.example.com:3478?transport=udp",
        "turns:turn.example.com:443?transport=tcp",
      ],
      username: "turn-user-fixture",
      credential: "turn-credential-fixture",
    };
    const parsed = browserScreencastServerFrameSchema.parse({
      kind: "sdpOffer",
      hasBinaryPayload: false,
      negotiationId: 1,
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
      iceServers: [turnServer],
    });
    expect(parsed).toMatchObject({ iceServers: [turnServer] });
    expect(
      parsesServer({
        kind: "sdpOffer",
        hasBinaryPayload: false,
        negotiationId: 1,
        sdp: "v=0\r\n",
        iceServers: [
          {
            urls: ["stun:stun.example.com:19302"],
            username: null,
            credential: null,
          },
        ],
      }),
    ).toBe(true);
  });

  it("round-trips the client answer + trickle ICE", () => {
    expect(
      parsesClient({
        kind: "sdpAnswer",
        hasBinaryPayload: false,
        negotiationId: 1,
        sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
      }),
    ).toBe(true);
    expect(
      parsesClient({
        kind: "iceCandidate",
        hasBinaryPayload: false,
        negotiationId: 1,
        candidate: "candidate:1 1 UDP 2113937151 10.0.0.1 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      }),
    ).toBe(true);
  });

  it("defaults sdpAnswer.candidates to [] for an older client that sends none", () => {
    const parsed = browserScreencastClientFrameSchema.parse({
      kind: "sdpAnswer",
      hasBinaryPayload: false,
      negotiationId: 1,
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n",
    });
    expect(parsed).toMatchObject({ candidates: [] });
  });

  it("round-trips a sdpAnswer carrying A12's batched ICE candidates", () => {
    const candidates = [
      {
        candidate: "candidate:1 1 UDP 2113937151 10.0.0.1 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
      {
        candidate: "candidate:2 1 UDP 2113937151 10.0.0.2 54322 typ host",
        sdpMid: null,
        sdpMLineIndex: null,
      },
    ];
    const parsed = browserScreencastClientFrameSchema.parse({
      kind: "sdpAnswer",
      hasBinaryPayload: false,
      negotiationId: 1,
      sdp: "v=0\r\n",
      candidates,
    });
    expect(parsed).toMatchObject({ candidates });
  });

  it("rejects signaling frames missing negotiationId (no optional-field bypass)", () => {
    expect(
      parsesServer({
        kind: "sdpOffer",
        hasBinaryPayload: false,
        sdp: "v=0\r\n",
      }),
    ).toBe(false);
    expect(
      parsesClient({
        kind: "sdpAnswer",
        hasBinaryPayload: false,
        sdp: "v=0\r\n",
      }),
    ).toBe(false);
  });

  it("parses the agent ghost-cursor overlay frame (server -> client)", () => {
    expect(
      parsesServer({
        kind: "agentCursor",
        hasBinaryPayload: false,
        type: "move",
        epoch: 2,
        normalizedX: 0.4,
        normalizedY: 0.6,
        label: "agent",
      }),
    ).toBe(true);
    expect(
      parsesServer({
        kind: "agentCursor",
        hasBinaryPayload: false,
        type: "click",
        epoch: 2,
        normalizedX: 0.4,
        normalizedY: 0.6,
        label: "agent",
      }),
    ).toBe(false);
  });

  it("rejects an agentCursor frame missing the viewport epoch", () => {
    expect(
      parsesServer({
        kind: "agentCursor",
        hasBinaryPayload: false,
        type: "move",
        normalizedX: 0.4,
        normalizedY: 0.6,
        label: "agent",
      }),
    ).toBe(false);
  });

  it("parses the captureMode transition frame (server -> client)", () => {
    expect(
      parsesServer({
        kind: "captureMode",
        hasBinaryPayload: false,
        mode: "video",
      }),
    ).toBe(true);
    expect(
      parsesServer({
        kind: "captureMode",
        hasBinaryPayload: false,
        mode: "jpeg",
      }),
    ).toBe(true);
    expect(
      parsesServer({
        kind: "captureMode",
        hasBinaryPayload: false,
        mode: "png",
      }),
    ).toBe(false);
  });

  it("parses the client's receive-side videoStats frame (client -> host)", () => {
    expect(
      parsesClient({
        kind: "videoStats",
        hasBinaryPayload: false,
        negotiationId: 1,
        framesDecoded: 900,
        framesDropped: 3,
        packetsLost: 0,
        jitterMs: 4.2,
        roundTripTimeMs: 18,
        glassToGlassMs: 62,
        iceCandidatePairType: "srflx",
      }),
    ).toBe(true);
    expect(
      parsesClient({
        kind: "videoStats",
        hasBinaryPayload: false,
        negotiationId: 1,
        framesDecoded: 900,
        framesDropped: 3,
        packetsLost: 0,
        jitterMs: 4.2,
        roundTripTimeMs: 18,
        glassToGlassMs: null,
        iceCandidatePairType: "host",
      }),
    ).toBe(true);
  });

  it("defaults ticket 17's additive videoStats timings to null for an older client", () => {
    const parsed = browserScreencastClientFrameSchema.parse({
      kind: "videoStats",
      hasBinaryPayload: false,
      negotiationId: 1,
      framesDecoded: 900,
      framesDropped: 3,
      packetsLost: 0,
      jitterMs: 4.2,
      roundTripTimeMs: 18,
      glassToGlassMs: null,
      iceCandidatePairType: "host",
    });
    expect(parsed).toMatchObject({
      glassToGlassP95Ms: null,
      networkPlusJitterMs: null,
      decodeCompositeMs: null,
      dataChannelRttMs: null,
    });
  });

  it("carries the full ticket 17 timing set when a current client sends it", () => {
    expect(
      parsesClient({
        kind: "videoStats",
        hasBinaryPayload: false,
        negotiationId: 1,
        framesDecoded: 900,
        framesDropped: 3,
        packetsLost: 0,
        jitterMs: 4.2,
        roundTripTimeMs: 18,
        glassToGlassMs: 62,
        glassToGlassP95Ms: 141,
        networkPlusJitterMs: 39,
        decodeCompositeMs: 23,
        dataChannelRttMs: 88,
        iceCandidatePairType: "srflx",
      }),
    ).toBe(true);
    // Nonnegative, like every other timing on this frame: a negative reading
    // means the two endpoints were not on one clock, which is not a sample.
    expect(
      parsesClient({
        kind: "videoStats",
        hasBinaryPayload: false,
        negotiationId: 1,
        framesDecoded: 900,
        framesDropped: 3,
        packetsLost: 0,
        jitterMs: 4.2,
        roundTripTimeMs: 18,
        glassToGlassMs: 62,
        glassToGlassP95Ms: 141,
        networkPlusJitterMs: -1,
        decodeCompositeMs: 23,
        dataChannelRttMs: 88,
        iceCandidatePairType: "srflx",
      }),
    ).toBe(false);
  });

  it("maps an off-vocabulary iceCandidatePairType to 'unknown' (no free text)", () => {
    const parsed = browserScreencastClientFrameSchema.parse({
      kind: "videoStats",
      hasBinaryPayload: false,
      negotiationId: 1,
      framesDecoded: 900,
      framesDropped: 3,
      packetsLost: 0,
      jitterMs: 4.2,
      roundTripTimeMs: 18,
      glassToGlassMs: null,
      iceCandidatePairType: "candidate:842163049 1 udp 1677729535",
    });
    expect(parsed).toMatchObject({ iceCandidatePairType: "unknown" });
  });

  it("bounds the SDP and candidate wire strings", () => {
    expect(
      parsesServer({
        kind: "sdpOffer",
        hasBinaryPayload: false,
        negotiationId: 1,
        sdp: "a".repeat(1_048_577),
      }),
    ).toBe(false);
    expect(
      parsesClient({
        kind: "sdpAnswer",
        hasBinaryPayload: false,
        negotiationId: 1,
        sdp: "a".repeat(1_048_577),
      }),
    ).toBe(false);
    expect(
      parsesServer({
        kind: "iceCandidate",
        hasBinaryPayload: false,
        negotiationId: 1,
        candidate: "a".repeat(16_385),
        sdpMid: "0",
        sdpMLineIndex: 0,
      }),
    ).toBe(false);
    expect(
      parsesClient({
        kind: "sdpAnswer",
        hasBinaryPayload: false,
        negotiationId: 1,
        sdp: "answer",
        candidates: Array.from({ length: 257 }, () => ({
          candidate: "candidate:1 1 udp 1 10.0.0.1 1 typ host",
          sdpMid: "0",
          sdpMLineIndex: 0,
        })),
      }),
    ).toBe(false);
  });

  it("rejects a videoStats frame sent the wrong direction (client-only stats)", () => {
    expect(
      parsesServer({
        kind: "videoStats",
        hasBinaryPayload: false,
        negotiationId: 1,
        framesDecoded: 900,
        framesDropped: 3,
        packetsLost: 0,
        jitterMs: 4.2,
        roundTripTimeMs: 18,
        glassToGlassMs: null,
        iceCandidatePairType: "host",
      }),
    ).toBe(false);
  });

  it("round-trips videoPlaneState live/failed reports (client -> host)", () => {
    expect(
      parsesClient({
        kind: "videoPlaneState",
        hasBinaryPayload: false,
        negotiationId: 1,
        state: "live",
        reason: null,
      }),
    ).toBe(true);
    expect(
      parsesClient({
        kind: "videoPlaneState",
        hasBinaryPayload: false,
        negotiationId: 1,
        state: "failed",
        reason: "ice-timeout",
      }),
    ).toBe(true);
    expect(
      parsesClient({
        kind: "videoPlaneState",
        hasBinaryPayload: false,
        negotiationId: 1,
        state: "connecting",
        reason: null,
      }),
    ).toBe(false);
    expect(
      parsesServer({
        kind: "videoPlaneState",
        hasBinaryPayload: false,
        negotiationId: 1,
        state: "live",
        reason: null,
      }),
    ).toBe(false);
  });

  it("rejects an unknown extra key on a strict video-plane frame", () => {
    expect(
      parsesServer({
        kind: "sdpOffer",
        hasBinaryPayload: false,
        negotiationId: 1,
        sdp: "v=0\r\n",
        someFutureField: true,
      }),
    ).toBe(false);
  });
});

describe("browser.screencast@1.0 viewport-epoch hit-testing", () => {
  const POINTER = {
    kind: "pointer",
    hasBinaryPayload: false,
    armEpoch: 1,
    seq: 4,
    type: "down",
    normalizedX: 0.25,
    normalizedY: 0.5,
    button: "left",
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
    deltaX: 0,
    deltaY: 0,
  } as const;

  it("announces the viewport epoch (server -> client)", () => {
    expect(
      parsesServer({
        kind: "viewportEpoch",
        hasBinaryPayload: false,
        epoch: 0,
      }),
    ).toBe(true);
    expect(
      parsesServer({
        kind: "viewportEpoch",
        hasBinaryPayload: false,
        epoch: -1,
      }),
    ).toBe(false);
    expect(
      parsesServer({ kind: "viewportEpoch", hasBinaryPayload: false }),
    ).toBe(false);
    // Client-only direction check: the epoch is minted host-side.
    expect(
      parsesClient({
        kind: "viewportEpoch",
        hasBinaryPayload: false,
        epoch: 0,
      }),
    ).toBe(false);
  });

  it("carries either correlation token on a pointer frame", () => {
    expect(
      parsesClient({ ...POINTER, castSequence: 7, viewportEpoch: null }),
    ).toBe(true);
    expect(
      parsesClient({ ...POINTER, castSequence: null, viewportEpoch: 3 }),
    ).toBe(true);
  });

  it("defaults both correlation tokens to null when omitted", () => {
    const parsed = browserScreencastClientFrameSchema.parse(POINTER);
    expect(parsed).toMatchObject({ castSequence: null, viewportEpoch: null });
    const legacy = browserScreencastClientFrameSchema.parse({
      ...POINTER,
      castSequence: 7,
    });
    expect(legacy).toMatchObject({ castSequence: 7, viewportEpoch: null });
  });

  it("rejects a negative or non-integer viewport epoch on input", () => {
    expect(
      parsesClient({ ...POINTER, castSequence: null, viewportEpoch: -1 }),
    ).toBe(false);
    expect(
      parsesClient({ ...POINTER, castSequence: null, viewportEpoch: 1.5 }),
    ).toBe(false);
  });
});
