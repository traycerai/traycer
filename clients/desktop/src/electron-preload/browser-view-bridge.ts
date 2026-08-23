import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  AgentBrowserViewCdpDispatch,
  AgentBrowserViewCdpResult,
  AgentBrowserViewCdpSessionEndedChange,
  AgentBrowserViewCdpTargetAttachedChange,
  AgentBrowserViewTileHandoffChange,
  BrowserCookieCryptoState,
  BrowserViewBackgroundTabCreate,
  BrowserViewBackgroundThrottlingChange,
  BrowserLabsStateUpdate,
  BrowserPrimaryProfileCaptureResult,
  BrowserViewBoundsUpdate,
  BrowserViewCapturePageResult,
  BrowserViewCertificateErrorChange,
  BrowserViewCertificateTrust,
  BrowserViewControlAction,
  BrowserViewControlActionResult,
  BrowserViewControlGrant,
  BrowserViewControlGrantResult,
  BrowserViewControlRevokedChange,
  BrowserViewControlRevoke,
  BrowserViewDebugSnapshotChange,
  BrowserViewDownloadCancel,
  BrowserViewDownloadChange,
  BrowserViewDurableTabRegistration,
  BrowserViewFindChange,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOpenTileRequest,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayRelease,
  BrowserViewOverlayReleaseResult,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewStatusChange,
  BrowserViewStorageStateApply,
  BrowserViewStorageStateApplyResult,
  BrowserViewStorageStateCapture,
  BrowserViewStorageStateCaptureResult,
  BrowserViewTileKey,
  BrowserViewTileUpsert,
  BrowserViewViewportPresetChange,
} from "../ipc-contracts/browser-view-types";
import type {
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartResult,
} from "../ipc-contracts/browser-annotation-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface BrowserViewBridgeSurface {
  browserView: {
    upsertTile(input: BrowserViewTileUpsert): Promise<void>;
    createBackgroundTab(input: BrowserViewBackgroundTabCreate): Promise<void>;
    registerDurableTab(input: BrowserViewDurableTabRegistration): Promise<void>;
    releaseDurableTab(
      input: BrowserViewDurableTabRegistration,
    ): Promise<void>;
    setBackgroundThrottling(
      input: BrowserViewBackgroundThrottlingChange,
    ): Promise<void>;
    updateBounds(input: BrowserViewBoundsUpdate): Promise<void>;
    setViewportPreset(input: BrowserViewViewportPresetChange): Promise<void>;
    releaseTile(input: BrowserViewTileKey): Promise<void>;
    /** BT-303: register renderer chords that outrank guest keystrokes. */
    setReservedChords(tokens: readonly string[]): Promise<void>;
    /**
     * BT-202 flicker fix: renderer confirms the replacement frame is decoded
     * and on screen; both managers park their owned tiles on this ack.
     */
    overlayPaintAck(overlayId: string): Promise<void>;
    reloadTile(input: BrowserViewTileKey): Promise<void>;
    goBack(input: BrowserViewTileKey): Promise<void>;
    goForward(input: BrowserViewTileKey): Promise<void>;
    findInPage(input: BrowserViewFindRequest): Promise<void>;
    stopFindInPage(input: BrowserViewFindStop): Promise<void>;
    cancelDownload(input: BrowserViewDownloadCancel): Promise<void>;
    trustCertificate(input: BrowserViewCertificateTrust): Promise<void>;
    zoomIn(input: BrowserViewTileKey): Promise<void>;
    zoomOut(input: BrowserViewTileKey): Promise<void>;
    resetZoom(input: BrowserViewTileKey): Promise<void>;
    capturePage(
      input: BrowserViewTileKey,
    ): Promise<BrowserViewCapturePageResult>;
    getDebugSnapshot(
      input: BrowserViewTileKey,
    ): Promise<BrowserViewDebugSnapshotChange>;
    clearDebugEvents(input: BrowserViewTileKey): Promise<void>;
    startAnnotation(
      input: BrowserViewTileKey,
    ): Promise<BrowserAnnotationStartResult>;
    cancelAnnotation(input: BrowserViewTileKey): Promise<void>;
    setAnnotationTargetChatLabel(
      input: BrowserAnnotationSetTargetChatLabelInput,
    ): Promise<void>;
    reportAnnotationAttachResult(
      input: BrowserAnnotationAttachResultInput,
    ): Promise<void>;
    openDevTools(input: BrowserViewTileKey): Promise<void>;
    occludeForOverlay(
      input: BrowserViewOverlayOcclusion,
    ): Promise<BrowserViewOverlayOcclusionResult>;
    releaseOverlay(
      input: BrowserViewOverlayRelease,
    ): Promise<BrowserViewOverlayReleaseResult>;
    getCookieCryptoState(): Promise<BrowserCookieCryptoState>;
    setLabsState(input: BrowserLabsStateUpdate): Promise<void>;
    applyStorageState(
      input: BrowserViewStorageStateApply,
    ): Promise<BrowserViewStorageStateApplyResult>;
    captureStorageState(
      input: BrowserViewStorageStateCapture,
    ): Promise<BrowserViewStorageStateCaptureResult>;
    capturePrimaryProfile(): Promise<BrowserPrimaryProfileCaptureResult>;
    grantControl(
      input: BrowserViewControlGrant,
    ): Promise<BrowserViewControlGrantResult>;
    revokeControl(input: BrowserViewControlRevoke): Promise<void>;
    executeControlAction(
      input: BrowserViewControlAction,
    ): Promise<BrowserViewControlActionResult>;
    onStatusChange(handler: Listener<BrowserViewStatusChange>): Disposable;
    onFindChange(handler: Listener<BrowserViewFindChange>): Disposable;
    onDownloadChange(handler: Listener<BrowserViewDownloadChange>): Disposable;
    onCertificateError(
      handler: Listener<BrowserViewCertificateErrorChange>,
    ): Disposable;
    onOpenTileRequest(
      handler: Listener<BrowserViewOpenTileRequest>,
    ): Disposable;
    onSnapshotInvalidated(
      handler: Listener<BrowserViewSnapshotInvalidatedChange>,
    ): Disposable;
    onDebugSnapshotChange(
      handler: Listener<BrowserViewDebugSnapshotChange>,
    ): Disposable;
    onControlRevoked(
      handler: Listener<BrowserViewControlRevokedChange>,
    ): Disposable;
    onAnnotationEvent(
      handler: Listener<BrowserAnnotationSessionIpcEvent>,
    ): Disposable;
    onAnnotationAttached(
      handler: Listener<BrowserAnnotationAttachedIpcEvent>,
    ): Disposable;
    // Durable user-tab driving over the same typed CDP bridge as agent tabs.
    dispatchCdp(
      input: AgentBrowserViewCdpDispatch,
    ): Promise<AgentBrowserViewCdpResult>;
    onCdpSessionEnded(
      handler: Listener<AgentBrowserViewCdpSessionEndedChange>,
    ): Disposable;
    onCdpTargetAttached(
      handler: Listener<AgentBrowserViewCdpTargetAttachedChange>,
    ): Disposable;
    onTileHandoff(
      handler: Listener<AgentBrowserViewTileHandoffChange>,
    ): Disposable;
  };
}

