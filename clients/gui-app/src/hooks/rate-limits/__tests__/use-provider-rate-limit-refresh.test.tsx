/**
 * Focused unit coverage for `useProviderRateLimitRefresh` - the single source
 * of truth for a provider's refresh action + spinner state, shared by the
 * popover's `RateLimitProviderBlock` and the Settings card. The consumers'
 * own tests exercise this logic only through their full component trees;
 * these pin the lane routing and the fetch-pending fold-in directly, so a
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
  // Backs `useIsRateLimitFetchPending(providerId, profileId)` - THIS
  // provider/profile's own queue-pending flag. `isRefreshing` no longer folds
  // in a lane-wide draining flag at all, so no such hook is mocked/exercised
  // here anymore. Defaults to "nothing pending".
  pending: vi.fn((..._args: unknown[]) => false),
  scope: { hostId: "host-b" },
  enqueue: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock("@/hooks/rate-limits/use-is-rate-limit-fetch-pending", () => ({
  useIsRateLimitFetchPending: (...args: unknown[]) => mocks.pending(...args),
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
  mocks.pending = vi.fn((..._args: unknown[]) => false);
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
        dataUpdatedAt: 0,
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
        dataUpdatedAt: 0,
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
        dataUpdatedAt: 0,
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
        dataUpdatedAt: 0,
        fetchEligible: true,
        isFetching: true,
        refetch,
      }),
    );
    expect(openrouter.result.current.isRefreshing).toBe(true);
  });

  it("turns on for an ephemeralProcess provider whose own pull is pending in the queue, even though its own fetch has settled", () => {
    mocks.pending = vi.fn(
      (...args: unknown[]) => args[0] === "codex" && args[1] === null,
    );
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        dataUpdatedAt: 0,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(true);
    expect(mocks.pending).toHaveBeenCalledWith("codex", null);
  });

  // Regression guard for the fix: `isRefreshing` used to OR in a lane-wide
  // draining flag, so ANY queued work anywhere (a background sweep of an
  // unrelated provider, one wedged probe holding the lane for its full
  // response budget) disabled every rate-limit refresh control - including
  // the very forced click that exists to jump the queue ahead of that
  // waiting work. Scoping to this exact provider/profile's own pending flag
  // is what makes the priority scheduler reachable again. If this regresses
  // to a lane-wide flag, provider/profile X's `isRefreshing` would flip true
  // here even though only Y is queued.
  it("stays false for provider/profile X while an unrelated provider/profile Y is pending in the lane, not merely a lane-wide flag", () => {
    mocks.pending = vi.fn(
      (...args: unknown[]) =>
        args[0] === "claude-code" && args[1] === "other-profile",
    );
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: "work-profile",
        dataUpdatedAt: 0,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
    expect(mocks.pending).toHaveBeenCalledWith("codex", "work-profile");
  });

  it("turns true for provider/profile X once X's own pull (not Y's) is pending in the lane", () => {
    mocks.pending = vi.fn(
      (...args: unknown[]) => args[0] === "codex" && args[1] === "work-profile",
    );
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: "work-profile",
        dataUpdatedAt: 0,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(true);
  });

  it("ignores the fetch-pending flag for an httpFetch provider - its own isFetching is the complete signal", () => {
    mocks.pending = vi.fn(() => true);
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "openrouter",
        profileId: null,
        dataUpdatedAt: 0,
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
        dataUpdatedAt: 0,
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
        dataUpdatedAt: 0,
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
