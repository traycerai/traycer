import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
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
  setEpicPinnedRequestSchema,
  type BatchDeleteResponse,
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
import { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
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
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EPIC_DELETE_HOST_UNREACHABLE_MESSAGE,
  useEpicBatchDelete,
  type BatchDeleteEpicVariables,
} from "@/hooks/epic/use-epic-batch-delete-mutation";
import { toast } from "sonner";

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

vi.mock("@/lib/host/use-worktree-delete-stream-transport", () => ({
  useWorktreeDeleteStreamTransportFactory: () => () => {
    throw new Error("unexpected worktree cleanup in History routing test");
  },
}));

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

class HistoryRunnerHost extends MockRunnerHost {
  override readonly poolBaseUrl = poolEntry.websocketUrl ?? "";
}

const bindings: Array<HostRuntimeBinding<typeof hostRpcRegistry>> = [];

async function makeBinding(
  queryClient: QueryClient,
  messenger: MockHostMessenger<HostRpcRegistry>,
): Promise<HostRuntimeBinding<typeof hostRpcRegistry>> {
  const runnerHost = new HistoryRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [teamHost, personalHost],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: false,
    traycerCli: undefined,
  });
  const auth = new AuthService({ runnerHost });
  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () =>
      Promise.resolve({
        kind: "hosts",
        entries: [teamHost, personalHost],
      }),
    onRegistryPollTick: null,
    authContextId: null,
    credentialGeneration: null,
    localHostIdSeeder: null,
  });
  await directory.start();
  const runtime = new HostRuntime<HostRpcRegistry>({
    runnerHost,
    onHostTokenRenewal: () => {},
    registry: hostRpcRegistry,
    messenger,
    singleAttemptMessenger: null,
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(queryClient),
    schedulingPolicy: hostRpcSchedulingPolicy,
    connectionRegistry: null,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => useSelectionAuthorityStore.getState().effectiveHostId,
    servingDecision: () =>
      readHostServingDecision((hostId) => directory.findById(hostId)),
  });
  runtime.start();
  runtime.hostClient.setRequestContext(
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
  const binding: HostRuntimeBinding<typeof hostRpcRegistry> = {
    runtime,
    hostClient: runtime.hostClient,
    directory,
    auth,
    hostId: null,
  };
  bindings.push(binding);
  return binding;
}

function historyTaskLight(
  id: string,
  teamId: string | null,
  home: "cloud" | "local",
): ListTasksResponse["tasks"][number] {
  const task = taskLight(id, teamId);
  const epic = task.epic;
  if (epic?.light === null || epic?.light === undefined)
    throw new Error("A History fixture needs an Epic");
  return {
    ...task,
    home,
    epic: {
      ...epic,
      light: { ...epic.light, createdBy: USER_ID },
    },
  };
}

function renderHistoryPanel(
  queryClient: QueryClient,
  binding: HostRuntimeBinding<typeof hostRpcRegistry>,
): void {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <EpicsListPanel
        scope="all"
        onScopeChange={() => {}}
        variant="page"
        className={undefined}
        onSelectEpic={null}
        onOpenItem={null}
        routeSearch={parseHistorySearch({})}
        historyNowMs={null}
        autoFocusSearch={false}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <HostRuntimeContext.Provider value={binding}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </HostRuntimeContext.Provider>,
  );
}

function HistoryDeleteDispatch(props: {
  readonly variables: BatchDeleteEpicVariables;
  readonly onResult: (response: BatchDeleteResponse) => void;
}): ReactNode {
  const mutation = useEpicBatchDelete();
  return (
    <button
      type="button"
      data-testid="history-delete-dispatch"
      onClick={() => {
        mutation.mutate(props.variables, { onSuccess: props.onResult });
      }}
    >
      Delete
    </button>
  );
}

function renderHistoryDeleteDispatch(
  queryClient: QueryClient,
  binding: HostRuntimeBinding<typeof hostRpcRegistry>,
  variables: BatchDeleteEpicVariables,
  onResult: (response: BatchDeleteResponse) => void,
): void {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <HistoryDeleteDispatch variables={variables} onResult={onResult} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <HostRuntimeContext.Provider value={binding}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </HostRuntimeContext.Provider>,
  );
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

