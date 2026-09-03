import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  BrowserSessionProfileKind,
  BrowserTabDriver,
} from "@traycer/protocol/host/browser/contracts";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
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
  browserTileKey,
  browserTileScope,
  type BrowserTilePlacement,
} from "./browser-tile-placement";
import { BrowserViewSnapshotLayer } from "@/components/epic-canvas/renderers/browser-view-snapshot-layer";
import {
  useMaybeBrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { PRIMARY_TILE_CHROME_CAPABILITIES } from "@/components/epic-canvas/renderers/tile-controller";
import { useBrowserAnnotationSession } from "@/hooks/browser/use-browser-annotation-session";
import { useBrowserViewSnapshot } from "@/components/epic-canvas/renderers/use-browser-view-snapshot";
import { useBrowserViewBoundsBridge } from "@/components/epic-canvas/renderers/use-browser-view-bounds-bridge";
import { useElectronTabChrome } from "@/components/epic-canvas/renderers/use-electron-tile-chrome";
import {
  BROWSER_VIEW_SURFACE_ATTRIBUTE,
  type BrowserViewSnapshotState,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import { isSameBrowserViewTile } from "@/lib/browser-view/tiles/browser-view-keys";
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
  readonly onConvertToPip: (() => void) | null;
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
      if (!isStaleSettleBeforeEcho(current, change.status)) {
        setStatus(change.status);
        setStatusReason(change.reason);
        setStatusUrl(change.url);
        setCanGoBack(change.canGoBack);
        setCanGoForward(change.canGoForward);
        setZoomPercent(change.zoomPercent);
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

  /**
   * Where a link the page opened goes. The whole "open a tab in this session
   * and place it beside this tile" flow belongs to the host surface, because
   * placing a tile is the one part of it that is not a browser fact - so the
   * surface only forwards the request.
   */
  const onOpenLinkInNewTile = props.onOpenLinkInNewTile;

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
  useBrowserViewBoundsBridge({
    browserView: attachedBrowserView,
    surfaceRef,
    tileKey,
    visible,
  });
  const snapshot = useBrowserViewSnapshot(tileKey);
  const annotation = useBrowserAnnotationSession({
    browserView: showStartPage ? null : browserView,
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
  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onTileCommand((event) => {
      if (!isSameBrowserViewTile(event, tileKey)) return;
      switch (event.command) {
        case "newTab":
          onOpenLinkInNewTile?.(DEFAULT_BROWSER_TILE_URL, "foreground");
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
              : "The native browser surface could not be attached.",
        });
      });
    return () => {
      active = false;
      const lease = surfaceLeaseRef.current;
      surfaceLeaseRef.current = null;
      if (lease !== null) void lease.detach();
      // The surface is gone in main the moment we detach, so the readiness
      // this state feeds must go with it. Leaving it "ready" is what let the
      // bounds bridge (declared ABOVE this effect, so it re-mounts first)
      // fire its one mount-time `updateBounds` at a surface key main no
      // longer maps - the send is dropped, the rAF dedupe never repeats it,
      // and the re-attached tile stays at `bounds === null`, i.e. invisible
      // until a window resize. Clearing here keeps the bridge unmounted until
      // the NEXT attach resolves. The in-flight attach cannot resurrect it:
      // `active` is already false, so its `.then`/`.catch` return early.
      setSurfaceAttachment(null);
    };
  }, [bindSurface, bindingId, registrationId, showStartPage, tileKey, visible]);

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
        className="relative min-h-0 flex-1 bg-background"
        {...{ [BROWSER_VIEW_SURFACE_ATTRIBUTE]: "" }}
      >
        <ElectronTabSurfaceBaseLayer
          showStartPage={showStartPage}
          scope={browserTileScope(placement)}
          hostId={hostId}
          snapshot={snapshot}
          onNavigate={navigateToUrl}
        />
        <div
          hidden={showStartPage}
          className={cn(
            "absolute inset-0 flex min-h-0 flex-col items-center justify-center gap-3 px-4 text-center",
            effectiveStatus === "ready" && "pointer-events-none opacity-0",
          )}
          role={effectiveStatus === "dead" ? "alert" : "status"}
          aria-live={effectiveStatus === "dead" ? "assertive" : "polite"}
          aria-busy={effectiveStatus === "loading"}
        >
          <ElectronTabSurfaceStatus
            status={effectiveStatus}
            reason={effectiveStatusReason}
            hostId={hostId}
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
  readonly showStartPage: boolean;
  readonly scope: HostResourceScope;
  readonly hostId: string;
  readonly snapshot: BrowserViewSnapshotState | null;
  readonly onNavigate: (url: string) => void;
}) {
  if (props.showStartPage) {
    return (
      <BrowserStartPage
        scope={props.scope}
        hostId={props.hostId}
        browserRunsOnHost={false}
        onNavigate={props.onNavigate}
      />
    );
  }
  return <BrowserViewSnapshotLayer snapshot={props.snapshot} />;
}

/**
 * The start page stands in for the blank address, whatever placement the tile
 * is in - it is the launcher a fresh tab opens on, not an epic surface.
 */
function isStartPageUrl(statusUrl: string, initialUrl: string): boolean {
  const liveUrl = statusUrl.length > 0 ? statusUrl : initialUrl;
  return liveUrl === DEFAULT_BROWSER_TILE_URL;
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
  readonly status: BrowserViewStatus;
  readonly reason: string | null;
  readonly hostId: string;
}

/** Shows only lifecycle states reported by the native browser owner. */
function ElectronTabSurfaceStatus(props: ElectronTabSurfaceStatusProps) {
  if (props.status === "dead") {
    return (
      <>
        <div className="text-ui-base font-medium">
          Agent browser unavailable
        </div>
        <ElectronTabSurfaceReason reason={props.reason} hostId={props.hostId} />
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
