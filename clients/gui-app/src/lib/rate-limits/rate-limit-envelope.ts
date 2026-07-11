import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  ProviderRateLimits,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";

const PROVIDERS_LIST_METHOD_DISCRIMINATOR = "providers.list";

/** The `available: true` arm of `ProviderRateLimits` - the only shape worth retaining. */
export type AvailableProviderRateLimits = Extract<
  ProviderRateLimits,
  { available: true }
>;

/** The raw wire response for `host.getRateLimitUsage` at whatever version the GUI currently negotiates. */
export type RateLimitUsageResponse = ResponseOfMethod<
  HostRpcRegistry,
  "host.getRateLimitUsage"
>;

/**
 * Reasons a provider-pull can fail that are transient - a fetch problem on
 * THIS attempt, not a statement about the account's capability to ever report
 * usage. `usage_fetch_failed` is the CLI usage-HTTP-fetch failure the Claude
 * usage-limit fix's protocol ticket split out (e.g. a server-side 429 on
 * Anthropic's `/api/oauth/usage` with a multi-minute penalty window);
 * `timeout`/`connection_failed` are the probe-level analogues. Every other
 * reason (`rate_limits_not_available`, `cli_not_found`, etc.) is authoritative
 * - it says something about the account/setup, not "try again shortly" - so a
 * retained last-good reading must NOT survive alongside one of those.
 */
const TRANSIENT_UNAVAILABLE_REASONS: ReadonlySet<RateLimitUnavailableReason> =
  new Set(["usage_fetch_failed", "timeout", "connection_failed"]);

export function isTransientUnavailableReason(
  reason: RateLimitUnavailableReason,
): boolean {
  return TRANSIENT_UNAVAILABLE_REASONS.has(reason);
}

/**
 * Renderer-memory envelope the `host.getRateLimitUsage` provider-pull query
 * cache entry holds (replacing the raw wire response as the cached `data`),
 * so a transient fetch failure (Core Flows: "couldn't fetch usage - will
 * retry") doesn't blank a real, recent reading the way replacing `data`
 * outright would.
 *
 * - `latest`: the most recent provider snapshot exactly as the wire reported
 *   it (its own `available` arm decides what the CURRENT attempt says).
 * - `lastGood`: the most recent `available: true` snapshot, retained across a
 *   transient failure. `null` once an authoritative unavailable reason
 *   arrives (that reason replaces the picture entirely - see
 *   `buildProviderRateLimitEnvelope`) or before any successful read has ever
 *   happened (cold start / after a reload - this is renderer-memory only).
 * - `lastGoodAt` / `lastFailureAt`: epoch-ms timestamps for the two events
 *   above, `null` until they've happened at least once in this envelope's
 *   lifetime.
 */
export interface ProviderRateLimitEnvelope {
  readonly latest: ProviderRateLimits | null;
  readonly lastGood: AvailableProviderRateLimits | null;
  readonly lastGoodAt: number | null;
  readonly lastFailureAt: number | null;
}

/**
 * Whether `response` carries a snapshot for one of the two providers that
 * support managed profiles (v1 is claude-code/codex only) - the only
 * providers `providers.list`'s per-profile `rateLimitStatus` can ever report
 * anything for. Openrouter/kilocode/traycer-aperture reads gate out here so a
 * convergence invalidation isn't spent on a provider that could never affect
 * the switch-prompt banner. Failed probes (`available: false` - timeout,
 * cli_not_found, ...) gate out too: they carry no usage the host's gauge cache
 * could have captured, so `providers.list` has nothing new to converge on.
 */
function isManagedProfileCapableRateLimitsResponse(
  response: RateLimitUsageResponse,
): boolean {
  const provider = response.providerRateLimits;
  return (
    provider !== null &&
    provider.available &&
    (provider.provider === "codex" || provider.provider === "claude-code")
  );
}

/**
 * Converges the composer's rate-limit switch-prompt banner (which reads
 * `providers.list`) with whatever this `host.getRateLimitUsage` fetch just
 * learned: a profile the popover/queue just observed crossing into (or out
 * of) near/hard limit should not wait for `providers.list`'s own unrelated
 * refetch cadence to reflect that.
 *
 * Invalidated by a broad key-prefix predicate rather than one exact `hostId`:
 * this fetch's own host (the default host, or whichever host the ephemeral
 * queue is bound to) is not necessarily the tab host the banner's
 * `providers.list` query is scoped to, and `providers.list` is a cheap
 * cache-only host read (no subprocess, no account probe), so invalidating it
 * across every currently-cached host scope is safe.
 */
function invalidateProvidersListForConvergence(
  queryClient: QueryClient,
  response: RateLimitUsageResponse,
): void {
  if (!isManagedProfileCapableRateLimitsResponse(response)) return;
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey.includes(PROVIDERS_LIST_METHOD_DISCRIMINATOR),
  });
}

