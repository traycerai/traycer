import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  TEAM_MEMBERSHIP_REQUIRED,
  TEAM_MEMBERSHIP_REQUIRED_MESSAGE,
  TEAM_MEMBERSHIP_UNAVAILABLE,
} from "../../../shared/host-transport/local-open-auth";
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";
import { ACCESS_UNCONFIRMED_MESSAGE } from "./host-door-words";
import { createLocalOpenAuth } from "../../../shared/host-transport/create-local-open-auth";
import type { LocalOpenAuth } from "../../../shared/host-transport/local-open-auth";

/**
 * Local admission for the one CLI connection that still opens with the stored
 * sign-in: a running host's own credential provisioning. It mints no member
 * credential; every other host connection presents this CLI's host-only
 * token instead.
 */
export function createCliLocalOpenAuth(authnBaseUrl: string): LocalOpenAuth {
  return createLocalOpenAuth({
    authnBaseUrl: authnBaseUrl,
    cloudAuthorized: () => true,
  });
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
      message: ACCESS_UNCONFIRMED_MESSAGE,
      details: null,
      exitCode: 1,
    });
  }
  return null;
}
