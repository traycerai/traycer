import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type {
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationAttachPayload,
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationEndReason,
  BrowserAnnotationForwardedSessionEvent,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartFailureReason,
  BrowserAnnotationStartResult,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-annotation";
import type {
  BrowserViewElementAttribute,
  BrowserViewElementBoundingBox,
  BrowserViewElementCapture,
  BrowserViewElementStyle,
} from "@traycer/protocol/persistence/epic/schemas";
// Type-only, and deliberately so: `desktop-agent-browser-view.ts` already
// imports this module's tile-key types, and a value import back would be a
// real cycle. Ticket 03 defined the CDP command/result shapes there because
// the agent's own tile was their only consumer; ticket 09 gives them a
// second one on this bridge, and they are erased at build time either way.
import type {
  AgentBrowserViewCdpDispatch,
  AgentBrowserViewCdpResult,
  AgentBrowserViewCdpSessionEndedChange,
  AgentBrowserViewCdpTargetAttachedChange,
  AgentBrowserViewTileHandoffChange,
} from "./desktop-agent-browser-view";

export type {
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationAttachPayload,
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartResult,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-annotation";

export interface BrowserViewTileUpsert extends BrowserViewTileKey {
  readonly url: string;
  readonly visible: boolean;
  readonly viewportPreset: BrowserViewViewportPresetId;
}

export interface BrowserViewDurableTabRegistration extends BrowserViewTileKey {
  readonly sessionId: string;
  readonly tabId: string;
}

export interface BrowserViewBackgroundTabCreate extends BrowserViewDurableTabRegistration {
  readonly url: string;
  readonly seedStorageState?: unknown;
}

export interface BrowserViewBackgroundThrottlingChange extends BrowserViewTileKey {
  readonly enabled: boolean;
}

export interface BrowserViewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserViewBoundsUpdate extends BrowserViewTileKey {
  readonly bounds: BrowserViewBounds;
}

export type BrowserViewViewportPresetId =
  "responsive" | "mobile" | "tablet" | "desktop";

export interface BrowserViewViewportPresetChange extends BrowserViewTileKey {
  readonly viewportPreset: BrowserViewViewportPresetId;
}

export type BrowserViewStatus = "loading" | "ready" | "dead";

export interface BrowserViewStatusChange extends BrowserViewTileKey {
  readonly url: string;
  readonly title: string;
  readonly status: BrowserViewStatus;
  readonly reason: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly zoomPercent: number;
}

export interface BrowserViewFindRequest extends BrowserViewTileKey {
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly forward: boolean;
  readonly findNext: boolean;
}

export interface BrowserViewFindStop extends BrowserViewTileKey {
  readonly requestId: number;
}

export type BrowserViewFindStatus = "idle" | "searching" | "ready" | "error";

export interface BrowserViewFindChange extends BrowserViewTileKey {
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly status: BrowserViewFindStatus;
  readonly current: number;
  readonly total: number;
  readonly finalUpdate: boolean;
  readonly errorMessage: string | null;
}

export type BrowserViewDownloadState =
  "prompting" | "progressing" | "completed" | "cancelled" | "interrupted";

export interface BrowserViewDownloadChange extends BrowserViewTileKey {
  readonly downloadId: string;
  readonly url: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly state: BrowserViewDownloadState;
  readonly savePath: string | null;
  readonly dangerType: string | null;
  readonly canCancel: boolean;
}

export interface BrowserViewDownloadCancel {
  readonly downloadId: string;
}

export interface BrowserViewCertificateErrorChange extends BrowserViewTileKey {
  readonly certificateErrorId: string;
  readonly url: string;
  readonly hostname: string;
  readonly error: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly issuer: string;
}

export interface BrowserViewCertificateTrust extends BrowserViewTileKey {
  readonly certificateErrorId: string;
}

export interface BrowserViewOpenTileRequest extends BrowserViewTileKey {
  readonly url: string;
  readonly disposition: string;
}

export interface BrowserViewOverlayOcclusion {
  readonly overlayId: string;
  readonly tiles: readonly BrowserViewTileKey[];
}

export interface BrowserViewOverlayRelease {
  readonly overlayId: string;
}

export interface BrowserViewOverlaySnapshot extends BrowserViewTileKey {
  readonly dataUrl: string | null;
  readonly stale: boolean;
}

export interface BrowserViewOverlayOcclusionResult {
  readonly snapshots: readonly BrowserViewOverlaySnapshot[];
  readonly restoredTiles: readonly BrowserViewTileKey[];
}

export interface BrowserViewOverlayReleaseResult {
  readonly restoredTiles: readonly BrowserViewTileKey[];
}

export interface BrowserViewSnapshotInvalidatedChange extends BrowserViewTileKey {
  readonly reason: string;
}

export interface BrowserViewStorageStateApply {
  readonly storageState: unknown;
  readonly sessionId: string | null;
  readonly tabId: string | null;
  readonly purpose: "primary-profile-seed" | "sync-back";
}

export interface BrowserViewStorageStateCapture extends BrowserViewTileKey {
  readonly origin: string;
}

export interface BrowserViewStorageStateCaptureResult {
  readonly storageState: unknown;
  readonly cookieCount: number;
  readonly cookieDomains: readonly string[];
  readonly localStorageCount: number;
  readonly localStorageAvailable: boolean;
  readonly localStorageReason: string | null;
}

export interface BrowserPrimaryProfileCaptureResult {
  readonly status: "captured" | "unavailable";
  readonly storageState: unknown;
  readonly reason: string | null;
}

export interface BrowserViewControlGrant extends BrowserViewTileKey {
  readonly controlId: string;
  readonly chatId: string;
  readonly agentRunId: string | null;
  readonly agentLabel: string;
  readonly origin: string;
  readonly expiresAt: number;
}

export interface BrowserViewControlRevoke extends BrowserViewTileKey {
  readonly controlId: string;
  readonly reason: string;
}

export type BrowserViewControlActionCommand =
  | {
      readonly kind: "click";
      readonly selector: string;
    }
  | {
      readonly kind: "type";
      readonly selector: string;
      readonly text: string;
    }
  | {
      readonly kind: "scroll";
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | {
      readonly kind: "navigate";
      readonly url: string;
    };

export interface BrowserViewControlAction extends BrowserViewTileKey {
  readonly controlId: string;
  readonly actionId: string;
  readonly sensitiveApprovalId: string | null;
  readonly action: BrowserViewControlActionCommand;
}

export interface BrowserViewControlRevokedChange extends BrowserViewTileKey {
  readonly controlId: string;
  readonly reason: string;
}

export type BrowserViewControlGrantResult =
  | { readonly status: "granted"; readonly controlId: string }
  | { readonly status: "queued"; readonly controlId: string }
  | { readonly status: "denied"; readonly reason: string };

export type BrowserViewControlActionResult =
  | { readonly status: "completed"; readonly value: unknown }
  | {
      readonly status: "needs-approval";
      readonly approvalId: string;
      readonly reason: string;
    }
  | { readonly status: "cancelled"; readonly reason: string }
  | { readonly status: "denied"; readonly reason: string };

export type BrowserViewStorageStateApplyResult =
  | {
      readonly status: "applied";
      readonly cookieCount: number;
      readonly localStorageApplied: false;
      readonly reason: "cookies-only";
    }
  | {
      readonly status: "skipped-degraded";
      readonly cookieCount: 0;
      readonly localStorageApplied: false;
      readonly reason: BrowserCookieCryptoReason;
    };

export type BrowserViewConsoleLevel =
  "log" | "info" | "warning" | "error" | "debug" | "trace";

export interface BrowserViewStackFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number | null;
  readonly columnNumber: number | null;
}

export interface BrowserViewConsoleEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly source: string;
  readonly level: BrowserViewConsoleLevel;
  readonly text: string;
  readonly url: string | null;
  readonly lineNumber: number | null;
  readonly columnNumber: number | null;
  readonly stackTrace: readonly BrowserViewStackFrame[];
}

export type BrowserViewNetworkStatus = "pending" | "finished" | "failed";

export interface BrowserViewNetworkEntry {
  readonly id: string;
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string | null;
  readonly status: BrowserViewNetworkStatus;
  readonly statusCode: number | null;
  readonly statusText: string | null;
  readonly mimeType: string | null;
  readonly fromCache: boolean;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
  readonly encodedDataLength: number | null;
  readonly failureText: string | null;
}

export interface BrowserViewDebugSnapshotChange extends BrowserViewTileKey {
  readonly consoleEntries: readonly BrowserViewConsoleEntry[];
  readonly networkEntries: readonly BrowserViewNetworkEntry[];
}

export interface BrowserViewCapturePageResult extends BrowserViewTileKey {
  readonly mediaType: string;
  readonly base64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly capturedAt: number;
}

export type {
  BrowserViewElementAttribute,
  BrowserViewElementBoundingBox,
  BrowserViewElementCapture,
  BrowserViewElementStyle,
};

export type BrowserCookieCryptoMode = "real" | "basic" | "degraded";
export type BrowserCookiePersistence = "persistent" | "ephemeral";
export type BrowserCookieStorageBackend =
  | "basic_text"
  | "gnome_libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6"
  | "unknown"
  | null;
export type BrowserCookieCryptoReason =
  | "os-backed"
  | "linux-basic-text"
  | "mock-keychain"
  | "keychain-denied"
  | "encryption-unavailable"
  | "unresolved";

export interface BrowserCookieCryptoState {
  readonly mode: BrowserCookieCryptoMode;
  readonly persistence: BrowserCookiePersistence;
  readonly reason: BrowserCookieCryptoReason;
  readonly storageBackend: BrowserCookieStorageBackend;
  readonly encryptionAvailable: boolean;
  readonly mockKeychainEnabled: boolean;
}

export interface BrowserLabsStateUpdate {
  readonly inAppBrowserBetaEnabled: boolean;
}

export interface DesktopBrowserViewBridge {
  upsertTile(input: BrowserViewTileUpsert): Promise<void>;
  createBackgroundTab?(input: BrowserViewBackgroundTabCreate): Promise<void>;
  registerDurableTab(input: BrowserViewDurableTabRegistration): Promise<void>;
  releaseDurableTab?(input: BrowserViewDurableTabRegistration): Promise<void>;
  setBackgroundThrottling?(
    input: BrowserViewBackgroundThrottlingChange,
  ): Promise<void>;
  updateBounds(input: BrowserViewBoundsUpdate): Promise<void>;
  setViewportPreset(input: BrowserViewViewportPresetChange): Promise<void>;
  releaseTile(input: BrowserViewTileKey): Promise<void>;
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
  capturePage(input: BrowserViewTileKey): Promise<BrowserViewCapturePageResult>;
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
  reportAnnotationAttachResult?(
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
  /**
   * BT-202 flicker fix: renderer confirms the replacement frame for
   * `overlayId` is decoded and on screen; main then parks the native view.
   * Capability-gated (older preloads lack it) — callers must guard.
   */
  readonly overlayPaintAck?: (overlayId: string) => Promise<void>;
  applyStorageState(
    input: BrowserViewStorageStateApply,
  ): Promise<BrowserViewStorageStateApplyResult>;
  captureStorageState(
    input: BrowserViewStorageStateCapture,
  ): Promise<BrowserViewStorageStateCaptureResult>;
  capturePrimaryProfile?: () => Promise<BrowserPrimaryProfileCaptureResult>;
  grantControl(
    input: BrowserViewControlGrant,
  ): Promise<BrowserViewControlGrantResult>;
  revokeControl(input: BrowserViewControlRevoke): Promise<void>;
  executeControlAction(
    input: BrowserViewControlAction,
  ): Promise<BrowserViewControlActionResult>;
  onStatusChange(handler: (change: BrowserViewStatusChange) => void): {
    dispose: () => void;
  };
  onFindChange(handler: (change: BrowserViewFindChange) => void): {
    dispose: () => void;
  };
  onDownloadChange(handler: (change: BrowserViewDownloadChange) => void): {
    dispose: () => void;
  };
  onCertificateError(
    handler: (change: BrowserViewCertificateErrorChange) => void,
  ): {
    dispose: () => void;
  };
  onOpenTileRequest(handler: (change: BrowserViewOpenTileRequest) => void): {
    dispose: () => void;
  };
  onSnapshotInvalidated(
    handler: (change: BrowserViewSnapshotInvalidatedChange) => void,
  ): {
    dispose: () => void;
  };
  onDebugSnapshotChange(
    handler: (change: BrowserViewDebugSnapshotChange) => void,
  ): {
    dispose: () => void;
  };
  /** Typed CDP bridge shared by every host-registered Electron tab. */
  dispatchCdp(
    input: AgentBrowserViewCdpDispatch,
  ): Promise<AgentBrowserViewCdpResult>;
  onCdpSessionEnded(
    handler: (change: AgentBrowserViewCdpSessionEndedChange) => void,
  ): {
    dispose: () => void;
  };
  onCdpTargetAttached(
    handler: (change: AgentBrowserViewCdpTargetAttachedChange) => void,
  ): {
    dispose: () => void;
  };
  onTileHandoff(handler: (change: AgentBrowserViewTileHandoffChange) => void): {
    dispose: () => void;
  };
  onControlRevoked(
    handler: (change: BrowserViewControlRevokedChange) => void,
  ): {
    dispose: () => void;
  };
  onAnnotationEvent(
    handler: (change: BrowserAnnotationSessionIpcEvent) => void,
  ): {
    dispose: () => void;
  };
  onAnnotationAttached(
    handler: (change: BrowserAnnotationAttachedIpcEvent) => void,
  ): {
    dispose: () => void;
  };
}

type BrowserViewBridgeMethod = (this: unknown, ...args: unknown[]) => unknown;
type BrowserViewBridgeSource = Record<string, unknown>;
type BrowserViewBridgeMethodSet = {
  readonly [
    MethodName in Exclude<
      keyof DesktopBrowserViewBridge,
      "capturePrimaryProfile"
    >
  ]: BrowserViewBridgeMethod;
} & {
  readonly capturePrimaryProfile: BrowserViewBridgeMethod | undefined;
  readonly overlayPaintAck: BrowserViewBridgeMethod | undefined;
};

const REQUIRED_BROWSER_VIEW_BRIDGE_METHODS = [
  "upsertTile",
  "registerDurableTab",
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
  "reportAnnotationAttachResult",
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
  "onControlRevoked",
  "onAnnotationEvent",
  "onAnnotationAttached",
  // Electron-tab CDP members are deliberately NOT required.
  //
  // This list is a gate: a preload missing any entry makes
  // `resolveDesktopBrowserViewBridge` return null and every browser tile in
  // the app render as unavailable. That is the right answer for members the
  // bridge is useless without - but a browser tab is not useless without
  // agent driving. Requiring these would turn "this build cannot drive a tab"
  // into "the user has no browser at all", which is a far
  // worse failure than the capability it guards.
  //
  // A renderer newer than its preload is not hypothetical here: the desktop
  // dev loop hot-reloads the renderer but not the preload, so the strict
  // form breaks every open browser tile until a full relaunch.
  //
  // `readBridgeMethod` already covers the mismatch honestly - a missing
  // member resolves to a stub that throws when called, so a dispatch fails
  // with a typed CDP error the model can react to, and nothing else on the
  // tile is affected.
] satisfies readonly (keyof DesktopBrowserViewBridge)[];

export function resolveDesktopBrowserViewBridge(
  runnerHost: IRunnerHost,
): DesktopBrowserViewBridge | null {
  const value = readBrowserViewSource(runnerHost);
  if (value === null) return null;
  const methods = readBrowserViewBridgeMethods(value);
  return {
    ...createBrowserViewLifecycleBridge(value, methods),
    ...createBrowserViewNavigationBridge(value, methods),
    ...createBrowserViewDebugBridge(value, methods),
    ...createBrowserViewOverlayBridge(value, methods),
    ...createBrowserViewStorageBridge(value, methods),
    ...createBrowserViewControlBridge(value, methods),
    ...createBrowserViewSubscriptionBridge(value, methods),
  };
}

export function canCapturePrimaryProfile(runnerHost: IRunnerHost): boolean {
  const value = readBrowserViewSource(runnerHost);
  return value !== null && isBridgeMethod(value.capturePrimaryProfile);
}

function readBrowserViewSource(
  runnerHost: IRunnerHost,
): BrowserViewBridgeSource | null {
  if (!isRecord(runnerHost)) return null;
  const value = runnerHost.browserView;
  if (!isRecord(value)) return null;
  if (!hasRequiredBrowserViewBridgeMethods(value)) return null;
  return value;
}

function readBrowserViewBridgeMethods(
  value: BrowserViewBridgeSource,
): BrowserViewBridgeMethodSet {
  return {
    upsertTile: readBridgeMethod(value, "upsertTile"),
    createBackgroundTab: readBridgeMethod(value, "createBackgroundTab"),
    registerDurableTab: readBridgeMethod(value, "registerDurableTab"),
    releaseDurableTab: readBridgeMethod(value, "releaseDurableTab"),
    setBackgroundThrottling: readBridgeMethod(value, "setBackgroundThrottling"),
    updateBounds: readBridgeMethod(value, "updateBounds"),
    setViewportPreset: readBridgeMethod(value, "setViewportPreset"),
    releaseTile: readBridgeMethod(value, "releaseTile"),
    reloadTile: readBridgeMethod(value, "reloadTile"),
    goBack: readBridgeMethod(value, "goBack"),
    goForward: readBridgeMethod(value, "goForward"),
    findInPage: readBridgeMethod(value, "findInPage"),
    stopFindInPage: readBridgeMethod(value, "stopFindInPage"),
    cancelDownload: readBridgeMethod(value, "cancelDownload"),
    trustCertificate: readBridgeMethod(value, "trustCertificate"),
    zoomIn: readBridgeMethod(value, "zoomIn"),
    zoomOut: readBridgeMethod(value, "zoomOut"),
    resetZoom: readBridgeMethod(value, "resetZoom"),
    capturePage: readBridgeMethod(value, "capturePage"),
    getDebugSnapshot: readBridgeMethod(value, "getDebugSnapshot"),
    clearDebugEvents: readBridgeMethod(value, "clearDebugEvents"),
    startAnnotation: readBridgeMethod(value, "startAnnotation"),
    cancelAnnotation: readBridgeMethod(value, "cancelAnnotation"),
    setAnnotationTargetChatLabel: readBridgeMethod(
      value,
      "setAnnotationTargetChatLabel",
    ),
    reportAnnotationAttachResult: readBridgeMethod(
      value,
      "reportAnnotationAttachResult",
    ),
    openDevTools: readBridgeMethod(value, "openDevTools"),
    occludeForOverlay: readBridgeMethod(value, "occludeForOverlay"),
    releaseOverlay: readBridgeMethod(value, "releaseOverlay"),
    getCookieCryptoState: readBridgeMethod(value, "getCookieCryptoState"),
    setLabsState: readBridgeMethod(value, "setLabsState"),
    applyStorageState: readBridgeMethod(value, "applyStorageState"),
    captureStorageState: readBridgeMethod(value, "captureStorageState"),
    capturePrimaryProfile: readBridgeMethod(value, "capturePrimaryProfile"),
    overlayPaintAck: readBridgeMethod(value, "overlayPaintAck"),
    grantControl: readBridgeMethod(value, "grantControl"),
    revokeControl: readBridgeMethod(value, "revokeControl"),
    executeControlAction: readBridgeMethod(value, "executeControlAction"),
    onStatusChange: readBridgeMethod(value, "onStatusChange"),
    onFindChange: readBridgeMethod(value, "onFindChange"),
    onDownloadChange: readBridgeMethod(value, "onDownloadChange"),
    onCertificateError: readBridgeMethod(value, "onCertificateError"),
    onOpenTileRequest: readBridgeMethod(value, "onOpenTileRequest"),
    onSnapshotInvalidated: readBridgeMethod(value, "onSnapshotInvalidated"),
    onDebugSnapshotChange: readBridgeMethod(value, "onDebugSnapshotChange"),
    onControlRevoked: readBridgeMethod(value, "onControlRevoked"),
    onAnnotationEvent: readBridgeMethod(value, "onAnnotationEvent"),
    onAnnotationAttached: readBridgeMethod(value, "onAnnotationAttached"),
    dispatchCdp: readBridgeMethod(value, "dispatchCdp"),
    onCdpSessionEnded: readBridgeMethod(value, "onCdpSessionEnded"),
    onCdpTargetAttached: readBridgeMethod(value, "onCdpTargetAttached"),
    onTileHandoff: readBridgeMethod(value, "onTileHandoff"),
  };
}

function createBrowserViewLifecycleBridge(
  value: BrowserViewBridgeSource,
  methods: BrowserViewBridgeMethodSet,
) {
  return {
    upsertTile: (input) => callBridgeVoid(value, methods.upsertTile, input),
    createBackgroundTab: (input) =>
      callBridgeVoid(value, methods.createBackgroundTab, input),
    registerDurableTab: (input) =>
      callBridgeVoid(value, methods.registerDurableTab, input),
    releaseDurableTab: (input) =>
      callBridgeVoid(value, methods.releaseDurableTab, input),
    setBackgroundThrottling: (input) =>
      callBridgeVoid(value, methods.setBackgroundThrottling, input),
    updateBounds: (input) => callBridgeVoid(value, methods.updateBounds, input),
    setViewportPreset: (input) =>
      callBridgeVoid(value, methods.setViewportPreset, input),
    releaseTile: (input) => callBridgeVoid(value, methods.releaseTile, input),
    overlayPaintAck: (overlayId: string) =>
      Promise.resolve(
        methods.overlayPaintAck.call(value, overlayId),
      ) as Promise<void>,
  } satisfies Pick<
    DesktopBrowserViewBridge,
    | "upsertTile"
    | "createBackgroundTab"
    | "registerDurableTab"
    | "releaseDurableTab"
    | "setBackgroundThrottling"
    | "updateBounds"
    | "setViewportPreset"
    | "releaseTile"
    | "overlayPaintAck"
  >;
}

function createBrowserViewNavigationBridge(
  value: BrowserViewBridgeSource,
  methods: BrowserViewBridgeMethodSet,
) {
  return {
    reloadTile: (input) => callBridgeVoid(value, methods.reloadTile, input),
    goBack: (input) => callBridgeVoid(value, methods.goBack, input),
    goForward: (input) => callBridgeVoid(value, methods.goForward, input),
    findInPage: (input) => callBridgeVoid(value, methods.findInPage, input),
    stopFindInPage: (input) =>
      callBridgeVoid(value, methods.stopFindInPage, input),
    cancelDownload: (input) =>
      callBridgeVoid(value, methods.cancelDownload, input),
    trustCertificate: (input) =>
      callBridgeVoid(value, methods.trustCertificate, input),
    zoomIn: (input) => callBridgeVoid(value, methods.zoomIn, input),
    zoomOut: (input) => callBridgeVoid(value, methods.zoomOut, input),
    resetZoom: (input) => callBridgeVoid(value, methods.resetZoom, input),
    openDevTools: (input) => callBridgeVoid(value, methods.openDevTools, input),
  } satisfies Pick<
    DesktopBrowserViewBridge,
    | "reloadTile"
    | "goBack"
    | "goForward"
    | "findInPage"
    | "stopFindInPage"
    | "cancelDownload"
    | "trustCertificate"
    | "zoomIn"
    | "zoomOut"
    | "resetZoom"
    | "openDevTools"
  >;
}

function createBrowserViewDebugBridge(
  value: BrowserViewBridgeSource,
  methods: BrowserViewBridgeMethodSet,
) {
  return {
    capturePage: (input) =>
      callBridgeResult(
        value,
        methods.capturePage,
        input,
        readCapturePageResult,
      ),
    getDebugSnapshot: (input) =>
      callBridgeResult(
        value,
        methods.getDebugSnapshot,
        input,
        readDebugSnapshot,
      ),
    clearDebugEvents: (input) =>
      callBridgeVoid(value, methods.clearDebugEvents, input),
    startAnnotation: (input) =>
      callBridgeResult(
        value,
        methods.startAnnotation,
        input,
        readAnnotationStartResult,
      ),
    cancelAnnotation: (input) =>
      callBridgeVoid(value, methods.cancelAnnotation, input),
    setAnnotationTargetChatLabel: (input) =>
      callBridgeVoid(value, methods.setAnnotationTargetChatLabel, input),
    reportAnnotationAttachResult: (input) =>
      callBridgeVoid(value, methods.reportAnnotationAttachResult, input),
  } satisfies Pick<
    DesktopBrowserViewBridge,
    | "capturePage"
    | "getDebugSnapshot"
    | "clearDebugEvents"
    | "startAnnotation"
    | "cancelAnnotation"
    | "setAnnotationTargetChatLabel"
    | "reportAnnotationAttachResult"
  >;
}

function createBrowserViewOverlayBridge(
  value: BrowserViewBridgeSource,
  methods: BrowserViewBridgeMethodSet,
) {
  return {
    occludeForOverlay: (input) =>
      callBridgeResult(
        value,
        methods.occludeForOverlay,
        input,
        readOverlayOcclusionResult,
      ),
    releaseOverlay: (input) =>
      callBridgeResult(
        value,
        methods.releaseOverlay,
        input,
        readOverlayReleaseResult,
      ),
  } satisfies Pick<
    DesktopBrowserViewBridge,
    "occludeForOverlay" | "releaseOverlay"
  >;
}

function createBrowserViewStorageBridge(
  value: BrowserViewBridgeSource,
  methods: BrowserViewBridgeMethodSet,
) {
  const capturePrimaryProfileMethod = methods.capturePrimaryProfile;
  return {
    getCookieCryptoState: () =>
      callBridgeResultWithoutInput(
        value,
        methods.getCookieCryptoState,
        readBrowserCookieCryptoState,
      ),
    setLabsState: (input) => callBridgeVoid(value, methods.setLabsState, input),
    applyStorageState: (input) =>
      callBridgeResult(
        value,
        methods.applyStorageState,
        input,
        readStorageStateApplyResult,
      ),
    captureStorageState: (input) =>
      callBridgeResult(
        value,
        methods.captureStorageState,
        input,
        readStorageStateCaptureResult,
      ),
    ...(capturePrimaryProfileMethod === undefined
      ? {}
      : {
          capturePrimaryProfile: () =>
            callBridgeResultWithoutInput(
              value,
              capturePrimaryProfileMethod,
              readPrimaryProfileCaptureResult,
            ),
        }),
  } satisfies Pick<
    DesktopBrowserViewBridge,
    | "getCookieCryptoState"
    | "setLabsState"
    | "applyStorageState"
    | "captureStorageState"
    | "capturePrimaryProfile"
  >;
}

function createBrowserViewControlBridge(
  value: BrowserViewBridgeSource,
  methods: BrowserViewBridgeMethodSet,
) {
  return {
    grantControl: (input) =>
      callBridgeResult(
        value,
        methods.grantControl,
        input,
        readControlGrantResult,
      ),
    revokeControl: (input) =>
      callBridgeVoid(value, methods.revokeControl, input),
    executeControlAction: (input) =>
      callBridgeResult(
        value,
        methods.executeControlAction,
        input,
        readControlActionResult,
      ),
  } satisfies Pick<
    DesktopBrowserViewBridge,
    "grantControl" | "revokeControl" | "executeControlAction"
  >;
}

function createBrowserViewSubscriptionBridge(
  value: BrowserViewBridgeSource,
  methods: BrowserViewBridgeMethodSet,
) {
  return {
    onStatusChange: (handler) =>
      readBridgeSubscription(value, methods.onStatusChange, handler),
    onFindChange: (handler) =>
      readBridgeSubscription(value, methods.onFindChange, handler),
    onDownloadChange: (handler) =>
      readBridgeSubscription(value, methods.onDownloadChange, handler),
    onCertificateError: (handler) =>
      readBridgeSubscription(value, methods.onCertificateError, handler),
    onOpenTileRequest: (handler) =>
      readBridgeSubscription(value, methods.onOpenTileRequest, handler),
    onSnapshotInvalidated: (handler) =>
      readBridgeSubscription(value, methods.onSnapshotInvalidated, handler),
    onDebugSnapshotChange: (handler) =>
      readBridgeSubscription(value, methods.onDebugSnapshotChange, handler),
    onControlRevoked: (handler) =>
      readBridgeSubscription(value, methods.onControlRevoked, handler),
    onAnnotationEvent: (handler) =>
      readBridgeSubscription(
        value,
        methods.onAnnotationEvent,
        wrapAnnotationEventHandler(handler),
      ),
    onAnnotationAttached: (handler) =>
      readBridgeSubscription(
        value,
        methods.onAnnotationAttached,
        wrapAnnotationAttachedHandler(handler),
      ),
    dispatchCdp: (input) =>
      Promise.resolve(
        methods.dispatchCdp.call(value, input),
      ) as Promise<AgentBrowserViewCdpResult>,
    onCdpSessionEnded: (handler) =>
      readBridgeSubscription(value, methods.onCdpSessionEnded, handler),
    onCdpTargetAttached: (handler) =>
      readBridgeSubscription(value, methods.onCdpTargetAttached, handler),
    onTileHandoff: (handler) =>
      readBridgeSubscription(value, methods.onTileHandoff, handler),
  } satisfies Pick<
    DesktopBrowserViewBridge,
    | "dispatchCdp"
    | "onCdpSessionEnded"
    | "onCdpTargetAttached"
    | "onTileHandoff"
    | "onStatusChange"
    | "onFindChange"
    | "onDownloadChange"
    | "onCertificateError"
    | "onOpenTileRequest"
    | "onSnapshotInvalidated"
    | "onDebugSnapshotChange"
    | "onControlRevoked"
    | "onAnnotationEvent"
    | "onAnnotationAttached"
  >;
}

function callBridgeVoid(
  value: BrowserViewBridgeSource,
  method: BrowserViewBridgeMethod,
  input: unknown,
): Promise<void> {
  return Promise.resolve(method.call(value, input)).then(() => undefined);
}

function callBridgeResult<Result>(
  value: BrowserViewBridgeSource,
  method: BrowserViewBridgeMethod,
  input: unknown,
  readResult: (value: unknown) => Result,
): Promise<Result> {
  return Promise.resolve(method.call(value, input)).then(readResult);
}

function callBridgeResultWithoutInput<Result>(
  value: BrowserViewBridgeSource,
  method: BrowserViewBridgeMethod,
  readResult: (value: unknown) => Result,
): Promise<Result> {
  return Promise.resolve(method.call(value)).then(readResult);
}

function readBridgeSubscription(
  value: BrowserViewBridgeSource,
  method: BrowserViewBridgeMethod,
  handler: unknown,
): { dispose: () => void } {
  return readDisposable(method.call(value, handler));
}

function hasRequiredBrowserViewBridgeMethods(
  value: BrowserViewBridgeSource,
): boolean {
  return REQUIRED_BROWSER_VIEW_BRIDGE_METHODS.every((methodName) =>
    isBridgeMethod(value[methodName]),
  );
}

function readBridgeMethod(
  value: BrowserViewBridgeSource,
  name: keyof DesktopBrowserViewBridge,
): BrowserViewBridgeMethod {
  const method = value[name];
  if (isBridgeMethod(method)) return method;
  return function missingBrowserViewBridgeMethod() {
    throw new Error(`Desktop browser view bridge method ${name} is missing.`);
  };
}

function isBridgeMethod(value: unknown): value is BrowserViewBridgeMethod {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDisposable(value: unknown): { dispose: () => void } {
  if (isRecord(value)) {
    const dispose = value.dispose;
    if (typeof dispose === "function") {
      return {
        dispose: () => {
          dispose.call(value);
        },
      };
    }
  }
  return { dispose: () => undefined };
}

function readOverlayOcclusionResult(
  value: unknown,
): BrowserViewOverlayOcclusionResult {
  if (!isRecord(value) || !Array.isArray(value.snapshots)) {
    return { snapshots: [], restoredTiles: [] };
  }
  return {
    snapshots: value.snapshots.flatMap(
      (snapshot): BrowserViewOverlaySnapshot[] => {
        if (!isRecord(snapshot)) return [];
        const key = readTileKey(snapshot);
        if (key === null) return [];
        const dataUrl = snapshot.dataUrl;
        return [
          {
            ...key,
            dataUrl: typeof dataUrl === "string" ? dataUrl : null,
            stale: snapshot.stale === true,
          },
        ];
      },
    ),
    restoredTiles: Array.isArray(value.restoredTiles)
      ? value.restoredTiles.flatMap((tile): BrowserViewTileKey[] => {
          if (!isRecord(tile)) return [];
          const key = readTileKey(tile);
          return key === null ? [] : [key];
        })
      : [],
  };
}

function readOverlayReleaseResult(
  value: unknown,
): BrowserViewOverlayReleaseResult {
  if (!isRecord(value) || !Array.isArray(value.restoredTiles)) {
    return { restoredTiles: [] };
  }
  return {
    restoredTiles: value.restoredTiles.flatMap((tile): BrowserViewTileKey[] => {
      if (!isRecord(tile)) return [];
      const key = readTileKey(tile);
      return key === null ? [] : [key];
    }),
  };
}

function readBrowserCookieCryptoState(
  value: unknown,
): BrowserCookieCryptoState {
  if (!isRecord(value)) return fallbackCookieCryptoState();
  const mode = readCookieCryptoMode(value.mode);
  return {
    mode,
    persistence:
      value.persistence === "persistent" && mode !== "degraded"
        ? "persistent"
        : "ephemeral",
    reason: readCookieCryptoReason(value.reason),
    storageBackend: readCookieStorageBackend(value.storageBackend),
    encryptionAvailable: value.encryptionAvailable === true,
    mockKeychainEnabled: value.mockKeychainEnabled === true,
  };
}

function readStorageStateApplyResult(
  value: unknown,
): BrowserViewStorageStateApplyResult {
  if (!isRecord(value)) {
    return {
      status: "skipped-degraded",
      cookieCount: 0,
      localStorageApplied: false,
      reason: "unresolved",
    };
  }
  if (value.status === "applied") {
    const cookieCount =
      typeof value.cookieCount === "number" &&
      Number.isFinite(value.cookieCount) &&
      value.cookieCount > 0
        ? Math.floor(value.cookieCount)
        : 0;
    return {
      status: "applied",
      cookieCount,
      localStorageApplied: false,
      reason: "cookies-only",
    };
  }
  if (value.status === "skipped-degraded") {
    return {
      status: "skipped-degraded",
      cookieCount: 0,
      localStorageApplied: false,
      reason: readCookieCryptoReason(value.reason),
    };
  }
  return {
    status: "skipped-degraded",
    cookieCount: 0,
    localStorageApplied: false,
    reason: "unresolved",
  };
}

function readStorageStateCaptureResult(
  value: unknown,
): BrowserViewStorageStateCaptureResult {
  if (!isRecord(value)) {
    return {
      storageState: { cookies: [], origins: [] },
      cookieCount: 0,
      cookieDomains: [],
      localStorageCount: 0,
      localStorageAvailable: false,
      localStorageReason: "Invalid storage capture result.",
    };
  }
  return {
    storageState: value.storageState ?? { cookies: [], origins: [] },
    cookieCount: readNonNegativeInteger(value.cookieCount),
    cookieDomains: readStringArray(value.cookieDomains),
    localStorageCount: readNonNegativeInteger(value.localStorageCount),
    localStorageAvailable: value.localStorageAvailable === true,
    localStorageReason:
      typeof value.localStorageReason === "string"
        ? value.localStorageReason
        : null,
  };
}

function readPrimaryProfileCaptureResult(
  value: unknown,
): BrowserPrimaryProfileCaptureResult {
  if (!isRecord(value)) {
    throw new Error("Invalid primary profile capture result.");
  }
  if (value.status === "unavailable") {
    return {
      status: "unavailable",
      storageState: null,
      reason: typeof value.reason === "string" ? value.reason : null,
    };
  }
  if (value.status !== "captured" || !("storageState" in value)) {
    throw new Error("Invalid primary profile capture result.");
  }
  return { status: "captured", storageState: value.storageState, reason: null };
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function readControlGrantResult(value: unknown): BrowserViewControlGrantResult {
  if (!isRecord(value)) {
    return { status: "denied", reason: "Invalid control grant result." };
  }
  if (value.status === "granted" || value.status === "queued") {
    return {
      status: value.status,
      controlId:
        typeof value.controlId === "string"
          ? value.controlId
          : crypto.randomUUID(),
    };
  }
  if (value.status === "denied") {
    return {
      status: "denied",
      reason:
        typeof value.reason === "string"
          ? value.reason
          : "Browser control denied.",
    };
  }
  return { status: "denied", reason: "Browser control denied." };
}

function readControlActionResult(
  value: unknown,
): BrowserViewControlActionResult {
  if (!isRecord(value)) {
    return { status: "denied", reason: "Invalid control action result." };
  }
  if (value.status === "completed") {
    return { status: "completed", value: value.value };
  }
  if (value.status === "needs-approval") {
    return {
      status: "needs-approval",
      approvalId: typeof value.approvalId === "string" ? value.approvalId : "",
      reason:
        typeof value.reason === "string"
          ? value.reason
          : "Browser control action requires approval.",
    };
  }
  if (value.status === "cancelled") {
    return {
      status: "cancelled",
      reason:
        typeof value.reason === "string"
          ? value.reason
          : "Browser control action cancelled.",
    };
  }
  if (value.status === "denied") {
    return {
      status: "denied",
      reason:
        typeof value.reason === "string"
          ? value.reason
          : "Browser control action denied.",
    };
  }
  return { status: "denied", reason: "Browser control action denied." };
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

function readCookieCryptoMode(value: unknown): BrowserCookieCryptoMode {
  return value === "real" || value === "basic" || value === "degraded"
    ? value
    : "degraded";
}

function readCookieCryptoReason(value: unknown): BrowserCookieCryptoReason {
  if (
    value === "os-backed" ||
    value === "linux-basic-text" ||
    value === "mock-keychain" ||
    value === "keychain-denied" ||
    value === "encryption-unavailable" ||
    value === "unresolved"
  ) {
    return value;
  }
  return "unresolved";
}

function readCookieStorageBackend(value: unknown): BrowserCookieStorageBackend {
  if (
    value === "basic_text" ||
    value === "gnome_libsecret" ||
    value === "kwallet" ||
    value === "kwallet5" ||
    value === "kwallet6" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function readDebugSnapshot(value: unknown): BrowserViewDebugSnapshotChange {
  if (!isRecord(value)) {
    return emptyDebugSnapshot({
      viewTabId: "",
      paneId: "",
      tileInstanceId: "",
      pageSessionId: "",
    });
  }
  const key = readTileKey(value);
  if (key === null) {
    return emptyDebugSnapshot({
      viewTabId: "",
      paneId: "",
      tileInstanceId: "",
      pageSessionId: "",
    });
  }
  return {
    ...key,
    consoleEntries: Array.isArray(value.consoleEntries)
      ? value.consoleEntries.flatMap(readConsoleEntry)
      : [],
    networkEntries: Array.isArray(value.networkEntries)
      ? value.networkEntries.flatMap(readNetworkEntry)
      : [],
  };
}

function emptyDebugSnapshot(
  key: BrowserViewTileKey,
): BrowserViewDebugSnapshotChange {
  return {
    ...key,
    consoleEntries: [],
    networkEntries: [],
  };
}

function readCapturePageResult(value: unknown): BrowserViewCapturePageResult {
  if (!isRecord(value)) {
    throw new Error("Browser capture result must be an object");
  }
  const key = readTileKey(value);
  if (key === null) {
    throw new Error("Browser capture result is missing a tile key");
  }
  return {
    ...key,
    mediaType: readString(value.mediaType, "mediaType"),
    base64: readString(value.base64, "base64"),
    byteLength: readNumber(value.byteLength, "byteLength"),
    sha256: readString(value.sha256, "sha256"),
    capturedAt: readNumber(value.capturedAt, "capturedAt"),
  };
}

function readConsoleEntry(value: unknown): BrowserViewConsoleEntry[] {
  if (!isRecord(value)) return [];
  const id = value.id;
  const timestamp = value.timestamp;
  const source = value.source;
  const level = value.level;
  const text = value.text;
  if (
    typeof id !== "string" ||
    typeof timestamp !== "number" ||
    typeof source !== "string" ||
    !isConsoleLevel(level) ||
    typeof text !== "string"
  ) {
    return [];
  }
  return [
    {
      id,
      timestamp,
      source,
      level,
      text,
      url: nullableString(value.url),
      lineNumber: nullableNumber(value.lineNumber),
      columnNumber: nullableNumber(value.columnNumber),
      stackTrace: Array.isArray(value.stackTrace)
        ? value.stackTrace.flatMap(readStackFrame)
        : [],
    },
  ];
}

function readNetworkEntry(value: unknown): BrowserViewNetworkEntry[] {
  if (!isRecord(value)) return [];
  const id = value.id;
  const requestId = value.requestId;
  const url = value.url;
  const method = value.method;
  const status = value.status;
  const fromCache = value.fromCache;
  const startedAt = value.startedAt;
  if (
    typeof id !== "string" ||
    typeof requestId !== "string" ||
    typeof url !== "string" ||
    typeof method !== "string" ||
    !isNetworkStatus(status) ||
    typeof fromCache !== "boolean" ||
    typeof startedAt !== "number"
  ) {
    return [];
  }
  return [
    {
      id,
      requestId,
      url,
      method,
      resourceType: nullableString(value.resourceType),
      status,
      statusCode: nullableNumber(value.statusCode),
      statusText: nullableString(value.statusText),
      mimeType: nullableString(value.mimeType),
      fromCache,
      startedAt,
      completedAt: nullableNumber(value.completedAt),
      durationMs: nullableNumber(value.durationMs),
      encodedDataLength: nullableNumber(value.encodedDataLength),
      failureText: nullableString(value.failureText),
    },
  ];
}

function readStackFrame(value: unknown): BrowserViewStackFrame[] {
  if (!isRecord(value)) return [];
  const functionName = value.functionName;
  const url = value.url;
  if (typeof functionName !== "string" || typeof url !== "string") return [];
  return [
    {
      functionName,
      url,
      lineNumber: nullableNumber(value.lineNumber),
      columnNumber: nullableNumber(value.columnNumber),
    },
  ];
}

function readAnnotationStartResult(
  value: unknown,
): BrowserAnnotationStartResult {
  if (isRecord(value) && value.ok === true) return { ok: true };
  return {
    ok: false,
    reason: readAnnotationStartFailureReason(
      isRecord(value) ? value.reason : null,
    ),
  };
}

function readAnnotationStartFailureReason(
  value: unknown,
): BrowserAnnotationStartFailureReason {
  if (
    value === "tile-not-found" ||
    value === "page-not-ready" ||
    value === "debugger-not-attached" ||
    value === "no-main-frame" ||
    value === "no-isolated-world" ||
    value === "inject-failed"
  ) {
    return value;
  }
  return "inject-failed";
}

function wrapAnnotationEventHandler(
  handler: unknown,
): (change: unknown) => void {
  if (!isUnknownHandler(handler)) return () => undefined;
  return (change: unknown) => {
    const parsed = readAnnotationSessionEvent(change);
    if (parsed === null) return;
    handler(parsed);
  };
}

function wrapAnnotationAttachedHandler(
  handler: unknown,
): (change: unknown) => void {
  if (!isUnknownHandler(handler)) return () => undefined;
  return (change: unknown) => {
    const parsed = readAnnotationAttachedEvent(change);
    if (parsed === null) return;
    handler(parsed);
  };
}

function isUnknownHandler(value: unknown): value is (input: unknown) => void {
  return typeof value === "function";
}

function readAnnotationSessionEvent(
  value: unknown,
): BrowserAnnotationSessionIpcEvent | null {
  if (!isRecord(value)) return null;
  const key = readTileKey(value);
  if (key === null) return null;
  const event = readAnnotationEvent(value.event);
  if (event === null) return null;
  return { ...key, event };
}

function readAnnotationEvent(
  value: unknown,
): BrowserAnnotationForwardedSessionEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "cancelled") return { type: "cancelled" };
  if (value.type === "ended") {
    const reason = readAnnotationEndReason(value.reason);
    if (reason === null) return null;
    return {
      type: "ended",
      reason,
    };
  }
  if (value.type === "stateChanged") {
    const mode = value.mode;
    if (
      mode !== "select" &&
      mode !== "region" &&
      mode !== "draw" &&
      mode !== "erase"
    ) {
      return null;
    }
    const markCount =
      typeof value.markCount === "number" && Number.isFinite(value.markCount)
        ? Math.max(0, Math.floor(value.markCount))
        : 0;
    return { type: "stateChanged", mode, markCount };
  }
  return null;
}

function readAnnotationEndReason(
  value: unknown,
): Exclude<BrowserAnnotationEndReason, "cancelled"> | null {
  return value === "navigation" ||
    value === "reload" ||
    value === "crash" ||
    value === "tile-close" ||
    value === "replaced"
    ? value
    : null;
}

function readAnnotationAttachedEvent(
  value: unknown,
): BrowserAnnotationAttachedIpcEvent | null {
  if (!isRecord(value)) return null;
  const key = readTileKey(value);
  if (key === null) return null;
  const payload = readAnnotationAttachPayload(value.payload);
  if (payload === null) return null;
  const pngBytes = readPngBytes(value.pngBytes);
  if (pngBytes === null) return null;
  if (typeof value.targetChatId !== "string") return null;
  return { ...key, targetChatId: value.targetChatId, payload, pngBytes };
}

function readAnnotationAttachPayload(
  value: unknown,
): BrowserAnnotationAttachPayload | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.annotationId !== "string" ||
    typeof value.tabId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.pageUrl !== "string" ||
    typeof value.pageTitle !== "string" ||
    typeof value.capturedAt !== "number" ||
    !Number.isFinite(value.capturedAt) ||
    typeof value.comment !== "string"
  ) {
    return null;
  }
  const counts = readAnnotationCounts(value.counts);
  if (counts === null) return null;
  const elements = Array.isArray(value.elements)
    ? value.elements.flatMap((entry): BrowserViewElementCapture[] => {
        const element = readElementCapture(entry);
        return element === null ? [] : [element];
      })
    : [];
  return {
    annotationId: value.annotationId,
    tabId: value.tabId,
    sessionId: value.sessionId,
    origin: value.origin,
    pageUrl: value.pageUrl,
    pageTitle: value.pageTitle,
    capturedAt: value.capturedAt,
    comment: value.comment,
    counts,
    droppedElementCount: readDroppedElementCount(value.droppedElementCount),
    elements,
  };
}

function readDroppedElementCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function readAnnotationCounts(
  value: unknown,
): BrowserAnnotationAttachPayload["counts"] | null {
  if (!isRecord(value)) return null;
  const elements = value.elements;
  const regions = value.regions;
  const strokes = value.strokes;
  if (
    typeof elements !== "number" ||
    !Number.isFinite(elements) ||
    typeof regions !== "number" ||
    !Number.isFinite(regions) ||
    typeof strokes !== "number" ||
    !Number.isFinite(strokes)
  ) {
    return null;
  }
  return {
    elements: Math.max(0, Math.floor(elements)),
    regions: Math.max(0, Math.floor(regions)),
    strokes: Math.max(0, Math.floor(strokes)),
  };
}

function readPngBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof Uint8Array) return copyPngBytes(value);
  if (value instanceof ArrayBuffer) return copyPngBytes(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return copyPngBytes(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (isRecord(value) && Array.isArray(value.data)) {
    const numbers = value.data.filter(
      (entry): entry is number => typeof entry === "number",
    );
    if (numbers.length !== value.data.length) return null;
    return copyPngBytes(Uint8Array.from(numbers));
  }
  return null;
}

function copyPngBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function readElementCapture(value: unknown): BrowserViewElementCapture | null {
  if (!isRecord(value)) return null;
  return {
    selector: typeof value.selector === "string" ? value.selector : "",
    tagName: typeof value.tagName === "string" ? value.tagName : "",
    elementId: nullableString(value.elementId),
    classNames: readElementStringList(value.classNames),
    attributes: readElementAttributes(value.attributes),
    outerHtml: typeof value.outerHtml === "string" ? value.outerHtml : "",
    outerHtmlTruncated: value.outerHtmlTruncated === true,
    textPreview: nullableString(value.textPreview),
    ariaRole: nullableString(value.ariaRole),
    accessibleName: nullableString(value.accessibleName),
    boundingBox: readElementBoundingBox(value.boundingBox),
    computedStyles: readElementStyles(value.computedStyles),
  };
}

function readElementStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readElementAttributes(value: unknown): BrowserViewElementAttribute[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): BrowserViewElementAttribute[] => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.value !== "string"
    ) {
      return [];
    }
    return [{ name: entry.name, value: entry.value }];
  });
}

