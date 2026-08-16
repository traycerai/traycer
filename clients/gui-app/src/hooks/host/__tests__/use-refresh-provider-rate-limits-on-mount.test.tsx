import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

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
    }: {
      id: RateLimitProviderId;
      updatedAt: number | null;
    }) =>
      useRefreshProviderRateLimitsOnMount({
        providerId: id,
        profileId: null,
        usageUpdatedAt: updatedAt,
        hasCachedValue,
        fetchEligible: true,
        refetch,
      }),
    { initialProps: { id: providerId, updatedAt: usageUpdatedAt } },
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

  it("does not refetch an httpFetch provider with a cached successful value", () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: true,
        fetchEligible: true,
        refetch,
      }),
    );
    expect(refetch).not.toHaveBeenCalled();
  });

  it("does not enqueue when the host summary has a successful reading", () => {
    setup("codex", Date.now(), false);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not enqueue when the query cache has a successful reading", () => {
    setup("codex", null, true);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("enqueues again when the provider id changes to a different ephemeralProcess provider", () => {
    const { rerender } = setup("codex", null, false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "claude-code", updatedAt: null });
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSpy).toHaveBeenLastCalledWith(
      mocks.scope,
      "claude-code",
      DEFAULT_ACCOUNT_CONTEXT,
      { force: false, profileId: null },
    );
  });

  it("does not re-enqueue on a re-render with the same provider id", () => {
    const { rerender } = setup("codex", null, false);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "codex", updatedAt: null });
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
});
