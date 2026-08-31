import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { AlertTriangle, Pause, Radio, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import {
  BrowserTileToolbar,
  BrowserTileToolbarCompact,
  type BrowserPictureInPictureControl,
} from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { BrowserStartPage } from "@/components/epic-canvas/renderers/browser-start-page";
import { SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX } from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import { useCloseCanvasTileWithNestedFocus } from "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus";
import type { TileController } from "@/components/epic-canvas/renderers/tile-controller";
import { ScreencastSurface } from "@/components/epic-canvas/renderers/screencast-surface";
import { useScreencastTileChrome } from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useRegisterVisibleBrowserTile } from "@/lib/browser-view/tiles/visible-tile-registry";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";
import { convertBrowserTabToPip } from "@/lib/browser-view/pip/pip-store";
import {
  browserPeekFrameKey,
  snapshotVideoFrameIntoPeekCache,
  useRetainLastBrowserPeekFrame,
} from "@/lib/browser-view/sessions/peek-frame-cache";
import type { ScreencastOverlayHandlers } from "@/lib/browser-view/sessions/screencast-controller";
import {
  useScreencastSession,
  type ScreencastDialog,
  type ScreencastLifecycle,
} from "@/lib/browser-view/sessions/use-screencast-session";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { cn } from "@/lib/utils";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";
import type { BrowserSessionTileRef } from "@/stores/epics/canvas/types";
import { DEFAULT_BROWSER_TILE_URL } from "@/stores/epics/canvas/tile-schema/browser-tile";

interface BrowserPeekStatus {
  readonly label: string;
  readonly overlay: string | null;
  readonly tone: "live" | "muted" | "bad";
  readonly Icon: typeof Radio;
}

export type BrowserPeekNode = Pick<
  BrowserSessionTileRef,
  "id" | "instanceId" | "hostId" | "sessionId" | "tabId"
> & {
  readonly initialUrl: string;
};

interface BrowserPeekTileProps {
  readonly epicId: string;
  readonly node: BrowserPeekNode;
  readonly viewTabId: string;
  readonly paneId: string;
}

/**
 * The streamed browser viewer, for both pointer grades (decision #13).
 *
 * The transport, arm/epoch protocol, viewport bridge and nav-state derivation
 * are device-agnostic, so `useCoarsePointer()` only picks between two things:
 * the input handler bag (a touch drag scrolls the remote page instead of
 * dragging a selection - see {@link useTouchScreencastOverlayHandlers}) and the
 * chrome/dialog containers a finger can actually reach.
 */
