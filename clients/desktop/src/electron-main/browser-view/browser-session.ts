import {
  dialog,
  session,
  type Certificate,
  type Session,
  type WebPreferences,
} from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserViewDownloadState } from "@traycer-clients/shared/platform/browser-view";
import type { BrowserPrimaryProfileDelta } from "@traycer/protocol/host/browser/contracts";
import { describeLogError, log } from "../app/logger";
import {
  setBrowserCertificateErrorHandler,
  type CertificateErrorReport,
} from "../app/cert-trust";
import { ensureBrowserPersistenceForTileOpen } from "./storage/browser-cookie-crypto";
import {
  BrowserCookieChangeObserver,
  BROWSER_COOKIE_DELTA_WINDOW_MS,
} from "./storage/browser-cookie-change-observer";

export const BROWSER_VIEW_PARTITION = "persist:traycer-browser";
export const BROWSER_VIEW_EPHEMERAL_PARTITION = "traycer-browser-ephemeral";
const BROWSER_VIEW_ISOLATED_PARTITION_PREFIX = "traycer-isolated-";

/**
 * Which jar a browser guest gets. `primary` is the one shared identity (user
 * tabs, agent Electron tabs, popups); `isolated` is a per-session throwaway
 * partition that shares cookies with nothing and dies with the session.
 */
export type BrowserSessionProfile = "primary" | "isolated";

export interface BrowserSessionProfileRequest {
  readonly profile: BrowserSessionProfile;
  readonly sessionId: string;
}

type BrowserPermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (permissionGranted: boolean) => void,
  details: unknown,
) => void;

type BrowserPermissionCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: unknown,
) => boolean;

type BrowserDownloadListener = (
  event: unknown,
  item: BrowserDownloadItem,
  webContents: BrowserDownloadWebContents,
) => void;

type BrowserDisplayMediaRequestHandler = (
  request: unknown,
  callback: (streams: object) => void,
) => void;

interface BrowserViewPolicySession {
  setPermissionRequestHandler(
    handler: BrowserPermissionRequestHandler | null,
  ): void;
  setPermissionCheckHandler(
    handler: BrowserPermissionCheckHandler | null,
  ): void;
  setDevicePermissionHandler(
    handler: ((details: unknown) => boolean) | null,
  ): void;
  setUSBProtectedClassesHandler(
    handler: ((details: unknown) => unknown[]) | null,
  ): void;
  setBluetoothPairingHandler(
    handler:
      | ((
          details: unknown,
          callback: (response: { readonly confirmed: boolean }) => void,
        ) => void)
      | null,
  ): void;
  setDisplayMediaRequestHandler(
    handler: BrowserDisplayMediaRequestHandler | null,
  ): void;
  on(event: "will-download", listener: BrowserDownloadListener): void;
}

interface BrowserViewTrackedWebContents {
  readonly id: number;
  once(event: "destroyed", listener: () => void): void;
}

interface BrowserDownloadItem {
  getURL(): string;
  getFilename(): string;
  getMimeType(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  getSavePath(): string;
  setSavePath(path: string): void;
  cancel(): void;
  on(
    event: "updated",
    listener: (updatedEvent: unknown, state: string) => void,
  ): void;
  on(
    event: "done",
    listener: (doneEvent: unknown, state: string) => void,
  ): void;
}

interface BrowserDownloadWebContents {
  readonly id: number;
  getURL(): string;
}

export interface BrowserSessionDownloadChange {
  readonly webContentsId: number;
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

export interface BrowserSessionCertificateErrorChange {
  readonly webContentsId: number;
  readonly certificateErrorId: string;
  readonly url: string;
  readonly hostname: string;
  readonly error: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly issuer: string;
}

interface BrowserSessionPendingCertificateError extends BrowserSessionCertificateErrorChange {
  readonly certificate: Certificate;
}

const BROWSER_ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
  "mediaKeySystem",
  "pointerLock",
  "storage-access",
  "top-level-storage-access",
]);

