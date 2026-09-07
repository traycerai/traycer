import type { LaunchCompetingRegistrationRepair } from "../app/host-login-item";
import {
  withDesktopUpdateContender,
  type DesktopUpdateContenderOutcome,
} from "./update-contender";
import { retireCompetingCliRegistrationWithAttempt } from "./update-mutation";

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
