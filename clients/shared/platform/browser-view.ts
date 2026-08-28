import type {
  BrowserCdpCommand,
  BrowserCdpResult,
  BrowserCdpTarget,
  BrowserElectronTabHandoffSibling,
  BrowserScreencastServerFrame,
  BrowserSessionsClientFrame,
  BrowserStorageState,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationAttachedIpcEvent,
  BrowserAnnotationSessionIpcEvent,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartInput,
  BrowserAnnotationStartResult,
  BrowserViewTileKey,
} from "./browser-annotation";

export type { BrowserViewTileKey };

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

export interface BrowserViewAttachSurface extends BrowserViewNativeTabCapability {
  readonly bindingId: string;
  readonly surface: BrowserViewTileKey;
}

export interface BrowserViewDetachSurface extends BrowserViewNativeTabCapability {
  readonly bindingId: string;
}

export interface PipCaptureStartInput extends BrowserViewNativeTabCapability {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
}

export type BrowserViewElectronTabControlAction =
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

export type BrowserViewElectronTabControl = BrowserViewNativeTabCapability & {
  readonly action: BrowserViewElectronTabControlAction;
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

export const BROWSER_VIEW_VIEWPORT_PRESET_IDS = [
  "responsive",
  "mobile",
  "tablet",
  "desktop",
] as const;

export type BrowserViewViewportPresetId =
  (typeof BROWSER_VIEW_VIEWPORT_PRESET_IDS)[number];

export type BrowserViewStatus = "loading" | "ready" | "dead";

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

type BrowserViewFindStatus = "idle" | "searching" | "ready" | "error";

export interface BrowserViewFindChange extends BrowserViewTileKey {
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly status: BrowserViewFindStatus;
  readonly current: number;
  readonly total: number;
  readonly errorMessage: string | null;
}

export type BrowserViewDownloadState =
  | "prompting"
  | "progressing"
  | "completed"
  | "cancelled"
  | "interrupted";

export interface BrowserViewDownloadChange extends BrowserViewTileKey {
  readonly downloadId: string;
  readonly url: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly state: BrowserViewDownloadState;
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

export interface BrowserViewElectronTabCdpDispatch extends BrowserViewNativeTabCapability {
  readonly target: BrowserCdpTarget;
  readonly command: BrowserCdpCommand;
}

export interface BrowserViewElectronTabHandoffChange extends BrowserViewNativeTabCapability {
  readonly capturedUrl: string;
  readonly capturedStorageState: BrowserStorageState | null;
  readonly siblingTabs: readonly BrowserElectronTabHandoffSibling[];
  readonly reason: Extract<
    BrowserSessionsClientFrame,
    { readonly kind: "electronTabHandoff" }
  >["reason"];
}

type BrowserCookieCryptoMode = "real" | "basic" | "degraded";
type BrowserCookiePersistence = "persistent" | "ephemeral";
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
  | "keychain-denied"
  | "encryption-unavailable"
  | "unresolved";

export interface BrowserCookieCryptoState {
  readonly mode: BrowserCookieCryptoMode;
  readonly persistence: BrowserCookiePersistence;
  readonly reason: BrowserCookieCryptoReason;
  readonly storageBackend: BrowserCookieStorageBackend;
  readonly encryptionAvailable: boolean;
}

export type BrowserViewConsoleLevel =
  | "log"
  | "info"
  | "warning"
  | "error"
  | "debug"
  | "trace";

export interface BrowserViewConsoleEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly source: string;
  readonly level: BrowserViewConsoleLevel;
  readonly text: string;
  readonly url: string | null;
  readonly lineNumber: number | null;
  readonly columnNumber: number | null;
}

export type BrowserViewNetworkStatus = "pending" | "finished" | "failed";

export interface BrowserViewNetworkEntry {
  readonly id: string;
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly status: BrowserViewNetworkStatus;
  readonly statusCode: number | null;
  readonly statusText: string | null;
  readonly mimeType: string | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
  readonly failureText: string | null;
}

export interface BrowserViewDebugSnapshotData {
  readonly consoleEntries: readonly BrowserViewConsoleEntry[];
  readonly networkEntries: readonly BrowserViewNetworkEntry[];
}

export interface BrowserViewDebugSnapshot
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
  updateBounds(input: BrowserViewBoundsUpdate): Promise<void>;
  setReservedChords(tokens: readonly string[]): Promise<void>;
  findInPage(input: BrowserViewFindRequest): Promise<void>;
  stopFindInPage(input: BrowserViewFindStop): Promise<void>;
  cancelDownload(input: BrowserViewDownloadCancel): Promise<void>;
  trustCertificate(input: BrowserViewCertificateTrust): Promise<void>;
  capturePage(input: BrowserViewTileKey): Promise<BrowserViewCapturePageResult>;
  getDebugSnapshot(
    input: BrowserViewTileKey,
  ): Promise<BrowserViewDebugSnapshot>;
  startAnnotation(
    input: BrowserAnnotationStartInput,
  ): Promise<BrowserAnnotationStartResult>;
  cancelAnnotation(input: BrowserViewTileKey): Promise<void>;
  setAnnotationTargetChatLabel(
    input: BrowserAnnotationSetTargetChatLabelInput,
  ): Promise<void>;
  reportAnnotationAttachResult(
    input: BrowserAnnotationAttachResultInput,
  ): Promise<void>;
  occludeForOverlay(
    input: BrowserViewOverlayOcclusion,
  ): Promise<BrowserViewOverlayOcclusionResult>;
  releaseOverlay(
    input: BrowserViewOverlayRelease,
  ): Promise<BrowserViewOverlayReleaseResult>;
  getCookieCryptoState(): Promise<BrowserCookieCryptoState>;
  /** Renderer confirms the replacement frame is painted before main parks the view. */
  readonly overlayPaintAck: (overlayId: string) => Promise<void>;
  capturePrimaryProfile(): Promise<BrowserPrimaryProfileCaptureResult>;
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
  ensureTab(
    input: BrowserViewEnsureTab,
  ): Promise<BrowserViewNativeTabCapability>;
  acceptTab(input: BrowserViewNativeTabCapability): Promise<void>;
  attachSurface(input: BrowserViewAttachSurface): Promise<void>;
  detachSurface(input: BrowserViewDetachSurface): Promise<void>;
  releaseTab(input: BrowserViewNativeTabCapability): Promise<boolean>;
  controlElectronTab(input: BrowserViewElectronTabControl): Promise<void>;
  dispatchElectronTabCdp(
    input: BrowserViewElectronTabCdpDispatch,
  ): Promise<BrowserCdpResult>;
  startPipCapture(input: PipCaptureStartInput): Promise<void>;
  stopPipCapture(): Promise<void>;
  onPipCaptureFrame(
    handler: (
      frame: BrowserScreencastServerFrame,
      jpegBytes: Uint8Array | null,
    ) => void,
  ): { dispose: () => void };
  onNativeTabStatusChange(
    handler: (change: BrowserViewNativeTabStatusChange) => void,
  ): { dispose: () => void };
  onElectronTabHandoff(
    handler: (change: BrowserViewElectronTabHandoffChange) => void,
  ): { dispose: () => void };
}
