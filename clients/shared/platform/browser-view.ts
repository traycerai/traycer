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

export interface BrowserViewNativeTabKey {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}

export interface BrowserViewNativeTabCapability extends BrowserViewNativeTabKey {
  readonly registrationId: string;
}

/**
 * Main asks the trusted renderer to create a blank `<webview>` for this grant.
 * The grant and its partition only - no tab identity, never seed or cookie material.
 */
export interface BrowserViewGuestMountRequested {
  readonly registrationId: string;
  readonly partition: string;
}

/** Main tells the renderer to drop the DOM guest for this grant or registration. */
export interface BrowserViewGuestReleaseRequested {
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
  | { readonly kind: "zoomIn" }
  | { readonly kind: "zoomOut" }
  | { readonly kind: "resetZoom" }
  | { readonly kind: "openDevTools" };

export type BrowserViewElectronTabControl = BrowserViewNativeTabCapability & {
  readonly action: BrowserViewElectronTabControlAction;
};

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
  /** Whether a tile is showing this guest right now. */
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
  /** Chromium's disposition for the in-page open: `background-tab` is the
   */
  readonly disposition: "foreground" | "background";
}

/**
 * What a reserved chord does to the tile that owns keyboard focus, when the chord is browser-scoped rather than app-scoped.
 */
export type BrowserViewTileCommand = "closeTab" | "newTab" | "focusAddressBar";

/**
 * One row of the guest-focused input policy: which chord, and what it means while a native browser tile has focus.
 * `command: null` is the app-forwarded case - main replays the keystroke into the host renderer so the app's own keybinding runs, exactly as if the guest never had focus.
 */
export interface BrowserViewReservedChord {
  readonly token: string;
  readonly command: BrowserViewTileCommand | null;
}

export interface BrowserViewTileCommandEvent extends BrowserViewTileKey {
  readonly command: BrowserViewTileCommand;
}

export interface BrowserViewSnapshotInvalidatedChange extends BrowserViewTileKey {
  readonly reason: string;
}

export type LoginImportBrowser =
  | "chrome"
  | "chromium"
  | "edge"
  | "brave"
  | "arc"
  | "vivaldi"
  | "opera"
  | "aside"
  | "helium"
  | "firefox"
  | "safari"
  | "file";

export const LOGIN_IMPORT_BROWSER_LABELS: Readonly<
  Record<LoginImportBrowser, string>
> = {
  chrome: "Google Chrome",
  chromium: "Chromium",
  edge: "Microsoft Edge",
  brave: "Brave",
  arc: "Arc",
  vivaldi: "Vivaldi",
  opera: "Opera",
  aside: "Aside",
  helium: "Helium",
  firefox: "Firefox",
  safari: "Safari",
  file: "Cookie file",
};

/**
 * One importable cookie jar on this machine.
 * `id` is opaque and derived from the source's location: the renderer never learns a filesystem path, and can only name a source the desktop listed for it.
 */
export interface LoginImportSource {
  readonly id: string;
  readonly browser: LoginImportBrowser;
  /** "Default", "Work", a Firefox profile name, or the picked file's name. */
  readonly profileLabel: string;
  /** When the jar was last written, or null when the desktop cannot tell. */
  readonly lastUsedAt: number | null;
}

/**
 * Why a source cannot be read at all. Every value is a state the dialog can
 * explain and the user can act on; none carries a message from the OS.
 */
export type LoginImportBlocked =
  | "keyring-unavailable"
  | "needs-full-disk-access"
  | "browser-locked"
  /**
   * Import only: the source changed between the scan and the Import click in a way that would open a keystore the Choose step did not name (a site the scan read as plaintext gained an encrypted row).
   */
  | "source-changed"
  /**
   * Import only: more sites were chosen than the desktop's forget ledger keeps at once (a thousand or so), which is what tells every host to replace them.
   */
  | "too-many-sites"
  /**
   * The source is a regular file bigger than the desktop will read into main in one go (tens of megabytes; a cookie export is kilobytes).
   * A path that is not a regular file at all - a FIFO, a device - is `unreadable`.
   */
  | "file-too-large"
  /** Nothing is copied or read. */
  | "profile-too-large"
  | "unreadable";

  /**
   * The OS credential store the Import click will touch for this source.
   * Known from the scan without touching it: the cookie rows' encryption prefix says which key they need.
   */
export type LoginImportUnlock =
  | "macos-keychain"
  | "linux-keyring"
  | "windows-dpapi";

export interface LoginImportSite {
  /** Registrable domain (eTLD+1); never a cookie name, never a value. */
  readonly domain: string;
  readonly cookieCount: number;
  /**
   * The keystore importing this site opens, or `null` for a site whose rows are all plaintext.
   * The dialog's pre-prompt explainer is derived from the selected sites' values, so a plaintext-only selection promises no prompt.
   */
  readonly unlock: LoginImportUnlock | null;
}

