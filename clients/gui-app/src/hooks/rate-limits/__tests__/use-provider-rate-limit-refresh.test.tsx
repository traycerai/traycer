/**
 * Focused unit coverage for `useProviderRateLimitRefresh` - the single source
 * of truth for a provider's refresh action + spinner state, shared by the
 * popover's `RateLimitProviderBlock` and the Settings card. The consumers'
 * own tests exercise this logic only through their full component trees;
 * these pin the lane routing and the `draining` fold-in directly, so a
 * regression is caught even if a consumer's test setup masks it.
 *
 * `rateLimitFetchLane` stays REAL (it is a pure provider-id classifier):
 * codex exercises the ephemeralProcess lane and openrouter the httpFetch
 * lane, so the routing under test is the true production mapping rather than
 * a mocked one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";

const mocks = vi.hoisted(() => ({
  draining: false,
  scope: { hostId: "host-b" },
  enqueue: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock("@/hooks/rate-limits/use-is-rate-limit-queue-draining", () => ({
  useIsRateLimitQueueDraining: () => mocks.draining,
}));
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  // Wrapper (not `mocks.enqueue` directly) so `beforeEach` can swap the spy.
  enqueueRateLimitFetchForScope: (...args: unknown[]) => mocks.enqueue(...args),
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-queue-scope", () => ({
  useRateLimitQueueScope: () => mocks.scope,
}));
// No-op the fresh-on-open side effect: it has its own enqueue call that would
// pollute the spy, and its behavior is covered through the consumers' tests.
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: () => {},
}));

import { useProviderRateLimitRefresh } from "@/hooks/rate-limits/use-provider-rate-limit-refresh";

beforeEach(() => {
  mocks.draining = false;
  mocks.enqueue = vi.fn((..._args: unknown[]) => Promise.resolve());
});

afterEach(() => {
  cleanup();
});

describe("useProviderRateLimitRefresh refresh routing", () => {
  it("routes an ephemeralProcess provider's refresh through the serial queue with force:true, never a bare refetch", async () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );

    await result.current.refresh();

    expect(mocks.enqueue).toHaveBeenCalledWith(
      mocks.scope,
      "codex",
      DEFAULT_ACCOUNT_CONTEXT,
      {
        force: true,
        profileId: null,
      },
    );
    expect(refetch).not.toHaveBeenCalled();
  });

  it("routes an httpFetch provider's refresh through its own refetch, never the queue", async () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );

    await result.current.refresh();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe("useProviderRateLimitRefresh isRefreshing", () => {
  const refetch = () => Promise.resolve({});

  it("reflects the provider's own isFetching on both lanes", () => {
    const codex = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        fetchEligible: true,
        isFetching: true,
        refetch,
      }),
    );
    expect(codex.result.current.isRefreshing).toBe(true);

    const openrouter = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        fetchEligible: true,
        isFetching: true,
        refetch,
      }),
    );
    expect(openrouter.result.current.isRefreshing).toBe(true);
  });

  it("folds the queue's draining flag in for an ephemeralProcess provider whose own fetch has settled", () => {
    mocks.draining = true;
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(true);
  });

  it("ignores draining for an httpFetch provider - its own isFetching is the complete signal", () => {
    mocks.draining = true;
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });

  it("is false when nothing is fetching and the queue is idle", () => {
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });

  it("does not report or perform a refresh when fetching is ineligible", async () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        fetchEligible: false,
        isFetching: true,
        refetch,
      }),
    );

    await result.current.refresh();

    expect(result.current.isRefreshing).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
