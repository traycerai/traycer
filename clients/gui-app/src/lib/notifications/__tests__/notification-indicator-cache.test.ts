import { createElement, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import {
  clearNotificationIndicatorCaches,
  COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS,
  createCompleteNotificationIndicatorsReask,
  invalidateCompleteNotificationIndicators,
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
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
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
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  return spine.createRequester(mockLocalHostEntry);
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

  it("invalidates only the cached answers that are a host's whole origin, on any host", () => {
    const queryClient = new QueryClient();
    const wholeOriginA = indicatorKey({
      hostId: "host-a",
      userId: "user-a",
      epicIds: [],
      chatIds: ["chat-a"],
    });
    const wholeOriginB = indicatorKey({
      hostId: "host-b",
      userId: "user-a",
      epicIds: [],
      chatIds: ["chat-b"],
    });
    const partition = indicatorKey({
      hostId: "host-b",
      userId: "user-a",
      epicIds: [],
      chatIds: ["chat-c"],
    });
    const unsaid = indicatorKey({
      hostId: "host-b",
      userId: "user-a",
      epicIds: [],
      chatIds: ["chat-d"],
    });
    const unrelated: readonly unknown[] = ["host", "host-b", "host.chat.list"];
    queryClient.setQueryData(wholeOriginA, {
      epics: {},
      chats: {},
      complete: true,
    });
    queryClient.setQueryData(wholeOriginB, {
      epics: {},
      chats: {},
      complete: true,
    });
    queryClient.setQueryData(partition, {
      epics: {},
      chats: {},
      complete: false,
    });
    queryClient.setQueryData(unsaid, { epics: {}, chats: {}, complete: null });
    queryClient.setQueryData(unrelated, { complete: true });

    invalidateCompleteNotificationIndicators(queryClient);

    expect(queryClient.getQueryState(wholeOriginA)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(wholeOriginB)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(partition)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(unsaid)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(unrelated)?.isInvalidated).toBe(false);
  });

  it("fences a read still in flight, first read or not, and leaves an idle partition answer valid", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const firstRead = indicatorKey({
      hostId: "host-a",
      userId: "alice",
      epicIds: [],
      chatIds: ["chat-a"],
    });
    const rereadOfPartition = indicatorKey({
      hostId: "host-a",
      userId: "alice",
      epicIds: [],
      chatIds: ["chat-b"],
    });
    const idlePartition = indicatorKey({
      hostId: "host-a",
      userId: "alice",
      epicIds: [],
      chatIds: ["chat-c"],
    });
    const partitionAnswer: HostNotificationsIndicatorStateResponse = {
      epics: {},
      chats: {},
      complete: false,
    };
    queryClient.setQueryData(rereadOfPartition, partitionAnswer);
    queryClient.setQueryData(idlePartition, partitionAnswer);
    const requests = new Map<
      string,
      Array<Deferred<HostNotificationsIndicatorStateResponse>>
    >();
    const ask = (
      name: string,
    ): Promise<HostNotificationsIndicatorStateResponse> => {
      const deferred =
        createDeferred<HostNotificationsIndicatorStateResponse>();
      requests.set(name, [...(requests.get(name) ?? []), deferred]);
      return deferred.promise;
    };
    const wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );
    renderHook(
      () =>
        useQueries({
          queries: [
            queryOptions({
              queryKey: firstRead,
              queryFn: () => ask("firstRead"),
            }),
            queryOptions({
              queryKey: rereadOfPartition,
              queryFn: () => ask("rereadOfPartition"),
            }),
            queryOptions({
              queryKey: idlePartition,
              queryFn: () => ask("idlePartition"),
              staleTime: Infinity,
            }),
          ],
        }),
      { wrapper },
    );
    await waitFor(() => {
      expect(requests.get("firstRead")).toHaveLength(1);
      expect(requests.get("rereadOfPartition")).toHaveLength(1);
    });
    expect(queryClient.getQueryData(firstRead)).toBeUndefined();

    act(() => {
      invalidateCompleteNotificationIndicators(queryClient);
    });

    await waitFor(() => {
      expect(requests.get("firstRead")).toHaveLength(2);
      expect(requests.get("rereadOfPartition")).toHaveLength(2);
    });
    expect(requests.has("idlePartition")).toBe(false);
    expect(queryClient.getQueryState(idlePartition)?.isInvalidated).toBe(false);

    const wholeOrigin = (
      unreadCount: number,
    ): HostNotificationsIndicatorStateResponse => ({
      epics: {},
      chats: {
        "chat-a": {
          unreadFailure: false,
          pendingFork: false,
          pendingApproval: false,
          pendingInterview: false,
          unreadDone: unreadCount > 0,
          unreadCount,
        },
      },
      complete: true,
    });
    await act(async () => {
      // Each stale read answers after its re-ask was issued.
      requests.get("firstRead")?.[1].resolve(wholeOrigin(1));
      requests.get("firstRead")?.[0].resolve(wholeOrigin(0));
      requests.get("rereadOfPartition")?.[1].resolve(wholeOrigin(1));
      requests.get("rereadOfPartition")?.[0].resolve(wholeOrigin(0));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(queryClient.getQueryData(firstRead)).toEqual(wholeOrigin(1));
      expect(queryClient.getQueryData(rereadOfPartition)).toEqual(
        wholeOrigin(1),
      );
    });
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
            pendingFork: false,
            pendingApproval: false,
            pendingInterview: false,
            unreadDone: false,
            unreadCount: 0,
          },
        },
        chats: {},
        complete: true,
      });
      requests[1].resolve({
        epics: {
          "epic-a": {
            unreadFailure: true,
            pendingFork: false,
            pendingApproval: false,
            pendingInterview: false,
            unreadDone: false,
            unreadCount: 1,
          },
        },
        chats: {},
        complete: true,
      });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({
        epics: {
          "epic-a": {
            unreadFailure: true,
            pendingFork: false,
            pendingApproval: false,
            pendingInterview: false,
            unreadDone: false,
            unreadCount: 1,
          },
        },
        chats: {},
        complete: true,
      });
    });
  });
});

