import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "../host-transport/i-stream-session";
import { isMethodIncompatibleClose } from "../host-transport/i-stream-session";
import type {
  BrowserScreencastServerFrame,
  BrowserSessionsUxClientFrame,
  BrowserSessionsUxServerFrame,
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
  /**
   * Whether a tile is showing this guest right now.
   *
   * Read by main, which reports it to the host as `electronTabState.viewed`.
   * It used to be the renderer's answer, because the renderer held the surface
   * lease AND the stream; with the stream in main (H10) the attachment is
   * read where it actually lives - the manager's own entry - rather than
   * inferred from a lease object on the far side of an IPC boundary.
   */
  readonly viewed: boolean;
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

/**
 * What a reserved chord does to the tile that owns keyboard focus, when the
 * chord is BROWSER-scoped rather than app-scoped. Main claims the keystroke
 * from the guest page and names one of these back to the renderer, which runs
 * it against the focused tile's own session tab.
 */
export type BrowserViewTileCommand = "closeTab" | "newTab" | "focusAddressBar";

/**
 * One row of the guest-focused input policy: which chord, and what it means
 * while a native browser tile has focus. `command: null` is the app-forwarded
 * case - main replays the keystroke into the host renderer so the app's own
 * keybinding runs, exactly as if the guest never had focus.
 */
export interface BrowserViewReservedChord {
  readonly token: string;
  readonly command: BrowserViewTileCommand | null;
}

export interface BrowserViewTileCommandEvent extends BrowserViewTileKey {
  readonly command: BrowserViewTileCommand;
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
  /**
   * How many of the requested tiles the main process actually knows. Zero
   * means the occlusion did not take at all (the scan raced tile teardown or
   * a surface rebind), so the caller must be able to try that overlay again
   * instead of remembering it as done.
   */
  readonly matchedCount: number;
}

export interface BrowserViewOverlayReleaseResult {
  readonly restoredTiles: readonly BrowserViewTileKey[];
}

export interface BrowserViewSnapshotInvalidatedChange extends BrowserViewTileKey {
  readonly reason: string;
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
  BrowserViewElementBoundingBox,
  BrowserViewElementCapture,
  BrowserViewElementStyle,
} from "@traycer/protocol/persistence/epic/schemas";

/**
 * How far along one main-owned `browser.sessions` stream is, as the renderer
 * renders it. Lives here rather than beside the renderer's reducer because
 * main is what computes it now and this is the IPC payload's own contract.
 */
export type BrowserSessionsLifecycle =
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed"
  | "failed"
  /**
   * The host has no `browser.sessions` at all (a release before browsers
   * existed). Distinct from `failed` because it is a statement about the
   * host's capability, not about this attempt: no retry can change it, and
   * the only remedy is updating the host.
   */
  | "unsupported";

export const BROWSERS_UNSUPPORTED_MESSAGE =
  "This host doesn't support browsers. Update Traycer Host to use browser tabs here.";

/**
 * The lifecycle a stream's connection status reads as, and the message that
 * goes with it.
 *
 * Both sides compute it: main for every desktop stream, and the renderer for
 * the direct one it still owns on a shell with no main process. One home, so
 * the two cannot drift into disagreeing about what `reconnecting` looks like.
 */
export function browserSessionsLifecycle(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): BrowserSessionsLifecycle {
  if (isMethodIncompatibleClose(reason)) return "unsupported";
  if (reason?.kind === "fatalError") return "failed";
  if (status === "open") return "live";
  if (status === "reconnecting") return "reconnecting";
  if (status === "closed") return "closed";
  return "connecting";
}

export function browserSessionsError(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): string | null {
  if (isMethodIncompatibleClose(reason)) return BROWSERS_UNSUPPORTED_MESSAGE;
  if (reason?.kind === "fatalError") return reason.details.reason;
  if (status === "reconnecting") return "Reconnecting browser sessions.";
  if (status === "closed") return "Browser sessions stream closed.";
  return null;
}

/**
 * Why an action that needs a live stream is refused right now. One string
 * for every surface that opens a tab, so a host without browsers is told the
 * same thing from the "+" button, the empty state and the command palette.
 */
export function browserSessionsRefusal(
  lifecycle: BrowserSessionsLifecycle | null,
): string {
  return lifecycle === "unsupported"
    ? BROWSERS_UNSUPPORTED_MESSAGE
    : "Browsers are not connected yet.";
}

/**
 * The renderer's name for one stream. Main keys its own streams by this plus
 * the sender's window id, and never dedupes across windows: one subscriber is
 * one Electron lifecycle owner, so collapsing two windows onto one would put
 * both windows' native tabs on a single route.
 *
 * `hostId` is an ID, not a directory row. Main resolves the row itself with
 * the bearer it already holds, because that row carries the host's static
 * Noise key - a renderer-supplied one would let a compromised renderer point
 * main's jar stream at a host it controls.
 */
export interface BrowserSessionsStreamKey {
  readonly epicId: string;
  readonly hostId: string;
  /**
   * The signed-in owner identity the renderer keys its coordinator by. Opaque
   * to main, which only uses it to keep two identities' streams apart.
   */
  readonly identityKey: string;
}

/**
 * The one map-key encoding for each of the two identities main and the renderer
 * both index by. Both sides used to spell them separately - `JSON.stringify` in
 * main, a joined string in the renderer - which is a silent-collision seam
 * around a value that decides which live socket or native guest a request
 * reaches. `JSON.stringify` over the fields in a fixed order is injective for
 * arbitrary strings, which a separator join is not.
 */
export function browserSessionsStreamKeyId(
  key: BrowserSessionsStreamKey,
): string {
  return JSON.stringify([key.epicId, key.hostId, key.identityKey]);
}

export function browserViewNativeTabKeyId(
  key: BrowserViewNativeTabKey,
): string {
  return JSON.stringify([key.hostId, key.sessionId, key.tabId]);
}

export interface BrowserSessionsStreamSend {
  readonly key: BrowserSessionsStreamKey;
  readonly frame: BrowserSessionsUxClientFrame;
}

/**
 * Everything main forwards to the window that opened a stream. `frame` is
 * typed as the UX projection, so a jar frame cannot be forwarded by mistake -
 * the protocol's `BrowserSessionsUxServerFrame` is an `Exclude` with a
 * `never` assertion over every cookie-bearing field.
 */
export type BrowserSessionsStreamEvent =
  | {
      readonly kind: "status";
      readonly lifecycle: BrowserSessionsLifecycle;
      readonly errorMessage: string | null;
    }
  | { readonly kind: "frame"; readonly frame: BrowserSessionsUxServerFrame }
  | {
      readonly kind: "tabBound";
      readonly capability: BrowserViewNativeTabCapability;
    }
  | {
      readonly kind: "tabReleased";
      readonly capability: BrowserViewNativeTabCapability;
    };

export interface BrowserSessionsStreamEventEnvelope {
  readonly key: BrowserSessionsStreamKey;
  readonly event: BrowserSessionsStreamEvent;
}

export interface BrowserViewBridge {
  updateBounds(input: BrowserViewBoundsUpdate): Promise<void>;
  setReservedChords(chords: readonly BrowserViewReservedChord[]): Promise<void>;
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
   * "Forget all browser logins" (spec §6.5), this machine's half: record the
   * forget in the durable ledger, clear the `primary` jars - the durable
   * partition always, and the ephemeral one the live guests are on when saving
   * is off, which otherwise keeps them signed in until the app restarts - drop
   * the remembered localStorage origins, and recreate the open primary tiles at
   * their URLs on the empty jar.
   *
   * Called by Settings alongside the `forgetLogins` frame that shreds each
   * connected host's slice; there is no host fan-out any more (universal-sign-in
   * decision 6). The ledger is what reaches a host that was disconnected, and
   * it is written before a cookie moves so an in-flight observation for a
   * forgotten site cannot land behind the clear.
   *
   * Answers whether the user CONFIRMED. Main raises the native dialog (the
   * renderer is not a trustworthy place to gate the most destructive action
   * the browser surface has), so `false` means nothing was touched here and
   * the caller must not send the host frames either.
   */
  forgetLogins(): Promise<boolean>;
  /** Renderer confirms the replacement frame is painted before main parks the view. */
  readonly overlayPaintAck: (overlayId: string) => Promise<void>;
  /**
   * "Clear cookies for this site" (spec §6.5): removes the tile's registrable
   * domain from the shared `primary` jars - cookies and the localStorage of
   * every remembered origin under it - and reports the emptied slice to the
   * host as one delta, which is what turns it into tombstones. The durable jar
   * always, and the ephemeral one as well when saving is off, since it is the
   * one the live tiles are on then. A tile with no site to name - a private
   * session, or a non-http(s) page - is a no-op.
   */
  clearSite(input: BrowserViewTileKey): Promise<void>;
  /**
   * Opens (or adopts) the main-owned `browser.sessions` stream for this
   * window and this key. Idempotent per key: a second call from the same
   * window is the same stream.
   *
   * The stream lives in main because the jar does - every cookie-bearing
   * frame on it is produced and consumed there, and this renderer sees only
   * the UX projection (browser-security-hardening H10, root cause C).
   *
   * A host id and an epic, and nothing else. The signed-in user is main's own
   * (it holds the desktop auth session), for the same reason the directory row
   * is: anything the renderer states here is something a compromised renderer
   * could state differently.
   */
  openSessionsStream(key: BrowserSessionsStreamKey): Promise<void>;
  closeSessionsStream(key: BrowserSessionsStreamKey): Promise<void>;
  /** One user-initiated request onto that stream. */
  sendSessionsFrame(input: BrowserSessionsStreamSend): Promise<void>;
  onSessionsStreamEvent(
    handler: (envelope: BrowserSessionsStreamEventEnvelope) => void,
  ): { dispose: () => void };
  /**
   * "Clear" on one row of Settings > Browser: signs the user out of that site
   * on every host this process holds a stream to.
   *
   * Main confirms it and main sends the frames. It is forget-all one domain
   * at a time as far as a host's slice is concerned, so it may not be a frame
   * a renderer can mint (H05's residual for H10). Answers whether the user
   * confirmed.
   */
  clearSavedLoginSite(domain: string): Promise<boolean>;
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
  /** A browser-scoped reserved chord fired inside a focused guest page. */
  onTileCommand(handler: (event: BrowserViewTileCommandEvent) => void): {
    dispose: () => void;
  };
  onSnapshotInvalidated(
    handler: (change: BrowserViewSnapshotInvalidatedChange) => void,
  ): {
    dispose: () => void;
  };
  /**
   * Ticket 04 exit-edge handshake: fires once for a tile that WAS parked,
   * when the un-parked native view's first composited frame lands - the
   * renderer's cue to drop the stand-in it kept mounted since occlusion. A
   * tile released without ever parking never reaches here; it restores
   * through `restoredTiles` on the occlude/release return value instead.
   */
  onOverlayTileRestored(handler: (tile: BrowserViewTileKey) => void): {
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
  attachSurface(input: BrowserViewAttachSurface): Promise<void>;
  detachSurface(input: BrowserViewDetachSurface): Promise<void>;
  controlElectronTab(input: BrowserViewElectronTabControl): Promise<void>;
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
}
