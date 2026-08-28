import { app } from "electron";
import { autoUpdater } from "electron-updater";
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
// The channel mode the updater is CONFIGURED with right now: what
// `autoUpdater.allowPrerelease` was derived from, and what the namespaced
// selector is filtering candidates for. Set once at initialization and moved
// only by a channel change that genuinely alters discovery behavior, so it can
// be compared against a freshly requested mode to tell a real transition from a
// preference write that changes nothing the updater does.
let activeChannelMode: DesktopUpdateChannelMode = "stable-only";
// Monotonic channel epoch, bumped by every `setAllowPrereleaseUpdates` call.
// A channel change makes any discovery/candidate produced under a prior
// generation stale: `checkForUpdatesNow` rejects a stale discovery before
// touching the feed, the availability/download handlers ignore stale events,
// and download/install refuse a candidate whose generation no longer matches.
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
// Serializes the whole channel-change operation. `setAllowPrereleaseUpdates`
// enqueues onto this chain synchronously (before any await), so admission order
// equals call order and each operation's idempotence check + refusal +
// persistence + generation/feed/snapshot run to completion before the next
// begins. Without this, two windows toggling opposite directions can interleave
// - the second reads the pre-persist value, returns "unchanged", and the first
// then persists the opposite - stranding the channel on the wrong value. The
// chain swallows each operation's settlement so one rejection can't wedge every
// later change.
let channelChangeQueue: Promise<void> = Promise.resolve();
// GitHub release discovery walks at most this many 100-item pages. Hitting the
// cap with a still-full final page is surfaced as a discovery error rather than
// "no update", so a real release beyond the cap is never mistaken for "up to
// date".
const MAX_DISCOVERY_PAGES = 10;
// Raised the moment we hand off to `quitAndInstall`. The `before-quit`
// handler reads this to let the install-driven `app.quit()` through instead
// of intercepting it with the unsynced-edits prompt - the user already chose
// to restart, so blocking the quit would silently swallow the install.
let installingUpdate = false;
// A downloaded update artifact is staged inside electron-updater from the moment
// an `update-downloaded` event fires; from then on its normal-quit install
// handler (`autoInstallOnAppQuit`, enabled on macOS/Windows/AppImage) can apply
// it. Crucially this stays raised through an install *attempt that then errors* -
// a failed install does not un-stage the artifact - so a channel switch must be
// refused as long as any staged artifact could still auto-install on quit, not
// merely while the status reads "ready" (cold-review finding 2). Never lowered
// within the process: a successful install ends the process, and any other
// transition leaves the artifact staged.
let updateArtifactStaged = false;