function readElementStyles(value: unknown): BrowserViewElementStyle[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): BrowserViewElementStyle[] => {
    if (
      !isRecord(entry) ||
      typeof entry.property !== "string" ||
      typeof entry.value !== "string"
    ) {
      return [];
    }
    return [{ property: entry.property, value: entry.value }];
  });
}

function readElementBoundingBox(value: unknown): BrowserViewElementBoundingBox {
  const record = isRecord(value) ? value : {};
  return {
    x: numberOrZero(record.x),
    y: numberOrZero(record.y),
    width: numberOrZero(record.width),
    height: numberOrZero(record.height),
    top: numberOrZero(record.top),
    right: numberOrZero(record.right),
    bottom: numberOrZero(record.bottom),
    left: numberOrZero(record.left),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readTileKey(
  value: Record<string, unknown>,
): BrowserViewTileKey | null {
  const viewTabId = value.viewTabId;
  const paneId = value.paneId;
  const tileInstanceId = value.tileInstanceId;
  const pageSessionId = value.pageSessionId;
  if (
    typeof viewTabId !== "string" ||
    typeof paneId !== "string" ||
    typeof tileInstanceId !== "string" ||
    typeof pageSessionId !== "string"
  ) {
    return null;
  }
  return {
    viewTabId,
    paneId,
    tileInstanceId,
    pageSessionId,
  };
}

function isConsoleLevel(value: unknown): value is BrowserViewConsoleLevel {
  return (
    value === "log" ||
    value === "info" ||
    value === "warning" ||
    value === "error" ||
    value === "debug" ||
    value === "trace"
  );
}

function isNetworkStatus(value: unknown): value is BrowserViewNetworkStatus {
  return value === "pending" || value === "finished" || value === "failed";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`Browser view ${field} must be a string`);
}

function readNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Browser view ${field} must be a finite number`);
}
