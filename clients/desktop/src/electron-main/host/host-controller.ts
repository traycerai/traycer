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


const CLI_STREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
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

// The sole canonical copy (Tech Plan judgment call 3): every caller that used to import this from the now-deleted `app/host-respawn.ts`.
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

const REGISTRY_LIVENESS_STAGE_PREFIX = "registry-";

function isRegistryLivenessStage(stage: string | null): boolean {
  return stage !== null && stage.startsWith(REGISTRY_LIVENESS_STAGE_PREFIX);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


interface ApplyResultShape {
  readonly outcome: "no-op" | "applied" | "stage-fingerprint-mismatch";
  readonly installedVersion: string | null;
  readonly version: string | null;
  // Fixup B9: stamping must decide off what this apply just wrote, never the record it replaced - see the call site in `applyStagedCliOwned`.
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
  /** The command REFUSED under its own lock and left the service untouched, because a parked packaged activation made a generic restart unsafe. */
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
  // Keep this tolerant of the full command envelope as well: recovery is a safety boundary and must never treat a parked safe-stop as a successful relaunch solely because a caller.
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
    // Carried through rather than collapsed, because `serviceUninstalled` above cannot express "unknown" and no platform can verify absence - see `UninstallOk`.
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

// Deliberately NOT a MutationOutcome kind - it must never escape to a caller, and carrying the message (not the built failure) defers `failedAfterServiceCycle`'s reload side effect.
type MacActivationCycleAttempt =
  | MutationOutcome<{ readonly activated: boolean }>
  | {
      readonly kind: "retryable-readiness-timeout";
      readonly message: string;
      readonly prePid: number | null;
      readonly expectedRuntimeVersion: string | null;
    };

interface EligibleStage {
  readonly version: string;
  readonly fingerprint: string;
}

// Pinned against the CLI's real command output by the contract test in `traycer-cli/src/commands/__tests__/host-available.test.ts`.
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
        available:
          entry.yanked !== true &&
          isPlainObject(asset) &&
          asset.available === true,
      },
    ];
  });
  return { valid: true, latest: manifest.latest, versions };
}

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

function installableVersions(snapshot: AvailableSnapshotShape): string[] {
  return snapshot.versions
    .filter((entry) => entry.available)
    .map((entry) => entry.version);
}

export interface HostControllerHostLifecycle {
  notifyRespawning(): void;
  ensureWatcherInstalled(): void;
  reloadSnapshotFromDisk(): Promise<unknown>;
}

export interface HostControllerOptions {
  readonly environment: Environment;
  readonly hostLifecycle: HostControllerHostLifecycle;
  readonly reachabilityProbe: HostEndpointReachabilityProbe;
  readonly desktopLockWaitMs: number;
  readonly desktopLockPollIntervalMs: number;
}

/**
 * `"registered"` carries just enough state for the CALLER to finish the choreography (stamp-runtime CAS + readiness wait) AFTER the lock has released.
 * `"register-failed"` is the SMAppService refusal (`not-found`/`not-registered`/`not-supported`).
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
    }
  /**
   * `registerHostLoginItem` parked before its first bootout: no process was torn down and none was asked for, so a readiness wait here can only time out.
   * Resolved after the lock releases by asking the RUNNING host to restart itself through the CLI (`host restart`, cooperative claim → commit → kickstart).
   */
  | {
      readonly phase: "parked";
      readonly prePid: number | null;
      readonly expectedGeneration: string | null;
      readonly expectedRuntimeVersion: string | null;
    };

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
 * Generation and sequence must be real integers - `Number.isInteger` rather than `typeof number`, because `NaN` and `1.5` are both `number` and neither can name a record.
 */