// Serialized updater-initialization barrier. `installAutoUpdater` runs in a
// deferred startup phase, but the update IPC and the menu "Check for updates"
// affordance are wired earlier, in the window phase. Until initialization
// finishes, electron-updater's `allowPrerelease` still reflects the running
// build (an RC build implicitly allows prereleases) and no event listeners are
// attached, so an early check/action must not touch electron-updater or it would
// act on that implicit channel. Every externally reachable check/set awaits
// `updaterInitialized`; the synchronous download/install entry points are guarded
// by `updaterInitState` (they are only reachable after a candidate has been
// surfaced, which itself requires initialization). Failure is explicit: the
// barrier always settles, and a failed init refuses checks rather than letting
// them fall through to the implicit channel or leaving callers hanging.
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
  try {
    await configureAutoUpdater(deps);
    // Initialization is complete: the persisted channel is applied, the feed is
    // configured, and every event listener is attached. Release the barrier now,
    // BEFORE the initial check below, so the fire-and-forget check (and any early
    // IPC/menu check already parked on the barrier) runs against authoritative
    // state and never deadlocks awaiting an unresolved barrier.
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

// Applies the persisted channel, configures the update feed, and attaches every
// electron-updater event listener. Extracted so `installAutoUpdater` can wrap it
// in a single initialization boundary that always settles the readiness barrier
// (cold-review finding 1).
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
  // electron-updater auto-enables prereleases when the running build is an RC,
  // and then selects the newest prerelease it can see - across release lines,
  // and across the `host-v*` / `cli-v*` tags this repository also publishes.
  // Both halves of that are wrong here, so the flag is replaced by a mode
  // derived from the persisted preference and the installed version, and every
  // prerelease check is routed through the desktop-tag selector in
  // `resolveDesktopReleaseFeed` below, which receives that mode.
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
      // Read off THIS check's `info`, same as `latestVersion` above: the pair
      // describes the feed's current latest build even when it is not an
      // upgrade for us. That freshness is what recovery routing needs - a
      // previously cached epoch could describe a build the feed no longer
      // offers, and `null`ing it would hide a generation the feed does state.
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
    // An artifact is now physically staged on disk and electron-updater's
    // quit-time handler could apply it. Record that before any early return so a
    // later channel switch is refused (finding 2) even if this event is dropped
    // by a guard below or the ready status is later replaced by an install error.
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

/**
 * The mode a check would run under RIGHT NOW: the durable explicit preference
 * plus the installed version.
 *
 * Read from the persisted preference rather than `autoUpdater.allowPrerelease`
 * for the same reason `getAppUpdateSnapshot` reconciles: the flag is a derived
 * effect that a half-applied or not-yet-initialized updater can lag behind,
 * while the preference and the app version are always authoritative.
 */
function effectiveChannelMode(): DesktopUpdateChannelMode {
  return resolveUpdateChannelMode(prereleaseUpdatesEnabled(), CURRENT_VERSION);
}

export async function checkForUpdatesNow(
  isDev: boolean,
  intent: DesktopAppUpdateCheckIntent,
): Promise<DesktopAppUpdateSnapshot> {
  // Serialize behind updater initialization: a check reaching here in the window
  // phase (menu / IPC) before the deferred `installAutoUpdater` runs must wait
  // for the persisted channel, feed, and listeners to be authoritative rather
  // than query electron-updater's implicit (build-derived) channel (finding 1).
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
  // Fail closed on a misconfigured private feed: a token set against an invalid
  // repository coordinate must never fall through to the packaged/public
  // `app-update.yml`. Refuse every check (stable and RC) before any network
  // access rather than authenticate against, or move the build onto, the public
  // feed (review amendment 2).
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
    // THE MODE decides whether the namespaced selector runs, not the flag it
    // derived: `allowPrerelease` is now an effect of the mode, and reading the
    // effect back to re-decide the cause is how the two drift.
    if (modeAllowsPrerelease(activeChannelMode)) {
      const feed = await resolveDesktopReleaseFeed(activeChannelMode);
      // Discovery is async: if the channel changed while it ran, reject this
      // stale result before touching the feed or publishing any state - the
      // superseding channel's own check (queued below via `pendingRecheck`)
      // owns the outcome now.
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
  // Enqueue synchronously (no await before this line) so admission order equals
  // call order: the entire operation below - idempotence, refusal, persistence,
  // generation/feed/snapshot - runs serialized, and the last admitted request
  // wins. Two windows requesting opposite channels can no longer interleave the
  // idempotence check across the async persistence and strand the wrong value.
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
  // Serialize behind updater initialization so a channel change can never race
  // ahead of the deferred `installAutoUpdater` and mutate a half-initialized
  // feed/listener set (finding 1). The barrier always settles, so this never
  // hangs; the preference persistence below is independent of updater health.
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
  // PAST HERE THE PREFERENCE MOVES, AND SO DOES THE EFFECTIVE MODE - always,
  // and there is deliberately no third branch for "persisted moved, mode did
  // not".
  //
  // Persisting intent and transitioning the channel are still two different
  // things, and the code below keeps them ordered accordingly. They just cannot
  // currently come apart: `resolveUpdateChannelMode(true, …)` is always
  // `explicit-prerelease` and `resolveUpdateChannelMode(false, …)` never is, so
  // a changed preference always crosses that boundary. A branch guarding the
  // other case would be unreachable defensive code, and the cold review was
  // right that shipping one - with a test that has to construct an impossible
  // updater state to reach it - is worse than not having it.
  //
  // If the derivation ever gains a mode that BOTH preference values can select,
  // this is the point that needs the split back: persist, re-emit, and return
  // `unchanged` WITHOUT running any of the destructive choreography below (epoch
  // bump, candidate invalidation, staged-artifact refusal/discard, feed
  // replacement, quit-install disarm), none of which a change that selects no
  // different candidate can justify.

  // A DOWNLOAD IN PROGRESS refuses on every platform, and this half of the
  // guard is not negotiable: `startUpdateDownload` calls
  // `autoUpdater.downloadUpdate()` with no `CancellationToken`, so there is no
  // supported way to stop the transfer that is already writing into the
  // updater's `pending/` directory. Nothing here can make that safe.
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
  // A STAGED ARTIFACT is where the platforms diverge, and the divergence is a
  // fact about electron-updater rather than a preference of ours.
  //
  // The original blanket refusal rested on two hazards: the artifact could
  // still auto-install on quit, and it could be reused by a later download.
  // On Windows/AppImage both are dissolved - `BaseUpdater`'s quit handler
  // RE-READS `autoInstallOnAppQuit` at quit time, so lowering the flag now
  // provably disarms it, and `DownloadedUpdateHelper` re-hashes the cached file
  // against the current feed candidate, so an RC artifact can never be mistaken
  // for the stable one it replaces. `discardStagedUpdate` performs exactly that
  // disarm, which is what makes the switch admissible here rather than a
  // hopeful one.
  //
  // On macOS neither is dissolved. Squirrel.Mac has already been handed the
  // update by `MacUpdater.updateDownloaded`, it registers no quit handler and
  // re-reads no flag, and no supported API withdraws a natively staged update.
  // The refusal therefore STANDS, and it is not a transient one the user can
  // wait out: the staged build applies at the next quit, and RC opt-in becomes
  // reachable only after that hop. `resolveCompatRecovery` routes that case to
  // `restart-to-clear-staged` so the dialog says so instead of offering a
  // button that errors.
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

  // Any not-yet-downloading candidate the previous channel produced (an
  // "available"/"checking" result) no longer matches the selected channel, so
  // drop it. Downloading/ready states never reach here - the guard above rejects
  // a switch while an artifact exists. The caller (app-update IPC) follows this
  // with a check for the new channel; if a stale check is still resolving, that
  // check is queued via `pendingRecheck`.
  downloadInProgress = false;
  downloadIntent = null;
  candidateGeneration = null;
  return {
    outcome: "changed",
    snapshot: emitSnapshot({
      allowPrerelease: autoUpdater.allowPrerelease,
      status: "idle",
      latestVersion: null,
      // Cleared WITH the version. These two describe one candidate, and a null
      // version beside a live epoch would read as "some build of unknown
      // version declares epoch N" to every consumer that treats a non-null
      // epoch as sufficient.
      latestCompatibilityEpoch: null,
      downloadProgress: null,
      errorMessage: null,
      lastCheckIntent: null,
    }),
  };
}

/**
 * Whether a staged update can be withdrawn on THIS platform.
 *
 * `darwin` is the whole of the exception and the reason is Squirrel.Mac, not
 * macOS: `MacUpdater.updateDownloaded` hands the artifact to the native updater
 * the moment the download completes (under `autoInstallOnAppQuit`, which this
 * app deliberately keeps enabled), and from then on the staging lives in
 * ShipIt's own cache with no supported API to revoke it. Reaching into
 * `~/Library/Caches/<appId>.ShipIt/` was investigated and rejected: it races
 * the already-spawned watcher and is version-fragile.
 *
 * Everywhere else the artifact is inert until something acts on it, and both
 * of the things that could act are ours to stop - see the call sites.
 */
function canDiscardStagedUpdate(): boolean {
  return process.platform !== "darwin";
}

/**
 * Disarms quit-time install for the rest of this process.
 *
 * WHY THIS IS SUFFICIENT rather than hopeful, at the pinned electron-updater:
 * `BaseUpdater` registers its quit handler once, at download completion, and
 * that handler RE-READS `this.autoInstallOnAppQuit` when the quit actually
 * arrives ("Update will not be installed on quit because autoInstallOnAppQuit
 * is set to false"). So lowering the public flag after the fact genuinely
 * disarms an already-registered handler, and lowering it before a download
 * completes stops the handler being registered at all. A contract test pins
 * that re-read, because the whole Windows/AppImage half of this policy rests
 * on it.
 *
 * It is deliberately NOT re-raised later in the process. Re-arming would mean
 * deciding, at some future download completion, that the artifact then staged
 * is one we still want applied silently - and the explicit "Restart to update"
 * affordance covers that case with the user present. deb/rpm never had it
 * raised (`configureAutoUpdater` sets it false there), so this is a no-op for
 * them.
 */
function disarmQuitInstall(): void {
  if (!autoUpdater.autoInstallOnAppQuit) {
    return;
  }
  log.info("[updater] disarming quit-time install for a staged update");
  autoUpdater.autoInstallOnAppQuit = false;
}

/**
 * Withdraws a staged artifact from every path that could still apply it, and
 * transitions the snapshot out of the states that offer it.
 *
 * Three paths, all closed:
 *
 *  - QUIT-TIME install, by {@link disarmQuitInstall} above.
 *  - The MANUAL install affordance, by leaving `ready`: `installDownloadedUpdate`
 *    refuses unless `status === "ready"`, and every renderer affordance is gated
 *    on the same status.
 *  - REUSE by a later download, by `DownloadedUpdateHelper`'s own re-hash: it
 *    records and re-verifies the cached file's `sha512` against the CURRENT feed
 *    candidate and empties `pending/` on any mismatch. An RC artifact never
 *    matches a stable one's hash.
 *
 * The bytes on disk are deliberately left alone. `DownloadedUpdateHelper.clear()`
 * is `@private` and reachable only through a cast this repo's lint bans, and
 * deleting `pending/` by hand races a download that may be writing into it - the
 * one non-idempotent operation in this design, and the one it refuses. The
 * helper's own cleanup covers it without the race.
 *
 * Idempotent: every step is a flag or a snapshot transition, so a crash between
 * them leaves at worst "flag cleared, snapshot stale", which fails in the safe
 * direction and converges on the next call or restart.
 */
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

/**
 * How many RC candidates the recovery probe will fetch a manifest for.
 *
 * The listing walk is already bounded by {@link MAX_DISCOVERY_PAGES}; this
 * bounds the SECOND cost, one HTTP round trip per surviving candidate. Newest
 * first, so the cap only ever truncates the tail - and a floor that no RC build
 * in the five newest can clear is not one an older RC build is going to clear
 * either. Truncation is logged rather than silent, because "we found nothing"
 * and "we stopped looking" are different answers.
 */
const MAX_RC_RECOVERY_MANIFEST_FETCHES = 5;

/**
 * Wall-clock ceiling for the whole RC probe.
 *
 * The fetch-count budget above bounds how many requests are made; it does not
 * bound how long one of them takes. A stalled TCP connection never rejects, so
 * without a deadline the `manual` fallback this design leans on is simply never
 * reached and the blocking dialog sits on a spinner indefinitely - the one
 * outcome every arm of this surface is written to avoid.
 *
 * THE WHOLE PROBE, not per request, and deliberately: the two fetch helpers are
 * shared with the shipping discovery path (`resolveDesktopReleaseFeed`), and
 * threading a signal through them would change update behaviour well outside
 * this recovery flow. Racing the composed probe bounds the answer without
 * touching either.
 *
 * The loser of the race is abandoned rather than cancelled - its socket closes
 * when the runtime gives up - which is acceptable because the probe is
 * read-only and mutates nothing on timeout.
 */
const RC_RECOVERY_PROBE_DEADLINE_MS = 15_000;

/**
 * In-flight RC probes, keyed by the floor they are probing for.
 *
 * Every window renders its own copy of the blocking recovery surface, and they
 * all mount at once when a host raises its floor mid-session - so without this
 * one rejection fans out into one paginated GitHub walk per window. Keyed by
 * epoch rather than shared outright because two hosts with different floors are
 * two different questions, and the cheaper answer must not be reused for the
 * stricter one.
 *
 * Only the IN-FLIGHT promise is shared; nothing is cached past settlement. A
 * probe is cheap relative to how rarely this surface opens, and a cached "no RC
 * build clears this" would outlive the publication of the build that does.
 */
const rcRecoveryProbesInFlight = new Map<
  number,
  Promise<DesktopReleaseCandidate | null>
>();

/**
 * THE recovery decision for a client the host refused at its epoch gate.
 *
 * Decided here, in main, because every input lives here - see
 * {@link DesktopCompatRecoveryPlan} for why the renderer gets a route and not
 * the facts behind it.
 *
 * `hostAllowsRcRecovery` is passed in rather than read from the requirement,
 * because the requirement is a wire object and its interpretation
 * (`hostReleaseChannelAllowsRcRecovery` - only the exact string `rc`) belongs to
 * the protocol package the renderer already imports. Main is told the verdict,
 * not the channel string, so there is no second place that could decide `dev`
 * or an unknown future line authorizes an RC hop.
 *
 * IT HAS ONE SIDE EFFECT, and only in the direction of safety: an insufficient
 * held candidate is discarded where the platform permits (§5's disarm-on-
 * detection). That is not incidental to answering the question - a Windows user
 * who quits while an insufficient build is staged installs it and relaunches
 * into the same rejection, and this is the moment we learn it is insufficient.
 */
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
  // An automatic check deliberately leaves the public snapshot at `idle`.
  // Wait for it before deciding the selected feed cannot help; otherwise a
  // faster RC probe can offer an unnecessary prerelease opt-in while the
  // stable check is about to publish a sufficient candidate.
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
    // The selected feed already holds a build that clears the floor. No channel
    // change is offered even if the host is on RC - the update the user already
    // has is the shorter path, and an RC opt-in they did not need is one they
    // cannot easily undo.
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
    // Nothing staged YET, but the updater is holding or fetching a candidate we
    // have just established cannot clear the floor. Lowering the flag now means
    // the download's completion never registers a quit handler at all, which is
    // better than lowering it after the artifact lands.
    //
    // GATED ON `holdsCandidate` deliberately. Disarming on the bare insufficient
    // path would also fire when the updater holds NOTHING - the common case for
    // this dialog - and quit-time install stays off for the rest of the process
    // once lowered. That would silently cost a user their auto-install for a
    // perfectly good update they fetch later in the same session, to defend
    // against an artifact that does not exist.
    disarmQuitInstall();
  }
  if (!input.hostAllowsRcRecovery) {
    return manualRecoveryPlan();
  }
  // AN ACTIVE DOWNLOAD FORECLOSES THE RC HOP, whatever the probe would find.
  // `performChannelChange` refuses unconditionally while a transfer is in
  // flight - there is no `CancellationToken` plumbed, so that refusal cannot be
  // relaxed - and offering `enable-rc` here would put up a button whose only
  // possible outcome is `refused-update-pending`, reported to the user as
  // nothing happening at all. The download settles on its own; recovery
  // re-resolves and reaches the RC offer then.
  if (downloadInProgress || currentSnapshot.status === "downloading") {
    return manualRecoveryPlan();
  }
  // THE EFFECTIVE MODE, not the persisted preference and not
  // `currentSnapshot.allowPrerelease`.
  //
  // `explicit-prerelease` is the case this guard has always covered: the feed
  // checked above WAS the prerelease feed, so there is no second line left to
  // look on, and `setAllowPrereleaseUpdates(true)` would answer `unchanged` -
  // a button that reports success and changes nothing.
  //
  // `implicit-rc-line` is the case the mode model adds, and it is worse than a
  // no-op. An RC build already receives its own line's candidates, so the
  // probe would offer an opt-in that changes no current discovery behavior
  // while PERSISTING a broad prerelease preference the user never asked for -
  // one that outlives the RC install and keeps them on prereleases after they
  // reach stable. Implicit participation is derived and must never be written
  // to disk, so the `enable-rc` route stays reserved for a stable-only app
  // giving explicit consent.
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
 * Does an RC build exist that would clear this floor?
 *
 * READ-ONLY, and that is the property that makes it safe to run from a blocking
 * dialog on a channel the user has not opted into: no `setFeedURL`, no
 * `channelGeneration` bump, no snapshot mutation, no `autoUpdater` touch of any
 * kind. `resolveDesktopReleaseFeed` - the shipping discovery path - does all
 * four, which is exactly why this is a separate function rather than a flag on
 * that one.
 *
 * SELECTOR-FAITHFUL: enabling prereleases makes the shipping resolver consider
 * stable and RC tags together, newest-first. The probe must inspect that same
 * ordered set and decide from the FIRST usable candidate. Skipping an
 * insufficient stable candidate to offer an older sufficient RC would promise
 * a build the updater will never select after consent.
 *
 * DEEP-VALIDATED before its epoch or channel can authorize an offer, with the same
 * `validateDesktopReleaseManifest` the shipping path uses: a candidate that
 * would fail the OS floor, the architecture filter, or a missing checksum is
 * not a remedy, and offering it would spend the user's channel opt-in on a
 * build their updater then refuses to install.
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
    // A probe failure is not a verdict about RC - it is "we could not find
    // out". Route it exactly like "nothing found": the manual link. Surfacing
    // a discovery error on top of "your app is too old" adds noise to a state
    // that already has one clear instruction.
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
 * Resolves to the probe's answer, or to `null` once
 * {@link RC_RECOVERY_PROBE_DEADLINE_MS} elapses - whichever happens first.
 *
 * Timing out is reported as "no sufficient RC candidate", which is the same
 * conservative answer a failed probe gives. It is never reported as an error:
 * the caller's only use for the distinction would be to show it, and a network
 * diagnostic stacked on "your app is too old" is noise in a state that already
 * has one clear instruction.
 *
 * The timer is unref'd so a probe running as the app quits cannot hold the
 * process open, and cleared on the winning path so a resolved probe leaves no
 * pending handle behind.
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

/**
 * Starts downloading the update the user just opted into from the header
 * button. Only valid once the feed reported an update as `available`; a
 * second call while already downloading is a no-op (re-asserts the state).
 */
export function startUpdateDownload(): DesktopAppUpdateSnapshot {
  // Readiness guard (finding 1): a download is only reachable once a candidate
  // has been surfaced as `available`, which requires initialization to have
  // completed and attached the listeners that produce that state. This synchronous
  // guard keeps the entry point (and its download/error UX) unchanged while making
  // it impossible to touch electron-updater before the persisted channel/feed are
  // authoritative or after a failed init.
  if (updaterInitState !== "initialized") {
    return currentSnapshot;
  }
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
  // Some installed updater implementations throw *synchronously* while resolving
  // the download (e.g. during file resolution) rather than returning a rejected
  // promise. Attaching `.catch` to the call result would miss that throw, leaving
  // `downloadInProgress`/`downloading` stranded forever (finding 7). Wrapping the
  // call in an async IIFE funnels both a synchronous throw and an async rejection
  // into the one `.catch`, so either way the download takes the single
  // reset/error transition in `handleUpdaterError`.
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
  // Re-entrancy guard. The quit this triggers is bounded but not instant, and
  // the restart affordances live in every window, so a second request can
  // arrive mid-quit. `status` is still "ready" at that point (the artifact is
  // staged until the process ends), so the check above can't catch it - handing
  // a second `quitAndInstall` to electron-updater mid-install is not something
  // we rely on it to tolerate.
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
    // Some installed updater implementations throw *synchronously* here rather
    // than rejecting (same hazard the download path guards against). Without
    // this, `handleUpdaterError` never runs: no error snapshot is emitted, so
    // `installInFlight` stays raised and every restart affordance is left
    // permanently disabled with no way back. Route it through the same handler
    // as an async failure - its `installingUpdate` branch lowers the flag and
    // emits the error. Call it BEFORE clearing the flag; that branch is
    // selected by it.
    log.warn("[updater] install handoff threw", err);
    handleUpdaterError(err);
  }
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

/**
 * `allowPrerelease` reports whether THE CURRENT CHECK effectively allows
 * prereleases - the derived effect of the mode, not the saved preference.
 *
 * An RC build following its own line reports `true` while its persisted
 * preference is `false`, and that is the honest answer to the question every
 * consumer is actually asking ("could this updater hand me an RC?"). If product
 * UI ever needs to distinguish "the user asked for prereleases" from "this
 * build follows its own line", that is a DISTINCT field - overloading this one
 * is how the recovery dialog came to offer an opt-in to a build that already
 * had one.
 */
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

// Resolves the repository the update feed targets. Without a private token, an
// unset/invalid coordinate falls back to the public production repo. WITH a
// token, an invalid coordinate returns null so callers fail closed: a private
// token must never authenticate against, or move the build onto, the public
// feed (review finding 2).
function resolveUpdateRepo(): GitHubRepoCoordinate | null {
  const parsed = parseGitHubRepoCoordinate(PRIVATE_UPDATE_REPO);
  if (PRIVATE_UPDATE_TOKEN.trim().length > 0) {
    return parsed;
  }
  return parsed ?? { owner: "traycerai", repo: "traycer" };
}

// True when a private update token is configured but its repository coordinate
// is invalid. In that state no feed can be safely resolved, so every check is
// refused up front (fail closed) rather than falling through to the packaged
// public feed.
function invalidPrivateConfig(): boolean {
  return (
    PRIVATE_UPDATE_TOKEN.trim().length > 0 &&
    parseGitHubRepoCoordinate(PRIVATE_UPDATE_REPO) === null
  );
}

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

/**
 * Resolves the compatible desktop-tagged GitHub Release this MODE selects
 * across pagination, and builds the feed that points electron-updater at that
 * exact release. The repository also hosts host and CLI releases, so
 * electron-updater's built-in `allowPrerelease` GitHub path is unsafe: it
 * selects the newest prerelease without respecting the `desktop-v` namespace.
 * Returns null when no selectable desktop release exists (genuine "up to
 * date"); throws on a discovery error (surfaced as a check failure).
 */
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
  // Evaluate candidates newest-first, actually fetching + parsing each channel
  // manifest and fully validating it (tag/version agreement, checksums,
  // referenced installer assets, applicable installer, OS compatibility). The
  // first genuinely usable release wins; a broken, partial, or incompatible
  // newer release is skipped so an older applicable one is chosen instead of
  // committing the feed to a candidate that only fails once electron-updater
  // parses its manifest (cold-review finding 4).
  //
  // MODE FILTERS FIRST, and newest-first ordering is what gives the implicit
  // line its stable priority for free: the comparator ranks stable `X.Y.Z`
  // above every `X.Y.Z-rc.M`, so once the line's stable release is published it
  // is simply the head of the ordered list. The eligibility filter is what
  // keeps `X.Y+1.0-rc.1` out of that list entirely.
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

// Collects every `desktop-v*` candidate (RC-only consent applied by
// `projectDesktopRelease`) across pagination, without a manifest fetch, so the
// caller can order them and validate newest-first. Hitting the page cap with a
// still-full final page is a discovery error, not "no update", so a real release
// beyond the cap is never mistaken for "up to date".
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

// Fetches a candidate's channel manifest bytes for validation. An HTTP error
// (404/403 - a broken or unpublished manifest) returns null so discovery treats
// the release as unusable and falls back to the next; a transport-level failure
// rejects so a genuine connectivity problem surfaces as a discovery error rather
// than a false "up to date".
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

// Whether the running macOS build should be treated as arm64 for update-file
// selection, resolved once and cached for the process. Mirrors
// `MacUpdater.doDownloadUpdate`'s determination so discovery filters the same
// architecture the installed updater will at download time.
let cachedIsArm64Mac: boolean | null = null;

function isArm64MacTarget(): boolean {
  if (cachedIsArm64Mac === null) {
    cachedIsArm64Mac = resolveIsArm64Mac();
  }
  return cachedIsArm64Mac;
}

// `TEST_UPDATER_ARCH` (the same override electron-updater's `Provider` honors)
// short-circuits the probe deterministically. Otherwise a native arm64 build is
// arm64 outright; an x64 build additionally probes for Rosetta / arm64 hardware
// (an x64 binary translated onto Apple Silicon), which MacUpdater treats as
// arm64 and offers arm64 (or universal/x64) artifacts to.
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

/**
 * The compatibility epoch an updater candidate declares, read off the raw feed
 * document electron-updater parsed.
 *
 * DELEGATES to `desktop-release-feed.ts` rather than re-deriving the rule: the
 * RC probe reads the same key straight out of a channel manifest it fetched
 * itself, and a probe that called a candidate sufficient while this call site
 * later called the same candidate insufficient would offer the user a remedy
 * that immediately withdraws itself.
 *
 * WHY THE KEY SURVIVES AT ALL, verified against the pinned electron-updater
 * rather than assumed: `parseUpdateInfo` is a bare `js-yaml` load of the whole
 * document, `GitHubProvider.getLatestVersion` returns `{ tag, ...result }`,
 * `update-available` emits `result.info` unmodified, and `update-downloaded`
 * emits `{ ...updateInfo, downloadedFile }`. Every hop preserves unknown keys.
 * That is a property of a PINNED dependency, so it is pinned by a contract test
 * and must be re-checked at every dependency bump.
 *
 * ANYTHING UNREADABLE IS `null`, and `null` is insufficient everywhere it is
 * consumed. An absent key, a string `"2"`, a float, a zero: each means we could
 * not establish the candidate's generation, and a candidate whose generation is
 * unknown must never be offered as the remedy for a compatibility rejection.
 * Refusing to guess here is what keeps a wrong stamp a routing inconvenience
 * rather than a restart into the same rejection.
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

// REMOVED with the three-mode channel model: the "no production release exists
// yet" fallback.
//
// It existed because an RC build used to check the STABLE `/releases/latest`
// feed, which 404s until the line's first GA release is published, and
// reporting that 404 as a service failure to every RC user was noise. Under the
// mode model a canonical `X.Y.Z-rc.N` build is never on the stable feed - it
// derives `implicit-rc-line`, configures `allowPrerelease: true`, and resolves
// its candidate through the namespaced `desktop-v*` selector, which answers
// "nothing selectable" by returning a null feed (a genuine up-to-date), not by
// raising an updater error. The only builds still on the stable feed are stable
// releases and non-canonical prereleases, and for both of those a 404 from the
// release feed IS a service problem worth surfacing.
//
// Keeping the fallback would have meant keeping a second, contradictory
// definition of "is this a prerelease" (`version.includes("-")`) alive purely
// to suppress an error path that the supported builds can no longer reach.

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

// True when the in-flight check was started under a channel that has since been
// superseded by a `setAllowPrereleaseUpdates` call. Used to drop a stale check's
// terminal emission (its failure or "no stable release" outcome) so it cannot
// overwrite the current channel's snapshot; the re-check queued for the new
// channel owns the authoritative outcome (finding 8). Deliberately scoped to the
// check path only - genuine current download/install errors carry no
// `checkGeneration` and are never generation-gated, so they still surface.
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
