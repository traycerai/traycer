import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  BrowserNavState,
  BrowserScreencastCaptureMode,
  BrowserScreencastClientFrame,
  BrowserScreencastServerFrame,
  BrowserScreencastViewerRole,
} from "@traycer/protocol/host/browser/contracts";
import { BrowserScreencastStreamClient } from "@traycer-clients/shared/host-transport/browser-screencast-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import {
  EMPTY_SCREENCAST_NAV_STATE,
  toastScreencastUnsupportedInteraction,
} from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import {
  createScreencastController,
  type ScreencastController,
  type ScreencastDialog,
  type ScreencastImeHandlers,
  type ScreencastOverlayHandlers,
  type ScreencastSessionRefs,
} from "@/lib/browser-view/sessions/screencast-controller";
import type {
  AgentCursorPosition,
  ScreencastFrameSize,
} from "@/lib/browser-view/sessions/screencast-input-encoding";
import {
  clampScreencastDpr,
  screencastProfile,
  type ScreencastProfile,
} from "@/lib/browser-view/sessions/screencast-profile";
import {
  createVideoPlaneSession,
  NO_VIDEO_VIEW,
  startPlayback,
  type VideoPlaneSession,
  type VideoPlaneView,
} from "@/lib/browser-view/sessions/video-plane-session";
import { deriveSpecDeadlineMs } from "@traycer/protocol/host-transport/rtt-deadlines";
import { VIEWER_CONTROL_PLANE_DEADLINES } from "@/lib/browser-view/sessions/control-plane-deadlines";
import type { WebrtcVideoStatsSample } from "@/lib/browser-view/tiles/webrtc-media-registry";
import {
  acquireBrowserMediaEntry,
  createBrowserMediaPeer,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

const VIEWPORT_DEBOUNCE_MS = 200;
/**
 * Server frames that start a fresh capture, so the ack-tracking sequence resets
 * and the ended plane's stale one cannot linger.
 */
const PRESENTED_SEQUENCE_RESET_KINDS: ReadonlySet<
  BrowserScreencastServerFrame["kind"]
> = new Set<BrowserScreencastServerFrame["kind"]>([
  "started",
  "resized",
  "failed",
  "complete",
]);

// The one re-export left: `ScreencastDialog` is this hook's OUTPUT type, so
// tiles read it off the session rather than off the controller they never see.
export type { ScreencastDialog };

export type ScreencastLifecycle =
  | "connecting"
  | "waiting"
  | "live"
  | "idle"
  | "stale"
  | "disconnected"
  | "failed"
  | "complete";

type ScreencastViewportInput = Omit<
  Extract<BrowserScreencastClientFrame, { readonly kind: "viewport" }>,
  "kind" | "hasBinaryPayload"
>;

export interface ScreencastImage {
  readonly src: string;
  readonly sequence: number;
}

export interface ScreencastSession {
  readonly refs: ScreencastSessionRefs;
  /**
   * The last JPEG frame, or `null` when the JPEG plane is not painting -
   * either none has arrived yet, or the host stopped the cast to attempt
   * video. Exactly one of this and {@link video}`.active` is ever the tile's
   * surface; when neither is, the tile shows its connecting loader.
   */
  readonly image: ScreencastImage | null;
  /**
   * The video plane's display state. `media` is non-null from the inbound
   * track onwards so the `<video>` can mount and decode; `active` says it has
   * decoded a frame and is the surface to show. The window in between is the
   * loader's, never a JPEG frame kept alive underneath (ticket 26).
   */
  readonly video: VideoPlaneView;
  /** The video plane's latest 5s stats sample (ticket 11); `null` off the live round. */
  readonly videoStats: WebrtcVideoStatsSample | null;
  readonly lifecycle: ScreencastLifecycle;
  readonly details: string | null;
  readonly frameSize: ScreencastFrameSize | null;
  readonly navState: BrowserNavState;
  /**
   * This subscription is a `"viewer"`, the tier the host refuses every claim
   * and every input frame from (`viewer-passive`, H07). A tile reading `true`
   * must render no arm and no input affordance at all: the alternative is a
   * control that starts a gesture the host will not finish, which reads as a
   * broken tab (H12).
   */
  readonly readOnly: boolean;
  /** Non-null only while this tile is visible AND the host has armed input. */
  readonly armedEpoch: number | null;
  readonly dialog: ScreencastDialog | null;
  readonly composing: boolean;
  readonly disarm: () => void;
  readonly requestNav: ScreencastController["requestNav"];
  readonly releaseForwardedPageKeys: () => void;
  readonly respondToDialog: ScreencastController["respondToDialog"];
  /**
   * The browser has painted a frame (`<img onLoad>`): latches the presented
   * sequence that pointer frames carry for host-side hit-test correlation,
   * and marks the tile lifecycle live. The ack the host gates its next
   * capture on has already gone out at frame arrival - see
   * `noteFrameArrived` in the transport effect below.
   */
  readonly notePresented: (sequence: number) => void;
  /**
   * Where the agent driving this tab last pointed, or null while nobody is
   * driving it. Positional only - the overlay owns how long it stays visible.
   */
  readonly agentCursor: AgentCursorPosition | null;
  readonly overlayHandlers: ScreencastOverlayHandlers;
  readonly imeHandlers: ScreencastImeHandlers;
}

type ScreencastHostClient = IHostStreamClient<HostStreamRpcRegistry>;

/**
 * A value that only means anything while the client it was produced on is
 * still the tile's. Every interaction slice below is one, so a client swap
 * drops them all with no per-slice reset.
 */
interface ClientScoped<T> {
  readonly client: ScreencastHostClient;
  readonly value: T;
}

function scopedToClient<T>(
  state: ClientScoped<T> | null,
  client: ScreencastHostClient | null,
): T | null {
  return state !== null && state.client === client ? state.value : null;
}

interface ScreencastRenderState {
  readonly client: ScreencastHostClient | null;
  readonly image: ScreencastImage | null;
  readonly lifecycle: ScreencastLifecycle;
  readonly details: string | null;
  readonly frameSize: ScreencastFrameSize | null;
  readonly navState: BrowserNavState;
}

/** A partial, or a function of the client-reset base state, per `patchStreamState`. */
type ScreencastStatePatch =
  | Partial<ScreencastRenderState>
  | ((base: ScreencastRenderState) => Partial<ScreencastRenderState>);

export interface ScreencastSessionOptions {
  readonly client: ScreencastHostClient | null;
  readonly epicId: string;
  /** Identity half of the video plane's media key (with session + tab). */
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly visible: boolean;
  /**
   * Called from the `<video>` attach effect's cleanup, before `srcObject` is
   * cleared - the element still has its last decoded frame at that point,
   * whether the teardown is a plane fallback to JPEG, a fresh negotiation
   * swapping in a new `MediaStream`, or the tile unmounting outright. Passed
   * the live element plus whether the video plane was the one actually
   * painting (not merely attached-but-negotiating) at the moment of
   * teardown - both guards belong with the snapshot write itself, so callers
   * push both signals through rather than pre-filtering.
   */
  readonly captureDormantSnapshot: (
    video: HTMLVideoElement,
    wasActivePlane: boolean,
  ) => void;
}

/**
 * The control tier a shell may subscribe at. `"tile"` only where the shell
 * owns a native browser of its own - which is exactly the desktop, since
 * `browserView` is the shell's own "I have a real BrowserView" capability and
 * both the web bundle (no runner host at all) and the mobile shell
 * (`MobileRunnerHost.browserView = null`) answer `null`.
 *
 * Everything else is a `"viewer"`: it watches the tab, and the host refuses
 * its `arm` and its input frames outright (security review root cause G). The
 * declaration is what the host acts on, so a modified client can still claim
 * `"tile"` - the tier bounds a cooperating viewer, it does not authorize one.
 */
export function screencastRoleForShell(
  runnerHost: Pick<IRunnerHost, "browserView"> | null,
): BrowserScreencastViewerRole {
  if (runnerHost === null || runnerHost.browserView === null) return "viewer";
  return "tile";
}

/**
 * Headless `browser.screencast` viewer. This hook owns only what a render
 * reads - the frame image, the lifecycle, the armed epoch and the composing
 * flag - plus the transport that feeds them. Everything with its own state
 * machine (arm epochs, input queues, pointer bookkeeping) lives in
 * `createScreencastController`, which is plain TypeScript and testable without
 * React.
 */
export function useScreencastSession(
  options: ScreencastSessionOptions,
): ScreencastSession {
  const { client, epicId, hostId, sessionId, tabId, visible } = options;
  // A module constant chosen by the shell this bundle booted into, so the
  // reference is stable across renders and safe to depend on below.
  const profile = screencastProfile();
  const role = screencastRoleForShell(useRunnerHostOrNull());
  const streamRef = useRef<BrowserScreencastStreamClient | null>(null);
  const videoPlaneRef = useRef<VideoPlaneSession | null>(null);
  /**
   * The last geometry the viewport bridge measured, restated whenever the
   * transport reports `open` below.
   *
   * A subscription is re-established (and reconnected) far more often than the
   * tile is resized, and the bridge only mints on a RESIZE - so an
   * already-laid-out tile carried no `viewport` frame at all, leaving the host
   * on the default metrics it falls back to when the last tile closes.
   *
   * The restatement has to wait for `open`, not for the subscribe CALL: the
   * transport drops every client frame while its phase is not `subscribed`
   * (`WsStreamSession.sendClientFrame`), silently. Anything minted in the same
   * tick as the subscribe - the bridge's own first measurement, or a
   * restatement queued at effect entry - is written into that window and lost,
   * which is exactly what the field showed: a whole session whose only
   * `viewport_override` records were `last-tile-close` 1280x720 while the tile
   * had been measuring 1272x800@2 since mount.
   */
  const lastViewportRef = useRef<ScreencastViewportInput | null>(null);
  /**
   * The host's smoothed control-plane RTT for this subscription, refreshed by
   * every `rttProbe`, `null` until the first one lands (ticket 18). One value
   * feeds all three viewer-side deadlines - the arm buffer inside the
   * controller, the video plane's first-frame window, and staleness below -
   * so they can never disagree about how slow this link is.
   */
  const controlPlaneRttRef = useRef<number | null>(null);
  const readControlPlaneRttMs = useCallback(
    () => controlPlaneRttRef.current,
    [],
  );
  // Latest-value refs so the video attach effect (keyed only on
  // `videoView.media`) can read the current "is video the painting plane"
  // state and the current callback at cleanup time without re-running - the
  // effect's own dependency array intentionally does not include either.
  const videoActiveRef = useRef(false);
  /**
   * The committed client, for the controller's `onControlEngaged` - which
   * fires from a DOM event, outside the subscription effect that owns the
   * `client` the frame handlers close over.
   */
  const clientRef = useRef(client);
  const captureDormantSnapshotRef = useRef(options.captureDormantSnapshot);
  const tileRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const overlayButtonRef = useRef<HTMLButtonElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imeInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * When this document last became visible, or `null` while it is hidden.
   *
   * An occluded window stops presenting frames: `requestVideoFrameCallback`
   * never fires and images do not paint, so every deadline fed by a PAINT is
   * measuring the compositor, not the stream. Both planes read this - the
   * video staleness clock below, and the presented-sequence resync - so a
   * round is never judged over a window nobody could see, and the clock
   * restarts from the moment the pixels became observable again rather than
   * from a frame timestamp that predates the whole hidden stretch.
   */
  const visibleSinceRef = useRef<number | null>(null);
  /**
   * The painted JPEG frame, as a latest-value ref: a new one lands ~25x/s
   * while the plane runs, and keying the visibility listener on the state
   * would tear down and re-register it at that rate.
   */
  const presentedImageRef = useRef<ScreencastImage | null>(null);
  /**
   * The stats sample and the last time its `framesDecoded` moved - the
   * DECODE-side half of the video plane's liveness (see
   * {@link isVideoPlaneStale}). Refs, not state: the staleness timer below is
   * keyed on the controller and must not be torn down every 5s cadence tick.
   */
  const videoStatsRef = useRef<WebrtcVideoStatsSample | null>(null);
  const decodeProgressRef = useRef<{
    readonly framesDecoded: number;
    readonly at: number;
  } | null>(null);

  const [armedState, setArmedState] = useState<ClientScoped<number> | null>(
    null,
  );
  const [dialogState, setDialogState] =
    useState<ClientScoped<ScreencastDialog> | null>(null);
  const [composing, setComposing] = useState(false);
  const [agentCursorState, setAgentCursorState] =
    useState<ClientScoped<AgentCursorPosition> | null>(null);
  const [videoViewState, setVideoView] =
    useState<VideoPlaneView>(NO_VIDEO_VIEW);
  const [videoStats, setVideoStats] = useState<WebrtcVideoStatsSample | null>(
    null,
  );
  const [videoFrameSize, setVideoFrameSize] =
    useState<ScreencastFrameSize | null>(null);
  const [streamState, setStreamState] = useState<ScreencastRenderState>(() => ({
    client,
    image: null,
    lifecycle: "connecting",
    details: null,
    frameSize: null,
    navState: EMPTY_SCREENCAST_NAV_STATE,
  }));

  const refs = useMemo<ScreencastSessionRefs>(
    () => ({
      tileRef,
      viewportRef,
      overlayButtonRef,
      imageRef,
      videoRef,
      imeInputRef,
    }),
    [],
  );
  const resetLocalArmState = useCallback(() => {
    setComposing(false);
    setDialogState(null);
    setArmedState(null);
  }, []);
  // eslint-disable-next-line react-hooks/refs -- the controller only stores the ref bag; it reads `.current` from handlers and effects, never during render.
  const [controller] = useState<ScreencastController>(() =>
    createScreencastController({
      refs,
      sendFrame: (frame) => {
        streamRef.current?.sendClientFrame(frame);
      },
      readControlPlaneRttMs,
      // The same latest-value ref the dormant snapshot reads, synced by the
      // passive effect below: pointer events always land after that commit.
      readVideoPainting: () => videoActiveRef.current,
      listeners: {
        // Control, not the arm epoch, is what a render shows: a hover pre-arm
        // holds the epoch at the host but drives nothing.
        onControlEngaged: (epoch) => {
          const engagedClient = clientRef.current;
          if (engagedClient === null) return;
          setArmedState({ client: engagedClient, value: epoch });
        },
        onLocalArmCleared: resetLocalArmState,
        onComposingChange: setComposing,
        onDialogSettled: () => {
          setDialogState(null);
        },
      },
    }),
  );

  // No subscription means no plane: the last round's view would otherwise
  // keep a dead `srcObject` painting and keep reporting video geometry until
  // the tile subscribes again. Derived rather than reset in the effect.
  const subscribed = client !== null && visible;
  const planeView = deriveScreencastPlaneView({
    client,
    subscribed,
    streamState,
    videoViewState,
    videoStats,
    videoFrameSize,
  });
  const { video: videoView, frameSize } = planeView;
  const armedEpoch = visible ? scopedToClient(armedState, client) : null;
  const dialog = scopedToClient(dialogState, client);
  const agentCursor = subscribed
    ? scopedToClient(agentCursorState, client)
    : null;

  /**
   * Every write into `streamState` goes through here: it re-bases on the
   * current client first (a stale client's values are dropped, never merged
   * into the new one's), then applies the caller's fields.
   */
  const patchStreamState = useCallback(
    (patch: ScreencastStatePatch) => {
      setStreamState((current) => {
        const base = resetScreencastStateForClient(current, client);
        const fields = typeof patch === "function" ? patch(base) : patch;
        return { ...base, ...fields };
      });
    },
    [client],
  );

  useEffect(() => {
    controller.resetInputContext();
    if (client === null || !visible) {
      streamRef.current = null;
      controller.clearLocalArm(false);
      return;
    }

    let stream: BrowserScreencastStreamClient | null = null;
    // A transport that replays its status synchronously from `subscribe`
    // reaches these callbacks while the client reference is still unset.
    const beforeOpen: BrowserScreencastClientFrame[] = [];
    const send = (frame: BrowserScreencastClientFrame): void => {
      if (stream === null) beforeOpen.push(frame);
      else stream.sendClientFrame(frame);
    };
    const isCurrent = (): boolean =>
      stream !== null && streamRef.current === stream;

    // The peer connection lives in the module-scoped registry, keyed host +
    // session + tab, so it outlives this subscription's remounts and is shared
    // with the PiP viewer. What is per-subscription is the SIGNALING: the
    // reply channel is this stream, and the host re-attaches (and re-offers)
    // on the next subscribe.
    const media = acquireBrowserMediaEntry({
      key: { hostId, sessionId, tabId },
      createPeer: createBrowserMediaPeer,
    });
    const videoPlane = createVideoPlaneSession({
      media,
      port: {
        sendSdpAnswer: ({ negotiationId, sdp, candidates }) => {
          send({
            kind: "sdpAnswer",
            hasBinaryPayload: false,
            negotiationId,
            sdp,
            candidates: [...candidates],
          });
        },
        sendIceCandidate: ({ negotiationId, ...candidate }) => {
          send({
            kind: "iceCandidate",
            hasBinaryPayload: false,
            negotiationId,
            ...candidate,
          });
        },
        sendVideoPlaneState: ({ negotiationId, state, reason, detail }) => {
          send({
            kind: "videoPlaneState",
            hasBinaryPayload: false,
            negotiationId,
            state,
            reason,
            detail,
          });
        },
        sendVideoStats: ({ negotiationId, ...stats }) => {
          send({
            kind: "videoStats",
            hasBinaryPayload: false,
            negotiationId,
            ...stats,
          });
        },
        // A12: the batch's flush window scales with this same measured
        // control-plane RTT (webrtc-media-registry.ts).
        readControlPlaneRttMs,
      },
      onChange: setVideoView,
      onVideoStats: setVideoStats,
      readControlPlaneRttMs,
    });
    videoPlaneRef.current = videoPlane;

    // Ticket 15: human input rides the round's DataChannels while both are
    // open, and reverts to the mux the moment they are not. Two independent
    // reverts, deliberately - the entry publishes `inputReady: false` on
    // channel close / round supersede / peer failure, and the controller's
    // own `captureMode !== "video"` gate covers a plane fallback whose
    // channels have not closed yet.
    const syncInputTransport = (): void => {
      controller.setInputTransport(
        media.entry.getSnapshot().inputReady
          ? (label, payload) => media.entry.sendInput(label, payload)
          : null,
      );
    };
    const unsubscribeInputTransport = media.entry.subscribe(syncInputTransport);
    syncInputTransport();

    let agentCursorSerial = 0;

    const onConnectionStatus = (
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
    ): void => {
      if (stream !== null && !isCurrent()) return;
      if (status !== "open") {
        controller.notePresentedSequence(null);
        // Plane state cannot outlive the transport that established it: the
        // next subscription starts on JPEG until the host says otherwise.
        controller.noteViewportEpoch(null);
        controller.setCaptureMode("jpeg");
        controller.clearLocalArm(false);
      } else {
        // Restate the measured geometry for THIS round - see `lastViewportRef`.
        // On `open`, because that is the first moment the transport stops
        // dropping what it is handed; every earlier attempt (the bridge's own
        // first measurement included) went into the pre-subscribe window. Also
        // covers a RECONNECT, which re-opens the same stream without re-running
        // this effect at all.
        const knownViewport = lastViewportRef.current;
        if (knownViewport !== null) {
          send({ kind: "viewport", hasBinaryPayload: false, ...knownViewport });
        }
        if (viewportRef.current?.contains(document.activeElement) === true) {
          send({
            kind: "arm",
            hasBinaryPayload: false,
            armEpoch: controller.startArmEpoch(),
          });
        }
      }
      handleStreamStatus(status, reason, patchStreamState);
    };

    const onServerFrame = (
      frame: BrowserScreencastServerFrame,
      binaryPayload: Uint8Array | null,
    ): void => {
      if (stream !== null && !isCurrent()) return;
      // A fresh capture the client has not presented yet: the ack-tracking
      // sequence resets so the ended plane's stale one cannot linger.
      if (PRESENTED_SEQUENCE_RESET_KINDS.has(frame.kind)) {
        controller.notePresentedSequence(null);
      }
      // Ack at arrival, not paint - the host gates its next capture on the
      // ack, and a tile that waited for paint would outrun what the host is
      // willing to send. Same split PiP already uses (pip-headless-stream.ts).
      if (frame.kind === "frame") {
        controller.noteFrameArrived(frame.sequence);
      } else if (frame.kind === "viewportEpoch") {
        controller.noteViewportEpoch(frame.epoch);
      } else if (frame.kind === "rttProbe") {
        // Answered before anything else this frame could imply: the host is
        // timing this reply, so any work in between would be measured as link
        // latency. The estimate it carries is the PREVIOUS probe's result.
        controlPlaneRttRef.current = frame.controlPlaneRttMs;
        send({
          kind: "rttProbeAck",
          hasBinaryPayload: false,
          probeId: frame.probeId,
        });
      } else if (frame.kind === "inputAck") {
        controller.noteInputAck(frame.armEpoch, frame.lastSeq);
      } else if (frame.kind === "captureMode") {
        controller.setCaptureMode(frame.mode);
        // The JPEG cast has stopped, so the frame still on screen is the last
        // one of a plane that is no longer producing: drop it - and with it the
        // geometry its hit test was measured against - and let the tile show
        // its connecting loader until a plane actually paints again (ticket
        // 26). This is the ONLY thing that retires a JPEG frame; a frame
        // arriving is what puts one up.
        if (frame.mode === "video") {
          patchStreamState({ image: null, frameSize: null });
        }
      } else if (frame.kind === "agentCursor") {
        // Only the video plane can be looking at a superseded viewport: a
        // JPEG tile's cursor is decoration over whatever frame it has painted,
        // and per-frame correlation is a thing input needs, not an overlay.
        if (
          shouldAcceptAgentCursorFrame(
            controller.captureMode(),
            frame.epoch,
            controller.viewportEpoch(),
          )
        ) {
          agentCursorSerial += 1;
          setAgentCursorState({
            client,
            value: {
              type: frame.type,
              normalizedX: frame.normalizedX,
              normalizedY: frame.normalizedY,
              label: frame.label,
              id: agentCursorSerial,
            },
          });
        }
      }
      videoPlane.handleServerFrame(frame);
      handleScreencastFrame(frame, binaryPayload, patchStreamState);
      if (frame.kind === "navState") {
        patchStreamState({
          navState: {
            url: frame.url,
            canGoBack: frame.canGoBack,
            canGoForward: frame.canGoForward,
            loading: frame.loading,
          },
        });
      } else if (frame.kind === "unsupportedInteraction") {
        toastScreencastUnsupportedInteraction(frame.feature);
      }
      applyScreencastArmFrame({
        frame,
        controller,
        onDialogOpened: (nextDialog) => {
          setDialogState({ client, value: nextDialog });
        },
        onDialogSettled: () => {
          setDialogState(null);
        },
      });
    };

    stream = new BrowserScreencastStreamClient({
      wsStreamClient: client,
      epicId,
      sessionId,
      tabId,
      maxWidth: profile.maxWidth,
      maxHeight: profile.maxHeight,
      quality: profile.quality,
      format: "jpeg",
      role,
      callbacks: { onServerFrame, onConnectionStatus },
    });
    streamRef.current = stream;
    const opened = stream;
    for (const frame of beforeOpen) opened.sendClientFrame(frame);

    return () => {
      if (streamRef.current === opened) streamRef.current = null;
      controller.notePresentedSequence(null);
      controller.noteViewportEpoch(null);
      controller.setCaptureMode("jpeg");
      unsubscribeInputTransport();
      controller.setInputTransport(null);
      videoPlane.close();
      if (videoPlaneRef.current === videoPlane) videoPlaneRef.current = null;
      // H28: the view goes with the stats, or a healthy re-subscribe paints the
      // dead round's `srcObject` until its first decoded frame lands.
      setVideoView(NO_VIDEO_VIEW);
      setVideoStats(null);
      controller.clearLocalArm(false);
      opened.close();
    };
  }, [
    client,
    controller,
    epicId,
    hostId,
    patchStreamState,
    profile,
    readControlPlaneRttMs,
    role,
    sessionId,
    tabId,
    visible,
  ]);

  const sendViewport = useCallback((viewport: ScreencastViewportInput) => {
    lastViewportRef.current = viewport;
    streamRef.current?.sendClientFrame({
      kind: "viewport",
      hasBinaryPayload: false,
      ...viewport,
    });
  }, []);
  useScreencastViewportBridge(viewportRef, visible, profile, sendViewport);

  // Keeps the two dormant-snapshot latest-value refs current after every
  // commit - a plain PASSIVE effect (not a render-time write, which
  // `react-hooks/refs` disallows; not a layout effect either). Layout
  // effects flush synchronously during commit, before any passive effect's
  // cleanup runs - so on the very commit that flips `videoActive` to false
  // (plane fallback, visible/client change: both derive from the same
  // `videoViewState` that also nulls `videoView.media`), a layout-effect
  // sync would already have overwritten the ref with the new `false` before
  // the video-attach effect's passive cleanup below reads it, silently
  // dropping the snapshot on every teardown but a bare unmount. A passive
  // effect runs its cleanup-then-create in DECLARATION order alongside every
  // other passive effect in the same commit: this one has no cleanup, so its
  // create (the ref write) runs after every passive cleanup already fired -
  // including the video-attach effect's, below - which is what lets that
  // cleanup still read the value from the render being torn down. General
  // hazard, not just this hook: any latest-value ref read inside a passive
  // effect's cleanup must be synced by another PASSIVE effect, never a
  // layout effect.
  useEffect(() => {
    videoActiveRef.current = videoView.active;
    clientRef.current = client;
    presentedImageRef.current = planeView.image;
    captureDormantSnapshotRef.current = options.captureDormantSnapshot;
    videoStatsRef.current = videoStats;
  });

  /**
   * The `<video>` half of the video plane. The tile renders the element (with
   * the same overlay above it as the `<img>`); everything about the media -
   * attaching it, its geometry, and the decoded-frame liveness that reports
   * `videoPlaneState: "live"` - is owned here, so both tile variants stay
   * pure JSX.
   */
  useEffect(() => {
    const element = videoRef.current;
    const media = videoView.media;
    if (element === null || media === null) return;
    element.srcObject = media;
    const noteSize = (): void => {
      setVideoFrameSize(
        element.videoWidth > 0 && element.videoHeight > 0
          ? { width: element.videoWidth, height: element.videoHeight }
          : null,
      );
    };
    const noteFrame = (): void => {
      videoPlaneRef.current?.noteVideoFrame(null);
    };
    let frameHandle: number | null = null;
    // The metadata argument is the whole glass-to-glass measurement (ticket
    // 17): `captureTime`/`receiveTime`/`expectedDisplayTime` are the only
    // client-side view of capture-to-paint there is, and discarding them was
    // what left `glassToGlassMs` null on every sample.
    const onDecodedFrame: VideoFrameRequestCallback = (_now, metadata) => {
      videoPlaneRef.current?.noteVideoFrame(metadata);
      frameHandle = element.requestVideoFrameCallback(onDecodedFrame);
    };
    if (typeof element.requestVideoFrameCallback === "function") {
      frameHandle = element.requestVideoFrameCallback(onDecodedFrame);
    } else {
      // No per-frame callback (an older WebView, jsdom): media progress is the
      // only decode evidence available.
      element.addEventListener("playing", noteFrame);
      element.addEventListener("timeupdate", noteFrame);
    }
    element.addEventListener("loadedmetadata", noteSize);
    element.addEventListener("resize", noteSize);
    noteSize();
    startPlayback(element);
    return () => {
      // Snapshot before anything else touches the element: `srcObject`
      // clearing below (and, on a real unmount, DOM removal right after
      // this cleanup returns) is the deadline - the element still has its
      // last decoded frame right now.
      captureDormantSnapshotRef.current(element, videoActiveRef.current);
      if (frameHandle !== null) element.cancelVideoFrameCallback(frameHandle);
      element.removeEventListener("playing", noteFrame);
      element.removeEventListener("timeupdate", noteFrame);
      element.removeEventListener("loadedmetadata", noteSize);
      element.removeEventListener("resize", noteSize);
      element.srcObject = null;
    };
  }, [videoView.media]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      // While the video plane paints, its decoded frames ARE the liveness
      // signal - the JPEG pump is off, so `lastFrameAt` would freeze at the
      // last JPEG frame and flip a healthy tile to "stale" (G3).
      const videoFrameAt = videoPlaneRef.current?.lastVideoFrameAt() ?? null;
      const lastFrameAt = videoFrameAt ?? controller.lastFrameAt();
      if (lastFrameAt === null) return;
      const staleAfterMs = deriveSpecDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.staleWithoutFrame,
        controlPlaneRttRef.current,
      );
      if (videoFrameAt === null) {
        // JPEG liveness is stamped on ARRIVAL, not on paint, so it means the
        // same whether or not anyone is looking: no visibility gate belongs
        // on this branch.
        if (Date.now() - lastFrameAt < staleAfterMs) return;
      } else {
        // A hidden window presents nothing, so `requestVideoFrameCallback`
        // stops firing on a perfectly healthy track (packets still arriving,
        // decoder still decoding). Judging that silence tears a live round
        // down and leaves the viewer on a plane it has to renegotiate; the
        // clock resumes from the moment the pixels became observable again,
        // so a stream that really did die is still caught one window after
        // the return.
        const visibleSince = visibleSinceRef.current;
        if (visibleSince === null) return;
        const stats = videoStatsRef.current;
        const progress = decodeProgressRef.current;
        if (
          stats !== null &&
          (progress === null || stats.framesDecoded !== progress.framesDecoded)
        ) {
          decodeProgressRef.current = {
            framesDecoded: stats.framesDecoded,
            at: Date.now(),
          };
        }
        if (
          !isVideoPlaneStale({
            videoFrameAt,
            decodeAdvancedAt: decodeProgressRef.current?.at ?? null,
            visibleSince,
            now: Date.now(),
            staleAfterMs,
          })
        ) {
          return;
        }
        // A track that connected, painted, then froze is the one failure no
        // deadline covers (the first-frame one is disarmed by then) and the
        // registry cannot see. Reporting it is what turns the host's JPEG
        // pump back on instead of leaving a frozen tile with no plane at all.
        videoPlaneRef.current?.fail("frames-stopped");
      }
      patchStreamState((base) => ({
        lifecycle:
          base.lifecycle === "live" || base.lifecycle === "waiting"
            ? "stale"
            : base.lifecycle,
      }));
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [controller, patchStreamState]);

  useEffect(() => {
    controller.setVisible(visible);
    if (visible) return;
    controller.detachLocalArm();
    // Refs and host disarm must win immediately; React state follows after
    // this visibility effect commits so the hidden render cannot route input.
    queueMicrotask(resetLocalArmState);
  }, [controller, resetLocalArmState, visible]);

  useLayoutEffect(() => {
    controller.setFrameSize(frameSize);
  }, [controller, frameSize]);

  useEffect(() => {
    const tile = tileRef.current;
    if (tile === null || armedEpoch === null || role === "viewer") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      controller.handleTileKeyDown(event);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      controller.handleTileKeyUp(event);
    };
    const onWindowBlur = (): void => {
      controller.clearClaimedLocalCodes();
    };
    tile.addEventListener("keydown", onKeyDown, true);
    tile.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      tile.removeEventListener("keydown", onKeyDown, true);
      tile.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [armedEpoch, controller, role]);

  useEffect(() => {
    const button = overlayButtonRef.current;
    if (button === null || armedEpoch === null) return;
    const onWheel = (event: WheelEvent): void => {
      controller.handleWheel(event, button);
    };
    button.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      button.removeEventListener("wheel", onWheel);
    };
  }, [armedEpoch, controller]);

  const notePresented = useCallback(
    (sequence: number) => {
      controller.notePresentedSequence(sequence);
      patchStreamState({ lifecycle: "live", details: null });
    },
    [controller, patchStreamState],
  );

  /**
   * The visibility seam both planes depend on.
   *
   * Going hidden stops the staleness clock above (an unobservable round must
   * not be torn down). Coming back re-stamps it AND republishes the JPEG
   * plane's presented sequence, because `<img onLoad>` is the only thing that
   * ever publishes one and a load that completed while the window was
   * occluded may never have fired a paint the tile could observe. Without
   * this the tile returns with `presentedSequence === null`, which is not a
   * degraded correlation but NO correlation: `buildScreencastPointerFrame`
   * drops every click and scroll silently, and nothing re-arms it, because a
   * resting page produces no further frame to load. That is exactly the
   * post-fallback dead tile - the host still holds the arm, the client simply
   * never sends. The element has already decoded by the time we read it, so
   * `complete` is the signal the load event failed to deliver.
   */
  useEffect(() => {
    // Stamped once per hidden->visible edge and left alone while visible: a
    // re-stamp on every commit would keep pushing the staleness clock forward
    // and a frozen tile would never be judged at all.
    const stamp = (): boolean => {
      if (document.visibilityState !== "visible") {
        visibleSinceRef.current = null;
        return false;
      }
      const returned = visibleSinceRef.current === null;
      visibleSinceRef.current ??= Date.now();
      return returned;
    };
    const onVisibilityChange = (): void => {
      if (!stamp()) return;
      const presented = presentedImageRef.current;
      const element = imageRef.current;
      if (presented === null || element === null || !element.complete) return;
      notePresented(presented.sequence);
    };
    stamp();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [notePresented]);

  return {
    refs,
    ...planeView,
    readOnly: role === "viewer",
    armedEpoch,
    dialog,
    composing,
    disarm: controller.disarm,
    requestNav: controller.requestNav,
    releaseForwardedPageKeys: controller.releaseForwardedPageKeys,
    respondToDialog: controller.respondToDialog,
    notePresented,
    agentCursor,
    overlayHandlers: controller.overlayHandlers,
    imeHandlers: controller.imeHandlers,
  };
}

