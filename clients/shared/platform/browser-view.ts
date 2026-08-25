import type {
  BrowserCdpCommand,
  BrowserCdpError,
  BrowserCdpFrameInfo,
  BrowserCdpResult,
  BrowserStorageState,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartResult,
  BrowserViewTileKey,
} from "./browser-annotation";

export type { BrowserViewTileKey };

export interface BrowserViewTileUpsert extends BrowserViewTileKey {
  readonly url: string;
  readonly visible: boolean;
  readonly viewportPreset: BrowserViewViewportPresetId;
}

/** Stable identity of an Electron-owned browser guest. Presentation is separate. */
export interface BrowserViewNativeTabKey {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}

/** Exact authority for one live Electron-owned browser guest incarnation. */
export interface BrowserViewNativeTabCapability extends BrowserViewNativeTabKey {
  readonly registrationId: string;
}

export interface BrowserViewEnsureTab extends BrowserViewNativeTabKey {
  readonly requestedUrl: string;
  readonly seedStorageState: BrowserStorageState | null;
}

export type BrowserViewProvisionedTab = BrowserViewNativeTabCapability;

export interface BrowserViewAttachSurface extends BrowserViewNativeTabCapability {
  readonly bindingId: string;
  readonly surface: BrowserViewTileKey;
  readonly visible: boolean;
}

export interface BrowserViewDetachSurface extends BrowserViewNativeTabCapability {
  readonly bindingId: string;
}

export type BrowserViewReleaseTab = BrowserViewNativeTabCapability;

export type BrowserViewElectronTabControl = BrowserViewNativeTabCapability & {
  readonly action:
    | { readonly kind: "navigate"; readonly url: string }
    | { readonly kind: "reload" }
    | { readonly kind: "goBack" }
    | { readonly kind: "goForward" }
    | {
        readonly kind: "setViewportPreset";
        readonly viewportPreset: BrowserViewViewportPresetId;
      }
    | { readonly kind: "zoomIn" }
    | { readonly kind: "zoomOut" }
    | { readonly kind: "resetZoom" }
    | { readonly kind: "openDevTools" };
};

export type BrowserViewElectronTabControlAction =
  BrowserViewElectronTabControl["action"];

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

export interface BrowserViewNativeTabStatusChange extends BrowserViewNativeTabCapability {
  readonly url: string;
  readonly title: string | null;
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
  readonly storageState: BrowserStorageState;
  readonly sessionId: string | null;
  readonly tabId: string | null;
  readonly purpose: "primary-profile-seed" | "sync-back";
}

export interface BrowserViewStorageStateCapture extends BrowserViewTileKey {
  readonly origin: string;
}

export interface BrowserViewStorageStateCaptureResult {
  readonly storageState: BrowserStorageState;
  readonly cookieCount: number;
  readonly cookieDomains: readonly string[];
  readonly localStorageCount: number;
  readonly localStorageAvailable: boolean;
  readonly localStorageReason: string | null;
}

export type BrowserPrimaryProfileCaptureResult =
  | {
      readonly status: "captured";
      readonly storageState: BrowserStorageState;
      readonly reason: null;
    }
  | {
      readonly status: "unavailable";
      readonly storageState: null;
      readonly reason: string;
    };

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

export type BrowserViewCdpCommand = BrowserCdpCommand;

export interface BrowserViewCdpDispatch extends BrowserViewTileKey {
  readonly sessionId: string | null;
  readonly command: BrowserViewCdpCommand;
}

/** Renderer name retained for compatibility; both address the same tile seam. */
export type BrowserViewTileCdpDispatch = BrowserViewCdpDispatch;

export interface BrowserViewElectronTabCdpDispatch extends BrowserViewNativeTabCapability {
  /** Flattened child-target session; unrelated to the browser sessionId. */
  readonly cdpSessionId: string | null;
  readonly command: BrowserViewCdpCommand;
}

export type BrowserViewCdpFrameInfo = BrowserCdpFrameInfo;
export type BrowserViewCdpErrorInfo = BrowserCdpError;
export type BrowserViewCdpResult = BrowserCdpResult;

export interface BrowserViewCdpSessionEndedChange extends BrowserViewTileKey {
  readonly reason: string;
}

export type BrowserViewTileCdpSessionEndedChange =
  BrowserViewCdpSessionEndedChange;

