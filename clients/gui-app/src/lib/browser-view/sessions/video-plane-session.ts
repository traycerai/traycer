import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserMediaEntry,
  BrowserMediaSnapshot,
  WebrtcSignalPort,
  WebrtcVideoStatsSample,
} from "@/lib/browser-view/tiles/webrtc-media-registry";
import { mapWebrtcVideoStats } from "@/lib/browser-view/sessions/webrtc-video-stats";
import { createVideoFrameLatencyWindow } from "@/lib/browser-view/sessions/video-frame-latency";
import {
  deriveViewerDeadlineMs,
  VIEWER_CONTROL_PLANE_DEADLINES,
} from "@/lib/browser-view/sessions/control-plane-deadlines";

/**
 * The tile's display plane, as three named states:
 *
 * ```
 *   jpeg ──sdpOffer──▶ negotiating ──first decoded frame──▶ video
 *     ▲                     │                                 │
 *     └── failure/deadline ─┴─────────── failure ─────────────┘
 * ```
 *
 * - `jpeg` is the INITIAL state, not a degraded one: the subscription paints
 *   JPEG from its first frame, so there is never a black tile while ICE runs.
 * - `negotiating` still paints JPEG, and covers the registry's `streaming`
 *   phase too: an arrived track has decoded nothing yet. The `<video>` mounts
 *   there (it has to be in the tree to decode) but stays invisible.
 * - `video` is entered by the first decoded frame and nothing else - that is
 *   what `videoPlaneState: "live"` reports, and the host's
 *   `setCaptureEnabled(false)` hangs off that report. Reporting on `ontrack`
 *   would kill the JPEG pump before a pixel had been painted.
 *
 * This is the SINK half of the split `webrtc-media-registry` documents:
 * peer-level failures (track death, terminal connection state) are the
 * registry's to see and report; the first decoded frame and the
 * no-first-frame deadline are only visible from the `<video>` and are
 * reported in from here.
 *
 * There is no client-scheduled retry. The host's only re-arm seam is
 * `BrowserVideoPlaneBroker.attach()`, which runs on SUBSCRIBE, so a retry
 * costs a full re-subscription: dropping a healthy JPEG stream (and the arm
 * epoch, and any open dialog) to gamble on video. The next natural
 * re-subscribe - reconnect, visibility toggle, `runtime.revision` remount -
 * re-arms the broker and a fresh offer arrives on its own. Ticket 14 owns
 * whether a deliberate retry is ever worth that cost.
 */
export type VideoPlaneMode = "jpeg" | "negotiating" | "video";

export interface VideoPlaneView {
  readonly mode: VideoPlaneMode;
  /** Non-null from `ontrack` onwards, in `negotiating` as well as `video`. */
  readonly media: MediaStream | null;
}

export interface VideoPlaneSession {
  /**
   * Consumes `sdpOffer` / `iceCandidate`, and `inputPong` (the DataChannel
   * RTT probe's reply - this session is the only sender of `ping` on the
   * stream); ignores every other frame kind.
   */
  readonly handleServerFrame: (frame: BrowserScreencastServerFrame) => void;
  /**
   * One decoded video frame. `metadata` is the `requestVideoFrameCallback`
   * argument, and `null` on the fallback path (a WebView with no per-frame
   * callback, where `playing`/`timeupdate` is the only decode evidence) - the
   * frame still counts for liveness, it just carries no timings.
   */
  readonly noteVideoFrame: (
    metadata: VideoFrameCallbackMetadata | null,
  ) => void;
  /** When the video plane owns liveness, the last decoded frame's time. */
  readonly lastVideoFrameAt: () => number | null;
  /** A sink-level failure the registry cannot see (frames stopped arriving). */
  readonly fail: (reason: string) => void;
  /** Drops the snapshot subscription and releases the registry entry. */
  readonly close: () => void;
}

export const JPEG_VIEW: VideoPlaneView = { mode: "jpeg", media: null };

/**
 * Ticket 11's stats cadence. Sampled only while the round is live (a
 * `negotiating` round has no inbound-rtp stats worth reading yet), and both
 * sent to the host (`WebrtcSignalPort.sendVideoStats`) and handed to
 * `onVideoStats` for the tile's debug overlay - one sample, two consumers.
 */