/**
 * Whether a video round that has painted before has genuinely stopped, judged
 * from the last decode-side evidence rather than from presentation alone.
 *
 * `requestVideoFrameCallback` reports COMPOSITING, and compositing is exactly
 * what is fragile across a hidden->visible edge: a window occluded for minutes
 * returns with the track still decoding and rVFC yet to resume, and calling
 * that dead tore down a healthy round. `framesDecoded` (the 5s stats sample)
 * moves whether or not anything is painted, so it is the honest liveness
 * signal here; presentation is still counted, since it is the fresher of the
 * two while the window is visible.
 *
 * The visibility gate is unchanged: nothing is judged over a window nobody
 * could see, so the clock runs from `visibleSince` at the earliest.
 */
export function isVideoPlaneStale(input: {
  readonly videoFrameAt: number;
  readonly decodeAdvancedAt: number | null;
  readonly visibleSince: number;
  readonly now: number;
  readonly staleAfterMs: number;
}): boolean {
  const evidenceAt = Math.max(
    input.videoFrameAt,
    input.decodeAdvancedAt ?? 0,
    input.visibleSince,
  );
  return input.now - evidenceAt >= input.staleAfterMs;
}

/**
 * The render-facing view of both planes: which one is painting, and the
 * lifecycle / geometry / nav state it reports. Pure derivation, pulled out of
 * the hook so its own branching stays readable. `subscribed` is a parameter
 * rather than recomputed here because the caller gates its interaction slices
 * on the same value.
 */
