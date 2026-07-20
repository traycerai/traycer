import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";

export const PROVIDERS_LIST_REFRESH_MS = 15 * 60 * 1000;
export const PROVIDERS_LIST_PENDING_REFRESH_MS = 800;

/**
 * Bounded-staleness cadence while any profile is reporting near/hard limit -
 * short enough that the rate-limit switch-prompt banner (which reads
 * `providers.list`) self-clears within half a minute of the provider's window
 * actually resetting (Part A's reset-aware gauge derivation on the host now
 * reports that reset instead of a stale-forever limit), even with the app
 * otherwise idle and no turn/fetch around to trigger a convergence
 * invalidation. Doubles as the fast-poll fallback once a pending probe
 * overruns its budget (below).
 */
export const PROVIDERS_LIST_LIMITED_REFRESH_MS = 30 * 1000;

/**
 * How long the 800 ms fast-poll may run continuously while a probe is pending
 * before it backs off to the bounded cadence. A cold shell-env probe settles
 * within ~86 s (4 x 20 s attempts), so this budget lets a legitimate probe
 * resolve at full speed; a probe that is genuinely stuck (a hung shell rc, an
 * unreachable api-key backend, a `--version` that never returns) then degrades
 * to one call / 30 s instead of pinning a perpetual sub-second storm. The
 * budget restarts whenever the pending state clears, so a real probe that
 * settles and a later fresh probe each get the full fast-poll window.
 */
export const PROVIDERS_LIST_PENDING_FAST_POLL_BUDGET_MS = 90 * 1000;

type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

function hasPendingProbe(data: ProvidersListResponse | undefined): boolean {
  return (
    data?.providers.some(
      (provider) =>
        // A disabled provider never launches, so its auth/availability/version
        // probes are irrelevant and must not drive the fast-poll. The host
        // clears these flags for disabled providers at the wire boundary, but
        // gate here too so a released client stays calm against an older host
        // that still surfaces them.
        provider.enabled &&
        (provider.authPending ||
          provider.availabilityPending ||
          provider.candidates.some((candidate) => candidate.versionPending)),
    ) ?? false
  );
}

function hasLimitedProfile(data: ProvidersListResponse | undefined): boolean {
  return (
    data?.providers.some((provider) =>
      provider.profiles.some(
        (profile) =>
          profile.rateLimitStatus === "near_limit" ||
          profile.rateLimitStatus === "hard_limit",
      ),
    ) ?? false
  );
}

/**
 * Pure `providers.list` refetch cadence: fastest while any enabled provider's
 * probe is still pending (auth / availability / version), bounded once that
 * pending state overruns its fast-poll budget or while any profile is near/at
 * its rate limit, otherwise the steady catalog cadence. `pendingElapsedMs` is
 * the continuous time the pending state has held (0 when not pending);
 * `providersListRefetchIntervalForQuery` supplies it, keyed to the query.
 */
export function providersListRefetchInterval(
  data: ProvidersListResponse | undefined,
  pendingElapsedMs: number,
): number {
  if (hasPendingProbe(data)) {
    return pendingElapsedMs <= PROVIDERS_LIST_PENDING_FAST_POLL_BUDGET_MS
      ? PROVIDERS_LIST_PENDING_REFRESH_MS
      : PROVIDERS_LIST_LIMITED_REFRESH_MS;
  }
  if (hasLimitedProfile(data)) return PROVIDERS_LIST_LIMITED_REFRESH_MS;
  return PROVIDERS_LIST_REFRESH_MS;
}

// "Pending since" clock keyed by the SHARED TanStack Query instance. Every
// observer of one `providers.list` query (default host + tab host, Settings,
// each open tab) receives the same Query in its `refetchInterval` callback, so
// keying here makes the fast-poll budget PER QUERY, not per observer: a
// late-mounting observer cannot restart the budget and re-arm the 800 ms poll,
// and a host/query-key switch (a different Query) starts a fresh budget. The
// WeakMap lets a query dropped from the cache release its slot.
const pendingSinceByQuery = new WeakMap<object, number>();

/**
 * `refetchInterval` callback for both `providers.list` query hooks. Tracks the
 * pending-since timestamp against the shared `query` so the fast-poll budget is
 * enforced query-wide (see `pendingSinceByQuery`).
 */
export function providersListRefetchIntervalForQuery(query: {
  readonly state: { readonly data: ProvidersListResponse | undefined };
}): number {
  const data = query.state.data;
  if (!hasPendingProbe(data)) {
    pendingSinceByQuery.delete(query);
    return providersListRefetchInterval(data, 0);
  }
  const now = Date.now();
  let pendingSince = pendingSinceByQuery.get(query);
  if (pendingSince === undefined) {
    pendingSince = now;
    pendingSinceByQuery.set(query, pendingSince);
  }
  return providersListRefetchInterval(data, now - pendingSince);
}
