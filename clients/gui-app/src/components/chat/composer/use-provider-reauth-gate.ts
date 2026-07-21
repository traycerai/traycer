import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useTabProvidersList } from "@/hooks/providers/use-tab-providers-list-query";
import type { ComposerSeedSourceKind } from "@/lib/composer/composer-seed-source";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { providerCliIdForHarness } from "@/lib/provider-ordering";

/**
 * - `provider_unauthenticated`: the ambient/host login itself is signed out
 *   (today's original, single-reason gate) - `profileId` is `null`.
 * - `profile_missing`: the chat's committed `profileId` isn't among this
 *   provider's active profiles - removed/tombstoned, OR the provider's
 *   `providers.list` has SETTLED on no profile support at all for this host
 *   (old host, flag off, or an unsupported provider - ticket 07 round 2: a
 *   persisted/memory/default non-null `profileId` must not silently reach the
 *   wire against a no-support host). Never silently falls back to ambient -
 *   blocks send and offers the confirm-first "Continue on Terminal account"
 *   affordance instead.
 * - `profile_unauthenticated`: the profile still exists but its OWN auth
 *   probe is signed out (distinct from the provider-level probe above, which
 *   only reflects the ambient login and must not gate a healthy managed
 *   profile just because ambient happens to be signed out).
 */
export type ProviderReauthReason =
  "provider_unauthenticated" | "profile_missing" | "profile_unauthenticated";

export interface ProviderReauthGate {
  readonly providerId: ProviderId | null;
  readonly profileId: string | null;
  readonly state: ProviderCliState | null;
  readonly signedOut: boolean;
  readonly reason: ProviderReauthReason | null;
  /** The matched profile's own label, when one was found (missing has none). */
  readonly profileLabel: string | null;
}

/**
 * Connection-level auth gate for the composer's currently-selected provider,
 * scoped to the tab's host. This replaces the per-message re-auth card: auth
 * is a property of `(tabHost, provider)`, not of any one turn, so the live
 * affordance lives here (above the composer) and derives purely from current
 * provider state - no `isLatestTurn`, no per-segment resolution store, no latch.
 *
 * `signedOut` is a pure predicate: a *definitive* probe `unauthenticated`. A
 * transient `unknown` does not flip it (no flicker on the host probe's race);
 * the host poison (`markProviderUnauthenticated`, written the instant it
 * detects a credential failure) guarantees a definitive `unauthenticated` after
 * a real failure, so there is no renderer-side "last turn failed" flag to carry
 * - the `code: "auth"` stream frame drives a plain `providers.list` invalidate
 * and the refetch reads the poison.
 *
 * The gate intentionally does NOT auto-force-refresh on activate: a bare
 * force-refresh bypasses the host poison and re-runs the flaky standalone
 * probe, which on a pure subscription reports `authenticated` while the run
 * 401s - flipping `signedOut` off and flickering the banner. Re-checks are
 * user-driven (the banner's Refresh button) or driven by the next failing
 * run's poison. An external `claude /logout` while the composer was unmounted
 * therefore surfaces on the next send (which re-poisons) or a manual Refresh.
 */
// `settled` distinguishes "the tab-scoped `providers.list` query hasn't
// resolved yet" (a stray non-null `profileId` can't be judged against
// nothing - stays inert) from "it HAS resolved, with no profiles for this
// provider" (a flag-on, capable host always synthesizes at least the ambient
// row - see `resolveProfileWireEntries`/`synthesizeAmbientProfile` on the
// host - so a settled-empty `profiles[]` is a real "no support here" verdict,
// not an unknown one). Once settled, `matchedProfile` naturally resolves to
// `null` whether the provider entry itself is missing or its `profiles[]` is
// merely empty - both cases fall through to `profile_missing` below, exactly
// mirroring `resolveSeededProfileId`'s round-1 fix for the fork-dialog seed
// path (ticket 07).
//
// `authoritative` is the banner-flash fix, and it gates ONLY the
// `profile_missing` conclusion - NOT `profile_unauthenticated`. A fallback
// seed (composer-run-settings-store's epic/global last-run, a landing
// draft's frozen snapshot, a settings-store default, ...) is a PICKER
// DEFAULT, not a chat pin - it can legitimately carry a profileId minted on
// a different host/session that simply doesn't exist here, and accusing a
// non-existent row of being "missing" is always a false alarm that self-
// corrects the instant the chat's own authoritative settings hydrate
// (exactly what painted the "This chat's Codex profile is no longer
// available" flash on a tab switch / fresh chat).
//
// `profile_unauthenticated` is different: it only fires once `matchedProfile`
// is non-null, i.e. the profile genuinely EXISTS on this host (prong 2's seed
// validation - `useComposerToolbarStore`'s `client`/`seedIsAuthoritative` -
// has already nulled out any non-existent fallback pin before it ever
// reaches this gate, so a non-authoritative selection that still resolves to
// a real row is a CONFIRMED-EXISTING profile, not a guess). A confirmed
// profile whose own probe is definitively `unauthenticated` cannot flash
// spuriously (a transient `unknown` never trips this) and will not self-
// correct away (the fallback stays the seed until the user acts) - so
// suppressing it here would silently un-block send on a signed-out profile:
// the turn would dispatch, fail host-side mid-send, and only THEN show the
// banner once the chat's own settings became authoritative. Always surface
// it instead, authoritative or not.
//
// `provider_unauthenticated` (the ambient/host-wide probe, keyed on
// `profileId === null`, never a per-chat pin) is unaffected by
// `authoritative` either way.
function deriveReauthReason(input: {
  readonly enabled: boolean;
  readonly authoritative: boolean;
  readonly settled: boolean;
  readonly profileId: string | null;
  readonly state: ProviderCliState | null;
  readonly matchedProfile: ProviderCliState["profiles"][number] | null;
}): ProviderReauthReason | null {
  if (!input.enabled) return null;
  if (input.profileId === null) {
    return input.state?.auth.status === "unauthenticated"
      ? "provider_unauthenticated"
      : null;
  }
  if (!input.settled) return null;
  if (input.matchedProfile === null) {
    return input.authoritative ? "profile_missing" : null;
  }
  return input.matchedProfile.auth.status === "unauthenticated"
    ? "profile_unauthenticated"
    : null;
}

