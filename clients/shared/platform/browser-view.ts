import type {
  BrowserCdpCommand,
  BrowserCdpResult,
  BrowserCdpTarget,
  BrowserElectronTabHandoffSibling,
  BrowserPrimaryProfileDelta,
  BrowserScreencastServerFrame,
  BrowserSessionProfileKind,
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
  /**
   * Which jar the guest is born into. It travels from the host's
   * `createElectronTab` frame; `isolated` selects the session's own in-memory
   * partition and never carries a seed.
   */
  readonly profile: BrowserSessionProfileKind;
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

/**
 * One coalesced cookie-change window from the durable `primary` jar. Re-exported
 * so renderer code sees the bridge and its payloads in one import.
 */
export type { BrowserPrimaryProfileDelta };

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

/**
 * The answer to "clear cookies for this site" (spec §6.5). `refused` is not a
 * failure: a tile with no site to name (a non-http(s) page) or a private
 * session has nothing to clear, and the reason is what the UI says instead of
 * a success toast.
 */
export type BrowserViewClearSiteResult =
  | {
      readonly status: "cleared";
      readonly domain: string;
      readonly cookiesRemoved: number;
      readonly originsCleared: number;
    }
  | {
      readonly status: "refused";
      readonly reason: string;
    };

export interface BrowserViewElectronTabCdpDispatch extends BrowserViewNativeTabCapability {
  readonly target: BrowserCdpTarget;
  readonly command: BrowserCdpCommand;
}

/**
 * The handoff reasons the wire contract carries to the host, including
 * `persistence-migration`: the tab is torn down so it can come back on the jar
 * the saved-logins toggle now names. The host treats it like any other release
 * - what matters is its "revived; re-snapshot" notice.
 */
export type BrowserViewHandoffReason = Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "electronTabHandoff" }
>["reason"];

export interface BrowserViewElectronTabHandoffChange extends BrowserViewNativeTabCapability {
  readonly capturedUrl: string;
  readonly capturedStorageState: BrowserStorageState | null;
  readonly siblingTabs: readonly BrowserElectronTabHandoffSibling[];
  readonly reason: BrowserViewHandoffReason;
}

/**
 * Answer to one store-key wrap. `ok: false` is an expected outcome, not a bug:
 * the keystore may be unavailable on this machine, and the host then simply
 * stays sealed.
 */
export type BrowserStoreKeyWrapResult =
  | { readonly ok: true; readonly wrappedKey: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Answer to one store-key unwrap. `ok: false` means this machine cannot open
 * the host's blob (keystore item ACL changed, or a different machine wrapped
 * it); the host is told so it can stay sealed instead of re-minting.
 */
export type BrowserStoreKeyUnwrapResult =
  | { readonly ok: true; readonly rawKey: string }
  | { readonly ok: false; readonly reason: string };

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
  /**
   * Does this machine keep browser logins across restarts? On by default,
   * Chrome-style; the only way it is false is the user turning it off in
   * Settings, and the answer is per-machine (desktop userData), never per
   * account.
   */
  getSaveLogins(): Promise<boolean>;
  /**
   * Turns saving on or off and moves every live `primary` tile onto the jar the
   * new answer names, at the same URL. Nothing is copied either way: turning it
   * off leaves the `persist:` jar on disk untouched, turning it on drops the
   * in-memory one. Returns the settled value.
   */
  setSaveLogins(enabled: boolean): Promise<boolean>;
  /**
   * Seals the host's freshly minted primary-profile store key with this
   * machine's OS keystore (spec §6.2). The host keeps the returned blob; it
   * never sees a key this machine cannot open again.
   */
  wrapStoreKey(rawKey: string): Promise<BrowserStoreKeyWrapResult>;
  /** Opens a blob wrapped earlier on this machine, so the host can unseal. */
  unwrapStoreKey(wrappedKey: string): Promise<BrowserStoreKeyUnwrapResult>;
  /**
   * "Forget all browser logins" (spec §6.5), this machine's half: clear the
   * durable `primary` partition, drop the remembered localStorage origins, and
   * recreate the open primary tiles at their URLs on the empty jar.
   *
   * Called only in answer to the host's `primaryProfileForgotten`, so the key
   * and the host's slice are already gone by the time the jar is cleared -
   * never the other way round, which would leave the host holding logins the
   * user believes are forgotten.
   */
  forgetLogins(): Promise<void>;
  /**
   * Push for every coalesced cookie change in the durable `primary` jar (spec
   * §6.3). Unsolicited and continuous: the renderer holding the host stream
   * forwards each one as a `primaryProfileDelta` client frame, so a login
   * reaches the store within a window instead of waiting for teardown.
   */
  onPrimaryProfileDelta(handler: (delta: BrowserPrimaryProfileDelta) => void): {
    dispose: () => void;
  };
  /** Renderer confirms the replacement frame is painted before main parks the view. */
  readonly overlayPaintAck: (overlayId: string) => Promise<void>;
  capturePrimaryProfile(): Promise<BrowserPrimaryProfileCaptureResult>;
  /**
   * "Clear cookies for this site" (spec §6.5): removes the tile's registrable
   * domain from the shared `primary` jar - cookies and the localStorage of
   * every remembered origin under it - and reports the emptied slice to the
   * host as one delta, which is what turns it into tombstones.
   */
  clearSite(input: BrowserViewTileKey): Promise<BrowserViewClearSiteResult>;
  /**
   * The receiving half of the same action: the host says one site was cleared
   * somewhere else for this user (`primaryProfileEvict`), so this partition
   * drops it too. Emits **no** delta - the store already recorded the
   * tombstones, and an echo would only re-assert what it just decided.
   */
  evictSite(domain: string): Promise<void>;
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
