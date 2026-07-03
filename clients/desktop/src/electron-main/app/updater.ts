import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger";
import {
  buildLinuxUpdateGuidance,
  isLinuxEscalationError,
  readLinuxPackageType,
  resolveLinuxSilentInstallSupported,
  type LinuxPackageType,
} from "./linux-update-guidance";
import { UPDATE_BLOCKED_LOCATION_REASON } from "./relocate-to-applications";
import { showSimpleNotification } from "../notifications";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateGuidance,
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
  readonly downloadProgress?: number | null;
  readonly errorMessage?: string | null;
  readonly lastCheckedAt?: string | null;
  readonly lastCheckIntent?: DesktopAppUpdateCheckIntent | null;
}

// Set once at `installAutoUpdater` time from the `package-type` file
// (deb/rpm only - AppImage never gets this file and keeps electron-updater's
// default silent-update path untouched). Drives the `autoInstallOnAppQuit`
// gate below and scopes every other Linux-guidance code path.
let linuxPackageType: LinuxPackageType | null = null;
// Whether an in-place `dpkg -i`/`rpm -U` upgrade would actually succeed and
// replace the binary we're running from (see `linux-update-guidance.ts`).
// Only meaningful when `linuxPackageType !== null`; UX gate, not a safety
// net - `autoInstallOnAppQuit` is disabled for deb/rpm regardless of this.
let linuxSilentInstallSupported = true;
// Path electron-updater downloaded the update to, captured off the
// `update-downloaded` event. Threaded into the guidance command so the user
// runs `dpkg -i`/`rpm -U` against the file we already fetched instead of
// re-downloading by hand.
let linuxDownloadedFile: string | null = null;
// Built once, exactly when we learn silent install won't/didn't work for this
// update cycle - either decided up front (`linuxSilentInstallSupported ===
// false` at download-complete time) or discovered the hard way (a live
// "Restart to update" click hit an escalation failure despite looking safe up
// front). Echoed by reference on every subsequent `emitSnapshot` call rather
// than rebuilt fresh each time, so `sameSnapshot`'s renderer-side dedup (which
// compares this field) doesn't see spurious changes on unrelated re-emits
// while status stays "ready".
let linuxInstallGuidance: DesktopAppUpdateGuidance | null = null;

// Injected from `desktop-startup` so the updater can decide whether to raise an
// OS notification (only when no app window is focused) and bring the app
// forward when the user clicks it. Focus across all windows is only knowable in
// the main process, so the notification decision lives here rather than in any
// single renderer.
export interface AppUpdaterDeps {
  readonly isAnyWindowFocused: () => boolean;
  readonly focusPrimaryWindow: () => void;
  // Returns the user-facing reason when this install can't apply updates from
  // its current location (macOS app outside /Applications), else null. Evaluated
  // on each snapshot so it tracks the live location rather than a frozen value.
  readonly installBlockedReason: () => string | null;
}

const AUTOMATIC_RESUME_CHECK_DEBOUNCE_MS = 30_000;
const CURRENT_VERSION = app.getVersion();
// A SemVer prerelease carries identifiers after `-` (before any `+` build
// metadata), e.g. `1.0.0-rc.1`. We force `allowPrerelease` off (see
// installAutoUpdater) and use this to treat "no GA release exists yet" as a
// non-error on RC builds rather than logging/surfacing a failure.
const IS_PRERELEASE_BUILD = CURRENT_VERSION.split("+")[0].includes("-");
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
// Linux deb/rpm only: a live install attempt hit an escalation failure
// (pkexec/sudo/dpkg/rpm). Unlike the other generic messages, this one points
// at the guidance dialog rather than suggesting a retry - the escalation path
// is now known not to work on this machine, so `installGuidance` is populated
// alongside this message (see `handleUpdaterError`'s `installingUpdate`
// branch).
const UPDATE_ERROR_LINUX_MANUAL_INSTALL_MESSAGE =
  "Traycer couldn't finish installing the update automatically. Follow the instructions below to finish it manually.";

const listeners = new Set<AppUpdateListener>();
let sequence = 0;
let currentSnapshot: DesktopAppUpdateSnapshot = {
  sequence,
  status: "idle",
  currentVersion: CURRENT_VERSION,
  latestVersion: null,
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  errorMessage: null,
  lastCheckedAt: null,
  lastCheckIntent: null,
};
// Resolver for the install-blocked reason, injected at `installAutoUpdater` and
// evaluated fresh for each snapshot (so it tracks the live location).
let resolveInstallBlockedReason: (() => string | null) | null = null;
let updaterDeps: AppUpdaterDeps | null = null;

