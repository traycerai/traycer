import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { AlertTriangle, Pause, Radio, WifiOff } from "lucide-react";
import { toast } from "sonner";
import {
  browserScreencastServerFrameSchema,
  type BrowserScreencastClientFrame,
  type BrowserScreencastServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import {
  BrowserTileToolbar,
  type BrowserPictureInPictureControl,
} from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { useCloseCanvasTileWithNestedFocus } from "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus";
import type { TileController } from "@/components/epic-canvas/renderers/tile-controller";
import {
  createScreencastArmBuffer,
  SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX,
  type ScreencastArmBuffer,
} from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import {
  EMPTY_SCREENCAST_NAV_STATE,
  toastScreencastUnsupportedInteraction,
  useScreencastTileChrome,
  type ScreencastNavState,
} from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useRegisterVisibleBrowserTile } from "@/lib/browser-view/visible-tile-registry";
import {
  clearBrowserViewSnapshot,
  publishSelfPaintedTileFrame,
} from "@/lib/browser-view/browser-overlay-coordinator";
import { convertBrowserTabToPip } from "@/lib/browser-view/pip-store";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { hasPlatformModKey } from "@/lib/keybindings/chord";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { cn } from "@/lib/utils";
import { wheelDeltaToPixels } from "@/lib/wheel-delta-to-pixels";
import type { BrowserPeekTileRef } from "@/stores/epics/canvas/types";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 720;
const DEFAULT_QUALITY = 70;
const STALE_WITHOUT_FRAME_MS = 8_000;
const VIEWPORT_DEBOUNCE_MS = 200;
const POINTER_CLICK_COUNT_WINDOW_MS = 500;
const POINTER_CLICK_COUNT_MAX = 8;
const WHEEL_LINE_HEIGHT_PX = 16;

type PeekPointerInput = Omit<
  Extract<BrowserScreencastClientFrame, { readonly kind: "pointer" }>,
  "armEpoch" | "seq" | "hasBinaryPayload"
>;

type PeekKeyboardInput = Omit<
  Extract<BrowserScreencastClientFrame, { readonly kind: "keyboard" }>,
  "armEpoch" | "seq" | "hasBinaryPayload"
>;

type PeekInsertTextInput = Omit<
  Extract<BrowserScreencastClientFrame, { readonly kind: "insertText" }>,
  "armEpoch" | "seq" | "hasBinaryPayload"
>;

type PeekNavInput =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "goBack" }
  | { readonly kind: "goForward" }
  | { readonly kind: "reload" };

type PeekInputFrame =
  PeekPointerInput | PeekKeyboardInput | PeekInsertTextInput | PeekNavInput;

interface CapturedPointer {
  readonly element: HTMLElement;
  readonly pointerId: number;
}

interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
  readonly button: number;
  readonly buttons: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

interface PointerClickCount {
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly at: number;
  readonly count: number;
}

interface PointerFrameRequest {
  readonly event: PointerLike;
  readonly type: PeekPointerInput["type"];
  readonly clampToEdge: boolean;
  readonly deltaX: number;
  readonly deltaY: number;
}

interface NormalizedPointerRequest {
  readonly clientX: number;
  readonly clientY: number;
  readonly image: HTMLImageElement | null;
  readonly frameSize: {
    readonly width: number;
    readonly height: number;
  } | null;
  readonly clampToEdge: boolean;
}

interface BrowserPeekStatus {
  readonly label: string;
  readonly overlay: string | null;
  readonly tone: "live" | "muted" | "bad";
  readonly Icon: typeof Radio;
}

type PeekLifecycle =
  | "connecting"
  | "waiting"
  | "live"
  | "idle"
  | "stale"
  | "disconnected"
  | "failed"
  | "complete";

interface BrowserPeekRenderState {
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly image: { readonly src: string; readonly sequence: number } | null;
  readonly lifecycle: PeekLifecycle;
  readonly details: string | null;
  readonly frameSize: {
    readonly width: number;
    readonly height: number;
  } | null;
  readonly navState: ScreencastNavState;
}

type BrowserPeekDialog = Extract<
  BrowserScreencastServerFrame,
  { readonly kind: "dialogOpened" }