const installedPolicySessions = new WeakSet<BrowserViewPolicySession>();
const browserWebContentsIds = new Set<number>();
const browserDownloadListeners = new Set<
  (change: BrowserSessionDownloadChange) => void
>();
const browserCertificateListeners = new Set<
  (change: BrowserSessionCertificateErrorChange) => void
>();
const activeDownloadsById = new Map<string, BrowserDownloadItem>();
const pendingCertificateErrorsById = new Map<
  string,
  BrowserSessionPendingCertificateError
>();

/**
 * Sessions are memoised per partition name, not globally: enabling persistence
 * mid-process moves new guests from the ephemeral partition to the persistent
 * one, and each partition needs the hardening installed exactly once.
 * `session.defaultSession` is never touched here - the app shell owns it.
 */
const sessionsByPartition = new Map<string, Session>();
const browserCookieDeltaListeners = new Set<
  (delta: BrowserPrimaryProfileDelta) => void
>();
/** One per process: the durable `primary` jar is the only observed partition. */
let primaryCookieObserver: BrowserCookieChangeObserver | null = null;

export function ensureBrowserViewSession(
  request: BrowserSessionProfileRequest,
): Session {
  return ensureBrowserViewSessionForPartition(
    partitionForProfile(request.profile, request.sessionId),
  );
}

/**
 * The named jar, bypassing the persistence decision. Only the enable-time
 * migration needs this: it has to hold BOTH jars open at once (spec §6.4),
 * which the decision-driven lookup above can never express.
 */
export function ensureBrowserViewSessionForPartition(
  partition: string,
): Session {
  const existing = sessionsByPartition.get(partition);
  if (existing !== undefined) return existing;
  const browserSession = session.fromPartition(partition, { cache: true });
  installBrowserViewSessionPolicy(browserSession);
  sessionsByPartition.set(partition, browserSession);
  observePrimaryProfileCookieChanges(partition, browserSession);
  return browserSession;
}

/**
 * Cookie deltas come from the durable `primary` jar and nowhere else: the
 * ephemeral jar's logins are gone at quit, and an isolated partition shares
 * nothing by construction (spec §6.1). This is also the single attach point for
 * the enable-time migration - it creates the persistent session through this
 * same function, so the jar it copies into is observed from its first cookie.
 */
function observePrimaryProfileCookieChanges(
  partition: string,
  browserSession: Session,
): void {
  if (partition !== BROWSER_VIEW_PARTITION || primaryCookieObserver !== null) {
    return;
  }
  const observer = new BrowserCookieChangeObserver({
    cookies: browserSession.cookies,
    emit: (delta) => {
      browserCookieDeltaListeners.forEach((listener) => listener(delta));
    },
    now: () => Date.now(),
    coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
  });
  observer.attach();
  primaryCookieObserver = observer;
}

/**
 * Every coalesced cookie delta from the durable `primary` jar. The IPC layer
 * fans these out to the renderer, which forwards them to the host as
 * `primaryProfileDelta`.
 */
export function onBrowserPrimaryProfileDelta(
  listener: (delta: BrowserPrimaryProfileDelta) => void,
): () => void {
  browserCookieDeltaListeners.add(listener);
  return () => {
    browserCookieDeltaListeners.delete(listener);
  };
}

/**
 * Runs a deliberate local change to one site's cookies without it echoing back
 * to the host as a delta (ticket 07's "clear cookies for this site").
 */
export async function suppressBrowserPrimaryProfileDelta<T>(
  domain: string,
  action: () => Promise<T>,
): Promise<T> {
  if (primaryCookieObserver === null) return await action();
  return await primaryCookieObserver.suppress(domain, action);
}

