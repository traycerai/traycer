import type { CommandFn, CommandResult } from "../runner/runner";
import {
  verifyHostUpdateAttempt,
  humanForVerifyReport,
  type HostUpdateVerifyArgs,
} from "../host/update-verify";

// `traycer host update-verify` (hidden, internal) - the post-restart verification claim for a Desktop-owned packaged-macOS activation.
// This file is deliberately thin.

export type { HostUpdateVerifyArgs };
export type { HostUpdateVerifyReport } from "../host/update-verify";

export function buildHostUpdateVerifyCommand(
  args: HostUpdateVerifyArgs,
): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Host update-verify command started", {
      environment: ctx.runtime.environment,
      attemptId: args.attemptId,
    });

    const report = await verifyHostUpdateAttempt(ctx.runtime.environment, args);

    ctx.runtime.logger.info("Host update-verify command completed", {
      environment: ctx.runtime.environment,
      outcome: report.outcome,
    });
    // Exit code stays 0 for every arm on purpose.
    // A non-zero exit would make a dispatcher that reads only the status conflate `failed` (a real terminal verdict) with `indeterminate` (no verdict at all).
    return { data: report, human: humanForVerifyReport(report), exitCode: 0 };
  };
}
