import { readCliManifest } from "../manifest/cli-manifest";
import {
  incumbentMayBeAlive,
  readWindowsRestartSlot,
  sameIncarnation,
  windowsRestartIncumbentSchema,
  type WindowsRestartIncumbent,
} from "../host/windows-restart-incumbent";
import {
  defaultSupervisorRelaunchWaitDeps,
  waitForSupervisorRelaunch,
} from "../host/service-supervisor-relaunch";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
} from "../host/pid-metadata";
import {
  credentialProvisionForResult,
  formatCredentialProvisionNote,
  maybeProvisionCredential,
} from "../host/install-auth";
import { link, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { uptime } from "node:os";
import { probeHostReady } from "@traycer-clients/shared/host-client/host-activity-probe";
import { HOST_START_ADOPTION_MAX_AGE_MS } from "@traycer-clients/shared/host-start-adoption/spawn-edge-bounds";
import { finalizePendingCliUpgrade } from "./cli-upgrade";
import { createCliLogger, type ILogger } from "../logger";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError, isErrnoException } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import {
  cliInstallHomeDir,
  newCliPostFinalizeReceiptPath,
} from "../store/paths";
import {
  withCliAttemptMutation,
  withCliSupervisorRelaunchSegment,
  withCliUpdateContender,
  withCliUpdateExecutionSegment,
} from "../host/update-contender";
import { startHostServiceWithAttempt } from "../host/update-mutation";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import {
  claimWindowsRestartSidecar,
  type PostFinalizeMarker,
  type WindowsServiceObservation,
} from "../upgrade/finalize-helper";
import { publicWindowsCliDiagnostic } from "../upgrade/windows-cli-publication";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import {
  WINDOWS_RESTORE_RECEIPT_WRITE_FAILED,
  WINDOWS_RESTORE_RECEIPT_WRITE_WARNING,
  WINDOWS_RESTORE_UNCONFIRMED,
} from "../service/windows-task-restoration";

interface FinalizeStartObservation {
  started: boolean;
  recoveryClaimed: boolean;
  incumbentNotProvenGone: boolean;
  readonly confirmWindowsStart: boolean;
  readonly abandonedPath: string | null;
  readonly incumbentDeadlineMs: number | null;
  readonly admissionDeadlineMs: number | null;
}

interface DetachedFinalizeOptions {
  readonly legacyDetached?: boolean;
  readonly expectedStagedPath?: string;
  readonly expectedStagedSha256?: string;
  readonly windowsWorkerReceiptId?: string;
}

interface WindowsTaskRestoreResult {
  readonly status: "started" | "restore-failed";
  readonly receiptErrorCode?: typeof WINDOWS_RESTORE_RECEIPT_WRITE_FAILED;
}

export const cliFinalizeUpgradeCommand = buildCliFinalizeUpgradeCommand({});

