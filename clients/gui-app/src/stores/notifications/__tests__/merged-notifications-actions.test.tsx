import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostNotificationEntry,
  HostNotificationsCloudFeedRow,
} from "@traycer/protocol/host/notifications/contracts";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  cloudNotificationFeedId,
  useCloudNotificationsStore,
} from "@/stores/notifications/cloud-notifications-store";
import {
  useAttentionNotificationIds,
  useMergedNotificationRow,
  useMergedNotificationsActions,
} from "@/stores/notifications/merged-notifications";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";

const hostRequestMock = vi.hoisted(() => vi.fn());
const notificationFeedMode = vi.hoisted<{ value: "local" | "cloud" }>(() => ({
  value: "local",
}));

const hostBindingState = vi.hoisted(() => ({
  current: null as {
    readonly hostClient: {
      readonly request: typeof hostRequestMock;
      readonly getActiveHostId: () => string | null;
    };
  } | null,
}));

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingState.current,
  };
});

vi.mock("@/lib/host-error-toast", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host-error-toast")>();
  return {
    ...actual,
    toastFromHostError: vi.fn(actual.toastFromHostError),
  };
});

vi.mock("@/lib/notifications/notification-feed-mode", () => ({
  useNotificationFeedMode: () => notificationFeedMode.value,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () =>
    hostBindingState.current?.hostClient.getActiveHostId() ?? null,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";
import { toastFromHostError } from "@/lib/host-error-toast";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(): (props: {
  readonly children: ReactNode;
}) => ReactNode {
  const queryClient = createTestQueryClient();
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function createRetryingMutationWrapper(): (props: {
  readonly children: ReactNode;
}) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: 1, retryDelay: 0 },
    },
  });
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function hostPrompt(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "approval.requested",
    sourceRef: id,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: "Checkout notifications",
      approvalId: id,
    },
  };
}

function hostDone(
  id: string,
  updatedAt: number,
  readAt: number | null,
): HostNotificationEntry {
  return {
    id,
    updatedAt,
    readAt,
    kind: "agent.stopped",
    sourceRef: id,
    severity: "done",
    outcome: "completed",
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
      agentName: "Agent",
      taskTitle: "Checkout notifications",
      outcome: "completed",
    },
  };
}

/** One occurrence of the `agent.stopped:chat-1` group. A reopen is a DIFFERENT
 * `entryId` under the same `coalesceKey`, never an edit of this one. */
function cloudDone(
  entryId: string,
  createdAt: number,
  readAt: number | null,
): HostNotificationsCloudFeedRow {
  return {
    entryId,
    originHostId: "host-cloud",
    coalesceKey: "agent.stopped:chat-1",
    entry: {
      id: entryId,
      updatedAt: createdAt,
      readAt,
      kind: "agent.stopped",
      sourceRef: entryId,
      severity: "done",
      outcome: "completed",
      epicId: "epic-1",
      chatId: "chat-1",
      payload: {
        kind: "chat",
        epicId: "epic-1",
        chatId: "chat-1",
        outcome: "completed",
      },
    },
    presentation: { epicTitle: "Cloud epic", chatTitle: "Cloud chat" },
  };
}

function applyHostSnapshot(
  entries: ReadonlyArray<HostNotificationEntry>,
  summary: { readonly unreadCount: number; readonly attentionCount: number },
): void {
  useHostNotificationsStore.getState().applySnapshot({
    attention: {
      entries: entries.filter(
        (entry) =>
          entry.severity === "needs_action" || entry.severity === "failure",
      ),
      nextCursor: null,
    },
    recent: { entries, nextCursor: null },
    summary,
  });
}

function bindHostClient(): void {
  hostBindingState.current = {
    hostClient: {
      request: hostRequestMock,
      getActiveHostId: () => mockLocalHostEntry.hostId,
    },
  };
}

