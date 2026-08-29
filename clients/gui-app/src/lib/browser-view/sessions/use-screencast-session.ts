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
import type { ScreencastFrameSize } from "@/lib/browser-view/sessions/screencast-input-encoding";
import {
  createVideoPlaneSession,
  JPEG_VIEW,
  type VideoPlaneSession,
  type VideoPlaneView,
} from "@/lib/browser-view/sessions/video-plane-session";
import {
  acquireBrowserMediaEntry,
  createBrowserMediaPeer,
} from "@/lib/browser-view/tiles/webrtc-media-registry";

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 720;
const DEFAULT_QUALITY = 70;
const STALE_WITHOUT_FRAME_MS = 8_000;
const VIEWPORT_DEBOUNCE_MS = 200;

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
  readonly image: ScreencastImage | null;
  /**
   * The video plane's display state. `media` is non-null from the inbound
   * track onwards so the `<video>` can mount and decode; `active` says it has
   * decoded a frame and is the surface to show. Until then the JPEG image
   * keeps painting - there is no black-tile window during ICE.
   */
  readonly video: VideoPlaneView & { readonly active: boolean };
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
  readonly onFocusExit: (relatedTarget: EventTarget | null) => void;
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
  const [videoViewState, setVideoView] = useState<VideoPlaneView>(JPEG_VIEW);
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
      listeners: {
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
  // the tile subscribes again. Derived rather than reset in the effect - the
  // same shape as `stateMatchesClient` below.
  const videoView = client !== null && visible ? videoViewState : JPEG_VIEW;
  const stateMatchesClient = streamState.client === client;
  const image = stateMatchesClient ? streamState.image : null;
  const videoActive = videoView.mode === "video";
  const baseLifecycle = stateMatchesClient
    ? streamState.lifecycle
    : "connecting";
  // A video tile paints no JPEG frame, so `notePresented` never runs and the
  // liveness the chrome reads has to come from the decoded video frames
  // instead. Degraded lifecycles still win - `stale` in particular is how a
  // frozen video track surfaces (G3).
  const lifecycle: ScreencastLifecycle =
    videoActive && isFreshLifecycle(baseLifecycle) ? "live" : baseLifecycle;
  const details = screencastDetailsForRender(
    stateMatchesClient,
    streamState,
    client,
  );
  const jpegFrameSize = stateMatchesClient ? streamState.frameSize : null;
  // The video plane's own geometry wins only while it is painting, so a
  // fallback to JPEG reverts the hit-test box with no restore step (G4).
  const frameSize = videoActive ? videoFrameSize : jpegFrameSize;
  const navState = stateMatchesClient
    ? streamState.navState
    : EMPTY_SCREENCAST_NAV_STATE;
  const armedEpochForClient =
    armedState?.client === client ? armedState.epoch : null;
  const armedEpoch = visible ? armedEpochForClient : null;
  const dialog = dialogState?.client === client ? dialogState.dialog : null;

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
    (value: ScreencastImage) => {
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
    const isCurrent = (): boolean =>
      stream !== null && streamRef.current === stream;

    // The peer connection lives in the module-scoped registry, keyed host +
    // session + tab, so it outlives this subscription's remounts and is shared
    // with the PiP viewer. What is per-subscription is the SIGNALING: the
    // reply channel is this stream, and the host re-attaches (and re-offers)
    // on the next subscribe.
    const videoPlane = createVideoPlaneSession({
      media: acquireBrowserMediaEntry({
        key: { hostId, sessionId, tabId },
        createPeer: createBrowserMediaPeer,
      }),
      port: {
        sendSdpAnswer: ({ negotiationId, sdp }) => {
          send({
            kind: "sdpAnswer",
            hasBinaryPayload: false,
            negotiationId,
            sdp,
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
      },
      onChange: setVideoView,
    });
    videoPlaneRef.current = videoPlane;

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
      if (
        frame.kind === "started" ||
        frame.kind === "resized" ||
        frame.kind === "failed" ||
        frame.kind === "complete"
      ) {
        controller.notePresentedSequence(null);
      }
      // Ack at arrival, not paint - the host gates its next capture on the
      // ack, and a tile that waited for paint would outrun what the host is
      // willing to send. Same split PiP already uses (pip-headless-stream.ts).
      if (frame.kind === "frame") {
        controller.noteFrameArrived(frame.sequence);
      } else if (frame.kind === "viewportEpoch") {
        controller.noteViewportEpoch(frame.epoch);
      } else if (frame.kind === "captureMode") {
        controller.setCaptureMode(frame.mode);
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
      const control = applyScreencastControlFrame({
        frame,
        desiredEpoch: controller.desiredArmEpoch(),
        activeEpoch: controller.activeArmEpoch(),
      });
      if (control === "teardown") {
        controller.clearLocalArm(false);
      } else if (control === "armed" && frame.kind === "armed") {
        controller.noteArmed(frame.armEpoch);
        setArmedState({ client, epoch: frame.armEpoch });
      } else {
        handleDialogServerFrame({
          frame,
          armEpoch: controller.activeArmEpoch(),
          current: controller.activeDialog(),
          opened: (nextDialog) => {
            controller.setActiveDialog(nextDialog);
            setDialogState({ client, dialog: nextDialog });
          },
          settled: () => {
            controller.setActiveDialog(null);
            setDialogState(null);
          },
        });
      }
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
      videoPlane.close();
      if (videoPlaneRef.current === videoPlane) videoPlaneRef.current = null;
      controller.clearLocalArm(false);
      opened.close();
    };
  }, [
    client,
    controller,
    epicId,
    hostId,
    sessionId,
    setDetails,
    setFrameSize,
    setImage,
    setLifecycle,
    tabId,
    visible,
  ]);

  const sendViewport = useCallback((viewport: ScreencastViewportInput) => {
    streamRef.current?.sendClientFrame({
      kind: "viewport",
      hasBinaryPayload: false,
      ...viewport,
    });
  }, []);
  useScreencastViewportBridge(viewportRef, visible, sendViewport);

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
      videoPlaneRef.current?.noteVideoFrame();
    };
    let frameHandle: number | null = null;
    const onDecodedFrame = (): void => {
      noteFrame();
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
      if (Date.now() - lastFrameAt < STALE_WITHOUT_FRAME_MS) return;
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
    video: { ...videoView, active: videoActive },
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
    onFocusExit: controller.onFocusExit,
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
    const emit = (width: number, height: number): void => {
      if (!visible) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        sendViewport({
          width: Math.max(1, Math.round(width)),
          height: Math.max(1, Math.round(height)),
          dpr: window.devicePixelRatio,
        });
      }, VIEWPORT_DEBOUNCE_MS);
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        emit(entry.contentRect.width, entry.contentRect.height);
        break;
      }
    });
    observer.observe(element);
    emit(element.clientWidth, element.clientHeight);
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ref, sendViewport, visible]);
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
