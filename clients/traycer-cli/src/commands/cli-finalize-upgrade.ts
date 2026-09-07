import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { finalizePendingCliUpgrade } from "./cli-upgrade";
import { createCliLogger, type ILogger } from "../logger";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { cliPostFinalizeMarkerPath } from "../store/paths";
import { withCliUpdateContender } from "../host/update-contender";
import { startHostServiceWithAttempt } from "../host/update-mutation";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import type { WithCliUpdateContenderOptions } from "../host/update-contender";
import type { PostFinalizeMarker } from "../upgrade/finalize-helper";

// `traycer cli finalize-upgrade` - hidden, internal-only command the Windows/POSIX detached finalize-helper script invokes (via the STAGED CLI binary, once the parent CLI process has exited) to complete a pending self-upgrade.
// See upgrade/finalize-helper.ts's module doc comment for the full handoff design.
export const cliFinalizeUpgradeCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const environment = ctx.runtime.environment;
  // ONE options value for acquisition and for every in-attempt revalidation:
  // two literals that must stay identical are how admission policies drift.
  const contenderOptions: WithCliUpdateContenderOptions = {
    environment,
    reason: "cli-finalize-upgrade",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "service-maintenance",
  };
  try {
    const outcome = await withCliUpdateContender(
      contenderOptions,
      (capability) =>
        runFinalizeUpgradeSwapWithAttempt(
          { environment },
          capability,
          contenderOptions,
        ),
    );
    return {
      data: outcome,
      human: humanForOutcome(outcome),
      exitCode: 0,
    };
  } catch (err) {
    // Both refusals defer the same way: no marker is written, so `pendingUpgrade` stays populated and the next `host restart` retries.
    // An active durable attempt (E_HOST_UPDATE_ATTEMPT_ACTIVE from the nonterminal-attempt admission verdict) is a scheduling refusal exactly like a busy cli-lock, not a finalization failure.
    if (
      err instanceof CliError &&
      (err.code === CLI_ERROR_CODES.CLI_LOCK_BUSY ||
        err.code === CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE)
    ) {
      const outcome: FinalizeSwapOutcome = { status: "lock-timeout" };
      return { data: outcome, human: humanForOutcome(outcome), exitCode: 0 };
    }
    throw err;
  }
};

export type FinalizeSwapOutcome =
  | {
      readonly status: "swapped";
      readonly previousVersion: string;
      readonly version: string;
      readonly serviceStartError: string | null;
    }
  | { readonly status: "swap-failed"; readonly errorMessage: string }
  | {
      readonly status: "manifest-update-failed";
      readonly previousVersion: string;
      readonly version: string;
      readonly errorMessage: string;
      readonly serviceStartError: string | null;
    }
  // The manifest still records a pendingUpgrade, but the file it points at is gone (audit CLI-015).
  // Kept distinct from `no-pending`: the two describe opposite persisted states, and collapsing them reported "nothing to finalize" while the manifest was still asking every future restart to finalize a file that no longer exists.
  | {
      readonly status: "staged-binary-missing";
      readonly stagedVersion: string;
      readonly stagedBinaryPath: string;
      readonly livePath: string;
    }
  | {
      readonly status: "no-pending";
      readonly serviceStartError: string | null;
    }
  | { readonly status: "lock-timeout" };

// Core: assumes the caller already holds cli-lock (matches the "core assumes caller holds lock" pattern used throughout this ticket - installer/apply.ts, restartWithPendingCliUpgradeFinalize).
// Kept separate from the command wrapper so tests can exercise it without lock machinery.
export async function runFinalizeUpgradeSwap(
  opts: {
    readonly environment: Environment;
  },
  startService: () => Promise<void>,
): Promise<FinalizeSwapOutcome> {
  return runFinalizeUpgradeSwapWithStart(opts, startService);
}

