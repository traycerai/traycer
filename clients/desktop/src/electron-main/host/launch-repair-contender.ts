import type { LaunchCompetingRegistrationRepair } from "../app/host-login-item";
import {
  withDesktopUpdateContender,
  type DesktopUpdateContenderOutcome,
} from "./update-contender";
import { retireCompetingCliRegistrationWithAttempt } from "./update-mutation";

/**
 * Named admission for the launch-time competing-registration repair. It is
 * maintenance, not an executor: absence/terminal v2 evidence preserves the
 * old repair, while every nonterminal or unreadable record is returned to
 * startup without touching the CLI LaunchAgent manifest.
 */
export async function retireCompetingCliRegistrationWithContender(options: {
  readonly hostHomeDir: string;
  readonly lockPath: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
}): Promise<DesktopUpdateContenderOutcome<LaunchCompetingRegistrationRepair>> {
  return withDesktopUpdateContender(
    {
      hostHomeDir: options.hostHomeDir,
      lockPath: options.lockPath,
      reason: "desktop-launch-registration-repair",
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
      admission: "desktop-activation-maintenance",
    },
    async (capability) =>
      retireCompetingCliRegistrationWithAttempt(
        capability,
        options.hostHomeDir,
      ),
  );
}
