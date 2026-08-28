import {
  BrowserWindow,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
} from "electron";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import {
  browserViewIpcPayload,
  parseReservedChordTokens,
} from "./browser-view-ipc-payload";
import type { IpcManagedWindow } from "./runner-ipc-bridge";
import {
  BOUNDS_STREAM_LOG_INTERVAL_MS,
  BrowserViewManager,
} from "../browser-view/browser-view-manager";
import type {
  BrowserViewWindow,
  ManagedBrowserView,
} from "../browser-view/browser-view-port";
import { hostPlatformFromProcessPlatform } from "../browser-view/manager/browser-view-chords";
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
import { getBrowserCookieCryptoState } from "../browser-view/storage/browser-cookie-crypto";
import {
  BrowserPrimaryProfileSnapshotCoordinator,
  captureBrowserOriginLocalStorage,
  captureBrowserPrimaryProfile,
  captureBrowserViewStorageState,
  seedBrowserViewCookies,
} from "../browser-view/storage/browser-storage-state";
import { trustBrowserCertificate } from "../app/cert-trust";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export function registerBrowserViewIpc(
  bridge: RunnerIpcBridge,
): BrowserViewManager {
  const primaryProfileSnapshots = new BrowserPrimaryProfileSnapshotCoordinator(
    (origins) =>
      captureBrowserPrimaryProfile(origins, {
        readCryptoState: getBrowserCookieCryptoState,
        getSession: ensureBrowserViewSession,
      }),
    captureBrowserOriginLocalStorage,
  );
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
      // Native views follow both the windows list and pure geometry
      // transitions (minimize/restore/maximize), which the list does not
      // carry - see WindowRegistry's `geometry` signal.
      bridge.windowRegistry.on("change", listener);
      bridge.windowRegistry.on("geometry", listener);
      return () => {
        bridge.windowRegistry.off("change", listener);
        bridge.windowRegistry.off("geometry", listener);
      };
    },
    notifyHostWindowRendererReset: (windowId) => {
      bridge.markRendererUnavailable(windowId);
    },
    send: (windowId, channel, payload) =>
      bridge.safeSendToWindow(windowId, channel, payload),
    seedStorageState: seedBrowserViewCookies,
    captureStorageState: captureBrowserViewStorageState,
    observePrimaryProfileOrigin: (url, webContents) => {
      primaryProfileSnapshots.observe(url, webContents);
    },
    boundsStreamLogIntervalMs: BOUNDS_STREAM_LOG_INTERVAL_MS,
    hostPlatform: hostPlatformFromProcessPlatform(process.platform),
  });

  bridge.handleInvoke(RunnerHostInvoke.browserViewEnsureTab, (event, payload) =>
    manager.ensureTab(
      readSenderWindowId(bridge, event),
      browserViewIpcPayload.ensureTab.parse(payload),
    ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAcceptTab,
    (_event, payload) =>
      manager.acceptTab(
        browserViewIpcPayload.nativeTabCapability.parse(payload),
      ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAttachSurface,
    (event, payload) => {
      const attached = manager.attachSurface(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.attachSurface.parse(payload),
      );
      if (!attached) throw new Error("Electron browser tab is not available.");
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewDetachSurface,
    (event, payload) => {
      manager.detachSurface(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.detachSurface.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewReleaseTab,
    (_event, payload) =>
      manager.releaseTab(
        browserViewIpcPayload.nativeTabCapability.parse(payload),
      ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewControlElectronTab,
    async (event, payload) => {
      const controlled = await manager.controlElectronTab(
        readSenderWindowId(bridge, event),
        browserViewIpcPayload.electronTabControl.parse(payload),
      );
      if (!controlled)
        throw new Error("Electron browser tab is not available.");
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewElectronTabCdpDispatch,
    (_event, payload) =>
      manager.dispatchElectronTabCdp(
        browserViewIpcPayload.electronTabCdpDispatch.parse(payload),
      ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewUpdateBounds,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.updateBounds(
        windowId,
        browserViewIpcPayload.boundsUpdate.parse(payload),
      );
    },
  );

  // BT-202 flicker fix: renderer confirms the replacement frame is decoded
  // and on screen; only then does the manager move the native view offscreen.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewOverlayPaintAck,
    (_event, payload) => {
      const parsed = browserViewIpcPayload.overlayPaintAck.safeParse(payload);
      if (parsed.success) manager.overlay.paintAck(parsed.data.overlayId);
    },
  );

  // BT-302/BT-303: the renderer is the source of truth for which app chords
  // outrank guest keystrokes; it pushes its binding tokens at startup.
  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSetReservedChords,
    (_event, payload) => {
      manager.chords.setTokens(parseReservedChordTokens(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.find.find(
        windowId,
        browserViewIpcPayload.findRequest.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStopFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.find.stop(
        windowId,
        browserViewIpcPayload.findStop.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCancelDownload,
    (_event, payload) => {
      cancelBrowserViewDownload(
        browserViewIpcPayload.downloadCancel.parse(payload).downloadId,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewTrustCertificate,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const input = browserViewIpcPayload.certificateTrust.parse(payload);
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

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewOccludeForOverlay,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.overlay.occlude(
        windowId,
        browserViewIpcPayload.overlayOcclusion.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewReleaseOverlay,
    (_event, payload) =>
      manager.overlay.release(
        browserViewIpcPayload.overlayRelease.parse(payload),
      ),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCapturePage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.capturePage(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewGetDebugSnapshot,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.getDebugSnapshot(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewPrimaryProfileCapture, () =>
    primaryProfileSnapshots.capture(),
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewStartAnnotation,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.annotations.start(
        windowId,
        browserViewIpcPayload.annotationStart.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewCancelAnnotation,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.annotations.cancel(
        windowId,
        browserViewIpcPayload.tileKey.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewSetAnnotationTargetChatLabel,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.annotations.setTargetChatLabel(
        windowId,
        browserViewIpcPayload.annotationTargetChatLabel.parse(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.browserViewAnnotationAttachResult,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.annotations.reportAttachResult(
        windowId,
        browserViewIpcPayload.annotationAttachResult.parse(payload),
      );
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.browserViewCookieCryptoStateGet, () =>
    getBrowserCookieCryptoState(),
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

function isElectronBrowserWindow(
  value: IpcManagedWindow | undefined,
): value is BrowserWindow {
  return value instanceof BrowserWindow;
}

function toBrowserViewWindow(
  value: IpcManagedWindow | undefined,
): BrowserViewWindow | null {
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
