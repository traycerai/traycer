import { describe, expect, it } from "vitest";
import { mapWebrtcVideoStats } from "../webrtc-video-stats";

function fakeReport(entries: readonly [string, unknown][]): RTCStatsReport {
  return new Map(entries);
}

describe("mapWebrtcVideoStats", () => {
  it("returns null when there is no inbound video RTP stream yet", () => {
    const report = fakeReport([
      ["pair-1", { type: "candidate-pair", id: "pair-1", nominated: true }],
    ]);
    expect(mapWebrtcVideoStats(report)).toBeNull();
  });

  it("ignores an inbound-rtp stream that is not video", () => {
    const report = fakeReport([
      [
        "audio-1",
        {
          type: "inbound-rtp",
          kind: "audio",
          framesDecoded: 999,
        },
      ],
    ]);
    expect(mapWebrtcVideoStats(report)).toBeNull();
  });

  it("maps frame/packet/jitter counters and converts seconds to milliseconds", () => {
    const report = fakeReport([
      [
        "video-1",
        {
          type: "inbound-rtp",
          kind: "video",
          framesDecoded: 900,
          framesDropped: 3,
          packetsLost: 5,
          jitter: 0.012,
        },
      ],
      [
        "pair-1",
        {
          type: "candidate-pair",
          id: "pair-1",
          nominated: true,
          state: "succeeded",
          currentRoundTripTime: 0.08,
          localCandidateId: "local-1",
        },
      ],
      [
        "local-1",
        { type: "local-candidate", id: "local-1", candidateType: "srflx" },
      ],
    ]);

    expect(mapWebrtcVideoStats(report)).toEqual({
      framesDecoded: 900,
      framesDropped: 3,
      packetsLost: 5,
      jitterMs: 12,
      roundTripTimeMs: 80,
      iceCandidatePairType: "srflx",
    });
  });

  it("selects the nominated candidate pair over an un-nominated one", () => {
    const report = fakeReport([
      ["video-1", { type: "inbound-rtp", kind: "video", framesDecoded: 10 }],
      [
        "pair-losing",
        {
          type: "candidate-pair",
          id: "pair-losing",
          nominated: false,
          currentRoundTripTime: 5,
          localCandidateId: "local-losing",
        },
      ],
      [
        "pair-winning",
        {
          type: "candidate-pair",
          id: "pair-winning",
          nominated: true,
          state: "succeeded",
          currentRoundTripTime: 0.05,
          localCandidateId: "local-winning",
        },
      ],
      [
        "local-losing",
        { type: "local-candidate", id: "local-losing", candidateType: "relay" },
      ],
      [
        "local-winning",
        { type: "local-candidate", id: "local-winning", candidateType: "host" },
      ],
    ]);

    const sample = mapWebrtcVideoStats(report);
    expect(sample?.iceCandidatePairType).toBe("host");
    expect(sample?.roundTripTimeMs).toBe(50);
  });

  it("reports 'unknown' when no candidate pair has settled yet", () => {
    const report = fakeReport([
      ["video-1", { type: "inbound-rtp", kind: "video", framesDecoded: 10 }],
    ]);
    expect(mapWebrtcVideoStats(report)?.iceCandidatePairType).toBe("unknown");
    expect(mapWebrtcVideoStats(report)?.roundTripTimeMs).toBe(0);
  });

  it("resolves via the transport's selectedCandidatePairId, not just the last nominated pair (ICE restart)", () => {
    // Iteration order is deliberately adversarial: the pair the transport
    // actually selected comes FIRST, and a retired-but-still-nominated pair
    // (the ICE-restart case) comes AFTER it. A naive "last nominated wins"
    // scan would report the retired pair's numbers - wrong host/relay type
    // and wrong RTT, the two figures this metric exists for.
    const report = fakeReport([
      ["video-1", { type: "inbound-rtp", kind: "video", framesDecoded: 10 }],
      [
        "pair-current",
        {
          type: "candidate-pair",
          id: "pair-current",
          nominated: true,
          state: "succeeded",
          currentRoundTripTime: 0.03,
          localCandidateId: "local-current",
        },
      ],
      [
        "pair-retired",
        {
          type: "candidate-pair",
          id: "pair-retired",
          nominated: true,
          state: "succeeded",
          currentRoundTripTime: 9,
          localCandidateId: "local-retired",
        },
      ],
      [
        "local-current",
        { type: "local-candidate", id: "local-current", candidateType: "host" },
      ],
      [
        "local-retired",
        {
          type: "local-candidate",
          id: "local-retired",
          candidateType: "relay",
        },
      ],
      [
        "transport-1",
        { type: "transport", selectedCandidatePairId: "pair-current" },
      ],
    ]);

    const sample = mapWebrtcVideoStats(report);
    expect(sample?.iceCandidatePairType).toBe("host");
    expect(sample?.roundTripTimeMs).toBe(30);
  });

  it("falls back to a succeeded nominated pair when no transport stat is present", () => {
    const report = fakeReport([
      ["video-1", { type: "inbound-rtp", kind: "video", framesDecoded: 10 }],
      [
        "pair-checking",
        {
          type: "candidate-pair",
          id: "pair-checking",
          nominated: true,
          state: "in-progress",
          currentRoundTripTime: 9,
          localCandidateId: "local-checking",
        },
      ],
      [
        "pair-succeeded",
        {
          type: "candidate-pair",
          id: "pair-succeeded",
          nominated: true,
          state: "succeeded",
          currentRoundTripTime: 0.02,
          localCandidateId: "local-succeeded",
        },
      ],
      [
        "local-checking",
        {
          type: "local-candidate",
          id: "local-checking",
          candidateType: "relay",
        },
      ],
      [
        "local-succeeded",
        {
          type: "local-candidate",
          id: "local-succeeded",
          candidateType: "srflx",
        },
      ],
    ]);

    const sample = mapWebrtcVideoStats(report);
    expect(sample?.iceCandidatePairType).toBe("srflx");
    expect(sample?.roundTripTimeMs).toBe(20);
  });

  it("clamps a spec-signed negative packetsLost to 0 (duplicate/late packets)", () => {
    const report = fakeReport([
      [
        "video-1",
        {
          type: "inbound-rtp",
          kind: "video",
          framesDecoded: 10,
          packetsLost: -2,
        },
      ],
    ]);
    expect(mapWebrtcVideoStats(report)?.packetsLost).toBe(0);
  });

  it("distinguishes a relay path from a direct host path", () => {
    const relay = fakeReport([
      ["video-1", { type: "inbound-rtp", kind: "video", framesDecoded: 1 }],
      [
        "pair-1",
        {
          type: "candidate-pair",
          id: "pair-1",
          nominated: true,
          state: "succeeded",
          localCandidateId: "local-1",
        },
      ],
      [
        "local-1",
        { type: "local-candidate", id: "local-1", candidateType: "relay" },
      ],
    ]);
    const host = fakeReport([
      ["video-1", { type: "inbound-rtp", kind: "video", framesDecoded: 1 }],
      [
        "pair-1",
        {
          type: "candidate-pair",
          id: "pair-1",
          nominated: true,
          state: "succeeded",
          localCandidateId: "local-1",
        },
      ],
      [
        "local-1",
        { type: "local-candidate", id: "local-1", candidateType: "host" },
      ],
    ]);
    expect(mapWebrtcVideoStats(relay)?.iceCandidatePairType).toBe("relay");
    expect(mapWebrtcVideoStats(host)?.iceCandidatePairType).toBe("host");
  });
});
