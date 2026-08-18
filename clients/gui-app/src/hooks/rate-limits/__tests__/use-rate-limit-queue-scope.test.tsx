import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ReactNode } from "react";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { RateLimitUsageResponse } from "@/lib/rate-limits/rate-limit-envelope";
import { RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS } from "@/lib/rate-limits/rate-limit-timing";

/**
 * `useRateLimitQueueScope` now resolves its client through
 * `useHostClientForHostId` (a requester PINNED to `hostId`), not the mutable
 * app-wide `useHostClient()`. Stubbing `useHostClientForHostId` itself would
 * hide exactly the bug this hook fixes - a fake pinned client can't prove
 * anything stays pinned - so these mocks build a REAL `HostClient` +
 * `MockHostMessenger` instead, mirroring `use-host-client-for-host-id.test.ts`
 * and `use-run-target-host.test.tsx`'s own harnesses. `@/lib/host/runtime` is
 * the module both `use-host-client-for-host-id.ts` (via `@/lib/host`'s
 * re-export) and `use-host-client-for.ts` actually import `useHostClient`
 * from, so mocking it there (not `@/lib/host`) is what both internally see.
 */
const globalClientRef = vi.hoisted<{
  value: HostClient<HostRpcRegistry> | null;
}>(() => ({ value: null }));
const directoryRef = vi.hoisted<{ entries: HostDirectoryEntry[] }>(() => ({
  entries: [],
}));
// `vi.hoisted` factories run before this file's own imports are evaluated, so
// this can't read `mockLocalHostEntry.hostId` here - hardcode its literal
// value ("mock-local") instead and keep every other reference to the fixture
// itself (below, after imports resolve).
const hostState = vi.hoisted<{ hostId: string | null }>(() => ({
  hostId: "mock-local",
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
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => hostState.hostId,
}));

import { useRateLimitQueueScope } from "@/hooks/rate-limits/use-rate-limit-queue-scope";

const TARGET_B: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "host-b",
  websocketUrl: "ws://127.0.0.1:59999/stream",
};

