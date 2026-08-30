import type { BrowserViewNativeTabKey } from "@traycer-clients/shared/platform/browser-view";
import { compositeKey } from "./browser-view-keys";

/**
 * Module-scoped registry of the video plane's peer connections, keyed host +
 * session + tab and refcounted like `visible-tile-registry`.
 *
 * It exists because the React tree tears the tile down far more often than the
 * media should die: `browser-session-tile.tsx` keys the peek tile on
 * `session.runtime.revision`, so every revision bump is a full unmount +
 * remount, and `use-screencast-session`'s subscription effect re-runs on every
 * visibility toggle and client-identity change. A peer connection owned by the
 * component would renegotiate from scratch each time. Owned here, one PC
 * outlives all of it, and the tile and the PiP share the single track (two
 * acquires, one connection).
 *
 * The registry knows nothing about React, about the screencast subscription,
 * or about `<video>`. Signaling reaches it through {@link WebrtcSignalPort}
 * (handed in per negotiation round, since the round is what owns the reply
 * channel) and the DOM through {@link MediaPeerFactory}.
 *
 * Liveness split - what the registry sees vs what its consumer reports:
 *
 * - The registry detects, and reports as `videoPlaneState: "failed"` itself:
 *   the track ending or muting for good, and the peer connection reaching a
 *   terminal state. Those are peer-level facts, visible without a video sink.
 * - The consumer reports in: the first decoded frame
 *   ({@link BrowserMediaEntry.reportFirstDecodedFrame}, which is a
 *   `requestVideoFrameCallback` tick on the `<video>` the registry never
 *   sees) and any sink-level failure such as ticket 08's "no offer arrived"
 *   and "no first frame" deadlines ({@link BrowserMediaEntry.reportFailure}).
 *
 * Either way the registry owns the wire report, so `videoPlaneState` always
 * carries the `negotiationId` of the round it belongs to and is emitted at
 * most once per round - the host can then ignore a late "failed" from a round
 * it already abandoned.
 */

export interface WebrtcIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

/**
 * The narrow seam to the screencast subscription. Ticket 08 implements this
 * over `BrowserScreencastStreamClient`; tests implement it with a recorder.
 */
export interface WebrtcSignalPort {
  sendSdpAnswer(input: {
    readonly negotiationId: number;
    readonly sdp: string;
  }): void;
  sendIceCandidate(
    input: { readonly negotiationId: number } & WebrtcIceCandidate,
  ): void;
  sendVideoPlaneState(input: {
    readonly negotiationId: number;
    readonly state: "live" | "failed";
    readonly reason: string | null;
  }): void;
  sendVideoStats(
    input: { readonly negotiationId: number } & WebrtcVideoStatsSample,
  ): void;
}

/** The `videoStats` wire frame's payload, minus the envelope. */
export interface WebrtcVideoStatsSample {
  readonly framesDecoded: number;
  readonly framesDropped: number;
  readonly packetsLost: number;
  readonly jitterMs: number;
  readonly roundTripTimeMs: number;
  /** Ticket 17's rVFC-derived timings; see `video-frame-latency.ts`. */
  readonly glassToGlassMs: number | null;
  readonly glassToGlassP95Ms: number | null;
  readonly networkPlusJitterMs: number | null;
  readonly decodeCompositeMs: number | null;
  /** DataChannel-up / mux-down `ping` round trip; null until one completes. */
  readonly dataChannelRttMs: number | null;
  readonly iceCandidatePairType: string;
}

/**
 * The input DataChannels the helper (the OFFERER) creates, so they arrive here
 * through `ondatachannel` rather than being opened from this side.
 */
export type BrowserInputChannelLabel = "input-lossy" | "input-reliable";

const INPUT_CHANNEL_LABELS: readonly BrowserInputChannelLabel[] = [
  "input-lossy",
  "input-reliable",
];

function inputChannelLabel(label: string): BrowserInputChannelLabel | null {
  return INPUT_CHANNEL_LABELS.find((known) => known === label) ?? null;
}

/**
 * One inbound DataChannel, adapted the same way {@link MediaPeer} adapts the
 * connection: the registry stays testable without an `RTCDataChannel`.
 */
export interface MediaDataChannel {
  readonly label: string;
  isOpen(): boolean;
  send(payload: string): void;
  close(): void;
  /** Open/close, so the registry can republish its readiness. */
  onStateChange: (() => void) | null;
}

export interface MediaPeerHandlers {
  /** A locally gathered candidate to trickle back. */
  readonly onLocalIceCandidate: (candidate: WebrtcIceCandidate) => void;
  /** The remote stream, once `ontrack` delivers it. */
  readonly onStream: (stream: MediaStream) => void;
  /** An inbound DataChannel (ticket 15's input transport). */
  readonly onDataChannel: (channel: MediaDataChannel) => void;
  /** Track death or a terminal connection state. */
  readonly onFailure: (reason: string) => void;
}