export function buildBrowserViewBridge(): BrowserViewBridgeSurface {
  return {
    browserView: {
      upsertTile: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewUpsert,
          input,
        ) as Promise<void>,
      createBackgroundTab: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewCreateBackgroundTab,
          input,
        ) as Promise<void>,
      registerDurableTab: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewRegisterDurableTab,
          input,
        ) as Promise<void>,
      releaseDurableTab: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewReleaseDurableTab,
          input,
        ) as Promise<void>,
      setBackgroundThrottling: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSetBackgroundThrottling,
          input,
        ) as Promise<void>,
      updateBounds: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewUpdateBounds,
          input,
        ) as Promise<void>,
      setViewportPreset: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSetViewportPreset,
          input,
        ) as Promise<void>,
      releaseTile: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewRelease,
          input,
        ) as Promise<void>,
      setReservedChords: async (tokens) => {
        // BT-303: BOTH manager instances must learn the chord set — user
        // durable tabs live on the primary runtime, isolated session tiles
        // on the agent runtime; interception has to cover both.
        const primary = ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSetReservedChords,
          { tokens },
        );
        const agent = ipcRenderer
          .invoke(RunnerHostInvoke.agentBrowserViewSetReservedChords, {
            tokens,
          })
          .catch(() => undefined);
        await Promise.all([primary, agent]);
      },
      overlayPaintAck: async (overlayId) => {
        const primary = ipcRenderer.invoke(
          RunnerHostInvoke.browserViewOverlayPaintAck,
          { overlayId },
        );
        const agent = ipcRenderer
          .invoke(RunnerHostInvoke.agentBrowserViewOverlayPaintAck, {
            overlayId,
          })
          .catch(() => undefined);
        await Promise.all([primary, agent]);
      },
      reloadTile: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewReload,
          input,
        ) as Promise<void>,
      goBack: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewGoBack,
          input,
        ) as Promise<void>,
      goForward: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewGoForward,
          input,
        ) as Promise<void>,
      findInPage: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewFindInPage,
          input,
        ) as Promise<void>,
      stopFindInPage: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewStopFindInPage,
          input,
        ) as Promise<void>,
      cancelDownload: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewCancelDownload,
          input,
        ) as Promise<void>,
      trustCertificate: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewTrustCertificate,
          input,
        ) as Promise<void>,
      zoomIn: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewZoomIn,
          input,
        ) as Promise<void>,
      zoomOut: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewZoomOut,
          input,
        ) as Promise<void>,
      resetZoom: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewResetZoom,
          input,
        ) as Promise<void>,
      capturePage: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewCapturePage,
          input,
        ) as Promise<BrowserViewCapturePageResult>,
      getDebugSnapshot: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewGetDebugSnapshot,
          input,
        ) as Promise<BrowserViewDebugSnapshotChange>,
      clearDebugEvents: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewClearDebugEvents,
          input,
        ) as Promise<void>,
      startAnnotation: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewStartAnnotation,
          input,
        ) as Promise<BrowserAnnotationStartResult>,
      cancelAnnotation: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewCancelAnnotation,
          input,
        ) as Promise<void>,
      setAnnotationTargetChatLabel: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSetAnnotationTargetChatLabel,
          input,
        ) as Promise<void>,
      reportAnnotationAttachResult: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewAnnotationAttachResult,
          input,
        ) as Promise<void>,
      openDevTools: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewOpenDevTools,
          input,
        ) as Promise<void>,
      occludeForOverlay: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewOccludeForOverlay,
          input,
        ) as Promise<BrowserViewOverlayOcclusionResult>,
      releaseOverlay: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewReleaseOverlay,
          input,
        ) as Promise<BrowserViewOverlayReleaseResult>,
      getCookieCryptoState: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewCookieCryptoStateGet,
        ) as Promise<BrowserCookieCryptoState>,
      setLabsState: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewLabsStateSet,
          input,
        ) as Promise<void>,
      applyStorageState: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewStorageStateApply,
          input,
        ) as Promise<BrowserViewStorageStateApplyResult>,
      captureStorageState: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewStorageStateCapture,
          input,
        ) as Promise<BrowserViewStorageStateCaptureResult>,
      capturePrimaryProfile: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewPrimaryProfileCapture,
        ) as Promise<BrowserPrimaryProfileCaptureResult>,
      grantControl: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewControlGrant,
          input,
        ) as Promise<BrowserViewControlGrantResult>,
      revokeControl: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewControlRevoke,
          input,
        ) as Promise<void>,
      executeControlAction: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewControlAction,
          input,
        ) as Promise<BrowserViewControlActionResult>,
      onStatusChange: (handler) =>
        subscribe<BrowserViewStatusChange>(
          RunnerHostEvent.browserViewStatusChange,
          handler,
        ),
      onFindChange: (handler) =>
        subscribe<BrowserViewFindChange>(
          RunnerHostEvent.browserViewFindChange,
          handler,
        ),
      onDownloadChange: (handler) =>
        subscribe<BrowserViewDownloadChange>(
          RunnerHostEvent.browserViewDownloadChange,
          handler,
        ),
      onCertificateError: (handler) =>
        subscribe<BrowserViewCertificateErrorChange>(
          RunnerHostEvent.browserViewCertificateError,
          handler,
        ),
      onOpenTileRequest: (handler) =>
        subscribe<BrowserViewOpenTileRequest>(
          RunnerHostEvent.browserViewOpenTileRequest,
          handler,
        ),
      onSnapshotInvalidated: (handler) =>
        subscribe<BrowserViewSnapshotInvalidatedChange>(
          RunnerHostEvent.browserViewSnapshotInvalidated,
          handler,
        ),
      onDebugSnapshotChange: (handler) =>
        subscribe<BrowserViewDebugSnapshotChange>(
          RunnerHostEvent.browserViewDebugSnapshotChange,
          handler,
        ),
      onControlRevoked: (handler) =>
        subscribe<BrowserViewControlRevokedChange>(
          RunnerHostEvent.browserViewControlRevoked,
          handler,
        ),
      onAnnotationEvent: (handler) =>
        subscribe<BrowserAnnotationSessionIpcEvent>(
          RunnerHostEvent.browserViewAnnotationEvent,
          handler,
        ),
      onAnnotationAttached: (handler) =>
        subscribe<BrowserAnnotationAttachedIpcEvent>(
          RunnerHostEvent.browserViewAnnotationAttached,
          handler,
        ),
      dispatchCdp: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewCdpDispatch,
          input,
        ) as Promise<AgentBrowserViewCdpResult>,
      onCdpSessionEnded: (handler) =>
        subscribe<AgentBrowserViewCdpSessionEndedChange>(
          RunnerHostEvent.browserViewCdpSessionEnded,
          handler,
        ),
      onCdpTargetAttached: (handler) =>
        subscribe<AgentBrowserViewCdpTargetAttachedChange>(
          RunnerHostEvent.browserViewCdpTargetAttached,
          handler,
        ),
      onTileHandoff: (handler) =>
        subscribe<AgentBrowserViewTileHandoffChange>(
          RunnerHostEvent.browserViewTileHandoff,
          handler,
        ),
    },
  };
}
