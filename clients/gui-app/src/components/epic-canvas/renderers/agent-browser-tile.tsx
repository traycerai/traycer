import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  BrowserSessionProfileKind,
  BrowserTabDriver,
} from "@traycer/protocol/host/browser/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { usePublishBrowserGuestTile } from "@/components/epic-canvas/browser-guest/use-publish-browser-guest-tile";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import { useRegisterVisibleBrowserTile } from "@/lib/browser-view/tiles/visible-tile-registry";
import { BrowserTileFindAdapterBridge } from "@/components/epic-canvas/renderers/browser-tile-find-adapter";
import {
  BrowserTileCertificateInterstitial,
  BrowserTileDownloadStrip,
} from "@/components/epic-canvas/renderers/browser-tile-status-panels";
import { BrowserTileToolbar } from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { BrowserStartPage } from "@/components/epic-canvas/renderers/browser-start-page";
import {
  useMaybeBrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { PRIMARY_TILE_CHROME_CAPABILITIES } from "@/components/epic-canvas/renderers/tile-controller";
import { useBrowserAnnotationSession } from "@/hooks/browser/use-browser-annotation-session";
import { useCloseCanvasTileWithNestedFocus } from "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus";
import { useElectronTabChrome } from "@/components/epic-canvas/renderers/use-electron-tile-chrome";
import { isSameBrowserViewTile } from "@/lib/browser-view/tiles/browser-view-keys";
import { resolveTileOverlay } from "@/components/epic-canvas/renderers/resolve-tile-overlay";
import type { TileOverlaySurface } from "@/components/epic-canvas/renderers/resolve-tile-overlay";
import type {
  BrowserViewStatus,
  BrowserViewTileKey,
  BrowserViewViewportPresetId,
} from "@traycer-clients/shared/platform/browser-view";
import { browserSessionsRefusal } from "@traycer-clients/shared/platform/browser-view";
import type {
  ElectronTabBinding,
  ElectronTabSurfaceLease,
} from "@/lib/browser-view/sessions/electron-tab-directory";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import type { TileOpenTarget } from "@/lib/canvas/tile-open/intent";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { convertBrowserTabToPip } from "@/lib/browser-view/pip/pip-store";
import {
  DEFAULT_BROWSER_TILE_URL,
  makeBrowserSessionTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import { claimHostedPaneActivationFocus } from "@/components/epic-canvas/pane-activation";

interface ElectronTabSurfaceNode {
  readonly id: string;
  readonly instanceId: string;
  readonly name: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly viewportPreset: BrowserViewViewportPresetId;
}

interface ElectronTabSurfaceProps {
  readonly node: ElectronTabSurfaceNode;
  readonly binding: ElectronTabBinding;
  readonly viewTabId: string;
  readonly paneId: string;
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
  const visible = useTileBodyVisible();
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
  const { openTile } = useEpicTileNavigation();
  const epicId = useEpicCanvasStore(
    (state) => state.tabsById[props.viewTabId]?.epicId ?? null,
  );
  const startPageEpicId = resolveStartPageEpicId(
    epicId,
    statusUrl,
    props.node.url,
  );
  const showStartPage = startPageEpicId !== null;
  const { profile: sessionProfile, drivenBy } = agentTileSessionFacts(
    browserSessions,
    props.node.sessionId,
    props.binding.tabId,
  );
  const annotationPreferredChatId = drivenBy.at(-1)?.chatId ?? null;

  const tileKey = useMemo<BrowserViewTileKey>(
    () => ({
      viewTabId: props.viewTabId,
      paneId: props.paneId,
      tileInstanceId: props.node.instanceId,
      // pageSessionId is the canvas node id, never host sessionId.
      pageSessionId: pageSessionIdForAgentTile(props.node.id),
    }),
    [props.viewTabId, props.paneId, props.node.instanceId, props.node.id],
  );
  const bindingId = useMemo(
    () =>
      ["canvas", props.viewTabId, props.paneId, props.node.instanceId].join(
        "\u001f",
      ),
    [props.paneId, props.node.instanceId, props.viewTabId],
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
    viewTabId: props.viewTabId,
    paneId: props.paneId,
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

  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.paneId,
    props.node.instanceId,
  );
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
      if (!isStaleSettleBeforeEcho(current, change.status)) {
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
      const next = nextAttemptedNavigationAfterStatus(current, change.status);
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

  /** Open a tab in this tile's session and place it beside this tile. */
  const openTabBesideThisTile = useCallback(
    (url: string, disposition: "foreground" | "background") => {
      if (
        browserSessions === null ||
        browserSessions.lifecycle !== "live" ||
        browserSessions.hostId !== props.node.hostId
      ) {
        toast.error(browserSessionsRefusal(browserSessions));
        return;
      }
      void browserSessions
        .openTab(props.node.sessionId, url)
        .then((opened) => {
          // Browser semantics, never the placement setting (A4): the popup is
          // a tab of THIS pane's session, and a background disposition
          // (middle/ctrl/cmd-click) leaves the current tab active.
          openTile({
            node: makeBrowserSessionTileRef({
              hostId: props.node.hostId,
              sessionId: opened.sessionId,
              tabId: opened.tabId,
            }),
            // Resolved after the await, not before: the view tab can close
            // while `openTab` is in flight, and opening into a closed tab id
            // mutates a canvas with no route (R8).
            target: currentPopupTarget(props.viewTabId, epicId),
            gesture: disposition === "background" ? "host" : "explicit",
            modifiers: null,
            placement: { kind: "tab", paneId: props.paneId, index: null },
            dedupe: true,
            source: "direct_ui",
          });
        })
        .catch((cause: unknown) => {
          toast.error(
            cause instanceof Error
              ? cause.message
              : "Couldn't open the browser tab.",
          );
        });
    },
    [
      browserSessions,
      epicId,
      openTile,
      props.node.hostId,
      props.node.sessionId,
      props.paneId,
      props.viewTabId,
    ],
  );

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onTileFocused((focusedTile) => {
      if (!isSameBrowserViewTile(focusedTile, tileKey)) return;
      claimHostedPaneActivationFocus(props.viewTabId, props.paneId, {
        defaultPrevented: false,
        scope: null,
        target: null,
      });
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, props.paneId, props.viewTabId, tileKey]);

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onOpenTileRequest((change) => {
      if (!isSameBrowserViewTile(change, tileKey)) return;
      openTabBesideThisTile(change.url, change.disposition);
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, openTabBesideThisTile, tileKey]);

  const attachedBrowserView = surfaceReady ? browserView : null;
  const annotation = useBrowserAnnotationSession({
    browserView: showStartPage ? null : browserView,
    tileKey,
    status: effectiveStatus,
    epicId: epicId ?? "",
    browserHostId: props.node.hostId,
    preferredChatId: annotationPreferredChatId,
    fallbackChatId: null,
  });
  const persistViewportPreset = useEpicCanvasStore(
    (state) => state.updateBrowserTileViewportPresetInTab,
  );
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
      persistViewportPreset(props.viewTabId, props.node.instanceId, preset);
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
          openTabBesideThisTile(DEFAULT_BROWSER_TILE_URL, "foreground");
          return;
        case "focusAddressBar":
          focusAddress();
          return;
        case "closeTab": {
          if (
            browserSessions === null ||
            browserSessions.lifecycle !== "live"
          ) {
            return;
          }
          // Retire the canvas tile only after the host agrees the tab is
          // gone - a refused close must not leave a live tab with no tile.
          void browserSessions
            .closeTab(props.node.sessionId, props.binding.tabId)
            .then(closeCanvasTile)
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
    closeCanvasTile,
    openTabBesideThisTile,
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
          disabled: epicId === null,
          convert: () => {
            if (epicId === null) return;
            convertBrowserTabToPip({
              epicId,
              hostId: props.binding.hostId,
              sessionId: props.binding.sessionId,
              tabId: props.binding.tabId,
              origin: "manual",
              onReady: closeCanvasTile,
              onError: (message) => toast.error(message),
            });
          },
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
          startPageEpicId={startPageEpicId}
          hostId={hostId}
          onNavigate={navigateToUrl}
        />
        <div
          hidden={showStartPage}
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

function ElectronTabSurfaceBaseLayer(props: {
  readonly startPageEpicId: string | null;
  readonly hostId: string;
  readonly onNavigate: (url: string) => void;
}) {
  if (props.startPageEpicId === null) return null;
  return (
    <BrowserStartPage
      epicId={props.startPageEpicId}
      hostId={props.hostId}
      browserRunsOnHost={false}
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

function resolveStartPageEpicId(
  epicId: string | null,
  statusUrl: string,
  initialUrl: string,
): string | null {
  const liveUrl = statusUrl.length > 0 ? statusUrl : initialUrl;
  return epicId !== null && liveUrl === DEFAULT_BROWSER_TILE_URL
    ? epicId
    : null;
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

/** Canvas node id is the Electron tile key's pageSessionId, not host sessionId. */
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

function pageSessionIdForAgentTile(nodeId: string): string {
  return nodeId;
}

interface AttemptedNavigation {
  readonly url: string;
  readonly echoSeen: boolean;
}

/**
 * Address submit latches {url, echoSeen:false}. navigate() emits a
 * synchronous `loading` echo before loadURL, so the first loading
 * status after a submit is this attempt's echo (echoSeen=true). A
 * later `ready` then clears the latch. A `ready` that arrives before
 * that echo is a stale settle from a previous attempt - ignore it
 * (newest submit wins; do not let it replace the latch or feed
 * the toolbar state).
 *
 * A submit whose URL equals the active latch is a no-op (echoSeen
 * stays). That matches the manager skipping navigate when
 * requestedUrl already equals the upsert. Resetting would mint a
 * phantom attempt that never gets an echo.
 *
 * `dead` keeps the latch so a later Retry still upserts the submitted
 * URL rather than the pre-submit page. Residual B: the dead branch
 * currently has no Retry button; if Retry is ever exposed there it
 * must force reload (user-tile `reloadTile`), not rely on upsert
 * identity - manager already set requestedUrl to the attempt before
 * loadURL failed.
 *
 * Same root cause (submit-via-upsert-identity): if B settled via
 * redirect to C (latch cleared) and the user resubmits B, the
 * manager may skip navigate (requestedUrl still B) and emit nothing.
 * A fresh {B, echoSeen:false} then sits inert. Do not patch the
 * latch; the honest fix is a force-navigate submit path
 * (reloadTile-style), which is shared manager semantics.
 */
function nextAttemptedNavigationAfterStatus(
  current: AttemptedNavigation | null,
  status: BrowserViewStatus,
): AttemptedNavigation | null {
  if (current === null) return null;
  // Residual B + redirected-away resubmit: keep latch. Both are
  // submit-via-upsert-identity. Dead-state Retry, if ever exposed,
  // must use a forced reload path like the user tile's reloadTile.
  if (status === "dead") return current;
  if (status === "loading") {
    if (current.echoSeen) return current;
    return { url: current.url, echoSeen: true };
  }
  if (!current.echoSeen) return current;
  return null;
}

function isStaleSettleBeforeEcho(
  current: AttemptedNavigation | null,
  status: BrowserViewStatus,
): boolean {
  return current !== null && status === "ready" && !current.echoSeen;
}

/**
 * The popup's own canvas tab while it still exists, else the epic - which
 * lets the resolver pick (or create) a live tab instead of writing a tile
 * into a tab that closed while `openTab` was in flight (R8).
 */
function currentPopupTarget(
  viewTabId: string,
  epicId: string | null,
): TileOpenTarget {
  const tabs = useEpicCanvasStore.getState().tabsById;
  if (tabs[viewTabId] !== undefined) return { tabId: viewTabId };
  return epicId === null ? { tabId: viewTabId } : { epicId };
}
