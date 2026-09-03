import {
  BROWSER_SCREENCAST_STUN_URL,
  type BrowserScreencastIcePairType,
  type BrowserVideoPlaneFailureReason,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserViewNativeTabKey } from "@traycer-clients/shared/platform/browser-view";
import {
  deriveSpecDeadlineMs,
  type ControlPlaneDeadlineSpec,
} from "@traycer/protocol/host-transport/rtt-deadlines";
import { VIEWER_CONTROL_PLANE_DEADLINES } from "@/lib/browser-view/sessions/control-plane-deadlines";
// Value import against a module that imports only TYPES back from this one, so
// the cycle is erased at compile time.
import { inboundVideoJitterMs } from "@/lib/browser-view/sessions/webrtc-video-stats";
import { compositeKey } from "./browser-view-keys";

/**
 * Module-scoped registry of the video plane's peer connections, keyed host +
 * session + tab and refcounted like `visible-tile-registry`.
 *
 * It exists because the React tree tears the tile down far more often than the
 * media should die: `browser-tab-tile.tsx` keys the peek tile on
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
    /**
     * A12: local candidates gathered before the answer shipped, batched onto
     * this frame instead of one `iceCandidate` frame each. Empty when
     * gathering hadn't produced any yet - never omitted, so an older host
     * (which ignores the field) and a new one see the same shape either way.
     */
    readonly candidates: readonly WebrtcIceCandidate[];
  }): void;
  sendIceCandidate(
    input: { readonly negotiationId: number } & WebrtcIceCandidate,
  ): void;
  sendVideoPlaneState(input: {
    readonly negotiationId: number;
    readonly state: "live" | "failed";
    readonly reason: BrowserVideoPlaneFailureReason | null;
    readonly detail: string | null;
  }): void;
  sendVideoStats(
    input: { readonly negotiationId: number } & WebrtcVideoStatsSample,
  ): void;
  /**
   * The subscription's measured control-plane RTT (ticket 18), `null` until
   * an `rttProbe` has landed. A12's batch flush window derives from it - see
   * {@link ICE_TRICKLE_BATCH_DEADLINE}.
   */
  readControlPlaneRttMs(): number | null;
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
  readonly iceCandidatePairType: BrowserScreencastIcePairType;
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
  return INPUT_CHANNEL_LABELS.find((known): boolean => known === label) ?? null;
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
  /**
   * A12: every local candidate has been gathered
   * (`RTCPeerConnection.iceGatheringState === "complete"`). One of the two
   * batch-flush triggers, alongside the RTT-derived deadline.
   */
  readonly onIceGatheringComplete: () => void;
  /** The remote stream, once `ontrack` delivers it. */
  readonly onStream: (stream: MediaStream) => void;
  /** An inbound DataChannel (ticket 15's input transport). */
  readonly onDataChannel: (channel: MediaDataChannel) => void;
  /** Track death or a terminal connection state. */
  readonly onFailure: (reason: BrowserVideoPlaneFailureReason) => void;
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

