import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX } from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import {
  browserPeekFrameKey,
  snapshotVideoFrameIntoPeekCache,
  useRetainLastBrowserPeekFrame,
  type BrowserPeekNode,
} from "@/components/epic-canvas/renderers/browser-peek-tile";
import { AgentCursorOverlay } from "@/components/epic-canvas/renderers/agent-cursor-overlay";
import { ScreencastSurface } from "@/components/epic-canvas/renderers/screencast-surface";
import { useScreencastTileChrome } from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useRegisterVisibleBrowserTile } from "@/lib/browser-view/tiles/visible-tile-registry";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";
import {
  useScreencastSession,
  type ScreencastDialog,
} from "@/lib/browser-view/sessions/use-screencast-session";
import {
  touchMoveToWheelDelta,
  type TouchScreenPoint,
} from "@/lib/browser-view/sessions/screencast-touch-input";
import type { ScreencastOverlayHandlers } from "@/lib/browser-view/sessions/screencast-controller";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { cn } from "@/lib/utils";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";

interface BrowserPeekTileMobileProps {
  readonly epicId: string;
  readonly node: BrowserPeekNode;
  readonly viewTabId: string;
  readonly paneId: string;
}

/**
 * Touch-adapted counterpart to `BrowserPeekTile` (decision #13, ticket 12).
 * Reuses `useScreencastSession` and `useScreencastTileChrome` unchanged - the
 * transport, arm/epoch protocol, viewport-bridge (device size + DPR) and nav
 * state derivation are device-agnostic. The only fork is the input surface:
 * a tap still resolves to the same pointer down/up frames the mouse path
 * sends, but a drag maps to wheel deltas instead of a button-held pointer
 * move, so the remote page scrolls the way a touch screen scrolls rather
 * than dragging a selection. See {@link useTouchScreencastOverlayHandlers}.
 *
 * Rendered from `browser-session-tile.tsx` in place of `BrowserPeekTile`
 * when `useCoarsePointer()` is true, so it reaches the same call site every
 * browser tile - desktop and mobile - resolves through today.
 */
export function BrowserPeekTileMobile(props: BrowserPeekTileMobileProps) {
  const { epicId, node } = props;
  const hostEntry = useHostDirectoryEntry(node.hostId);
  const auth = useStreamAuthRevalidator();
  const client = useHostStreamClientFor(hostEntry, auth);
  const visible = useTileBodyVisible();
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

  return (
    <div
      ref={tileRef}
      className="flex h-full w-full flex-col bg-canvas text-foreground"
      data-testid={`browser-peek-tile-mobile-${node.instanceId}`}
      onBlurCapture={(event) => {
        // The dialog sheet portals its content outside this subtree (unlike
        // the desktop tile's inline `<dialog>`), so Radix's own focus trap
        // moving focus into it would otherwise read as "focus left the
        // tile" here and disarm - wiping the dialog `onFocusExit` was
        // supposed to leave alone. Skip while it is open; a real
        // focus-leaves-the-tile disarm resumes once it closes.
        if (dialog !== null) return;
        session.onFocusExit(event.relatedTarget);
      }}
    >
      <MobileScreencastNavBar
        url={chrome.controller.url}
        canGoBack={chrome.controller.canGoBack}
        canGoForward={chrome.controller.canGoForward}
        loading={navState.loading}
        disabled={chrome.controller.disabled}
        onBack={chrome.controller.onBack}
        onForward={chrome.controller.onForward}
        onReload={chrome.controller.onReload}
      />
      <div
        ref={viewportRef}
        className={cn(
          "relative min-h-0 flex-1 cursor-default overflow-hidden bg-background p-0 text-left outline-none",
          armedEpoch !== null && "ring-2 ring-primary ring-inset",
        )}
      >
        <button
          ref={overlayButtonRef}
          type="button"
          className="absolute inset-0 h-full w-full cursor-default touch-none overflow-hidden bg-background p-0 text-left outline-none"
          aria-label="Browser screencast controls"
          {...touchOverlayHandlers}
        >
          <ScreencastSurface
            session={session}
            emptyHint="Tap the screencast to control this browser tab."
          />
          <AgentCursorOverlay
            cursor={session.agentCursor}
            frameSize={frameSize}
          />
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
          {...session.imeHandlers}
        />
      </div>
      {dialog === null ? null : (
        <MobileBrowserDialogSheet
          dialog={dialog}
          onRespond={session.respondToDialog}
        />
      )}
    </div>
  );
}

