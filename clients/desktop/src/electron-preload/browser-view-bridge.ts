import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  BrowserViewBridge,
  BrowserCookieCryptoState,
  BrowserPrimaryProfileCaptureResult,
  BrowserViewCapturePageResult,
  BrowserViewCertificateErrorChange,
  BrowserViewDebugSnapshotChange,
  BrowserViewDownloadChange,
  BrowserViewFindChange,
  BrowserViewOpenTileRequest,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayReleaseResult,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewElectronTabHandoffChange,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabStatusChange,
  BrowserViewStatusChange,
  BrowserViewStorageStateApplyResult,
  BrowserViewStorageStateCaptureResult,
  BrowserCdpResult,
} from "../ipc-contracts/browser-view-types";
import type {
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationStartResult,
} from "../ipc-contracts/browser-annotation-types";
import type { PipCaptureIpcPayload } from "../ipc-contracts/pip-capture-types";
import { subscribe } from "./subscribe";

export function buildBrowserViewBridge(): { browserView: BrowserViewBridge } {
  return {
    browserView: {
      upsertTile: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewUpsert,
          input,
        ) as Promise<void>,
      ensureTab: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewEnsureTab,
          input,
        ) as Promise<BrowserViewNativeTabCapability>,
      acceptTab: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewAcceptTab,
          input,
        ) as Promise<void>,
      attachSurface: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewAttachSurface,
          input,
        ) as Promise<void>,
      detachSurface: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewDetachSurface,
          input,
        ) as Promise<void>,
      releaseTab: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewReleaseTab,
          input,
        ) as Promise<boolean>,
      controlElectronTab: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewControlElectronTab,
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
        await ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSetReservedChords,
          { tokens },
        );
      },
      overlayPaintAck: async (overlayId) => {
        await ipcRenderer.invoke(RunnerHostInvoke.browserViewOverlayPaintAck, {
          overlayId,
        });
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
      dispatchElectronTabCdp: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewElectronTabCdpDispatch,
          input,
        ) as Promise<BrowserCdpResult>,
      startPipCapture: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.pipCaptureStart,
          input,
        ) as Promise<void>,
      stopPipCapture: () =>
        ipcRenderer.invoke(RunnerHostInvoke.pipCaptureStop) as Promise<void>,
      onPipCaptureFrame: (handler) =>
        subscribe<PipCaptureIpcPayload>(
          RunnerHostEvent.pipCaptureFrame,
          (payload) => {
            handler(payload.frame, payload.jpegBytes);
          },
        ),
      onNativeTabStatusChange: (handler) =>
        subscribe<BrowserViewNativeTabStatusChange>(
          RunnerHostEvent.browserViewNativeTabStatusChange,
          handler,
        ),
      onElectronTabHandoff: (handler) =>
        subscribe<BrowserViewElectronTabHandoffChange>(
          RunnerHostEvent.browserViewElectronTabHandoff,
          handler,
        ),
    },
  };
}
