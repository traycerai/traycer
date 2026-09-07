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
 * Providers whose `host.getRateLimitUsage` arm carries native account detail.
 * Re-exported from the protocol enum so host dispatch and GUI eligibility cannot silently drift apart.
 */
export type RateLimitProviderId = RateLimitCapableProviderId;

/** Fetch cost class for a rate-limit-capable provider - the load-bearing split the polling scheduler branches on: */
export type RateLimitFetchLane = "httpFetch" | "ephemeralProcess";

/**
 * Credential eligibility is scoped to the target that owns the credential: terminal/ambient usage reads depend on the provider's ambient auth summary, while managed profiles own and report their own credentials.
 */
export interface RateLimitFetchEligibility {
  readonly ambient: boolean;
  readonly managedProfiles: boolean;
}

/**
 * Shared "how fresh is fresh enough" floor for provider rate-limit reads: the `staleTime` on the provider rate-limit query, the minimum spacing the turn-completion refresh hook enforces, and the queue's own automatic-trigger cooldown.
 */
export const PROVIDER_RATE_LIMITS_STALE_TIME_MS = 5 * 60 * 1000;

export function isRateLimitCapableProvider(
  providerId: ProviderId,
): providerId is RateLimitProviderId {
  return rateLimitCapableProviderIdSchema.safeParse(providerId).success;
}

/**
 * The one named home for the provider -> lane mapping.
 * Load-bearing in the query options (which lane enables the table-owned fixed cadence), the turn-completion refresh hook (which trigger routes through the serial queue), and the interval timer (which providers it walks) - so it lives here once rather than.
 */
export function rateLimitFetchLane(
  providerId: RateLimitProviderId,
): RateLimitFetchLane {
  switch (providerId) {
    case "openrouter":
    case "kilocode":
    case "huggingface":
    case "opencode":
    case "cursor":
      // Two round trips (the API key mints a dashboard session before the usage read), but still credential-and-fetch - no subprocess - so it keeps the table-owned fixed cadence rather than the serial queue.
      return "httpFetch";
    case "codex":
    case "claude-code":
    case "grok":
      // Grok reads usage over the vendored CLI's own `_x.ai/billing` ACP extension (a subprocess RPC, so Traycer never touches the grok OAuth token) - an ephemeral spawn like codex/claude-code, despite grok's credit-shaped payload resembling the httpFetch providers'.
      return "ephemeralProcess";
  }
}

/**
 * Whether the terminal/ambient credential is currently valid for a rate-limit pull.
 * This gates the persistent ambient app-shell queue; managed profiles instead use `resolveRateLimitFetchEligibility` plus their own profile auth.
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
 * Whether a profile can perform its own usage read under the provider's settled availability state.
 * Managed profiles deliberately do not inherit terminal/ambient sign-out: they authenticate independently.
 */
export function isRateLimitProfileFetchEligible(
  eligibility: RateLimitFetchEligibility,
  profile: ProviderProfile,
): boolean {
  return (
    profile.enabled &&
    (profile.kind === "ambient"
      ? eligibility.ambient
      : eligibility.managedProfiles) &&
    hasUsableProfileCredential(profile)
  );
}

/** Backward-compatible ambient/legacy alias for the app-shell queue. */
export function isRateLimitProviderConfigured(
  state: ProviderCliState,
): boolean {
  return resolveRateLimitFetchEligibility(state).ambient;
}
