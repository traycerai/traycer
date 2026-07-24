import {
  downloadAndStageHost,
  type HostDownloadOutcome,
} from "../installer/download-stage";
import type { CommandFn, CommandResult } from "../runner/runner";

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
    const outcome = await downloadAndStageHost({
      environment: ctx.runtime.environment,
      versionRequest: args.versionRequest,
      automatic: args.automatic,
      onProgress: (info) => ctx.progress(info),
      registryClient: null,
    });
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
