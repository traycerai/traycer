import { TEAM_MEMBERSHIP_REQUIRED_MESSAGE } from "@traycer-clients/shared/host-transport/local-open-auth";
import { hostDoorStateOfRefusal } from "@traycer-clients/shared/host-transport/host-door-state";
import {
  readDoorReason,
  type HostDoorReason,
} from "@traycer/protocol/framework/door-reason";
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

/** The owner's ruling 2 of 14 Nov: an older host, never a login. */
export const OLDER_HOST_MESSAGE =
  "The host is out of date. Reinstall the latest host with 'traycer host update'.";

/**
 * Board C30, rows 9 to 11, built to its Proposal and waiting on the board.
 *
 * Row 9: a command refused by a host's door, by the door's reason: board
 * C1's sentence for that reason. `host_claimed` prints the computer's own
 * short reason, because a refusal never names who claimed the computer or
 * for which team (row 14 of the board).
 */
const DOOR_REASON_MESSAGES = {
  keys_unavailable:
    "traycer: This computer needs to connect once before it can verify access. Check its connection, then retry.",
  clock_skew:
    "traycer: This computer's date or time appears incorrect. Enable automatic date and time on that computer, then retry.",
  enrolment_broken:
    "traycer: This computer's connection to the team needs repair. Ask a team administrator to restore it.",
  membership_removed:
    "traycer: You no longer have access to this team's computer. Ask a team administrator if this is unexpected.",
  not_admitted:
    "traycer: This account cannot access this computer. Switch accounts to use it.",
} as const satisfies Partial<Record<HostDoorReason, string>>;

/** Row 10: access cannot be confirmed because Traycer's servers did not answer. */
export const ACCESS_UNCONFIRMED_MESSAGE =
  "traycer: We can't confirm access to this computer right now. Try the command again.";

/**
 * Row 11: a team sandbox paused for credits. The row ends "<team>'s bundle
 * is out."; authn's refusal does not name the team, so that clause waits on
 * the board.
 */
export const SANDBOX_OUT_OF_CREDITS_MESSAGE =
  "traycer: This sandbox is out of credits.";

/**
 * authn's refusals of a mint the owner has not worded yet: a computer that is
 * not this person's, and a sign-in replaced while the command ran. Nothing
 * authn sent is printed. Empty until ruled; the runner then prints `error: `
 * and the code.
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

/**
 * What the refused call presented: this CLI's host-only token, or the agent
 * session capability the host gave an agent. The door's reasons speak to a
 * person about their account and computer; an agent's capability is the
 * host's own grant to that agent, so none of those sentences is true of it.
 */
export type HostDoorCredential = "host-token" | "agent-capability";

/**
 * How a refusal by a host's door, once the call's one recovery is spent, is
 * told to the person:
 * - `signed-out`: a credential refusal after authn refused the stored sign-in
 *   during this call's recovery. This machine is signed out in fact, and only
 *   this case gives sign-in advice.
 * - `older-host`: no reason, on a non-retryable refusal of the token itself.
 * - `worded`: a reason of board C30's row 9, on a host-only token.
 * - `unworded`: every other reason, and every reason on an agent's
 *   capability. The command prints its own line for an unexpected host error,
 *   never sign-in advice and never the epic-access line.
 *
 * `null`: not the door's refusal; the command's own arms decide. A reason
 * decides ahead of the code that carries it.
 */
export type HostDoorRefusalKind =
  | "signed-out"
  | "older-host"
  | "worded"
  | "unworded";

export function hostDoorRefusalKind(
  refusal: FatalErrorDetails,
  signInRejected: boolean,
  credential: HostDoorCredential,
): HostDoorRefusalKind | null {
  if (signInRejected && isCredentialRefusal(refusal)) return "signed-out";
  const reason = readDoorReason(refusal.doorReason);
  if (reason === "absent") {
    return hostDoorStateOfRefusal(refusal) === "older-host"
      ? "older-host"
      : null;
  }
  return credential === "host-token" &&
    wordedDoorRefusalMessage(refusal) !== null
    ? "worded"
    : "unworded";
}

/**
 * A command's line for a door refusal ({@link hostDoorRefusalKind}), or `null`
 * when the refusal is not the door's. `generic` is the command's own line for
 * an unexpected host error.
 */
export function hostDoorRefusalCliError<Generic extends Error>(
  refusal: FatalErrorDetails,
  signInRejected: boolean,
  credential: HostDoorCredential,
  generic: () => Generic,
): CliError | Generic | null {
  switch (hostDoorRefusalKind(refusal, signInRejected, credential)) {
    case "signed-out":
      return signedOutCliError();
    case "older-host":
      return olderHostCliError();
    case "worded": {
      const message = wordedDoorRefusalMessage(refusal);
      return message === null
        ? generic()
        : cliError({
            code: CLI_ERROR_CODES.AUTH_REJECTED,
            message,
            details: null,
            exitCode: 1,
          });
    }
    case "unworded":
      return generic();
    case null:
      return null;
  }
}

/** Board C30 row 9's line for `refusal`'s reason, or `null` when it has none. */
function wordedDoorRefusalMessage(refusal: FatalErrorDetails): string | null {
  const reason = readDoorReason(refusal.doorReason);
  switch (reason) {
    case "keys_unavailable":
    case "clock_skew":
    case "enrolment_broken":
    case "membership_removed":
    case "not_admitted":
      return DOOR_REASON_MESSAGES[reason];
    case "host_claimed": {
      const own = refusal.reason.trim();
      return own.length === 0 ? null : `traycer: ${own}`;
    }
    case "token_expired":
    case "session_revoked":
    case "unrecognised":
    case "absent":
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
        message: SANDBOX_OUT_OF_CREDITS_MESSAGE,
        details: null,
        exitCode: 1,
      });
    case "unavailable":
      return cliError({
        code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
        message: ACCESS_UNCONFIRMED_MESSAGE,
        details: null,
        exitCode: 1,
      });
  }
}
