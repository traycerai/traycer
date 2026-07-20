import { log } from "../app/logger";
import {
  hasPendingLoginItemRevision,
  hostManagesHostLoginItem,
  readHostLoginItemStatus,
  registerHostLoginItem,
  unregisterHostLoginItem,
  type RegisterHostLoginItemResult,
} from "../app/host-login-item";
import {
  runBundledTraycerCliJson,
  streamBundledTraycerCliJson,
  TraycerCliError,
  type NdjsonEvent,
} from "../cli/traycer-cli";
import { withDesktopCliLock } from "./desktop-cli-lock";
import {
  getHostFsLayout,
  cliLockPath,
  type Environment,
  type HostFsLayout,
} from "./host-paths";
import {
  HOST_READY_POLL_MS,
  HOST_READY_TIMEOUT_MS,
  waitForHostReady,
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
  readRunningHostIdentity,
  readRunningRuntimeVersion,
  type DesktopHostInstallRecord,
} from "./host-state";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ApplyStagedTrigger,
  BusyContinuation,
  ConvergeReadyOk,
  DownloadLaneStatus,
  HostControllerIntent,
  HostControllerStatus,
  InstallVersionOk,
  MutationKind,
  MutationLaneStatus,
  MutationOutcome,
  MutationProgress,
  RemoveTraycerOk,
  ServiceRegistrationOk,
  UninstallOk,
} from "./host-controller-types";

// Single main-process owner of every host-lifecycle mutation (Host Update
// Layer Redesign Tech Plan, "Desktop main: HostController"). Every writer
// that used to shell out to the CLI or the platform service-manager
// directly now submits an intent here instead - see the ticket's "Single-
// writer cutover" for the exhaustive list of call sites this replaces.

const CLI_STREAM_TIMEOUT_MS = 10 * 60_000;
const DESKTOP_LOCK_WAIT_MS = 30_000;
const DESKTOP_LOCK_POLL_INTERVAL_MS = 100;
const CLI_LOCK_BUSY_CODE = "E_CLI_LOCK_BUSY";
const HOST_BUSY_CODE = "E_HOST_BUSY";
const LOCK_BUSY_MESSAGE = "Another Traycer process is managing the host.";

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

function noopProgress(): MutationProgress {
  return {
    stage: null,
    percent: null,
    bytes: null,
    totalBytes: null,
    message: null,
  };
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
  };
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
  readonly outcome: "no-op" | "applied";
  readonly installedVersion: string | null;
  readonly version: string | null;
  readonly runningActivated: boolean;
  readonly installGeneration: string | null;
  readonly postSwapError: string | null;
}

function parseApplyResult(raw: unknown): ApplyResultShape {
  if (!isPlainObject(raw) || raw.outcome === "no-op") {
    const installedVersion =
      isPlainObject(raw) && typeof raw.installedVersion === "string"
        ? raw.installedVersion
        : null;
    return {
      outcome: "no-op",
      installedVersion,
      version: null,
      runningActivated: false,
      installGeneration: null,
      postSwapError: null,
    };
  }
  const record = isPlainObject(raw.record) ? raw.record : null;
  return {
    outcome: "applied",
    installedVersion: null,
    version:
      record !== null && typeof record.version === "string"
        ? record.version
        : null,
    runningActivated: raw.runningActivated === true,
    installGeneration:
      typeof raw.installGeneration === "string" ? raw.installGeneration : null,
    postSwapError:
      typeof raw.postSwapError === "string" ? raw.postSwapError : null,
  };
}

interface InstallResultShape {
  readonly version: string | null;
  readonly installGeneration: string | null;
  readonly postSwapError: string | null;
  readonly postSwapAction: string | null;
}

function parseInstallResult(raw: unknown): InstallResultShape {
  if (!isPlainObject(raw)) {
    return {
      version: null,
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
    "noop" | "installed" | "service-registered" | "started" | null;
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
}

function parseStampRuntimeResult(raw: unknown): StampRuntimeResultShape {
  if (!isPlainObject(raw)) return { outcome: null };
  return {
    outcome:
      raw.outcome === "stamped" || raw.outcome === "superseded"
        ? raw.outcome
        : null,
  };
}

interface UninstallResultShape {
  readonly removedInstallDir: boolean;
  readonly removedStagedDir: boolean;
  readonly serviceUninstalled: boolean;
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
    };
  }
  return {
    removedInstallDir:
      raw.removedInstallDir === true || raw.removedRecord === true,
    removedStagedDir: raw.removedStagedDir === true,
    serviceUninstalled:
      raw.serviceUninstalled === true ||
      (all && raw.serviceUninstalled !== false),
  };
}

interface AvailableSnapshotShape {
  readonly latest: string;
  readonly versions: ReadonlyArray<{
    readonly version: string;
    readonly available: boolean;
  }>;
}

