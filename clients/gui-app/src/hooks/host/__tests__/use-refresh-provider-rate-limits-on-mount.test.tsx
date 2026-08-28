import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";

const mocks = vi.hoisted(() => ({ scope: { hostId: "host-b" } }));

vi.mock("@/hooks/rate-limits/use-rate-limit-queue-scope", () => ({
  useRateLimitQueueScope: () => mocks.scope,
}));
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  enqueueRateLimitFetchForScope: vi.fn(() => Promise.resolve()),
}));

import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import { enqueueRateLimitFetchForScope } from "@/lib/rate-limits/ephemeral-fetch-queue";

const enqueueSpy = vi.mocked(enqueueRateLimitFetchForScope);

function setup(
  providerId: RateLimitProviderId,
  usageUpdatedAt: number | null,
  hasCachedValue: boolean,
) {
  const refetch = vi.fn(() => Promise.resolve({}));
  return renderHook(
    ({
      id,
      updatedAt,
      cached,
    }: {
      id: RateLimitProviderId;
      updatedAt: number | null;
      cached: boolean;
    }) =>
      useRefreshProviderRateLimitsOnMount({
        providerId: id,
        profileId: null,
        usageUpdatedAt: updatedAt,
        hasCachedValue: cached,
        fetchEligible: true,
        refetch,
      }),
    {
      initialProps: {
        id: providerId,
        updatedAt: usageUpdatedAt,
        cached: hasCachedValue,
      },
    },
  );
}

describe("useRefreshProviderRateLimitsOnMount", () => {
  beforeEach(() => {
    enqueueSpy.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it("enqueues a force:false pull for an ephemeralProcess provider on mount", () => {
    setup("codex", null, false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      mocks.scope,
      "codex",
      DEFAULT_ACCOUNT_CONTEXT,
      {
        force: false,
        profileId: null,
      },
    );
  });

  it("does not enqueue an httpFetch provider", () => {
    setup("openrouter", null, false);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("refetches an httpFetch provider when no successful value exists", () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        refetch,
      }),
    );
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch an httpFetch provider with a fresh summary and a cached successful value", () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: Date.now(),
        hasCachedValue: true,
        fetchEligible: true,
        refetch,
      }),
    );
    expect(refetch).not.toHaveBeenCalled();
  });

  // --- The skip-vs-enqueue matrix -------------------------------------
  //
  // The hook now skips ONLY when BOTH the host-persisted summary
  // (`usageUpdatedAt`) is within the freshness window AND a successful
  // detailed value is already cached in this renderer. Either condition
  // failing on its own must still enqueue: a stale/absent summary (managed
  // profiles the app-shell interval cannot assume are already represented
  // in this renderer's cache) and a cold detailed cache (a fresh popover
  // mount that has never observed this exact provider/profile key) are each
  // independently sufficient to trigger a pull.

  it("skips when the summary is fresh AND a detailed value is already cached", () => {
    setup("codex", Date.now(), true);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("enqueues when the summary is stale (null) even though a detailed value is cached", () => {
    setup("codex", null, true);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      mocks.scope,
      "codex",
      DEFAULT_ACCOUNT_CONTEXT,
      { force: false, profileId: null },
    );
  });

  it("enqueues when the summary is past the freshness window even though a detailed value is cached", () => {
    setup(
      "codex",
      Date.now() - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 1_000,
      true,
    );
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a summary exactly at the freshness boundary as stale (fresh is a strict less-than)", () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    setup("codex", now - PROVIDER_RATE_LIMITS_STALE_TIME_MS, true);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("enqueues when the summary is fresh but no detailed value is cached yet (cold detailed cache)", () => {
    setup("codex", Date.now(), false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      mocks.scope,
      "codex",
      DEFAULT_ACCOUNT_CONTEXT,
      { force: false, profileId: null },
    );
  });

  it("enqueues when neither the summary is fresh nor a detailed value is cached", () => {
    setup("codex", null, false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("re-enqueues on a re-render where the summary transitions from stale to fresh but the cache is still cold", () => {
    const { rerender } = setup("codex", null, false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "codex", updatedAt: Date.now(), cached: false });
    // Still cold on the detailed cache, so still eligible - not skipped just
    // because the summary caught up.
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
  });

  it("stops re-enqueuing once a re-render lands on both fresh summary and cached value", () => {
    const { rerender } = setup("codex", null, false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    // The re-render's dependencies changed (so the effect re-runs), but this
    // time it lands squarely on the skip condition - both fresh and cached -
    // so the re-run's own body must not call through.
    rerender({ id: "codex", updatedAt: Date.now(), cached: true });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("enqueues again when the provider id changes to a different ephemeralProcess provider", () => {
    const { rerender } = setup("codex", null, false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "claude-code", updatedAt: null, cached: false });
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSpy).toHaveBeenLastCalledWith(
      mocks.scope,
      "claude-code",
      DEFAULT_ACCOUNT_CONTEXT,
      { force: false, profileId: null },
    );
  });

  it("does not re-enqueue on a re-render with the same provider id, summary, and cache state", () => {
    const { rerender } = setup("codex", null, false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "codex", updatedAt: null, cached: false });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue an ephemeralProcess provider when fetching is ineligible", () => {
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: false,
        refetch: null,
      }),
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not enqueue a disabled authenticated profile when automatic fetching is ineligible", () => {
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "codex",
        profileId: "disabled-authenticated",
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: false,
        refetch: null,
      }),
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not enqueue an eligible-but-fresh-and-cached ephemeralProcess provider when fetching is ineligible", () => {
    // Belt-and-suspenders: `fetchEligible` gates before the freshness/cache
    // check runs at all, so an ineligible target never enqueues regardless
    // of what the skip matrix above would otherwise decide.
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: true,
        fetchEligible: false,
        refetch: null,
      }),
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
