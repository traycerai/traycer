import {
  dialog,
  session,
  type Certificate,
  type Session,
  type WebPreferences,
} from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserViewDownloadState } from "@traycer-clients/shared/platform/browser-view";
import type {
  BrowserCookieKey,
  BrowserPrimaryProfileDelta,
} from "@traycer/protocol/host/browser/contracts";
import { describeLogError, log } from "../app/logger";
import { confirmDestructiveInMainSync } from "../app/confirm-destructive";
import {
  setBrowserCertificateErrorHandler,
  type CertificateErrorReport,
} from "../app/cert-trust";
import { isBrowserSavedLoginsEnabled } from "./storage/browser-saved-logins";
import { releaseHeadlessOriginCookieKeys } from "./storage/browser-forget-ledger";
import {
  BrowserCookieChangeObserver,
  BROWSER_COOKIE_DELTA_WINDOW_MS,
} from "./storage/browser-cookie-change-observer";

export const BROWSER_VIEW_PARTITION = "persist:traycer-browser";
export const BROWSER_VIEW_EPHEMERAL_PARTITION = "traycer-browser-ephemeral";
const BROWSER_VIEW_ISOLATED_PARTITION_PREFIX = "traycer-isolated-";

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

interface BrowserViewBeforeRequestDetails {
  readonly url: string;
  readonly webContentsId?: number;
}

type BrowserViewBeforeRequestListener = (
  details: BrowserViewBeforeRequestDetails,
  callback: (response: { readonly cancel?: boolean }) => void,
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
  readonly webRequest: {
    onBeforeRequest(listener: BrowserViewBeforeRequestListener): void;
  };
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
const gatedGuestWebContentsIds = new Set<number>();
const BLANK_GUEST_REQUEST_URL = "about:blank";
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

/** `session.defaultSession` is never touched here - the app shell owns it. */
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

/** Guests get this clean UA too, but not via a session-level `setUserAgent` call here: guest partition sessions are never the default session, so with no explicit session UA they. */
export function guestBrowserUserAgent(): string {
  const platformToken = guestBrowserPlatformToken();
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

function guestBrowserPlatformToken(): string {
  if (process.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (process.platform === "win32") return "Windows NT 10.0; Win64; x64";
  return "X11; Linux x86_64";
}

/** The named jar, bypassing the saved-logins pref. */
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
    monotonicNow: () => performance.now(),
    coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
    // The handler is synchronous, so the promise cannot be awaited here.
    onLocalCookieWrite: (key) => void releaseHeadlessOriginCookieKeys([key]),
  });
  observer.attach();
  primaryCookieObserver = observer;
}

export function onBrowserPrimaryProfileDelta(
  listener: (delta: BrowserPrimaryProfileDelta) => void,
): () => void {
  browserCookieDeltaListeners.add(listener);
  return () => {
    browserCookieDeltaListeners.delete(listener);
  };
}

export async function suppressAllBrowserPrimaryProfileDeltas<T>(
  action: () => Promise<T>,
): Promise<T> {
  if (primaryCookieObserver === null) return await action();
  return await primaryCookieObserver.suppressAll(action);
}

/**
 * The observed-sign-in applier is about to write these keys into the DURABLE jar (universal-sign-in ticket 08). Their insert events belong to the applier, not to this machine's.
 * A no-op when that jar has never been materialised this run - there is no observer, and therefore no insert to attribute either way.
 */
export function noteBrowserPrimaryProfileAppliedKeys(
  keys: readonly BrowserCookieKey[],
): void {
  primaryCookieObserver?.noteAppliedKeys(keys);
}

/** The jar refused those writes, so the marks will never be answered. */
export function forgetBrowserPrimaryProfileAppliedKeys(
  keys: readonly BrowserCookieKey[],
): void {
  primaryCookieObserver?.forgetAppliedKeys(keys);
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

export function partitionForProfile(
  profile: BrowserSessionProfile,
  sessionId: string,
): string {
  if (profile === "isolated") {
    return `${BROWSER_VIEW_ISOLATED_PARTITION_PREFIX}${sessionId}`;
  }
  return isBrowserSavedLoginsEnabled()
    ? BROWSER_VIEW_PARTITION
    : BROWSER_VIEW_EPHEMERAL_PARTITION;
}

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
  target.webRequest.onBeforeRequest((details, callback) => {
    const webContentsId = details.webContentsId;
    if (
      webContentsId !== undefined &&
      gatedGuestWebContentsIds.has(webContentsId) &&
      details.url !== BLANK_GUEST_REQUEST_URL
    ) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  target.on("will-download", (_event, item, webContents) => {
    handleBrowserViewDownload(item, webContents);
  });
}

export function gateBrowserViewGuestRequests(
  webContentsId: number,
): () => void {
  gatedGuestWebContentsIds.add(webContentsId);
  return () => {
    gatedGuestWebContentsIds.delete(webContentsId);
  };
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
    !confirmDestructiveInMainSync({
      title: "Confirm download",
      message: `Save ${filename}?`,
      detail: `${dangerType} files can run code on your machine.\n\nSource: ${item.getURL()}`,
      confirmLabel: "Save anyway",
    })
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
