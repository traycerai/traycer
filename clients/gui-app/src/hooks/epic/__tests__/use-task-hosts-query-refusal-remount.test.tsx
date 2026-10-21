import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { useTaskHosts } from "@/hooks/epic/use-task-hosts-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

// The real `useTaskHosts` over the real `useHostQuery` and a real `HostClient`:
// the count that matters is how often the host is asked, so it is read off the
// handler. A consumer that unmounts on an error and mounts again (the venue's
// section did) re-enters the query's mount path each time.

const TASK_ID = "task-refused";

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
    const queryClient = createAppQueryClient();
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => `task-hosts-${String(requests.value)}`,
        handlers: {
          "epic.listTaskHosts": () => {
            requests.value += 1;
            return Promise.reject(
              new HostRpcError({
                code: "FORBIDDEN",
                message: "refused",
                requestId: `task-hosts-${String(requests.value)}`,
                method: "epic.listTaskHosts",
                fatalDetails: null,
              }),
            );
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );

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
});