export interface BrowserMediaSnapshot {
  readonly phase: "idle" | "negotiating" | "streaming" | "failed";
  /** The round the snapshot describes; `null` before the first offer. */
  readonly negotiationId: number | null;
  /** Stable while a round streams - hand it straight to `video.srcObject`. */
  readonly stream: MediaStream | null;
  readonly failureReason: BrowserVideoPlaneFailureReason | null;
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
  reportFailure(reason: BrowserVideoPlaneFailureReason): void;
  /**
   * The subscription that supplied a round's reply channel is gone. The round
   * itself survives (the media is refcounted, and another viewer may still be
   * holding it), but nothing is sent on that port again - the next offer
   * brings the port that replaces it.
   */
  detachPort(port: WebrtcSignalPort): void;
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
export const RELEASE_GRACE_MS = 1_000;

/**
 * A12: how long a round's local-candidate batch waits for
 * {@link MediaPeerHandlers.onIceGatheringComplete} before shipping anyway.
 * Either trigger sends the same batch once - whichever fires first.
 *
 * Derived off the measured control-plane RTT (ticket 18's table), not a flat
 * literal: on a fast link the window should shrink (nothing worth waiting
 * for), on a slow one it should grow with the path, same as every other
 * viewer deadline. Two round trips is the STUN gather itself - one request
 * plus response, with a second for a retry/relay hop - so it tracks the thing
 * this window is actually waiting on rather than an arbitrary multiple.
 */
const ICE_TRICKLE_BATCH_DEADLINE: ControlPlaneDeadlineSpec = {
  floorMs: 150,
  roundTrips: 2,
};
const ICE_TRICKLE_BATCH_CEILING_MS = 500;

/**
 * How many gathered candidates the `sdpAnswer` frame may carry. A pathological
 * gather (many interfaces x many relays) would otherwise ship one unbounded
 * frame; the remainder is not dropped, it trickles.
 */
const ICE_ANSWER_CANDIDATE_BATCH_MAX = 256;

function iceTrickleBatchMs(rttMs: number | null): number {
  return Math.min(
    ICE_TRICKLE_BATCH_CEILING_MS,
    deriveSpecDeadlineMs(ICE_TRICKLE_BATCH_DEADLINE, rttMs),
  );
}

/**
 * Blocker fix (batch-3a review): `connectionState: "failed"` is potentially
 * recoverable - the host may drive a same-id ICE restart on this SAME peer
 * (see `acceptOffer`'s `===` branch) - so it must not fail the round the
 * instant it fires; that races the host's restart and always wins, tearing
 * the peer down before the restart offer can land. This is how long the
 * client waits for the connection to recover on its own before giving up and
 * reporting failure. `VIEWER_CONTROL_PLANE_DEADLINES.firstFrame` is "the
 * negotiation deadline spec" the review named as the right bound: its floor
 * alone (no RTT reading is available at peer-creation time) already covers
 * the host's own restart window, which that same spec sizes.
 */
const CONNECTION_FAILED_GRACE_MS =
  VIEWER_CONTROL_PLANE_DEADLINES.firstFrame.floorMs;

/**
 * One negotiation round's live state. Named (rather than inline) because A12
 * added enough batching fields that an inline literal type stopped reading as
 * one shape.
 */
interface ActiveRound {
  readonly negotiationId: number;
  /**
   * The reply channel; re-pointed on a same-id restart in case it changed, and
   * `null` once the subscription that supplied it has gone (`detachPort`).
   */
  port: WebrtcSignalPort | null;
  readonly peer: MediaPeer;
  /**
   * The offer SDP this round last negotiated against - lets a same-id
   * ICE-restart re-offer (blocker fix, batch-3a review) tell a genuine
   * restart from a duplicate resend of the SDP it already answered.
   */
  lastOfferSdp: string;
  /** Candidates that arrived before the answer set the remote description. */
  readonly pendingCandidates: WebrtcIceCandidate[];
  /** This round's input channels, by label. */
  readonly channels: Map<BrowserInputChannelLabel, MediaDataChannel>;
  remoteReady: boolean;
  reportedLive: boolean;
  reportedFailed: boolean;
  /**
   * Local candidates gathered before the answer ships (A12), batched onto
   * the `sdpAnswer` frame instead of one `iceCandidate` frame each. Emptied
   * the moment the batch flushes.
   */
  readonly localCandidateBatch: WebrtcIceCandidate[];
  /** True once the batch has shipped; every later local candidate trickles individually. */
  answerSent: boolean;
  /** True once `RTCPeerConnection.iceGatheringState` reaches `"complete"`. */
  gatheringComplete: boolean;
  /** The RTT-derived flush deadline; cleared once the batch ships or the round ends. */
  flushTimer: number | null;
  /** Known only once `answerOffer()` resolves; `null` before that. */
  flushAnswer: (() => void) | null;
}

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

/** Live keys - the registry's only observable disposal signal, read by tests. */
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

