import { app } from "electron";
import { autoUpdater } from "electron-updater";
// Type-only: erased at compile time, so it is unaffected by the unit suite's
// `electron-updater` package-root mock (which exports `autoUpdater` alone).
import type { VerifyUpdateCodeSignature } from "electron-updater";
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { release as osRelease } from "node:os";
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
import { compareHostVersions } from "../cli/cli-discovery";
import {
  hydrateUpdatePreferences,
  prereleaseUpdatesEnabled,
  setPrereleaseUpdatesEnabled as persistPrereleaseUpdatesEnabled,
} from "./update-preferences";
import {
  buildDesktopReleaseFeed,
  isPlatformCompatibleRelease,
  platformChannelFile,
  projectDesktopRelease,
  readCompatibilityEpoch,
  readManifestCompatibilityEpoch,
  resolveDesktopManifestRequest,
  validateDesktopReleaseManifest,
  type DesktopReleaseCandidate,
  type DesktopUpdateFeed,
} from "./desktop-release-feed";
import { isCanonicalReleaseCandidate } from "@traycer-clients/shared/host-version/release-line";
import {
  isSelectableCandidate,
  modeAllowsPrerelease,
  resolveUpdateChannelMode,
  type DesktopUpdateChannelMode,
} from "./update-channel-mode";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateChannelChange,
  DesktopAppUpdateGuidance,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdateStatus,
  DesktopCompatRecoveryPlan,
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
  readonly allowPrerelease?: boolean;
  readonly latestVersion?: string | null;
  readonly latestCompatibilityEpoch?: number | null;
  readonly downloadProgress?: number | null;
  readonly errorMessage?: string | null;
  readonly lastCheckedAt?: string | null;
  readonly lastCheckIntent?: DesktopAppUpdateCheckIntent | null;
}

// Set once at `installAutoUpdater` time from the `package-type` file (deb/rpm only - AppImage never gets this file and keeps electron-updater's default silent-update path untouched).
let linuxPackageType: LinuxPackageType | null = null;
let linuxSilentInstallSupported = true;
let linuxDownloadedFile: string | null = null;
let linuxInstallGuidance: DesktopAppUpdateGuidance | null = null;

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
const PRIVATE_UPDATE_REPO = process.env.VITE_TRAYCER_DESKTOP_UPDATE_REPO ?? "";
const PRIVATE_UPDATE_TOKEN =
  process.env.VITE_TRAYCER_DESKTOP_UPDATE_TOKEN ?? "";

// The raw error is still logged, and the renderer offers "Report an issue" (which privately attaches logs) so support has the real diagnostics for anything the user can't resolve.
const UPDATE_ERROR_OFFLINE_MESSAGE =
  "Traycer couldn't connect to check for updates. Please check your internet connection and try again.";
const UPDATE_ERROR_SERVICE_MESSAGE =
  "Traycer couldn't reach the update service right now. Please try again in a little while.";
const UPDATE_ERROR_DOWNLOAD_MESSAGE =
  "Traycer couldn't download and install the latest update. Please try again in a little while.";
// "Try again" is the wrong advice - a retry re-downloads bytes that were never the problem - and the artifact to distrust is the UPDATE, not the copy already installed.
const UPDATE_ERROR_SIGNATURE_MESSAGE =
  "Traycer couldn't verify this update and did not install it. Please download Traycer again from traycer.ai.";
const UPDATE_ERROR_GENERIC_MESSAGE =
  "Traycer ran into a problem while updating. Please try again in a little while.";
const UPDATE_ERROR_LINUX_MANUAL_INSTALL_MESSAGE =
  "Traycer couldn't finish installing the update automatically. Follow the instructions below to finish it manually.";

