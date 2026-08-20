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

// The indicator hook resolves its own client from a host id (so the surfaces
// that mount it need no host plumbing of their own). This suite builds the
// `HostClient` itself, so the resolver is pointed straight at it.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => hostClient,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => hostClient,
  };
});

// The indicator query addresses the NOTIFICATION host - the machine whose feed
// the centre renders - rather than the app-wide active host, so a `home:
// local` partition question is not asked of some other host's local partition.
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationHostId: () => hostClient.getActiveHostId(),
  useNotificationHost: () => ({
    hostId: hostClient.getActiveHostId(),
    client: hostClient,
  }),
}));

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
      {},
      undefined,
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].epicIds).toHaveLength(
      HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP,
    );
    expect(requests[1].epicIds).toEqual([
      `epic-${String(HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP).padStart(3, "0")}`,
    ]);
    // EVERY epic chunk carries the complete live-chat whitelist: a task
    // aggregate computed against a partial whitelist would silently narrow
    // that epic's aggregate to the chats that happened to share its page.
    expect(requests[0].chatIds).toEqual(["chat-a", "chat-b"]);
    expect(requests[1].chatIds).toEqual(["chat-a", "chat-b"]);
  });

  it("crosses epic chunks with chat chunks so every aggregate sees the whole whitelist", () => {
    const epicIds = Array.from(
      { length: HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP + 1 },
      (_value, index) => `epic-${index}`,
    );
    const chatIds = Array.from(
      { length: HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP + 1 },
      (_value, index) => `chat-${index}`,
    );

    const requests = indicatorRequests(epicIds, chatIds, {}, undefined);

    const sortedEpicIds = [...epicIds].sort((left, right) =>
      left.localeCompare(right),
    );
    const sortedChatIds = [...chatIds].sort((left, right) =>
      left.localeCompare(right),
    );
    const epicChunks = [
      sortedEpicIds.slice(0, HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP),
      sortedEpicIds.slice(HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP),
    ];
    const chatChunks = [
      sortedChatIds.slice(0, HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP),
      sortedChatIds.slice(HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP),
    ];

    // Crossed rather than paired index-wise: a chat id landing in a request
    // without its epic would drop it from that epic's aggregate entirely.
    expect(requests).toEqual(
      epicChunks.flatMap((epicChunk) =>
        chatChunks.map((chatChunk) => ({
          epicIds: epicChunk,
          chatIds: chatChunk,
        })),
      ),
    );
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
          pendingFork: false,
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
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
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
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "token",
      }),
    );
    hostClient = spine.createRequester(mockLocalHostEntry);
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
          hostId: mockLocalHostEntry.hostId,
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
