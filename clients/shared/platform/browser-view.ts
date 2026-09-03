import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "../host-transport/i-stream-session";
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
  /** Chromium's disposition for the in-page open: `background-tab` is the
   * only one that maps to `background` (middle/ctrl/cmd-click). */
  readonly disposition: "foreground" | "background";
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

/**
 * Which browser a login-import source was read from. `file` is a cookie
 * export the user picked (Netscape `cookies.txt`, Cookie-Editor JSON, or a
 * Playwright storage state).
 */
export type LoginImportBrowser =
  | "chrome"
  | "chromium"
  | "edge"
  | "brave"
  | "arc"
  | "vivaldi"
  | "opera"
  | "firefox"
  | "safari"
  | "file";

/** The product names the dialog and main's confirmation both show. */
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
  firefox: "Firefox",
  safari: "Safari",
  file: "Cookie file",
};

/**
 * One importable cookie jar on this machine. `id` is opaque and derived from
 * the source's location: the renderer never learns a filesystem path, and can
 * only name a source the desktop listed for it. It survives a re-listing, so a
 * scan taken in one settings window is still valid after another lists the
 * sources, and it changes the moment the underlying jar moves - which is
 * exactly when an earlier scan must not be trusted.
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
   * Import only: the source changed between the scan and the Import click in
   * a way that would open a keystore the Choose step did not name (a site the
   * scan read as plaintext gained an encrypted row). Nothing was imported and
   * no prompt fired; the way back in is a fresh scan.
   */
  | "source-changed"
  /**
   * Import only: more sites were chosen than the desktop's forget ledger
   * keeps at once (a thousand or so), which is what tells every host to
   * replace them. Nothing was imported and no prompt fired; choose fewer
   * sites and import in batches.
   */
  | "too-many-sites"
  /**
   * The source is a regular file bigger than the desktop will read into
   * main in one go (tens of megabytes; a cookie export is kilobytes). A path
   * that is not a regular file at all - a FIFO, a device - is `unreadable`.
   */
  | "file-too-large"
  /**
   * An installed profile's cookie database (with its write-ahead log) is
   * bigger than the desktop will copy, or holds more rows than it will read
   * - many times what any browser keeps, so a corrupt or runaway file rather
   * than a big jar. Nothing is copied or read.
   */
  | "profile-too-large"
  | "unreadable";

/**
 * The OS credential store the Import click will touch for this source. Known
 * from the scan without touching it: the cookie rows' encryption prefix says
 * which key they need. `null` when nothing in the selection is encrypted.
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
   * The keystore importing THIS site opens, or `null` for a site whose rows
   * are all plaintext. The dialog's pre-prompt explainer is derived from the
   * selected sites' values, so a plaintext-only selection promises no prompt.
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
 * What a source holds, read from metadata only: no keystore is opened and no
 * value is decrypted, so a scan never prompts. Counts are honest by
 * construction - a cookie the import cannot bring over is reported under the
 * reason it cannot, never dropped from the arithmetic.
 */
export interface LoginImportScan {
  readonly sourceId: string;
  /**
   * This scan's own opaque token, which the import request must quote. Two
   * Settings windows can scan the same source, and each import is checked
   * against the scan ITS window rendered - the site list and the keystore
   * promise the user saw - never against whichever scan came last.
   */
  readonly scanId: string;
  readonly sites: readonly LoginImportSite[];
  readonly excluded: readonly LoginImportExcludedSite[];
  /** Windows App-Bound-Encryption rows (`v20`), which no app can decrypt. */
  readonly protectedCookieCount: number;
  /**
   * CHIPS / container cookies, which have no unpartitioned home in the jar.
   */
  readonly partitionedCookieCount: number;
  /**
   * Records the reader could not make a row of (a Safari record that fails
   * its bounds check). They belong to no site, so they are neither listed
   * nor counted under `skippedInvalid`; the dialog names them so the scan
   * does not claim to account for everything.
   */
  readonly unreadableCookieCount: number;
  readonly unlock: LoginImportUnlock | null;
  readonly blocked: LoginImportBlocked | null;
}

