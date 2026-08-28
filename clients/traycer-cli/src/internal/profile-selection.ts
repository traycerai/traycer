/**
 * Parses the `--profile <ambient|id>` option shared by `traycer agent create`,
 * `profile-rate-limits`, and `configure` into the protocol's explicit
 * `ProfileSelection` (see `host/agent/shared.ts`).
 *
 * The three creation cases must stay distinguishable all the way to the wire,
 * because the host resolves each differently and only the first two are
 * unrepresentable on a pre-`agent.create@2.0` host:
 *
 *   - option omitted → `last_used` (the caller's per-user/per-provider
 *     remembered profile, falling back to ambient);
 *   - `--profile ambient` → the provider's ambient CLI login, explicitly;
 *   - `--profile <id>` → that managed profile.
 *
 * Omission is therefore NOT a synonym for ambient, and neither is a synonym
 * for the legacy `profileId: null` (which meant "inherit the sender's
 * profile"). Collapsing any pair here would silently route a child agent onto
 * an account the caller never chose.
 */
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
  if (profile === null) return { kind: "last_used" };
  return parseConcreteProfileSelection(profile);
}

/**
 * Parses `traycer agent fork`'s `--profile <ambient|id>` into
 * `ForkAgentProfileSelection`. Deliberately separate from
 * `parseCreateProfileSelection`: fork's omit-default is `inherit` (byte-for-byte
 * continuation of the SOURCE agent's own profile), not `last_used` (a
 * per-user/per-provider preference lookup for a freshly-minted agent) - see
 * `forkAgentProfileSelectionSchema` in `host/agent/shared.ts` for why the two
 * defaults must stay distinguishable on the wire.
 */
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