// The detached helper invokes this command after its parent exits. The
// finalizer uses its own process identity to acquire cli-lock. On lock
// timeout the pending record remains for the next host restart to retry.
export function buildCliFinalizeUpgradeCommand(
  detached: DetachedFinalizeOptions,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    const environment = ctx.runtime.environment;
    const workerMode =
      detached.windowsWorkerReceiptId === undefined
        ? null
        : await readWindowsWorkerAdmission(detached.windowsWorkerReceiptId);
    if (detached.windowsWorkerReceiptId !== undefined && workerMode === null) {
      throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
    }
    const contenderOptions: WithCliUpdateContenderOptions = {
      environment,
      reason: "cli-finalize-upgrade",
      waitMs: 30_000,
      pollIntervalMs: 100,
      admission: "service-maintenance",
    };
    const receiptPath = windowsReceiptPath(
      environment,
      detached.windowsWorkerReceiptId,
    );
    const windowsHandoff =
      process.platform === "win32" && detached.expectedStagedPath !== undefined;
    const start: FinalizeStartObservation = {
      started: false,
      recoveryClaimed: false,
      incumbentNotProvenGone: false,
      incumbentDeadlineMs:
        workerMode?.kind === "start" ? workerMode.incumbentDeadlineMs : null,
      confirmWindowsStart: windowsHandoff,
      abandonedPath:
        workerMode?.kind === "start" ? workerMode.abandonedPath : null,
      admissionDeadlineMs:
        workerMode?.kind === "start" ? workerMode.admissionDeadlineMs : null,
    };
    if (workerMode?.kind === "swap") {
      const result = await withCliUpdateContender(contenderOptions, () =>
        runFinalizeUpgradeSwapWithStart(
          { environment, ...detached, coordinatorOwnsReceipt: true },
          null,
        ),
      ).catch((error: unknown): FinalizeSwapOutcome =>
        error instanceof CliError &&
        (error.code === CLI_ERROR_CODES.CLI_LOCK_BUSY ||
          error.code === CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE)
          ? { status: "lock-timeout" }
          : {
              status: "swap-failed",
              errorMessage: "",
              serviceStartError: null,
            },
      );
      const swapStatus =
        result.status === "swapped" ||
        result.status === "manifest-update-failed" ||
        result.status === "swap-failed"
          ? result.status
          : result.status === "staged-binary-missing"
            ? "swap-failed"
            : "deferred";
      return {
        data: { swapStatus },
        human: "",
        exitCode: 0,
      };
    }
    if (workerMode?.kind === "start") {
      const serviceObservation = await recoverWindowsService(
        environment,
        start,
        workerMode,
      );
      return {
        data: { serviceObservation },
        human:
          serviceObservation.status === "not-ready"
            ? WINDOWS_RESTORE_UNCONFIRMED
            : "",
        exitCode: serviceObservation.status === "not-ready" ? 1 : 0,
      };
    }
    let outcome: FinalizeSwapOutcome;
    try {
      outcome = await withCliUpdateContender(contenderOptions, (capability) =>
        runFinalizeUpgradeSwapWithAttempt(
          {
            environment,
            ...detached,
            receiptPath,
          },
          capability,
          contenderOptions,
          start,
        ),
      );
    } catch (err) {
      // Admission refusals leave the swap pending. Only the existing recovery
      // start can owe a credential probe, after its own lock is released.
      if (
        err instanceof CliError &&
        (err.code === CLI_ERROR_CODES.CLI_LOCK_BUSY ||
          err.code === CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE)
      ) {
        if (err.code === CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE) {
          await startBesideUpdateAttempt(environment, start);
        }
        outcome = { status: "lock-timeout" };
      } else if (windowsHandoff) {
        outcome = {
          status: "swap-failed",
          errorMessage: "The CLI upgrade could not finish.",
          serviceStartError: null,
        };
      } else {
        throw err;
      }
    }
    let serviceRestore: WindowsTaskRestoreResult | null = null;
    if (windowsHandoff) {
      if (start.started) {
        serviceRestore = { status: "started" };
      } else {
        serviceRestore = await recordWindowsRestoreFailure(
          environment,
          receiptPath,
          detached.expectedStagedPath,
        );
      }
    }
    if (serviceRestore !== null && "serviceStartError" in outcome) {
      outcome = {
        ...outcome,
        serviceStartError:
          serviceRestore.status === "started"
            ? null
            : WINDOWS_RESTORE_UNCONFIRMED,
      };
    }
    const credentialProvision = start.started
      ? await maybeProvisionCredential(ctx, "start", null)
      : null;
    const note = formatCredentialProvisionNote(credentialProvision);
    const human =
      process.platform === "win32"
        ? humanForWindowsOutcome(outcome)
        : humanForOutcome(outcome);
    const data =
      process.platform === "win32"
        ? windowsFinalizeResult(outcome)
        : outcome.status === "swap-failed"
          ? { status: outcome.status, errorMessage: outcome.errorMessage }
          : outcome;
    return {
      data: {
        ...data,
        ...(serviceRestore !== null && {
          serviceRestore: serviceRestore.status,
        }),
        ...(serviceRestore?.receiptErrorCode !== undefined && {
          serviceRestoreReceiptErrorCode: serviceRestore.receiptErrorCode,
        }),
        credentialProvision: credentialProvisionForResult(credentialProvision),
      },
      human: [
        human,
        serviceRestore?.status === "restore-failed" &&
        !("serviceStartError" in outcome)
          ? WINDOWS_RESTORE_UNCONFIRMED
          : null,
        serviceRestore?.receiptErrorCode === undefined
          ? null
          : WINDOWS_RESTORE_RECEIPT_WRITE_WARNING,
        note,
      ]
        .filter((part) => part !== null)
        .join("; "),
      exitCode: 0,
    };
  };
}

