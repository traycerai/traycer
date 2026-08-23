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
import type {
  AgentBrowserViewCdpDispatch,
  BrowserViewBounds,
  BrowserViewBoundsUpdate,
  BrowserViewCertificateTrust,
  BrowserViewDownloadCancel,
  BrowserViewDurableTabRegistration,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOpenTileRequest,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayRelease,
  BrowserViewTileKey,
  BrowserViewTileUpsert,
  BrowserViewViewportPresetChange,
  BrowserViewViewportPresetId,
} from "../../ipc-contracts/browser-view-types";
import {
  BOUNDS_STREAM_LOG_INTERVAL_MS,
  BrowserViewManager,
  scheduleBrowserViewDebugSnapshot,
  type BrowserViewHostWebContents,
  type BrowserViewWindow,
  type ManagedBrowserView,
  type ManagedContentView,
} from "../browser-view/browser-view-manager";
import { hostPlatformFromProcessPlatform } from "../../ipc-contracts/reserved-chords";
import {
  cancelBrowserViewDownload,
  clearBrowserViewPendingCertificateError,
  createAgentBrowserViewWebPreferences,
  ensureAgentBrowserViewSession,
  onBrowserViewCertificateError,
  onBrowserViewDownloadChange,
  readBrowserViewPendingCertificateError,
  registerBrowserViewWebContents,
} from "../browser-view/browser-session";
import { trustBrowserCertificate } from "../app/cert-trust";
import { applyAgentBrowserBackgroundPosture } from "../browser-view/agent-browser-posture";
import { parseBrowserViewCdpCommand } from "./browser-view-cdp-payload";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

const AGENT_BROWSER_VIEW_RELEASE_GRACE_MS = 500;

/**
 * IPC surface for the agent's own browser tile (ticket 02). This deliberately
 * mirrors only the subset of `registerBrowserViewIpc` needed to create,
 * position, show and release a tile in `AGENT_BROWSER_VIEW_PARTITION` -
 * driving (control grant/action), storage-state lending, find, zoom and
 * devtools belong to later tickets (03+) that build the agent's actual
 * REPL-driven surface, so they are not wired here. Snapshot invalidation
 * is wired so the overlay coordinator can stale agent-tile bitmaps.
 * Popups stay in the agent partition (never the user's) since that is a
 * containment property, not a driving feature.
 */
