import { useLayoutEffect, useMemo, useState, type ReactElement } from "react";
import { AlertTriangle, Monitor, Pause, Radio, WifiOff } from "lucide-react";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import {
  BrowserTileToolbar,
  BrowserTileToolbarCompact,
  type BrowserPictureInPictureControl,
} from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { BrowserStartPage } from "./browser-start-page";
import type { BrowserTileNode } from "./browser-tile-placement";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
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
import {
  browserPeekFrameKey,
  snapshotVideoFrameIntoPeekCache,
  useRetainLastBrowserPeekFrame,
} from "@/lib/browser-view/sessions/peek-frame-cache";
import {
  useScreencastSession,
  type ScreencastDialog,
  type ScreencastLifecycle,
  type ScreencastSession,
} from "@/lib/browser-view/sessions/use-screencast-session";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { cn } from "@/lib/utils";
import { useScreencastArmedStore } from "@/stores/screencast-armed-store";
import { DEFAULT_BROWSER_TILE_URL } from "@/lib/browser-view/browser-tile-defaults";

/**
 * `touch-none`: the controller translates a finger drag into wheel frames
 * itself, and it can only see the moves the browser does not consume for its
 * own panning and pinch-zoom. Touch-action governs touch and pen alone, so a
 * mouse is unaffected.
 */
const SCREENCAST_SURFACE_CLASS =
  "absolute inset-0 h-full w-full cursor-default touch-none overflow-hidden bg-background p-0 text-left outline-none";

interface BrowserPeekStatus {
  readonly label: string;
  readonly overlay: string | null;
  readonly tone: "live" | "muted" | "bad";
  readonly Icon: typeof Radio;
}

export type BrowserPeekNode = Pick<
  BrowserTileNode,
  "instanceId" | "hostId" | "sessionId" | "tabId"
> & {
  readonly initialUrl: string;
};

/**
 * What the host's `complete` frame means for this tile. The host answers it for
 * every Electron-placed tab (`browser-screencast-plane.ts`'s
 * `subscribeScreencast`), because such a tab has no viewer plane there - so the
 * frame alone cannot say whether pixels are about to appear somewhere else on
 * this screen or will never appear here at all.
 *
 * - `ended` - an ordinary cast that stopped.
 * - `native-handoff` - this client is the one placing the native tab, so its
 *   own window is a beat away from showing the page.
 * - `native-elsewhere` - the tab is live in the desktop app on that host and no
 *   surface here can ever show it. Terminal, and said as such rather than
 *   dressed as a handoff that is not coming.
 */
export type BrowserPeekCompleteMeaning =
  | "ended"
  | "native-handoff"
  | "native-elsewhere";

interface BrowserPeekTileProps {
  readonly scope: HostResourceScope;
  readonly node: BrowserPeekNode;
  /** Whether the tile body is actually on screen, not merely mounted. */
  readonly visible: boolean;
  /**
   * No `onRequestClose` here on purpose: the streamed viewer never retires its
   * own tile. The body owns that decision, and the picture-in-picture handoff
   * - the one path that used to close from here - closes from the adapter that
   * starts it.
   */
  readonly onConvertToPip: (() => void) | null;
  readonly completeMeans: BrowserPeekCompleteMeaning;
}

/**
 * The streamed browser viewer, for both pointer grades (decision #13).
 *
 * The transport, arm/epoch protocol, viewport bridge and nav-state derivation
 * are device-agnostic, and so is the input path: the controller translates a
 * finger into scroll and tap frames itself, keyed off `pointerType`. What
 * `useCoarsePointer()` picks is the chrome and the dialog containers a finger
 * can actually reach.
 */
