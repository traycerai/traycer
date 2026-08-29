import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserMediaEntry,
  BrowserMediaSnapshot,
  WebrtcSignalPort,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

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
  /** Consumes `sdpOffer` / `iceCandidate`; ignores every other frame kind. */
  readonly handleServerFrame: (frame: BrowserScreencastServerFrame) => void;
  /** One decoded video frame (`requestVideoFrameCallback`). */
  readonly noteVideoFrame: () => void;
  /** When the video plane owns liveness, the last decoded frame's time. */
  readonly lastVideoFrameAt: () => number | null;
  /** A sink-level failure the registry cannot see (frames stopped arriving). */
  readonly fail: (reason: string) => void;
  /** Drops the snapshot subscription and releases the registry entry. */
  readonly close: () => void;
}

export const JPEG_VIEW: VideoPlaneView = { mode: "jpeg", media: null };

/**
 * How long a round may hold a peer connection without producing a decoded
 * frame. The host's own negotiation deadline stops at "answered" - a
 * connection that never carries pixels (ICE settles, media does not flow) is
 * only visible from this end.
 */
const FIRST_FRAME_DEADLINE_MS = 15_000;

export function createVideoPlaneSession(options: {
  /** One `acquireBrowserMediaEntry(...)` result; closing releases it. */
  readonly media: {
    readonly entry: BrowserMediaEntry;
    readonly release: () => void;
  };
  readonly port: WebrtcSignalPort;
  readonly onChange: (view: VideoPlaneView) => void;
}): VideoPlaneSession {
  const { media, onChange, port } = options;
  const { entry } = media;
  /** The round whose first decoded frame has been reported. */
  let liveRound: number | null = null;
  let lastFrameAt: number | null = null;
  let deadlineRound: number | null = null;
  let cancelDeadline: (() => void) | null = null;
  let closed = false;

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
    const timer = window.setTimeout(() => {
      cancelDeadline = null;
      deadlineRound = null;
      entry.reportFailure("no decoded video frame before deadline");
    }, FIRST_FRAME_DEADLINE_MS);
    cancelDeadline = () => {
      window.clearTimeout(timer);
    };
  };

  const publish = (): void => {
    if (closed) return;
    const snapshot = entry.getSnapshot();
    syncDeadline(snapshot);
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
      if (frame.kind === "sdpOffer") {
        // Duplicate and superseded rounds are the registry's call: it owns the
        // round in flight, and this session is not necessarily its only viewer.
        entry.acceptOffer({
          negotiationId: frame.negotiationId,
          sdp: frame.sdp,
          port,
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
    noteVideoFrame: () => {
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
      unsubscribe();
      media.release();
    },
  };
}
