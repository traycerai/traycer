import { useLayoutEffect, useMemo, useState } from "react";
import { AlertTriangle, Pause, Radio, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import {
  BrowserTileToolbar,
  type BrowserPictureInPictureControl,
} from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { BrowserStartPage } from "@/components/epic-canvas/renderers/browser-start-page";
import { useCloseCanvasTileWithNestedFocus } from "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus";
import type { TileController } from "@/components/epic-canvas/renderers/tile-controller";
import { useScreencastTileChrome } from "@/components/epic-canvas/renderers/use-screencast-tile-chrome";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { useRegisterVisibleBrowserTile } from "@/lib/browser-view/tiles/visible-tile-registry";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";
import { convertBrowserTabToPip } from "@/lib/browser-view/pip/pip-store";
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

export function BrowserPeekTile(props: BrowserPeekTileProps) {
  const { epicId, node } = props;
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
  const session = useScreencastSession({
    client,
    epicId,
    sessionId: node.sessionId,
    tabId: node.tabId,
    visible,
  });
  const { image, frameSize, navState, armedEpoch, dialog } = session;
  const { tileRef, viewportRef, overlayButtonRef, imageRef, imeInputRef } =
    session.refs;
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
      onBlurCapture={(event) => session.onFocusExit(event.relatedTarget)}
    >
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
          // `touch-none`: the controller translates a finger drag into wheel
          // frames itself, and it can only see the moves the browser does not
          // consume for its own panning and pinch-zoom. Touch-action governs
          // touch and pen alone, so a mouse is unaffected.
          className="absolute inset-0 h-full w-full cursor-default touch-none overflow-hidden bg-background p-0 text-left outline-none"
          aria-label="Browser screencast controls"
          {...session.overlayHandlers}
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
              onLoad={() => session.notePainted(image.sequence)}
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
            onRespond={session.respondToDialog}
          />
        )}
      </div>
    </div>
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

function BrowserDialogOverlay(props: {
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
              className="rounded border border-border px-3 py-1.5 text-ui-sm hover:bg-foreground/8"
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