export interface BrowserViewNativeTabCdpSessionEndedChange extends BrowserViewNativeTabCapability {
  readonly reason: string;
}

/**
 * Push notification (electron-main -> renderer -> host), not a response to a
 * specific request - mirrors `BrowserViewCdpSessionEndedChange`'s shape.
 * Fired whenever CDP's own `Target.attachedToTarget` fires on the tile's
 * root session, so the host can discover a flattened child (OOPIF/worker)
 * session id to address further dispatches at.
 */
export interface BrowserViewCdpTargetAttachedChange extends BrowserViewTileKey {
  readonly sessionId: string;
  readonly targetId: string;
  readonly targetType: string;
  readonly url: string;
  readonly waitingForDebugger: boolean;
}

export type BrowserViewTileCdpTargetAttachedChange =
  BrowserViewCdpTargetAttachedChange;

export interface BrowserViewNativeTabCdpTargetAttachedChange extends BrowserViewNativeTabCapability {
  readonly cdpSessionId: string;
  readonly targetId: string;
  readonly targetType: string;
  readonly url: string;
  readonly waitingForDebugger: boolean;
}

export interface BrowserViewElectronTabHandoffSibling {
  readonly tabId: string;
  readonly registrationId: string;
  readonly url: string;
  readonly capturedStorageState: BrowserStorageState | null;
}

export interface BrowserViewElectronTabHandoffChange extends BrowserViewNativeTabCapability {
  readonly capturedUrl: string;
  readonly capturedStorageState: BrowserStorageState | null;
  readonly siblingTabs: readonly BrowserViewElectronTabHandoffSibling[];
  readonly reason: "gui-quit" | "tab-released" | "crash-no-capture";
}

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

export interface BrowserViewDebugSnapshotData {
  readonly consoleEntries: readonly BrowserViewConsoleEntry[];
  readonly networkEntries: readonly BrowserViewNetworkEntry[];
}

export interface BrowserViewDebugSnapshotChange
  extends BrowserViewTileKey, BrowserViewDebugSnapshotData {}

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
} from "@traycer/protocol/persistence/epic/schemas";

export interface BrowserViewBridge {
  upsertTile(input: BrowserViewTileUpsert): Promise<void>;
  updateBounds(input: BrowserViewBoundsUpdate): Promise<void>;
  setViewportPreset(input: BrowserViewViewportPresetChange): Promise<void>;
  releaseTile(input: BrowserViewTileKey): Promise<void>;
  setReservedChords?(tokens: readonly string[]): Promise<void>;
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
  dispatchCdp(input: BrowserViewTileCdpDispatch): Promise<BrowserViewCdpResult>;
  onCdpSessionEnded(
    handler: (change: BrowserViewTileCdpSessionEndedChange) => void,
  ): {
    dispose: () => void;
  };
  onCdpTargetAttached(
    handler: (change: BrowserViewTileCdpTargetAttachedChange) => void,
  ): {
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

/** Complete native-tab lifecycle capability. It is never inferred from the general tile bridge. */
export interface BrowserViewElectronTabLifecycleBridge {
  ensureTab(input: BrowserViewEnsureTab): Promise<BrowserViewProvisionedTab>;
  acceptTab(input: BrowserViewNativeTabCapability): Promise<void>;
  attachSurface(input: BrowserViewAttachSurface): Promise<void>;
  detachSurface(input: BrowserViewDetachSurface): Promise<void>;
  releaseTab(input: BrowserViewReleaseTab): Promise<boolean>;
  controlElectronTab(input: BrowserViewElectronTabControl): Promise<void>;
  dispatchElectronTabCdp(
    input: BrowserViewElectronTabCdpDispatch,
  ): Promise<BrowserViewCdpResult>;
  onNativeTabStatusChange(
    handler: (change: BrowserViewNativeTabStatusChange) => void,
  ): { dispose: () => void };
  onNativeTabCdpSessionEnded(
    handler: (change: BrowserViewNativeTabCdpSessionEndedChange) => void,
  ): { dispose: () => void };
  onNativeTabCdpTargetAttached(
    handler: (change: BrowserViewNativeTabCdpTargetAttachedChange) => void,
  ): { dispose: () => void };
  onElectronTabHandoff(
    handler: (change: BrowserViewElectronTabHandoffChange) => void,
  ): { dispose: () => void };
}