const wholeOrigin: HostNotificationsIndicatorStateResponse = {
  epics: {},
  chats: {},
  complete: true,
};

describe("complete notification indicators re-ask", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A mounted indicator read whose cached answer is a host's whole origin;
   * `requests` counts the reads the host was asked for. */
  const wholeOriginKey = indicatorKey({
    hostId: "host-b",
    userId: "alice",
    epicIds: [],
    chatIds: ["chat-a"],
  });

  async function mountWholeOriginRead(
    queryClient: QueryClient,
  ): Promise<{ readonly requests: Array<string> }> {
    const requests: Array<string> = [];
    const key = wholeOriginKey;
    const wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );
    renderHook(
      () =>
        useQuery(
          queryOptions({
            queryKey: key,
            queryFn: () => {
              requests.push("read");
              return Promise.resolve(wholeOrigin);
            },
            staleTime: Infinity,
          }),
        ),
      { wrapper },
    );
    await waitFor(() => {
      expect(queryClient.getQueryData(key)).toEqual(wholeOrigin);
    });
    expect(requests).toHaveLength(1);
    return { requests };
  }

  it("re-asks once after a burst of snapshots inside the quiet window", async () => {
    const queryClient = new QueryClient();
    const { requests } = await mountWholeOriginRead(queryClient);
    const reask = createCompleteNotificationIndicatorsReask(
      queryClient,
      COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS,
    );

    vi.useFakeTimers();
    reask.schedule();
    vi.advanceTimersByTime(COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS - 1);
    reask.schedule();
    vi.advanceTimersByTime(COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS - 1);
    reask.schedule();
    vi.advanceTimersByTime(COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS - 1);
    // Each snapshot restarted the window, so nothing has been asked yet.
    expect(requests).toHaveLength(1);

    vi.advanceTimersByTime(1);
    // Run on past any later timer a stray re-ask would have needed.
    vi.advanceTimersByTime(
      COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS * 10,
    );
    vi.useRealTimers();

    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    reask.dispose();
  });

  it("asks nothing when disposed before the quiet window elapses", async () => {
    const queryClient = new QueryClient();
    const { requests } = await mountWholeOriginRead(queryClient);
    const reask = createCompleteNotificationIndicatorsReask(
      queryClient,
      COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS,
    );

    vi.useFakeTimers();
    reask.schedule();
    vi.advanceTimersByTime(COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS - 1);
    reask.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(COMPLETE_NOTIFICATION_INDICATORS_REASK_QUIET_MS);

    expect(requests).toHaveLength(1);
    expect(queryClient.getQueryState(wholeOriginKey)?.isInvalidated).toBe(
      false,
    );
  });
});
