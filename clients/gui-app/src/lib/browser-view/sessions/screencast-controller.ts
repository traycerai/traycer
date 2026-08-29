import type {
  ClipboardEvent as ReactClipboardEvent,
  CompositionEvent as ReactCompositionEvent,
  InputEvent as ReactInputEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import type {
  BrowserScreencastCaptureMode,
  BrowserScreencastClientFrame,
  BrowserScreencastServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import { createScreencastArmBuffer } from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import {
  buildScreencastPointerFrame,
  correlationToken,
  inputModifiers,
  isScreencastModChord,
  nextPointerClickCount,
  pointerButton,
  type PointerClickCount,
  type ScreencastFrameSize,
  type ScreencastInputCorrelation,
  type ScreencastInputFrame,
  type ScreencastKeyboardInput,
  type ScreencastNavInput,
  type ScreencastPointerInput,
} from "@/lib/browser-view/sessions/screencast-input-encoding";
import { wheelDeltaToPixels } from "@/lib/wheel-delta-to-pixels";

const WHEEL_LINE_HEIGHT_PX = 16;

export type ScreencastDialog = Extract<
  BrowserScreencastServerFrame,
  { readonly kind: "dialogOpened" }
> & { readonly armEpoch: number };

export interface ScreencastSessionRefs {
  readonly tileRef: RefObject<HTMLDivElement | null>;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly overlayButtonRef: RefObject<HTMLButtonElement | null>;
  readonly imageRef: RefObject<HTMLImageElement | null>;
  /** The video plane's paint surface; null on a tile that never negotiated. */
  readonly videoRef: RefObject<HTMLVideoElement | null>;
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

/**
 * The four moments the controller has to tell React about. Everything else it
 * owns outright - the epochs, the queues, the pointer bookkeeping - is state no
 * render ever reads, which is why it does not live in the hook.
 */
export interface ScreencastControllerListeners {
  /** Local arm torn down: React must drop armed / dialog / composing state. */
  readonly onLocalArmCleared: () => void;
  readonly onComposingChange: (composing: boolean) => void;
  readonly onDialogSettled: () => void;
}

export interface ScreencastController {
  readonly activeArmEpoch: () => number | null;
  readonly desiredArmEpoch: () => number | null;
  readonly lastFrameAt: () => number | null;
  readonly activeDialog: () => ScreencastDialog | null;
  readonly setVisible: (visible: boolean) => void;
  readonly setFrameSize: (frameSize: ScreencastFrameSize | null) => void;
  readonly setActiveDialog: (dialog: ScreencastDialog | null) => void;
  /** Drops the dialog and composition the previous transport incarnation left. */
  readonly resetInputContext: () => void;
  /** Latches the sequence the browser has actually painted (`<img onLoad>`); JPEG-plane pointer frames carry this for host-side hit-test correlation. */
  readonly notePresentedSequence: (sequence: number | null) => void;
  /**
   * Latches the host's viewport epoch, the video plane's correlation token -
   * a video tile paints no `castSequence`, so this is what its pointer frames
   * carry. `null` while no epoch is confirmed, which withholds input exactly
   * as an unpainted JPEG tile does.
   */
  readonly noteViewportEpoch: (epoch: number | null) => void;
  /**
   * Which plane's token the tile is correlating against. The host announces
   * it (`captureMode` frame); nothing else about the mode lives here.
   */
  readonly setCaptureMode: (mode: BrowserScreencastCaptureMode) => void;
  /** Frame arrived over the wire: freshness clock + the ack the host gates the next capture on. Fires before paint - a tile acks on arrival, same as PiP. */
  readonly noteFrameArrived: (sequence: number) => void;
  /** Allocates the next arm epoch without sending; the caller emits the frame. */
  readonly startArmEpoch: () => number;
  readonly arm: () => void;
  readonly noteArmed: (armEpoch: number) => void;
  readonly disarm: () => void;
  readonly clearLocalArm: (notifyHost: boolean) => void;
  /**
   * Refs-and-host half of a disarm, with no React notification: the visibility
   * teardown needs the host told immediately while the render that can no
   * longer route input commits afterwards.
   */
  readonly detachLocalArm: () => void;
  readonly requestNav: (input: ScreencastNavInput) => void;
  readonly releaseForwardedPageKeys: () => void;
  readonly respondToDialog: (
    generation: number,
    accept: boolean,
    promptText: string | null,
  ) => void;
  readonly onFocusExit: (relatedTarget: EventTarget | null) => void;
  readonly handleTileKeyDown: (event: KeyboardEvent) => void;
  readonly handleTileKeyUp: (event: KeyboardEvent) => void;
  readonly clearClaimedLocalCodes: () => void;
  readonly handleWheel: (event: WheelEvent, surface: HTMLElement) => void;
  readonly overlayHandlers: ScreencastOverlayHandlers;
  readonly imeHandlers: ScreencastImeHandlers;
}

interface CapturedPointer {
  readonly element: HTMLElement;
  readonly pointerId: number;
}

/**
 * The non-React half of a screencast tile: the arm/disarm epoch protocol, the
 * input queues and their encoding dispatch, pointer capture, click counting,
 * rAF move coalescing and every `ScreencastInputFrame` emission. It reads the
 * tile's DOM refs directly and talks to the transport through `sendFrame`, so
 * the hook above it only has to own the handful of values a render actually
 * displays.
 */
export function createScreencastController(options: {
  readonly refs: ScreencastSessionRefs;
  readonly sendFrame: (frame: BrowserScreencastClientFrame) => void;
  readonly listeners: ScreencastControllerListeners;
}): ScreencastController {
  const { listeners, refs, sendFrame } = options;

  let visible = false;
  let armEpochCounter = 0;
  let desiredArmEpoch: number | null = null;
  let activeArmEpoch: number | null = null;
  let inputSequence = 0;
  let presentedSequence: number | null = null;
  let viewportEpoch: number | null = null;
  let captureMode: BrowserScreencastCaptureMode = "jpeg";
  let lastFrameAt: number | null = null;
  let activeDialog: ScreencastDialog | null = null;
  let composing = false;
  let frameSize: ScreencastFrameSize | null = null;
  let capturedPointer: CapturedPointer | null = null;
  let suppressPointerId: number | null = null;
  let pendingMove: ScreencastPointerInput | null = null;
  let moveRaf: number | null = null;
  let pendingWheel: ScreencastPointerInput | null = null;
  let wheelRaf: number | null = null;
  let pointerClickCount: PointerClickCount | null = null;
  let pendingNav: ScreencastNavInput[] = [];
  const acceptedPointerDowns = new Map<
    ScreencastPointerInput["button"],
    ScreencastPointerInput
  >();
  const forwardedKeyDowns = new Map<string, ScreencastKeyboardInput>();
  const claimedLocalCodes = new Set<string>();

  /**
   * The one place the display plane decides anything on this side: which
   * token the pointer frames (and the arm buffer) correlate against. The
   * JPEG plane's `castSequence` path is untouched by the video plane's epoch
   * and vice versa - only this reads `captureMode`.
   */
  /**
   * The element a pointer's coordinates are normalized against.
   *
   * Deliberately NOT keyed off `captureMode`: that is the HOST's echo, while
   * the tile swaps surfaces on its own first decoded frame, and in the RTT
   * window between the two the host-chosen element is the `display:none` one -
   * a zeroed `getBoundingClientRect`, a non-positive scale, and every pointer
   * event silently dropped (permanently, if that `captureMode` frame is lost).
   *
   * The `<video>` is mounted only while the video plane holds a track, and
   * both surfaces are `object-contain` inside the same overlay button, so the
   * one that exists is always the right box - whichever plane is correlating.
   */
  const paintSurface = (): HTMLElement | null =>
    refs.videoRef.current ?? refs.imageRef.current;

  const inputCorrelation = (): ScreencastInputCorrelation =>
    captureMode === "video"
      ? { castSequence: null, viewportEpoch }
      : { castSequence: presentedSequence, viewportEpoch: null };

  const armBuffer = createScreencastArmBuffer<ScreencastPointerInput>(() => {
    pointerClickCount = null;
    if (capturedPointer === null) return;
    suppressPointerId = capturedPointer.pointerId;
  });

  const sendInput = (frame: ScreencastInputFrame): void => {
    if (activeArmEpoch === null) return;
    if (frame.kind === "keyboard") {
      if (frame.type === "rawKeyDown") forwardedKeyDowns.set(frame.code, frame);
      else if (frame.type === "keyUp") forwardedKeyDowns.delete(frame.code);
    }
    sendFrame({
      ...frame,
      hasBinaryPayload: false,
      armEpoch: activeArmEpoch,
      seq: inputSequence,
    });
    inputSequence += 1;
  };

  const releaseCapturedPointer = (): void => {
    const captured = capturedPointer;
    capturedPointer = null;
    if (captured === null) return;
    try {
      captured.element.releasePointerCapture(captured.pointerId);
    } catch {
      // Already released or the node is gone.
    }
  };

  const cancelPendingMove = (): void => {
    pendingMove = null;
    if (moveRaf === null) return;
    window.cancelAnimationFrame(moveRaf);
    moveRaf = null;
  };

  const flushPendingMove = (): void => {
    const pending = pendingMove;
    pendingMove = null;
    if (moveRaf !== null) {
      window.cancelAnimationFrame(moveRaf);
      moveRaf = null;
    }
    if (pending === null) return;
    sendInput(pending);
  };

  const scheduleMove = (frame: ScreencastPointerInput): void => {
    pendingMove = frame;
    if (moveRaf !== null) return;
    moveRaf = window.requestAnimationFrame(() => {
      moveRaf = null;
      const pending = pendingMove;
      pendingMove = null;
      if (pending === null) return;
      sendInput(pending);
    });
  };

  const sendDiscretePointer = (frame: ScreencastPointerInput): void => {
    flushPendingWheel();
    flushPendingMove();
    sendInput(frame);
    if (frame.type === "down") {
      acceptedPointerDowns.set(frame.button, frame);
      return;
    }
    if (frame.type === "up") acceptedPointerDowns.delete(frame.button);
  };

  const wheelDirectionReversed = (
    previous: ScreencastPointerInput,
    next: ScreencastPointerInput,
  ): boolean => {
    const previousX = Math.sign(previous.deltaX);
    const previousY = Math.sign(previous.deltaY);
    const nextX = Math.sign(next.deltaX);
    const nextY = Math.sign(next.deltaY);
    return (
      (previousX !== 0 && nextX !== 0 && previousX !== nextX) ||
      (previousY !== 0 && nextY !== 0 && previousY !== nextY)
    );
  };

  const cancelPendingWheel = (): void => {
    pendingWheel = null;
    if (wheelRaf === null) return;
    window.cancelAnimationFrame(wheelRaf);
    wheelRaf = null;
  };

  // sendInput directly, not sendDiscretePointer - sendDiscretePointer calls
  // flushPendingWheel first, and this IS that flush.
  const flushPendingWheel = (): void => {
    const pending = pendingWheel;
    pendingWheel = null;
    if (wheelRaf !== null) {
      window.cancelAnimationFrame(wheelRaf);
      wheelRaf = null;
    }
    if (pending === null) return;
    flushPendingMove();
    sendInput(pending);
  };

  // Budget: keys + wheel + clicks share the host's 120/s control window
  // (`BROWSER_CONTROL_MAX_FRAMES_PER_WINDOW`, browser-screencast-control.ts).
  // Coalescing every wheel tick into at most one send per animation frame
  // caps wheel at ~60/s, leaving headroom under 120/s for keyboard bursts
  // and clicks sharing the same budget.
  const scheduleWheel = (frame: ScreencastPointerInput): void => {
    if (pendingWheel !== null && wheelDirectionReversed(pendingWheel, frame)) {
      flushPendingWheel();
    }
    pendingWheel =
      pendingWheel === null
        ? frame
        : {
            ...frame,
            deltaX: pendingWheel.deltaX + frame.deltaX,
            deltaY: pendingWheel.deltaY + frame.deltaY,
          };
    if (wheelRaf !== null) return;
    wheelRaf = window.requestAnimationFrame(() => {
      wheelRaf = null;
      flushPendingWheel();
    });
  };

  const resetTransientInput = (): void => {
    armBuffer.drop();
    pendingNav = [];
    forwardedKeyDowns.clear();
    claimedLocalCodes.clear();
    suppressPointerId = null;
    acceptedPointerDowns.clear();
    pointerClickCount = null;
    cancelPendingMove();
    cancelPendingWheel();
    releaseCapturedPointer();
  };

  const resetLocalArmRefs = (): number | null => {
    const armEpoch = activeArmEpoch ?? desiredArmEpoch;
    desiredArmEpoch = null;
    activeArmEpoch = null;
    activeDialog = null;
    composing = false;
    resetTransientInput();
    return armEpoch;
  };

  const startArmEpoch = (): number => {
    armEpochCounter += 1;
    desiredArmEpoch = armEpochCounter;
    inputSequence = 0;
    return armEpochCounter;
  };

  const arm = (): void => {
    if (desiredArmEpoch !== null || activeArmEpoch !== null) return;
    sendFrame({
      kind: "arm",
      hasBinaryPayload: false,
      armEpoch: startArmEpoch(),
    });
  };

  const clearLocalArm = (notifyHost: boolean): void => {
    const armEpoch = resetLocalArmRefs();
    listeners.onLocalArmCleared();
    if (!notifyHost || armEpoch === null) return;
    sendFrame({ kind: "disarm", hasBinaryPayload: false, armEpoch });
  };

  const detachLocalArm = (): void => {
    const armEpoch = resetLocalArmRefs();
    if (armEpoch === null) return;
    sendFrame({ kind: "disarm", hasBinaryPayload: false, armEpoch });
  };

  const deliverArmBuffer = (): void => {
    const hadPending = armBuffer.hasPending();
    const gesture = armBuffer.takeIfCurrent(
      correlationToken(inputCorrelation()),
    );
    if (gesture === null) {
      if (hadPending && capturedPointer !== null) {
        suppressPointerId = capturedPointer.pointerId;
      }
      return;
    }
    sendDiscretePointer(gesture.down);
    sendDiscretePointer(gesture.up);
  };

  const noteArmed = (armEpoch: number): void => {
    activeArmEpoch = armEpoch;
    deliverArmBuffer();
    const pending = pendingNav;
    pendingNav = [];
    for (const frame of pending) sendInput(frame);
  };

  const requestNav = (frame: ScreencastNavInput): void => {
    if (activeArmEpoch !== null) {
      sendInput(frame);
      return;
    }
    pendingNav = [...pendingNav, frame];
    arm();
  };

  const releaseForwardedPageKeys = (): void => {
    for (const frame of Array.from(forwardedKeyDowns.values())) {
      sendInput({ ...frame, type: "keyUp", autoRepeat: false });
    }
  };

  const buildPointerFrame = (request: {
    readonly event: ReactPointerEvent<HTMLButtonElement> | WheelEvent;
    readonly type: ScreencastPointerInput["type"];
    readonly clampToEdge: boolean;
    readonly deltaX: number;
    readonly deltaY: number;
  }): ScreencastPointerInput | null => {
    let clickCount = 0;
    if (request.type === "down") {
      const counted = nextPointerClickCount(
        pointerClickCount,
        request.event,
        performance.now(),
      );
      pointerClickCount = counted;
      clickCount = counted.count;
    } else if (request.type === "up") {
      const accepted = acceptedPointerDowns.get(
        pointerButton(request.event.button),
      );
      const down = pointerClickCount;
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
      correlation: inputCorrelation(),
      surface: paintSurface(),
      frameSize,
    });
  };

  const capturePointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; local teardown still needs the id.
    }
    capturedPointer = {
      element: event.currentTarget,
      pointerId: event.pointerId,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    capturePointer(event);
    const armed = activeArmEpoch !== null;
    const arming = desiredArmEpoch !== null;
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
        suppressPointerId = event.pointerId;
      } else {
        const frame = buildPointerFrame({
          event,
          type: "down",
          clampToEdge: false,
          deltaX: 0,
          deltaY: 0,
        });
        const token =
          frame === null
            ? null
            : correlationToken({
                castSequence: frame.castSequence,
                viewportEpoch: frame.viewportEpoch,
              });
        if (frame !== null && token !== null) {
          armBuffer.storeDown({
            payload: frame,
            correlationToken: token,
            clientX: event.clientX,
            clientY: event.clientY,
            isPrimary: true,
          });
        }
      }
    }
    refs.imeInputRef.current?.focus();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (armBuffer.hasPending()) {
      armBuffer.noteMove(event.clientX, event.clientY);
      if (!armBuffer.hasPending()) suppressPointerId = event.pointerId;
      return;
    }
    if (suppressPointerId === event.pointerId) return;
    if (activeArmEpoch === null) return;
    const frame = buildPointerFrame({
      event,
      type: "move",
      clampToEdge: event.buttons !== 0,
      deltaX: 0,
      deltaY: 0,
    });
    if (frame === null) return;
    scheduleMove(frame);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
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
    if (suppressPointerId === event.pointerId) {
      suppressPointerId = null;
      releaseCapturedPointer();
      return;
    }
    if (
      activeArmEpoch !== null &&
      acceptedPointerDowns.has(pointerButton(event.button))
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
  };

  const onPointerCancel = (): void => {
    if (activeArmEpoch !== null) {
      for (const accepted of acceptedPointerDowns.values()) {
        sendDiscretePointer({ ...accepted, type: "up", buttons: 0 });
      }
    }
    armBuffer.drop();
    suppressPointerId = null;
    acceptedPointerDowns.clear();
    cancelPendingMove();
    cancelPendingWheel();
    releaseCapturedPointer();
  };

  const onImeKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (activeDialog !== null) return;
    if (event.nativeEvent.isComposing || composing) return;
    if (activeArmEpoch === null) return;
    if (isScreencastModChord(event.nativeEvent, "v")) {
      claimedLocalCodes.add(event.code);
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
  };

  const onImeKeyUp = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (activeDialog !== null) return;
    if (event.nativeEvent.isComposing || composing) return;
    if (claimedLocalCodes.delete(event.code)) {
      event.preventDefault();
      return;
    }
    if (activeArmEpoch === null) return;
    if (!forwardedKeyDowns.has(event.code)) return;
    event.preventDefault();
    sendInput({
      kind: "keyboard",
      type: "keyUp",
      code: event.code,
      key: event.key,
      modifiers: inputModifiers(event),
      autoRepeat: event.repeat,
    });
  };

  return {
    activeArmEpoch: () => activeArmEpoch,
    desiredArmEpoch: () => desiredArmEpoch,
    lastFrameAt: () => lastFrameAt,
    activeDialog: () => activeDialog,
    setVisible: (next) => {
      visible = next;
    },
    setFrameSize: (next) => {
      frameSize = next;
    },
    setActiveDialog: (dialog) => {
      activeDialog = dialog;
    },
    resetInputContext: () => {
      activeDialog = null;
      composing = false;
    },
    notePresentedSequence: (sequence) => {
      presentedSequence = sequence;
    },
    noteViewportEpoch: (epoch) => {
      viewportEpoch = epoch;
    },
    setCaptureMode: (mode) => {
      if (mode === captureMode) return;
      captureMode = mode;
      // The two planes' tokens are different number spaces, so a gesture
      // buffered under the old one must not be matched against the new one:
      // a press held at `castSequence` 37 would replay against epoch 37.
      armBuffer.drop();
    },
    noteFrameArrived: (sequence) => {
      lastFrameAt = Date.now();
      sendFrame({ kind: "ack", hasBinaryPayload: false, sequence });
    },
    startArmEpoch,
    arm,
    noteArmed,
    disarm: () => {
      clearLocalArm(true);
    },
    clearLocalArm,
    detachLocalArm,
    requestNav,
    releaseForwardedPageKeys,
    respondToDialog: (generation, accept, promptText) => {
      const current = activeDialog;
      const armEpoch = activeArmEpoch;
      if (
        current === null ||
        current.generation !== generation ||
        armEpoch === null ||
        current.armEpoch !== armEpoch
      ) {
        return;
      }
      activeDialog = null;
      listeners.onDialogSettled();
      sendFrame({
        kind: "dialogResponse",
        hasBinaryPayload: false,
        armEpoch,
        generation,
        accept,
        promptText,
      });
      refs.imeInputRef.current?.focus();
    },
    onFocusExit: (relatedTarget) => {
      if (
        relatedTarget instanceof Node &&
        refs.tileRef.current?.contains(relatedTarget) === true
      ) {
        return;
      }
      clearLocalArm(true);
    },
    handleTileKeyDown: (event) => {
      const tile = refs.tileRef.current;
      if (tile === null) return;
      if (isScreencastModChord(event, "l")) {
        event.preventDefault();
        event.stopPropagation();
        claimedLocalCodes.add(event.code);
        if (document.activeElement === refs.imeInputRef.current) {
          releaseForwardedPageKeys();
        }
        focusScreencastAddressBar(tile);
        return;
      }
      if (isScreencastModChord(event, "r")) {
        event.preventDefault();
        event.stopPropagation();
        claimedLocalCodes.add(event.code);
        requestNav({ kind: "reload" });
      }
    },
    handleTileKeyUp: (event) => {
      if (!claimedLocalCodes.delete(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    clearClaimedLocalCodes: () => {
      claimedLocalCodes.clear();
    },
    handleWheel: (event, surface) => {
      if (activeArmEpoch === null) return;
      event.preventDefault();
      const frame = buildPointerFrame({
        event,
        type: "wheel",
        clampToEdge: false,
        deltaX: wheelDeltaToPixels(
          event.deltaX,
          event.deltaMode,
          surface.clientWidth,
          WHEEL_LINE_HEIGHT_PX,
        ),
        deltaY: wheelDeltaToPixels(
          event.deltaY,
          event.deltaMode,
          surface.clientHeight,
          WHEEL_LINE_HEIGHT_PX,
        ),
      });
      if (frame === null) return;
      scheduleWheel(frame);
    },
    overlayHandlers: {
      onFocus: () => {
        refs.imeInputRef.current?.focus();
      },
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onContextMenu: (event) => {
        if (activeArmEpoch === null) return;
        event.preventDefault();
      },
    },
    imeHandlers: {
      onFocus: arm,
      onKeyDown: onImeKeyDown,
      onKeyUp: onImeKeyUp,
      onPaste: (event) => {
        if (activeArmEpoch === null) return;
        if (!visible) return;
        const text = event.clipboardData.getData("text/plain");
        event.preventDefault();
        if (text === "") return;
        sendInput({ kind: "insertText", text });
      },
      onCompositionStart: () => {
        composing = true;
        listeners.onComposingChange(true);
      },
      onCompositionEnd: (event) => {
        composing = false;
        listeners.onComposingChange(false);
        event.currentTarget.value = "";
        if (event.data !== "") {
          sendInput({ kind: "insertText", text: event.data });
        }
      },
      onInput: (event) => {
        if (!composing) event.currentTarget.value = "";
      },
    },
  };
}

function focusScreencastAddressBar(tile: HTMLElement): void {
  const input = tile.querySelector('input[aria-label="Browser address"]');
  if (!(input instanceof HTMLInputElement)) return;
  input.focus();
  input.select();
}
