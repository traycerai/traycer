import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  poolEntry,
  remoteEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
import {
  listTasksRequestSchema,
  type ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HistorySearchState } from "@/lib/history-search";
import { parseHistorySearch } from "@/lib/history-search";
import { Route as EpicsIndexRoute } from "@/routes/epics/index";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { cloudEpicTasksPageIdentity } from "@/stores/epics/cloud-epic-tasks-pages-store";
import { useCloudEpicTasksPagesStore } from "@/stores/epics/cloud-epic-tasks-pages-store";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { taskLight } from "@/lib/view-replica/__tests__/replica-fixtures";
import { LIST_CLOUD_TASKS_REQUEST } from "@/lib/cloud-epic-tasks-query";
import {
  __resetCloudEpicTasksClientsForTests,
  getCloudEpicTasksClient,
} from "@/lib/cloud-epic-tasks-query/client-registry";
import { queryClient as appQueryClient } from "@/lib/query-client";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";

const clientRef = vi.hoisted(() => ({
  current: null as HostClient<typeof hostRpcRegistry> | null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (clientRef.current === null) {
        throw new Error("host client fixture is not installed");
      }
      return clientRef.current;
    },
  };
});

const USER_ID = "history-peer-user";
const TEAM_HOST_ID = "history-team-computer";
const PERSONAL_HOST_ID = "history-personal-computer";
const emptyLocalHistory: LocalHistoryReadResponse = {
  complete: true,
  willComplete: true,
  localHomeRows: [],
  preservedRows: [],
  tombstonedEpicIds: [],
  localRows: "none",
};

const personalHost: HostDirectoryEntry = {
  ...remoteEntry(PERSONAL_HOST_ID, null),
  version: "99.0.0",
  owner: { kind: "user", id: USER_ID },
};
const teamHost: HostDirectoryEntry = {
  ...personalHost,
  hostId: TEAM_HOST_ID,
  owner: { kind: "team", id: "team-1", name: "Team" },
};

function setServingPeer(
  peer:
    | { readonly kind: "pool" }
    | { readonly kind: "computer"; readonly hostId: string },
): void {
  const hostId = peer.kind === "computer" ? peer.hostId : null;
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    servingPeer: peer,
    noPeerPresentation: null,
    leases: [],
    selectionRevision: 1,
  });
}

function makeWrapper(
  queryClient: QueryClient,
  binding: HostRuntimeBinding<typeof hostRpcRegistry>,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(
      HostRuntimeContext.Provider,
      { value: binding },
      createElement(QueryClientProvider, { client: queryClient }, children),
    );
}

function makeBinding(
  client: HostClient<typeof hostRpcRegistry>,
): HostRuntimeBinding<typeof hostRpcRegistry> {
  return Object.assign(Object.create(null), {
    hostClient: client,
  }) as HostRuntimeBinding<typeof hostRpcRegistry>;
}

function invokeHistoryLoader(
  queryClient: QueryClient,
  client: HostClient<typeof hostRpcRegistry>,
  hostId: string,
): void {
  const loader = EpicsIndexRoute.options.loader as (args: {
    readonly context: {
      readonly getHostClient: () => HostClient<typeof hostRpcRegistry>;
      readonly getAuthSnapshot: () => AuthState;
      readonly queryClient: QueryClient;
    };
    readonly deps: { readonly historySearch: HistorySearchState };
  }) => unknown;
  loader({
    context: {
      getHostClient: () => client.createRequesterForHostId(hostId),
      getAuthSnapshot: () => useAuthStore.getState(),
      queryClient,
    },
    deps: { historySearch: parseHistorySearch({}) },
  });
}

function createClient(
  queryClient: QueryClient,
  messenger: MockHostMessenger<HostRpcRegistry>,
): HostClient<typeof hostRpcRegistry> {
  const hosts = new Map<string, HostDirectoryEntry>([
    [poolEntry.hostId, poolEntry],
    [TEAM_HOST_ID, teamHost],
    [PERSONAL_HOST_ID, personalHost],
  ]);
  const plan = settleProcessHostRpcTierPlan(poolEntry);
  const client = new HostClient({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
    findHostById: (hostId) => hosts.get(hostId) ?? null,
    routing: {
      plan,
      selectedHostId: () => null,
      serving: () =>
        readHostServingDecision((hostId) => hosts.get(hostId) ?? null),
    },
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "test-token",
      identity: {
        userId: USER_ID,
        username: "History user",
        providerHandle: "history-user",
      },
    }),
  );
  return client;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("promise resolver missing");
  return { promise, resolve: resolvePromise };
}

beforeEach(() => {
  settleProcessHostRpcTierPlan(poolEntry);
  appQueryClient.clear();
  resetNegotiatedManifests();
  useSelectionAuthorityStore.getState().reset();
  clientRef.current = null;
  useAuthStore.getState().setSignedIn(
    {
      userId: USER_ID,
      userName: "History user",
      email: "history@example.com",
    },
    { userId: USER_ID, username: "history-user" },
    [],
  );
});

