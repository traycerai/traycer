import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type {
  GuiHarnessId,
  HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ReactNode } from "react";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { queryKeys } from "@/lib/query-keys";

interface TestCompletion {
  readonly harnessId: GuiHarnessId;
  readonly hostId: string | null;
  readonly profileId: string | null;
}

// Capture the turn-completion subscriber so tests can fire synthetic completions.
const sub = vi.hoisted(() => ({
  handler: null as null | ((completion: TestCompletion) => void),
}));
const mocks = vi.hoisted(() => ({ scope: { hostId: "host-b" } }));
vi.mock("@/lib/chats/chat-turn-completions", () => ({
  subscribeChatTurnCompletions: (cb: (completion: TestCompletion) => void) => {
    sub.handler = cb;
    return () => {
      sub.handler = null;
    };
  },
}));
vi.mock("@/hooks/rate-limits/use-provider-rate-limit-fetch-scope", () => ({
  useProviderRateLimitFetchScope: () => mocks.scope,
}));
vi.mock("@/lib/rate-limits/provider-rate-limit-fetch", () => ({
  fetchProviderRateLimits: vi.fn(() => Promise.resolve()),
}));

import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";
import { fetchProviderRateLimits } from "@/lib/rate-limits/provider-rate-limit-fetch";

const fetchSpy = vi.mocked(fetchProviderRateLimits);

function fireTurn(
  harnessId: GuiHarnessId,
  hostId: string | null,
  profileId: string | null,
): void {
  act(() => {
    sub.handler?.({ harnessId, hostId, profileId });
  });
}

function setup(
  providerId: RateLimitProviderId | null,
  profileId: string | null,
) {
  const queryClient = new QueryClient();
  const invalidateSpy = vi
    .spyOn(queryClient, "invalidateQueries")
    .mockResolvedValue(undefined);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(
    () => useRefreshProviderRateLimitsOnTurn(providerId, profileId, true),
    { wrapper },
  );
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
    fetchSpy.mockClear();
    defineVisibility("visible");
  });
  afterEach(() => {
    cleanup();
  });

  it("routes an ephemeralProcess provider's turn completion through fetchProviderRateLimits, not a direct invalidate", () => {
    const { invalidateSpy } = setup("codex", "work-profile");
    fireTurn("codex", mocks.scope.hostId, "work-profile");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      mocks.scope,
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: "work-profile",
      },
      { force: false },
    );
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("routes a Claude turn through the selected host scope too", () => {
    const { invalidateSpy } = setup("claude-code", "selected-profile");
    fireTurn("claude", mocks.scope.hostId, "selected-profile");
    expect(fetchSpy).toHaveBeenCalledWith(
      mocks.scope,
      {
        providerId: "claude-code",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: "selected-profile",
      },
      { force: false },
    );
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("invalidates an httpFetch provider's query directly and never touches fetchProviderRateLimits", () => {
    const { invalidateSpy } = setup("openrouter", null);
    fireTurn("openrouter", mocks.scope.hostId, null);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.hostMethod<HostRpcRegistry, "host.getRateLimitUsage">(
        "host-b",
        "host.getRateLimitUsage",
        {
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          providerId: "openrouter",
          profileId: null,
        },
      ),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still fetches an ephemeralProcess turn completion while the window is hidden (guardrail 3)", () => {
    defineVisibility("hidden");
    setup("codex", null);
    fireTurn("codex", mocks.scope.hostId, null);
    // The visibility pause applies ONLY to the interval timer - a background
    // turn finishing while the user is away must still refresh that provider.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      mocks.scope,
      {
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: null,
      },
      { force: false },
    );
  });

  it("ignores completions from a different provider's harness", () => {
    const { invalidateSpy } = setup("codex", null);
    fireTurn("claude", mocks.scope.hostId, null);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("ignores completions from a different host scope, even on a matching harness and profile", () => {
    // A background chat on another host completing a codex turn under the
    // same profile id must not refresh THIS surface's rate-limit data.
    const { invalidateSpy } = setup("codex", "work-profile");
    fireTurn("codex", "some-other-host", "work-profile");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("ignores completions from a different profile on the same host and harness", () => {
    const { invalidateSpy } = setup("codex", "work-profile");
    fireTurn("codex", mocks.scope.hostId, "other-profile");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("throttles bursts of matching completions to the outer cooldown", () => {
    setup("codex", null);
    fireTurn("codex", mocks.scope.hostId, null);
    fireTurn("codex", mocks.scope.hostId, null);
    fireTurn("codex", mocks.scope.hostId, null);
    // The outer cooldown ref bounds the ephemeral path to at most once per window.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("no-ops while providerId is null", () => {
    const { invalidateSpy } = setup(null, null);
    // No subscription is created, so there is nothing to fire; assert the
    // effect took the null branch and wired nothing up.
    expect(sub.handler).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("does not subscribe or refresh when fetching is ineligible", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    renderHook(() => useRefreshProviderRateLimitsOnTurn("codex", null, false), {
      wrapper,
    });

    expect(sub.handler).toBeNull();
    fireTurn("codex", mocks.scope.hostId, null);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