function decodeParkedIdentity(
  raw: Record<string, unknown>,
): HostUpdateAttemptIdentity | null {
  const attemptId = raw.attemptId;
  const generation = raw.generation;
  const sequence = raw.sequence;
  // `typeof` first so TypeScript narrows, THEN `Number.isInteger` for the values `typeof` calls a number and a record cannot use.
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
 * Two things were wrong with that, and the second is worse than the first: 1. The two sides do not share a discriminator.
 * A mixed-version CLI can emit a shape this build has never seen, and an assertion cannot notice.
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
  private mutationEpoch = 0;

  private pendingRevisionTail: Promise<void> = Promise.resolve();

  private pendingRevisionCycleInFlight: Promise<MutationOutcome<ConvergeReadyOk> | null> | null =
    null;

  // The EFFECTIVE owner policy of the cycle in the slot above, which is not necessarily the policy of the caller that opened it: a within-lane joiner UPGRADES it (see.
  // The reverse admission check reads this rather than its own parameter, because a coalesced call runs once for every caller attached to it.
  private pendingRevisionCycleCaller: PendingRevisionCaller | null = null;

  private pendingRevisionCycleDeferredByLane = false;

  private pendingRevisionCycleDisruptive = false;

  private downloadTail: Promise<void> = Promise.resolve();
  private downloadStatus: DownloadLaneStatus | null = null;
  private downloadAbortController: AbortController | null = null;
  private stageLatestInFlight: Promise<void> | null = null;
  private stageLatestPending = false;
  private eligibleStage: EligibleStage | null = null;

  private latestVersionCache: string | null = null;

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


  /**
   * What would stop an accepted lifecycle write from running ALONE right now, sampled synchronously - or `null` when nothing would.
   * `getStatus()` reads the lane too, but only after three filesystem reads, so its answer is already history by the time a caller sees it.
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
   * Reading this needs no host, which is the entire point: with the host down there is no `host.status` to answer, and without these facts the renderer has no observation at all.
   * An unreadable or absent record both answer `null`, and the field's contract says `null` means "cannot say" rather than "nothing running".
   */
  private async readLocalAttemptFacts(): Promise<LocalAttemptFacts | null> {
    const read = await readUpdateAttemptRecord(this.layout.rootDir);
    if (read.kind !== "valid") return null;
    const record = read.value;
    // The renderer's host-down memorial promises "a failure stays discoverable until it is superseded or ages out", and the store-open prune alone cannot keep the second half: pruning.
    // Retention is therefore also enforced at this read seam.
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


  private readonly inFlightMutations = new Map<
    string,
    Promise<MutationOutcome<unknown> | AbandonedByGuard>
  >();

  // Coalesce that whole intent too, so identical callers cannot duplicate registry probes or automatic download submissions and only join at the mutation body.
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

  // Whatever the job settles with is what EVERY coalesced waiter receives - which is why a guard refusal must be an outcome arm rather than per-caller state (see `AbandonedByGuard`).
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


  private async streamBundled<T>(args: readonly string[]): Promise<T> {
    // Not every caller is inside the mutation lane: `applyPendingLoginItemRevisionIfIdle` (driven by the pending-revision monitor, deliberately not enqueued) reaches the `host service.
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


  private lockBusyOutcome<T>(): MutationOutcome<T> {
    // A held lock means another actor is mid-lifecycle-work; NOTHING ran, so nothing was learned about the host.
    return { kind: "deferred", message: LOCK_BUSY_MESSAGE };
  }

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

  /** A contender refusal is durable update evidence, not an idle-check result: --force cannot make this command legal. */
  private activeUpdateAttemptOutcome<T>(message: string): MutationOutcome<T> {
    return {
      kind: "deferred",
      message: `${message} Attach to or wait for the active host update attempt before retrying.`,
    };
  }


  private async isPackagedMacOwned(): Promise<boolean> {
    return hostManagesHostLoginItem();
  }

  // Production returns `[]`; this never widens prod's `host service install` argv.
  private devServiceInstallExtras(): readonly string[] {
    return this.environment === "dev" ? ["--allow-self-invocation"] : [];
  }

  isPendingRevisionRefreshQuarantined(): boolean {
    return this.pendingRevisionRefreshQuarantined;
  }


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

  // Every branch that starts or cycles a service must complete this sequence before reporting success.
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

  private isCliTakeoverRecoverableStatus(
    status: RegisterHostLoginItemResult,
  ): status is "not-registered" | "not-found" | "not-supported" {
    return (
      status === "not-registered" ||
      status === "not-found" ||
      status === "not-supported"
    );
  }

  private async recoverRegistrationViaCliTakeover(args: {
    readonly failedStatus: HostLoginItemStatus;
    readonly prePid: number | null;
    readonly expectedRuntimeVersion: string | null;
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
    this.pendingRevisionRefreshQuarantined = true;
    log.warn(
      "[host-controller] SMAppService registration failed - falling back to the CLI-owned LaunchAgent",
      { status: args.failedStatus },
    );
    let raw: unknown;
    try {
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
      // The SMAppService cycle may already have cleared the old registration before the fallback CLI call refused.
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
   * It must NOT own or accept free-form caller context.
   * The governing invariant is that *classification may normalize the failure category, but it must never replace caller-only discriminating evidence.
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

  // A service manager acknowledgement or a readiness handshake is not sufficient by itself: the renderer-facing snapshot must still derive as reachable at the moment we report a live.
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
    // This preserves attach/yield guidance for E_HOST_UPDATE_ATTEMPT_ACTIVE and never offers Force for that coordination refusal.
    return this.classifyMutationSubprocessError(err, "retry-with-force");
  }

  private async installedNotConverged<T>(
    message: string,
  ): Promise<MutationOutcome<T>> {
    await this.reloadAfterServiceCycleFailure();
    return { kind: "installed-not-converged", message };
  }

  private async deferredAfterServiceCycle<T>(
    message: string,
  ): Promise<MutationOutcome<T>> {
    await this.reloadAfterServiceCycleFailure();
    return { kind: "deferred", message };
  }


  // The register cycle is itself the repair (bootout + re-register), so the automatic second attempt is precisely what the card's Retry button would ask the user to click.
  // Bounded at one: an unbounded loop would churn disruptive SMAppService cycles forever while the user never learns anything is wrong.
  /**
   * Extracted from `runLockedMacActivationCycleOnce`'s contender callback so that a caller which ALREADY holds the outer update-attempt lock can run the identical actuator without.
   * That second acquisition was a real self-deadlock, not a theoretical one: `withDesktopUpdateContender` acquires the outer lock around its whole callback, so an executor segment.
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
    // Mo-A (finding): a live host + `requires-approval` makes this cycle both futile and destructive.
    // Fail fast BEFORE the bootout and leave the running host untouched.
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
    if (registerResult === "parked") {
      // Also post-lock, for the same reason as `register-failed`: the
      // fallback spawns the CLI, which re-acquires this lock.
      return {
        phase: "parked",
        prePid,
        expectedGeneration,
        expectedRuntimeVersion: record.runtimeVersion,
      };
    }
    if (this.isCliTakeoverRecoverableStatus(registerResult)) {
      return {
        phase: "register-failed",
        status: registerResult,
        prePid,
        expectedRuntimeVersion: record.runtimeVersion,
      };
    }
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
    // This cycle booted a host out; one that survived its own eviction is also reachable, and accepting it would report an activation that never happened.
    // So the late host must be a DIFFERENT process from the one torn down, and must be running what the cycle set out to activate.
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

  /**
   * Finish an activation whose SMAppService register cycle parked.
   * With NO running host the login item's status decides: `enabled` is started through the same CLI cycle (its relaunch half kickstarts the registered agent, which needs no live pid).
   */
  private async activateAroundParkedRegistration(
    step: Extract<LockedMacActivationStep, { phase: "parked" }>,
    force: boolean,
  ): Promise<MutationOutcome<{ readonly activated: boolean }>> {
    if (step.prePid === null) {
      // The pre-lock approval pre-flight is deliberately skipped when no host is running, so this is the first place the condition can be named - and `host doctor` cannot fix it.
      const loginItemStatus = readHostLoginItemStatus();
      if (loginItemStatus === "requires-approval") {
        log.warn(
          "[host-controller] login-item registration parked with no running host - login item requires approval in System Settings",
        );
        return this.failedAfterServiceCycle(approvalRequiredMessage());
      }
      if (loginItemStatus !== "enabled") {
        log.warn(
          "[host-controller] login-item registration parked with no running host to restart",
          { loginItemStatus },
        );
        return this.failedAfterServiceCycle(
          "Traycer Host's login item could not be re-registered and no host is running to restart - run `traycer host doctor` to recover.",
        );
      }
      log.warn(
        "[host-controller] login-item registration parked with no running host but an enabled login item - kickstarting it through the CLI to activate the committed install",
        { force },
      );
    } else {
      log.warn(
        "[host-controller] login-item registration parked - restarting the running host through the CLI to activate the committed install",
        { prePid: step.prePid, force },
      );
    }
    return this.runCliRecoveryServiceCycle(
      force
        ? ["host", "restart", "--force", "--defer-if-parked"]
        : ["host", "restart", "--if-idle", "--defer-if-parked"],
      step.prePid,
    );
  }

  private async runLockedMacActivationCycleOnce(
    force: boolean,
    postCommitContinuation: BusyContinuation,
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
    if (step.phase === "parked") {
      return this.activateAroundParkedRegistration(step, force);
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
    const readiness = await waitForHostReady(
      HOST_READY_TIMEOUT_MS,
      this.layout.pidMetadataFile,
      HOST_READY_POLL_MS,
      prePid,
    );
    if (!readiness.ready) {
      const postWaitStatus = readHostLoginItemStatus();
      log.warn("[host-controller] host did not become ready after activation", {
        reason: readiness.reason,
        loginItemStatus: postWaitStatus,
      });
      if (postWaitStatus === "requires-approval") {
        return this.failedAfterServiceCycle(approvalRequiredMessage());
      }
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

  // Two callers drive this opportunistically, ONLY when the host is idle, so the refresh never interrupts in-progress work: `convergeReadyPackagedMac`'s already-reachable branch (a.
  // Public - not run through `enqueueMutation`.
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
      // The upgrade lands before the check for the whole precheck window (several file/probe awaits).
      // Re-attempt ONCE, never a loop: the retry only happens after a lane-policy refusal, and it runs under `within-lane-job`, which cannot produce another one.
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
    // First, before any I/O: a quarantined session has nothing to learn from
    // the reachability probe, and the monitor ticks this every 30s for the
    // life of the process.
    if (this.pendingRevisionRefreshQuarantined) return null;
    const currentVersion = await readRunningRuntimeVersion(
      this.layout,
      this.reachabilityProbe,
    );
    if (currentVersion === null) return null;
    if (!(await hasUnappliedPendingLoginItemRevision(this.environment)))
      return null;
    if ((await probeHostBusyVerdict(this.layout)) !== "idle") {
      log.debug(
        "[host-controller] pending LaunchAgent revision deferred - host busy",
      );
      return null;
    }
    // Skip AND quarantine for the session: retrying every convergeReady call cannot help (the toggle is the user's alone) and would only churn.
    if (readHostLoginItemStatus() === "requires-approval") {
      this.pendingRevisionRefreshQuarantined = true;
      log.warn(
        "[host-controller] pending LaunchAgent revision quarantined for this session - login item requires approval in System Settings",
      );
      return null;
    }
    // Reverse admission, owner-aware: the *IfIdle handlers refuse while this cycle is committed, and this is the same rule pointed the other way.
    // A WITHIN-LANE caller is that intent - `convergeReady` reaches here from inside its own lane job, where the lane being occupied is not a competitor but the caller itself.
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
    // Raised BEFORE the lock wait, not inside it.
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
        const prePid =
          (await readRunningHostIdentity(this.layout))?.pid ?? null;
        const record = await readDesktopHostInstallRecord(this.layout);
        if (record === null) {
          return {
            status: null,
            prePid,
            expectedGeneration: null,
            expectedRuntimeVersion: null,
          };
        }
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
      // The host this call already confirmed reachable needed no work - reporting `deferred` here would fail an otherwise-healthy convergeReady over work that was never required.
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
    if (status === "parked") {
      this.pendingRevisionRefreshQuarantined = true;
      log.warn(
        "[host-controller] pending LaunchAgent revision quarantined for this session - registration parked (prior registration cannot be restored exactly)",
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


  /** Used at quit time (`update-install-quit.ts`) so the shell never tears down a subprocess mid-swap - it does NOT start a new mutation, only waits for one already in flight. */
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


  async convergeReady(
    force: boolean,
    intent: LocalHostMutationIntent,
  ): Promise<GuardedMutationOutcome<ConvergeReadyOk>> {
    return this.enqueueMutation<GuardedMutationOutcome<ConvergeReadyOk>>(
      "ensure",
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

  private reprovisionCoalesceKeySuffix(
    intent: LocalHostMutationIntent,
  ): string {
    return intent.kind === "background"
      ? "background"
      : `user-repair:${encodeURIComponent(intent.targetHostId)}`;
  }

  private async admitReprovision(
    intent: LocalHostMutationIntent,
  ): Promise<AbandonedByGuard | null> {
    const abandoned = await this.runLaneHeadGuard(intent);
    if (abandoned !== null) return abandoned;
    if (intent.kind === "background") return null;
    if (await isHostRemovedByUser()) {
      await clearHostRemovedByUser();
    }
    return null;
  }

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

  /** An update-attempt refusal is durable coordination evidence, never the user-workload busy condition that a Force action can legitimately retry. */
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
        // Fixup B8: a healthy host with active work is a busy-keep (`host-busy`/`running: true`), never a fatal gate error, on a reconnect/compat ensure.
        return this.hostBusyOutcome<T>(workloadBusyContinuation);
      }
      return { kind: "failed", message: err.message };
    }
    return { kind: "failed", message: describeError(err) };
  }

  // Never starts a NEW download while a mutation owns the host; re-kicked from `enqueueMutation`'s finally once the mutation completes.

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
    // THE INSTALL RECORD IS READ BEFORE THE REGISTRY REQUEST, because it is an input to that request: an installed canonical `X.Y.Z-rc.N` follows its own line with no saved preference.
    const installed = await readDesktopHostInstallRecord(this.layout);
    const installedVersion = installed?.version ?? null;
    const mode = resolveHostChannelMode({
      explicitPrerelease: prereleaseUpdatesEnabled(),
      installedVersion,
    });
    // If `2.0.0` is never published and the work ships as `2.1.0`, a `2.0.0-rc.1` host stays where it is rather than being moved to a line nobody put it on.
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
        if (this.mutationStatus === null && automaticStablePathOpen) {
          await this.runDownloadLane(null);
        } else if (this.mutationStatus !== null) {
          this.stageLatestPending = true;
        }
      }
      return;
    }
    // When this mode picks a candidate, it is pinned by exact version instead.
    const downloadTarget = resolveHostStageTarget({
      mode,
      installedVersion,
      availableVersions: installableVersions(snapshot),
      stableLatest: this.latestVersionCache,
    });
    let migratedLegacyStage = false;
    if (staged?.stageId === null) {
      // A FOLLOWER REPAIRS FROM ITS OWN LINE OR NOT AT ALL: `--automatic` here would repair the stage by fetching another line's stable, so the pinned same-line candidate is used instead.
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
        // Falling through would reach the purge branch below, which requires a fingerprint this stage does not have, and would log "cannot purge an unpinned staged host after registry.
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
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type !== "progress" || this.downloadStatus === null)
              return;
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
        // Fixup C5: this used to unconditionally null `downloadStatus` right after the catch block above wrote `lastError` into it.
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


  applyStaged(
    trigger: ApplyStagedTrigger,
    force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
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


  activateInstalled(
    force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return this.coalesceIntent<ActivateInstalledOk>(
      `activate:${force}`,
      async () => {
        // Match `applyStaged`'s at-most-once freshness retry: the first fingerprint can be invalidated by a replacement stage after the off-lane eligibility pass.
        // Re-check outside the mutation lane, never by reusing stale stage state under the exclusive lock.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await this.awaitDownloadLaneIdle();
          await this.stageLatest();
          await this.awaitDownloadLaneIdle();

          const outcome = await this.enqueueMutation<
            MutationOutcome<ActivateInstalledOk>
          >("activate", `activate:${force}`, async () => {
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
      // One classifier table for every Desktop-owned CLI mutation route  -  an
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
          if (registration.status === "parked") {
            const loginItemStatus = readHostLoginItemStatus();
            if (loginItemStatus !== "enabled") {
              return {
                kind: "failed",
                message:
                  loginItemStatus === "requires-approval"
                    ? approvalRequiredMessage()
                    : `Traycer Host's login item could not be re-registered (status=${loginItemStatus}) - run \`traycer host doctor\` to recover.`,
              };
            }
            // Enabled already, so the registration stands; what the parked cycle left undone is the RESTART a register cycle implies.
            const activated = await this.activateAroundParkedRegistration(
              {
                phase: "parked",
                prePid: registration.prePid,
                expectedGeneration: registration.expectedInstallGeneration,
                expectedRuntimeVersion: registration.expectedRuntimeVersion,
              },
              false,
            );
            return activated.kind === "ok"
              ? { kind: "ok", value: { registered: true } }
              : activated;
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
          await this.streamBundled<unknown>(["host", "service", "uninstall"]);
        } catch (err) {
          return this.classifyMutationSubprocessError(err, "retry-with-force");
        }
        return { kind: "ok", value: { registered: false } };
      },
    );
  }

  /**
   * A direct SMAppService activation would be allowed to register whichever bundle is currently on disk.
   * Do not run readiness or stamp the parked bytes as though a new host had started.
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
      // The command classified the record under ITS lock and refused without touching the service, so the host is in whatever state it was in and the activation continuation is still.
      // `deferred` is the truthful outcome: nothing was promised and nothing was broken.
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


  // The caller deliberately asked for an immediate restart.
  // Coalescing dedupes identical submissions (same key, still in flight), but the key is intent- and target-discriminated, so a watched user repair and a menu/tray background restart.
  private respawnGeneration = 0;

  /**
   * Desktop then reports `{activated: false}` and the machine is left with NO running host and a parked update nobody activated.
   * Only two things diverge from it: a continuation that actually completed, and a live executor that must not be interrupted.
   */
  private async routeForceRestartContinuation(
    /** False on the re-entry, so the recovery arm can run at most once per Force restart - a recovery that lands something still unclaimable must surface, not spin. */
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
        // Acquisition sits BEFORE the write-ahead, so a busy inner lock defers while the record is still `preparing` - rather than terminalizing a staged activation that a park keeps.
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
          if (step.phase === "parked") {
            // The executor segment holds the actuator lock and the parked fallback spawns the CLI, so it cannot run inline.
            return {
              kind: "deferred",
              message:
                "Traycer Host's login item could not be re-registered right now; the update is installed and will finish when the host restarts.",
            };
          }
          if (step.phase === "register-failed") {
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
                      // Same invariant as the takeover-diagnostics ruling earlier in this ticket: classification may normalize the failure CATEGORY, but it must never replace caller-only discriminating.
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
      switch (segment.verification.kind) {
        case "complete":
          return { kind: "ok", value: { activated: true } };
        case "resumed":
        case "failed":
        case "indeterminate":
          // Fall through to the generic restart, which now carries `--defer-if-parked` and so makes the parked-activation decision ITSELF, from the record as it stands, under the same.
          // `recoveryActionFor` in shared calls `restarting/activate` and `verifying/activate` `restart-current`.
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
      // Because acquisition now happens before the `restarting` commit, nothing was promised and the record is truthfully re-parked.
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
   * Dispatch the CLI recovery claimant, then resume normally if it parked one.
   * The reported identity is used only to detect DISAGREEMENT: if the record names a different attempt than the claimant says it parked, something else moved it between the two reads.
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
      // `failed`, `indeterminate`, or a `resumed` that could not name what it parked.
      // In every one of those the record stands as the claimant left it and nothing here may claim otherwise.
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
      // Two background respawns still collapse to one restart; a user repair is its own job so it cannot join a background restart and skip the guard question below.
      `respawn:${this.reprovisionCoalesceKeySuffix(intent)}`,
      async () => {
        // A restart is not a reprovision: it must keep the removed-by-user deferral below and clears nothing.
        // Runs before `notifyRespawning`, which clears the renderer-facing snapshot - an abandoned job must leave no trace it was ever admitted.
        const abandoned = await this.runLaneHeadGuard(intent);
        if (abandoned !== null) return abandoned;
        // After the guard, before any effect: identity decides whether this job may act at all; the generation only decides whether there is anything left to do.
        if (this.respawnGeneration !== generationAtSubmit) {
          return { kind: "ok", value: { activated: true } };
        }
        if (await isHostRemovedByUser()) {
          return { kind: "deferred", message: HOST_REMOVED_BY_USER_MESSAGE };
        }
        // Runs AFTER the removed-by-user deferral (a removed host is not one to continue activating) and BEFORE `notifyRespawning`, because a continuation makes that announcement itself at.
        // Returns null for every state that is not a pending packaged-macOS activation, so the sequence below stays byte-identical.
        const continuation = await this.routeForceRestartContinuation(true);
        if (continuation !== null) {
          // It must satisfy every respawn submitted before it, same rule as the plain path below.
          if (continuation.kind === "ok" && continuation.value.activated) {
            this.respawnGeneration += 1;
          }
          return continuation;
        }
        this.hostLifecycle.notifyRespawning();
        const prePid =
          (await readRunningHostIdentity(this.layout))?.pid ?? null;
        // `--defer-if-parked`: Desktop never wants a stop-without-relaunch.
        // The flag moves the parked-activation decision INSIDE the command's own contender lock, so it is made from the record as it stands when the action runs rather than from a snapshot.
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

  /** `suppressed` when a mutation already owns the host (checked BEFORE submission, so a healthy tick never queues redundant work) or the running host is already reachable once. */
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
          raw = await this.streamBundled<unknown>(
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


  async removeTraycer(): Promise<MutationOutcome<RemoveTraycerOk>> {
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
          // Streamed: see `deregisterService` and `uninstallHost`. This is
          // the third Desktop route that stops a host through the CLI.
          raw = await this.streamBundled<unknown>([
            "host",
            "uninstall",
            "--all",
          ]);
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
