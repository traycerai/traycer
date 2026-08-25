import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import { useRegisterVisibleBrowserTile } from "@/lib/browser-view/visible-tile-registry";
import { BrowserTileFindAdapterBridge } from "@/components/epic-canvas/renderers/browser-tile-find-adapter";
import {
  BrowserTileCertificateInterstitial,
  BrowserTileDownloadStrip,
} from "@/components/epic-canvas/renderers/browser-tile-status-panels";
import { BrowserTileToolbar } from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { BrowserViewSnapshotLayer } from "@/components/epic-canvas/renderers/browser-view-snapshot-layer";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { PRIMARY_TILE_CHROME_CAPABILITIES } from "@/components/epic-canvas/renderers/tile-controller";
import { useBrowserAnnotationSession } from "@/hooks/browser/use-browser-annotation-session";
import { useBrowserViewSnapshot } from "@/components/epic-canvas/renderers/use-browser-view-snapshot";
import { useCloseCanvasTileWithNestedFocus } from "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus";
import { useBrowserViewBoundsBridge } from "@/components/epic-canvas/renderers/use-browser-view-bounds-bridge";
import { useElectronTabChrome } from "@/components/epic-canvas/renderers/use-electron-tile-chrome";
import { BROWSER_VIEW_SURFACE_ATTRIBUTE } from "@/lib/browser-view/browser-overlay-coordinator";
import type {
  BrowserViewStatus,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import type {
  ElectronTabBinding,
  ElectronTabSurfaceLease,
} from "@/lib/browser-view/electron-tabs";
import { openFreshBrowserTileFromBrowserPage } from "@/lib/browser-view/browser-link-routing-core";
import { useBrowserCookieCryptoState } from "@/lib/browser-view/use-browser-cookie-crypto-state";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { convertBrowserTabToPip } from "@/lib/browser-view/pip-store";

interface ElectronTabSurfaceNode {
  readonly id: string;
  readonly instanceId: string;
  readonly name: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly viewportPreset: string;
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
  const epicId = useEpicCanvasStore(
    (state) => state.tabsById[props.viewTabId]?.epicId ?? null,
  );
  const annotationSession = browserSessions?.items.find(
    (item) => item.sessionId === props.node.sessionId,
  );
  const annotationTab = annotationSession?.tabs.find(
    (item) => item.tabId === props.binding.tabId,
  );
  const annotationDriverChatId = annotationTab?.drivenBy.at(-1)?.chatId ?? null;
  const annotationPreferredChatId = annotationDriverChatId;

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
  const currentSurfaceAttachment = resolveCurrentSurfaceAttachment(
    surfaceAttachment,
    bindingId,
    props.binding.registrationId,
  );
  const surfaceReady = currentSurfaceAttachment?.status === "ready";
  const surfaceError = currentSurfaceAttachment?.error ?? null;

  const { status: effectiveStatus, reason: effectiveStatusReason } =
    effectiveAgentTileStatus(
      browserView !== null,
      surfaceError,
      status,
      statusReason,
    );

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

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onOpenTileRequest((change) => {
      if (!isChangeForTile(change, tileKey)) return;
      openFreshBrowserTileFromBrowserPage({
        viewTabId: props.viewTabId,
        paneId: props.paneId,
        hostId: props.node.hostId,
        url: change.url,
      });
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, props.node.hostId, props.paneId, props.viewTabId, tileKey]);

  const attachedBrowserView = surfaceReady ? browserView : null;
  useBrowserViewBoundsBridge({
    browserView: attachedBrowserView,
    surfaceRef,
    tileKey,
    visible,
  });
  const snapshot = useBrowserViewSnapshot(tileKey);
  const cookieCryptoState = useBrowserCookieCryptoState(browserView);
  const annotation = useBrowserAnnotationSession({
    browserView,
    tileKey,
    status: effectiveStatus,
    epicId: epicId ?? "",
    browserHostId: props.node.hostId,
    preferredChatId: annotationPreferredChatId,
    fallbackChatId: annotationSession?.createdBy.chatId ?? null,
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
    control: props.binding.control,
    surfaceServices: attachedBrowserView,
    tileKey,
    initialUrl: props.node.url,
    capabilities: chromeCapabilities,
    annotation,
    cookieCryptoState,
    statusUrl,
    canGoBack,
    canGoForward,
    zoomPercent,
    persistViewportPreset: (preset) => {
      persistViewportPreset(props.viewTabId, props.node.instanceId, preset);
    },
    initialViewportPreset: readAgentViewportPreset(props.node.viewportPreset),
    onAttemptedUrl: latchAttemptedUrl,
  });
  useEffect(() => {
    let active = true;
    void props.binding
      .bindSurface({
        bindingId,
        surface: tileKey,
        visible: false,
      })
      .then((lease) => {
        if (!active) {
          void lease.detach();
          return;
        }
        surfaceLeaseRef.current = lease;
        setSurfaceAttachment({
          bindingId,
          registrationId: props.binding.registrationId,
          status: "ready",
          error: null,
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setSurfaceAttachment({
          bindingId,
          registrationId: props.binding.registrationId,
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
    };
  }, [bindingId, props.binding, tileKey]);

  useEffect(() => {
    const lease = surfaceLeaseRef.current;
    if (lease === null || !surfaceReady) return;
    void lease
      .update({
        surface: tileKey,
        visible,
      })
      .catch((cause: unknown) => {
        setSurfaceAttachment({
          bindingId,
          registrationId: props.binding.registrationId,
          status: "error",
          error:
            cause instanceof Error
              ? cause.message
              : "The native browser surface could not be updated.",
        });
      });
  }, [bindingId, props.binding.registrationId, surfaceReady, tileKey, visible]);

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
        controller={chrome.controller}
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
        className="relative min-h-0 flex-1 bg-background"
        {...{ [BROWSER_VIEW_SURFACE_ATTRIBUTE]: "" }}
      >
        <div
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
        <BrowserViewSnapshotLayer snapshot={snapshot} />
        <BrowserTileDownloadStrip
          downloads={chrome.downloads}
          onCancel={chrome.cancelDownload}
        />
        <BrowserTileCertificateInterstitial
          certificateError={chrome.certificateError}
          proceeding={chrome.certificateProceeding}
          onProceed={chrome.proceedCertificate}
        />
      </div>
    </div>
  );
}

function resolveCurrentSurfaceAttachment(
  attachment: SurfaceAttachmentState | null,
  bindingId: string,
  registrationId: string,
): SurfaceAttachmentState | null {
  if (attachment?.bindingId !== bindingId) return null;
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

function readAgentViewportPreset(
  value: string,
): "responsive" | "mobile" | "tablet" | "desktop" {
  if (
    value === "responsive" ||
    value === "mobile" ||
    value === "tablet" ||
    value === "desktop"
  ) {
    return value;
  }
  return "responsive";
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

function isChangeForTile(
  change: BrowserViewTileKey,
  key: BrowserViewTileKey,
): boolean {
  return (
    change.viewTabId === key.viewTabId &&
    change.paneId === key.paneId &&
    change.tileInstanceId === key.tileInstanceId &&
    change.pageSessionId === key.pageSessionId
  );
}