export function createBrowserViewWebPreferences(
  request: BrowserSessionProfileRequest,
): WebPreferences {
  return {
    partition: partitionForProfile(request.profile, request.sessionId),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

/**
 * The single place that decides whether a guest gets a durable jar. `primary`
 * only reaches `persist:` when the user enabled persistence on this machine
 * *and* the keystore probe succeeded in this process - anything else stays
 * in memory, which is what keeps a denied keychain usable rather than fatal.
 */
export function partitionForProfile(
  profile: BrowserSessionProfile,
  sessionId: string,
): string {
  // No `persist:` prefix, and the session id in the name: the jar lives in
  // memory only, is shared by nothing else, and is cleared outright when the
  // session's last tab goes away (spec §6.1, decision #24). The persistence
  // decision is deliberately not consulted - an isolated session is ephemeral
  // whether or not the user enabled saved logins.
  if (profile === "isolated") {
    return `${BROWSER_VIEW_ISOLATED_PARTITION_PREFIX}${sessionId}`;
  }
  return ensureBrowserPersistenceForTileOpen().persistence === "persistent"
    ? BROWSER_VIEW_PARTITION
    : BROWSER_VIEW_EPHEMERAL_PARTITION;
}

/**
 * Drops a partition's jar and its memoised session. Only an isolated session's
 * partition is ever released: the shared `primary` jars outlive every guest,
 * and clearing one would sign the user out of the whole app.
 */
export async function releaseBrowserViewSession(
  partition: string,
): Promise<void> {
  if (!partition.startsWith(BROWSER_VIEW_ISOLATED_PARTITION_PREFIX)) {
    throw new Error(
      `Refusing to clear the shared browser partition "${partition}".`,
    );
  }
  const browserSession = sessionsByPartition.get(partition);
  sessionsByPartition.delete(partition);
  if (browserSession === undefined) return;
  try {
    await browserSession.clearStorageData();
  } catch (error) {
    log.warn("[browser-view] isolated partition clear failed", {
      partition,
      error: describeLogError(error),
    });
  }
}

function installBrowserViewSessionPolicy(
  target: BrowserViewPolicySession,
): void {
  if (installedPolicySessions.has(target)) return;
  installedPolicySessions.add(target);

  target.setPermissionRequestHandler(
    (_webContents, permission, callback, _details) => {
      const allowed = isBrowserPermissionAllowed(permission);
      if (!allowed) {
        log.info("[browser-view] permission denied", { permission });
      }
      callback(allowed);
    },
  );
  target.setPermissionCheckHandler(
    (_webContents, permission, _requestingOrigin, _details) =>
      isBrowserPermissionAllowed(permission),
  );
  target.setDevicePermissionHandler(() => false);
  target.setUSBProtectedClassesHandler(() => []);
  target.setBluetoothPairingHandler((_details, callback) => {
    callback({ confirmed: false });
  });
  target.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  });
  target.on("will-download", (_event, item, webContents) => {
    handleBrowserViewDownload(item, webContents);
  });
}

function isBrowserPermissionAllowed(permission: string): boolean {
  return BROWSER_ALLOWED_PERMISSIONS.has(permission);
}

export function registerBrowserViewWebContents(
  webContents: BrowserViewTrackedWebContents,
): void {
  browserWebContentsIds.add(webContents.id);
  webContents.once("destroyed", () => {
    browserWebContentsIds.delete(webContents.id);
    for (const [id, pending] of pendingCertificateErrorsById) {
      if (pending.webContentsId === webContents.id) {
        pendingCertificateErrorsById.delete(id);
      }
    }
  });
}

export function isBrowserViewWebContents(
  webContents: { readonly id: number } | null,
): boolean {
  return webContents !== null && browserWebContentsIds.has(webContents.id);
}

export function onBrowserViewDownloadChange(
  listener: (change: BrowserSessionDownloadChange) => void,
): () => void {
  browserDownloadListeners.add(listener);
  return () => {
    browserDownloadListeners.delete(listener);
  };
}

