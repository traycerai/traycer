import type { GuiHarnessOption } from "@traycer/protocol/host/index";
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
 * The same definitive signed-out verdict, read from a HARNESS CATALOG ROW
 * (`agent.gui.listHarnesses@7.1`'s `authStatus`) instead of a
 * `providers.list` state.
 *
 * Why a second reader rather than a second predicate: the surfaces that
 * classify a provider (the rail, the model picker, the palette subpages)
 * render from the catalog, and until 7.1 they had to JOIN against a
 * separately-timed `providers.list` query to learn about auth. That join is
 * the model-picker bug - a provider signed out minutes ago still rendered as a
 * normal, sendable row until the other query refetched. Reading the verdict
 * off the row the surface already has closes that window with no extra fetch.
 *
 * DEFINITIVE ONLY, exactly like {@link isProviderAmbientSignedOut}:
 * `unknown`/`unavailable` are read errors and fail OPEN. This is not a style
 * choice - `railHarnessVisible` ORs the degraded predicate into VISIBILITY, so
 * widening this to non-definitive states would keep a sticky-enabled provider
 * with no CLI installed permanently in the rail as a tab that can never run.
 *
 * `undefined` (a host below 7.1) is not a verdict either. Callers that have a
 * `providers.list`-derived set fall back to it; callers that don't (the
 * palette) simply behave as they did before the field existed.
 */
export function isHarnessRowSignedOut(harness: GuiHarnessOption): boolean {
  return harness.authStatus === "unauthenticated";
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