export function BrowserPeekTile(props: BrowserPeekTileProps) {
  const { epicId, node } = props;
  const coarsePointer = useCoarsePointer();
  const hostEntry = useHostDirectoryEntry(node.hostId);
  const auth = useStreamAuthRevalidator();
  const client = useHostStreamClientFor(hostEntry, auth);
  const visible = useTileBodyVisible();
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.paneId,
    node.instanceId,
  );
  useRegisterVisibleBrowserTile({
    hostId: node.hostId,
    sessionId: node.sessionId,
    tabId: node.tabId,
    visible,
  });
  const frameCacheKey = browserPeekFrameKey(node);
  const session = useScreencastSession({
    client,
    epicId,
    hostId: node.hostId,
    sessionId: node.sessionId,
    tabId: node.tabId,
    visible,
    captureDormantSnapshot: (video, wasActivePlane) => {
      snapshotVideoFrameIntoPeekCache(frameCacheKey, video, wasActivePlane);
    },
  });
  const { image, frameSize, navState, armedEpoch, dialog } = session;
  const { tileRef, viewportRef, overlayButtonRef, imeInputRef } = session.refs;
  useRetainLastBrowserPeekFrame(frameCacheKey, image);
  const inputOwnerId =
    armedEpoch === null
      ? null
      : compositeKey(node.hostId, node.sessionId, node.tabId, node.instanceId);

  useLayoutEffect(() => {
    if (inputOwnerId === null) return;
    const store = useScreencastArmedStore.getState();
    store.claim(inputOwnerId);
    return () => {
      useScreencastArmedStore.getState().release(inputOwnerId);
    };
  }, [inputOwnerId]);

  const status = useMemo(
    () => browserPeekStatus(session.lifecycle, visible, session.details),
    [session.details, session.lifecycle, visible],
  );

  const chrome = useScreencastTileChrome({
    navState,
    initialUrl: node.initialUrl,
    disabled: client === null,
    onNavigateUrl: (url) => {
      session.requestNav({ kind: "navigate", url });
    },
    onBack: () => {
      session.requestNav({ kind: "goBack" });
    },
    onForward: () => {
      session.requestNav({ kind: "goForward" });
    },
    onReload: () => {
      session.requestNav({ kind: "reload" });
    },
  });

  const touchOverlayHandlers = useTouchScreencastOverlayHandlers({
    overlayHandlers: session.overlayHandlers,
    overlayButtonRef,
    armed: armedEpoch !== null,
  });

  // Focus in the address field must also drop any page keys still forwarded to
  // the screencast, so typing a URL does not reach the remote page.
  const controller: TileController = {
    ...chrome.controller,
    onAddressFocusChange: (focused: boolean) => {
      if (focused) session.releaseForwardedPageKeys();
      chrome.onAddressFocusChange(focused);
    },
  };
  const showStartPage = chrome.controller.url === DEFAULT_BROWSER_TILE_URL;

  return (
    <div
      ref={tileRef}
      className="flex h-full w-full flex-col bg-canvas text-foreground"
      data-testid={`browser-peek-tile-${node.instanceId}`}
    >
      {coarsePointer ? (
        <BrowserTileToolbarCompact
          controller={controller}
          loading={navState.loading}
        />
      ) : (
        <ScreencastPeekChromeBar
          controller={controller}
          pictureInPicture={{
            disabled: client === null,
            convert: () => {
              convertBrowserTabToPip({
                epicId,
                hostId: node.hostId,
                sessionId: node.sessionId,
                tabId: node.tabId,
                origin: "manual",
                onReady: closeCanvasTile,
                onError: (message) => toast.error(message),
              });
            },
          }}
          loading={navState.loading}
          armed={armedEpoch !== null}
          status={status}
          onRelease={session.disarm}
        />
      )}
      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 flex-1 cursor-default overflow-hidden bg-background p-0 text-left outline-none",
          armedEpoch !== null && "ring-2 ring-primary ring-inset",
        )}
      >
        {showStartPage ? (
          <BrowserStartPage
            epicId={epicId}
            hostId={node.hostId}
            browserRunsOnHost
            onNavigate={chrome.navigateToUrl}
          />
        ) : null}
        <button
          ref={overlayButtonRef}
          type="button"
          hidden={showStartPage}
          className={cn(
            "absolute inset-0 h-full w-full cursor-default overflow-hidden bg-background p-0 text-left outline-none",
            coarsePointer && "touch-none",
          )}
          aria-label="Browser screencast controls"
          {...(coarsePointer ? touchOverlayHandlers : session.overlayHandlers)}
        >
          <ScreencastSurface session={session} />
          {status.overlay === null ? null : (
            <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded border border-border bg-popover/95 px-3 py-2 text-ui-sm text-popover-foreground shadow-sm">
              {status.overlay}
            </div>
          )}
          {import.meta.env.DEV && frameSize !== null ? (
            <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-background/80 px-2 py-1 font-mono text-ui-xs text-muted-foreground">
              {frameSize.width} x {frameSize.height}
            </div>
          ) : null}
        </button>
        <input
          ref={imeInputRef}
          aria-label="Browser IME input"
          autoComplete="off"
          disabled={showStartPage}
          className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
          {...session.imeHandlers}
        />
        {!showStartPage && session.composing ? (
          <div
            aria-live="polite"
            className="pointer-events-none absolute right-3 top-3 rounded-sm bg-background/90 px-2 py-1 text-ui-xs text-muted-foreground"
          >
            Composing text…
          </div>
        ) : null}
        {showStartPage || dialog === null ? null : (
          <BrowserDialogOverlay
            key={dialog.generation}
            dialog={dialog}
            sheet={coarsePointer}
            onRespond={session.respondToDialog}
          />
        )}
      </div>
    </div>
  );
}

