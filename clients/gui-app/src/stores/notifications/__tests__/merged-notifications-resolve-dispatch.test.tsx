import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type {
  HostNotificationsCloudFeedRow,
  HostNotificationsCloudFeedRowV16,
} from "@traycer/protocol/host/notifications/contracts";
import { useAuthStore } from "@/stores/auth/auth-store";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";
import {
  CLOUD_ENTITY_READ_RETRY_MAX_MS,
  resetCloudEntityReadDriver,
} from "@/lib/notifications/cloud-entity-read-driver";
import { notificationsMutationKeys } from "@/lib/query-keys";
import {
  cloudNotificationFeedId,
  useCloudNotificationsStore,
  type CloudNotificationsState,
} from "@/stores/notifications/cloud-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import {
  useMergedNotificationRow,
  useMergedNotificationsActions,
  type MergedNotificationRow,
  type MergedNotificationsActions,
} from "@/stores/notifications/merged-notifications";

const hostRequestMock = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
);

interface StubHostClient {
  readonly request: typeof hostRequestMock;
  readonly getActiveHostId: () => string | null;
  readonly createRequesterForHostId: (hostId: string | null) => StubHostClient;
  readonly requestWithSignalRequiringHostMethodVersion: (
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    requirement: { readonly method: string; readonly version: SchemaVersion },
  ) => Promise<unknown>;
}

const hostBindingState = vi.hoisted(() => ({
  current: null as { readonly hostClient: StubHostClient } | null,
}));

vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => hostBindingState.current,
  };
});

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () =>
    hostBindingState.current?.hostClient.getActiveHostId() ?? null,
}));

