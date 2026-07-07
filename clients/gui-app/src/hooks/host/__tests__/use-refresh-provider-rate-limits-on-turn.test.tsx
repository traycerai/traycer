import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ReactNode } from "react";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

// Capture the turn-completion subscriber so tests can fire synthetic completions.
const sub = vi.hoisted(() => ({
  handler: null as null | ((completion: { harnessId: GuiHarnessId }) => void),
}));
vi.mock("@/lib/notifications/chat-turn-completion", () => ({
  subscribeChatTurnCompletions: (
    cb: (completion: { harnessId: GuiHarnessId }) => void,
  ) => {
    sub.handler = cb;
    return () => {
      sub.handler = null;
    };
  },
}));
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  enqueueRateLimitFetch: vi.fn(() => Promise.resolve()),
}));

import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { enqueueRateLimitFetch } from "@/lib/rate-limits/ephemeral-fetch-queue";

const enqueueSpy = vi.mocked(enqueueRateLimitFetch);

function fireTurn(harnessId: GuiHarnessId): void {
  act(() => {
    sub.handler?.({ harnessId });
  });
}

function setup(providerId: RateLimitProviderId | null, hostId: string | null) {
  const queryClient = new QueryClient();
  const invalidateSpy = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(() => useRefreshProviderRateLimitsOnTurn(providerId, hostId), {
    wrapper,
  });
  return { invalidateSpy };
}

function defineVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("useRefreshProviderRateLimitsOnTurn", () => {
  beforeEach(() => {
    sub.handler = null;
    enqueueSpy.mockClear();
    defineVisibility("visible");
  });
  afterEach(() => {
    cleanup();
  });

  it("routes an ephemeralProcess provider's turn completion through the serial queue, not a direct invalidate", () => {
    const { invalidateSpy } = setup("codex", "host-a");
    fireTurn("codex");
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates an httpFetch provider's query directly and never touches the queue", () => {
    const { invalidateSpy } = setup("openrouter", "host-a");
    fireTurn("openrouter");
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("still enqueues an ephemeralProcess turn completion while the window is hidden (guardrail 3)", () => {
    defineVisibility("hidden");
    setup("codex", "host-a");
    fireTurn("codex");
    // The visibility pause applies ONLY to the interval timer - a background
    // turn finishing while the user is away must still refresh that provider.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
    });
  });

  it("ignores completions from a different provider's harness", () => {
    const { invalidateSpy } = setup("codex", "host-a");
    fireTurn("claude");
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("throttles bursts of matching completions to the outer cooldown", () => {
    setup("codex", "host-a");
    fireTurn("codex");
    fireTurn("codex");
    fireTurn("codex");
    // The outer cooldown ref bounds the queue path to at most once per window.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("no-ops while providerId is null", () => {
    const { invalidateSpy } = setup(null, "host-a");
    // No subscription is created, so there is nothing to fire; assert the
    // effect took the null branch and wired nothing up.
    expect(sub.handler).toBeNull();
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
