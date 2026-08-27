import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type InputEvent as ReactInputEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
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
  createScreencastArmBuffer,
  type ScreencastArmBuffer,
} from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import {
  EMPTY_SCREENCAST_NAV_STATE,
  toastScreencastUnsupportedInteraction,
} from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  buildScreencastPointerFrame,
  inputModifiers,
  isScreencastModChord,
  nextPointerClickCount,
  pointerButton,
  type PointerClickCount,
  type ScreencastFrameSize,
  type ScreencastInputFrame,
  type ScreencastKeyboardInput,
  type ScreencastNavInput,
  type ScreencastPointerInput,
} from "@/lib/browser-view/sessions/screencast-input-encoding";
import { wheelDeltaToPixels } from "@/lib/wheel-delta-to-pixels";

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 720;
const DEFAULT_QUALITY = 70;
const STALE_WITHOUT_FRAME_MS = 8_000;
const VIEWPORT_DEBOUNCE_MS = 200;
const WHEEL_LINE_HEIGHT_PX = 16;

export type ScreencastLifecycle =
  | "connecting"
  | "waiting"
  | "live"
  | "idle"
  | "stale"
  | "disconnected"
  | "failed"
  | "complete";

export type ScreencastDialog = Extract<
  BrowserScreencastServerFrame,
  { readonly kind: "dialogOpened" }
> & { readonly armEpoch: number };

type ScreencastViewportInput = Omit<
  Extract<BrowserScreencastClientFrame, { readonly kind: "viewport" }>,
  "kind" | "hasBinaryPayload"
>;

export interface ScreencastImage {
  readonly src: string;
  readonly sequence: number;
}

export interface ScreencastSessionRefs {
  readonly tileRef: RefObject<HTMLDivElement | null>;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly overlayButtonRef: RefObject<HTMLButtonElement | null>;
  readonly imageRef: RefObject<HTMLImageElement | null>;
  readonly imeInputRef: RefObject<HTMLInputElement | null>;
}

