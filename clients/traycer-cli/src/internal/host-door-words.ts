import { TEAM_MEMBERSHIP_REQUIRED_MESSAGE } from "@traycer-clients/shared/host-transport/local-open-auth";
import { hostDoorStateOfRefusal } from "@traycer-clients/shared/host-transport/host-door-state";
import { readDoorReason } from "@traycer/protocol/framework/door-reason";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { isCredentialRefusal } from "@traycer/protocol/host-transport/door-refusal";
import { cliError, CLI_ERROR_CODES, type CliError } from "../runner/errors";
import type { CliHostTokenFailure } from "./cli-host-tokens";

/**
 * A refusal with no worded line prints its command's generic line: no server text
 * from authn, and never sign-in advice for a person who is signed in.
 */

/** Printed only when this machine holds no usable sign-in. */
export const SIGNED_OUT_MESSAGE =
  "traycer: not signed in - run `traycer login` to authenticate.";

/** A refused refresh, or a mint refused again after one; never authn unreachable. */
export const STORED_CREDENTIAL_REJECTED_MESSAGE =
  "The stored credential was rejected. Run `traycer login` to re-authenticate.";

/**
 * authn's directory could not be read for this computer, so whose it is was
 * not confirmed: the team install's owner check and `bot list`'s narrowing.
 */
export const HOST_OWNERSHIP_UNCONFIRMED_MESSAGE =
  "This computer's ownership could not be confirmed. Try again.";

/** authn could not be reached to read the stored sign-in: `whoami`'s words. */
export const AUTHN_UNREACHABLE_MESSAGE =
  "Could not reach the authn service; check your network.";

/** An older host, never a login. */
export const OLDER_HOST_MESSAGE =
  "The host is out of date. Reinstall the latest host with 'traycer host update'.";

/** Nothing authn sent is printed. Empty, so the runner prints `error: ` and the code. */
export const UNWORDED_MINT_REFUSAL_MESSAGE = "";

export function signedOutCliError(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.AUTH_NO_CREDENTIALS,
    message: SIGNED_OUT_MESSAGE,
    details: null,
    exitCode: 1,
  });
}

export function storedCredentialRejectedCliError(): CliError {
  return cliError({
    code: CLI_ERROR_CODES.AUTH_REJECTED,
    message: STORED_CREDENTIAL_REJECTED_MESSAGE,
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

/**
 * Only `sign-in-rejected`, and a machine with no sign-in, give sign-in advice.
 * `null`: not the door's refusal. A reason decides ahead of the code that carries it.
 */
export type HostDoorRefusalKind =
  | "sign-in-rejected"
  | "older-host"
  | "not-provisioned"
  | "unworded";

export function hostDoorRefusalKind(
  refusal: FatalErrorDetails,
  signInRejected: boolean,
): HostDoorRefusalKind | null {
  if (signInRejected && isCredentialRefusal(refusal)) return "sign-in-rejected";
  const reason = readDoorReason(refusal.doorReason);
  if (reason === "not_provisioned") return "not-provisioned";
  if (reason !== "absent") return "unworded";
  return hostDoorStateOfRefusal(refusal) === "older-host" ? "older-host" : null;
}

/** `generic` is printed for every reason with no words of its own yet. */
export function hostDoorRefusalCliError<Generic extends Error>(
  refusal: FatalErrorDetails,
  signInRejected: boolean,
  generic: () => Generic,
): CliError | Generic | null {
  switch (hostDoorRefusalKind(refusal, signInRejected)) {
    case "sign-in-rejected":
      return storedCredentialRejectedCliError();
    case "older-host":
      return olderHostCliError();
    // The host's own sentence, as a released command line printed it.
    case "not-provisioned":
      return cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: refusal.reason,
        details: null,
        exitCode: 1,
      });
    case "unworded":
      return generic();
    case null:
      return null;
  }
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
    // authn refused the sign-in, and its refresh or the mint after it too.
    case "sign-in-rejected":
      return storedCredentialRejectedCliError();
    // No sign-in is held: this machine is signed out in fact.
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
