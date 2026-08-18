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
import { EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS } from "@/lib/rate-limits/rate-limit-timing";
import {
  __resetRateLimitQueueForTests,
  configureRateLimitQueue,
  enqueueRateLimitFetch,
  enqueueRateLimitFetchBatch,
  enqueueRateLimitFetchBatchForScope,
  enqueueRateLimitFetchForScope,
  getRateLimitQueueTargetPhase,
  isRateLimitQueueDraining,
  subscribeRateLimitQueueDraining,
  subscribeRateLimitQueueTargets,
  type RateLimitQueueBatchTarget,
  type RateLimitQueueRequestFn,
  type RateLimitQueueTargetPhase,
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

  it("serializes concurrent enqueues across providers - only one request is ever in flight (guardrail 1)", async () => {
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // Fire two ephemeralProcess providers concurrently, as a rapid "Refresh all"
    // across providers would. Force bypasses the freshness floor.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });

    await flush();
    // Despite two concurrent enqueues, only the first provider's request has
    // started - the second is queued behind it, not spawned in parallel.
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

  it("starts every profile in one refresh batch concurrently, then waits before running the next queue item", async () => {
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
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });

    await flush();
    expect(profileStarts).toEqual([null, "work-profile"]);
    expect(request).toHaveBeenCalledTimes(2);

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
      },
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

  it("serializes default-host and selected-host subprocess work on the same lane", async () => {
    const queryClient = newQueryClient();
    const defaultHost = makeControllableRequest();
    const selectedHost = makeControllableRequest();
    configureRateLimitQueue({
      hostId: "host-a",
      queryClient,
      request: defaultHost.request,
    });

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
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
      { force: true, profileId: "selected-profile" },
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

  it("dedupes rapid identical-target force enqueues into a single fetch (target registry join, not four serialized fetches)", async () => {
    // Pre-registry behavior serialized four rapid same-target force enqueues
    // into four back-to-back fetches. The target registry now joins a
    // still-queued identical target instead of re-registering it, so four
    // back-to-back force refreshes for the SAME provider/profile collapse
    // into ONE fetch - see "rate-limit queue target registry" below for the
    // dedup/promotion/join mechanics in isolation.
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    for (let i = 0; i < 4; i++) {
      void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
        force: true,
        profileId: null,
      });
    }

    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    settlers[0].ok();
    await flush();
    // Still just the one fetch - the other three rapid calls joined it rather
    // than each spawning their own.
    expect(request).toHaveBeenCalledTimes(1);

    // Once that fetch has settled and the target is cleared from the
    // registry, a later enqueue is a genuinely new request.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    settlers[1].ok();
    await flush();
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

  it("one provider's failure does not block the next provider's turn", async () => {
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
      profileId: null,
    });

    await flush();
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
    const unsubscribe = subscribeRateLimitQueueDraining(() => {
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

// The per-target `queued`/`fetching` registry (`getRateLimitQueueTargetPhase` /
// `subscribeRateLimitQueueTargets`) backing `useRateLimitQueueTargetPhase` -
// the popover row-level "Queued…"/spinner copy. Distinct from the lane-wide
// `isRateLimitQueueDraining` signal: a target can be truthfully reported
// "queued" while a DIFFERENT target occupies the serial lane.
describe("rate-limit queue target registry", () => {
  beforeEach(() => {
    __resetRateLimitQueueForTests();
  });
  afterEach(() => {
    __resetRateLimitQueueForTests();
    vi.useRealTimers();
  });

  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function target(
    providerId: RateLimitQueueBatchTarget["providerId"],
    profileId: string | null,
  ): RateLimitQueueBatchTarget {
    return {
      providerId,
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      profileId,
    };
  }

  function ambientTarget(
    providerId: RateLimitQueueBatchTarget["providerId"],
  ): RateLimitQueueBatchTarget {
    return target(providerId, null);
  }

  it("reports queued while a target waits behind an earlier item, then fetching once its turn arrives", async () => {
    const queryClient = newQueryClient();
    const blocker = makeControllableRequest();
    configureRateLimitQueue({
      hostId: HOST_ID,
      queryClient,
      request: blocker.request,
    });

    // Occupy the lane with claude-code so codex's item must wait.
    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: blocker.request },
      [ambientTarget("claude-code")],
      { force: true },
    );
    await flush();
    expect(getRateLimitQueueTargetPhase(HOST_ID, "claude-code", null)).toBe(
      "fetching",
    );

    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: blocker.request },
      [ambientTarget("codex")],
      { force: true },
    );
    await flush();
    // Still behind claude-code: queued, not fetching.
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBe("queued");

    blocker.settlers[0].ok();
    await flush();
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBe(
      "fetching",
    );
    // The claude-code target already settled and was cleaned out of the
    // registry - `null`, not a stale phase.
    expect(
      getRateLimitQueueTargetPhase(HOST_ID, "claude-code", null),
    ).toBeNull();

    blocker.settlers[1].ok();
    await flush();
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBeNull();
  });

  it("cleans the registry after a successful fetch", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request },
      [ambientTarget("codex")],
      { force: true },
    );
    await flush();
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBe(
      "fetching",
    );

    settlers[0].ok();
    await flush();
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBeNull();
  });

  it("cleans the registry after a failed fetch", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request },
      [ambientTarget("codex")],
      { force: true },
    );
    await flush();
    settlers[0].fail();
    await flush();
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBeNull();
  });

  it("notifies target listeners on every queued/fetching/cleanup transition", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    const seen: Array<RateLimitQueueTargetPhase | null> = [];
    const unsubscribe = subscribeRateLimitQueueTargets(() => {
      seen.push(getRateLimitQueueTargetPhase(HOST_ID, "codex", null));
    });

    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request },
      [ambientTarget("codex")],
      { force: true },
    );
    // Registered as "queued" synchronously at enqueue time.
    expect(seen.at(-1)).toBe("queued");

    await flush();
    expect(seen.at(-1)).toBe("fetching");

    settlers[0].ok();
    await flush();
    expect(seen.at(-1)).toBeNull();

    unsubscribe();
  });

  it("dedupes a repeated identical force enqueue for a target still queued behind an earlier item - no extra queue item, one shared join", async () => {
    const queryClient = newQueryClient();
    const blocker = makeControllableRequest();
    const codexCalls: Array<string | null> = [];
    const codexRequest = vi.fn<RateLimitQueueRequestFn>(
      (_hostId, _method, params) => {
        codexCalls.push(params.profileId);
        return Promise.resolve(response());
      },
    );
    configureRateLimitQueue({
      hostId: HOST_ID,
      queryClient,
      request: blocker.request,
    });

    // Occupy the lane so codex's item must wait, queued.
    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: blocker.request },
      [ambientTarget("claude-code")],
      { force: true },
    );
    await flush();

    const first = enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: codexRequest },
      [ambientTarget("codex")],
      { force: true },
    );
    const second = enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: codexRequest },
      [ambientTarget("codex")],
      { force: true },
    );
    await flush();
    // Both calls resolved to the SAME queued entry - only one target sits in
    // the registry, and it is still queued behind claude-code.
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBe("queued");

    blocker.settlers[0].ok();
    await flush();
    // One dedup'd entry -> exactly one codex request, not two.
    expect(codexRequest).toHaveBeenCalledTimes(1);
    expect(codexCalls).toEqual([null]);

    await Promise.all([first, second]);
  });

  it("joins an already-fetching target instead of spawning a follow-up fetch", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request },
      [ambientTarget("codex")],
      { force: true },
    );
    await flush();
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBe(
      "fetching",
    );

    // A second caller (e.g. a popover row remounting) asks for the exact same
    // target while the first fetch is still in flight.
    const joinResult = enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request },
      [ambientTarget("codex")],
      { force: true },
    );
    await flush();
    // No second request spawned - the join is satisfied by the one already
    // running.
    expect(request).toHaveBeenCalledTimes(1);

    let joinResolved = false;
    void joinResult.then(() => {
      joinResolved = true;
    });
    await flush();
    expect(joinResolved).toBe(false);

    settlers[0].ok();
    await flush();
    expect(joinResolved).toBe(true);
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBeNull();
  });

  it("promotes queued automatic work to force when a manual refresh joins it before its turn arrives", async () => {
    const queryClient = newQueryClient();
    const blocker = makeControllableRequest();
    const codexRequest = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(response()),
    );
    configureRateLimitQueue({
      hostId: HOST_ID,
      queryClient,
      request: blocker.request,
    });

    // Occupy the lane so the automatic codex enqueue below queues instead of
    // running immediately.
    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: blocker.request },
      [ambientTarget("claude-code")],
      { force: true },
    );
    await flush();

    // Automatic (force: false) enqueue for codex - the cache is empty, so it
    // passes its enqueue-time freshness check and gets queued.
    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: codexRequest },
      [ambientTarget("codex")],
      { force: false },
    );
    await flush();
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBe("queued");

    // While it waits, the codex cache key becomes fresh (a sibling lane wrote
    // it) - without promotion, `shouldSkipAutomatic()` would now skip codex's
    // still-force:false turn entirely.
    queryClient.setQueryData(keyFor("codex"), response());

    // A manual refresh for the exact same target joins the queued entry
    // instead of adding a new one, upgrading it to force in place.
    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: codexRequest },
      [ambientTarget("codex")],
      { force: true },
    );
    await flush();

    blocker.settlers[0].ok();
    await flush();

    // The promotion made codex's turn run despite the now-fresh cache -
    // proving `force` actually propagated onto the already-queued entry
    // rather than being dropped as a redundant enqueue.
    expect(codexRequest).toHaveBeenCalledTimes(1);
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBeNull();
  });

  it("without promotion, a queued automatic target that turns fresh before its turn is skipped (contrast case)", async () => {
    const queryClient = newQueryClient();
    const blocker = makeControllableRequest();
    const codexRequest = vi.fn<RateLimitQueueRequestFn>(() =>
      Promise.resolve(response()),
    );
    configureRateLimitQueue({
      hostId: HOST_ID,
      queryClient,
      request: blocker.request,
    });

    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: blocker.request },
      [ambientTarget("claude-code")],
      { force: true },
    );
    await flush();

    void enqueueRateLimitFetchBatchForScope(
      { hostId: HOST_ID, queryClient, request: codexRequest },
      [ambientTarget("codex")],
      { force: false },
    );
    await flush();

    // Turns fresh before its turn, with no manual join this time.
    queryClient.setQueryData(keyFor("codex"), response());

    blocker.settlers[0].ok();
    await flush();

    expect(codexRequest).not.toHaveBeenCalled();
    expect(getRateLimitQueueTargetPhase(HOST_ID, "codex", null)).toBeNull();
  });

  it("keeps host-scoped targets separate: the same provider/profile on two hosts tracks independent registry entries and is never joined as one target", async () => {
    // The serial lane itself is shared process-wide across every host scope
    // (by design - see the module doc comment), so these two items still run
    // one after the other rather than concurrently. What this test proves is
    // narrower: an identical (providerId, profileId) pair on two DIFFERENT
    // hosts must occupy two DISTINCT registry entries - never joined/deduped
    // into one target the way a same-host repeat enqueue is - and each host's
    // fetch/cleanup is independent of the other's.
    const queryClient = newQueryClient();
    const hostA = makeControllableRequest();
    const hostB = makeControllableRequest();

    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-a", queryClient, request: hostA.request },
      [target("codex", "work-profile")],
      { force: true },
    );
    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-b", queryClient, request: hostB.request },
      [target("codex", "work-profile")],
      { force: true },
    );
    await flush();

    // host-a's item reached the lane first and started fetching; host-b's
    // identical (provider, profile) pair got its OWN registry entry - queued
    // behind host-a's, not silently joined into it.
    expect(hostA.request).toHaveBeenCalledTimes(1);
    expect(hostB.request).not.toHaveBeenCalled();
    expect(
      getRateLimitQueueTargetPhase(HOST_ID, "codex", "work-profile"),
    ).toBeNull();
    expect(
      getRateLimitQueueTargetPhase("host-a", "codex", "work-profile"),
    ).toBe("fetching");
    expect(
      getRateLimitQueueTargetPhase("host-b", "codex", "work-profile"),
    ).toBe("queued");

    hostA.settlers[0].ok();
    await flush();
    // Host A cleaned up independently of host B, which now runs its own fetch.
    expect(
      getRateLimitQueueTargetPhase("host-a", "codex", "work-profile"),
    ).toBeNull();
    expect(hostB.request).toHaveBeenCalledTimes(1);
    expect(
      getRateLimitQueueTargetPhase("host-b", "codex", "work-profile"),
    ).toBe("fetching");

    hostB.settlers[0].ok();
    await flush();
    expect(
      getRateLimitQueueTargetPhase("host-b", "codex", "work-profile"),
    ).toBeNull();
  });
});