function currentInstallBlockedReason(): string | null {
  return resolveInstallBlockedReason === null
    ? null
    : resolveInstallBlockedReason();
}

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
export async function installAutoUpdater(
  isDev: boolean,
  deps: AppUpdaterDeps,
): Promise<void> {
  if (installed) {
    return;
  }
  installed = true;
  updaterDeps = deps;
  resolveInstallBlockedReason = deps.installBlockedReason;
  currentSnapshot = {
    ...currentSnapshot,
    installBlockedReason: currentInstallBlockedReason(),
  };
  autoUpdater.logger = log;
  // Never download on our own - the user starts the download from the header
  // button (see `startUpdateDownload`). We only check + surface availability.
  autoUpdater.autoDownload = false;
  if (process.platform === "linux") {
    linuxPackageType = readLinuxPackageType();
    if (linuxPackageType !== null) {
      linuxSilentInstallSupported =
        await resolveLinuxSilentInstallSupported(linuxPackageType);
    }
  }
  // deb/rpm installs require root escalation (pkexec/sudo) to apply -
  // unlike macOS/Windows/AppImage, that escalation can fail in ways that are
  // invisible when attempted from the quit-teardown path (see `doInstall` in
  // `DebUpdater`/`RpmUpdater`): a failure there dispatches an error, but
  // Electron's quit proceeds regardless, so the user just reopens the old
  // binary with no explanation. Disabling this unconditionally for deb/rpm -
  // regardless of `linuxSilentInstallSupported` - means a privileged install
  // is only ever attempted synchronously from the user's explicit "Restart to
  // update" click, where a failure is guaranteed to surface visibly (see
  // `handleUpdaterError`'s `installingUpdate` branch).
  autoUpdater.autoInstallOnAppQuit = linuxPackageType === null;
  // Never auto-update users onto a prerelease, and never let an RC build pick a
  // sibling product's prerelease out of the shared releases repo. electron-
  // updater auto-enables `allowPrerelease` for an RC app version, and on that
  // path its private GitHub provider returns the newest *prerelease* in the
  // whole repo regardless of tag prefix - which lands on a `host-v*` release and
  // 404s on `latest-mac.yml`. Forcing it off routes to the stable
  // `/releases/latest` feed, which honors the desktop release's `--latest` flag
  // (host/CLI releases are always `--latest=false`). Stable builds already
  // resolve to `false`, so this only changes RC behaviour.
  autoUpdater.allowPrerelease = false;
  configurePrivateGitHubUpdateFeed();

  autoUpdater.on("checking-for-update", () =>
    log.debug("[updater] checking for updates"),
  );
  autoUpdater.on("update-available", (info) => {
    log.info("[updater] update available", info);
    // Already past the "found it" stage (downloading / downloaded), or already
    // surfaced as available - don't re-emit or re-notify on a later re-check.
    if (
      currentSnapshot.status === "available" ||
      currentSnapshot.status === "downloading" ||
      currentSnapshot.status === "ready" ||
      downloadInProgress
    ) {
      return;
    }
    const intent = checkIntent ?? "automatic";
    emitSnapshot({
      status: "available",
      latestVersion: info.version,
      downloadProgress: null,
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
      lastCheckIntent: intent,
    });
    notifyUpdateWhenUnfocused("available", info.version);
  });
  autoUpdater.on("update-not-available", (info) => {
    log.debug("[updater] no update available", info);
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
  autoUpdater.on("download-progress", (progress) => {
    log.debug("[updater] download progress", progress);
    if (currentSnapshot.status === "ready" || !downloadInProgress) {
      return;
    }
    emitSnapshot({
      status: "downloading",
      downloadProgress: clampPercent(progress.percent),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    log.info("[updater] update downloaded - ready to install", info);
    if (currentSnapshot.status === "ready") {
      return;
    }
    linuxDownloadedFile = info.downloadedFile;
    linuxInstallGuidance =
      linuxPackageType !== null && !linuxSilentInstallSupported
        ? buildLinuxUpdateGuidance(
            linuxPackageType,
            info.version,
            linuxDownloadedFile,
          )
        : null;
    const intent = downloadIntent ?? checkIntent ?? "automatic";
    downloadInProgress = false;
    downloadIntent = null;
    emitSnapshot({
      status: "ready",
      latestVersion: info.version,
      downloadProgress: null,
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
      lastCheckIntent: intent,
    });
    notifyUpdateWhenUnfocused("ready", info.version);
  });
  autoUpdater.on("error", (err) => {
    if (handledNoStableReleaseForPrerelease(err)) {
      return;
    }
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
  // An update is found but not yet downloading: the header button already shows
  // "Download update", so a re-check (automatic resume or manual) is a no-op
  // rather than re-running the feed query and re-firing the availability notice.
  if (currentSnapshot.status === "available") {
    return currentSnapshot;
  }
  if (!(await canCheckForUpdates(isDev))) {
    log.debug("[updater] check skipped outside a shipped build");
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
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (!handledNoStableReleaseForPrerelease(err)) {
      log.warn("[updater] check failed", err);
      emitCheckErrorFromCatch(err, checkIntent ?? intent);
    }
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

/**
 * Starts downloading the update the user just opted into from the header
 * button. Only valid once the feed reported an update as `available`; a
 * second call while already downloading is a no-op (re-asserts the state).
 */
export function startUpdateDownload(): DesktopAppUpdateSnapshot {
  // Updates can't be installed from this location (read-only volume), so never
  // start a download that would fail at install time. The renderer also
  // disables the trigger, but guard here too. Re-emit so the live blocked
  // reason (resolved lazily) reaches the renderer instead of returning a
  // snapshot frozen at the last emit.
  if (currentInstallBlockedReason() !== null) {
    return emitSnapshot({});
  }
  if (currentSnapshot.status === "downloading" || downloadInProgress) {
    return currentSnapshot;
  }
  if (currentSnapshot.status !== "available") {
    return currentSnapshot;
  }
  downloadInProgress = true;
  downloadIntent = "manual";
  emitSnapshot({
    status: "downloading",
    downloadProgress: 0,
    errorMessage: null,
    lastCheckedAt: new Date().toISOString(),
    lastCheckIntent: "manual",
  });
  void autoUpdater.downloadUpdate().catch((err) => {
    if (!handledNoStableReleaseForPrerelease(err)) {
      log.warn("[updater] download failed", err);
      handleUpdaterError(err);
    }
  });
  return currentSnapshot;
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
  log.debug("[updater] configured private GitHub update feed", {
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

// Raises an OS notification only when none of the app's windows is focused -
// while the user is in the app the header button is the affordance, so a
// notification would be noise. Clicking the notification brings the app
// forward. Fired on the "available" and "ready" transitions only.
function notifyUpdateWhenUnfocused(
  kind: "available" | "ready",
  version: string | null,
): void {
  if (updaterDeps === null || updaterDeps.isAnyWindowFocused()) {
    return;
  }
  const focus = updaterDeps.focusPrimaryWindow;
  const versionLabel = version === null ? "" : ` v${version}`;
  if (kind === "available") {
    // When updates can't be installed from this location, point at the fix
    // instead of telling the user to download something they can't apply.
    showSimpleNotification(
      "Traycer update available",
      currentInstallBlockedReason() ??
        `Open Traycer to download${versionLabel}.`,
      focus,
    );
    return;
  }
  showSimpleNotification(
    "Traycer update ready",
    `Restart Traycer to install${versionLabel}.`,
    focus,
  );
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function emitSnapshot(patch: AppUpdateSnapshotPatch): DesktopAppUpdateSnapshot {
  sequence += 1;
  const status = patch.status ?? currentSnapshot.status;
  let downloadProgress: number | null = null;
  if (status === "downloading") {
    const nextDownloadProgress =
      patch.downloadProgress === undefined
        ? currentSnapshot.downloadProgress
        : patch.downloadProgress;
    downloadProgress = nextDownloadProgress ?? 0;
  }
  currentSnapshot = {
    ...currentSnapshot,
    sequence,
    status,
    installBlockedReason: currentInstallBlockedReason(),
    installGuidance: linuxInstallGuidance,
    latestVersion:
      patch.latestVersion === undefined
        ? currentSnapshot.latestVersion
        : patch.latestVersion,
    downloadProgress,
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

// Expected outcome for an RC build: with `allowPrerelease` forced off we query
// the stable `/releases/latest` feed, which 404s until the first GA release
// exists (surfaced as ERR_UPDATER_LATEST_VERSION_NOT_FOUND). That is not a
// failure for a prerelease, so we log it quietly and report "no update" instead
// of error-logging and showing a service-unavailable message. Returns true when
// it handled the error (callers must then treat it as non-fatal). The error
// event fires before `checkForUpdatesAndNotify()` rejects, so both the `error`
// listener and the check's `catch` call this; `checkErrorEmitted` makes the
// second call a no-op.
const NO_STABLE_RELEASE_ERROR_HINTS: readonly string[] = [
  "err_updater_latest_version_not_found",
  "please ensure a production release exists",
  "no published versions",
];

function handledNoStableReleaseForPrerelease(error: unknown): boolean {
  if (!IS_PRERELEASE_BUILD) {
    return false;
  }
  const rawMessage =
    error instanceof Error && error.message.length > 0
      ? error.message
      : String(error);
  if (!includesAny(rawMessage.toLowerCase(), NO_STABLE_RELEASE_ERROR_HINTS)) {
    return false;
  }
  if (checkErrorEmitted) {
    return true;
  }
  checkErrorEmitted = true;
  log.debug(
    "[updater] no production release to update to yet (prerelease build) - skipping",
  );
  if (currentSnapshot.status === "ready" || downloadInProgress) {
    return true;
  }
  const intent = checkIntent ?? "automatic";
  emitSnapshot({
    status: intent === "manual" ? "up-to-date" : "idle",
    errorMessage: null,
    lastCheckedAt: new Date().toISOString(),
    lastCheckIntent: intent,
  });
  return true;
}

function handleUpdaterError(error: unknown): void {
  // An error after the user chose "Restart" (quitAndInstall) must NOT be
  // swallowed by the "ready" guard below: the install failed, the app won't
  // relaunch, and the user is left staring at a confirmation that did nothing
  // (e.g. macOS "read-only volume" / App Translocation). Surface it and clear
  // the install flag so they can retry once the cause is fixed.
  if (installingUpdate) {
    installingUpdate = false;
    // Pre-flight said this install could self-update, but the live escalation
    // attempt (pkexec/sudo/dpkg/rpm) still failed - e.g. a minimal window
    // manager with no polkit agent. We now know for certain silent install
    // doesn't work here, so switch to the same guidance a blocked pre-flight
    // would have shown instead of a generic "try again later" that just
    // invites the same doomed retry.
    const isLinuxEscalationFailure =
      linuxPackageType !== null &&
      isLinuxEscalationError(rawErrorMessage(error));
    if (isLinuxEscalationFailure && linuxPackageType !== null) {
      linuxInstallGuidance = buildLinuxUpdateGuidance(
        linuxPackageType,
        currentSnapshot.latestVersion,
        linuxDownloadedFile,
      );
    }
    emitSnapshot({
      status: "error",
      errorMessage: isLinuxEscalationFailure
        ? UPDATE_ERROR_LINUX_MANUAL_INSTALL_MESSAGE
        : readErrorMessage(error),
      lastCheckedAt: new Date().toISOString(),
      lastCheckIntent: "manual",
    });
    return;
  }
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

function rawErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : String(error);
}

function readErrorMessage(error: unknown): string {
  return formatUserVisibleUpdateError(rawErrorMessage(error));
}

// Maps any `electron-updater` failure onto one of a few generic, user-safe
// messages. Crucially the raw text is NEVER returned - even an unrecognized
// error falls through to the generic message - so HTTP bodies, response
// headers, cookies, and auth-token hints can't leak into the UI. The hint sets
// below only pick which reassuring message to show, not whether to sanitize.
function formatUserVisibleUpdateError(rawMessage: string): string {
  const message = rawMessage.toLowerCase();
  // macOS-only: App Translocation / read-only volume - the user is running from
  // a read-only path so the installer can't replace the app. The remedy ("move
  // to Applications") is macOS-specific, so only map it on darwin; on
  // Windows/Linux a read-only/permission failure falls through to the generic
  // install message below.
  if (
    process.platform === "darwin" &&
    includesAny(message, READ_ONLY_VOLUME_ERROR_HINTS)
  ) {
    return UPDATE_BLOCKED_LOCATION_REASON;
  }
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

// macOS Squirrel.Mac refuses to apply an update when the running app sits on a
// read-only volume - typically Gatekeeper App Translocation running a
// quarantined copy from a randomized read-only mount. User-fixable by moving
// the app to /Applications and reopening it.
const READ_ONLY_VOLUME_ERROR_HINTS: readonly string[] = [
  "read-only volume",
  "read only volume",
  "move the application",
  "translocat",
  "app translocation",
  "downloads directory",
];

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
