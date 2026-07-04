import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  enqueueRateLimitFetch: vi.fn(() => Promise.resolve()),
}));

import { useRefreshProviderRateLimitsOnMount } from "@/hooks/host/use-refresh-provider-rate-limits-on-mount";
import { enqueueRateLimitFetch } from "@/lib/rate-limits/ephemeral-fetch-queue";

const enqueueSpy = vi.mocked(enqueueRateLimitFetch);

function setup(providerId: RateLimitProviderId) {
  return renderHook(
    ({ id }: { id: RateLimitProviderId }) =>
      useRefreshProviderRateLimitsOnMount(id),
    { initialProps: { id: providerId } },
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
    setup("codex");
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
    });
  });

  it("no-ops on mount for an httpFetch provider - its query keeps TanStack's own refetchOnMount", () => {
    setup("openrouter");
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("enqueues again when the provider id changes to a different ephemeralProcess provider", () => {
    const { rerender } = setup("codex");
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "claude-code" });
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSpy).toHaveBeenLastCalledWith(
      "claude-code",
      DEFAULT_ACCOUNT_CONTEXT,
      { force: false },
    );
  });

  it("does not re-enqueue on a re-render with the same provider id", () => {
    const { rerender } = setup("codex");
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    rerender({ id: "codex" });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });
});
