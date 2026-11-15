import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ChatForkEvent } from "@traycer/protocol/host/chat-fork/schemas";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import { useChatForkEventQuery } from "@/hooks/chats/use-chat-fork-queries";
import {
  publicationTargetMap,
  readCachedChatPublicationId,
  useChatPublicationTargets,
} from "@/hooks/chats/use-chat-publication-targets";
import { useHostNotificationIndicators } from "@/hooks/notifications/use-host-notification-indicators-query";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { queryKeys } from "@/lib/query-keys";
import { selectUnfoldedCloudChats } from "@/lib/chats/unified-chat-list";
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

// Both layers, and BOTH hooks on each: an `importActual` spread hands back
// the REAL spine hook (`useHostRuntimeClient`, a separate export),
// which throws outside a provider.
vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => requireHostClient(),
    useHostRuntimeClient: () => requireHostClient(),
  };
});

vi.mock("@/lib/host/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostClient: () => requireHostClient(),
    useHostRuntimeClient: () => requireHostClient(),
  };
});

// The indicator hook resolves its own client from a host id (so the surfaces
// that mount it need no host plumbing of their own). This suite builds the
// `HostClient` itself, so the resolver is pointed straight at it.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => requireHostClient(),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => mockLocalHostEntry.hostId,
}));

