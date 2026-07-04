import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { queryKeys } from "@/lib/query-keys";
import { createAppQueryClient } from "@/lib/query-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  __resetRateLimitQueueForTests,
  configureRateLimitQueue,
  enqueueRateLimitFetch,
  isRateLimitQueueDraining,
  subscribeRateLimitQueueDraining,
  type RateLimitQueueRequestFn,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

const HOST_ID = "host-1";

// A minimal valid `host.getRateLimitUsage @1.2` response - only the ordering of
// `request` calls matters to these tests, not the payload.
function response() {
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits: null };
}

function keyFor(providerId: ProviderId) {
  return queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
    HOST_ID,
    "host.getRateLimitUsage",
    { accountContext: DEFAULT_ACCOUNT_CONTEXT, providerId },
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
  });

  it("serializes concurrent enqueues across providers - only one request is ever in flight (guardrail 1)", async () => {
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // Fire two ephemeralProcess providers concurrently, as a rapid "Refresh all"
    // across providers would. Force bypasses the freshness floor.
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
    });
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
    });

    await flush();
    // Despite two concurrent enqueues, only the first provider's request has
    // started - the second is queued behind it, not spawned in parallel.
    expect(request).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["codex"]);

    // Release the first; only now may the second run.
    settlers[0].ok();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["codex", "claude-code"]);

    settlers[1].ok();
    await flush();
  });

  it("serializes many rapid same-provider force refreshes one at a time", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    for (let i = 0; i < 4; i++) {
      void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
        force: true,
      });
    }

    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    settlers[0].ok();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);

    settlers[1].ok();
    await flush();
    expect(request).toHaveBeenCalledTimes(3);

    settlers[2].ok();
    settlers[3]?.ok();
    await flush();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("writes into the same query key the per-provider hook reads", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
    });
    await flush();
    settlers[0].ok();
    await flush();

    expect(queryClient.getQueryState(keyFor("codex"))?.data).toEqual(
      response(),
    );
  });

  it("force: false no-ops when cached data is still within the freshness floor, force: true bypasses it", async () => {
    const queryClient = newQueryClient();
    const { request } = makeControllableRequest();
    configureRateLimitQueue({ hostId: HOST_ID, queryClient, request });

    // Seed fresh data (dataUpdatedAt = now) into the provider's key.
    queryClient.setQueryData(keyFor("codex"), response());

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
    });
    await flush();
    // Still fresh -> the automatic trigger must not spawn a subprocess.
    expect(request).not.toHaveBeenCalled();

    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
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
    });
    void enqueueRateLimitFetch("claude-code", DEFAULT_ACCOUNT_CONTEXT, {
      force: true,
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
    });
    void enqueueRateLimitFetch("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
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
    });
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(isRateLimitQueueDraining()).toBe(false);
  });
});