export interface ScreencastOverlayHandlers {
  readonly onFocus: () => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onPointerCancel: () => void;
  readonly onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

export interface ScreencastImeHandlers {
  readonly onFocus: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onKeyUp: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  readonly onPaste: (event: ReactClipboardEvent<HTMLInputElement>) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: (
    event: ReactCompositionEvent<HTMLInputElement>,
  ) => void;
  readonly onInput: (event: ReactInputEvent<HTMLInputElement>) => void;
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
  readonly requestNav: (input: ScreencastNavInput) => void;
  readonly releaseForwardedPageKeys: () => void;
  readonly respondToDialog: (
    generation: number,
    accept: boolean,
    promptText: string | null,
  ) => void;
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

interface CapturedPointer {
  readonly element: HTMLElement;
  readonly pointerId: number;
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
 * Headless `browser.screencast` viewer: transport, arm/disarm epoch protocol,
 * frame decode, JS dialog state, nav state, viewport bridge and the pointer /
 * keyboard input path. Owns the DOM refs its input handlers read so a caller
 * only has to attach them and render.
 */
export function useScreencastSession(
  options: ScreencastSessionOptions,
): ScreencastSession {
  const { client, epicId, sessionId, tabId, visible } = options;
  const streamRef = useRef<BrowserScreencastStreamClient | null>(null);
  const tileRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const overlayButtonRef = useRef<HTMLButtonElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const imeInputRef = useRef<HTMLInputElement | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const armEpochCounterRef = useRef(0);
  const desiredArmEpochRef = useRef<number | null>(null);
  const activeArmEpochRef = useRef<number | null>(null);
  const inputSequenceRef = useRef(0);
  const presentedSequenceRef = useRef<number | null>(null);
  const activeDialogRef = useRef<ScreencastDialog | null>(null);
  const composingRef = useRef(false);
  const frameSizeRef = useRef<ScreencastFrameSize | null>(null);
  const capturedPointerRef = useRef<CapturedPointer | null>(null);
  const suppressPointerIdRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<ScreencastPointerInput | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const acceptedPointerDownsRef = useRef(
    new Map<ScreencastPointerInput["button"], ScreencastPointerInput>(),
  );
  const pointerClickCountRef = useRef<PointerClickCount | null>(null);
  const handleArmBufferDropped = useCallback(() => {
    pointerClickCountRef.current = null;
    const captured = capturedPointerRef.current;
    if (captured === null) return;
    suppressPointerIdRef.current = captured.pointerId;
  }, []);
  const [armBuffer] = useState<ScreencastArmBuffer<ScreencastPointerInput>>(
    // eslint-disable-next-line react-hooks/refs -- the factory stores this handler; it never invokes it during render.
    () => createScreencastArmBuffer(handleArmBufferDropped),
  );
  const deliverArmBufferRef = useRef<() => void>(() => {});
  const flushPendingNavRef = useRef<() => void>(() => {});
  const clearLocalArmRef = useRef<(notifyHost: boolean) => void>(() => {});
  const pendingNavRef = useRef<ScreencastNavInput[]>([]);
  const forwardedKeyDownsRef = useRef(
    new Map<string, ScreencastKeyboardInput>(),
  );
  const claimedLocalCodesRef = useRef(new Set<string>());
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
    activeDialogRef.current = null;
    composingRef.current = false;
    if (client === null || !visible) {
      streamRef.current = null;
      clearLocalArmRef.current(false);
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
        presentedSequenceRef.current = null;
        clearLocalArmRef.current(false);
      } else if (
        viewportRef.current?.contains(document.activeElement) === true
      ) {
        armEpochCounterRef.current += 1;
        const armEpoch = armEpochCounterRef.current;
        desiredArmEpochRef.current = armEpoch;
        inputSequenceRef.current = 0;
        send({ kind: "arm", hasBinaryPayload: false, armEpoch });
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
        presentedSequenceRef.current = null;
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
        desiredEpoch: desiredArmEpochRef.current,
        activeEpoch: activeArmEpochRef.current,
      });
      if (control === "teardown") {
        clearLocalArmRef.current(false);
      } else if (control === "armed" && frame.kind === "armed") {
        activeArmEpochRef.current = frame.armEpoch;
        setArmedState({ client, epoch: frame.armEpoch });
        deliverArmBufferRef.current();
        flushPendingNavRef.current();
      } else {
        handleDialogServerFrame({
          frame,
          armEpoch: activeArmEpochRef.current,
          current: activeDialogRef.current,
          opened: (nextDialog) => {
            activeDialogRef.current = nextDialog;
            setDialogState({ client, dialog: nextDialog });
          },
          settled: () => {
            activeDialogRef.current = null;
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
      presentedSequenceRef.current = null;
      clearLocalArmRef.current(false);
      opened.close();
    };
  }, [
    client,
    epicId,
    sessionId,
    setDetails,
    setFrameSize,
    setImage,
    setLifecycle,
    tabId,
    visible,
  ]);

  const sendFrame = useCallback((frame: BrowserScreencastClientFrame) => {
    streamRef.current?.sendClientFrame(frame);
  }, []);

  const sendViewport = useCallback(
    (viewport: ScreencastViewportInput) => {
      sendFrame({ kind: "viewport", hasBinaryPayload: false, ...viewport });
    },
    [sendFrame],
  );
  useScreencastViewportBridge(viewportRef, visible, sendViewport);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const lastFrameAt = lastFrameAtRef.current;
      if (lastFrameAt === null) return;
      if (Date.now() - lastFrameAt < STALE_WITHOUT_FRAME_MS) return;
      setLifecycle((current) =>
        current === "live" || current === "waiting" ? "stale" : current,
      );
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [setLifecycle]);

  const arm = useCallback(() => {
    if (
      desiredArmEpochRef.current !== null ||
      activeArmEpochRef.current !== null
    ) {
      return;
    }
    armEpochCounterRef.current += 1;
    const armEpoch = armEpochCounterRef.current;
    desiredArmEpochRef.current = armEpoch;
    inputSequenceRef.current = 0;
    sendFrame({ kind: "arm", hasBinaryPayload: false, armEpoch });
  }, [sendFrame]);

  const releaseCapturedPointer = useCallback(() => {
    const captured = capturedPointerRef.current;
    capturedPointerRef.current = null;
    if (captured === null) return;
    try {
      captured.element.releasePointerCapture(captured.pointerId);
    } catch {
      // Already released or the node is gone.
    }
  }, []);