export const STATS_SAMPLE_INTERVAL_MS = 5_000;

export function createVideoPlaneSession(options: {
  /** One `acquireBrowserMediaEntry(...)` result; closing releases it. */
  readonly media: {
    readonly entry: BrowserMediaEntry;
    readonly release: () => void;
  };
  readonly port: WebrtcSignalPort;
  readonly onChange: (view: VideoPlaneView) => void;
  /** Latest mapped sample for the tile's debug overlay; `null` off the live round. */
  readonly onVideoStats: (sample: WebrtcVideoStatsSample | null) => void;
  /**
   * The host's measured control-plane RTT for this subscription, `null` until
   * an `rttProbe` has landed. Read when the first-frame deadline is armed.
   */
  readonly readControlPlaneRttMs: () => number | null;
}): VideoPlaneSession {
  const { media, onChange, onVideoStats, port } = options;
  const { entry } = media;
  /** The round whose first decoded frame has been reported. */
  let liveRound: number | null = null;
  let lastFrameAt: number | null = null;
  let deadlineRound: number | null = null;
  let cancelDeadline: (() => void) | null = null;
  let statsTimer: number | null = null;
  let closed = false;
  const latency = createVideoFrameLatencyWindow();
  /**
   * The DataChannel RTT probe (ticket 17). One `ping` in flight at a time:
   * the screencast `pong` frame carries no correlation id, so a second
   * outstanding ping would have no way to tell which reply is which. The
   * sample reports the LAST completed round trip, which is one cadence tick
   * behind - the alternative is holding the whole 5s sample on a reply that
   * may never come.
   */
  let pingSentAt: number | null = null;
  let dataChannelRttMs: number | null = null;

  const isLive = (snapshot: BrowserMediaSnapshot): boolean =>
    snapshot.phase === "streaming" &&
    snapshot.negotiationId !== null &&
    snapshot.negotiationId === liveRound;

  const clearDeadline = (): void => {
    cancelDeadline?.();
    cancelDeadline = null;
    deadlineRound = null;
  };

  const syncDeadline = (snapshot: BrowserMediaSnapshot): void => {
    const pending =
      (snapshot.phase === "negotiating" || snapshot.phase === "streaming") &&
      snapshot.negotiationId !== null &&
      !isLive(snapshot);
    if (!pending) {
      clearDeadline();
      return;
    }
    if (deadlineRound === snapshot.negotiationId) return;
    clearDeadline();
    deadlineRound = snapshot.negotiationId;
    // How long a round may hold a peer connection without producing a decoded
    // frame. The host's own negotiation deadline stops at "answered" - a
    // connection that never carries pixels (ICE settles, media does not flow)
    // is only visible from this end. Derived from the host's reported
    // control-plane RTT (ticket 18), with the old 15s literal as its floor.
    const timer = window.setTimeout(
      () => {
        cancelDeadline = null;
        deadlineRound = null;
        entry.reportFailure("no decoded video frame before deadline");
      },
      deriveViewerDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.firstFrame,
        options.readControlPlaneRttMs(),
      ),
    );
    cancelDeadline = () => {
      window.clearTimeout(timer);
    };
  };

  const stopStatsTimer = (): void => {
    if (statsTimer === null) return;
    window.clearInterval(statsTimer);
    statsTimer = null;
  };

  /**
   * Sends one `ping` on `input-reliable`, if the channels are up and no probe
   * is already outstanding. It rides the SAME encoding human input rides
   * (a bare wire client frame), so the host parses it on the one input path -
   * `browser-video-plane-broker.ts` admits `"ping"` alongside the input kinds
   * and the screencast plane answers it over the mux as `inputPong` (the plain
   * `pong` kind never reaches this handler: the stream transport eats it).
   */
  const probeDataChannelRtt = (): void => {
    if (pingSentAt !== null) {
      // A probe still outstanding a whole cadence later got no pong - the
      // subscriber stopped accepting frames mid-flight, or the round changed
      // under it. Abandon it so one lost reply cannot retire the measurement
      // for the life of the session, but do NOT start the replacement in the
      // same breath: the `pong` frame carries no correlation id, so a late
      // reply arriving next to a fresh ping would be credited to the wrong
      // one. Skipping a tick makes that window empty instead.
      pingSentAt = null;
      return;
    }
    if (!entry.getSnapshot().inputReady) return;
    const sent = entry.sendInput(
      "input-reliable",
      JSON.stringify({ kind: "ping", hasBinaryPayload: false }),
    );
    if (sent) pingSentAt = performance.now();
  };

  const sampleStats = (): void => {
    if (closed) return;
    const snapshot = entry.getSnapshot();
    if (!isLive(snapshot) || snapshot.negotiationId === null) return;
    const negotiationId = snapshot.negotiationId;
    // Before the stats read, not after it: the probe must fire on a tick whose
    // `getStats()` rejects (teardown overlap) too, or one such tick would
    // retire the measurement. What this sample reports is therefore the
    // PREVIOUS tick's round trip - the one-cadence lag the field documents.
    probeDataChannelRtt();
    void entry
      .getStats()
      .then((report) => {
        if (closed) return;
        const reportFields =
          report === null ? null : mapWebrtcVideoStats(report);
        const sample: WebrtcVideoStatsSample | null =
          reportFields === null
            ? null
            : {
                ...reportFields,
                ...latency.summarize(),
                dataChannelRttMs,
              };
        onVideoStats(sample);
        if (sample === null) return;
        port.sendVideoStats({ negotiationId, ...sample });
      })
      .catch(() => {
        // The interval can overlap teardown by design (it stops on the next
        // `publish()`, not synchronously with the peer closing), and
        // `getStats()` on a closed connection rejects - a skipped sample,
        // not a failure worth surfacing.
      });
  };

  const syncStatsTimer = (snapshot: BrowserMediaSnapshot): void => {
    if (!isLive(snapshot)) {
      stopStatsTimer();
      return;
    }
    if (statsTimer !== null) return;
    sampleStats();
    statsTimer = window.setInterval(sampleStats, STATS_SAMPLE_INTERVAL_MS);
  };

  const publish = (): void => {
    if (closed) return;
    const snapshot = entry.getSnapshot();
    syncDeadline(snapshot);
    syncStatsTimer(snapshot);
    if (snapshot.phase === "streaming") {
      onChange({
        mode: isLive(snapshot) ? "video" : "negotiating",
        media: snapshot.stream,
      });
      return;
    }
    onChange(
      snapshot.phase === "negotiating"
        ? { mode: "negotiating", media: null }
        : JPEG_VIEW,
    );
  };

  const unsubscribe = entry.subscribe(publish);
  publish();

  return {
    handleServerFrame: (frame) => {
      if (frame.kind === "inputPong") {
        // Nothing else on this stream sends `ping`, so an unmatched reply is
        // impossible in practice; guarding anyway keeps a stray one from
        // minting a nonsense RTT out of a stale stamp.
        if (pingSentAt === null) return;
        dataChannelRttMs = Math.max(0, performance.now() - pingSentAt);
        pingSentAt = null;
        return;
      }
      if (frame.kind === "sdpOffer") {
        // Duplicate and superseded rounds are the registry's call: it owns the
        // round in flight, and this session is not necessarily its only viewer.
        entry.acceptOffer({
          negotiationId: frame.negotiationId,
          sdp: frame.sdp,
          port,
          iceServers: frame.iceServers,
        });
        return;
      }
      if (frame.kind !== "iceCandidate") return;
      entry.acceptRemoteCandidate({
        negotiationId: frame.negotiationId,
        candidate: frame.candidate,
        sdpMid: frame.sdpMid,
        sdpMLineIndex: frame.sdpMLineIndex,
      });
    },
    noteVideoFrame: (metadata) => {
      latency.note(metadata);
      const snapshot = entry.getSnapshot();
      if (snapshot.phase !== "streaming" || snapshot.negotiationId === null) {
        return;
      }
      lastFrameAt = Date.now();
      if (snapshot.negotiationId === liveRound) return;
      liveRound = snapshot.negotiationId;
      entry.reportFirstDecodedFrame();
      publish();
    },
    lastVideoFrameAt: () => (isLive(entry.getSnapshot()) ? lastFrameAt : null),
    fail: (reason) => {
      entry.reportFailure(reason);
    },
    close: () => {
      if (closed) return;
      closed = true;
      clearDeadline();
      stopStatsTimer();
      unsubscribe();
      media.release();
    },
  };
}
