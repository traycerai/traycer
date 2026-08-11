import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useHostQueries } from "@/hooks/host/use-host-queries";

describe("useHostQueries enabled handling", () => {
  afterEach(() => {
    cleanup();
  });

  it("respects a function-form `enabled` rather than collapsing it to true", async () => {
    const fixture = createHostQueriesFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    renderHook(
      () =>
        useHostQueries({
          client: fixture.client,
          cacheKeyIdentity: undefined,
          requests: [{ method: "host.status", params: {} }],
          options: { enabled: () => false },
        }),
      { wrapper: fixture.Wrapper },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestCount.value).toBe(0);

    renderHook(
      () =>
        useHostQueries({
          client: fixture.client,
          cacheKeyIdentity: undefined,
          requests: [{ method: "host.status", params: {} }],
          options: { enabled: () => true },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });
  });

  it("keeps a combined result stable when its query data is unchanged", async () => {
    const fixture = createHostQueriesFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    const { result, rerender } = renderHook(
      () =>
        useHostQueries<
          HostRpcRegistry,
          "host.status",
          {
            readonly data:
              ResponseOfMethod<HostRpcRegistry, "host.status"> | undefined;
          }
        >({
          client: fixture.client,
          cacheKeyIdentity: undefined,
          requests: [{ method: "host.status", params: {} }],
          options: null,
          combine: (results) => ({ data: results[0]?.data }),
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    const combined = result.current;
    rerender();

    expect(result.current).toBe(combined);
  });
});

function createHostQueriesFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
      },
    },
  });
  const requestCount = { value: 0 };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "host.status": () => {
          requestCount.value += 1;
          return {
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
          };
        },
      },
    }),
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { client, requestCount, Wrapper };
}