/**
 * The DOM half of a negotiation round, kept behind an interface so the
 * registry is testable in jsdom (which has no `RTCPeerConnection`) with a fake
 * rather than a patched global.
 */
export interface MediaPeer {
  /** setRemoteDescription(offer) -> createAnswer -> setLocalDescription. */
  answerOffer(sdp: string): Promise<string>;
  addRemoteCandidate(candidate: WebrtcIceCandidate): Promise<void>;
  /**
   * Passthrough to `RTCPeerConnection.getStats()` (ticket 11) - the registry
   * stays DOM-free otherwise, so the caller (the video-plane session) maps
   * the raw report into the wire's `videoStats` shape.
   */
  getStats(): Promise<RTCStatsReport>;
  /** Stops the received tracks and closes the connection. Idempotent. */
  close(): void;
}

/**
 * The ICE servers a round negotiates against, as the host delivered them on
 * the offer (`sdpOffer.iceServers`). Empty means the host has no TURN
 * configured, and the peer falls back to its built-in STUN literal.
 */
export type MediaIceServer = {
  readonly urls: readonly string[];
  readonly username: string | null;
  readonly credential: string | null;
};

export type MediaPeerFactory = (
  handlers: MediaPeerHandlers,
  iceServers: readonly MediaIceServer[],
) => MediaPeer;

export type VideoPlanePhase = "idle" | "negotiating" | "streaming" | "failed";

export interface BrowserMediaSnapshot {
  readonly phase: VideoPlanePhase;
  /** The round the snapshot describes; `null` before the first offer. */
  readonly negotiationId: number | null;
  /** Stable while a round streams - hand it straight to `video.srcObject`. */
  readonly stream: MediaStream | null;
  readonly failureReason: string | null;
  /**
   * Both input channels of the CURRENT round are open, so
   * {@link BrowserMediaEntry.sendInput} can carry human input. Never true for
   * a superseded round - its channels are closed on arrival or at supersede.
   */
  readonly inputReady: boolean;
}

export interface BrowserMediaEntry {
  getSnapshot(): BrowserMediaSnapshot;
  /** `useSyncExternalStore`-shaped; the snapshot identity changes on change. */
  subscribe(listener: () => void): () => void;
  /**
   * Start a round. A higher `negotiationId` supersedes the round in flight
   * (its peer is closed); a lower or equal one is ignored as stale.
   */
  acceptOffer(input: {
    readonly negotiationId: number;
    readonly sdp: string;
    readonly port: WebrtcSignalPort;
    /** Delivered on the offer; empty when the host has no TURN configured. */
    readonly iceServers: readonly MediaIceServer[];
  }): void;
  acceptRemoteCandidate(
    input: { readonly negotiationId: number } & WebrtcIceCandidate,
  ): void;
  /** First `requestVideoFrameCallback` tick - reports `"live"`. */
  reportFirstDecodedFrame(): void;
  /** A sink-level failure the registry cannot observe (deadlines, decode). */
  reportFailure(reason: string): void;
  /**
   * Sends one already-encoded client frame on the current round's channel.
   * `false` (a no-op) when the channel is absent, not open, or refuses the
   * payload - the caller falls back to the mux, which is what keeps a
   * discrete frame on exactly one transport.
   */
  sendInput(label: BrowserInputChannelLabel, payload: string): boolean;
  /**
   * The current round's raw stats report, or `null` when no round is in
   * flight (ticket 11's periodic sampler skips a tick rather than throwing).
   */
  getStats(): Promise<RTCStatsReport | null>;
}

/**
 * A remount releases before it re-acquires: React runs the outgoing tree's
 * effect cleanups and the incoming tree's setups in one commit, so the count
 * dips to zero and back within a tick. Closing on the trailing edge of that
 * dip would tear down exactly the connection this registry exists to keep, so
 * the last release only schedules the close. The window is generous enough to
 * also cover a remount that straddles a state update arriving off the wire.
 */
const RELEASE_GRACE_MS = 1_000;

interface RegistryRecord {
  readonly entry: BrowserMediaEntry;
  readonly dispose: () => void;
  refCount: number;
  closeTimer: number | null;
}

const records = new Map<string, RegistryRecord>();

/**
 * Three segments, deliberately - no `instanceId`, unlike the neighbouring
 * `browserPeekFrameKey`: a runtime restart is covered by the superseding offer
 * it brings, so keying on it would only cost the media its identity.
 */
