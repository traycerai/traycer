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
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";
import type {
  ProviderRateLimitEnvelope,
  RateLimitUsageResponse,
} from "@/lib/rate-limits/rate-limit-envelope";
import {
  RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS,
  RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
} from "@/lib/rate-limits/rate-limit-timing";
import {
  HostTransportFailureError,
  RetryableTransportError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  __resetProviderRateLimitFetchesForTests,
  fetchProviderRateLimits,
  type ProviderRateLimitFetchScope,
  type ProviderRateLimitRequestFn,
} from "@/lib/rate-limits/provider-rate-limit-fetch";

const HOST_ID = "host-1";

// A minimal valid `host.getRateLimitUsage` response - only the ordering/count
// of `request` calls matters to most of these tests, not the payload.
function response() {
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits: null };
}

// A provider-pull response reporting a specific unavailable reason - used
// where a test needs to tell two distinct responses apart via the cached
// envelope's `latest.reason`.
function unavailableResponse(reason: RateLimitUnavailableReason) {
  const providerRateLimits: ProviderRateLimits = {
    provider: "claude-code",
    available: false,
    reason,
  };
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits };
}

function keyFor(providerId: ProviderId, profileId: string | null) {
  return keyForHost(HOST_ID, providerId, profileId);
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

function target(providerId: RateLimitProviderId, profileId: string | null) {
  return {
    providerId,
    accountContext: DEFAULT_ACCOUNT_CONTEXT,
    profileId,
  };
}

function scopeFor(
  hostId: string,
  queryClient: QueryClient,
  request: ProviderRateLimitRequestFn,
): ProviderRateLimitFetchScope {
  return { hostId, queryClient, request };
}

// A `request` double whose promises settle only when the test explicitly
// releases them, so we can observe how many are in flight at any moment.
function makeControllableRequest() {
  const calls: Array<{
    readonly providerId: ProviderId | undefined;
    readonly profileId: string | null;
    readonly force: boolean | undefined;
    readonly responseTimeoutMs: number;
  }> = [];
  const settlers: Array<{
    ok: () => void;
    okWith: (payload: RateLimitUsageResponse) => void;
  }> = [];
  const request: ProviderRateLimitRequestFn = (
    _method,
    params,
    responseTimeoutMs,
  ) => {
    calls.push({
      providerId: params.providerId,
      profileId: params.profileId,
      force: params.force,
      responseTimeoutMs,
    });
    return new Promise((resolve) => {
      settlers.push({
        ok: () => resolve(response()),
        okWith: (payload) => resolve(payload),
      });
    });
  };
  return { request: vi.fn(request), calls, settlers };
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// Flush pending microtasks/callbacks so `fetchQuery` has a chance to invoke
// the queued `queryFn`. Real timers are in effect for these tests.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("fetchProviderRateLimits", () => {
  beforeEach(() => {
    __resetProviderRateLimitFetchesForTests();
  });
  afterEach(() => {
    __resetProviderRateLimitFetchesForTests();
    vi.useRealTimers();
  });

  it("resolves without requesting when the scope is null", async () => {
    const { request } = makeControllableRequest();
    await fetchProviderRateLimits(null, target("codex", null), { force: true });
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  describe("freshness", () => {
    it("force: false skips a key whose data is younger than the stale floor", async () => {
      const queryClient = newQueryClient();
      const { request } = makeControllableRequest();
      const scope = scopeFor(HOST_ID, queryClient, request);
      queryClient.setQueryData(keyFor("codex", null), response());

      void fetchProviderRateLimits(scope, target("codex", null), {
        force: false,
      });
      await flush();
      expect(request).not.toHaveBeenCalled();
    });

    it("force: false fetches once the cached data is older than the stale floor", async () => {
      const queryClient = newQueryClient();
      const { request } = makeControllableRequest();
      const scope = scopeFor(HOST_ID, queryClient, request);
      // Backdate the cached entry's `dataUpdatedAt` past the stale floor
      // rather than waiting for real time to pass.
      queryClient.setQueryData(keyFor("codex", null), response(), {
        updatedAt: Date.now() - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 1,
      });

      void fetchProviderRateLimits(scope, target("codex", null), {
        force: false,
      });
      await flush();
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("force: true bypasses the stale floor even for fresh data", async () => {
      const queryClient = newQueryClient();
      const { request } = makeControllableRequest();
      const scope = scopeFor(HOST_ID, queryClient, request);
      queryClient.setQueryData(keyFor("codex", null), response());

      void fetchProviderRateLimits(scope, target("codex", null), {
        force: true,
      });
      await flush();
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  it("carries force on the wire request but never in the cache key - a forced and an automatic call share one entry", async () => {
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    const scope = scopeFor(HOST_ID, queryClient, request);

    const pull = fetchProviderRateLimits(
      scope,
      target("codex", "work-profile"),
      { force: true },
    );
    await flush();

    // The frame budget must be exactly the one the scheduling policy declares
    // for this method: `HostClient.requestWithResponseTimeout` rejects any
    // other value before the request is sent.
    expect(calls).toEqual([
      {
        providerId: "codex",
        profileId: "work-profile",
        force: true,
        responseTimeoutMs: RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
      },
    ]);

    settlers[0].ok();
    await pull;

    // The cache identity (queryKey) carries no `force` field at all - so a
    // later automatic and a later forced call both resolve to this same slot.
    expect(queryClient.getQueryData(keyFor("codex", "work-profile"))).toEqual({
      latest: null,
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
    });
  });

  it("two concurrent automatic calls for the same target join into one request", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    const scope = scopeFor(HOST_ID, queryClient, request);

    const first = fetchProviderRateLimits(scope, target("codex", null), {
      force: false,
    });
    const second = fetchProviderRateLimits(scope, target("codex", null), {
      force: false,
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    settlers[0].ok();
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("a forced call joins an already-forced pending fetch for the same target", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    const scope = scopeFor(HOST_ID, queryClient, request);

    const first = fetchProviderRateLimits(scope, target("codex", null), {
      force: true,
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    const second = fetchProviderRateLimits(scope, target("codex", null), {
      force: true,
    });
    await flush();
    // No second request - the forced call joined the one already on the wire.
    expect(request).toHaveBeenCalledTimes(1);

    settlers[0].ok();
    await Promise.all([first, second]);
  });

  it("a forced call behind an in-flight AUTOMATIC one waits for it to settle, then issues its own forced request", async () => {
    // Joining would be wrong here: the automatic pull travels as `force:
    // false`, so a v4 host may answer it from its gauge cache - handing the
    // forced caller a reading up to the read floor old when it asked for a
    // fresh probe. Consuming a Codex rate-limit reset credit is exactly this
    // caller: it forces a re-read from outside any button, and answering that
    // from the automatic pull's cache would show the pre-reset numbers.
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    const scope = scopeFor(HOST_ID, queryClient, request);

    void fetchProviderRateLimits(scope, target("codex", null), {
      force: false,
    });
    await flush();
    expect(calls.map((c) => c.force)).toEqual([false]);

    // Lands while the automatic pull is still fetching - too late to promote
    // in place, since the request is already on the wire.
    const forced = fetchProviderRateLimits(scope, target("codex", null), {
      force: true,
    });
    await flush();
    // Still just the automatic request - the forced call is waiting, not
    // spawning its own request yet.
    expect(calls.map((c) => c.force)).toEqual([false]);

    settlers[0].ok();
    await flush();
    // ...and only now runs as its own, forced request.
    expect(calls.map((c) => c.force)).toEqual([false, true]);

    settlers[1].ok();
    await forced;
  });

  it("dispatches four distinct profiles concurrently - all four requests are on the wire before any settles", async () => {
    const queryClient = newQueryClient();
    const { request, calls, settlers } = makeControllableRequest();
    const scope = scopeFor(HOST_ID, queryClient, request);

    const profileIds = ["p1", "p2", "p3", "p4"];
    const pulls = profileIds.map((profileId) =>
      fetchProviderRateLimits(scope, target("codex", profileId), {
        force: true,
      }),
    );

    await flush();
    // Independence: nothing here serializes distinct targets behind one
    // another the way the deleted queue used to.
    expect(request).toHaveBeenCalledTimes(4);
    expect(calls.map((c) => c.profileId).sort()).toEqual(profileIds.sort());

    settlers.forEach((settler) => settler.ok());
    await Promise.all(pulls);
  });

  it("dispatches two different hosts' scopes without waiting on each other, each writing only its own cache key", async () => {
    const queryClient = newQueryClient();
    const hostA = makeControllableRequest();
    const hostB = makeControllableRequest();
    const scopeA = scopeFor("host-a", queryClient, hostA.request);
    const scopeB = scopeFor("host-b", queryClient, hostB.request);

    const pullA = fetchProviderRateLimits(
      scopeA,
      target("codex", "work-profile"),
      { force: true },
    );
    const pullB = fetchProviderRateLimits(
      scopeB,
      target("codex", "work-profile"),
      { force: true },
    );

    await flush();
    // Both dispatched immediately - neither waited for the other.
    expect(hostA.request).toHaveBeenCalledTimes(1);
    expect(hostB.request).toHaveBeenCalledTimes(1);

    hostA.settlers[0].ok();
    hostB.settlers[0].ok();
    await Promise.all([pullA, pullB]);

    expect(
      queryClient.getQueryData(keyForHost("host-a", "codex", "work-profile")),
    ).toBeDefined();
    expect(
      queryClient.getQueryData(keyForHost("host-b", "codex", "work-profile")),
    ).toBeDefined();
    // host-a's write never lands under host-b's key or vice versa.
    expect(
      queryClient.getQueryData(keyForHost("host-a", "claude-code", null)),
    ).toBeUndefined();
  });

  // A response timeout after the request reached the host is not a failed
  // read: the probe keeps running (a same-profile custodian alone can hold
  // the gate for minutes) and the host captures it in its gauge cache. These
  // pin that the fetch goes back for it rather than leaving the user with a
  // refresh that visibly failed and silently succeeded later.
  describe("collection after we stop waiting on a still-running read", () => {
    function transportFailure(): HostTransportFailureError {
      return new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "WebSocket frame timed out after 180000ms",
        requestId: "req-1",
        method: "host.getRateLimitUsage",
        fatalDetails: null,
      });
    }

    it("waits out the delay, then sends exactly one unforced collection request, and never surfaces isError while it is pending", async () => {
      vi.useFakeTimers();
      const queryClient = newQueryClient();
      const forced: Array<boolean | undefined> = [];
      let attempt = 0;
      const request: ProviderRateLimitRequestFn = (_method, params) => {
        attempt += 1;
        forced.push(params.force);
        return attempt === 1
          ? Promise.reject(transportFailure())
          : Promise.resolve(response());
      };
      const scope = scopeFor(HOST_ID, queryClient, vi.fn(request));

      const pull = fetchProviderRateLimits(scope, target("codex", null), {
        force: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(forced).toEqual([true]);
      // Still on the wire, but not an error - the fetch caught the failure
      // and is holding the query open for its own delayed collection.
      expect(
        queryClient.getQueryState(keyFor("codex", null))?.fetchStatus,
      ).toBe("fetching");
      // `getQueryState()` is the raw `QueryState` - it has no `isError`
      // convenience flag (that only exists on a `useQuery()` observer
      // result), so the settled/unsettled distinction is read off `status`
      // directly: still "pending" here because `queryFn` is inside its own
      // collection wait, not yet resolved or rejected from TanStack's view.
      expect(queryClient.getQueryState(keyFor("codex", null))?.status).toBe(
        "pending",
      );

      // Nothing yet - the collection waits for the full delay.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS - 1);
      expect(forced).toEqual([true]);
      expect(queryClient.getQueryState(keyFor("codex", null))?.status).toBe(
        "pending",
      );

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      // Unforced: it wants the reading the abandoned probe already produced,
      // not a second subprocess.
      expect(forced).toEqual([true, false]);

      await pull;
      const finalState = queryClient.getQueryState(keyFor("codex", null));
      expect(finalState?.status).toBe("success");
      expect(finalState?.data).toEqual({
        latest: null,
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: null,
      });
    });

    it("surfaces isError once the one collection attempt also fails unheard", async () => {
      vi.useFakeTimers();
      const queryClient = newQueryClient();
      let calls = 0;
      const request: ProviderRateLimitRequestFn = () => {
        calls += 1;
        return Promise.reject(transportFailure());
      };
      const scope = scopeFor(HOST_ID, queryClient, vi.fn(request));

      const pull = fetchProviderRateLimits(scope, target("codex", null), {
        force: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      expect(queryClient.getQueryState(keyFor("codex", null))?.status).toBe(
        "pending",
      );

      await vi.advanceTimersByTimeAsync(RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(2);

      await pull;
      const finalState = queryClient.getQueryState(keyFor("codex", null));
      expect(finalState?.status).toBe("error");
      expect(finalState?.error).toBeInstanceOf(HostRpcError);

      // There is exactly one collection - a host that never answers must not
      // become a poll loop (the 15-minute background poll already covers
      // that case), so no third request follows.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS * 5);
      expect(calls).toBe(2);
    });

    it("sends no collection for a fetch cancelled while it waited", async () => {
      vi.useFakeTimers();
      const queryClient = newQueryClient();
      let calls = 0;
      const request: ProviderRateLimitRequestFn = () => {
        calls += 1;
        return Promise.reject(transportFailure());
      };
      const scope = scopeFor(HOST_ID, queryClient, vi.fn(request));

      void fetchProviderRateLimits(scope, target("codex", null), {
        force: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      await queryClient.cancelQueries({ queryKey: keyFor("codex", null) });
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS * 2);
      // Nobody reads a cancelled fetch's result, so its collection would be a
      // host request for nothing.
      expect(calls).toBe(1);
    });

    it("sends no collection for a fetch cancelled while it waited, even after a newer fetch of the same key has started", async () => {
      // The reset-credit path: cancel the read in flight, then force a fresh
      // one. The newer fetch now owns the key, and the cancelled one must
      // still not send its collection when its delay runs out.
      vi.useFakeTimers();
      const queryClient = newQueryClient();
      const forced: Array<boolean | undefined> = [];
      const request: ProviderRateLimitRequestFn = (_method, params) => {
        forced.push(params.force);
        return forced.length === 1
          ? Promise.reject(transportFailure())
          : Promise.resolve(response());
      };
      const scope = scopeFor(HOST_ID, queryClient, vi.fn(request));

      void fetchProviderRateLimits(scope, target("codex", null), {
        force: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(forced).toEqual([true]);

      await queryClient.cancelQueries({ queryKey: keyFor("codex", null) });
      await fetchProviderRateLimits(scope, target("codex", null), {
        force: true,
      });
      expect(forced).toEqual([true, true]);

      await vi.advanceTimersByTimeAsync(RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS * 2);
      expect(forced).toEqual([true, true]);
    });

    it("does not let TanStack's own retry policy re-send a request while a collection is the only recovery that should run", async () => {
      // `newQueryClient()` sets `retry: false` as the DEFAULT, so every other
      // test in this file is blind to what production actually does: the app
      // QueryClient retries every non-`RetryableTransportError` once
      // (`lib/query-client.ts`). This client mirrors that, so the assertion is
      // about `fetchProviderRateLimits`'s own `retry: false` on `fetchQuery`
      // rather than about the fixture.
      vi.useFakeTimers();
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: (failureCount: number, error: unknown) =>
              !(error instanceof RetryableTransportError) && failureCount < 1,
          },
        },
      });
      let calls = 0;
      const request: ProviderRateLimitRequestFn = () => {
        calls += 1;
        return Promise.reject(transportFailure());
      };
      const scope = scopeFor(HOST_ID, queryClient, vi.fn(request));

      void fetchProviderRateLimits(scope, target("codex", null), {
        force: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      // Give TanStack's own retry backoff room to fire if it were going to.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(1);

      // Recovery is the single delayed collection, and it is UNFORCED - a
      // cache read, not another subprocess.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(2);
    });
  });

  it("a RetryableTransportError never dispatched to the host surfaces at once, with no collection", async () => {
    vi.useFakeTimers();
    const queryClient = newQueryClient();
    let calls = 0;
    const request: ProviderRateLimitRequestFn = () => {
      calls += 1;
      return Promise.reject(
        new RetryableTransportError({
          replaySafetyFromKey: false,
          code: "RPC_ERROR",
          message: "WebSocket dial timed out after 10000ms",
          requestId: "req-2",
          method: "host.getRateLimitUsage",
          fatalDetails: null,
        }),
      );
    };
    const scope = scopeFor(HOST_ID, queryClient, vi.fn(request));

    const pull = fetchProviderRateLimits(scope, target("codex", null), {
      force: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    await pull;
    expect(calls).toBe(1);
    expect(queryClient.getQueryState(keyFor("codex", null))?.status).toBe(
      "error",
    );

    await vi.advanceTimersByTimeAsync(RATE_LIMIT_READ_FOLLOW_UP_DELAY_MS * 3);
    expect(calls).toBe(1);
  });

  it("a fatal-details failure surfaces at once, with no collection", async () => {
    // `isRateLimitReadStillRunningOnHost` requires `fatalDetails === null`;
    // a non-null fatal-error frame (e.g. an incompatible-version rejection)
    // is a different failure class entirely and must not be treated as "the
    // host is still running the probe".
    const queryClient = newQueryClient();
    const request: ProviderRateLimitRequestFn = () =>
      Promise.reject(
        new HostTransportFailureError({
          code: "RPC_ERROR",
          message: "connection rejected",
          requestId: "req-3",
          method: "host.getRateLimitUsage",
          fatalDetails: {
            code: "VERSION_INCOMPATIBLE",
            reason: "host too old",
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        }),
      );
    const scope = scopeFor(HOST_ID, queryClient, vi.fn(request));

    await fetchProviderRateLimits(scope, target("codex", null), {
      force: true,
    });
    expect(queryClient.getQueryState(keyFor("codex", null))?.status).toBe(
      "error",
    );
  });

  it("never rejects, even when the underlying request rejects", async () => {
    const queryClient = newQueryClient();
    const request: ProviderRateLimitRequestFn = () =>
      Promise.reject(new TypeError("boom from transport"));
    const scope = scopeFor(HOST_ID, queryClient, vi.fn(request));

    await expect(
      fetchProviderRateLimits(scope, target("codex", null), { force: true }),
    ).resolves.toBeUndefined();

    const cachedError = queryClient.getQueryState(keyFor("codex", null))?.error;
    expect(cachedError).toBeInstanceOf(HostRpcError);
    expect(cachedError).toMatchObject({
      code: "RPC_ERROR",
      method: "host.getRateLimitUsage",
      message: "boom from transport",
    });
  });

  it("cancelQueries on an in-flight forced fetch idles it; an immediate forced call issues a NEW request rather than joining, and the cancelled one's late response does not overwrite it", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    const scope = scopeFor(HOST_ID, queryClient, request);
    const queryKey = keyFor("claude-code", null);

    const stale = fetchProviderRateLimits(scope, target("claude-code", null), {
      force: true,
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    await queryClient.cancelQueries({ queryKey });
    expect(queryClient.getQueryState(queryKey)?.fetchStatus).toBe("idle");

    const fresh = fetchProviderRateLimits(scope, target("claude-code", null), {
      force: true,
    });
    await flush();
    // Not joined: the cancelled entry's query was idle, so it is treated as
    // absent and a genuinely new request goes out.
    expect(request).toHaveBeenCalledTimes(2);

    // Resolve the NEW request first, with a distinguishable reading.
    settlers[1].okWith(unavailableResponse("timeout"));
    await flush();
    expect(
      queryClient.getQueryData<ProviderRateLimitEnvelope>(queryKey)?.latest,
    ).toMatchObject({ reason: "timeout" });

    // The cancelled request's late response must not overwrite it.
    settlers[0].okWith(unavailableResponse("connection_failed"));
    await flush();
    expect(
      queryClient.getQueryData<ProviderRateLimitEnvelope>(queryKey)?.latest,
    ).toMatchObject({ reason: "timeout" });

    await Promise.all([stale, fresh]);
  });

  it("calling fetchProviderRateLimits synchronously right after an un-awaited cancelQueries (registry entry still present) issues a NEW request, not a join", async () => {
    const queryClient = newQueryClient();
    const { request, settlers } = makeControllableRequest();
    const scope = scopeFor(HOST_ID, queryClient, request);
    const queryKey = keyFor("claude-code", null);

    const stale = fetchProviderRateLimits(scope, target("claude-code", null), {
      force: true,
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    // Un-awaited: `cancelQueries` idles the query SYNCHRONOUSLY, but its
    // caller here never yields, so the `pendingFetches` registry entry this
    // fetch owns has not had a chance to clear itself yet - unlike every
    // other cancel-then-fetch test in this file, which awaits the cancel (and
    // so a few microtasks) before calling again.
    void queryClient.cancelQueries({ queryKey });

    // Called in the SAME synchronous stretch, before any microtask runs.
    const fresh = fetchProviderRateLimits(scope, target("claude-code", null), {
      force: true,
    });
    await flush();

    // Expected: a genuinely new request, not a join on the cancelled entry -
    // the idle check must treat it as absent even while it is still present
    // in the registry.
    expect(request).toHaveBeenCalledTimes(2);

    settlers[1]?.okWith(unavailableResponse("timeout"));
    await flush();
    expect(
      queryClient.getQueryData<ProviderRateLimitEnvelope>(queryKey)?.latest,
    ).toMatchObject({ reason: "timeout" });

    settlers[0]?.okWith(unavailableResponse("connection_failed"));
    await flush();

    await Promise.all([stale, fresh]);
  });

  it("fetches under the production QueryClient's global staleTime default - fetchQuery's own staleTime: 0 always overrides it", async () => {
    // THE regression that made "Refresh all" look broken in the real app
    // while every test built with a bare `new QueryClient()` (staleTime 0
    // default, so `fetchQuery` always fetches) passed: the app's
    // `createAppQueryClient()` sets a 60s global default, and `fetchQuery`
    // inherits the QueryClient default for any option it does not pass
    // itself. `fetchProviderRateLimits` passes `staleTime: 0` explicitly, so
    // this must keep fetching under the real configuration too.
    const queryClient = createAppQueryClient();
    const { request, settlers } = makeControllableRequest();
    const scope = scopeFor(HOST_ID, queryClient, request);
    queryClient.setQueryData(keyFor("codex", null), response());

    void fetchProviderRateLimits(scope, target("codex", null), { force: true });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    settlers[0].ok();
    await flush();
  });

  it("keeps the cache entry alive past a short global gcTime default - fetchQuery's own gcTime: Infinity always overrides it", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: 50, retry: false } },
    });
    const request: ProviderRateLimitRequestFn = () =>
      Promise.resolve(response());
    const scope = scopeFor(HOST_ID, queryClient, vi.fn(request));

    await fetchProviderRateLimits(scope, target("codex", null), {
      force: true,
    });
    const queryKey = keyFor("codex", null);
    await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);

    await vi.advanceTimersByTimeAsync(51);

    expect(queryClient.getQueryData(queryKey)).toBeDefined();
  });

  it("stamps the query's meta with the host-RPC method name", async () => {
    const queryClient = newQueryClient();
    const { request } = makeControllableRequest();
    const scope = scopeFor(HOST_ID, queryClient, request);

    void fetchProviderRateLimits(scope, target("codex", null), { force: true });
    await flush();

    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: keyFor("codex", null), exact: true })?.options.meta,
    ).toMatchObject({ hostRpcMethod: "host.getRateLimitUsage" });
  });
});