export interface LoginImportExcludedSite {
  readonly domain: string;
  readonly cookieCount: number;
  readonly unlock: LoginImportUnlock | null;
  readonly reason: "google-device-bound";
}

/**
 * What a source holds, read from metadata only: no keystore is opened and no value is decrypted, so a scan never prompts.
 * Counts are honest by construction - a cookie the import cannot bring over is reported under the reason it cannot, never dropped from the arithmetic.
 */
export interface LoginImportScan {
  readonly sourceId: string;
  /**
   * This scan's own opaque token, which the import request must quote.
   * Two Settings windows can scan the same source, and each import is checked against the scan its window rendered - the site list and the keystore promise the user saw - never against whichever scan came last.
   */
  readonly scanId: string;
  readonly sites: readonly LoginImportSite[];
  readonly excluded: readonly LoginImportExcludedSite[];
  /** Windows App-Bound-Encryption rows (`v20`), which no app can decrypt. */
  readonly protectedCookieCount: number;
  /**
   * chips / container cookies, which have no unpartitioned home in the jar.
   */
  readonly partitionedCookieCount: number;
  /**
   * Records the reader could not make a row of (a Safari record that fails its bounds check).
   * They belong to no site, so they are neither listed nor counted under `skippedInvalid`; the dialog names them so the scan does not claim to account for everything.
   */
  readonly unreadableCookieCount: number;
  readonly unlock: LoginImportUnlock | null;
  readonly blocked: LoginImportBlocked | null;
}

export interface LoginImportRequest {
  readonly sourceId: string;
  /**
   * The `scanId` of the scan this request's domains were chosen from.
   * An import honours only that scan's site list; a token the desktop no longer holds (a failed re-scan, a retired source, a scan that fell out of the retained set) answers `unreadable`, and the dialog's Try again re-scans.
   */
  readonly scanId: string;
  /**
   * Registrable domains from the scan's `sites` - and, only with
   * `includeDeviceBound`, from its `excluded`; anything else is ignored.
   */
  readonly domains: readonly string[];
  /**
   * The user's explicit opt-in to the scan's `excluded` (Google) sites.
   * Google binds its sessions to the device, so an imported one can end on its own; the dialog says so beside the toggle, and the desktop honours a Google domain only when this is true.
   */
  readonly includeDeviceBound: boolean;
}

export type LoginImportResult =
  | {
      readonly status: "imported";
      readonly importedSites: number;
      readonly importedCookies: number;
      /**
       * Chosen sites the jar already held cookies for, now replaced: the cookies the source did not carry are gone, and so is the site's localStorage, which belonged to whichever account was signed in before.
       */
      readonly replacedSites: number;
      /**
       * Cookies the scan counted for a chosen site that could not be written: a value that would not decrypt, or a `set` Electron refused.
       * A row the scan never counted - expired, nameless, breaking its own prefix rule - is not here either, so a site's `cookieCount` from the scan is exactly its share of `importedCookies` plus its share of this number.
       */
      readonly skippedInvalid: number;
      /**
       * Hosts that acked the jar main pushed after the write, counted once per host.
       * Zero is an ordinary outcome (no host has a live stream yet), not a failure: the import is on this machine either way, and the next capture carries it.
       */
      readonly notifiedHosts: number;
    }
  | {
      readonly status: "blocked";
      readonly reason:
        | LoginImportBlocked
        | "keychain-denied"
        | "saved-logins-off"
        /**
         * The write stopped part-way - the jar barrier's budget ran out, a removal or a site's localStorage clear failed - after at least one cookie had reached the jar.
         */
        | "incomplete";
    }
  /**
   * The desktop's own confirmation - a native dialog main draws over every window, naming the source and how many sites the request validated to - was declined.
   * The renderer may ask for a replacement of saved logins, but a native dialog it cannot draw or dismiss is what turns the ask into a decision, exactly as for clearing a site or forgetting every login.
   */
  | { readonly status: "cancelled" };

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
 * How far along one main-owned `browser.sessions` stream is, as the renderer renders it.
 * Lives here rather than beside the renderer's reducer because main is what computes it now and this is the IPC payload's own contract.
 */
export type BrowserSessionsLifecycle =
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed"
  | "failed"
  /**
   * The host has no `browser.sessions` at all (a release before browsers existed).
   * Distinct from `failed` because it is a statement about the host's capability, not about this attempt: no retry can change it, and the only remedy is updating the host.
   */
  | "unsupported";

export const BROWSERS_UNSUPPORTED_MESSAGE =
  "This host doesn't support browsers. Update Traycer Host to use browser tabs here.";

export const BROWSERS_APP_OUTDATED_MESSAGE =
  "This app is too old for this host's browsers. Update the Traycer app to use browser tabs here.";