function deriveScreencastPlaneView(input: {
  readonly client: ScreencastHostClient | null;
  readonly subscribed: boolean;
  readonly streamState: ScreencastRenderState;
  readonly videoViewState: VideoPlaneView;
  readonly videoStats: WebrtcVideoStatsSample | null;
  readonly videoFrameSize: ScreencastFrameSize | null;
}): Pick<
  ScreencastSession,
  | "image"
  | "video"
  | "videoStats"
  | "lifecycle"
  | "details"
  | "frameSize"
  | "navState"
> {
  const { streamState, subscribed } = input;
  const video = subscribed ? input.videoViewState : NO_VIDEO_VIEW;
  const current = streamState.client === input.client;
  // A video tile paints no JPEG frame, so `notePresented` never runs and the
  // liveness the chrome reads has to come from the decoded video frames
  // instead. Degraded lifecycles still win - `stale` in particular is how a
  // frozen video track surfaces (G3).
  const lifecycle = current ? streamState.lifecycle : "connecting";
  const upgradable =
    lifecycle === "waiting" || lifecycle === "idle" || lifecycle === "live";
  // The video plane's own geometry wins only while it is painting, so a
  // fallback to JPEG reverts the hit-test box with no restore step (G4).
  const jpegFrameSize = current ? streamState.frameSize : null;
  const frameSize = video.active ? input.videoFrameSize : jpegFrameSize;
  return {
    image: current ? streamState.image : null,
    video,
    videoStats: subscribed ? input.videoStats : null,
    lifecycle: video.active && upgradable ? "live" : lifecycle,
    details: current
      ? streamState.details
      : clientlessDetails(input.client === null),
    frameSize,
    navState: current ? streamState.navState : EMPTY_SCREENCAST_NAV_STATE,
  };
}