function defaultHostRequest(method: string): Promise<unknown> {
  if (
    method === "host.notifications.markRead" ||
    method === "host.notifications.resolve" ||
    method === "host.notifications.markAllRead"
  ) {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve({});
}

function unsupportedResolveError(): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: "host.notifications.resolve is not supported",
    requestId: "req-unsupported-resolve",
    method: "host.notifications.resolve",
    fatalDetails: {
      code: "E_HOST_UNSUPPORTED",
      reason: "Method not advertised by this host",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function markAllReadCallParams(): { readonly beforeUpdatedAt: number } {
  const call = hostRequestMock.mock.calls.find(
    (entry) => entry[0] === "host.notifications.markAllRead",
  );
  const params: unknown = call === undefined ? undefined : call[1];
  if (!isRecord(params)) {
    throw new Error("expected host.notifications.markAllRead params");
  }
  const beforeUpdatedAt = params["beforeUpdatedAt"];
  if (typeof beforeUpdatedAt !== "number") {
    throw new Error("expected host.notifications.markAllRead params");
  }
  return { beforeUpdatedAt };
}

function resolveCallOccurrences(): ReadonlyArray<{
  readonly id: string;
  readonly updatedAt: number;
  readonly sourceRef: string | null;
}> {
  const call = hostRequestMock.mock.calls.find(
    (entry) => entry[0] === "host.notifications.resolve",
  );
  const params: unknown = call === undefined ? undefined : call[1];
  if (!isRecord(params)) {
    throw new Error("expected host.notifications.resolve params");
  }
  const occurrences = params["occurrences"];
  if (!Array.isArray(occurrences)) {
    throw new Error("expected host.notifications.resolve params");
  }
  return occurrences.map((raw: unknown) => {
    if (!isRecord(raw)) {
      throw new Error("expected resolve occurrence token");
    }
    const id = raw["id"];
    const updatedAt = raw["updatedAt"];
    const sourceRef = raw["sourceRef"];
    if (
      typeof id !== "string" ||
      typeof updatedAt !== "number" ||
      (sourceRef !== null && typeof sourceRef !== "string")
    ) {
      throw new Error("expected resolve occurrence token");
    }
    return {
      id,
      updatedAt,
      sourceRef: sourceRef === null ? null : sourceRef,
    };
  });
}

/** The exact `useHostQueries` cache key shape for one `indicatorState`
 * request pair: host scope, method, request params, identity suffix. */
type IndicatorQueryKey = readonly [
  "host",
  string,
  "host.notifications.indicatorState",
  {
    readonly epicIds: ReadonlyArray<string>;
    readonly chatIds: ReadonlyArray<string>;
  },
  string,
];

function entryResolvedAt(id: string): number | null {
  const byId = useHostNotificationsStore.getState().byId;
  if (!(id in byId)) {
    throw new Error(`missing host notification ${id}`);
  }
  const entry = byId[id];
  return "resolvedAt" in entry ? entry.resolvedAt : null;
}

describe("useMergedNotificationsActions markAllAsRead composition", () => {
  beforeEach(() => {
    hostRequestMock.mockReset();
    hostRequestMock.mockImplementation(defaultHostRequest);
    hostBindingState.current = null;
    notificationFeedMode.value = "local";
    vi.mocked(toastFromHostError).mockClear();
    vi.mocked(toast.error).mockClear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    __resetAppLocalNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-actions");
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    hostBindingState.current = null;
    notificationFeedMode.value = "local";
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("fires markAllRead and resolve concurrently with loaded blocking occurrence tokens", async () => {
    bindHostClient();
    applyHostSnapshot(
      [
        hostPrompt("prompt-a", 200, null),
        hostPrompt("prompt-b", 150, 40),
        hostDone("done-unread", 100, null),
      ],
      { unreadCount: 2, attentionCount: 2 },
    );

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        attentionIds: useAttentionNotificationIds(),
      }),
      { wrapper: createWrapper() },
    );

    expect(result.current.attentionIds).toEqual([
      "host:prompt-a",
      "host:prompt-b",
    ]);

    act(() => {
      result.current.actions.markAllAsRead();
    });

    await waitFor(() => {
      expect(markAllReadCallParams().beforeUpdatedAt).toBeTypeOf("number");
      expect(
        [...resolveCallOccurrences()].sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual([
        { id: "prompt-a", updatedAt: 200, sourceRef: "prompt-a" },
        { id: "prompt-b", updatedAt: 150, sourceRef: "prompt-b" },
      ]);
    });

    // No optimistic resolve: Attention still holds the loaded prompts until the
    // host's authoritative readStateChanged frame lands.
    expect(result.current.attentionIds).toEqual([
      "host:prompt-a",
      "host:prompt-b",
    ]);
    expect(entryResolvedAt("prompt-a")).toBeNull();

    act(() => {
      useHostNotificationsStore
        .getState()
        .applyReadStateFrame(["prompt-a", "prompt-b"], {
          readAt: 999,
          resolvedAt: 999,
          removedIds: [],
          summary: { unreadCount: 0, attentionCount: 0 },
        });
    });

    await waitFor(() => {
      expect(result.current.attentionIds).toEqual([]);
    });
  });

  it("skips resolve when no loaded blocking Attention rows exist", async () => {
    bindHostClient();
    applyHostSnapshot([hostDone("done-only", 100, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });

    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllAsRead();
    });

    await waitFor(() => {
      expect(markAllReadCallParams().beforeUpdatedAt).toBeTypeOf("number");
    });

    expect(
      hostRequestMock.mock.calls.some(
        (call) => call[0] === "host.notifications.resolve",
      ),
    ).toBe(false);
  });

  it("keeps markAllRead when resolve is E_HOST_UNSUPPORTED without a failure row or double toast", async () => {
    bindHostClient();
    applyHostSnapshot(
      [
        hostPrompt("prompt-old-host", 200, null),
        hostDone("done-unread", 100, null),
      ],
      { unreadCount: 2, attentionCount: 1 },
    );

    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.resolve") {
        return Promise.reject(unsupportedResolveError());
      }
      return defaultHostRequest(method);
    });

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        attentionIds: useAttentionNotificationIds(),
      }),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.actions.markAllAsRead();
    });

    await waitFor(() => {
      expect(markAllReadCallParams().beforeUpdatedAt).toBeTypeOf("number");
      expect(resolveCallOccurrences()).toEqual([
        {
          id: "prompt-old-host",
          updatedAt: 200,
          sourceRef: "prompt-old-host",
        },
      ]);
    });

    await waitFor(() => {
      expect(
        useHostNotificationsStore.getState().byId["done-unread"].readAt,
      ).toBeTypeOf("number");
    });

    await waitFor(() => {
      expect(toastFromHostError).toHaveBeenCalledTimes(1);
    });
    expect(toastFromHostError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "E_HOST_UNSUPPORTED",
        method: "host.notifications.resolve",
      }),
      "Couldn't dismiss the notifications.",
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "This needs a newer Traycer host. Update the host to continue.",
      {
        id: "host-error:E_HOST_UNSUPPORTED:E_HOST_UNSUPPORTED",
        cancel: null,
      },
    );
    expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(0);
    expect(result.current.attentionIds).toEqual(["host:prompt-old-host"]);
    expect(entryResolvedAt("prompt-old-host")).toBeNull();
  });
});

