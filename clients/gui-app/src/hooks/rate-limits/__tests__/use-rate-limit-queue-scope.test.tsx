import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestWithResponseTimeout: vi.fn(() =>
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
  useHostClient: () => ({
    requestWithResponseTimeout: mocks.requestWithResponseTimeout,
  }),
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => ({
    requestWithResponseTimeout: mocks.requestWithResponseTimeout,
  }),
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => hostState.hostId,
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
    mocks.requestWithResponseTimeout.mockClear();
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

    await scope.request(
      "host-b",
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "codex",
        profileId: "work-profile",
      },
      90_000,
    );

    expect(mocks.requestWithResponseTimeout).toHaveBeenCalledWith(
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "codex",
        profileId: "work-profile",
      },
      90_000,
    );
  });

  // The scope routes through `requestWithResponseTimeout` rather than the plain
  // `request` precisely so the QUEUE's budget decides how long to wait: an
  // `ephemeralProcess` read spawns a provider CLI and legitimately outruns the
  // client's default frame timeout. Asserting a second, different value keeps
  // this honest - a hard-coded constant would satisfy the case above.
  it("threads the caller's response budget through on every call", async () => {
    const { result } = renderHook(() => useRateLimitQueueScope(), {
      wrapper: wrapperFor(new QueryClient()),
    });
    const scope = result.current;
    if (scope === null) throw new Error("Expected a selected host scope");

    await scope.request(
      "host-b",
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "claude-code",
        profileId: null,
      },
      12_345,
    );

    expect(mocks.requestWithResponseTimeout).toHaveBeenCalledWith(
      "host.getRateLimitUsage",
      expect.anything(),
      12_345,
    );
  });

  it("returns null while the selected host client is unbound", () => {
    hostState.hostId = null;
    const { result } = renderHook(() => useRateLimitQueueScope(), {
      wrapper: wrapperFor(new QueryClient()),
    });
    expect(result.current).toBeNull();
  });
});
