import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  ProviderRateLimits,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import { queryKeys } from "@/lib/query-keys";
import { createAppQueryClient } from "@/lib/query-client";
import type { HostRpcRegistry } from "@/lib/host";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";
import {
  EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS,
  RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
} from "@/lib/rate-limits/rate-limit-timing";
import {
  __resetRateLimitQueueForTests,
  configureRateLimitQueue,
  enqueueRateLimitFetch,
  enqueueRateLimitFetchBatch,
  enqueueRateLimitFetchForScope,
  isRateLimitFetchPending,
  isRateLimitQueueDraining,
  subscribeRateLimitQueue,
  type RateLimitQueueRequestFn,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

const HOST_ID = "host-1";

// A minimal valid `host.getRateLimitUsage` response - only the ordering of
// `request` calls matters to most of these tests, not the payload.
function response() {
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits: null };
}

// A provider-pull response reporting a specific unavailable reason - used by
// the cool-down tests below, which DO care about the payload.
function unavailableResponse(reason: RateLimitUnavailableReason) {
  const providerRateLimits: ProviderRateLimits = {
    provider: "claude-code",
    available: false,
    reason,
  };
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits };
}

function keyFor(providerId: ProviderId) {
  return keyForHost(HOST_ID, providerId, null);
}

function keyForHost(
  hostId: string,
  providerId: ProviderId,
  profileId: string | null,
) {
  return queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
    hostId,
    "host.getRateLimitUsage",
    { accountContext: DEFAULT_ACCOUNT_CONTEXT, providerId, profileId },
  );
}

