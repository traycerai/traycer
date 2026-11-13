/** Profile defaults are method-specific: create is ambient, fork inherits. */
import {
  AMBIENT_PROFILE_ID_SENTINEL,
  type ConcreteProfileSelection,
  type ForkAgentProfileSelection,
  type ProfileSelection,
} from "@traycer/protocol/host/agent/shared";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

export function parseCreateProfileSelection(
  profile: string | null,
): ProfileSelection {
  if (profile === null) return { kind: "ambient" };
  return parseConcreteProfileSelection(profile);
}

/** Fork omission inherits the source; explicit ambient remains a separate choice. */
export function parseForkProfileSelection(
  profile: string | null,
): ForkAgentProfileSelection {
  if (profile === null) return { kind: "inherit" };
  return parseConcreteProfileSelection(profile);
}

export function parseConcreteProfileSelection(
  profile: string,
): ConcreteProfileSelection {
  const value = profile.trim();
  if (value === AMBIENT_PROFILE_ID_SENTINEL) return { kind: "ambient" };
  if (value.length === 0) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `traycer: --profile must be '${AMBIENT_PROFILE_ID_SENTINEL}' or a managed profile id - run 'traycer agent list-profiles <harness>' to see the available values.`,
      details: null,
      exitCode: 1,
    });
  }
  return { kind: "profile", profileId: value };
}