function unsupportedBrowsersMessage(reason: StreamCloseReason | null): string {
  const guidance =
    reason?.kind === "fatalError" ? reason.details.upgradeGuidance : null;
  return guidance !== null &&
    guidance.clientShouldUpgrade &&
    !guidance.hostShouldUpgrade
    ? BROWSERS_APP_OUTDATED_MESSAGE
    : BROWSERS_UNSUPPORTED_MESSAGE;
}

/**
 * The lifecycle a stream's connection status reads as, and the message that goes with it.
 * One home, so the two cannot drift into disagreeing about what `reconnecting` looks like.
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
  if (isMethodIncompatibleClose(reason)) {
    return unsupportedBrowsersMessage(reason);
  }
  if (reason?.kind === "fatalError") return reason.details.reason;
  if (status === "reconnecting") return "Reconnecting browser sessions.";
  if (status === "closed") return "Browser sessions stream closed.";
  return null;
}

export interface BrowserSessionsRefusalInput {
  readonly lifecycle: BrowserSessionsLifecycle;
  readonly errorMessage: string | null;
}

export function browserSessionsRefusal(
  sessions: BrowserSessionsRefusalInput | null,
): string {
  if (sessions?.lifecycle !== "unsupported") {
    return "Browsers are not connected yet.";
  }
  return sessions.errorMessage ?? BROWSERS_UNSUPPORTED_MESSAGE;
}

/**
 * The renderer's name for one stream.
 * `hostId` is an ID, not a directory row.
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
 * Everything main forwards to the window that opened a stream.
 * `frame` is typed as the UX projection, so a jar frame cannot be forwarded by mistake - the protocol's `BrowserSessionsUxServerFrame` is an `Exclude` with a `never` assertion over every cookie-bearing field.
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
  /**
   * Does this machine keep browser logins across restarts?
   * On by default, Chrome-style; the only way it is false is the user turning it off in Settings, and the answer is per-machine (desktop userData), never per account.
   */
  getSaveLogins(): Promise<boolean>;
  /**
   * Turns saving on or off and moves every live `primary` tile onto the jar the new answer names, at the same URL.
   */
  setSaveLogins(enabled: boolean): Promise<boolean>;
  /**
   * Called by Settings alongside the `forgetLogins` frame that shreds each connected host's slice; there is no host fan-out any more (universal-sign-in decision 6).
   * The ledger is what reaches a host that was disconnected, and it is written before a cookie moves so an in-flight observation for a forgotten site cannot land behind the clear.
   */
  forgetLogins(): Promise<boolean>;
  /**
   * The durable jar always, and the ephemeral one as well when saving is off, since it is the one the live tiles are on then.
   */
  clearSite(input: BrowserViewTileKey): Promise<void>;
  /**
   * Opens (or adopts) the main-owned `browser.sessions` stream for this window and this key.
   * Idempotent per key: a second call from the same window is the same stream.
   */
  openSessionsStream(key: BrowserSessionsStreamKey): Promise<void>;
  closeSessionsStream(key: BrowserSessionsStreamKey): Promise<void>;
  /** One user-initiated request onto that stream. */
  sendSessionsFrame(input: BrowserSessionsStreamSend): Promise<void>;
  onSessionsStreamEvent(
    handler: (envelope: BrowserSessionsStreamEventEnvelope) => void,
  ): { dispose: () => void };
  /**
   * "Clear" on one row of Settings > Browser: signs the user out of that site on every host this process holds a stream to.
   */
  clearSavedLoginSite(domain: string): Promise<boolean>;
  /**
   * Import logins from another browser on this machine, in three calls that mirror the dialog's steps.
   * None of the four ever rejects: every failure is a result value, because a rejected invoke's message is logged and reported and a cookie must never travel that way.
   */
  listLoginImportSources(): Promise<readonly LoginImportSource[]>;
  /** Null when no file was picked: the user cancelled, or the dialog could not open. */
  pickLoginImportFile(): Promise<LoginImportSource | null>;
  scanLoginImportSource(sourceId: string): Promise<LoginImportScan>;
  /**
   * The user chooses from what this window was shown, not from a later scan another window took of the same source.
   */
  importLogins(input: LoginImportRequest): Promise<LoginImportResult>;
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
  /** The native guest received focus, which bypasses the renderer DOM. */
  onTileFocused(handler: (tile: BrowserViewTileKey) => void): {
    dispose: () => void;
  };
  onSnapshotInvalidated(
    handler: (change: BrowserViewSnapshotInvalidatedChange) => void,
  ): {
    dispose: () => void;
  };
  /**
   * A tile released without ever parking never reaches here; it restores through `restoredTiles` on the occlude/release return value instead.
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
  onGuestMountRequested(
    handler: (request: BrowserViewGuestMountRequested) => void,
  ): { dispose: () => void };
  onGuestReleaseRequested(
    handler: (request: BrowserViewGuestReleaseRequested) => void,
  ): { dispose: () => void };
}
