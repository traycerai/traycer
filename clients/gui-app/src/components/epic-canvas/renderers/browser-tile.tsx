import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { AlertTriangle } from "lucide-react";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import { BROWSER_VIEW_SURFACE_ATTRIBUTE } from "@/lib/browser-view/browser-overlay-coordinator";
import { browserCookieDegradedMessage } from "@/lib/browser-view/browser-cookie-degraded-message";
import { selectSiblingChatIdForBrowserTile } from "@/lib/browser-view/browser-tile-chat-routing";
import type {
  BrowserCookieCryptoState,
  BrowserViewCertificateErrorChange,
  BrowserViewDownloadChange,
  BrowserViewStatus,
  BrowserViewTileKey,
  BrowserViewViewportPresetId,
} from "@traycer-clients/shared/platform/browser-view";
import {
  browserTileNameForUrl,
  normalizeBrowserAddressInput,
  openFreshBrowserTileFromBrowserPage,
} from "@/lib/browser-view/browser-link-routing-core";
import { useBrowserCookieCryptoState } from "@/lib/browser-view/use-browser-cookie-crypto-state";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { BrowserTileRef } from "@/stores/epics/canvas/types";
import { BrowserDebugPanels } from "@/components/epic-canvas/renderers/browser-debug-panels";
import { BrowserTileToolbar } from "@/components/epic-canvas/renderers/browser-tile-toolbar";
import { useBrowserAnnotationSession } from "@/hooks/browser/use-browser-annotation-session";
import { BrowserTileFindAdapterBridge } from "@/components/epic-canvas/renderers/browser-tile-find-adapter";
import { PRIMARY_TILE_CHROME_CAPABILITIES } from "@/components/epic-canvas/renderers/tile-controller";
import { BrowserViewSnapshotLayer } from "@/components/epic-canvas/renderers/browser-view-snapshot-layer";
import { useBrowserViewSnapshot } from "@/components/epic-canvas/renderers/use-browser-view-snapshot";
import { useBrowserViewBoundsBridge } from "@/components/epic-canvas/renderers/use-browser-view-bounds-bridge";
import {
  BrowserTileCertificateInterstitial,
  BrowserTileDownloadStrip,
} from "@/components/epic-canvas/renderers/browser-tile-status-panels";

interface BrowserTileProps {
  readonly node: BrowserTileRef;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly epicId: string;
}

interface BrowserAddressDraft {
  readonly sourceUrl: string | null;
  readonly value: string;
}

