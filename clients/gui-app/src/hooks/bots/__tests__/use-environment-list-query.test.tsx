import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

// `environment.list` is the ACCOUNT's data under a host key. An account switch
// marks host keys stale without dropping them, so an unpartitioned entry would
// be served to the next account's first render. Only the viewer id and the
// host transport are faked; the hook, `useHostQuery` and the QueryClient are
// real.

const viewer = vi.hoisted(() => ({ current: "" }));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => viewer.current,
}));

function listFor(label: string): EnvironmentListResponse {
  return {
    environments: [
      {
        environmentId: `env-${label}`,
        ownerKind: "user",
        ownerId: label,
        roomId: `room-${label}`,
        label,
      },
    ],
  };
}

function createFixture() {
  let requests = 0;
  const queryClient = new QueryClient({
    // Infinity so A's entry survives the account switch: that lingering entry
    // is the hazard, and with gc the test would pass without any partition.
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "environment.list": () => {
          requests += 1;
          return listFor(viewer.current);
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { client, queryClient, Wrapper, requestCount: () => requests };
}

afterEach(() => {
  cleanup();
  viewer.current = "";
});

describe("useEnvironmentListQuery - per-viewer cache partition", () => {
  it("does not serve viewer A's environments on viewer B's first render", async () => {
    const fixture = createFixture();
    viewer.current = "user-a";
    const first = renderHook(
      () => useEnvironmentListQuery(fixture.client, true),
      {
        wrapper: fixture.Wrapper,
      },
    );
    await waitFor(() => {
      expect(first.result.current.data?.environments[0]?.label).toBe("user-a");
    });
    first.unmount();

    // What an identity transition does to host keys: stale, not dropped.
    await fixture.queryClient.invalidateQueries({
      queryKey: ["host"],
      refetchType: "none",
    });
    viewer.current = "user-b";
    const second = renderHook(
      () => useEnvironmentListQuery(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );

    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => {
      expect(second.result.current.data?.environments[0]?.label).toBe("user-b");
    });
  });

  it("sends no request while the viewer is unresolved", async () => {
    const fixture = createFixture();
    const { result } = renderHook(
      () => useEnvironmentListQuery(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.requestCount()).toBe(0);
    expect(result.current.data).toBeUndefined();
  });
});