interface BufferedTouchGesture {
  readonly pointerId: number;
  readonly downEvent: ReactPointerEvent<HTMLButtonElement>;
  readonly origin: TouchScreenPoint;
  last: TouchScreenPoint;
  exceededSlop: boolean;
}

/**
 * Reuses `session.overlayHandlers` verbatim for every mouse/pen pointer and
 * for the touch handshake that establishes the arm (the arm buffer's own
 * click-slop drop already disambiguates a tap from the first drag there -
 * see `screencast-arm-buffer.ts`).
 *
 * Once the tile is already armed, a touch gesture is buffered locally
 * instead of being forwarded immediately: forwarding `down` at touch-start
 * unconditionally would bracket every scroll with a down/up pair, and
 * Chrome synthesizes a `click` from that pair - scrolling past a link would
 * navigate. So the down is held back and resolved only at `pointerup`,
 * mirroring the same click-slop rule the arm buffer already uses for the
 * pre-arm gesture: never exceeded the slop -> forward `down` then `up` (a
 * tap); exceeded it -> drop both and let the wheel deltas already sent
 * during the move stand as the whole gesture (a scroll, no click).
 *
 * Move deltas past the slop become synthetic `wheel` events dispatched at
 * the overlay button - which `useScreencastSession` already listens for and
 * routes through `controller.handleWheel` unchanged, so no part of
 * `screencast-controller.ts` needed to change for this.
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
      onFocus: overlayHandlers.onFocus,
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === "touch" && armed) {
          const point: TouchScreenPoint = {
            clientX: event.clientX,
            clientY: event.clientY,
          };
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
            const delta = touchMoveToWheelDelta(gesture.last, event);
            if (delta.deltaX !== 0 || delta.deltaY !== 0) {
              dispatchSyntheticWheel(overlayButtonRef.current, {
                clientX: event.clientX,
                clientY: event.clientY,
                deltaX: delta.deltaX,
                deltaY: delta.deltaY,
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
      onContextMenu: overlayHandlers.onContextMenu,
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

function MobileScreencastNavBar(props: {
  readonly url: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onReload: () => void;
}) {
  return (
    <div
      className="flex min-h-11 w-full shrink-0 items-center gap-1 border-b border-border px-2"
      data-testid="browser-peek-mobile-nav-bar"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Back"
        disabled={props.disabled || !props.canGoBack}
        onClick={props.onBack}
      >
        <ArrowLeft className="size-4" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Forward"
        disabled={props.disabled || !props.canGoForward}
        onClick={props.onForward}
      >
        <ArrowRight className="size-4" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Reload"
        disabled={props.disabled}
        onClick={props.onReload}
      >
        <RotateCw className="size-4" aria-hidden />
      </Button>
      <div className="min-w-0 flex-1 truncate px-1 text-ui-sm text-muted-foreground">
        {props.url === "" ? "New tab" : props.url}
      </div>
      {props.loading ? (
        <span role="status" aria-label="Page loading" className="shrink-0">
          <AgentSpinningDots
            className="text-muted-foreground"
            testId="browser-peek-mobile-page-loading"
            variant={undefined}
          />
        </span>
      ) : null}
    </div>
  );
}

function MobileBrowserDialogSheet(props: {
  readonly dialog: ScreencastDialog;
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
    <Sheet
      open
      onOpenChange={(open) => {
        if (open) return;
        // A backdrop tap / swipe-to-close has no button to read intent from.
        // An alert has only one action (OK), so treat the dismiss as that;
        // confirm/prompt read it as Cancel, same as pressing Escape does for
        // `window.confirm()`/`window.prompt()` on a real page.
        props.onRespond(props.dialog.generation, isAlert, null);
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
        {isPrompt ? (
          <input
            aria-label="Prompt response"
            className="mx-4 w-auto rounded border border-input bg-background px-3 py-2 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={promptText}
            onChange={(event) => setPromptText(event.currentTarget.value)}
          />
        ) : null}
        <SheetFooter className="flex-row justify-end gap-2">
          {isAlert ? null : (
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                props.onRespond(props.dialog.generation, false, null)
              }
            >
              Cancel
            </Button>
          )}
          <Button
            type="button"
            onClick={() =>
              props.onRespond(
                props.dialog.generation,
                true,
                isPrompt ? promptText : null,
              )
            }
          >
            OK
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