// A `request` double whose promises settle only when the test explicitly
// releases them, so we can observe how many are in flight at any moment.
function makeControllableRequest() {
  const calls: Array<ProviderId | undefined> = [];
  const settlers: Array<{ ok: () => void; fail: () => void }> = [];
  const request: RateLimitQueueRequestFn = (_hostId, _method, params) => {
    calls.push(params.providerId);
    return new Promise((resolve, reject) => {
      settlers.push({
        ok: () => resolve(response()),
        fail: () => reject(new Error("boom")),
      });
    });
  };
  return { request: vi.fn(request), calls, settlers };
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// Flush pending microtasks/callbacks so `fetchQuery` has a chance to invoke the
// queued `queryFn`. Real timers are in effect for these tests.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("ephemeral-fetch-queue", () => {
  beforeEach(() => {
    __resetRateLimitQueueForTests();
  });
  afterEach(() => {
    __resetRateLimitQueueForTests();
    vi.useRealTimers();
  });

  // Ticket 06's guardrail 1 was "only one subprocess-spawning fetch in flight at
  // a time, even under rapid manual clicking", refined by #369 to one TRIGGER at
  // a time. The manual-clicking half was deliberately given up: a click paid for
  // that bound by waiting behind work it never asked for, under a "Queued" label.
  // What survives is asserted across the next three tests - automatic work still
  // serializes, and now also yields to anything a person asked for.
  it("serializes concurrent AUTOMATIC enqueues across providers - only one request is ever in flight", async () => {
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // Two background sweeps landing together. Nobody is waiting on either, so
    // the lane still spends exactly one subprocess at a time.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });

    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["codex"]);
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: keyFor("codex"), exact: true })?.options.meta,
    ).toMatchObject({ hostRpcMethod: "host.getRateLimitUsage" });

    // Release the first; only now may the second run.
    settlers[0].ok();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["codex", "claude-code"]);

    settlers[1].ok();
    await flush();
  });

  it("starts a forced pull immediately even while an automatic pull is running - a click never waits on work nobody asked for", async () => {
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // A background sweep takes the lane and is left in flight for the whole test.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();
    expect(calls).toEqual(["codex"]);

    // The click. Under the old lane this sat behind the sweep for up to the full
    // response budget; it now spawns straight away.
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["codex", "claude-code"]);

    settlers[0].ok();
    settlers[1].ok();
    await flush();
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("does not start automatic work while a forced pull is in flight, and resumes it once that pull settles", async () => {
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flush();
    expect(calls).toEqual(["codex"]);

    // Background work must not pile a second subprocess on top of the click.
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["codex"]);

    settlers[0].ok();
    await flush();
    expect(calls).toEqual(["codex", "claude-code"]);

    settlers[1].ok();
    await flush();
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("starts every profile in one refresh batch concurrently, then defers a later automatic item until the batch settles", async () => {
    const queryClient = newQueryClient();
    const profileStarts: Array<string | null> = [];
    const settlers: Array<() => void> = [];
    const request = vi.fn<RateLimitQueueRequestFn>(
      (_hostId, _method, params) => {
        profileStarts.push(params.profileId);
        return new Promise((resolve) => {
          settlers.push(() => resolve(response()));
        });
      },
    );
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetchBatch(
      [
        {
          providerId: "codex",
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          profileId: null,
        },
        {
          providerId: "codex",
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          profileId: "work-profile",
        },
      ],
      { force: true },
    );
    // Automatic, so it demonstrates the deferral: a forced batch fans out
    // concurrently (#369) while later background work still waits its turn.
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });

    await flush();
    expect(profileStarts).toEqual([null, "work-profile"]);
    expect(request).toHaveBeenCalledTimes(2);

    // One of the batch's two pulls settling is not the batch settling.
    settlers[0]();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    settlers[1]();
    await flush();
    expect(profileStarts).toEqual([null, "work-profile", null]);

    settlers[2]();
    await flush();
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("targets an explicit selected host instead of the configured default host and writes only its cache key", async () => {
    const queryClient = newQueryClient();
    const defaultRequest = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(response()),
    );
    const selectedRequest = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(response()),
    );
    configureRateLimitQueue({
      hostId: "host-a",
      queryClient,
      request: defaultRequest,
    });

    await enqueueRateLimitFetchForScope(
      {
        hostId: "host-b",
        queryClient,
        request: selectedRequest,
      },
      "codex",
      DEFAULT_ACCOUNT_CONTEXT,
      { force: true, profileId: "work-profile" },
    );

    expect(defaultRequest).not.toHaveBeenCalled();
    expect(selectedRequest).toHaveBeenCalledWith(
      "host-b",
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "codex",
        profileId: "work-profile",
        force: true,
      },
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );
    expect(
      queryClient.getQueryData(keyForHost("host-b", "codex", "work-profile")),
    ).toEqual({
      latest: null,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
    });
    expect(
      queryClient.getQueryData(keyForHost("host-a", "codex", "work-profile")),
    ).toBeUndefined();
  });

  it("serializes default-host and selected-host AUTOMATIC subprocess work on the same lane", async () => {
    const queryClient = newQueryClient();
    const defaultHost = makeControllableRequest();
    const selectedHost = makeControllableRequest();
    configureRateLimitQueue({
      hostId: "host-a",
      queryClient,
      request: defaultHost.request,
    });

    // An explicit scope feeds the same lane as the app-shell default, so
    // background work for two different hosts still costs one subprocess at a
    // time. (Forced pulls from either scope bypass the lane by design.)
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    void enqueueRateLimitFetchForScope(
      {
        hostId: "host-b",
        queryClient,
        request: selectedHost.request,
      },
      "claude-code",
      DEFAULT_ACCOUNT_CONTEXT,
      { force: false, profileId: "selected-profile" },
    );

    await flush();
    expect(defaultHost.request).toHaveBeenCalledTimes(1);
    expect(selectedHost.request).not.toHaveBeenCalled();

    defaultHost.settlers[0].ok();
    await flush();
    expect(selectedHost.request).toHaveBeenCalledTimes(1);

    selectedHost.settlers[0].ok();
    await flush();
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("collapses many rapid same-profile force refreshes into one request - fetchQuery dedupes on the query key", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // Four clicks on one row in quick succession. Forced pulls no longer queue,
    // so the lane is not what stops four CLI spawns here - `fetchQuery` joining
    // the in-flight fetch for the same key is (and, underneath, the host's
    // per-(provider, effective profile) single-flight).
    const settled = Array.from({ length: 4 }, () =>
      enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
        force: true,
        profileId: null,
      }),
    );

    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    settlers[0].ok();
    await Promise.all(settled);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("writes into the same query key the per-provider hook reads", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flush();
    settlers[0].ok();
    await flush();

    // The queue's queryFn wraps the raw response into the provider-pull
    // envelope before TanStack caches it - `response()`'s `providerRateLimits:
    // null` resolves to an envelope with nothing retained.
    expect(queryClient.getQueryState(keyFor("codex"))?.data).toEqual({
      latest: null,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
    });
  });

  it("keeps an inactive rate-limit entry after invalidation instead of garbage-collecting it", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: 50, retry: false } },
    });
    const request = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(response()),
    );
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    await enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    const queryKey = keyFor("codex");
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });

    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(queryKey)).toBeDefined();

    await vi.advanceTimersByTimeAsync(51);

    expect(queryClient.getQueryData(queryKey)).toBeDefined();
  });

  it("force: false no-ops when cached data is still within the freshness floor, force: true bypasses it", async () => {
    const queryClient = newQueryClient();
    const { request } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // Seed fresh data (dataUpdatedAt = now) into the provider's key.
    queryClient.setQueryData(keyFor("codex"), response());

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();
    // Still fresh -> the automatic trigger must not spawn a subprocess.
    expect(request).not.toHaveBeenCalled();

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flush();
    // A user-initiated refresh bypasses the floor.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("one provider's failure does not block the next provider's turn in the lane", async () => {
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // Automatic, so the second genuinely has a turn to be blocked from - two
    // forced pulls would both already be running and prove nothing here.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });

    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    settlers[0].fail();
    await flush();
    // The rejection was swallowed by the chain; the queue advanced to the next.
    expect(request).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["codex", "claude-code"]);

    settlers[1].ok();
    await flush();
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("stores a normalized HostRpcError in the shared cache slot when the request rejects a foreign error", async () => {
    const queryClient = newQueryClient();
    // A raw TypeError - the shape that previously leaked into the provider
    // rate-limit slot that `HostRpcError`-typed observers read.
    const request: RateLimitQueueRequestFn = () =>
      Promise.reject(new TypeError("boom from transport"));
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flush();

    const cachedError = queryClient.getQueryState(keyFor("claude-code"))?.error;
    expect(cachedError).toBeInstanceOf(HostRpcError);
    expect(cachedError).toMatchObject({
      code: "RPC_ERROR",
      method: "host.getRateLimitUsage",
      message: "boom from transport",
    });
  });

  it("a failed first read does not make a provider look fresh; an automatic enqueue retries and recovers", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();
    settlers[0].fail();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryState(keyFor("claude-code"))?.dataUpdatedAt,
    ).toBe(0);

    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();

    expect(request).toHaveBeenCalledTimes(2);
    settlers[1].ok();
    await flush();
    expect(queryClient.getQueryState(keyFor("claude-code"))?.data).toEqual({
      latest: null,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
    });
    expect(
      queryClient.getQueryState(keyFor("claude-code"))?.dataUpdatedAt,
    ).toBeGreaterThan(0);
  });

  it("exposes an external-store draining signal that flips with in-flight work", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    const notified: boolean[] = [];
    const unsubscribe = subscribeRateLimitQueue(() => {
      notified.push(isRateLimitQueueDraining());
    });

    expect(isRateLimitQueueDraining()).toBe(false);

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    // Draining flips true synchronously at enqueue, before any await.
    expect(isRateLimitQueueDraining()).toBe(true);
    expect(notified.at(-1)).toBe(true);

    await flush();
    settlers[0].ok();
    await flush();

    expect(isRateLimitQueueDraining()).toBe(false);
    expect(notified.at(-1)).toBe(false);

    unsubscribe();
  });

  it("force: true actually refetches fresh-cached data under the app QueryClient's global staleTime", async () => {
    // THE regression that made "Refresh all" look broken in the real app while
    // every test passed: `fetchQuery` inherits the QueryClient's GLOBAL
    // `staleTime` default (60s in the app's `query-client.ts`) and serves
    // still-fresh cache without fetching. The popover's open-time refresh
    // keeps provider data younger than 60s, so a user's `force: true` refresh
    // resolved from cache in a microtask - no subprocess, no `isFetching`, a
    // sub-frame `draining` blip - while the httpFetch lane's
    // `invalidateQueries` (which always refetches) visibly spun. Every prior
    // test built a bare `new QueryClient()` (staleTime 0), where `fetchQuery`
    // always fetches - so the suite exercised semantics the app doesn't run.
    // This test runs the production configuration.
    const queryClient = createAppQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // Seed fresh data (dataUpdatedAt = now), as the popover's open-time
    // refresh does moments before the user clicks.
    queryClient.setQueryData(keyFor("codex"), response());

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    expect(isRateLimitQueueDraining()).toBe(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    settlers[0].ok();
    await flush();
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("an automatic (force: false) enqueue re-checks freshness at its turn in the lane, not just at enqueue time", async () => {
    // With `staleTime: 0` on the queue's own `fetchQuery`, the accidental
    // dedupe the inherited global staleTime used to provide is gone - so the
    // queue re-checks the freshness floor when a queued automatic fetch's
    // turn arrives. An automatic trigger enqueued behind a fetch for the same
    // provider must not re-spawn a subprocess for data that just became fresh.
    const queryClient = createAppQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // No cached data yet: both pass their enqueue-time freshness check.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    settlers[0].ok();
    await flush();
    // The automatic turn found the data fresh (the forced fetch just wrote
    // it) and skipped instead of spawning a second subprocess.
    expect(request).toHaveBeenCalledTimes(1);
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("no-ops (never calls request) while the queue is unconfigured", async () => {
    const { request } = makeControllableRequest();
    // No configureRateLimitQueue call.
    await enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(isRateLimitQueueDraining()).toBe(false);
    // No scope was ever bound to write against, so nothing was ever marked
    // pending either.
    expect(isRateLimitFetchPending(HOST_ID, "codex", null)).toBe(false);
  });

  it("passes the extended response-frame budget as the request fn's 4th argument", async () => {
    const queryClient = newQueryClient();
    const request = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(response()),
    );
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    await enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });

    expect(request).toHaveBeenCalledWith(
      HOST_ID,
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "codex",
        profileId: null,
        force: true,
      },
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );
  });

  it("sends the enqueue's force value on the wire: an automatic pull sends force: false, a forced one sends force: true", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // No cached data yet, so the automatic pull passes its freshness check
    // and actually reaches the request fn rather than no-opping.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();
    expect(request).toHaveBeenNthCalledWith(
      1,
      HOST_ID,
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "codex",
        profileId: null,
        force: false,
      },
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );

    settlers[0].ok();
    await flush();

    // A different provider so this second pull's own freshness check (an
    // empty cache entry) is unaffected by the first pull's write.
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flush();
    expect(request).toHaveBeenNthCalledWith(
      2,
      HOST_ID,
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "claude-code",
        profileId: null,
        force: true,
      },
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );

    settlers[1].ok();
    await flush();
  });

  it("a forced pull and an automatic pull for the same host/provider/profile write the same query cache key - force never partitions the cache", async () => {
    const queryClient = newQueryClient();
    const request = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(response()),
    );
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // A user-initiated (force: true) pull writes first.
    await enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    expect(request).toHaveBeenCalledTimes(1);

    // `keyFor` builds the exact force-less key an automatic-lane observer
    // (`providerRateLimitQueryOptions`) uses for this same provider/profile -
    // not a key this test invents. Reading the forced fetch's own result
    // straight out of the cache through that key is the proof the two lanes
    // share one entry, rather than two key arrays compared to each other.
    const observedByAutomaticLane = queryClient.getQueryState(keyFor("codex"));
    expect(observedByAutomaticLane?.data).toEqual({
      latest: null,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
    });
    expect(observedByAutomaticLane?.dataUpdatedAt).toBeGreaterThan(0);

    // The behavioral proof: an automatic pull for the exact same triple,
    // enqueued right after, must see the forced pull's write as fresh and
    // skip re-fetching entirely. If `force` partitioned the cache, this
    // automatic pull would find its own key still empty and spawn a second
    // subprocess.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("starts forced items at once alongside a running automatic item and each other, and defers the waiting automatic item until they all settle", async () => {
    // Round 1 shipped a priority scheduler here: a forced item was spliced ahead
    // of every waiting automatic one, but still waited for the RUNNING item - so
    // a click could sit for that item's whole response budget. Superseded: a
    // click waits for nothing. The ordering below IS the behaviour change.
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // A: automatic, takes the lane and stays in flight throughout.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();
    expect(calls).toEqual(["codex"]);

    // B: automatic, waits behind the running A.
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flush();
    expect(calls).toEqual(["codex"]);

    // C: forced. Starts at once without waiting for A. A distinct profile, so
    // this is a genuinely new request rather than a dedupe onto A's.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: "profile-c",
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    // D: a second forced item - forced pulls do not serialize against each
    // other either.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: "profile-d",
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(3);

    // Releasing A does NOT start B: forced work is in flight, and background
    // spawns must not stack on top of what a person asked for.
    settlers[0].ok();
    await flush();
    expect(request).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(["codex", "codex", "codex"]);

    // Still deferred with one forced pull outstanding.
    settlers[1].ok();
    await flush();
    expect(request).toHaveBeenCalledTimes(3);

    // Both forced pulls settled - only now does the deferred automatic item run.
    settlers[2].ok();
    await flush();
    expect(calls).toEqual(["codex", "codex", "codex", "claude-code"]);

    settlers[3].ok();
    await flush();
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("marks a pull pending from enqueue until its item settles, including while it only waits behind another item", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    const notified: boolean[] = [];
    const unsubscribe = subscribeRateLimitQueue(() => {
      notified.push(isRateLimitFetchPending(HOST_ID, "claude-code", null));
    });

    expect(isRateLimitFetchPending(HOST_ID, "claude-code", null)).toBe(false);

    // A forced codex pull is in flight, which defers automatic work.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flush();

    // claude-code is automatic, so it genuinely only waits - not yet running -
    // but is pending from the moment it was enqueued. This is what lets a row
    // read as "Refreshing" instead of looking ignored.
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    expect(isRateLimitFetchPending(HOST_ID, "claude-code", null)).toBe(true);
    expect(notified.at(-1)).toBe(true);

    await flush();
    expect(isRateLimitFetchPending(HOST_ID, "claude-code", null)).toBe(true);

    // codex settles - claude-code now starts running, still pending.
    settlers[0].ok();
    await flush();
    expect(isRateLimitFetchPending(HOST_ID, "claude-code", null)).toBe(true);

    // claude-code itself settles - pending flips false and listeners fire.
    settlers[1].ok();
    await flush();
    expect(isRateLimitFetchPending(HOST_ID, "claude-code", null)).toBe(false);
    expect(notified.at(-1)).toBe(false);

    unsubscribe();
  });

  it("never marks a still-fresh automatic enqueue as pending - it resolves without entering the lane", async () => {
    const queryClient = newQueryClient();
    const { request } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });
    queryClient.setQueryData(keyFor("codex"), response());

    const settled = enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    // Fresh data skips the lane entirely, so the pull is never queued as
    // waiting-or-running - nothing to mark pending.
    expect(isRateLimitFetchPending(HOST_ID, "codex", null)).toBe(false);
    await settled;
    expect(isRateLimitFetchPending(HOST_ID, "codex", null)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves an enqueue against a null scope and never marks anything pending", async () => {
    await expect(
      enqueueRateLimitFetchForScope(null, "codex", DEFAULT_ACCOUNT_CONTEXT, {
        force: true,
        profileId: null,
      }),
    ).resolves.toBeUndefined();
    expect(isRateLimitFetchPending(HOST_ID, "codex", null)).toBe(false);
    expect(isRateLimitQueueDraining()).toBe(false);
  });

  it("does not let one fetch's rejection inside a batch block its sibling fetches or the next queue item", async () => {
    const queryClient = newQueryClient();
    const profileStarts: Array<string | null> = [];
    const settlers: Array<{ ok: () => void; fail: () => void }> = [];
    const request = vi.fn<RateLimitQueueRequestFn>(
      (_hostId, _method, params) => {
        profileStarts.push(params.profileId);
        return new Promise((resolve, reject) => {
          settlers.push({
            ok: () => resolve(response()),
            fail: () => reject(new Error("boom")),
          });
        });
      },
    );
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetchBatch(
      [
        {
          providerId: "codex",
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          profileId: "fails",
        },
        {
          providerId: "codex",
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          profileId: "succeeds",
        },
      ],
      { force: true },
    );
    // Automatic, so "the next queue item" is a real queue item with a turn to
    // wait for - a forced one would already be running and prove nothing.
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });

    await flush();
    expect(profileStarts).toEqual(["fails", "succeeds"]);

    // The failing sibling rejects - its sibling in the same batch is
    // unaffected and the next queue item still gets its turn once the batch
    // as a whole settles.
    settlers[0].fail();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    settlers[1].ok();
    await flush();
    expect(profileStarts).toEqual(["fails", "succeeds", null]);

    settlers[2].ok();
    await flush();
    expect(isRateLimitQueueDraining()).toBe(false);
  });
});

