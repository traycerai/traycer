import type {
  BrowserScreencastServerFrame,
  BrowserVideoPlaneFailureReason,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserMediaEntry,
  BrowserMediaSnapshot,
  WebrtcSignalPort,
  WebrtcVideoStatsSample,
} from "@/lib/browser-view/tiles/webrtc-media-registry";
import { mapWebrtcVideoStats } from "@/lib/browser-view/sessions/webrtc-video-stats";
import { createVideoFrameLatencyWindow } from "@/lib/browser-view/sessions/video-frame-latency";
import { deriveSpecDeadlineMs } from "@traycer/protocol/host-transport/rtt-deadlines";
import { VIEWER_CONTROL_PLANE_DEADLINES } from "@/lib/browser-view/sessions/control-plane-deadlines";

/**
 * `muted` + `playsInline` autoplay is allowed, but a source attached after
 * mount still needs the kick. jsdom (and any runtime without a media stack)
 * throws instead of returning a promise, which is not a plane failure.
 *
 * Lives beside the video plumbing rather than in the tile's hook, because
 * every surface that attaches a `MediaStream` to a `<video>` needs the same
 * kick - the peek tile and the PiP preview alike.
 */
export function startPlayback(element: HTMLVideoElement): void {
  try {
    const started = element.play();
    if (started instanceof Promise) void started.catch(() => {});
  } catch {
    // No media stack; the plane simply never reports a decoded frame.
  }
}

/**
 * The tile's video plane, as what a render needs to know about it: whether a
 * track exists to mount, and whether it has decoded a frame.
 *
 * `active` is entered by the first decoded frame and nothing else - that is
 * what `videoPlaneState: "live"` reports. It is deliberately NOT what turns
 * the host's JPEG pump off: the pump is already off for the whole attempt
 * (ticket 26), and this report only confirms the attempt paid off.
 *
 * Between `ontrack` and that first frame the `<video>` is mounted but blank -
 * it has to be in the tree to decode - and the tile shows its connecting
 * loader over it. Nothing paints a JPEG frame underneath it.
 *
 * This is the SINK half of the split `webrtc-media-registry` documents:
 * peer-level failures (track death, terminal connection state) are the
 * registry's to see and report; the first decoded frame and the
 * no-first-frame deadline are only visible from the `<video>` and are
 * reported in from here.
 *
 * There is no client-scheduled retry: the broker re-offers on its own backoff
 * (ticket 23), and the next natural re-subscribe - reconnect, visibility
 * toggle, `runtime.revision` remount - re-arms it as well.
 */
export interface VideoPlaneView {
  /** Non-null from `ontrack` onwards, blank until the first decoded frame. */
  readonly media: MediaStream | null;
  /** A frame has been decoded: this plane is the tile's surface. */
  readonly active: boolean;
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
  readonly fail: (reason: BrowserVideoPlaneFailureReason) => void;
  /** Drops the snapshot subscription and releases the registry entry. */
  readonly close: () => void;
}

/** No track, nothing decoded: the tile is on JPEG or on its loader. */
export const NO_VIDEO_VIEW: VideoPlaneView = { media: null, active: false };

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
  /** The round the per-round measurements below belong to; see `sdpOffer`. */
  let measuredRound: number | null = null;
  let latency = createVideoFrameLatencyWindow();
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

  /**
   * How long a round may hold a peer connection without producing a decoded
   * frame. The host's own negotiation deadline stops at "answered" - a
   * connection that never carries pixels (ICE settles, media does not flow)
   * is only visible from this end. Derived from the host's reported
   * control-plane RTT (ticket 18), with the old 15s literal as its floor.
   *
   * "Decoded frame" is observed through `requestVideoFrameCallback`, which a
   * hidden window never fires: an occluded viewer would otherwise fail every
   * round it negotiates in the background and retry forever. Expiring while
   * hidden therefore parks the window on the return instead of restarting it
   * blind - a re-armed timer would let a viewer that comes back a moment
   * later wait out most of a second window on a bare loader (a first-attempt
   * round has the JPEG cast stopped, so there is no plane underneath), and
   * nothing else bounds a round whose DataChannels opened but whose media
   * never flowed.
   */
  const armDeadline = (): void => {
    const onVisible = (): void => {
      cancelDeadline = null;
      armDeadline();
    };
    const timer = window.setTimeout(
      () => {
        cancelDeadline = null;
        if (document.visibilityState !== "visible") {
          document.addEventListener("visibilitychange", onVisible, {
            once: true,
          });
          cancelDeadline = () => {
            document.removeEventListener("visibilitychange", onVisible);
          };
          return;
        }
        deadlineRound = null;
        entry.reportFailure("no-first-frame");
      },
      deriveSpecDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.firstFrame,
        options.readControlPlaneRttMs(),
      ),
    );
    cancelDeadline = () => {
      window.clearTimeout(timer);
    };
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
    armDeadline();
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
      onChange({ media: snapshot.stream, active: isLive(snapshot) });
      return;
    }
    onChange(NO_VIDEO_VIEW);
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
        // A new round is a new path: the previous one's latency window and
        // DataChannel round trip describe a connection that no longer exists,
        // and an outstanding ping's reply can never be matched now that the
        // channels it went out on are gone. A same-id ICE restart keeps them,
        // which is the point - it is the same round, re-pathed.
        if (frame.negotiationId !== measuredRound) {
          measuredRound = frame.negotiationId;
          pingSentAt = null;
          dataChannelRttMs = null;
          latency = createVideoFrameLatencyWindow();
        }
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
      // Before the `liveRound` gate: a same-id ICE restart reopens the
      // registry's per-round latch, and only a fresh `live` report cancels the
      // host's restart deadline. The latch keeps this idempotent.
      entry.reportFirstDecodedFrame();
      if (snapshot.negotiationId === liveRound) return;
      liveRound = snapshot.negotiationId;
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
      // The registry outlives this subscription (PiP may still hold it), but
      // the reply channel does not: without this the round keeps answering
      // into a stream nobody is reading.
      entry.detachPort(port);
      media.release();
    },
  };
}