async function runFinalizeUpgradeSwapWithAttempt(
  opts: { readonly environment: Environment },
  capability: UpdateMutationCapability,
  contenderOptions: WithCliUpdateContenderOptions,
): Promise<FinalizeSwapOutcome> {
  return runFinalizeUpgradeSwapWithStart(opts, () =>
    startHostServiceWithAttempt(
      capability,
      contenderOptions,
      createServiceController(),
      serviceLabelFor(opts.environment),
    ),
  );
}

async function runFinalizeUpgradeSwapWithStart(
  opts: { readonly environment: Environment },
  startService: () => Promise<void>,
): Promise<FinalizeSwapOutcome> {
  const logger = createCliLogger(opts.environment);
  const markerPath = cliPostFinalizeMarkerPath(opts.environment);
  const swap = await finalizePendingCliUpgrade({
    environment: opts.environment,
  });
  logger.info("Finalize-upgrade swap attempted", {
    environment: opts.environment,
    status: swap.status,
  });

  // Service was stopped by the `host restart` that scheduled this helper; this process starts it after the swap.
  if (swap.status === "no-pending" || swap.status === "no-manifest") {
    const serviceStartError = await startServiceBestEffort(
      startService,
      opts.environment,
      logger,
    );
    if (serviceStartError !== null) {
      // The helper runs detached with output redirected away.
      // Preserve a failed hand-back in the cross-version marker format even though no upgrade identity remains; reconciliation's no-pending/no-manifest branch intentionally consumes this without identity correlation.
      await writePostFinalizeMarkerFile(markerPath, {
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
    // The pending record outlived the file it points at (cleanup, AV, a wiped tmpdir).
    // `pendingUpgrade` is deliberately RETAINED rather than cleared: it is the only remaining evidence that the user asked for an upgrade they never received, and Doctor already renders it as "CLI upgrade staged but staged binary is missing" with `traycer cli upgrade` as the recovery command.
    const serviceStartError = await startServiceBestEffort(
      startService,
      opts.environment,
      logger,
    );
    await writePostFinalizeMarkerFile(markerPath, {
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

  // `publish-failed` and `still-locked` are the same shape of outcome: the swap did not happen, the live binary is untouched, and `pendingUpgrade` stands.
  // Both must still hand the host back.
  if (swap.status === "publish-failed" || swap.status === "still-locked") {
    const serviceStartError = await startServiceBestEffort(
      startService,
      opts.environment,
      logger,
    );
    await writePostFinalizeMarkerFile(markerPath, {
      status: "swap-failed",
      attemptedAt: new Date().toISOString(),
      livePath: swap.livePath,
      stagedBinaryPath: swap.stagedBinaryPath,
      errorMessage: swap.errorMessage,
      serviceStartError,
    });
    return { status: "swap-failed", errorMessage: swap.errorMessage };
  }

  if (swap.status === "manifest-update-failed") {
    const serviceStartError = await startServiceBestEffort(
      startService,
      opts.environment,
      logger,
    );
    await writePostFinalizeMarkerFile(markerPath, {
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
  await writePostFinalizeMarkerFile(markerPath, {
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

// Hand the host back.
// Best-effort by design: this runs on paths that are already reporting a failure, and a service-start error must be recorded rather than replace the outcome the caller needs to see.
async function startServiceBestEffort(
  // The INJECTED start, never a raw controller call: under the maintenance capability the thunk is `startHostServiceWithAttempt`, and a raw start here would hand the host back outside the attempt gate on exactly the paths that report failures.
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

export async function writePostFinalizeMarkerFile(
  markerPath: string,
  marker: PostFinalizeMarker,
): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  const tmpPath = `${markerPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(marker), "utf8");
  await rename(tmpPath, markerPath);
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
    case "no-pending":
      return outcome.serviceStartError === null
        ? "cli finalize-upgrade: nothing to finalize"
        : `cli finalize-upgrade: nothing to finalize; service did not start: ${outcome.serviceStartError}`;
    case "lock-timeout":
      return "cli finalize-upgrade: timed out acquiring cli-lock; deferring to the next 'host restart'";
  }
}
