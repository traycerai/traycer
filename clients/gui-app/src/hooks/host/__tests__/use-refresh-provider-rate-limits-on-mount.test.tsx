import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import {
  PROVIDER_RATE_LIMITS_STALE_TIME_MS,
  type RateLimitProviderId,
} from "@/lib/rate-limit-providers";

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

function setup(providerId: RateLimitProviderId, usageUpdatedAt: number | null) {
  return renderHook(
    ({
      id,
      updatedAt,
    }: {
      id: RateLimitProviderId;
      updatedAt: number | null;
    }) => useRefreshProviderRateLimitsOnMount(id, null, updatedAt, true),
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
    setup("codex", null);
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

  it("no-ops on mount for an httpFetch provider - its query keeps TanStack's own refetchOnMount", () => {
    setup("openrouter", null);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not enqueue a fresh ephemeralProcess profile on mount", () => {
    setup("codex", Date.now() - PROVIDER_RATE_LIMITS_STALE_TIME_MS + 10_000);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("enqueues again when the provider id changes to a different ephemeralProcess provider", () => {
    const { rerender } = setup("codex", null);
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
    const { rerender } = setup("codex", null);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "codex", updatedAt: null });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue an ephemeralProcess provider when fetching is ineligible", () => {
    renderHook(() =>
      useRefreshProviderRateLimitsOnMount("codex", null, null, false),
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
