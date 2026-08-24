import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-annotation";

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
  readonly seedStorageState: unknown | null;
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
  readonly storageState: unknown | null;
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

// IPC itself is not versioned (only the host<->renderer protocol leg is - see
// `browser.sessions@1.3` in `@traycer/protocol`), but the shape here still
// mirrors that wire contract one-for-one: one command kind per enumerated CDP
// method, no generic `method: string, params: unknown` passthrough.
export type BrowserViewCdpCommand =
  | {
      readonly kind: "cdpNavigate";
      readonly url: string;
    }
  | {
      readonly kind: "cdpCaptureScreenshot";
      readonly format: "png" | "jpeg";
      readonly quality: number | null;
    }
  | {
      readonly kind: "cdpGetFrameTree";
    }
  | {
      readonly kind: "cdpCreateIsolatedWorld";
      readonly frameId: string;
      readonly worldName: string;
      readonly grantUniversalAccess: boolean;
    }
  | {
      readonly kind: "cdpEvaluate";
      readonly expression: string;
      readonly awaitPromise: boolean;
      readonly returnByValue: boolean;
      readonly contextId: number | null;
    }
  | {
      readonly kind: "cdpCallFunctionOn";
      readonly objectId: string | null;
      readonly executionContextId: number | null;
      readonly functionDeclaration: string;
      readonly argumentsJson: unknown;
      readonly returnByValue: boolean;
    }
  | {
      readonly kind: "cdpReleaseObject";
      readonly objectId: string;
    }
  | {
      readonly kind: "cdpDispatchMouseEvent";
      readonly type:
        "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      readonly x: number;
      readonly y: number;
      readonly button: "left" | "right" | "middle" | "none" | null;
      readonly clickCount: number | null;
      readonly deltaX: number | null;
      readonly deltaY: number | null;
    }
  | {
      readonly kind: "cdpInsertText";
      readonly text: string;
    }
  | {
      readonly kind: "cdpDispatchKeyEvent";
      readonly type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      readonly key: string | null;
      readonly code: string | null;
      readonly text: string | null;
      readonly modifiers: number | null;
      readonly unmodifiedText: string | null;
      readonly windowsVirtualKeyCode: number | null;
      readonly location: number | null;
      readonly isKeypad: boolean | null;
      readonly autoRepeat: boolean | null;
      readonly commands: readonly string[] | null;
    }
  | {
      readonly kind: "cdpSetDeviceMetricsOverride";
      readonly width: number;
      readonly height: number;
      readonly deviceScaleFactor: number;
      readonly mobile: boolean;
    }
  | {
      readonly kind: "cdpSetAutoAttach";
      readonly autoAttach: boolean;
      readonly waitForDebuggerOnStart: boolean;
    }
  | {
      readonly kind: "cdpDescribeNode";
      readonly objectId: string;
      readonly depth: number | null;
      readonly pierce: boolean;
    }
  | {
      readonly kind: "cdpGetFullAXTree";
      readonly depth: number | null;
    };

export interface BrowserViewCdpDispatch extends BrowserViewTileKey {
  readonly sessionId: string | null;
  readonly command: BrowserViewCdpCommand;
}

export interface BrowserViewElectronTabCdpDispatch extends BrowserViewNativeTabCapability {
  /** Flattened child-target session; unrelated to the browser sessionId. */
  readonly cdpSessionId: string | null;
  readonly command: BrowserViewCdpCommand;
}

export interface BrowserViewCdpFrameInfo {
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly url: string;
  readonly securityOrigin: string | null;
}

export interface BrowserViewCdpErrorInfo {
  readonly kind:
    "not_attached" | "tile_not_found" | "tab_not_found" | "cdp_error";
  readonly message: string;
  readonly code: number | null;
}

export type BrowserViewCdpResult =
  | {
      readonly kind: "cdpNavigate";
      readonly ok: true;
      readonly frameId: string | null;
      readonly loaderId: string | null;
      readonly errorText: string | null;
    }
  | {
      readonly kind: "cdpCaptureScreenshot";
      readonly ok: true;
      readonly dataBase64: string;
    }
  | {
      readonly kind: "cdpGetFrameTree";
      readonly ok: true;
      readonly frames: readonly BrowserViewCdpFrameInfo[];
    }
  | {
      readonly kind: "cdpCreateIsolatedWorld";
      readonly ok: true;
      readonly executionContextId: number | null;
    }
  | {
      readonly kind: "cdpEvaluate";
      readonly ok: true;
      readonly resultJson: unknown;
      readonly objectId: string | null;
      readonly exceptionDescription: string | null;
    }
  | {
      readonly kind: "cdpCallFunctionOn";
      readonly ok: true;
      readonly resultJson: unknown;
      readonly objectId: string | null;
      readonly exceptionDescription: string | null;
    }
  | { readonly kind: "cdpReleaseObject"; readonly ok: true }
  | { readonly kind: "cdpDispatchMouseEvent"; readonly ok: true }
  | { readonly kind: "cdpInsertText"; readonly ok: true }
  | { readonly kind: "cdpDispatchKeyEvent"; readonly ok: true }
  | { readonly kind: "cdpSetDeviceMetricsOverride"; readonly ok: true }
  | { readonly kind: "cdpSetAutoAttach"; readonly ok: true }
  | {
      readonly kind: "cdpDescribeNode";
      readonly ok: true;
      readonly nodeId: number | null;
      readonly backendNodeId: number | null;
      readonly nodeName: string | null;
      readonly frameId: string | null;
    }
  | {
      readonly kind: "cdpGetFullAXTree";
      readonly ok: true;
      readonly nodesJson: unknown;
    }
  | {
      readonly kind: BrowserViewCdpCommand["kind"];
      readonly ok: false;
      readonly error: BrowserViewCdpErrorInfo;
    };

export interface BrowserViewCdpSessionEndedChange extends BrowserViewTileKey {
  readonly reason: string;
}

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
  readonly capturedStorageState: unknown;
}

export interface BrowserViewElectronTabHandoffChange extends BrowserViewNativeTabCapability {
  readonly capturedUrl: string;
  readonly capturedStorageState: unknown;
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