function buildGlobalClient(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
} {
  const responder = (): RateLimitUsageResponse => ({
    totalTokens: 0,
    remainingTokens: 0,
    providerRateLimits: null,
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: {
      "host.getRateLimitUsage": () => responder(),
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger,
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) =>
      directoryRef.entries.find((entry) => entry.hostId === hostId) ?? null,
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return { client, messenger };
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useRateLimitQueueScope", () => {
  afterEach(() => {
    cleanup();
    globalClientRef.value = null;
    directoryRef.entries = [];
    hostState.hostId = mockLocalHostEntry.hostId;
  });

  it("captures the context-selected host, client, and shared query cache", async () => {
    const { client, messenger } = buildGlobalClient();
    globalClientRef.value = client;
    directoryRef.entries = [mockLocalHostEntry];
    hostState.hostId = mockLocalHostEntry.hostId;

    const queryClient = new QueryClient();
    const { result } = renderHook(() => useRateLimitQueueScope(), {
      wrapper: wrapperFor(queryClient),
    });
    const scope = result.current;
    expect(scope?.hostId).toBe(mockLocalHostEntry.hostId);
    expect(scope?.queryClient).toBe(queryClient);
    if (scope === null) throw new Error("Expected a selected host scope");

    await scope.request(
      mockLocalHostEntry.hostId,
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "codex",
        profileId: "work-profile",
      },
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );

    expect(messenger.calls).toHaveLength(1);
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(
      mockLocalHostEntry.hostId,
    );
  });

  it("returns null while the selected host id is unbound", () => {
    globalClientRef.value = buildGlobalClient().client;
    hostState.hostId = null;

    const { result } = renderHook(() => useRateLimitQueueScope(), {
      wrapper: wrapperFor(new QueryClient()),
    });
    expect(result.current).toBeNull();
  });

  it("returns null when the pinned client cannot resolve the active host id, e.g. a host not yet in the directory", () => {
    // A hostId the default client cannot resolve anywhere - not its own
    // active host, not the directory - so `useHostClientForHostId` yields
    // `null`. `useRateLimitQueueScope` must fold that into a `null` scope too,
    // matching the doc comment: "A `hostId` that no longer resolves yields a
    // `null` scope, which every enqueue entry point already treats as a
    // no-op." Simulates a subtree bound to a host that hasn't (or no longer)
    // resolved.
    globalClientRef.value = buildGlobalClient().client;
    directoryRef.entries = [];
    hostState.hostId = "unresolvable-host";

    const { result } = renderHook(() => useRateLimitQueueScope(), {
      wrapper: wrapperFor(new QueryClient()),
    });
    expect(result.current).toBeNull();
  });

  it("keeps a scope captured for host A routing to host A's client after the app-wide active host switches to B - the bug this pinning fixes", async () => {
    // Before the fix, this hook resolved its client via the mutable app-wide
    // `useHostClient()`. That returns the SAME `HostClient` object across
    // renders, mutated in place by `.bind()` on every host switch - so a
    // `request` closure captured while host A was active would still hit
    // whichever host that object was bound to by the time a queued item
    // actually ran, up to the serial queue's full response-timeout budget
    // later. `useHostClientForHostId` instead resolves a requester PINNED to
    // the id captured at render time, so the closure keeps routing to A's
    // endpoint no matter what the shared client does afterward. Mirrors
    // `use-host-client-for-host-id.test.ts`'s "keeps an explicit requester
    // pinned when the default host switches", through this hook.
    const { client, messenger } = buildGlobalClient();
    globalClientRef.value = client;
    directoryRef.entries = [mockLocalHostEntry, TARGET_B];
    hostState.hostId = mockLocalHostEntry.hostId;

    const { result } = renderHook(() => useRateLimitQueueScope(), {
      wrapper: wrapperFor(new QueryClient()),
    });
    const scopeForHostA = result.current;
    if (scopeForHostA === null) throw new Error("Expected a scope for host A");
    expect(scopeForHostA.hostId).toBe(mockLocalHostEntry.hostId);

    // The switch happens without this hook re-rendering yet, matching the
    // vulnerable window between a HostClient change event and React
    // consuming it - the exact window a queued item can sit in.
    client.bind(TARGET_B);
    expect(client.getActiveHostId()).toBe("host-b");

    await scopeForHostA.request(
      mockLocalHostEntry.hostId,
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "codex",
        profileId: null,
      },
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );

    // Still routed to host A's endpoint, not host B's - the pinned client
    // never followed the app-wide switch.
    expect(messenger.calls).toHaveLength(1);
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe(
      mockLocalHostEntry.hostId,
    );
    expect(messenger.calls[0]?.authority.endpoint.websocketUrl).toBe(
      mockLocalHostEntry.websocketUrl,
    );
  });

  it("resolves a fresh scope pinned to host B on the next render after the switch", async () => {
    const { client, messenger } = buildGlobalClient();
    globalClientRef.value = client;
    directoryRef.entries = [mockLocalHostEntry, TARGET_B];
    hostState.hostId = mockLocalHostEntry.hostId;

    const { result, rerender } = renderHook(() => useRateLimitQueueScope(), {
      wrapper: wrapperFor(new QueryClient()),
    });
    expect(result.current?.hostId).toBe(mockLocalHostEntry.hostId);

    client.bind(TARGET_B);
    act(() => {
      hostState.hostId = "host-b";
      rerender();
    });

    const scopeForHostB = result.current;
    expect(scopeForHostB?.hostId).toBe("host-b");
    if (scopeForHostB === null) throw new Error("Expected a scope for host B");

    await scopeForHostB.request(
      "host-b",
      "host.getRateLimitUsage",
      {
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        providerId: "codex",
        profileId: null,
      },
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );
    expect(messenger.calls).toHaveLength(1);
    expect(messenger.calls[0]?.authority.endpoint.hostId).toBe("host-b");
  });
});
