import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { finalizePendingCliUpgrade } from "./cli-upgrade";
import { createCliLogger } from "../logger";
import type { Environment } from "../runner/environment";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";
import type { CommandFn, CommandResult } from "../runner/runner";
import { createServiceController, serviceLabelFor } from "../service";
import { cliPostFinalizeMarkerPath } from "../store/paths";
import { withCliLock } from "../store/cli-lock";
import type { PostFinalizeMarker } from "../upgrade/finalize-helper";

// `traycer cli finalize-upgrade` - hidden, internal-only command the
// Windows/POSIX detached finalize-helper script invokes (via the
// STAGED CLI binary, once the parent CLI process has exited) to
// complete a pending self-upgrade. See upgrade/finalize-helper.ts's
// module doc comment for the full handoff design.
//
// This is a leaf command: nothing else wraps it in a lock, so it
// acquires `cli-lock` itself (Host Update Layer Redesign Tech Plan,
// "Windows CLI-finalize helper") - own PID + start-time identity, since
// this runs as its own OS process distinct from both the original CLI
// process (already exited) and the wrapping helper script. On lock
// timeout it writes NO marker: `pendingUpgrade` stays populated in the
// manifest, so the next `host restart` retries the whole flow - "defers
// to the existing pending-upgrade marker for the next restart".
export const cliFinalizeUpgradeCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const environment = ctx.runtime.environment;
  try {
    const outcome = await withCliLock(
      {
        environment,
        reason: "cli-finalize-upgrade",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      () => runFinalizeUpgradeSwap({ environment }),
    );
    return {
      data: outcome,
      human: humanForOutcome(outcome),
      exitCode: 0,
    };
  } catch (err) {
    if (err instanceof CliError && err.code === CLI_ERROR_CODES.CLI_LOCK_BUSY) {
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
  // The manifest still records a pendingUpgrade, but the file it points
  // at is gone (audit CLI-015). Kept distinct from `no-pending`: the two
  // describe opposite persisted states, and collapsing them reported
  // "nothing to finalize" while the manifest was still asking every
  // future restart to finalize a file that no longer exists.
  | {
      readonly status: "staged-binary-missing";
      readonly stagedVersion: string;
      readonly stagedBinaryPath: string;
    }
  | { readonly status: "no-pending" }
  | { readonly status: "lock-timeout" };

// Core: assumes the caller already holds cli-lock (matches the
// "core assumes caller holds lock" pattern used throughout this ticket
// - installer/apply.ts, restartWithPendingCliUpgradeFinalize). Kept
// separate from the command wrapper so tests can exercise it without
// lock machinery.
export async function runFinalizeUpgradeSwap(opts: {
  readonly environment: Environment;
}): Promise<FinalizeSwapOutcome> {
  const logger = createCliLogger(opts.environment);
  const markerPath = cliPostFinalizeMarkerPath(opts.environment);
  const swap = await finalizePendingCliUpgrade({
    environment: opts.environment,
  });
  logger.info("Finalize-upgrade swap attempted", {
    environment: opts.environment,
    status: swap.status,
  });

  if (swap.status === "no-pending" || swap.status === "no-manifest") {
    return { status: "no-pending" };
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
    await writePostFinalizeMarkerFile(markerPath, {
      status: "swap-failed",
      attemptedAt: new Date().toISOString(),
      livePath: "",
      stagedBinaryPath: swap.stagedBinaryPath,
      errorMessage: `staged binary for ${swap.stagedVersion} is missing at ${swap.stagedBinaryPath}`,
      serviceStartError: null,
    });
    return {
      status: "staged-binary-missing",
      stagedVersion: swap.stagedVersion,
      stagedBinaryPath: swap.stagedBinaryPath,
    };
  }

  if (swap.status === "still-locked") {
    await writePostFinalizeMarkerFile(markerPath, {
      status: "swap-failed",
      attemptedAt: new Date().toISOString(),
      livePath: swap.livePath,
      stagedBinaryPath: swap.stagedBinaryPath,
      errorMessage: swap.errorMessage,
      serviceStartError: null,
    });
    return { status: "swap-failed", errorMessage: swap.errorMessage };
  }

  // swap.status === "finalised"
  let serviceStartError: string | null = null;
  try {
    await createServiceController().start(serviceLabelFor(opts.environment));
  } catch (err) {
    serviceStartError = err instanceof Error ? err.message : String(err);
    logger.warn("Finalize-upgrade service start failed after binary swap", {
      environment: opts.environment,
      errorMessage: serviceStartError,
    });
  }
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

async function writePostFinalizeMarkerFile(
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
    case "staged-binary-missing":
      return (
        `cli finalize-upgrade: staged binary for ${outcome.stagedVersion} is missing at ` +
        `${outcome.stagedBinaryPath}; pending state retained. ` +
        "Re-run 'traycer cli upgrade' to re-stage it."
      );
    case "no-pending":
      return "cli finalize-upgrade: nothing to finalize";
    case "lock-timeout":
      return "cli finalize-upgrade: timed out acquiring cli-lock; deferring to the next 'host restart'";
  }
}
