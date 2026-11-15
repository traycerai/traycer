import { TEAM_MEMBERSHIP_REQUIRED_MESSAGE } from "@traycer-clients/shared/host-transport/local-open-auth";
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";
import type { CliHostTokenFailure } from "./cli-host-tokens";

/**
 * Every line the CLI prints when a host's door, or authn's mint of a host-only
 * token, refuses it. One place, so a ruling on any of them changes one line.
 *
 * Only words already in the CLI or ruled for it are here. A refusal the owner
 * has not yet worded prints its command's generic line, with no server text
 * from authn and never sign-in advice for a person who is signed in.
 */

/** Printed only when this machine holds no usable sign-in. */
export const SIGNED_OUT_MESSAGE =
  "traycer: not signed in - run `traycer login` to authenticate.";

/** The owner's ruling 2 of 14 Nov: an older host, never a login. */
export const OLDER_HOST_MESSAGE =
  "The host is out of date. Reinstall the latest host with 'traycer host update'.";

/**
 * authn's refusals of a mint the owner has not worded yet: a computer that is
 * not this person's, a frozen sandbox, and authn unreachable. Nothing authn
 * sent is printed. Empty until ruled; the runner then prints `error: ` and the
 * code.
 */
export const UNWORDED_MINT_REFUSAL_MESSAGE = "";

export function signedOutCliError(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
    message: SIGNED_OUT_MESSAGE,
    details: null,
    exitCode: 1,
  });
}

export function olderHostCliError(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
    message: OLDER_HOST_MESSAGE,
    details: null,
    exitCode: 1,
  });
}

/** What a command says when no host-only token could be had for its host. */
export function hostTokenFailureCliError(
  failure: CliHostTokenFailure,
): CliError {
  switch (failure.kind) {
    case "not-a-member":
      return cliError({
        code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
        message: `traycer: ${TEAM_MEMBERSHIP_REQUIRED_MESSAGE} Run \`traycer login\` to switch accounts.`,
        details: null,
        exitCode: 1,
      });
    // The sign-in itself was refused and its refresh too, or none is held:
    // this machine is signed out in fact.
    case "sign-in-rejected":
    case "no-sign-in":
      return signedOutCliError();
    // The stored sign-in was replaced while this command ran: someone may
    // well be signed in, so no sign-in advice.
    case "superseded":
    case "not-admitted":
      return cliError({
        code: CLI_ERROR_CODES.FORBIDDEN,
        message: UNWORDED_MINT_REFUSAL_MESSAGE,
        details: null,
        exitCode: 1,
      });
    case "sandbox-frozen":
      return cliError({
        code: CLI_ERROR_CODES.HOST_UNREACHABLE,
        message: UNWORDED_MINT_REFUSAL_MESSAGE,
        details: null,
        exitCode: 1,
      });
    case "unavailable":
      return cliError({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: UNWORDED_MINT_REFUSAL_MESSAGE,
        details: null,
        exitCode: 1,
      });
  }
}