// The indicator query binds to the NOTIFICATION host rather than the app-wide
// active one, so mocking the active-host hooks alone leaves it with a null
// client and the query never leaves `isPending`. See `use-notification-host`
// on why the two must not be allowed to diverge here.
vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () => mockLocalHostEntry.hostId,
  useNotificationResolveHost: () => ({
    hostId: mockLocalHostEntry.hostId,
    client: requireHostClient(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const CHAT_ID = "chat-1";
const EPIC_ID = "epic-1";

interface Harness {
  readonly queryClient: QueryClient;
  readonly forkEvent: { value: ChatForkEvent | null };
  readonly calls: Array<string>;
  readonly targetRequests: Array<readonly string[]>;
  readonly targetFailure: { value: "unsupported" | null };
  readonly targetGate: {
    promise: Promise<void> | null;
    release: (() => void) | null;
  };
  readonly targetGateIndex: { value: number };
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
          freshnessMode: "base",
          hostId: mockLocalHostEntry.hostId,
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

  it("ignores a new chat and refreshes the full ID set on a fork edge", async () => {
    const harness = createHarness(null);
    const initialIds = Array.from(
      { length: 2_000 },
      (_, index) => `chat-${String(index)}`,
    );
    let chatIds = initialIds;
    const { result, rerender } = renderHook(
      () => {
        const fork = useChatForkEventQuery();
        const targets = useChatPublicationTargets({
          client: requireHostClient(),
          epicId: EPIC_ID,
          chatIds,
          cloudChatIds: [],
          chatIdsAuthoritative: true,
          chatRecordListFailed: false,
          enabled: true,
        });
        return {
          redirectedTo:
            targets.data === undefined
              ? undefined
              : (targets.data.redirected[0]?.publicationChatId ?? null),
          refetchFork: fork.refetch,
        };
      },
      { wrapper: wrapperFor(harness.queryClient) },
    );

    await waitFor(() => expect(result.current.redirectedTo).toBeNull());
    expect(
      harness.calls.filter(
        (method) => method === "epic.listChatPublicationTargets",
      ),
    ).toHaveLength(1);
    expect(harness.targetRequests).toEqual([initialIds]);

    // A newly created chat does not change the task key. Advance past the
    // stale budget to prove it cannot cause a refresh by itself.
    chatIds = [...initialIds, "chat-created-later"];
    vi.useFakeTimers();
    await act(async () => {
      rerender();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    });
    expect(harness.targetRequests).toHaveLength(1);
    vi.useRealTimers();

    // The host detects the fork and mints the redirect. Only the fork edge
    // invalidates the task-keyed answer; the new chat did not issue a request.
    harness.forkEvent.value = sampleForkEvent();
    await act(async () => {
      await result.current.refetchFork();
    });

    await waitFor(() =>
      expect(result.current.redirectedTo).toBe("chat-1-forked"),
    );
    expect(
      harness.calls.filter(
        (method) => method === "epic.listChatPublicationTargets",
      ),
    ).toHaveLength(2);
    expect(harness.targetRequests[1]).toEqual([
      ...initialIds,
      "chat-created-later",
    ]);
  });

  it("leaves the publication-target map alone while the episode is unchanged", async () => {
    const harness = createHarness(null);
    const { result } = renderHook(
      () => {
        const fork = useChatForkEventQuery();
        useChatPublicationTargets({
          client: requireHostClient(),
          epicId: EPIC_ID,
          chatIds: [CHAT_ID],
          cloudChatIds: [],
          chatIdsAuthoritative: true,
          chatRecordListFailed: false,
          enabled: true,
        });
        return { refetchFork: fork.refetch };
      },
      { wrapper: wrapperFor(harness.queryClient) },
    );

    await waitFor(() =>
      expect(
        harness.calls.filter(
          (method) => method === "epic.listChatPublicationTargets",
        ),
      ).toHaveLength(1),
    );

    // Two more fork polls that report the SAME (empty) episode. The lifecycle
    // key is unchanged, so this must not turn a five-minute cache into a poll.
    await act(async () => {
      await result.current.refetchFork();
      await result.current.refetchFork();
    });

    expect(
      harness.calls.filter((method) => method === "host.chatFork.get"),
    ).toHaveLength(3);
    expect(
      harness.calls.filter(
        (method) => method === "epic.listChatPublicationTargets",
      ),
    ).toHaveLength(1);
  });

  it("shares one task entry between sidebar-shaped and palette-shaped observers", async () => {
    const harness = createHarness(null);
    const sidebarIds = ["chat-c", "chat-a", "chat-b"];
    const paletteIds = [...sidebarIds].sort();
    const useTargets = (chatIds: readonly string[]) =>
      useChatPublicationTargets({
        client: requireHostClient(),
        epicId: EPIC_ID,
        chatIds,
        cloudChatIds: [],
        chatIdsAuthoritative: true,
        chatRecordListFailed: false,
        enabled: true,
      });
    const sidebar = renderHook(() => useTargets(sidebarIds), {
      wrapper: wrapperFor(harness.queryClient),
    });
    const palette = renderHook(() => useTargets(paletteIds), {
      wrapper: wrapperFor(harness.queryClient),
    });

    await waitFor(() => expect(sidebar.result.current.isFetching).toBe(false));
    const key = queryKeys.hostMethod<
      HostRpcRegistry,
      "epic.listChatPublicationTargets"
    >(mockLocalHostEntry.hostId, "epic.listChatPublicationTargets", {
      epicId: EPIC_ID,
      chatIds: [],
    });
    expect(sidebar.result.current.data).toEqual(palette.result.current.data);
    expect(harness.targetRequests).toHaveLength(1);
    expect([...(harness.targetRequests[0] ?? [])].sort()).toEqual(paletteIds);
    expect(
      harness.queryClient.getQueryCache().findAll({ queryKey: key }),
    ).toHaveLength(1);
  });

  it("waits for an in-flight partial answer before fetching the full list once", async () => {
    const harness = createHarness(null);
    const knownIds = ["chat-known"];
    const allIds = Array.from(
      { length: 2_001 },
      (_, index) => `chat-${String(index)}`,
    );
    harness.targetGate.promise = new Promise<void>((resolve) => {
      harness.targetGate.release = resolve;
    });
    let authoritative = false;
    let failed = false;
    let ids: readonly string[] = knownIds;
    const useTargets = () =>
      useChatPublicationTargets({
        client: requireHostClient(),
        epicId: EPIC_ID,
        chatIds: ids,
        cloudChatIds: [],
        chatIdsAuthoritative: authoritative,
        chatRecordListFailed: failed,
        enabled: true,
      });
    const sidebar = renderHook(useTargets, {
      wrapper: wrapperFor(harness.queryClient),
    });
    const palette = renderHook(useTargets, {
      wrapper: wrapperFor(harness.queryClient),
    });

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(harness.targetRequests).toHaveLength(0);
    vi.useRealTimers();

    failed = true;
    act(() => {
      sidebar.rerender();
      palette.rerender();
    });
    await waitFor(() => expect(harness.targetRequests).toHaveLength(1));
    expect(harness.targetRequests[0]).toEqual(knownIds);

    ids = allIds;
    authoritative = true;
    failed = false;
    act(() => {
      sidebar.rerender();
      palette.rerender();
    });
    expect(harness.targetRequests).toHaveLength(1);
    harness.targetGate.release?.();

    await waitFor(() => expect(harness.targetRequests).toHaveLength(2));
    await waitFor(() => expect(sidebar.result.current.isFetching).toBe(false));
    expect(harness.targetRequests).toEqual([knownIds, allIds]);
  });

  it("recovers an identical failed-latch answer with one authoritative refresh across observers", async () => {
    const harness = createHarness(null);
    const partialIds = ["chat-known"];
    const allIds = ["chat-known", "chat-new"];
    let authoritative = false;
    let failed = true;
    let ids: readonly string[] = partialIds;
    const useTargets = () =>
      useChatPublicationTargets({
        client: requireHostClient(),
        epicId: EPIC_ID,
        chatIds: ids,
        cloudChatIds: [],
        chatIdsAuthoritative: authoritative,
        chatRecordListFailed: failed,
        enabled: true,
      });
    const sidebar = renderHook(useTargets, {
      wrapper: wrapperFor(harness.queryClient),
    });
    const palette = renderHook(useTargets, {
      wrapper: wrapperFor(harness.queryClient),
    });

    await waitFor(() => expect(harness.targetRequests).toEqual([partialIds]));
    await waitFor(() => expect(sidebar.result.current.isFetching).toBe(false));

    harness.targetGateIndex.value = 2;
    harness.targetGate.promise = new Promise<void>((resolve) => {
      harness.targetGate.release = resolve;
    });
    act(() => {
      void sidebar.result.current.refetch();
    });
    await waitFor(() =>
      expect(harness.targetRequests).toEqual([partialIds, partialIds]),
    );

    ids = allIds;
    authoritative = true;
    failed = false;
    act(() => {
      sidebar.rerender();
      palette.rerender();
    });
    expect(harness.targetRequests).toHaveLength(2);
    harness.targetGate.release?.();

    await waitFor(() => expect(harness.targetRequests).toHaveLength(3));
    await waitFor(() => expect(sidebar.result.current.isFetching).toBe(false));
    expect(harness.targetRequests).toEqual([partialIds, partialIds, allIds]);
  });

  it("does not restart recovery when the refreshed target answer is unsupported", async () => {
    const harness = createHarness(null);
    let authoritative = false;
    let failed = true;
    let ids: readonly string[] = [CHAT_ID];
    let cloudChatIds: readonly string[] = [];
    const useTargets = () =>
      useChatPublicationTargets({
        client: requireHostClient(),
        epicId: EPIC_ID,
        chatIds: ids,
        cloudChatIds,
        chatIdsAuthoritative: authoritative,
        chatRecordListFailed: failed,
        enabled: true,
      });
    const first = renderHook(useTargets, {
      wrapper: wrapperFor(harness.queryClient),
    });
    const second = renderHook(useTargets, {
      wrapper: wrapperFor(harness.queryClient),
    });
    await waitFor(() => expect(harness.targetRequests).toHaveLength(1));
    await waitFor(() => expect(first.result.current.isFetching).toBe(false));

    harness.targetFailure.value = "unsupported";
    ids = [CHAT_ID, "chat-new"];
    authoritative = true;
    failed = false;
    act(() => {
      first.rerender();
      second.rerender();
    });
    await waitFor(() => expect(harness.targetRequests).toHaveLength(2));
    await waitFor(() => expect(first.result.current.isError).toBe(true));

    vi.useFakeTimers();
    try {
      cloudChatIds = ["new-unexplained-cloud-row"];
      act(() => {
        first.rerender();
        second.rerender();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      });
      expect(harness.targetRequests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades unsupported hosts to an empty publication map without retrying", async () => {
    const harness = createHarness(null);
    harness.targetFailure.value = "unsupported";
    const { result } = renderHook(
      () =>
        useChatPublicationTargets({
          client: requireHostClient(),
          epicId: EPIC_ID,
          chatIds: [CHAT_ID],
          cloudChatIds: [],
          chatIdsAuthoritative: true,
          chatRecordListFailed: false,
          enabled: true,
        }),
      { wrapper: wrapperFor(harness.queryClient) },
    );
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.error?.code).toBe("E_HOST_UNSUPPORTED");
    expect(publicationTargetMap(result.current.data)).toEqual(new Map());
    expect(harness.targetRequests).toEqual([[CHAT_ID]]);
  });

  it("feeds a fetched redirect into the real cloud-list fold", async () => {
    const harness = createHarness(sampleForkEvent());
    const { result } = renderHook(
      () =>
        useChatPublicationTargets({
          client: requireHostClient(),
          epicId: EPIC_ID,
          chatIds: [CHAT_ID],
          cloudChatIds: [],
          chatIdsAuthoritative: true,
          chatRecordListFailed: false,
          enabled: true,
        }),
      { wrapper: wrapperFor(harness.queryClient) },
    );
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    const rows = selectUnfoldedCloudChats({
      chats: [
        cloudSummary(CHAT_ID, "other-host"),
        cloudSummary("chat-1-forked", mockLocalHostEntry.hostId),
      ],
      localChatIds: [CHAT_ID],
      publicationChatIdByChatId: publicationTargetMap(result.current.data),
    });
    expect(rows.map((chat) => chat.identity.chatId)).toEqual([CHAT_ID]);
    expect(
      readCachedChatPublicationId(
        harness.queryClient,
        mockLocalHostEntry.hostId,
        EPIC_ID,
        CHAT_ID,
      ),
    ).toBe("chat-1-forked");
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
  const targetRequests: Array<readonly string[]> = [];
  const targetFailure = { value: null as "unsupported" | null };
  const targetGate: Harness["targetGate"] = { promise: null, release: null };
  const targetGateIndex = { value: 1 };
  let requestId = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
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
        // The redirect the sidebar folds the cloud list on. It is minted BY the
        // fork, so its answer flips exactly across the episode this test drives.
        "epic.listChatPublicationTargets": async (params) => {
          calls.push("epic.listChatPublicationTargets");
          targetRequests.push([...params.chatIds]);
          if (
            targetRequests.length === targetGateIndex.value &&
            targetGate.promise !== null
          ) {
            await targetGate.promise;
          }
          if (targetFailure.value === "unsupported") {
            throw new HostRpcError({
              code: "E_HOST_UNSUPPORTED",
              message: "This host does not support publication targets.",
              requestId: `request-${String(requestId)}`,
              method: "epic.listChatPublicationTargets",
              fatalDetails: {
                code: "E_HOST_UNSUPPORTED",
                reason: "This host does not support publication targets.",
                incompatibleMethods: null,
                upgradeGuidance: {
                  clientShouldUpgrade: false,
                  hostShouldUpgrade: true,
                },
              },
            });
          }
          return {
            redirected:
              forkEvent.value === null
                ? []
                : [{ chatId: CHAT_ID, publicationChatId: "chat-1-forked" }],
          };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
  );
  hostClientRef.current = spine.createRequester(mockLocalHostEntry);
  recordNegotiatedHostMethods(mockLocalHostEntry.hostId, ["host.chatFork.get"]);
  useAuthStore.setState({
    contextMetadata: { userId: "user-a", username: "user-a" },
  });
  return {
    queryClient,
    forkEvent,
    calls,
    targetRequests,
    targetFailure,
    targetGate,
    targetGateIndex,
  };
}

function cloudSummary(chatId: string, ownerHostId: string) {
  return {
    identity: { taskId: "task-1", ownerUserId: "user-1", chatId },
    ownerHostId,
    createdAt: 1,
    visibility: "task" as const,
    title: chatId,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: 1,
    throughRecordSeq: null,
    isOwnedByViewer: true,
  };
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
        unreadCount: 0,
      },
    },
    complete: true,
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
