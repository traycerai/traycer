import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  BrowserNavState,
  BrowserScreencastCaptureMode,
  BrowserScreencastClientFrame,
  BrowserScreencastServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import { BrowserScreencastStreamClient } from "@traycer-clients/shared/host-transport/browser-screencast-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  EMPTY_SCREENCAST_NAV_STATE,
  toastScreencastUnsupportedInteraction,
} from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";
import { bytesToBase64 } from "@/lib/composer/image-base64";
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
  createVideoPlaneSession,
  NO_VIDEO_VIEW,
  type VideoPlaneSession,
  type VideoPlaneView,
} from "@/lib/browser-view/sessions/video-plane-session";
import {
  deriveViewerDeadlineMs,
  VIEWER_CONTROL_PLANE_DEADLINES,
} from "@/lib/browser-view/sessions/control-plane-deadlines";
import type { WebrtcVideoStatsSample } from "@/lib/browser-view/tiles/webrtc-media-registry";
import {
  acquireBrowserMediaEntry,
  createBrowserMediaPeer,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 720;
const DEFAULT_QUALITY = 70;
const VIEWPORT_DEBOUNCE_MS = 200;

// Re-exported: the type now lives beside `ScreencastFrameSize`, which every
// consumer reads it with, but the tile side knows it as this hook's output.
export type { AgentCursorPosition };

export type {
  ScreencastDialog,
  ScreencastImeHandlers,
  ScreencastOverlayHandlers,
  ScreencastSessionRefs,
};

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

interface ScreencastRenderState {
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly image: ScreencastImage | null;
  readonly lifecycle: ScreencastLifecycle;
  readonly details: string | null;
  readonly frameSize: ScreencastFrameSize | null;
  readonly navState: BrowserNavState;
}

export interface ScreencastSessionOptions {
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
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
  const streamRef = useRef<BrowserScreencastStreamClient | null>(null);
  const videoPlaneRef = useRef<VideoPlaneSession | null>(null);
  /**
   * The last geometry the viewport bridge measured, restated on every
   * subscription below.
   *
   * A subscription is re-established far more often than the tile is resized
   * (client change, tab switch, reconnect), and the bridge only mints on a
   * RESIZE - so a re-subscribe of an already-laid-out tile carried no
   * `viewport` frame at all, leaving the host on the default metrics it falls
   * back to when the last tile closes. Field evidence: a live round whose most
   * recent `viewport_override` was `last-tile-close` 1280x720 and which never
   * saw a `tile-resize`, while the tile had been measuring 1272x800@2 all along.
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

  const [armedState, setArmedState] = useState<{
    readonly client: IHostStreamClient<HostStreamRpcRegistry>;
    readonly epoch: number;
  } | null>(null);
  const [dialogState, setDialogState] = useState<{
    readonly client: IHostStreamClient<HostStreamRpcRegistry>;
    readonly dialog: ScreencastDialog;
  } | null>(null);
  const [composing, setComposing] = useState(false);
  const [agentCursorState, setAgentCursorState] = useState<{
    readonly client: IHostStreamClient<HostStreamRpcRegistry>;
    readonly cursor: AgentCursorPosition;
  } | null>(null);
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
          setArmedState({ client: engagedClient, epoch });
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
  const {
    videoView,
    videoStatsForRender,
    stateMatchesClient,
    image,
    videoActive,
    lifecycle,
    frameSize,
    navState,
  } = deriveScreencastPlaneView({
    client,
    subscribed,
    videoViewState,
    videoStats,
    streamState,
    videoFrameSize,
  });
  const { armedEpoch, dialog, agentCursor } = deriveScreencastInteractionState({
    client,
    visible,
    subscribed,
    armedState,
    dialogState,
    agentCursorState,
  });
  const details = screencastDetailsForRender(
    stateMatchesClient,
    streamState,
    client,
  );

  const setLifecycle = useCallback(
    (value: SetStateAction<ScreencastLifecycle>) => {
      setStreamState((current) => {
        const base = resetScreencastStateForClient(current, client);
        const lifecycle =
          typeof value === "function" ? value(base.lifecycle) : value;
        return { ...base, lifecycle };
      });
    },
    [client],
  );
  const setDetails = useCallback(
    (value: string | null) => {
      setStreamState((current) => ({
        ...resetScreencastStateForClient(current, client),
        details: value,
      }));
    },
    [client],
  );
  const setImage = useCallback(
    (value: ScreencastImage | null) => {
      setStreamState((current) => ({
        ...resetScreencastStateForClient(current, client),
        image: value,
      }));
    },
    [client],
  );
  const setFrameSize = useCallback(
    (value: ScreencastFrameSize | null) => {
      setStreamState((current) => ({
        ...resetScreencastStateForClient(current, client),
        frameSize: value,
      }));
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
    // Restate the measured geometry for THIS subscription - see
    // `lastViewportRef`. Queued first, so it is the first client frame this
    // subscription sends and the host re-applies the tile's real metrics
    // within one round trip of attach instead of never. It does NOT beat the
    // attach itself: capture can still start against the old metrics, which
    // is fine because `setViewport` re-applies the override on a live capture
    // and the tab-capture track follows it.
    const knownViewport = lastViewportRef.current;
    if (knownViewport !== null) {
      send({ kind: "viewport", hasBinaryPayload: false, ...knownViewport });
    }
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
        sendVideoPlaneState: ({ negotiationId, state, reason }) => {
          send({
            kind: "videoPlaneState",
            hasBinaryPayload: false,
            negotiationId,
            state,
            reason,
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

    // The agent cursor's own view of the plane state, kept beside the
    // controller's rather than read back out of it: what an `agentCursor`
    // frame has to be judged against is the epoch this subscription is
    // painting, and this closure's lifetime is exactly that subscription.
    let viewportEpoch: number | null = null;
    let captureMode: BrowserScreencastCaptureMode = "jpeg";
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
        viewportEpoch = null;
        captureMode = "jpeg";
        controller.setCaptureMode("jpeg");
        controller.clearLocalArm(false);
      } else if (
        viewportRef.current?.contains(document.activeElement) === true
      ) {
        send({
          kind: "arm",
          hasBinaryPayload: false,
          armEpoch: controller.startArmEpoch(),
        });
      }
      handleStreamStatus(status, reason, setLifecycle, setDetails);
    };

    const onServerFrame = (
      frame: BrowserScreencastServerFrame,
      binaryPayload: Uint8Array | null,
    ): void => {
      if (stream !== null && !isCurrent()) return;
      if (isPlaneResettingFrameKind(frame.kind)) {
        controller.notePresentedSequence(null);
      }
      // Ack at arrival, not paint - the host gates its next capture on the
      // ack, and a tile that waited for paint would outrun what the host is
      // willing to send. Same split PiP already uses (pip-headless-stream.ts).
      if (frame.kind === "frame") {
        controller.noteFrameArrived(frame.sequence);
      } else if (frame.kind === "viewportEpoch") {
        viewportEpoch = frame.epoch;
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
        captureMode = frame.mode;
        controller.setCaptureMode(frame.mode);
        // The JPEG cast has stopped, so the frame still on screen is the last
        // one of a plane that is no longer producing: drop it and let the tile
        // show its connecting loader until a plane actually paints again
        // (ticket 26). This is the ONLY thing that retires a JPEG frame - a
        // frame arriving is what puts one up.
        if (frame.mode === "video") setImage(null);
      } else if (frame.kind === "agentCursor") {
        // Only the video plane can be looking at a superseded viewport: a
        // JPEG tile's cursor is decoration over whatever frame it has painted,
        // and per-frame correlation is a thing input needs, not an overlay.
        if (
          shouldAcceptAgentCursorFrame(captureMode, frame.epoch, viewportEpoch)
        ) {
          agentCursorSerial += 1;
          setAgentCursorState({
            client,
            cursor: {
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
      handleScreencastFrame({
        frame,
        binaryPayload,
        setImage,
        setLifecycle,
        setDetails,
        setFrameSize,
      });
      if (frame.kind === "navState") {
        const nextNavState: BrowserNavState = {
          url: frame.url,
          canGoBack: frame.canGoBack,
          canGoForward: frame.canGoForward,
          loading: frame.loading,
        };
        setStreamState((current) => ({
          ...resetScreencastStateForClient(current, client),
          navState: nextNavState,
        }));
      } else if (frame.kind === "unsupportedInteraction") {
        toastScreencastUnsupportedInteraction(frame.feature);
      }
      applyScreencastArmFrame({
        frame,
        controller,
        onDialogOpened: (nextDialog) => {
          setDialogState({ client, dialog: nextDialog });
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
      maxWidth: DEFAULT_MAX_WIDTH,
      maxHeight: DEFAULT_MAX_HEIGHT,
      quality: DEFAULT_QUALITY,
      format: "jpeg",
      role: "tile",
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
      setVideoStats(null);
      controller.clearLocalArm(false);
      opened.close();
    };
  }, [
    client,
    controller,
    epicId,
    hostId,
    readControlPlaneRttMs,
    sessionId,
    setDetails,
    setFrameSize,
    setImage,
    setLifecycle,
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
  useScreencastViewportBridge(viewportRef, visible, sendViewport);

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
    videoActiveRef.current = videoActive;
    clientRef.current = client;
    captureDormantSnapshotRef.current = options.captureDormantSnapshot;
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
      const staleAfterMs = deriveViewerDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.staleWithoutFrame,
        controlPlaneRttRef.current,
      );
      if (Date.now() - lastFrameAt < staleAfterMs) return;
      // A track that connected, painted, then froze is the one failure no
      // deadline covers (the first-frame one is disarmed by then) and the
      // registry cannot see. Reporting it is what turns the host's JPEG pump
      // back on instead of leaving a frozen tile with no plane at all.
      if (videoFrameAt !== null) {
        videoPlaneRef.current?.fail("video frames stopped");
      }
      setLifecycle((current) =>
        current === "live" || current === "waiting" ? "stale" : current,
      );
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [controller, setLifecycle]);

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
    if (tile === null || armedEpoch === null) return;
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
  }, [armedEpoch, controller]);

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
      setLifecycle("live");
      setDetails(null);
    },
    [controller, setDetails, setLifecycle],
  );

  return {
    refs,
    image,
    video: videoView,
    videoStats: videoStatsForRender,
    lifecycle,
    details,
    frameSize,
    navState,
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
 * `muted` + `playsInline` autoplay is allowed, but a source attached after
 * mount still needs the kick. jsdom (and any runtime without a media stack)
 * throws instead of returning a promise, which is not a plane failure.
 */
function startPlayback(element: HTMLVideoElement): void {
  try {
    const started = element.play();
    if (started instanceof Promise) void started.catch(() => {});
  } catch {
    // No media stack; the plane simply never reports a decoded frame.
  }
}

/** Lifecycles a decoded video frame is allowed to upgrade to "live". */
function isFreshLifecycle(lifecycle: ScreencastLifecycle): boolean {
  return (
    lifecycle === "waiting" || lifecycle === "idle" || lifecycle === "live"
  );
}

/**
 * The plane/lifecycle/geometry half of the render-facing derived state: what
 * plane is painting and the lifecycle/frame size/nav state it reports. Pulled
 * out of `useScreencastSession` itself so the hook's own branching stays
 * readable - this is pure derivation, no hook calls. `subscribed` is a
 * parameter rather than recomputed here because `deriveScreencastInteractionState`
 * needs the same value.
 */
function deriveScreencastPlaneView(input: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly subscribed: boolean;
  readonly videoViewState: VideoPlaneView;
  readonly videoStats: WebrtcVideoStatsSample | null;
  readonly streamState: ScreencastRenderState;
  readonly videoFrameSize: ScreencastFrameSize | null;
}): {
  readonly videoView: VideoPlaneView;
  readonly videoStatsForRender: WebrtcVideoStatsSample | null;
  readonly stateMatchesClient: boolean;
  readonly image: ScreencastImage | null;
  readonly videoActive: boolean;
  readonly lifecycle: ScreencastLifecycle;
  readonly frameSize: ScreencastFrameSize | null;
  readonly navState: BrowserNavState;
} {
  const {
    client,
    subscribed,
    videoViewState,
    videoStats,
    streamState,
    videoFrameSize,
  } = input;
  const videoView = subscribed ? videoViewState : NO_VIDEO_VIEW;
  const videoStatsForRender = subscribed ? videoStats : null;
  const stateMatchesClient = streamState.client === client;
  const image = stateMatchesClient ? streamState.image : null;
  const videoActive = videoView.active;
  const baseLifecycle = stateMatchesClient
    ? streamState.lifecycle
    : "connecting";
  // A video tile paints no JPEG frame, so `notePresented` never runs and the
  // liveness the chrome reads has to come from the decoded video frames
  // instead. Degraded lifecycles still win - `stale` in particular is how a
  // frozen video track surfaces (G3).
  const lifecycle: ScreencastLifecycle =
    videoActive && isFreshLifecycle(baseLifecycle) ? "live" : baseLifecycle;
  const jpegFrameSize = stateMatchesClient ? streamState.frameSize : null;
  // The video plane's own geometry wins only while it is painting, so a
  // fallback to JPEG reverts the hit-test box with no restore step (G4).
  const frameSize = videoActive ? videoFrameSize : jpegFrameSize;
  const navState = stateMatchesClient
    ? streamState.navState
    : EMPTY_SCREENCAST_NAV_STATE;
  return {
    videoView,
    videoStatsForRender,
    stateMatchesClient,
    image,
    videoActive,
    lifecycle,
    frameSize,
    navState,
  };
}

/** The arm/dialog/agent-cursor slices gated to the current client and visibility. */
function deriveScreencastInteractionState(input: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly visible: boolean;
  readonly subscribed: boolean;
  readonly armedState: {
    readonly client: IHostStreamClient<HostStreamRpcRegistry>;
    readonly epoch: number;
  } | null;
  readonly dialogState: {
    readonly client: IHostStreamClient<HostStreamRpcRegistry>;
    readonly dialog: ScreencastDialog;
  } | null;
  readonly agentCursorState: {
    readonly client: IHostStreamClient<HostStreamRpcRegistry>;
    readonly cursor: AgentCursorPosition;
  } | null;
}): {
  readonly armedEpoch: number | null;
  readonly dialog: ScreencastDialog | null;
  readonly agentCursor: AgentCursorPosition | null;
} {
  const {
    client,
    visible,
    subscribed,
    armedState,
    dialogState,
    agentCursorState,
  } = input;
  const armedEpochForClient =
    armedState?.client === client ? armedState.epoch : null;
  const armedEpoch = visible ? armedEpochForClient : null;
  const dialog = dialogState?.client === client ? dialogState.dialog : null;
  const agentCursor =
    agentCursorState?.client === client && subscribed
      ? agentCursorState.cursor
      : null;
  return { armedEpoch, dialog, agentCursor };
}

