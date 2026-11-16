import type { CommandContext } from "../runner/runner";
import { keepConsoleOffStdout } from "../runner/output";
import {
  formatCredentialProvisionNote,
  maybeProvisionCredential,
} from "../host/install-auth";
import {
  runHostStart,
  type RunHostStartDeps,
  type RunHostStartOptions,
} from "./host-start";

/** Foreground supervision has no terminal result envelope. */
export async function runHostStartCommand(
  ctx: CommandContext,
  options: RunHostStartOptions,
  injected: Partial<RunHostStartDeps>,
): Promise<void> {
  if (ctx.runtime.json) keepConsoleOffStdout();
  await runHostStart(options, {
    ...injected,
    onHostStarted:
      "serviceLabel" in options || "probe" in options
        ? null
        : async () => {
            // Preserve the supervisor's single progress event. The actual
            // advisory outcome goes to the existing logger and human note.
            const credentialProvision = await maybeProvisionCredential(
              { ...ctx, progress: () => undefined },
              "start",
              null,
            );
            ctx.runtime.logger.debug("Host credential provisioning settled", {
              environment: ctx.runtime.environment,
              credentialProvision,
            });
            const note = formatCredentialProvisionNote(credentialProvision);
            if (note !== null) ctx.output.humanRequired(note);
          },
  });
}