export function browserMediaKeyId(key: BrowserViewNativeTabKey): string {
  return compositeKey(key.hostId, key.sessionId, key.tabId);
}

export function acquireBrowserMediaEntry(input: {
  readonly key: BrowserViewNativeTabKey;
  readonly createPeer: MediaPeerFactory;
}): { readonly entry: BrowserMediaEntry; readonly release: () => void } {
  const keyId = browserMediaKeyId(input.key);
  const record = records.get(keyId) ?? createRecord(input.createPeer);
  records.set(keyId, record);
  record.refCount += 1;
  if (record.closeTimer !== null) {
    window.clearTimeout(record.closeTimer);
    record.closeTimer = null;
  }

  let released = false;
  return {
    entry: record.entry,
    release: () => {
      if (released) return;
      released = true;
      record.refCount -= 1;
      if (record.refCount > 0) return;
      record.closeTimer = window.setTimeout(() => {
        if (record.refCount > 0) return;
        records.delete(keyId);
        record.dispose();
      }, RELEASE_GRACE_MS);
    },
  };
}

/** Live keys, for tests and the ticket-11 debug overlay. */
export function activeBrowserMediaKeyIds(): readonly string[] {
  return [...records.keys()];
}

function createRecord(createPeer: MediaPeerFactory): RegistryRecord {
  const listeners = new Set<() => void>();
  let snapshot: BrowserMediaSnapshot = {
    phase: "idle",
    negotiationId: null,
    stream: null,
    failureReason: null,
    inputReady: false,
  };

  let round: {
    readonly negotiationId: number;
    readonly port: WebrtcSignalPort;
    readonly peer: MediaPeer;
    /** Candidates that arrived before the answer set the remote description. */
    readonly pendingCandidates: WebrtcIceCandidate[];
    /** This round's input channels, by label. */
    readonly channels: Map<BrowserInputChannelLabel, MediaDataChannel>;
    remoteReady: boolean;
    reportedLive: boolean;
    reportedFailed: boolean;
  } | null = null;

  const publish = (next: Partial<BrowserMediaSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  /**
   * Latched per STATE, not per round: a round that went live and then lost its
   * track must report both, because "failed" after "live" is the report the
   * host flips `setCaptureEnabled(true)` on. A single per-round latch would
   * swallow it. Each state still goes out at most once - `fail()` nulls the
   * round, so a second failure cannot re-fire either.
   */
  const report = (state: "live" | "failed", reason: string | null): void => {
    if (round === null) return;
    if (state === "live") {
      if (round.reportedLive) return;
      round.reportedLive = true;
    } else {
      if (round.reportedFailed) return;
      round.reportedFailed = true;
    }
    round.port.sendVideoPlaneState({
      negotiationId: round.negotiationId,
      state,
      reason,
    });
  };

  const closeChannels = (): void => {
    for (const channel of round?.channels.values() ?? []) {
      channel.onStateChange = null;
      channel.close();
    }
    round?.channels.clear();
  };

  const syncInputReady = (): void => {
    const channels = round?.channels;
    const ready =
      channels !== undefined &&
      INPUT_CHANNEL_LABELS.every(
        (label) => channels.get(label)?.isOpen() === true,
      );
    if (ready === snapshot.inputReady) return;
    publish({ inputReady: ready });
  };

  const fail = (reason: string): void => {
    if (round === null) return;
    report("failed", reason);
    closeChannels();
    round.peer.close();
    round = null;
    publish({
      phase: "failed",
      stream: null,
      failureReason: reason,
      inputReady: false,
    });
  };

  const entry: BrowserMediaEntry = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    acceptOffer: ({ negotiationId, sdp, port, iceServers }) => {
      if (round !== null && negotiationId <= round.negotiationId) return;
      if (
        round === null &&
        snapshot.negotiationId !== null &&
        negotiationId <= snapshot.negotiationId
      ) {
        return;
      }
      closeChannels();
      round?.peer.close();

      const peer = createPeer(
        {
          onLocalIceCandidate: (candidate) => {
            if (round?.negotiationId !== negotiationId) return;
            port.sendIceCandidate({ negotiationId, ...candidate });
          },
          onStream: (stream) => {
            if (round?.negotiationId !== negotiationId) return;
            publish({ phase: "streaming", stream });
          },
          onDataChannel: (channel) => {
            const label = inputChannelLabel(channel.label);
            // A channel from a superseded round (or one nothing here reads) is
            // dropped on arrival - same discipline as a stale offer.
            if (label === null || round?.negotiationId !== negotiationId) {
              channel.close();
              return;
            }
            round.channels.set(label, channel);
            channel.onStateChange = syncInputReady;
            syncInputReady();
          },
          onFailure: (reason) => {
            if (round?.negotiationId !== negotiationId) return;
            fail(reason);
          },
        },
        iceServers,
      );
      const started = {
        negotiationId,
        port,
        peer,
        pendingCandidates: [],
        channels: new Map<BrowserInputChannelLabel, MediaDataChannel>(),
        remoteReady: false,
        reportedLive: false,
        reportedFailed: false,
      };
      round = started;
      publish({
        phase: "negotiating",
        negotiationId,
        stream: null,
        failureReason: null,
        inputReady: false,
      });

      void peer
        .answerOffer(sdp)
        .then((answerSdp) => {
          if (round !== started) return;
          port.sendSdpAnswer({ negotiationId, sdp: answerSdp });
          started.remoteReady = true;
          for (const candidate of started.pendingCandidates.splice(0)) {
            void started.peer.addRemoteCandidate(candidate).catch(noop);
          }
        })
        .catch((error: unknown) => {
          if (round !== started) return;
          fail(`answer-failed: ${errorText(error)}`);
        });
    },

    acceptRemoteCandidate: ({ negotiationId, ...candidate }) => {
      if (round === null || round.negotiationId !== negotiationId) return;
      if (!round.remoteReady) {
        round.pendingCandidates.push(candidate);
        return;
      }
      void round.peer.addRemoteCandidate(candidate).catch(noop);
    },

    reportFirstDecodedFrame: () => {
      report("live", null);
    },

    reportFailure: (reason) => {
      fail(reason);
    },

    getStats: () => round?.peer.getStats() ?? Promise.resolve(null),

    sendInput: (label, payload) => {
      // Both or neither: with only one channel up, moves would take the
      // channel while the clicks they precede took the mux, and the two
      // transports have no ordering between them.
      if (!snapshot.inputReady) return false;
      const channel = round?.channels.get(label);
      if (channel === undefined || !channel.isOpen()) return false;
      try {
        channel.send(payload);
        return true;
      } catch {
        // A channel closing mid-send throws; the caller re-sends on the mux.
        syncInputReady();
        return false;
      }
    },
  };

  return {
    entry,
    refCount: 0,
    closeTimer: null,
    dispose: () => {
      closeChannels();
      round?.peer.close();
      round = null;
      listeners.clear();
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noop(): void {}

/**
 * The real peer. Adapting `RTCPeerConnection` here rather than exposing it is
 * what keeps the registry above DOM-free: track-death detection, the
 * end-of-candidates sentinel and track stopping all live in this function.
 */
export function createBrowserMediaPeer(
  handlers: MediaPeerHandlers,
  iceServers: readonly MediaIceServer[],
): MediaPeer {
  const connection = new RTCPeerConnection({
    // The host-delivered set (STUN + minted TURN) takes precedence; this
    // literal is only the fallback for a host with no TURN configured - and
    // for an older host that sends no `sdpOffer.iceServers` at all.
    iceServers:
      iceServers.length === 0
        ? [{ urls: "stun:stun.l.google.com:19302" }]
        : iceServers.map((server) => ({
            urls: [...server.urls],
            ...(server.username === null ? {} : { username: server.username }),
            ...(server.credential === null
              ? {}
              : { credential: server.credential }),
          })),
  });
  let stream: MediaStream | null = null;

  connection.onicecandidate = (event) => {
    const candidate = event.candidate;
    if (candidate === null) return;
    handlers.onLocalIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    });
  };
  connection.ontrack = (event) => {
    const received = event.streams.at(0);
    if (received === undefined) return;
    event.track.onended = () => {
      handlers.onFailure("track-ended");
    };
    stream = received;
    handlers.onStream(received);
  };
  connection.ondatachannel = (event) => {
    const channel = event.channel;
    const adapted: MediaDataChannel = {
      label: channel.label,
      isOpen: () => channel.readyState === "open",
      send: (payload) => {
        channel.send(payload);
      },
      close: () => {
        channel.close();
      },
      onStateChange: null,
    };
    const notify = (): void => {
      adapted.onStateChange?.();
    };
    channel.onopen = notify;
    channel.onclose = notify;
    channel.onerror = notify;
    handlers.onDataChannel(adapted);
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "failed") {
      handlers.onFailure("connection-failed");
    }
  };

  return {
    answerOffer: async (sdp) => {
      await connection.setRemoteDescription({ type: "offer", sdp });
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      return connection.localDescription?.sdp ?? answer.sdp ?? "";
    },
    addRemoteCandidate: (candidate) => connection.addIceCandidate(candidate),
    getStats: () => connection.getStats(),
    close: () => {
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
      connection.close();
    },
  };
}