describe("useMergedNotificationsActions row-level resolve", () => {
  beforeEach(() => {
    hostRequestMock.mockReset();
    hostRequestMock.mockImplementation(defaultHostRequest);
    hostBindingState.current = null;
    vi.mocked(toastFromHostError).mockClear();
    vi.mocked(toast.error).mockClear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-actions");
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries: [], nextCursor: null },
      recent: { entries: [], nextCursor: null },
      summary: { unreadCount: 0, attentionCount: 0 },
    });
  });

  afterEach(() => {
    cleanup();
    hostBindingState.current = null;
    __resetHostNotificationsStoreForTests();
    __resetAppLocalNotificationsStoreForTests();
  });

  it("no-ops when the host binding is retained but has no active host", async () => {
    // A disconnect keeps the runtime binding (`client !== null`) and the
    // rendered blocking row, but drops the active host id to null. The Dismiss
    // tick stays clickable, yet firing resolve then would only yield an
    // unbound-rejection toast while the row cannot change - so it must no-op,
    // mirroring markAllAsRead's dismiss-all active-host gate.
    hostBindingState.current = {
      hostClient: {
        request: hostRequestMock,
        getActiveHostId: () => null,
      },
    };
    applyHostSnapshot([hostPrompt("prompt-a", 200, null)], {
      unreadCount: 1,
      attentionCount: 1,
    });

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        row: useMergedNotificationRow("host:prompt-a"),
      }),
      { wrapper: createWrapper() },
    );

    const row = result.current.row;
    expect(row).not.toBeNull();
    if (row === null) return;

    act(() => {
      result.current.actions.resolve(row);
    });
    // Flush any scheduled mutation so a regression that dropped the guard would
    // surface the resolve RPC here rather than pass on an unflushed microtask.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });

    expect(
      hostRequestMock.mock.calls.some(
        (call) => call[0] === "host.notifications.resolve",
      ),
    ).toBe(false);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(vi.mocked(toastFromHostError)).not.toHaveBeenCalled();
  });

  it("fires the resolve RPC with the occurrence token when an active host is bound", async () => {
    bindHostClient();
    applyHostSnapshot([hostPrompt("prompt-a", 200, null)], {
      unreadCount: 1,
      attentionCount: 1,
    });

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        row: useMergedNotificationRow("host:prompt-a"),
      }),
      { wrapper: createWrapper() },
    );

    const row = result.current.row;
    expect(row).not.toBeNull();
    if (row === null) return;

    act(() => {
      result.current.actions.resolve(row);
    });

    await waitFor(() => {
      expect(
        hostRequestMock.mock.calls.some(
          (call) => call[0] === "host.notifications.resolve",
        ),
      ).toBe(true);
    });
    // The resolve carries the row's immutable occurrence token
    // (id, updatedAt, sourceRef) - the exact tuple the host guards on - not just
    // the method name.
    expect(resolveCallOccurrences()).toEqual([
      { id: "prompt-a", updatedAt: 200, sourceRef: "prompt-a" },
    ]);
  });
});

