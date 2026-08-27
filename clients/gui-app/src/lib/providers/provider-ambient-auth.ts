import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type {
  ProviderAuthStatus,
  ProviderMutationCliStateV21,
  ProviderProfileKind,
} from "@traycer/protocol/host/provider-schemas";

/**
 * The two fields the ambient verdict below actually reads, named structurally
 * rather than as one concrete state type.
 *
 * Both shapes that carry an ambient verdict satisfy this: `ProviderCliState`
 * (a `providers.list` row) and `ProviderMutationCliStateV21` (what a mutation
 * response - `awaitLogin` included - hands back). They are not related by
 * assignability in either direction, but they share `PROVIDER_AUTH_SCHEMA_V20`
 * for `auth` and build `profiles` from the same `providerProfileShapeV70`, so
 * the sources this reconciles are byte-identical across the two.
 *
 * Typed this way because the alternative is what F3 of the review caught: a
 * caller holding the mutation shape cannot call a `ProviderCliState` predicate,
 * so it open-codes `state.auth.status === "authenticated"` instead and silently
 * drops the profile half of the verdict. The same idiom `isProfileEnabled`
 * already uses in `provider-schemas.ts`.
 */
type AmbientAuthSources = {
  readonly auth: { readonly status: ProviderAuthStatus };
  readonly profiles: readonly {
    readonly kind: ProviderProfileKind;
    readonly auth: { readonly status: ProviderAuthStatus };
  }[];
};

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
  provider: AmbientAuthSources,
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
  provider: AmbientAuthSources,
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
 * `authenticated` / `unauthenticated` are ANSWERS; `unknown` / `unavailable`
 * / `configured` are the absence of one. Every caller that has to distinguish
 * "the probe said no" from "the probe has not said anything yet" asks through
 * here.
 */
export function isDefinitiveProviderAuthStatus(
  status: ProviderAuthStatus,
): boolean {
  return status === "authenticated" || status === "unauthenticated";
}

/**
 * The `providers.awaitLogin` window in which the ambient verdict is NOT yet
 * settled, and so must not be read as a failed sign-in.
 *
 * The host's login runner evicts the ambient auth cache when the login child
 * closes, and assembles the response's `state` from a NON-BLOCKING re-probe
 * (older hosts always; any host when a background probe is still running), so
 * a fresh, successful login can settle the long-poll while its own verdict is
 * still in flight. `authPending` is the host saying exactly that. Callers wait
 * it out with a bounded re-poll rather than concluding anything - re-awaiting
 * is cheap, since with no login job in flight the host resolves immediately
 * with a re-probed state.
 *
 * Both surfaces that turn an `awaitLogin` completion into a decision read this
 * one predicate - Settings' login flow (which drives its own state machine off
 * it) and onboarding's "Sign in to enable" button (which decides whether to
 * write the enablement). A second copy of the rule would be a silent
 * divergence in exactly the case neither surface can reproduce on demand.
 */
export function isAmbientAuthVerdictPending(
  state: ProviderMutationCliStateV21,
): boolean {
  return (
    state.authPending && !isDefinitiveProviderAuthStatus(state.auth.status)
  );
}

/**
 * Budget for the bounded re-poll of the window above: a few short re-polls let
 * a background probe land instead of misreporting a successful sign-in as a
 * failure. Definitive verdicts are never re-polled, so this only ever bounds
 * the unsettled case.
 *
 * Beside the predicate rather than in either flow because BOTH flows spend it
 * - Settings' login state machine and onboarding's "Sign in to enable" button
 * - and two budgets would mean the same sign-in gets a different amount of
 * patience depending on which screen the user is standing on.
 */
export const AMBIENT_AUTH_PENDING_REPOLL_CAP = 3;
// Exported so tests can drive the re-poll deterministically with fake timers
// instead of hardcoding a duplicate magic number that could silently drift
// from this value.
export const AMBIENT_AUTH_PENDING_REPOLL_DELAY_MS = 2_000;

/**
 * Definitive signed-in verdict for the terminal/ambient account - the
 * symmetric complement of {@link isProviderAmbientSignedOut}. Used by the
 * re-auth gate's reconnect bookend so the "reconnected" edge tracks the same
 * two sources the sign-out edge does: a reconnect that only lands on the
 * ambient profile row first (with the provider-level summary still lagging)
 * still clears the latch. A definitive `unauthenticated` on either source wins
 * (returns false) so a half-converged reconnect never phantom-clears while the
 * account is still signed out.
 *
 * Onboarding's "Sign in to enable" spends this on an `awaitLogin` completion
 * for the same reason, and gets both halves of that rule: an ambient row that
 * lands first no longer burns the re-poll budget waiting for the summary, and
 * a stale top-level `authenticated` can no longer enable a provider whose
 * ambient row definitively says otherwise.
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
