import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import {
  rateLimitCapableProviderIdSchema,
  type RateLimitCapableProviderId,
} from "@traycer/protocol/host/rate-limit";

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
 *   these poll on their own independent `refetchInterval` and never enter the
 *   serial queue.
 * - `"ephemeralProcess"`: the host spawns a real CLI subprocess to read usage
 *   (codex, claude-code). Expensive; these are funnelled through a shared
 *   queue so background and single-profile triggers cannot overlap. The
 *   deliberate exception is the popover's "Refresh all" queue item, which fans
 *   out its configured profiles together before the next item begins.
 */
export type RateLimitFetchLane = "httpFetch" | "ephemeralProcess";

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
 * query options (which lane gets a `refetchInterval`), the turn-completion
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
 * Whether `state` currently reports valid credentials for a rate-limit pull -
 * the gate both polling lanes share, read from the same `providers.list` auth
 * state the popover rail keys off. A provider enters a lane only while this is
 * `true`; because these subscriptions are now persistent (app-shell level, not
 * the transient Settings card that re-gates on every mount), a credential
 * removed mid-session drops the provider out on the very next tick.
 *
 * - `authPending` / `availabilityPending`: the host has not settled a verdict
 *   yet, so acting on the row would be premature - treated as not-yet-eligible.
 * - `"authenticated"`: verified good credentials.
 * - `"configured"`: credentials are present but unverified (e.g. an API key set
 *   for openrouter/kilocode before the first probe) - included because the pull
 *   itself is what verifies them, and it degrades gracefully if they are bad.
 * - `"unauthenticated"` / `"unavailable"` / `"unknown"`: no usable credential
 *   to authenticate a usage call, so the provider is not polled.
 * - `enabled: false`: the user turned the provider off; don't spend a fetch on
 *   a provider they have disabled.
 */
export function isRateLimitProviderConfigured(
  state: ProviderCliState,
): boolean {
  if (!state.enabled) return false;
  if (state.authPending || state.availabilityPending) return false;
  return (
    state.auth.status === "authenticated" || state.auth.status === "configured"
  );
}
