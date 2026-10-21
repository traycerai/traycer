import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  subscribeTaskHostRefusalReset,
  useTaskHosts,
} from "@/hooks/epic/use-task-hosts-query";
import type { ListTaskHostsResponse } from "@traycer/protocol/host/task-host-summary";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

// The real `useTaskHosts` over the real `useHostQuery` and a real `HostClient`:
// the count that matters is how often the host is asked, so it is read off the
// handler. A consumer that unmounts on an error and mounts again (the venue's
// section did) re-enters the query's mount path each time.

const TASK_ID = "task-refused";

function refusal(requestId: string): HostRpcError {
  return new HostRpcError({
    code: "FORBIDDEN",
    message: "refused",
    requestId,
    method: "epic.listTaskHosts",
    fatalDetails: null,
  });
}

/** A real `HostClient` whose `epic.listTaskHosts` is the given handler. */
function mountFixture(listTaskHosts: () => Promise<ListTaskHostsResponse>): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "task-hosts",
      handlers: { "epic.listTaskHosts": listTaskHosts },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return {
    client: spine.createRequester(mockLocalHostEntry),
    queryClient,
    wrapper: (props) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      ),
  };
}

describe("useTaskHosts after a refusal", () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "viewer-1", username: "viewer-1" },
    });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("does not ask the host again when the consumer remounts on the refused answer", async () => {
    const requests = { value: 0 };
    const { client, wrapper } = mountFixture(() => {
      requests.value += 1;
      return Promise.reject(refusal(`task-hosts-${String(requests.value)}`));
    });

    const first = renderHook(() => useTaskHosts(client, TASK_ID), { wrapper });
    await vi.waitFor(() => {
      expect(first.result.current.isError).toBe(true);
    });
    expect(requests.value).toBe(1);

    first.unmount();
    const second = renderHook(() => useTaskHosts(client, TASK_ID), { wrapper });
    // Let the remounted observer's refetch, if it starts one, reach the host.
    await vi.waitFor(() => {
      expect(second.result.current.isFetching).toBe(false);
    });

    expect(requests.value).toBe(1);
  });

  it("asks the host again on a remount once the session is announced verified", async () => {
    // The refusal was cached while the session held no verdict. The consumer
    // was unmounted when the session was promoted, so no mounted observer
    // could refetch it: the provider's announcement has to drop the failure.
    const hostRefuses = { value: true };
    const requests = { value: 0 };
    const { client, queryClient, wrapper } = mountFixture(() => {
      requests.value += 1;
      return hostRefuses.value
        ? Promise.reject(refusal(`task-hosts-${String(requests.value)}`))
        : Promise.resolve({
            hosts: [
              {
                hostId: "host-1",
                label: null,
                principal: { kind: "user", id: "viewer-1" },
                reach: "same_principal",
              },
            ],
          });
    });
    const provider = new DefaultRequestContextProvider({ origin: "renderer" });
    provider.setSignedIn({
      user: createAuthenticatedUserFixture(undefined),
      bearerToken: "tok-1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });
    const unsubscribe = subscribeTaskHostRefusalReset({
      requestContextProvider: provider,
      queryClient,
    });

    const first = renderHook(() => useTaskHosts(client, TASK_ID), { wrapper });
    await vi.waitFor(() => {
      expect(first.result.current.isError).toBe(true);
    });
    first.unmount();

    hostRefuses.value = false;
    provider.announceSessionVerified();

    const second = renderHook(() => useTaskHosts(client, TASK_ID), { wrapper });
    // Settled either way: on the fetch the reset allows, or on the cached
    // refusal it would otherwise keep.
    await vi.waitFor(() => {
      expect(second.result.current.isPending).toBe(false);
    });
    expect(requests.value).toBe(2);
    expect(second.result.current.data?.hosts[0]?.hostId).toBe("host-1");

    unsubscribe();
    provider.dispose();
  });

  it("refetches a still-mounted refused read when the session is announced verified", async () => {
    // The verdict is withdrawn and returns inside one act, so the observer
    // never renders disabled: the reset is the only thing that can start the
    // refetch, and it must still reach a read it has just returned to pending.
    const hostRefuses = { value: true };
    const requests = { value: 0 };
    const { client, queryClient, wrapper } = mountFixture(() => {
      requests.value += 1;
      return hostRefuses.value
        ? Promise.reject(refusal(`task-hosts-${String(requests.value)}`))
        : Promise.resolve({
            hosts: [
              {
                hostId: "host-1",
                label: null,
                principal: { kind: "user", id: "viewer-1" },
                reach: "same_principal",
              },
            ],
          });
    });
    const provider = new DefaultRequestContextProvider({ origin: "renderer" });
    provider.setSignedIn({
      user: createAuthenticatedUserFixture(undefined),
      bearerToken: "tok-1",
      operationId: undefined,
      externalAbortSignal: undefined,
    });
    const unsubscribe = subscribeTaskHostRefusalReset({
      requestContextProvider: provider,
      queryClient,
    });

    const mounted = renderHook(() => useTaskHosts(client, TASK_ID), {
      wrapper,
    });
    await vi.waitFor(() => {
      expect(mounted.result.current.isError).toBe(true);
    });

    hostRefuses.value = false;
    act(() => {
      useAuthStore.setState({ status: "unverified" });
      useAuthStore.setState({ status: "signed-in" });
      provider.announceSessionVerified();
    });

    // Settled either way: on the refetch the reset allows, or on the idle
    // pending read it would otherwise leave behind.
    await vi.waitFor(() => {
      expect(mounted.result.current.isFetching).toBe(false);
    });
    expect(requests.value).toBe(2);
    expect(mounted.result.current.data?.hosts[0]?.hostId).toBe("host-1");

    unsubscribe();
    provider.dispose();
  });
});
