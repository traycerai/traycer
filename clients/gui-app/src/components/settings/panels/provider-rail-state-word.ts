import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  isProviderAmbientAuthenticated,
  isProviderAmbientSignedOut,
} from "@/lib/providers/provider-ambient-auth";

/**
 * The Providers rail's one word of state for a provider, read from its own
 * `providers.list` row, the first rule that holds winning:
 *
 * - `off`: `enabled` is false.
 * - `<n> profiles` / `1 profile`: the managed profiles in `profiles`, which
 *   Personal carries to every computer running it.
 * - `key`: `apiKey.configured`, saved here or read from the shell.
 * - `signed out`: the terminal login's definitive verdict, from `auth` or the
 *   ambient profile row (`isProviderAmbientSignedOut`).
 * - `own login`: the terminal login is signed in, which works on this
 *   computer only. A login the tool reports as `configured` (Codex's saved
 *   login, which it does not check until a run) counts, as the Profiles
 *   card's own-login row reads it. Not for Traycer, whose sign-in is the
 *   person's account.
 * - `not checked`: the provider has a terminal login to check
 *   (`loginCapability` is not `null`), the check is not still running, and it
 *   settled on neither a signed-out nor a signed-in verdict - the probe
 *   itself failed, which the Profiles card's own-login row answers with its
 *   Retry.
 *
 * `null` while nothing above is known yet (a probe still running, a status
 * that is not an answer), so the rail never states a guess.
 */
export function providerRailStateWord(state: ProviderCliState): string | null {
  if (!state.enabled) return "off";
  const managed = state.profiles.filter(
    (profile) => profile.kind === "managed",
  ).length;
  if (managed === 1) return "1 profile";
  if (managed > 1) return `${managed} profiles`;
  if (state.apiKey.configured) return "key";
  if (isProviderAmbientSignedOut(state)) return "signed out";
  if (
    state.providerId !== "traycer" &&
    (isProviderAmbientAuthenticated(state) || ambientLoginConfigured(state))
  ) {
    return "own login";
  }
  // Pending stays `null`, never a guess: a still-running probe is not a
  // failed one, and a surface that wants to say "checking" while it waits
  // reads `authPending` itself. `loginCapability` is null for a provider
  // with no terminal login to probe at all (an API-key-only provider, or
  // Traycer's own account) - the host emits an ambient profile row for every
  // provider regardless, so that row alone is not the right gate.
  if (state.loginCapability !== null && !state.authPending) {
    return "not checked";
  }
  return null;
}

/** Shared with the Profiles card's own-login row, which reads the same two sources. */
export function ambientLoginConfigured(state: ProviderCliState): boolean {
  return (
    state.auth.status === "configured" ||
    state.profiles.some(
      (profile) =>
        profile.kind === "ambient" && profile.auth.status === "configured",
    )
  );
}
