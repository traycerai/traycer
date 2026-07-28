import { createElement, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import {
  clearNotificationIndicatorCaches,
  invalidateNotificationIndicatorsForEntities,
} from "@/lib/notifications/notification-indicator-cache";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { notificationsQueryKeys, queryKeys } from "@/lib/query-keys";

function indicatorKey(input: {
  readonly hostId: string;
  readonly userId: string;
  readonly epicIds: ReadonlyArray<string>;
  readonly chatIds: ReadonlyArray<string>;
}) {
  return [
    ...queryKeys.hostMethod<
      HostRpcRegistry,
      "host.notifications.indicatorState"
    >(input.hostId, "host.notifications.indicatorState", {
      epicIds: [...input.epicIds],
      chatIds: [...input.chatIds],
    }),
    notificationsQueryKeys.indicatorIdentity(input.userId),
  ] as const;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value) };
}

function createIndicatorClient(
  queryClient: QueryClient,
  requests: Array<Deferred<HostNotificationsIndicatorStateResponse>>,
): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: {
        "host.notifications.indicatorState": () => {
          const deferred =
            createDeferred<HostNotificationsIndicatorStateResponse>();
          requests.push(deferred);
          return deferred.promise;
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  return client;
}

describe("notification indicator cache invalidation", () => {
  it("invalidates only query surfaces containing the frame entity", () => {
    const queryClient = new QueryClient();
    const target = indicatorKey({
      hostId: "host-a",
      userId: "user-a",
      epicIds: ["epic-a"],
      chatIds: ["chat-a"],
    });
    const other = indicatorKey({
      hostId: "host-a",
      userId: "user-a",
      epicIds: ["epic-b"],
      chatIds: ["chat-b"],
    });
    const epicOnly = indicatorKey({
      hostId: "host-a",
      userId: "user-a",
      epicIds: ["epic-a"],
      chatIds: [],
    });
    queryClient.setQueryData(target, { epics: {}, chats: {} });
    queryClient.setQueryData(other, { epics: {}, chats: {} });
    queryClient.setQueryData(epicOnly, { epics: {}, chats: {} });

    invalidateNotificationIndicatorsForEntities(
      queryClient,
      "host-a",
      [{ epicId: "epic-a", chatId: "chat-a" }],
      null,
    );

    expect(queryClient.getQueryState(target)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(epicOnly)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(other)?.isInvalidated).toBe(false);
  });

  it("clears all account-scoped indicator caches on identity reset", () => {
    const queryClient = new QueryClient();
    const alice = indicatorKey({
      hostId: "host-a",
      userId: "alice",
      epicIds: ["epic-a"],
      chatIds: [],
    });
    const bob = indicatorKey({
      hostId: "host-b",
      userId: "bob",
      epicIds: ["epic-b"],
      chatIds: [],
    });
    queryClient.setQueryData(alice, { epics: {}, chats: {} });
    queryClient.setQueryData(bob, { epics: {}, chats: {} });

    clearNotificationIndicatorCaches(queryClient);

    expect(queryClient.getQueryData(alice)).toBeUndefined();
    expect(queryClient.getQueryData(bob)).toBeUndefined();
  });

  it("cancels an in-flight fetch before refetching after an entity invalidation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const requests: Array<Deferred<HostNotificationsIndicatorStateResponse>> =
      [];
    const client = createIndicatorClient(queryClient, requests);
    const key = indicatorKey({
      hostId: mockLocalHostEntry.hostId,
      userId: "alice",
      epicIds: ["epic-a"],
      chatIds: ["chat-a"],
    });
    const wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );

    const { result } = renderHook(
      () =>
        useQuery(
          queryOptions({
            queryKey: key,
            queryFn: () =>
              client.request("host.notifications.indicatorState", {
                epicIds: ["epic-a"],
                chatIds: ["chat-a"],
              }),
          }),
        ),
      { wrapper },
    );

    await waitFor(() => expect(requests).toHaveLength(1));

    act(() => {
      invalidateNotificationIndicatorsForEntities(
        queryClient,
        mockLocalHostEntry.hostId,
        [{ epicId: "epic-a", chatId: "chat-a" }],
        client,
      );
    });

    await waitFor(() => expect(requests).toHaveLength(2));

    act(() => {
      requests[0].resolve({
        epics: {
          "epic-a": {
            unreadFailure: false,
            pendingApproval: false,
            pendingInterview: false,
            unreadDone: false,
          },
        },
        chats: {},
      });
      requests[1].resolve({
        epics: {
          "epic-a": {
            unreadFailure: true,
            pendingApproval: false,
            pendingInterview: false,
            unreadDone: false,
          },
        },
        chats: {},
      });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({
        epics: {
          "epic-a": {
            unreadFailure: true,
            pendingApproval: false,
            pendingInterview: false,
            unreadDone: false,
          },
        },
        chats: {},
      });
    });
  });
});
