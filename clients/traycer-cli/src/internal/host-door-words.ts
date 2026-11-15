import { TEAM_MEMBERSHIP_REQUIRED_MESSAGE } from "@traycer-clients/shared/host-transport/local-open-auth";
import { hostDoorStateOfRefusal } from "@traycer-clients/shared/host-transport/host-door-state";
import { readDoorReason } from "@traycer/protocol/framework/door-reason";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { isCredentialRefusal } from "@traycer/protocol/host-transport/door-refusal";
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

/**
 * authn rejected the stored sign-in for good: its refresh was refused, or a
 * mint was refused again after a refresh. The CLI's existing words
 * (`auth/link-phone-flow.ts`), never authn being unreachable.
 */
export const STORED_CREDENTIAL_REJECTED_MESSAGE =
  "The stored credential was rejected. Run `traycer login` to re-authenticate.";

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
 * How a refusal by a host's door, once the call's one recovery is spent, is
 * told to the person:
 * - `sign-in-rejected`: a credential refusal after authn rejected the stored
 *   sign-in during this call's recovery. Only this case, and a machine with
 *   no sign-in at all, gives sign-in advice.
 * - `older-host`: no reason, on a non-retryable refusal of the token itself.
 * - `unworded`: every reason the owner has not worded. The command prints its
 *   own line for an unexpected host error, never sign-in advice and never the
 *   epic-access line.
 *
 * `null`: not the door's refusal; the command's own arms decide. A reason
 * decides ahead of the code that carries it.
 */
export type HostDoorRefusalKind =
  | "sign-in-rejected"
  | "older-host"
  | "unworded";

export function hostDoorRefusalKind(
  refusal: FatalErrorDetails,
  signInRejected: boolean,
): HostDoorRefusalKind | null {
  if (signInRejected && isCredentialRefusal(refusal)) return "sign-in-rejected";
  if (readDoorReason(refusal.doorReason) !== "absent") return "unworded";
  return hostDoorStateOfRefusal(refusal) === "older-host" ? "older-host" : null;
}

/**
 * A command's line for a door refusal ({@link hostDoorRefusalKind}), or `null`
 * when the refusal is not the door's. `generic` is the command's own line for
 * an unexpected host error.
 *
 * The owner's board on the door's reasons words `not_admitted`,
 * `keys_unavailable`, `clock_skew`, `enrolment_broken`, `membership_removed`
 * and `host_claimed`; those arms go here, and print `generic` until then.
 */
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