async function recordWindowsRestoreFailure(
  environment: Environment,
  markerPath: string,
  stagedBinaryPath: string | undefined,
): Promise<WindowsTaskRestoreResult> {
  const manifest = await readCliManifest(environment).catch(() => null);
  const marker: PostFinalizeMarker = {
    status: "swap-failed",
    attemptedAt: new Date().toISOString(),
    livePath: manifest?.binaryPath ?? "",
    stagedBinaryPath:
      stagedBinaryPath ?? manifest?.pendingUpgrade?.stagedBinaryPath ?? "",
    errorMessage: "The CLI upgrade is still pending.",
    serviceStartError: WINDOWS_RESTORE_UNCONFIRMED,
  };
  try {
    await writePostFinalizeMarkerFile(markerPath, marker);
  } catch (error) {
    if (error instanceof FinalizeReceiptAlreadyWritten) {
      return { status: "restore-failed" };
    }
    createCliLogger(environment).warn(
      WINDOWS_RESTORE_RECEIPT_WRITE_WARNING,
      {},
    );
    return {
      status: "restore-failed",
      receiptErrorCode: WINDOWS_RESTORE_RECEIPT_WRITE_FAILED,
    };
  }
  return { status: "restore-failed" };
}

function windowsReceiptPath(
  environment: Environment,
  workerReceiptId: string | undefined,
): string {
  return workerReceiptId === undefined
    ? newCliPostFinalizeReceiptPath(environment)
    : join(
        cliInstallHomeDir(environment),
        `post-finalize.${workerReceiptId}.json`,
      );
}

type WindowsWorkerAdmission =
  | { readonly kind: "swap" }
  | {
      readonly kind: "start";
      readonly admissionDeadlineMs: number;
      readonly incumbent: WindowsRestartIncumbent;
      readonly incumbentDeadlineMs: number;
      readonly abandonedPath: string;
      readonly stop: "not-issued" | "effect-unknown" | "stopped";
    };

async function readWindowsWorkerAdmission(
  receiptId: string,
): Promise<WindowsWorkerAdmission | null> {
  if (
    process.platform !== "win32" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(receiptId)
  )
    return null;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (line === "swap") return { kind: line };
      const start =
        /^start ([0-9]+) ([0-9]+) (stopped|not-issued|effect-unknown) ([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+)$/u.exec(
          line,
        );
      if (start === null) return null;
      const admissionDeadlineMs = Number(start[1]);
      const incumbentDeadlineMs = Number(start[2]);
      const stop = start[3];
      if (
        !Number.isSafeInteger(admissionDeadlineMs) ||
        !Number.isSafeInteger(incumbentDeadlineMs) ||
        incumbentDeadlineMs > admissionDeadlineMs ||
        (stop !== "not-issued" &&
          stop !== "effect-unknown" &&
          stop !== "stopped")
      )
        return null;
      const incumbent = windowsRestartIncumbentSchema.parse(
        JSON.parse(Buffer.from(start[4], "base64url").toString("utf8")),
      );
      return {
        kind: "start",
        admissionDeadlineMs,
        incumbentDeadlineMs,
        abandonedPath: Buffer.from(start[5], "base64url").toString("utf8"),
        stop,
        incumbent,
      };
    }
    return null;
  } finally {
    input.close();
  }
}

function windowsFinalizeResult(outcome: FinalizeSwapOutcome) {
  return {
    status: outcome.status,
    ...("version" in outcome && { version: outcome.version }),
    ...("previousVersion" in outcome && {
      previousVersion: outcome.previousVersion,
    }),
    ...("installedVersion" in outcome && {
      installedVersion: outcome.installedVersion,
    }),
    ...("stagedVersion" in outcome && { stagedVersion: outcome.stagedVersion }),
    ...("errorMessage" in outcome && {
      errorMessage: publicWindowsCliDiagnostic(
        outcome.errorMessage,
        "The CLI upgrade is still pending.",
      ),
    }),
    ...("serviceStartError" in outcome && {
      serviceStartError:
        outcome.serviceStartError === null ? null : WINDOWS_RESTORE_UNCONFIRMED,
    }),
  };
}

function humanForWindowsOutcome(outcome: FinalizeSwapOutcome): string {
  const { status, errorMessage, serviceStartError } =
    windowsFinalizeResult(outcome);
  const summary = {
    swapped: "The CLI upgrade finished.",
    "swap-failed": errorMessage ?? "The CLI upgrade is still pending.",
    "manifest-update-failed":
      "The CLI was installed. Its manifest update is pending reconciliation.",
    "staged-binary-missing":
      "The staged CLI is missing. Retry with 'traycer cli upgrade'.",
    "installed-newer": "The installed CLI is newer than the staged upgrade.",
    "no-pending": "There is no pending CLI upgrade.",
    "lock-timeout":
      "The CLI upgrade is still pending. Retry with 'traycer host restart'.",
  }[status];
  return serviceStartError ? `${summary} ${serviceStartError}` : summary;
}