  const cancelPendingMove = useCallback(() => {
    pendingMoveRef.current = null;
    if (moveRafRef.current === null) return;
    window.cancelAnimationFrame(moveRafRef.current);
    moveRafRef.current = null;
  }, []);

  const resetTransientInput = useCallback(() => {
    armBuffer.drop();
    pendingNavRef.current = [];
    forwardedKeyDownsRef.current.clear();
    claimedLocalCodesRef.current.clear();
    suppressPointerIdRef.current = null;
    acceptedPointerDownsRef.current.clear();
    pointerClickCountRef.current = null;
    cancelPendingMove();
    releaseCapturedPointer();
  }, [armBuffer, cancelPendingMove, releaseCapturedPointer]);

  const resetLocalArmRefs = useCallback((): number | null => {
    const armEpoch = activeArmEpochRef.current ?? desiredArmEpochRef.current;
    desiredArmEpochRef.current = null;
    activeArmEpochRef.current = null;
    activeDialogRef.current = null;
    composingRef.current = false;
    resetTransientInput();
    return armEpoch;
  }, [resetTransientInput]);

  const resetLocalArmState = useCallback(() => {
    setComposing(false);
    setDialogState(null);
    setArmedState(null);
  }, []);

  const clearLocalArm = useCallback(
    (notifyHost: boolean) => {
      const armEpoch = resetLocalArmRefs();
      resetLocalArmState();
      if (!notifyHost || armEpoch === null) return;
      sendFrame({ kind: "disarm", hasBinaryPayload: false, armEpoch });
    },
    [resetLocalArmRefs, resetLocalArmState, sendFrame],
  );

  const disarm = useCallback(() => {
    clearLocalArm(true);
  }, [clearLocalArm]);

  useEffect(() => {
    if (visible) return;
    const armEpoch = resetLocalArmRefs();
    if (armEpoch !== null) {
      sendFrame({ kind: "disarm", hasBinaryPayload: false, armEpoch });
    }
    // Refs and host disarm must win immediately; React state follows after
    // this visibility effect commits so the hidden render cannot route input.
    queueMicrotask(() => {
      resetLocalArmState();
    });
  }, [resetLocalArmRefs, resetLocalArmState, sendFrame, visible]);

  const sendInput = useCallback(
    (frame: ScreencastInputFrame) => {
      const armEpoch = activeArmEpochRef.current;
      if (armEpoch === null) return;
      if (frame.kind === "keyboard") {
        if (frame.type === "rawKeyDown") {
          forwardedKeyDownsRef.current.set(frame.code, frame);
        } else if (frame.type === "keyUp") {
          forwardedKeyDownsRef.current.delete(frame.code);
        }
      }
      sendFrame({
        ...frame,
        hasBinaryPayload: false,
        armEpoch,
        seq: inputSequenceRef.current,
      });
      inputSequenceRef.current += 1;
    },
    [sendFrame],
  );

  const releaseForwardedPageKeys = useCallback(() => {
    const held = Array.from(forwardedKeyDownsRef.current.values());
    for (const frame of held) {
      sendInput({ ...frame, type: "keyUp", autoRepeat: false });
    }
  }, [sendInput]);

  const flushPendingNav = useCallback(() => {
    const pending = pendingNavRef.current;
    pendingNavRef.current = [];
    for (const frame of pending) {
      sendInput(frame);
    }
  }, [sendInput]);

  const requestNav = useCallback(
    (frame: ScreencastNavInput) => {
      if (activeArmEpochRef.current !== null) {
        sendInput(frame);
        return;
      }
      pendingNavRef.current = [...pendingNavRef.current, frame];
      arm();
    },
    [arm, sendInput],
  );

