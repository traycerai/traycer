import { readDoorReason } from "@traycer/protocol/framework/door-reason";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
  TEAM_MEMBERSHIP_UNAVAILABLE,
} from "../../../shared/host-transport/local-open-auth";
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";

/**
 * Before a one-shot command's first open, whether a `reconnecting` with this
 * retry cause is waited out within the command's deadline: nothing was sent,
 * and the stream redials it. `TEAM_MEMBERSHIP_REQUIRED` is not: no redial
 * answers it, so it ends the command at once.
 */
export function waitedOutBeforeOpen(
  retryCause: FatalErrorDetails | null,
): boolean {
  return retryCause?.code !== TEAM_MEMBERSHIP_REQUIRED;
}

/**
 * A team admission refusal that names its reason comes from a current host:
 * its sentence goes ahead of the door's wording, which would read the named
 * reason as unworded. A reasonless one is a released host's refusal of the
 * token, and stays the door's.
 */
export function namedTeamAdmissionCliError(
  details: FatalErrorDetails,
): CliError | null {
  return readDoorReason(details.doorReason) === "absent"
    ? null
    : localTeamAdmissionCliError(details);
}

/** Typed admission failures never quote server text or account details. */
export function localTeamAdmissionCliError(
  details: FatalErrorDetails,
): CliError | null {
  if (details.code === TEAM_MEMBERSHIP_REQUIRED) {
    return cliError({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
      message: `traycer: ${TEAM_MEMBERSHIP_REQUIRED_MESSAGE} Run \`traycer login\` to switch accounts.`,
      details: null,
      exitCode: 1,
    });
  }
  if (details.code === TEAM_MEMBERSHIP_UNAVAILABLE) {
    return cliError({
      code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_UNAVAILABLE,
      message:
        "traycer: could not reach the cloud to check team membership. Try the command again.",
      details: null,
      exitCode: 1,
    });
  }
  return null;
}