interface BufferedTouchGesture {
  readonly pointerId: number;
  readonly downEvent: ReactPointerEvent<HTMLButtonElement>;
  readonly origin: { readonly clientX: number; readonly clientY: number };
  last: { readonly clientX: number; readonly clientY: number };
  exceededSlop: boolean;
}

/**
 * Reuses `session.overlayHandlers` verbatim for every mouse/pen pointer and
 * for the touch handshake that establishes the arm (the arm buffer's own
 * click-slop drop already disambiguates a tap from the first drag there -
 * see `screencast-arm-buffer.ts`).
 *
 * Once the tile is already armed, a touch gesture is buffered locally instead
 * of being forwarded immediately: forwarding `down` at touch-start would
 * bracket every scroll with a down/up pair, and Chrome synthesizes a `click`
 * from that pair - scrolling past a link would navigate. So the down is held
 * back and resolved only at `pointerup`, mirroring the arm buffer's click-slop
 * rule: never exceeded the slop -> forward `down` then `up` (a tap); exceeded
 * it -> drop both and let the wheel deltas already sent during the move stand
 * as the whole gesture (a scroll, no click).
 *
 * Move deltas past the slop become synthetic `wheel` events dispatched at the
 * overlay button - which the session already listens for and routes through
 * `controller.handleWheel` unchanged. They are inverted like native touch
 * scrolling: dragging a finger UP moves the content up under it, which reads
 * as scrolling DOWN.
 */
function useTouchScreencastOverlayHandlers(args: {
  readonly overlayHandlers: ScreencastOverlayHandlers;
  readonly overlayButtonRef: RefObject<HTMLButtonElement | null>;
  readonly armed: boolean;
}): ScreencastOverlayHandlers {
  const { overlayHandlers, overlayButtonRef, armed } = args;
  const buffered = useRef<BufferedTouchGesture | null>(null);

  // A disarm mid-gesture (e.g. `Release`) must drop whatever is buffered -
  // otherwise the next pointermove for that pointerId would still read as a
  // live drag against a gesture the arm epoch underneath it already ended.
  useEffect(() => {
    if (!armed) buffered.current = null;
  }, [armed]);

  return useMemo<ScreencastOverlayHandlers>(
    () => ({
      ...overlayHandlers,
      // Touch has no hover: `pointerenter` fires as part of the tap itself, so
      // pre-arming here would only put a speculative claim on the wire a
      // millisecond before the tap's own arm supersedes it.
      onPointerEnter: () => {},
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === "touch" && armed) {
          const point = { clientX: event.clientX, clientY: event.clientY };
          buffered.current = {
            pointerId: event.pointerId,
            downEvent: event,
            origin: point,
            last: point,
            exceededSlop: false,
          };
          return;
        }
        overlayHandlers.onPointerDown(event);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
        const gesture = buffered.current;
        if (
          event.pointerType === "touch" &&
          gesture !== null &&
          gesture.pointerId === event.pointerId
        ) {
          if (!gesture.exceededSlop) {
            const dx = event.clientX - gesture.origin.clientX;
            const dy = event.clientY - gesture.origin.clientY;
            gesture.exceededSlop =
              Math.abs(dx) > SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX ||
              Math.abs(dy) > SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX;
          }
          if (gesture.exceededSlop) {
            const deltaX = gesture.last.clientX - event.clientX;
            const deltaY = gesture.last.clientY - event.clientY;
            if (deltaX !== 0 || deltaY !== 0) {
              dispatchSyntheticWheel(overlayButtonRef.current, {
                clientX: event.clientX,
                clientY: event.clientY,
                deltaX,
                deltaY,
              });
            }
          }
          gesture.last = { clientX: event.clientX, clientY: event.clientY };
          return;
        }
        overlayHandlers.onPointerMove(event);
      },
      onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
        const gesture = buffered.current;
        if (
          event.pointerType === "touch" &&
          gesture !== null &&
          gesture.pointerId === event.pointerId
        ) {
          buffered.current = null;
          if (!gesture.exceededSlop) {
            overlayHandlers.onPointerDown(gesture.downEvent);
            overlayHandlers.onPointerUp(event);
          }
          return;
        }
        overlayHandlers.onPointerUp(event);
      },
      onPointerCancel: () => {
        buffered.current = null;
        overlayHandlers.onPointerCancel();
      },
    }),
    [armed, overlayButtonRef, overlayHandlers],
  );
}