// Cool-down after a `usage_fetch_failed` response (PR tech plan: a server-side
// 429 on Anthropic's usage endpoint with a multi-minute penalty window - the
// point of this cool-down is to stop automatic polling from re-tripping it).
// Uses fake timers (and `vi.setSystemTime`) so the tests can cross both the
// `PROVIDER_RATE_LIMITS_STALE_TIME_MS` freshness floor (5m) AND the 15-minute
// cool-down window deterministically, without a real 5-minute wait - and to
// prove the cool-down is a DISTINCT gate from the freshness floor (an
// automatic enqueue past 5m but still inside the cool-down must stay
// suppressed).
describe("post-usage_fetch_failed cool-down", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A realistic epoch, not 0: `isFresh()`'s default `dataUpdatedAt ?? 0` for
    // a never-fetched key would otherwise sit right next to a clock started
    // at 0, making the very first enqueue look artificially "fresh".
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    __resetRateLimitQueueForTests();
    vi.useRealTimers();
  });

  // Fake-timer analogue of `flush()`: advances virtual time (default 0, just
  // enough to drain already-pending microtasks/timers) without a real wait.
  async function flushFake(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  it("suppresses a later automatic enqueue for the same provider while in cool-down, past the freshness floor, but never a manual refresh", async () => {
    const queryClient = newQueryClient();
    const request = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(unavailableResponse("usage_fetch_failed")),
    );
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(1);

    // Past the 5-minute freshness floor, but still well inside the 15-minute
    // cool-down - an automatic trigger (interval tick / turn completion) must
    // still be suppressed here, proving the cool-down is a separate gate from
    // freshness (freshness alone would already allow a re-fetch by now).
    await flushFake(PROVIDER_RATE_LIMITS_STALE_TIME_MS + 1_000);
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(1);

    // A manual, user-initiated refresh is never subject to the cool-down.
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("resumes automatic enqueues once the cool-down window elapses", async () => {
    const queryClient = newQueryClient();
    const request = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(unavailableResponse("usage_fetch_failed")),
    );
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(1);

    // Advance past the full automatic-poll cool-down window.
    await flushFake(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS + 1_000);
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not apply the cool-down to other transient reasons (timeout, connection_failed) - only usage_fetch_failed", async () => {
    const queryClient = newQueryClient();
    const request = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(unavailableResponse("timeout")),
    );
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(1);

    // Past the freshness floor only (not the 5-minute cool-down window) - a
    // `timeout` response must not have started this provider's cool-down, so
    // the freshness floor alone (already elapsed) is what gates this.
    await flushFake(PROVIDER_RATE_LIMITS_STALE_TIME_MS + 1_000);
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("clears a standing cool-down once a later fetch resolves with something other than usage_fetch_failed", async () => {
    const queryClient = newQueryClient();
    let nextReason: RateLimitUnavailableReason | null = "usage_fetch_failed";
    const request = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(
        nextReason === null ? response() : unavailableResponse(nextReason),
      ),
    );
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // First automatic pull trips the cool-down.
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(1);

    // A manual refresh (never gated by the cool-down) comes back clean.
    nextReason = null;
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(2);

    // Past the freshness floor, well inside what would have been the original
    // cool-down window - a subsequent automatic trigger now proceeds, because
    // the clean read above cleared the standing cool-down.
    await flushFake(PROVIDER_RATE_LIMITS_STALE_TIME_MS + 1_000);
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    await flushFake(0);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
