import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encodeStageFingerprint } from "@traycer-clients/shared/host-version/stage-fingerprint";
import { log } from "../app/logger";
import { prereleaseUpdatesEnabled } from "../app/update-preferences";
import {
  hasUnappliedPendingLoginItemRevision,
  hostManagesHostLoginItem,
  readHostLoginItemStatus,
  type HostLoginItemStatus,
  type RegisterHostLoginItemResult,
} from "../app/host-login-item";
import { resolveBundledCliPath } from "../cli/cli-discovery";
import {
  runBundledTraycerCliJson,
  streamBundledTraycerCliJson,
  TraycerCliError,
  type NdjsonEvent,
} from "../cli/traycer-cli";
import {
  withDesktopUpdateContender,
  withDesktopAttemptMutation,
  DesktopCliLockBusyError,
  type DesktopUpdateContenderOutcome,
} from "./update-contender";
import {
  registerHostLoginItemWithAttempt,
  unregisterHostLoginItemWithAttempt,
  publishRestartTombstoneWithAttempt,
  clearRestartTombstoneWithAttempt,
  withMintedAdoption,
} from "./update-mutation";
import {
  readUpdateAttemptRecord,
  commitAttemptMutationWithCapability,
  isTerminalRetentionExpired,
  type HostUpdateAttemptIdentity,
  type HostUpdateAttemptRecord,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import type { HostUpdateAttemptPhase } from "@traycer/protocol/config/host-update-attempt";
import { readHostServiceOwner } from "./host-owner";
import {
  runDesktopActivationSegment,
  NO_DESKTOP_EXECUTOR_FAULTS,
  type DesktopActivationCycleOutcome,
  type DesktopActuatorSpan,
  type DesktopVerificationOutcome,
} from "./update-executor";
import {
  requiresPreReleaseListing,
  resolveHostChannelMode,
  resolveHostStageTarget,
} from "./host-stage-policy";
import {
  getHostFsLayout,
  cliLockPath,
  labelForEnvironment,
  smAppServiceAgentLabelId,
  type Environment,
  type HostFsLayout,
} from "./host-paths";
import {
  HOST_READY_POLL_MS,
  HOST_READY_TIMEOUT_MS,
  waitForHostReady,
  type HostReadinessResult,
} from "./host-readiness";
import {
  clearHostRemovedByUser,
  isHostRemovedByUser,
  markHostRemovedByUser,
} from "./host-removal-state";
import {
  attestedInstallGenerationFromDisk,
  compareHostVersions,
  deriveActivationState,
  deriveUpdateReady,
  isStrictlyNewerHostVersion,
  probeHostBusyVerdict,
  readDesktopHostInstallRecord,
  readDesktopHostStagedRecord,
  readReachableHostIdentity,
  readRunningHostIdentity,
  readRunningRuntimeVersion,
  type DesktopHostInstallRecord,
  type HostEndpointReachabilityProbe,
} from "./host-state";
import {
  HOST_REMOVED_BY_USER_MESSAGE,
  type AbandonedByGuard,
  type ActivateInstalledOk,
  type ApplyStagedOk,
  type ApplyStagedTrigger,
  type BusyContinuation,
  type ConvergeReadyOk,
  type DownloadLaneStatus,
  type GuardedMutationOutcome,
  type HostControllerIntent,
  type HostControllerStatus,
  type LocalAttemptFacts,
  type InstallVersionOk,
  type LifecycleAdmissionBlock,
  type MutationKind,
  type MutationLaneStatus,
  type MutationOutcome,
  type MutationProgress,
  type PendingRevisionCaller,
  type RemoveTraycerOk,
  type LocalHostMutationIntent,
  type ServiceRegistrationOk,
  type UninstallOk,
} from "./host-controller-types";

// Single main-process owner of every host-lifecycle mutation (Host Update
// Layer Redesign Tech Plan, "Desktop main: HostController"). Every writer
// that used to shell out to the CLI or the platform service-manager
// directly now submits an intent here instead - see the ticket's "Single-
// writer cutover" for the exhaustive list of call sites this replaces.

// How long a streaming CLI child may stay SILENT before it is treated as
// wedged and killed. Not a ceiling on how long the work may take: the timer
// re-arms on every NDJSON event (`streamTraycerCliJson`), and the CLI emits
// progress per downloaded chunk plus watchdog/backoff heartbeats while a
// transfer is stalled.
//
// As an absolute cap this same 10 minutes made the host download
// unfinishable below ~1.2 MB/s - the CLI was SIGKILLed mid-transfer and the
// partial went with it (traycer#585/#589). Kept at 10 minutes as an idle
// budget: comfortably longer than the CLI's own 30s transfer watchdog, so
// only a child that has genuinely stopped reporting trips it.
//
// Deliberately shared by `host service install` too, not a tighter
// per-command bound: that command's legitimately SILENT windows stack -
// a 30s cli-lock wait, a 32s cooperative host stop (SHUTDOWN_FORCE_EXIT_MS
// + margin), and on win32 an install/replace sequence whose schtasks/
// taskkill subprocess timeouts alone sum past 100s with no NDJSON between
// them - so any bound tight enough to feel responsive risks SIGKILLing a
// slow-but-live registration mid-critical-section, the torn-record class
// the A8 comment above exists to prevent. Slow detection of a rare wedge
// beats a false kill of a real one.
const CLI_STREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
// Fixup A9: the production desktop-held cli-lock wait/poll - matches the
// CLI's own `waitMs: 30_000` at every `withCliLock` call site (fixup A8).
// Exported (not just a local default) so `HostControllerOptions.desktopLockWaitMs`/
// `desktopLockPollIntervalMs` has one source of truth for its production
// value at the one real construction site (`desktop-startup.ts`), while
// still being an explicit, required, per-instance field - not a default
// parameter - so a test can inject a small override and prove the
// exhausted-lock -> `deferred` terminal contract in a unit suite instead of
// a real 30s wait.
export const DESKTOP_LOCK_WAIT_MS = 30_000;
export const DESKTOP_LOCK_POLL_INTERVAL_MS = 100;
const CLI_LOCK_BUSY_CODE = "E_CLI_LOCK_BUSY";
const HOST_BUSY_CODE = "E_HOST_BUSY";
const HOST_UPDATE_ATTEMPT_ACTIVE_CODE = "E_HOST_UPDATE_ATTEMPT_ACTIVE";
const LOCK_BUSY_MESSAGE = "Another Traycer process is managing the host.";

class HostReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostReadinessError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single user-visible message for the SMAppService approval state. The sole
// canonical copy (Tech Plan judgment call 3): every caller that used to
// import this from the now-deleted `app/host-respawn.ts` - the ensure fast
// path, IPC respawn, menu/tray respawn - now gets it from here, so the
// actionable copy can never drift into two texts that quietly diverge.
function approvalRequiredMessage(): string {
  return (
    "Traycer's background host is registered but disabled by macOS. " +
    "Open System Settings → General → Login Items & Extensions and turn on " +
    'Traycer under "Allow in the Background", then click Retry.'
  );
}

function progressFromNdjson(
  event: Extract<NdjsonEvent, { type: "progress" }>,
): MutationProgress {
  return {
    stage: event.stage,
    percent: event.percent,
    bytes: event.bytes,
    totalBytes: event.totalBytes,
    message: event.message,
    workUnits: event.workUnits,
  };
}

// The CLI names its network liveness ticks `registry-<resource>-<phase>`
// (registry/client.ts, commands/cli-upgrade.ts). They report that a fetch is
// still alive, not that the work moved to a new stage - see
// `setMutationProgress`.
const REGISTRY_LIVENESS_STAGE_PREFIX = "registry-";

function isRegistryLivenessStage(stage: string | null): boolean {
  return stage !== null && stage.startsWith(REGISTRY_LIVENESS_STAGE_PREFIX);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---- Tolerant local parsers for the CLI's NDJSON `result.data` payloads --
//
// Desktop-local mirrors of the CLI producers' shapes (commands/host-*.ts),
// not imports of CLI-internal types - this ticket must not modify or
// depend on `clients/traycer-cli/` internals. Parsed the same
// defensively-tolerant way `host-management-ipc.ts`'s existing
// `projectInstallResult`/`projectUninstallResult` already do.

interface ApplyResultShape {
  readonly outcome: "no-op" | "applied" | "stage-fingerprint-mismatch";
  readonly installedVersion: string | null;
  readonly version: string | null;
  // The newly-COMMITTED record's runtime stamp (`record.runtimeVersion` on
  // the CLI's real `applied` outcome - `installer/apply.ts`'s
  // `ApplyHostOutcome`), not the pre-apply record's. Fixup B9: stamping
  // must decide off what this apply just wrote, never the record it
  // replaced - see the call site in `applyStagedCliOwned`.
  readonly runtimeVersion: string | null;
  readonly runningActivated: boolean;
  readonly installGeneration: string | null;
  readonly postSwapError: string | null;
  readonly stoppedBeforeSwap: boolean;
  readonly postSwapAction: string | null;
}

interface PurgeStageResultShape {
  readonly outcome: "purged" | "stage-fingerprint-mismatch" | null;
}

function parsePurgeStageResult(raw: unknown): PurgeStageResultShape {
  if (!isPlainObject(raw)) return { outcome: null };
  return {
    outcome:
      raw.outcome === "purged" || raw.outcome === "stage-fingerprint-mismatch"
        ? raw.outcome
        : null,
  };
}

function parseApplyResult(raw: unknown): ApplyResultShape {
  if (
    !isPlainObject(raw) ||
    raw.outcome === "no-op" ||
    raw.outcome === "stage-fingerprint-mismatch"
  ) {
    const installedVersion =
      isPlainObject(raw) && typeof raw.installedVersion === "string"
        ? raw.installedVersion
        : null;
    return {
      outcome:
        isPlainObject(raw) && raw.outcome === "stage-fingerprint-mismatch"
          ? "stage-fingerprint-mismatch"
          : "no-op",
      installedVersion,
      version: null,
      runtimeVersion: null,
      runningActivated: false,
      installGeneration: null,
      postSwapError: null,
      stoppedBeforeSwap: false,
      postSwapAction: null,
    };
  }
  const record = isPlainObject(raw.record) ? raw.record : null;
  const lifecycle = isPlainObject(raw.serviceLifecycle)
    ? raw.serviceLifecycle
    : null;
  return {
    outcome: "applied",
    installedVersion: null,
    version:
      record !== null && typeof record.version === "string"
        ? record.version
        : null,
    runtimeVersion:
      record !== null && typeof record.runtimeVersion === "string"
        ? record.runtimeVersion
        : null,
    runningActivated: raw.runningActivated === true,
    installGeneration:
      typeof raw.installGeneration === "string" ? raw.installGeneration : null,
    postSwapError:
      typeof raw.postSwapError === "string" ? raw.postSwapError : null,
    stoppedBeforeSwap:
      lifecycle !== null && lifecycle.stoppedBeforeSwap === true,
    postSwapAction:
      lifecycle !== null && typeof lifecycle.postSwapAction === "string"
        ? lifecycle.postSwapAction
        : null,
  };
}

interface InstallResultShape {
  readonly version: string | null;
  readonly runtimeVersion: string | null;
  readonly installGeneration: string | null;
  readonly postSwapError: string | null;
  readonly postSwapAction: string | null;
}

function parseInstallResult(raw: unknown): InstallResultShape {
  if (!isPlainObject(raw)) {
    return {
      version: null,
      runtimeVersion: null,
      installGeneration: null,
      postSwapError: null,
      postSwapAction: null,
    };
  }
  const lifecycle = isPlainObject(raw.serviceLifecycle)
    ? raw.serviceLifecycle
    : null;
  return {
    version: typeof raw.version === "string" ? raw.version : null,
    runtimeVersion:
      typeof raw.runtimeVersion === "string" ? raw.runtimeVersion : null,
    installGeneration:
      typeof raw.installGeneration === "string" ? raw.installGeneration : null,
    postSwapError:
      lifecycle !== null && typeof lifecycle.postSwapError === "string"
        ? lifecycle.postSwapError
        : null,
    postSwapAction:
      lifecycle !== null && typeof lifecycle.postSwapAction === "string"
        ? lifecycle.postSwapAction
        : null,
  };
}

interface EnsureResultShape {
  readonly installed: boolean;
  readonly registered: boolean;
  readonly running: boolean;
  readonly version: string | null;
  readonly runtimeVersion: string | null;
  readonly action:
    | "noop"
    | "installed"
    | "service-registered"
    | "started"
    | null;
  readonly installGeneration: string | null;
  readonly postSwapError: string | null;
}

function parseEnsureResult(raw: unknown): EnsureResultShape {
  if (!isPlainObject(raw)) {
    return {
      installed: false,
      registered: false,
      running: false,
      version: null,
      runtimeVersion: null,
      action: null,
      installGeneration: null,
      postSwapError: null,
    };
  }
  const action =
    raw.action === "noop" ||
    raw.action === "installed" ||
    raw.action === "service-registered" ||
    raw.action === "started"
      ? raw.action
      : null;
  return {
    installed: raw.installed === true,
    registered: raw.registered === true,
    running: raw.running === true,
    version: typeof raw.version === "string" ? raw.version : null,
    runtimeVersion:
      typeof raw.runtimeVersion === "string" ? raw.runtimeVersion : null,
    action,
    installGeneration:
      typeof raw.installGeneration === "string" ? raw.installGeneration : null,
    postSwapError:
      typeof raw.postSwapError === "string" ? raw.postSwapError : null,
  };
}

interface StampRuntimeResultShape {
  readonly outcome: "stamped" | "superseded" | null;
  readonly reason:
    | "no-install-record"
    | "runtime-already-stamped"
    | "runtime-version-mismatch"
    | "generation-mismatch"
    | "no-live-host"
    | "pid-evidence-mismatch"
    | "pid-not-live"
    | null;
}

function parseStampRuntimeResult(raw: unknown): StampRuntimeResultShape {
  if (!isPlainObject(raw)) return { outcome: null, reason: null };
  return {
    outcome:
      raw.outcome === "stamped" || raw.outcome === "superseded"
        ? raw.outcome
        : null,
    reason:
      raw.reason === "no-install-record" ||
      raw.reason === "runtime-already-stamped" ||
      raw.reason === "runtime-version-mismatch" ||
      raw.reason === "generation-mismatch" ||
      raw.reason === "no-live-host" ||
      raw.reason === "pid-evidence-mismatch" ||
      raw.reason === "pid-not-live"
        ? raw.reason
        : null,
  };
}

interface ServiceStartResultShape {
  readonly installGeneration: string | null;
  readonly runtimeVersion: string | null;
  readonly runtimeWasNull: boolean;
  /** A parked activation continuation was safely stopped, not relaunched. */
  readonly restarted: boolean;
  /**
   * The command REFUSED under its own lock and left the service untouched,
   * because a parked packaged activation made a generic restart unsafe.
   *
   * Distinct from `restarted:false`, which stopped the service. Collapsing the
   * two would report a still-running host as `{activated:false}` - the shape
   * that reads as "your restart did nothing and your host is down".
   */
  readonly deferredForParkedActivation: boolean;
}

function parseServiceStartResult(raw: unknown): ServiceStartResultShape {
  if (!isPlainObject(raw)) {
    return {
      installGeneration: null,
      runtimeVersion: null,
      runtimeWasNull: false,
      restarted: true,
      deferredForParkedActivation: false,
    };
  }
  // `streamBundled` returns CLI `data` directly. Keep this tolerant of the
  // full command envelope as well: recovery is a safety boundary and must
  // never treat a parked safe-stop as a successful relaunch solely because a
  // caller preserved that envelope for diagnostics.
  const data = isPlainObject(raw.data) ? raw.data : raw;
  return {
    installGeneration:
      typeof data.installGeneration === "string"
        ? data.installGeneration
        : null,
    runtimeVersion:
      typeof data.runtimeVersion === "string" ? data.runtimeVersion : null,
    runtimeWasNull: data.runtimeWasNull === true,
    // `host restart` reports this field directly; the free-port recovery
    // command names the same fact by the restarted label. Older commands did
    // neither, so retain their historic successful-start interpretation.
    restarted:
      data.restarted === false || data.restartedLabel === null ? false : true,
    // Must be an explicit `=== true`: a command that predates the flag omits
    // the field, and treating "absent" as a deferral would turn every legacy
    // safe-stop into a silent no-op report.
    deferredForParkedActivation: data.deferredForParkedActivation === true,
  };
}

interface UninstallResultShape {
  readonly removedInstallDir: boolean;
  readonly removedStagedDir: boolean;
  readonly serviceUninstalled: boolean;
  readonly serviceRegistrationRetained: boolean | null;
}

// `all` mirrors the legacy IPC-layer `projectUninstallResult` leniency: an
// `--all` uninstall always requests service deregistration, so a CLI
// response that omits `serviceUninstalled` (rather than explicitly reporting
// `false`) is read as deregistered. `removedRecord` is an older CLI field
// name for `removedInstallDir` - accepted for backward compatibility with a
// CLI build that predates the rename.
function parseUninstallResult(
  raw: unknown,
  all: boolean,
): UninstallResultShape {
  if (!isPlainObject(raw)) {
    return {
      removedInstallDir: false,
      removedStagedDir: false,
      serviceUninstalled: false,
      serviceRegistrationRetained: null,
    };
  }
  return {
    removedInstallDir:
      raw.removedInstallDir === true || raw.removedRecord === true,
    removedStagedDir: raw.removedStagedDir === true,
    serviceUninstalled:
      raw.serviceUninstalled === true ||
      (all && raw.serviceUninstalled !== false),
    // Additive tri-state from the CLI: `true` means its readback positively
    // found the registration still there. Carried through rather than
    // collapsed, because `serviceUninstalled` above cannot express "unknown"
    // and no platform can verify absence - see `UninstallOk`.
    serviceRegistrationRetained:
      raw.serviceRegistrationRetained === true
        ? true
        : raw.serviceRegistrationRetained === false
          ? false
          : null,
  };
}

interface AvailableSnapshotShape {
  readonly valid: boolean;
  readonly latest: string;
  readonly versions: ReadonlyArray<{
    readonly version: string;
    readonly available: boolean;
  }>;
}

// One attempt of the locked macOS activation cycle. The extra arm marks
// the one failure class the wrapper may repair by re-running the cycle:
// "register completed, host did not come up in time". Deliberately NOT a
// MutationOutcome kind - it must never escape to a caller, and carrying
// the message (not the built failure) defers `failedAfterServiceCycle`'s
// reload side effect until the retry is truly exhausted.
type MacActivationCycleAttempt =
  | MutationOutcome<{ readonly activated: boolean }>
  | {
      readonly kind: "retryable-readiness-timeout";
      readonly message: string;
      // Carried so the retry decision can tell "the host came up late" from
      // "a host is reachable": `prePid` is who was serving BEFORE this cycle
      // tore it down, and `expectedRuntimeVersion` is what the cycle had to
      // produce. Without both, a reachable outgoing host reads as success.
      readonly prePid: number | null;
      readonly expectedRuntimeVersion: string | null;
    };

interface EligibleStage {
  readonly version: string;
  readonly fingerprint: string;
}

// Mirrors the real wire shape `traycer host available --json` emits
// (`traycer-cli/src/commands/host-available.ts`'s `data` envelope):
// `{ manifest: { latest, versions[].platforms[platformKey] }, manifestUrl,
// platformKey }` - NOT a flat `{latest, versions[].platformAsset}` shape.
// Pinned against the CLI's real command output by the contract test in
// `traycer-cli/src/commands/__tests__/host-available.test.ts`.
function parseAvailableSnapshot(raw: unknown): AvailableSnapshotShape {
  if (!isPlainObject(raw) || typeof raw.platformKey !== "string") {
    return { valid: false, latest: "", versions: [] };
  }
  const platformKey = raw.platformKey;
  const manifest = isPlainObject(raw.manifest) ? raw.manifest : null;
  if (
    manifest === null ||
    typeof manifest.latest !== "string" ||
    !Array.isArray(manifest.versions)
  ) {
    return { valid: false, latest: "", versions: [] };
  }
  const versions = manifest.versions.flatMap((entry) => {
    if (!isPlainObject(entry) || typeof entry.version !== "string") return [];
    const platforms = isPlainObject(entry.platforms) ? entry.platforms : null;
    const asset = platforms !== null ? platforms[platformKey] : null;
    return [
      {
        version: entry.version,
        // A platform asset can remain physically present while a release is
        // withdrawn. `host available` is the curation authority for staged
        // bytes, so a yanked entry is ineligible even if its asset says it
        // can be downloaded.
        available:
          entry.yanked !== true &&
          isPlainObject(asset) &&
          asset.available === true,
      },
    ];
  });
  return { valid: true, latest: manifest.latest, versions };
}

// Resolve the host-runtime archive bundled beside the desktop's CLI binary
// (`resources/cli/<platform>-<arch>/host-runtime-<platform>-<arch>.tar.gz`,
// staged by scripts/desktop-install-cloud.js). Windows-only (fixup A2): on
// POSIX the per-user slot CLI is a symlink into the app bundle, so
// `process.execPath` resolves beside the bundled host archive and the CLI's
// own `resolveBundledHostArchive` finds it unaided - passing nothing is
// correct there. On Windows symlinks need elevated privilege, so the slot
// CLI is a COPY living outside the bundle; the CLI can no longer see the
// sibling archive and would fall back to the registry, which publishes no
// win32 asset for dogfood/unsigned builds. `--from` points it at the
// archive explicitly. Returns null when there is no packaged archive (dev
// builds, CLI-only installs) - `host ensure` then falls through to its
// normal registry resolution.
async function resolveWindowsBundledHostArchive(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const bundledCli = await resolveBundledCliPath();
  if (bundledCli === null) return null;
  // No native Windows arm64 host - arm64 runs the x64 runtime (mirrors
  // resolveBundledHostArchive in the CLI).
  const arch = process.arch === "arm64" ? "x64" : process.arch;
  const archive = join(
    dirname(bundledCli),
    `host-runtime-win32-${arch}.tar.gz`,
  );
  try {
    await access(archive, constants.R_OK);
    return archive;
  } catch {
    return null;
  }
}

function latestVersionFromSnapshot(
  snapshot: AvailableSnapshotShape,
): string | null {
  if (snapshot.latest.length === 0) return null;
  const entry = snapshot.versions.find(
    (candidate) => candidate.version === snapshot.latest,
  );
  return entry !== undefined && entry.available ? entry.version : null;
}

// The listing rows background staging may actually choose between: installable
// on this platform and not yanked. Every policy question in
// `host-stage-policy.ts` is asked against this set, so a broken or withdrawn
// release is gone before any of them run.
function installableVersions(snapshot: AvailableSnapshotShape): string[] {
  return snapshot.versions
    .filter((entry) => entry.available)
    .map((entry) => entry.version);
}

/**
 * Narrow structural slice of `HostLifecycle` that `HostController` actually
 * calls - the same "narrow interface for testability" pattern as
 * `IpcHostLifecycle` / `IpcHostController`: tests supply a lightweight fake
 * instead of constructing the real, heavier `HostLifecycle` class. The real
 * class satisfies this structurally; no explicit `implements` needed.
 */
export interface HostControllerHostLifecycle {
  notifyRespawning(): void;
  ensureWatcherInstalled(): void;
  reloadSnapshotFromDisk(): Promise<unknown>;
}

export interface HostControllerOptions {
  readonly environment: Environment;
  readonly hostLifecycle: HostControllerHostLifecycle;
  /**
   * Real-endpoint-reachability probe for `readRunningRuntimeVersion`
   * (fixup A3). Production passes `canReachHostWebsocketUrl` from
   * `./host-lifecycle`; tests substitute a deterministic stub instead of
   * depending on a real TCP listener bound to a fixture's `websocketUrl`.
   */
  readonly reachabilityProbe: HostEndpointReachabilityProbe;
  /**
   * Fixup A9: injectable override for the desktop-held cli-lock's own
   * wait/poll timing at every `withDesktopCliLock` call site. Production
   * passes `DESKTOP_LOCK_WAIT_MS`/`DESKTOP_LOCK_POLL_INTERVAL_MS`
   * (30_000ms/100ms, matching the CLI's own 30s `waitMs` - fixup A8);
   * tests substitute a much smaller wait so the exhausted-lock ->
   * `deferred` terminal contract is provable in a unit suite instead of a
   * real 30s wait.
   */
  readonly desktopLockWaitMs: number;
  readonly desktopLockPollIntervalMs: number;
}

/**
 * `runLockedMacActivationCycle`'s desktop-locked closure result (fixup A7).
 * `"terminal"` short-circuits with a final outcome decided under the lock
 * (no host installed, busy). `"registered"` carries just enough state for
 * the CALLER to finish the choreography (stamp-runtime CAS + readiness
 * wait) AFTER the lock has released - those steps must never run while
 * still holding it, see the comment at the return site.
 * `"register-failed"` is the SMAppService refusal
 * (`not-found`/`not-registered`/`not-supported`) - also resolved after the
 * lock releases, because its recovery spawns the CLI, which re-acquires
 * this same lock (lock rule 3).
 */
type LockedMacActivationStep =
  | {
      readonly phase: "terminal";
      readonly outcome: MutationOutcome<{ readonly activated: boolean }>;
    }
  | {
      readonly phase: "register-failed";
      readonly status: HostLoginItemStatus;
      readonly prePid: number | null;
      readonly expectedRuntimeVersion: string | null;
    }
  | {
      readonly phase: "registered";
      readonly registerResult: RegisterHostLoginItemResult;
      readonly prePid: number | null;
      readonly expectedGeneration: string | null;
      readonly expectedRuntimeVersion: string | null;
    };

// Phases where a pending packaged-macOS activation could still be continued.
// Deliberately a pre-filter and NOT policy: `waiting-for-work` is excluded
// because its bytes are not placed (a plain restart is already correct there),
// and the three terminals because there is nothing left to continue. Whether a
// claim on any remaining phase is legal stays `decideAttemptClaim`'s call.
const FORCE_RESTART_CONTINUATION_PHASES: ReadonlySet<HostUpdateAttemptPhase> =
  new Set<HostUpdateAttemptPhase>([
    "downloading",
    "preparing",
    "applying",
    "waiting-to-activate",
    "restarting",
    "verifying",
  ]);

/** Non-`ok` takeover outcomes all carry a user-facing message. */
function describeTakeoverRefusal(outcome: MutationOutcome<never>): string {
  return "message" in outcome ? outcome.message : LOCK_BUSY_MESSAGE;
}

const HOST_UPDATE_ACTIVATING_MESSAGE =
  "An update is activating - the host will restart on its own.";

/**
 * The parked identity a `resumed` report may name, or `null`.
 *
 * All three fields or none: a partially decoded identity is not a weaker
 * identity, it is a different attempt with two fields borrowed. Generation and
 * sequence must be real integers - `Number.isInteger` rather than `typeof
 * number`, because `NaN` and `1.5` are both `number` and neither can name a
 * record.
 *
 * `null` is a supported answer, not a failure: an older CLI predates this field
 * entirely, and the caller treats "could not name it" as a reason to stop
 * rather than a reason to guess.
 */
function decodeParkedIdentity(
  raw: Record<string, unknown>,
): HostUpdateAttemptIdentity | null {
  const attemptId = raw.attemptId;
  const generation = raw.generation;
  const sequence = raw.sequence;
  // `typeof` first so TypeScript narrows, THEN `Number.isInteger` for the
  // values `typeof` calls a number and a record cannot use. `Number.isInteger`
  // alone would leave both `unknown` and force a cast, which this repo bans -
  // and rightly, since the cast would be the only thing asserting the shape.
  if (
    typeof attemptId !== "string" ||
    attemptId.length === 0 ||
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    typeof sequence !== "number" ||
    !Number.isInteger(sequence)
  ) {
    return null;
  }
  return { attemptId, generation, sequence };
}

/**
 * Decode the bundled CLI's verification report into Desktop's outcome type.
 *
 * ## Why this is a decoder and not a cast
 *
 * It used to be `streamBundled<DesktopVerificationOutcome>(...)`, which is a
 * type assertion over JSON from ANOTHER PROCESS. Two things were wrong with
 * that, and the second is worse than the first:
 *
 *  1. The two sides do not share a discriminator. The CLI reports
 *     `{ outcome: ... }` (`traycer-cli/src/host/update-verify.ts`); Desktop
 *     reads `{ kind: ... }`. So the asserted field was **always `undefined`**
 *     and no arm ever matched.
 *  2. Even had they agreed, the bytes come from a separately-versioned binary.
 *     A mixed-version CLI can emit a shape this build has never seen, and an
 *     assertion cannot notice. Desktop bundles the CLI *binary*, not its
 *     source, so the type genuinely cannot be shared - decoding is the correct
 *     architecture here, not a workaround for the rename.
 *
 * Total by construction: anything unrecognized becomes `indeterminate`, never
 * a terminal verdict. An unreadable answer is the absence of evidence, and
 * turning it into `complete` is exactly how a `verifying` record would acquire
 * a success it never earned.
 */
function decodeVerificationReport(value: unknown): DesktopVerificationOutcome {
  if (value === null || typeof value !== "object") {
    return {
      kind: "indeterminate",
      reason: "verification report was not an object",
    };
  }
  const raw: Record<string, unknown> = { ...value };
  const outcome = raw.outcome;
  const reason = typeof raw.reason === "string" ? raw.reason : "unspecified";
  switch (outcome) {
    case "complete":
      return { kind: "complete" };
    case "failed":
      return { kind: "failed", reason };
    case "resumed":
      return {
        kind: "resumed",
        continuation: "activate",
        parked: decodeParkedIdentity(raw),
      };
    case "indeterminate":
      return { kind: "indeterminate", reason };
    default:
      return {
        kind: "indeterminate",
        reason: `unrecognized verification outcome ${JSON.stringify(outcome)}`,
      };
  }
}

export class HostController {
  private readonly environment: Environment;
  private readonly layout: HostFsLayout;
  private readonly lockPath: string;
  private readonly hostLifecycle: HostControllerHostLifecycle;
  private readonly reachabilityProbe: HostEndpointReachabilityProbe;
  private readonly desktopLockWaitMs: number;
  private readonly desktopLockPollIntervalMs: number;

  private mutationTail: Promise<void> = Promise.resolve();
  private mutationStatus: MutationLaneStatus | null = null;
  // Bumped on every mutation start AND end. `streamBundled` captures it at
  // spawn so a CLI child's progress events publish only while the mutation
  // that spawned it is still the active one - `mutationStatus` itself is
  // replaced on every progress merge, so object identity cannot serve as
  // the ownership token.
  private mutationEpoch = 0;

  // Fixup B15: `applyPendingLoginItemRevisionIfIdle`'s disruptive
  // SMAppService cycle is reachable both outside the FIFO mutation lane
  // (the pending-login-item-revision monitor's poll loop) and reentrantly
  // from within an already-running lane job (`convergeReadyPackagedMac`),
  // where routing it through `enqueueMutation` would deadlock - see that
  // method's own comment. Tracked on this independent tail instead, so
  // `awaitMutationLaneIdle` (the quit-time drain) can still see it without
  // giving it FIFO exclusivity it neither needs nor can safely have (the
  // desktop cli-lock already provides real exclusivity for the disruptive
  // section itself).
  private pendingRevisionTail: Promise<void> = Promise.resolve();

  // Fixup D1: coalescing slot for `applyPendingLoginItemRevisionIfIdle` -
  // see that method's doc comment. Mirrors the deleted `runEnsureHost`'s
  // module-scoped `inFlight` slot, instance-scoped here since each
  // `HostController` already owns its own long-lived state.
  private pendingRevisionCycleInFlight: Promise<MutationOutcome<ConvergeReadyOk> | null> | null =
    null;

  // The EFFECTIVE owner policy of the cycle in the slot above, which is not
  // necessarily the policy of the caller that opened it: a within-lane joiner
  // UPGRADES it (see `applyPendingLoginItemRevisionIfIdle`). The reverse
  // admission check reads this rather than its own parameter, because a
  // coalesced call runs once for every caller attached to it - deciding on
  // the first caller's policy alone would refuse on behalf of a joiner whose
  // own lane job is the very thing being refused for.
  private pendingRevisionCycleCaller: PendingRevisionCaller | null = null;

  // Whether the cycle in the slot ended by refusing on OUTSIDE-lane policy.
  // Distinguishes that refusal from every other `null` (nothing to do, not
  // reachable, quarantined, host busy), which is what lets a within-lane
  // joiner tell "there was nothing to apply" from "it was refused for MY
  // lane" - only the second is worth re-attempting.
  private pendingRevisionCycleDeferredByLane = false;

  // True only while a pending-login-item revision cycle is COMMITTED - past
  // every precheck and either waiting on the desktop lock or running its
  // bootout/re-register. Deliberately narrower than the D1 in-flight slot
  // above, which is occupied during the prechecks of every monitor tick;
  // admission must not refuse a user's install because a poll happened to be
  // reading files at that moment.
  private pendingRevisionCycleDisruptive = false;

  private downloadTail: Promise<void> = Promise.resolve();
  private downloadStatus: DownloadLaneStatus | null = null;
  private downloadAbortController: AbortController | null = null;
  private stageLatestInFlight: Promise<void> | null = null;
  private stageLatestPending = false;
  private eligibleStage: EligibleStage | null = null;

  private latestVersionCache: string | null = null;

  // Session quarantine for the pending-LaunchAgent-revision fast-path
  // refresh (see `applyPendingLoginItemRevisionIfIdle` below). Instance-
  // scoped, not module-scoped - each `HostController` is a single
  // long-lived process singleton, so this needs no test-reset seam the way
  // the old module-level flag did.
  private pendingRevisionRefreshQuarantined = false;

  constructor(opts: HostControllerOptions) {
    this.environment = opts.environment;
    this.layout = getHostFsLayout(opts.environment);
    this.lockPath = cliLockPath(opts.environment);
    this.hostLifecycle = opts.hostLifecycle;
    this.reachabilityProbe = opts.reachabilityProbe;
    this.desktopLockWaitMs = opts.desktopLockWaitMs;
    this.desktopLockPollIntervalMs = opts.desktopLockPollIntervalMs;
  }

  // ---- Canonical status --------------------------------------------------

  /**
   * What would stop an accepted lifecycle write from running ALONE right now,
   * sampled synchronously — or `null` when nothing would.
   *
   * `getStatus()` reads the lane too, but only after three filesystem reads,
   * so its answer is already history by the time a caller sees it. A caller
   * that must not ENQUEUE beside running lifecycle work needs the test and the
   * submission in one synchronous stretch — the lane is exclusive but it does
   * not refuse a distinct intent, it queues it, so a stale "idle" verdict
   * becomes a write that lands after whatever was running. Pair this with the
   * submission and put no `await` between them.
   *
   * TWO sources, because the FIFO lane is not the only lifecycle work: the
   * pending-login-item revision cycle runs on its own tail (see
   * `pendingRevisionTail` above) and its bootout/re-register restarts the host
   * exactly like a lane job would. An admission check that read only the lane
   * would accept an install or restart during that cycle, serialize it behind
   * the refresh on the desktop lock, and deliver a second lifecycle change
   * after a refusal was promised. This getter is the ONLY admission surface —
   * the lane is deliberately not exposed on its own, so a future `*IfIdle`
   * handler cannot reach for the narrower fact.
   *
   * The lane arm reports the RUNNING intent, and `mutationStatus` is set when
   * a job begins rather than when it is enqueued — which is nevertheless
   * sufficient for every caller here, because the gap is not observable from
   * one. A job queued behind another is queued behind a job that has already
   * set the field; the only window where something is enqueued and this reads
   * `null` is between one job's `finally` and the next job's first line, and
   * those are adjacent microtasks in a single drain. No macrotask — no IPC
   * handler, no timer — can be scheduled inside it.
   */
  get lifecycleAdmissionBlock(): LifecycleAdmissionBlock | null {
    if (this.mutationStatus !== null) {
      return { kind: "mutation", lane: this.mutationStatus };
    }
    if (this.pendingRevisionCycleDisruptive) {
      return { kind: "login-item-refresh" };
    }
    return null;
  }

  /**
   * The durable attempt's facts, for the host-DOWN window (Ticket 07 §5.2.7).
   *
   * Reading this needs no host, which is the entire point: with the host down
   * there is no `host.status` to answer, and without these facts the renderer
   * has no observation at all — so a mid-flight update renders as a blank
   * "state unknown" and the user cannot tell it from an idle machine.
   *
   * Facts only. This method deliberately does NOT decide whether the attempt is
   * live, stale, or progressing: that judgement belongs to the renderer's
   * existing qualified-stale projector, and a second copy of it here would
   * drift from the one the live path uses.
   *
   * An unreadable or absent record both answer `null`, and the field's contract
   * says `null` means "cannot say" rather than "nothing running" — the caller
   * must not turn a failed read into a claim of idleness.
   */
  private async readLocalAttemptFacts(): Promise<LocalAttemptFacts | null> {
    const read = await readUpdateAttemptRecord(this.layout.rootDir);
    if (read.kind !== "valid") return null;
    const record = read.value;
    // The renderer's host-down memorial promises "a failure stays
    // discoverable until it is superseded or ages out", and the store-open
    // prune alone cannot keep the second half: pruning is handle-bound, a
    // handle exists only at a lock acquisition, and a stable host may not
    // acquire one for months. Retention is therefore also enforced at this
    // read seam — an aged-out terminal record answers `null` ("cannot say",
    // same as absent) rather than resurfacing a week-old failure as the
    // freshest available fact. The record file itself is left for the next
    // contender's prune; a facts read must not grow a write path.
    if (isTerminalRetentionExpired(record, Date.now())) return null;
    return {
      attemptId: record.attemptId,
      generation: record.generation,
      sequence: record.sequence,
      targetVersion: record.targetVersion,
      phase: record.phase,
      continuation: record.continuation,
      updatedAt: record.updatedAt,
    };
  }

  async getStatus(): Promise<HostControllerStatus> {
    const installed = await readDesktopHostInstallRecord(this.layout);
    const staged = await readDesktopHostStagedRecord(this.layout);
    const runningRuntimeVersion = await readRunningRuntimeVersion(
      this.layout,
      this.reachabilityProbe,
    );
    const installedVersion = installed?.version ?? null;
    const installedRuntimeVersion = installed?.runtimeVersion ?? null;
    return {
      localAttempt: await this.readLocalAttemptFacts(),
      download: this.downloadStatus,
      mutation: this.mutationStatus,
      installedVersion,
      latestVersion: this.latestVersionCache,
      stagedVersion: staged?.version ?? null,
      installedRuntimeVersion,
      runningRuntimeVersion,
      updateReady: deriveUpdateReady(installedVersion, staged?.version ?? null),
      activation: deriveActivationState(
        installedRuntimeVersion,
        runningRuntimeVersion,
      ),
      reachable: runningRuntimeVersion !== null,
      removedByUser: await isHostRemovedByUser(),
      checkedAt: new Date().toISOString(),
    };
  }

  // ---- Mutation lane primitives -------------------------------------------
  //
  // Exclusive FIFO, wait-never-reject: `mutationTail` is a promise chain
  // that is NEVER allowed to carry a rejection forward (every job's errors
  // are caught and turned into a `MutationOutcome` before the tail
  // advances), so a submission behind a failed one is never starved. This
  // is also what makes `convergeReady` mid-mutation "drain then re-check"
  // - it's just another item submitted to the same queue.
  //
  // Coalescing (fixup A5, Tech Plan D3 "explicit coalescing keys, per-intent
  // results"): `inFlightMutations` maps a coalescing key to the still-
  // unsettled job's promise. A submission whose key already has an entry
  // JOINS that job instead of enqueueing a duplicate - the entry is removed
  // the instant the job settles (in `finally`, synchronously within that
  // job's own continuation, so there is no window for a third submission to
  // race the deletion), so a LATER, non-overlapping call with the same key
  // still runs fresh rather than replaying a stale result. Every call site
  // below derives its key from the intent's OWN distinguishing parameters
  // (e.g. `force`, `pin`) - two background `respawn()`s always coalesce; two
  // `installVersion` calls only coalesce when the pin AND force both match;
  // guarded intents additionally key on the intent kind and target host
  // (`reprovisionCoalesceKeySuffix`), so a user repair never joins a
  // background job and inherits its skipped guard.

  private readonly inFlightMutations = new Map<
    string,
    Promise<MutationOutcome<unknown> | AbandonedByGuard>
  >();

  // Apply and activation both run asynchronous eligibility/download-lane
  // preflight before they enter `enqueueMutation`. Coalesce that whole
  // intent too, so identical callers cannot duplicate registry probes or
  // automatic download submissions and only join at the mutation body.
  private readonly inFlightIntentPreflights = new Map<
    string,
    Promise<MutationOutcome<unknown>>
  >();

  private coalesceIntent<T>(
    coalesceKey: string,
    fn: () => Promise<MutationOutcome<T>>,
  ): Promise<MutationOutcome<T>> {
    const existing = this.inFlightIntentPreflights.get(coalesceKey);
    if (existing !== undefined) {
      return existing as Promise<MutationOutcome<T>>;
    }
    const job = fn().finally(() => {
      this.inFlightIntentPreflights.delete(coalesceKey);
    });
    this.inFlightIntentPreflights.set(
      coalesceKey,
      job as Promise<MutationOutcome<unknown>>,
    );
    return job;
  }

  // Generic over the RESULT union, not the ok-value: an intent-taking
  // mutation resolves `GuardedMutationOutcome` (its lane head can abandon),
  // everything else plain `MutationOutcome`, and both flow through this one
  // lane. Whatever the job settles with is what EVERY coalesced waiter
  // receives - which is why a guard refusal must be an outcome arm rather
  // than per-caller state (see `AbandonedByGuard`).
  private enqueueMutation<
    R extends MutationOutcome<unknown> | AbandonedByGuard,
  >(
    kind: MutationKind,
    coalesceKey: string,
    fn: () => Promise<R>,
  ): Promise<R | { readonly kind: "failed"; readonly message: string }> {
    const existing = this.inFlightMutations.get(coalesceKey);
    if (existing !== undefined) {
      return existing as Promise<
        R | { readonly kind: "failed"; readonly message: string }
      >;
    }
    const job = this.mutationTail.then(
      async (): Promise<
        R | { readonly kind: "failed"; readonly message: string }
      > => {
        this.mutationEpoch += 1;
        this.mutationStatus = {
          kind,
          progress: null,
          startedAt: new Date().toISOString(),
        };
        this.publishMutationStatus();
        try {
          return await fn();
        } catch (err) {
          log.warn("[host-controller] mutation intent threw", { kind, err });
          return {
            kind: "failed",
            message: describeError(err),
          };
        } finally {
          this.mutationEpoch += 1;
          this.mutationStatus = null;
          this.publishMutationStatus();
          this.inFlightMutations.delete(coalesceKey);
          if (this.stageLatestPending) {
            this.stageLatestPending = false;
            void this.stageLatest();
          }
        }
      },
    );
    this.inFlightMutations.set(coalesceKey, job);
    this.mutationTail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private setMutationProgress(progress: MutationProgress): void {
    if (this.mutationStatus === null) return;
    // Mi-1: carry the last concrete percent/bytes/totalBytes forward so a bare
    // heartbeat (an event that omits them) holds the bar instead of blanking
    // it; message still tracks the incoming event so the retry text is
    // visible. A later event with real numbers overrides.
    //
    // `stage` is carried forward too, but only for a registry liveness tick.
    // Those are emitted from INSIDE whatever stage is already running (the
    // manifest fetch, the archive transfer, the signature fetch) rather than
    // being stages in their own right, so letting one overwrite `stage` made
    // the renderer's heading flip away from "Downloading Traycer Host…" and
    // back on every retry. The progress-aware retry budget turned that from a
    // rare blip into a constant flicker on exactly the throttled links it
    // exists for. A genuine stage transition (resolve/download/extract/swap/
    // …) still lands.
    // SCOPED TO ONE STAGE (completing Mi-1, not reversing it). The paragraph
    // above states a WITHIN-stage purpose - "a bare heartbeat holds the bar" -
    // and the `stage` guard shows transitions were already being reasoned about.
    // The numbers were simply not given the same treatment, so they leaked
    // across a real stage change, and on the SHIPPED download path that meant:
    //
    //   download climbs to percent 100, bytes == totalBytes
    //   extract announces with all three null
    //   stage transitions correctly, and every number is inherited
    //
    // ⇒ a FULL progress bar and "800 MB of 800 MB" under "Setting up Traycer
    // Host…" for the entire multi-minute extract. A full bar reads as finished,
    // not as working - the worst of the three, and it was on every registry
    // install. The bundled path had the same shape one field down: `verify`
    // emits `totalBytes` with no `bytes`, so extract inherited a frozen total.
    //
    // Blanking at a genuine transition is the fix, not a regression: the new
    // stage has no measured position yet, and an honest empty beats an inherited
    // lie. `percent`/`bytes`/`totalBytes` describe THIS stage's work.
    //
    // NO CLAUSE FOR A NULL INCOMING STAGE, deliberately, and this was checked
    // rather than assumed. A first draft treated one as "omitted" so it would
    // not be mistaken for a transition - but it cannot happen: this method has
    // exactly ONE caller (`progressFromNdjson`, below the stream reader) and the
    // NDJSON progress event types `stage` as a non-null `string`. So the clause
    // was dead code and the arm for it was unwritable through any real path;
    // both are gone rather than left reading as covered.
    //
    // This file used to hold a `noopProgress()` returning an all-null progress,
    // the one thing here that could have produced a null stage. It had no call
    // site and is now deleted, so the argument above no longer has an exception
    // to carve out. Re-introducing any all-null producer puts the clause back on
    // the table - it is the type, not this comment, that would stop being true.
    const prior = this.mutationStatus.progress;
    const isLiveness = isRegistryLivenessStage(progress.stage);
    const withinStage =
      prior !== null && (isLiveness || progress.stage === prior.stage);
    const merged: MutationProgress = !withinStage
      ? progress
      : {
          stage: isLiveness ? prior.stage : progress.stage,
          percent: progress.percent ?? prior.percent,
          bytes: progress.bytes ?? prior.bytes,
          totalBytes: progress.totalBytes ?? prior.totalBytes,
          message: progress.message,
          // In the carry-forward set for the same reason as the rest: a bare
          // event inside a stage should HOLD the count, not blank it. It resets
          // across a genuine transition with everything else, which is correct -
          // a new stage's work has not started being counted.
          workUnits: progress.workUnits ?? prior.workUnits,
        };
    this.mutationStatus = { ...this.mutationStatus, progress: merged };
    this.publishMutationStatus();
    for (const listener of this.progressListeners) {
      try {
        listener(merged);
      } catch (err) {
        log.warn("[host-controller] mutation progress listener threw", {
          err: describeError(err),
        });
      }
    }
  }

  private progressListeners = new Set<(progress: MutationProgress) => void>();
  private mutationStatusListeners = new Set<
    (status: MutationLaneStatus | null) => void
  >();

  private publishMutationStatus(): void {
    for (const listener of this.mutationStatusListeners) {
      try {
        listener(this.mutationStatus);
      } catch (err) {
        log.warn("[host-controller] mutation status listener threw", {
          err: describeError(err),
        });
      }
    }
  }

  onMutationProgress(
    listener: (progress: MutationProgress) => void,
  ): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  onMutationStatus(
    listener: (status: MutationLaneStatus | null) => void,
  ): () => void {
    this.mutationStatusListeners.add(listener);
    return () => {
      this.mutationStatusListeners.delete(listener);
    };
  }

  // ---- Shared CLI invocation helpers --------------------------------------

  private async streamBundled<T>(args: readonly string[]): Promise<T> {
    // Progress ownership is captured at spawn. Not every caller is inside
    // the mutation lane: `applyPendingLoginItemRevisionIfIdle` (driven by
    // the pending-revision monitor, deliberately not enqueued) reaches the
    // `host service install --takeover` call, and a mutation that starts
    // while that child is still emitting must not inherit its progress -
    // the renderer would show a foreign operation's stage/message under the
    // active mutation's heading. The epoch also stops a lane call's late
    // events once its own mutation has ended.
    const spawnEpoch = this.mutationEpoch;
    const spawnedInLane = this.mutationStatus !== null;
    const result = await streamBundledTraycerCliJson<T>({
      args,
      env: null,
      idleTimeoutMs: CLI_STREAM_IDLE_TIMEOUT_MS,
      // Every mutation-lane call goes through here - none of them are
      // cancellable (only the download lane's `runDownloadLane`, below, has
      // an `AbortController`).
      signal: null,
      onEvent: (event) => {
        if (
          event.type === "progress" &&
          spawnedInLane &&
          this.mutationEpoch === spawnEpoch
        ) {
          this.setMutationProgress(progressFromNdjson(event));
        }
      },
    });
    return result.data;
  }

  private async runBundled<T>(args: readonly string[]): Promise<T> {
    return runBundledTraycerCliJson<T>(args);
  }

  // ---- Lock-contention terminal contract ----------------------------------
  //
  // Both `withCliLock` (CLI-side, thrown as `E_CLI_LOCK_BUSY` after its own
  // internal 30s poll) and `withDesktopCliLock` (desktop-side, resolving
  // `busy` after its own `DESKTOP_LOCK_WAIT_MS` poll) already perform the
  // Tech Plan's "bounded retry" internally - the poll loop inside a single
  // acquisition IS the bound. The controller does not re-wrap that in a
  // second retry loop; it just classifies the terminal signal once.

  private lockBusyOutcome<T>(): MutationOutcome<T> {
    // A held lock means another actor is mid-lifecycle-work; NOTHING ran, so
    // nothing was learned about the host. `deferred` for every mutation,
    // convergeReady included: the old convergeReady-only `failed` mapping
    // served a retired renderer gate that wanted a Retry surface, and it
    // taught the selection authority's launch ensure to arm a 30s dead-lease
    // cooldown - the "No host is available" modal over a healthy machine -
    // whenever it lost the lock to the desktop's own launch reconcile. Every
    // surviving consumer is kind-agnostic (Settings/doctor throw the message
    // whatever the kind; launch converge logs it), and the authority port
    // maps `deferred` to request pacing instead of lease death.
    return { kind: "deferred", message: LOCK_BUSY_MESSAGE };
  }

  /**
   * Preserve contender evidence at the desktop boundary. Only an actual
   * attempt/CLI holder is ordinary bounded contention; durable-record faults
   * and a lost capability are actionable, and a live attempt is a distinct
   * refusal rather than an anonymous desktop-lock wait.
   */
  private desktopContenderRefusal<T>(
    outcome: Exclude<
      DesktopUpdateContenderOutcome<unknown>,
      { kind: "acquired" }
    >,
  ): MutationOutcome<T> {
    switch (outcome.kind) {
      case "busy":
        return this.lockBusyOutcome();
      case "nonterminal-attempt":
        return {
          kind: "deferred",
          message: `A host update attempt (${outcome.record.attemptId}, ${outcome.record.phase}) is active; this ${outcome.disposition} maintenance request was not run.`,
        };
      case "record-fail-closed":
        return {
          kind: "failed",
          message: `Host update state (${outcome.record.kind}) cannot be verified. Run host doctor before retrying.`,
        };
      case "capability-not-live":
        return {
          kind: "failed",
          message: `Host update coordination was lost (${outcome.verdict}); retry the operation.`,
        };
    }
  }

  private hostBusyOutcome<T>(
    continuation: BusyContinuation,
  ): MutationOutcome<T> {
    return {
      kind: "busy",
      continuation,
      message:
        continuation === "retry-with-force"
          ? "The host has work in progress; refusing to restart it and lose that work."
          : "The update was installed, but the host has work in progress; restart it to finish.",
    };
  }

  /**
   * A contender refusal is durable update evidence, not an idle-check result:
   * --force cannot make this command legal. Keep it distinct from the
   * workload-busy branch so every CLI-backed path gives attach/yield guidance
   * instead of advertising a retry that will deterministically be refused.
   */
  private activeUpdateAttemptOutcome<T>(message: string): MutationOutcome<T> {
    return {
      kind: "deferred",
      message: `${message} Attach to or wait for the active host update attempt before retrying.`,
    };
  }

  // ---- Platform helpers ----------------------------------------------------

  private async isPackagedMacOwned(): Promise<boolean> {
    return hostManagesHostLoginItem();
  }

  // Dev environment needs the staged wrapper / self-invocation flag so
  // service (re)register resolves without a per-run dev manifest (Ticket
  // f0ae4530) - `make dev-desktop` stages a CLI wrapper the packaged CLI
  // can't self-resolve otherwise. Production returns `[]`; this never
  // widens prod's `host service install` argv.
  private devServiceInstallExtras(): readonly string[] {
    return this.environment === "dev" ? ["--allow-self-invocation"] : [];
  }

  /**
   * Consulted by the pending-login-item-revision monitor to stop ticking
   * once a refresh cycle has run and terminally failed to land `enabled`,
   * or the login item pre-flighted as `requires-approval` - see
   * `applyPendingLoginItemRevisionIfIdle`'s doc comment for why retrying
   * either case is pointless churn rather than eventual progress.
   */
  isPendingRevisionRefreshQuarantined(): boolean {
    return this.pendingRevisionRefreshQuarantined;
  }

  // ---- stamp-runtime CAS backfill -----------------------------------------
  //
  // Stamping immediacy (Tech Plan, "Unknown runtime identity"): any
  // controller-driven mutation that itself starts/cycles the service
  // stamps immediately after ITS OWN readiness observation. `prePid` is the
  // pid observed running before this cycle (or null) so `waitForHostReady`
  // skips a stale snapshot from the process being replaced.

  private async confirmActivationReadiness(
    prePid: number | null,
    expectedRuntimeVersion: string | null,
  ): Promise<Extract<HostReadinessResult, { readonly ready: true }>> {
    const readiness = await waitForHostReady(
      HOST_READY_TIMEOUT_MS,
      this.layout.pidMetadataFile,
      HOST_READY_POLL_MS,
      prePid,
    );
    if (!readiness.ready) {
      throw new HostReadinessError(
        `Traycer Host did not become reachable after activation (${readiness.reason}) - run \`traycer host doctor\` to recover.`,
      );
    }
    if (
      expectedRuntimeVersion !== null &&
      readiness.version !== expectedRuntimeVersion
    ) {
      throw new HostReadinessError(
        `Traycer Host published runtime ${readiness.version} after activation, but the committed installation expects ${expectedRuntimeVersion}. Run \`traycer host doctor\` to recover.`,
      );
    }
    return readiness;
  }

  private async stampIfNullRuntime(
    expectedInstallGeneration: string | null,
    readiness: Extract<HostReadinessResult, { readonly ready: true }>,
  ): Promise<void> {
    if (expectedInstallGeneration === null) return;
    // No try/catch here on purpose: a typed contender refusal propagates
    // unchanged so the caller's central mutation classifier keeps the
    // attach/yield guidance. Wrapping it in `Error` used to collapse an
    // active update into a generic activation failure and advertise the
    // wrong recovery.
    const outcome = parseStampRuntimeResult(
      await this.runBundled<unknown>([
        "host",
        "stamp-runtime",
        "--expected-install-generation",
        expectedInstallGeneration,
        "--observed-pid",
        String(readiness.pid),
        "--observed-started-at",
        readiness.startedAt,
        "--observed-runtime-version",
        readiness.version,
      ]),
    );
    if (
      outcome.outcome === "stamped" ||
      (outcome.outcome === "superseded" &&
        outcome.reason === "runtime-already-stamped")
    ) {
      log.info("[host-controller] stamp-runtime completed", {
        outcome: outcome.outcome,
        reason: outcome.reason,
      });
      return;
    }
    if (outcome.outcome === "superseded") {
      const status = await this.getStatus();
      throw new Error(
        `The host installation changed while activation was being confirmed (current activation: ${status.activation}). Retry to converge the current installation.`,
      );
    }
    throw new Error(
      "Traycer Host activation could not be confirmed - run `traycer host doctor` to recover.",
    );
  }

  // Keep the post-cycle invariant in one place. A service command returning
  // successfully only means the manager accepted the request; it does not
  // prove the host bound its endpoint. Every branch that starts or cycles a
  // service must complete this sequence before reporting success.
  private async completeServiceStart(
    prePid: number | null,
    expectedInstallGeneration: string | null,
    expectedRuntimeVersion: string | null,
  ): Promise<void> {
    const readiness = await this.confirmActivationReadiness(
      prePid,
      expectedRuntimeVersion,
    );
    await this.stampIfNullRuntime(expectedInstallGeneration, readiness);
    if (!(await this.publishReachableHostSnapshot())) {
      throw new HostReadinessError(
        "Traycer Host became unavailable while activation was being published - run `traycer host doctor` to recover.",
      );
    }
  }

  // The three `HostLoginItemStatus` values that mean SMAppService has
  // definitively failed to register the LaunchAgent (as opposed to
  // `requires-approval`, which means it IS registered and only needs the
  // user's own toggle) - the CLI's raw-LaunchAgent takeover can recover from
  // exactly these. Single source of truth for the three call sites below so
  // a future `HostLoginItemStatus` member can't drift between them.
  private isCliTakeoverRecoverableStatus(
    status: RegisterHostLoginItemResult,
  ): status is "not-registered" | "not-found" | "not-supported" {
    return (
      status === "not-registered" ||
      status === "not-found" ||
      status === "not-supported"
    );
  }

  // Last-rung recovery for a macOS register cycle whose SMAppService calls
  // failed (`not-found` / `not-registered` / `not-supported`) AFTER the
  // cycle's own bootout already tore down the loaded agent. Field RCA
  // (2026-07-28): SMAppService can answer `not-found` for a byte-correct
  // in-bundle plist for the remainder of the app process's life (the BTM
  // record's identity keyed to a previous build), so re-running the same
  // cycle - which is all the gate card's Retry does - can never recover,
  // and the machine is stranded with NOTHING registered and no way out.
  //
  // The CLI's raw LaunchAgent (`host service install --takeover`) does not
  // go through SMAppService/BTM at all: takeover cooperatively stops a
  // still-loaded agent first (aborting on live busy work, proceeding when
  // it is unreachable), is a no-op when the agent is already gone (this
  // path's common case - the failed cycle booted it out), and the desktop
  // re-retires the CLI registration on its next healthy SMAppService
  // cycle - so the fallback is temporary by construction.
  //
  // Must be called OUTSIDE `withDesktopCliLock` sections: the spawned CLI
  // re-acquires that same lock (lock rule 3: CLI-locked and desktop-locked
  // sections are sequenced, not nested).
  private async recoverRegistrationViaCliTakeover(args: {
    readonly failedStatus: HostLoginItemStatus;
    readonly prePid: number | null;
    readonly expectedRuntimeVersion: string | null;
    /**
     * Adoption proof for this child, or empty.
     *
     * Empty on the LEGACY paths, and that is correct there: they call this
     * after `withDesktopUpdateContender` has already released, so the child
     * contends for the attempt lock normally and wins it.
     *
     * Non-empty on the F3 continuation, which is still INSIDE its executor
     * segment - there the child would contend against its own parent and
     * self-deadlock, which is the whole reason the adoption producer exists.
     */
    readonly adoptionArgs: readonly string[];
  }): Promise<
    | { readonly recovered: true; readonly version: string | null }
    | {
        readonly recovered: false;
        // Never collapse an update-attempt refusal into "host busy" here:
        // the caller must preserve the table's attach/yield guidance, while
        // only a real workload busy outcome offers force/retry semantics.
        readonly outcome: MutationOutcome<never>;
      }
  > {
    // SMAppService is unusable for the rest of this session - quarantine the
    // pending-revision refresh so it cannot boot the fallback host out for a
    // plist revision it has just proven it cannot land. The on-disk marker
    // deliberately survives for the next launch's fresh session.
    this.pendingRevisionRefreshQuarantined = true;
    log.warn(
      "[host-controller] SMAppService registration failed - falling back to the CLI-owned LaunchAgent",
      { status: args.failedStatus },
    );
    let raw: unknown;
    try {
      // Streaming, not the flat-45s JSON wrapper: `host service install` now
      // runs the post-registration credential provisioning probe (up to 30s
      // waiting for the host), which stacked on the CLI's 30s lock wait can
      // exceed any flat bound - and a SIGKILL there reports a registration
      // that already succeeded as failed. The idle timeout is re-armed by the
      // command's own progress NDJSON (`register`, `host-credential`).
      raw = await this.streamBundled<unknown>([
        "host",
        "service",
        "install",
        "--takeover",
        ...args.adoptionArgs,
        ...this.devServiceInstallExtras(),
      ]);
    } catch (err) {
      const outcome = this.classifyMutationSubprocessError<never>(
        err,
        "retry-with-force",
      );
      // The SMAppService cycle may already have cleared the old registration
      // before the fallback CLI call refused. Preserve the previous callers'
      // snapshot-healing behavior while returning the central classifier's
      // distinct active-attempt / lock-busy / workload-busy outcome.
      await this.reloadAfterServiceCycleFailure();
      return {
        recovered: false,
        outcome: this.withTakeoverDiagnostics(outcome, args.failedStatus),
      };
    }
    const result = parseServiceStartResult(raw);
    try {
      await this.completeServiceStart(
        args.prePid,
        result.runtimeWasNull ? result.installGeneration : null,
        result.runtimeVersion ?? args.expectedRuntimeVersion,
      );
    } catch (err) {
      await this.reloadAfterServiceCycleFailure();
      return {
        recovered: false,
        outcome: {
          kind: "failed",
          message: `Failed to register the host login item (status=${args.failedStatus}); the fallback service was registered but the host did not come up: ${describeError(err)}`,
        },
      };
    }
    const version = await readRunningRuntimeVersion(
      this.layout,
      this.reachabilityProbe,
    );
    log.info(
      "[host-controller] CLI-owned LaunchAgent fallback recovered the host",
      { status: args.failedStatus, version },
    );
    return { recovered: true, version };
  }

  /**
   * Append the caller-only evidence the central classifier is contractually
   * forbidden to carry.
   *
   * The division of labour (T2/T3 author's ruling): the classifier owns what is
   * derivable from the thrown subprocess error and attempt semantics — original
   * message, code, stderr, and the busy / authority-loss / attempt-active
   * category. It must NOT own or accept free-form caller context. The governing
   * invariant is that *classification may normalize the failure category, but it
   * must never replace caller-only discriminating evidence; every caller with
   * actionable local state must append it at the presentation boundary.*
   *
   * Here that state is the SMAppService status this cycle actually observed and
   * the manual escape hatch. Neither is derivable from the CLI error — the CLI
   * never saw the SMAppService failure — and this is the card a locked-out user
   * reads: the machine has just been left with nothing registered, and
   * `status=not-found` plus the two recovery commands are what make the message
   * actionable rather than merely true.
   *
   * The classifier's `kind` and `continuation` are preserved exactly. A
   * workload-busy refusal stays `busy` with its retry semantics; enriching a
   * message must not silently re-categorize an outcome.
   */
  private withTakeoverDiagnostics<T>(
    outcome: MutationOutcome<T>,
    failedStatus: HostLoginItemStatus,
  ): MutationOutcome<T> {
    if (outcome.kind === "ok") return outcome;
    return {
      ...outcome,
      message:
        `Failed to register the host login item (status=${failedStatus}), ` +
        `and the fallback service registration failed: ${outcome.message} ` +
        `Run 'traycer host service uninstall' and relaunch Traycer, or run ` +
        `'traycer host doctor' to recover.`,
    };
  }

  // Success paths which start, cycle, or otherwise claim a live host publish
  // through this one gate. A service manager acknowledgement or a readiness
  // handshake is not sufficient by itself: the renderer-facing snapshot must
  // still derive as reachable at the moment we report a live outcome.
  private async publishReachableHostSnapshot(): Promise<boolean> {
    this.hostLifecycle.ensureWatcherInstalled();
    return (await this.hostLifecycle.reloadSnapshotFromDisk()) !== null;
  }

  private async reloadAfterServiceCycleFailure(): Promise<void> {
    try {
      await this.hostLifecycle.reloadSnapshotFromDisk();
    } catch (err) {
      // Preserve the command/readiness failure as the user-visible error.
      // A best-effort reload is only for publication of whatever state did
      // land before that primary failure.
      log.warn(
        "[host-controller] failed to reload host snapshot after service cycle failure",
        {
          err: describeError(err),
        },
      );
    }
  }

  private async failedAfterServiceCycle<T>(
    err: unknown,
  ): Promise<MutationOutcome<T>> {
    await this.reloadAfterServiceCycleFailure();
    // Completion helpers (notably stamp-runtime) run after a service cycle
    // and can race a newly admitted attempt. They all terminate here, so
    // classify the original typed CLI error before reducing it to a message.
    // This preserves attach/yield guidance for E_HOST_UPDATE_ATTEMPT_ACTIVE
    // and never offers Force for that coordination refusal.
    return this.classifyMutationSubprocessError(err, "retry-with-force");
  }

  private async installedNotConverged<T>(
    message: string,
  ): Promise<MutationOutcome<T>> {
    await this.reloadAfterServiceCycleFailure();
    return { kind: "installed-not-converged", message };
  }

  // Deferred sibling of `failedAfterServiceCycle`, for the takeover's
  // host-busy denial: the same snapshot healing applies (the cycle may
  // have cleared the renderer-facing snapshot, and a busy denial proves
  // the host is alive and publishing pid.json), but the outcome resolves
  // `deferred` so restart surfaces present "not restarted, retry later"
  // as information rather than a reportable failure.
  private async deferredAfterServiceCycle<T>(
    message: string,
  ): Promise<MutationOutcome<T>> {
    await this.reloadAfterServiceCycleFailure();
    return { kind: "deferred", message };
  }

  // ---- Shared locked macOS SMAppService activation cycle ------------------
  //
  // Used by BOTH `activateInstalled` directly and `applyStaged`'s packaged-
  // macOS branch (after its own non-disruptive bytes-only apply already
  // committed the record) - the choreography past that point is identical:
  // re-read state under the desktop-held lock, probe busy, cycle
  // SMAppService, wait for readiness, stamp if the record was null.

  // Bounded self-repair around the activation cycle: a readiness timeout
  // after a COMPLETED register cycle retries the full cycle exactly once
  // before surfacing the gate card. The register cycle is itself the
  // repair (bootout + re-register), so the automatic second attempt is
  // precisely what the card's Retry button would ask the user to click -
  // the machine must not outsource its own retry. Bounded at one: an
  // unbounded loop would churn disruptive SMAppService cycles forever
  // while the user never learns anything is wrong. `requires-approval`
  // never auto-retries (only the user can act), and every other failure
  // class surfaces immediately - the retry covers exactly "the cycle
  // completed, the host did not come up in time".
  /**
   * The packaged-macOS activation actuator, as a CAPABILITY-CONSUMING step.
   *
   * Extracted from `runLockedMacActivationCycleOnce`'s contender callback so
   * that a caller which ALREADY holds the outer update-attempt lock can run
   * the identical actuator without acquiring it a second time.
   *
   * That second acquisition was a real self-deadlock, not a theoretical one:
   * `withDesktopUpdateContender` acquires the outer lock around its whole
   * callback, so an executor segment that already held it (F3's Force-restart
   * continuation) contended against ITSELF, resolved `busy`/`source:"attempt"`,
   * and terminalized the record `failed`/`activation-not-performed` with
   * SMAppService registration never attempted. It read as ordinary lock
   * contention, which is what made it survive review.
   *
   * This is the same "child deadlocks against its own parent" class that
   * adoption solves for CLI subprocess children. Adoption is the wrong tool
   * here - there is no second process and no proof to carry - so the fix is
   * simply to stop re-entering the contender and consume the capability the
   * segment already holds.
   */
  private async runMacActivationStepWithCapability(
    capability: UpdateMutationCapability,
    force: boolean,
    postCommitContinuation: BusyContinuation,
  ): Promise<LockedMacActivationStep> {
    // Re-read install/pid state after acquisition (lock rule 3) - a
    // superseding mutation may have landed while we waited.
    const record = await readDesktopHostInstallRecord(this.layout);
    if (record === null) {
      return {
        phase: "terminal",
        outcome: { kind: "failed", message: "No host installed." },
      };
    }
    if (!force) {
      const verdict = await probeHostBusyVerdict(this.layout);
      if (verdict === "busy") {
        return {
          phase: "terminal",
          outcome: this.hostBusyOutcome<{ readonly activated: boolean }>(
            postCommitContinuation,
          ),
        };
      }
    }
    const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
    // Mo-A (finding): a live host + `requires-approval` makes this cycle
    // both futile and destructive - `registerHostLoginItem` leads with an
    // unconditional bootout that kills the healthy host, then cannot
    // re-enable the agent (only the user can approve it in System
    // Settings). Fail fast BEFORE the bootout and leave the running host
    // untouched. Mirrors the pending-revision preflight; scoped to
    // `prePid !== null` so a cycle with nothing running still proceeds
    // (its bootout is a harmless no-op and the post-register status
    // handling below reports the approval requirement).
    if (prePid !== null && readHostLoginItemStatus() === "requires-approval") {
      return {
        phase: "terminal",
        outcome: { kind: "failed", message: approvalRequiredMessage() },
      };
    }
    const expectedGeneration =
      record.runtimeVersion === null
        ? attestedInstallGenerationFromDisk(record)
        : null;
    const registerResult: RegisterHostLoginItemResult =
      await registerHostLoginItemWithAttempt(
        capability,
        this.layout.rootDir,
        async () => true,
      );
    if (registerResult === "removed-by-user") {
      return {
        phase: "terminal",
        outcome: {
          kind: "failed",
          message: HOST_REMOVED_BY_USER_MESSAGE,
        },
      };
    }
    if (registerResult === "deferred-busy") {
      return {
        phase: "terminal",
        outcome: this.hostBusyOutcome<{ readonly activated: boolean }>(
          postCommitContinuation,
        ),
      };
    }
    if (this.isCliTakeoverRecoverableStatus(registerResult)) {
      // Not terminal: this cycle's own bootout already tore the loaded
      // agent down, so failing here would strand the machine with no
      // registration at all and a Retry that re-runs the same doomed
      // SMAppService call in the same poisoned session. Recovery spawns
      // the CLI, which re-acquires the lock this closure holds (lock
      // rule 3), so hand the failure to the post-lock fallback.
      return {
        phase: "register-failed",
        status: registerResult,
        prePid,
        expectedRuntimeVersion: record.runtimeVersion,
      };
    }
    // Fixup A7: the desktop lock is released as soon as this closure
    // returns - registration is the only disruptive SMAppService step
    // this cycle needs to hold it across. `stampIfNullRuntime` (below,
    // post-lock) spawns `host stamp-runtime`, which reacquires this
    // SAME lock (lock rule 3: "CLI-locked and desktop-locked sections
    // are sequenced, not nested"). Nesting it here deadlocked the CLI
    // subprocess against its own caller until the desktop-side 10s
    // timeout fired and swallowed the error, silently leaving the
    // record unstamped while activation reported success.
    return {
      phase: "registered",
      registerResult,
      prePid,
      expectedGeneration,
      expectedRuntimeVersion: record.runtimeVersion,
    };
  }

  private async runLockedMacActivationCycle(
    force: boolean,
    postCommitContinuation: BusyContinuation,
    isConvergeReady: boolean,
  ): Promise<MutationOutcome<{ readonly activated: boolean }>> {
    const first = await this.runLockedMacActivationCycleOnce(
      force,
      postCommitContinuation,
      isConvergeReady,
    );
    if (first.kind !== "retryable-readiness-timeout") return first;
    // Re-probe before paying for a second DISRUPTIVE cycle.
    //
    // `HOST_READY_TIMEOUT_MS` is a deadline, not proof of failure: a host that
    // bound its endpoint a moment after it expired is up and serving. The
    // retry leads with `registerHostLoginItem`'s bootout, so retrying
    // unconditionally tears down the very recovery this code was waiting for,
    // and then holds the caller's mutation lane for another full timeout
    // (~120s in total) before any outcome reaches the user. The `force: false`
    // busy probe inside the cycle does not cover this: "not busy" is not
    // "not reachable".
    //
    // But "a host is reachable" is NOT the question. This cycle booted a host
    // out; one that survived its own eviction is also reachable, and accepting
    // it would report an activation that never happened - a strictly worse
    // failure than the extra cycle, because it is silent. So the late host
    // must be a DIFFERENT process from the one torn down, and must be running
    // what the cycle set out to activate. Both, or retry.
    if (await this.lateActivationSucceeded(first)) {
      return { kind: "ok", value: { activated: true } };
    }
    log.warn(
      "[host-controller] readiness timed out after a completed register cycle - auto-retrying the cycle once before surfacing the failure",
    );
    const second = await this.runLockedMacActivationCycleOnce(
      force,
      postCommitContinuation,
      isConvergeReady,
    );
    if (second.kind !== "retryable-readiness-timeout") return second;
    return this.failedAfterServiceCycle(second.message);
  }

  /**
   * Did the host come up on its own between the readiness deadline expiring
   * and now? Answered conservatively: `false` unless every condition holds,
   * because a wrong `true` publishes a live-host outcome for a host that is
   * not there.
   */
  private async lateActivationSucceeded(timeout: {
    readonly prePid: number | null;
    readonly expectedRuntimeVersion: string | null;
  }): Promise<boolean> {
    const running = await readReachableHostIdentity(
      this.layout,
      this.reachabilityProbe,
    );
    if (running === null) return false;
    // The host we just booted out, still serving. Not evidence of anything
    // except that the eviction has not finished.
    if (timeout.prePid !== null && running.pid === timeout.prePid) return false;
    // Same equality check the in-cycle readiness path applies. A late host
    // running the wrong runtime is an activation failure, not a slow success.
    if (
      timeout.expectedRuntimeVersion !== null &&
      running.version !== timeout.expectedRuntimeVersion
    ) {
      return false;
    }
    // Publication gates the success claim on every other live-host path; it
    // gates this one too. If the snapshot will not derive as reachable we have
    // not confirmed a live host, so fall through to the retry.
    if (!(await this.publishReachableHostSnapshot())) return false;
    log.info(
      "[host-controller] host became reachable after the readiness deadline - accepting the completed cycle instead of cycling it again",
      { pid: running.pid, version: running.version },
    );
    return true;
  }

  private async runLockedMacActivationCycleOnce(
    force: boolean,
    postCommitContinuation: BusyContinuation,
    // Fixup B3: lock-contention terminal contract - the desktop-held-lock
    // busy outcome from THIS activation cycle must classify the same way
    // the caller's own intent would (gate failure + Retry for `convergeReady`,
    // "deferred" for everything else), not a hardcoded `false`. Threaded
    // explicitly (not re-derived) since this cycle is shared by
    // `convergeReady`, `applyStaged`, `activateInstalled`, `installVersion`,
    // `respawn`, `recoverIfDown`, and `freePortAndRestart`.
    isConvergeReady: boolean,
  ): Promise<MacActivationCycleAttempt> {
    const outcome = await withDesktopUpdateContender(
      {
        hostHomeDir: this.layout.rootDir,
        lockPath: this.lockPath,
        reason: "host-controller-activate",
        waitMs: this.desktopLockWaitMs,
        pollIntervalMs: this.desktopLockPollIntervalMs,
        admission: "desktop-activation-maintenance",
      },
      async (capability): Promise<LockedMacActivationStep> =>
        this.runMacActivationStepWithCapability(
          capability,
          force,
          postCommitContinuation,
        ),
    );
    if (outcome.kind !== "acquired") {
      return this.desktopContenderRefusal(outcome);
    }
    const step = outcome.result;
    if (step.phase === "terminal") {
      return step.outcome;
    }
    if (step.phase === "register-failed") {
      const recovery = await this.recoverRegistrationViaCliTakeover({
        adoptionArgs: [],
        failedStatus: step.status,
        prePid: step.prePid,
        expectedRuntimeVersion: step.expectedRuntimeVersion,
      });
      if (!recovery.recovered) {
        return recovery.outcome;
      }
      return { kind: "ok", value: { activated: true } };
    }
    const {
      registerResult,
      prePid,
      expectedGeneration,
      expectedRuntimeVersion,
    } = step;
    // `requires-approval` still means the plist is registered - launchd
    // will start it once the user approves it in System Settings; we still
    // wait for readiness (it may already be approved from a prior cycle)
    // but the activation-failure semantics classify a timeout as the
    // approval message rather than a generic readiness failure.
    const readiness = await waitForHostReady(
      HOST_READY_TIMEOUT_MS,
      this.layout.pidMetadataFile,
      HOST_READY_POLL_MS,
      prePid,
    );
    if (!readiness.ready) {
      // Fixup C6: re-read the login-item status HERE rather than trusting
      // the pre-wait `registerResult` - macOS can flip the agent to
      // `requires-approval` mid-wait (the user toggled it off in System
      // Settings during the poll), and that's indistinguishable from a
      // generic readiness timeout without a fresh check. Mirrors the
      // deleted `respawnHost`'s reread.
      const postWaitStatus = readHostLoginItemStatus();
      log.warn("[host-controller] host did not become ready after activation", {
        reason: readiness.reason,
        loginItemStatus: postWaitStatus,
      });
      if (postWaitStatus === "requires-approval") {
        return this.failedAfterServiceCycle(approvalRequiredMessage());
      }
      // Not a terminal failure yet: the wrapper retries the full cycle
      // once before building the gate card from this message.
      // `readiness.reason` belongs in the user string, not only the log:
      // the sibling failure paths (`:992`, `:1533`) already include it,
      // and this is the one card a locked-out user actually reads.
      return {
        kind: "retryable-readiness-timeout",
        message: `Traycer Host did not start within ${HOST_READY_TIMEOUT_MS}ms (${readiness.reason}) - run \`traycer host doctor\` to recover.`,
        prePid,
        expectedRuntimeVersion,
      };
    }
    if (
      expectedRuntimeVersion !== null &&
      readiness.version !== expectedRuntimeVersion
    ) {
      return this.failedAfterServiceCycle(
        `Traycer Host published runtime ${readiness.version} after activation, but the committed installation expects ${expectedRuntimeVersion}. Run \`traycer host doctor\` to recover.`,
      );
    }
    try {
      await this.stampIfNullRuntime(expectedGeneration, readiness);
    } catch (err) {
      return this.failedAfterServiceCycle(err);
    }
    if (!(await this.publishReachableHostSnapshot())) {
      return this.failedAfterServiceCycle(
        "Traycer Host became unavailable while activation was being published - run `traycer host doctor` to recover.",
      );
    }
    return { kind: "ok", value: { activated: true } };
  }

  // ---- Pending LaunchAgent revision refresh (packaged macOS) --------------
  //
  // A busy/indeterminate `desktop-install-cloud.js` update preserves the
  // running host instead of booting it out, so its LaunchAgent keeps the
  // launchd registration it had before the bundle swap - the freshly
  // written plist (e.g. a new descriptor limit) sits inert until something
  // re-runs the SMAppService cycle. Two callers drive this opportunistically,
  // ONLY when the host is idle, so the refresh never interrupts in-progress
  // work: `convergeReadyPackagedMac`'s already-reachable branch (a renderer-
  // triggered ensure), and `PendingLoginItemRevisionMonitor`'s poll loop (the
  // background catch-up for a host that stays up for the rest of the
  // session without another ensure). Public - not run through
  // `enqueueMutation` - because it is fully self-locking via
  // `withDesktopCliLock`, the same cross-process exclusion any other
  // controller-driven SMAppService section uses; going through the
  // mutation lane would additionally force a `host ensure` CLI round trip on
  // every poll tick just to reach this check, AND (the more serious reason)
  // `convergeReadyPackagedMac` calls this reentrantly from INSIDE an already-
  // running `enqueueMutation` job - routing through `enqueueMutation` here
  // would deadlock that caller against its own tail. Returns the converged
  // result when this path fully handled the call (refreshed, removed-by-
  // user, or a terminal refresh failure), or `null` when there was nothing
  // to do (not reachable, no marker, quarantined, or the host is busy).
  //
  // Fixup D1: the monitor's tick and the reentrant `convergeReadyPackagedMac`
  // caller used to each independently pass every pre-check and run their own
  // disruptive SMAppService bootout+reregister when they landed concurrently
  // - two genuine cycles instead of one, the exact double-bootout the
  // deleted `runEnsureHost`'s module-scoped in-flight slot existed to
  // prevent. `enqueueMutation`'s own coalescing can't be reused here for the
  // same reentrancy reason it can't provide exclusivity (above), so this
  // gate is a SEPARATE, instance-scoped in-flight slot, checked and set
  // synchronously (no `await` in between) so two calls landing in the same
  // JS turn can't both see it empty. Whichever caller arrives first owns the
  // slot for the ENTIRE call - including its own pre-checks - the other
  // joins its result outright, exactly mirroring how `runEnsureHost` gated
  // before any of its own logic ran.
  //
  // Coalescing carries ONE more obligation than the slot itself: the joiner's
  // OWNER POLICY. An outside tick that is still in its prechecks when
  // `convergeReady` joins from inside its lane job would otherwise reach the
  // reverse-admission check holding only the tick's own `outside-lane`
  // policy, see the mutation lane the JOINER occupies, and refuse - a cycle
  // declining to run because of the very caller waiting on it, after which
  // the no-op converge path reports success having applied nothing. So a
  // within-lane joiner upgrades the cycle's policy, and (for the narrow case
  // where the refusal already happened before it could) re-attempts exactly
  // once under the corrected policy.
  async applyPendingLoginItemRevisionIfIdle(
    caller: PendingRevisionCaller,
  ): Promise<MutationOutcome<ConvergeReadyOk> | null> {
    const inFlight = this.pendingRevisionCycleInFlight;
    if (inFlight !== null) {
      // An outside-lane joiner never widens what the cycle may do, so it
      // takes the in-flight answer as-is.
      if (caller === "outside-lane") return inFlight;
      this.pendingRevisionCycleCaller = "within-lane-job";
      const joined = await inFlight;
      // The upgrade lands before the check for the whole precheck window
      // (several file/probe awaits). It can only miss when the cycle had
      // already refused, and that refusal was against THIS caller's lane -
      // so it is void for this caller. Re-attempt ONCE, never a loop: the
      // retry only happens after a lane-policy refusal, and it runs under
      // `within-lane-job`, which cannot produce another one.
      if (joined !== null || !this.pendingRevisionCycleDeferredByLane) {
        return joined;
      }
      // Someone else opened a cycle in the gap; theirs subsumes this one
      // (and carries the upgraded policy set above).
      if (this.pendingRevisionCycleInFlight !== null) {
        return this.pendingRevisionCycleInFlight;
      }
      // Falls through to open a fresh cycle. The check above and the set
      // below stay in one synchronous stretch, exactly like the first-caller
      // path, so the D1 gate still cannot admit two owners in one JS turn.
    }
    this.pendingRevisionCycleCaller = caller;
    this.pendingRevisionCycleDeferredByLane = false;
    const run = this.applyPendingLoginItemRevisionIfIdleUncoalesced();
    // The D1 cache becomes visible synchronously, before any of the
    // reachability/quarantine/approval prechecks await. Quit drain must see
    // the entire in-flight intent, not only the later lock-owning cycle.
    const priorTail = this.pendingRevisionTail;
    this.pendingRevisionTail = Promise.all([
      priorTail,
      run.then(
        () => undefined,
        () => undefined,
      ),
    ]).then(() => undefined);
    this.pendingRevisionCycleInFlight = run;
    const clearInFlight = (): void => {
      if (this.pendingRevisionCycleInFlight === run) {
        this.pendingRevisionCycleInFlight = null;
        this.pendingRevisionCycleCaller = null;
      }
    };
    run.then(clearInFlight, clearInFlight);
    return run;
  }

  private async applyPendingLoginItemRevisionIfIdleUncoalesced(): Promise<MutationOutcome<ConvergeReadyOk> | null> {
    const currentVersion = await readRunningRuntimeVersion(
      this.layout,
      this.reachabilityProbe,
    );
    if (currentVersion === null) return null;
    if (this.pendingRevisionRefreshQuarantined) return null;
    if (!(await hasUnappliedPendingLoginItemRevision(this.environment)))
      return null;
    if ((await probeHostBusyVerdict(this.layout)) !== "idle") {
      log.debug(
        "[host-controller] pending LaunchAgent revision deferred - host busy",
      );
      return null;
    }
    // Pre-flight: with the login item toggled off in System Settings the
    // cycle is guaranteed futile (only the user can re-enable it) AND
    // destructive (its leading bootout kills the healthy host we just
    // probed). Skip AND quarantine for the session: retrying every
    // convergeReady call cannot help (the toggle is the user's alone) and
    // would only churn; the marker survives on disk for the next launch.
    if (readHostLoginItemStatus() === "requires-approval") {
      this.pendingRevisionRefreshQuarantined = true;
      log.warn(
        "[host-controller] pending LaunchAgent revision quarantined for this session - login item requires approval in System Settings",
      );
      return null;
    }
    // Reverse admission, owner-aware: the *IfIdle handlers refuse while this
    // cycle is committed, and this is the same rule pointed the other way -
    // an OUTSIDE caller (the monitor's poll) must not commit a disruptive
    // cycle while the mutation lane owns an intent, or an already-accepted
    // watched write gets a second unannounced lifecycle change serialized
    // behind it on the desktop lock. A WITHIN-LANE caller is that intent -
    // `convergeReady` reaches here from inside its own lane job, where the
    // lane being occupied is not a competitor but the caller itself.
    //
    // Checked in the same synchronous stretch that raises the flag (no await
    // between), mirroring the handlers' own test-and-submit rule: the lane
    // check, the commitment, and the flag are one decision.
    // Reads the cycle's EFFECTIVE policy, not a captured parameter, so a
    // within-lane joiner that upgraded it during these prechecks is honoured.
    // Written as "unless within-lane" rather than "if outside-lane" so the
    // impossible null reading defers (fails CLOSED) instead of committing a
    // disruptive cycle beside a live lane intent.
    if (
      this.pendingRevisionCycleCaller !== "within-lane-job" &&
      this.mutationStatus !== null
    ) {
      this.pendingRevisionCycleDeferredByLane = true;
      log.debug(
        "[host-controller] pending LaunchAgent revision deferred - mutation lane active",
      );
      return null;
    }
    // Committed from here: every precheck passed, and the next thing this
    // call does is take the desktop lock and run the disruptive bootout /
    // re-register. Raised BEFORE the lock wait, not inside it - a caller
    // refused admission during the wait would otherwise be accepted, queue on
    // the same lock, and land right after the cycle it was told nothing about.
    this.pendingRevisionCycleDisruptive = true;
    try {
      return await this.runPendingLoginItemRevisionCycle(currentVersion);
    } finally {
      this.pendingRevisionCycleDisruptive = false;
    }
  }

  private async runPendingLoginItemRevisionCycle(
    currentVersion: string,
  ): Promise<MutationOutcome<ConvergeReadyOk> | null> {
    const outcome = await withDesktopUpdateContender(
      {
        hostHomeDir: this.layout.rootDir,
        lockPath: this.lockPath,
        reason: "host-controller-pending-revision-refresh",
        waitMs: this.desktopLockWaitMs,
        pollIntervalMs: this.desktopLockPollIntervalMs,
        admission: "desktop-activation-maintenance",
      },
      async (capability) => {
        // Capture the pre-cycle identity AND the generation to
        // (conditionally) stamp INSIDE the lock, immediately before the
        // disruptive bootout/reregister - mirrors `runLockedMacActivationCycle`.
        // Fixup A4: reading the install record AFTER the lock releases
        // would risk observing a SUPERSEDING record that landed during the
        // cycle (a terminal bytes-only install completing while we were
        // mid-registerHostLoginItem) and CAS-stamping THAT record with this
        // cycle's now-stale identity - the superseding install would then
        // read as falsely activated and never get its own real activation
        // cycle. Capturing both together, under the lock, ties the
        // expected generation to the exact record this cycle is actually
        // reactivating.
        const prePid =
          (await readRunningHostIdentity(this.layout))?.pid ?? null;
        const record = await readDesktopHostInstallRecord(this.layout);
        // Fixup B12 (lock rule 3): a terminal `host uninstall --all` may
        // have won the lock, removed the install, and released it while
        // this call waited its turn - re-reading here (rather than trusting
        // the pre-lock probes above) catches that and skips the bootout
        // rather than reactivating an absent install.
        if (record === null) {
          return {
            status: null,
            prePid,
            expectedGeneration: null,
            expectedRuntimeVersion: null,
          };
        }
        // Fixup D1 defense-in-depth: the in-flight coalescing gate on
        // `applyPendingLoginItemRevisionIfIdle` is the primary fix for two
        // concurrent callers double-cycling SMAppService, but this closure
        // only runs once per acquisition regardless of how many callers are
        // waiting on the desktop lock - re-check the marker itself here,
        // under the lock, the same lock-rule-3 discipline B12 applies to
        // the install record above. Catches the marker resolving through
        // any OTHER path between the pre-lock check and acquisition, not
        // just the specific race the coalescing gate closes.
        if (!(await hasUnappliedPendingLoginItemRevision(this.environment))) {
          return {
            status: "no-longer-pending" as const,
            prePid,
            expectedGeneration: null,
            expectedRuntimeVersion: null,
          };
        }
        const expectedGeneration =
          record.runtimeVersion === null
            ? attestedInstallGenerationFromDisk(record)
            : null;
        // The busy probe above can go stale while this cycle waits its turn
        // on the shared registration lock (a concurrent respawn/activation
        // cycle can be mid-cycle right now) - re-check right before the
        // bootout actually runs, so a host that picked up real work while
        // queued isn't killed anyway.
        const status = await registerHostLoginItemWithAttempt(
          capability,
          this.layout.rootDir,
          async () => (await probeHostBusyVerdict(this.layout)) === "idle",
        );
        return {
          status,
          prePid,
          expectedGeneration,
          expectedRuntimeVersion: record.runtimeVersion,
        };
      },
    );
    if (outcome.kind === "busy" || outcome.kind === "nonterminal-attempt") {
      // Both are ordinary, transient contention for an OPPORTUNISTIC
      // refresh: another SMAppService section is mid-cycle, or a durable
      // update attempt is active and this refresh yielded to it. The host
      // this call already confirmed reachable needed no work — reporting
      // `deferred` here would fail an otherwise-healthy convergeReady over
      // work that was never required. The actionable refusals
      // (record-fail-closed, capability-not-live) still map below.
      log.debug(
        "[host-controller] pending LaunchAgent revision deferred - contention",
        { refusal: outcome.kind },
      );
      return null;
    }
    if (outcome.kind !== "acquired") {
      return this.desktopContenderRefusal(outcome);
    }
    const { status, prePid, expectedGeneration, expectedRuntimeVersion } =
      outcome.result;
    if (status === null) {
      log.debug(
        "[host-controller] pending LaunchAgent revision skipped - install absent after lock acquisition",
      );
      return null;
    }
    if (status === "no-longer-pending") {
      log.debug(
        "[host-controller] pending LaunchAgent revision skipped - marker resolved before this cycle acquired the lock",
      );
      return null;
    }
    if (status === "removed-by-user") {
      log.info(
        "[host-controller] pending LaunchAgent revision skipped - host removed by user mid-refresh",
      );
      return { kind: "ok", value: { running: false, version: null } };
    }
    if (status === "deferred-busy") {
      log.debug(
        "[host-controller] pending LaunchAgent revision deferred - host became busy while queued behind another registration cycle",
      );
      return null;
    }
    if (status === "requires-approval") {
      this.pendingRevisionRefreshQuarantined = true;
      return { kind: "failed", message: approvalRequiredMessage() };
    }
    if (this.isCliTakeoverRecoverableStatus(status)) {
      this.pendingRevisionRefreshQuarantined = true;
      log.warn(
        "[host-controller] pending LaunchAgent revision refresh did not enable the agent",
        { status },
      );
      // This cycle just booted out a host that was verified reachable and
      // idle moments before - a bare failure here strands the machine with
      // nothing running AND nothing registered (field RCA 2026-07-28: the
      // installer restarted the host, this refresh tore it down,
      // SMAppService answered `not-found`, and the session was locked
      // out). Restore service via the CLI-owned fallback; the pending
      // marker deliberately survives for the next launch.
      const recovery = await this.recoverRegistrationViaCliTakeover({
        adoptionArgs: [],
        failedStatus: status,
        prePid,
        expectedRuntimeVersion,
      });
      if (!recovery.recovered) {
        return recovery.outcome;
      }
      return {
        kind: "ok",
        value: { running: true, version: recovery.version ?? currentVersion },
      };
    }
    const readiness = await waitForHostReady(
      HOST_READY_TIMEOUT_MS,
      this.layout.pidMetadataFile,
      HOST_READY_POLL_MS,
      prePid,
    );
    if (!readiness.ready) {
      log.warn(
        "[host-controller] host did not become reachable after applying a pending LaunchAgent revision",
        { reason: readiness.reason },
      );
      return this.failedAfterServiceCycle(
        `The host's background service was refreshed but did not become reachable in time (${readiness.reason}). Open Doctor or run 'traycer host doctor' to recover.`,
      );
    }
    if (
      expectedRuntimeVersion !== null &&
      readiness.version !== expectedRuntimeVersion
    ) {
      return this.failedAfterServiceCycle(
        `Traycer Host published runtime ${readiness.version} after activation, but the committed installation expects ${expectedRuntimeVersion}. Run \`traycer host doctor\` to recover.`,
      );
    }
    try {
      await this.stampIfNullRuntime(expectedGeneration, readiness);
    } catch (err) {
      return this.failedAfterServiceCycle(err);
    }
    log.info("[host-controller] pending LaunchAgent revision applied", {
      version: readiness.version ?? currentVersion,
      pid: readiness.pid,
    });
    if (!(await this.publishReachableHostSnapshot())) {
      return this.failedAfterServiceCycle(
        "Traycer Host became unavailable while the pending LaunchAgent revision was being published - run `traycer host doctor` to recover.",
      );
    }
    return {
      kind: "ok",
      value: { running: true, version: readiness.version ?? currentVersion },
    };
  }

  // ---- Quit-time drain -----------------------------------------------------

  /**
   * Bounded wait for whatever mutation is CURRENTLY chained on the lane to
   * settle. Used at quit time (`update-install-quit.ts`) so the shell never
   * tears down a subprocess mid-swap - it does NOT start a new mutation, only
   * waits for one already in flight. Does not wait for mutations enqueued
   * after this call starts (those are a fresh problem for the next launch to
   * reconcile). Resolves `true` once drained, `false` on timeout - fail-open,
   * matching every other quit-path step. Fixup B15: also covers
   * `applyPendingLoginItemRevisionIfIdle`'s independently-tracked tail - its
   * SMAppService cycle is a real disruptive mutation, even though it can't
   * safely route through `enqueueMutation` itself (see that method).
   */
  async awaitMutationLaneIdle(timeoutMs: number): Promise<boolean> {
    const tail = Promise.all([this.mutationTail, this.pendingRevisionTail]);
    let timedOut = false;
    await Promise.race([
      tail,
      sleep(timeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
    return !timedOut;
  }

  // ---- convergeReady -------------------------------------------------------

  async convergeReady(
    force: boolean,
    intent: LocalHostMutationIntent,
  ): Promise<GuardedMutationOutcome<ConvergeReadyOk>> {
    return this.enqueueMutation<GuardedMutationOutcome<ConvergeReadyOk>>(
      "ensure",
      // The intent is part of the coalesce key, not decoration, and so is the
      // host it targets. A repair that coalesced onto a background converge
      // would inherit that job's policy and silently skip both its guard and
      // its sentinel clear - the same shape as the pending-revision
      // coalescing bug, where the joiner's policy was discarded in favour of
      // the occupant's. Two repairs for DIFFERENT hosts are likewise not the
      // same job: joining would hand the newcomer the occupant's guard, which
      // then refuses it for naming a different host.
      `ensure:${force}:${this.reprovisionCoalesceKeySuffix(intent)}`,
      async () => {
        const abandoned = await this.admitReprovision(intent);
        if (abandoned !== null) return abandoned;
        // Only a BACKGROUND converge obeys the sentinel. `admitReprovision`
        // has already cleared it for a user repair, so this cannot swallow
        // the click that asked for the host back.
        if (intent.kind === "background" && (await isHostRemovedByUser())) {
          return { kind: "ok", value: { running: false, version: null } };
        }
        if (await this.isPackagedMacOwned()) {
          return this.convergeReadyPackagedMac(force);
        }
        return this.convergeReadyCliOwned(force);
      },
    );
  }

  /**
   * The coalesce-key fragment for a reprovision intent. A background job
   * collapses to one bucket; a user repair is bucketed by the host it names,
   * percent-encoded so a `:` inside a host id cannot split the key and make
   * two different targets look like one.
   */
  private reprovisionCoalesceKeySuffix(
    intent: LocalHostMutationIntent,
  ): string {
    return intent.kind === "background"
      ? "background"
      : `user-repair:${encodeURIComponent(intent.targetHostId)}`;
  }

  /**
   * The head-of-lane half of a user-driven reprovision: re-ask the identity
   * question the IPC handler asked before enqueueing, then clear the removal
   * sentinel so the reprovision is not swallowed by it.
   *
   * Returns an `abandoned` outcome to ABANDON the job, or `null` to proceed.
   * A background intent is always `null` and touches nothing - the background
   * paths are byte-for-byte what they were.
   */
  private async admitReprovision(
    intent: LocalHostMutationIntent,
  ): Promise<AbandonedByGuard | null> {
    const abandoned = await this.runLaneHeadGuard(intent);
    if (abandoned !== null) return abandoned;
    if (intent.kind === "background") return null;
    // Same rule as `installVersion`: an explicit reprovision means the person
    // wants the host back on this device, so the sentinel goes. This half is
    // what makes it a REPROVISION rather than merely a guarded mutation, and
    // it is why `freePortAndRestart` calls the guard directly instead: a
    // restart must keep the removed-by-user deferral.
    if (await isHostRemovedByUser()) {
      await clearHostRemovedByUser();
    }
    return null;
  }

  /**
   * The guard half alone: re-ask the caller's identity question now that this
   * job owns the lane, and abandon if the answer changed while it waited.
   *
   * Separate from `admitReprovision` because a guarded mutation is not
   * necessarily a reprovision. `freePortAndRestart` needs exactly this and
   * none of the sentinel handling - it kills a recorded PID and frees a
   * recorded port, so running it against a host that was swapped in while it
   * queued would kill a process nobody named.
   */
  private async runLaneHeadGuard(
    intent: LocalHostMutationIntent,
  ): Promise<AbandonedByGuard | null> {
    if (intent.kind === "background") return null;
    const verdict = await intent.guard();
    return verdict.kind === "abandon"
      ? { kind: "abandoned", message: verdict.message }
      : null;
  }

  private async convergeReadyCliOwned(
    force: boolean,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
    const bundledHostFrom = await resolveWindowsBundledHostArchive();
    const args = [
      "host",
      "ensure",
      ...(force ? ["--force"] : []),
      ...(bundledHostFrom !== null ? ["--from", bundledHostFrom] : []),
    ];
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>(args);
    } catch (err) {
      await this.reloadAfterServiceCycleFailure();
      return this.classifyEnsureLikeError(err);
    }
    const result = parseEnsureResult(raw);
    // Fixup B7: a non-throwing result can still carry a post-swap start
    // failure (`installed: true, running: false`) - the old code ignored
    // `postSwapError` entirely and returned `ok`, which the IPC layer then
    // misprojects as `{action:"removed"}` (its `running: false` branch is
    // otherwise only reachable via the removed-by-user short-circuit).
    // Surface it as non-converged instead - never "update ready"/"removed".
    if (result.postSwapError !== null) {
      return this.failedAfterServiceCycle(
        `Host installed, but the background service failed to start after the swap: ${result.postSwapError}. Open Doctor or run 'traycer host doctor' to recover.`,
      );
    }
    if (result.action !== "noop") {
      const expectedInstallGeneration =
        result.runtimeVersion === null ? result.installGeneration : null;
      try {
        const readiness = await this.confirmActivationReadiness(
          prePid,
          result.runtimeVersion,
        );
        await this.stampIfNullRuntime(expectedInstallGeneration, readiness);
      } catch (err) {
        return this.failedAfterServiceCycle(err);
      }
    }
    if (!(await this.publishReachableHostSnapshot())) {
      return this.failedAfterServiceCycle(
        "Traycer Host became unavailable while ensure was being published - run `traycer host doctor` to recover.",
      );
    }
    return {
      kind: "ok",
      value: {
        running: true,
        version: result.runtimeVersion ?? result.version,
      },
    };
  }

  private async convergeReadyPackagedMac(
    force: boolean,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>(
        force
          ? ["host", "ensure", "--force", "--no-service-register"]
          : ["host", "ensure", "--no-service-register"],
      );
    } catch (err) {
      return this.classifyEnsureLikeError(err);
    }
    const result = parseEnsureResult(raw);
    // Bytes-only ensure never starts the service itself - skip the
    // activation cycle ONLY when nothing changed (`action === "noop"`), the
    // caller didn't force it, AND the host is already reachable, modulo one
    // opportunistic check: apply a pending LaunchAgent revision if the host
    // has been idle since it was last cycled (see
    // `applyPendingLoginItemRevisionIfIdle`). Fixup B6: this used to key
    // off reachability ALONE - a live OLD process (still running the
    // pre-ensure version) made "reachable" true regardless of what `action`
    // just reported, so newly installed bytes never got activated, and an
    // explicit `force: true` was silently dropped the moment any host
    // (stale or not) happened to already be up. `action`/`force` now both
    // override "already reachable"; otherwise drive the same locked
    // register cycle `activateInstalled` uses so SMAppService (re-)starts
    // it and picks up the plist revision.
    if (result.action === "noop" && !force) {
      const runningRuntimeVersion = await readRunningRuntimeVersion(
        this.layout,
        this.reachabilityProbe,
      );
      if (runningRuntimeVersion !== null) {
        const refreshed =
          await this.applyPendingLoginItemRevisionIfIdle("within-lane-job");
        if (refreshed !== null) return refreshed;
        return {
          kind: "ok",
          value: { running: true, version: runningRuntimeVersion },
        };
      }
    }
    const activation = await this.runLockedMacActivationCycle(
      force,
      "activate",
      true,
    );
    if (activation.kind !== "ok") {
      return activation as MutationOutcome<ConvergeReadyOk>;
    }
    const version = await readRunningRuntimeVersion(
      this.layout,
      this.reachabilityProbe,
    );
    if (version === null) {
      return this.failedAfterServiceCycle(
        "Traycer Host became unavailable while ensure was being published - run `traycer host doctor` to recover.",
      );
    }
    return {
      kind: "ok",
      value: { running: true, version },
    };
  }

  private classifyEnsureLikeError<T>(err: unknown): MutationOutcome<T> {
    return this.classifyMutationSubprocessError(err, "retry-with-force");
  }

  /**
   * All Desktop-owned CLI mutation routes terminate through this one table.
   * An update-attempt refusal is durable coordination evidence, never the
   * user-workload busy condition that a Force action can legitimately retry.
   */
  private classifyMutationSubprocessError<T>(
    err: unknown,
    workloadBusyContinuation: BusyContinuation,
  ): MutationOutcome<T> {
    if (err instanceof TraycerCliError) {
      if (err.code === CLI_LOCK_BUSY_CODE) return this.lockBusyOutcome<T>();
      if (err.code === HOST_UPDATE_ATTEMPT_ACTIVE_CODE) {
        return this.activeUpdateAttemptOutcome<T>(err.message);
      }
      if (err.code === HOST_BUSY_CODE) {
        // Fixup B8: a healthy host with active work is a busy-keep
        // (`host-busy`/`running: true`), never a fatal gate error, on a
        // reconnect/compat ensure. The `isConvergeReady` flag that once
        // distinguished this branch is gone entirely - lock-busy now
        // classifies `deferred` for every caller (see `lockBusyOutcome`).
        return this.hostBusyOutcome<T>(workloadBusyContinuation);
      }
      return { kind: "failed", message: err.message };
    }
    return { kind: "failed", message: describeError(err) };
  }

  // ---- stageLatest -----------------------------------------------------
  //
  // Download lane: independent of the mutation lane. Fires on every
  // successful registry refresh when comparable `latest > installed` OR a
  // stage already exists (the yank-heal reconcile arm runs even when
  // latest is equal/older/absent). Never starts a NEW download while a
  // mutation owns the host; re-kicked from `enqueueMutation`'s finally
  // once the mutation completes.

  stageLatest(): Promise<void> {
    if (this.stageLatestInFlight !== null) {
      return this.stageLatestInFlight;
    }
    const job = this.runStageLatest().finally(() => {
      if (this.stageLatestInFlight === job) {
        this.stageLatestInFlight = null;
      }
    });
    this.stageLatestInFlight = job;
    return job;
  }

  private async runStageLatest(): Promise<void> {
    if (this.mutationStatus !== null) {
      this.stageLatestPending = true;
      await this.mutationTail;
    }
    // A job may have entered the lane while this call was awaiting the old
    // tail. Wait until the actual lane is idle before deciding to start a
    // download, rather than relying on the status at submission time.
    if (this.mutationStatus !== null) {
      await this.runStageLatest();
      return;
    }
    await this.reconcileEligibleStage();
  }

  private async reconcileEligibleStage(): Promise<void> {
    if (await isHostRemovedByUser()) return;
    this.eligibleStage = null;
    let staged = await readDesktopHostStagedRecord(this.layout);
    let snapshot: AvailableSnapshotShape;
    // THE INSTALL RECORD IS READ BEFORE THE REGISTRY REQUEST, because it is an
    // input to that request: an installed canonical `X.Y.Z-rc.N` follows its
    // own line with no saved preference, and a stable-only listing would not
    // even contain the candidates that follow implies. A missing or unreadable
    // record fails closed to stable-only (see `resolveHostChannelMode`).
    const installed = await readDesktopHostInstallRecord(this.layout);
    const installedVersion = installed?.version ?? null;
    const mode = resolveHostChannelMode({
      explicitPrerelease: prereleaseUpdatesEnabled(),
      installedVersion,
    });
    // THE ORDINARY `--automatic` PATH IS CLOSED WHILE FOLLOWING A LINE.
    //
    // `host download --automatic` follows the manifest's stable `latest`
    // pointer, and for a build following its own release line that pointer is
    // another line - so falling through to it whenever this line has nothing to
    // offer is exactly the cross-line jump implicit participation forbids. The
    // only builds this mode may stage are the ones `resolveHostStageTarget`
    // returns: a later RC on the line, or the line's own stable.
    //
    // The consequence is deliberate and matches the Desktop app: an ABANDONED
    // line has no automatic exit. If `2.0.0` is never published and the work
    // ships as `2.1.0`, a `2.0.0-rc.1` host stays where it is rather than being
    // moved to a line nobody put it on. Publishing the line's stable, or a
    // reinstall, is the exit.
    const automaticStablePathOpen = mode !== "implicit-rc-line";
    try {
      snapshot = parseAvailableSnapshot(
        await this.runBundled<unknown>([
          "host",
          "available",
          "--json",
          ...(requiresPreReleaseListing({
            mode,
            stagedVersion: staged?.version ?? null,
          })
            ? ["--include-pre-releases"]
            : []),
        ]),
      );
    } catch (err) {
      log.debug("[host-controller] registry probe failed (silent)", {
        err: describeError(err),
      });
      if (staged?.stageId !== null && staged?.stageId !== undefined) {
        this.eligibleStage = {
          version: staged.version,
          fingerprint: encodeStageFingerprint(staged.stageId),
        };
      }
      return;
    }
    this.latestVersionCache = latestVersionFromSnapshot(snapshot);
    if (!snapshot.valid) {
      if (staged?.stageId !== null && staged?.stageId !== undefined) {
        this.eligibleStage = {
          version: staged.version,
          fingerprint: encodeStageFingerprint(staged.stageId),
        };
        // An unparseable manifest leaves nothing to resolve a same-line
        // candidate from, so a follower has no admissible target here and the
        // `--automatic` repair would stage whatever `latest` names. The stage
        // above stays eligible either way; only the speculative refresh is
        // skipped.
        if (this.mutationStatus === null && automaticStablePathOpen) {
          await this.runDownloadLane(null);
        } else if (this.mutationStatus !== null) {
          this.stageLatestPending = true;
        }
      }
      return;
    }
    // Resolve-then-pin: `--automatic` follows the manifest's stable `latest`
    // pointer, so it can reach neither a later RC on the installed line nor a
    // matching stable published while `latest` still lags. When this mode picks
    // a candidate, it is pinned by exact version instead. Downgrade- and
    // line-guarded inside; null means "nothing this mode may stage", which for
    // `stable-only`/`explicit-prerelease` hands over to `--automatic` and for
    // `implicit-rc-line` means no download at all.
    const downloadTarget = resolveHostStageTarget({
      mode,
      installedVersion,
      availableVersions: installableVersions(snapshot),
      stableLatest: this.latestVersionCache,
    });
    let migratedLegacyStage = false;
    if (staged?.stageId === null) {
      // Legacy archives predate the stage fingerprint used by the atomic
      // apply/purge handoff. Keep the signed bytes only long enough for the
      // normal automatic download path to replace them with a freshly
      // verified, fingerprinted stage; otherwise this valid update remains
      // permanently deferred because Desktop can neither apply nor purge it.
      //
      // A FOLLOWER REPAIRS FROM ITS OWN LINE OR NOT AT ALL: `--automatic` here
      // would repair the stage by fetching another line's stable, so the pinned
      // same-line candidate is used instead. With no such candidate the legacy
      // bytes are left alone - already unusable, and no worse for waiting -
      // rather than replaced by a build this mode may not select.
      //
      // The lane overloads `null` to mean "run `--automatic`", so the two cases
      // are spelled out rather than left to that overload: `repairWithAutomatic`
      // says WHICH lane, `repairPin` is the exact version when the automatic
      // lane is closed, and `null` is only ever passed when the automatic lane
      // is genuinely the one we want.
      const repairWithAutomatic = automaticStablePathOpen;
      const repairPin = repairWithAutomatic ? null : downloadTarget;
      if (repairWithAutomatic || repairPin !== null) {
        log.info(
          "[host-controller] replacing a legacy staged host without a handoff fingerprint",
          {
            version: staged.version,
            replacement: repairWithAutomatic ? "--automatic" : repairPin,
          },
        );
        await this.runDownloadLane(repairPin);
        migratedLegacyStage = true;
        staged = await readDesktopHostStagedRecord(this.layout);
      } else {
        // TERMINAL FOR THIS RECONCILE, and returning here is the point.
        //
        // Falling through would reach the purge branch below, which requires a
        // fingerprint this stage does not have, and would log "cannot purge an
        // unpinned staged host after registry invalidation" at `warn` on every
        // single reconcile - naming a cause that did not happen. The registry
        // is fine; the stage is fine; this build's line simply has nothing to
        // replace it with yet. Say that once, at debug, since it is a standing
        // condition rather than an event, and stop.
        log.debug(
          "[host-controller] leaving an unpinned legacy stage in place: its release line has no candidate to replace it with",
          {
            version: staged.version,
            installedVersion,
            mode,
          },
        );
        return;
      }
    }
    const stageIsEligible =
      staged !== null &&
      staged.stageId !== null &&
      snapshot.valid &&
      snapshot.versions.some(
        (entry) => entry.version === staged?.version && entry.available,
      );
    if (staged !== null && !stageIsEligible) {
      const expectedStageFingerprint =
        staged.stageId === null ? null : encodeStageFingerprint(staged.stageId);
      if (expectedStageFingerprint === null) {
        // Reached only when a replacement WAS attempted and left the stage
        // unpinned anyway (the repair download failed). The deliberate
        // leave-in-place case returns above, so this no longer speaks for it -
        // and it no longer blames registry invalidation, which is one possible
        // reason a stage is ineligible but not the reason it cannot be purged.
        log.warn(
          "[host-controller] cannot purge an ineligible staged host: it carries no handoff fingerprint",
          { version: staged.version },
        );
        return;
      }
      try {
        const purge = parsePurgeStageResult(
          await this.runBundled<unknown>([
            "host",
            "purge-stage",
            "--expected-stage-fingerprint",
            expectedStageFingerprint,
          ]),
        );
        if (purge.outcome === "stage-fingerprint-mismatch") {
          log.info(
            "[host-controller] staged host changed before the yanked stage could be purged",
            { expectedStageFingerprint },
          );
          return;
        }
        if (purge.outcome !== "purged") {
          throw new Error("host purge-stage returned an invalid outcome");
        }
      } catch (err) {
        const classified = this.classifyMutationSubprocessError<void>(
          err,
          "retry-with-force",
        );
        if (classified.kind === "deferred") {
          log.info(
            "[host-controller] yielding ineligible-stage purge to host update authority",
            { message: classified.message },
          );
          return;
        }
        log.warn(
          "[host-controller] could not purge an ineligible staged host",
          {
            err: describeError(err),
          },
        );
        return;
      }
      staged = null;
    }
    // Work the `--automatic` lane would do: refresh an existing stage, or take
    // a stable release newer than the installed build. Both are gated on the
    // automatic path being open, so a follower whose line offers nothing simply
    // does not download - it never reaches `runDownloadLane(null)` and so can
    // never be handed another line's `latest`.
    const hasAutomaticStableWork =
      automaticStablePathOpen &&
      (staged !== null ||
        (this.latestVersionCache !== null &&
          installedVersion !== null &&
          isStrictlyNewerHostVersion(
            this.latestVersionCache,
            installedVersion,
          )));
    const needsDownload =
      !migratedLegacyStage &&
      (downloadTarget !== null || hasAutomaticStableWork);
    if (!needsDownload) {
      if (stageIsEligible && staged !== null && staged.stageId !== null) {
        this.eligibleStage = {
          version: staged.version,
          fingerprint: encodeStageFingerprint(staged.stageId),
        };
      }
      return;
    }
    // Fixup A6: re-check mutation state HERE, atomically with the decision
    // to start a download - `stageLatest`'s own `mutationStatus !== null`
    // guard only covers its SYNCHRONOUS entry. The registry probe above is
    // an async gap a mutation can start during; without this re-check a
    // download would still begin right after, violating "no new download
    // while a mutation is active."
    if (this.mutationStatus !== null) {
      this.stageLatestPending = true;
      return;
    }
    await this.runDownloadLane(downloadTarget);
    staged = await readDesktopHostStagedRecord(this.layout);
    const downloadedStageIsEligible =
      staged !== null &&
      staged.stageId !== null &&
      snapshot.valid &&
      snapshot.versions.some(
        (entry) => entry.version === staged?.version && entry.available,
      );
    if (
      downloadedStageIsEligible &&
      staged !== null &&
      staged.stageId !== null
    ) {
      this.eligibleStage = {
        version: staged.version,
        fingerprint: encodeStageFingerprint(staged.stageId),
      };
    }
  }

  private async runDownloadLane(explicitVersion: string | null): Promise<void> {
    const job = this.downloadTail.then(async () => {
      // This work may have sat behind another download. Check both gates at
      // execution time: a mutation can have started, or Remove Traycer can
      // have persisted its sentinel, while it was waiting.
      if (await isHostRemovedByUser()) return;
      if (this.mutationStatus !== null) {
        this.stageLatestPending = true;
        return;
      }
      const version = explicitVersion ?? this.latestVersionCache ?? "latest";
      this.downloadStatus = { version, progress: null, lastError: null };
      const controller = new AbortController();
      this.downloadAbortController = controller;
      try {
        const args =
          explicitVersion !== null
            ? ["host", "download", explicitVersion]
            : ["host", "download", "--automatic"];
        await streamBundledTraycerCliJson<unknown>({
          args,
          env: null,
          idleTimeoutMs: CLI_STREAM_IDLE_TIMEOUT_MS,
          // Fixup C4: this download's own `AbortController` - `abortInFlightDownload`
          // (only called by `removeTraycer`) now actually kills the spawned CLI
          // subprocess instead of only flipping `.aborted` on a signal nothing
          // downstream read.
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type !== "progress" || this.downloadStatus === null)
              return;
            // Mi-1: the download watchdog (finding H) emits bare heartbeats -
            // progress events with all-null percent/bytes during a network
            // stall - purely to prove liveness. Projecting those verbatim
            // blanks an already-shown progress bar (e.g. 60% -> nothing -> 60%);
            // carry the last concrete value forward so a heartbeat holds the
            // bar and only a real number moves it.
            const priorDownloadProgress = this.downloadStatus.progress;
            this.downloadStatus = {
              ...this.downloadStatus,
              progress: {
                percent:
                  event.percent ?? priorDownloadProgress?.percent ?? null,
                bytes: event.bytes ?? priorDownloadProgress?.bytes ?? null,
                totalBytes:
                  event.totalBytes ?? priorDownloadProgress?.totalBytes ?? null,
              },
            };
          },
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          const classified = this.classifyMutationSubprocessError<void>(
            err,
            "retry-with-force",
          );
          if (classified.kind === "deferred") {
            log.info(
              "[host-controller] download lane yielded to host update authority",
              { message: classified.message },
            );
            return;
          }
          const message = describeError(err);
          log.debug(
            "[host-controller] download lane failed (silent - fail-open)",
            { message },
          );
          this.downloadStatus =
            this.downloadStatus === null
              ? null
              : { ...this.downloadStatus, lastError: message };
        }
      } finally {
        if (this.downloadAbortController === controller) {
          this.downloadAbortController = null;
        }
        // Fixup C5: this used to unconditionally null `downloadStatus` right
        // after the catch block above wrote `lastError` into it - the
        // terminal download-lane error was written and erased in the same
        // tick, so `getStatus().download` could never observe it (ticket 4
        // needs this to render download-lane failures). A clean settle (no
        // error - success, or an abort, which the catch block above
        // deliberately leaves `lastError: null` for) still clears the lane;
        // only a genuine `lastError` survives, until the next download
        // attempt's own start (`this.downloadStatus = { ...,
        // lastError: null }` above) overwrites it with a fresh record.
        if (
          this.downloadStatus !== null &&
          this.downloadStatus.lastError === null
        ) {
          this.downloadStatus = null;
        }
      }
    });
    this.downloadTail = job;
    return job;
  }

  private abortInFlightDownload(): void {
    this.downloadAbortController?.abort();
  }

  private async awaitDownloadLaneIdle(): Promise<void> {
    await this.downloadTail;
  }

  private async noOpApplyOutcome(
    appliedVersion: string,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    const runningRuntimeVersion = await readRunningRuntimeVersion(
      this.layout,
      this.reachabilityProbe,
    );
    if (runningRuntimeVersion === null) {
      return this.installedNotConverged(
        "No staged host update was available, but the current host is not reachable. Open Doctor or run 'traycer host doctor' to recover.",
      );
    }
    return {
      kind: "ok",
      value: { appliedVersion, runningActivated: true },
    };
  }

  // ---- applyStaged -----------------------------------------------------

  applyStaged(
    trigger: ApplyStagedTrigger,
    force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    // Fixup A6: reconcile BEFORE entering the exclusive mutation lane. The
    // ordering edge ("apply awaits any in-flight-or-due eligibility
    // reconcile for the staged version") still holds - it's just no longer
    // performed while HOLDING the lane, which used to block every other
    // mutation (`convergeReady` included) for the length of a WAN download -
    // a self-inflicted recurrence of the gate-pressure bug this ticket
    // exists to eliminate. Offline policy: a registry-unreachable reconcile
    // still proceeds with the signed stage (yank is curation; the minisign
    // signature is the security boundary) - `stageLatest`'s own probe
    // failure is already silent.
    return this.coalesceIntent<ApplyStagedOk>(
      `apply:${trigger}:${force}`,
      async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await this.awaitDownloadLaneIdle();
          await this.stageLatest();
          await this.awaitDownloadLaneIdle();

          const eligibleStage = this.eligibleStage;
          const installed = await readDesktopHostInstallRecord(this.layout);
          const staged = await readDesktopHostStagedRecord(this.layout);
          if (eligibleStage === null) {
            if (staged === null) {
              return this.noOpApplyOutcome(installed?.version ?? "");
            }
            return {
              kind: "deferred",
              message:
                "The staged host could not be eligibility-checked. Try the update again when the registry is reachable.",
            };
          }

          const outcome = await this.enqueueMutation<
            MutationOutcome<ApplyStagedOk>
          >("apply", `apply:${trigger}:${force}`, async () => {
            if (trigger === "launch" && (await isHostRemovedByUser())) {
              return {
                kind: "deferred",
                message: HOST_REMOVED_BY_USER_MESSAGE,
              };
            }
            if (await this.isPackagedMacOwned()) {
              return this.applyStagedPackagedMac(eligibleStage.fingerprint);
            }
            return this.applyStagedCliOwned(force, eligibleStage.fingerprint);
          });
          if (outcome.kind !== "stage-fingerprint-mismatch") return outcome;
        }
        return {
          kind: "deferred",
          message:
            "The staged host changed while the update was being applied. Retry to apply the current stage.",
        };
      },
    );
  }

  private async applyStagedCliOwned(
    force: boolean,
    expectedStageFingerprint: string,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>([
        "host",
        "apply",
        "--expected-stage-fingerprint",
        expectedStageFingerprint,
        ...(force ? ["--force"] : []),
      ]);
    } catch (err) {
      await this.reloadAfterServiceCycleFailure();
      return this.classifyApplyLikeError(err, "retry-with-force");
    }
    const result = parseApplyResult(raw);
    if (result.outcome === "stage-fingerprint-mismatch") {
      return {
        kind: "stage-fingerprint-mismatch",
        message: "The staged host changed after it was eligibility-checked.",
      };
    }
    if (result.outcome === "no-op") {
      return this.noOpApplyOutcome(result.installedVersion ?? "");
    }
    if (result.postSwapError !== null) {
      return this.installedNotConverged(
        `Host bytes were applied, but the background service failed to start after the swap: ${result.postSwapError}. Open Doctor or run 'traycer host doctor' to recover.`,
      );
    }
    // A CLI-owned apply can itself restart the supervisor. Readiness is
    // required for that cycle regardless of whether the committed record
    // needs a runtime CAS backfill; stamping is a separate null-runtime-only
    // concern.
    if (result.runningActivated) {
      try {
        await this.completeServiceStart(
          result.stoppedBeforeSwap ? prePid : null,
          result.runtimeVersion === null ? result.installGeneration : null,
          result.runtimeVersion,
        );
      } catch (err) {
        return this.installedNotConverged(describeError(err));
      }
    } else {
      return this.installedNotConverged(
        "Host bytes were applied, but the background service was not started. Open Doctor or run 'traycer host doctor' to recover.",
      );
    }
    return {
      kind: "ok",
      value: {
        appliedVersion: result.version ?? "",
        runningActivated: result.runningActivated,
      },
    };
  }

  private async applyStagedPackagedMac(
    expectedStageFingerprint: string,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>([
        "host",
        "apply",
        "--no-service",
        "--expected-stage-fingerprint",
        expectedStageFingerprint,
      ]);
    } catch (err) {
      // `--no-service` never busy-checks CLI-side, so any error here is a
      // genuine apply failure, not a pre-commit busy signal.
      return this.classifyApplyLikeError(err, "retry-with-force");
    }
    const result = parseApplyResult(raw);
    if (result.outcome === "stage-fingerprint-mismatch") {
      return {
        kind: "stage-fingerprint-mismatch",
        message: "The staged host changed after it was eligibility-checked.",
      };
    }
    if (result.outcome === "no-op") {
      return this.noOpApplyOutcome(result.installedVersion ?? "");
    }
    // Bytes are committed unconditionally at this point - any busy/failure
    // from here on is POST-COMMIT (continuation: "activate").
    const activation = await this.runLockedMacActivationCycle(
      false,
      "activate",
      false,
    );
    if (activation.kind !== "ok") {
      return activation as MutationOutcome<ApplyStagedOk>;
    }
    return {
      kind: "ok",
      value: {
        appliedVersion: result.version ?? "",
        runningActivated: activation.value.activated,
      },
    };
  }

  private classifyApplyLikeError<T>(
    err: unknown,
    continuation: BusyContinuation,
  ): MutationOutcome<T> {
    return this.classifyMutationSubprocessError(err, continuation);
  }

  // ---- activateInstalled -------------------------------------------------

  activateInstalled(
    force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    // Fixup A6: reconcile BEFORE entering the exclusive mutation lane, same
    // reasoning as `applyStaged` - determining whether a ready update
    // supersedes activation debt needs fresh `updateReady` state, and
    // fetching it must never hold the lane hostage across a WAN download.
    return this.coalesceIntent<ActivateInstalledOk>(
      `activate:${force}`,
      async () => {
        // Match `applyStaged`'s at-most-once freshness retry: the first
        // fingerprint can be invalidated by a replacement stage after the
        // off-lane eligibility pass. Re-check outside the mutation lane,
        // never by reusing stale stage state under the exclusive lock.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await this.awaitDownloadLaneIdle();
          await this.stageLatest();
          await this.awaitDownloadLaneIdle();

          const outcome = await this.enqueueMutation<
            MutationOutcome<ActivateInstalledOk>
          >("activate", `activate:${force}`, async () => {
            // A ready update supersedes activation debt - prevents the
            // restart-old -> stamp -> restart-new double cycle. The reconcile
            // already ran above; this only re-reads the (now-fresh) state and
            // performs the apply/activate choreography, no further download.
            const installed = await readDesktopHostInstallRecord(this.layout);
            const staged = await readDesktopHostStagedRecord(this.layout);
            if (
              deriveUpdateReady(
                installed?.version ?? null,
                staged?.version ?? null,
              )
            ) {
              const eligibleStage = this.eligibleStage;
              if (eligibleStage === null) {
                return {
                  kind: "deferred",
                  message:
                    "The staged host could not be eligibility-checked. Try the update again when the registry is reachable.",
                };
              }
              const applied = (await this.isPackagedMacOwned())
                ? await this.applyStagedPackagedMac(eligibleStage.fingerprint)
                : await this.applyStagedCliOwned(
                    force,
                    eligibleStage.fingerprint,
                  );
              if (applied.kind === "stage-fingerprint-mismatch") {
                return applied;
              }
              return applied.kind === "ok"
                ? {
                    kind: "ok",
                    value: { activated: applied.value.runningActivated },
                  }
                : applied;
            }
            if (await this.isPackagedMacOwned()) {
              return this.runLockedMacActivationCycle(force, "activate", false);
            }
            return this.activateInstalledCliOwned(force);
          });
          if (outcome.kind !== "stage-fingerprint-mismatch") return outcome;
        }
        return {
          kind: "deferred",
          message:
            "The staged host changed while activation was being applied. Retry to apply the current stage.",
        };
      },
    );
  }

  private async activateInstalledCliOwned(
    force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    const record = await readDesktopHostInstallRecord(this.layout);
    if (record === null) {
      return { kind: "failed", message: "No host installed." };
    }
    const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>(
        force ? ["host", "restart"] : ["host", "restart", "--if-idle"],
      );
    } catch (err) {
      await this.reloadAfterServiceCycleFailure();
      // One classifier table for every Desktop-owned CLI mutation route — an
      // inline copy of its three branches is the drift the central table
      // exists to prevent.
      return this.classifyMutationSubprocessError(err, "retry-with-force");
    }
    const result = parseServiceStartResult(raw);
    try {
      await this.completeServiceStart(
        prePid,
        result.runtimeWasNull ? result.installGeneration : null,
        result.runtimeVersion,
      );
    } catch (err) {
      return this.failedAfterServiceCycle(err);
    }
    return { kind: "ok", value: { activated: true } };
  }

  // ---- installVersion (pins) ---------------------------------------------

  async installVersion(
    pin: string,
    force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    return this.enqueueMutation<MutationOutcome<InstallVersionOk>>(
      "install",
      `install:${pin}:${force}`,
      async () => {
        // Explicit reinstall clears the removed-by-user sentinel (host-
        // removal-state.ts: "Cleared by an explicit reinstall").
        if (await isHostRemovedByUser()) {
          await clearHostRemovedByUser();
        }
        if (await this.isPackagedMacOwned()) {
          return this.installVersionPackagedMac(pin, force);
        }
        return this.installVersionCliOwned(pin, force);
      },
    );
  }

  private async installVersionCliOwned(
    pin: string,
    force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>(
        force
          ? ["host", "install", "--release", pin]
          : ["host", "install", "--release", pin, "--if-idle"],
      );
    } catch (err) {
      await this.reloadAfterServiceCycleFailure();
      return this.classifyApplyLikeError(err, "retry-with-force");
    }
    const result = parseInstallResult(raw);
    if (result.postSwapAction !== null && result.postSwapAction !== "none") {
      try {
        const readiness = await this.confirmActivationReadiness(
          prePid,
          result.runtimeVersion,
        );
        await this.stampIfNullRuntime(
          result.runtimeVersion === null ? result.installGeneration : null,
          readiness,
        );
      } catch (err) {
        return this.failedAfterServiceCycle(err);
      }
    }
    this.hostLifecycle.ensureWatcherInstalled();
    await this.hostLifecycle.reloadSnapshotFromDisk();
    const runningRuntimeVersion = await readRunningRuntimeVersion(
      this.layout,
      this.reachabilityProbe,
    );
    return {
      kind: "ok",
      value: {
        installedVersion: result.version ?? pin,
        runningActivated: runningRuntimeVersion !== null,
      },
    };
  }

  private async installVersionPackagedMac(
    pin: string,
    force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>([
        "host",
        "install",
        "--release",
        pin,
        "--no-service-register",
      ]);
    } catch (err) {
      // Bytes-only install never busy-checks CLI-side either.
      return this.classifyMutationSubprocessError(err, "retry-with-force");
    }
    const result = parseInstallResult(raw);
    // Bytes committed unconditionally - any busy/failure from here on is
    // post-commit (continuation: "activate"), same as apply's mac path.
    // Fixup B11: thread the caller's `force` through to the locked
    // activation cycle - a forced pin (Settings' "Force" busy-continuation
    // resubmit) must still force activation past a busy host, not silently
    // fall back to the non-forced busy-check this hardcoded `false` used to.
    const activation = await this.runLockedMacActivationCycle(
      force,
      "activate",
      false,
    );
    if (activation.kind !== "ok") {
      return activation as MutationOutcome<InstallVersionOk>;
    }
    return {
      kind: "ok",
      value: {
        installedVersion: result.version ?? pin,
        runningActivated: activation.value.activated,
      },
    };
  }

  // ---- registerService / deregisterService --------------------------------

  async registerService(
    intent: LocalHostMutationIntent,
  ): Promise<GuardedMutationOutcome<ServiceRegistrationOk>> {
    return this.enqueueMutation<GuardedMutationOutcome<ServiceRegistrationOk>>(
      "register",
      // Intent- and target-discriminated for the same reasons
      // `convergeReady`'s key is.
      `register:${this.reprovisionCoalesceKeySuffix(intent)}`,
      async () => {
        const abandoned = await this.admitReprovision(intent);
        if (abandoned !== null) return abandoned;
        if (await this.isPackagedMacOwned()) {
          const outcome = await withDesktopUpdateContender(
            {
              hostHomeDir: this.layout.rootDir,
              lockPath: this.lockPath,
              reason: "host-controller-register",
              waitMs: this.desktopLockWaitMs,
              pollIntervalMs: this.desktopLockPollIntervalMs,
              admission: "desktop-activation-maintenance",
            },
            async (capability) => {
              // Fixup B12 (lock rule 3): re-read install state after
              // acquisition - a terminal `host uninstall --all` may have
              // won the lock, removed the install, and released it while
              // this call waited its turn. Registering SMAppService against
              // an absent install would report success for a host that no
              // longer exists.
              const record = await readDesktopHostInstallRecord(this.layout);
              if (record === null) return null;
              const prePid =
                (await readRunningHostIdentity(this.layout))?.pid ?? null;
              const expectedInstallGeneration =
                record.runtimeVersion === null
                  ? attestedInstallGenerationFromDisk(record)
                  : null;
              const status = await registerHostLoginItemWithAttempt(
                capability,
                this.layout.rootDir,
                async () => true,
              );
              return {
                status,
                prePid,
                expectedInstallGeneration,
                expectedRuntimeVersion: record.runtimeVersion,
              };
            },
          );
          if (outcome.kind !== "acquired") {
            return this.desktopContenderRefusal(outcome);
          }
          const registration = outcome.result;
          if (registration === null) {
            return { kind: "failed", message: "No host installed." };
          }
          if (registration.status === "requires-approval") {
            return { kind: "failed", message: approvalRequiredMessage() };
          }
          if (registration.status === "enabled") {
            try {
              await this.completeServiceStart(
                registration.prePid,
                registration.expectedInstallGeneration,
                registration.expectedRuntimeVersion,
              );
            } catch (err) {
              return this.failedAfterServiceCycle(err);
            }
            return { kind: "ok", value: { registered: true } };
          }
          if (this.isCliTakeoverRecoverableStatus(registration.status)) {
            const recovery = await this.recoverRegistrationViaCliTakeover({
              adoptionArgs: [],
              failedStatus: registration.status,
              prePid: registration.prePid,
              expectedRuntimeVersion: registration.expectedRuntimeVersion,
            });
            if (!recovery.recovered) {
              return recovery.outcome;
            }
            return { kind: "ok", value: { registered: true } };
          }
          return {
            kind: "failed",
            message: `Failed to register the host login item (status=${registration.status}).`,
          };
        }
        let raw: unknown;
        try {
          // Streaming, not the flat-45s JSON wrapper: `host service install`
          // now runs the post-registration credential provisioning probe (up
          // to 30s waiting for the host), which stacked on the CLI's 30s
          // lock wait can exceed any flat bound - and a SIGKILL there
          // reports a registration that already succeeded as failed. The
          // idle timeout is re-armed by the command's own progress NDJSON
          // (`register`, `host-credential`).
          raw = await this.streamBundled<unknown>([
            "host",
            "service",
            "install",
            ...this.devServiceInstallExtras(),
          ]);
        } catch (err) {
          await this.reloadAfterServiceCycleFailure();
          return this.classifyMutationSubprocessError(err, "retry-with-force");
        }
        const result = parseServiceStartResult(raw);
        try {
          // Service registration can be an idempotent Linux
          // `systemctl enable --now`: it may leave the current host PID in
          // place. Only restart/cycle actions pass a pre-PID to readiness;
          // treating registration as a guaranteed replacement converts a
          // healthy same-PID service into a 60s false timeout.
          await this.completeServiceStart(
            null,
            result.runtimeWasNull ? result.installGeneration : null,
            result.runtimeVersion,
          );
        } catch (err) {
          return this.failedAfterServiceCycle(err);
        }
        return { kind: "ok", value: { registered: true } };
      },
    );
  }

  async deregisterService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return this.enqueueMutation<MutationOutcome<ServiceRegistrationOk>>(
      "deregister",
      "deregister",
      async () => {
        if (await this.isPackagedMacOwned()) {
          const outcome = await withDesktopUpdateContender(
            {
              hostHomeDir: this.layout.rootDir,
              lockPath: this.lockPath,
              reason: "host-controller-deregister",
              waitMs: this.desktopLockWaitMs,
              pollIntervalMs: this.desktopLockPollIntervalMs,
              admission: "desktop-activation-maintenance",
            },
            async (capability) =>
              unregisterHostLoginItemWithAttempt(
                capability,
                this.layout.rootDir,
              ),
          );
          if (outcome.kind !== "acquired") {
            return this.desktopContenderRefusal(outcome);
          }
          return { kind: "ok", value: { registered: false } };
        }
        try {
          await this.runBundled<unknown>(["host", "service", "uninstall"]);
        } catch (err) {
          return this.classifyMutationSubprocessError(err, "retry-with-force");
        }
        return { kind: "ok", value: { registered: false } };
      },
    );
  }

  /**
   * Independent recovery deliberately uses the CLI's attempt-aware restart
   * path on every platform, including packaged macOS. A direct SMAppService
   * activation would be allowed to register whichever bundle is currently on
   * disk; that is not a recovery action when a parked update has reserved its
   * explicit activation continuation. The CLI returns `restarted: false` for
   * that case after safely stopping the current service. Do not run readiness
   * or stamp the parked bytes as though a new host had started.
   */
  private async runCliRecoveryServiceCycle(
    args: readonly string[],
    prePid: number | null,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>(args);
    } catch (err) {
      await this.reloadAfterServiceCycleFailure();
      return this.classifyMutationSubprocessError(err, "retry-with-force");
    }
    const result = parseServiceStartResult(raw);
    if (result.deferredForParkedActivation) {
      // The command classified the record under ITS lock and refused without
      // touching the service, so the host is in whatever state it was in and
      // the activation continuation is still parked. `deferred` is the
      // truthful outcome: nothing was promised and nothing was broken.
      //
      // Reporting the `{kind:"ok", value:{activated:false}}` below instead
      // would be the stranding shape - it reads as "the restart ran and
      // achieved nothing", which is what the caller sees when a safe-stop
      // really did stop the host.
      await this.hostLifecycle.reloadSnapshotFromDisk();
      return { kind: "deferred", message: HOST_UPDATE_ACTIVATING_MESSAGE };
    }
    if (!result.restarted) {
      await this.hostLifecycle.reloadSnapshotFromDisk();
      return { kind: "ok", value: { activated: false } };
    }
    try {
      await this.completeServiceStart(
        prePid,
        result.runtimeWasNull ? result.installGeneration : null,
        result.runtimeVersion,
      );
    } catch (err) {
      return this.failedAfterServiceCycle(err);
    }
    return { kind: "ok", value: { activated: true } };
  }

  // ---- respawn / recoverIfDown --------------------------------------------

  // `respawn` is always force=true (`host restart --force` / a
  // force-activation cycle, never `--if-idle`): it is the explicit "restart
  // the host now" intent - Settings → Force restart on a busy denial, a
  // doctor-recommended restart, the health monitor's recovery hook. The
  // caller deliberately asked for an immediate restart; silently downgrading
  // to "only if idle" would make the action a no-op exactly when the user is
  // trying to recover from a stuck host, which is the case it exists for.
  // `--force` on the CLI leg is load-bearing for the same reason: without it
  // `host restart` runs the cooperative shutdown claim, and the busy host
  // that made the user reach for Force restart denies it - the forced
  // restart would report the very declined outcome it exists to override.
  // Bumped when a respawn lane job completes an actual restart. Coalescing
  // dedupes identical submissions (same key, still in flight), but the key is
  // intent- and target-discriminated, so a watched user repair and a
  // menu/tray background restart for the same slot are DIFFERENT jobs - the
  // renderer's mutation keys cannot dedupe across BrowserWindows either. The
  // generation closes that seam at the head of the lane: a respawn admitted
  // after another respawn already completed a restart that the caller's own
  // submission predates has its ask already satisfied, and running a second
  // forced cycle would kill the sessions that just reconnected to the fresh
  // host.
  private respawnGeneration = 0;

  /**
   * F3 - Force restart while a packaged-macOS activation is pending.
   *
   * ## The defect
   *
   * On packaged macOS `respawn` shells `host restart --force`, which at a
   * byte-placement checkpoint takes its `stop-only` branch, stops the service
   * and returns `restarted: false`. Desktop then reports `{activated: false}`
   * and the machine is left with NO running host and a parked update nobody
   * activated - stranded on precisely the state the button exists to escape.
   *
   * ## Latent, not live
   *
   * Under the shadow cohort nothing ever claims, so no attempt record is
   * created, so `recoveryActionFor` always answers `restart-current` and the
   * `stop-only` branch is unreachable. This lands ahead of Ticket 07's cutover
   * rather than in response to a field report - and the same fact is why the
   * continuation arm below returns `cohort-disabled` today and falls through.
   *
   * ## Returning `null` means "fall through, byte-identical"
   *
   * The default is deliberately today's exact behaviour. Only two things
   * diverge from it: a continuation that actually completed, and a live
   * executor that must not be interrupted. Every other outcome - a refusal, a
   * rejection, a park, even a terminalized failure - falls through to the
   * plain `host restart --force`, because after any of them the user still
   * asked for a restart and a running host is strictly better than a stopped
   * one. That is what keeps the "never strand worse than entry" property.
   *
   * ## No new decision logic
   *
   * The phase set below is a cheap PRE-FILTER, not a policy: it only skips the
   * states where a continuation could not apply. Which claims are legal, and
   * what a claim resolves to, stays with `decideAttemptClaim` inside the
   * segment. Re-deriving that here is how the two would drift.
   */
  private async routeForceRestartContinuation(
    /**
     * Whether a `requires-recovery` refusal may dispatch the CLI recovery
     * claimant and re-enter once. False on the re-entry, so the recovery arm
     * can run at most once per Force restart - a recovery that lands something
     * still unclaimable must surface, not spin.
     */
    allowRecoveryDispatch: boolean,
  ): Promise<GuardedMutationOutcome<ActivateInstalledOk> | null> {
    const read = await readUpdateAttemptRecord(this.layout.rootDir);
    // Absent, or unreadable: nothing to continue. An unreadable record must
    // NOT block a restart - stale or faulted attempt evidence disabling
    // recovery controls is the exact deadlock this path exists to prevent.
    if (read.kind !== "valid") return null;
    const record = read.value;
    if (!FORCE_RESTART_CONTINUATION_PHASES.has(record.phase)) return null;

    const label = labelForEnvironment(this.environment);
    const owner = await readHostServiceOwner(
      this.layout,
      {
        cliLabelId: label.id,
        agentLabelId: smAppServiceAgentLabelId(label.id),
      },
      // Desktop cannot observe the RUNNING host's launchd label: it belongs to
      // the host's own job, not to this process. Unavailable is the honest
      // input, and the projection falls back to the durable substrate record.
      { kind: "unavailable" },
    );
    if (owner.kind !== "owned") return null;

    const identity: HostUpdateAttemptIdentity = {
      attemptId: record.attemptId,
      generation: record.generation,
      sequence: record.sequence,
    };
    const segment = await runDesktopActivationSegment(
      {
        targetVersion: record.targetVersion,
        trigger: record.trigger,
        action: "activate",
        expected: identity,
        // Unreachable: an identity-bound request never reaches a create path.
        newAttemptId: randomUUID(),
        // The user's Force-restart confirmation IS the drain override. It is
        // NOT update-force authorization - `action` above stays `activate`,
        // and the core refuses `force` for an activation continuation anyway,
        // so the two authorizations cannot be spent for one another.
        overrideDrain: true,
      },
      {
        layout: this.layout,
        substrate: owner.substrate,
        contender: {
          hostHomeDir: this.layout.rootDir,
          lockPath: this.lockPath,
          reason: "desktop-force-restart-continuation",
          waitMs: this.desktopLockWaitMs,
          pollIntervalMs: this.desktopLockPollIntervalMs,
        },
        nowIso: () => new Date().toISOString(),
        drain: () => probeHostBusyVerdict(this.layout),
        commit: (capability: UpdateMutationCapability, intent) =>
          commitAttemptMutationWithCapability(
            capability,
            this.layout.rootDir,
            intent,
          ),
        publishTombstone: (capability: UpdateMutationCapability) =>
          publishRestartTombstoneWithAttempt(capability, this.layout),
        clearTombstone: (capability: UpdateMutationCapability) =>
          clearRestartTombstoneWithAttempt(capability, this.layout),
        // The actuator span. Acquisition sits BEFORE the write-ahead, so a
        // busy inner lock defers while the record is still `preparing` -
        // rather than terminalizing a staged activation that a park keeps.
        //
        // Scoped here and not inside `runMacActivationStepWithCapability`
        // deliberately: that actuator is also reached from the four
        // `withDesktopUpdateContender` callers, whose wrapper already holds
        // the cli-lock, and wrapping it there would re-acquire a held lock.
        withActuatorLock: async <T>(
          capability: UpdateMutationCapability,
          run: () => Promise<T>,
        ): Promise<DesktopActuatorSpan<T>> => {
          try {
            return {
              kind: "ran",
              value: await withDesktopAttemptMutation(
                capability,
                {
                  hostHomeDir: this.layout.rootDir,
                  lockPath: this.lockPath,
                  reason: "desktop-force-restart-continuation",
                  waitMs: this.desktopLockWaitMs,
                  pollIntervalMs: this.desktopLockPollIntervalMs,
                  admission: "attempt-executor",
                },
                async () => run(),
              ),
            };
          } catch (err) {
            if (err instanceof DesktopCliLockBusyError) {
              return { kind: "busy", message: LOCK_BUSY_MESSAGE };
            }
            throw err;
          }
        },
        registerActuator: async (
          capability: UpdateMutationCapability,
        ): Promise<DesktopActivationCycleOutcome> => {
          const step = await this.runMacActivationStepWithCapability(
            capability,
            // Force: the user's confirmation already overrode the drain, so a
            // second busy check here would re-ask a question they answered.
            true,
            "activate",
          );
          if (step.phase === "registered") return { kind: "activated" };
          if (step.phase === "register-failed") {
            // F3 MINT SITE - the only bundled-CLI child in this flow, and it
            // runs OUTSIDE the span. Adoption waives the attempt lock only;
            // the takeover child takes the cli-lock itself, so handing back a
            // thunk is what keeps the parent from blocking its own child.
            if (this.isCliTakeoverRecoverableStatus(step.status)) {
              return {
                kind: "needs-takeover",
                recoverOutsideLock:
                  async (): Promise<DesktopActivationCycleOutcome> => {
                    const recovery = await withMintedAdoption(
                      capability,
                      this.layout,
                      (adoptionArgs) =>
                        this.recoverRegistrationViaCliTakeover({
                          failedStatus: step.status,
                          prePid: step.prePid,
                          expectedRuntimeVersion: step.expectedRuntimeVersion,
                          adoptionArgs,
                        }),
                    ).catch((err: unknown) => {
                      const cause =
                        err instanceof Error ? err.message : String(err);
                      log.warn(
                        "[host-controller] takeover adoption could not be minted",
                        { cause },
                      );
                      return { mintFailure: cause };
                    });
                    if ("mintFailure" in recovery) {
                      // Carry the REAL cause. This used to return the generic
                      // lock-busy message, which `terminalize` then wrote to disk
                      // as the failure's `cause` - so a local proof-write I/O
                      // error was permanently recorded as lock contention, which
                      // is not merely vague but actively wrong for whoever reads
                      // that diagnostic later.
                      //
                      // Same invariant as the takeover-diagnostics ruling earlier
                      // in this ticket: classification may normalize the failure
                      // CATEGORY, but it must never replace caller-only
                      // discriminating evidence.
                      return {
                        kind: "failed",
                        message: `adoption proof could not be minted: ${recovery.mintFailure}`,
                      };
                    }
                    return recovery.recovered
                      ? { kind: "activated" }
                      : {
                          kind: "deferred",
                          message: describeTakeoverRefusal(recovery.outcome),
                        };
                  },
              };
            }
            // Carries the login-item status rather than a message. Keep the
            // status in the text: it is the discriminating evidence a caller
            // needs (`requires-approval` is a user action, not a retry).
            return {
              kind: "failed",
              message: `SMAppService registration failed (${step.status}).`,
            };
          }
          // Whether the host is READY on the new bytes is deliberately not
          // decided here - the verification claim answers that from real
          // installed-and-running evidence.
          return step.outcome.kind === "deferred"
            ? { kind: "deferred", message: step.outcome.message }
            : {
                kind: "failed",
                message:
                  "message" in step.outcome
                    ? step.outcome.message
                    : step.outcome.kind,
              };
        },
        // The claim succeeded and a restart is now imminent: that is exactly
        // what the renderer-facing respawn notification means, so the private
        // acknowledgement IS this call. The plain path below makes the same
        // announcement at the same point in its own sequence.
        acknowledge: async (): Promise<void> => {
          this.hostLifecycle.notifyRespawning();
        },
        dispatchVerification: (
          claimed: HostUpdateAttemptIdentity,
        ): Promise<DesktopVerificationOutcome> =>
          this.dispatchUpdateVerification(claimed, record.targetVersion),
        faults: NO_DESKTOP_EXECUTOR_FAULTS,
      },
    );

    if (segment.kind === "verified") {
      // `verified` means the SEGMENT reached its verification step - NOT that
      // verification succeeded. Reporting `{activated:true}` without reading
      // the verdict turned every `failed`, `resumed` and `indeterminate`
      // report into a success, and left a nonterminal continuation behind
      // while telling the user the restart had completed.
      //
      // Only `complete` is an activation. Every other verdict falls through to
      // the plain restart, and that is the safe direction rather than a
      // shrug: `resumed` means bytes are placed but the host is NOT running,
      // `failed` means it may be down, and `indeterminate` means we do not
      // know - in all three the user asked for a restart and a running host
      // beats a stopped one.
      switch (segment.verification.kind) {
        case "complete":
          return { kind: "ok", value: { activated: true } };
        case "resumed":
        case "failed":
        case "indeterminate":
          // Fall through to the generic restart, which now carries
          // `--defer-if-parked` and so makes the parked-activation decision
          // ITSELF, from the record as it stands, under the same contender
          // lock that guards the stop/restart it authorizes.
          //
          // Deciding it here is what round 2 rejected, on two counts:
          //
          //  - It was a SNAPSHOT, not a condition on the restart. A contender
          //    can park `preparing/activate` in the window between this read
          //    and the command taking the lock, so a "safe to restart" verdict
          //    could be stale before it was acted on - and the command would
          //    then stop the service without relaunching, which is the exact
          //    stranding this route exists to prevent.
          //  - It was a SECOND COPY of the policy, and it disagreed with the
          //    canonical one. `recoveryActionFor` in shared calls
          //    `restarting/activate` and `verifying/activate`
          //    `restart-current`; this copy treated every continuation phase
          //    as unsafe, so an `indeterminate` verdict over one of those
          //    records deferred forever and Force restart could never bring a
          //    downed host back.
          //
          // What remains here is diagnostics, not a decision.
          log.warn(
            "[host-controller] continuation verification did not complete",
            {
              attemptId: identity.attemptId,
              verification: segment.verification.kind,
              action: "generic-restart-decides",
            },
          );
          return null;
      }
    }
    if (segment.kind === "parked" && segment.reason === "actuator-lock-busy") {
      // The INNER cli-lock was held elsewhere. Because acquisition now happens
      // before the `restarting` commit, nothing was promised and the record is
      // truthfully re-parked - so this is a real deferral, not a terminalized
      // activation. Falling through here would run a plain restart while
      // another process is mid-mutation of the install tree.
      return { kind: "deferred", message: LOCK_BUSY_MESSAGE };
    }
    if (
      segment.kind === "rejected" &&
      segment.reason === "requires-recovery" &&
      allowRecoveryDispatch
    ) {
      return this.recoverOrphanedContinuationThenResume(identity, record);
    }
    if (segment.kind === "refused" && segment.outcome.kind === "busy") {
      // A live executor owns this attempt. Stopping its host mid-flight is the
      // one thing worse than not restarting, so this is the sole refusal that
      // does not fall through.
      return { kind: "deferred", message: HOST_UPDATE_ACTIVATING_MESSAGE };
    }
    return null;
  }

  /**
   * Dispatch the post-restart verification claim to the bundled CLI.
   *
   * Desktop is a DISPATCHER here, not a parent: it supplies no capability, no
   * adoption proof and no evidence. The CLI claims the orphaned record with
   * its own lock and its own lock-scoped evidence. An adoption proof could not
   * validate in principle anyway - there is no live holder left to name, which
   * is the definition of the state being reconciled.
   */
  /**
   * An orphaned continuation refused the plain claim as `requires-recovery`.
   * Dispatch the CLI recovery claimant, then resume normally if it parked one.
   *
   * ## Why Desktop dispatches instead of reconciling
   *
   * Reconciling an orphan needs the executor-only `recover` intent plus
   * evidence gathered under an inner CLI lock. Both are deliberately private
   * to the CLI executor, and Desktop minting recovery evidence of its own
   * would be the structural forgery T3 closed. So Desktop is a dispatcher
   * here, exactly as it is for post-restart verification - it supplies no
   * capability, no proof and no evidence.
   *
   * ## Why the record is the authority and the report is not
   *
   * The claimant returns the identity it parked, and this does NOT resume from
   * it. It re-enters the route, which re-reads the record and resumes from
   * what is on disk. The reported identity is used only to detect
   * DISAGREEMENT: if the record names a different attempt than the claimant
   * says it parked, something else moved it between the two reads and neither
   * value describes the machine. That is the same record-over-testimonial rule
   * the cohort scoping follows.
   *
   * Re-entry is capped at one pass (`allowRecoveryDispatch: false`). Recovery
   * that lands something still unclaimable must surface rather than spin.
   */
  private async recoverOrphanedContinuationThenResume(
    identity: HostUpdateAttemptIdentity,
    record: HostUpdateAttemptRecord,
  ): Promise<GuardedMutationOutcome<ActivateInstalledOk> | null> {
    const report = await this.dispatchUpdateVerification(
      identity,
      record.targetVersion,
    );
    if (report.kind === "complete") {
      return { kind: "ok", value: { activated: true } };
    }
    if (report.kind !== "resumed" || report.parked === null) {
      // `failed`, `indeterminate`, or a `resumed` that could not name what it
      // parked. In every one of those the record stands as the claimant left
      // it and nothing here may claim otherwise - fall through to the generic
      // restart, which carries `--defer-if-parked` and so refuses rather than
      // stopping a host behind placed bytes.
      log.warn(
        "[host-controller] orphan recovery did not park a resumable attempt",
        {
          attemptId: identity.attemptId,
          report: report.kind,
          parked: report.kind === "resumed" ? "unnamed" : "n/a",
        },
      );
      return null;
    }
    const after = await readUpdateAttemptRecord(this.layout.rootDir);
    const parked = report.parked;
    const agrees =
      after.kind === "valid" &&
      after.value.attemptId === parked.attemptId &&
      after.value.generation === parked.generation;
    if (!agrees) {
      log.warn(
        "[host-controller] recovery parked an attempt the record does not name",
        {
          reportedAttemptId: parked.attemptId,
          reportedGeneration: parked.generation,
          onDisk: after.kind === "valid" ? after.value.attemptId : after.kind,
        },
      );
      return null;
    }
    return this.routeForceRestartContinuation(false);
  }

  private async dispatchUpdateVerification(
    identity: HostUpdateAttemptIdentity,
    targetVersion: string,
  ): Promise<DesktopVerificationOutcome> {
    try {
      return decodeVerificationReport(
        await this.streamBundled<unknown>([
          "host",
          "update-verify",
          "--attempt-id",
          identity.attemptId,
          "--generation",
          String(identity.generation),
          "--sequence",
          String(identity.sequence),
          "--target-version",
          targetVersion,
        ]),
      );
    } catch (err) {
      // A dispatch that could not complete carries NO evidence about the
      // update's fate. Reporting anything terminal here is how a `verifying`
      // record would become a false `complete`.
      return {
        kind: "indeterminate",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async respawn(
    intent: LocalHostMutationIntent,
  ): Promise<GuardedMutationOutcome<ActivateInstalledOk>> {
    // Sampled at SUBMISSION, synchronously: a restart completed after this
    // point satisfies this request; one completed before it does not.
    const generationAtSubmit = this.respawnGeneration;
    return this.enqueueMutation<GuardedMutationOutcome<ActivateInstalledOk>>(
      "respawn",
      // Intent- and target-discriminated like the reprovision keys. Two
      // background respawns still collapse to one restart; a user repair is
      // its own job so it cannot join a background restart and skip the
      // guard question below. The cross-key dedupe that this key split gave
      // up is `respawnGeneration`'s job above.
      `respawn:${this.reprovisionCoalesceKeySuffix(intent)}`,
      async () => {
        // Guard only - NOT `admitReprovision`. A restart is not a
        // reprovision: it must keep the removed-by-user deferral below and
        // clears nothing. Asked at the head of the lane because this intent
        // QUEUES behind whatever is running - a doctor-recommended restart
        // can wait minutes behind an install, and the host it named can be
        // replaced in that window; firing then would force-restart a host
        // nobody asked about, killing its active sessions. Runs before
        // `notifyRespawning`, which clears the renderer-facing snapshot - an
        // abandoned job must leave no trace it was ever admitted.
        const abandoned = await this.runLaneHeadGuard(intent);
        if (abandoned !== null) return abandoned;
        // After the guard, before any effect: identity decides whether this
        // job may act at all; the generation only decides whether there is
        // anything left to do. A restart that completed since submission is
        // this request fulfilled - report it, run nothing.
        if (this.respawnGeneration !== generationAtSubmit) {
          return { kind: "ok", value: { activated: true } };
        }
        // Fixup B14: Remove Traycer may have persisted the removed-by-user
        // sentinel but failed/been interrupted mid-uninstall, leaving
        // remaining bytes on disk - without this check, Restart/Retry would
        // resurrect them instead of respecting the removal.
        if (await isHostRemovedByUser()) {
          return { kind: "deferred", message: HOST_REMOVED_BY_USER_MESSAGE };
        }
        // F3. Runs AFTER the removed-by-user deferral (a removed host is not
        // one to continue activating) and BEFORE `notifyRespawning`, because a
        // continuation makes that announcement itself at its own claim point.
        // Returns null for every state that is not a pending packaged-macOS
        // activation, so the sequence below stays byte-identical.
        const continuation = await this.routeForceRestartContinuation(true);
        if (continuation !== null) {
          // A completed continuation IS a relaunch — verification reported
          // `complete`, so the host restarted onto the new bytes. It must
          // satisfy every respawn submitted before it, same rule as the
          // plain path below; otherwise the queued respawn still sees its
          // submission generation and force-restarts the host that just
          // came up, killing the sessions that reconnected to it.
          if (continuation.kind === "ok" && continuation.value.activated) {
            this.respawnGeneration += 1;
          }
          return continuation;
        }
        this.hostLifecycle.notifyRespawning();
        const prePid =
          (await readRunningHostIdentity(this.layout))?.pid ?? null;
        // `--defer-if-parked`: Desktop never wants a stop-without-relaunch.
        // The flag moves the parked-activation decision INSIDE the command's
        // own contender lock, so it is made from the record as it stands when
        // the action runs rather than from a snapshot taken here beforehand.
        const recovery = await this.runCliRecoveryServiceCycle(
          ["host", "restart", "--force", "--defer-if-parked"],
          prePid,
        );
        // Only a completed relaunch satisfies later-submitted respawns. A
        // parked-activation safe-stop, busy result, or failure leaves the
        // queued caller's restart request outstanding.
        if (recovery.kind === "ok" && recovery.value.activated) {
          this.respawnGeneration += 1;
        } else if (recovery.kind !== "ok") {
          await this.hostLifecycle.reloadSnapshotFromDisk();
        }
        return recovery;
      },
    );
  }

  /**
   * Windows/CLI-owned health monitor's recovery hook. `suppressed` when a
   * mutation already owns the host (checked BEFORE submission, so a
   * healthy tick never queues redundant work) or the running host is
   * already reachable once re-checked at the head of the lane (no
   * double-restart against a host another mutation already fixed).
   *
   * Always force=true, same as `respawn`, but for a different reason: by the
   * time the lane job below runs, `readRunningRuntimeVersion` has already
   * confirmed the host is NOT reachable - there is no live work for
   * `--if-idle` to protect, so gating on idle here would only add a chance
   * of a stale/racy busy read silently swallowing a recovery the monitor
   * exists to guarantee.
   */
  async recoverIfDown(): Promise<
    MutationOutcome<ActivateInstalledOk> | { readonly kind: "suppressed" }
  > {
    if (this.mutationStatus !== null) {
      return { kind: "suppressed" };
    }
    return this.enqueueMutation<MutationOutcome<ActivateInstalledOk>>(
      "recoverIfDown",
      "recoverIfDown",
      async () => {
        const runningRuntimeVersion = await readRunningRuntimeVersion(
          this.layout,
          this.reachabilityProbe,
        );
        if (runningRuntimeVersion !== null) {
          return { kind: "ok", value: { activated: true } };
        }
        if (await isHostRemovedByUser()) {
          return { kind: "deferred", message: HOST_REMOVED_BY_USER_MESSAGE };
        }
        // The CLI attests the committed install record while it owns the
        // restart lock. Desktop only contributes its pre-cycle pid, then
        // stamps against that command result after readiness.
        const prePid =
          (await readRunningHostIdentity(this.layout))?.pid ?? null;
        // Same reason as `respawn`: the health monitor exists to bring a host
        // back, so stopping one without relaunching is the one result it must
        // never produce.
        return this.runCliRecoveryServiceCycle(
          ["host", "restart", "--defer-if-parked"],
          prePid,
        );
      },
    );
  }

  // ---- freePortAndRestart --------------------------------------------------

  // Always force=true, for the same reason as `respawn`: by the time this
  // runs, the renderer's Doctor flow has already shown the user the foreign
  // process holding the host's port and gotten their explicit confirmation
  // to kill it and restart. `--if-idle` protecting "work in progress" makes
  // no sense here - the port conflict means the host isn't even bound yet,
  // so there is nothing in-flight on it to protect, and the whole point of
  // the confirmed action is to force the restart through.
  async freePortAndRestart(
    pid: number | null,
    port: number | null,
    intent: LocalHostMutationIntent,
  ): Promise<GuardedMutationOutcome<ActivateInstalledOk>> {
    return this.enqueueMutation<GuardedMutationOutcome<ActivateInstalledOk>>(
      "freePortAndRestart",
      // Target-discriminated like the reprovision keys: `pid`/`port` alone
      // name a process, not the host that recorded it, so two repairs from
      // different hosts could otherwise collide on identical numbers.
      `freePortAndRestart:${pid}:${port}:${this.reprovisionCoalesceKeySuffix(intent)}`,
      async () => {
        // Guard only - NOT `admitReprovision`. This is a restart, so the
        // removed-by-user deferral stays. What it does need is the identity
        // re-ask: the queued route waits behind whatever holds the lane, and
        // `pid`/`port` were recorded against the host as it was THEN. Running
        // them after a replacement kills a process nobody pointed at, and
        // frees a port some other process may now hold.
        const abandoned = await this.runLaneHeadGuard(intent);
        if (abandoned !== null) return abandoned;
        // The port repair reaches the identical `stop-only` branch, so it is
        // the same stop-without-relaunch hazard by another entry point.
        const args = ["host", "free-port-and-restart", "--defer-if-parked"];
        if (pid !== null) args.push("--pid", String(pid));
        if (port !== null) args.push("--port", String(port));
        // As in `recoverIfDown`, the command attests the record while it
        // owns the restart lock; Desktop stamps that result after readiness.
        const prePid =
          (await readRunningHostIdentity(this.layout))?.pid ?? null;
        return this.runCliRecoveryServiceCycle(args, prePid);
      },
    );
  }

  // ---- uninstallHost (Settings; no sentinel) -------------------------------

  async uninstallHost(all: boolean): Promise<MutationOutcome<UninstallOk>> {
    return this.enqueueMutation<MutationOutcome<UninstallOk>>(
      "uninstallHost",
      `uninstallHost:${all}`,
      async () => {
        if (all && (await this.isPackagedMacOwned())) {
          const outcome = await withDesktopUpdateContender(
            {
              hostHomeDir: this.layout.rootDir,
              lockPath: this.lockPath,
              reason: "host-controller-uninstall",
              waitMs: this.desktopLockWaitMs,
              pollIntervalMs: this.desktopLockPollIntervalMs,
              admission: "uninstall-maintenance",
            },
            async (capability) =>
              unregisterHostLoginItemWithAttempt(
                capability,
                this.layout.rootDir,
              ),
          );
          if (outcome.kind !== "acquired") {
            return this.desktopContenderRefusal(outcome);
          }
        }
        let raw: unknown;
        try {
          raw = await this.runBundled<unknown>(
            all ? ["host", "uninstall", "--all"] : ["host", "uninstall"],
          );
        } catch (err) {
          return this.classifyMutationSubprocessError(err, "retry-with-force");
        }
        const result = parseUninstallResult(raw, all);
        this.hostLifecycle.ensureWatcherInstalled();
        await this.hostLifecycle.reloadSnapshotFromDisk();
        return {
          kind: "ok",
          value: {
            removedInstallDir: result.removedInstallDir,
            deregisteredService: result.serviceUninstalled,
            serviceRegistrationRetained: result.serviceRegistrationRetained,
          },
        };
      },
    );
  }

  // ---- removeTraycer (Danger Zone; sentinel + BTM cleanup) -----------------

  async removeTraycer(): Promise<MutationOutcome<RemoveTraycerOk>> {
    // Persist the sentinel FIRST, before entering the lane, so any
    // already-queued automatic intent that hasn't executed yet observes it
    // the moment it runs (functional "cancel queued automatic intents" -
    // they still execute their job body but immediately no-op).
    await markHostRemovedByUser();
    this.abortInFlightDownload();
    return this.enqueueMutation<MutationOutcome<RemoveTraycerOk>>(
      "removeTraycer",
      "removeTraycer",
      async () => {
        // The abort asks the child to exit; wait for the stream's `close`
        // before unregistering or uninstalling, and let queued automatic
        // jobs observe the sentinel and no-op.
        await this.awaitDownloadLaneIdle();
        let removedLoginItem = false;
        if (await this.isPackagedMacOwned()) {
          const outcome = await withDesktopUpdateContender(
            {
              hostHomeDir: this.layout.rootDir,
              lockPath: this.lockPath,
              reason: "host-controller-remove",
              waitMs: this.desktopLockWaitMs,
              pollIntervalMs: this.desktopLockPollIntervalMs,
              admission: "uninstall-maintenance",
            },
            async (capability) =>
              unregisterHostLoginItemWithAttempt(
                capability,
                this.layout.rootDir,
              ),
          );
          if (outcome.kind !== "acquired") {
            return this.desktopContenderRefusal(outcome);
          }
          removedLoginItem = true;
        }
        let raw: unknown;
        try {
          raw = await this.runBundled<unknown>(["host", "uninstall", "--all"]);
        } catch (err) {
          return this.classifyMutationSubprocessError(err, "retry-with-force");
        }
        const result = parseUninstallResult(raw, true);
        this.hostLifecycle.ensureWatcherInstalled();
        await this.hostLifecycle.reloadSnapshotFromDisk();
        return {
          kind: "ok",
          value: {
            removedHost: result.removedInstallDir,
            deregisteredService: result.serviceUninstalled,
            serviceRegistrationRetained: result.serviceRegistrationRetained,
            removedLoginItem,
          },
        };
      },
    );
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
