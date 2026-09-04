import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  BrowserSessionProfileKind,
  BrowserTabDriver,
} from "@traycer/protocol/host/browser/contracts";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { usePublishBrowserGuestTile } from "@/components/epic-canvas/browser-guest/use-publish-browser-guest-tile";
import { useRegisterVisibleBrowserTile } from "@/lib/browser-view/tiles/visible-tile-registry";
import { BrowserTileFindAdapterBridge } from "@/components/epic-canvas/renderers/browser-tile-find-adapter";
import {
  BrowserTileCertificateInterstitial,
  BrowserTileDownloadStrip,
} from "@/components/epic-canvas/renderers/browser-tile-status-panels";
import { BrowserTileToolbar } from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { BrowserStartPage } from "./browser-start-page";
import {
  browserTileBindingId,
  browserTileEpicId,
  browserTileHostOwnsClose,
  browserTileKey,
  browserTileScope,
  type BrowserTilePlacement,
} from "./browser-tile-placement";
import {
  useMaybeBrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { PRIMARY_TILE_CHROME_CAPABILITIES } from "@/components/epic-canvas/renderers/tile-controller";
import { useBrowserAnnotationSession } from "@/hooks/browser/use-browser-annotation-session";
import { useElectronTabChrome } from "@/components/epic-canvas/renderers/use-electron-tile-chrome";
import { isSameBrowserViewTile } from "@/lib/browser-view/tiles/browser-view-keys";
import { resolveTileOverlay } from "@/components/epic-canvas/renderers/resolve-tile-overlay";
import type { TileOverlaySurface } from "@/components/epic-canvas/renderers/resolve-tile-overlay";
import type {
  BrowserViewStatus,
  BrowserViewViewportPresetId,
} from "@traycer-clients/shared/platform/browser-view";
import type {
  ElectronTabBinding,
  ElectronTabSurfaceLease,
} from "@/lib/browser-view/sessions/electron-tab-directory";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import { DEFAULT_BROWSER_TILE_URL } from "@/lib/browser-view/browser-tile-defaults";
import { samePageKey } from "@/lib/links/normalize-url";

interface ElectronTabSurfaceNode {
  readonly instanceId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly viewportPreset: BrowserViewViewportPresetId;
}

interface ElectronTabSurfaceProps {
  readonly node: ElectronTabSurfaceNode;
  readonly binding: ElectronTabBinding;
  readonly placement: BrowserTilePlacement;
  /** Whether the tile body is actually on screen, not merely mounted. */
  readonly visible: boolean;
  readonly pageSessionId: string;
  readonly onRequestClose: () => void;
  readonly persistViewportPreset:
    | ((preset: BrowserViewViewportPresetId) => void)
    | null;
  readonly onOpenLinkInNewTile:
    | ((url: string, disposition: "foreground" | "background") => void)
    | null;
  /** See `BrowserTabTileProps.onRequestNewTab`. `null` falls back to a link open. */
  readonly onRequestNewTab: (() => void) | null;
  readonly onConvertToPip: (() => void) | null;
  /**
   * The native view took focus, which is a BROWSER fact this surface is the
   * only one positioned to hear - the desktop reports it per tile, and nothing
   * above the surface knows which tile the report is for.
   *
   * What a host does about it is the host's own: the canvas claims its pane's
   * activation, so the focus moves off whatever pane held it. The Start Page
   * panel has no panes and passes `null`.
   */
  readonly onNativeTileFocused: (() => void) | null;
}

interface SurfaceAttachmentState {
  readonly bindingId: string;
  readonly registrationId: string;
  readonly status: "ready" | "error";
  readonly error: string | null;
}

interface AgentTileSessionFacts {
  /**
   * The host's session record is the only source for the profile; a tile
   * cannot infer a private session from its own state, and a tile whose
   * session is not in the context yet is treated as primary.
   */
  readonly profile: BrowserSessionProfileKind;
  readonly drivenBy: readonly BrowserTabDriver[];
}

/**
 * Kept extracted rather than inlined into {@link ElectronTabSurface}: folding
 * these lookups back into that component puts it over the complexity budget,
 * which is the objective signal that the extraction is carrying its weight.
 */
function agentTileSessionFacts(
  sessions: BrowserSessionsState | null,
  sessionId: string,
  tabId: string,
): AgentTileSessionFacts {
  const session = sessions?.items.find((item) => item.sessionId === sessionId);
  if (session === undefined) return { profile: "primary", drivenBy: [] };
  const tab = session.tabs.find((item) => item.tabId === tabId);
  return { profile: session.profile, drivenBy: tab?.drivenBy ?? [] };
}

/**
 * How long a tile may sit at `loading` with no progress report before it
 * resolves to the stalled/retry surface (see the stall effect below).
 */
const NAVIGATION_STALL_TIMEOUT_MS = 30_000;

/**
 * Electron tile used for agent-created pages and native session tabs.
 * Host-owned Electron tabs always use the primary browser partition.
 */
export function ElectronTabSurface(props: ElectronTabSurfaceProps) {
  const hostId = props.binding.hostId;
  const runnerHost = useRunnerHost();
  const visible = props.visible;
  const browserView = runnerHost.browserView;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<BrowserViewStatus>("loading");
  const [statusReason, setStatusReason] = useState<string | null>(null);
  const [statusUrl, setStatusUrl] = useState("");
  // A wire `loading` with no follow-up settle would spin forever; a silent
  // stretch resolves to a terminal retry surface instead. `loadingNonce`
  // bumps on every incoming `loading`, so ongoing progress keeps rearming
  // the clock and only a genuinely stalled tab trips it.
  const [stalledNonce, setStalledNonce] = useState<number | null>(null);
  const [loadingNonce, setLoadingNonce] = useState(0);
  const attemptedNavigationRef = useRef<AttemptedNavigation | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [surfaceAttachment, setSurfaceAttachment] =
    useState<SurfaceAttachmentState | null>(null);
  const surfaceLeaseRef = useRef<ElectronTabSurfaceLease | null>(null);
  useRegisterVisibleBrowserTile({
    hostId,
    sessionId: props.node.sessionId,
    tabId: props.binding.tabId,
    visible,
  });
  const browserSessions = useMaybeBrowserSessionsContext();
  // The epic this tile's annotations would be routed into, or `null` where the
  // placement has no epic. Not a scope - see `browserTileEpicId`.
  const epicId = browserTileEpicId(props.placement);
  const showStartPage = isStartPageUrl(statusUrl, props.node.url);
  const { profile: sessionProfile, drivenBy } = agentTileSessionFacts(
    browserSessions,
    props.node.sessionId,
    props.binding.tabId,
  );
  const annotationPreferredChatId = drivenBy.at(-1)?.chatId ?? null;

  const placement = props.placement;
  const tileInstanceId = props.node.instanceId;
  const pageSessionId = props.pageSessionId;
  const tileKey = useMemo(
    () => browserTileKey(placement, tileInstanceId, pageSessionId),
    [placement, tileInstanceId, pageSessionId],
  );
  const bindingId = useMemo(
    () => browserTileBindingId(placement, tileInstanceId),
    [placement, tileInstanceId],
  );
  const bindSurface = props.binding.bindSurface;
  const registrationId = props.binding.registrationId;
  const currentSurfaceAttachment = resolveCurrentSurfaceAttachment(
    surfaceAttachment,
    bindingId,
    registrationId,
  );
  const surfaceReady = isSurfaceReady(
    visible,
    showStartPage,
    currentSurfaceAttachment,
  );
  usePublishBrowserGuestTile({
    surfaceRef,
    registrationId,
    instanceId: props.node.instanceId,
    viewTabId: tileKey.viewTabId,
    paneId: tileKey.paneId,
    presented: surfaceReady,
    tileKey,
  });
  const surfaceError = visible
    ? (currentSurfaceAttachment?.error ?? null)
    : null;

  const { status: effectiveStatus, reason: effectiveStatusReason } =
    effectiveAgentTileStatus(
      browserView !== null,
      surfaceError,
      status,
      statusReason,
    );

  // Terminal stall is derived, not a synchronously-reset flag: the tile is
  // stalled only when the current loading episode is the one the timer fired
  // for. A new episode - a status flip or a `loadingNonce` bump from a fresh
  // progress report - clears it for free, with no setState in the effect.
  const navigationStalled =
    effectiveStatus === "loading" && stalledNonce === loadingNonce;

  // Deterministic terminal transition: a `loading` that neither settles nor
  // reports further progress within the window trips the stalled surface.
  // `loadingNonce` restarts the timer on each progress report, so only true
  // silence trips it. ponytail: fixed 30s ceiling; a page still streaming
  // status updates keeps rearming, a wedged navigation does not.
  useEffect(() => {
    if (effectiveStatus !== "loading") return;
    const timer = setTimeout(() => {
      setStalledNonce(loadingNonce);
    }, NAVIGATION_STALL_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [effectiveStatus, loadingNonce]);

  const onRequestClose = props.onRequestClose;
  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onNativeTabStatusChange((change) => {
      if (
        change.hostId !== props.binding.hostId ||
        change.sessionId !== props.binding.sessionId ||
        change.tabId !== props.binding.tabId
      ) {
        return;
      }
      const current = attemptedNavigationRef.current;
      if (!isStaleSettleBeforeEcho(current, change.status, change.url)) {
        setStatus(change.status);
        setStatusReason(change.reason);
        setStatusUrl(change.url);
        setCanGoBack(change.canGoBack);
        setCanGoForward(change.canGoForward);
        setZoomPercent(change.zoomPercent);
      }
      // Every fresh loading report is progress: rearm the stall clock.
      if (change.status === "loading") {
        setLoadingNonce((nonce) => nonce + 1);
      }
      const next = nextAttemptedNavigationAfterStatus(
        current,
        change.status,
        change.url,
      );
      attemptedNavigationRef.current = next;
    });
    return () => {
      subscription.dispose();
    };
  }, [
    browserView,
    props.binding.hostId,
    props.binding.sessionId,
    props.binding.tabId,
  ]);

  /**
   * Where a link the page opened goes. The whole "open a tab in this session
   * and place it beside this tile" flow belongs to the host surface, because
   * placing a tile is the one part of it that is not a browser fact - so the
   * surface only forwards the request.
   */
  const onOpenLinkInNewTile = props.onOpenLinkInNewTile;
  const onRequestNewTab = props.onRequestNewTab;

  const onNativeTileFocused = props.onNativeTileFocused;
  // Only the report is this surface's business. The desktop names the tile, so
  // the identity filter stays here - it is the same `tileKey` every other
  // bridge subscription in this file matches on - and the consequence is
  // forwarded, which is how every other host-shaped behaviour leaves this
  // body.
  useEffect(() => {
    if (browserView === null || onNativeTileFocused === null) return;
    const subscription = browserView.onTileFocused((focusedTile) => {
      if (!isSameBrowserViewTile(focusedTile, tileKey)) return;
      onNativeTileFocused();
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, onNativeTileFocused, tileKey]);

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onOpenTileRequest((change) => {
      if (!isSameBrowserViewTile(change, tileKey)) return;
      onOpenLinkInNewTile?.(change.url, change.disposition);
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, onOpenLinkInNewTile, tileKey]);

  const attachedBrowserView = surfaceReady ? browserView : null;
  const annotation = useBrowserAnnotationSession({
    browserView: annotationBrowserView(showStartPage, epicId, browserView),
    tileKey,
    status: effectiveStatus,
    epicId: epicId ?? "",
    browserHostId: props.node.hostId,
    preferredChatId: annotationPreferredChatId,
    fallbackChatId: null,
  });
  const chromeCapabilities = PRIMARY_TILE_CHROME_CAPABILITIES;
  const latchAttemptedUrl = useCallback((url: string) => {
    const current = attemptedNavigationRef.current;
    // Same URL as the in-flight attempt: keep echoSeen. The manager
    // skips navigate when requestedUrl already matches, so a reset
    // would wait for an echo that never comes.
    if (current !== null && current.url === url) return;
    const next: AttemptedNavigation = { url, echoSeen: false };
    attemptedNavigationRef.current = next;
  }, []);
  const chrome = useElectronTabChrome({
    profile: sessionProfile,
    control: props.binding.control,
    surfaceServices: attachedBrowserView,
    tileKey,
    initialUrl: props.node.url,
    capabilities: chromeCapabilities,
    annotation,
    statusUrl,
    canGoBack,
    canGoForward,
    zoomPercent,
    persistViewportPreset: (preset) => {
      // A placement that does not remember a viewport choice supplies no
      // writer; the chrome still applies the preset for this tile's life.
      props.persistViewportPreset?.(preset);
    },
    initialViewportPreset: props.node.viewportPreset,
    onAttemptedUrl: latchAttemptedUrl,
  });

  // Browser-scoped reserved chords: main claimed the keystroke from the guest
  // page (the app renderer never sees it) and named what the browser should
  // do. The policy table lives in
  // `@/lib/browser-view/reserved-chords-registration`.
  const {
    controller: chromeController,
    navigateToUrl,
    downloads,
    cancelDownload,
    certificateError,
    certificateProceeding,
    proceedCertificate,
  } = chrome;
  const focusAddress = chromeController.focusAddress;
  const retryNavigation = useCallback(() => {
    // Bump the episode so the derived stall clears immediately on click,
    // before the re-driven navigation's own status echoes back.
    setLoadingNonce((nonce) => nonce + 1);
    // Re-drive the intended navigation rather than reloading the wedged
    // about:blank the initial navigation never left.
    navigateToUrl(props.node.url);
  }, [navigateToUrl, props.node.url]);
  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onTileCommand((event) => {
      if (!isSameBrowserViewTile(event, tileKey)) return;
      switch (event.command) {
        case "newTab":
          // The guest asked for a NEW TAB, not for a url. A host surface that
          // has its own answer to that (the Start Page's chooser) takes it;
          // otherwise it degrades to opening a blank tab beside this one,
          // which is what every caller did before the two were separated.
          if (onRequestNewTab !== null) {
            onRequestNewTab();
            return;
          }
          onOpenLinkInNewTile?.(DEFAULT_BROWSER_TILE_URL, "foreground");
          return;
        case "focusAddressBar":
          focusAddress();
          return;
        case "closeTab": {
          // A host surface that owns the close gets ASKED, and nothing else
          // happens here - not even the liveness guard below, because its path
          // is tombstone-first and closes a row whose device cannot be reached.
          if (browserTileHostOwnsClose(placement)) {
            onRequestClose();
            return;
          }
          if (
            browserSessions === null ||
            browserSessions.lifecycle !== "live"
          ) {
            return;
          }
          // Retire the tile only after the host agrees the tab is gone - a
          // refused close must not leave a live tab with no tile.
          void browserSessions
            .closeTab(props.node.sessionId, props.binding.tabId)
            .then(onRequestClose)
            .catch(() => {
              toast.error("Couldn't close the browser tab. Try again.");
            });
          return;
        }
      }
    });
    return () => {
      subscription.dispose();
    };
  }, [
    focusAddress,
    browserSessions,
    browserView,
    onRequestClose,
    onOpenLinkInNewTile,
    onRequestNewTab,
    placement,
    props.binding.tabId,
    props.node.sessionId,
    tileKey,
  ]);

  useEffect(() => {
    if (!shouldAttachSurface(visible, showStartPage)) return;
    let active = true;
    void bindSurface({
      bindingId,
      surface: tileKey,
    })
      .then((lease) => {
        if (!active) {
          void lease.detach();
          return;
        }
        surfaceLeaseRef.current = lease;
        setSurfaceAttachment({
          bindingId,
          registrationId,
          status: "ready",
          error: null,
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setSurfaceAttachment({
          bindingId,
          registrationId,
          status: "error",
          error:
            cause instanceof Error
              ? cause.message
              : "The browser surface could not be attached.",
        });
      });
    return () => {
      active = false;
      const lease = surfaceLeaseRef.current;
      surfaceLeaseRef.current = null;
      if (lease !== null) void lease.detach();
      setSurfaceAttachment(null);
    };
  }, [bindSurface, bindingId, registrationId, showStartPage, tileKey, visible]);

  const overlay = resolveTileOverlay(
    effectiveStatus,
    surfaceReady,
    navigationStalled,
  );

  return (
    <div
      className="flex h-full w-full flex-col bg-canvas text-foreground"
      data-testid={`agent-browser-tile-${props.node.instanceId}`}
    >
      <BrowserTileFindAdapterBridge
        browserView={attachedBrowserView}
        tileKey={tileKey}
      />
      <BrowserTileToolbar
        controller={chromeController}
        pictureInPicture={{
          disabled: props.onConvertToPip === null,
          convert: () => props.onConvertToPip?.(),
        }}
      />
      <div
        ref={surfaceRef}
        className={cn(
          "relative min-h-0 bg-background",
          props.node.viewportPreset === "responsive"
            ? "flex-1"
            : "mx-auto my-auto",
        )}
        style={viewportPresetSurfaceStyle(props.node.viewportPreset)}
      >
        <ElectronTabSurfaceBaseLayer
          showStartPage={showStartPage}
          visible={visible}
          scope={browserTileScope(placement)}
          hostId={hostId}
          onNavigate={navigateToUrl}
        />
        <div
          hidden={showStartPage}
          // Transparent is not hidden: without this a presented, live guest
          // still exposes the loader's role and "Reconnecting" text to
          // assistive tech. Hide it from AT whenever it is not the shown layer.
          aria-hidden={!overlay.visible}
          className={cn(
            "absolute inset-0 z-20 flex min-h-0 flex-col items-center justify-center gap-3 px-4 text-center",
            overlay.visible ? "opacity-100" : "opacity-0",
            // Pointer events are gated on the guest not yet being interactive,
            // NOT on the same flag that hides the overlay: a presented, live
            // guest must never be click-blocked by a stale loader. A terminal
            // surface keeps them so its Retry stays clickable.
            overlay.blocking ? "pointer-events-auto" : "pointer-events-none",
          )}
          role={overlay.surface === "loading" ? "status" : "alert"}
          aria-live={overlay.surface === "loading" ? "polite" : "assertive"}
          aria-busy={
            overlay.visible ? overlay.surface === "loading" : undefined
          }
        >
          <ElectronTabSurfaceStatus
            surface={overlay.surface}
            reason={effectiveStatusReason}
            hostId={hostId}
            onRetry={retryNavigation}
          />
        </div>
        <BrowserTileDownloadStrip
          downloads={downloads}
          onCancel={cancelDownload}
        />
        <BrowserTileCertificateInterstitial
          certificateError={certificateError}
          proceeding={certificateProceeding}
          onProceed={proceedCertificate}
        />
      </div>
    </div>
  );
}

/**
 * The start page stands in for the blank address, whatever placement the tile
 * is in - it is the launcher a fresh tab opens on, not an epic surface. Any
 * other address has no base layer of its own: the renderer-owned guest is
 * the surface, positioned over this element by the guest host.
 */
function ElectronTabSurfaceBaseLayer(props: {
  readonly showStartPage: boolean;
  readonly visible: boolean;
  readonly scope: HostResourceScope;
  readonly hostId: string;
  readonly onNavigate: (url: string) => void;
}) {
  if (!props.showStartPage) return null;
  return (
    <BrowserStartPage
      scope={props.scope}
      hostId={props.hostId}
      browserRunsOnHost={false}
      visible={props.visible}
      onNavigate={props.onNavigate}
    />
  );
}

const VIEWPORT_PRESET_SIZES: Readonly<
  Record<
    BrowserViewViewportPresetId,
    { readonly width: number; readonly height: number } | null
  >
> = {
  responsive: null,
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
};

function viewportPresetSurfaceStyle(
  preset: BrowserViewViewportPresetId,
):
  | { width: number; height: number; maxWidth: string; maxHeight: string }
  | undefined {
  const size = VIEWPORT_PRESET_SIZES[preset];
  if (size === null) return undefined;
  return {
    width: size.width,
    height: size.height,
    maxWidth: "100%",
    maxHeight: "100%",
  };
}

function isStartPageUrl(statusUrl: string, initialUrl: string): boolean {
  const liveUrl = statusUrl.length > 0 ? statusUrl : initialUrl;
  return liveUrl === DEFAULT_BROWSER_TILE_URL;
}

/**
 * Null browser view on BOTH inert paths, not just the start page: an
 * annotation is captured into a chat in an epic, so a placement with no epic
 * has nowhere to put one. Without the `epicId === null` half, a Start Page tab
 * sitting on a real page would render an enabled Annotate button whose capture
 * routes through an empty epic id and resolves no targets at all - an overlay
 * that works and then attaches to nothing.
 */
function annotationBrowserView<T>(
  showStartPage: boolean,
  epicId: string | null,
  browserView: T | null,
): T | null {
  return showStartPage || epicId === null ? null : browserView;
}

function isSurfaceReady(
  visible: boolean,
  showStartPage: boolean,
  attachment: SurfaceAttachmentState | null,
): boolean {
  return visible && !showStartPage && attachment?.status === "ready";
}

function shouldAttachSurface(
  visible: boolean,
  showStartPage: boolean,
): boolean {
  return visible && !showStartPage;
}

function resolveCurrentSurfaceAttachment(
  attachment: SurfaceAttachmentState | null,
  bindingId: string,
  registrationId: string,
): SurfaceAttachmentState | null {
  if (attachment === null || attachment.bindingId !== bindingId) return null;
  if (attachment.registrationId !== registrationId) return null;
  return attachment;
}

interface ElectronTabSurfaceStatusProps {
  readonly surface: TileOverlaySurface;
  readonly reason: string | null;
  readonly hostId: string;
  readonly onRetry: () => void;
}

/** Shows only lifecycle states reported by the native browser owner. */
function ElectronTabSurfaceStatus(props: ElectronTabSurfaceStatusProps) {
  if (props.surface === "dead") {
    return (
      <>
        <div className="text-ui-base font-medium">
          Agent browser unavailable
        </div>
        <ElectronTabSurfaceReason reason={props.reason} hostId={props.hostId} />
      </>
    );
  }
  if (props.surface === "stalled") {
    return (
      <>
        <div className="text-ui-base font-medium">This page did not load</div>
        <ElectronTabSurfaceReason reason={props.reason} hostId={props.hostId} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={props.onRetry}
        >
          Retry
        </Button>
      </>
    );
  }
  return (
    <>
      <AgentSpinningDots
        className="shrink-0"
        testId={undefined}
        variant={undefined}
      />
      <div className="text-ui-base font-medium">
        Reconnecting to this session
      </div>
      <ElectronTabSurfaceReason reason={props.reason} hostId={props.hostId} />
    </>
  );
}

function ElectronTabSurfaceReason(props: {
  readonly reason: string | null;
  readonly hostId: string;
}) {
  return (
    <div className="flex max-w-[min(90vw,32rem)] flex-col items-center gap-1 text-ui-sm text-muted-foreground">
      {props.reason === null ? null : <span>{props.reason}</span>}
      <TooltipWrapper
        label={`Host ${props.hostId}`}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          className="text-ui-xs text-muted-foreground/70 underline decoration-dotted underline-offset-2 outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Host details
        </button>
      </TooltipWrapper>
    </div>
  );
}

function effectiveAgentTileStatus(
  nativeAvailable: boolean,
  surfaceError: string | null,
  status: BrowserViewStatus,
  statusReason: string | null,
): { readonly status: BrowserViewStatus; readonly reason: string | null } {
  if (!nativeAvailable) {
    return { status: "dead", reason: "Native browser views are unavailable." };
  }
  if (surfaceError !== null) return { status: "dead", reason: surfaceError };
  return { status, reason: statusReason };
}

interface AttemptedNavigation {
  readonly url: string;
  readonly echoSeen: boolean;
}

/**
 * True when a settle's URL is the latched attempt's own page completing,
 * tolerating the trailing-slash / hash / http↔https differences a site
 * introduces between the submitted URL and where the tab commits.
 * `samePageKey` keys http(s) URLs on host+path+query (scheme-insensitive);
 * a non-http(s) latch (e.g. `about:blank`) falls back to exact equality.
 */
// eslint-disable-next-line react-refresh/only-export-components -- test-only export; the component's own callers use this helper directly, the export exists only for the latch unit tests.
export function settleMatchesLatch(
  latchUrl: string,
  settledUrl: string,
): boolean {
  const a = samePageKey(latchUrl);
  const b = samePageKey(settledUrl);
  return a !== null && b !== null ? a === b : latchUrl === settledUrl;
}

/**
 * Address submit (and back/forward) latches {url, echoSeen:false}.
 * navigate() emits a synchronous `loading` echo before loadURL, so the
 * first loading status after such an attempt is its echo (echoSeen=true),
 * and a later `ready` then clears the latch. A `ready` that arrives before
 * that echo is normally a stale settle from a previous attempt - ignore it
 * (newest submit wins; do not let it replace the latch or feed the toolbar
 * state).
 *
 * Exception: a back/forward history nav or a session reconnect re-attach
 * settles straight to `ready` with NO loading echo. Such a settle whose URL
 * matches the latch (`settleMatchesLatch`) is that very attempt completing,
 * not a stale one - accept it and clear the latch. Only an echo-less `ready`
 * whose URL does NOT match the latch is still dropped as stale.
 *
 * That URL-match also closes the "Residual B" resubmit-same-URL cases:
 * resubmitting B when the manager skips navigate (requestedUrl already B)
 * emits no echo, but the eventual `ready` for B now matches the latch and
 * clears it instead of sitting inert.
 *
 * A submit whose URL equals the active latch is a no-op (echoSeen stays) -
 * see `latchAttemptedUrl`.
 *
 * `dead` keeps the latch so a later Retry still upserts the submitted URL
 * rather than the pre-submit page. The dead branch currently has no Retry
 * button; if Retry is ever exposed there it must force reload (user-tile
 * `reloadTile`), not rely on upsert identity - manager already set
 * requestedUrl to the attempt before loadURL failed.
 */
function nextAttemptedNavigationAfterStatus(
  current: AttemptedNavigation | null,
  status: BrowserViewStatus,
  settledUrl: string,
): AttemptedNavigation | null {
  if (current === null) return null;
  // Dead-state Retry, if ever exposed, must use a forced reload path like
  // the user tile's reloadTile rather than upsert identity.
  if (status === "dead") return current;
  if (status === "loading") {
    if (current.echoSeen) return current;
    return { url: current.url, echoSeen: true };
  }
  // Echo-less `ready` for a different page is still a stale pre-echo settle;
  // keep waiting. Echo seen, or a settle that matches the latch (echo-less
  // history/reconnect settle), is this attempt completing - clear it.
  if (!current.echoSeen && !settleMatchesLatch(current.url, settledUrl)) {
    return current;
  }
  return null;
}

function isStaleSettleBeforeEcho(
  current: AttemptedNavigation | null,
  status: BrowserViewStatus,
  settledUrl: string,
): boolean {
  return (
    current !== null &&
    status === "ready" &&
    !current.echoSeen &&
    !settleMatchesLatch(current.url, settledUrl)
  );
}
