/**
 * Focused unit coverage for `useProviderRateLimitRefresh` - the single source
 * of truth for a provider's refresh action + spinner state, shared by the
 * popover's `RateLimitProviderBlock` and the Settings card. The consumers'
 * own tests exercise this logic only through their full component trees;
 * these pin the lane routing directly, so a regression is caught even if a
 * consumer's test setup masks it.
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
  scope: { hostId: "host-b" },
  fetch: vi.fn(
    (_scope: unknown, _target: unknown, _opts: unknown): Promise<void> =>
      Promise.resolve(),
  ),
}));

vi.mock("@/lib/rate-limits/provider-rate-limit-fetch", () => ({
  // Wrapper (not `mocks.fetch` directly) so `beforeEach` can swap the spy.
  fetchProviderRateLimits: (scope: unknown, target: unknown, opts: unknown) =>
    mocks.fetch(scope, target, opts),
}));
vi.mock("@/hooks/rate-limits/use-provider-rate-limit-fetch-scope", () => ({
  useProviderRateLimitFetchScope: () => mocks.scope,
}));
// No-op the fresh-on-open side effect: it has its own fetch call that would
// pollute the spy, and its behavior is covered through the consumers' tests
// and `use-refresh-provider-rate-limits-on-mount.test.tsx`.
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: () => {},
}));

import { useProviderRateLimitRefresh } from "@/hooks/rate-limits/use-provider-rate-limit-refresh";

beforeEach(() => {
  mocks.fetch = vi.fn(
    (_scope: unknown, _target: unknown, _opts: unknown): Promise<void> =>
      Promise.resolve(),
  );
});

afterEach(() => {
  cleanup();
});

describe("useProviderRateLimitRefresh refresh routing", () => {
  it("routes an ephemeralProcess provider's refresh through a forced fetchProviderRateLimits, never a bare refetch", async () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );

    await result.current.refresh();

    expect(mocks.fetch).toHaveBeenCalledWith(
      mocks.scope,
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: null,
      },
      { force: true },
    );
    expect(refetch).not.toHaveBeenCalled();
  });

  it("routes an httpFetch provider's refresh through its own refetch, never fetchProviderRateLimits", async () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );

    await result.current.refresh();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not report or perform a refresh when fetching is ineligible", async () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: false,
        isFetching: true,
        refetch,
      }),
    );

    await result.current.refresh();

    expect(result.current.isRefreshing).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

// `isRefreshing` is now a plain `fetchEligible && isFetching` fold - no other
// target's queue phase can hold it back or keep it clickable, on either lane.
// The old per-target "queued"/"forced" registry this used to consult was
// deleted with the shared serial queue.
describe("useProviderRateLimitRefresh isRefreshing", () => {
  const refetch = () => Promise.resolve({});

  it("reflects the provider's own isFetching on both lanes", () => {
    const codex = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
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
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: true,
        refetch,
      }),
    );
    expect(openrouter.result.current.isRefreshing).toBe(true);
  });

  it("is false on both lanes when isFetching is false", () => {
    const codex = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(codex.result.current.isRefreshing).toBe(false);

    const openrouter = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(openrouter.result.current.isRefreshing).toBe(false);
  });

  it("is false when fetchEligible is false even while isFetching is true", () => {
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: false,
        isFetching: true,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });
});
