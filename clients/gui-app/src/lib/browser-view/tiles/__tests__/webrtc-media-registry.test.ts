import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireBrowserMediaEntry,
  activeBrowserMediaKeyIds,
  type MediaDataChannel,
  type MediaPeer,
  type MediaPeerHandlers,
  type WebrtcIceCandidate,
  type WebrtcSignalPort,
} from "../webrtc-media-registry";

const GRACE_MS = 1_000;

interface FakePeer extends MediaPeer {
  readonly handlers: MediaPeerHandlers;
  readonly offers: string[];
  readonly remoteCandidates: WebrtcIceCandidate[];
  closeCount: number;
}

interface PeerHarness {
  readonly peers: FakePeer[];
  readonly createPeer: (handlers: MediaPeerHandlers) => MediaPeer;
}

function peerHarness(): PeerHarness {
  const peers: FakePeer[] = [];
  return {
    peers,
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
        getStats: () => Promise.resolve(new Map()),
        close: () => {
          peer.closeCount += 1;
        },
      };
      peers.push(peer);
      return peer;
    },
  };
}

interface RecordingPort extends WebrtcSignalPort {
  readonly answers: { negotiationId: number; sdp: string }[];
  readonly candidates: ({ negotiationId: number } & WebrtcIceCandidate)[];
  readonly states: {
    negotiationId: number;
    state: "live" | "failed";
    reason: string | null;
  }[];
  readonly stats: { negotiationId: number }[];
}

function recordingPort(): RecordingPort {
  const port: RecordingPort = {
    answers: [],
    candidates: [],
    states: [],
    stats: [],
    sendSdpAnswer: (input) => {
      port.answers.push({ ...input });
    },
    sendIceCandidate: (input) => {
      port.candidates.push({ ...input });
    },
    sendVideoPlaneState: (input) => {
      port.states.push({ ...input });
    },
    sendVideoStats: (input) => {
      port.stats.push({ negotiationId: input.negotiationId });
    },
  };
  return port;
}

/**
 * jsdom has no `MediaStream`; the registry only ever carries the value
 * through, so a downcast stand-in is enough to pin the pass-through.
 */
function fakeStream(id: string): MediaStream {
  const partial: Pick<MediaStream, "id"> = { id };
  return partial as MediaStream;
}

interface FakeChannel extends MediaDataChannel {
  readonly sent: string[];
  open: boolean;
  closeCount: number;
}

function fakeChannel(label: string): FakeChannel {
  const channel: FakeChannel = {
    label,
    sent: [],
    open: true,
    closeCount: 0,
    isOpen: () => channel.open,
    send: (payload) => {
      channel.sent.push(payload);
    },
    close: () => {
      channel.open = false;
      channel.closeCount += 1;
    },
    onStateChange: null,
  };
  return channel;
}

let keyCounter = 0;

function nextKey(): {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
} {
  keyCounter += 1;
  return { hostId: "h1", sessionId: "s1", tabId: `tab-${keyCounter}` };
}