export type FinalizeSwapOutcome =
  | {
      readonly status: "swapped";
      readonly previousVersion: string;
      readonly version: string;
      readonly serviceStartError: string | null;
    }
  | {
      readonly status: "swap-failed";
      readonly errorMessage: string;
      readonly serviceStartError: string | null;
    }
  | {
      readonly status: "manifest-update-failed";
      readonly previousVersion: string;
      readonly version: string;
      readonly errorMessage: string;
      readonly serviceStartError: string | null;
    }
  // The manifest still records a pendingUpgrade, but the file it points
  // at is gone (audit CLI-015). Kept distinct from `no-pending`: the two
  // describe opposite persisted states, and collapsing them reported
  // "nothing to finalize" while the manifest was still asking every
  // future restart to finalize a file that no longer exists.
  | {
      readonly status: "staged-binary-missing";
      readonly stagedVersion: string;
      readonly stagedBinaryPath: string;
      readonly livePath: string;
    }
  // The staged binary is below the installed version, so it was not
  // published. Distinct from `swap-failed`: nothing was attempted and
  // nothing went wrong - see the `installed-newer` outcome in
  // `cli-upgrade.ts` for why the manifest is read as untrusted input.
  | {
      readonly status: "installed-newer";
      readonly stagedVersion: string;
      readonly installedVersion: string;
      readonly serviceStartError: string | null;
    }
  | {
      readonly status: "no-pending";
      readonly serviceStartError: string | null;
    }
  | { readonly status: "lock-timeout" };

// Core: assumes the caller already holds cli-lock (matches the
// "core assumes caller holds lock" pattern used throughout this ticket
// - installer/apply.ts, restartWithPendingCliUpgradeFinalize). Kept
// separate from the command wrapper so tests can exercise it without
// lock machinery.
export async function runFinalizeUpgradeSwap(
  opts: {
    readonly environment: Environment;
  },
  startService: () => Promise<void>,
): Promise<FinalizeSwapOutcome> {
  return runFinalizeUpgradeSwapWithStart(opts, startService);
}

async function runFinalizeUpgradeSwapWithAttempt(
  opts: {
    readonly environment: Environment;
    readonly receiptPath: string;
  } & DetachedFinalizeOptions,
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  start: FinalizeStartObservation,
): Promise<FinalizeSwapOutcome> {
  return runFinalizeUpgradeSwapWithStart(opts, async () => {
    await startHostWithAttempt(
      opts.environment,
      capability,
      contenderOptions,
      start,
    );
  });
}

async function startHostWithAttempt(
  environment: Environment,
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
  start: FinalizeStartObservation,
): Promise<void> {
  const label = serviceLabelFor(environment);
  if (start.admissionDeadlineMs !== null && recoveryAdmissionWait(start) === 0)
    throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
  const controller = createServiceController();
  const abandonedPath = start.abandonedPath;
  const outcome = await startHostServiceWithAttempt(
    capability,
    contenderOptions,
    "maintenance",
    abandonedPath === null
      ? controller
      : {
          ...controller,
          beforeWindowsRecoveryRun: async () => {
            const incumbentDeadline = start.incumbentDeadlineMs ?? 0;
            const fresh = await waitForSupervisorRelaunch(environment, {
              ...defaultSupervisorRelaunchWaitDeps,
              now: windowsRecoveryClock,
              waitMs: Math.max(0, incumbentDeadline - windowsRecoveryClock()),
              observe: async () => {
                const slot = await readWindowsRestartSlot(environment);
                if (slot === "runtime-current") return "host-ready";
                return slot === "empty" ? "supervisor-gone" : null;
              },
            });
            start.incumbentNotProvenGone = fresh.kind === "timed-out";
            if (
              fresh.kind !== "supervisor-gone" ||
              recoveryAdmissionWait(start) === 0
            )
              throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
            start.recoveryClaimed =
              await claimWindowsRestartSidecar(abandonedPath);
            if (!start.recoveryClaimed)
              throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
          },
        },
    label,
    start.confirmWindowsStart ? () => undefined : undefined,
  );
  start.started = outcome.kind === "started";
}

async function observeWindowsReadyRuntime(
  environment: Environment,
  incumbent: WindowsRestartIncumbent["runtime"],
  remainingMs: number,
): Promise<Extract<
  WindowsServiceObservation,
  { status: "endpoint-ready" }