  useEffect(() => {
    const tile = tileRef.current;
    if (tile === null || armedEpoch === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isScreencastModChord(event, "l")) {
        event.preventDefault();
        event.stopPropagation();
        claimedLocalCodesRef.current.add(event.code);
        if (document.activeElement === imeInputRef.current) {
          releaseForwardedPageKeys();
        }
        focusScreencastAddressBar(tile);
        return;
      }
      if (isScreencastModChord(event, "r")) {
        event.preventDefault();
        event.stopPropagation();
        claimedLocalCodesRef.current.add(event.code);
        requestNav({ kind: "reload" });
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!claimedLocalCodesRef.current.delete(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onWindowBlur = (): void => {
      claimedLocalCodesRef.current.clear();
    };
    tile.addEventListener("keydown", onKeyDown, true);
    tile.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      tile.removeEventListener("keydown", onKeyDown, true);
      tile.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [armedEpoch, releaseForwardedPageKeys, requestNav]);

  const respondToDialog = useCallback(
    (generation: number, accept: boolean, promptText: string | null) => {
      const current = activeDialogRef.current;
      const armEpoch = activeArmEpochRef.current;
      if (
        current === null ||
        current.generation !== generation ||
        armEpoch === null ||
        current.armEpoch !== armEpoch
      ) {
        return;
      }
      activeDialogRef.current = null;
      setDialogState(null);
      sendFrame({
        kind: "dialogResponse",
        hasBinaryPayload: false,
        armEpoch,
        generation,
        accept,
        promptText,
      });
      imeInputRef.current?.focus();
    },
    [sendFrame],
  );

  const buildPointerFrame = useCallback(
    (request: {
      readonly event: ReactPointerEvent<HTMLButtonElement> | WheelEvent;
      readonly type: ScreencastPointerInput["type"];
      readonly clampToEdge: boolean;
      readonly deltaX: number;
      readonly deltaY: number;
    }): ScreencastPointerInput | null => {
      let clickCount = 0;
      if (request.type === "down") {
        const counted = nextPointerClickCount(
          pointerClickCountRef.current,
          request.event,
          performance.now(),
        );
        pointerClickCountRef.current = counted;
        clickCount = counted.count;
      } else if (request.type === "up") {
        const accepted = acceptedPointerDownsRef.current.get(
          pointerButton(request.event.button),
        );
        const down = pointerClickCountRef.current;
        clickCount =
          accepted?.clickCount ??
          (down?.button === request.event.button ? down.count : 1);
      }
      return buildScreencastPointerFrame({
        event: request.event,
        type: request.type,
        clampToEdge: request.clampToEdge,
        deltaX: request.deltaX,
        deltaY: request.deltaY,
        clickCount,
        castSequence: presentedSequenceRef.current,
        image: imageRef.current,
        frameSize: frameSizeRef.current,
      });
    },
    [],
  );

  const flushPendingMove = useCallback(() => {
    const pending = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (moveRafRef.current !== null) {
      window.cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    if (pending === null) return;
    sendInput(pending);
  }, [sendInput]);

  const scheduleMove = useCallback(
    (frame: ScreencastPointerInput) => {
      pendingMoveRef.current = frame;
      if (moveRafRef.current !== null) return;
      moveRafRef.current = window.requestAnimationFrame(() => {
        moveRafRef.current = null;
        const pending = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (pending === null) return;
        sendInput(pending);
      });
    },
    [sendInput],
  );

  const sendDiscretePointer = useCallback(
    (frame: ScreencastPointerInput) => {
      flushPendingMove();
      sendInput(frame);
      if (frame.type === "down") {
        acceptedPointerDownsRef.current.set(frame.button, frame);
        return;
      }
      if (frame.type === "up") {
        acceptedPointerDownsRef.current.delete(frame.button);
      }
    },
    [flushPendingMove, sendInput],
  );

  const deliverArmBuffer = useCallback(() => {
    const hadPending = armBuffer.hasPending();
    const gesture = armBuffer.takeIfCurrent(presentedSequenceRef.current);
    if (gesture === null) {
      const captured = capturedPointerRef.current;
      if (hadPending && captured !== null) {
        suppressPointerIdRef.current = captured.pointerId;
      }
      return;
    }
    sendDiscretePointer(gesture.down);
    sendDiscretePointer(gesture.up);
  }, [armBuffer, sendDiscretePointer]);

  const capturePointer = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort; local teardown still needs the id.
      }
      capturedPointerRef.current = {
        element: event.currentTarget,
        pointerId: event.pointerId,
      };
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      capturePointer(event);
      const armed = activeArmEpochRef.current !== null;
      const arming = desiredArmEpochRef.current !== null;
      if (armed) {
        const frame = buildPointerFrame({
          event,
          type: "down",
          clampToEdge: false,
          deltaX: 0,
          deltaY: 0,
        });
        if (frame !== null) sendDiscretePointer(frame);
      } else if (!arming) {
        arm();
        if (event.button !== 0) {
          suppressPointerIdRef.current = event.pointerId;
        } else {
          const frame = buildPointerFrame({
            event,
            type: "down",
            clampToEdge: false,
            deltaX: 0,
            deltaY: 0,
          });
          if (frame !== null) {
            armBuffer.storeDown({
              payload: frame,
              castSequence: frame.castSequence,
              clientX: event.clientX,
              clientY: event.clientY,
              isPrimary: true,
            });
          }
        }
      }
      imeInputRef.current?.focus();
    },
    [arm, armBuffer, buildPointerFrame, capturePointer, sendDiscretePointer],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (armBuffer.hasPending()) {
        armBuffer.noteMove(event.clientX, event.clientY);
        if (!armBuffer.hasPending()) {
          suppressPointerIdRef.current = event.pointerId;
        }
        return;
      }
      if (suppressPointerIdRef.current === event.pointerId) return;
      if (activeArmEpochRef.current === null) return;
      const frame = buildPointerFrame({
        event,
        type: "move",
        clampToEdge: event.buttons !== 0,
        deltaX: 0,
        deltaY: 0,
      });
      if (frame === null) return;
      scheduleMove(frame);
    },
    [armBuffer, buildPointerFrame, scheduleMove],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (armBuffer.hasPending()) {
        const frame = buildPointerFrame({
          event,
          type: "up",
          clampToEdge: true,
          deltaX: 0,
          deltaY: 0,
        });
        if (frame !== null) {
          armBuffer.storeMatchingUp({
            payload: frame,
            isPrimary: event.button === 0,
            clientX: event.clientX,
            clientY: event.clientY,
          });
        }
        releaseCapturedPointer();
        return;
      }
      if (suppressPointerIdRef.current === event.pointerId) {
        suppressPointerIdRef.current = null;
        releaseCapturedPointer();
        return;
      }
      if (
        activeArmEpochRef.current !== null &&
        acceptedPointerDownsRef.current.has(pointerButton(event.button))
      ) {
        const frame = buildPointerFrame({
          event,
          type: "up",
          clampToEdge: true,
          deltaX: 0,
          deltaY: 0,
        });
        if (frame !== null) sendDiscretePointer(frame);
      }
      releaseCapturedPointer();
    },
    [armBuffer, buildPointerFrame, releaseCapturedPointer, sendDiscretePointer],
  );