afterEach(() => {
  cleanup();
  clientRef.current?.dispose();
  clientRef.current = null;
  useSelectionAuthorityStore.getState().reset();
  useAuthStore.getState().setSignedOut();
  resetNegotiatedManifests();
  __resetCloudEpicTasksClientsForTests();
  appQueryClient.clear();
});

describe("History routes its loader, hook, and retained pages through one answering peer", () => {
  it("uses one pool first-page request for the actual route loader and mounted History hook", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-loader-request",
      handlers: {
        "epic.listTasks": () => ({
          tasks: [taskLight("pool-page", null)],
          hasMore: false,
        }),
        "epic.localHistory.read": () => emptyLocalHistory,
      },
    });
    const client = createClient(queryClient, messenger);
    clientRef.current = client;
    const binding = makeBinding(client);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    setServingPeer({ kind: "computer", hostId: TEAM_HOST_ID });

    invokeHistoryLoader(queryClient, client, TEAM_HOST_ID);
    await waitFor(() => {
      expect(
        messenger.calls.filter((call) => call.method === "epic.listTasks"),
      ).toHaveLength(1);
    });
    expect(getCloudEpicTasksClient(POOL_HOST_ID)).not.toBeNull();
    expect(getCloudEpicTasksClient(TEAM_HOST_ID)).toBeNull();
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.listTasks")
        .map((call) => call.authority.endpoint.hostId),
    ).toEqual([POOL_HOST_ID]);

    const rendered = renderHook(
      () => useCloudEpicTasksQuery(undefined, { enabled: true }),
      { wrapper: makeWrapper(queryClient, binding) },
    );
    await waitFor(() => {
      expect(rendered.result.current.query.isSuccess).toBe(true);
    });
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.listTasks")
        .map((call) => call.authority.endpoint.hostId),
    ).toEqual([POOL_HOST_ID]);
  });

  it("ends Select All when a pool cursor is pending as the serving computer changes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const poolCursor = deferred<ListTasksResponse>();
    const poolCursorStarted = deferred<void>();
    let firstPageCount = 0;
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-select-all-request",
      handlers: {
        "epic.listTasks": (params) => {
          if (params.cursor === "pool-cursor") {
            poolCursorStarted.resolve();
            return poolCursor.promise;
          }
          if (params.cursor !== undefined) {
            return {
              tasks: [taskLight("crossed-peer-tail", null)],
              hasMore: false,
            };
          }
          firstPageCount += 1;
          return firstPageCount === 1
            ? {
                tasks: [taskLight("pool-first", null)],
                hasMore: true,
                nextCursor: "pool-cursor",
              }
            : { tasks: [taskLight("computer-first", null)], hasMore: false };
        },
        "epic.localHistory.read": () => emptyLocalHistory,
      },
    });
    const client = createClient(queryClient, messenger);
    clientRef.current = client;
    const binding = makeBinding(client);
    recordNegotiatedHostManifest(PERSONAL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    setServingPeer({ kind: "pool" });

    const rendered = renderHook(
      () => useCloudEpicTasksQuery(undefined, { enabled: true }),
      { wrapper: makeWrapper(queryClient, binding) },
    );
    await waitFor(() => {
      expect(rendered.result.current.hasNextPage).toBe(true);
      expect(rendered.result.current.query.isFetching).toBe(false);
    });
    const poolIdentity = cloudEpicTasksPageIdentity(
      POOL_HOST_ID,
      USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    );
    const allPages = rendered.result.current.fetchAllPages(
      new AbortController().signal,
    );
    await act(async () => poolCursorStarted.promise);
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.listTasks")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          cursor: listTasksRequestSchema.parse(call.params).cursor,
        })),
    ).toEqual([
      { hostId: POOL_HOST_ID, cursor: undefined },
      { hostId: POOL_HOST_ID, cursor: "pool-cursor" },
    ]);

    act(() => setServingPeer({ kind: "computer", hostId: PERSONAL_HOST_ID }));
    await waitFor(() => {
      expect(
        messenger.calls.filter(
          (call) =>
            call.method === "epic.listTasks" &&
            call.authority.endpoint.hostId === PERSONAL_HOST_ID &&
            listTasksRequestSchema.parse(call.params).cursor === undefined,
        ),
      ).toHaveLength(1);
    });
    await act(async () => {
      poolCursor.resolve({
        tasks: [taskLight("pool-cursor-tail", null)],
        hasMore: true,
        nextCursor: "pool-next-cursor",
      });
      await allPages;
    });

    const cursorRequests = messenger.calls
      .filter(
        (call) =>
          call.method === "epic.listTasks" &&
          listTasksRequestSchema.parse(call.params).cursor !== undefined,
      )
      .map((call) => ({
        hostId: call.authority.endpoint.hostId,
        cursor: listTasksRequestSchema.parse(call.params).cursor,
      }));
    expect({
      cursorRequests,
      poolPages:
        useCloudEpicTasksPagesStore.getState().pagesByIdentity[poolIdentity] ??
        [],
      allPagesResolved: await allPages,
    }).toEqual({
      cursorRequests: [{ hostId: POOL_HOST_ID, cursor: "pool-cursor" }],
      poolPages: [],
      allPagesResolved: null,
    });
  });
});