export function registerAgentBrowserViewIpc(
  bridge: RunnerIpcBridge,
): BrowserViewManager {
  const manager = new BrowserViewManager({
    createView: createAgentBrowserView,
    getWindow: (windowId) =>
      toBrowserViewWindow(
        bridge.windowRegistry.getRecordById(windowId)?.window,
      ),
    createPopupWindowOptions: (windowId) =>
      createAgentBrowserPopupWindowOptions(bridge, windowId),
    createDevToolsWindow: (windowId) => createDevToolsWindow(bridge, windowId),
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
        RunnerHostEvent.agentBrowserViewStatusChange,
        change,
      );
    },
    notifyFind: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.agentBrowserViewFindChange,
        change,
      );
    },
    notifyDownload: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.agentBrowserViewDownloadChange,
        change,
      );
    },
    notifyCertificateError: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.agentBrowserViewCertificateError,
        change,
      );
    },
    notifyOpenTileRequest: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.agentBrowserViewOpenTileRequest,
        change satisfies BrowserViewOpenTileRequest,
      );
    },
    notifySnapshotInvalidated: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.agentBrowserViewSnapshotInvalidated,
        change,
      );
    },
    notifyDebugSnapshot: () => {},
    notifyControlRevoked: () => {},
    notifyCdpSessionEnded: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.agentBrowserViewCdpSessionEnded,
        change,
      );
    },
    notifyCdpTargetAttached: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.agentBrowserViewCdpTargetAttached,
        change,
      );
    },
    notifyTileHandoff: (windowId, change) => {
      bridge.safeSendToWindow(
        windowId,
        RunnerHostEvent.agentBrowserViewTileHandoff,
        change,
      );
    },
    notifyAnnotationEvent: () => {},
    notifyAnnotationAttached: () => {},
    scheduleDebugSnapshot: scheduleBrowserViewDebugSnapshot,
    applyStorageState: () =>
      Promise.reject(
        new Error(
          "Storage-state lending is not supported on the agent browser partition",
        ),
      ),
    captureStorageState: () =>
      Promise.reject(
        new Error(
          "Storage-state capture is not supported on the agent browser partition",
        ),
      ),
    capturePrimaryProfile: () =>
      Promise.resolve({
        status: "unavailable",
        storageState: null,
        reason:
          "Primary-profile capture is not supported on the agent partition",
      }),
    capturePrimaryProfileLocalStorage: () => Promise.resolve(null),
    releaseGraceMs: AGENT_BROWSER_VIEW_RELEASE_GRACE_MS,
    electronCreateDelayMs: 0,
    boundsStreamLogIntervalMs: BOUNDS_STREAM_LOG_INTERVAL_MS,
    hostPlatform: hostPlatformFromProcessPlatform(process.platform),
  });

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewUpsert,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.upsertTile(windowId, parseTileUpsert(payload));
    },
  );

  // BT-302/BT-303: the agent manager owns isolated-runtime session tiles, so
  // reserved-chord registration MUST reach it too — otherwise ⌘K etc. die on
  // exactly the tiles users browse in. Mirrors the occlusion broadcast shape
  // (each manager stores its own copy; the renderer pushes to both).
  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewSetReservedChords,
    (_event, payload) => {
      manager.setReservedChords(readReservedChordTokens(payload));
    },
  );

  // BT-202 flicker fix: paint acknowledgement for the agent runtime's own
  // tiles (mirrors the primary manager handler).
  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewOverlayPaintAck,
    (_event, payload) => {
      if (!isRecordValue(payload)) return;
      if (typeof payload.overlayId !== "string") return;
      manager.paintAckOverlay(payload.overlayId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewRegisterDurableTab,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.registerDurableTab(
        windowId,
        parseDurableTabRegistration(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewUpdateBounds,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.updateBounds(windowId, parseBoundsUpdate(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewRelease,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.releaseTile(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewCdpDispatch,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.dispatchCdp(windowId, parseCdpDispatch(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewOccludeForOverlay,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.occludeForOverlay(
        windowId,
        parseOverlayOcclusion(payload),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewReleaseOverlay,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      return manager.releaseOverlay(windowId, parseOverlayRelease(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewSetViewportPreset,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.setViewportPreset(windowId, parseViewportPresetChange(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewReload,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.reloadTile(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewGoBack,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.goBack(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewGoForward,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.goForward(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.findInPage(windowId, parseFindRequest(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewStopFindInPage,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.stopFindInPage(windowId, parseFindStop(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewCancelDownload,
    (_event, payload) => {
      cancelBrowserViewDownload(parseDownloadCancel(payload).downloadId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewTrustCertificate,
    async (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      const input = parseCertificateTrust(payload);
      if (!manager.canTrustCertificateError(windowId, input)) {
        throw new Error(
          "Agent browser certificate error is not active for this tile",
        );
      }
      const pending = readBrowserViewPendingCertificateError(
        input.certificateErrorId,
      );
      if (pending === null) {
        throw new Error("Agent browser certificate error is no longer pending");
      }
      await trustBrowserCertificate(pending.hostname, pending.certificate);
      clearBrowserViewPendingCertificateError(input.certificateErrorId);
      manager.clearCertificateError(windowId, input);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewZoomIn,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.zoomIn(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewZoomOut,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.zoomOut(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewResetZoom,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.resetZoom(windowId, parseTileKey(payload));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.agentBrowserViewOpenDevTools,
    (event, payload) => {
      const windowId = readSenderWindowId(bridge, event);
      manager.openDevTools(windowId, parseTileKey(payload));
    },
  );

  bridge.disposeFns.push(() => {
    manager.dispose();
  });
  return manager;
}

function createAgentBrowserView(): ManagedBrowserView {
  // Same non-trusted-IPC-sender posture as the user's browser view: no
  // preload / Node integration, mediated entirely through this file's
  // handlers.
  ensureAgentBrowserViewSession();
  const view = new WebContentsView({
    webPreferences: createAgentBrowserViewWebPreferences(),
  });
  registerBrowserViewWebContents(view.webContents);
  applyAgentBrowserBackgroundPosture(view.webContents);
  return view;
}

function createAgentBrowserPopupWindowOptions(
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
    // Popups opened from a page in the agent's browser must stay in the
    // agent partition - reusing the user's popup options here would be
    // exactly the "second route around" the partition boundary the ticket
    // warns against.
    webPreferences: createAgentBrowserViewWebPreferences(),
  };
}

function createDevToolsWindow(
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

function readSenderWindowId(
  bridge: RunnerIpcBridge,
  event: IpcMainInvokeEvent,
): string {
  const windowId = bridge.resolveSenderWindowId(event);
  if (windowId === null) {
    throw new Error("Agent browser view IPC sender window is not registered");
  }
  return windowId;
}

function parseTileUpsert(value: unknown): BrowserViewTileUpsert {
  const record = assertRecord(value, "Agent browser view upsert payload");
  return {
    ...parseTileKey(record),
    url: readString(record.url, "url"),
    visible: readBoolean(record.visible, "visible"),
    viewportPreset: readViewportPresetId(record.viewportPreset),
  };
}

function parseBoundsUpdate(value: unknown): BrowserViewBoundsUpdate {
  const record = assertRecord(value, "Agent browser view bounds payload");
  return {
    ...parseTileKey(record),
    bounds: parseBounds(record.bounds),
  };
}

function parseTileKey(value: unknown): BrowserViewTileKey {
  const record = assertRecord(value, "Agent browser view tile key");
  return {
    viewTabId: readString(record.viewTabId, "viewTabId"),
    paneId: readString(record.paneId, "paneId"),
    tileInstanceId: readString(record.tileInstanceId, "tileInstanceId"),
    pageSessionId: readString(record.pageSessionId, "pageSessionId"),
  };
}

function parseOverlayOcclusion(value: unknown): BrowserViewOverlayOcclusion {
  const record = assertRecord(value, "Agent browser view overlay occlusion payload");
  const tilesValue = record.tiles;
  if (!Array.isArray(tilesValue)) {
    throw new Error("Agent browser view overlay tiles must be an array");
  }
  return {
    overlayId: readString(record.overlayId, "overlayId"),
    tiles: tilesValue.map((tile) => parseTileKey(tile)),
  };
}

function parseOverlayRelease(value: unknown): BrowserViewOverlayRelease {
  const record = assertRecord(value, "Agent browser view overlay release payload");
  return {
    overlayId: readString(record.overlayId, "overlayId"),
  };
}

function parseDurableTabRegistration(
  value: unknown,
): BrowserViewDurableTabRegistration {
  const record = assertRecord(value, "Agent browser durable tab registration");
  return {
    ...parseTileKey(record),
    sessionId: readString(record.sessionId, "sessionId"),
    tabId: readString(record.tabId, "tabId"),
  };
}

function parseViewportPresetChange(
  value: unknown,
): BrowserViewViewportPresetChange {
  const record = assertRecord(
    value,
    "Agent browser view viewport preset payload",
  );
  return {
    ...parseTileKey(record),
    viewportPreset: readViewportPresetId(record.viewportPreset),
  };
}

function parseFindRequest(value: unknown): BrowserViewFindRequest {
  const record = assertRecord(value, "Agent browser view find payload");
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
  const record = assertRecord(value, "Agent browser view find stop payload");
  return {
    ...parseTileKey(record),
    requestId: readFiniteNumber(record.requestId, "requestId"),
  };
}

function parseDownloadCancel(value: unknown): BrowserViewDownloadCancel {
  const record = assertRecord(
    value,
    "Agent browser view download cancel payload",
  );
  return {
    downloadId: readString(record.downloadId, "downloadId"),
  };
}

function parseCertificateTrust(value: unknown): BrowserViewCertificateTrust {
  const record = assertRecord(
    value,
    "Agent browser view certificate trust payload",
  );
  return {
    ...parseTileKey(record),
    certificateErrorId: readString(
      record.certificateErrorId,
      "certificateErrorId",
    ),
  };
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
  throw new Error("Agent browser view viewportPreset is invalid");
}

function parseCdpDispatch(value: unknown): AgentBrowserViewCdpDispatch {
  const record = assertRecord(value, "Agent browser view CDP dispatch payload");
  return {
    ...parseTileKey(record),
    sessionId: readNullableString(record.sessionId, "sessionId"),
    command: parseBrowserViewCdpCommand(record.command),
  };
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`Agent browser view ${field} must be a string or null`);
}

function parseBounds(value: unknown): BrowserViewBounds {
  const record = assertRecord(value, "Agent browser view bounds");
  return {
    x: readFiniteNumber(record.x, "x"),
    y: readFiniteNumber(record.y, "y"),
    width: readFiniteNumber(record.width, "width"),
    height: readFiniteNumber(record.height, "height"),
  };
}

function toBrowserViewWindow(value: unknown): BrowserViewWindow | null {
  if (!isRecord(value)) return null;
  const contentView = Reflect.get(value, "contentView");
  if (!isContentView(contentView)) return null;
  const isDestroyed = Reflect.get(value, "isDestroyed");
  const isVisible = Reflect.get(value, "isVisible");
  const isMinimized = Reflect.get(value, "isMinimized");
  if (typeof isDestroyed !== "function" || typeof isVisible !== "function") {
    return null;
  }
  return {
    contentView,
    webContents: toBrowserViewHostWebContents(Reflect.get(value, "webContents")),
    isDestroyed: () => Boolean(isDestroyed.call(value)),
    isVisible: () => Boolean(isVisible.call(value)),
    isMinimized: () =>
      typeof isMinimized === "function" && Boolean(isMinimized.call(value)),
  };
}

function toBrowserViewHostWebContents(
  value: unknown,
): BrowserViewHostWebContents | null {
  if (!isRecord(value)) return null;
  const on = Reflect.get(value, "on");
  const off = Reflect.get(value, "off");
  const sendInputEvent = Reflect.get(value, "sendInputEvent");
  if (typeof on !== "function" || typeof off !== "function") return null;
  if (typeof sendInputEvent !== "function") return null;
  return {
    on: (event, listener) => {
      on.call(value, event, listener);
    },
    off: (event, listener) => {
      off.call(value, event, listener);
    },
    sendInputEvent: (event) => {
      sendInputEvent.call(value, event);
    },
  };
}

function isContentView(value: unknown): value is ManagedContentView {
  if (!isRecord(value)) return false;
  return (
    typeof Reflect.get(value, "addChildView") === "function" &&
    typeof Reflect.get(value, "removeChildView") === "function"
  );
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
  throw new Error(`Agent browser view ${field} must be a string`);
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`Agent browser view ${field} must be a boolean`);
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Agent browser view ${field} must be a finite number`);
}

function readReservedChordTokens(payload: unknown): readonly string[] {
  if (!isRecord(payload)) return [];
  const raw = payload.tokens;
  if (!Array.isArray(raw)) return [];
  return raw.filter((token): token is string => typeof token === "string");
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