describe("useMergedNotificationsActions indicator invalidation", () => {
  beforeEach(() => {
    hostRequestMock.mockReset();
    hostRequestMock.mockImplementation(defaultHostRequest);
    hostBindingState.current = null;
    notificationFeedMode.value = "local";
    vi.mocked(toastFromHostError).mockClear();
    vi.mocked(toast.error).mockClear();
    __resetNotificationsStoreForTests();
    __resetHostNotificationsStoreForTests();
    // The feed version is monotonic within a session, so a snapshot below the
    // one already applied is dropped as a stale frame. Leaking it across tests
    // would silently swallow the next test's seed.
    useCloudNotificationsStore.getState().reset();
    __resetAppLocalNotificationsStoreForTests();
    useAppLocalNotificationsStore.getState().activateIdentity("user-actions");
  });

  afterEach(() => {
    cleanup();
    hostBindingState.current = null;
    notificationFeedMode.value = "local";
    __resetHostNotificationsStoreForTests();
    useCloudNotificationsStore.getState().reset();
    __resetAppLocalNotificationsStoreForTests();
  });

  function indicatorKey(epicId: string, chatId: string): IndicatorQueryKey {
    return [
      "host",
      mockLocalHostEntry.hostId,
      "host.notifications.indicatorState",
      { epicIds: [epicId], chatIds: [chatId] },
      "notifications:indicator-state:user-actions",
    ];
  }

  function seededIndicatorHarness(): {
    readonly queryClient: QueryClient;
    readonly rowKey: IndicatorQueryKey;
    readonly unrelatedKey: IndicatorQueryKey;
    readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  } {
    const queryClient = createTestQueryClient();
    const rowKey = indicatorKey("epic-1", "chat-1");
    const unrelatedKey = indicatorKey("epic-other", "chat-other");
    queryClient.setQueryData(rowKey, { epics: {}, chats: {} });
    queryClient.setQueryData(unrelatedKey, { epics: {}, chats: {} });
    return {
      queryClient,
      rowKey,
      unrelatedKey,
      wrapper: function Wrapper(props: {
        readonly children: ReactNode;
      }): ReactNode {
        return (
          <QueryClientProvider client={queryClient}>
            {props.children}
          </QueryClientProvider>
        );
      },
    };
  }

  it("invalidates the row's entity-scoped indicator queries on mark-read success", async () => {
    // The tab/sidebar error badges refetch off `indicatorState` queries. The
    // host's `readStateChanged` echo on the feed stream is one invalidation
    // trigger, but a successful unary mark-read must clear them on its own -
    // otherwise a stream outage freezes badges while the popover row greys out.
    bindHostClient();
    applyHostSnapshot([hostDone("done-1", 100, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });
    const { queryClient, rowKey, unrelatedKey, wrapper } =
      seededIndicatorHarness();

    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper,
    });

    act(() => {
      result.current.markAsRead("host:done-1");
    });

    await waitFor(() => {
      expect(queryClient.getQueryState(rowKey)?.isInvalidated).toBe(true);
    });
    expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  });

  it("falls back to the full indicator scope when the marked row names no entity", async () => {
    // A row can leave `byId` before its mark-read settles (retention pruning,
    // a snapshot swap), and a row with no `epicId` never named an entity at
    // all. Neither can produce an entity-scoped invalidation, so the fallback
    // must refresh the whole host scope rather than silently skip — a skip
    // would strand exactly the badges this change exists to clear.
    bindHostClient();
    applyHostSnapshot([hostDone("done-1", 100, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });
    const { queryClient, rowKey, unrelatedKey, wrapper } =
      seededIndicatorHarness();

    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper,
    });

    act(() => {
      result.current.markAsRead("host:pruned-before-settle");
    });

    await waitFor(() => {
      expect(queryClient.getQueryState(rowKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(true);
    });
  });

  it("invalidates the full indicator scope on mark-all-read success", async () => {
    bindHostClient();
    applyHostSnapshot([hostDone("done-1", 100, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });
    const { queryClient, rowKey, unrelatedKey, wrapper } =
      seededIndicatorHarness();

    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper,
    });

    act(() => {
      result.current.markAllAsRead();
    });

    await waitFor(() => {
      expect(queryClient.getQueryState(rowKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(true);
    });
  });

  it("addresses the entry captured by the click, even after that coalesceKey reopened", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    const original = cloudDone("entry-a", 1, null);
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [original],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 1,
    });

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        row: useMergedNotificationRow(cloudNotificationFeedId("entry-a")),
      }),
      { wrapper: createWrapper() },
    );
    const captured = result.current.row;
    if (captured === null) throw new Error("expected cloud row");

    // The group reopens: a NEW entry supersedes the captured one, and it
    // arrives under its own feed id rather than mutating the old row.
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-b", 2, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 2,
    });
    act(() => {
      result.current.actions.clear(captured);
    });

    // The command still names `entry-a`. That is the whole guard: a stale
    // action can only reference a superseded entry, where the cloud no-ops it
    // - so no occurrence token is needed to keep it off `entry-b`.
    await waitFor(() => {
      const call = hostRequestMock.mock.calls.find(
        (entry) => entry[0] === "host.notifications.cloudFeed.clear",
      );
      expect(call?.[1]).toEqual({ entryId: "entry-a" });
    });
    expect(
      useCloudNotificationsStore.getState().rows[
        cloudNotificationFeedId("entry-b")
      ]?.entryId,
    ).toBe("entry-b");
  });

  it("keeps a reopened entry unread after the entry it superseded was read", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 10,
    });

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        readRow: useMergedNotificationRow(cloudNotificationFeedId("entry-a")),
        reopenedRow: useMergedNotificationRow(
          cloudNotificationFeedId("entry-b"),
        ),
      }),
      { wrapper: createWrapper() },
    );
    const captured = result.current.readRow;
    if (captured === null) throw new Error("expected cloud row");
    act(() => {
      result.current.actions.markAsRead(captured);
    });
    const optimisticallyRead =
      useCloudNotificationsStore.getState().rows[
        cloudNotificationFeedId("entry-a")
      ];
    expect(optimisticallyRead?.entry.readAt).toBeTypeOf("number");
    expect(useCloudNotificationsStore.getState().summary?.unreadCount).toBe(0);
    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markRead",
        { entryId: "entry-a" },
      );
    });

    // `entry-a` is now read in the cloud, and the reopen arrives as its own
    // immutable entry with its own null markers. Nothing can carry the read
    // across: there is no shared row for a marker to have been written on.
    act(() => {
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [cloudDone("entry-b", 2, null)],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
        version: 11,
      });
    });

    expect(result.current.reopenedRow?.readAt).toBeNull();
    expect(result.current.readRow).toBeNull();
  });

  it("sends an identical body on a retried mutation - a set-once marker needs no idempotency key", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    let attempts = 0;
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.cloudFeed.markRead") {
        attempts += 1;
        if (attempts === 1) return Promise.reject(unsupportedResolveError());
        return Promise.resolve({ status: "applied", version: 11 });
      }
      return defaultHostRequest(method);
    });
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        row: useMergedNotificationRow(cloudNotificationFeedId("entry-a")),
      }),
      { wrapper: createRetryingMutationWrapper() },
    );
    const captured = result.current.row;
    if (captured === null) throw new Error("expected cloud row");

    act(() => {
      result.current.actions.markAsRead(captured);
    });

    await waitFor(() => {
      const calls = hostRequestMock.mock.calls.filter(
        (call) => call[0] === "host.notifications.cloudFeed.markRead",
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[1]).toEqual({ entryId: "entry-a" });
      expect(calls[1]?.[1]).toEqual(calls[0]?.[1]);
    });
  });

  it("captures clear-all at the observed version while a newer entry survives", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-observed", 1, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.clearAll();
      // A newer entry lands between the click and the request. Membership is
      // decided by the observed version, not by a timestamp threshold, so this
      // one is simply not in the set - whatever its clock says.
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [cloudDone("entry-later", 2, null)],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
        version: 11,
      });
    });

    await waitFor(() => {
      const call = hostRequestMock.mock.calls.find(
        (entry) => entry[0] === "host.notifications.cloudFeed.clearAll",
      );
      expect(call?.[1]).toEqual({ observedVersion: 10 });
    });
    expect(
      useCloudNotificationsStore.getState().rows[
        cloudNotificationFeedId("entry-later")
      ]?.entryId,
    ).toBe("entry-later");
  });

  it("quotes the newest version to clear-all even when the rendered feed did not change", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    const row = cloudDone("entry-a", 1, null);
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [row],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    // A relay frame whose rendered rows are identical but whose version moved:
    // something changed in the feed that this build cannot display. The
    // clear-all the user issues next must name THAT feed, not the one from
    // before - otherwise the change it could not render also escapes the
    // clear.
    act(() => {
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [row],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
        version: 11,
      });
    });
    act(() => {
      result.current.clearAll();
    });

    await waitFor(() => {
      const call = hostRequestMock.mock.calls.find(
        (entry) => entry[0] === "host.notifications.cloudFeed.clearAll",
      );
      expect(call?.[1]).toEqual({ observedVersion: 11 });
    });
  });

  it("retains an optimistic read marker until a later snapshot reconciles an unavailable command", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.cloudFeed.markRead") {
        return Promise.resolve({ status: "unavailable", version: null });
      }
      return defaultHostRequest(method);
    });
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        row: useMergedNotificationRow(cloudNotificationFeedId("entry-a")),
      }),
      { wrapper: createWrapper() },
    );
    const captured = result.current.row;
    if (captured === null) throw new Error("expected cloud row");

    act(() => {
      result.current.actions.markAsRead(captured);
    });

    await waitFor(() => {
      expect(useCloudNotificationsStore.getState().connectionState).toBe(
        "unavailable",
      );
    });
    // The row stays present and the set-once marker remains optimistic while
    // unavailable; no rollback timer makes perceived state depend on a poll.
    expect(
      useCloudNotificationsStore.getState().rows[
        cloudNotificationFeedId("entry-a")
      ]?.entryId,
    ).toBe("entry-a");
    expect(result.current.row?.readAt).toBeTypeOf("number");

    act(() => {
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [cloudDone("entry-a", 1, null)],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
        version: 11,
      });
    });
    expect(result.current.row?.readAt).toBeNull();
  });

  it("does not acknowledge a retained v1 row while cloud is authoritative", () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    applyHostSnapshot([hostDone("retained-local", 1, null)], {
      unreadCount: 1,
      attentionCount: 0,
    });

    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });
    act(() => {
      result.current.markAsRead("host:retained-local");
    });

    expect(hostRequestMock).not.toHaveBeenCalled();
  });

  it("uses one observed-version mark-all for renderable and summary-only unread entries", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.cloudFeed.markAllRead") {
        return Promise.resolve({ status: "applied", version: 2 });
      }
      return defaultHostRequest(method);
    });
    useCloudNotificationsStore.getState().applySnapshot({
      // The second unread entry exists in the raw cloud feed but was omitted
      // by the relay's renderer conversion, so it appears only in the summary.
      rows: [cloudDone("entry-a", 1, null)],
      summary: { totalCount: 2, unreadCount: 2, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllAsRead();
    });

    expect(useCloudNotificationsStore.getState().summary?.unreadCount).toBe(0);
    expect(
      Object.values(useCloudNotificationsStore.getState().rows).every(
        (row) => row?.entry.readAt !== null,
      ),
    ).toBe(true);
    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markAllRead",
        { observedVersion: 10 },
      );
    });
    expect(
      hostRequestMock.mock.calls.filter(
        (call) => call[0] === "host.notifications.cloudFeed.markRead",
      ),
    ).toHaveLength(0);
  });

  it("marks renderer-local failures read alongside the cloud feed", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 10,
    });
    useAppLocalNotificationsStore.getState().upsert({
      id: "terminal-crash",
      updatedAt: 2,
      readAt: null,
      kind: "terminal.crashed",
      sourceRef: "terminal-instance",
      payload: {
        kind: "terminal",
        epicId: "epic-1",
        terminalId: "terminal-1",
        tabId: "tab-1",
        paneId: "pane-1",
        tileInstanceId: "terminal-instance",
      },
      message: "Build terminal exited unexpectedly.",
      detail: "The terminal process ended with an error.",
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllAsRead();
    });

    expect(
      useAppLocalNotificationsStore.getState().byId["terminal-crash"].readAt,
    ).toBeTypeOf("number");
    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markAllRead",
        { observedVersion: 10 },
      );
    });
  });

  it("marks renderer-local failures read without mutating a reconnecting cloud feed", () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 10,
    });
    useCloudNotificationsStore.getState().setConnectionState("reconnecting");
    useAppLocalNotificationsStore.getState().upsert({
      id: "terminal-crash",
      updatedAt: 2,
      readAt: null,
      kind: "terminal.crashed",
      sourceRef: "terminal-instance",
      payload: null,
      message: "Build terminal exited unexpectedly.",
      detail: "The terminal process ended with an error.",
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllAsRead();
    });

    expect(
      useAppLocalNotificationsStore.getState().byId["terminal-crash"].readAt,
    ).toBeTypeOf("number");
    expect(useCloudNotificationsStore.getState().summary?.unreadCount).toBe(1);
    expect(hostRequestMock).not.toHaveBeenCalled();
  });

  it("falls back to renderable cloud entries when an older relay lacks mark-all", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.cloudFeed.markAllRead") {
        return Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "host.notifications.cloudFeed.markAllRead is unsupported",
            requestId: "test-request",
            method,
            fatalDetails: {
              code: "E_HOST_UNSUPPORTED",
              reason: "unsupported method",
              incompatibleMethods: null,
              upgradeGuidance: null,
            },
          }),
        );
      }
      if (method === "host.notifications.cloudFeed.markRead") {
        return Promise.resolve({ status: "applied", version: 10 });
      }
      return defaultHostRequest(method);
    });
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null), cloudDone("entry-b", 2, null)],
      summary: { totalCount: 2, unreadCount: 2, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllAsRead();
    });

    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markRead",
        { entryId: "entry-a" },
      );
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markRead",
        { entryId: "entry-b" },
      );
    });
    expect(useCloudNotificationsStore.getState().connectionState).toBe(
      "connected",
    );
  });

  it("falls back when an older cloud server cannot acknowledge mark-all", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.cloudFeed.markAllRead") {
        return Promise.resolve({ status: "unsupported", version: null });
      }
      if (method === "host.notifications.cloudFeed.markRead") {
        return Promise.resolve({ status: "applied", version: 10 });
      }
      return defaultHostRequest(method);
    });
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null), cloudDone("entry-b", 2, null)],
      summary: { totalCount: 2, unreadCount: 2, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllAsRead();
    });

    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markRead",
        { entryId: "entry-a" },
      );
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markRead",
        { entryId: "entry-b" },
      );
    });
    expect(useCloudNotificationsStore.getState().connectionState).toBe(
      "connected",
    );
  });

  it("continues the compatibility fallback after one entry write fails", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    hostRequestMock.mockImplementation((method: string, params: unknown) => {
      if (method === "host.notifications.cloudFeed.markAllRead") {
        return Promise.resolve({ status: "unsupported", version: null });
      }
      if (method === "host.notifications.cloudFeed.markRead") {
        if (isRecord(params) && params["entryId"] === "entry-a") {
          return Promise.reject(new Error("transient entry write failure"));
        }
        return Promise.resolve({ status: "applied", version: 10 });
      }
      return defaultHostRequest(method);
    });
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null), cloudDone("entry-b", 2, null)],
      summary: { totalCount: 2, unreadCount: 2, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllAsRead();
    });

    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markRead",
        { entryId: "entry-b" },
      );
    });
  });

  it("does not replay a bulk compatibility fallback into a replacement cloud session", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    let resolveMarkAll:
      | ((result: {
          readonly status: "unsupported";
          readonly version: null;
        }) => void)
      | undefined;
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.cloudFeed.markAllRead") {
        return new Promise((resolve) => {
          resolveMarkAll = resolve;
        });
      }
      if (method === "host.notifications.cloudFeed.markRead") {
        return Promise.resolve({ status: "applied", version: 10 });
      }
      return defaultHostRequest(method);
    });
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.markAllAsRead();
    });
    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markAllRead",
        { observedVersion: 10 },
      );
    });
    act(() => {
      useCloudNotificationsStore.getState().reset();
    });
    if (resolveMarkAll === undefined) {
      throw new Error("expected pending cloud mark-all request");
    }
    const resolvePendingMarkAll = resolveMarkAll;
    await act(async () => {
      resolvePendingMarkAll({ status: "unsupported", version: null });
      await Promise.resolve();
    });

    expect(
      hostRequestMock.mock.calls.filter(
        (call) => call[0] === "host.notifications.cloudFeed.markRead",
      ),
    ).toHaveLength(0);
  });

  it("does not mark a newer cloud snapshot from a stale action closure", () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 10,
    });
    const { result } = renderHook(() => useMergedNotificationsActions(), {
      wrapper: createWrapper(),
    });
    const staleMarkAllAsRead = result.current.markAllAsRead;

    act(() => {
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [cloudDone("entry-a", 1, null), cloudDone("entry-b", 2, null)],
        summary: { totalCount: 2, unreadCount: 2, attentionCount: 0 },
        version: 11,
      });
      staleMarkAllAsRead();
    });

    expect(useCloudNotificationsStore.getState().summary?.unreadCount).toBe(2);
    expect(
      Object.values(useCloudNotificationsStore.getState().rows).every(
        (row) => row?.entry.readAt === null,
      ),
    ).toBe(true);
    expect(hostRequestMock).not.toHaveBeenCalled();
  });

  it("ignores a cloud command completion from a replaced ownership epoch", async () => {
    bindHostClient();
    notificationFeedMode.value = "cloud";
    useCloudNotificationsStore.getState().applySnapshot({
      rows: [cloudDone("entry-a", 1, null)],
      summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
      version: 1,
    });
    let settleRequest: (() => void) | null = null;
    hostRequestMock.mockImplementation((method: string) => {
      if (method === "host.notifications.cloudFeed.markRead") {
        return new Promise((resolve) => {
          settleRequest = () =>
            resolve({ status: "unavailable", version: null });
        });
      }
      return defaultHostRequest(method);
    });

    const { result } = renderHook(
      () => ({
        actions: useMergedNotificationsActions(),
        row: useMergedNotificationRow(cloudNotificationFeedId("entry-a")),
      }),
      { wrapper: createWrapper() },
    );
    const captured = result.current.row;
    if (captured === null) throw new Error("expected cloud row");
    act(() => {
      result.current.actions.markAsRead(captured);
    });
    await waitFor(() => {
      expect(hostRequestMock).toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markRead",
        expect.any(Object),
      );
    });

    act(() => {
      useCloudNotificationsStore.getState().reset();
      useCloudNotificationsStore.getState().applySnapshot({
        rows: [cloudDone("entry-b", 2, null)],
        summary: { totalCount: 1, unreadCount: 1, attentionCount: 0 },
        version: 2,
      });
      if (settleRequest === null) {
        throw new Error("expected pending cloud request");
      }
      settleRequest();
    });
    await waitFor(() => {
      expect(useCloudNotificationsStore.getState().connectionState).toBe(
        "connected",
      );
    });
  });
});
