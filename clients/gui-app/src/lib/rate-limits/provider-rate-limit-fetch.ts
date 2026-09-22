import { hashKey, type QueryClient } from "@tanstack/react-query";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import type { RequestOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { queryKeys } from "@/lib/query-keys";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import {
  mapResponseToProviderRateLimitEnvelope,
  type ProviderRateLimitEnvelope,
  type RateLimitUsageResponse,
} from "@/lib/rate-limits/rate-limit-envelope";
import { isRateLimitReadStillRunningOnHost } from "@/lib/rate-limits/rate-limit-read-status";
import {
  RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS,
  RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
} from "@/lib/rate-limits/rate-limit-timing";

/**
 * The one way the GUI reads an `ephemeralProcess` provider's usage (codex,
 * claude-code, grok - the providers whose host-side read spawns a CLI). Every
 * trigger calls it: a surface mounting, the app-shell's background poll, a
 * turn completing, a person clicking Refresh, a Codex reset credit being spent.
 *
 * Each call is an independent request. Nothing here orders one target behind
 * another, one provider behind another, or one host behind another: how many
 * probes may run at once is the HOST's decision (`provider-probe-gates.ts`
 * there), because only the host sees every caller - every window, the agent
 * tool, the fallback ladder - and only it knows which reads it can answer from
 * its gauge without spawning anything.
 *
 * `force` is the whole difference between the triggers:
 *
 * - `false` (open, poll, turn completion): skips a key whose reading is younger
 *   than `PROVIDER_RATE_LIMITS_STALE_TIME_MS`, and otherwise asks the host with
 *   `force: false`, which lets it serve its gauge inside its own floors rather
 *   than spawn.
 * - `true` (a click, a spent reset credit): always asks, with `force: true`. A
 *   forced call that finds an AUTOMATIC fetch of the same key in flight waits
 *   for it and then asks again, forced: that automatic request may be answered
 *   from the host's gauge, and a person who clicked Refresh - or just spent a
 *   reset credit - must not be handed the reading from before it.
 *
 * `force` never enters the cache key, so every trigger reads and writes the one
 * `(host, provider, profile)` entry the surfaces observe. Those observers stay
 * disabled for this lane (`providerRateLimitQueryOptions`): an observer's own
 * fetch would send no `force` at all, which the wire reads as forced.
 */

type RateLimitUsageParams = RequestOfMethod<
  HostRpcRegistry,
  "host.getRateLimitUsage"
>;

/**
 * The transport call one read makes. `responseTimeoutMs` is this read's frame
 * budget (`RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS`); the binding site forwards it
 * to `requestWithResponseTimeout`, since a CLI-backed read legitimately outruns
 * the transport's default frame timeout.
 */
export type ProviderRateLimitRequestFn = (
  method: "host.getRateLimitUsage",
  params: RateLimitUsageParams,
  responseTimeoutMs: number,
) => Promise<RateLimitUsageResponse>;

/**
 * Which host a read goes to and which cache it writes. Snapshotted by the
 * caller at call time, with a requester pinned to `hostId`, so a read that
 * outlives a host switch still answers for the host it asked and writes under
 * that host's key.
 */
export interface ProviderRateLimitFetchScope {
  readonly hostId: string;
  readonly queryClient: QueryClient;
  readonly request: ProviderRateLimitRequestFn;
}

export interface ProviderRateLimitFetchTarget {
  readonly providerId: RateLimitProviderId;
  readonly accountContext: AccountContext;
  readonly profileId: string | null;
}

interface PendingProviderRateLimitFetch {
  readonly force: boolean;
  readonly promise: Promise<void>;
}

// One entry per cache key with a fetch of ours in flight, and only so a forced
// call can tell an automatic fetch (wait, then ask again) from a forced one
// (join it). Removed BEFORE the entry's promise resolves, so a forced call
// chained behind it always finds the slot empty and issues a real request. A
// newer entry can replace one whose fetch was cancelled, which is why removal
// checks identity.
const pendingFetches = new Map<string, PendingProviderRateLimitFetch>();

function waitFor(delayMs: number): Promise<void> {
  // `window.setTimeout`, not the ambient one: the fake-timer suites drive it.
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

/**
 * Reads one target's usage and writes it into that target's cache entry.
 * Resolves when the read settles, never rejects: a failure is kept on the cache
 * entry for its observers, and one target's failure is nobody else's.
 *
 * A `null` scope (the host is not ready yet) resolves immediately and asks
 * nothing, the same readiness gate the observers have.
 */
export function fetchProviderRateLimits(
  scope: ProviderRateLimitFetchScope | null,
  target: ProviderRateLimitFetchTarget,
  opts: { readonly force: boolean },
): Promise<void> {
  if (scope === null) return Promise.resolve();
  const { hostId, queryClient, request } = scope;
  const params: RateLimitUsageParams = {
    accountContext: target.accountContext,
    providerId: target.providerId,
    profileId: target.profileId,
  };
  const queryKey = queryKeys.hostMethod<
    HostRpcRegistry,
    "host.getRateLimitUsage"
  >(hostId, "host.getRateLimitUsage", params);
  const pendingKey = hashKey(queryKey);

  const pending = pendingFetches.get(pendingKey);
  // An entry whose query has stopped fetching has nothing left to deliver: it
  // was cancelled (`cancelQueries` idles the query synchronously) or it has
  // just settled and is about to clear. Joining it would hand this caller no
  // read at all, so it is treated as absent.
  if (
    pending !== undefined &&
    queryClient.getQueryState(queryKey)?.fetchStatus !== "idle"
  ) {
    if (!opts.force || pending.force) return pending.promise;
    return pending.promise.then(() =>
      fetchProviderRateLimits(scope, target, { force: true }),
    );
  }

  if (!opts.force) {
    const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
    if (Date.now() - updatedAt < PROVIDER_RATE_LIMITS_STALE_TIME_MS) {
      return Promise.resolve();
    }
  }

  const force = opts.force;
  function requestUsage(forced: boolean): Promise<RateLimitUsageResponse> {
    // `force` rides the request only - never `params`, which is the cache key.
    return request(
      "host.getRateLimitUsage",
      { ...params, force: forced },
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );
  }

  // Named, so the host-scoped key stays the sole cache identity.
  // Boundary-wrapped because this writes the same entry the HostRpcError-typed
  // observers read.
  function queryFn(): Promise<ProviderRateLimitEnvelope> {
    return withHostQueryErrorBoundary("host.getRateLimitUsage", async () => {
      const response = await requestUsage(force).catch(
        async (error: unknown): Promise<RateLimitUsageResponse> => {
          // We stopped waiting, but the host is still reading and will keep
          // what it reads in its gauge. Collect it once, a little later, from
          // that gauge (`force: false`) instead of reporting a failure now and
          // spawning a second probe for an answer already on its way. The
          // entry stays in its fetching state meanwhile, so nothing reads this
          // window as an error.
          if (!isRateLimitReadStillRunningOnHost(error)) throw error;
          await waitFor(RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS);
          return requestUsage(false);
        },
      );
      return mapResponseToProviderRateLimitEnvelope({
        response,
        queryClient,
        queryKey,
      });
    });
  }

  let resolveSettled = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const entry: PendingProviderRateLimitFetch = { force, promise: settled };
  pendingFetches.set(pendingKey, entry);
  void queryClient
    .fetchQuery({
      queryKey,
      queryFn,
      // Freshness was decided above; once a read gets here it must run.
      staleTime: 0,
      // The collection above is the only retry. The app-wide default retries
      // every non-retryable transport error once, which here would re-send the
      // same probe while the first is still running on the host.
      retry: false,
      meta: stampHostRpcMethod(undefined, "host.getRateLimitUsage"),
      gcTime: Infinity,
    })
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (pendingFetches.get(pendingKey) === entry) {
        pendingFetches.delete(pendingKey);
      }
      resolveSettled();
    });
  return settled;
}

/** Test-only: forget every in-flight fetch so each test starts clean. */
export function __resetProviderRateLimitFetchesForTests(): void {
  pendingFetches.clear();
}