export function onBrowserViewCertificateError(
  listener: (change: BrowserSessionCertificateErrorChange) => void,
): () => void {
  browserCertificateListeners.add(listener);
  return () => {
    browserCertificateListeners.delete(listener);
  };
}

export function cancelBrowserViewDownload(downloadId: string): boolean {
  const item = activeDownloadsById.get(downloadId);
  if (item === undefined) return false;
  item.cancel();
  return true;
}

export function readBrowserViewPendingCertificateError(
  certificateErrorId: string,
): BrowserSessionPendingCertificateError | null {
  return pendingCertificateErrorsById.get(certificateErrorId) ?? null;
}

export function clearBrowserViewPendingCertificateError(
  certificateErrorId: string,
): void {
  pendingCertificateErrorsById.delete(certificateErrorId);
}

export function handleBrowserViewCertificateError(
  input: CertificateErrorReport,
): boolean {
  const existing = findPendingCertificateError(input);
  if (existing !== null) {
    emitBrowserCertificateError(existing);
    return false;
  }
  const pending: BrowserSessionPendingCertificateError = {
    webContentsId: input.webContentsId,
    certificateErrorId: randomUUID(),
    url: input.url,
    hostname: input.hostname,
    error: input.error,
    fingerprint: input.fingerprint,
    subject: input.certificate.subject.commonName,
    issuer: input.certificate.issuer.commonName,
    certificate: input.certificate,
  };
  pendingCertificateErrorsById.set(pending.certificateErrorId, pending);
  emitBrowserCertificateError(pending);
  log.warn("[browser-view] certificate error rejected", {
    hostname: input.hostname,
    fingerprint: input.fingerprint,
    error: input.error,
    subject: input.certificate.subject.commonName,
    issuer: input.certificate.issuer.commonName,
  });
  return false;
}

/**
 * The app-shell owns Electron's `certificate-error` event; this tells it
 * which webContents are native browser tiles and where their rejected certs
 * go, so `app/cert-trust` never has to reach into browser-view.
 */
setBrowserCertificateErrorHandler({
  owns: (webContentsId) => isBrowserViewWebContents({ id: webContentsId }),
  report: (input) => {
    handleBrowserViewCertificateError(input);
  },
});

function handleBrowserViewDownload(
  item: BrowserDownloadItem,
  webContents: BrowserDownloadWebContents,
): void {
  const downloadId = randomUUID();
  const filename = item.getFilename();
  const dangerType = dangerousDownloadType(filename);
  emitBrowserDownloadChange(item, webContents, {
    downloadId,
    state: "prompting",
    savePath: null,
    dangerType,
    canCancel: true,
  });

  if (
    dangerType !== null &&
    !confirmDangerousDownload(filename, dangerType, item.getURL())
  ) {
    item.cancel();
    emitBrowserDownloadChange(item, webContents, {
      downloadId,
      state: "cancelled",
      savePath: null,
      dangerType,
      canCancel: false,
    });
    return;
  }

  const savePath = dialog.showSaveDialogSync({
    title: "Save download",
    defaultPath: filename,
    buttonLabel: "Save",
  });
  if (savePath === undefined) {
    item.cancel();
    emitBrowserDownloadChange(item, webContents, {
      downloadId,
      state: "cancelled",
      savePath: null,
      dangerType,
      canCancel: false,
    });
    return;
  }

  item.setSavePath(savePath);
  activeDownloadsById.set(downloadId, item);
  log.info("[browser-view] download accepted", {
    url: item.getURL(),
    filename,
    mimeType: item.getMimeType(),
    totalBytes: item.getTotalBytes(),
    initiatedBy: webContents.getURL(),
  });
  emitBrowserDownloadChange(item, webContents, {
    downloadId,
    state: "progressing",
    savePath,
    dangerType,
    canCancel: true,
  });
  item.on("updated", (_updatedEvent, state) => {
    const downloadState =
      state === "interrupted" ? "interrupted" : "progressing";
    emitBrowserDownloadChange(item, webContents, {
      downloadId,
      state: downloadState,
      savePath,
      dangerType,
      canCancel: true,
    });
  });
  item.on("done", (_doneEvent, state) => {
    activeDownloadsById.delete(downloadId);
    const downloadState = terminalDownloadState(state);
    log.info("[browser-view] download finished", {
      url: item.getURL(),
      state,
      receivedBytes: item.getReceivedBytes(),
    });
    emitBrowserDownloadChange(item, webContents, {
      downloadId,
      state: downloadState,
      savePath,
      dangerType,
      canCancel: false,
    });
  });
}

