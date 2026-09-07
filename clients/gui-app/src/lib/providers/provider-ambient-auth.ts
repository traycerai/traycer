import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type {
  ProviderAuthStatus,
  ProviderMutationCliStateV21,
  ProviderProfileKind,
} from "@traycer/protocol/host/provider-schemas";

/**
 * The two fields the ambient verdict below actually reads, named structurally rather than as one concrete state type.
 */
type AmbientAuthSources = {
  readonly auth: { readonly status: ProviderAuthStatus };
  readonly profiles: readonly {
    readonly kind: ProviderProfileKind;
    readonly auth: { readonly status: ProviderAuthStatus };
  }[];
};

/**
 * The terminal/ambient account's effective sign-in verdict for a provider, reconciling the two places that reflect the SAME underlying login: the provider-level probe (`state.auth`, the historical pre-profiles ambient signal) and the ambient profile row.
 */
function ambientProfileAuthStatus(
  provider: AmbientAuthSources,
): ProviderAuthStatus | null {
  return (
    provider.profiles.find((profile) => profile.kind === "ambient")?.auth
      .status ?? null
  );
}

/**
 * Definitive signed-out verdict for the terminal/ambient account: either the provider-level probe or the ambient profile row reports `unauthenticated`.
 * A transient `unknown`/`unavailable` on either source does NOT flip it - only a definitive `unauthenticated`.
 */
export function isProviderAmbientSignedOut(
  provider: AmbientAuthSources,
): boolean {
  return (
    provider.auth.status === "unauthenticated" ||
    ambientProfileAuthStatus(provider) === "unauthenticated"
  );
}

/**
 * The same definitive signed-out verdict, read from a HARNESS CATALOG ROW (`agent.gui.listHarnesses@7.1`'s `authStatus`) instead of a `providers.list` state.
 */
export function isHarnessRowSignedOut(harness: GuiHarnessOption): boolean {
  return harness.authStatus === "unauthenticated";
}

/**
 * `authenticated` / `unauthenticated` are ANSWERS; `unknown` / `unavailable` / `configured` are the absence of one.
 * Every caller that has to distinguish "the probe said no" from "the probe has not said anything yet" asks through here.
 */
export function isDefinitiveProviderAuthStatus(
  status: ProviderAuthStatus,
): boolean {
  return status === "authenticated" || status === "unauthenticated";
}

/**
 * The `providers.awaitLogin` window in which the ambient verdict is NOT yet settled, and so must not be read as a failed sign-in.
 */
export function isAmbientAuthVerdictPending(
  state: ProviderMutationCliStateV21,
): boolean {
  return (
    state.authPending && !isDefinitiveProviderAuthStatus(state.auth.status)
  );
}

/**
 * Budget for the bounded re-poll of the window above: a few short re-polls let a background probe land instead of misreporting a successful sign-in as a failure.
 * Definitive verdicts are never re-polled, so this only ever bounds the unsettled case.
 */
export const AMBIENT_AUTH_PENDING_REPOLL_CAP = 3;
// Exported so tests can drive the re-poll deterministically with fake timers instead of hardcoding a duplicate magic number that could silently drift from this value.
export const AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS = 2_000;

/**
 * Definitive signed-in verdict for the terminal/ambient account - the symmetric complement of {@link isProviderAmbientSignedOut}.
 * Used by the re-auth gate's reconnect bookend so the "reconnected" edge tracks the same two sources the sign-out edge does: a reconnect that only lands on the ambient profile row first (with the provider-level summary still lagging) still clears the latch.
 */
export function isProviderAmbientAuthenticated(
  provider: AmbientAuthSources,
): boolean {
  if (isProviderAmbientSignedOut(provider)) return false;
  return (
    provider.auth.status === "authenticated" ||
    ambientProfileAuthStatus(provider) === "authenticated"
  );
}
