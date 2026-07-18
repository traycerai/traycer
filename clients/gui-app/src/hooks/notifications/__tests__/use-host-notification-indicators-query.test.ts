import { createElement, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP } from "@traycer/protocol/host/notifications/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import {
  indicatorRequests,
  useHostNotificationIndicators,
} from "@/hooks/notifications/use-host-notification-indicators-query";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

let hostClient: HostClient<HostRpcRegistry>;

const flushQueryNotifications = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => hostClient,
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("indicatorRequests", () => {
  it("deduplicates, sorts, and chunks visible surface ids at the host cap", () => {
    const epicIds = Array.from(
      { length: HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP + 1 },
      (_value, index) => `epic-${String(index).padStart(3, "0")}`,
    );
    const requests = indicatorRequests(
      [...epicIds, "epic-000"],
      ["chat-b", "chat-a"],
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].epicIds).toHaveLength(
      HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP,
    );
    expect(requests[1].epicIds).toEqual([
      `epic-${String(HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP).padStart(3, "0")}`,
    ]);
    expect(requests[0].chatIds).toEqual(["chat-a", "chat-b"]);
    expect(requests[1].chatIds).toEqual([]);
  });
});

describe("useHostNotificationIndicators recovery", () => {
  it("self-heals stale indicator data after a transport-exhausted refetch", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const queryClient = createAppQueryClient();
    queryClient.setDefaultOptions({
      queries: {
        ...queryClient.getDefaultOptions().queries,
        retry: false,
      },
    });
    const requestCount = { value: 0 };
    const responseMode: { value: "done" | "error" | "clear" } = {
      value: "done",
    };
    const doneResponse: HostNotificationsIndicatorStateResponse = {
      epics: {
        "epic-a": {
          unreadFailure: false,
          pendingApproval: false,
          pendingInterview: false,
          unreadDone: true,
        },
      },
      chats: {},
    };
    const clearResponse: HostNotificationsIndicatorStateResponse = {
      epics: {},
      chats: {},
    };
    hostClient = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => `request-${requestCount.value}`,
        handlers: {
          "host.notifications.indicatorState": () => {
            requestCount.value += 1;
            if (responseMode.value === "error") {
              return Promise.reject(
                new RetryableTransportError({
                  code: "RPC_ERROR",
                  message: "WebSocket dial timed out after 10000ms",
                  requestId: `request-${requestCount.value}`,
                  method: "host.notifications.indicatorState",
                  fatalDetails: null,
                }),
              );
            }
            return responseMode.value === "done" ? doneResponse : clearResponse;
          },
        },
      }),
    });
    hostClient.bind(mockLocalHostEntry);
    hostClient.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "token",
      }),
    );
    useAuthStore.setState({
      contextMetadata: { userId: "user-a", username: "user-a" },
    });
    const wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );

    const { result } = renderHook(
      () =>
        useHostNotificationIndicators({
          epicIds: ["epic-a"],
          chatIds: [],
          enabled: true,
        }),
      { wrapper },
    );

    await act(async () => {
      await flushQueryNotifications();
    });
    expect(requestCount.value).toBe(1);
    expect(result.current.data.epics["epic-a"].unreadDone).toBe(true);

    responseMode.value = "error";
    await act(async () => {
      await result.current.refetch();
    });
    expect(requestCount.value).toBe(2);
    expect(result.current.error).not.toBeNull();
    expect(result.current.data.epics["epic-a"].unreadDone).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushQueryNotifications();
    });
    expect(requestCount.value).toBe(3);
    expect(result.current.error).not.toBeNull();
    expect(result.current.data.epics["epic-a"].unreadDone).toBe(true);

    responseMode.value = "clear";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushQueryNotifications();
    });
    expect(requestCount.value).toBe(4);
    expect(result.current.error).toBeNull();
    expect(result.current.data.epics).toEqual({});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushQueryNotifications();
    });
    expect(requestCount.value).toBe(4);
  });
});