export function useProviderReauthGate(
  harnessId: GuiHarnessId,
  profileId: string | null,
  active: boolean,
  /**
   * S11: the SAME `ComposerSeedSource.kind` the caller's `useComposerToolbarStore`
   * call is fed - `"authoritative"` when `profileId` came from the chat's own
   * authoritative settings (a real pin), anything else when it came from a
   * fallback/picker-default seed. Consuming the identical discriminant (not a
   * separately re-derived `settingsSeed !== null` boolean) keeps this in
   * lockstep with the toolbar store's own seed-validation decision - see the
   * `deriveReauthReason` comment above for why that distinction matters.
   */
  seedKind: ComposerSeedSourceKind,
): ProviderReauthGate {
  const authoritative = seedKind === "authoritative";
  const providerId = providerCliIdForHarness(harnessId);
  const enabled = active && providerId !== null;
  const query = useTabProvidersList({ enabled, subscribed: enabled });
  // `providers.list` always returns every configured provider in one atomic
  // response, so `data !== undefined` is a trustworthy "this provider's entry
  // (or lack of one) is final" signal - mirrors
  // `useResolvedSeededProfileId`'s `settled` derivation.
  const settled = query.data !== undefined;

  const state =
    query.data?.providers.find((p) => p.providerId === providerId) ?? null;
  // `null` for ambient - a non-null `profileId` can only ever match a managed
  // profile's own real id (never the wire array's "ambient" sentinel), so no
  // normalization is needed here the way the rail/rate-limit prompt need it.
  const matchedProfile =
    profileId === null || state === null
      ? null
      : (state.profiles.find((p) => p.profileId === profileId) ?? null);

  const reason = deriveReauthReason({
    enabled,
    authoritative,
    settled,
    profileId,
    state,
    matchedProfile,
  });
  const signedOut = reason !== null;
  const profileLabel = matchedProfile?.label ?? null;

  // Bookend the reconnect loop with one-shot toasts: a notice when the provider
  // first goes signed-out (the failure has no transcript row - it's suppressed
  // as a connection condition - so this is the transient "why did nothing
  // happen?" acknowledgement), and a success when it returns. Feedback, not
  // stored state: the banner still mounts/unmounts purely from `signedOut`, so
  // nothing here resurrects the old per-segment "resolved" memory.
  //
  // The latch holds the *provider* that was signed out, not a bool, so each edge
  // fires exactly once. A token paste makes the host re-probe, emitting a
  // transient `unknown` between paste and verdict; a bool reset on every render
  // would clear during that gap and double-fire. Holding the provider id also
  // means a provider the user merely *switched to* (already authenticated) never
  // phantom-fires, and deactivating the composer (`state` -> null) can't either.
  //
  // Scoped to `provider_unauthenticated` only (the ambient case this toast copy
  // was written for) - the profile-specific reasons block send via the banner
  // without this connection-level toast.
  const providerUnauthenticated = reason === "provider_unauthenticated";
  const authStatus = state?.auth.status ?? null;
  const signedOutProviderRef = useRef<ProviderId | null>(null);
  useEffect(() => {
    if (providerUnauthenticated && providerId !== null) {
      if (signedOutProviderRef.current !== providerId) {
        signedOutProviderRef.current = providerId;
        reportableErrorToast(
          `${PROVIDER_DISPLAY_NAMES[providerId]} is signed out`,
          undefined,
          {
            title: "Provider signed out",
            message: null,
            code: null,
            source: "Chat",
          },
        );
      }
    } else if (
      authStatus === "authenticated" &&
      providerId !== null &&
      signedOutProviderRef.current === providerId
    ) {
      signedOutProviderRef.current = null;
      toast.success(`${PROVIDER_DISPLAY_NAMES[providerId]} reconnected`);
    }
  }, [providerUnauthenticated, authStatus, providerId]);

  return { providerId, profileId, state, signedOut, reason, profileLabel };
}
