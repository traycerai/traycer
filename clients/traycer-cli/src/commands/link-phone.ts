import { runLinkPhoneFlow } from "../auth/link-phone-flow";
import { makeColorizer, shouldUseColor } from "../runner/ansi";
import type { CommandFn, CommandResult } from "../runner/runner";

// `traycer link-phone` prints a QR (plus the same code as typeable text) for
// the Traycer mobile app to scan, then asks the human at this terminal to
// approve the phone that scanned it. Approval - never the scan - is what signs
// the phone in.
//
// Exit-code contract, following `whoami`'s split between "we did our job" and
// a true failure:
//   - approved → result.ok, data.decision="approved", exit=0
//   - rejected → result.ok, data.decision="rejected", exit=1 (the shell
//     convention for "the answer was no")
//   - superseded / already decided / expired / not signed in → CliError,
//     exit=1
//   - authn unreachable → CliError(AUTH_NETWORK), exit=2
export function buildLinkPhoneCommand(opts: {
  readonly showQr: boolean;
}): CommandFn {
  return async (ctx): Promise<CommandResult> => {
    ctx.runtime.logger.info("Link-phone command started", {
      environment: ctx.runtime.environment,
      showQr: opts.showQr,
    });
    const result = await runLinkPhoneFlow(ctx, { showQr: opts.showQr });
    ctx.runtime.logger.info("Link-phone command completed", {
      environment: ctx.runtime.environment,
      decision: result.decision,
    });
    // The verdict line is printed on stdout by the runner.
    const c = makeColorizer(shouldUseColor(ctx.runtime, process.stdout));
    return {
      data: { decision: result.decision, claimant: result.claimant },
      human:
        result.decision === "approved"
          ? `${c.green("✓")} Approved — the phone is signing in now.`
          : `${c.red("✗")} Rejected. That phone was not signed in.`,
      exitCode: result.decision === "approved" ? 0 : 1,
    };
  };
}