> & { readonly armEpoch: number };

export interface BrowserPeekTileProps {
  readonly epicId: string;
  readonly node: BrowserPeekTileRef;
  readonly viewTabId?: string;
  readonly paneId?: string;
}

export function BrowserPeekTile(props: BrowserPeekTileProps) {
  const { epicId, node } = props;
  const tabHostId = useTabHostId();
  const hostEntry = useHostDirectoryEntry(tabHostId);
  const auth = useStreamAuthRevalidator();
  const client = useHostStreamClientFor(hostEntry, auth);
  const visible = useTileBodyVisible();
  const snapshotKey = useMemo<BrowserViewTileKey>(
    () => ({
      viewTabId: props.viewTabId ?? "",
      paneId: props.paneId ?? "",
      tileInstanceId: node.instanceId,
      pageSessionId: node.id,
    }),
    [node.id, node.instanceId, props.paneId, props.viewTabId],
  );
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    snapshotKey.viewTabId,
    snapshotKey.paneId,
    node.instanceId,
  );
  useRegisterVisibleBrowserTile({
    hostId: tabHostId,
    sessionId: node.sessionId,
    tabId: node.tabId,
    visible,
  });
  // BT-204: drop this mirror's frame from the shared snapshot store when the
  // tile goes away so nothing can resurrect stale pixels from it.
  useEffect(
    () => () => {
      clearBrowserViewSnapshot(snapshotKey);
    },
    [snapshotKey],
  );
  const sessionRef = useRef<{
    sendClientFrame: (
      frame: BrowserScreencastClientFrame,
      binaryPayload: Uint8Array | null,
    ) => void;
  } | null>(null);
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
  const activeDialogRef = useRef<BrowserPeekDialog | null>(null);
  const composingRef = useRef(false);
  const frameSizeRef = useRef<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const capturedPointerRef = useRef<CapturedPointer | null>(null);
  const suppressPointerIdRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<PeekPointerInput | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const acceptedPointerDownsRef = useRef(
    new Map<PeekPointerInput["button"], PeekPointerInput>(),
  );
  const pointerClickCountRef = useRef<PointerClickCount | null>(null);
  const handleArmBufferDropped = useCallback(() => {
    pointerClickCountRef.current = null;
    const captured = capturedPointerRef.current;
    if (captured === null) return;
    suppressPointerIdRef.current = captured.pointerId;
  }, []);
  // eslint-disable-next-line react-hooks/refs -- the factory stores this handler; it never invokes it during render.
  const [armBuffer] = useState<ScreencastArmBuffer<PeekPointerInput>>(() =>
    createScreencastArmBuffer(handleArmBufferDropped),
  );
  const deliverArmBufferRef = useRef<() => void>(() => {});
  const flushPendingNavRef = useRef<() => void>(() => {});
  const clearLocalArmRef = useRef<(notifyHost: boolean) => void>(() => {});
  const pendingNavRef = useRef<PeekNavInput[]>([]);
  const forwardedKeyDownsRef = useRef(new Map<string, PeekKeyboardInput>());
  const claimedLocalCodesRef = useRef(new Set<string>());
  const [armedState, setArmedState] = useState<{
    readonly client: IHostStreamClient<HostStreamRpcRegistry>;
    readonly epoch: number;
  } | null>(null);
  const [dialogState, setDialogState] = useState<{
    readonly client: IHostStreamClient<HostStreamRpcRegistry>;
    readonly dialog: BrowserPeekDialog;
  } | null>(null);
  const [composing, setComposing] = useState(false);
  const [streamState, setStreamState] = useState<BrowserPeekRenderState>(
    () => ({
      client,
      image: null,
      lifecycle: "connecting",
      details: null,
      frameSize: null,
      navState: EMPTY_SCREENCAST_NAV_STATE,
    }),
  );
  const stateMatchesClient = streamState.client === client;
  const image = stateMatchesClient ? streamState.image : null;
  const lifecycle = stateMatchesClient ? streamState.lifecycle : "connecting";
  const details = peekDetailsForRender(stateMatchesClient, streamState, client);
  const frameSize = stateMatchesClient ? streamState.frameSize : null;
  const navState = stateMatchesClient
    ? streamState.navState
    : EMPTY_SCREENCAST_NAV_STATE;
  const armedEpoch = armedState?.client === client ? armedState.epoch : null;
  const presentedArmedEpoch = visible ? armedEpoch : null;
  const dialog = dialogForClient(dialogState, client);

  // Only an actually-armed, visible tile participates. An unarmed
  // sibling must never write false and clobber another tile's flag.
  useLayoutEffect(() => {
    if (presentedArmedEpoch === null) return;
    const setArmed = useScreencastArmedStore.getState().setArmed;
    setArmed(true);
    return () => {
      setArmed(false);
    };
  }, [presentedArmedEpoch]);

  const setLifecycle = useCallback(
    (value: SetStateAction<PeekLifecycle>) => {
      setStreamState((current) => {
        const base = resetPeekStateForClient(current, client);
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
        ...resetPeekStateForClient(current, client),
        details: value,
      }));
    },
    [client],
  );
  const setImage = useCallback(
    (value: { readonly src: string; readonly sequence: number }) => {
      setStreamState((current) => ({
        ...resetPeekStateForClient(current, client),
        image: value,
      }));
    },
    [client],
  );
  const setFrameSize = useCallback(
    (
      value: {
        readonly width: number;
        readonly height: number;
      } | null,
    ) => {
      setStreamState((current) => ({
        ...resetPeekStateForClient(current, client),
        frameSize: value,
      }));
    },
    [client],
  );

  useEffect(() => {
    activeDialogRef.current = null;
    composingRef.current = false;
    if (client === null || !visible) {
      sessionRef.current = null;
      clearLocalArmRef.current(false);
      return;
    }

    const session = client.subscribe("browser.screencast", {
      epicId,
      sessionId: node.sessionId,
      tabId: node.tabId,
      maxWidth: DEFAULT_MAX_WIDTH,
      maxHeight: DEFAULT_MAX_HEIGHT,
      quality: DEFAULT_QUALITY,
      format: "jpeg",
      role: "tile",
    });
    sessionRef.current = session;
    session.onStatusChange((status, reason) => {
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
        sendPeekFrame(session, {
          kind: "arm",
          hasBinaryPayload: false,
          armEpoch,
        });
      }
      handleStreamStatus(status, reason, setLifecycle, setDetails);
    });
    session.onServerFrame((envelope, binaryPayload) => {
      const parsed = browserScreencastServerFrameSchema.safeParse(envelope);
      if (!parsed.success) return;
      if (
        parsed.data.kind === "started" ||
        parsed.data.kind === "resized" ||
        parsed.data.kind === "failed" ||
        parsed.data.kind === "complete"
      ) {
        presentedSequenceRef.current = null;
      }
      handleScreencastFrame({
        frame: parsed.data,
        binaryPayload,
        setImage,
        setLifecycle,
        setDetails,
        setFrameSize,
        onFramePainted: (dataUrl) => {
          // BT-204: mirror tiles are DOM-painted and never need hiding, but
          // their latest frame shares the snapshot store with native tiles'
          // cached frames — one pixel source of truth per tile key.
          publishSelfPaintedTileFrame(snapshotKey, dataUrl);
        },
      });
      if (parsed.data.kind === "navState") {
        const nextNavState: ScreencastNavState = {
          url: parsed.data.url,
          canGoBack: parsed.data.canGoBack,
          canGoForward: parsed.data.canGoForward,
          loading: parsed.data.loading,
        };
        setStreamState((current) => ({
          ...resetPeekStateForClient(current, client),
          navState: nextNavState,
        }));
      } else if (parsed.data.kind === "unsupportedInteraction") {
        toastScreencastUnsupportedInteraction(parsed.data.feature);
      }
      const control = applyScreencastControlFrame({
        frame: parsed.data,
        desiredEpoch: desiredArmEpochRef.current,
        activeEpoch: activeArmEpochRef.current,
      });
      if (control === "teardown") {
        clearLocalArmRef.current(false);
      } else if (control === "armed" && parsed.data.kind === "armed") {
        activeArmEpochRef.current = parsed.data.armEpoch;
        setArmedState({ client, epoch: parsed.data.armEpoch });
        deliverArmBufferRef.current();
        flushPendingNavRef.current();
      } else {
        handleDialogServerFrame({
          frame: parsed.data,
          armEpoch: activeArmEpochRef.current,
          current: activeDialogRef.current,
          opened: (dialog) => {
            activeDialogRef.current = dialog;
            setDialogState({ client, dialog });
          },
          settled: () => {
            activeDialogRef.current = null;
            setDialogState(null);
          },
        });
      }
    });

    return () => {
      if (sessionRef.current === session) {
        sessionRef.current = null;
      }
      presentedSequenceRef.current = null;
      clearLocalArmRef.current(false);
      session.close();
    };
  }, [
    client,
    epicId,
    node.sessionId,
    node.tabId,
    setDetails,
    setFrameSize,
    setImage,
    setLifecycle,
    snapshotKey,
    visible,
  ]);

  const sendViewport = useCallback(
    (viewport: {
      readonly width: number;
      readonly height: number;
      readonly dpr: number;
    }) => {
      sendPeekFrame(sessionRef.current, {
        kind: "viewport",
        hasBinaryPayload: false,
        ...viewport,
      });
    },
    [],
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

  const status = useMemo(
    () => browserPeekStatus(lifecycle, visible, details),
    [details, lifecycle, visible],
  );

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
    sendPeekFrame(sessionRef.current, {
      kind: "arm",
      hasBinaryPayload: false,
      armEpoch,
    });
  }, []);

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
      sendPeekFrame(sessionRef.current, {
        kind: "disarm",
        hasBinaryPayload: false,
        armEpoch,
      });
    },
    [resetLocalArmRefs, resetLocalArmState],
  );

  const disarm = useCallback(() => {
    clearLocalArm(true);
  }, [clearLocalArm]);

  useEffect(() => {
    if (visible) return;
    const armEpoch = resetLocalArmRefs();
    if (armEpoch !== null) {
      sendPeekFrame(sessionRef.current, {
        kind: "disarm",
        hasBinaryPayload: false,
        armEpoch,
      });
    }
    // Refs and host disarm must win immediately; React state follows after
    // this visibility effect commits so the hidden render cannot route input.
    queueMicrotask(() => {
      resetLocalArmState();
    });
  }, [resetLocalArmRefs, resetLocalArmState, visible]);

  const sendInput = useCallback((frame: PeekInputFrame) => {
    const armEpoch = activeArmEpochRef.current;
    if (armEpoch === null) return;
    if (frame.kind === "keyboard") {
      if (frame.type === "rawKeyDown") {
        forwardedKeyDownsRef.current.set(frame.code, frame);
      } else if (frame.type === "keyUp") {
        forwardedKeyDownsRef.current.delete(frame.code);
      }
    }
    sendPeekFrame(sessionRef.current, {
      ...frame,
      hasBinaryPayload: false,
      armEpoch,
      seq: inputSequenceRef.current,
    });
    inputSequenceRef.current += 1;
  }, []);

  const releaseForwardedPageKeys = useCallback(() => {
    const held = Array.from(forwardedKeyDownsRef.current.values());
    for (const frame of held) {
      sendInput({
        ...frame,
        type: "keyUp",
        autoRepeat: false,
      });
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
    (frame: PeekNavInput) => {
      if (activeArmEpochRef.current !== null) {
        sendInput(frame);
        return;
      }
      pendingNavRef.current = [...pendingNavRef.current, frame];
      arm();
    },
    [arm, sendInput],
  );

  const chrome = useScreencastTileChrome({
    navState,
    initialUrl: node.initialUrl,
    disabled: client === null,
    onNavigateUrl: (url) => {
      requestNav({ kind: "navigate", url });
    },
    onBack: () => {
      requestNav({ kind: "goBack" });
    },
    onForward: () => {
      requestNav({ kind: "goForward" });
    },
    onReload: () => {
      requestNav({ kind: "reload" });
    },
  });

  const onAddressFocusChange = (focused: boolean): void => {
    if (focused) releaseForwardedPageKeys();
    chrome.onAddressFocusChange(focused);
  };

  useEffect(() => {
    const tile = tileRef.current;
    if (tile === null || presentedArmedEpoch === null) return;
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
  }, [presentedArmedEpoch, releaseForwardedPageKeys, requestNav]);

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
      sendPeekFrame(sessionRef.current, {
        kind: "dialogResponse",
        hasBinaryPayload: false,
        armEpoch,
        generation,
        accept,
        promptText,
      });
      imeInputRef.current?.focus();
    },
    [],
  );

  const buildPointerFrame = useCallback(
    (request: PointerFrameRequest): PeekPointerInput | null => {
      const castSequence = presentedSequenceRef.current;
      const normalized = normalizedPointerPosition({
        clientX: request.event.clientX,
        clientY: request.event.clientY,
        image: imageRef.current,
        frameSize: frameSizeRef.current,
        clampToEdge: request.clampToEdge,
      });
      if (castSequence === null || normalized === null) return null;
      let clickCount = 0;
      if (request.type === "down") {
        const at = performance.now();
        const previous = pointerClickCountRef.current;
        const continuesPrevious =
          previous !== null &&
          previous.button === request.event.button &&
          at - previous.at <= POINTER_CLICK_COUNT_WINDOW_MS &&
          Math.abs(request.event.clientX - previous.clientX) <=
            SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX &&
          Math.abs(request.event.clientY - previous.clientY) <=
            SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX;
        clickCount = continuesPrevious
          ? Math.min(POINTER_CLICK_COUNT_MAX, previous.count + 1)
          : 1;
        pointerClickCountRef.current = {
          button: request.event.button,
          clientX: request.event.clientX,
          clientY: request.event.clientY,
          at,
          count: clickCount,
        };
      } else if (request.type === "up") {
        const button = pointerButton(request.event.button);
        const accepted = acceptedPointerDownsRef.current.get(button);
        const down = pointerClickCountRef.current;
        clickCount =
          accepted?.clickCount ??
          (down?.button === request.event.button ? down.count : 1);
      }
      return {
        kind: "pointer",
        type: request.type,
        castSequence,
        ...normalized,
        button:
          request.type === "wheel"
            ? "none"
            : pointerButton(request.event.button),
        buttons: request.event.buttons,
        modifiers: inputModifiers(request.event),
        clickCount,
        deltaX: request.deltaX,
        deltaY: request.deltaY,
      };
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
    (frame: PeekPointerInput) => {
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
    (frame: PeekPointerInput) => {
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

  const handleOverlayPointerDown = useCallback(
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

  const handleOverlayPointerMove = useCallback(
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
      const clampToEdge = event.buttons !== 0;
      const frame = buildPointerFrame({
        event,
        type: "move",
        clampToEdge,
        deltaX: 0,
        deltaY: 0,
      });
      if (frame === null) return;
      scheduleMove(frame);
    },
    [armBuffer, buildPointerFrame, scheduleMove],
  );

  const handleOverlayPointerUp = useCallback(
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

  const handleOverlayPointerCancel = useCallback(() => {
    if (activeArmEpochRef.current !== null) {
      for (const accepted of acceptedPointerDownsRef.current.values()) {
        sendDiscretePointer({
          ...accepted,
          type: "up",
          buttons: 0,
        });
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

  const handleOverlayContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (activeArmEpochRef.current === null) return;
      event.preventDefault();
    },
    [],
  );

  useEffect(() => {
    const button = overlayButtonRef.current;
    if (button === null || presentedArmedEpoch === null) return;
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
  }, [buildPointerFrame, presentedArmedEpoch, sendDiscretePointer]);

  const handleFocusExit = useCallback(
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

  return (
    <div
      ref={tileRef}
      className="flex h-full w-full flex-col bg-canvas text-foreground"
      data-testid={`browser-peek-tile-${node.instanceId}`}
      onBlurCapture={(event) => handleFocusExit(event.relatedTarget)}
    >
      <ScreencastPeekChromeBar
        controller={chrome.controller}
        pictureInPicture={{
          disabled: client === null,
          convert: () => {
            convertBrowserTabToPip({
              epicId,
              hostId: tabHostId,
              sessionId: node.sessionId,
              tabId: node.tabId,
              origin: "manual",
              onReady: closeCanvasTile,
              onError: (message) => toast.error(message),
            });
          },
        }}
        onAddressFocusChange={onAddressFocusChange}
        loading={navState.loading}
        armed={presentedArmedEpoch !== null}
        status={status}
        onRelease={disarm}
      />
      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 flex-1 cursor-default overflow-hidden bg-background p-0 text-left outline-none",
          presentedArmedEpoch !== null && "ring-2 ring-primary ring-inset",
        )}
      >
        <button
          ref={overlayButtonRef}
          type="button"
          className="absolute inset-0 h-full w-full cursor-default overflow-hidden bg-background p-0 text-left outline-none"
          aria-label="Browser screencast controls"
          onFocus={() => imeInputRef.current?.focus()}
          onPointerDown={handleOverlayPointerDown}
          onPointerMove={handleOverlayPointerMove}
          onPointerUp={handleOverlayPointerUp}
          onPointerCancel={handleOverlayPointerCancel}
          onContextMenu={handleOverlayContextMenu}
        >
          {image === null ? (
            <div className="absolute inset-0 flex items-center justify-center px-4 text-center">
              <div>
                <div className="text-ui-base font-medium">
                  Waiting for frames
                </div>
                <div className="mt-1 max-w-[min(90vw,32rem)] text-ui-sm text-muted-foreground">
                  Click the screencast to control this browser tab.
                </div>
              </div>
            </div>
          ) : (
            <img
              ref={imageRef}
              src={image.src}
              alt="Browser screencast"
              className="h-full w-full object-contain"
              draggable={false}
              onLoad={() => {
                presentedSequenceRef.current = image.sequence;
                lastFrameAtRef.current = Date.now();
                setLifecycle("live");
                setDetails(null);
                sendPeekFrame(sessionRef.current, {
                  kind: "ack",
                  hasBinaryPayload: false,
                  sequence: image.sequence,
                });
              }}
            />
          )}
          {status.overlay === null ? null : (
            <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded border border-border bg-popover/95 px-3 py-2 text-ui-sm text-popover-foreground shadow-sm">
              {status.overlay}
            </div>
          )}
          {frameSize === null ? null : (
            <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-background/80 px-2 py-1 font-mono text-ui-xs text-muted-foreground">
              {frameSize.width} x {frameSize.height}
            </div>
          )}
        </button>
        <input
          ref={imeInputRef}
          aria-label="Browser IME input"
          autoComplete="off"
          className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
          onFocus={arm}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
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
          }}
          onKeyUp={(event: ReactKeyboardEvent<HTMLInputElement>) => {
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
          }}
          onPaste={(event: ReactClipboardEvent<HTMLInputElement>) => {
            if (activeArmEpochRef.current === null) return;
            if (!visible) return;
            const text = event.clipboardData.getData("text/plain");
            event.preventDefault();
            if (text === "") return;
            sendInput({ kind: "insertText", text });
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            setComposing(true);
          }}
          onCompositionEnd={(
            event: ReactCompositionEvent<HTMLInputElement>,
          ) => {
            composingRef.current = false;
            setComposing(false);
            event.currentTarget.value = "";
            if (event.data !== "") {
              sendInput({ kind: "insertText", text: event.data });
            }
          }}
          onInput={(event) => {
            if (!composingRef.current) event.currentTarget.value = "";
          }}
        />
        {composing ? (
          <div
            aria-live="polite"
            className="pointer-events-none absolute right-3 top-3 rounded-sm bg-background/90 px-2 py-1 text-ui-xs text-muted-foreground"
          >
            Composing text…
          </div>
        ) : null}
        {dialog === null ? null : (
          <BrowserDialogOverlay
            key={dialog.generation}
            dialog={dialog}
            onRespond={respondToDialog}
          />
        )}
      </div>
    </div>
  );
}

function ScreencastPeekChromeBar(props: {
  readonly controller: TileController;
  readonly pictureInPicture: BrowserPictureInPictureControl;
  readonly onAddressFocusChange: (focused: boolean) => void;
  readonly loading: boolean;
  readonly armed: boolean;
  readonly status: BrowserPeekStatus;
  readonly onRelease: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-col border-b border-border">
      <div className="flex min-h-0 items-center">
        <div
          className="min-w-0 flex-1 [&>div]:border-b-0"
          onFocusCapture={(event) => {
            if (isBrowserAddressInput(event.target)) {
              props.onAddressFocusChange(true);
            }
          }}
          onBlurCapture={(event) => {
            if (isBrowserAddressInput(event.target)) {
              props.onAddressFocusChange(false);
            }
          }}
        >
          <BrowserTileToolbar
            controller={props.controller}
            pictureInPicture={props.pictureInPicture}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 pr-2">
          {props.loading ? (
            <span role="status" aria-label="Page loading">
              <AgentSpinningDots
                className="text-muted-foreground"
                testId="screencast-page-loading"
                variant={undefined}
              />
            </span>
          ) : null}
          {props.armed ? (
            <div className="flex shrink-0 items-center gap-1">
              <Badge variant="outline">Controlling</Badge>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label="Release control"
                onClick={props.onRelease}
              >
                Release
              </Button>
            </div>
          ) : null}
          <div
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-ui-xs",
              peekStatusToneClass(props.status.tone),
            )}
          >
            <props.status.Icon className="size-3.5" aria-hidden />
            <span>{props.status.label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function BrowserDialogOverlay(props: {
  readonly dialog: BrowserPeekDialog;
  readonly onRespond: (
    generation: number,
    accept: boolean,
    promptText: string | null,
  ) => void;
}) {
  const [promptText, setPromptText] = useState(props.dialog.defaultValue);
  const isAlert = props.dialog.type === "alert";
  const isPrompt = props.dialog.type === "prompt";
  let title = "Confirm";
  if (isAlert) title = "Alert";
  else if (isPrompt) title = "Prompt";
  return (
    <dialog
      open
      aria-label={`${props.dialog.type} dialog`}
      aria-modal="true"
      className="absolute inset-0 z-10 m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-background/60 p-4 text-foreground"
    >
      <div className="w-full max-w-md rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-lg">
        <div className="text-ui-base font-medium">{title}</div>
        <div className="mt-2 whitespace-pre-wrap break-words text-ui-sm">
          {props.dialog.message}
        </div>
        {isPrompt ? (
          <input
            aria-label="Prompt response"
            className="mt-3 w-full rounded border border-input bg-background px-3 py-2 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={promptText}
            onChange={(event) => setPromptText(event.currentTarget.value)}
          />
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          {isAlert ? null : (
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5 text-ui-sm hover:bg-muted"
              onClick={() =>
                props.onRespond(props.dialog.generation, false, null)
              }
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-ui-sm text-primary-foreground hover:bg-primary/90"
            onClick={() =>
              props.onRespond(
                props.dialog.generation,
                true,
                isPrompt ? promptText : null,
              )
            }
          >
            OK
          </button>
        </div>
      </div>
    </dialog>
  );
}

function dialogForClient(
  state: {
    readonly client: IHostStreamClient<HostStreamRpcRegistry>;
    readonly dialog: BrowserPeekDialog;
  } | null,
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
): BrowserPeekDialog | null {
  return state?.client === client ? state.dialog : null;
}

function handleDialogServerFrame(input: {
  readonly frame: BrowserScreencastServerFrame;
  readonly armEpoch: number | null;
  readonly current: BrowserPeekDialog | null;
  readonly opened: (dialog: BrowserPeekDialog) => void;
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

function resetPeekStateForClient(
  current: BrowserPeekRenderState,
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
): BrowserPeekRenderState {
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

function peekDetailsForRender(
  stateMatchesClient: boolean,
  streamState: BrowserPeekRenderState,
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
): string | null {
  if (stateMatchesClient) return streamState.details;
  if (client === null) return "Waiting for the host stream.";
  return null;
}

function handleStreamStatus(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
  setLifecycle: (value: PeekLifecycle) => void,
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
  readonly setImage: (value: {
    readonly src: string;
    readonly sequence: number;
  }) => void;
  readonly setLifecycle: (value: PeekLifecycle) => void;
  readonly setDetails: (value: string | null) => void;
  readonly setFrameSize: (
    value: { readonly width: number; readonly height: number } | null,
  ) => void;
  /** BT-204 seam: mirror tiles publish presented frames to the shared store. */
  readonly onFramePainted: ((dataUrl: string) => void) | null;
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
    const src = `data:image/jpeg;base64,${bytesToBase64(args.binaryPayload)}`;
    args.setImage({
      src,
      sequence: args.frame.sequence,
    });
    args.onFramePainted?.(src);
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
  sendViewport: (viewport: {
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
  }) => void,
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

function isBrowserAddressInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement &&
    target.getAttribute("aria-label") === "Browser address"
  );
}

function isScreencastModChord(event: KeyboardEvent, key: string): boolean {
  return (
    hasPlatformModKey(event) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === key
  );
}

function focusScreencastAddressBar(tile: HTMLElement): void {
  const input = tile.querySelector('input[aria-label="Browser address"]');
  if (!(input instanceof HTMLInputElement)) return;
  input.focus();
  input.select();
}

function sendPeekFrame(
  session: {
    sendClientFrame: (
      frame: BrowserScreencastClientFrame,
      binaryPayload: Uint8Array | null,
    ) => void;
  } | null,
  frame: BrowserScreencastClientFrame,
): void {
  session?.sendClientFrame(frame, null);
}

function peekStatusToneClass(tone: BrowserPeekStatus["tone"]): string {
  if (tone === "live") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "bad") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-border bg-muted text-muted-foreground";
}

function browserPeekStatus(
  lifecycle: PeekLifecycle,
  visible: boolean,
  details: string | null,
): BrowserPeekStatus {
  if (!visible) {
    return {
      label: "Paused off-screen",
      overlay: "Peek is paused while this tile is hidden.",
      tone: "muted",
      Icon: Pause,
    };
  }
  if (lifecycle === "live") {
    return { label: "Live", overlay: null, tone: "live", Icon: Radio };
  }
  if (lifecycle === "idle") {
    return {
      label: "Live idle",
      overlay: details,
      tone: "muted",
      Icon: Radio,
    };
  }
  if (lifecycle === "failed" || lifecycle === "disconnected") {
    return {
      label: "Disconnected",
      overlay: details ?? "Screencast is disconnected.",
      tone: "bad",
      Icon: WifiOff,
    };
  }
  if (lifecycle === "complete") {
    return {
      label: "Ended",
      overlay: details,
      tone: "muted",
      Icon: WifiOff,
    };
  }
  if (lifecycle === "stale") {
    return {
      label: "Stale",
      overlay: details ?? "No new frames have arrived recently.",
      tone: "muted",
      Icon: AlertTriangle,
    };
  }
  return {
    label: "Connecting",
    overlay: details,
    tone: "muted",
    Icon: Radio,
  };
}

function inputModifiers(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

function pointerButton(
  button: number,
): Extract<
  BrowserScreencastClientFrame,
  { readonly kind: "pointer" }
>["button"] {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return "none";
}

function normalizedPointerPosition(
  request: NormalizedPointerRequest,
): { readonly normalizedX: number; readonly normalizedY: number } | null {
  if (request.image === null || request.frameSize === null) return null;
  const rect = request.image.getBoundingClientRect();
  const scale = Math.min(
    rect.width / request.frameSize.width,
    rect.height / request.frameSize.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = request.frameSize.width * scale;
  const height = request.frameSize.height * scale;
  const rawX = request.clientX - rect.left - (rect.width - width) / 2;
  const rawY = request.clientY - rect.top - (rect.height - height) / 2;
  const x = request.clampToEdge ? Math.min(width, Math.max(0, rawX)) : rawX;
  const y = request.clampToEdge ? Math.min(height, Math.max(0, rawY)) : rawY;
  if (!request.clampToEdge && (x < 0 || x > width || y < 0 || y > height)) {
    return null;
  }
  return { normalizedX: x / width, normalizedY: y / height };
}