export function BrowserPeekTile(props: BrowserPeekTileProps) {
  const { node, visible } = props;
  const coarsePointer = useCoarsePointer();
  const hostEntry = useHostDirectoryEntry(node.hostId);
  const auth = useStreamAuthRevalidator();
  const client = useHostStreamClientFor(hostEntry, auth);
  // wire: the screencast hook and the start page still take an `epicId`; both
  // become `scope` consumers when ticket 2's shared client lands.
  const epicId = props.scope.kind === "epic" ? props.scope.epicId : "";
  useRegisterVisibleBrowserTile({
    hostId: node.hostId,
    sessionId: node.sessionId,
    tabId: node.tabId,
    visible,
  });
  const frameCacheKey = browserPeekFrameKey(node);
  const session = useScreencastSession({
    client,
    scope: { kind: "epic", epicId },
    hostId: node.hostId,
    sessionId: node.sessionId,
    tabId: node.tabId,
    visible,
    captureDormantSnapshot: (video, wasActivePlane) => {
      snapshotVideoFrameIntoPeekCache(frameCacheKey, video, wasActivePlane);
    },
  });
  // A peeked session can be isolated too; the toolbar has to say so rather
  // than describe saved logins that this session never had.
  const browserSessions = useMaybeBrowserSessionsContext();
  const sessionProfile =
    browserSessions?.items.find((item) => item.sessionId === node.sessionId)
      ?.profile ?? "primary";
  const { image, navState, armedEpoch, dialog, readOnly } = session;
  const { tileRef, viewportRef } = session.refs;
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
    () =>
      browserPeekStatus(
        session.lifecycle,
        visible,
        session.details,
        props.completeMeans,
      ),
    [session.details, session.lifecycle, visible, props.completeMeans],
  );

  const chrome = useScreencastTileChrome({
    profile: sessionProfile,
    navState,
    initialUrl: node.initialUrl,
    // A `viewer` subscription is refused every nav frame too (H07's
    // `viewer-passive` list is the whole client-frame set), so the toolbar
    // reads as the read-only chrome it is instead of silently dropping clicks.
    disabled: readOnly || client === null,
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

  // Focus in the address field must also drop any page keys still forwarded to
  // the screencast, so typing a URL does not reach the remote page.
  const controller: TileController = {
    ...chrome.controller,
    onAddressFocusChange: (focused: boolean) => {
      if (focused) session.releaseForwardedPageKeys();
      chrome.onAddressFocusChange(focused);
    },
  };
  // The start page is a launcher - pure navigation, which a viewer cannot do.
  const showStartPage =
    !readOnly && chrome.controller.url === DEFAULT_BROWSER_TILE_URL;

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
          readOnly={readOnly}
        />
      ) : (
        <ScreencastPeekChromeBar
          controller={controller}
          pictureInPicture={{
            // Both halves of today's gate: a placement with nowhere to put a
            // picture-in-picture window supplies no callback, and a tile with
            // no stream client cannot hand one off either.
            disabled: props.onConvertToPip === null || client === null,
            convert: () => props.onConvertToPip?.(),
          }}
          loading={navState.loading}
          armed={armedEpoch !== null}
          readOnly={readOnly}
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
          // wire: `epicId` becomes `scope={props.scope}` on the rebase.
          <BrowserStartPage
            epicId={epicId}
            hostId={node.hostId}
            browserRunsOnHost
            onNavigate={chrome.navigateToUrl}
          />
        ) : null}
        <ScreencastPeekSurface
          session={session}
          overlay={status.overlay}
          showStartPage={showStartPage}
        />
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

/**
 * The pixels and everything that reaches them. A `viewer` subscription gets
 * the pixels alone (H12): the host refuses its every claim and input frame,
 * so an overlay button and an IME input here would be controls that start a
 * gesture nothing finishes - which is what reads as a broken tab.
 */
function ScreencastPeekSurface(props: {
  readonly session: ScreencastSession;
  readonly overlay: string | null;
  readonly showStartPage: boolean;
}) {
  const session = props.session;
  const { overlayButtonRef, imeInputRef } = session.refs;
  const frameSize = session.frameSize;
  const pixels = (
    <>
      <ScreencastSurface session={session} />
      {props.overlay === null ? null : (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded border border-border bg-popover/95 px-3 py-2 text-ui-sm text-popover-foreground shadow-sm">
          {props.overlay}
        </div>
      )}
      {import.meta.env.DEV && frameSize !== null ? (
        <div className="pointer-events-none absolute left-3 top-3 rounded-sm bg-background/80 px-2 py-1 font-mono text-ui-xs text-muted-foreground">
          {frameSize.width} x {frameSize.height}
        </div>
      ) : null}
    </>
  );

  if (session.readOnly) {
    return (
      // `role="img"`: the `<img alt>` underneath is hidden while the video
      // plane paints, so the surface itself has to carry the label.
      <div
        role="img"
        aria-label="Browser screencast, view only"
        data-testid="browser-screencast-view"
        className={SCREENCAST_SURFACE_CLASS}
      >
        {pixels}
      </div>
    );
  }
  return (
    <>
      <button
        ref={overlayButtonRef}
        type="button"
        hidden={props.showStartPage}
        className={SCREENCAST_SURFACE_CLASS}
        aria-label="Browser screencast controls"
        {...session.overlayHandlers}
      >
        {pixels}
      </button>
      <input
        ref={imeInputRef}
        aria-label="Browser IME input"
        autoComplete="off"
        disabled={props.showStartPage}
        className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
        {...session.imeHandlers}
      />
      {!props.showStartPage && session.composing ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute right-3 top-3 rounded-sm bg-background/90 px-2 py-1 text-ui-xs text-muted-foreground"
        >
          Composing text…
        </div>
      ) : null}
    </>
  );
}

function ScreencastPeekChromeBar(props: {
  readonly controller: TileController;
  readonly pictureInPicture: BrowserPictureInPictureControl;
  readonly loading: boolean;
  readonly armed: boolean;
  readonly readOnly: boolean;
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
          {props.readOnly ? <Badge variant="outline">View only</Badge> : null}
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
  completeMeans: BrowserPeekCompleteMeaning,
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
    // An Electron wake's `complete` frame means "attached, going native", not
    // a dead cast (`browser-screencast-plane.ts`'s `subscribeScreencast`) -
    // WifiOff/"Ended" would read as a failure at the exact moment the tab is
    // succeeding.
    if (completeMeans === "native-handoff") {
      return {
        label: "Going native",
        overlay: "Handing off to the native tab.",
        tone: "muted",
        Icon: Radio,
      };
    }
    // The same frame, read from a client with no native window of its own to
    // hand off to. Nothing is in flight and nothing will arrive, so it says so
    // rather than spinning on a handoff that is happening on another machine.
    if (completeMeans === "native-elsewhere") {
      return {
        label: "Open natively",
        overlay:
          "This tab is open in the desktop app on that host, so it can't be streamed here.",
        tone: "muted",
        Icon: Monitor,
      };
    }
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
