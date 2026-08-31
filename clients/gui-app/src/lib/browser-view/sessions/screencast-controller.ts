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
import { deriveSpecDeadlineMs } from "@traycer/protocol/host-transport/rtt-deadlines";
import { VIEWER_CONTROL_PLANE_DEADLINES } from "@/lib/browser-view/sessions/control-plane-deadlines";
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
import type { BrowserInputChannelLabel } from "@/lib/browser-view/tiles/webrtc-media-registry";
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
  /** Hover pre-arms, so the click that follows costs no arm round trip. */
  readonly onPointerEnter: () => void;
  /**
   * Releases a hover pre-arm's host-side claim. A deliberate gesture arm is
   * left alone: the pointer leaving the tile is not a release of control.
   */
  readonly onPointerLeave: () => void;
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
  /**
   * The viewer took CONTROL of this tab - a press, a nav, focus in the IME -
   * as opposed to merely holding the host-side claim a hover pre-arm raised.
   * Everything a render shows about being in control hangs off this, not off
   * the arm epoch, which a pre-arm also owns.
   */
  readonly onControlEngaged: (armEpoch: number) => void;
  /** Local arm torn down: React must drop armed / dialog / composing state. */
  readonly onLocalArmCleared: () => void;
  readonly onComposingChange: (composing: boolean) => void;
  readonly onDialogSettled: () => void;
}

/**
 * Ticket 15's input transport: the video plane's DataChannels, as one
 * function. `false` means the channel could not take the frame, and the
 * controller re-sends it on the mux - which is what keeps every discrete frame
 * on exactly one transport across a switchover.
 */