describe("webrtc media registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    expect(activeBrowserMediaKeyIds()).toEqual([]);
  });

  it("shares one peer across two acquires and closes on the last release", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const port = recordingPort();

    const tile = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });
    const pip = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });
    expect(pip.entry).toBe(tile.entry);

    tile.entry.acceptOffer({ negotiationId: 1, sdp: "offer-1", port });
    await vi.advanceTimersByTimeAsync(0);
    harness.peers[0]?.handlers.onStream(fakeStream("track"));

    expect(harness.peers).toHaveLength(1);
    expect(pip.entry.getSnapshot().stream?.id).toBe("track");

    tile.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(harness.peers[0]?.closeCount).toBe(0);
    expect(activeBrowserMediaKeyIds()).toHaveLength(1);

    pip.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(harness.peers[0]?.closeCount).toBe(1);
    expect(activeBrowserMediaKeyIds()).toEqual([]);
  });

  it("survives a remount that releases and re-acquires within the grace window", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const port = recordingPort();

    const before = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });
    before.entry.acceptOffer({ negotiationId: 7, sdp: "offer", port });
    await vi.advanceTimersByTimeAsync(0);
    harness.peers[0]?.handlers.onStream(fakeStream("live-track"));

    before.release();
    // Not a same-tick remount: the tile can pass through its "Reconnecting
    // browser tab…" branch before the replacement mounts, so the grace has to
    // be a real window, not just a deferred close.
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    const after = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(after.entry).toBe(before.entry);
    expect(harness.peers).toHaveLength(1);
    expect(harness.peers[0]?.closeCount).toBe(0);
    expect(after.entry.getSnapshot()).toMatchObject({
      phase: "streaming",
      negotiationId: 7,
    });

    after.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(harness.peers[0]?.closeCount).toBe(1);
  });

  it("double release is idempotent and does not disturb the other holder", async () => {
    const key = nextKey();
    const harness = peerHarness();

    const tile = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });
    const pip = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });
    tile.release();
    tile.release();

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(activeBrowserMediaKeyIds()).toHaveLength(1);

    pip.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(activeBrowserMediaKeyIds()).toEqual([]);
  });

  it("answers an offer, trickles candidates both ways and reports live", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const port = recordingPort();
    const held = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });

    held.entry.acceptOffer({ negotiationId: 3, sdp: "offer-sdp", port });
    // Arrives before the answer resolves: buffered, not dropped.
    held.entry.acceptRemoteCandidate({
      negotiationId: 3,
      candidate: "early",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    expect(harness.peers[0]?.remoteCandidates).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    expect(port.answers).toEqual([
      { negotiationId: 3, sdp: "answer-for:offer-sdp" },
    ]);
    expect(harness.peers[0]?.remoteCandidates).toEqual([
      { candidate: "early", sdpMid: "0", sdpMLineIndex: 0 },
    ]);

    held.entry.acceptRemoteCandidate({
      negotiationId: 3,
      candidate: "late",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    expect(harness.peers[0]?.remoteCandidates).toHaveLength(2);

    harness.peers[0]?.handlers.onLocalIceCandidate({
      candidate: "local",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    expect(port.candidates).toEqual([
      { negotiationId: 3, candidate: "local", sdpMid: "0", sdpMLineIndex: 0 },
    ]);

    harness.peers[0]?.handlers.onStream(fakeStream("t"));
    held.entry.reportFirstDecodedFrame();
    held.entry.reportFirstDecodedFrame();
    expect(port.states).toEqual([
      { negotiationId: 3, state: "live", reason: null },
    ]);

    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
  });

  it("reports failed with the round's negotiationId when the track dies", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const port = recordingPort();
    const held = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });

    held.entry.acceptOffer({ negotiationId: 4, sdp: "offer", port });
    await vi.advanceTimersByTimeAsync(0);
    harness.peers[0]?.handlers.onStream(fakeStream("t"));
    held.entry.reportFirstDecodedFrame();
    harness.peers[0]?.handlers.onFailure("track-ended");

    // The failed report must survive the live one: it is what tells the host
    // to re-enable JPEG capture, and a per-round latch would swallow it.
    expect(port.states).toEqual([
      { negotiationId: 4, state: "live", reason: null },
      { negotiationId: 4, state: "failed", reason: "track-ended" },
    ]);
    expect(held.entry.getSnapshot()).toMatchObject({
      phase: "failed",
      stream: null,
      failureReason: "track-ended",
    });
    expect(harness.peers[0]?.closeCount).toBe(1);

    // The round is gone with its peer, so a second, sink-side failure for the
    // same round is dropped rather than double-reported.
    held.entry.reportFailure("no-frame-deadline");
    expect(port.states).toHaveLength(2);

    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(harness.peers[0]?.closeCount).toBe(1);
  });

  it("ignores stale rounds and supersedes the in-flight one on retry", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const port = recordingPort();
    const held = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });

    held.entry.acceptOffer({ negotiationId: 2, sdp: "first", port });
    await vi.advanceTimersByTimeAsync(0);

    held.entry.acceptOffer({ negotiationId: 2, sdp: "duplicate", port });
    held.entry.acceptOffer({ negotiationId: 1, sdp: "older", port });
    expect(harness.peers).toHaveLength(1);

    held.entry.acceptOffer({ negotiationId: 5, sdp: "retry", port });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.peers).toHaveLength(2);
    expect(harness.peers[0]?.closeCount).toBe(1);
    expect(port.answers.map((answer) => answer.negotiationId)).toEqual([2, 5]);

    // Late candidate from the abandoned round never reaches the new peer.
    held.entry.acceptRemoteCandidate({
      negotiationId: 2,
      candidate: "stale",
      sdpMid: null,
      sdpMLineIndex: null,
    });
    expect(harness.peers[1]?.remoteCandidates).toEqual([]);

    // Nor does a late local candidate from the dead peer reach the wire.
    harness.peers[0]?.handlers.onLocalIceCandidate({
      candidate: "stale-local",
      sdpMid: null,
      sdpMLineIndex: null,
    });
    harness.peers[0]?.handlers.onFailure("late-death");
    expect(port.candidates).toEqual([]);
    expect(port.states).toEqual([]);

    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(harness.peers[1]?.closeCount).toBe(1);
  });

  it("fails the round when the answer rejects", async () => {
    const key = nextKey();
    const port = recordingPort();
    const held = acquireBrowserMediaEntry({
      key,
      createPeer: () => ({
        answerOffer: () => Promise.reject(new Error("no m-line")),
        addRemoteCandidate: () => Promise.resolve(),
        getStats: () => Promise.resolve(new Map()),
        close: () => {},
      }),
    });

    held.entry.acceptOffer({ negotiationId: 9, sdp: "offer", port });
    await vi.advanceTimersByTimeAsync(0);

    expect(port.answers).toEqual([]);
    expect(port.states).toEqual([
      { negotiationId: 9, state: "failed", reason: "answer-failed: no m-line" },
    ]);

    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
  });

  it("notifies subscribers on phase changes and stops after unsubscribe", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const port = recordingPort();
    const held = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });

    let notifications = 0;
    const unsubscribe = held.entry.subscribe(() => {
      notifications += 1;
    });

    held.entry.acceptOffer({ negotiationId: 1, sdp: "offer", port });
    await vi.advanceTimersByTimeAsync(0);
    harness.peers[0]?.handlers.onStream(fakeStream("t"));
    expect(notifications).toBe(2);

    unsubscribe();
    harness.peers[0]?.handlers.onFailure("gone");
    expect(notifications).toBe(2);

    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
  });

  /**
   * The reconnect shape: the stream the round was negotiated over dies, the
   * tile re-subscribes, and the host's fresh subscription offers a new round
   * over a NEW reply channel. There is no resume - the registry's whole job
   * here is that the surviving entry adopts the new round and never answers
   * back down the dead one.
   */
  it("adopts a superseding offer on a fresh port after the transport dies", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const deadPort = recordingPort();
    const held = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });

    held.entry.acceptOffer({ negotiationId: 4, sdp: "first", port: deadPort });
    await vi.advanceTimersByTimeAsync(0);
    harness.peers[0]?.handlers.onStream(fakeStream("s"));
    held.entry.reportFirstDecodedFrame();
    expect(deadPort.states).toEqual([
      { negotiationId: 4, state: "live", reason: null },
    ]);

    // Transport death: the stream is gone, so nothing tells the registry. The
    // media survives the tile's remount, and the re-subscription's offer -
    // higher round, new port - is what re-establishes video.
    const livePort = recordingPort();
    held.entry.acceptOffer({ negotiationId: 9, sdp: "second", port: livePort });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.peers).toHaveLength(2);
    expect(harness.peers[0]?.closeCount).toBe(1);
    expect(livePort.answers).toEqual([
      { negotiationId: 9, sdp: "answer-for:second" },
    ]);
    expect(deadPort.answers).toHaveLength(1);

    harness.peers[1]?.handlers.onStream(fakeStream("s2"));
    held.entry.reportFirstDecodedFrame();
    expect(livePort.states).toEqual([
      { negotiationId: 9, state: "live", reason: null },
    ]);
    expect(held.entry.getSnapshot()).toMatchObject({
      phase: "streaming",
      negotiationId: 9,
    });
    // The dead round's channel is never written to again, not even by its own
    // peer falling over afterwards.
    harness.peers[0]?.handlers.onFailure("transport-gone");
    expect(deadPort.states).toHaveLength(1);
    expect(deadPort.candidates).toEqual([]);

    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(harness.peers[1]?.closeCount).toBe(1);
  });

  it("carries input once both channels of the current round are open", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const port = recordingPort();
    const held = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });

    held.entry.acceptOffer({ negotiationId: 1, sdp: "offer", port });
    await vi.advanceTimersByTimeAsync(0);
    const handlers = harness.peers[0].handlers;

    const lossy = fakeChannel("input-lossy");
    handlers.onDataChannel(lossy);
    // One channel is not a transport: the reliable half has to be open too.
    expect(held.entry.getSnapshot().inputReady).toBe(false);
    expect(held.entry.sendInput("input-lossy", "{}")).toBe(false);

    const reliable = fakeChannel("input-reliable");
    handlers.onDataChannel(reliable);
    expect(held.entry.getSnapshot().inputReady).toBe(true);
    expect(held.entry.sendInput("input-reliable", '{"kind":"ping"}')).toBe(
      true,
    );
    expect(reliable.sent).toEqual(['{"kind":"ping"}']);
    expect(lossy.sent).toEqual([]);

    reliable.open = false;
    reliable.onStateChange?.();
    expect(held.entry.getSnapshot().inputReady).toBe(false);
    expect(held.entry.sendInput("input-reliable", "{}")).toBe(false);

    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
  });

  it("closes a superseded round's channels and ignores late ones", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const port = recordingPort();
    const held = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });

    held.entry.acceptOffer({ negotiationId: 1, sdp: "offer-1", port });
    await vi.advanceTimersByTimeAsync(0);
    const stale = harness.peers[0].handlers;
    const staleLossy = fakeChannel("input-lossy");
    const staleReliable = fakeChannel("input-reliable");
    stale.onDataChannel(staleLossy);
    stale.onDataChannel(staleReliable);
    expect(held.entry.getSnapshot().inputReady).toBe(true);

    held.entry.acceptOffer({ negotiationId: 2, sdp: "offer-2", port });
    await vi.advanceTimersByTimeAsync(0);
    expect(staleLossy.closeCount).toBe(1);
    expect(staleReliable.closeCount).toBe(1);
    expect(held.entry.getSnapshot().inputReady).toBe(false);

    // A channel the superseded round negotiates after the fact is dropped on
    // arrival - the same discipline stale signaling gets.
    const late = fakeChannel("input-reliable");
    stale.onDataChannel(late);
    expect(late.closeCount).toBe(1);
    expect(held.entry.getSnapshot().inputReady).toBe(false);
    expect(held.entry.sendInput("input-reliable", "{}")).toBe(false);

    const fresh = harness.peers[1].handlers;
    fresh.onDataChannel(fakeChannel("input-lossy"));
    fresh.onDataChannel(fakeChannel("input-reliable"));
    expect(held.entry.getSnapshot().inputReady).toBe(true);

    held.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
  });

  it("keeps separate keys on separate peers", async () => {
    const first = nextKey();
    const second = nextKey();
    const harness = peerHarness();

    const a = acquireBrowserMediaEntry({
      key: first,
      createPeer: harness.createPeer,
    });
    const b = acquireBrowserMediaEntry({
      key: second,
      createPeer: harness.createPeer,
    });
    expect(a.entry).not.toBe(b.entry);
    expect(activeBrowserMediaKeyIds()).toHaveLength(2);

    a.release();
    b.release();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(activeBrowserMediaKeyIds()).toEqual([]);
  });
});
