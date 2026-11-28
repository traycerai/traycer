import {
  credentialProvisionForResult,
  formatCredentialProvisionNote,
  maybeProvisionCredential,
} from "../host/install-auth";
import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import { probeHostReachable } from "@traycer-clients/shared/host-client/host-activity-probe";
import { HOST_START_ADOPTION_MAX_AGE_MS } from "@traycer-clients/shared/host-start-adoption/spawn-edge-bounds";
import { windowsProcessStartIdentityMicros } from "@traycer/protocol/host/lifecycle";
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
import type { PostFinalizeMarker } from "../upgrade/finalize-helper";
import { publicWindowsCliDiagnostic } from "../upgrade/windows-cli-publication";
import { readCliManifest } from "../manifest/cli-manifest";
import { readHostInstallRecord } from "../manifest/host-install";
import { readLiveSupervisorRun } from "../host/live-supervisor-run";
import { probeHostHealth } from "../service/health-probe";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import {
  WINDOWS_RESTORE_RECEIPT_WRITE_FAILED,
  WINDOWS_RESTORE_RECEIPT_WRITE_WARNING,
  WINDOWS_RESTORE_STAGE_PREFIX,
  WINDOWS_RESTORE_UNCONFIRMED,
} from "../service/windows-task-restoration";

interface FinalizeStartObservation {
  started: boolean;
  readonly confirmWindowsStart: boolean;
  readonly reportStage: ((stage: "start" | "receipt") => void) | null;
}

interface DetachedFinalizeOptions {
  readonly legacyDetached?: boolean;
  readonly expectedStagedPath?: string;
  readonly expectedStagedSha256?: string;
  readonly windowsWorkerReceiptId?: string;
}

interface WindowsTaskRestoreResult {
  readonly status: "restored" | "restore-failed";
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
    if (detached.windowsWorkerReceiptId !== undefined) {
      if (
        process.platform !== "win32" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
          detached.windowsWorkerReceiptId,
        ) ||
        !(await readWindowsWorkerAdmission())
      ) {
        throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
      }
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
      confirmWindowsStart: windowsHandoff,
      reportStage:
        detached.windowsWorkerReceiptId === undefined
          ? null
          : (stage) => {
              process.stdout.write(
                `${WINDOWS_RESTORE_STAGE_PREFIX} ${stage}\n`,
              );
            },
    };
    let outcome: FinalizeSwapOutcome;
    try {
      outcome = await withCliUpdateContender(contenderOptions, (capability) =>
        runFinalizeUpgradeSwapWithAttempt(
          {
            environment,
            ...detached,
            receiptPath,
            reportReceipt: () => start.reportStage?.("receipt"),
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
        serviceRestore = { status: "restored" };
      } else {
        start.reportStage?.("receipt");
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
          serviceRestore.status === "restored"
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
        serviceRestore?.status === "restored"
          ? "The service is running and responsive."
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

async function readWindowsWorkerAdmission(): Promise<boolean> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) return line === "restore";
    return false;
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
    readonly reportReceipt: () => void;
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
  const expected = start.confirmWindowsStart
    ? await readHostInstallRecord(environment)
    : null;
  if (start.confirmWindowsStart && expected === null) {
    throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
  }
  const afterStopMicros = Date.now() * 1000;
  const startBegan = performance.now();
  let acknowledgedSupervisor: number | null = null;
  start.reportStage?.("start");
  const outcome = await startHostServiceWithAttempt(
    capability,
    contenderOptions,
    // Completes the restart whose stop released the CLI binary: a restart
    // relaunch leg, so `maintenance` (`host/lifecycle-origin.ts`).
    "maintenance",
    createServiceController(),
    label,
    start.confirmWindowsStart
      ? (pid) => {
          acknowledgedSupervisor = pid;
        }
      : undefined,
  );
  if (start.confirmWindowsStart && expected !== null) {
    const expectedGeneration = encodeInstallGeneration(expected);
    if (outcome.kind !== "started" || acknowledgedSupervisor === null) {
      throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
    }
    const health = await probeHostHealth({
      environment,
      checkProcessAlive: null,
      checkTcpReachable: null,
      checkReadiness: async (metadata) => {
        const startedMicros = windowsProcessStartIdentityMicros(
          metadata.processStartIdentity,
        );
        if (
          startedMicros === null ||
          startedMicros < afterStopMicros ||
          metadata.version !== expected.version ||
          (await getPublishedProcessIdentityVerdict(
            metadata.pid,
            metadata.processStartIdentity,
          )) !== "current" ||
          (await readLiveSupervisorRun(environment))?.supervisorPid !==
            acknowledgedSupervisor
        ) {
          return false;
        }
        const installed = await readHostInstallRecord(environment);
        return (
          installed !== null &&
          encodeInstallGeneration(installed) === expectedGeneration &&
          (await probeHostReachable(metadata.websocketUrl))
        );
      },
      totalBudgetMs: Math.max(
        0,
        HOST_START_ADOPTION_MAX_AGE_MS - (performance.now() - startBegan),
      ),
      retryDelayMs: null,
    });
    if (!health.healthy) throw new Error(WINDOWS_RESTORE_UNCONFIRMED);
  }
  if (outcome.kind === "started") start.started = true;
  // Not expected here: the stop that released the binary ended the old
  // supervisor, and it removed its records. A live one means something
  // else brought the service back first, and its supervisor hands the host
  // back itself - which is what this start was for.
  if (outcome.kind === "supervisor-relaunching") {
    createCliLogger(environment).info(
      "Finalize-upgrade start left the host to the service's live supervisor",
      {
        environment,
        supervisorPid: outcome.supervisorPid,
      },
    );
  }
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

async function startAsSupervisorRelaunch(
  environment: Environment,
  logger: ILogger,
  start: FinalizeStartObservation,
): Promise<void> {
  const relaunchOptions: WithCliUpdateContenderOptions = {
    environment,
    reason: "cli-finalize-upgrade",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "supervisor-relaunch-maintenance",
  };
  await withCliSupervisorRelaunchSegment(
    relaunchOptions,
    (capability, context) =>
      withCliAttemptMutation(capability, relaunchOptions, async () => {
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
      }),
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
    waitMs: 30_000,
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
      await withCliAttemptMutation(capability, recoveryOptions, async () => {
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
      });
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
    readonly reportReceipt?: () => void;
  } & DetachedFinalizeOptions,
  startService: () => Promise<void>,
): Promise<FinalizeSwapOutcome> {
  const logger = createCliLogger(opts.environment);
  const markerPath =
    opts.receiptPath ?? newCliPostFinalizeReceiptPath(opts.environment);
  const writeReceipt = (marker: PostFinalizeMarker): Promise<void> => {
    opts.reportReceipt?.();
    return writePostFinalizeMarkerFile(markerPath, marker);
  };
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
    const serviceStartError = await startServiceBestEffort(
      startService,
      opts.environment,
      logger,
    );
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
    const serviceStartError = await startServiceBestEffort(
      startService,
      opts.environment,
      logger,
    );
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
    const serviceStartError = await startServiceBestEffort(
      startService,
      opts.environment,
      logger,
    );
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
    const serviceStartError = await startServiceBestEffort(
      startService,
      opts.environment,
      logger,
    );
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
    const serviceStartError = await startServiceBestEffort(
      startService,
      opts.environment,
      logger,
    );
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
  const serviceStartError = await startServiceBestEffort(
    startService,
    opts.environment,
    logger,
  );
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
          "The finalization receipt already exists.",
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
