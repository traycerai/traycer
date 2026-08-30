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
  BrowserScreencastClientFrame,
  BrowserScreencastServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import { createScreencastArmBuffer } from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import {
  buildScreencastPointerFrame,
  inputModifiers,
  isScreencastModChord,
  nextPointerClickCount,
  pointerButton,
  type PointerClickCount,
  type PointerLike,
  type ScreencastFrameSize,
  type ScreencastInputFrame,
  type ScreencastKeyboardInput,
  type ScreencastNavInput,
  type ScreencastPointerInput,
} from "@/lib/browser-view/sessions/screencast-input-encoding";
import { wheelDeltaToPixels } from "@/lib/wheel-delta-to-pixels";

const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * Finger travel that commits a touch press to a scroll instead of a tap. Wider
 * than the arm buffer's click slop, which measures a mouse holding still: a
 * finger never does, so a threshold tight enough for a cursor would turn every
 * tap into a one-pixel scroll.
 */
const TOUCH_SCROLL_SLOP_PX = 8;

export type ScreencastDialog = Extract<
  BrowserScreencastServerFrame,
  { readonly kind: "dialogOpened" }
> & { readonly armEpoch: number };

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
  readonly onPointerCancel: (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
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
  readonly notePresentedSequence: (sequence: number | null) => void;
  /** Presented sequence + freshness clock + the paint ack the host gates on. */
  readonly notePainted: (sequence: number) => void;
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

/** The one finger a touch gesture is being translated from. */
interface ActiveTouch {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /**
   * The frame that was on screen when the finger LANDED. A click means "this
   * point of what I was looking at", and what the user was looking at is the
   * frame under the press - not whatever has repainted by the time they lift.
   */
  readonly downSequence: number | null;
  lastX: number;
  lastY: number;
  scrolling: boolean;
}

/**
 * A touch gesture completed while the host had not yet answered the arm
 * request. They are held in ONE ordered queue rather than in per-kind slots,
 * because the finger's order is the only order the page can be replayed in: a
 * tap belongs before the swipe that followed it and after the swipe that
 * preceded it, and no rule about kinds can recover that.
 *
 * The queue is also why touch does not use the arm buffer. That buffer holds
 * exactly one gesture and drops it when a second `up` lands outside the first
 * `down`'s slop - correct for a mouse, where a press and a release bracket one
 * click, and destructive for touch, where two taps in the window are two
 * gestures and forcing them through one pen annihilated both.
 */
type PendingTouchGesture =
  | {
      readonly kind: "wheel";
      readonly pointer: PointerLike;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | {
      readonly kind: "tap";
      readonly down: ScreencastPointerInput;
      readonly up: ScreencastPointerInput;
    };

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
  let lastFrameAt: number | null = null;
  let activeDialog: ScreencastDialog | null = null;
  let composing = false;
  let frameSize: ScreencastFrameSize | null = null;
  let capturedPointer: CapturedPointer | null = null;
  let activeTouch: ActiveTouch | null = null;
  let pendingTouchGestures: PendingTouchGesture[] = [];
  let suppressPointerId: number | null = null;
  let pendingMove: ScreencastPointerInput | null = null;
  let moveRaf: number | null = null;
  let pointerClickCount: PointerClickCount | null = null;
  let pendingNav: ScreencastNavInput[] = [];
  const acceptedPointerDowns = new Map<
    ScreencastPointerInput["button"],
    ScreencastPointerInput
  >();
  const forwardedKeyDowns = new Map<string, ScreencastKeyboardInput>();
  const claimedLocalCodes = new Set<string>();

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
    flushPendingMove();
    sendInput(frame);
    if (frame.type === "down") {
      acceptedPointerDowns.set(frame.button, frame);
      return;
    }
    if (frame.type === "up") acceptedPointerDowns.delete(frame.button);
  };

  const resetTransientInput = (): void => {
    armBuffer.drop();
    activeTouch = null;
    pendingTouchGestures = [];
    pendingNav = [];
    forwardedKeyDowns.clear();
    claimedLocalCodes.clear();
    suppressPointerId = null;
    acceptedPointerDowns.clear();
    pointerClickCount = null;
    cancelPendingMove();
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
    const gesture = armBuffer.takeIfCurrent(presentedSequence);
    if (gesture === null) {
      if (hadPending && capturedPointer !== null) {
        suppressPointerId = capturedPointer.pointerId;
      }
      return;
    }
    sendDiscretePointer(gesture.down);
    sendDiscretePointer(gesture.up);
  };

  /**
   * The gestures a finger completed while the arm request was in flight,
   * replayed in the order they were made now that there is an epoch to stamp
   * them with. Without this the whole first interaction with a freshly-opened
   * tile is lost: arming is a round trip, and on a relay it easily outlasts a
   * swipe or a tap.
   *
   * A stale TAP is dropped rather than sent. Its coordinates were normalized
   * against the frame that was on screen when the finger landed, so replaying
   * it against a frame that has since repainted clicks whatever moved into
   * that spot - the same refusal the arm buffer applies to a mouse click. A
   * wheel keeps no such promise: it carries a delta, and scrolling by it is
   * right whatever the page has repainted underneath.
   */
  const flushPendingTouchGestures = (): void => {
    const queued = pendingTouchGestures;
    pendingTouchGestures = [];
    if (activeArmEpoch === null) return;
    // A multi-click chain describes what the PAGE received. Discarding a stale
    // tap breaks it, so nothing after the discard may claim to continue it -
    // neither the taps still in this queue, whose counts were stamped when they
    // were made, nor the next tap the finger produces.
    let chainBroken = false;
    for (const gesture of queued) {
      if (gesture.kind === "wheel") {
        const frame = buildPointerFrame({
          event: gesture.pointer,
          type: "wheel",
          clampToEdge: true,
          deltaX: gesture.deltaX,
          deltaY: gesture.deltaY,
        });
        if (frame !== null) sendDiscretePointer(frame);
        continue;
      }
      if (gesture.down.castSequence !== presentedSequence) {
        chainBroken = true;
        continue;
      }
      sendDiscretePointer(
        chainBroken ? { ...gesture.down, clickCount: 1 } : gesture.down,
      );
      sendDiscretePointer(
        chainBroken ? { ...gesture.up, clickCount: 1 } : gesture.up,
      );
    }
    if (chainBroken) pointerClickCount = null;
  };

  const noteArmed = (armEpoch: number): void => {
    activeArmEpoch = armEpoch;
    // The finger's own gestures first, in the order it made them; then the
    // mouse path's buffered click, which is a different pointer's business.
    flushPendingTouchGestures();
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
    readonly event: PointerLike;
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
      castSequence: presentedSequence,
      image: refs.imageRef.current,
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
    releaseCapturedPointer();
  };

  /**
   * A touch pointer as the encoder wants to see it. The DOM event reports a
   * finger as `button 0 / buttons 1` for its whole life, which is right for the
   * synthesized click and wrong for the synthesized wheel - a wheel carrying a
   * held left button reads on the page as a button-down drag, which is the
   * text selection this translation exists to avoid.
   */
  const touchPointerLike = (
    event: ReactPointerEvent<HTMLButtonElement>,
    buttons: number,
  ): PointerLike => ({
    clientX: event.clientX,
    clientY: event.clientY,
    button: 0,
    buttons,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });

  /** The same pointer, reported where the finger first touched down. */
  const touchPointerLikeAt = (
    touch: ActiveTouch,
    event: ReactPointerEvent<HTMLButtonElement>,
    buttons: number,
  ): PointerLike => ({
    clientX: touch.startX,
    clientY: touch.startY,
    button: 0,
    buttons,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });

  const onTouchPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    event.preventDefault();
    // A second finger is a pinch or a stray palm, neither of which this
    // translation represents; leaving the first one in charge keeps the
    // in-flight scroll coherent instead of tearing between two origins.
    if (activeTouch !== null) return;
    capturePointer(event);
    activeTouch = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      downSequence: presentedSequence,
      lastX: event.clientX,
      lastY: event.clientY,
      scrolling: false,
    };
    // Arming on press, not on the tap that may follow, so the round trip
    // overlaps the gesture and a scroll can start delivering on the first move.
    arm();
  };

  /**
   * One finger-travel segment, as the page should receive it: inverted, because
   * the page follows the finger, and in client pixels - the same unit
   * `handleWheel` converts its own into. Shared by the move handler and the
   * release, which has its own final segment to account for.
   */
  const translateTouchScroll = (
    event: ReactPointerEvent<HTMLButtonElement>,
    deltaX: number,
    deltaY: number,
  ): void => {
    if (deltaX === 0 && deltaY === 0) return;
    if (activeArmEpoch === null) {
      // Queued rather than dropped, and replayed by `noteArmed`. Consecutive
      // moves fold into one wheel entry; a tap in between ends the run, so the
      // scroll either side of it stays on its own side.
      const last = pendingTouchGestures.at(-1);
      const carried = last?.kind === "wheel" ? last : null;
      const next: PendingTouchGesture = {
        kind: "wheel",
        pointer: touchPointerLike(event, 0),
        deltaX: (carried?.deltaX ?? 0) - deltaX,
        deltaY: (carried?.deltaY ?? 0) - deltaY,
      };
      if (carried === null) pendingTouchGestures.push(next);
      else pendingTouchGestures[pendingTouchGestures.length - 1] = next;
      return;
    }
    const frame = buildPointerFrame({
      event: touchPointerLike(event, 0),
      type: "wheel",
      clampToEdge: true,
      deltaX: -deltaX,
      deltaY: -deltaY,
    });
    if (frame === null) return;
    sendDiscretePointer(frame);
  };

  /** Whether the finger has travelled far enough to mean a scroll. */
  const travelExceedsSlop = (
    touch: ActiveTouch,
    clientX: number,
    clientY: number,
  ): boolean =>
    Math.abs(clientX - touch.startX) > TOUCH_SCROLL_SLOP_PX ||
    Math.abs(clientY - touch.startY) > TOUCH_SCROLL_SLOP_PX;

  const onTouchPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const touch = activeTouch;
    if (touch === null || touch.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - touch.lastX;
    const deltaY = event.clientY - touch.lastY;
    if (!touch.scrolling) {
      if (!travelExceedsSlop(touch, event.clientX, event.clientY)) return;
      touch.scrolling = true;
    }
    touch.lastX = event.clientX;
    touch.lastY = event.clientY;
    translateTouchScroll(event, deltaX, deltaY);
  };

  const onTouchPointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const touch = activeTouch;
    if (touch === null || touch.pointerId !== event.pointerId) return;
    activeTouch = null;
    releaseCapturedPointer();
    // The release carries its own displacement. A flick can cross the slop
    // between the last `pointermove` and the `pointerup` - browsers coalesce
    // moves, and a fast one may report almost none - so judging the gesture on
    // `scrolling` alone would call that a tap, click where the finger LANDED,
    // and raise the keyboard over what the user meant as a scroll.
    const scrolled =
      touch.scrolling || travelExceedsSlop(touch, event.clientX, event.clientY);
    if (scrolled) {
      // And the final segment is part of the scroll, whether it is what tipped
      // the gesture over the slop or the tail of one already under way.
      translateTouchScroll(
        event,
        event.clientX - touch.lastX,
        event.clientY - touch.lastY,
      );
      return;
    }
    // Built from where the finger LANDED and stamped with the frame that was
    // presented then. Building from the pointer-up event instead would aim the
    // click at the current frame, so a repaint between press and release would
    // click whatever moved under the finger - and the stale-frame check below
    // would wave it through, because it would be comparing the new frame
    // against itself.
    const downSequence = touch.downSequence;
    // Refused, not merely stamped. A tap belongs to the frame it was made
    // against; once that frame is gone the coordinates describe content that
    // has been replaced, and BOTH delivery paths must say so. Sending it here
    // while the queued path rejects the identical situation would make the
    // answer depend on how busy the host happened to be.
    if (downSequence === null || downSequence !== presentedSequence) {
      // The page receives no click, so the multi-click chain it would have
      // continued does not exist.
      pointerClickCount = null;
      return;
    }
    const pressed = buildPointerFrame({
      event: touchPointerLikeAt(touch, event, 1),
      type: "down",
      clampToEdge: true,
      deltaX: 0,
      deltaY: 0,
    });
    const released = buildPointerFrame({
      event: touchPointerLikeAt(touch, event, 0),
      type: "up",
      clampToEdge: true,
      deltaX: 0,
      deltaY: 0,
    });
    if (pressed === null || released === null) {
      // `buildPointerFrame` advances the multi-click counter for a `down`
      // before it can fail to normalize, so a tap that dies here has still
      // been counted. Same invariant as the stale-frame branch above: no
      // click reached the page, so there is no chain to continue.
      pointerClickCount = null;
      return;
    }
    // A tap is a click, and a click is where typing goes - so the hidden IME
    // input takes focus, raising the phone's keyboard. It happens HERE, after
    // the tap has survived every check: focusing before them raises the
    // keyboard over a gesture that is then discarded, leaving it covering the
    // screen for a tap the page never received. Still inside the pointer-up
    // handler, so it is still the user gesture iOS requires.
    //
    // Blurring later is not the alternative: the tile treats focus leaving the
    // IME input as the user releasing control (`onFocusExit` -> `clearLocalArm`),
    // so a corrective blur would disarm the tab.
    refs.imeInputRef.current?.focus();
    const down = { ...pressed, castSequence: downSequence };
    const up = { ...released, castSequence: downSequence };
    if (activeArmEpoch !== null) {
      sendDiscretePointer(down);
      sendDiscretePointer(up);
      return;
    }
    // Still waiting on the host's `armed`: queue the pair behind whatever the
    // finger did before it.
    pendingTouchGestures.push({ kind: "tap", down, up });
  };

  const onTouchPointerCancel = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    // Only the finger that owns the gesture may end it. An ignored second
    // touch cancels routinely - the browser reclaims it - and tearing down on
    // that would strand the primary finger's scroll mid-drag.
    const touch = activeTouch;
    if (touch === null || touch.pointerId !== event.pointerId) return;
    activeTouch = null;
    // Only the gesture in flight is abandoned; gestures already completed into
    // the queue were the user's and still owed to the page.
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
    notePainted: (sequence) => {
      presentedSequence = sequence;
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
      sendDiscretePointer(frame);
    },
    overlayHandlers: {
      onFocus: () => {
        refs.imeInputRef.current?.focus();
      },
      // A finger is translated before it reaches the pointer path: forwarded
      // verbatim it becomes a mouse drag, which on the remote page selects
      // text rather than scrolling. Every other pointer type - mouse, pen,
      // and the synthetic pointers a test drives - takes the branch below
      // unchanged.
      onPointerDown: (event) => {
        if (event.pointerType === "touch") {
          onTouchPointerDown(event);
          return;
        }
        onPointerDown(event);
      },
      onPointerMove: (event) => {
        if (event.pointerType === "touch") {
          onTouchPointerMove(event);
          return;
        }
        onPointerMove(event);
      },
      onPointerUp: (event) => {
        if (event.pointerType === "touch") {
          onTouchPointerUp(event);
          return;
        }
        onPointerUp(event);
      },
      onPointerCancel: (event) => {
        if (event.pointerType === "touch") {
          onTouchPointerCancel(event);
          return;
        }
        onPointerCancel();
      },
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
