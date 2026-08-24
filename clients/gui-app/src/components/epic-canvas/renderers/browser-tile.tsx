import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { AlertTriangle, ShieldCheck, Square } from "lucide-react";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import { Button } from "@/components/ui/button";
import { BROWSER_VIEW_SURFACE_ATTRIBUTE } from "@/lib/browser-view/browser-overlay-coordinator";
import { browserCookieDegradedMessage } from "@/lib/browser-view/browser-cookie-degraded-message";
import { selectSiblingChatIdForBrowserTile } from "@/lib/browser-view/browser-tile-chat-routing";
import {
  type BrowserViewCertificateErrorChange,
  type BrowserViewDownloadChange,
  type BrowserViewStatus,
  type BrowserViewTileKey,
  type BrowserViewViewportPresetId,
  type BrowserCookieCryptoState,
  type BrowserViewControlActionResult,
  resolveDesktopBrowserViewBridge,
} from "@/lib/browser-view/desktop-browser-view";
import {
  browserTileNameForUrl,
  normalizeBrowserAddressInput,
  openFreshBrowserTileFromBrowserPage,
} from "@/lib/browser-view/browser-link-routing-core";
import { useBrowserCookieCryptoState } from "@/lib/browser-view/use-browser-cookie-crypto-state";
import {
  activateBrowserTileControl,
  clearBrowserTileActiveControl,
  clearBrowserTileControlRequest,
  registerBrowserTileControlActionHandler,
  useBrowserTileControlState,
  type BrowserTileControlRequest,
  type BrowserTileActiveControl,
  type BrowserTileControlActionRequest,
} from "@/lib/browser-view/browser-tile-control-store";
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
import { attachBorrowedTileCdpSurface } from "@/lib/browser-view/borrowed-tile-cdp";

export interface BrowserTileProps {
  readonly node: BrowserTileRef;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly epicId: string;
}

interface BrowserAddressDraft {
  readonly sourceUrl: string | null;
  readonly value: string;
}

type BrowserTileSensitiveActionPrompt = {
  readonly request: BrowserTileControlActionRequest;
  readonly approvalId: string;
  readonly reason: string;
  readonly expiresAt: number;
};

/**
 * Ceiling for how long the human sensitive-action prompt stays open, kept
 * comfortably under the host's `MAX_VISIBLE_TILE_ACTION_TIMEOUT_MS` (30s,
 * browser-session-manager.ts). That clock starts the moment the host
 * broadcasts the action, before this prompt even renders, so a window equal
 * to 30s would still let a stale approval land after the host gave up
 * waiting and re-issued the action to the agent as a timeout - which is how
 * a sensitive value used to get typed twice.
 */
/** Exported for tests that assert the local approval window stays under host wait. */
export const SENSITIVE_ACTION_APPROVAL_WINDOW_MS = 20_000;