function dispatchSyntheticWheel(
  button: HTMLButtonElement | null,
  input: {
    readonly clientX: number;
    readonly clientY: number;
    readonly deltaX: number;
    readonly deltaY: number;
  },
): void {
  if (button === null) return;
  button.dispatchEvent(
    new WheelEvent("wheel", {
      deltaX: input.deltaX,
      deltaY: input.deltaY,
      deltaMode: 0,
      clientX: input.clientX,
      clientY: input.clientY,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function ScreencastPeekChromeBar(props: {
  readonly controller: TileController;
  readonly pictureInPicture: BrowserPictureInPictureControl;
  readonly loading: boolean;
  readonly armed: boolean;
  readonly status: BrowserPeekStatus;
  readonly onRelease: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-col border-b border-border">
      <div className="flex min-h-0 items-center">
        <div className="min-w-0 flex-1 [&>div]:border-b-0">
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

/**
 * One dialog body, two containers: a bottom sheet where a finger has to reach
 * the buttons, the tile-local `<dialog>` otherwise. A backdrop dismiss has no
 * button to read intent from - an alert has only one action (OK), so the
 * dismiss is that; confirm/prompt read it as Cancel, exactly as Escape does
 * for `window.confirm()`/`window.prompt()` on a real page.
 */
function BrowserDialogOverlay(props: {
  readonly dialog: ScreencastDialog;
  readonly sheet: boolean;
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
  const respond = (accept: boolean): void => {
    props.onRespond(
      props.dialog.generation,
      accept,
      accept && isPrompt ? promptText : null,
    );
  };
  const promptInput = (className: string): ReactElement | null =>
    isPrompt ? (
      <input
        aria-label="Prompt response"
        className={cn(
          "rounded border border-input bg-background px-3 py-2 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        value={promptText}
        onChange={(event) => setPromptText(event.currentTarget.value)}
      />
    ) : null;
  const actions = (
    <>
      {isAlert ? null : (
        <Button type="button" variant="ghost" onClick={() => respond(false)}>
          Cancel
        </Button>
      )}
      <Button type="button" onClick={() => respond(true)}>
        OK
      </Button>
    </>
  );

  if (props.sheet) {
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (open) return;
          respond(isAlert);
        }}
      >
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="pb-safe-bottom"
        >
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription className="whitespace-pre-wrap break-words text-foreground">
              {props.dialog.message}
            </SheetDescription>
          </SheetHeader>
          {promptInput("mx-4 w-auto")}
          <SheetFooter className="flex-row justify-end gap-2">
            {actions}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
  }
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
        {promptInput("mt-3 w-full")}
        <div className="mt-4 flex justify-end gap-2">{actions}</div>
      </div>
    </dialog>
  );
}

function peekStatusToneClass(tone: BrowserPeekStatus["tone"]): string {
  if (tone === "live") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "bad") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  return "border-border bg-foreground/8 text-muted-foreground";
}

function browserPeekStatus(
  lifecycle: ScreencastLifecycle,
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
