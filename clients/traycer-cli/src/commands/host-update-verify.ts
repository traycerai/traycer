import type { CommandFn, CommandResult } from "../runner/runner";
import {
  verifyHostUpdateAttempt,
  humanForVerifyReport,
  type HostUpdateVerifyArgs,
} from "../host/update-verify";

// `traycer host update-verify` (hidden, internal) - the post-restart
// verification claim for a Desktop-owned packaged-macOS activation.
//
// This file is deliberately thin. The claim itself lives in
// `host/update-verify.ts` because Ticket 03's structural fence permits
// executor consumers only under `host/*.ts`: the released legacy update
// command must never be able to reach the shadow executor. Satisfying that by
// construction is worth more than an allowlist entry would be, and it matches
// how every other command in this tree is shaped.
//
// What belongs here and nowhere else: argument plumbing, logging, and the
// process-facing result envelope.

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
    // Exit code stays 0 for every arm on purpose. A non-zero exit would make a
    // dispatcher that reads only the status conflate `failed` (a real terminal
    // verdict) with `indeterminate` (no verdict at all). The outcome is carried
    // in the report, which is the only place that distinction survives.
    return { data: report, human: humanForVerifyReport(report), exitCode: 0 };
  };
}
