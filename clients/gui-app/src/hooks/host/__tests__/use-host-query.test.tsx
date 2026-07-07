import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";

describe("useHostQuery auth readiness", () => {
  afterEach(() => {
    cleanup();
  });

  it("waits for an active request context before dispatching host RPC", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);

    const rendered = renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    expect(fixture.requestCount.value).toBe(0);
    expect(rendered.result.current.fetchStatus).toBe("idle");

    act(() => {
      fixture.client.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "tok-1",
        }),
      );
    });

    await waitFor(() => {
      expect(rendered.result.current.data?.ready).toBe(true);
    });
    expect(fixture.requestCount.value).toBe(1);
  });

  it("does not refetch active host queries when auth context is removed", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });

    act(() => {
      fixture.client.setRequestContext(null);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestCount.value).toBe(1);
  });

  it("respects a function-form `enabled` rather than collapsing it to true", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: { enabled: () => false },
        }),
      { wrapper: fixture.Wrapper },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestCount.value).toBe(0);

    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: { enabled: () => true },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });
  });

  it("rejects mutations without a client with a host RPC error", async () => {
    const fixture = createHostQueryFixture();
    const rendered = renderHook(
      () =>
        useHostMutation({
          client: null,
          method: "host.status",
          options: null,
          mapVariables: () => ({}),
        }),
      { wrapper: fixture.Wrapper },
    );

    let caught: unknown;
    await act(async () => {
      try {
        await rendered.result.current.mutateAsync({});
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(HostRpcError);
    expect(caught).toMatchObject({
      code: "RPC_ERROR",
      requestId: "client-unavailable",
      method: "host.status",
      message: "Host client unavailable",
      fatalDetails: null,
    });
  });
});

function createHostQueryFixture(): {
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
