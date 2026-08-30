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
  clampScreencastDpr,
  screencastProfile,
  type ScreencastProfile,
} from "@/lib/browser-view/sessions/screencast-profile";

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
   * The tile acks a frame only once the browser has painted it - the host
   * gates the next capture on that ack, so acking on arrival would outrun the
   * viewer. Also latches the presented sequence that pointer frames carry.
   */
  readonly notePainted: (sequence: number) => void;
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
  const { client, epicId, sessionId, tabId, visible } = options;
  // A module constant chosen by the shell this bundle booted into, so the
  // reference is stable across renders and safe to depend on below.
  const profile = screencastProfile();
  const streamRef = useRef<BrowserScreencastStreamClient | null>(null);
  const tileRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const overlayButtonRef = useRef<HTMLButtonElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
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

  const stateMatchesClient = streamState.client === client;
  const image = stateMatchesClient ? streamState.image : null;
  const lifecycle = stateMatchesClient ? streamState.lifecycle : "connecting";
  const details = screencastDetailsForRender(
    stateMatchesClient,
    streamState,
    client,
  );
  const frameSize = stateMatchesClient ? streamState.frameSize : null;
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

    const onConnectionStatus = (
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
    ): void => {
      if (stream !== null && !isCurrent()) return;
      if (status !== "open") {
        controller.notePresentedSequence(null);
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
      maxWidth: profile.maxWidth,
      maxHeight: profile.maxHeight,
      quality: profile.quality,
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
      controller.clearLocalArm(false);
      opened.close();
    };
  }, [
    client,
    controller,
    epicId,
    sessionId,
    setDetails,
    setFrameSize,
    setImage,
    profile,
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
  useScreencastViewportBridge(viewportRef, visible, profile, sendViewport);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const lastFrameAt = controller.lastFrameAt();
      if (lastFrameAt === null) return;
      if (Date.now() - lastFrameAt < STALE_WITHOUT_FRAME_MS) return;
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

  const notePainted = useCallback(
    (sequence: number) => {
      controller.notePainted(sequence);
      setLifecycle("live");
      setDetails(null);
    },
    [controller, setDetails, setLifecycle],
  );

  return {
    refs,
    image,
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
    notePainted,
    onFocusExit: controller.onFocusExit,
    overlayHandlers: controller.overlayHandlers,
    imeHandlers: controller.imeHandlers,
  };
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
  profile: ScreencastProfile,
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
          dpr: clampScreencastDpr(profile, window.devicePixelRatio),
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
  }, [profile, ref, sendViewport, visible]);
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