function emitBrowserDownloadChange(
  item: BrowserDownloadItem,
  webContents: BrowserDownloadWebContents,
  state: {
    readonly downloadId: string;
    readonly state: BrowserViewDownloadState;
    readonly savePath: string | null;
    readonly dangerType: string | null;
    readonly canCancel: boolean;
  },
): void {
  const change: BrowserSessionDownloadChange = {
    webContentsId: webContents.id,
    downloadId: state.downloadId,
    url: item.getURL(),
    filename: item.getFilename(),
    mimeType: item.getMimeType(),
    totalBytes: item.getTotalBytes(),
    receivedBytes: item.getReceivedBytes(),
    state: state.state,
    savePath: state.savePath,
    dangerType: state.dangerType,
    canCancel: state.canCancel,
  };
  browserDownloadListeners.forEach((listener) => listener(change));
}

function emitBrowserCertificateError(
  pending: BrowserSessionPendingCertificateError,
): void {
  const change: BrowserSessionCertificateErrorChange = {
    webContentsId: pending.webContentsId,
    certificateErrorId: pending.certificateErrorId,
    url: pending.url,
    hostname: pending.hostname,
    error: pending.error,
    fingerprint: pending.fingerprint,
    subject: pending.subject,
    issuer: pending.issuer,
  };
  browserCertificateListeners.forEach((listener) => listener(change));
}

function terminalDownloadState(state: string): BrowserViewDownloadState {
  if (state === "completed") return "completed";
  if (state === "cancelled") return "cancelled";
  return "interrupted";
}

function confirmDangerousDownload(
  filename: string,
  dangerType: string,
  url: string,
): boolean {
  const response = dialog.showMessageBoxSync({
    type: "warning",
    buttons: ["Cancel", "Save anyway"],
    defaultId: 0,
    cancelId: 0,
    title: "Confirm download",
    message: `Save ${filename}?`,
    detail: `${dangerType} files can run code on your machine.\n\nSource: ${url}`,
    noLink: true,
  });
  return response === 1;
}

function dangerousDownloadType(filename: string): string | null {
  const lower = filename.toLowerCase();
  const extension = lower.includes(".")
    ? lower.slice(lower.lastIndexOf("."))
    : "";
  if (DANGEROUS_DOWNLOAD_EXTENSIONS.has(extension)) return extension;
  return null;
}

function findPendingCertificateError(
  input: CertificateErrorReport,
): BrowserSessionPendingCertificateError | null {
  for (const pending of pendingCertificateErrorsById.values()) {
    if (
      pending.webContentsId === input.webContentsId &&
      pending.fingerprint === input.fingerprint &&
      pending.hostname === input.hostname
    ) {
      return pending;
    }
  }
  return null;
}

const DANGEROUS_DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  ".app",
  ".applescript",
  ".bat",
  ".cmd",
  ".command",
  ".com",
  ".cpl",
  ".dmg",
  ".exe",
  ".hta",
  ".jar",
  ".js",
  ".jse",
  ".msi",
  ".pkg",
  ".ps1",
  ".reg",
  ".scr",
  ".sh",
  ".vb",
  ".vbe",
  ".vbs",
  ".wsf",
]);
