import {
  dialog,
  session,
  type Certificate,
  type Session,
  type WebPreferences,
} from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserCookieCryptoState } from "../../ipc-contracts/browser-view-types";
import { log } from "../app/logger";
import { getBrowserCookieCryptoState } from "./browser-cookie-crypto";

export const BROWSER_VIEW_PARTITION = "persist:traycer-browser";
export const BROWSER_VIEW_EPHEMERAL_PARTITION = "traycer-browser-ephemeral";

export type BrowserPermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (permissionGranted: boolean) => void,
  details: unknown,
) => void;

export type BrowserPermissionCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: unknown,
) => boolean;

export type BrowserDownloadListener = (
  event: unknown,
  item: BrowserDownloadItem,
  webContents: BrowserDownloadWebContents,
) => void;

export type BrowserDisplayMediaRequestHandler = (
  request: unknown,
  callback: (streams: object) => void,
) => void;

export interface BrowserViewPolicySession {
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

export interface BrowserViewTrackedWebContents {
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

export interface BrowserViewCertificateError {
  readonly webContentsId: number;
  readonly url: string;
  readonly hostname: string;
  readonly error: string;
  readonly fingerprint: string;
  readonly certificate: Certificate;
}

export type BrowserViewDownloadState =
  "prompting" | "progressing" | "completed" | "cancelled" | "interrupted";

export interface BrowserViewDownloadChange {
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

export interface BrowserViewCertificateErrorChange {
  readonly webContentsId: number;
  readonly certificateErrorId: string;
  readonly url: string;
  readonly hostname: string;
  readonly error: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly issuer: string;
}

export interface BrowserViewPendingCertificateError extends BrowserViewCertificateErrorChange {
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
  (change: BrowserViewDownloadChange) => void
>();
const browserCertificateListeners = new Set<
  (change: BrowserViewCertificateErrorChange) => void
>();
const activeDownloadsById = new Map<string, BrowserDownloadItem>();
const pendingCertificateErrorsById = new Map<
  string,
  BrowserViewPendingCertificateError
>();

export function ensureBrowserViewSession(): Session {
  const browserSession = session.fromPartition(getBrowserViewPartition(), {
    cache: true,
  });
  installBrowserViewSessionPolicy(browserSession);
  return browserSession;
}

export function createBrowserViewWebPreferences(): WebPreferences {
  return {
    partition: getBrowserViewPartition(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

export function getBrowserViewPartition(): string {
  return browserViewPartitionForCryptoState(getBrowserCookieCryptoState());
}

export function browserViewPartitionForCryptoState(
  state: BrowserCookieCryptoState,
): string {
  return state.mode === "degraded"
    ? BROWSER_VIEW_EPHEMERAL_PARTITION
    : BROWSER_VIEW_PARTITION;
}

export function installBrowserViewSessionPolicy(
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

export function isBrowserPermissionAllowed(permission: string): boolean {
  return BROWSER_ALLOWED_PERMISSIONS.has(permission);
}

export function registerBrowserViewWebContents(
  webContents: BrowserViewTrackedWebContents,
): void {
  browserWebContentsIds.add(webContents.id);
  webContents.once("destroyed", () => {
    browserWebContentsIds.delete(webContents.id);
  });
}

export function isBrowserViewWebContents(
  webContents: { readonly id: number } | null,
): boolean {
  return webContents !== null && browserWebContentsIds.has(webContents.id);
}

export function onBrowserViewDownloadChange(
  listener: (change: BrowserViewDownloadChange) => void,
): () => void {
  browserDownloadListeners.add(listener);
  return () => {
    browserDownloadListeners.delete(listener);
  };
}

export function onBrowserViewCertificateError(
  listener: (change: BrowserViewCertificateErrorChange) => void,
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
): BrowserViewPendingCertificateError | null {
  return pendingCertificateErrorsById.get(certificateErrorId) ?? null;
}

export function clearBrowserViewPendingCertificateError(
  certificateErrorId: string,
): void {
  pendingCertificateErrorsById.delete(certificateErrorId);
}

export function handleBrowserViewCertificateError(
  input: BrowserViewCertificateError,
): boolean {
  const existing = findPendingCertificateError(input);
  if (existing !== null) {
    emitBrowserCertificateError(existing);
    return false;
  }
  const pending: BrowserViewPendingCertificateError = {
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
  const change: BrowserViewDownloadChange = {
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
  pending: BrowserViewPendingCertificateError,
): void {
  const change: BrowserViewCertificateErrorChange = {
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
  input: BrowserViewCertificateError,
): BrowserViewPendingCertificateError | null {
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