/**
 * Whether a server frame's kind marks a fresh capture the client has not yet
 * presented - the ack-tracking sequence has to reset for all of these so a
 * stale presented-sequence from the plane that just ended doesn't linger.
 */
function isPlaneResettingFrameKind(
  kind: BrowserScreencastServerFrame["kind"],
): boolean {
  return (
    kind === "started" ||
    kind === "resized" ||
    kind === "failed" ||
    kind === "complete"
  );
}

/** Whether an `agentCursor` frame is looking at the viewport currently painting. */
function shouldAcceptAgentCursorFrame(
  captureMode: BrowserScreencastCaptureMode,
  frameEpoch: number,
  viewportEpoch: number | null,
): boolean {
  return captureMode !== "video" || frameEpoch === viewportEpoch;
}

function handleDialogServerFrame(input: {
  readonly frame: BrowserScreencastServerFrame;
  readonly armEpoch: number | null;
  readonly current: ScreencastDialog | null;
  readonly opened: (dialog: ScreencastDialog) => void;
  readonly settled: () => void;
}): void {
  if (input.frame.kind === "dialogOpened") {
    if (
      input.armEpoch === null ||
      (input.current !== null &&
        input.frame.generation <= input.current.generation)
    ) {
      return;
    }
    input.opened({ ...input.frame, armEpoch: input.armEpoch });
  } else if (
    input.frame.kind === "dialogSettled" &&
    input.current?.generation === input.frame.generation
  ) {
    input.settled();
  }
}

