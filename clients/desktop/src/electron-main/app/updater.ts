import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdateStatus,
} from "../../ipc-contracts/app-update-types";

type AppUpdateListener = (snapshot: DesktopAppUpdateSnapshot) => void;
interface GitHubRepoCoordinate {
  readonly owner: string;
  readonly repo: string;
}
interface PrivateGitHubUpdateFeed {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly private: true;
  readonly token: string;
}
interface AppUpdateSnapshotPatch {
  readonly status?: DesktopAppUpdateStatus;
  readonly latestVersion?: string | null;
  readonly errorMessage?: string | null;
  readonly lastCheckedAt?: string | null;
  readonly lastCheckIntent?: DesktopAppUpdateCheckIntent | null;
}

const AUTOMATIC_RESUME_CHECK_DEBOUNCE_MS = 30_000;
const CURRENT_VERSION = app.getVersion();
const PRIVATE_UPDATE_REPO = process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO ?? "";
const PRIVATE_UPDATE_TOKEN =
  process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN ?? "";

// User-facing copy for the update failure classes. Deliberately generic and
// reassuring - users shouldn't see release-feed internals, HTTP bodies, or be
// asked to reason about repository visibility. The raw error is still logged,
// and the renderer offers "Report an issue" (which privately attaches logs) so
// support has the real diagnostics for anything the user can't resolve.
const UPDATE_ERROR_OFFLINE_MESSAGE =
  "Traycer couldn't connect to check for updates. Please check your internet connection and try again.";
const UPDATE_ERROR_SERVICE_MESSAGE =
  "Traycer couldn't reach the update service right now. Please try again in a little while.";
const UPDATE_ERROR_DOWNLOAD_MESSAGE =
  "Traycer couldn't download and install the latest update. Please try again in a little while.";
const UPDATE_ERROR_GENERIC_MESSAGE =
  "Traycer ran into a problem while updating. Please try again in a little while.";

const listeners = new Set<AppUpdateListener>();
let sequence = 0;
let currentSnapshot: DesktopAppUpdateSnapshot = {
  sequence,
  status: "idle",
  currentVersion: CURRENT_VERSION,
  latestVersion: null,
  errorMessage: null,
  lastCheckedAt: null,
  lastCheckIntent: null,
};
let installed = false;
let checkInFlight = false;
let checkIntent: DesktopAppUpdateCheckIntent | null = null;
let checkErrorEmitted = false;
let downloadInProgress = false;
let downloadIntent: DesktopAppUpdateCheckIntent | null = null;
let lastResumeCheckAtMs = 0;
// Raised the moment we hand off to `quitAndInstall`. The `before-quit`
// handler reads this to let the install-driven `app.quit()` through instead
// of intercepting it with the unsynced-edits prompt - the user already chose
// to restart, so blocking the quit would silently swallow the install.
let installingUpdate = false;

/**
 * Wires `electron-updater` to the GitHub Releases publish target declared in
 * `package.json` (`build.publish`). Actual release channels, signing, and
 * promotion flows are set up in T5 (CI/CD) - here we only install the core
 * wiring so the desktop shell checks for updates at startup and surfaces
 * progress through `electron-log`.
 *
 * `isDev` (resolved once into DesktopConfig) gates updates off when the dev
 * orchestrator is in charge.
 */