/** The only detail line a tile with no client of its own ever shows. */
function clientlessDetails(clientless: boolean): string | null {
  return clientless ? "Waiting for the host stream." : null;
}

/** Whether an `agentCursor` frame is looking at the viewport currently painting. */
function shouldAcceptAgentCursorFrame(
  captureMode: BrowserScreencastCaptureMode,
  frameEpoch: number,
  viewportEpoch: number | null,
): boolean {
  return captureMode !== "video" || frameEpoch === viewportEpoch;
}

function resetScreencastStateForClient(
  current: ScreencastRenderState,
  client: ScreencastHostClient | null,
): ScreencastRenderState {
  if (current.client === client) return current;
  return {
    client,
    image: null,
    lifecycle: "connecting",
    details: clientlessDetails(client === null),
    frameSize: null,
    navState: EMPTY_SCREENCAST_NAV_STATE,
  };
}

function handleStreamStatus(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
  patch: (patch: ScreencastStatePatch) => void,
): void {
  if (status === "open") {
    patch({ lifecycle: "waiting", details: null });
    return;
  }
  if (status === "connecting") {
    patch({ lifecycle: "connecting", details: null });
    return;
  }
  if (status === "reconnecting") {
    patch({
      lifecycle: "stale",
      details: "Reconnecting to the screencast stream.",
    });
    return;
  }
  if (reason?.kind === "fatalError") {
    patch({ lifecycle: "failed", details: reason.details.reason });
    return;
  }
  patch({
    lifecycle: "disconnected",
    details: "Screencast stream disconnected.",
  });
}

