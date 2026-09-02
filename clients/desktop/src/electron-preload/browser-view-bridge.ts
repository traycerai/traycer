import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  BrowserSessionsStreamEventEnvelope,
  BrowserViewBridge,
  BrowserViewCapturePageResult,
  BrowserViewCertificateErrorChange,
  BrowserViewDebugSnapshot,
  BrowserViewDownloadChange,
  BrowserViewFindChange,
  BrowserViewOpenTileRequest,
  BrowserViewOverlayOcclusionResult,
  BrowserViewOverlayReleaseResult,
  BrowserViewSnapshotInvalidatedChange,
  BrowserViewTileCommandEvent,
  BrowserViewTileKey,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabStatusChange,
} from "@traycer-clients/shared/platform/browser-view";
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
      openSessionsStream: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSessionsOpen,
          input,
        ) as Promise<void>,
      closeSessionsStream: (key) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSessionsClose,
          key,
        ) as Promise<void>,
      sendSessionsFrame: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSessionsSend,
          input,
        ) as Promise<void>,
      onSessionsStreamEvent: (handler) =>
        subscribe<BrowserSessionsStreamEventEnvelope>(
          RunnerHostEvent.browserViewSessionsEvent,
          handler,
        ),
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
      setReservedChords: async (chords) => {
        await ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSetReservedChords,
          { chords },
        );
      },
      overlayPaintAck: async (overlayId) => {
        await ipcRenderer.invoke(RunnerHostInvoke.browserViewOverlayPaintAck, {
          overlayId,
        });
      },
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
      capturePage: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewCapturePage,
          input,
        ) as Promise<BrowserViewCapturePageResult>,
      getDebugSnapshot: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewGetDebugSnapshot,
          input,
        ) as Promise<BrowserViewDebugSnapshot>,
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
      getSaveLogins: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSaveLoginsGet,
        ) as Promise<boolean>,
      setSaveLogins: (enabled) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewSaveLoginsSet,
          enabled,
        ) as Promise<boolean>,
      forgetLogins: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewForgetLogins,
        ) as Promise<boolean>,
      // A domain, and main confirms it before a single frame leaves: the
      // renderer may ask for one row to be cleared, and may not perform it.
      clearSavedLoginSite: (domain) =>
        ipcRenderer.invoke(RunnerHostInvoke.browserViewClearSavedLoginSite, {
          domain,
        }) as Promise<boolean>,
      // The tile key, not a domain: main derives the site from that tile's own
      // URL, so no renderer can name a site it is not looking at.
      clearSite: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.browserViewClearSite,
          input,
        ) as Promise<void>,
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
      onTileCommand: (handler) =>
        subscribe<BrowserViewTileCommandEvent>(
          RunnerHostEvent.browserViewTileCommand,
          handler,
        ),
      onSnapshotInvalidated: (handler) =>
        subscribe<BrowserViewSnapshotInvalidatedChange>(
          RunnerHostEvent.browserViewSnapshotInvalidated,
          handler,
        ),
      onOverlayTileRestored: (handler) =>
        subscribe<BrowserViewTileKey>(
          RunnerHostEvent.browserViewOverlayRestored,
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
    },
  };
}
