import { AMBIENT_PROFILE_ID_SENTINEL } from "@traycer/protocol/host/agent/shared";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import {
  GUI_HARNESS_BY_PROVIDER_ID,
  providerIdFromHarnessOrProviderName,
} from "../../../shared/providers/provider-harness-ids";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

/**
 * The `<provider>` argument of the `traycer profile` commands: a harness id as
 * `traycer agent create --harness` takes it (`claude`), or the provider id
 * (`claude-code`).
 *
 * Whether the provider HAS profiles is not decided here. The host refuses a
 * profile mutation for a provider without them, and the CLI prints that
 * refusal rather than keeping a third copy of the list the host and the GUI
 * already hold.
 */
export function parseProviderArgument(value: string): ProviderId {
  const providerId = providerIdFromHarnessOrProviderName(value.trim());
  if (providerId === null) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `traycer: unknown provider '${printable(value)}' - run 'traycer profile list' to see the providers that have profiles.`,
      details: null,
      exitCode: 1,
    });
  }
  return providerId;
}

/**
 * The `<profile>` argument: `ambient` for the provider's own CLI login, or a
 * managed profile id from `traycer profile list`. Returned as the row id the
 * host's profile mutations take, where ambient is the literal sentinel.
 */
export function parseProfileArgument(value: string): string {
  const profileId = value.trim();
  if (profileId.length === 0) {
    throw cliError({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: `traycer: profile must be '${AMBIENT_PROFILE_ID_SENTINEL}' or a managed profile id - run 'traycer profile list' to see them.`,
      details: null,
      exitCode: 1,
    });
  }
  return profileId;
}

export function isAmbientProfileId(profileId: string): boolean {
  return profileId === AMBIENT_PROFILE_ID_SENTINEL;
}

/**
 * Text from the host, made safe to print in a terminal line. A profile label,
 * an account email and a provider's refusal reason are all written by someone
 * else - a label can arrive with a profile copied from another machine - and
 * a newline or an escape sequence in one would split a table row or drive the
 * terminal. Control characters are shown as `\xNN` / `\uNNNN`; anything else
 * is unchanged. Structured (`--json`) output keeps the original value.
 */
export function printable(text: string): string {
  return text.replace(
    // C0 controls, DEL, C1 controls, and the two Unicode line separators.
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (character) => {
      const code = character.charCodeAt(0);
      return code <= 0xff
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : `\\u${code.toString(16).padStart(4, "0")}`;
    },
  );
}

/** How a provider is named back to the user: `claude (Claude Code)`. */
export function describeProvider(providerId: ProviderId): string {
  return `${GUI_HARNESS_BY_PROVIDER_ID[providerId]} (${PROVIDER_DISPLAY_NAMES[providerId]})`;
}