/**
 * Pure accumulator: folds a fresh wire response into the envelope built from
 * `previous` (the envelope this same query key held before this fetch, or
 * `undefined` on a cold cache - the first fetch ever, or after a reload, since
 * this envelope is renderer-memory only).
 *
 * - `available: true` -> becomes the new `lastGood` outright.
 * - `available: false` with a transient reason -> `latest` reflects the
 *   failure, but `lastGood`/`lastGoodAt` carry over unchanged from `previous`
 *   (retention). `lastFailureAt` advances to `now`.
 * - `available: false` with an authoritative reason (`rate_limits_not_available`
 *   and friends), or no provider snapshot at all (`providerRateLimits: null` -
 *   an aperture-only call; never expected for the provider-pull branch this
 *   envelope serves, but handled the same way defensively) -> replaces the
 *   picture entirely: `lastGood`/`lastGoodAt`/`lastFailureAt` all reset to
 *   `null`. An authoritative "this account can't see usage" reading must
 *   never be shown dimmed alongside a stale good one.
 */
export function buildProviderRateLimitEnvelope(
  previous: ProviderRateLimitEnvelope | undefined,
  response: RateLimitUsageResponse,
  now: number,
): ProviderRateLimitEnvelope {
  const latest = response.providerRateLimits;

  if (latest !== null && latest.available) {
    return {
      latest,
      lastGood: latest,
      lastGoodAt: now,
      lastFailureAt: previous?.lastFailureAt ?? null,
    };
  }

  if (latest !== null && isTransientUnavailableReason(latest.reason)) {
    return {
      latest,
      lastGood: previous?.lastGood ?? null,
      lastGoodAt: previous?.lastGoodAt ?? null,
      lastFailureAt: now,
    };
  }

  return { latest, lastGood: null, lastGoodAt: null, lastFailureAt: null };
}

/**
 * The shared fetch wrapper both `host.getRateLimitUsage` provider-pull write
 * lanes fold their fresh response through before handing it to TanStack as
 * the cached `data`: the `ephemeralProcess` serial queue
 * (`ephemeral-fetch-queue.ts`, which fetches via its own `queryClient.fetchQuery`
 * call) and the `httpFetch` lane (`use-host-provider-rate-limits-query.ts` /
 * `use-header-rate-limit-bars.ts` / the popover's "Refresh all" button, all via
 * `useHostQueryWithResponseMap` / `useHostQueriesWithResponseMap`). Both write
 * into the same query-key family, so routing every write through this one
 * function is what keeps the envelope shape consistent no matter which lane's
 * fetch actually lands - see those hooks' own doc comments for why a bespoke
 * wrapper was necessary instead of the plain `useHostQuery` path.
 *
 * Reads `previous` from the exact cache slot the caller is about to write
 * (`queryClient.getQueryData(queryKey)`) - synchronous, and always up to date
 * for this purpose because it runs inside the same queryFn invocation that
 * will overwrite that slot.
 *
 * Also the single point where a resolved codex/claude-code fetch converges
 * `providers.list` (`invalidateProvidersListForConvergence`) - every real
 * `host.getRateLimitUsage` fetch for those two providers folds through this
 * function (the ephemeral queue's own `queryFn`; every other observer of
 * these providers' query key stays `enabled: false`), so this is exactly
 * "whenever a rate-limit usage fetch resolves" without duplicating the
 * invalidation at each call site.
 */
export function mapResponseToProviderRateLimitEnvelope(args: {
  readonly response: RateLimitUsageResponse;
  readonly queryClient: QueryClient;
  readonly queryKey: QueryKey;
}): ProviderRateLimitEnvelope {
  const previous = args.queryClient.getQueryData<ProviderRateLimitEnvelope>(
    args.queryKey,
  );
  invalidateProvidersListForConvergence(args.queryClient, args.response);
  return buildProviderRateLimitEnvelope(previous, args.response, Date.now());
}

/**
 * What a consumer should currently render for a provider: the retained
 * `lastGood` reading when the latest attempt is a transient failure with one
 * available, otherwise exactly what the latest attempt reported (a good
 * reading, an authoritative unavailable reason, or `null` if no provider
 * snapshot has ever arrived). Shared by both resolvers in
 * `provider-rate-limit-content.ts` and by the header glyph bars
 * (`use-header-rate-limit-bars.ts`), so all three surfaces retain identically.
 */
export function resolveRetainedProviderRateLimits(
  envelope: ProviderRateLimitEnvelope | null,
): ProviderRateLimits | null {
  if (envelope === null) return null;
  const { latest, lastGood } = envelope;
  if (latest === null) return null;
  if (latest.available) return latest;
  if (isTransientUnavailableReason(latest.reason) && lastGood !== null) {
    return lastGood;
  }
  return latest;
}

/**
 * Whether the CURRENT retained view (`resolveRetainedProviderRateLimits`) is a
 * dimmed last-known-good reading rather than a fresh one - true only when the
 * latest attempt itself is a transient failure and a `lastGood` reading is
 * being shown in its place. Distinct from a query-level `isError` degrade
 * (TanStack retaining old data across a thrown fetch exception): that case
 * has no specific wire reason to report and stays the caller's own generic
 * "refresh failed" treatment.
 */
export function envelopeDegradedReason(
  envelope: ProviderRateLimitEnvelope | null,
): RateLimitUnavailableReason | null {
  if (envelope === null) return null;
  const { latest, lastGood } = envelope;
  if (latest === null || latest.available) return null;
  if (isTransientUnavailableReason(latest.reason) && lastGood !== null) {
    return latest.reason;
  }
  return null;
}
