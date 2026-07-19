import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostNotificationsSetConfigForClient } from "@/hooks/host/use-host-notifications-set-config-mutation";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

type NotificationConfig = ResponseOfMethod<
  HostRpcRegistry,
  "host.notifications.getConfig"
>;
type SetConfigRequest = RequestOfMethod<
  HostRpcRegistry,
  "host.notifications.setConfig"
>;

afterEach(() => {
  cleanup();
});

describe("useHostNotificationsSetConfigForClient", () => {
  it("invalidates the host captured in onMutate after a host swap", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const request = makeSetConfigRequest();
    const setRequests: SetConfigRequest[] = [];
    let resolveMutation: (value: NotificationConfig) => void = () => undefined;
    const mutationResponse = new Promise<NotificationConfig>((resolve) => {
      resolveMutation = resolve;
    });
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: { invalidateHostScope: () => undefined },
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "host.notifications.setConfig": (params) => {
            setRequests.push(params);
            return mutationResponse;
          },
        },
      }),
    });
    client.bind({ ...mockLocalHostEntry, hostId: "host-a" });
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    const rendered = renderHook(
      () => useHostNotificationsSetConfigForClient(client),
      { wrapper },
    );

    act(() => {
      rendered.result.current.mutate(request);
    });

    await waitFor(() => {
      expect(setRequests).toHaveLength(1);
    });

    act(() => {
      client.bind({ ...mockRemoteHostEntry, hostId: "host-b" });
    });
    await act(async () => {
      resolveMutation(makeNotificationConfig());
      await mutationResponse;
    });

    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: hostQueryKeys.methodScope(
          "host-a",
          "host.notifications.getConfig",
        ),
      });
    });
  });
});

function makeSetConfigRequest(): SetConfigRequest {
  return {
    matrix: makeNotificationConfig().matrix,
    channels: {
      renderer: {},
      email: {
        host: "smtp.example.com",
        port: 587,
        user: "me@example.com",
        from: "Traycer <me@example.com>",
        password: { kind: "leaveUnchanged" },
      },
    },
  };
}

function makeNotificationConfig(): NotificationConfig {
  return {
    matrix: {
      info: {
        renderer: true,
        email: false,
      },
      needs_action: {
        renderer: true,
        email: true,
      },
      failure: {
        renderer: true,
        email: true,
      },
      done: {
        renderer: true,
        email: false,
      },
    },
    channels: {
      renderer: {
        lastError: null,
      },
      email: {
        host: "smtp.example.com",
        port: 587,
        user: "me@example.com",
        from: "Traycer <me@example.com>",
        credentialConfigured: true,
        lastError: null,
      },
    },
  };
}
