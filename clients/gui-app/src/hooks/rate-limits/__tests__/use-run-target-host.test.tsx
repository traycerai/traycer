import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ReactNode } from "react";
import type { RateLimitUsageResponse } from "@/lib/rate-limits/rate-limit-envelope";

// One global (default-host) client shared between the mocked `useHostClient`
// and the tests, mirroring `use-host-client-for.test.tsx`'s harness so
// `useHostClientForHostId`'s internal `useHostClientFor` builds real
// transient clients against it.
const globalClientRef = vi.hoisted(() => ({
  value: null as HostClient<HostRpcRegistry> | null,
}));
const directoryRef = vi.hoisted(() => ({
  entries: [] as HostDirectoryEntry[],
}));

vi.mock("@/lib/host/runtime", () => ({
  useHostClient: () => {
    if (globalClientRef.value === null) {
      throw new Error("test global client not configured");
    }
    return globalClientRef.value;
  },
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: directoryRef.entries }),
}));
// The remote transport in `useHostClientFor` reads `runnerHost.authnBaseUrl`
// for attach-grant minting; local targets never touch it. Stub the minimum
// shape, mirroring `use-host-client-for.test.tsx`.
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ authnBaseUrl: "https://authn.test" }),
}));

import { useRunTargetHost } from "@/hooks/rate-limits/use-run-target-host";

const TAB_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "tab-host",
  websocketUrl: "ws://127.0.0.1:59998/stream",
};

function buildClient(
  hostId: string,
  websocketUrl: string,
  responder: () => RateLimitUsageResponse,
): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "host.getRateLimitUsage": () => responder(),
      },
    }),
  });
  client.bind({ ...mockLocalHostEntry, hostId, websocketUrl });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return client;
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useRunTargetHost", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    directoryRef.entries = [];
  });

  it("resolves the app-wide default host's client when runTargetHostId is null", () => {
    globalClientRef.value = buildClient(
      "default-host",
      mockLocalHostEntry.websocketUrl ?? "ws://default",
      () => ({
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: null,
      }),
    );

    const { result } = renderHook(() => useRunTargetHost(null), {
      wrapper: wrapperFor(new QueryClient()),
    });

    expect(result.current.hostId).toBe("default-host");
    expect(result.current.isReady).toBe(true);
    expect(result.current.queueScope?.hostId).toBe("default-host");
  });

  it("resolves an explicit tab host's own transient client, never the default host", async () => {
    const defaultRequest = vi.fn(() => ({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: null,
    }));
    globalClientRef.value = buildClient(
      "default-host",
      mockLocalHostEntry.websocketUrl ?? "ws://default",
      defaultRequest,
    );
    directoryRef.entries = [TAB_HOST];

    const { result } = renderHook(() => useRunTargetHost("tab-host"), {
      wrapper: wrapperFor(new QueryClient()),
    });

    expect(result.current.hostId).toBe("tab-host");
    expect(result.current.isReady).toBe(true);
    expect(result.current.queueScope?.hostId).toBe("tab-host");
    // Bound to the tab host's own directory entry, not the default host's.
    expect(result.current.client?.getActiveHost()?.websocketUrl).toBe(
      TAB_HOST.websocketUrl,
    );

    // The queue scope's request function must route through the tab host's
    // OWN client instance, not silently execute against the default host.
    const client = result.current.client;
    if (client === null) throw new Error("Expected a resolved tab-host client");
    const tabHostRequest = vi.spyOn(client, "request").mockResolvedValue({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: null,
    });

    await result.current.queueScope?.request(
      "tab-host",
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "codex",
        profileId: null,
      },
    );
    expect(tabHostRequest).toHaveBeenCalledTimes(1);
    expect(defaultRequest).not.toHaveBeenCalled();
  });

  it("never falls back to the default host when the tab host cannot be resolved (not yet in the directory)", () => {
    const defaultRequest = vi.fn(() => ({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: null,
    }));
    globalClientRef.value = buildClient(
      "default-host",
      mockLocalHostEntry.websocketUrl ?? "ws://default",
      defaultRequest,
    );
    // Directory does not (yet) contain "tab-host" - simulating an unresolved
    // or unreachable tab host.
    directoryRef.entries = [];

    const { result } = renderHook(() => useRunTargetHost("tab-host"), {
      wrapper: wrapperFor(new QueryClient()),
    });

    expect(result.current.client).toBeNull();
    expect(result.current.hostId).not.toBe("default-host");
    expect(result.current.hostId).toBeNull();
    expect(result.current.isReady).toBe(false);
    expect(result.current.queueScope).toBeNull();
  });
});
