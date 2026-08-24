import {
  BrowserWindow,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
} from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import {
  parseBrowserViewCdpCommand,
  readCdpNullableString,
} from "./browser-view-cdp-payload";
import {
  parseBrowserViewAttachSurface,
  parseBrowserViewDetachSurface,
  parseBrowserViewElectronTabCdpDispatch,
  parseBrowserViewElectronTabControl,
  parseBrowserViewEnsureTab,
  parseBrowserViewNativeTabCapability,
  parseBrowserViewReleaseTab,
} from "./browser-view-native-tab-payload";
import type {
  BrowserViewCdpDispatch,
  BrowserLabsStateUpdate,
  BrowserViewBounds,
  BrowserViewBoundsUpdate,
  BrowserViewCertificateTrust,
  BrowserViewControlAction,
  BrowserViewControlGrant,
  BrowserViewControlRevoke,
  BrowserViewDownloadCancel,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayRelease,
  BrowserViewStorageStateApply,
  BrowserViewStorageStateCapture,
  BrowserViewTileKey,
  BrowserViewTileUpsert,
  BrowserViewViewportPresetChange,
  BrowserViewViewportPresetId,
} from "../../ipc-contracts/browser-view-types";
import { setInAppBrowserBetaEnabledMarker } from "../app/browser-labs-state";
import {
  BOUNDS_STREAM_LOG_INTERVAL_MS,
  BrowserViewManager,
  scheduleBrowserViewDebugSnapshot,
  type BrowserViewWindow,
  type ManagedBrowserView,
} from "../browser-view/browser-view-manager";
import { hostPlatformFromProcessPlatform } from "../../ipc-contracts/reserved-chords";
import { installBrowserViewManagerDebug } from "../browser-view/browser-view-manager-debug";
import {
  createBrowserViewWebPreferences,
  cancelBrowserViewDownload,
  clearBrowserViewPendingCertificateError,
  ensureBrowserViewSession,
  onBrowserViewCertificateError,
  onBrowserViewDownloadChange,
  readBrowserViewPendingCertificateError,
  registerBrowserViewWebContents,
} from "../browser-view/browser-session";
import { getBrowserCookieCryptoState } from "../browser-view/browser-cookie-crypto";
import {
  applyBrowserViewStorageState,
  captureBrowserOriginLocalStorage,
  captureBrowserPrimaryProfile,
  captureBrowserViewStorageState,
} from "../browser-view/browser-storage-state";
import { trustBrowserCertificate } from "../app/cert-trust";
import { log } from "../app/logger";
import type {
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationSetTargetChatLabelInput,
} from "../../ipc-contracts/browser-annotation-types";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerBrowserViewIpc(
  bridge: RunnerIpcBridge,
): BrowserViewManager {
  const manager = new BrowserViewManager({
    createView: createElectronBrowserView,
    getWindow: (windowId) =>
      toBrowserViewWindow(
        bridge.windowRegistry.getRecordById(windowId)?.window,
      ),
    createPopupWindowOptions: (windowId) =>
      createBrowserPopupWindowOptions(bridge, windowId),
    createDevToolsWindow: (windowId) =>
      createBrowserDevToolsWindow(bridge, windowId),
    registerPopupWebContents: (webContents) => {
      registerBrowserViewWebContents(webContents);
    },
    onDownloadChange: onBrowserViewDownloadChange,
    onCertificateError: onBrowserViewCertificateError,
    onWindowChange: (listener) => {
      bridge.windowRegistry.on("change", listener);
      return () => {
        bridge.windowRegistry.off("change", listener);
      };
    },
    notifyStatus: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewStatusChange,
        change,
      );
    },
    notifyNativeTabStatus: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewNativeTabStatusChange,
        change,
      );
    },
    notifyFind: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewFindChange,
        change,
      );
    },
    notifyDownload: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewDownloadChange,
        change,
      );
    },
    notifyCertificateError: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewCertificateError,
        change,
      );
    },
    notifyOpenTileRequest: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewOpenTileRequest,
        change,
      );
    },
    notifySnapshotInvalidated: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewSnapshotInvalidated,
        change,
      );
    },
    notifyDebugSnapshot: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewDebugSnapshotChange,
        change,
      );
    },
    notifyControlRevoked: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewControlRevoked,
        change,
      );
    },
    // Ticket 09: a visible tile CAN now be driven over the ticket-03 CDP
    // bridge, as a *borrowed* tile the user asked the agent to drive, so
    // these are real rather than the no-ops they were when the agent's own
    // tile was the bridge's only consumer. The T18 control-grant revocation
    // through `notifyControlRevoked` above still fires independently - the
    // two mechanisms address the same tile but are separate surfaces, and a
    // detached debugger has to end both.
    notifyCdpSessionEnded: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewCdpSessionEnded,
        change,
      );
    },
    notifyCdpTargetAttached: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewCdpTargetAttached,
        change,
      );
    },
    notifyNativeTabCdpSessionEnded: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewNativeTabCdpSessionEnded,
        change,
      );
    },
    notifyNativeTabCdpTargetAttached: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewNativeTabCdpTargetAttached,
        change,
      );
    },
    notifyElectronTabHandoff: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewElectronTabHandoff,
        change,
      );
    },
    notifyAnnotationEvent: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewAnnotationEvent,
        change,
      );
    },
    notifyAnnotationAttached: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.browserViewAnnotationAttached,
        change,
      );
    },
    scheduleDebugSnapshot: scheduleBrowserViewDebugSnapshot,
    applyStorageState: applyBrowserViewStorageState,
    captureStorageState: captureBrowserViewStorageState,
    capturePrimaryProfile: captureBrowserPrimaryProfile,
    capturePrimaryProfileLocalStorage: captureBrowserOriginLocalStorage,
    boundsStreamLogIntervalMs: BOUNDS_STREAM_LOG_INTERVAL_MS,
    hostPlatform: hostPlatformFromProcessPlatform(process.platform),
  });

  // BT-501: E2E-only debug surface. Production never sets TRAYCER_E2E.
  if (process.env.TRAYCER_E2E === "1") {
    installBrowserViewManagerDebug({
      boundsByKeyId: () => manager.debugBoundsByKeyId(),
      occludedKeyIds: () => manager.debugOccludedKeyIds(),
      frameCacheStats: () => manager.frameCacheStats(),
      evictedKeyIds: () => manager.debugEvictedKeyIds(),
    });
  }

  bridge.handleInvoke(RunnerHostInvoke.browserViewUpsert, (event, payload) => {
    const windowId = readSenderWindowId(bridge, event);
    manager.upsertTile(windowId, parseTileUpsert(payload));
  });

  bridge.handleInvoke(RunnerHostInvoke.browserViewEnsureTab, (event, payload) =>
    manager.ensureTab(
      readSenderWindowId(bridge, event),
      parseBrowserViewEnsureTab(payload),
    ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAcceptTab,
    (_event, payload) =>
      manager.acceptTab(parseBrowserViewNativeTabCapability(payload)),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAttachSurface,
    (event, payload) => {
      const attached = manager.attachSurface(
        readSenderWindowId(bridge, event),
        parseBrowserViewAttachSurface(payload),
      );
      if (!attached) throw new Error("Electron browser tab is not available.");
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewDetachSurface,
    (event, payload) => {
      manager.detachSurface(
        readSenderWindowId(bridge, event),
        parseBrowserViewDetachSurface(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewReleaseTab,
    (event, payload) => {
      readSenderWindowId(bridge, event);
      return manager.releaseTab(parseBrowserViewReleaseTab(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewControlElectronTab,
    async (event, payload) => {
      const controlled = await manager.controlElectronTab(
        readSenderWindowId(bridge, event),
        parseBrowserViewElectronTabControl(payload),
      );
      if (!controlled)
        throw new Error("Electron browser tab is not available.");
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewElectronTabCdpDispatch,
    (event, payload) => {
      readSenderWindowId(bridge, event);
      return manager.dispatchElectronTabCdp(
        parseBrowserViewElectronTabCdpDispatch(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewUpdateBounds,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.updateBounds(windowId, parseBoundsUpdate(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSetViewportPreset,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.setViewportPreset(windowId, parseViewportPresetChange(payload));
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewRelease, (event, payload) => {
    const windowId = readSenderWindowId(bridge, event);
    manager.releaseTile(windowId, parseTileKey(payload));
  });

  // BT-202 flicker fix: renderer confirms the replacement frame is decoded
  // and on screen; only then does the manager move the native view offscreen.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewOverlayPaintAck,
    (_event, payload) => {
      if (!isRecordValue(payload)) return;
      if (typeof payload.overlayId !== "string") return;
      manager.paintAckOverlay(payload.overlayId);
    },
  );

  // BT-302/BT-303: the renderer is the source of truth for which app chords
  // outrank guest keystrokes; it pushes its binding tokens at startup.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSetReservedChords,
    (_event, payload) => {
      manager.setReservedChords(readReservedChordTokens(payload));
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewReload, (event, payload) => {
    const windowId = readSenderWindowId(bridge, event);
    manager.reloadTile(windowId, parseTileKey(payload));
  });

  bridge.handleInvoke(RunnerHostInvoke.browserViewGoBack, (event, payload) => {
    const windowId = readSenderWindowId(bridge, event);
    manager.goBack(windowId, parseTileKey(payload));
  });

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewGoForward,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.goForward(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.findInPage(windowId, parseFindRequest(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStopFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.stopFindInPage(windowId, parseFindStop(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCancelDownload,
    (_event, payload) => {
      cancelBrowserViewDownload(parseDownloadCancel(payload).downloadId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewTrustCertificate,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const input = parseCertificateTrust(payload);
      if (!manager.canTrustCertificateError(windowId, input)) {
        throw new Error(
          "Browser certificate error is not active for this tile",
        );
      }
      const pending = readBrowserViewPendingCertificateError(
        input.certificateErrorId,
      );
      if (pending === null) {
        throw new Error("Browser certificate error is no longer pending");
      }
      await trustBrowserCertificate(pending.hostname, pending.certificate);
      clearBrowserViewPendingCertificateError(input.certificateErrorId);
      manager.clearCertificateError(windowId, input);
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewZoomIn, (event, payload) => {
    const windowId = readSenderWindowId(bridge, event);
    manager.zoomIn(windowId, parseTileKey(payload));
  });

  bridge.handleInvoke(RunnerHostInvoke.browserViewZoomOut, (event, payload) => {
    const windowId = readSenderWindowId(bridge, event);
    manager.zoomOut(windowId, parseTileKey(payload));
  });

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewResetZoom,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.resetZoom(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewOccludeForOverlay,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.occludeForOverlay(
        windowId,
        parseOverlayOcclusion(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewReleaseOverlay,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.releaseOverlay(windowId, parseOverlayRelease(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCapturePage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.capturePage(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewGetDebugSnapshot,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.getDebugSnapshot(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewClearDebugEvents,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.clearDebugEvents(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStorageStateApply,
    (_event, payload) =>
      manager.applyStorageState(parseStorageStateApply(payload)),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStorageStateCapture,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.captureStorageState(
        windowId,
        parseStorageStateCapture(payload),
      );
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewPrimaryProfileCapture, () =>
    manager.capturePrimaryProfile(),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewControlGrant,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.grantControl(windowId, parseControlGrant(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewControlRevoke,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.revokeControl(windowId, parseControlRevoke(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewControlAction,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.executeControlAction(
        windowId,
        parseControlAction(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStartAnnotation,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.startAnnotation(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCancelAnnotation,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.cancelAnnotation(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSetAnnotationTargetChatLabel,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.setAnnotationTargetChatLabel(
        windowId,
        parseAnnotationTargetChatLabel(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAnnotationAttachResult,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.reportAnnotationAttachResult(
        windowId,
        parseAnnotationAttachResult(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewOpenDevTools,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.openDevTools(windowId, parseTileKey(payload));
    },
  );

  // Borrowed-surface CDP remains presentation-keyed by design. Host-owned
  // Electron tabs use browserViewElectronTabCdpDispatch above and never
  // fall back through this route.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCdpDispatch,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.dispatchCdp(windowId, parseCdpDispatch(payload));
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewCookieCryptoStateGet, () =>
    getBrowserCookieCryptoState(),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewLabsStateSet,
    (_event, payload) =>
      setInAppBrowserBetaEnabledMarker(
        parseLabsStateUpdate(payload).inAppBrowserBetaEnabled,
      ).then(() => undefined),
  );

  bridge.disposeFns.push(() => {
    manager.dispose();
  });
  return manager;
}

function createElectronBrowserView(): ManagedBrowserView {
  // Browser page webContents are intentionally not registered as trusted IPC
  // senders. They get no preload / Node integration; the Traycer renderer
  // mediates all browser-view IPC through RunnerIpcBridge's existing sender
  // gate.
  ensureBrowserViewSession();
  const view = new WebContentsView({
    webPreferences: createBrowserViewWebPreferences(),
  });
  registerBrowserViewWebContents(view.webContents);
  return view;
}

function createBrowserPopupWindowOptions(
  bridge: RunnerIpcBridge,
  windowId: string,
): BrowserWindowConstructorOptions {
  const parentWindow = bridge.windowRegistry.getRecordById(windowId)?.window;
  return {
    parent: isElectronBrowserWindow(parentWindow) ? parentWindow : undefined,
    show: true,
    width: 900,
    height: 700,
    backgroundColor: "#0b0b0d",
    webPreferences: createBrowserViewWebPreferences(),
  };
}

function createBrowserDevToolsWindow(
  bridge: RunnerIpcBridge,
  windowId: string,
): BrowserWindow {
  const parentWindow = bridge.windowRegistry.getRecordById(windowId)?.window;
  return new BrowserWindow({
    parent: isElectronBrowserWindow(parentWindow) ? parentWindow : undefined,
    show: true,
    width: 1200,
    height: 800,
    backgroundColor: "#0b0b0d",
  });
}

function isElectronBrowserWindow(value: unknown): value is BrowserWindow {
  if (typeof BrowserWindow !== "function") return false;
  return value instanceof BrowserWindow;
}

function toBrowserViewWindow(value: unknown): BrowserViewWindow | null {
  if (!isElectronBrowserWindow(value)) return null;
  return {
    contentView: {
      addChildView: (view) => {
        if (!(view instanceof WebContentsView)) {
          throw new Error("Browser manager produced a non-Electron view");
        }
        value.contentView.addChildView(view);
      },
      removeChildView: (view) => {
        if (!(view instanceof WebContentsView)) return;
        value.contentView.removeChildView(view);
      },
    },
    webContents: value.webContents,
    isDestroyed: () => value.isDestroyed(),
    isVisible: () => value.isVisible(),
    isMinimized: () => value.isMinimized(),
  };
}

function readSenderWindowId(
  bridge: RunnerIpcBridge,
  event: IpcMainInvokeEvent,
): string {
  const windowId = bridge.resolveSenderWindowId(event);
  if (windowId === null) {
    throw new Error("Browser view IPC sender window is not registered");
  }
  return windowId;
}

function parseTileUpsert(value: unknown): BrowserViewTileUpsert {
  const record = assertRecord(value, "Browser view upsert payload");
  return {
    ...parseTileKey(record),
    url: readString(record.url, "url"),
    visible: readBoolean(record.visible, "visible"),
    viewportPreset: readViewportPresetId(record.viewportPreset),
  };
}

function parseBoundsUpdate(value: unknown): BrowserViewBoundsUpdate {
  const record = assertRecord(value, "Browser view bounds payload");
  return {
    ...parseTileKey(record),
    bounds: parseBounds(record.bounds),
  };
}

function parseViewportPresetChange(
  value: unknown,
): BrowserViewViewportPresetChange {
  const record = assertRecord(value, "Browser view viewport preset payload");
  return {
    ...parseTileKey(record),
    viewportPreset: readViewportPresetId(record.viewportPreset),
  };
}

function parseCdpDispatch(value: unknown): BrowserViewCdpDispatch {
  const record = assertRecord(value, "Browser view CDP dispatch payload");
  return {
    ...parseTileKey(record),
    sessionId: readCdpNullableString(record.sessionId, "sessionId"),
    command: parseBrowserViewCdpCommand(record.command),
  };
}

function parseTileKey(value: unknown): BrowserViewTileKey {
  const record = assertRecord(value, "Browser view tile key");
  return {
    viewTabId: readString(record.viewTabId, "viewTabId"),
    paneId: readString(record.paneId, "paneId"),
    tileInstanceId: readString(record.tileInstanceId, "tileInstanceId"),
    pageSessionId: readString(record.pageSessionId, "pageSessionId"),
  };
}

function parseAnnotationTargetChatLabel(
  value: unknown,
): BrowserAnnotationSetTargetChatLabelInput {
  const record = assertRecord(value, "Annotation target-chat label payload");
  return {
    ...parseTileKey(record),
    targets: Array.isArray(record.targets)
      ? record.targets.map((value) => {
          const target = assertRecord(value, "Annotation target chat");
          return {
            chatId: readString(target.chatId, "chatId"),
            label: readString(target.label, "label"),
          };
        })
      : [],
    defaultChatId:
      record.defaultChatId === null
        ? null
        : readString(record.defaultChatId, "defaultChatId"),
  };
}

function parseAnnotationAttachResult(
  value: unknown,
): BrowserAnnotationAttachResultInput {
  const record = assertRecord(value, "Annotation attach-result payload");
  const status = readString(record.status, "status");
  if (status !== "attached" && status !== "failed") {
    throw new Error("Browser view annotation attach result status is invalid");
  }
  return {
    annotationId: readString(record.annotationId, "annotationId"),
    status,
  };
}

function parseFindRequest(value: unknown): BrowserViewFindRequest {
  const record = assertRecord(value, "Browser view find payload");
  return {
    ...parseTileKey(record),
    requestId: readFiniteNumber(record.requestId, "requestId"),
    query: readString(record.query, "query"),
    matchCase: readBoolean(record.matchCase, "matchCase"),
    forward: readBoolean(record.forward, "forward"),
    findNext: readBoolean(record.findNext, "findNext"),
  };
}

function parseFindStop(value: unknown): BrowserViewFindStop {
  const record = assertRecord(value, "Browser view find stop payload");
  return {
    ...parseTileKey(record),
    requestId: readFiniteNumber(record.requestId, "requestId"),
  };
}

function parseDownloadCancel(value: unknown): BrowserViewDownloadCancel {
  const record = assertRecord(value, "Browser view download cancel payload");
  return {
    downloadId: readString(record.downloadId, "downloadId"),
  };
}

function parseCertificateTrust(value: unknown): BrowserViewCertificateTrust {
  const record = assertRecord(value, "Browser view certificate trust payload");
  return {
    ...parseTileKey(record),
    certificateErrorId: readString(
      record.certificateErrorId,
      "certificateErrorId",
    ),
  };
}

function parseOverlayOcclusion(value: unknown): BrowserViewOverlayOcclusion {
  const record = assertRecord(value, "Browser view overlay occlusion payload");
  const tilesValue = record.tiles;
  if (!Array.isArray(tilesValue)) {
    throw new Error("Browser view overlay tiles must be an array");
  }
  return {
    overlayId: readString(record.overlayId, "overlayId"),
    tiles: tilesValue.map((tile) => parseTileKey(tile)),
  };
}

function parseOverlayRelease(value: unknown): BrowserViewOverlayRelease {
  const record = assertRecord(value, "Browser view overlay release payload");
  return {
    overlayId: readString(record.overlayId, "overlayId"),
  };
}

function parseLabsStateUpdate(value: unknown): BrowserLabsStateUpdate {
  const record = assertRecord(value, "Browser labs state update payload");
  return {
    inAppBrowserBetaEnabled: readBoolean(
      record.inAppBrowserBetaEnabled,
      "inAppBrowserBetaEnabled",
    ),
  };
}

function parseStorageStateApply(value: unknown): BrowserViewStorageStateApply {
  const record = assertRecord(value, "Browser storageState apply payload");
  return {
    storageState: record.storageState,
    sessionId: readNullableString(record.sessionId, "sessionId"),
    tabId: readNullableString(record.tabId, "tabId"),
    purpose: readStorageStateApplyPurpose(record.purpose),
  };
}

function readStorageStateApplyPurpose(
  value: unknown,
): BrowserViewStorageStateApply["purpose"] {
  if (value === "primary-profile-seed" || value === "sync-back") return value;
  throw new Error("Browser storageState apply purpose is invalid");
}

function parseStorageStateCapture(
  value: unknown,
): BrowserViewStorageStateCapture {
  const record = assertRecord(value, "Browser storageState capture payload");
  return {
    ...parseTileKey(record),
    origin: readString(record.origin, "origin"),
  };
}

function parseControlGrant(value: unknown): BrowserViewControlGrant {
  const record = assertRecord(value, "Browser view control grant payload");
  return {
    ...parseTileKey(record),
    controlId: readString(record.controlId, "controlId"),
    chatId: readString(record.chatId, "chatId"),
    agentRunId: readNullableString(record.agentRunId, "agentRunId"),
    agentLabel: readString(record.agentLabel, "agentLabel"),
    origin: readString(record.origin, "origin"),
    expiresAt: readFiniteNumber(record.expiresAt, "expiresAt"),
  };
}

function parseControlRevoke(value: unknown): BrowserViewControlRevoke {
  const record = assertRecord(value, "Browser view control revoke payload");
  return {
    ...parseTileKey(record),
    controlId: readString(record.controlId, "controlId"),
    reason: readString(record.reason, "reason"),
  };
}

function parseControlAction(value: unknown): BrowserViewControlAction {
  const record = assertRecord(value, "Browser view control action payload");
  return {
    ...parseTileKey(record),
    controlId: readString(record.controlId, "controlId"),
    actionId: readString(record.actionId, "actionId"),
    sensitiveApprovalId: readNullableString(
      record.sensitiveApprovalId,
      "sensitiveApprovalId",
    ),
    action: readControlActionCommand(record.action),
  };
}

function parseBounds(value: unknown): BrowserViewBounds {
  const record = assertRecord(value, "Browser view bounds");
  return {
    x: readFiniteNumber(record.x, "x"),
    y: readFiniteNumber(record.y, "y"),
    width: readFiniteNumber(record.width, "width"),
    height: readFiniteNumber(record.height, "height"),
  };
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} must be an object`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`Browser view ${field} must be a string`);
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Browser view ${field} must be a non-empty string`);
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`Browser view ${field} must be a boolean`);
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`Browser view ${field} must be a string or null`);
}

function readControlActionCommand(
  value: unknown,
): BrowserViewControlAction["action"] {
  const record = assertRecord(value, "Browser view control action command");
  if (record.kind === "click") {
    return {
      kind: "click",
      selector: readString(record.selector, "selector"),
    };
  }
  if (record.kind === "type") {
    return {
      kind: "type",
      selector: readString(record.selector, "selector"),
      text: readString(record.text, "text"),
    };
  }
  if (record.kind === "scroll") {
    return {
      kind: "scroll",
      deltaX: readFiniteNumber(record.deltaX, "deltaX"),
      deltaY: readFiniteNumber(record.deltaY, "deltaY"),
    };
  }
  if (record.kind === "navigate") {
    return {
      kind: "navigate",
      url: readString(record.url, "url"),
    };
  }
  throw new Error("Browser view control action kind is not supported");
}

function readViewportPresetId(value: unknown): BrowserViewViewportPresetId {
  if (
    value === "responsive" ||
    value === "mobile" ||
    value === "tablet" ||
    value === "desktop"
  ) {
    return value;
  }
  throw new Error("Browser view viewportPreset is invalid");
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Browser view ${field} must be a finite number`);
}

function readReservedChordTokens(payload: unknown): readonly string[] {
  if (!isRecordValue(payload)) return [];
  const raw = payload.tokens;
  if (!Array.isArray(raw)) return [];
  return raw.filter((token): token is string => typeof token === "string");
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