const listeners = new Set<AppUpdateListener>();
let sequence = 0;
let currentSnapshot: DesktopAppUpdateSnapshot = {
  sequence,
  status: "idle",
  currentVersion: CURRENT_VERSION,
  allowPrerelease: false,
  latestVersion: null,
  latestCompatibilityEpoch: null,
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  installInFlight: false,
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
let checkSettled: Promise<void> = Promise.resolve();
let settleCheck: (() => void) | null = null;
let checkIntent: DesktopAppUpdateCheckIntent | null = null;
let checkErrorEmitted = false;
let downloadInProgress = false;
let downloadIntent: DesktopAppUpdateCheckIntent | null = null;
let lastResumeCheckAtMs = 0;
let activeChannelMode: DesktopUpdateChannelMode = "stable-only";
let channelGeneration = 0;
// Generation the in-flight check was started under (null when idle). Compared
// against `channelGeneration` to detect a channel change mid-check.
let checkGeneration: number | null = null;
// Generation that produced the currently surfaced available/downloading/ready
// candidate (null when there is none). Guards download and install against a
// superseded channel.
let candidateGeneration: number | null = null;
// A check requested while a stale (older-generation) check was still resolving.
// Run once that check settles so the newest channel is always checked.
let pendingRecheck: {
  readonly isDev: boolean;
  readonly intent: DesktopAppUpdateCheckIntent;
} | null = null;
// `setAllowPrereleaseUpdates` enqueues onto this chain synchronously (before any await), so admission order equals call order and each operation's idempotence check + refusal +.
let channelChangeQueue: Promise<void> = Promise.resolve();
// Hitting the cap with a still-full final page is surfaced as a discovery error rather than "no update", so a real release beyond the cap is never mistaken for "up to date".
const MAX_DISCOVERY_PAGES = 10;
let installingUpdate = false;
let updateArtifactStaged = false;

type UpdaterInitState = "pending" | "initialized" | "failed";
let updaterInitState: UpdaterInitState = "pending";
let signalUpdaterInitialized: (() => void) | null = null;
const updaterInitialized: Promise<void> = new Promise((resolve) => {
  signalUpdaterInitialized = resolve;
});

function markUpdaterInitialized(state: "initialized" | "failed"): void {
  updaterInitState = state;
  if (signalUpdaterInitialized !== null) {
    signalUpdaterInitialized();
    signalUpdaterInitialized = null;
  }
}

export async function installAutoUpdater(
  isDev: boolean,
  deps: AppUpdaterDeps,
): Promise<void> {
  if (installed) {
    return;
  }
  installed = true;
  try {
    await configureAutoUpdater(deps);
    // Release the barrier now, BEFORE the initial check below, so the fire-and-forget check (and any early IPC/menu check already parked on the barrier) runs against authoritative state.
    markUpdaterInitialized("initialized");
  } catch (err) {
    // Initialization failed partway. Settle the barrier as failed so parked
    // callers don't hang, and so a later check refuses rather than falling
    // through to electron-updater's implicit (build-derived) channel.
    log.error("[updater] initialization failed", err);
    markUpdaterInitialized("failed");
    return;
  }
  if (await canCheckForUpdates(isDev)) {
    void checkForUpdatesNow(isDev, "automatic");
  }
}

/**
 * Windows only: an update whose signature check could not RUN must not be thrown away, but one that genuinely FAILED still must be.
 * The discriminator is structural, never textual: Node stamps `cmd` onto every error `execFile` raises.
 */
export function tolerateUnrunnableSignatureCheck(
  base: VerifyUpdateCodeSignature,
): VerifyUpdateCodeSignature {
  return async (publisherNames, filePath) => {
    try {
      return await base(publisherNames, filePath);
    } catch (err) {
      if (!isChildProcessFailure(err)) {
        throw err;
      }
      log.warn(
        "[updater] code-signature verification could not run; installing the downloaded update anyway",
        err,
      );
      return null;
    }
  };
}

function isChildProcessFailure(error: unknown): boolean {
  return (
    error instanceof Error && typeof Reflect.get(error, "cmd") === "string"
  );
}

interface CodeSignatureVerifyingUpdater {
  verifyUpdateCodeSignature: VerifyUpdateCodeSignature;
}

function hasCodeSignatureVerifier(
  candidate: object,
): candidate is CodeSignatureVerifyingUpdater {
  return (
    typeof Reflect.get(candidate, "verifyUpdateCodeSignature") === "function"
  );
}

function installWindowsSignatureTolerance(): void {
  if (process.platform !== "win32" || !hasCodeSignatureVerifier(autoUpdater)) {
    return;
  }
  const nsisUpdater: CodeSignatureVerifyingUpdater = autoUpdater;
  nsisUpdater.verifyUpdateCodeSignature = tolerateUnrunnableSignatureCheck(
    nsisUpdater.verifyUpdateCodeSignature,
  );
}

async function configureAutoUpdater(deps: AppUpdaterDeps): Promise<void> {
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
  autoUpdater.autoInstallOnAppQuit = linuxPackageType === null;
  // Windows: keep a completed, sha512-verified download from being discarded
  // when the Authenticode check can't execute (its PowerShell call carries a
  // hardcoded 20s timeout that a full ~138MB installer hash routinely exceeds).
  installWindowsSignatureTolerance();
  await hydrateUpdatePreferences();
  activeChannelMode = effectiveChannelMode();
  autoUpdater.allowPrerelease = modeAllowsPrerelease(activeChannelMode);
  log.debug("[updater] resolved update channel mode", {
    mode: activeChannelMode,
    currentVersion: CURRENT_VERSION,
  });
  emitSnapshot({ allowPrerelease: autoUpdater.allowPrerelease });
  // Skip feed configuration entirely when the private config is invalid: the
  // startup check below is refused by the same guard, so we must not leave a
  // partially-configured or packaged public feed in place (review amendment 2).
  if (!autoUpdater.allowPrerelease && !invalidPrivateConfig()) {
    configurePrivateGitHubUpdateFeed();
  }

  autoUpdater.on("checking-for-update", () =>
    log.debug("[updater] checking for updates"),
  );
  autoUpdater.on("update-available", (info) => {
    log.info("[updater] update available", info);
    // The channel changed after this check queried the feed: the result belongs
    // to a superseded channel, so drop it rather than surface (or later let the
    // user download) a candidate the current preference no longer selects.
    if (checkGeneration !== null && checkGeneration !== channelGeneration) {
      return;
    }
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
    candidateGeneration = channelGeneration;
    emitSnapshot({
      status: "available",
      latestVersion: info.version,
      latestCompatibilityEpoch: readCandidateCompatibilityEpoch(info),
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
    // Result belongs to a superseded channel: ignore it and let the queued
    // check for the current channel publish the authoritative outcome.
    if (checkGeneration !== null && checkGeneration !== channelGeneration) {
      return;
    }
    const intent = checkIntent ?? "automatic";
    downloadInProgress = false;
    downloadIntent = null;
    emitSnapshot({
      status: intent === "manual" ? "up-to-date" : "idle",
      latestVersion: info.version ?? null,
      latestCompatibilityEpoch: readCandidateCompatibilityEpoch(info),
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
    // Progress for a download whose candidate was invalidated by a channel
    // change (which clears `candidateGeneration`) is ignored.
    if (candidateGeneration !== channelGeneration) {
      return;
    }
    emitSnapshot({
      status: "downloading",
      downloadProgress: clampPercent(progress.percent),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    log.info("[updater] update downloaded - ready to install", info);
    updateArtifactStaged = true;
    if (currentSnapshot.status === "ready") {
      return;
    }
    // The channel changed while this artifact was downloading: it belongs to a
    // superseded channel, so never promote it to "ready" (installable).
    if (candidateGeneration !== channelGeneration) {
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
      // Re-read rather than carried forward from `available`: this is the
      // event that describes the artifact actually ON DISK, and if the two ever
      // disagreed the staged bytes are what a restart would apply.
      latestCompatibilityEpoch: readCandidateCompatibilityEpoch(info),
      downloadProgress: null,
      errorMessage: null,
      lastCheckedAt: new Date().toISOString(),
      lastCheckIntent: intent,
    });
    notifyUpdateWhenUnfocused("ready", info.version);
  });
  autoUpdater.on("error", (err) => {
    log.error("[updater] error", err);
    handleUpdaterError(err);
  });
}

function effectiveChannelMode(): DesktopUpdateChannelMode {
  return resolveUpdateChannelMode(prereleaseUpdatesEnabled(), CURRENT_VERSION);
}

export async function checkForUpdatesNow(
  isDev: boolean,
  intent: DesktopAppUpdateCheckIntent,
): Promise<DesktopAppUpdateSnapshot> {
  // Serialize behind updater initialization: a check reaching here in the window phase (menu / IPC) before the deferred `installAutoUpdater` runs must wait for the persisted channel.
  await updaterInitialized;
  if (updaterInitState === "failed") {
    // Initialization failed: never fall through to electron-updater's implicit
    // channel. Surface an explicit error for a manual check; stay quiet for an
    // automatic one.
    log.warn("[updater] refusing update check: updater initialization failed");
    if (intent === "manual") {
      emitSnapshot({
        status: "error",
        errorMessage: UPDATE_ERROR_GENERIC_MESSAGE,
        lastCheckedAt: new Date().toISOString(),
        lastCheckIntent: intent,
      });
    }
    return currentSnapshot;
  }
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
  // Fail closed on a misconfigured private feed: a token set against an invalid repository coordinate must never fall through to the packaged/public `app-update.yml`.
  if (invalidPrivateConfig()) {
    log.warn(
      "[updater] refusing update check: VITE_TRAYCER_DESKTOP_UPDATE_TOKEN is set but VITE_TRAYCER_DESKTOP_UPDATE_REPO is not a valid owner/repo coordinate",
    );
    if (intent === "manual") {
      emitSnapshot({
        status: "error",
        errorMessage: UPDATE_ERROR_GENERIC_MESSAGE,
        lastCheckedAt: new Date().toISOString(),
        lastCheckIntent: intent,
      });
    }
    return currentSnapshot;
  }
  if (checkInFlight) {
    // A check is already running. If it belongs to an older channel generation
    // it will abort without publishing, so queue a fresh check for the newest
    // generation to guarantee the new channel is actually checked.
    if (checkGeneration !== null && checkGeneration !== channelGeneration) {
      pendingRecheck = { isDev, intent };
    }
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
  checkSettled = new Promise<void>((resolve) => {
    settleCheck = resolve;
  });
  checkGeneration = channelGeneration;
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
    if (modeAllowsPrerelease(activeChannelMode)) {
      const feed = await resolveDesktopReleaseFeed(activeChannelMode);
      if (checkGeneration !== channelGeneration) {
        return currentSnapshot;
      }
      if (feed === null) {
        const resolvedIntent = checkIntent ?? intent;
        emitSnapshot({
          status: resolvedIntent === "manual" ? "up-to-date" : "idle",
          latestVersion: CURRENT_VERSION,
          errorMessage: null,
          lastCheckedAt: new Date().toISOString(),
          lastCheckIntent: resolvedIntent,
        });
        return currentSnapshot;
      }
      applyDesktopReleaseFeed(feed);
    }
    await autoUpdater.checkForUpdates();
  } catch (err) {
    log.warn("[updater] check failed", err);
    emitCheckErrorFromCatch(err, checkIntent ?? intent);
  } finally {
    checkInFlight = false;
    settleCheck?.();
    settleCheck = null;
    checkGeneration = null;
    checkIntent = null;
    checkErrorEmitted = false;
    runPendingRecheck();
  }
  return currentSnapshot;
}

// Runs the check queued while a stale (older-generation) check was resolving.
// Fire-and-forget: the queued check owns its own snapshot updates.
function runPendingRecheck(): void {
  if (pendingRecheck === null) {
    return;
  }
  const next = pendingRecheck;
  pendingRecheck = null;
  void checkForUpdatesNow(next.isDev, next.intent);
}

export type {
  DesktopAppUpdateChannelChange,
  DesktopAppUpdateChannelChangeOutcome,
} from "../../ipc-contracts/app-update-types";

export function setAllowPrereleaseUpdates(
  allowPrerelease: boolean,
): Promise<DesktopAppUpdateChannelChange> {
  // Enqueue synchronously (no await before this line) so admission order equals call order: the entire operation below - idempotence, refusal, persistence, generation/feed/snapshot.
  const run = channelChangeQueue.then(() =>
    performChannelChange(allowPrerelease),
  );
  // Keep the chain alive regardless of this operation's outcome so a rejected
  // persist can't wedge every subsequent channel change.
  channelChangeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function performChannelChange(
  allowPrerelease: boolean,
): Promise<DesktopAppUpdateChannelChange> {
  // Serialize behind updater initialization so a channel change can never race ahead of the deferred `installAutoUpdater` and mutate a half-initialized feed/listener set (finding 1)..
  await updaterInitialized;
  // The mode this request asks for. Read inside the serialized section so the
  // persisted value it is compared against reflects any preceding queued change.
  const requestedMode = resolveUpdateChannelMode(
    allowPrerelease,
    CURRENT_VERSION,
  );
  // Idempotent set (preference unchanged): change nothing - in particular do not
  // open a new epoch or invalidate an in-flight download for a no-op toggle.
  if (prereleaseUpdatesEnabled() === allowPrerelease) {
    return {
      outcome: "unchanged",
      snapshot: emitSnapshot({
        allowPrerelease: modeAllowsPrerelease(activeChannelMode),
      }),
    };
  }
  // They just cannot currently come apart: `resolveUpdateChannelMode(true, …)` is always `explicit-prerelease` and `resolveUpdateChannelMode(false, …)` never is, so a changed.

  if (downloadInProgress || currentSnapshot.status === "downloading") {
    log.warn(
      "[updater] refusing channel change while an update is downloading",
    );
    // Re-emit so every window re-reads the *unchanged* channel (a renderer
    // that optimistically flipped a control snaps back), then report the
    // refusal so the IPC boundary can raise it as a mutation error.
    return {
      outcome: "refused-update-pending",
      snapshot: emitSnapshot({}),
    };
  }
  if (updateArtifactStaged) {
    if (!canDiscardStagedUpdate()) {
      log.warn(
        "[updater] refusing channel change: a natively staged update cannot be discarded on this platform",
      );
      return {
        outcome: "refused-update-pending",
        snapshot: emitSnapshot({}),
      };
    }
    discardStagedUpdate();
  }
  await persistPrereleaseUpdatesEnabled(allowPrerelease);
  // Open a new channel epoch: any in-flight check discovered under the prior
  // generation will reject its result rather than restore the old feed, and any
  // candidate/download/ready state below is invalidated.
  channelGeneration += 1;
  activeChannelMode = requestedMode;
  autoUpdater.allowPrerelease = modeAllowsPrerelease(activeChannelMode);
  if (!autoUpdater.allowPrerelease) {
    configureStableGitHubUpdateFeed();
  }

  // Downloading/ready states never reach here - the guard above rejects a switch while an artifact exists.
  downloadInProgress = false;
  downloadIntent = null;
  candidateGeneration = null;
  return {
    outcome: "changed",
    snapshot: emitSnapshot({
      allowPrerelease: autoUpdater.allowPrerelease,
      status: "idle",
      latestVersion: null,
      latestCompatibilityEpoch: null,
      downloadProgress: null,
      errorMessage: null,
      lastCheckIntent: null,
    }),
  };
}

function canDiscardStagedUpdate(): boolean {
  return process.platform !== "darwin";
}

/**
 * So lowering the public flag after the fact genuinely disarms an already-registered handler, and lowering it before a download completes stops the handler being registered at all.
 * deb/rpm never had it raised (`configureAutoUpdater` sets it false there), so this is a no-op for them.
 */
function disarmQuitInstall(): void {
  if (!autoUpdater.autoInstallOnAppQuit) {
    return;
  }
  log.info("[updater] disarming quit-time install for a staged update");
  autoUpdater.autoInstallOnAppQuit = false;
}

/** An RC artifact never matches a stable one's hash. */
function discardStagedUpdate(): DesktopAppUpdateSnapshot {
  disarmQuitInstall();
  updateArtifactStaged = false;
  candidateGeneration = null;
  downloadInProgress = false;
  downloadIntent = null;
  linuxDownloadedFile = null;
  linuxInstallGuidance = null;
  return emitSnapshot({
    status: "idle",
    latestVersion: null,
    latestCompatibilityEpoch: null,
    downloadProgress: null,
    errorMessage: null,
    lastCheckIntent: null,
  });
}

const MAX_RC_RECOVERY_MANIFEST_FETCHES = 5;

/** A stalled TCP connection never rejects, so without a deadline the `manual` fallback this design leans on is simply never reached and the blocking dialog sits on a spinner. */
const RC_RECOVERY_PROBE_DEADLINE_MS = 15_000;

/** Keyed by epoch rather than shared outright because two hosts with different floors are two different questions, and the cheaper answer must not be reused for the stricter one. */
const rcRecoveryProbesInFlight = new Map<
  number,
  Promise<DesktopReleaseCandidate | null>
>();

export async function resolveCompatRecovery(input: {
  readonly minimumEpoch: number;
  readonly hostAllowsRcRecovery: boolean;
}): Promise<DesktopCompatRecoveryPlan> {
  await updaterInitialized;
  if (updaterInitState !== "initialized") {
    // No feed, no candidate, and no ability to acquire either. The manual link
    // is the only honest answer, and it is the one this surface falls back to.
    return manualRecoveryPlan();
  }
  // Wait for it before deciding the selected feed cannot help.
  while (checkInFlight) {
    await checkSettled;
  }
  const held = currentSnapshot;
  const holdsCandidate =
    held.status === "available" ||
    held.status === "downloading" ||
    held.status === "ready";
  if (
    holdsCandidate &&
    held.latestCompatibilityEpoch !== null &&
    held.latestCompatibilityEpoch >= input.minimumEpoch
  ) {
    // No channel change is offered even if the host is on RC - the update the user already has is the shorter path, and an RC opt-in they did not need is one they cannot easily undo.
    return {
      route: "update-available",
      rcCandidateVersion: null,
      stagedVersion: null,
    };
  }
  // Past here the selected feed cannot help: either it holds nothing, or what it
  // holds is of an unknown or insufficient generation.
  if (updateArtifactStaged) {
    if (!canDiscardStagedUpdate()) {
      // macOS: the staged build applies at the next quit whatever anyone does,
      // and RC opt-in stays refused until it has. Say that, rather than offer a
      // channel change that would return `refused-update-pending`.
      return {
        route: "restart-to-clear-staged",
        rcCandidateVersion: null,
        stagedVersion: held.latestVersion,
      };
    }
    discardStagedUpdate();
  } else if (holdsCandidate && canDiscardStagedUpdate()) {
    // Nothing staged YET, but the updater is holding or fetching a candidate we have just established cannot clear the floor.
    // Lowering the flag now means the download's completion never registers a quit handler at all, which is better than lowering it after the artifact lands.
    disarmQuitInstall();
  }
  if (!input.hostAllowsRcRecovery) {
    return manualRecoveryPlan();
  }
  // `performChannelChange` refuses unconditionally while a transfer is in flight - there is no `CancellationToken` plumbed, so that refusal cannot be relaxed.
  if (downloadInProgress || currentSnapshot.status === "downloading") {
    return manualRecoveryPlan();
  }
  // An RC build already receives its own line's candidates, so the probe would offer an opt-in that changes no current discovery behavior while PERSISTING a broad prerelease.
  // Implicit participation is derived and must never be written to disk, so the `enable-rc` route stays reserved for a stable-only app giving explicit consent.
  if (effectiveChannelMode() !== "stable-only") {
    return manualRecoveryPlan();
  }
  const candidate = await probeRcRecoveryCandidate(input.minimumEpoch);
  if (candidate === null) {
    return manualRecoveryPlan();
  }
  return {
    route: "enable-rc",
    rcCandidateVersion: candidate.version,
    stagedVersion: null,
  };
}

function manualRecoveryPlan(): DesktopCompatRecoveryPlan {
  return { route: "manual", rcCandidateVersion: null, stagedVersion: null };
}

/**
 * The probe must inspect that same ordered set and decide from the FIRST usable candidate.
 * Skipping an insufficient stable candidate to offer an older sufficient RC would promise a build the updater will never select after consent.
 */
async function probeRcRecoveryCandidate(
  minimumEpoch: number,
): Promise<DesktopReleaseCandidate | null> {
  const existing = rcRecoveryProbesInFlight.get(minimumEpoch);
  if (existing !== undefined) {
    return existing;
  }
  const controller = new AbortController();
  const probe = withRcRecoveryProbeDeadline(
    runRcRecoveryProbe(minimumEpoch, controller.signal),
    controller,
  ).catch((error: unknown) => {
    log.warn("[updater] RC recovery probe failed", error);
    return null;
  });
  rcRecoveryProbesInFlight.set(minimumEpoch, probe);
  try {
    return await probe;
  } finally {
    rcRecoveryProbesInFlight.delete(minimumEpoch);
  }
}

/**
 * It is never reported as an error: the caller's only use for the distinction would be to show it, and a network diagnostic stacked on "your app is too old" is noise in a state that.
 * The timer is unref'd so a probe running as the app quits cannot hold the process open, and cleared on the winning path so a resolved probe leaves no pending handle behind.
 */
function withRcRecoveryProbeDeadline(
  probe: Promise<DesktopReleaseCandidate | null>,
  controller: AbortController,
): Promise<DesktopReleaseCandidate | null> {
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<DesktopReleaseCandidate | null>((resolve) => {
    timer = setTimeout(() => {
      log.warn("[updater] RC recovery probe timed out", {
        deadlineMs: RC_RECOVERY_PROBE_DEADLINE_MS,
      });
      controller.abort();
      resolve(null);
    }, RC_RECOVERY_PROBE_DEADLINE_MS);
    timer.unref?.();
  });
  return Promise.race([probe, deadline]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

async function runRcRecoveryProbe(
  minimumEpoch: number,
  signal: AbortSignal,
): Promise<DesktopReleaseCandidate | null> {
  const coordinate = resolveUpdateRepo();
  if (coordinate === null) {
    return null;
  }
  const all = await collectDesktopReleaseCandidates(coordinate, signal);
  const releaseCandidates = [...all].sort((a, b) =>
    compareHostVersions(b.version, a.version),
  );
  const token = PRIVATE_UPDATE_TOKEN.trim();
  const channelFile = platformChannelFile();
  const currentOsRelease = osRelease();
  const isArm64Mac = process.platform === "darwin" ? isArm64MacTarget() : false;
  let fetched = 0;
  for (const candidate of releaseCandidates) {
    if (fetched >= MAX_RC_RECOVERY_MANIFEST_FETCHES) {
      log.info("[updater] RC recovery probe stopped at its fetch budget", {
        budget: MAX_RC_RECOVERY_MANIFEST_FETCHES,
        remaining: releaseCandidates.length - fetched,
      });
      return null;
    }
    if (!isPlatformCompatibleRelease(candidate, linuxPackageType)) {
      continue;
    }
    const request = resolveDesktopManifestRequest(
      coordinate.owner,
      coordinate.repo,
      candidate,
      token,
    );
    if (request === null) {
      continue;
    }
    fetched += 1;
    const rawManifest = await fetchDesktopReleaseManifest(request, signal);
    if (rawManifest === null) {
      continue;
    }
    const validation = validateDesktopReleaseManifest(
      rawManifest,
      channelFile,
      request.url,
      candidate,
      linuxPackageType,
      currentOsRelease,
      isArm64Mac,
    );
    if (validation.ok) {
      const epoch = readManifestCompatibilityEpoch(
        rawManifest,
        channelFile,
        request.url,
      );
      const isRc = isCanonicalReleaseCandidate(candidate.version);
      const isNewer =
        compareHostVersions(candidate.version, CURRENT_VERSION) > 0;
      if (!isRc || !isNewer || epoch === null || epoch < minimumEpoch) {
        log.info("[updater] RC recovery probe found no selectable RC remedy", {
          selectedVersion: candidate.version,
          compatibilityEpoch: epoch,
          minimumEpoch,
          isRc,
          isNewer,
        });
        return null;
      }
      log.info("[updater] RC recovery probe found a sufficient candidate", {
        version: candidate.version,
        compatibilityEpoch: epoch,
        minimumEpoch,
      });
      return candidate;
    }
    log.warn("[updater] RC recovery probe skipping an unusable candidate", {
      version: candidate.version,
      reason: validation.reason,
    });
  }
  return null;
}

export function checkForUpdatesAfterResume(isDev: boolean): void {
  const nowMs = Date.now();
  if (nowMs - lastResumeCheckAtMs < AUTOMATIC_RESUME_CHECK_DEBOUNCE_MS) {
    return;
  }
  lastResumeCheckAtMs = nowMs;
  void checkForUpdatesNow(isDev, "automatic");
}

export function startUpdateDownload(): DesktopAppUpdateSnapshot {
  if (updaterInitState !== "initialized") {
    return currentSnapshot;
  }
  // Updates can't be installed from this location (read-only volume), so never start a download that would fail at install time.
  if (currentInstallBlockedReason() !== null) {
    return emitSnapshot({});
  }
  if (currentSnapshot.status === "downloading" || downloadInProgress) {
    return currentSnapshot;
  }
  if (currentSnapshot.status !== "available") {
    return currentSnapshot;
  }
  // Refuse to download a candidate whose channel was superseded (a channel
  // change clears `candidateGeneration`); the queued re-check will surface the
  // new channel's candidate instead.
  if (candidateGeneration !== channelGeneration) {
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
  // Some installed updater implementations throw *synchronously* while resolving the download (e.g. during file resolution) rather than returning a rejected promise.
  void (async () => {
    await autoUpdater.downloadUpdate();
  })().catch((err: unknown) => {
    log.warn("[updater] download failed", err);
    handleUpdaterError(err);
  });
  return currentSnapshot;
}

export function installDownloadedUpdate(): DesktopAppUpdateSnapshot {
  // Readiness guard (finding 1): install is only reachable once an artifact has
  // reached "ready", which requires initialization. Refuse before init (or after
  // a failed init) rather than hand off to a not-yet-configured updater.
  if (updaterInitState !== "initialized") {
    return currentSnapshot;
  }
  if (currentSnapshot.status !== "ready") {
    emitSnapshot({
      status: "error",
      errorMessage: "No downloaded update is ready to install.",
      lastCheckedAt: currentSnapshot.lastCheckedAt,
      lastCheckIntent: "manual",
    });
    return currentSnapshot;
  }
  if (installingUpdate) {
    log.info("[updater] install already in flight - ignoring repeat request");
    return currentSnapshot;
  }
  installingUpdate = true;
  // Publish before handing off: this is the only signal the renderer gets that
  // an install started (a successful install emits nothing further - it ends
  // the process), and it's what disarms the restart affordances in every window.
  emitSnapshot({});
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    // Some installed updater implementations throw *synchronously* here rather than rejecting (same hazard the download path guards against).
    // Without this, `handleUpdaterError` never runs: no error snapshot is emitted, so `installInFlight` stays raised and every restart affordance is left permanently disabled with no.
    log.warn("[updater] install handoff threw", err);
    handleUpdaterError(err);
  }
  return currentSnapshot;
}

export function isInstallingUpdate(): boolean {
  return installingUpdate;
}

export function getAppUpdateSnapshot(): DesktopAppUpdateSnapshot {
  const allowPrerelease = modeAllowsPrerelease(effectiveChannelMode());
  return currentSnapshot.allowPrerelease === allowPrerelease
    ? currentSnapshot
    : { ...currentSnapshot, allowPrerelease };
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
  // `electron-builder --dir` (used by `make install-desktop-staging` and `make install-desktop-production` for dogfood installs) never emits `app-update.yml`.
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

// WITH a token, an invalid coordinate returns null so callers fail closed: a private token must never authenticate against, or move the build onto, the public feed (review finding.
function resolveUpdateRepo(): GitHubRepoCoordinate | null {
  const parsed = parseGitHubRepoCoordinate(PRIVATE_UPDATE_REPO);
  if (PRIVATE_UPDATE_TOKEN.trim().length > 0) {
    return parsed;
  }
  return parsed ?? { owner: "traycerai", repo: "traycer" };
}

function invalidPrivateConfig(): boolean {
  return (
    PRIVATE_UPDATE_TOKEN.trim().length > 0 &&
    parseGitHubRepoCoordinate(PRIVATE_UPDATE_REPO) === null
  );
}

/**
 * It cannot, because both other release workflows publish with `--latest=false` ("host version releases must never become the latest") while only a stable desktop publish passes.
 * If that ever changes, stable must move to `resolveDesktopReleaseFeed` like the prerelease modes already have - the namespaced selector is the only in-process defence.
 */
function configureStableGitHubUpdateFeed(): void {
  const coordinate = resolveUpdateRepo();
  const token = PRIVATE_UPDATE_TOKEN.trim();
  if (coordinate === null) {
    // Token set + invalid coordinate: fail closed. Leave the existing feed in
    // place rather than point an authenticated build at the public repo.
    log.warn(
      "[updater] private update token is configured but VITE_TRAYCER_DESKTOP_UPDATE_REPO is not a valid owner/repo coordinate; leaving the update feed unchanged",
    );
    return;
  }
  if (token.length === 0) {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: coordinate.owner,
      repo: coordinate.repo,
    });
    autoUpdater.requestHeaders = null;
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
}

async function resolveDesktopReleaseFeed(
  mode: DesktopUpdateChannelMode,
): Promise<DesktopUpdateFeed | null> {
  const coordinate = resolveUpdateRepo();
  if (coordinate === null) {
    throw new Error(
      "Desktop update repository is not a valid owner/repo coordinate for the configured private update token",
    );
  }
  const release = await findNewestDesktopRelease(coordinate, mode);
  if (release === null) return null;
  const token = PRIVATE_UPDATE_TOKEN.trim();
  log.debug("[updater] configured desktop release feed", {
    version: release.version,
    private: token.length > 0,
  });
  return buildDesktopReleaseFeed(
    coordinate.owner,
    coordinate.repo,
    release,
    token,
  );
}

function applyDesktopReleaseFeed(feed: DesktopUpdateFeed): void {
  // The public generic feed is unauthenticated and the private custom provider
  // carries its own per-request auth headers, so clear any global header - a
  // stale token must never ride along onto the wrong feed.
  autoUpdater.requestHeaders = null;
  autoUpdater.setFeedURL(feed);
}

async function findNewestDesktopRelease(
  coordinate: GitHubRepoCoordinate,
  mode: DesktopUpdateChannelMode,
): Promise<DesktopReleaseCandidate | null> {
  const candidates = await collectDesktopReleaseCandidates(
    coordinate,
    undefined,
  );
  const ordered = [...candidates]
    .filter((candidate) =>
      isSelectableCandidate({
        mode,
        installedVersion: CURRENT_VERSION,
        candidateVersion: candidate.version,
        isStrictlyNewer:
          compareHostVersions(candidate.version, CURRENT_VERSION) > 0,
      }),
    )
    .sort((a, b) => compareHostVersions(b.version, a.version));
  if (mode === "implicit-rc-line") {
    log.debug("[updater] implicit RC-line candidates", {
      currentVersion: CURRENT_VERSION,
      candidates: ordered.map((candidate) => candidate.version),
    });
  }
  const token = PRIVATE_UPDATE_TOKEN.trim();
  const channelFile = platformChannelFile();
  const currentOsRelease = osRelease();
  // Resolved consistently with MacUpdater so discovery filters manifests by the
  // same architecture the installed updater applies at download time. Only
  // meaningful on macOS; false elsewhere.
  const isArm64Mac = process.platform === "darwin" ? isArm64MacTarget() : false;
  for (const candidate of ordered) {
    // Cheap asset-presence gate first: never spend a manifest fetch on a release
    // that doesn't even publish this platform's manifest + applicable installer.
    if (!isPlatformCompatibleRelease(candidate, linuxPackageType)) {
      continue;
    }
    const request = resolveDesktopManifestRequest(
      coordinate.owner,
      coordinate.repo,
      candidate,
      token,
    );
    if (request === null) {
      continue;
    }
    const rawManifest = await fetchDesktopReleaseManifest(request, undefined);
    if (rawManifest === null) {
      // A missing/errored manifest (HTTP failure) makes this release unusable;
      // fall back to the next. A transport-level failure propagates as a
      // discovery error instead (see `fetchDesktopReleaseManifest`).
      log.warn(
        "[updater] skipping desktop release: channel manifest unavailable",
        {
          version: candidate.version,
        },
      );
      continue;
    }
    const validation = validateDesktopReleaseManifest(
      rawManifest,
      channelFile,
      request.url,
      candidate,
      linuxPackageType,
      currentOsRelease,
      isArm64Mac,
    );
    if (validation.ok) {
      return candidate;
    }
    log.warn("[updater] skipping unusable desktop release", {
      version: candidate.version,
      reason: validation.reason,
    });
  }
  return null;
}

// Collects every `desktop-v*` candidate (RC-only consent applied by `projectDesktopRelease`) across pagination, without a manifest fetch, so the caller can order them and validate.
// Hitting the page cap with a still-full final page is a discovery error, not "no update", so a real release beyond the cap is never mistaken for "up to date".
async function collectDesktopReleaseCandidates(
  coordinate: GitHubRepoCoordinate,
  signal: AbortSignal | undefined,
): Promise<DesktopReleaseCandidate[]> {
  const token = PRIVATE_UPDATE_TOKEN.trim();
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
  };
  if (token.length > 0) headers.authorization = `token ${token}`;

  const candidates: DesktopReleaseCandidate[] = [];
  for (let page = 1; page <= MAX_DISCOVERY_PAGES; page += 1) {
    const url = `https://api.github.com/repos/${coordinate.owner}/${coordinate.repo}/releases?per_page=100&page=${page}`;
    const response = await fetch(url, { headers, signal });
    if (!response.ok) {
      throw new Error(
        `GitHub release discovery failed with HTTP ${response.status}`,
      );
    }
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) {
      throw new Error("GitHub release discovery returned a malformed response");
    }
    candidates.push(...raw.flatMap(projectDesktopRelease));
    // A short page is GitHub's signal that no releases remain.
    if (raw.length < 100) return candidates;
  }
  throw new Error(
    `GitHub release discovery exceeded the ${MAX_DISCOVERY_PAGES}-page safety limit`,
  );
}

async function fetchDesktopReleaseManifest(
  request: {
    readonly url: string;
    readonly headers: Record<string, string>;
  },
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const response = await fetch(request.url, {
    headers: request.headers,
    signal,
  });
  if (!response.ok) {
    return null;
  }
  return response.text();
}

let cachedIsArm64Mac: boolean | null = null;

function isArm64MacTarget(): boolean {
  if (cachedIsArm64Mac === null) {
    cachedIsArm64Mac = resolveIsArm64Mac();
  }
  return cachedIsArm64Mac;
}

function resolveIsArm64Mac(): boolean {
  const overrideArch = process.env.TEST_UPDATER_ARCH;
  if (overrideArch !== undefined && overrideArch.length > 0) {
    return overrideArch === "arm64";
  }
  if (process.arch === "arm64") {
    return true;
  }
  return isRosettaTranslated() || unameReportsArm();
}

function isRosettaTranslated(): boolean {
  return probeMacArch("sysctl", ["sysctl.proc_translated"]).includes(
    "sysctl.proc_translated: 1",
  );
}

function unameReportsArm(): boolean {
  return probeMacArch("uname", ["-a"]).includes("ARM");
}

// Runs a short read-only architecture probe, returning "" on any failure so the
// caller falls open - matching MacUpdater, which treats a failed sysctl/uname
// probe as "not detected" rather than an error.
function probeMacArch(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 2000 });
  } catch {
    return "";
  }
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

/**
 * The compatibility epoch an updater candidate declares, read off the raw feed document electron-updater parsed.
 * That is a property of a PINNED dependency, so it is pinned by a contract test and must be re-checked at every dependency bump.
 */
function readCandidateCompatibilityEpoch(info: unknown): number | null {
  return readCompatibilityEpoch(info);
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
    allowPrerelease: patch.allowPrerelease ?? currentSnapshot.allowPrerelease,
    installBlockedReason: currentInstallBlockedReason(),
    installGuidance: linuxInstallGuidance,
    // Derived, like the two above: `installingUpdate` is the single source of
    // truth, so every emit republishes the live value rather than relying on
    // each call site to thread it through the patch.
    installInFlight: installingUpdate,
    latestVersion:
      patch.latestVersion === undefined
        ? currentSnapshot.latestVersion
        : patch.latestVersion,
    // Carried with `latestVersion` rather than derived from it: the epoch is a
    // property of the resolved CANDIDATE, and a patch that moves the version
    // without moving the epoch would leave the two describing different builds.
    latestCompatibilityEpoch:
      patch.latestCompatibilityEpoch === undefined
        ? currentSnapshot.latestCompatibilityEpoch
        : patch.latestCompatibilityEpoch,
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

// Under the mode model a canonical `X.Y.Z-rc.N` build is never on the stable feed.

function handleUpdaterError(error: unknown): void {
  // An error after the user chose "Restart" (quitAndInstall) must NOT be swallowed by the "ready" guard below: the install failed, the app won't relaunch, and the user is left staring.
  if (installingUpdate) {
    installingUpdate = false;
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

// Used to drop a stale check's terminal emission (its failure or "no stable release" outcome) so it cannot overwrite the current channel's snapshot.
function isSupersededCheckGeneration(): boolean {
  return checkGeneration !== null && checkGeneration !== channelGeneration;
}

function emitCheckErrorFromCatch(
  error: unknown,
  intent: DesktopAppUpdateCheckIntent,
): void {
  if (checkErrorEmitted) {
    return;
  }
  // The channel changed while this check was running: its failure belongs to a
  // superseded channel, so mark it handled (keeping the paired error-event/catch
  // dedup coherent) but publish nothing (finding 8).
  if (isSupersededCheckGeneration()) {
    checkErrorEmitted = true;
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

// Crucially the raw text is NEVER returned - even an unrecognized error falls through to the generic message.
function formatUserVisibleUpdateError(rawMessage: string): string {
  const message = rawMessage.toLowerCase();
  if (
    process.platform === "darwin" &&
    includesAny(message, READ_ONLY_VOLUME_ERROR_HINTS)
  ) {
    return UPDATE_BLOCKED_LOCATION_REASON;
  }
  // BEFORE install, and deliberately the most specific set: every phrase below
  // also contains `signature` or `not signed`, both of which INSTALL matches -
  // so the reverse order would make this bucket unreachable.
  if (includesAny(message, SIGNATURE_ERROR_HINTS)) {
    return UPDATE_ERROR_SIGNATURE_MESSAGE;
  }
  if (includesAny(message, CONNECTIVITY_ERROR_HINTS)) {
    return UPDATE_ERROR_OFFLINE_MESSAGE;
  }
  if (includesAny(message, INSTALL_ERROR_HINTS)) {
    return UPDATE_ERROR_DOWNLOAD_MESSAGE;
  }
  if (
    includesAny(message, SERVICE_ERROR_HINTS) ||
    includesHttpStatusCode(message)
  ) {
    return UPDATE_ERROR_SERVICE_MESSAGE;
  }
  return UPDATE_ERROR_GENERIC_MESSAGE;
}

function includesAny(message: string, hints: readonly string[]): boolean {
  return hints.some((hint) => message.includes(hint));
}

const SERVICE_HTTP_STATUS_PATTERN = /\b(?:401|403|404|500|502|503|504)\b/;

function includesHttpStatusCode(message: string): boolean {
  return SERVICE_HTTP_STATUS_PATTERN.test(message);
}

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

// Each hint must match the MINTED message and not the command echo that every `Command failed:` error carries.
const SIGNATURE_ERROR_HINTS: readonly string[] = [
  "is not signed by the application owner",
  "literalpath of ",
  "failing signature validation",
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

// The update feed/service was reachable but returned an error response, or a raw HTTP error body leaked through (GitHub `releases.atom` 404, status codes, missing channel manifests).
const SERVICE_ERROR_HINTS: readonly string[] = [
  "releases.atom",
  "status code",
  "statuscode",
  "failed with http",
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