function handleScreencastFrame(
  frame: BrowserScreencastServerFrame,
  binaryPayload: Uint8Array | null,
  patch: (patch: ScreencastStatePatch) => void,
): void {
  if (frame.kind === "started" || frame.kind === "resized") {
    patch({
      ...(frame.kind === "started" ? { lifecycle: "waiting" } : {}),
      frameSize: { width: frame.frameWidth, height: frame.frameHeight },
    });
    return;
  }
  if (frame.kind === "frame") {
    if (binaryPayload === null) return;
    patch({
      image: {
        src: `data:image/jpeg;base64,${bytesToBase64(binaryPayload)}`,
        sequence: frame.sequence,
      },
    });
    return;
  }
  if (frame.kind === "stalled") {
    patch({
      lifecycle: "idle",
      details: "Page is live but idle between repaints.",
    });
    return;
  }
  if (frame.kind === "failed") {
    patch({ lifecycle: "failed", details: frame.reason });
    return;
  }
  if (frame.kind === "complete") {
    patch({ lifecycle: "complete", details: "Screencast ended." });
  }
}

function useScreencastViewportBridge(
  ref: RefObject<HTMLElement | null>,
  visible: boolean,
  profile: ScreencastProfile,
  sendViewport: (viewport: ScreencastViewportInput) => void,
): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    let timer: number | null = null;
    const push = (width: number, height: number): void => {
      sendViewport({
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
        dpr: clampScreencastDpr(profile, window.devicePixelRatio),
      });
    };
    const emit = (width: number, height: number): void => {
      if (!visible) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        push(width, height);
      }, VIEWPORT_DEBOUNCE_MS);
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        emit(entry.contentRect.width, entry.contentRect.height);
        break;
      }
    });
    observer.observe(element);
    // The FIRST measurement is not resize churn, so it does not wait out the
    // debounce: the host starts capturing at subscribe, and 200ms of silence
    // is 200ms of capture against whatever metrics the tab was left on. A tile
    // with no layout yet has nothing to state - the observer's own first
    // callback covers that case.
    if (visible && element.clientWidth > 0 && element.clientHeight > 0) {
      push(element.clientWidth, element.clientHeight);
    }
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [profile, ref, sendViewport, visible]);
}