function resetScreencastStateForClient(
  current: ScreencastRenderState,
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
): ScreencastRenderState {
  if (current.client === client) return current;
  return {
    client,
    image: null,
    lifecycle: "connecting",
    details: client === null ? "Waiting for the host stream." : null,
    frameSize: null,
    navState: EMPTY_SCREENCAST_NAV_STATE,
  };
}

function screencastDetailsForRender(
  stateMatchesClient: boolean,
  streamState: ScreencastRenderState,
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
): string | null {
  if (stateMatchesClient) return streamState.details;
  if (client === null) return "Waiting for the host stream.";
  return null;
}

function handleStreamStatus(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
  setLifecycle: (value: ScreencastLifecycle) => void,
  setDetails: (value: string | null) => void,
): void {
  if (status === "open") {
    setLifecycle("waiting");
    setDetails(null);
    return;
  }
  if (status === "connecting") {
    setLifecycle("connecting");
    setDetails(null);
    return;
  }
  if (status === "reconnecting") {
    setLifecycle("stale");
    setDetails("Reconnecting to the screencast stream.");
    return;
  }
  if (reason?.kind === "fatalError") {
    setLifecycle("failed");
    setDetails(reason.details.reason);
    return;
  }
  setLifecycle("disconnected");
  setDetails("Screencast stream disconnected.");
}