  let round: ActiveRound | null = null;

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
  const report = (
    state: "live" | "failed",
    reason: BrowserVideoPlaneFailureReason | null,
    detail: string | null,
  ): void => {
    if (round === null) return;
    if (state === "live") {
      // The host only accepts `live` on an ANSWERED round, and both ride one
      // FIFO stream: a frame decoded between a restart re-offer and its
      // answer flush would arrive first and be rejected. Defer rather than
      // consume the latch - the next frame after the flush reports.
      if (!round.answerSent) return;
      if (round.reportedLive) return;
      round.reportedLive = true;
    } else {
      if (round.reportedFailed) return;
      round.reportedFailed = true;
    }
    round.port?.sendVideoPlaneState({
      negotiationId: round.negotiationId,
      state,
      reason,
      detail,
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

  const clearFlushTimer = (active: ActiveRound): void => {
    if (active.flushTimer === null) return;
    window.clearTimeout(active.flushTimer);
    active.flushTimer = null;
  };

  const fail = (
    reason: BrowserVideoPlaneFailureReason,
    detail: string | null,
  ): void => {
    if (round === null) return;
    report("failed", reason, detail);
    closeChannels();
    clearFlushTimer(round);
    round.peer.close();
    round = null;
    publish({
      phase: "failed",
      stream: null,
      failureReason: reason,
      inputReady: false,
    });
  };

  /**
   * Runs one `answerOffer` round against `started`, whether this is its
   * FIRST offer or a same-id ICE-restart re-offer on the SAME peer (blocker
   * fix, batch-3a review: the host restarts under the SAME `negotiationId`
   * rather than minting a new one, so the round is reused, not recreated).
   * Arms the A12 batch/flush machinery fresh each call.
   */
  const negotiateRound = (started: ActiveRound, sdp: string): void => {
    started.lastOfferSdp = sdp;
    void started.peer
      .answerOffer(sdp)
      .then((answerSdp) => {
        if (round !== started) return;
        started.remoteReady = true;
        for (const candidate of started.pendingCandidates.splice(0)) {
          void started.peer.addRemoteCandidate(candidate).catch(noop);
        }
        // A12: ship the answer with whatever local candidates have already
        // gathered, at end-of-gathering or the RTT-derived deadline -
        // whichever comes first. `onIceGatheringComplete` may already have
        // fired (gathering can finish before this promise settles), in which
        // case the flush happens immediately instead of arming the timer.
        const flush = (): void => {
          if (round !== started || started.answerSent) return;
          clearFlushTimer(started);
          const port = started.port;
          // Latched only once an answer actually goes out: a detached port is
          // not a sent answer, and marking it one would retire the round.
          if (port === null) return;
          started.answerSent = true;
          port.sendSdpAnswer({
            negotiationId: started.negotiationId,
            sdp: answerSdp,
            candidates: started.localCandidateBatch.splice(
              0,
              ICE_ANSWER_CANDIDATE_BATCH_MAX,
            ),
          });
          // Whatever the cap left behind rides the trickle path the answer has
          // just opened, rather than inflating one frame without bound.
          for (const candidate of started.localCandidateBatch.splice(0)) {
            port.sendIceCandidate({
              negotiationId: started.negotiationId,
              ...candidate,
            });
          }
        };
        started.flushAnswer = flush;
        if (started.gatheringComplete) {
          flush();
        } else {
          started.flushTimer = window.setTimeout(
            flush,
            iceTrickleBatchMs(started.port?.readControlPlaneRttMs() ?? null),
          );
        }
      })
      .catch((error: unknown) => {
        if (round !== started) return;
        fail("answer-failed", errorText(error));
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
      if (round !== null && negotiationId < round.negotiationId) return;
      if (round !== null && negotiationId === round.negotiationId) {
        // Blocker fix (batch-3a review): the staleness guard used to drop
        // this outright, silently swallowing the host's same-id ICE-restart
        // re-offer. A bit-for-bit resend of the SDP this round already
        // answered is the one degenerate case left to drop - nothing
        // changed, so there is nothing to renegotiate.
        if (sdp === round.lastOfferSdp) return;
        const existing = round;
        clearFlushTimer(existing);
        existing.port = port;
        existing.remoteReady = false;
        // The host's restart deadline is cancelled only by a fresh `live`
        // report, so the latch must reopen for the restarted round.
        existing.reportedLive = false;
        existing.answerSent = false;
        existing.gatheringComplete = false;
        existing.flushAnswer = null;
        existing.localCandidateBatch.length = 0;
        negotiateRound(existing, sdp);
        return;
      }
      if (
        round === null &&
        snapshot.negotiationId !== null &&
        (negotiationId < snapshot.negotiationId ||
          // A failed round is over, so the host re-offering under the SAME id
          // is a genuine retry of it, not the stale resend the `<=` guard
          // exists to drop.
          (negotiationId === snapshot.negotiationId &&
            snapshot.phase !== "failed"))
      ) {
        return;
      }
      closeChannels();
      if (round !== null) clearFlushTimer(round);
      round?.peer.close();

      const peer = createPeer(
        {
          onLocalIceCandidate: (candidate) => {
            if (round?.negotiationId !== negotiationId) return;
            // A12: batch until the answer ships, then trickle individually -
            // a late candidate after the batch is gone is still worth
            // sending, just no longer worth holding. `round.port`, not the
            // `port` this offer was accepted with: a same-id restart
            // re-points it, and this handler outlives that (the peer, and
            // its handlers, are never recreated for a restart).
            if (round.answerSent) {
              round.port?.sendIceCandidate({ negotiationId, ...candidate });
              return;
            }
            round.localCandidateBatch.push(candidate);
          },
          onIceGatheringComplete: () => {
            if (round?.negotiationId !== negotiationId) return;
            round.gatheringComplete = true;
            round.flushAnswer?.();
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
            fail(reason, null);
          },
        },
        iceServers,
      );
      const started: ActiveRound = {
        negotiationId,
        port,
        lastOfferSdp: sdp,
        peer,
        pendingCandidates: [],
        channels: new Map<BrowserInputChannelLabel, MediaDataChannel>(),
        remoteReady: false,
        reportedLive: false,
        reportedFailed: false,
        localCandidateBatch: [],
        answerSent: false,
        gatheringComplete: false,
        flushTimer: null,
        flushAnswer: null,
      };
      round = started;
      publish({
        phase: "negotiating",
        negotiationId,
        stream: null,
        failureReason: null,
        inputReady: false,
      });
      negotiateRound(started, sdp);
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
      report("live", null, null);
    },

    reportFailure: (reason) => {
      fail(reason, null);
    },

    detachPort: (port) => {
      if (round?.port === port) round.port = null;
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
      if (round !== null) clearFlushTimer(round);
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
 * A4/F6: sizes the receiver's jitter buffer off the CURRENTLY measured
 * jitter instead of trusting Chromium's constant default (30-100ms,
 * inflated further by DERP's TCP burstiness). Re-evaluated on every
 * `getStats()` read - the existing 5s sampler in `video-plane-session.ts` -
 * rather than its own timer. `jitterBufferTarget` is absent on older
 * receivers, so it is feature-detected rather than assumed from the DOM
 * typings (which declare it unconditionally).
 */
function applyAdaptiveJitterBufferTarget(
  receiver: RTCRtpReceiver | null,
  report: RTCStatsReport,
): void {
  if (receiver === null || !("jitterBufferTarget" in receiver)) return;
  const jitterMs = inboundVideoJitterMs(report);
  if (jitterMs === null) return;
  receiver.jitterBufferTarget = Math.min(200, Math.max(0, jitterMs * 2));
}

/**
 * An actual `a=rtpmap` payload line, not just the substring "h264" appearing
 * anywhere in the SDP (a `cname`/`msid`/tool banner can legitimately contain
 * it) - the payload-type digit is what makes this a real codec offer rather
 * than a coincidence.
 */
const H264_RTPMAP_PATTERN = /a=rtpmap:\d+ h264\//i;

/**
 * A4/F6: prefers H.264 over the offer's default (VP8) ANSWERER-side, and
 * only when both ends can actually use it - this engine's
 * `RTCRtpReceiver.getCapabilities` reports H.264 decode support AND the
 * offer's SDP already carries an H.264 payload (the offerer negotiates
 * whatever its own `createOffer` puts on the wire; it does not itself
 * prefer a codec - that stays ticket 23's `index.html` entry point,
 * untouched here). VP8 stays the floor otherwise: `setCodecPreferences` is
 * simply never called, so the default (VP8-first) order survives. Read
 * right after `setRemoteDescription`, before `createAnswer`, since the
 * answer is what carries the preference back to the offerer.
 */
function preferH264IfCapable(
  connection: RTCPeerConnection,
  offerSdp: string,
): void {
  if (!H264_RTPMAP_PATTERN.test(offerSdp)) return;
  const capabilities = RTCRtpReceiver.getCapabilities("video");
  if (capabilities === null) return;
  const h264Codecs = capabilities.codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === "video/h264",
  );
  if (h264Codecs.length === 0) return;
  const otherCodecs = capabilities.codecs.filter(
    (codec) => codec.mimeType.toLowerCase() !== "video/h264",
  );
  for (const transceiver of connection.getTransceivers()) {
    if (transceiver.receiver.track.kind !== "video") continue;
    if (typeof transceiver.setCodecPreferences !== "function") continue;
    transceiver.setCodecPreferences([...h264Codecs, ...otherCodecs]);
  }
}

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
        ? [{ urls: BROWSER_SCREENCAST_STUN_URL }]
        : iceServers.map((server) => ({
            urls: [...server.urls],
            ...(server.username === null ? {} : { username: server.username }),
            ...(server.credential === null
              ? {}
              : { credential: server.credential }),
          })),
  });
  let stream: MediaStream | null = null;
  /** A4/F6: the video receiver, captured here so the stats sampler can tune its `jitterBufferTarget`. */
  let videoReceiver: RTCRtpReceiver | null = null;
  /**
   * Blocker fix (batch-3a review): armed the moment `connectionState` reads
   * "failed", cleared the moment it reads anything else. "failed" is
   * potentially recoverable - the host may drive a same-id ICE restart on
   * this SAME peer - so it must not report failure the instant it fires;
   * that races the restart and always wins. `null` while unarmed.
   */
  let connectionFailedTimer: number | null = null;

  const clearConnectionFailedTimer = (): void => {
    if (connectionFailedTimer === null) return;
    window.clearTimeout(connectionFailedTimer);
    connectionFailedTimer = null;
  };

  connection.onicecandidate = (event) => {
    const candidate = event.candidate;
    if (candidate === null) return;
    handlers.onLocalIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    });
  };
  connection.onicegatheringstatechange = () => {
    if (connection.iceGatheringState !== "complete") return;
    handlers.onIceGatheringComplete();
  };
  connection.ontrack = (event) => {
    const received = event.streams.at(0);
    if (received === undefined) return;
    event.track.onended = () => {
      handlers.onFailure("track-ended");
    };
    if (event.track.kind === "video") videoReceiver = event.receiver;
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
    const state = connection.connectionState;
    if (state === "closed") {
      // Terminal - nothing left to restart, unlike "failed" below.
      clearConnectionFailedTimer();
      handlers.onFailure("connection-closed");
      return;
    }
    if (state !== "failed") {
      // Recovered (a same-id ICE restart landing, or a transient blip
      // clearing on its own) - the grace timer's job is done.
      clearConnectionFailedTimer();
      return;
    }
    if (connectionFailedTimer !== null) return;
    connectionFailedTimer = window.setTimeout(() => {
      connectionFailedTimer = null;
      handlers.onFailure("connection-failed");
    }, CONNECTION_FAILED_GRACE_MS);
  };

  return {
    answerOffer: async (sdp) => {
      await connection.setRemoteDescription({ type: "offer", sdp });
      preferH264IfCapable(connection, sdp);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      return connection.localDescription?.sdp ?? answer.sdp ?? "";
    },
    addRemoteCandidate: (candidate) => connection.addIceCandidate(candidate),
    getStats: () => {
      // Piggybacks the existing 5s stats cadence rather than a second timer -
      // see `applyAdaptiveJitterBufferTarget`. One chain, so the caller's
      // catch owns the rejection a closing connection produces.
      return connection.getStats().then((stats) => {
        applyAdaptiveJitterBufferTarget(videoReceiver, stats);
        return stats;
      });
    },
    close: () => {
      // `close()` sets `connectionState` to "closed" without dispatching the
      // event, so nothing else disarms the grace timer: left armed it would
      // report a dead peer's failure into whatever round holds its id next.
      clearConnectionFailedTimer();
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
      connection.close();
    },
  };
}