> | null> {
  const before = await readHostPidMetadata(environment);
  if (
    before === null ||
    !isValidLocalHostWebsocketUrl(before.websocketUrl) ||
    sameIncarnation(incumbent, before.pid, before.processStartIdentity) ||
    (await getPublishedProcessIdentityVerdict(
      before.pid,
      before.processStartIdentity,
    )) !== "current" ||
    !(await probeHostReady(before.websocketUrl, remainingMs))
  )
    return null;

  const after = await readHostPidMetadata(environment);
  return after !== null &&
    after.pid === before.pid &&
    after.processStartIdentity === before.processStartIdentity &&
    after.websocketUrl === before.websocketUrl &&
    after.version === before.version &&
    (await getPublishedProcessIdentityVerdict(
      after.pid,
      after.processStartIdentity,
    )) === "current"
    ? {
        status: "endpoint-ready",
        metadataRuntimeVersion: after.version,
        pidRecordCurrentBeforeAndAfter: true,
      }
    : null;
}

function windowsRecoveryClock(): number {
  return Math.floor(uptime() * 1000);
}

async function restartWithdrawn(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function recoverWindowsService(
  environment: Environment,
  start: FinalizeStartObservation,
  mode: Extract<WindowsWorkerAdmission, { kind: "start" }>,
): Promise<WindowsServiceObservation> {
  const now = windowsRecoveryClock;
  const notChecked = { status: "not-checked", stop: mode.stop } as const;
  if (await restartWithdrawn(mode.abandonedPath)) return notChecked;
  const observe = (remaining: number) =>
    observeWindowsReadyRuntime(environment, mode.incumbent.runtime, remaining);
  let ready: WindowsServiceObservation | null = null;
  const incumbentWait = await waitForSupervisorRelaunch(environment, {
    ...defaultSupervisorRelaunchWaitDeps,
    now,
    waitMs: Math.max(0, mode.incumbentDeadlineMs - now()),
    observe: async () => {
      if (await incumbentMayBeAlive(mode.incumbent, mode.stop === "stopped"))
        return null;
      const slot = await readWindowsRestartSlot(environment);
      if (slot === "runtime-current") return "host-ready";
      return slot === "empty" ? "supervisor-gone" : null;
    },
  });
  if (incumbentWait.kind === "timed-out")
    return { status: "incumbent-not-proven-gone", stop: mode.stop };

  if (incumbentWait.kind === "supervisor-gone" && mode.stop !== "not-issued") {
    await startBesideUpdateAttempt(environment, start).catch(() => undefined);
    if (!start.recoveryClaimed && (await restartWithdrawn(mode.abandonedPath)))
      return notChecked;
    if (start.incumbentNotProvenGone)
      return { status: "incumbent-not-proven-gone", stop: mode.stop };
    if (
      !start.started &&
      (await readWindowsRestartSlot(environment)) === "empty"
    )
      return { status: "not-ready" };
  }
  const readyUntil = mode.admissionDeadlineMs + HOST_START_ADOPTION_MAX_AGE_MS;
  await waitForSupervisorRelaunch(environment, {
    ...defaultSupervisorRelaunchWaitDeps,
    now,
    waitMs: Math.max(0, readyUntil - now()),
    observe: async (remaining) => {
      ready = await observe(remaining);
      return ready === null ? null : "host-ready";
    },
  });
  return ready ?? { status: "not-ready" };
}

/**
 * The start this command owes when a standing update attempt refused its
 * swap.
 *
 * On Windows this command runs as the detached helper that completes a
 * `host restart` (`commands/host-restart.ts`), and that restart - admitted
 * under `recovery-maintenance` - has already STOPPED the service and left the
 * start to this command. `service-maintenance` refuses every nonterminal
 * record, so a routine park that admitted the stop refused the start that
 * completes it, and the host stayed down.
 *
 * The swap stays deferred exactly as before: no marker, `pendingUpgrade`
 * kept, so the next `host restart` finalizes it. Only the start runs, and
 * under one of two admissions, in this order:
 *
 *  1. as the service's own supervisor relaunch is
 *     (`withCliSupervisorRelaunchSegment`): parked for work, parked on an
 *     activation of the installed generation, or interrupted in a phase
 *     whose own next act is that start;
 *  2. where that refuses, as the restart it completes was: under
 *     `recovery-maintenance`, and only for a record whose recovery action is
 *     `restart-current` - the verdict that restart stopped the host under
 *     (`commands/host-restart.ts`). A POSIX restart relaunches in-process
 *     under that same verdict, so the helper's start now matches it.
 *
 * A stop-only record (`applying`, `preparing` to activate,
 * `waiting-to-activate`) is left to the attempt's own continuation, and a
 * busy lock leaves the host as it is - the outcome before this existed.
 */
async function startBesideUpdateAttempt(
  environment: Environment,
  start: FinalizeStartObservation,
): Promise<void> {
  const logger = createCliLogger(environment);
  try {
    await startAsSupervisorRelaunch(environment, logger, start);
    return;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    if (err.code === CLI_ERROR_CODES.CLI_LOCK_BUSY) {
      logStartNotAdmitted(environment, logger, err.code);
      return;
    }
    if (err.code !== CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE) throw err;
  }
  try {
    await startAsRestartCompletion(environment, logger, start);
  } catch (err) {
    if (
      err instanceof CliError &&
      (err.code === CLI_ERROR_CODES.CLI_LOCK_BUSY ||
        err.code === CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE)
    ) {
      logStartNotAdmitted(environment, logger, err.code);
      return;
    }
    throw err;
  }
}

function recoveryAdmissionWait(start: FinalizeStartObservation): number {
  return start.admissionDeadlineMs === null
    ? 30_000
    : Math.max(
        0,
        Math.min(
          30_000,
          start.admissionDeadlineMs - Math.floor(uptime() * 1000),
        ),
      );
}

async function startAsSupervisorRelaunch(
  environment: Environment,
  logger: ILogger,
  start: FinalizeStartObservation,
): Promise<void> {
  const relaunchOptions: WithCliUpdateContenderOptions = {
    environment,
    reason: "cli-finalize-upgrade",
    waitMs: recoveryAdmissionWait(start),
    pollIntervalMs: 100,
    admission: "supervisor-relaunch-maintenance",
  };
  await withCliSupervisorRelaunchSegment(
    relaunchOptions,
    (capability, context) =>
      withCliAttemptMutation(
        capability,
        { ...relaunchOptions, waitMs: recoveryAdmissionWait(start) },
        async () => {
          logger.info(
            "Finalize-upgrade deferred its CLI swap and is starting the installed host beside a standing update attempt",
            {
              environment,
              attemptId: context.activeAttempt?.attemptId ?? null,
              phase: context.activeAttempt?.phase ?? null,
            },
          );
          await startServiceBestEffort(
            () =>
              startHostWithAttempt(
                environment,
                capability,
                relaunchOptions,
                start,
              ),
            environment,
            logger,
          );
        },
      ),
  );
}

async function startAsRestartCompletion(
  environment: Environment,
  logger: ILogger,
  start: FinalizeStartObservation,
): Promise<void> {
  const recoveryOptions: WithCliUpdateContenderOptions = {
    environment,
    reason: "cli-finalize-upgrade",
    waitMs: recoveryAdmissionWait(start),
    pollIntervalMs: 100,
    admission: "recovery-maintenance",
  };
  await withCliUpdateExecutionSegment(
    recoveryOptions,
    async (capability, context) => {
      const attempt = {
        environment,
        attemptId: context.activeAttempt?.attemptId ?? null,
        phase: context.activeAttempt?.phase ?? null,
      };
      if (context.recoveryAction !== "restart-current") {
        logger.info(
          "Finalize-upgrade left the host as it was: the standing update attempt's own continuation starts it",
          attempt,
        );
        return;
      }
      await withCliAttemptMutation(
        capability,
        { ...recoveryOptions, waitMs: recoveryAdmissionWait(start) },
        async () => {
          logger.info(
            "Finalize-upgrade deferred its CLI swap and is starting the installed host to complete the restart that stopped it",
            attempt,
          );
          await startServiceBestEffort(
            () =>
              startHostWithAttempt(
                environment,
                capability,
                recoveryOptions,
                start,
              ),
            environment,
            logger,
          );
        },
      );
    },
  );
}

function logStartNotAdmitted(
  environment: Environment,
  logger: ILogger,
  code: string,
): void {
  logger.info(
    "Finalize-upgrade left the host as it was: the standing update attempt does not admit its start",
    { environment, code },
  );
}

async function runFinalizeUpgradeSwapWithStart(
  opts: {
    readonly environment: Environment;
    readonly receiptPath?: string;
    readonly coordinatorOwnsReceipt?: boolean;
  } & DetachedFinalizeOptions,
  startService: (() => Promise<void>) | null,
): Promise<FinalizeSwapOutcome> {
  const logger = createCliLogger(opts.environment);
  const markerPath =
    opts.receiptPath ?? newCliPostFinalizeReceiptPath(opts.environment);
  const writeReceipt = async (marker: PostFinalizeMarker): Promise<void> => {
    if (opts.coordinatorOwnsReceipt === true) return;
    await writePostFinalizeMarkerFile(markerPath, marker);
  };
  const handBack = (): Promise<string | null> =>
    startService === null
      ? Promise.resolve(null)
      : startServiceBestEffort(startService, opts.environment, logger);
  const swap = await finalizePendingCliUpgrade(opts);
  logger.info("Finalize-upgrade swap attempted", {
    environment: opts.environment,
    status: swap.status,
  });

  // Keep the existing registration. A committed helper owns the one start.
  //
  // This holds even for `no-pending`: the restart stops the service and
  // schedules the helper WITHOUT first checking that there will still be
  // something to finalize, so "nothing pending" here means another actor
  // cleared it in between - not that the service is up. The only
  // production callers are the two helper scripts in
  // `upgrade/finalize-helper.ts`, both of which run in exactly that
  // state; the command is hidden and has no other invocation path.
  if (swap.status === "no-pending" || swap.status === "no-manifest") {
    const serviceStartError = await handBack();
    if (serviceStartError !== null) {
      // The helper runs detached with output redirected away. Preserve a
      // failed hand-back in the cross-version marker format even though no
      // upgrade identity remains; reconciliation's no-pending/no-manifest
      // branch intentionally consumes this without identity correlation.
      await writeReceipt({
        status: "swap-failed",
        attemptedAt: new Date().toISOString(),
        livePath: "",
        stagedBinaryPath: "",
        errorMessage:
          "no pending CLI upgrade remained when the finalize helper ran",
        serviceStartError,
      });
    }
    return { status: "no-pending", serviceStartError };
  }

  if (swap.status === "staged-binary-missing") {
    // The pending record outlived the file it points at (cleanup, AV,
    // a wiped tmpdir). `pendingUpgrade` is deliberately RETAINED rather
    // than cleared: it is the only remaining evidence that the user
    // asked for an upgrade they never received, and Doctor already
    // renders it as "CLI upgrade staged but staged binary is missing"
    // with `traycer cli upgrade` as the recovery command. Clearing it
    // here would silently erase that request; re-downloading here would
    // turn the finalize helper - which runs detached, after its parent
    // exited - into a network operation nobody is watching.
    //
    // The marker reuses the `swap-failed` status on purpose. Marker
    // files cross CLI versions (the STAGED binary writes one, the
    // still-LIVE older binary reads it), and an unrecognised status
    // reads as `marker-invalid` on every already-installed CLI. The
    // errorMessage carries the distinction that matters.
    const serviceStartError = await handBack();
    await writeReceipt({
      status: "swap-failed",
      attemptedAt: new Date().toISOString(),
      livePath: swap.livePath,
      stagedBinaryPath: swap.stagedBinaryPath,
      errorMessage: `staged binary for ${swap.stagedVersion} is missing at ${swap.stagedBinaryPath}`,
      serviceStartError,
    });
    return {
      status: "staged-binary-missing",
      stagedVersion: swap.stagedVersion,
      stagedBinaryPath: swap.stagedBinaryPath,
      livePath: swap.livePath,
    };
  }

  if (swap.status === "installed-newer") {
    // Hand the host back like every other non-swap outcome. A marker is
    // written only to carry a service-start failure, as the no-pending
    // branch does: there is no swap failure to reconcile, and a
    // `swap-failed` marker written unconditionally would report one. It
    // leaves `pendingUpgrade` standing either way, which is what this
    // outcome wants - the staged record is superseded, not wrong.
    //
    // The marker keeps both paths, so `markerDescribesUpgrade` MATCHES the
    // pending record it was written beside. That is why doctor gives the
    // version ordering precedence over a matching `swap-failed` marker: left
    // alone it reported this state as a failed finalization with a
    // host-restart fix. The identity is kept rather than blanked because the
    // alternative - the empty-path marker the no-pending branch writes - is
    // read as "no pending CLI upgrade remained", which is not true here.
    const serviceStartError = await handBack();
    if (serviceStartError !== null) {
      await writeReceipt({
        status: "swap-failed",
        attemptedAt: new Date().toISOString(),
        livePath: swap.livePath,
        stagedBinaryPath: swap.stagedBinaryPath,
        errorMessage: `staged cli ${swap.stagedVersion} was not installed over the newer installed ${swap.installedVersion}`,
        serviceStartError,
      });
    }
    return {
      status: "installed-newer",
      stagedVersion: swap.stagedVersion,
      installedVersion: swap.installedVersion,
      serviceStartError,
    };
  }

  // `publish-failed` and `still-locked` are the same shape of outcome:
  // the swap did not happen, the live binary is untouched, and
  // `pendingUpgrade` stands. Both must still hand the host back.
  if (swap.status === "publish-failed" || swap.status === "still-locked") {
    const serviceStartError = await handBack();
    await writeReceipt({
      status: "swap-failed",
      attemptedAt: new Date().toISOString(),
      livePath: swap.livePath,
      stagedBinaryPath: swap.stagedBinaryPath,
      errorMessage: swap.errorMessage,
      serviceStartError,
    });
    return {
      status: "swap-failed",
      errorMessage: swap.errorMessage,
      serviceStartError,
    };
  }

  if (swap.status === "manifest-update-failed") {
    const serviceStartError = await handBack();
    await writeReceipt({
      status: "swapped",
      attemptedAt: new Date().toISOString(),
      livePath: swap.livePath,
      stagedBinaryPath: swap.stagedBinaryPath,
      errorMessage: swap.errorMessage,
      serviceStartError,
    });
    return {
      status: "manifest-update-failed",
      previousVersion: swap.previousVersion,
      version: swap.version,
      errorMessage: swap.errorMessage,
      serviceStartError,
    };
  }

  // swap.status === "finalised"
  const serviceStartError = await handBack();
  await writeReceipt({
    status: "swapped",
    attemptedAt: new Date().toISOString(),
    livePath: swap.binaryPath,
    stagedBinaryPath: "",
    errorMessage: null,
    serviceStartError,
  });
  return {
    status: "swapped",
    previousVersion: swap.previousVersion,
    version: swap.version,
    serviceStartError,
  };
}

// Hand the host back. Best-effort by design: this runs on paths that are
// already reporting a failure, and a service-start error must be recorded
// rather than replace the outcome the caller needs to see. The returned
// message goes into the marker's `serviceStartError` so the next CLI
// invocation's reconcile can surface it.
async function startServiceBestEffort(
  // The INJECTED start, never a raw controller call: under the maintenance
  // capability the thunk is `startHostServiceWithAttempt`, and a raw start
  // here would hand the host back outside the attempt gate on exactly the
  // paths that report failures.
  startService: () => Promise<void>,
  environment: Environment,
  logger: ILogger,
): Promise<string | null> {
  try {
    await startService();
    return null;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn("Finalize-upgrade service start failed", {
      environment,
      errorMessage,
    });
    return errorMessage;
  }
}

class FinalizeReceiptAlreadyWritten extends Error {}

export async function writePostFinalizeMarkerFile(
  markerPath: string,
  marker: PostFinalizeMarker,
): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  const tmpPath = `${markerPath}.${randomUUID()}.tmp`;
  const handle = await open(tmpPath, "wx");
  try {
    try {
      await handle.writeFile(JSON.stringify(marker));
    } finally {
      await handle.close();
    }
    try {
      await link(tmpPath, markerPath);
    } catch (error) {
      if (isErrnoException(error) && error.code === "EEXIST") {
        throw new FinalizeReceiptAlreadyWritten(
          WINDOWS_RESTORE_RECEIPT_WRITE_WARNING,
        );
      }
      throw error;
    }
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function humanForOutcome(outcome: FinalizeSwapOutcome): string {
  switch (outcome.status) {
    case "swapped":
      return outcome.serviceStartError !== null
        ? `finalized cli upgrade ${outcome.previousVersion} -> ${outcome.version}; service did not start: ${outcome.serviceStartError}`
        : `finalized cli upgrade ${outcome.previousVersion} -> ${outcome.version}`;
    case "swap-failed":
      return `cli finalize-upgrade: swap failed (${outcome.errorMessage}); pending state retained`;
    case "manifest-update-failed":
      return `cli finalize-upgrade: installed ${outcome.version}, but could not update the CLI manifest (${outcome.errorMessage}); reconciliation marker retained`;
    case "staged-binary-missing":
      return (
        `cli finalize-upgrade: staged binary for ${outcome.stagedVersion} is missing at ` +
        `${outcome.stagedBinaryPath}; pending state retained. ` +
        "Re-run 'traycer cli upgrade' to re-stage it."
      );
    case "installed-newer": {
      const summary = `cli finalize-upgrade: staged ${outcome.stagedVersion} was not installed; the cli is already at ${outcome.installedVersion}`;
      return outcome.serviceStartError === null
        ? summary
        : `${summary}; service did not start: ${outcome.serviceStartError}`;
    }
    case "no-pending":
      return outcome.serviceStartError === null
        ? "cli finalize-upgrade: nothing to finalize"
        : `cli finalize-upgrade: nothing to finalize; service did not start: ${outcome.serviceStartError}`;
    case "lock-timeout":
      return "cli finalize-upgrade: timed out acquiring cli-lock; deferring to the next 'host restart'";
  }
}