export function BrowserTile(props: BrowserTileProps) {
  const hostId = useTabHostId();
  const runnerHost = useRunnerHost();
  const visible = useTileBodyVisible();
  const browserView = useMemo(
    () => resolveDesktopBrowserViewBridge(runnerHost),
    [runnerHost],
  );
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
  const [sensitiveActionPrompt, setSensitiveActionPrompt] =
    useState<BrowserTileSensitiveActionPrompt | null>(null);
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
    return attachBorrowedTileCdpSurface({ bridge: browserView, tileKey });
  }, [browserView, tileKey]);

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
  const controlState = useBrowserTileControlState(props.node.instanceId);
  const annotation = useBrowserAnnotationSession({
    browserView,
    tileKey,
    status,
    epicId: props.epicId,
    browserHostId: props.node.hostId,
    preferredChatId:
      controlState.active?.chatId ?? controlState.pending?.chatId ?? null,
    fallbackChatId: null,
  });

  useEffect(() => {
    if (browserView === null) return;
    const subscription = browserView.onControlRevoked((change) => {
      if (!isStatusForTile(change, tileKey)) return;
      const active = controlState.active;
      if (active === null || active.requestId !== change.controlId) return;
      active.sendFrame({
        kind: "visibleTileControlRevoked",
        hasBinaryPayload: false,
        requestId: crypto.randomUUID(),
        grantId: active.grant.grantId,
        tileInstanceId: active.tileInstanceId,
        reason: change.reason,
      });
      if (sensitiveActionPrompt !== null) {
        sendBrowserTileControlActionFailure(
          sensitiveActionPrompt.request,
          change.reason,
        );
        setSensitiveActionPrompt(null);
      }
      clearBrowserTileActiveControl({
        tileInstanceId: active.tileInstanceId,
        controlId: active.requestId,
      });
    });
    return () => {
      subscription.dispose();
    };
  }, [browserView, controlState.active, sensitiveActionPrompt, tileKey]);

  useEffect(() => {
    return registerBrowserTileControlActionHandler(
      props.node.instanceId,
      (request) => {
        const active = controlState.active;
        if (browserView === null || active === null) {
          request.sendFrame({
            kind: "visibleTileControlActionResult",
            hasBinaryPayload: false,
            requestId: request.requestId,
            grantId: request.grantId,
            ok: false,
            reason: "Visible browser tile control is not active.",
            value: null,
          });
          return;
        }
        if (active.grant.grantId !== request.grantId) {
          request.sendFrame({
            kind: "visibleTileControlActionResult",
            hasBinaryPayload: false,
            requestId: request.requestId,
            grantId: request.grantId,
            ok: false,
            reason: "Visible browser tile grant is not active.",
            value: null,
          });
          return;
        }
        void browserView
          .executeControlAction({
            ...tileKey,
            controlId: active.requestId,
            actionId: request.requestId,
            sensitiveApprovalId: null,
            action: request.action,
          })
          .then((result) => {
            if (result.status === "needs-approval") {
              setSensitiveActionPrompt({
                request,
                approvalId: result.approvalId,
                reason: result.reason,
                expiresAt: Date.now() + SENSITIVE_ACTION_APPROVAL_WINDOW_MS,
              });
              return;
            }
            sendBrowserTileControlActionResult(request, result);
          })
          .catch((error: unknown) => {
            sendBrowserTileControlActionFailure(
              request,
              error instanceof Error ? error.message : String(error),
            );
          });
      },
    );
  }, [browserView, controlState.active, props.node.instanceId, tileKey]);

  useEffect(() => {
    if (sensitiveActionPrompt === null) return;
    const timeoutMs = Math.max(0, sensitiveActionPrompt.expiresAt - Date.now());
    const timer = setTimeout(() => {
      sendBrowserTileControlActionFailure(
        sensitiveActionPrompt.request,
        "Timed out waiting for sensitive browser action approval.",
      );
      setSensitiveActionPrompt((current) =>
        current?.approvalId === sensitiveActionPrompt.approvalId
          ? null
          : current,
      );
    }, timeoutMs);
    return () => {
      clearTimeout(timer);
    };
  }, [sensitiveActionPrompt]);

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

  const approveControlRequest = (request: BrowserTileControlRequest): void => {
    if (browserView === null || controlState.active !== null) return;
    const currentOrigin = originFromUrl(props.node.url);
    if (currentOrigin !== request.origin) {
      request.sendFrame({
        kind: "visibleTileControlDecision",
        hasBinaryPayload: false,
        requestId: request.requestId,
        approved: false,
        grant: null,
        reason: "The visible tile navigated to a different origin.",
      });
      clearBrowserTileControlRequest({
        tileInstanceId: request.tileInstanceId,
        requestId: request.requestId,
      });
      return;
    }
    const grant = {
      grantId: request.grantId,
      chatId: request.chatId,
      tileInstanceId: request.tileInstanceId,
      origin: request.origin,
      dataLevel: "control" as const,
      expiresAt: request.expiresAt,
    };
    void browserView
      .grantControl({
        ...tileKey,
        controlId: request.requestId,
        chatId: request.chatId,
        agentRunId: request.agentRunId,
        agentLabel: request.agentLabel,
        origin: request.origin,
        expiresAt: request.expiresAt,
      })
      .then((result) => {
        if (result.status === "queued") {
          return;
        }
        if (result.status !== "granted") {
          request.sendFrame({
            kind: "visibleTileControlDecision",
            hasBinaryPayload: false,
            requestId: request.requestId,
            approved: false,
            grant: null,
            reason: result.reason,
          });
          clearBrowserTileControlRequest({
            tileInstanceId: request.tileInstanceId,
            requestId: request.requestId,
          });
          return;
        }
        request.sendFrame({
          kind: "visibleTileControlDecision",
          hasBinaryPayload: false,
          requestId: request.requestId,
          approved: true,
          grant,
          reason: null,
        });
        activateBrowserTileControl({ request, grant });
      })
      .catch((error: unknown) => {
        request.sendFrame({
          kind: "visibleTileControlDecision",
          hasBinaryPayload: false,
          requestId: request.requestId,
          approved: false,
          grant: null,
          reason: error instanceof Error ? error.message : String(error),
        });
        clearBrowserTileControlRequest({
          tileInstanceId: request.tileInstanceId,
          requestId: request.requestId,
        });
      });
  };

  const stopControl = (active: BrowserTileActiveControl): void => {
    if (browserView !== null) {
      void browserView
        .revokeControl({
          ...tileKey,
          controlId: active.requestId,
          reason: "User stopped browser control.",
        })
        .catch(ignoreBrowserViewError);
      return;
    }
    active.sendFrame({
      kind: "visibleTileControlRevoked",
      hasBinaryPayload: false,
      requestId: crypto.randomUUID(),
      grantId: active.grant.grantId,
      tileInstanceId: active.tileInstanceId,
      reason: "User stopped browser control.",
    });
    clearBrowserTileActiveControl({
      tileInstanceId: active.tileInstanceId,
      controlId: active.requestId,
    });
  };

  const approveSensitiveAction = (
    prompt: BrowserTileSensitiveActionPrompt,
  ): void => {
    if (Date.now() >= prompt.expiresAt) {
      // The host's own wait for this action has almost certainly already
      // expired and been reported to the agent as a timeout by this point
      // (see `SENSITIVE_ACTION_APPROVAL_WINDOW_MS`). A click that lands here
      // is approving a request the host no longer has - execute it and the
      // agent's retry types the same value again. Treat it as expired
      // instead of live: this is the same failure the auto-expiry effect
      // reports, kept as an explicit check because a backgrounded/throttled
      // tab can delay that effect's timer past this point.
      sendBrowserTileControlActionFailure(
        prompt.request,
        "Sensitive browser action approval window expired.",
      );
      setSensitiveActionPrompt(null);
      return;
    }
    const active = controlState.active;
    if (browserView === null || active === null) {
      sendBrowserTileControlActionFailure(
        prompt.request,
        "Visible browser tile control is not active.",
      );
      setSensitiveActionPrompt(null);
      return;
    }
    if (active.grant.grantId !== prompt.request.grantId) {
      sendBrowserTileControlActionFailure(
        prompt.request,
        "Visible browser tile grant is not active.",
      );
      setSensitiveActionPrompt(null);
      return;
    }
    setSensitiveActionPrompt(null);
    void browserView
      .executeControlAction({
        ...tileKey,
        controlId: active.requestId,
        actionId: prompt.request.requestId,
        sensitiveApprovalId: prompt.approvalId,
        action: prompt.request.action,
      })
      .then((result) => {
        if (result.status === "needs-approval") {
          sendBrowserTileControlActionFailure(
            prompt.request,
            "Sensitive browser action approval was not accepted.",
          );
          return;
        }
        sendBrowserTileControlActionResult(prompt.request, result);
      })
      .catch((error: unknown) => {
        sendBrowserTileControlActionFailure(
          prompt.request,
          error instanceof Error ? error.message : String(error),
        );
      });
  };

  const denySensitiveAction = (
    prompt: BrowserTileSensitiveActionPrompt,
  ): void => {
    sendBrowserTileControlActionFailure(
      prompt.request,
      "User denied sensitive browser action.",
    );
    setSensitiveActionPrompt(null);
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
      <BrowserTileSensitiveActionBanner
        prompt={sensitiveActionPrompt}
        onApprove={approveSensitiveAction}
        onDeny={denySensitiveAction}
      />
      <BrowserTileControlBanner
        pending={controlState.pending}
        active={controlState.active}
        busy={browserView === null || controlState.active !== null}
        onApprove={approveControlRequest}
        onDeny={denyControlRequest}
        onStop={stopControl}
      />
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

function denyControlRequest(request: BrowserTileControlRequest): void {
  request.sendFrame({
    kind: "visibleTileControlDecision",
    hasBinaryPayload: false,
    requestId: request.requestId,
    approved: false,
    grant: null,
    reason: "User denied visible tile control.",
  });
  clearBrowserTileControlRequest({
    tileInstanceId: request.tileInstanceId,
    requestId: request.requestId,
  });
}

function sendBrowserTileControlActionResult(
  request: BrowserTileControlActionRequest,
  result: BrowserViewControlActionResult,
): void {
  request.sendFrame({
    kind: "visibleTileControlActionResult",
    hasBinaryPayload: false,
    requestId: request.requestId,
    grantId: request.grantId,
    ok: result.status === "completed",
    reason: result.status === "completed" ? null : result.reason,
    value: result.status === "completed" ? result.value : null,
  });
}

function sendBrowserTileControlActionFailure(
  request: BrowserTileControlActionRequest,
  reason: string,
): void {
  request.sendFrame({
    kind: "visibleTileControlActionResult",
    hasBinaryPayload: false,
    requestId: request.requestId,
    grantId: request.grantId,
    ok: false,
    reason,
    value: null,
  });
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

function BrowserTileSensitiveActionBanner(props: {
  readonly prompt: BrowserTileSensitiveActionPrompt | null;
  readonly onApprove: (prompt: BrowserTileSensitiveActionPrompt) => void;
  readonly onDeny: (prompt: BrowserTileSensitiveActionPrompt) => void;
}) {
  const prompt = props.prompt;
  if (prompt === null) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-rose-500/35 bg-rose-500/10 px-3 py-1.5 text-ui-xs">
      <ShieldCheck className="size-3.5 shrink-0 text-rose-600" />
      <div className="min-w-0 flex-1 truncate text-rose-950 dark:text-rose-100">
        Sensitive browser typing requires approval
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-ui-xs"
        onClick={() => props.onDeny(prompt)}
      >
        Deny
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2 text-ui-xs"
        onClick={() => props.onApprove(prompt)}
      >
        Approve
      </Button>
    </div>
  );
}

function BrowserTileControlBanner(props: {
  readonly pending: BrowserTileControlRequest | null;
  readonly active: BrowserTileActiveControl | null;
  readonly busy: boolean;
  readonly onApprove: (request: BrowserTileControlRequest) => void;
  readonly onDeny: (request: BrowserTileControlRequest) => void;
  readonly onStop: (active: BrowserTileActiveControl) => void;
}) {
  const active = props.active;
  if (active !== null) {
    return (
      <div className="flex min-w-0 items-center gap-2 border-b border-emerald-500/35 bg-emerald-500/10 px-3 py-1.5 text-ui-xs">
        <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1 truncate text-emerald-900 dark:text-emerald-100">
          {active.agentLabel} is controlling this browser from chat{" "}
          {active.chatId}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-ui-xs"
          onClick={() => props.onStop(active)}
        >
          <Square className="size-3" />
          Stop
        </Button>
      </div>
    );
  }
  const pending = props.pending;
  if (pending === null) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-amber-500/35 bg-amber-500/10 px-3 py-1.5 text-ui-xs">
      <ShieldCheck className="size-3.5 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1 truncate text-amber-950 dark:text-amber-100">
        {pending.agentLabel} requests control of this browser for{" "}
        {pending.origin}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-ui-xs"
        onClick={() => props.onDeny(pending)}
      >
        Deny
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2 text-ui-xs"
        disabled={props.busy}
        onClick={() => props.onApprove(pending)}
      >
        Grant
      </Button>
    </div>
  );
}

function originFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
  } catch {
    return "";
  }
  return "";
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
