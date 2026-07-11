import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(() =>
    Promise.resolve({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: null,
    }),
  ),
}));
const hostState = vi.hoisted<{ hostId: string | null }>(() => ({
  hostId: "host-b",
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({ request: mocks.request }),
}));
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => hostState.hostId,
}));

import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useRateLimitQueueScope", () => {
  beforeEach(() => {
    hostState.hostId = "host-b";
    mocks.request.mockClear();
  });

  it("captures the context-selected host, client, and shared query cache", async () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useRateLimitQueueScope(), {
      wrapper: wrapperFor(queryClient),
    });
    const scope = result.current;
    expect(scope?.hostId).toBe("host-b");
    expect(scope?.queryClient).toBe(queryClient);
    if (scope === null) throw new Error("Expected a selected host scope");

    await scope.request("host-b", "host.getRateLimitUsage", {
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "codex",
      profileId: "work-profile",
    });

    expect(mocks.request).toHaveBeenCalledWith("host.getRateLimitUsage", {
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "codex",
      profileId: "work-profile",
    });
  });

  it("returns null while the selected host client is unbound", () => {
    hostState.hostId = null;
    const { result } = renderHook(() => useRateLimitQueueScope(), {
      wrapper: wrapperFor(new QueryClient()),
    });
    expect(result.current).toBeNull();
  });
});
