import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  BrowserCookieCryptoState,
  BrowserViewBridge,
  BrowserViewElectronTabLifecycleBridge,
} from "@traycer-clients/shared/platform/browser-view";

export type {
  BrowserAnnotationAttachPayload,
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartResult,
} from "@traycer-clients/shared/platform/browser-annotation";
export type * from "@traycer-clients/shared/platform/browser-view";

export type DesktopBrowserViewBridge = BrowserViewBridge;
export type DesktopElectronTabLifecycleBridge =
  BrowserViewElectronTabLifecycleBridge;

const REQUIRED_BROWSER_VIEW_BRIDGE_METHODS = [
  "upsertTile",
  "updateBounds",
  "setViewportPreset",
  "releaseTile",
  "reloadTile",
  "goBack",
  "goForward",
  "findInPage",
  "stopFindInPage",
  "cancelDownload",
  "trustCertificate",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "capturePage",
  "getDebugSnapshot",
  "clearDebugEvents",
  "startAnnotation",
  "cancelAnnotation",
  "setAnnotationTargetChatLabel",
  "openDevTools",
  "occludeForOverlay",
  "releaseOverlay",
  "getCookieCryptoState",
  "setLabsState",
  "applyStorageState",
  "captureStorageState",
  "grantControl",
  "revokeControl",
  "executeControlAction",
  "onStatusChange",
  "onFindChange",
  "onDownloadChange",
  "onCertificateError",
  "onOpenTileRequest",
  "onSnapshotInvalidated",
  "onDebugSnapshotChange",
  "dispatchCdp",
  "onCdpSessionEnded",
  "onCdpTargetAttached",
  "onControlRevoked",
  "onAnnotationEvent",
  "onAnnotationAttached",
] satisfies readonly (keyof DesktopBrowserViewBridge & string)[];

const REQUIRED_ELECTRON_TAB_LIFECYCLE_METHODS = [
  "ensureTab",
  "acceptTab",
  "attachSurface",
  "detachSurface",
  "releaseTab",
  "controlElectronTab",
  "dispatchElectronTabCdp",
  "onNativeTabStatusChange",
  "onNativeTabCdpSessionEnded",
  "onNativeTabCdpTargetAttached",
  "onElectronTabHandoff",
] satisfies readonly (keyof DesktopElectronTabLifecycleBridge & string)[];

export function resolveDesktopBrowserViewBridge(
  runnerHost: IRunnerHost,
): DesktopBrowserViewBridge | null {
  const browserView = readBrowserViewCapability(runnerHost);
  return hasBridgeMethods<DesktopBrowserViewBridge>(
    browserView,
    REQUIRED_BROWSER_VIEW_BRIDGE_METHODS,
  )
    ? browserView
    : null;
}

export function resolveDesktopElectronTabLifecycleBridge(
  runnerHost: IRunnerHost,
): DesktopElectronTabLifecycleBridge | null {
  const browserView = readBrowserViewCapability(runnerHost);
  return hasBridgeMethods<DesktopElectronTabLifecycleBridge>(
    browserView,
    REQUIRED_ELECTRON_TAB_LIFECYCLE_METHODS,
  )
    ? browserView
    : null;
}

export function canCapturePrimaryProfile(runnerHost: IRunnerHost): boolean {
  const browserView = resolveDesktopBrowserViewBridge(runnerHost);
  return typeof browserView?.capturePrimaryProfile === "function";
}

export function fallbackCookieCryptoState(): BrowserCookieCryptoState {
  return {
    mode: "degraded",
    persistence: "ephemeral",
    reason: "unresolved",
    storageBackend: null,
    encryptionAvailable: false,
    mockKeychainEnabled: false,
  };
}

function readBrowserViewCapability(runnerHost: IRunnerHost): unknown {
  return "browserView" in runnerHost ? runnerHost.browserView : null;
}

function hasBridgeMethods<Bridge extends object>(
  value: unknown,
  methods: readonly (keyof Bridge & string)[],
): value is Bridge {
  if (!isRecord(value)) return false;
  return methods.every((method) => typeof value[method] === "function");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