function handleScreencastFrame(args: {
  readonly frame: BrowserScreencastServerFrame;
  readonly binaryPayload: Uint8Array | null;
  readonly setImage: (value: ScreencastImage) => void;
  readonly setLifecycle: (value: ScreencastLifecycle) => void;
  readonly setDetails: (value: string | null) => void;
  readonly setFrameSize: (value: ScreencastFrameSize | null) => void;
}): void {
  if (args.frame.kind === "started") {
    args.setLifecycle("waiting");
    args.setFrameSize({
      width: args.frame.frameWidth,
      height: args.frame.frameHeight,
    });
    return;
  }
  if (args.frame.kind === "frame") {
    if (args.binaryPayload === null) return;
    args.setImage({
      src: `data:image/jpeg;base64,${bytesToBase64(args.binaryPayload)}`,
      sequence: args.frame.sequence,
    });
    return;
  }
  if (args.frame.kind === "stalled") {
    args.setLifecycle("idle");
    args.setDetails("Page is live but idle between repaints.");
    return;
  }
  if (args.frame.kind === "resized") {
    args.setFrameSize({
      width: args.frame.frameWidth,
      height: args.frame.frameHeight,
    });
    return;
  }
  if (args.frame.kind === "failed") {
    args.setLifecycle("failed");
    args.setDetails(args.frame.reason);
    return;
  }
  if (args.frame.kind === "complete") {
    args.setLifecycle("complete");
    args.setDetails("Screencast ended.");
  }
}

