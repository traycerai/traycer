import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ChatForkEvent } from "@traycer/protocol/host/chat-fork/schemas";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { useChatForkEventQuery } from "@/hooks/chats/use-chat-fork-queries";
import { useHostNotificationIndicators } from "@/hooks/notifications/use-host-notification-indicators-query";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

const hostClientRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));

function requireHostClient(): HostClient<HostRpcRegistry> {
  const client = hostClientRef.current;
  if (client === null) throw new Error("host client not created");
  return client;
}

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => requireHostClient() };
});

vi.mock("@/lib/host/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostClient: () => requireHostClient() };
});

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mockLocalHostEntry.hostId,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const CHAT_ID = "chat-1";

interface Harness {
  readonly queryClient: QueryClient;
  readonly forkEvent: { value: ChatForkEvent | null };
  readonly calls: Array<string>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetNegotiatedManifests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  hostClientRef.current = null;
});

describe("fork lifecycle notification-indicator refresh", () => {
  it("refreshes a mounted pendingFork false -> true -> false as the fork poll changes", async () => {
    const harness = createHarness(null);
    const { result } = renderHook(
      () => {
        const fork = useChatForkEventQuery();
        const indicators = useHostNotificationIndicators({
          epicIds: [],
          chatIds: [CHAT_ID],
          enabled: true,
        });
        return {
          episodeId:
            fork.data === undefined
              ? undefined
              : (fork.data.event?.episodeId ?? null),
          pendingFork: indicators.isPending
            ? false
            : indicators.data.chats[CHAT_ID].pendingFork,
          indicatorsPending: indicators.isPending,
          refetchFork: fork.refetch,
        };
      },
      { wrapper: wrapperFor(harness.queryClient) },
    );

    await waitFor(() =>
      expect(result.current).toMatchObject({
        episodeId: null,
        pendingFork: false,
        indicatorsPending: false,
      }),
    );
    expect(harness.calls).toEqual([
      "host.chatFork.get",
      "host.notifications.indicatorState",
    ]);

    // No notification feed is mounted or changed in this test. These explicit
    // reads stand in for the fixed lifecycle poll while keeping wall-clock
    // timers out of the test; the production query client's 60s stale cache is
    // otherwise untouched.
    harness.forkEvent.value = sampleForkEvent();
    await act(async () => {
      await result.current.refetchFork();
    });
    await waitFor(() =>
      expect(result.current).toMatchObject({
        episodeId: "episode-1",
        pendingFork: true,
        indicatorsPending: false,
      }),
    );

    harness.forkEvent.value = null;
    await act(async () => {
      await result.current.refetchFork();
    });
    await waitFor(() =>
      expect(
        harness.calls.filter((method) => method === "host.chatFork.get"),
      ).toHaveLength(3),
    );
    await waitFor(() =>
      expect(result.current).toMatchObject({
        episodeId: null,
        pendingFork: false,
        indicatorsPending: false,
      }),
    );
    expect(
      harness.calls.filter(
        (method) => method === "host.notifications.indicatorState",
      ),
    ).toHaveLength(3);
  });
});

function createHarness(initialEvent: ChatForkEvent | null): Harness {
  const queryClient = createAppQueryClient();
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
    mutations: { retry: false },
  });
  const forkEvent = { value: initialEvent };
  const calls: string[] = [];
  let requestId = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestId += 1;
        return `request-${String(requestId)}`;
      },
      handlers: {
        "host.chatFork.get": () => {
          calls.push("host.chatFork.get");
          return { event: forkEvent.value };
        },
        "host.notifications.indicatorState": () => {
          calls.push("host.notifications.indicatorState");
          return indicatorResponse(forkEvent.value !== null);
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  hostClientRef.current = client;
  recordNegotiatedHostMethods(mockLocalHostEntry.hostId, ["host.chatFork.get"]);
  useAuthStore.setState({
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
  return { queryClient, forkEvent, calls };
}

function wrapperFor(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
}

function indicatorResponse(
  pendingFork: boolean,
): HostNotificationsIndicatorStateResponse {
  return {
    epics: {},
    chats: {
      [CHAT_ID]: {
        pendingApproval: false,
        pendingInterview: false,
        pendingFork,
        unreadFailure: false,
        unreadDone: false,
      },
    },
  };
}

function sampleForkEvent(): ChatForkEvent {
  return {
    kind: "chat-publication-fork",
    episodeId: "episode-1",
    detectedAt: 1_000,
    cause: "sibling-of-receipt",
    diagnostic: "a copied or restored host directory is the usual cause",
    chats: [
      {
        taskId: "task-1",
        chatId: CHAT_ID,
        publicationChatId: CHAT_ID,
        chatTitle: "Restore the shard publisher",
        incumbent: {
          headSha256: "a".repeat(64),
          parentHeadSha256: null,
          throughRecordSeq: 10,
          capturedAt: 1_000,
          partCount: 3,
        },
        candidate: {
          headSha256: "b".repeat(64),
          parentHeadSha256: null,
          throughRecordSeq: 12,
          capturedAt: 2_000,
          partCount: 4,
        },
        repairEpoch: 1,
        forkOccurrenceId: "occ-1",
      },
    ],
  };
}
