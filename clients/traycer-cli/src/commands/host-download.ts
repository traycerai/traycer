import {
  clearHostDownloadFailure,
  writeHostUpdateLastAttempt,
} from "@traycer-clients/shared/host-update";
import { runByDesktop } from "../host/update-contender";
import { errorFacts, outcomeOfThrow } from "../host/update-last-attempt";
import {
  downloadAndStageHost,
  type HostDownloadOutcome,
} from "../installer/download-stage";
import type { CommandFn, CommandResult } from "../runner/runner";
import { hostHomeDir } from "../store/paths";

// `traycer host download [version] [--automatic]` - stages a host version
// without touching the running host: download + verify + extract happen
// with NO `cli-lock` held and no busy check (Host Update Layer Redesign
// Tech Plan, "CLI: two-phase split with a staged store"). Only the brief
// eligibility-check and promote sections take the lock - see
// `installer/download-stage.ts`.
//
// `--automatic` is hidden: it's the controller's contract (desktop main's
// `stageLatest`), not a user-facing switch - it additionally refuses to
// stage when the installed version is incomparable (a `local-*` pin).
export interface HostDownloadArgs {
  readonly versionRequest: string | null;
  readonly automatic: boolean;
}

export function buildHostDownloadCommand(args: HostDownloadArgs): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host download command started", {
      environment: ctx.runtime.environment,
      versionRequest: args.versionRequest ?? "latest",
      automatic: args.automatic,
    });
    const home = hostHomeDir(ctx.runtime.environment);
    const target = { version: args.versionRequest, transferring: false };
    let outcome: HostDownloadOutcome;
    try {
      outcome = await downloadAndStageHost({
        environment: ctx.runtime.environment,
        versionRequest: args.versionRequest,
        automatic: args.automatic,
        onProgress: (info) => ctx.progress(info),
        registryClient: null,
        // No marker to publish from here: `host download` never touches the
        // running host, so there is no in-flight update for a remote client to
        // be told about. It only says when a throw stopped being a refusal.
        onWillDownload: async (targetVersion) => {
          target.version = targetVersion;
          target.transferring = true;
        },
        // Same reason: no attempt record to advance across the verified-bytes
        // barrier, and no attempt of this run's own for the promotion guard to
        // exempt - every nonterminal record it meets is someone else's.
        beforeExtract: async () => {},
        ownAttempt: null,
      });
    } catch (err) {
      await writeHostUpdateLastAttempt(
        home,
        {
          command: "host download",
          initiator: runByDesktop() ? "desktop" : "manual",
          outcome: outcomeOfThrow(err, target.transferring),
          targetVersion: target.version,
          attemptId: null,
          ...errorFacts(err),
        },
        ctx.runtime.logger,
      );
      throw err;
    }
    await clearHostDownloadFailure(home);
    ctx.runtime.logger.info("Host download command completed", {
      environment: ctx.runtime.environment,
      outcome: outcome.outcome,
    });
    return {
      data: outcome,
      human: humanSummary(outcome),
      exitCode: 0,
    };
  };
}

function humanSummary(outcome: HostDownloadOutcome): string {
  if (outcome.outcome === "short-circuit") {
    if (outcome.reason === "installed-up-to-date") {
      return `host already at ${outcome.installedVersion} (no-op)`;
    }
    if (outcome.reason === "already-staged") {
      return `host ${outcome.stagedVersion} already staged (no-op)`;
    }
    return `automatic download refused: installed version ${outcome.installedVersion} is not comparable to the registry`;
  }
  if (outcome.outcome === "discarded") {
    if (outcome.reason === "install-record-vanished") {
      return `discarded download ${outcome.targetVersion}: host was uninstalled during download`;
    }
    return `discarded download ${outcome.targetVersion}: no longer newer than the current install/stage`;
  }
  return `staged host ${outcome.stagedVersion} (installed: ${outcome.installedVersion})`;
}