/**
 * The arm half of a server frame: what it does to the local arm, and - since
 * a dialog only exists inside one - to the dialog the arm carries. Pulled out
 * of the frame handler so that handler stays a flat dispatch over frame kinds;
 * everything here is one concern, the arm lifecycle.
 */
function applyScreencastArmFrame(input: {
  readonly frame: BrowserScreencastServerFrame;
  readonly controller: ScreencastController;
  readonly onDialogOpened: (dialog: ScreencastDialog) => void;
  readonly onDialogSettled: () => void;
}): void {
  const { frame, controller } = input;
  if (frame.kind === "failed" || frame.kind === "complete") {
    controller.clearLocalArm(false);
    return;
  }
  if (frame.kind === "armed") {
    // `noteArmed` reports the engagement itself when this arm was a
    // deliberate one; a pre-arm's `armed` deliberately renders nothing. An
    // `armed` for any other epoch is a superseded request's, and is dropped.
    if (controller.desiredArmEpoch() === frame.armEpoch) {
      controller.noteArmed(frame.armEpoch);
    }
    return;
  }
  if (frame.kind === "revoked") {
    if (
      controller.activeArmEpoch() !== frame.armEpoch &&
      controller.desiredArmEpoch() !== frame.armEpoch
    ) {
      return;
    }
    // A refused pre-arm is the one teardown that says nothing about this
    // tile's own state - only that someone else is driving.
    if (frame.cause === "denied") controller.notePreArmDenied();
    controller.clearLocalArm(false);
    return;
  }
  if (frame.kind === "dialogOpened") {
    const armEpoch = controller.activeArmEpoch();
    const current = controller.activeDialog();
    if (
      armEpoch === null ||
      (current !== null && frame.generation <= current.generation)
    ) {
      return;
    }
    const dialog: ScreencastDialog = { ...frame, armEpoch };
    controller.setActiveDialog(dialog);
    input.onDialogOpened(dialog);
    return;
  }
  if (
    frame.kind === "dialogSettled" &&
    controller.activeDialog()?.generation === frame.generation
  ) {
    controller.setActiveDialog(null);
    input.onDialogSettled();
  }
}