export function BrowserTile(props: BrowserTileProps) {
  const hostId = useTabHostId();
  const runnerHost = useRunnerHost();
  const visible = useTileBodyVisible();
  const browserView = runnerHost.browserView;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [browserStatus, setBrowserStatus] =
    useState<BrowserViewStatus>("loading");
  const [browserStatusReason, setBrowserStatusReason] = useState<string | null>(
    null,
  );
  const [addressDraft, setAddressDraft] = useState<BrowserAddressDraft>({
    sourceUrl: null,
    value: "",
  });
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [downloads, setDownloads] = useState<
    readonly BrowserViewDownloadChange[]
  >([]);
  const [certificateError, setCertificateError] =
    useState<BrowserViewCertificateErrorChange | null>(null);
  const [certificateProceeding, setCertificateProceeding] = useState(false);
  const updateBrowserTileDocument = useEpicCanvasStore(
    (state) => state.updateBrowserTileDocumentInTab,
  );
  const updateBrowserTileViewportPreset = useEpicCanvasStore(
    (state) => state.updateBrowserTileViewportPresetInTab,
  );
  const browserAttachmentTargetChatId = useEpicCanvasStore((state) =>
    selectSiblingChatIdForBrowserTile(
      state.canvasByTabId[props.viewTabId] ?? null,
      props.node.instanceId,
    ),
  );

  const tileKey = useMemo<BrowserViewTileKey>(
    () => ({
      viewTabId: props.viewTabId,
      paneId: props.paneId,
      tileInstanceId: props.node.instanceId,
      pageSessionId: props.node.id,
    }),
    [props.viewTabId, props.paneId, props.node.instanceId, props.node.id],
  );
  const addressValue =
    addressDraft.sourceUrl === props.node.url
      ? addressDraft.value
      : props.node.url;
  const status: BrowserViewStatus =
    browserView === null ? "dead" : browserStatus;
  const statusReason =
    browserView === null
      ? "Native browser views are unavailable."
      : browserStatusReason;

  useEffect(() => {
    if (browserView === null) return;
    return () => {
      void browserView.releaseTile(tileKey).catch(ignoreBrowserViewError);
    };
  }, [browserView, tileKey]);

  useEffect(() => {
    if (browserView === null) return;
    void browserView
      .upsertTile({
        ...tileKey,
        url: props.node.url,
        visible,
        viewportPreset: readBrowserViewportPreset(props.node.viewportPreset),
      })
      .catch(ignoreBrowserViewError);
  }, [
    browserView,
    tileKey,
    props.node.url,
    props.node.viewportPreset,
    visible,
  ]);

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onStatusChange((change) => {
      if (!isStatusForTile(change, tileKey)) return;
      setBrowserStatus(change.status);
      setBrowserStatusReason(change.reason);
      setCanGoBack(change.canGoBack);
      setCanGoForward(change.canGoForward);
      setZoomPercent(change.zoomPercent);
      // Loading and dead frames retain the last committed URL while a new
      // navigation is pending. Persisting those stale URLs would send the
      // native view back to the previous page through the upsert effect.
      if (change.status === "ready" && change.url.length > 0) {
        const name =
          change.title.trim().length > 0
            ? change.title
            : browserTileNameForUrl(change.url);
        if (change.url === props.node.url && name === props.node.name) return;
        updateBrowserTileDocument(props.viewTabId, props.node.instanceId, {
          url: change.url,
          name,
        });
      }
    });
    return () => {
      subscription.dispose();
    };
  }, [
    browserView,
    props.node.instanceId,
    props.node.name,
    props.node.url,
    props.viewTabId,
    tileKey,
    updateBrowserTileDocument,
  ]);

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onDownloadChange((change) => {
      if (!isStatusForTile(change, tileKey)) return;
      setDownloads((current) => upsertDownload(current, change));
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, tileKey]);

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onCertificateError((change) => {
      if (!isStatusForTile(change, tileKey)) return;
      setCertificateProceeding(false);
      setCertificateError(change);
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, tileKey]);

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onOpenTileRequest((request) => {
      if (!isStatusForTile(request, tileKey)) return;
      openFreshBrowserTileFromBrowserPage({
        viewTabId: props.viewTabId,
        paneId: props.paneId,
        hostId: props.node.hostId,
        url: request.url,
      });
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, props.node.hostId, props.paneId, props.viewTabId, tileKey]);

  useBrowserViewBoundsBridge({
    browserView,
    surfaceRef,
    tileKey,
    visible,
  });
  const snapshot = useBrowserViewSnapshot(tileKey);
  const cookieCryptoState = useBrowserCookieCryptoState(browserView);
  const annotation = useBrowserAnnotationSession({
    browserView,
    tileKey,
    status,
    epicId: props.epicId,
    browserHostId: props.node.hostId,
    preferredChatId: null,
    fallbackChatId: null,
  });

  const navigateToAddress = (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): void => {
    event.preventDefault();
    const nextUrl = normalizeBrowserAddressInput(addressValue);
    setAddressDraft({ sourceUrl: nextUrl, value: nextUrl });
    if (nextUrl === props.node.url) return;
    setBrowserStatus("loading");
    setBrowserStatusReason(null);
    setCertificateError(null);
    setCertificateProceeding(false);
    updateBrowserTileDocument(props.viewTabId, props.node.instanceId, {
      url: nextUrl,
      name: browserTileNameForUrl(nextUrl),
    });
  };

  const reload = (): void => {
    if (browserView === null) return;
    setBrowserStatus("loading");
    setBrowserStatusReason(null);
    setCertificateError(null);
    setCertificateProceeding(false);
    void browserView.reloadTile(tileKey).catch(ignoreBrowserViewError);
  };

  const goBack = (): void => {
    if (browserView === null || !canGoBack) return;
    setBrowserStatus("loading");
    setBrowserStatusReason(null);
    setCertificateError(null);
    setCertificateProceeding(false);
    void browserView.goBack(tileKey).catch(ignoreBrowserViewError);
  };

  const goForward = (): void => {
    if (browserView === null || !canGoForward) return;
    setBrowserStatus("loading");
    setBrowserStatusReason(null);
    setCertificateError(null);
    setCertificateProceeding(false);
    void browserView.goForward(tileKey).catch(ignoreBrowserViewError);
  };

  const zoomOut = (): void => {
    if (browserView === null) return;
    void browserView.zoomOut(tileKey).catch(ignoreBrowserViewError);
  };

  const zoomIn = (): void => {
    if (browserView === null) return;
    void browserView.zoomIn(tileKey).catch(ignoreBrowserViewError);
  };

  const resetZoom = (): void => {
    if (browserView === null) return;
    void browserView.resetZoom(tileKey).catch(ignoreBrowserViewError);
  };

  const setViewportPreset = (preset: BrowserViewViewportPresetId): void => {
    updateBrowserTileViewportPreset(
      props.viewTabId,
      props.node.instanceId,
      preset,
    );
    if (browserView === null) return;
    void browserView
      .setViewportPreset({ ...tileKey, viewportPreset: preset })
      .catch(ignoreBrowserViewError);
  };

  const openDevTools = (): void => {
    if (browserView === null) return;
    void browserView.openDevTools(tileKey).catch(ignoreBrowserViewError);
  };

  const cancelDownload = (downloadId: string): void => {
    if (browserView === null) return;
    void browserView
      .cancelDownload({ downloadId })
      .catch(ignoreBrowserViewError);
  };

  const proceedCertificate = (): void => {
    if (browserView === null || certificateError === null) return;
    setCertificateProceeding(true);
    void browserView
      .trustCertificate({
        ...tileKey,
        certificateErrorId: certificateError.certificateErrorId,
      })
      .then(() => {
        setCertificateError(null);
        setCertificateProceeding(false);
      })
      .catch((error: unknown) => {
        setCertificateProceeding(false);
        ignoreBrowserViewError(error);
      });
  };

  return (
    <div
      className="flex h-full w-full flex-col bg-canvas text-foreground"
      data-testid={`browser-tile-${props.node.instanceId}`}
    >
      <BrowserTileFindAdapterBridge
        browserView={browserView}
        tileKey={tileKey}
      />
      <BrowserTileToolbar
        pictureInPicture={null}
        controller={{
          capabilities: PRIMARY_TILE_CHROME_CAPABILITIES,
          url: props.node.url,
          addressValue,
          canGoBack,
          canGoForward,
          zoomPercent,
          viewportPreset: readBrowserViewportPreset(props.node.viewportPreset),
          disabled: browserView === null,
          cookieCryptoState,
          zoomLocked: annotation.zoomLocked,
          annotation,
          onNavigate: navigateToAddress,
          onAddressChange: (value) => {
            setAddressDraft({
              sourceUrl: props.node.url,
              value,
            });
          },
          onBack: goBack,
          onForward: goForward,
          onReload: reload,
          onZoomOut: zoomOut,
          onZoomIn: zoomIn,
          onResetZoom: resetZoom,
          onViewportPresetChange: setViewportPreset,
          onOpenDevTools: openDevTools,
        }}
      />
      {cookieCryptoState?.mode === "degraded" ? (
        <BrowserCookieDegradedBanner cryptoState={cookieCryptoState} />
      ) : null}
      <div
        ref={surfaceRef}
        className="relative min-h-0 flex-1 bg-background"
        {...{ [BROWSER_VIEW_SURFACE_ATTRIBUTE]: "" }}
      >
        <div
          className={cn(
            "absolute inset-0 flex min-h-0 flex-col items-center justify-center gap-3 px-4 text-center",
            status === "ready" && "pointer-events-none opacity-0",
          )}
        >
          <div className="text-ui-base font-medium">
            {status === "dead" ? "Browser view unavailable" : "Loading page"}
          </div>
          <div className="max-w-[min(90vw,32rem)] text-ui-sm text-muted-foreground">
            {statusReason ?? `Host ${hostId}`}
          </div>
          {status === "dead" && browserView !== null ? (
            <button
              type="button"
              className="rounded border border-border bg-muted px-3 py-1 text-ui-sm text-foreground hover:bg-muted/80"
              onClick={reload}
            >
              Reload
            </button>
          ) : null}
        </div>
        <BrowserViewSnapshotLayer snapshot={snapshot} />
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
      <BrowserDebugPanels
        browserView={browserView}
        tileKey={tileKey}
        pageUrl={props.node.url}
        status={status}
        targetChatId={browserAttachmentTargetChatId}
      />
    </div>
  );
}