vi.mock("@/hooks/notifications/use-notification-host", () => ({
  useNotificationResolveHostId: () =>
    hostBindingState.current?.hostClient.getActiveHostId() ?? null,
  useNotificationResolveHost: () => ({
    hostId: hostBindingState.current?.hostClient.getActiveHostId() ?? null,
    client: hostBindingState.current?.hostClient ?? null,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

type FeedMode = "local" | "cloud" | "upgrade-required";

/** What the session provider would publish; the wrapper reads it per render. */
const publishedFeedMode: { value: FeedMode } = { value: "cloud" };

/**
 * The cloud store's optimistic writes, wrapped so a test can see whether a
 * gesture touched the feed. Each passes through to the real action, and
 * `setState` keeps them across `set`/`reset`.
 */
const realStoreActions = useCloudNotificationsStore.getState();
const localWrites = {
  resolveNoticeLocally: vi.fn((entryId: string, resolvedAt: number): void => {
    realStoreActions.resolveNoticeLocally(entryId, resolvedAt);
  }),
  markReadLocally: vi.fn((entryId: string, readAt: number): void => {
    realStoreActions.markReadLocally(entryId, readAt);
  }),
  markAllReadLocally: vi.fn((readAt: number): void => {
    realStoreActions.markAllReadLocally(readAt);
  }),
  beginEntityRead: vi.fn(
    (entryIds: ReadonlyArray<string>, readAt: number): void => {
      realStoreActions.beginEntityRead(entryIds, readAt);
    },
  ),
};
type LocalWriteName = keyof typeof localWrites;

const NOTICE_ID = "notice-1";
const CHAT_ID = "chat-row-1";
const CHAT_ID_SECOND = "chat-row-2";
const OTHER_ID = "other-1";
const FEED_VERSION = 10;
const CLOUD_MUTATION_KEYS = [
  notificationsMutationKeys.cloudMarkRead(),
  notificationsMutationKeys.cloudMarkAllRead(),
  notificationsMutationKeys.cloudResolve(),
  notificationsMutationKeys.cloudClear(),
  notificationsMutationKeys.cloudClearAll(),
];

function actionableSandboxNotice(
  entryId: string,
): HostNotificationsCloudFeedRowV16 {
  return {
    entryId,
    originHostId: "host-cloud",
    coalesceKey: `sandbox-notice:${entryId}`,
    entry: {
      id: entryId,
      updatedAt: 1,
      readAt: null,
      kind: "sandbox.notice",
      sourceRef: entryId,
      severity: "needs_action",
      outcome: "completed",
      epicId: null,
      chatId: null,
      resolvedAt: null,
      payload: {
        kind: "sandbox_notice",
        sandboxId: "sbx-1",
        sandboxName: "build box",
        notice: { kind: "resting_destroyed" },
      },
    },
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

function chatDone(entryId: string): HostNotificationsCloudFeedRow {
  return {
    entryId,
    originHostId: "host-cloud",
    coalesceKey: `agent.stopped:${entryId}`,
    entry: {
      id: entryId,
      updatedAt: 2,
      readAt: null,
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
    presentation: { epicTitle: "Epic", chatTitle: "Chat" },
  };
}

/** A feed as an opened session for the signed-in account holds it. */
function applyCloudFeed(
  entryIds: ReadonlyArray<string>,
  accountId: string,
): void {
  useCloudNotificationsStore.setState({ accountId });
  useCloudNotificationsStore.getState().applySnapshot({
    rows: entryIds.map((entryId) =>
      entryId === CHAT_ID || entryId === CHAT_ID_SECOND
        ? chatDone(entryId)
        : actionableSandboxNotice(entryId),
    ),
    summary: {
      totalCount: entryIds.length,
      unreadCount: entryIds.length,
      attentionCount: entryIds.length,
    },
    version: FEED_VERSION,
  });
}

function signInAs(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId, userName: "U", email: `${userId}@example.com` },
      { userId, username: "U" },
      [],
    );
}

function answerHostRequest(method: string): Promise<unknown> {
  if (method === "host.notifications.list") {
    return Promise.resolve({ entries: [], nextCursor: null });
  }
  if (method.startsWith("host.notifications.cloudFeed.")) {
    return Promise.resolve({ status: "applied", version: FEED_VERSION + 1 });
  }
  return Promise.resolve({});
}

function bindHostClient(): void {
  const hostClient: StubHostClient = {
    request: hostRequestMock,
    getActiveHostId: () => mockLocalHostEntry.hostId,
    createRequesterForHostId: () => hostClient,
    requestWithSignalRequiringHostMethodVersion: (method, params) =>
      hostRequestMock(method, params),
  };
  hostBindingState.current = { hostClient };
}

interface Subject {
  readonly queryClient: QueryClient;
  readonly rerender: () => void;
  readonly current: () => {
    readonly actions: MergedNotificationsActions;
    readonly row: MergedNotificationRow;
  };
}

function createQueryClient(mutationCache: MutationCache): QueryClient {
  return new QueryClient({
    mutationCache,
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderSubject(feedId: string): Subject {
  return renderSubjectWith(feedId, createQueryClient(new MutationCache()));
}

function renderSubjectWith(feedId: string, queryClient: QueryClient): Subject {
  const { result, rerender } = renderHook(
    () => ({
      actions: useMergedNotificationsActions(),
      row: useMergedNotificationRow(feedId),
    }),
    {
      wrapper: function Wrapper(props: {
        readonly children: ReactNode;
      }): ReactNode {
        return (
          <QueryClientProvider client={queryClient}>
            <NotificationFeedModeContext.Provider
              value={publishedFeedMode.value}
            >
              {props.children}
            </NotificationFeedModeContext.Provider>
          </QueryClientProvider>
        );
      },
    },
  );
  return {
    queryClient,
    rerender,
    current: () => {
      const { actions, row } = result.current;
      if (row === null) throw new Error("expected the cloud row");
      return { actions, row };
    },
  };
}

function cloudMutationCount(queryClient: QueryClient): number {
  return CLOUD_MUTATION_KEYS.reduce(
    (count, mutationKey) =>
      count + queryClient.getMutationCache().findAll({ mutationKey }).length,
    0,
  );
}

/** A refused gesture starts no cloud mutation and writes nothing to the feed. */
function expectNoCloudDispatch(subject: Subject): void {
  expect(cloudMutationCount(subject.queryClient)).toBe(0);
  for (const write of Object.values(localWrites)) {
    expect(write).not.toHaveBeenCalled();
  }
}

interface DispatchCase {
  readonly name: string;
  readonly kind: "per-entry" | "bulk";
  readonly feedId: string;
  readonly invoke: (
    actions: MergedNotificationsActions,
    row: MergedNotificationRow,
  ) => void;
  readonly rpcMethod: string;
  readonly rpcParams: unknown;
  readonly localWrite: LocalWriteName | null;
  /** Cloud mutations one gesture registers: a retirement resolves and clears. */
  readonly cloudMutations: number;
}

const DISPATCH_CASES: ReadonlyArray<DispatchCase> = [
  {
    name: "retireNotice",
    kind: "per-entry",
    feedId: cloudNotificationFeedId(NOTICE_ID),
    invoke: (actions, row) => {
      actions.retireNotice(row);
    },
    rpcMethod: "host.notifications.cloudFeed.resolve",
    rpcParams: { entryId: NOTICE_ID },
    localWrite: "resolveNoticeLocally",
    cloudMutations: 2,
  },
  {
    name: "markAsRead",
    kind: "per-entry",
    feedId: cloudNotificationFeedId(NOTICE_ID),
    invoke: (actions, row) => {
      actions.markAsRead(row);
    },
    rpcMethod: "host.notifications.cloudFeed.markRead",
    rpcParams: { entryId: NOTICE_ID },
    localWrite: "markReadLocally",
    cloudMutations: 1,
  },
  {
    name: "clear",
    kind: "per-entry",
    feedId: cloudNotificationFeedId(NOTICE_ID),
    invoke: (actions, row) => {
      actions.clear(row);
    },
    rpcMethod: "host.notifications.cloudFeed.clear",
    rpcParams: { entryId: NOTICE_ID },
    localWrite: null,
    cloudMutations: 1,
  },
  {
    name: "markEntityAsRead",
    kind: "per-entry",
    feedId: cloudNotificationFeedId(CHAT_ID),
    invoke: (actions) => {
      actions.markEntityAsRead(null, { epicId: "epic-1", chatId: "chat-1" });
    },
    rpcMethod: "host.notifications.cloudFeed.markRead",
    rpcParams: { entryId: CHAT_ID },
    localWrite: "beginEntityRead",
    cloudMutations: 1,
  },
  {
    name: "markAllAsRead",
    kind: "bulk",
    feedId: cloudNotificationFeedId(NOTICE_ID),
    invoke: (actions) => {
      actions.markAllAsRead();
    },
    rpcMethod: "host.notifications.cloudFeed.markAllRead",
    rpcParams: { observedVersion: FEED_VERSION },
    localWrite: "markAllReadLocally",
    cloudMutations: 1,
  },
  {
    name: "clearAll",
    kind: "bulk",
    feedId: cloudNotificationFeedId(NOTICE_ID),
    invoke: (actions) => {
      actions.clearAll();
    },
    rpcMethod: "host.notifications.cloudFeed.clearAll",
    rpcParams: { observedVersion: FEED_VERSION },
    localWrite: null,
    cloudMutations: 1,
  },
];

describe("useMergedNotificationsActions cloud dispatch fence", () => {
  beforeEach(() => {
    hostRequestMock.mockReset();
    hostRequestMock.mockImplementation(answerHostRequest);
    for (const write of Object.values(localWrites)) write.mockClear();
    publishedFeedMode.value = "cloud";
    bindHostClient();
    signInAs("user-a");
    resetCloudEntityReadDriver();
    useCloudNotificationsStore.getState().reset();
    useCloudNotificationsStore.setState(localWrites);
    applyCloudFeed([NOTICE_ID, CHAT_ID], "user-a");
  });

  afterEach(() => {
    cleanup();
    hostBindingState.current = null;
    useAuthStore.getState().setSignedOut();
    resetCloudEntityReadDriver();
    useCloudNotificationsStore.getState().reset();
    useCloudNotificationsStore.setState(realStoreActions);
  });

  describe.each(DISPATCH_CASES)("$name", (dispatchCase) => {
    it("dispatches from a current cloud session", async () => {
      const subject = renderSubject(dispatchCase.feedId);
      const { actions, row } = subject.current();

      act(() => {
        dispatchCase.invoke(actions, row);
      });

      await waitFor(() => {
        expect(hostRequestMock).toHaveBeenCalledWith(
          dispatchCase.rpcMethod,
          dispatchCase.rpcParams,
        );
      });
      if (dispatchCase.localWrite !== null) {
        expect(localWrites[dispatchCase.localWrite]).toHaveBeenCalled();
      }
      await waitFor(() => {
        expect(subject.queryClient.isMutating()).toBe(0);
      });
    });

    it("refuses a retained callback after the cloud session is reset", () => {
      const subject = renderSubject(dispatchCase.feedId);
      const { actions, row } = subject.current();

      act(() => {
        useCloudNotificationsStore.getState().reset();
      });
      act(() => {
        dispatchCase.invoke(actions, row);
      });

      expectNoCloudDispatch(subject);
    });

    it("refuses a retained callback in a replacement session that lacks the entry", () => {
      const subject = renderSubject(dispatchCase.feedId);
      const { actions, row } = subject.current();

      act(() => {
        useCloudNotificationsStore.getState().reset();
        applyCloudFeed([OTHER_ID], "user-a");
      });
      act(() => {
        dispatchCase.invoke(actions, row);
      });

      expectNoCloudDispatch(subject);
    });

    it("refuses a retained callback once the live mode is local", () => {
      const subject = renderSubject(dispatchCase.feedId);
      const { actions, row } = subject.current();

      publishedFeedMode.value = "local";
      act(() => {
        subject.rerender();
      });
      act(() => {
        dispatchCase.invoke(actions, row);
      });

      expectNoCloudDispatch(subject);
    });

    if (dispatchCase.kind === "per-entry") {
      it("allows a replacement session that replays the same entry id", async () => {
        const subject = renderSubject(dispatchCase.feedId);
        const { actions, row } = subject.current();

        act(() => {
          useCloudNotificationsStore.getState().reset();
          applyCloudFeed([NOTICE_ID, CHAT_ID], "user-a");
        });
        act(() => {
          dispatchCase.invoke(actions, row);
        });

        await waitFor(() => {
          expect(hostRequestMock).toHaveBeenCalledWith(
            dispatchCase.rpcMethod,
            dispatchCase.rpcParams,
          );
        });
        await waitFor(() => {
          expect(subject.queryClient.isMutating()).toBe(0);
        });
      });
    } else {
      it("refuses a replacement session that reuses the observed version", () => {
        const subject = renderSubject(dispatchCase.feedId);
        const { actions, row } = subject.current();

        act(() => {
          useCloudNotificationsStore.getState().reset();
          applyCloudFeed([NOTICE_ID, CHAT_ID], "user-a");
        });
        act(() => {
          dispatchCase.invoke(actions, row);
        });

        expectNoCloudDispatch(subject);
      });
    }

    if (dispatchCase.kind === "per-entry") {
      it("refuses A's retained gesture after B's complete feed replacement", () => {
        const subject = renderSubject(dispatchCase.feedId);
        const { actions, row } = subject.current();
        act(() => {
          signInAs("user-b");
          useCloudNotificationsStore.getState().reset();
          applyCloudFeed([NOTICE_ID, CHAT_ID], "user-b");
        });
        act(() => dispatchCase.invoke(actions, row));
        expectNoCloudDispatch(subject);
        expect(hostRequestMock).not.toHaveBeenCalled();
      });

      it("allows B's own gesture after B's complete feed replacement", async () => {
        const subject = renderSubject(dispatchCase.feedId);
        act(() => {
          signInAs("user-b");
          useCloudNotificationsStore.getState().reset();
          applyCloudFeed([NOTICE_ID, CHAT_ID], "user-b");
        });
        const { actions, row } = subject.current();
        act(() => dispatchCase.invoke(actions, row));
        await waitFor(() => {
          expect(hostRequestMock).toHaveBeenCalledWith(
            dispatchCase.rpcMethod,
            dispatchCase.rpcParams,
          );
        });
        await waitFor(() => expect(subject.queryClient.isMutating()).toBe(0));
      });
    }

    // The switch lands before any session reset, so account A's rows are still
    // in the store and membership alone cannot tell them from account B's.
    it("refuses a retained callback after the account changes with the rows still held", () => {
      const subject = renderSubject(dispatchCase.feedId);
      const { actions, row } = subject.current();

      act(() => {
        signInAs("user-b");
      });
      act(() => {
        dispatchCase.invoke(actions, row);
      });

      expectNoCloudDispatch(subject);
    });

    it("refuses a freshly rendered callback after the account changes with the rows still held", () => {
      act(() => {
        signInAs("user-b");
      });
      const subject = renderSubject(dispatchCase.feedId);
      const { actions, row } = subject.current();
      act(() => {
        dispatchCase.invoke(actions, row);
      });

      expectNoCloudDispatch(subject);
    });
  });
  describe("entity-read retry", () => {
    const entity = { epicId: "epic-1", chatId: "chat-1" };

    /** Settles when the cloud store first satisfies `predicate`. A store
     * subscription rather than `waitFor`, which polls on timers the retry
     * tests fake. */
    function storeReaches(
      predicate: (state: CloudNotificationsState) => boolean,
    ): Promise<void> {
      return new Promise((resolve) => {
        if (predicate(useCloudNotificationsStore.getState())) {
          resolve();
          return;
        }
        const unsubscribe = useCloudNotificationsStore.subscribe((state) => {
          if (predicate(state)) {
            unsubscribe();
            resolve();
          }
        });
      });
    }

    /** The first markRead fails, so the real driver parks the entry and arms
     * its backoff timer; every later one is accepted. `retried` settles when
     * the second one reaches the wire. */
    function failFirstMarkRead(): { readonly retried: Promise<void> } {
      let markReadCalls = 0;
      let markRetried: () => void = () => undefined;
      const retried = new Promise<void>((resolve) => {
        markRetried = resolve;
      });
      hostRequestMock.mockImplementation((method) => {
        if (method === "host.notifications.cloudFeed.markRead") {
          markReadCalls += 1;
          if (markReadCalls === 1) {
            return Promise.reject(new Error("relay unavailable"));
          }
          markRetried();
        }
        return answerHostRequest(method);
      });
      return { retried };
    }

    function markReadCallCount(): number {
      return hostRequestMock.mock.calls.filter(
        (call) => call[0] === "host.notifications.cloudFeed.markRead",
      ).length;
    }

    /** Resolves once the failure is recorded, which is also when the driver
     * arms its backoff timer. An in-flight claim sits in `entityReadRetries`
     * too, with an infinite `nextEligibleAt`; only a failure is finite. */
    async function parkFailedRead(subject: Subject): Promise<void> {
      const { actions } = subject.current();
      const parked = storeReaches((state) => {
        const retry = state.entityReadRetries[CHAT_ID];
        return retry?.attempts === 1 && Number.isFinite(retry.nextEligibleAt);
      });
      act(() => {
        actions.markEntityAsRead(null, entity);
      });
      await parked;
      expect(markReadCallCount()).toBe(1);
    }

    async function fireRetryTimer(): Promise<void> {
      await vi.advanceTimersByTimeAsync(CLOUD_ENTITY_READ_RETRY_MAX_MS);
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a parked read when the session is unchanged", async () => {
      const { retried } = failFirstMarkRead();
      const subject = renderSubject(cloudNotificationFeedId(CHAT_ID));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await parkFailedRead(subject);

      await fireRetryTimer();
      await retried;

      expect(markReadCallCount()).toBe(2);
    });

    it.each([
      {
        name: "the live mode becomes local",
        transition: (subject: Subject): void => {
          publishedFeedMode.value = "local";
          subject.rerender();
        },
      },
      {
        name: "the account changes",
        transition: (): void => {
          signInAs("user-b");
        },
      },
    ])(
      "does not fire a parked read's retry after $name",
      async ({ transition }) => {
        failFirstMarkRead();
        const subject = renderSubject(cloudNotificationFeedId(CHAT_ID));
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        await parkFailedRead(subject);
        act(() => {
          transition(subject);
        });
        localWrites.beginEntityRead.mockClear();
        const callsBefore = markReadCallCount();

        await fireRetryTimer();

        expect(localWrites.beginEntityRead).not.toHaveBeenCalled();
        expect(markReadCallCount()).toBe(callsBefore);
      },
    );
  });

  describe("host pagination", () => {
    beforeEach(() => {
      __resetHostNotificationsStoreForTests();
      useHostNotificationsStore.getState().applySnapshot({
        attention: {
          entries: [],
          nextCursor: {
            kind: "attention",
            tier: "blocking",
            updatedAt: 1,
            id: "page-anchor",
          },
        },
        recent: {
          entries: [],
          nextCursor: {
            kind: "chronological",
            updatedAt: 1,
            id: "page-anchor",
          },
        },
        summary: { unreadCount: 0, attentionCount: 0 },
      });
    });

    afterEach(() => {
      __resetHostNotificationsStoreForTests();
    });

    const PAGINATION_CASES: ReadonlyArray<{
      readonly name: string;
      readonly invoke: (actions: MergedNotificationsActions) => void;
    }> = [
      {
        name: "loadMoreHost",
        invoke: (actions) => {
          actions.loadMoreHost();
        },
      },
      {
        name: "loadMoreAttention",
        invoke: (actions) => {
          actions.loadMoreAttention();
        },
      },
      {
        name: "loadMoreUnreadRecent",
        invoke: (actions) => {
          actions.loadMoreUnreadRecent();
        },
      },
    ];

    describe.each(PAGINATION_CASES)("$name", ({ invoke }) => {
      it("pages from a current session", async () => {
        const subject = renderSubject(cloudNotificationFeedId(NOTICE_ID));
        const { actions } = subject.current();

        act(() => {
          invoke(actions);
        });

        await waitFor(() => {
          expect(hostRequestMock).toHaveBeenCalledWith(
            "host.notifications.list",
            expect.anything(),
          );
        });
        await waitFor(() => {
          expect(subject.queryClient.isMutating()).toBe(0);
        });
      });

      it("refuses a retained callback after the live mode is local", () => {
        const subject = renderSubject(cloudNotificationFeedId(NOTICE_ID));
        const { actions } = subject.current();

        publishedFeedMode.value = "local";
        act(() => {
          subject.rerender();
        });
        act(() => {
          invoke(actions);
        });

        expect(subject.queryClient.getMutationCache().getAll()).toHaveLength(0);
      });

      it.each([
        {
          name: "the live mode becomes local",
          apply: (subject: Subject): void => {
            publishedFeedMode.value = "local";
            subject.rerender();
          },
        },
        {
          name: "the cloud session is replaced",
          apply: (): void => {
            useCloudNotificationsStore.getState().reset();
            applyCloudFeed([NOTICE_ID, CHAT_ID], "user-a");
          },
        },
      ])(
        "does not send a queued page when $name before the request leaves",
        async ({ apply }) => {
          const subject = renderSubject(cloudNotificationFeedId(NOTICE_ID));
          const { actions } = subject.current();

          act(() => {
            invoke(actions);
            apply(subject);
          });
          expect(subject.queryClient.isMutating()).toBe(1);
          await waitFor(() => {
            expect(subject.queryClient.isMutating()).toBe(0);
          });

          expect(hostRequestMock).not.toHaveBeenCalledWith(
            "host.notifications.list",
            expect.anything(),
          );
        },
      );

      it("refuses a retained callback after the cloud session is replaced", () => {
        const subject = renderSubject(cloudNotificationFeedId(NOTICE_ID));
        const { actions } = subject.current();

        act(() => {
          useCloudNotificationsStore.getState().reset();
          applyCloudFeed([NOTICE_ID, CHAT_ID], "user-a");
        });
        act(() => {
          invoke(actions);
        });

        expect(subject.queryClient.getMutationCache().getAll()).toHaveLength(0);
      });
    });
  });
  describe("bulk fallback to per-entry marks", () => {
    it("does not mark entries in a replacement session when its first mark is queued behind a replacement", async () => {
      // The primary mark-all is answered `unsupported`, so the fallback marks
      // entry by entry. The cache-level hook gates only those per-entry marks
      // and holds the first one before its own onMutate runs, which is the gap
      // between the fallback's liveness check and the request leaving.
      hostRequestMock.mockImplementation((method) =>
        method === "host.notifications.cloudFeed.markAllRead"
          ? Promise.resolve({ status: "unsupported" })
          : answerHostRequest(method),
      );
      let markEntered: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      let releaseMark: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        releaseMark = resolve;
      });
      const markReadKey = notificationsMutationKeys.cloudMarkRead();
      const subject = renderSubjectWith(
        cloudNotificationFeedId(NOTICE_ID),
        createQueryClient(
          new MutationCache({
            onMutate: async (_variables, mutation) => {
              if (mutation.options.mutationKey?.[0] !== markReadKey[0]) return;
              markEntered();
              await released;
            },
          }),
        ),
      );
      const { actions } = subject.current();

      act(() => {
        actions.markAllAsRead();
      });
      await entered;
      act(() => {
        useCloudNotificationsStore.getState().reset();
        applyCloudFeed([NOTICE_ID, CHAT_ID], "user-a");
      });
      releaseMark();
      await waitFor(() => {
        expect(subject.queryClient.isMutating()).toBe(0);
      });

      expect(hostRequestMock).not.toHaveBeenCalledWith(
        "host.notifications.cloudFeed.markRead",
        expect.anything(),
      );
      expect(useCloudNotificationsStore.getState().connectionState).toBe(
        "connected",
      );
    });
  });

  describe("completion context", () => {
    it("completes a request in the replacement session that replayed its entry while the request was being prepared", async () => {
      const queryClient = createQueryClient(new MutationCache());
      const resolveKey = notificationsMutationKeys.cloudResolve();
      let replaced = false;
      // The mutation's own onMutate result lands in a second `pending` event;
      // the first carries no context. Replacing the session synchronously in
      // that event puts the swap after the context exists and before the
      // request leaves.
      const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
        if (
          replaced ||
          event.type !== "updated" ||
          event.action.type !== "pending" ||
          event.mutation.options.mutationKey?.[0] !== resolveKey[0] ||
          event.mutation.state.context === undefined
        ) {
          return;
        }
        replaced = true;
        useCloudNotificationsStore.getState().reset();
        applyCloudFeed([NOTICE_ID, CHAT_ID], "user-a");
        for (const write of Object.values(localWrites)) write.mockClear();
      });
      const subject = renderSubjectWith(
        cloudNotificationFeedId(NOTICE_ID),
        queryClient,
      );
      const { actions, row } = subject.current();

      act(() => {
        actions.retireNotice(row);
      });
      await waitFor(() => {
        expect(replaced).toBe(true);
      });
      await waitFor(() => {
        expect(queryClient.isMutating()).toBe(0);
      });
      unsubscribe();

      expect(
        hostRequestMock.mock.calls.filter(
          (call) => call[0] === "host.notifications.cloudFeed.resolve",
        ),
      ).toEqual([
        ["host.notifications.cloudFeed.resolve", { entryId: NOTICE_ID }],
      ]);
      const resolved =
        useCloudNotificationsStore.getState().rows[
          cloudNotificationFeedId(NOTICE_ID)
        ];
      const entry = resolved?.entry;
      if (entry?.kind !== "sandbox.notice") {
        throw new Error("expected the replacement session's notice");
      }
      expect(entry.readAt).toBeTypeOf("number");
      expect(entry.resolvedAt).toBeTypeOf("number");
    });
  });

  describe("entity read expansion", () => {
    it("stops after the first row when the session is replaced mid-expansion", async () => {
      useCloudNotificationsStore.getState().reset();
      applyCloudFeed([NOTICE_ID, CHAT_ID, CHAT_ID_SECOND], "user-a");
      let firstStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      let completeFirst: () => void = () => undefined;
      const firstAnswer = new Promise<unknown>((resolve) => {
        completeFirst = () => {
          resolve({ status: "applied", version: FEED_VERSION + 1 });
        };
      });
      hostRequestMock.mockImplementation((method, params) => {
        if (
          method === "host.notifications.cloudFeed.markRead" &&
          typeof params === "object" &&
          params !== null &&
          "entryId" in params &&
          params.entryId === CHAT_ID
        ) {
          firstStarted();
          return firstAnswer;
        }
        return answerHostRequest(method);
      });
      const subject = renderSubject(cloudNotificationFeedId(CHAT_ID));
      const { actions } = subject.current();

      act(() => {
        actions.markEntityAsRead(null, { epicId: "epic-1", chatId: "chat-1" });
      });
      await started;
      act(() => {
        useCloudNotificationsStore.getState().reset();
        applyCloudFeed([NOTICE_ID, CHAT_ID, CHAT_ID_SECOND], "user-a");
      });
      for (const write of Object.values(localWrites)) write.mockClear();
      completeFirst();
      await waitFor(() => {
        expect(subject.queryClient.isMutating()).toBe(0);
      });

      expect(
        hostRequestMock.mock.calls.filter(
          (call) => call[0] === "host.notifications.cloudFeed.markRead",
        ),
      ).toHaveLength(1);
      expect(localWrites.beginEntityRead).not.toHaveBeenCalled();
      const state = useCloudNotificationsStore.getState();
      expect(state.connectionState).toBe("connected");
      expect(
        state.rows[cloudNotificationFeedId(CHAT_ID)]?.entry.readAt,
      ).toBeNull();
      expect(
        state.rows[cloudNotificationFeedId(CHAT_ID_SECOND)]?.entry.readAt,
      ).toBeNull();
    });
  });

  describe("queued bulk host legs", () => {
    const BULK_HOST_LEGS = [
      {
        name: "markAllAsRead",
        method: "host.notifications.markAllRead",
        invoke: (actions: MergedNotificationsActions): void => {
          actions.markAllAsRead();
        },
      },
      {
        name: "clearAll",
        method: "host.notifications.clearAll",
        invoke: (actions: MergedNotificationsActions): void => {
          actions.clearAll();
        },
      },
    ];
    const TRANSITIONS = [
      {
        name: "the live mode becomes local",
        apply: (subject: Subject): void => {
          publishedFeedMode.value = "local";
          subject.rerender();
        },
      },
      {
        name: "the cloud session is replaced",
        apply: (): void => {
          useCloudNotificationsStore.getState().reset();
          applyCloudFeed([NOTICE_ID, CHAT_ID], "user-a");
        },
      },
    ];

    describe.each(BULK_HOST_LEGS)("$name", (leg) => {
      it.each(TRANSITIONS)(
        "does not send the host leg when $name before the request leaves",
        async (transition) => {
          const subject = renderSubject(cloudNotificationFeedId(NOTICE_ID));
          const { actions } = subject.current();

          act(() => {
            leg.invoke(actions);
            transition.apply(subject);
          });
          await waitFor(() => {
            expect(subject.queryClient.isMutating()).toBe(0);
          });

          expect(hostRequestMock).not.toHaveBeenCalledWith(
            leg.method,
            expect.anything(),
          );
        },
      );
    });
  });

  describe("queued before the transition", () => {
    interface QueuedTransition {
      readonly name: string;
      readonly perEntryReplayAllowed: boolean;
      readonly apply: (subject: Subject) => void;
    }

    const QUEUED_TRANSITIONS: ReadonlyArray<QueuedTransition> = [
      {
        name: "the session is replaced without the entry",
        perEntryReplayAllowed: false,
        apply: () => {
          useCloudNotificationsStore.getState().reset();
          applyCloudFeed([OTHER_ID], "user-a");
        },
      },
      {
        name: "the same account's replacement replays the entry",
        perEntryReplayAllowed: true,
        apply: () => {
          useCloudNotificationsStore.getState().reset();
          applyCloudFeed([NOTICE_ID, CHAT_ID], "user-a");
        },
      },
      {
        name: "the account changes",
        perEntryReplayAllowed: false,
        apply: () => {
          signInAs("user-b");
        },
      },
      {
        name: "B's complete feed replaces A's queued gesture",
        perEntryReplayAllowed: false,
        apply: () => {
          signInAs("user-b");
          useCloudNotificationsStore.getState().reset();
          applyCloudFeed([NOTICE_ID, CHAT_ID], "user-b");
        },
      },
      {
        name: "the live mode becomes local",
        perEntryReplayAllowed: false,
        apply: (subject) => {
          publishedFeedMode.value = "local";
          subject.rerender();
        },
      },
    ];

    describe.each(DISPATCH_CASES)("$name", (dispatchCase) => {
      it.each(QUEUED_TRANSITIONS)(
        "settles correctly when $name before the request leaves",
        async (transition) => {
          const subject = renderSubject(dispatchCase.feedId);
          const { actions, row } = subject.current();

          // The gesture is authorized and its mutation registered; the
          // transition lands before the queued mutation reaches the wire.
          act(() => {
            dispatchCase.invoke(actions, row);
            transition.apply(subject);
          });
          expect(cloudMutationCount(subject.queryClient)).toBe(
            dispatchCase.cloudMutations,
          );

          // An entity read fixes its feed when the gesture starts, so one
          // queued across a replacement is refused like a bulk gesture.
          const replayAllowed =
            dispatchCase.kind === "per-entry" &&
            dispatchCase.name !== "markEntityAsRead" &&
            transition.perEntryReplayAllowed;
          if (replayAllowed) {
            await waitFor(() => {
              expect(hostRequestMock).toHaveBeenCalledWith(
                dispatchCase.rpcMethod,
                dispatchCase.rpcParams,
              );
            });
          }
          await waitFor(() => {
            expect(subject.queryClient.isMutating()).toBe(0);
          });

          if (!replayAllowed) {
            expect(hostRequestMock).not.toHaveBeenCalledWith(
              dispatchCase.rpcMethod,
              expect.anything(),
            );
          }
          expect(useCloudNotificationsStore.getState().connectionState).toBe(
            "connected",
          );
        },
      );
    });
  });
});
