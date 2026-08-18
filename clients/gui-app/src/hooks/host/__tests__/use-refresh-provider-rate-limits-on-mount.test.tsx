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
  dataUpdatedAt: number,
  refetch: (() => Promise<unknown>) | null,
) {
  return renderHook(
    ({ id, updatedAt }: { id: RateLimitProviderId; updatedAt: number }) =>
      useRefreshProviderRateLimitsOnMount({
        providerId: id,
        profileId: null,
        dataUpdatedAt: updatedAt,
        fetchEligible: true,
        refetch,
      }),
    { initialProps: { id: providerId, updatedAt: dataUpdatedAt } },
  );
}

describe("useRefreshProviderRateLimitsOnMount", () => {
  beforeEach(() => {
    enqueueSpy.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it("enqueues a force:false pull for an ephemeralProcess provider on mount with no cached data", () => {
    setup("codex", 0, null);
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

  // The queue owns freshness (its own `PROVIDER_RATE_LIMITS_STALE_TIME_MS`
  // floor and cool-down), so this hook enqueues unconditionally for the
  // ephemeralProcess lane - even when this surface's own cached reading is
  // still fresh.
  it("enqueues an ephemeralProcess pull even when the surface's own cached data is fresh", () => {
    setup("codex", Date.now(), null);
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

  it("does not enqueue an ephemeralProcess provider when fetching is ineligible", () => {
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "codex",
        profileId: null,
        dataUpdatedAt: 0,
        fetchEligible: false,
        refetch: null,
      }),
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("enqueues again when the provider id changes to a different ephemeralProcess provider", () => {
    const { rerender } = setup("codex", 0, null);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "claude-code", updatedAt: 0 });
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSpy).toHaveBeenLastCalledWith(
      mocks.scope,
      "claude-code",
      DEFAULT_ACCOUNT_CONTEXT,
      { force: false, profileId: null },
    );
  });

  it("does not re-enqueue on a re-render with the same provider id and dataUpdatedAt", () => {
    const { rerender } = setup("codex", 0, null);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "codex", updatedAt: 0 });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches an httpFetch provider when dataUpdatedAt is 0 (nothing has ever landed)", () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "openrouter",
        profileId: null,
        dataUpdatedAt: 0,
        fetchEligible: true,
        refetch,
      }),
    );
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("refetches an httpFetch provider whose cached data is older than the freshness floor", () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "openrouter",
        profileId: null,
        dataUpdatedAt: Date.now() - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 1,
        fetchEligible: true,
        refetch,
      }),
    );
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not refetch an httpFetch provider whose cached data is still fresh", () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "openrouter",
        profileId: null,
        dataUpdatedAt: Date.now(),
        fetchEligible: true,
        refetch,
      }),
    );
    expect(refetch).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("no-ops for an httpFetch provider with no observer handle (refetch: null)", () => {
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "openrouter",
        profileId: null,
        dataUpdatedAt: 0,
        fetchEligible: true,
        refetch: null,
      }),
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not enqueue an httpFetch provider on the ephemeralProcess lane's queue", () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    setup("openrouter", 0, refetch);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