function parseAvailableSnapshot(raw: unknown): AvailableSnapshotShape {
  if (
    !isPlainObject(raw) ||
    typeof raw.latest !== "string" ||
    !Array.isArray(raw.versions)
  ) {
    return { latest: "", versions: [] };
  }
  const versions = raw.versions.flatMap((entry) => {
    if (!isPlainObject(entry) || typeof entry.version !== "string") return [];
    const asset = isPlainObject(entry.platformAsset)
      ? entry.platformAsset
      : null;
    return [
      {
        version: entry.version,
        available: asset !== null && asset.available === true,
      },
    ];
  });
  return { latest: raw.latest, versions };
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
}

export class HostController {
  private readonly environment: Environment;
  private readonly layout: HostFsLayout;
  private readonly lockPath: string;
  private readonly hostLifecycle: HostControllerHostLifecycle;

  private mutationTail: Promise<void> = Promise.resolve();
  private mutationStatus: MutationLaneStatus | null = null;

  private downloadTail: Promise<void> = Promise.resolve();
  private downloadStatus: DownloadLaneStatus | null = null;
  private downloadAbortController: AbortController | null = null;
  private stageLatestPending = false;

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
  }

  // ---- Canonical status --------------------------------------------------

  async getStatus(): Promise<HostControllerStatus> {
    const installed = await readDesktopHostInstallRecord(this.layout);
    const staged = await readDesktopHostStagedRecord(this.layout);
    const runningRuntimeVersion = await readRunningRuntimeVersion(this.layout);
    const installedVersion = installed?.version ?? null;
    const installedRuntimeVersion = installed?.runtimeVersion ?? null;
    return {
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

  private enqueueMutation<T>(
    kind: MutationKind,
    fn: () => Promise<MutationOutcome<T>>,
  ): Promise<MutationOutcome<T>> {
    const job = this.mutationTail.then(async () => {
      this.mutationStatus = {
        kind,
        progress: null,
        startedAt: new Date().toISOString(),
      };
      try {
        return await fn();
      } catch (err) {
        log.warn("[host-controller] mutation intent threw", { kind, err });
        return {
          kind: "failed",
          message: describeError(err),
        } as MutationOutcome<T>;
      } finally {
        this.mutationStatus = null;
        if (this.stageLatestPending) {
          this.stageLatestPending = false;
          void this.stageLatest();
        }
      }
    });
    this.mutationTail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private setMutationProgress(progress: MutationProgress): void {
    if (this.mutationStatus === null) return;
    this.mutationStatus = { ...this.mutationStatus, progress };
    for (const listener of this.progressListeners) {
      try {
        listener(progress);
      } catch (err) {
        log.warn("[host-controller] mutation progress listener threw", {
          err: describeError(err),
        });
      }
    }
  }

  // Legacy renderer shim support: IPC handlers that used to broadcast
  // `cliOperationProgress` / `hostOperationStatusChange` themselves (the
  // now-removed `trackHostOperation`) subscribe here for the duration of
  // their own call to keep re-emitting those events, without the controller
  // needing to know anything about IPC channels or renderer-minted
  // operation ids. Since the mutation lane is exclusive FIFO, a listener
  // registered immediately before submitting an intent only ever observes
  // progress for that intent - nothing else can be running concurrently.
  private progressListeners = new Set<(progress: MutationProgress) => void>();

  onMutationProgress(
    listener: (progress: MutationProgress) => void,
  ): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  // ---- Shared CLI invocation helpers --------------------------------------

  private async streamBundled<T>(args: readonly string[]): Promise<T> {
    const result = await streamBundledTraycerCliJson<T>({
      args,
      env: null,
      timeoutMs: CLI_STREAM_TIMEOUT_MS,
      onEvent: (event) => {
        if (event.type === "progress") {
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

  private lockBusyOutcome<T>(isConvergeReady: boolean): MutationOutcome<T> {
    return isConvergeReady
      ? { kind: "failed", message: `${LOCK_BUSY_MESSAGE} Retry.` }
      : { kind: "deferred", message: LOCK_BUSY_MESSAGE };
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

  private async stampIfNullRuntime(
    expectedInstallGeneration: string | null,
    prePid: number | null,
  ): Promise<void> {
    if (expectedInstallGeneration === null) return;
    const readiness = await waitForHostReady(
      HOST_READY_TIMEOUT_MS,
      this.layout.pidMetadataFile,
      HOST_READY_POLL_MS,
      prePid,
    );
    if (!readiness.ready) {
      log.warn(
        "[host-controller] stamp-runtime skipped - readiness not observed after a null-runtime cycle",
        {
          environment: this.environment,
        },
      );
      return;
    }
    const identity = await readRunningHostIdentity(this.layout);
    if (identity === null) {
      log.warn(
        "[host-controller] stamp-runtime skipped - no running host identity after readiness",
        {
          environment: this.environment,
        },
      );
      return;
    }
    try {
      const outcome = parseStampRuntimeResult(
        await this.runBundled<unknown>([
          "host",
          "stamp-runtime",
          "--expected-install-generation",
          expectedInstallGeneration,
          "--observed-pid",
          String(identity.pid),
          "--observed-started-at",
          identity.startedAt,
          "--observed-runtime-version",
          identity.version,
        ]),
      );
      log.info("[host-controller] stamp-runtime completed", {
        outcome: outcome.outcome,
      });
    } catch (err) {
      log.warn("[host-controller] stamp-runtime call failed", {
        err: describeError(err),
      });
    }
  }

  // ---- Shared locked macOS SMAppService activation cycle ------------------
  //
  // Used by BOTH `activateInstalled` directly and `applyStaged`'s packaged-
  // macOS branch (after its own non-disruptive bytes-only apply already
  // committed the record) - the choreography past that point is identical:
  // re-read state under the desktop-held lock, probe busy, cycle
  // SMAppService, wait for readiness, stamp if the record was null.

  private async runLockedMacActivationCycle(
    force: boolean,
    postCommitContinuation: BusyContinuation,
  ): Promise<MutationOutcome<{ readonly activated: boolean }>> {
    const outcome = await withDesktopCliLock(
      {
        lockPath: this.lockPath,
        reason: "host-controller-activate",
        waitMs: DESKTOP_LOCK_WAIT_MS,
        pollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
      },
      async () => {
        // Re-read install/pid state after acquisition (lock rule 3) - a
        // superseding mutation may have landed while we waited.
        const record = await readDesktopHostInstallRecord(this.layout);
        if (record === null) {
          return {
            kind: "failed",
            message: "No host installed.",
          } as MutationOutcome<{ readonly activated: boolean }>;
        }
        if (!force) {
          const verdict = await probeHostBusyVerdict(this.layout);
          if (verdict === "busy") {
            return this.hostBusyOutcome<{ readonly activated: boolean }>(
              postCommitContinuation,
            );
          }
        }
        const prePid =
          (await readRunningHostIdentity(this.layout))?.pid ?? null;
        const expectedGeneration =
          record.runtimeVersion === null
            ? attestedInstallGenerationFromDisk(record)
            : null;
        const registerResult: RegisterHostLoginItemResult =
          await registerHostLoginItem(undefined);
        if (registerResult === "removed-by-user") {
          return {
            kind: "failed",
            message: "Host was removed by the user.",
          } as MutationOutcome<{
            readonly activated: boolean;
          }>;
        }
        if (registerResult === "deferred-busy") {
          return this.hostBusyOutcome<{ readonly activated: boolean }>(
            postCommitContinuation,
          );
        }
        if (
          registerResult === "not-registered" ||
          registerResult === "not-found" ||
          registerResult === "not-supported"
        ) {
          return {
            kind: "failed",
            message: `Failed to register the host login item (status=${registerResult}).`,
          } as MutationOutcome<{ readonly activated: boolean }>;
        }
        // `requires-approval` still means the plist is registered - launchd
        // will start it once the user approves it in System Settings; we
        // still wait for readiness (it may already be approved from a prior
        // cycle) but the activation-failure semantics classify a timeout as
        // the approval message rather than a generic readiness failure.
        await this.stampIfNullRuntime(expectedGeneration, prePid);
        const readiness = await waitForHostReady(
          HOST_READY_TIMEOUT_MS,
          this.layout.pidMetadataFile,
          HOST_READY_POLL_MS,
          prePid,
        );
        if (!readiness.ready) {
          const message =
            registerResult === "requires-approval"
              ? approvalRequiredMessage()
              : `Traycer Host did not start within ${HOST_READY_TIMEOUT_MS}ms - run \`traycer host doctor\` to recover.`;
          return { kind: "failed", message } as MutationOutcome<{
            readonly activated: boolean;
          }>;
        }
        this.hostLifecycle.ensureWatcherInstalled();
        await this.hostLifecycle.reloadSnapshotFromDisk();
        return { kind: "ok", value: { activated: true } } as MutationOutcome<{
          readonly activated: boolean;
        }>;
      },
    );
    if (outcome.kind === "busy") {
      return this.lockBusyOutcome(false);
    }
    return outcome.result;
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
  // every poll tick just to reach this check. Returns the converged result
  // when this path fully handled the call (refreshed, removed-by-user, or a
  // terminal refresh failure), or `null` when there was nothing to do (not
  // reachable, no marker, quarantined, or the host is busy).
  async applyPendingLoginItemRevisionIfIdle(): Promise<MutationOutcome<ConvergeReadyOk> | null> {
    const currentVersion = await readRunningRuntimeVersion(this.layout);
    if (currentVersion === null) return null;
    if (this.pendingRevisionRefreshQuarantined) return null;
    if (!(await hasPendingLoginItemRevision(this.environment))) return null;
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
    const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
    const outcome = await withDesktopCliLock(
      {
        lockPath: this.lockPath,
        reason: "host-controller-pending-revision-refresh",
        waitMs: DESKTOP_LOCK_WAIT_MS,
        pollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
      },
      async () =>
        // The busy probe above can go stale while this cycle waits its turn
        // on the shared registration lock (a concurrent respawn/activation
        // cycle can be mid-cycle right now) - re-check right before the
        // bootout actually runs, so a host that picked up real work while
        // queued isn't killed anyway.
        registerHostLoginItem(
          async () => (await probeHostBusyVerdict(this.layout)) === "idle",
        ),
    );
    if (outcome.kind === "busy") {
      // Desktop-lock contention is transient, not terminal - some other
      // controller-driven SMAppService section is mid-cycle right now.
      // Skip this opportunistic refresh silently rather than failing an
      // otherwise-healthy convergeReady call.
      log.debug(
        "[host-controller] pending LaunchAgent revision deferred - desktop lock busy",
      );
      return null;
    }
    const status = outcome.result;
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
    if (status !== "enabled") {
      this.pendingRevisionRefreshQuarantined = true;
      log.warn(
        "[host-controller] pending LaunchAgent revision refresh did not enable the agent",
        { status },
      );
      return {
        kind: "failed",
        message: `The host's macOS login item could not be enabled (status: ${status}). Open Doctor or run 'traycer host doctor' to recover.`,
      };
    }
    const record = await readDesktopHostInstallRecord(this.layout);
    const expectedGeneration =
      record !== null && record.runtimeVersion === null
        ? attestedInstallGenerationFromDisk(record)
        : null;
    await this.stampIfNullRuntime(expectedGeneration, prePid);
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
      return {
        kind: "failed",
        message: `The host's background service was refreshed but did not become reachable in time (${readiness.reason}). Open Doctor or run 'traycer host doctor' to recover.`,
      };
    }
    log.info("[host-controller] pending LaunchAgent revision applied", {
      version: readiness.version ?? currentVersion,
      pid: readiness.pid,
    });
    this.hostLifecycle.ensureWatcherInstalled();
    await this.hostLifecycle.reloadSnapshotFromDisk();
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
   * matching every other quit-path step.
   */
  async awaitMutationLaneIdle(timeoutMs: number): Promise<boolean> {
    const tail = this.mutationTail;
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
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    return this.enqueueMutation<ConvergeReadyOk>("ensure", async () => {
      if (await isHostRemovedByUser()) {
        return { kind: "ok", value: { running: false, version: null } };
      }
      if (await this.isPackagedMacOwned()) {
        return this.convergeReadyPackagedMac(force);
      }
      return this.convergeReadyCliOwned(force);
    });
  }

  private async convergeReadyCliOwned(
    force: boolean,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>(
        force ? ["host", "ensure", "--force"] : ["host", "ensure"],
      );
    } catch (err) {
      return this.classifyEnsureLikeError(err, true);
    }
    const result = parseEnsureResult(raw);
    if (result.action !== "noop") {
      await this.stampIfNullRuntime(
        result.runtimeVersion === null ? result.installGeneration : null,
        prePid,
      );
    }
    this.hostLifecycle.ensureWatcherInstalled();
    await this.hostLifecycle.reloadSnapshotFromDisk();
    return {
      kind: "ok",
      value: {
        running: result.running,
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
      return this.classifyEnsureLikeError(err, true);
    }
    const result = parseEnsureResult(raw);
    // Bytes-only ensure never starts the service itself - if the host is
    // already reachable we're done, modulo one opportunistic check: apply
    // a pending LaunchAgent revision if the host has been idle since it
    // was last cycled (see `applyPendingLoginItemRevisionIfIdle`).
    // Otherwise drive the same locked register cycle `activateInstalled`
    // uses so SMAppService (re-)starts it and picks up the plist revision.
    const runningRuntimeVersion = await readRunningRuntimeVersion(this.layout);
    if (runningRuntimeVersion !== null) {
      const refreshed = await this.applyPendingLoginItemRevisionIfIdle();
      if (refreshed !== null) return refreshed;
      return {
        kind: "ok",
        value: { running: true, version: runningRuntimeVersion },
      };
    }
    const activation = await this.runLockedMacActivationCycle(
      force,
      "activate",
    );
    if (activation.kind !== "ok") {
      return activation as MutationOutcome<ConvergeReadyOk>;
    }
    const version = await readRunningRuntimeVersion(this.layout);
    return {
      kind: "ok",
      value: { running: true, version: version ?? result.version },
    };
  }

  private classifyEnsureLikeError<T>(
    err: unknown,
    isConvergeReady: boolean,
  ): MutationOutcome<T> {
    if (err instanceof TraycerCliError) {
      if (err.code === CLI_LOCK_BUSY_CODE)
        return this.lockBusyOutcome<T>(isConvergeReady);
      if (err.code === HOST_BUSY_CODE) {
        return isConvergeReady
          ? { kind: "failed", message: err.message }
          : this.hostBusyOutcome<T>("retry-with-force");
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

  async stageLatest(): Promise<void> {
    if (this.mutationStatus !== null) {
      this.stageLatestPending = true;
      return;
    }
    await this.reconcileEligibleStage();
  }

  // Split out from `stageLatest` so `applyStaged`'s own preflight reconcile
  // (the "apply awaits any in-flight-or-due eligibility reconcile" ordering
  // edge) can run this directly while ITS OWN mutation-lane job is active -
  // `stageLatest`'s `mutationStatus !== null` guard exists to keep a
  // background/independent download from starting during a mutation; it
  // must not also block a mutation's own preflight step against itself.
  private async reconcileEligibleStage(): Promise<void> {
    if (await isHostRemovedByUser()) return;
    let snapshot: AvailableSnapshotShape;
    try {
      snapshot = parseAvailableSnapshot(
        await this.runBundled<unknown>(["host", "available", "--json"]),
      );
    } catch (err) {
      log.debug("[host-controller] registry probe failed (silent)", {
        err: describeError(err),
      });
      return;
    }
    this.latestVersionCache = latestVersionFromSnapshot(snapshot);
    const installed = await readDesktopHostInstallRecord(this.layout);
    const staged = await readDesktopHostStagedRecord(this.layout);
    const installedVersion = installed?.version ?? null;
    const eligible =
      staged !== null ||
      (this.latestVersionCache !== null &&
        installedVersion !== null &&
        isStrictlyNewerHostVersion(this.latestVersionCache, installedVersion));
    if (!eligible) return;
    await this.runDownloadLane(null);
  }

  private async runDownloadLane(explicitVersion: string | null): Promise<void> {
    const job = this.downloadTail.then(async () => {
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
          timeoutMs: CLI_STREAM_TIMEOUT_MS,
          onEvent: (event) => {
            if (event.type !== "progress" || this.downloadStatus === null)
              return;
            this.downloadStatus = {
              ...this.downloadStatus,
              progress: {
                percent: event.percent,
                bytes: event.bytes,
                totalBytes: event.totalBytes,
              },
            };
          },
        });
      } catch (err) {
        if (!controller.signal.aborted) {
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
        this.downloadStatus = null;
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

  // ---- applyStaged -----------------------------------------------------

  async applyStaged(
    trigger: ApplyStagedTrigger,
    force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    return this.enqueueMutation<ApplyStagedOk>("apply", async () => {
      if (trigger === "launch" && (await isHostRemovedByUser())) {
        return { kind: "deferred", message: "Host was removed by the user." };
      }
      // Ordering edge: await any in-flight-or-due eligibility reconcile for
      // the staged version before re-reading `updateReady`. Offline policy:
      // a registry-unreachable reconcile still proceeds with the signed
      // stage (yank is curation; the minisign signature is the security
      // boundary) - `stageLatest`'s own probe failure is already silent.
      await this.awaitDownloadLaneIdle();
      await this.reconcileEligibleStage();
      await this.awaitDownloadLaneIdle();

      const installed = await readDesktopHostInstallRecord(this.layout);
      const staged = await readDesktopHostStagedRecord(this.layout);
      if (
        !deriveUpdateReady(
          installed?.version ?? null,
          staged?.version ?? null,
        ) &&
        staged === null
      ) {
        return {
          kind: "ok",
          value: {
            appliedVersion: installed?.version ?? "",
            runningActivated: true,
          },
        };
      }

      if (await this.isPackagedMacOwned()) {
        return this.applyStagedPackagedMac();
      }
      return this.applyStagedCliOwned(force);
    });
  }

  private async applyStagedCliOwned(
    force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
    const preRecord = await readDesktopHostInstallRecord(this.layout);
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>(
        force ? ["host", "apply", "--force"] : ["host", "apply"],
      );
    } catch (err) {
      return this.classifyApplyLikeError(err, "retry-with-force");
    }
    const result = parseApplyResult(raw);
    if (result.outcome === "no-op") {
      return {
        kind: "ok",
        value: {
          appliedVersion: result.installedVersion ?? "",
          runningActivated: true,
        },
      };
    }
    if (preRecord !== null && preRecord.runtimeVersion === null) {
      await this.stampIfNullRuntime(result.installGeneration, prePid);
    }
    this.hostLifecycle.ensureWatcherInstalled();
    await this.hostLifecycle.reloadSnapshotFromDisk();
    return {
      kind: "ok",
      value: {
        appliedVersion: result.version ?? "",
        runningActivated: result.runningActivated,
      },
    };
  }

  private async applyStagedPackagedMac(): Promise<
    MutationOutcome<ApplyStagedOk>
  > {
    let raw: unknown;
    try {
      raw = await this.streamBundled<unknown>([
        "host",
        "apply",
        "--no-service",
      ]);
    } catch (err) {
      // `--no-service` never busy-checks CLI-side, so any error here is a
      // genuine apply failure, not a pre-commit busy signal.
      return this.classifyApplyLikeError(err, "retry-with-force");
    }
    const result = parseApplyResult(raw);
    if (result.outcome === "no-op") {
      return {
        kind: "ok",
        value: {
          appliedVersion: result.installedVersion ?? "",
          runningActivated: true,
        },
      };
    }
    // Bytes are committed unconditionally at this point - any busy/failure
    // from here on is POST-COMMIT (continuation: "activate").
    const activation = await this.runLockedMacActivationCycle(
      false,
      "activate",
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
    if (err instanceof TraycerCliError) {
      if (err.code === CLI_LOCK_BUSY_CODE)
        return this.lockBusyOutcome<T>(false);
      if (err.code === HOST_BUSY_CODE)
        return this.hostBusyOutcome<T>(continuation);
      return { kind: "failed", message: err.message };
    }
    return { kind: "failed", message: describeError(err) };
  }

  // ---- activateInstalled -------------------------------------------------

  async activateInstalled(
    force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return this.enqueueMutation<ActivateInstalledOk>("activate", async () => {
      // A ready update supersedes activation debt - prevents the
      // restart-old -> stamp -> restart-new double cycle.
      const installed = await readDesktopHostInstallRecord(this.layout);
      const staged = await readDesktopHostStagedRecord(this.layout);
      if (
        deriveUpdateReady(installed?.version ?? null, staged?.version ?? null)
      ) {
        const applied = await this.applyStagedInline(force);
        return applied.kind === "ok"
          ? { kind: "ok", value: { activated: applied.value.runningActivated } }
          : applied;
      }
      if (await this.isPackagedMacOwned()) {
        return this.runLockedMacActivationCycle(force, "activate");
      }
      return this.activateInstalledCliOwned(force);
    });
  }

  // `activateInstalled` may need to run `applyStaged`'s own body when a
  // ready update supersedes debt, but it's already inside the mutation
  // lane (enqueueMutation would deadlock on itself) - this re-runs
  // `applyStaged`'s logic directly rather than re-entering the lane.
  private async applyStagedInline(
    force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>> {
    await this.awaitDownloadLaneIdle();
    await this.reconcileEligibleStage();
    await this.awaitDownloadLaneIdle();
    if (await this.isPackagedMacOwned()) {
      return this.applyStagedPackagedMac();
    }
    return this.applyStagedCliOwned(force);
  }

  private async activateInstalledCliOwned(
    force: boolean,
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    const record = await readDesktopHostInstallRecord(this.layout);
    if (record === null) {
      return { kind: "failed", message: "No host installed." };
    }
    const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
    const expectedGeneration =
      record.runtimeVersion === null
        ? attestedInstallGenerationFromDisk(record)
        : null;
    try {
      await this.streamBundled<unknown>(
        force ? ["host", "restart"] : ["host", "restart", "--if-idle"],
      );
    } catch (err) {
      if (err instanceof TraycerCliError) {
        if (err.code === CLI_LOCK_BUSY_CODE) return this.lockBusyOutcome(false);
        if (err.code === HOST_BUSY_CODE)
          return this.hostBusyOutcome("retry-with-force");
      }
      return { kind: "failed", message: describeError(err) };
    }
    await this.stampIfNullRuntime(expectedGeneration, prePid);
    this.hostLifecycle.ensureWatcherInstalled();
    await this.hostLifecycle.reloadSnapshotFromDisk();
    return { kind: "ok", value: { activated: true } };
  }

  // ---- installVersion (pins) ---------------------------------------------

  async installVersion(
    pin: string,
    force: boolean,
  ): Promise<MutationOutcome<InstallVersionOk>> {
    return this.enqueueMutation<InstallVersionOk>("install", async () => {
      // Explicit reinstall clears the removed-by-user sentinel (host-
      // removal-state.ts: "Cleared by an explicit reinstall").
      if (await isHostRemovedByUser()) {
        await clearHostRemovedByUser();
      }
      if (await this.isPackagedMacOwned()) {
        return this.installVersionPackagedMac(pin);
      }
      return this.installVersionCliOwned(pin, force);
    });
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
      return this.classifyApplyLikeError(err, "retry-with-force");
    }
    const result = parseInstallResult(raw);
    await this.stampIfNullRuntime(result.installGeneration, prePid);
    this.hostLifecycle.ensureWatcherInstalled();
    await this.hostLifecycle.reloadSnapshotFromDisk();
    const runningRuntimeVersion = await readRunningRuntimeVersion(this.layout);
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
      return { kind: "failed", message: describeError(err) };
    }
    const result = parseInstallResult(raw);
    // Bytes committed unconditionally - any busy/failure from here on is
    // post-commit (continuation: "activate"), same as apply's mac path.
    const activation = await this.runLockedMacActivationCycle(
      false,
      "activate",
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

  async registerService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return this.enqueueMutation<ServiceRegistrationOk>("register", async () => {
      if (await this.isPackagedMacOwned()) {
        const outcome = await withDesktopCliLock(
          {
            lockPath: this.lockPath,
            reason: "host-controller-register",
            waitMs: DESKTOP_LOCK_WAIT_MS,
            pollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
          },
          async () => registerHostLoginItem(undefined),
        );
        if (outcome.kind === "busy") return this.lockBusyOutcome(false);
        const status = outcome.result;
        if (status === "enabled" || status === "requires-approval") {
          return { kind: "ok", value: { registered: true } };
        }
        return {
          kind: "failed",
          message: `Failed to register the host login item (status=${status}).`,
        };
      }
      try {
        await this.runBundled<unknown>([
          "host",
          "service",
          "install",
          ...this.devServiceInstallExtras(),
        ]);
      } catch (err) {
        if (err instanceof TraycerCliError && err.code === CLI_LOCK_BUSY_CODE)
          return this.lockBusyOutcome(false);
        return { kind: "failed", message: describeError(err) };
      }
      return { kind: "ok", value: { registered: true } };
    });
  }

  async deregisterService(): Promise<MutationOutcome<ServiceRegistrationOk>> {
    return this.enqueueMutation<ServiceRegistrationOk>(
      "deregister",
      async () => {
        if (await this.isPackagedMacOwned()) {
          const outcome = await withDesktopCliLock(
            {
              lockPath: this.lockPath,
              reason: "host-controller-deregister",
              waitMs: DESKTOP_LOCK_WAIT_MS,
              pollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
            },
            async () => unregisterHostLoginItem(),
          );
          if (outcome.kind === "busy") return this.lockBusyOutcome(false);
          return { kind: "ok", value: { registered: false } };
        }
        try {
          await this.runBundled<unknown>(["host", "service", "uninstall"]);
        } catch (err) {
          if (err instanceof TraycerCliError && err.code === CLI_LOCK_BUSY_CODE)
            return this.lockBusyOutcome(false);
          return { kind: "failed", message: describeError(err) };
        }
        return { kind: "ok", value: { registered: false } };
      },
    );
  }

  // ---- respawn / recoverIfDown --------------------------------------------

  // `respawn` is always force=true (unconditional `host restart` / a
  // force-activation cycle, never `--if-idle`): it is the explicit "restart
  // the host now" intent - Settings → Restart Host, a doctor-recommended
  // restart, the health monitor's recovery hook. The caller deliberately
  // asked for an immediate restart; silently downgrading to "only if idle"
  // would make the action a no-op exactly when the user is trying to
  // recover from a stuck host, which is the case it exists for.
  async respawn(): Promise<MutationOutcome<ActivateInstalledOk>> {
    return this.enqueueMutation<ActivateInstalledOk>("respawn", async () => {
      this.hostLifecycle.notifyRespawning();
      if (await this.isPackagedMacOwned()) {
        return this.runLockedMacActivationCycle(true, "activate");
      }
      const prePid = (await readRunningHostIdentity(this.layout))?.pid ?? null;
      const record = await readDesktopHostInstallRecord(this.layout);
      const expectedGeneration =
        record !== null && record.runtimeVersion === null
          ? attestedInstallGenerationFromDisk(record)
          : null;
      try {
        await this.streamBundled<unknown>(["host", "restart"]);
      } catch (err) {
        if (err instanceof TraycerCliError && err.code === CLI_LOCK_BUSY_CODE)
          return this.lockBusyOutcome(false);
        return { kind: "failed", message: describeError(err) };
      }
      await this.stampIfNullRuntime(expectedGeneration, prePid);
      this.hostLifecycle.ensureWatcherInstalled();
      await this.hostLifecycle.reloadSnapshotFromDisk();
      return { kind: "ok", value: { activated: true } };
    });
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
    return this.enqueueMutation<ActivateInstalledOk>(
      "recoverIfDown",
      async () => {
        const runningRuntimeVersion = await readRunningRuntimeVersion(
          this.layout,
        );
        if (runningRuntimeVersion !== null) {
          return { kind: "ok", value: { activated: true } };
        }
        if (await isHostRemovedByUser()) {
          return { kind: "deferred", message: "Host was removed by the user." };
        }
        if (await this.isPackagedMacOwned()) {
          return this.runLockedMacActivationCycle(true, "activate");
        }
        try {
          await this.streamBundled<unknown>(["host", "restart"]);
        } catch (err) {
          if (err instanceof TraycerCliError && err.code === CLI_LOCK_BUSY_CODE)
            return this.lockBusyOutcome(false);
          return { kind: "failed", message: describeError(err) };
        }
        this.hostLifecycle.ensureWatcherInstalled();
        await this.hostLifecycle.reloadSnapshotFromDisk();
        return { kind: "ok", value: { activated: true } };
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
  ): Promise<MutationOutcome<ActivateInstalledOk>> {
    return this.enqueueMutation<ActivateInstalledOk>(
      "freePortAndRestart",
      async () => {
        if (await this.isPackagedMacOwned()) {
          if (pid !== null && port !== null) {
            try {
              await this.runBundled<unknown>([
                "host",
                "free-port",
                "--pid",
                String(pid),
                "--port",
                String(port),
              ]);
            } catch (err) {
              if (
                err instanceof TraycerCliError &&
                err.code === CLI_LOCK_BUSY_CODE
              )
                return this.lockBusyOutcome(false);
              return { kind: "failed", message: describeError(err) };
            }
          }
          return this.runLockedMacActivationCycle(true, "activate");
        }
        const args = ["host", "free-port-and-restart"];
        if (pid !== null) args.push("--pid", String(pid));
        if (port !== null) args.push("--port", String(port));
        try {
          await this.streamBundled<unknown>(args);
        } catch (err) {
          if (err instanceof TraycerCliError && err.code === CLI_LOCK_BUSY_CODE)
            return this.lockBusyOutcome(false);
          return { kind: "failed", message: describeError(err) };
        }
        this.hostLifecycle.ensureWatcherInstalled();
        await this.hostLifecycle.reloadSnapshotFromDisk();
        return { kind: "ok", value: { activated: true } };
      },
    );
  }

  // ---- uninstallHost (Settings; no sentinel) -------------------------------

  async uninstallHost(all: boolean): Promise<MutationOutcome<UninstallOk>> {
    return this.enqueueMutation<UninstallOk>("uninstallHost", async () => {
      if (all && (await this.isPackagedMacOwned())) {
        const outcome = await withDesktopCliLock(
          {
            lockPath: this.lockPath,
            reason: "host-controller-uninstall",
            waitMs: DESKTOP_LOCK_WAIT_MS,
            pollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
          },
          async () => unregisterHostLoginItem(),
        );
        if (outcome.kind === "busy") return this.lockBusyOutcome(false);
      }
      let raw: unknown;
      try {
        raw = await this.runBundled<unknown>(
          all ? ["host", "uninstall", "--all"] : ["host", "uninstall"],
        );
      } catch (err) {
        if (err instanceof TraycerCliError && err.code === CLI_LOCK_BUSY_CODE)
          return this.lockBusyOutcome(false);
        return { kind: "failed", message: describeError(err) };
      }
      const result = parseUninstallResult(raw, all);
      this.hostLifecycle.ensureWatcherInstalled();
      await this.hostLifecycle.reloadSnapshotFromDisk();
      return {
        kind: "ok",
        value: {
          removedInstallDir: result.removedInstallDir,
          deregisteredService: result.serviceUninstalled,
        },
      };
    });
  }

  // ---- removeTraycer (Danger Zone; sentinel + BTM cleanup) -----------------

  async removeTraycer(): Promise<MutationOutcome<RemoveTraycerOk>> {
    // Persist the sentinel FIRST, before entering the lane, so any
    // already-queued automatic intent that hasn't executed yet observes it
    // the moment it runs (functional "cancel queued automatic intents" -
    // they still execute their job body but immediately no-op).
    await markHostRemovedByUser();
    this.abortInFlightDownload();
    return this.enqueueMutation<RemoveTraycerOk>("removeTraycer", async () => {
      let removedLoginItem = false;
      if (await this.isPackagedMacOwned()) {
        const outcome = await withDesktopCliLock(
          {
            lockPath: this.lockPath,
            reason: "host-controller-remove",
            waitMs: DESKTOP_LOCK_WAIT_MS,
            pollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
          },
          async () => unregisterHostLoginItem(),
        );
        if (outcome.kind === "busy") return this.lockBusyOutcome(false);
        removedLoginItem = true;
      }
      let raw: unknown;
      try {
        raw = await this.runBundled<unknown>(["host", "uninstall", "--all"]);
      } catch (err) {
        if (err instanceof TraycerCliError && err.code === CLI_LOCK_BUSY_CODE)
          return this.lockBusyOutcome(false);
        return { kind: "failed", message: describeError(err) };
      }
      const result = parseUninstallResult(raw, true);
      this.hostLifecycle.ensureWatcherInstalled();
      await this.hostLifecycle.reloadSnapshotFromDisk();
      return {
        kind: "ok",
        value: {
          removedHost: result.removedInstallDir,
          deregisteredService: result.serviceUninstalled,
          removedLoginItem,
        },
      };
    });
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