export async function installAutoUpdater(isDev: boolean): Promise<void> {
  if (installed) {
    return;
  }
  installed = true;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  configurePrivateGitHubUpdateFeed();

  autoUpdater.on("checking-for-update", () =>
    log.info("[updater] checking for updates"),
  );
  autoUpdater.on("update-available", (info) => {
    log.info("[updater] update available", info);
    if (currentSnapshot.status === "ready") {
      return;
    }
    const intent = checkIntent ?? "automatic";
    downloadInProgress = true;
    downloadIntent = intent;
    emitSnapshot({
      status: "downloading",
      latestVersion: info.version,
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
      lastCheckIntent: intent,
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    log.info("[updater] no update available", info);
    if (currentSnapshot.status === "ready") {
      return;
    }
    const intent = checkIntent ?? "automatic";
    downloadInProgress = false;
    downloadIntent = null;
    emitSnapshot({
      status: intent === "manual" ? "up-to-date" : "idle",
      latestVersion: info.version ?? null,
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
      lastCheckIntent: intent,
    });
  });
  autoUpdater.on("download-progress", (progress) =>
    log.info("[updater] download progress", progress),
  );
  autoUpdater.on("update-downloaded", (info) => {
    log.info("[updater] update downloaded - ready to install", info);
    if (currentSnapshot.status === "ready") {
      return;
    }
    const intent = downloadIntent ?? checkIntent ?? "automatic";
    downloadInProgress = false;
    downloadIntent = null;
    emitSnapshot({
      status: "ready",
      latestVersion: info.version,
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
      lastCheckIntent: intent,
    });
  });
  autoUpdater.on("error", (err) => {
    log.error("[updater] error", err);
    handleUpdaterError(err);
  });

  if (await canCheckForUpdates(isDev)) {
    void checkForUpdatesNow(isDev, "automatic");
  }
}

export async function checkForUpdatesNow(
  isDev: boolean,
  intent: DesktopAppUpdateCheckIntent,
): Promise<DesktopAppUpdateSnapshot> {
  if (currentSnapshot.status === "ready") {
    if (intent === "manual") {
      emitSnapshot({
        status: "ready",
        errorMessage: null,
        lastCheckIntent: intent,
      });
    }
    return currentSnapshot;
  }
  if (downloadInProgress || currentSnapshot.status === "downloading") {
    if (intent === "manual") {
      downloadIntent = "manual";
      emitSnapshot({
        status: "downloading",
        errorMessage: null,
        lastCheckIntent: intent,
      });
    }
    return currentSnapshot;
  }
  if (!(await canCheckForUpdates(isDev))) {
    log.info("[updater] check skipped outside a shipped build");
    if (intent === "manual") {
      emitSnapshot({
        status: "unavailable",
        errorMessage: "Updates are not available for this build.",
        lastCheckedAt: new Date().toISOString(),
        lastCheckIntent: intent,
      });
    }
    return currentSnapshot;
  }
  if (checkInFlight) {
    if (intent === "manual") {
      checkIntent = "manual";
      emitSnapshot({
        status: "checking",
        errorMessage: null,
        lastCheckedAt:
          currentSnapshot.lastCheckedAt ?? new Date().toISOString(),
        lastCheckIntent: intent,
      });
    }
    return currentSnapshot;
  }
  checkInFlight = true;
  checkIntent = intent;
  checkErrorEmitted = false;
  if (intent === "manual") {
    emitSnapshot({
      status: "checking",
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
      lastCheckIntent: intent,
    });
  }
  try {
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    log.warn("[updater] check failed", err);
    emitCheckErrorFromCatch(err, checkIntent ?? intent);
  } finally {
    checkInFlight = false;
    checkIntent = null;
    checkErrorEmitted = false;
  }
  return currentSnapshot;
}

export function checkForUpdatesAfterResume(isDev: boolean): void {
  const nowMs = Date.now();
  if (nowMs - lastResumeCheckAtMs < AUTOMATIC_RESUME_CHECK_DEBOUNCE_MS) {
    return;
  }
  lastResumeCheckAtMs = nowMs;
  void checkForUpdatesNow(isDev, "automatic");
}

export function installDownloadedUpdate(): DesktopAppUpdateSnapshot {
  if (currentSnapshot.status !== "ready") {
    emitSnapshot({
      status: "error",
      errorMessage: "No downloaded update is ready to install.",
      lastCheckedAt: currentSnapshot.lastCheckedAt,
      lastCheckIntent: "manual",
    });
    return currentSnapshot;
  }
  installingUpdate = true;
  autoUpdater.quitAndInstall(false, true);
  return currentSnapshot;
}

/**
 * True once {@link installDownloadedUpdate} has handed off to
 * `quitAndInstall`. The `before-quit` handler uses this to authorize the
 * resulting quit rather than intercepting it with the unsynced-edits prompt.
 */
export function isInstallingUpdate(): boolean {
  return installingUpdate;
}

export function getAppUpdateSnapshot(): DesktopAppUpdateSnapshot {
  return currentSnapshot;
}

export function onAppUpdateChange(listener: AppUpdateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function canCheckForUpdates(isDev: boolean): Promise<boolean> {
  // `isDev` is the dev deploy slot (the development build) - it never has a
  // real update feed, so skip the updater entirely.
  if (isDev) return false;
  // `electron-builder --dir` (used by `make install-desktop-staging`
  // and `make install-desktop-production` for dogfood installs)
  // never emits `app-update.yml`. With no feed config on disk,
  // `electron-updater` throws ENOENT every launch and clutters the
  // log. Real CI release builds DO emit the file via the `publish`
  // configuration, so the file's presence is a faithful "has a real
  // update feed" signal.
  const feedConfigPath = join(process.resourcesPath, "app-update.yml");
  return access(feedConfigPath).then(
    () => true,
    () => false,
  );
}

function configurePrivateGitHubUpdateFeed(): void {
  const token = PRIVATE_UPDATE_TOKEN.trim();
  if (token.length === 0) {
    return;
  }
  const coordinate = parseGitHubRepoCoordinate(PRIVATE_UPDATE_REPO);
  if (coordinate === null) {
    log.warn(
      "[updater] private GitHub update token is configured but VITE_TRAYCER_DESKTOP_UPDATE_REPO is not a valid owner/repo coordinate",
    );
    return;
  }
  const feed: PrivateGitHubUpdateFeed = {
    provider: "github",
    owner: coordinate.owner,
    repo: coordinate.repo,
    private: true,
    token,
  };
  autoUpdater.setFeedURL(feed);
  log.info("[updater] configured private GitHub update feed", {
    repo: `${coordinate.owner}/${coordinate.repo}`,
  });
}

function parseGitHubRepoCoordinate(value: string): GitHubRepoCoordinate | null {
  const parts = value
    .trim()
    .split("/")
    .filter((part) => part.length > 0);
  if (parts.length !== 2) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}

function emitSnapshot(patch: AppUpdateSnapshotPatch): DesktopAppUpdateSnapshot {
  sequence += 1;
  currentSnapshot = {
    ...currentSnapshot,
    sequence,
    status: patch.status ?? currentSnapshot.status,
    latestVersion:
      patch.latestVersion === undefined
        ? currentSnapshot.latestVersion
        : patch.latestVersion,
    errorMessage:
      patch.errorMessage === undefined
        ? currentSnapshot.errorMessage
        : patch.errorMessage,
    lastCheckedAt:
      patch.lastCheckedAt === undefined
        ? currentSnapshot.lastCheckedAt
        : patch.lastCheckedAt,
    lastCheckIntent:
      patch.lastCheckIntent === undefined
        ? currentSnapshot.lastCheckIntent
        : patch.lastCheckIntent,
  };
  for (const listener of listeners) {
    listener(currentSnapshot);
  }
  return currentSnapshot;
}

function handleUpdaterError(error: unknown): void {
  if (currentSnapshot.status === "ready") {
    return;
  }
  const errorMessage = readErrorMessage(error);
  const lastCheckedAt = new Date().toISOString();
  if (downloadInProgress || currentSnapshot.status === "downloading") {
    const intent =
      downloadIntent ??
      checkIntent ??
      currentSnapshot.lastCheckIntent ??
      "automatic";
    downloadInProgress = false;
    downloadIntent = null;
    emitSnapshot({
      status: "error",
      errorMessage,
      lastCheckedAt,
      lastCheckIntent: intent,
    });
    return;
  }
  if (!checkInFlight) {
    return;
  }
  emitCheckErrorFromCatch(error, checkIntent ?? "automatic");
}

function emitCheckErrorFromCatch(
  error: unknown,
  intent: DesktopAppUpdateCheckIntent,
): void {
  if (checkErrorEmitted) {
    return;
  }
  checkErrorEmitted = true;
  if (intent !== "manual") {
    return;
  }
  emitSnapshot({
    status: "error",
    errorMessage: readErrorMessage(error),
    lastCheckedAt: new Date().toISOString(),
    lastCheckIntent: intent,
  });
}

function readErrorMessage(error: unknown): string {
  const rawMessage =
    error instanceof Error && error.message.length > 0
      ? error.message
      : String(error);
  return formatUserVisibleUpdateError(rawMessage);
}

// Maps any `electron-updater` failure onto one of a few generic, user-safe
// messages. Crucially the raw text is NEVER returned - even an unrecognized
// error falls through to the generic message - so HTTP bodies, response
// headers, cookies, and auth-token hints can't leak into the UI. The hint sets
// below only pick which reassuring message to show, not whether to sanitize.
function formatUserVisibleUpdateError(rawMessage: string): string {
  const message = rawMessage.toLowerCase();
  if (includesAny(message, CONNECTIVITY_ERROR_HINTS)) {
    return UPDATE_ERROR_OFFLINE_MESSAGE;
  }
  if (includesAny(message, INSTALL_ERROR_HINTS)) {
    return UPDATE_ERROR_DOWNLOAD_MESSAGE;
  }
  if (includesAny(message, SERVICE_ERROR_HINTS)) {
    return UPDATE_ERROR_SERVICE_MESSAGE;
  }
  return UPDATE_ERROR_GENERIC_MESSAGE;
}

function includesAny(message: string, hints: readonly string[]): boolean {
  return hints.some((hint) => message.includes(hint));
}

// Socket/DNS/proxy level failures the user can usually fix themselves (Wi-Fi,
// VPN, captive portal). Covers Chromium `net::ERR_*`, Node errno codes, and
// the wake-from-sleep `ERR_NETWORK_CHANGED` class.
const CONNECTIVITY_ERROR_HINTS: readonly string[] = [
  "err_internet_disconnected",
  "err_network_changed",
  "err_name_not_resolved",
  "err_connection_refused",
  "err_connection_reset",
  "err_connection_closed",
  "err_connection_timed_out",
  "err_address_unreachable",
  "err_proxy_connection_failed",
  "err_timed_out",
  "enotfound",
  "eai_again",
  "etimedout",
  "econnrefused",
  "econnreset",
  "enetunreach",
  "ehostunreach",
  "epipe",
  "getaddrinfo",
  "network change",
  "offline",
];

// The update was located but couldn't be downloaded, verified, or applied:
// checksum/signature mismatch, full disk, or filesystem permission errors.
const INSTALL_ERROR_HINTS: readonly string[] = [
  "sha512",
  "sha256",
  "checksum",
  "integrity",
  "signature",
  "not signed",
  "code sign",
  "enospc",
  "eacces",
  "eperm",
  "cannot find the file",
  "differential download",
];

// The update feed/service was reachable but returned an error response, or a
// raw HTTP error body leaked through (GitHub `releases.atom` 404, status codes,
// missing channel manifests). All of these are transient/server-side.
const SERVICE_ERROR_HINTS: readonly string[] = [
  "releases.atom",
  "status code",
  "statuscode",
  "404",
  "403",
  "401",
  "500",
  "502",
  "503",
  "504",
  "httperror",
  "not found",
  "forbidden",
  "unable to find",
  "no published versions",
  "latest.yml",
  "latest-mac.yml",
  "latest-linux.yml",
  "app-update.yml",
  "method: get",
  "headers:",
  "set-cookie",
  "authentication token",
];