  const onPointerCancel = useCallback(() => {
    if (activeArmEpochRef.current !== null) {
      for (const accepted of acceptedPointerDownsRef.current.values()) {
        sendDiscretePointer({ ...accepted, type: "up", buttons: 0 });
      }
    }
    armBuffer.drop();
    suppressPointerIdRef.current = null;
    acceptedPointerDownsRef.current.clear();
    cancelPendingMove();
    releaseCapturedPointer();
  }, [
    armBuffer,
    cancelPendingMove,
    releaseCapturedPointer,
    sendDiscretePointer,
  ]);

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (activeArmEpochRef.current === null) return;
      event.preventDefault();
    },
    [],
  );

  useEffect(() => {
    const button = overlayButtonRef.current;
    if (button === null || armedEpoch === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (activeArmEpochRef.current === null) return;
      event.preventDefault();
      const frame = buildPointerFrame({
        event,
        type: "wheel",
        clampToEdge: false,
        deltaX: wheelDeltaToPixels(
          event.deltaX,
          event.deltaMode,
          button.clientWidth,
          WHEEL_LINE_HEIGHT_PX,
        ),
        deltaY: wheelDeltaToPixels(
          event.deltaY,
          event.deltaMode,
          button.clientHeight,
          WHEEL_LINE_HEIGHT_PX,
        ),
      });
      if (frame === null) return;
      sendDiscretePointer(frame);
    };
    button.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      button.removeEventListener("wheel", onWheel);
    };
  }, [armedEpoch, buildPointerFrame, sendDiscretePointer]);

  const onFocusExit = useCallback(
    (relatedTarget: EventTarget | null) => {
      if (
        relatedTarget instanceof Node &&
        tileRef.current?.contains(relatedTarget) === true
      ) {
        return;
      }
      disarm();
    },
    [disarm],
  );

  const notePainted = useCallback(
    (sequence: number) => {
      presentedSequenceRef.current = sequence;
      lastFrameAtRef.current = Date.now();
      setLifecycle("live");
      setDetails(null);
      sendFrame({ kind: "ack", hasBinaryPayload: false, sequence });
    },
    [sendFrame, setDetails, setLifecycle],
  );

  const focusImeInput = useCallback(() => {
    imeInputRef.current?.focus();
  }, []);

  const onImeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (activeDialogRef.current !== null) return;
      if (event.nativeEvent.isComposing || composingRef.current) return;
      if (activeArmEpochRef.current === null) return;
      if (isScreencastModChord(event.nativeEvent, "v")) {
        claimedLocalCodesRef.current.add(event.code);
        return;
      }
      event.preventDefault();
      sendInput({
        kind: "keyboard",
        type: "rawKeyDown",
        code: event.code,
        key: event.key,
        modifiers: inputModifiers(event),
        autoRepeat: event.repeat,
      });
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        sendInput({
          kind: "keyboard",
          type: "char",
          code: event.code,
          key: event.key,
          modifiers: inputModifiers(event),
          autoRepeat: event.repeat,
        });
      }
    },
    [sendInput],
  );

  const onImeKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (activeDialogRef.current !== null) return;
      if (event.nativeEvent.isComposing || composingRef.current) return;
      if (claimedLocalCodesRef.current.delete(event.code)) {
        event.preventDefault();
        return;
      }
      if (activeArmEpochRef.current === null) return;
      if (!forwardedKeyDownsRef.current.has(event.code)) return;
      event.preventDefault();
      sendInput({
        kind: "keyboard",
        type: "keyUp",
        code: event.code,
        key: event.key,
        modifiers: inputModifiers(event),
        autoRepeat: event.repeat,
      });
    },
    [sendInput],
  );

  const onImePaste = useCallback(
    (event: ReactClipboardEvent<HTMLInputElement>) => {
      if (activeArmEpochRef.current === null) return;
      if (!visible) return;
      const text = event.clipboardData.getData("text/plain");
      event.preventDefault();
      if (text === "") return;
      sendInput({ kind: "insertText", text });
    },
    [sendInput, visible],
  );

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    setComposing(true);
  }, []);

  const onCompositionEnd = useCallback(
    (event: ReactCompositionEvent<HTMLInputElement>) => {
      composingRef.current = false;
      setComposing(false);
      event.currentTarget.value = "";
      if (event.data !== "") {
        sendInput({ kind: "insertText", text: event.data });
      }
    },
    [sendInput],
  );

  const onImeInput = useCallback((event: ReactInputEvent<HTMLInputElement>) => {
    if (!composingRef.current) event.currentTarget.value = "";
  }, []);

  useLayoutEffect(() => {
    frameSizeRef.current = frameSize;
  }, [frameSize]);

  useLayoutEffect(() => {
    deliverArmBufferRef.current = deliverArmBuffer;
  }, [deliverArmBuffer]);

  useLayoutEffect(() => {
    flushPendingNavRef.current = flushPendingNav;
  }, [flushPendingNav]);

  useLayoutEffect(() => {
    clearLocalArmRef.current = clearLocalArm;
  }, [clearLocalArm]);

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
    disarm,
    requestNav,
    releaseForwardedPageKeys,
    respondToDialog,
    notePainted,
    onFocusExit,
    overlayHandlers: {
      onFocus: focusImeInput,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onContextMenu,
    },
    imeHandlers: {
      onFocus: arm,
      onKeyDown: onImeKeyDown,
      onKeyUp: onImeKeyUp,
      onPaste: onImePaste,
      onCompositionStart,
      onCompositionEnd,
      onInput: onImeInput,
    },
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

function focusScreencastAddressBar(tile: HTMLElement): void {
  const input = tile.querySelector('input[aria-label="Browser address"]');
  if (!(input instanceof HTMLInputElement)) return;
  input.focus();
  input.select();
}