export interface LoginImportRequest {
  readonly sourceId: string;
  /**
   * The `scanId` of the scan this request's domains were chosen from. An
   * import honours only that scan's site list; a token the desktop no longer
   * holds (a failed re-scan, a retired source, a scan that fell out of the
   * retained set) answers `unreadable`, and the dialog's Try again re-scans.
   */
  readonly scanId: string;
  /**
   * Registrable domains from the scan's `sites` - and, only with
   * `includeDeviceBound`, from its `excluded`; anything else is ignored.
   */
  readonly domains: readonly string[];
  /**
   * The user's explicit opt-in to the scan's `excluded` (Google) sites.
   * Google binds its sessions to the device, so an imported one can end on
   * its own; the dialog says so beside the toggle, and the desktop honours a
   * Google domain only when this is true.
   */
  readonly includeDeviceBound: boolean;
}

export type LoginImportResult =
  | {
      readonly status: "imported";
      readonly importedSites: number;
      readonly importedCookies: number;
      /**
       * Chosen sites the jar already held cookies for, now replaced: the
       * cookies the source did not carry are gone, and so is the site's
       * localStorage, which belonged to whichever account was signed in
       * before.
       */
      readonly replacedSites: number;
      /**
       * Cookies the scan COUNTED for a chosen site that could not be written:
       * a value that would not decrypt, or a `set` Electron refused. A row the
       * scan never counted - expired, nameless, breaking its own prefix rule -
       * is not here either, so a site's `cookieCount` from the scan is exactly
       * its share of `importedCookies` plus its share of this number.
       */
      readonly skippedInvalid: number;
      /**
       * Hosts that acked the jar main pushed after the write, counted once per
       * host. Zero is an ordinary outcome (no host has a live stream yet), not
       * a failure: the import is on this machine either way, and the next
       * capture carries it.
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
         * The write stopped part-way - the jar barrier's budget ran out, a
         * removal or a site's localStorage clear failed - AFTER at least one
         * cookie had reached the jar. What was written is kept, and the jar
         * was pushed to the hosts as it stands; importing again finishes the
         * rest. Nothing written is one of the reasons above instead.
         */
        | "incomplete";
    }
  /**
   * The desktop's own confirmation - a native dialog main draws over every
   * window, naming the source and how many sites the request validated to -
   * was declined. Nothing was read or written; the dialog stays on the
   * Choose step. The renderer may ASK for a replacement of saved logins, but
   * a native dialog it cannot draw or dismiss is what turns the ask into a
   * decision, exactly as for clearing a site or forgetting every login.
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
 * How far along one main-owned `browser.sessions` stream is, as the renderer
 * renders it. Lives here rather than beside the renderer's reducer because
 * main is what computes it now and this is the IPC payload's own contract.
 */
export type BrowserSessionsLifecycle =
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed"
  | "failed";

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
  if (reason?.kind === "fatalError") return reason.details.reason;
  if (status === "reconnecting") return "Reconnecting browser sessions.";
  if (status === "closed") return "Browser sessions stream closed.";
  return null;
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
  /**
   * Import logins from another browser on this machine, in three calls that
   * mirror the dialog's steps. `listLoginImportSources` discovers installed
   * browsers and profiles; `pickLoginImportFile` opens the native file dialog
   * from main so the renderer never names a path; `scanLoginImportSource`
   * reads metadata only and never prompts; `importLogins` is the one call
   * that opens the OS credential store, decrypts, and writes the durable
   * `primary` jar with the cookie-delta observer muted. None of the four ever
   * rejects: every failure is a result value, because a rejected invoke's
   * message is logged and reported and a cookie must never travel that way.
   */
  listLoginImportSources(): Promise<readonly LoginImportSource[]>;
  /** Null when no file was picked: the user cancelled, or the dialog could not open. */
  pickLoginImportFile(): Promise<LoginImportSource | null>;
  scanLoginImportSource(sourceId: string): Promise<LoginImportScan>;
  /**
   * Only domains the scan the request quotes (`scanId`) listed under `sites`
   * are honoured (its `excluded` Google sites too, only with
   * `includeDeviceBound`); anything else is dropped in main, and a token the
   * desktop no longer holds, or one taken of another source, is refused as
   * `unreadable`. The user chooses from what THIS window was shown, not from
   * a later scan another window took of the same source.
   *
   * The push to the hosts is main's, like every other jar action: the write
   * runs with the delta observer muted, so nothing would reach a host on its
   * own, and `notifiedHosts` reports what main's capture actually placed.
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
