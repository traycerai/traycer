import type {
  ProviderAuthStatus,
  ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";

/**
 * The terminal/ambient account's effective sign-in verdict for a provider,
 * reconciling the two places that reflect the SAME underlying login: the
 * provider-level probe (`state.auth`, the historical pre-profiles ambient
 * signal) and the ambient profile row (`profiles[].kind === "ambient"`).
 *
 * They can transiently disagree. The host's auth poison + the probe-less
 * `providers.list` path stamp a *definitive* `unauthenticated` on the ambient
 * profile row the instant a credential failure is detected, while the
 * provider-level summary can still be lagging at a non-definitive status
 * (`unavailable`/`unknown`) before it converges. Treating only one source as
 * authority is exactly what let the model picker degrade a provider (it reads
 * both) while the send gate (it read only `state.auth`) kept Send enabled and
 * launched a doomed turn - see the provider-visibility review's send-gate
 * finding.
 *
 * `isProviderAmbientSignedOut` is the shared "terminal profile is signed out"
 * predicate both surfaces consume so they can't drift again. It is scoped to
 * the ambient/terminal account only: a healthy selected MANAGED profile is
 * judged by its own row's status, never blocked just because ambient is signed
 * out (the send gate applies this predicate solely on its `profileId === null`
 * branch).
 */
function ambientProfileAuthStatus(
  provider: ProviderCliState,
): ProviderAuthStatus | null {
  return (
    provider.profiles.find((profile) => profile.kind === "ambient")?.auth
      .status ?? null
  );
}

/**
 * Definitive signed-out verdict for the terminal/ambient account: either the
 * provider-level probe or the ambient profile row reports `unauthenticated`. A
 * transient `unknown`/`unavailable` on either source does NOT flip it - only a
 * definitive `unauthenticated`.
 */
export function isProviderAmbientSignedOut(
  provider: ProviderCliState,
): boolean {
  return (
    provider.auth.status === "unauthenticated" ||
    ambientProfileAuthStatus(provider) === "unauthenticated"
  );
}

/**
 * Definitive signed-in verdict for the terminal/ambient account - the
 * symmetric complement of {@link isProviderAmbientSignedOut}. Used by the
 * re-auth gate's reconnect bookend so the "reconnected" edge tracks the same
 * two sources the sign-out edge does: a reconnect that only lands on the
 * ambient profile row first (with the provider-level summary still lagging)
 * still clears the latch. A definitive `unauthenticated` on either source wins
 * (returns false) so a half-converged reconnect never phantom-clears while the
 * account is still signed out.
 */
export function isProviderAmbientAuthenticated(
  provider: ProviderCliState,
): boolean {
  if (isProviderAmbientSignedOut(provider)) return false;
  return (
    provider.auth.status === "authenticated" ||
    ambientProfileAuthStatus(provider) === "authenticated"
  );
}