function useScreencastViewportBridge(
  ref: RefObject<HTMLElement | null>,
  visible: boolean,
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
        dpr: window.devicePixelRatio,
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
  }, [ref, sendViewport, visible]);
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
  const control = applyScreencastControlFrame({
    frame,
    desiredEpoch: controller.desiredArmEpoch(),
    activeEpoch: controller.activeArmEpoch(),
  });
  if (control === "teardown") {
    // A refused pre-arm is the one teardown that says nothing about this
    // tile's own state - only that someone else is driving.
    if (frame.kind === "revoked" && frame.cause === "denied") {
      controller.notePreArmDenied();
    }
    controller.clearLocalArm(false);
    return;
  }
  if (control === "armed" && frame.kind === "armed") {
    // `noteArmed` reports the engagement itself when this arm was a
    // deliberate one; a pre-arm's `armed` deliberately renders nothing.
    controller.noteArmed(frame.armEpoch);
    return;
  }
  handleDialogServerFrame({
    frame,
    armEpoch: controller.activeArmEpoch(),
    current: controller.activeDialog(),
    opened: (nextDialog) => {
      controller.setActiveDialog(nextDialog);
      input.onDialogOpened(nextDialog);
    },
    settled: () => {
      controller.setActiveDialog(null);
      input.onDialogSettled();
    },
  });
}

type ScreencastControlResult = "armed" | "teardown" | "ignore";

function applyScreencastControlFrame(input: {
  readonly frame: BrowserScreencastServerFrame;
  readonly desiredEpoch: number | null;
  readonly activeEpoch: number | null;
}): ScreencastControlResult {
  if (input.frame.kind === "failed" || input.frame.kind === "complete") {
    return "teardown";
  }
  if (input.frame.kind === "armed") {
    return input.desiredEpoch === input.frame.armEpoch ? "armed" : "ignore";
  }
  if (input.frame.kind !== "revoked") return "ignore";
  if (
    input.activeEpoch !== input.frame.armEpoch &&
    input.desiredEpoch !== input.frame.armEpoch
  ) {
    return "ignore";
  }
  return "teardown";
}
