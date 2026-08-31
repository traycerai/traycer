import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserVideoPlaneFailureReason } from "@traycer/protocol/host/browser/contracts";
import { VIEWER_CONTROL_PLANE_DEADLINES } from "@/lib/browser-view/sessions/control-plane-deadlines";
import {
  acquireBrowserMediaEntry,
  activeBrowserMediaKeyIds,
  createBrowserMediaPeer,
  type MediaDataChannel,
  type MediaIceServer,
  type MediaPeer,
  type MediaPeerFactory,
  type MediaPeerHandlers,
  type WebrtcIceCandidate,
  type WebrtcSignalPort,
} from "../webrtc-media-registry";

const GRACE_MS = 1_000;

interface FakePeer extends MediaPeer {
  readonly handlers: MediaPeerHandlers;
  readonly offers: string[];
  readonly remoteCandidates: WebrtcIceCandidate[];
  readonly iceServers: readonly MediaIceServer[];
  closeCount: number;
}

interface PeerHarness {
  readonly peers: FakePeer[];
  readonly createPeer: MediaPeerFactory;
}

function peerHarness(): PeerHarness {
  const peers: FakePeer[] = [];
  return {
    peers,
    createPeer: (handlers, iceServers) => {
      const peer: FakePeer = {
        handlers,
        offers: [],
        remoteCandidates: [],
        iceServers,
        closeCount: 0,
        answerOffer: (sdp) => {
          peer.offers.push(sdp);
          // Real gathering completing before the answer settles is one of
          // the two A12 flush triggers; the harness models that as the
          // common case so pre-existing assertions can read `port.answers`
          // right after the promise resolves. The dedicated batching tests
          // below construct a peer that does NOT do this, to exercise the
          // 500ms deadline and the early-candidate batch instead.
          handlers.onIceGatheringComplete();
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
  readonly answers: {
    negotiationId: number;
    sdp: string;
    candidates: readonly WebrtcIceCandidate[];
  }[];
  readonly candidates: ({ negotiationId: number } & WebrtcIceCandidate)[];
  readonly states: {
    negotiationId: number;
    state: "live" | "failed";
    /** Closed enum on the wire; the free-form half rides `detail`. */
    reason: BrowserVideoPlaneFailureReason | null;
    detail: string | null;
  }[];
  readonly stats: { negotiationId: number }[];
}

/** No measured RTT (the common case in these tests) - the batch window floors at 150ms. */
function recordingPort(): RecordingPort {
  return recordingPortWithRtt(null);
}

function recordingPortWithRtt(rttMs: number | null): RecordingPort {
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
    readControlPlaneRttMs: () => rttMs,
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

    tile.entry.acceptOffer({
      negotiationId: 1,
      sdp: "offer-1",
      port,
      iceServers: [],
    });
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
    before.entry.acceptOffer({
      negotiationId: 7,
      sdp: "offer",
      port,
      iceServers: [],
    });
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

    held.entry.acceptOffer({
      negotiationId: 3,
      sdp: "offer-sdp",
      port,
      iceServers: [],
    });
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
      { negotiationId: 3, sdp: "answer-for:offer-sdp", candidates: [] },
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
      { negotiationId: 3, state: "live", reason: null, detail: null },
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

    held.entry.acceptOffer({
      negotiationId: 4,
      sdp: "offer",
      port,
      iceServers: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    harness.peers[0]?.handlers.onStream(fakeStream("t"));
    held.entry.reportFirstDecodedFrame();
    harness.peers[0]?.handlers.onFailure("track-ended");

    // The failed report must survive the live one: it is what tells the host
    // to re-enable JPEG capture, and a per-round latch would swallow it.
    expect(port.states).toEqual([
      { negotiationId: 4, state: "live", reason: null, detail: null },
      {
        negotiationId: 4,
        state: "failed",
        reason: "track-ended",
        detail: null,
      },
    ]);
    expect(held.entry.getSnapshot()).toMatchObject({
      phase: "failed",
      stream: null,
      failureReason: "track-ended",
    });
    expect(harness.peers[0]?.closeCount).toBe(1);

    // The round is gone with its peer, so a second, sink-side failure for the
    // same round is dropped rather than double-reported.
    held.entry.reportFailure("no-first-frame");
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

    held.entry.acceptOffer({
      negotiationId: 2,
      sdp: "first",
      port,
      iceServers: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    held.entry.acceptOffer({
      negotiationId: 2,
      sdp: "duplicate",
      port,
      iceServers: [],
    });
    held.entry.acceptOffer({
      negotiationId: 1,
      sdp: "older",
      port,
      iceServers: [],
    });
    expect(harness.peers).toHaveLength(1);

    held.entry.acceptOffer({
      negotiationId: 5,
      sdp: "retry",
      port,
      iceServers: [],
    });
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
    harness.peers[0]?.handlers.onFailure("track-ended");
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

    held.entry.acceptOffer({
      negotiationId: 9,
      sdp: "offer",
      port,
      iceServers: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(port.answers).toEqual([]);
    expect(port.states).toEqual([
      {
        negotiationId: 9,
        state: "failed",
        reason: "answer-failed",
        detail: "no m-line",
      },
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

    held.entry.acceptOffer({
      negotiationId: 1,
      sdp: "offer",
      port,
      iceServers: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    harness.peers[0]?.handlers.onStream(fakeStream("t"));
    expect(notifications).toBe(2);

    unsubscribe();
    harness.peers[0]?.handlers.onFailure("track-ended");
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

    held.entry.acceptOffer({
      negotiationId: 4,
      sdp: "first",
      port: deadPort,
      iceServers: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    harness.peers[0]?.handlers.onStream(fakeStream("s"));
    held.entry.reportFirstDecodedFrame();
    expect(deadPort.states).toEqual([
      { negotiationId: 4, state: "live", reason: null, detail: null },
    ]);

    // Transport death: the stream is gone, so nothing tells the registry. The
    // media survives the tile's remount, and the re-subscription's offer -
    // higher round, new port - is what re-establishes video.
    const livePort = recordingPort();
    held.entry.acceptOffer({
      negotiationId: 9,
      sdp: "second",
      port: livePort,
      iceServers: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.peers).toHaveLength(2);
    expect(harness.peers[0]?.closeCount).toBe(1);
    expect(livePort.answers).toEqual([
      { negotiationId: 9, sdp: "answer-for:second", candidates: [] },
    ]);
    expect(deadPort.answers).toHaveLength(1);

    harness.peers[1]?.handlers.onStream(fakeStream("s2"));
    held.entry.reportFirstDecodedFrame();
    expect(livePort.states).toEqual([
      { negotiationId: 9, state: "live", reason: null, detail: null },
    ]);
    expect(held.entry.getSnapshot()).toMatchObject({
      phase: "streaming",
      negotiationId: 9,
    });
    // The dead round's channel is never written to again, not even by its own
    // peer falling over afterwards.
    harness.peers[0]?.handlers.onFailure("connection-failed");
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

    held.entry.acceptOffer({
      negotiationId: 1,
      sdp: "offer",
      port,
      iceServers: [],
    });
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

  it("flips inputReady false -> true when a channel opens after arriving closed", async () => {
    const key = nextKey();
    const harness = peerHarness();
    const port = recordingPort();
    const held = acquireBrowserMediaEntry({
      key,
      createPeer: harness.createPeer,
    });

    held.entry.acceptOffer({
      negotiationId: 1,
      sdp: "offer",
      port,
      iceServers: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    const handlers = harness.peers[0].handlers;

    const reliable = fakeChannel("input-reliable");
    const lossy = fakeChannel("input-lossy");
    // Both channels arrive already closed - `onDataChannel` must not assume
    // the newly delivered channel is open.
    reliable.open = false;
    lossy.open = false;
    handlers.onDataChannel(reliable);
    handlers.onDataChannel(lossy);
    expect(held.entry.getSnapshot().inputReady).toBe(false);

    reliable.open = true;
    reliable.onStateChange?.();
    expect(held.entry.getSnapshot().inputReady).toBe(false);

    lossy.open = true;
    lossy.onStateChange?.();
    expect(held.entry.getSnapshot().inputReady).toBe(true);
    expect(held.entry.sendInput("input-reliable", '{"kind":"ping"}')).toBe(
      true,
    );

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

    held.entry.acceptOffer({
      negotiationId: 1,
      sdp: "offer-1",
      port,
      iceServers: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    const stale = harness.peers[0].handlers;
    const staleLossy = fakeChannel("input-lossy");
    const staleReliable = fakeChannel("input-reliable");
    stale.onDataChannel(staleLossy);
    stale.onDataChannel(staleReliable);
    expect(held.entry.getSnapshot().inputReady).toBe(true);

    held.entry.acceptOffer({
      negotiationId: 2,
      sdp: "offer-2",
      port,
      iceServers: [],
    });
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

  describe("A12 batched ICE trickle", () => {
    /**
     * Unlike `peerHarness()`, this one does NOT signal gathering-complete
     * from inside `answerOffer` - these tests drive that signal (or the
     * 500ms deadline) themselves.
     */
    function controlledPeerHarness(): PeerHarness {
      const peers: FakePeer[] = [];
      return {
        peers,
        createPeer: (handlers, iceServers) => {
          const peer: FakePeer = {
            handlers,
            offers: [],
            remoteCandidates: [],
            iceServers,
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

    it("batches local candidates gathered before the flush into the sdpAnswer frame, then trickles late ones individually", async () => {
      const key = nextKey();
      const harness = controlledPeerHarness();
      const port = recordingPort();
      const held = acquireBrowserMediaEntry({
        key,
        createPeer: harness.createPeer,
      });

      held.entry.acceptOffer({
        negotiationId: 1,
        sdp: "offer",
        port,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(port.answers).toEqual([]);

      const peer = harness.peers.at(0);
      if (peer === undefined) throw new Error("peer not created");
      const handlers = peer.handlers;
      handlers.onLocalIceCandidate({
        candidate: "a",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
      handlers.onLocalIceCandidate({
        candidate: "b",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
      // Batched, not trickled - the answer has not shipped yet.
      expect(port.candidates).toEqual([]);

      handlers.onIceGatheringComplete();
      expect(port.answers).toEqual([
        {
          negotiationId: 1,
          sdp: "answer-for:offer",
          candidates: [
            { candidate: "a", sdpMid: "0", sdpMLineIndex: 0 },
            { candidate: "b", sdpMid: "0", sdpMLineIndex: 0 },
          ],
        },
      ]);
      expect(port.candidates).toEqual([]);

      // A late candidate after the batch shipped trickles individually.
      handlers.onLocalIceCandidate({
        candidate: "late",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
      expect(port.candidates).toEqual([
        { negotiationId: 1, candidate: "late", sdpMid: "0", sdpMLineIndex: 0 },
      ]);

      // A second gathering-complete signal (Chrome can fire the state change
      // more than once in edge cases) must not re-flush.
      handlers.onIceGatheringComplete();
      expect(port.answers).toHaveLength(1);

      held.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });

    it("flushes the batch on the RTT-derived floor (150ms) when gathering never signals complete and no RTT is measured", async () => {
      const key = nextKey();
      const harness = controlledPeerHarness();
      const port = recordingPort();
      const held = acquireBrowserMediaEntry({
        key,
        createPeer: harness.createPeer,
      });

      held.entry.acceptOffer({
        negotiationId: 2,
        sdp: "offer",
        port,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);
      harness.peers[0]?.handlers.onLocalIceCandidate({
        candidate: "solo",
        sdpMid: null,
        sdpMLineIndex: null,
      });
      expect(port.answers).toEqual([]);

      await vi.advanceTimersByTimeAsync(149);
      expect(port.answers).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(port.answers).toEqual([
        {
          negotiationId: 2,
          sdp: "answer-for:offer",
          candidates: [
            { candidate: "solo", sdpMid: null, sdpMLineIndex: null },
          ],
        },
      ]);

      held.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });

    it("a superseded round's pending flush timer never fires against the new round", async () => {
      const key = nextKey();
      const harness = controlledPeerHarness();
      const port = recordingPort();
      const held = acquireBrowserMediaEntry({
        key,
        createPeer: harness.createPeer,
      });

      held.entry.acceptOffer({
        negotiationId: 1,
        sdp: "first",
        port,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);
      // Never signals gathering-complete for round 1, so its flush timer is
      // still armed when round 2 supersedes it.
      held.entry.acceptOffer({
        negotiationId: 2,
        sdp: "second",
        port,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);
      harness.peers[1]?.handlers.onIceGatheringComplete();
      expect(port.answers).toEqual([
        { negotiationId: 2, sdp: "answer-for:second", candidates: [] },
      ]);

      // Round 1's floor deadline elapsing afterwards must not emit a stale
      // second answer frame.
      await vi.advanceTimersByTimeAsync(150);
      expect(port.answers).toHaveLength(1);

      held.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });

    it("derives the flush window from the measured RTT, floored at 150ms and ceilinged at 500ms (minor 6)", async () => {
      // Fast link: 2 round trips at 10ms floors at 150ms, same as no RTT.
      const fastKey = nextKey();
      const fastHarness = controlledPeerHarness();
      const fastPort = recordingPortWithRtt(10);
      const fast = acquireBrowserMediaEntry({
        key: fastKey,
        createPeer: fastHarness.createPeer,
      });
      fast.entry.acceptOffer({
        negotiationId: 1,
        sdp: "offer",
        port: fastPort,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(149);
      expect(fastPort.answers).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(fastPort.answers).toHaveLength(1);
      fast.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

      // Slow link: 2 round trips at 1000ms (2000ms) ceilings at 500ms, not
      // the uncapped 2000ms - the negotiation critical path still needs a cap.
      const slowKey = nextKey();
      const slowHarness = controlledPeerHarness();
      const slowPort = recordingPortWithRtt(1_000);
      const slow = acquireBrowserMediaEntry({
        key: slowKey,
        createPeer: slowHarness.createPeer,
      });
      slow.entry.acceptOffer({
        negotiationId: 1,
        sdp: "offer",
        port: slowPort,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(slowPort.answers).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(slowPort.answers).toHaveLength(1);
      slow.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });
  });

  describe("blocker fix: same-id ICE-restart re-offer", () => {
    it("renegotiates on the EXISTING peer instead of dropping the offer or recreating the peer", async () => {
      const key = nextKey();
      const harness = peerHarness();
      const firstPort = recordingPort();
      const held = acquireBrowserMediaEntry({
        key,
        createPeer: harness.createPeer,
      });

      held.entry.acceptOffer({
        negotiationId: 5,
        sdp: "first-offer",
        port: firstPort,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);
      harness.peers[0]?.handlers.onStream(fakeStream("t"));
      held.entry.reportFirstDecodedFrame();
      expect(firstPort.answers).toEqual([
        { negotiationId: 5, sdp: "answer-for:first-offer", candidates: [] },
      ]);

      // The host restarts on the SAME negotiationId, over a fresh reply
      // channel (a genuine reconnect can bring one), with different SDP
      // (a real ICE restart offer, not a resend).
      const restartPort = recordingPort();
      held.entry.acceptOffer({
        negotiationId: 5,
        sdp: "restart-offer",
        port: restartPort,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);

      // No second peer: the existing one renegotiated in place.
      expect(harness.peers).toHaveLength(1);
      expect(harness.peers[0]?.closeCount).toBe(0);
      expect(harness.peers[0]?.offers).toEqual([
        "first-offer",
        "restart-offer",
      ]);
      expect(restartPort.answers).toEqual([
        {
          negotiationId: 5,
          sdp: "answer-for:restart-offer",
          candidates: [],
        },
      ]);
      // The stream never dropped (no `fail()` ran) - phase stayed streaming.
      expect(held.entry.getSnapshot()).toMatchObject({
        phase: "streaming",
        negotiationId: 5,
      });

      // The restart reopens the live latch: the host's restart deadline is
      // cancelled only by a fresh `live`, so the next decoded frame must
      // re-report it - exactly once, however many frames follow.
      expect(restartPort.states).toEqual([]);
      held.entry.reportFirstDecodedFrame();
      held.entry.reportFirstDecodedFrame();
      expect(restartPort.states).toEqual([
        { negotiationId: 5, state: "live", reason: null, detail: null },
      ]);

      held.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });

    it("defers a decoded frame that lands before the restart's answer ships", async () => {
      const key = nextKey();
      const harness = peerHarness();
      const port = recordingPort();
      const held = acquireBrowserMediaEntry({
        key,
        createPeer: harness.createPeer,
      });

      held.entry.acceptOffer({
        negotiationId: 7,
        sdp: "first-offer",
        port,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);
      harness.peers[0]?.handlers.onStream(fakeStream("t"));
      held.entry.reportFirstDecodedFrame();
      expect(port.states).toHaveLength(1);

      held.entry.acceptOffer({
        negotiationId: 7,
        sdp: "restart-offer",
        port,
        iceServers: [],
      });
      // The re-offer's answer has not shipped yet: `live` here would reach
      // the host ahead of the answer on the same FIFO stream and be rejected
      // as an invalid transition, so it must be deferred, not swallowed.
      held.entry.reportFirstDecodedFrame();
      expect(port.answers).toHaveLength(1);
      expect(port.states).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(0);
      expect(port.answers).toHaveLength(2);
      held.entry.reportFirstDecodedFrame();
      held.entry.reportFirstDecodedFrame();

      expect(port.states).toEqual([
        { negotiationId: 7, state: "live", reason: null, detail: null },
        { negotiationId: 7, state: "live", reason: null, detail: null },
      ]);

      held.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });

    it("drops a bit-for-bit duplicate resend of the already-answered offer", async () => {
      const key = nextKey();
      const harness = peerHarness();
      const port = recordingPort();
      const held = acquireBrowserMediaEntry({
        key,
        createPeer: harness.createPeer,
      });

      held.entry.acceptOffer({
        negotiationId: 3,
        sdp: "offer",
        port,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(port.answers).toHaveLength(1);

      held.entry.acceptOffer({
        negotiationId: 3,
        sdp: "offer",
        port,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.peers).toHaveLength(1);
      expect(harness.peers[0]?.offers).toEqual(["offer"]);
      expect(port.answers).toHaveLength(1);

      held.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });

    it("still drops a lower negotiationId as stale", async () => {
      const key = nextKey();
      const harness = peerHarness();
      const port = recordingPort();
      const held = acquireBrowserMediaEntry({
        key,
        createPeer: harness.createPeer,
      });

      held.entry.acceptOffer({
        negotiationId: 6,
        sdp: "offer",
        port,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);

      held.entry.acceptOffer({
        negotiationId: 4,
        sdp: "older",
        port,
        iceServers: [],
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.peers).toHaveLength(1);
      expect(harness.peers[0]?.offers).toEqual(["offer"]);

      held.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });
  });

  describe("delivered ICE servers", () => {
    const TURN_SERVER: MediaIceServer = {
      urls: ["turn:turn.example.com:3478?transport=udp"],
      username: "turn-user-fixture",
      credential: "turn-credential-fixture",
    };

    it("hands the delivered set to the peer factory verbatim", async () => {
      const key = nextKey();
      const harness = peerHarness();
      const port = recordingPort();
      const held = acquireBrowserMediaEntry({
        key,
        createPeer: harness.createPeer,
      });

      held.entry.acceptOffer({
        negotiationId: 1,
        sdp: "offer-1",
        port,
        iceServers: [TURN_SERVER],
      });

      expect(harness.peers[0]?.iceServers).toEqual([TURN_SERVER]);

      held.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });

    it("still calls the factory with [] when the delivered set is empty", async () => {
      const key = nextKey();
      const harness = peerHarness();
      const port = recordingPort();
      const held = acquireBrowserMediaEntry({
        key,
        createPeer: harness.createPeer,
      });

      held.entry.acceptOffer({
        negotiationId: 1,
        sdp: "offer-1",
        port,
        iceServers: [],
      });

      expect(harness.peers).toHaveLength(1);
      expect(harness.peers[0]?.iceServers).toEqual([]);

      held.release();
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    });
  });
});

/**
 * A minimal `RTCStatsReport`-shaped report: one inbound-rtp video stat. The
 * WebRTC stats spec reports `jitter` in SECONDS - same convention
 * `mapWebrtcVideoStats` reads - so callers pass seconds, not milliseconds.
 */
function jitterStatsReport(jitterSeconds: number | null): RTCStatsReport {
  const entries: [string, Record<string, unknown>][] =
    jitterSeconds === null
      ? []
      : [
          [
            "inbound-1",
            { type: "inbound-rtp", kind: "video", jitter: jitterSeconds },
          ],
        ];
  return new Map(entries);
}

/** jsdom has no `RTCRtpReceiver`; only the field this module reads travels. */
function fakeReceiver(jitterBufferTargetPresent: boolean): RTCRtpReceiver {
  const partial = jitterBufferTargetPresent ? { jitterBufferTarget: null } : {};
  return partial as RTCRtpReceiver;
}

interface FakeTrackEvent {
  readonly streams: readonly MediaStream[];
  readonly track: { readonly kind: string; onended: (() => void) | null };
  readonly receiver: RTCRtpReceiver;
}

/**
 * jsdom has no `RTCPeerConnection`; stood in as the GLOBAL constructor
 * (`vi.stubGlobal`) so `createBrowserMediaPeer`'s own `new RTCPeerConnection`
 * picks it up. Only what these tests actually drive is modeled: the
 * negotiation methods (for the minor-8 order pin) and `connectionState` +
 * `onconnectionstatechange` (for the blocker-2 grace timer).
 */
class FakeConnection {
  readonly calls: string[] = [];
  connectionState = "new";
  localDescription: { sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  /** What `getTransceivers()` answers, for the codec-preference path. */
  transceivers: readonly RTCRtpTransceiver[] = [];
  /** What `getStats()` resolves to, for the jitter-buffer path. */
  statsReport: RTCStatsReport = new Map();
  ontrack: ((event: FakeTrackEvent) => void) | null = null;

  setRemoteDescription(): Promise<void> {
    this.calls.push("setRemoteDescription");
    return Promise.resolve();
  }

  getTransceivers(): readonly RTCRtpTransceiver[] {
    this.calls.push("getTransceivers");
    return this.transceivers;
  }

  /** Mimics the browser delivering an inbound track. */
  emitTrack(kind: string, receiver: RTCRtpReceiver): void {
    this.ontrack?.({
      streams: [fakeStream("inbound-track")],
      track: { kind, onended: null },
      receiver,
    });
  }

  createAnswer(): Promise<{ type: "answer"; sdp: string }> {
    this.calls.push("createAnswer");
    return Promise.resolve({ type: "answer", sdp: "answer-sdp" });
  }

  setLocalDescription(desc: { sdp: string }): Promise<void> {
    this.calls.push("setLocalDescription");
    this.localDescription = desc;
    return Promise.resolve();
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(this.statsReport);
  }

  close(): void {}

  /** Mimics the browser dispatching the event after a state write. */
  setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const NOOP_HANDLERS: MediaPeerHandlers = {
  onLocalIceCandidate: () => {},
  onIceGatheringComplete: () => {},
  onStream: () => {},
  onDataChannel: () => {},
  onFailure: () => {},
};

/** Stubs the global constructor and returns the instance it will produce. */
function stubPeerConnection(): FakeConnection {
  const instance = new FakeConnection();
  vi.stubGlobal(
    "RTCPeerConnection",
    function FakeRTCPeerConnection(): FakeConnection {
      return instance;
    },
  );
  return instance;
}

describe("createBrowserMediaPeer.answerOffer codec-order pin (minor 8)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs setRemoteDescription -> preferH264IfCapable -> createAnswer -> setLocalDescription, in order", async () => {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({
        codecs: [{ clockRate: 90000, mimeType: "video/H264" }],
        headerExtensions: [],
      }),
    });
    const connection = stubPeerConnection();

    const peer = createBrowserMediaPeer(NOOP_HANDLERS, []);
    await peer.answerOffer("a=rtpmap:96 H264/90000\r\n");

    // `getTransceivers` is `preferH264IfCapable`'s only observable call on
    // this fake (it finds no video transceiver to touch and returns) - its
    // position between `setRemoteDescription` and `createAnswer` is the
    // order the review asked to pin.
    expect(connection.calls).toEqual([
      "setRemoteDescription",
      "getTransceivers",
      "createAnswer",
      "setLocalDescription",
    ]);
  });
});

describe("createBrowserMediaPeer connectionState 'failed' grace (blocker 2)", () => {
  const GRACE_MS = VIEWER_CONTROL_PLANE_DEADLINES.firstFrame.floorMs;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not report failure the instant connectionState reads 'failed'", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("failed");
    expect(failures).toEqual([]);
  });

  it("reports failure only after the grace period elapses with no recovery", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("failed");
    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(failures).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(failures).toEqual(["connection-failed"]);
  });

  it("cancels the grace timer when the connection recovers (a same-id restart landing)", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("failed");
    vi.advanceTimersByTime(GRACE_MS / 2);
    connection.setConnectionState("connected");

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(failures).toEqual([]);
  });

  it("treats 'closed' as immediately terminal, unlike 'failed'", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("closed");
    expect(failures).toEqual(["connection-closed"]);
  });

  it("disarms the grace timer when the peer is closed without a state event", () => {
    // What supersede and `fail()` do: `close()` alone, which the spec updates
    // `connectionState` for WITHOUT dispatching the event. A timer left armed
    // here reports a dead peer's failure into the round that reuses its id.
    const connection = stubPeerConnection();
    const failures: string[] = [];
    const peer = createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("failed");
    peer.close();
    vi.advanceTimersByTime(GRACE_MS * 2);

    expect(failures).toEqual([]);
  });

  it("closing while a failure grace timer is armed reports once, not twice", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("failed");
    connection.setConnectionState("closed");
    vi.advanceTimersByTime(GRACE_MS * 2);

    expect(failures).toEqual(["connection-closed"]);
  });
});

describe("createBrowserMediaPeer.getStats rejection ownership", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes a rejecting getStats through exactly one promise the caller owns", async () => {
    const connection = stubPeerConnection();
    const failure = new Error("connection closing");
    connection.getStats = () => Promise.reject(failure);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const peer = createBrowserMediaPeer(NOOP_HANDLERS, []);
    const observed: unknown[] = [];
    await peer.getStats().catch((error: unknown) => {
      observed.push(error);
    });
    // Node reports an unhandled rejection on the check that runs after the
    // microtask queue drains, so a detached child promise would surface here.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    process.off("unhandledRejection", onUnhandled);

    expect(observed).toEqual([failure]);
    expect(unhandled).toEqual([]);
  });
});

/**
 * A4/F6 media tuning, driven through the peer the registry actually builds:
 * the jitter-buffer target is applied inside `getStats()`, and the codec
 * preference inside `answerOffer()`. Both were exported only so a test could
 * call them; going through `createBrowserMediaPeer` also pins that they are
 * still WIRED, which a direct call never could.
 */
describe("createBrowserMediaPeer adaptive jitter buffer (A4/F6)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function targetAfterStats(input: {
    readonly receiver: RTCRtpReceiver;
    readonly kind: string;
    readonly jitterSeconds: number | null;
  }): Promise<void> {
    const connection = stubPeerConnection();
    connection.statsReport = jitterStatsReport(input.jitterSeconds);
    const peer = createBrowserMediaPeer(NOOP_HANDLERS, []);
    connection.emitTrack(input.kind, input.receiver);
    await peer.getStats();
  }

  it("sets the target to clamp(2 x jitterMs, 0, 200)", async () => {
    const receiver = fakeReceiver(true);
    await targetAfterStats({ receiver, kind: "video", jitterSeconds: 0.04 });
    expect(receiver.jitterBufferTarget).toBe(80);
  });

  it("clamps to the 200ms ceiling on a bad tail", async () => {
    const receiver = fakeReceiver(true);
    await targetAfterStats({ receiver, kind: "video", jitterSeconds: 0.523 });
    expect(receiver.jitterBufferTarget).toBe(200);
  });

  it("clamps to the 0ms floor on a negative reading", async () => {
    const receiver = fakeReceiver(true);
    await targetAfterStats({ receiver, kind: "video", jitterSeconds: -0.005 });
    expect(receiver.jitterBufferTarget).toBe(0);
  });

  it("does nothing when the receiver lacks jitterBufferTarget (older engine)", async () => {
    const receiver = fakeReceiver(false);
    await targetAfterStats({ receiver, kind: "video", jitterSeconds: 0.04 });
    expect("jitterBufferTarget" in receiver).toBe(false);
  });

  it("does nothing before a video track arrives, or with no inbound-rtp sample", async () => {
    // Mutation: capturing the receiver off an AUDIO track, or dropping the
    // `jitterMs === null` guard - the second would write NaN as the target.
    const audioReceiver = fakeReceiver(true);
    await targetAfterStats({
      receiver: audioReceiver,
      kind: "audio",
      jitterSeconds: 0.04,
    });
    expect(audioReceiver.jitterBufferTarget).toBeNull();

    const videoReceiver = fakeReceiver(true);
    await targetAfterStats({
      receiver: videoReceiver,
      kind: "video",
      jitterSeconds: null,
    });
    expect(videoReceiver.jitterBufferTarget).toBeNull();
  });
});

describe("createBrowserMediaPeer H.264 preference (A4/F6, answerer-side only)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeTransceiver(input: {
    readonly kind: string;
    readonly setCodecPreferences: ((codecs: RTCRtpCodec[]) => void) | null;
  }): RTCRtpTransceiver {
    const receiver = { track: { kind: input.kind } } as RTCRtpReceiver;
    const partial =
      input.setCodecPreferences === null
        ? { receiver }
        : { receiver, setCodecPreferences: input.setCodecPreferences };
    return partial as RTCRtpTransceiver;
  }

  const VP8: RTCRtpCodec = { clockRate: 90000, mimeType: "video/VP8" };
  const H264: RTCRtpCodec = { clockRate: 90000, mimeType: "video/H264" };

  async function preferencesAfterAnswer(input: {
    readonly engineCodecs: readonly RTCRtpCodec[];
    readonly transceivers: readonly RTCRtpTransceiver[];
    readonly offerSdp: string;
  }): Promise<void> {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({
        codecs: [...input.engineCodecs],
        headerExtensions: [],
      }),
    });
    const connection = stubPeerConnection();
    connection.transceivers = input.transceivers;
    const peer = createBrowserMediaPeer(NOOP_HANDLERS, []);
    await peer.answerOffer(input.offerSdp);
  }

  it("orders H.264 first when this engine and the offer both support it", async () => {
    const preferences: RTCRtpCodec[][] = [];
    await preferencesAfterAnswer({
      engineCodecs: [VP8, H264],
      transceivers: [
        fakeTransceiver({
          kind: "video",
          setCodecPreferences: (codecs) => preferences.push(codecs),
        }),
      ],
      offerSdp: "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n",
    });

    expect(preferences).toEqual([[H264, VP8]]);
  });

  it("leaves VP8 as the floor when the offer never carried an H.264 payload", async () => {
    // Mutation: testing the SDP with a bare `includes("h264")` - a `cname` or
    // tool banner would then flip the codec order on a VP8-only offer.
    const preferences: RTCRtpCodec[][] = [];
    await preferencesAfterAnswer({
      engineCodecs: [VP8, H264],
      transceivers: [
        fakeTransceiver({
          kind: "video",
          setCodecPreferences: (codecs) => preferences.push(codecs),
        }),
      ],
      offerSdp: "a=cname:h264-observer\r\na=rtpmap:97 VP8/90000\r\n",
    });

    expect(preferences).toEqual([]);
  });

  it("leaves VP8 as the floor when this engine cannot decode H.264", async () => {
    const preferences: RTCRtpCodec[][] = [];
    await preferencesAfterAnswer({
      engineCodecs: [VP8],
      transceivers: [
        fakeTransceiver({
          kind: "video",
          setCodecPreferences: (codecs) => preferences.push(codecs),
        }),
      ],
      offerSdp: "a=rtpmap:96 H264/90000\r\n",
    });

    expect(preferences).toEqual([]);
  });

  it("skips a transceiver without setCodecPreferences (older engine) instead of throwing", async () => {
    await expect(
      preferencesAfterAnswer({
        engineCodecs: [VP8, H264],
        transceivers: [
          fakeTransceiver({ kind: "video", setCodecPreferences: null }),
        ],
        offerSdp: "a=rtpmap:96 H264/90000\r\n",
      }),
    ).resolves.toBeUndefined();
  });

  it("never touches the audio transceiver", async () => {
    const preferences: RTCRtpCodec[][] = [];
    await preferencesAfterAnswer({
      engineCodecs: [VP8, H264],
      transceivers: [
        fakeTransceiver({
          kind: "audio",
          setCodecPreferences: (codecs) => preferences.push(codecs),
        }),
      ],
      offerSdp: "a=rtpmap:96 H264/90000\r\n",
    });

    expect(preferences).toEqual([]);
  });
});