export type ScreencastInputTransport = (
  label: BrowserInputChannelLabel,
  payload: string,
) => boolean;

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
  /** The latched viewport epoch, for callers judging a frame against it. */
  readonly viewportEpoch: () => number | null;
  /**
   * Which plane's token the tile is correlating against. The host announces
   * it (`captureMode` frame); nothing else about the mode lives here.
   */
  readonly setCaptureMode: (mode: BrowserScreencastCaptureMode) => void;
  readonly captureMode: () => BrowserScreencastCaptureMode;
  /**
   * The DataChannel sink for human input, or `null` for mux-only. Only the
   * high-frequency input frames ever look at it; arm/disarm, nav, dialog,
   * viewport, ack and videoPlaneState stay on the mux unconditionally.
   *
   * A transport is adopted only once the mux holds nothing this arm epoch -
   * see the reordering hazard on `adoptPendingTransport`. `null` takes effect
   * immediately.
   */
  readonly setInputTransport: (
    transport: ScreencastInputTransport | null,
  ) => void;
  /** Frame arrived over the wire: freshness clock + the ack the host gates the next capture on. Fires before paint - a tile acks on arrival, same as PiP. */
  readonly noteFrameArrived: (sequence: number) => void;
  /** Allocates the next arm epoch without sending; the caller emits the frame. */
  readonly startArmEpoch: () => number;
  readonly noteArmed: (armEpoch: number) => void;
  /**
   * The host refused a pre-arm (another viewer is driving). Latches hover
   * pre-arm off for the rest of this transport's life so a pointer crossing a
   * contested tile cannot storm the mux; an explicit click still arms, which
   * steals, exactly as it did before pre-arm existed.
   */
  readonly notePreArmDenied: () => void;
  /**
   * How far the host has consumed this epoch's input sequence. Once it covers
   * the last frame this client put on the mux, a pending DataChannel transport
   * is promoted immediately - the mux cannot reorder against it any more.
   */
  readonly noteInputAck: (armEpoch: number, lastSeq: number) => void;
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
  /**
   * The host's measured control-plane RTT for this subscription, or `null`
   * before any `rttProbe` has landed. Only the arm buffer's timeout reads it
   * (ticket 18), and only when a press is buffered.
   */
  readonly readControlPlaneRttMs: () => number | null;
  /**
   * Whether the video plane has DECODED a frame - not merely attached a
   * track. The `<video>` is in the tree from `ontrack`, blank, while the tile
   * shows its connecting loader; a pointer normalized against that element
   * would be aimed at pixels nobody can see.
   */
  readonly readVideoPainting: () => boolean;
}): ScreencastController {
  const {
    listeners,
    readControlPlaneRttMs,
    readVideoPainting,
    refs,
    sendFrame,
  } = options;

  let visible = false;
  let armEpochCounter = 0;
  let desiredArmEpoch: number | null = null;
  let activeArmEpoch: number | null = null;
  let inputSequence = 0;
  let presentedSequence: number | null = null;
  let viewportEpoch: number | null = null;
  let captureMode: BrowserScreencastCaptureMode = "jpeg";
  let inputTransport: ScreencastInputTransport | null = null;
  let pendingInputTransport: ScreencastInputTransport | null = null;
  /**
   * The sequence of the last input frame this epoch put on the MUX, or `null`
   * when the mux is known to be drained. Promotion to the DataChannels is
   * gated on it: while a mux frame is unaccounted for, a channel frame could
   * overtake it and be stale-rejected ahead of it.
   */
  let lastMuxInputSeq: number | null = null;
  /** Whether the arm request in flight is a speculative (hover) one. */
  let pendingArmIsPreArm = false;
  /**
   * Deliberate control, as opposed to the bare host-side claim a hover
   * pre-arm holds. A pre-armed tile owns the epoch (so the click that follows
   * costs no round trip) but drives nothing: no ring, no badge, no pointer
   * moves into the remote page against whatever agent is working there.
   */
  let gestureArmed = false;
  /**
   * Deliberate: once refused, hovering stops re-probing a contested tile for
   * the rest of this transport's life. A click still arms - and steals - so
   * the cost of being wrong (the owner released meanwhile) is one click.
   */
  let preArmDenied = false;
  let lastFrameAt: number | null = null;
  let activeDialog: ScreencastDialog | null = null;
  let composing = false;
  let frameSize: ScreencastFrameSize | null = null;
  let capturedPointer: CapturedPointer | null = null;
  let suppressPointerId: number | null = null;
  let pointerClickCount: PointerClickCount | null = null;
  let pendingNav: ScreencastNavInput[] = [];
  const acceptedPointerDowns = new Map<
    ScreencastPointerInput["button"],
    ScreencastPointerInput
  >();
  const forwardedKeyDowns = new Map<string, ScreencastKeyboardInput>();
  const claimedLocalCodes = new Set<string>();

  /**
   * The element a pointer's coordinates are normalized against: whichever
   * plane is PAINTING, since exactly one ever is (ticket 26) and both are
   * `object-contain` inside the same overlay button. `null` for the whole
   * loader window - a mounted-but-blank `<video>` is not a surface - and a
   * pointer frame built against nothing is dropped rather than misaimed.
   */
  const paintSurface = (): HTMLElement | null =>
    (readVideoPainting() ? refs.videoRef.current : null) ??
    refs.imageRef.current;

  /**
   * The one place the display plane decides anything on this side: which token
   * the pointer frames (and the arm buffer) correlate against. `captureMode`
   * is the host telling us whether a JPEG frame is coming at all - `video`
   * covers the whole time its cast is stopped, live track or not - so the
   * epoch is the only token that exists in that window.
   */
  const correlationToken = (): number | null =>
    captureMode === "video" ? viewportEpoch : presentedSequence;

  const armBuffer = createScreencastArmBuffer<ScreencastPointerInput>(
    () => {
      pointerClickCount = null;
      if (capturedPointer === null) return;
      suppressPointerId = capturedPointer.pointerId;
    },
    () =>
      deriveSpecDeadlineMs(
        VIEWER_CONTROL_PLANE_DEADLINES.armBuffer,
        readControlPlaneRttMs(),
      ),
  );

  const sendInput = (frame: ScreencastInputFrame): void => {
    if (activeArmEpoch === null) return;
    if (frame.kind === "keyboard") {
      if (frame.type === "rawKeyDown") forwardedKeyDowns.set(frame.code, frame);
      else if (frame.type === "keyUp") forwardedKeyDowns.delete(frame.code);
    }
    // One encoder, two sinks: the DataChannels carry the SAME wire frame the
    // mux would have carried, so the host has a single parse path.
    const wire: BrowserScreencastClientFrame = {
      ...frame,
      hasBinaryPayload: false,
      armEpoch: activeArmEpoch,
      seq: inputSequence,
    };
    inputSequence += 1;
    const transport = inputTransport;
    const label =
      transport === null || captureMode !== "video"
        ? null
        : inputTransportLabel(frame);
    if (
      label !== null &&
      transport !== null &&
      transport(label, JSON.stringify(wire))
    ) {
      return;
    }
    lastMuxInputSeq = wire.seq;
    sendFrame(wire);
  };

  /**
   * Adopt a pending transport as soon as the mux holds nothing this epoch -
   * at the arm itself (the host resets its `lastSeq` there, so nothing can
   * reorder against the channel), or later, when a host `inputAck` says the
   * mux has drained. The two transports have no ordering between them and the
   * mux runs seconds behind the channel, so a frame still in flight there
   * would arrive after - and be stale-rejected against - the first channel
   * frame that overtook it: a press left on the mux turns a drag into a hover.
   */
  const adoptPendingTransport = (): void => {
    if (pendingInputTransport === null || lastMuxInputSeq !== null) return;
    inputTransport = pendingInputTransport;
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

  // Budget: keys + wheel + clicks share the host's 120/s control window
  // (`BROWSER_CONTROL_MAX_FRAMES_PER_WINDOW`, browser-screencast-control.ts).
  // Coalescing every tick into at most one send per animation frame caps each
  // continuous stream at ~60/s, leaving headroom for keyboard bursts and
  // clicks sharing the same budget.
  const moveInput = rafCoalescer((_pending, next) => next, sendInput);
  const wheelInput = rafCoalescer(
    (pending, next) => ({
      ...next,
      deltaX: pending.deltaX + next.deltaX,
      deltaY: pending.deltaY + next.deltaY,
    }),
    // A pending move belongs ahead of the wheel it preceded.
    (frame) => {
      moveInput.flush();
      sendInput(frame);
    },
  );

  const sendDiscretePointer = (frame: ScreencastPointerInput): void => {
    wheelInput.flush();
    moveInput.flush();
    sendInput(frame);
    if (frame.type === "down") {
      acceptedPointerDowns.set(frame.button, frame);
      return;
    }
    if (frame.type === "up") acceptedPointerDowns.delete(frame.button);
  };

  const resetTransientInput = (): void => {
    armBuffer.drop();
    pendingNav = [];
    forwardedKeyDowns.clear();
    claimedLocalCodes.clear();
    suppressPointerId = null;
    acceptedPointerDowns.clear();
    pointerClickCount = null;
    moveInput.cancel();
    wheelInput.cancel();
    releaseCapturedPointer();
  };

  const resetLocalArmRefs = (): number | null => {
    const armEpoch = activeArmEpoch ?? desiredArmEpoch;
    desiredArmEpoch = null;
    activeArmEpoch = null;
    lastMuxInputSeq = null;
    gestureArmed = false;
    activeDialog = null;
    composing = false;
    resetTransientInput();
    return armEpoch;
  };

  const startArmEpoch = (): number => {
    armEpochCounter += 1;
    desiredArmEpoch = armEpochCounter;
    inputSequence = 0;
    // Minting an epoch outside `sendArmRequest` (the reconnect-with-focus arm
    // in `use-screencast-session`) is always a real claim.
    pendingArmIsPreArm = false;
    gestureArmed = true;
    return armEpochCounter;
  };

  const sendArmRequest = (kind: "arm" | "preArm"): void => {
    const armEpoch = startArmEpoch();
    pendingArmIsPreArm = kind === "preArm";
    gestureArmed = kind === "arm";
    sendFrame({ kind, hasBinaryPayload: false, armEpoch });
  };

  /**
   * Promote the claim this tile already holds into control. A pre-armed tile
   * is already armed at the host, so there is no frame to send and nothing to
   * wait for - only the render (and the move forwarding) to catch up.
   */
  const engageControl = (): void => {
    if (gestureArmed) return;
    gestureArmed = true;
    if (activeArmEpoch !== null) listeners.onControlEngaged(activeArmEpoch);
  };

  const preArm = (): void => {
    if (desiredArmEpoch !== null || activeArmEpoch !== null || preArmDenied) {
      return;
    }
    sendArmRequest("preArm");
  };

  /**
   * The arm a deliberate gesture needs - a press, or a nav from the toolbar:
   * a real one. A speculative claim still in flight is REPLACED rather than
   * waited on, because it may be refused, and the gesture is itself the
   * authorization to take control from whoever holds it. The refusal for the
   * superseded epoch is ignored on arrival (neither the desired nor the active
   * epoch matches it any more).
   */
  const armForGesture = (): void => {
    if (activeArmEpoch !== null) {
      engageControl();
      return;
    }
    if (desiredArmEpoch === null || pendingArmIsPreArm) sendArmRequest("arm");
    else gestureArmed = true;
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
    const gesture = armBuffer.takeIfCurrent(correlationToken());
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
    // The host resets its `lastSeq` on every arm, so this epoch starts with an
    // empty mux by definition.
    lastMuxInputSeq = null;
    preArmDenied = false;
    adoptPendingTransport();
    activeArmEpoch = armEpoch;
    if (gestureArmed) listeners.onControlEngaged(armEpoch);
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
    armForGesture();
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
      correlationToken: correlationToken(),
      captureMode,
      surface: paintSurface(),
      frameSize,
    });
  };

  /**
   * The overlay button by ref, NOT `event.currentTarget`: a touch tap is
   * replayed out of the tile's gesture buffer at pointerup, by which time
   * React has nulled `currentTarget` on the stored down event - and it is the
   * same node either way, since the ref and these handlers sit on one button.
   */
  const capturePointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    const element = refs.overlayButtonRef.current;
    if (element === null) return;
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; local teardown still needs the id.
    }
    capturedPointer = { element, pointerId: event.pointerId };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    capturePointer(event);
    if (activeArmEpoch !== null) {
      engageControl();
      const frame = buildPointerFrame({
        event,
        type: "down",
        clampToEdge: false,
        deltaX: 0,
        deltaY: 0,
      });
      if (frame !== null) sendDiscretePointer(frame);
    } else {
      armForGesture();
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
        const token = correlationToken();
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
    // A hover-only claim forwards nothing: the pointer crossing a tile must
    // not drive the remote cursor.
    if (activeArmEpoch === null || !gestureArmed) return;
    const frame = buildPointerFrame({
      event,
      type: "move",
      clampToEdge: event.buttons !== 0,
      deltaX: 0,
      deltaY: 0,
    });
    if (frame === null) return;
    moveInput.schedule(frame);
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
    moveInput.cancel();
    wheelInput.cancel();
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
    viewportEpoch: () => viewportEpoch,
    captureMode: () => captureMode,
    setCaptureMode: (mode) => {
      if (mode === captureMode) return;
      captureMode = mode;
      // The two planes' tokens are different number spaces, so a gesture
      // buffered under the old one must not be matched against the new one:
      // a press held at `castSequence` 37 would replay against epoch 37.
      armBuffer.drop();
    },
    setInputTransport: (transport) => {
      pendingInputTransport = transport;
      // Demotion is immediate and safe (the fast frames were sent first, so
      // they arrive first); promotion waits for a drained mux.
      if (transport === null) inputTransport = null;
      else adoptPendingTransport();
    },
    noteFrameArrived: (sequence) => {
      lastFrameAt = Date.now();
      sendFrame({ kind: "ack", hasBinaryPayload: false, sequence });
    },
    startArmEpoch,
    noteArmed,
    notePreArmDenied: () => {
      preArmDenied = true;
    },
    noteInputAck: (armEpoch, lastSeq) => {
      if (armEpoch !== activeArmEpoch || lastMuxInputSeq === null) return;
      if (lastSeq < lastMuxInputSeq) return;
      lastMuxInputSeq = null;
      adoptPendingTransport();
    },
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
      wheelInput.schedule(frame);
    },
    overlayHandlers: {
      onFocus: () => {
        refs.imeInputRef.current?.focus();
      },
      onPointerEnter: preArm,
      // A speculative claim the pointer merely raised is released the moment
      // it leaves; a deliberate gesture arm is not, so control survives the
      // pointer wandering off the tile.
      onPointerLeave: () => {
        if (!gestureArmed) detachLocalArm();
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
      onFocus: armForGesture,
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

interface RafCoalescer {
  readonly schedule: (frame: ScreencastPointerInput) => void;
  /** Emits whatever is pending right now (a discrete frame needs it ordered ahead). */
  readonly flush: () => void;
  /** Drops whatever is pending without emitting it (teardown, pointer cancel). */
  readonly cancel: () => void;
}

/**
 * At most one emission per animation frame, with `merge` deciding what several
 * ticks inside one frame add up to: the latest position for moves, the summed
 * deltas for wheels.
 */
function rafCoalescer(
  merge: (
    pending: ScreencastPointerInput,
    next: ScreencastPointerInput,
  ) => ScreencastPointerInput,
  emit: (frame: ScreencastPointerInput) => void,
): RafCoalescer {
  let pending: ScreencastPointerInput | null = null;
  let raf: number | null = null;

  const cancelRaf = (): void => {
    if (raf === null) return;
    window.cancelAnimationFrame(raf);
    raf = null;
  };
  const flush = (): void => {
    const frame = pending;
    pending = null;
    cancelRaf();
    if (frame !== null) emit(frame);
  };

  return {
    schedule: (frame) => {
      pending = pending === null ? frame : merge(pending, frame);
      if (raf !== null) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        flush();
      });
    },
    flush,
    cancel: () => {
      pending = null;
      cancelRaf();
    },
  };
}

/**
 * Which channel a frame belongs on, or `null` for the mux. Moves and wheels
 * are droppable, so they take the unordered lossy channel; everything a page
 * would mis-handle out of order or missing takes the reliable one. Nav frames
 * ride `sendInput` too and are control - they stay on the mux.
 */
function inputTransportLabel(
  frame: ScreencastInputFrame,
): BrowserInputChannelLabel | null {
  if (frame.kind === "keyboard" || frame.kind === "insertText") {
    return "input-reliable";
  }
  if (frame.kind !== "pointer") return null;
  return frame.type === "move" || frame.type === "wheel"
    ? "input-lossy"
    : "input-reliable";
}

function focusScreencastAddressBar(tile: HTMLElement): void {
  const input = tile.querySelector('input[aria-label="Browser address"]');
  if (!(input instanceof HTMLInputElement)) return;
  input.focus();
  input.select();
}
