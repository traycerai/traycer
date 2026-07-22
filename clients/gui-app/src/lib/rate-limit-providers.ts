import type {
  ProviderAuthStatus,
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  rateLimitCapableProviderIdSchema,
  type RateLimitCapableProviderId,
} from "@traycer/protocol/host/rate-limit";
import { isProviderAmbientSignedOut } from "@/lib/providers/provider-ambient-auth";

/**
 * The two providers `host.getRateLimitUsage @1.2`'s `providerRateLimits`
 * union reports full native detail for. Every other `ProviderId` (including
 * `traycer`, which uses the flat aperture fields on the same RPC) resolves
 * to the `available: false` arm if ever queried - the GUI simply never asks
 * for it. Re-exported from the protocol's own enum (rather than hand-listed
 * here again) so the host's dispatch, the wire schema's two available arms,
 * and this GUI type can't silently drift apart.
 */
export type RateLimitProviderId = RateLimitCapableProviderId;

/**
 * Fetch cost class for a rate-limit-capable provider - the load-bearing split
 * the polling scheduler branches on:
 *
 * - `"httpFetch"`: the host resolves a credential it already has and issues a
 *   plain GET (openrouter, kilocode). Cheap and safe to run concurrently, so
 *   their observers opt into the table-owned fixed cadence and never enter the
 *   serial queue.
 * - `"ephemeralProcess"`: the host spawns a real CLI subprocess to read usage
 *   (codex, claude-code). Expensive; these are funnelled through a shared
 *   queue so background and single-profile triggers cannot overlap. The
 *   deliberate exception is the popover's "Refresh all" queue item, which fans
 *   out its configured profiles together before the next item begins.
 */
export type RateLimitFetchLane = "httpFetch" | "ephemeralProcess";

/**
 * Credential eligibility is scoped to the target that owns the credential:
 * terminal/ambient usage reads depend on the provider's ambient auth summary,
 * while managed profiles own and report their own credentials.
 */
export interface RateLimitFetchEligibility {
  readonly ambient: boolean;
  readonly managedProfiles: boolean;
}

/**
 * Shared "how fresh is fresh enough" floor for provider rate-limit reads: the
 * `staleTime` on the provider rate-limit query, the minimum spacing the
 * turn-completion refresh hook enforces, and the queue's own automatic-trigger
 * cooldown. Unlike the aperture read (a cheap cloud call), an
 * `ephemeralProcess` pull spawns a real CLI subprocess, so a burst of triggers
 * (a queued run finishing, an interval tick landing next to a turn completion)
 * must not each spawn their own.
 *
 * Homed here - alongside the lane classifier it is conceptually paired with -
 * rather than in the turn-completion hook, so the queue module, the query
 * options, and that hook can all read it without an import cycle.
 */
export const PROVIDER_RATE_LIMITS_STALE_TIME_MS = 5 * 60 * 1000;

export function isRateLimitCapableProvider(
  providerId: ProviderId,
): providerId is RateLimitProviderId {
  return rateLimitCapableProviderIdSchema.safeParse(providerId).success;
}

/**
 * The one named home for the provider -> lane mapping. Load-bearing in the
 * query options (which lane enables the table-owned fixed cadence), the turn-completion
 * refresh hook (which trigger routes through the serial queue), and the
 * interval timer (which providers it walks) - so it lives here once rather
 * than being re-derived at each of those three sites.
 */
export function rateLimitFetchLane(
  providerId: RateLimitProviderId,
): RateLimitFetchLane {
  switch (providerId) {
    case "openrouter":
    case "kilocode":
      return "httpFetch";
    case "codex":
    case "claude-code":
      return "ephemeralProcess";
  }
}

/**
 * Whether the terminal/ambient credential is currently valid for a rate-limit
 * pull. This gates the persistent ambient app-shell queue; managed profiles
 * instead use `resolveRateLimitFetchEligibility` plus their own profile auth.
 *
 * - `availabilityPending`: provider availability has not settled, so no target
 *   may use it yet. `authPending` is deliberately target-local: it is an
 *   aggregate bit once profiles exist, and must not suppress a settled sibling.
 * - `"authenticated"`: verified good credentials.
 * - `"configured"`: credentials are present but unverified (e.g. an API key set
 *   for openrouter/kilocode before the first probe) - included because the pull
 *   itself is what verifies them, and it degrades gracefully if they are bad.
 * - `"unauthenticated"` / `"unavailable"` / `"unknown"`: no usable credential
 *   to authenticate a usage call, so the provider is not polled.
 * - `enabled: false`: the user turned the provider off; don't spend a fetch on
 *   a provider they have disabled.
 */
function isRateLimitProviderAvailableForUsage(
  state: ProviderCliState,
): boolean {
  if (!state.enabled) return false;
  if (state.availabilityPending) return false;
  return true;
}

function hasUsableCredential(status: ProviderAuthStatus): boolean {
  return status === "authenticated" || status === "configured";
}

function hasUsableProfileCredential(profile: ProviderProfile): boolean {
  return hasUsableCredential(profile.auth.status);
}

function ambientFetchEligible(state: ProviderCliState): boolean {
  if (!isRateLimitProviderAvailableForUsage(state)) return false;
  if (isProviderAmbientSignedOut(state)) return false;
  const ambientProfile = state.profiles.find(
    (profile) => profile.kind === "ambient",
  );
  if (ambientProfile !== undefined) {
    return hasUsableProfileCredential(ambientProfile);
  }
  if (state.authPending) return false;
  return hasUsableCredential(state.auth.status);
}

export function resolveRateLimitFetchEligibility(
  state: ProviderCliState,
): RateLimitFetchEligibility {
  const managedProfiles = isRateLimitProviderAvailableForUsage(state);
  return {
    managedProfiles,
    ambient: ambientFetchEligible(state),
  };
}

/**
 * Whether a profile can perform its own usage read under the provider's
 * settled availability state. Managed profiles deliberately do not inherit
 * terminal/ambient sign-out: they authenticate independently.
 */
export function isRateLimitProfileFetchEligible(
  eligibility: RateLimitFetchEligibility,
  profile: ProviderProfile,
): boolean {
  return (
    (profile.kind === "ambient"
      ? eligibility.ambient
      : eligibility.managedProfiles) && hasUsableProfileCredential(profile)
  );
}

/** Backward-compatible ambient/legacy alias for the app-shell queue. */
export function isRateLimitProviderConfigured(
  state: ProviderCliState,
): boolean {
  return resolveRateLimitFetchEligibility(state).ambient;
}