function historyDeleteVariables(input: {
  readonly ids: ReadonlyArray<string>;
  readonly acceptedPeerId: string;
  readonly listPeerId: string;
  readonly homes: ReadonlyArray<readonly [string, "cloud" | "local"]>;
  readonly acceptedHomes?: ReadonlyArray<readonly [string, "cloud" | "local"]>;
  readonly isLocalHomedNow?: (epicId: string) => boolean;
}): BatchDeleteEpicVariables {
  return {
    ids: input.ids,
    isLocalHomedNow: input.isLocalHomedNow ?? (() => false),
    boundUserId: USER_ID,
    history: {
      acceptedPeerId: input.acceptedPeerId,
      listPeerId: input.listPeerId,
      acceptedHomes: new Map(input.acceptedHomes ?? input.homes),
      selectedHomes: new Map(input.homes),
    },
    worktreeCleanup: null,
  };
}

function recordDeleteManifest(...hostIds: ReadonlyArray<string>): void {
  for (const hostId of hostIds)
    recordNegotiatedHostManifest(hostId, {
      "epic.batchDelete": { major: 1, minor: 1 },
    });
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
  vi.restoreAllMocks();
  clientRef.current?.dispose();
  clientRef.current = null;
  for (const binding of bindings.splice(0)) {
    binding.runtime.dispose();
    binding.directory.dispose();
    binding.auth.dispose();
  }
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
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [taskLight("pool-page", null)],
          hasMore: false,
        }),
        "epic.localHistory.read": () => emptyLocalHistory,
      },
    });
    const binding = await makeBinding(queryClient, messenger);
    const client = binding.hostClient;
    clientRef.current = client;
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
    const binding = await makeBinding(queryClient, messenger);
    const client = binding.hostClient;
    clientRef.current = client;
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

  it("pins a pool-listed History row through the pool while a team computer serves the window", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let pinned = false;
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-pool-pin-request",
      handlers: {
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [{ ...taskLight("pool-history-row", null), pinned }],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "none",
            sort: "server",
          },
        }),
        "epic.localHistory.read": () => emptyLocalHistory,
        "epic.setPinned": (params) => {
          expect(params.epicId).toBe("pool-history-row");
          pinned = params.pinned;
          return { pinned: params.pinned, home: "cloud" as const };
        },
      },
    });
    const binding = await makeBinding(queryClient, messenger);
    const client = binding.hostClient;
    clientRef.current = client;
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.setPinned": { major: 1, minor: 1 },
    });
    setServingPeer({ kind: "computer", hostId: TEAM_HOST_ID });
    renderHistoryPanel(queryClient, binding);

    const pin = await screen.findByTestId("epics-list-row-pin");
    fireEvent.click(pin);
    await waitFor(() => expect(pin.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(pin);
    await waitFor(() => expect(pin.getAttribute("aria-pressed")).toBe("false"));
    expect(
      messenger.calls
        .filter((entry) => entry.method === "epic.setPinned")
        .map((entry) => ({
          hostId: entry.authority.endpoint.hostId,
          pinned: setEpicPinnedRequestSchema.parse(entry.params).pinned,
        })),
    ).toEqual([
      { hostId: POOL_HOST_ID, pinned: true },
      { hostId: POOL_HOST_ID, pinned: false },
    ]);
  });

  it("splits a confirmed mixed History selection from the real panel and merges per-item outcomes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const ids = [
      "personal-cloud-row",
      "environment-cloud-row",
      "computer-local-row",
    ];
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-mixed-delete-request",
      handlers: {
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [
            historyTaskLight("personal-cloud-row", null, "cloud"),
            historyTaskLight("environment-cloud-row", "team-1", "cloud"),
          ],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "present",
            sort: "server",
          },
        }),
        "epic.localHistory.read": (): LocalHistoryReadResponse => ({
          ...emptyLocalHistory,
          localHomeRows: [
            historyTaskLight("computer-local-row", null, "local"),
          ],
          localRows: "present",
        }),
        "epic.batchDelete": ({ ids: requestedIds }) => ({
          results: requestedIds.map((taskId) =>
            taskId === "environment-cloud-row"
              ? {
                  taskId,
                  success: false,
                  home: "cloud" as const,
                  errorMessage: "Pool refused this row.",
                }
              : {
                  taskId,
                  success: true,
                  home:
                    taskId === "computer-local-row"
                      ? ("local" as const)
                      : ("cloud" as const),
                },
          ),
        }),
      },
    });
    const binding = await makeBinding(queryClient, messenger);
    const client = binding.hostClient;
    clientRef.current = client;
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    setServingPeer({ kind: "computer", hostId: TEAM_HOST_ID });
    const warning = vi.spyOn(toast, "warning");
    renderHistoryPanel(queryClient, binding);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(3),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    for (const id of ids)
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText("Delete 3 tasks?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() => {
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .find(
            (mutation) =>
              mutation.options.mutationKey?.[0] === "epic.batchDelete",
          )?.state.status,
      ).toBe("success");
      expect(warning).toHaveBeenCalledWith("Deleted 2 of 3; 1 failed.", {
        description: "Pool refused this row.",
      });
    });

    const requests = messenger.calls
      .filter((call) => call.method === "epic.batchDelete")
      .map((call) => ({
        hostId: call.authority.endpoint.hostId,
        ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
      }))
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
    expect(requests).toEqual(
      [
        {
          hostId: POOL_HOST_ID,
          ids: ["personal-cloud-row", "environment-cloud-row"],
        },
        { hostId: TEAM_HOST_ID, ids: ["computer-local-row"] },
      ].sort((left, right) => left.hostId.localeCompare(right.hostId)),
    );
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .find(
          (mutation) =>
            mutation.options.mutationKey?.[0] === "epic.batchDelete",
        )?.state.data,
    ).toEqual({
      results: [
        { taskId: "personal-cloud-row", success: true, home: "cloud" },
        {
          taskId: "environment-cloud-row",
          success: false,
          home: "cloud",
          errorMessage: "Pool refused this row.",
        },
        { taskId: "computer-local-row", success: true, home: "local" },
      ],
    });
  });

  it("drops a mixed confirmation when the serving peer changes and refuses a racing press", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-peer-race-delete-request",
      handlers: {
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [historyTaskLight("racing-cloud-row", null, "cloud")],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "present",
            sort: "server",
          },
        }),
        "epic.localHistory.read": (): LocalHistoryReadResponse => ({
          ...emptyLocalHistory,
          localHomeRows: [historyTaskLight("racing-local-row", null, "local")],
          localRows: "present",
        }),
        "epic.batchDelete": () => ({ results: [] }),
      },
    });
    const binding = await makeBinding(queryClient, messenger);
    const client = binding.hostClient;
    clientRef.current = client;
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    setServingPeer({ kind: "computer", hostId: TEAM_HOST_ID });
    renderHistoryPanel(queryClient, binding);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(2),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select racing-cloud-row" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select racing-local-row" }),
    );
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText("Delete 2 tasks?")).toBeTruthy();

    act(() => {
      setServingPeer({ kind: "computer", hostId: PERSONAL_HOST_ID });
      fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    });

    await waitFor(() =>
      expect(screen.queryByTestId("delete-tasks-dialog")).toBeNull(),
    );
    expect(
      messenger.calls.filter((call) => call.method === "epic.batchDelete"),
    ).toEqual([]);
  });

  it("keeps a pool row's refused item separate from the other pool success", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const variables = historyDeleteVariables({
      ids: ["pool-refused-row", "pool-success-row"],
      acceptedPeerId: POOL_HOST_ID,
      listPeerId: POOL_HOST_ID,
      homes: [
        ["pool-refused-row", "cloud"],
        ["pool-success-row", "cloud"],
      ],
    });
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-pool-partial-delete-request",
      handlers: {
        "epic.batchDelete": ({ ids }) => ({
          results: ids.map((taskId) =>
            taskId === "pool-refused-row"
              ? {
                  taskId,
                  success: false,
                  home: "cloud" as const,
                  errorMessage: "This row is still shared.",
                }
              : { taskId, success: true, home: "cloud" as const },
          ),
        }),
      },
    });
    const binding = await makeBinding(queryClient, messenger);
    const client = binding.hostClient;
    clientRef.current = client;
    recordDeleteManifest(POOL_HOST_ID);
    setServingPeer({ kind: "pool" });
    const outcome = deferred<BatchDeleteResponse>();
    const warning = vi.spyOn(toast, "warning");
    renderHistoryDeleteDispatch(
      queryClient,
      binding,
      variables,
      outcome.resolve,
    );

    fireEvent.click(await screen.findByTestId("history-delete-dispatch"));
    const result = await outcome.promise;

    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        })),
    ).toEqual([
      {
        hostId: POOL_HOST_ID,
        ids: ["pool-refused-row", "pool-success-row"],
      },
    ]);
    expect(result).toEqual({
      results: [
        {
          taskId: "pool-refused-row",
          success: false,
          home: "cloud",
          errorMessage: "This row is still shared.",
        },
        { taskId: "pool-success-row", success: true, home: "cloud" },
      ],
    });
    expect(warning).toHaveBeenCalledWith("Deleted 1 of 2; 1 failed.", {
      description: "This row is still shared.",
    });
  });

  it("sends the full page selection to a personal computer serving its own page", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const ids = ["personal-local-row", "personal-page-cloud-row"];
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-personal-delete-request",
      handlers: {
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [historyTaskLight("personal-page-cloud-row", null, "cloud")],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "present",
            sort: "server",
          },
        }),
        "epic.localHistory.read": (): LocalHistoryReadResponse => ({
          ...emptyLocalHistory,
          localHomeRows: [
            historyTaskLight("personal-local-row", null, "local"),
          ],
          localRows: "present",
        }),
        "epic.batchDelete": ({ ids: requestedIds }) => ({
          results: requestedIds.map((taskId) => ({
            taskId,
            success: true,
            home:
              taskId === "personal-local-row"
                ? ("local" as const)
                : ("cloud" as const),
          })),
        }),
      },
    });
    const binding = await makeBinding(queryClient, messenger);
    const client = binding.hostClient;
    clientRef.current = client;
    recordNegotiatedHostManifest(PERSONAL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    setServingPeer({ kind: "computer", hostId: PERSONAL_HOST_ID });
    renderHistoryPanel(queryClient, binding);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(2),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    for (const id of ids)
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    fireEvent.click(await screen.findByTestId("delete-tasks-confirm"));
    await waitFor(() => {
      const mutation = queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
      expect(mutation?.state.data).toEqual({
        results: [
          { taskId: "personal-local-row", success: true, home: "local" },
          { taskId: "personal-page-cloud-row", success: true, home: "cloud" },
        ],
      });
    });

    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        })),
    ).toEqual([{ hostId: PERSONAL_HOST_ID, ids }]);
  });

  it("sends accepted cloud homes to the pool and refuses computer-only homes after History switches to the pool", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const variables = historyDeleteVariables({
      ids: ["accepted-cloud-row", "accepted-local-row"],
      acceptedPeerId: TEAM_HOST_ID,
      listPeerId: POOL_HOST_ID,
      homes: [
        ["accepted-cloud-row", "cloud"],
        ["accepted-local-row", "local"],
      ],
      isLocalHomedNow: (epicId) => epicId === "accepted-local-row",
    });
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-remembered-home-delete-request",
      handlers: {
        "epic.batchDelete": ({ ids }) => ({
          results: ids.map((taskId) => ({
            taskId,
            success: true,
            home: "cloud" as const,
          })),
        }),
      },
    });
    const binding = await makeBinding(queryClient, messenger);
    const client = binding.hostClient;
    clientRef.current = client;
    recordDeleteManifest(TEAM_HOST_ID, POOL_HOST_ID);
    setServingPeer({ kind: "pool" });
    const outcome = deferred<BatchDeleteResponse>();
    renderHistoryDeleteDispatch(
      queryClient,
      binding,
      variables,
      outcome.resolve,
    );

    fireEvent.click(await screen.findByTestId("history-delete-dispatch"));
    const result = await outcome.promise;

    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        })),
    ).toEqual([{ hostId: POOL_HOST_ID, ids: ["accepted-cloud-row"] }]);
    expect(result).toEqual({
      results: [
        { taskId: "accepted-cloud-row", success: true, home: "cloud" },
        {
          taskId: "accepted-local-row",
          success: false,
          errorMessage: EPIC_DELETE_HOST_UNREACHABLE_MESSAGE,
        },
      ],
    });
  });
});
