import { useEffect, useLayoutEffect, useMemo, useState } from "react";
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
import { AgentCursorOverlay } from "@/components/epic-canvas/renderers/agent-cursor-overlay";
import { ScreencastSurface } from "@/components/epic-canvas/renderers/screencast-surface";
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
  type ScreencastImage,
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

/**
 * Best-effort last-known frame per tab, outside React state on purpose.
 *
 * The dormant placeholder (`browser-session-tile.tsx`, decision #9) greys
 * this out when a tab's host goes unreachable - and by the time that happens
 * this tile has usually already unmounted, since the parent stops rendering
 * it in favour of the placeholder. A frame kept only in this component's own
 * state would already be gone by then, so it is retained here, keyed the
 * same way the screencast session itself is (host+session+tab+tile
 * instance), and read directly rather than through a subscription - the
 * placeholder only ever needs the value at the moment it first renders.
 *
 * NOT freed on this tile's own unmount: the same key remounts on every
 * `runtime.revision` bump (`<BrowserPeekTile key={revision}>` in
 * browser-session-tile.tsx) and again whenever the placeholder replaces this
 * tile and later hands back to it, and an unmount-cleanup delete raced the
 * placeholder's own read of this cache in that same commit. Freed instead by
 * `clearLastBrowserPeekFrame`, called from the one place that knows the tab
 * is genuinely gone rather than merely swapping surfaces.
 */
const lastFrameCache = new Map<string, ScreencastImage>();

/**
 * The one key builder for a browser peek tile's frame cache / dormant
 * placeholder lookup - host+session+tab+tile-instance. Shared by both
 * viewers (`BrowserPeekTile`, `BrowserPeekTileMobile`) and by
 * `browser-session-tile.tsx`'s own placeholder/self-close reads, so the
 * shape cannot drift between the write side and any of its readers.
 */
// eslint-disable-next-line react-refresh/only-export-components -- shares this file's module-scoped lastFrameCache; not a component.
export function browserPeekFrameKey(node: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly instanceId: string;
}): string {
  return compositeKey(node.hostId, node.sessionId, node.tabId, node.instanceId);
}

// eslint-disable-next-line react-refresh/only-export-components -- shares this file's module-scoped lastFrameCache; not a component.
export function getLastBrowserPeekFrame(key: string): ScreencastImage | null {
  return lastFrameCache.get(key) ?? null;
}

// eslint-disable-next-line react-refresh/only-export-components -- shares this file's module-scoped lastFrameCache; not a component.
export function clearLastBrowserPeekFrame(key: string): void {
  lastFrameCache.delete(key);
}

/**
 * Exported for {@link BrowserPeekTileMobile} (`browser-peek-tile-mobile.tsx`),
 * which retains into this same module-scoped cache under the identical key so
 * the dormant placeholder in `browser-session-tile.tsx` sees a last frame
 * regardless of which viewer (desktop or touch) last streamed it.
 */
// eslint-disable-next-line react-refresh/only-export-components -- shares this file's module-scoped lastFrameCache; not a component.
export function useRetainLastBrowserPeekFrame(
  key: string,
  image: ScreencastImage | null,
): void {
  useEffect(() => {
    if (image !== null) lastFrameCache.set(key, image);
  }, [key, image]);
}

const VIDEO_SNAPSHOT_JPEG_QUALITY = 0.7;

/**
 * Draws a `<video>` element's currently decoded frame into the SAME dormant
 * frame cache the JPEG pump writes (`lastFrameCache`, `useRetainLastBrowserPeekFrame`
 * above), under the SAME key - so the dormant placeholder in
 * `browser-session-tile.tsx` still has something to show when a tab's last
 * live pixels arrived over WebRTC rather than JPEG.
 *
 * Called from the video plane's teardown (`use-screencast-session.ts`'s
 * `captureDormantSnapshot` option), while the element still has its last
 * frame and before `srcObject` is cleared.
 *
 * Both guards live here, not at the call site, so a test can pin them
 * directly against this pure function:
 * - `wasActivePlane` - only write when the video plane was actually the one
 *   painting (not merely attached-but-negotiating); otherwise this would
 *   overwrite a fresher JPEG frame with stale/blank video pixels on every
 *   ordinary fallback-to-JPEG teardown.
 * - `videoWidth`/`videoHeight` - a video element with no decoded frame yet
 *   reports 0x0; drawing that would cache a blank image.
 *
 * Same-origin media (the host's own peer connection) never taints the
 * canvas, so `toDataURL` needs no `crossOrigin` handling here the way a
 * cross-origin `<video>` would.
 */
// eslint-disable-next-line react-refresh/only-export-components -- shares this file's module-scoped lastFrameCache; not a component.
export function snapshotVideoFrameIntoPeekCache(
  key: string,
  video: HTMLVideoElement,
  wasActivePlane: boolean,
): void {
  if (!wasActivePlane) return;
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (context === null) return;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  lastFrameCache.set(key, {
    src: canvas.toDataURL("image/jpeg", VIDEO_SNAPSHOT_JPEG_QUALITY),
    sequence: -1, // never read back; the dormant placeholder only reads `.src`.
  });
}

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
          className="absolute inset-0 h-full w-full cursor-default overflow-hidden bg-background p-0 text-left outline-none"
          aria-label="Browser screencast controls"
          {...session.overlayHandlers}
        >
          <ScreencastSurface
            session={session}
            emptyHint="Click the screencast to control this browser tab."
          />
          <AgentCursorOverlay
            cursor={session.agentCursor}
            frameSize={frameSize}
          />
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