function BrowserCookieDegradedBanner(props: {
  readonly cryptoState: BrowserCookieCryptoState;
}) {
  const inAppBrowserBetaEnabled = useSettingsStore(
    (state) => state.inAppBrowserBetaEnabled,
  );
  return (
    <div
      role="status"
      data-testid="browser-cookie-degraded-banner"
      className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-50 px-3 py-2 text-ui-sm text-amber-950 dark:bg-amber-950/35 dark:text-amber-100"
    >
      <AlertTriangle
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300"
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        {browserCookieDegradedMessage(
          props.cryptoState,
          inAppBrowserBetaEnabled,
        )}
      </span>
    </div>
  );
}

function readBrowserViewportPreset(value: string): BrowserViewViewportPresetId {
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

function upsertDownload(
  current: readonly BrowserViewDownloadChange[],
  change: BrowserViewDownloadChange,
): readonly BrowserViewDownloadChange[] {
  const existingIndex = current.findIndex(
    (download) => download.downloadId === change.downloadId,
  );
  if (existingIndex < 0) {
    return [...current, change].slice(-5);
  }
  return current
    .map((download, index) => (index === existingIndex ? change : download))
    .slice(-5);
}

function isStatusForTile(
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

function ignoreBrowserViewError(_error: unknown): void {}
