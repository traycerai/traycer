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
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
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
  type BatchDeleteResponse,
  type GetTaskContextsResponse,
  listTasksRequestSchema,
  setEpicPinnedRequestSchema,
  type ListTaskLight,
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
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { taskLight } from "@/lib/view-replica/__tests__/replica-fixtures";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  cloudEpicTasksFirstPageQueryOptions,
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
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
  type BatchDeleteEpicVariables,
} from "@/hooks/epic/use-epic-batch-delete-mutation";
import { toast } from "sonner";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";
import type { WorktreeHostEntryV16 } from "@traycer/protocol/host/worktree-schemas";
import { hostQueryKeys } from "@/lib/query-keys";
import { __resetHistoryContributionsForTests } from "@/lib/history-composition/history-local-contribution";
import * as rowPeer from "@/lib/history-composition/history-row-peer";
import { observeOwnHistoryRecordChange } from "@/hooks/home/use-optimistic-activity-history-items";
import { HOST_UNSUPPORTED_MESSAGE } from "@/lib/host-error-toast";

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
const OWNER_DELETE_REFUSAL = (taskId: string): string =>
  `Caller does not have required permission (owner) for task ${taskId}`;

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

function localProcessSnapshot(hostId: string | null): LocalHostSnapshot | null {
  if (hostId === null) return null;
  return {
    hostId,
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "99.0.0",
    pid: 4242,
    systemHostName: "history-test-machine",
    displayName: "History test machine",
    availability: "available",
  };
}

async function mountServingPeer(
  peer:
    | { readonly kind: "pool" }
    | { readonly kind: "computer"; readonly hostId: string },
  additionalComputers: ReadonlyArray<string>,
  localHostId: string | null,
) {
  const readyComputers = peer.kind === "computer" ? [peer.hostId] : [];
  const computers = new Set([...readyComputers, ...additionalComputers]);
  const authority = mountTestSelectionAuthority({
    hosts: Array.from(computers, (hostId) => ({
      hostId,
      kind: hostId === localHostId ? ("local" as const) : ("remote" as const),
      teamOwned: hostId === TEAM_HOST_ID,
    })),
    localHostId,
    readyComputers,
    savedPick:
      peer.kind === "computer" && peer.hostId !== localHostId
        ? peer.hostId
        : null,
  });
  if (peer.kind === "computer") {
    authority.connectComputer(peer.hostId);
    expect(await authority.activate(peer.hostId)).toEqual({ ok: true });
  }
  const expected =
    peer.kind === "pool"
      ? { kind: "pool" as const }
      : { kind: "computer" as const, hostId: peer.hostId };
  expect(authority.snapshot().servingPeer).toEqual(expected);
  return authority;
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
  localHostId: string | null,
): Promise<HostRuntimeBinding<typeof hostRpcRegistry>> {
  const knownHosts = [teamHost, personalHost];
  const localHost =
    knownHosts.find((entry) => entry.hostId === localHostId) ?? null;
  const remoteHosts = knownHosts.filter(
    (entry) => entry.hostId !== localHostId,
  );
  const runnerHost = new HistoryRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: localProcessSnapshot(localHost?.hostId ?? null),
    hosts: remoteHosts,
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: localHost !== null,
    traycerCli: undefined,
  });
  const auth = new AuthService({ runnerHost });
  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () =>
      Promise.resolve({
        kind: "hosts",
        entries: knownHosts,
      }),
    onRegistryPollTick: null,
    authContextId: null,
    credentialGeneration: null,
    localHostIdSeeder: null,
  });
  await directory.start();
  await directory.refresh();
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
  home: "cloud" | "local" | null,
): ListTasksResponse["tasks"][number] {
  const task = taskLight(id, teamId);
  const epic = task.epic;
  if (epic?.light === null || epic?.light === undefined)
    throw new Error("A History fixture needs an Epic");
  const row = home === null ? task : { ...task, home };
  return {
    ...row,
    epic: {
      ...epic,
      light: { ...epic.light, createdBy: USER_ID },
    },
  };
}

type HistoryPermission = NonNullable<
  NonNullable<ListTaskLight["epic"]>["permission"]
>;

function serverHistoryTaskLight(
  id: string,
  teamId: string | null,
  permission: HistoryPermission,
): ListTaskLight {
  const task = historyTaskLight(id, teamId, null);
  const epic = task.epic;
  if (epic === null || epic === undefined)
    throw new Error("A server History fixture needs an Epic");
  return {
    ...task,
    epic: {
      ...epic,
      permission,
      roomInfo: {
        roomId: `history-room-${id}`,
        webSocketUrl: "wss://collab.traycer.invalid",
        token: {
          token: `history-token-${id}`,
          expiresAtMs: 9_999_999_999_999,
        },
      },
    },
  };
}

function directOwnerPermission(): HistoryPermission {
  return {
    role: "owner",
    accessType: "direct",
    userId: USER_ID,
    grantedBy: USER_ID,
    grantedAt: 1,
  };
}

function teamEditorPermission(): HistoryPermission {
  return {
    role: "editor",
    accessType: "organization",
    organizationId: "team-1",
    grantedBy: USER_ID,
    grantedAt: 1,
  };
}

function renderHistoryPanel(
  queryClient: QueryClient,
  binding: HostRuntimeBinding<typeof hostRpcRegistry>,
): void {
  renderHistoryPanelWithSearch(queryClient, binding, parseHistorySearch({}));
}

function renderHistoryPanelWithSearch(
  queryClient: QueryClient,
  binding: HostRuntimeBinding<typeof hostRpcRegistry>,
  routeSearch: HistorySearchState,
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
        routeSearch={routeSearch}
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

function historyWorktreeEntry(
  epicId: string,
  branch: string,
): WorktreeHostEntryV16 {
  return {
    worktreePath: `/tmp/history-${epicId}`,
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    branch,
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    lastActivityAt: null,
    owners: [
      {
        epicId,
        ownerKind: "chat",
        ownerId: epicId,
        updatedAt: 1,
      },
    ],
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: 1,
    presence: "present",
    gitUnreadable: false,
  };
}

const CONTEXT_CLOUD_ROW_ID = "context-cloud-home-row";
const CONTEXT_LOCAL_ROW_ID = "context-local-home-row";
const CONTEXT_HISTORY_BRANCH = "feature/history-peer-evidence";
const MIXED_HISTORY_IDS = [
  "personal-cloud-row",
  "environment-cloud-row",
  "computer-local-row",
] as const;
const LOST_DELETE_REPLY =
  "No reply came back from the Traycer host, so this may or may not have gone through.";
const mixedDeleteCases = [
  {
    name: "retains a successful computer delete beside the pool refusal",
    failingPeerIds: [],
    summary: "Deleted 2 of 3; 1 failed.",
    unsupportedComputer: false,
    unknownCount: 0,
    description: OWNER_DELETE_REFUSAL("environment-cloud-row"),
    expectedResults: [
      { taskId: "personal-cloud-row", success: true, home: "cloud" },
      {
        taskId: "environment-cloud-row",
        success: false,
        home: "cloud",
        errorMessage: OWNER_DELETE_REFUSAL("environment-cloud-row"),
      },
      { taskId: "computer-local-row", success: true, home: "local" },
    ],
  },
  {
    name: "reports an unknown computer delete beside the pool refusal",
    failingPeerIds: [TEAM_HOST_ID],
    summary: "Deleted 1 of 2; 1 failed.",
    unsupportedComputer: false,
    unknownCount: 1,
    description: OWNER_DELETE_REFUSAL("environment-cloud-row"),
    expectedResults: [
      { taskId: "personal-cloud-row", success: true, home: "cloud" },
      {
        taskId: "environment-cloud-row",
        success: false,
        home: "cloud",
        errorMessage: OWNER_DELETE_REFUSAL("environment-cloud-row"),
      },
    ],
  },
  {
    name: "counts an unsupported computer delete as a definitive refusal",
    failingPeerIds: [TEAM_HOST_ID],
    summary: "Deleted 1 of 3; 2 failed.",
    unsupportedComputer: true,
    unknownCount: 0,
    description: `${OWNER_DELETE_REFUSAL("environment-cloud-row")} · ${HOST_UNSUPPORTED_MESSAGE}`,
    expectedResults: [
      { taskId: "personal-cloud-row", success: true, home: "cloud" },
      {
        taskId: "environment-cloud-row",
        success: false,
        home: "cloud",
        errorMessage: OWNER_DELETE_REFUSAL("environment-cloud-row"),
      },
      {
        taskId: "computer-local-row",
        success: false,
        errorMessage: HOST_UNSUPPORTED_MESSAGE,
      },
    ],
  },
] as const;

function mixedHistoryMessenger(
  requestId: string,
  failingPeerIds: ReadonlyArray<string>,
  unsupportedComputer: boolean,
): MockHostMessenger<HostRpcRegistry> {
  return new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => requestId,
    handlers: {
      "epic.listTasks": (): ListTasksResponse => ({
        tasks: [
          serverHistoryTaskLight(
            "personal-cloud-row",
            null,
            directOwnerPermission(),
          ),
          serverHistoryTaskLight(
            "environment-cloud-row",
            "team-1",
            teamEditorPermission(),
          ),
        ],
        hasMore: false,
        completeness: {
          cloudPage: "settled",
          facets: "server",
          localRows: "none",
          sort: "server",
        },
      }),
      "epic.localHistory.read": (): LocalHistoryReadResponse => ({
        ...emptyLocalHistory,
        localHomeRows: [historyTaskLight("computer-local-row", null, "local")],
        localRows: "present",
      }),
      "worktree.listAllForHost": () => ({ worktrees: [], nextCursor: null }),
      "epic.batchDelete": ({ ids }) => {
        if (ids.includes("computer-local-row") && unsupportedComputer) {
          throw new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            requestId,
            method: "epic.batchDelete",
            message: "Method 'epic.batchDelete' is not served by this host",
            fatalDetails: null,
          });
        }
        if (
          ids.includes("computer-local-row") &&
          failingPeerIds.includes(TEAM_HOST_ID)
        )
          throw new HostTransportFailureError({
            code: "RPC_ERROR",
            requestId,
            method: "epic.batchDelete",
            message: "Computer delete answer was lost.",
            fatalDetails: null,
          });
        if (
          ids.some((id) => id !== "computer-local-row") &&
          failingPeerIds.includes(POOL_HOST_ID)
        )
          throw new HostTransportFailureError({
            code: "RPC_ERROR",
            requestId,
            method: "epic.batchDelete",
            message: "Pool delete answer was lost.",
            fatalDetails: null,
          });
        return {
          results: ids.map((taskId) =>
            taskId === "environment-cloud-row"
              ? {
                  taskId,
                  success: false,
                  home: "cloud" as const,
                  errorMessage: OWNER_DELETE_REFUSAL(taskId),
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
        };
      },
    },
  });
}

function contextHistoryMessenger(
  requestId: string,
  contextState: { cloudRowIsLocalHome: boolean },
  includePoolListedCloudRow: boolean,
): MockHostMessenger<HostRpcRegistry> {
  const contextRows = new Map<string, ListTaskLight>([
    [
      CONTEXT_CLOUD_ROW_ID,
      serverHistoryTaskLight(
        CONTEXT_CLOUD_ROW_ID,
        null,
        directOwnerPermission(),
      ),
    ],
    [
      CONTEXT_LOCAL_ROW_ID,
      serverHistoryTaskLight(
        CONTEXT_LOCAL_ROW_ID,
        null,
        directOwnerPermission(),
      ),
    ],
  ]);
  let requestIndex = 0;
  return new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => `${requestId}-${++requestIndex}`,
    handlers: {
      "epic.listTasks": (): ListTasksResponse => ({
        tasks: includePoolListedCloudRow
          ? [
              serverHistoryTaskLight(
                CONTEXT_CLOUD_ROW_ID,
                null,
                directOwnerPermission(),
              ),
            ]
          : [],
        hasMore: false,
        completeness: {
          cloudPage: "settled",
          facets: "server",
          localRows: "none",
          sort: "server",
        },
      }),
      "epic.localHistory.read": (): LocalHistoryReadResponse =>
        contextState.cloudRowIsLocalHome
          ? {
              ...emptyLocalHistory,
              localHomeRows: [
                historyTaskLight(CONTEXT_CLOUD_ROW_ID, null, "local"),
              ],
              localRows: "present",
            }
          : emptyLocalHistory,
      "worktree.listAllForHost": () => ({
        worktrees: [
          historyWorktreeEntry(CONTEXT_CLOUD_ROW_ID, CONTEXT_HISTORY_BRANCH),
          historyWorktreeEntry(CONTEXT_LOCAL_ROW_ID, CONTEXT_HISTORY_BRANCH),
        ],
        nextCursor: null,
      }),
      "epic.getTaskContexts": ({ taskIds }) => {
        const tasks: Record<
          string,
          { readonly status: "found"; readonly task: ListTaskLight }
        > = {};
        for (const taskId of taskIds) {
          const task = contextRows.get(taskId);
          if (task !== undefined) tasks[taskId] = { status: "found", task };
        }
        return {
          tasks,
          localHomedTaskIds: contextState.cloudRowIsLocalHome
            ? [CONTEXT_CLOUD_ROW_ID, CONTEXT_LOCAL_ROW_ID]
            : [CONTEXT_LOCAL_ROW_ID],
        };
      },
      "epic.batchDelete": ({ ids }) => ({
        results: ids.map((taskId) => ({
          taskId,
          success: true,
          home:
            taskId === CONTEXT_LOCAL_ROW_ID
              ? ("local" as const)
              : ("cloud" as const),
        })),
      }),
    },
  });
}

async function expectTeamContextLookups(
  messenger: MockHostMessenger<HostRpcRegistry>,
): Promise<void> {
  await waitFor(() => {
    for (const method of ["worktree.listAllForHost", "epic.getTaskContexts"]) {
      expect(
        messenger.calls
          .filter((call) => call.method === method)
          .map((call) => call.authority.endpoint.hostId),
      ).toContain(TEAM_HOST_ID);
    }
  });
}

async function waitForDeleteConfirmationReady(): Promise<void> {
  await waitFor(() => {
    expect(
      screen.getByTestId("delete-tasks-confirm").getAttribute("disabled"),
    ).toBeNull();
  });
}

async function expectHistorySearchQuery(query: string): Promise<void> {
  const searchBox = await screen.findByRole("searchbox", {
    name: "Search tasks and messages",
  });
  if (!(searchBox instanceof HTMLInputElement))
    throw new Error("History search control is not an input");
  expect(searchBox.value).toBe(query);
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

function findBatchDeleteMutation(queryClient: QueryClient) {
  return queryClient
    .getMutationCache()
    .find<BatchDeleteResponse, HostRpcError, BatchDeleteEpicVariables>({
      mutationKey: ["epic.batchDelete"],
    });
}

beforeEach(() => {
  onlineManager.setOnline(true);
  settleProcessHostRpcTierPlan(poolEntry);
  appQueryClient.clear();
  resetNegotiatedManifests();
  __resetHistoryContributionsForTests();
  useCloudEpicTasksPagesStore.setState({
    pagesByIdentity: {},
    generationByIdentity: {},
    identitiesWithDisplacedRowsPage: new Set(),
    deletedEpicIdsByScope: {},
  });
  useSelectionAuthorityStore.getState().reset();
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
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
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
          tasks: [
            serverHistoryTaskLight("pool-page", null, directOwnerPermission()),
          ],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "none",
            sort: "server",
          },
        }),
        "epic.localHistory.read": () => emptyLocalHistory,
      },
    });
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [],
      TEAM_HOST_ID,
    );

    invokeHistoryLoader(queryClient, binding.hostClient, TEAM_HOST_ID);
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
        "epic.listTasks": (
          params,
        ): ListTasksResponse | Promise<ListTasksResponse> => {
          if (params.cursor === "pool-cursor") {
            poolCursorStarted.resolve();
            return poolCursor.promise;
          }
          if (params.cursor !== undefined) {
            return {
              tasks: [
                serverHistoryTaskLight(
                  "crossed-peer-tail",
                  null,
                  directOwnerPermission(),
                ),
              ],
              hasMore: false,
              completeness: {
                cloudPage: "settled",
                facets: "server",
                localRows: "none",
                sort: "server",
              },
            };
          }
          firstPageCount += 1;
          return firstPageCount === 1
            ? {
                tasks: [
                  serverHistoryTaskLight(
                    "pool-first",
                    null,
                    directOwnerPermission(),
                  ),
                ],
                hasMore: true,
                nextCursor: "pool-cursor",
                completeness: {
                  cloudPage: "settled",
                  facets: "server",
                  localRows: "none",
                  sort: "server",
                },
              }
            : {
                tasks: [
                  serverHistoryTaskLight(
                    "computer-first",
                    null,
                    directOwnerPermission(),
                  ),
                ],
                hasMore: false,
                completeness: {
                  cloudPage: "settled",
                  facets: "server",
                  localRows: "none",
                  sort: "server",
                },
              };
        },
        "epic.localHistory.read": () => emptyLocalHistory,
      },
    });
    const binding = await makeBinding(queryClient, messenger, null);
    recordNegotiatedHostManifest(PERSONAL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    const authority = await mountServingPeer(
      { kind: "pool" },
      [PERSONAL_HOST_ID],
      null,
    );

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

    await act(async () => {
      authority.connectComputer(PERSONAL_HOST_ID);
      expect(await authority.activate(PERSONAL_HOST_ID)).toEqual({ ok: true });
    });
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
        tasks: [
          serverHistoryTaskLight(
            "pool-cursor-tail",
            null,
            directOwnerPermission(),
          ),
        ],
        hasMore: true,
        nextCursor: "pool-next-cursor",
        completeness: {
          cloudPage: "settled",
          facets: "server",
          localRows: "none",
          sort: "server",
        },
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
    const pinReplies: Array<Deferred<{ pinned: boolean; home: "cloud" }>> = [];
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-pool-pin-request",
      handlers: {
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [
            {
              ...serverHistoryTaskLight(
                "pool-history-row",
                null,
                directOwnerPermission(),
              ),
              pinned,
            },
          ],
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
          const response = deferred<{ pinned: boolean; home: "cloud" }>();
          pinReplies.push(response);
          return response.promise;
        },
      },
    });
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.setPinned": { major: 1, minor: 1 },
    });
    const authority = await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [],
      TEAM_HOST_ID,
    );
    renderHistoryPanel(queryClient, binding);

    const pin = await screen.findByTestId("epics-list-row-pin");
    const pageIdentity = cloudEpicTasksPageIdentity(
      POOL_HOST_ID,
      USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    );
    const pageGenerations =
      useCloudEpicTasksPagesStore.getState().generationByIdentity;
    expect(pageGenerations).toHaveProperty(pageIdentity);
    const pageGeneration = pageGenerations[pageIdentity];
    const retainedPage = {
      tasks: [historyTaskLight("pool-history-row", null, "cloud")],
      hasMore: false,
    };
    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(pageIdentity, pageGeneration, retainedPage);
    const pageQueryKey = cloudEpicTasksQueryKey(
      POOL_HOST_ID,
      USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    );
    fireEvent.click(pin);
    await waitFor(() => {
      expect(pin.getAttribute("aria-pressed")).toBe("true");
      expect(
        queryClient
          .getQueryData<ListTasksResponse>(pageQueryKey)
          ?.tasks.find((task) => task.epic?.light?.id === "pool-history-row")
          ?.pinned,
      ).toBe(true);
      expect(
        useCloudEpicTasksPagesStore.getState().pagesByIdentity[
          pageIdentity
        ]?.[0].tasks[0]?.pinned,
      ).toBe(true);
      expect(pinReplies).toHaveLength(1);
    });
    const pinReply = pinReplies[0];
    await act(() => {
      pinReply.resolve({ pinned: true, home: "cloud" });
      return pinReply.promise.then(() => undefined);
    });
    await waitFor(() => {
      const mutations = queryClient
        .getMutationCache()
        .getAll()
        .filter((entry) => entry.options.mutationKey?.[0] === "epic.setPinned");
      expect(mutations.at(-1)?.state.status).toBe("success");
    });

    const nextPageGenerations =
      useCloudEpicTasksPagesStore.getState().generationByIdentity;
    expect(nextPageGenerations).toHaveProperty(pageIdentity);
    const nextGeneration = nextPageGenerations[pageIdentity];
    useCloudEpicTasksPagesStore
      .getState()
      .appendPage(pageIdentity, nextGeneration, retainedPage);
    fireEvent.click(pin);
    await waitFor(() => {
      expect(pin.getAttribute("aria-pressed")).toBe("false");
      expect(
        queryClient
          .getQueryData<ListTasksResponse>(pageQueryKey)
          ?.tasks.find((task) => task.epic?.light?.id === "pool-history-row")
          ?.pinned,
      ).toBe(false);
      expect(
        useCloudEpicTasksPagesStore.getState().pagesByIdentity[
          pageIdentity
        ]?.[0].tasks[0]?.pinned,
      ).toBe(false);
      expect(pinReplies).toHaveLength(2);
    });
    const unpinReply = pinReplies[1];
    await act(() => {
      unpinReply.resolve({ pinned: false, home: "cloud" });
      return unpinReply.promise.then(() => undefined);
    });
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

    const stalePin = screen.getByTestId("epics-list-row-pin");
    const scopeMatches = vi.spyOn(rowPeer, "historyActionScopeMatches");
    act(() => {
      expect(authority.publishFleet([], null).servingPeer).toEqual({
        kind: "pool",
      });
      expect(stalePin.isConnected).toBe(true);
      scopeMatches.mockClear();
      fireEvent.click(stalePin);
      expect(scopeMatches).toHaveReturnedWith(false);
    });
    expect(
      messenger.calls.filter((entry) => entry.method === "epic.setPinned"),
    ).toHaveLength(2);
  });

  it.each([
    { pagePeer: POOL_HOST_ID, computerId: TEAM_HOST_ID, localId: TEAM_HOST_ID },
    { pagePeer: PERSONAL_HOST_ID, computerId: PERSONAL_HOST_ID, localId: null },
  ])(
    "routes Recent activity rows to the computer that supplied them on a $pagePeer page",
    async ({ pagePeer, computerId, localId }) => {
      const id = "recent-activity-only";
      let deleted = false;
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const messenger = new MockHostMessenger({
        registry: hostRpcRegistry,
        requestId: () => "history-recent-activity",
        handlers: {
          "epic.listTasks": (): ListTasksResponse => ({
            tasks: [],
            hasMore: false,
            completeness: {
              cloudPage: "settled",
              facets: "server",
              localRows: "none",
              sort: "server",
            },
          }),
          "epic.localHistory.read": () => emptyLocalHistory,
          "worktree.listAllForHost": () => ({
            worktrees: [],
            nextCursor: null,
          }),
          "epic.getTaskContexts": ({ taskIds }): GetTaskContextsResponse => ({
            tasks:
              !deleted && taskIds.includes(id)
                ? {
                    [id]: {
                      status: "found",
                      task: serverHistoryTaskLight(
                        id,
                        null,
                        directOwnerPermission(),
                      ),
                    },
                  }
                : {},
          }),
          "epic.setPinned": ({ pinned }) => ({
            pinned,
            home: "cloud" as const,
          }),
          "epic.batchDelete": ({ ids }) => {
            deleted = ids.includes(id);
            return {
              results: ids.map((taskId) => ({
                taskId,
                success: true,
                home: "cloud" as const,
              })),
            };
          },
        },
      });
      const binding = await makeBinding(queryClient, messenger, localId);
      recordNegotiatedHostManifest(POOL_HOST_ID, {
        "epic.listTasks": { major: 1, minor: 6 },
      });
      recordNegotiatedHostManifest(computerId, {
        "epic.listTasks": { major: 1, minor: 6 },
        "epic.getTaskContexts": { major: 1, minor: 4 },
        "epic.localHistory.read": { major: 1, minor: 0 },
        "epic.setPinned": { major: 1, minor: 1 },
        "epic.batchDelete": { major: 1, minor: 1 },
        "worktree.listAllForHost": { major: 1, minor: 7 },
      });
      await mountServingPeer(
        { kind: "computer", hostId: computerId },
        [],
        localId,
      );
      renderHistoryPanel(queryClient, binding);
      await waitFor(() => {
        expect(
          messenger.calls.find((call) => call.method === "epic.listTasks")
            ?.authority.endpoint.hostId,
        ).toBe(pagePeer);
      });
      act(() => observeOwnHistoryRecordChange(USER_ID, id, Date.now()));
      const pin = await screen.findByTestId("epics-list-row-pin");
      expect(screen.getByText(id)).toBeTruthy();
      expect(
        messenger.calls.find((call) => call.method === "epic.getTaskContexts"),
      ).toMatchObject({
        authority: { endpoint: { hostId: computerId } },
        params: { taskIds: [id] },
      });
      fireEvent.click(pin);
      await waitFor(() => {
        expect(
          messenger.calls.find((call) => call.method === "epic.setPinned"),
        ).toMatchObject({
          authority: { endpoint: { hostId: computerId } },
          params: { epicId: id, pinned: true },
        });
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Select history items" }),
      );
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
      fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
      await waitForDeleteConfirmationReady();
      fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
      await waitFor(() => {
        expect(
          messenger.calls.find((call) => call.method === "epic.batchDelete"),
        ).toMatchObject({
          authority: { endpoint: { hostId: computerId } },
          params: { ids: [id] },
        });
      });
    },
  );

  it.each(mixedDeleteCases)(
    "$name",
    async ({
      failingPeerIds,
      summary,
      description,
      unknownCount,
      unsupportedComputer,
      expectedResults,
    }) => {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const ids = MIXED_HISTORY_IDS;
      const messenger = mixedHistoryMessenger(
        "history-mixed-delete-request",
        failingPeerIds,
        unsupportedComputer,
      );
      const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
      recordNegotiatedHostManifest(TEAM_HOST_ID, {
        "epic.listTasks": { major: 1, minor: 6 },
        "epic.localHistory.read": { major: 1, minor: 0 },
        "epic.batchDelete": { major: 1, minor: 1 },
        "worktree.listAllForHost": { major: 1, minor: 7 },
      });
      recordNegotiatedHostManifest(POOL_HOST_ID, {
        "epic.listTasks": { major: 1, minor: 6 },
        "epic.batchDelete": { major: 1, minor: 1 },
      });
      await mountServingPeer(
        { kind: "computer", hostId: TEAM_HOST_ID },
        [],
        TEAM_HOST_ID,
      );
      const warning = vi.spyOn(toast, "warning");
      const noticesBefore = toast.getToasts().length;
      const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
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
      await waitForDeleteConfirmationReady();
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
        expect(warning).toHaveBeenCalledWith(summary, { description });
        expect(
          toast
            .getToasts()
            .slice(noticesBefore)
            .filter(
              (notice) =>
                "title" in notice && notice.title === LOST_DELETE_REPLY,
            ),
        ).toHaveLength(unknownCount);
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
      ).toEqual({ results: expectedResults });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: hostQueryKeys.scope(TEAM_HOST_ID),
      });
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: hostQueryKeys.scope(POOL_HOST_ID),
      });
    },
  );

  it("retains a computer success when a floor-method delete reaches an older pool", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const poolTaskId = "older-pool-cloud-row";
    const computerTaskId = "computer-local-row";
    let computerTaskPresent = true;
    const requestId = "history-older-pool-delete-request";
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => requestId,
      handlers: {
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [
            serverHistoryTaskLight(poolTaskId, null, directOwnerPermission()),
          ],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "none",
            sort: "server",
          },
        }),
        "epic.localHistory.read": (): LocalHistoryReadResponse => ({
          ...emptyLocalHistory,
          localHomeRows: computerTaskPresent
            ? [historyTaskLight(computerTaskId, null, "local")]
            : [],
          localRows: computerTaskPresent ? "present" : "none",
        }),
        "worktree.listAllForHost": () => ({
          worktrees: [],
          nextCursor: null,
        }),
        "epic.batchDelete": ({ ids }) => {
          if (ids.includes(poolTaskId)) {
            throw new HostRpcError({
              code: "E_HOST_UNSUPPORTED",
              requestId,
              method: "epic.batchDelete",
              message: "Method 'epic.batchDelete' is not served by this host",
              fatalDetails: null,
            });
          }
          expect(ids).toEqual([computerTaskId]);
          computerTaskPresent = false;
          return {
            results: ids.map((taskId) => ({
              taskId,
              success: true,
              home: "local" as const,
            })),
          };
        },
      },
    });
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 1 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      // This released-floor method is advertised even when an older pool has
      // no resolver for it and answers the RPC with E_HOST_UNSUPPORTED.
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [],
      TEAM_HOST_ID,
    );
    const warning = vi.spyOn(toast, "warning");
    const error = vi.spyOn(toast, "error");
    const noticesBefore = toast.getToasts().length;
    renderHistoryPanel(queryClient, binding);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(2),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    for (const id of [poolTaskId, computerTaskId])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText("Delete 2 tasks?")).toBeTruthy();
    await waitForDeleteConfirmationReady();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));

    await waitFor(() => {
      expect(findBatchDeleteMutation(queryClient)?.state.status).toBe(
        "success",
      );
      expect(warning).toHaveBeenCalledWith("Deleted 1 of 2; 1 failed.", {
        description: HOST_UNSUPPORTED_MESSAGE,
      });
    });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(toast.getToasts().slice(noticesBefore)).toHaveLength(1);
    expect(findBatchDeleteMutation(queryClient)?.state.data).toEqual({
      results: [
        {
          taskId: poolTaskId,
          success: false,
          errorMessage: HOST_UNSUPPORTED_MESSAGE,
        },
        { taskId: computerTaskId, success: true, home: "local" },
      ],
    });
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        }))
        .sort((left, right) => left.hostId.localeCompare(right.hostId)),
    ).toEqual(
      [
        { hostId: POOL_HOST_ID, ids: [poolTaskId] },
        { hostId: TEAM_HOST_ID, ids: [computerTaskId] },
      ].sort((left, right) => left.hostId.localeCompare(right.hostId)),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("checkbox", { name: `Select ${computerTaskId}` }),
      ).toBeNull();
      expect(
        screen.getByRole("checkbox", { name: `Select ${poolTaskId}` }),
      ).toBeTruthy();
    });
    const refusedCheckbox = screen.getByRole("checkbox", {
      name: `Select ${poolTaskId}`,
    });
    expect(refusedCheckbox.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(refusedCheckbox);
    expect(refusedCheckbox.getAttribute("aria-checked")).toBe("true");
  });

  it("rejects a split delete when both peer answers are unknown", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = mixedHistoryMessenger(
      "history-mixed-delete-unknown-request",
      [TEAM_HOST_ID, POOL_HOST_ID],
      false,
    );
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 1 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [],
      TEAM_HOST_ID,
    );
    const noticesBefore = toast.getToasts().length;
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    renderHistoryPanel(queryClient, binding);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(3),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    for (const id of MIXED_HISTORY_IDS)
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText("Delete 3 tasks?")).toBeTruthy();
    await waitForDeleteConfirmationReady();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));

    await waitFor(() => {
      const mutation = queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
      expect(mutation?.state.status).toBe("error");
      expect(
        toast
          .getToasts()
          .slice(noticesBefore)
          .filter(
            (notice) => "title" in notice && notice.title === LOST_DELETE_REPLY,
          ),
      ).toHaveLength(2);
    });
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        }))
        .sort((left, right) => left.hostId.localeCompare(right.hostId)),
    ).toEqual(
      [
        { hostId: POOL_HOST_ID, ids: MIXED_HISTORY_IDS.slice(0, 2) },
        { hostId: TEAM_HOST_ID, ids: ["computer-local-row"] },
      ].sort((left, right) => left.hostId.localeCompare(right.hostId)),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.scope(TEAM_HOST_ID),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostQueryKeys.scope(POOL_HOST_ID),
    });
    const mutation = queryClient
      .getMutationCache()
      .getAll()
      .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
    expect(mutation?.state.data).toBeUndefined();
  });

  it("routes cloud and local task-context rows to the computer that supplied them while it serves", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = contextHistoryMessenger(
      "history-context-peer-request",
      { cloudRowIsLocalHome: false },
      false,
    );
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.getTaskContexts": { major: 1, minor: 4 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [],
      TEAM_HOST_ID,
    );
    renderHistoryPanelWithSearch(
      queryClient,
      binding,
      parseHistorySearch({ historyQuery: CONTEXT_HISTORY_BRANCH }),
    );
    await expectHistorySearchQuery(CONTEXT_HISTORY_BRANCH);
    await expectTeamContextLookups(messenger);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(2),
    );
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.getTaskContexts")
        .map((call) => call.authority.endpoint.hostId),
    ).toEqual([TEAM_HOST_ID]);
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    for (const id of [CONTEXT_CLOUD_ROW_ID, CONTEXT_LOCAL_ROW_ID])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText("Delete 2 tasks?")).toBeTruthy();
    await waitForDeleteConfirmationReady();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() => {
      const mutation = queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
      expect(mutation?.state.status).toBe("success");
    });

    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        })),
    ).toEqual([
      {
        hostId: TEAM_HOST_ID,
        ids: [CONTEXT_CLOUD_ROW_ID, CONTEXT_LOCAL_ROW_ID],
      },
    ]);
  });

  it("keeps pool provenance when a duplicate context marks the row local-homed", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const localHomeReplies: Array<ReadonlyArray<string>> = [];
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-pool-listed-local-home-request",
      handlers: {
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [
            serverHistoryTaskLight(
              "pool-listed-local-home",
              null,
              directOwnerPermission(),
            ),
          ],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "none",
            sort: "server",
          },
        }),
        "epic.localHistory.read": () => emptyLocalHistory,
        "worktree.listAllForHost": () => ({
          worktrees: [
            historyWorktreeEntry(
              "pool-listed-local-home",
              CONTEXT_HISTORY_BRANCH,
            ),
          ],
          nextCursor: null,
        }),
        "epic.getTaskContexts": ({ taskIds }): GetTaskContextsResponse => {
          expect(taskIds).toContain("pool-listed-local-home");
          localHomeReplies.push(["pool-listed-local-home"]);
          return {
            tasks: {
              "pool-listed-local-home": {
                status: "found",
                task: serverHistoryTaskLight(
                  "pool-listed-local-home",
                  null,
                  directOwnerPermission(),
                ),
              },
            },
            localHomedTaskIds: ["pool-listed-local-home"],
          };
        },
        "epic.batchDelete": ({ ids }) => ({
          results: ids.map((taskId) => ({
            taskId,
            success: true,
            home: "cloud" as const,
          })),
        }),
      },
    });
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.getTaskContexts": { major: 1, minor: 4 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [],
      TEAM_HOST_ID,
    );
    renderHistoryPanelWithSearch(
      queryClient,
      binding,
      parseHistorySearch({ historyQuery: CONTEXT_HISTORY_BRANCH }),
    );
    await expectHistorySearchQuery(CONTEXT_HISTORY_BRANCH);
    await waitFor(() =>
      expect(localHomeReplies).toEqual([["pool-listed-local-home"]]),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(1),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select pool-listed-local-home" }),
    );
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(
      await screen.findByText('Delete "pool-listed-local-home"?'),
    ).toBeTruthy();
    await waitForDeleteConfirmationReady();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));

    await waitFor(() => {
      const mutation = queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
      expect(mutation?.state.status).toBe("success");
    });
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        })),
    ).toEqual([{ hostId: POOL_HOST_ID, ids: ["pool-listed-local-home"] }]);
  });

  it("does not send unknown and local context-only rows to the pool after the computer leaves", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = contextHistoryMessenger(
      "history-context-takeover-request",
      { cloudRowIsLocalHome: false },
      false,
    );
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.getTaskContexts": { major: 1, minor: 4 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    const authority = await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [],
      TEAM_HOST_ID,
    );
    renderHistoryPanelWithSearch(
      queryClient,
      binding,
      parseHistorySearch({ historyQuery: CONTEXT_HISTORY_BRANCH }),
    );
    await expectHistorySearchQuery(CONTEXT_HISTORY_BRANCH);
    await expectTeamContextLookups(messenger);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(2),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    for (const id of [CONTEXT_CLOUD_ROW_ID, CONTEXT_LOCAL_ROW_ID])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText("Delete 2 tasks?")).toBeTruthy();
    await waitForDeleteConfirmationReady();

    act(() => onlineManager.setOnline(false));
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() => {
      const mutation = queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
      expect(mutation?.state.isPaused).toBe(true);
      expect(
        findBatchDeleteMutation(
          queryClient,
        )?.state.variables?.history?.selectedRows.get(CONTEXT_CLOUD_ROW_ID),
      ).toEqual({
        home: undefined,
        listedByPeerId: TEAM_HOST_ID,
      });
      expect(
        findBatchDeleteMutation(
          queryClient,
        )?.state.variables?.history?.selectedRows.get(CONTEXT_LOCAL_ROW_ID),
      ).toEqual({ home: "local", listedByPeerId: TEAM_HOST_ID });
    });
    expect(
      messenger.calls.filter((call) => call.method === "epic.batchDelete"),
    ).toEqual([]);
    act(() => {
      expect(authority.publishFleet([], null).servingPeer).toEqual({
        kind: "pool",
      });
    });
    act(() => onlineManager.setOnline(true));
    await waitFor(() => {
      const mutation = queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
      expect(mutation?.state.status).toBe("error");
      expect(mutation?.state.data).toBeUndefined();
    });

    expect(
      messenger.calls.filter((call) => call.method === "epic.batchDelete"),
    ).toEqual([]);
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete")
        ?.state.data,
    ).toBeUndefined();
  });

  it("refuses a pool-listed delete after the same id becomes local-homed while the mutation is paused", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const contextState = { cloudRowIsLocalHome: false };
    const messenger = contextHistoryMessenger(
      "history-context-unverified-takeover-request",
      contextState,
      true,
    );
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.getTaskContexts": { major: 1, minor: 4 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    const authority = await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [],
      TEAM_HOST_ID,
    );
    const refusal = vi.spyOn(toast, "error");
    renderHistoryPanel(queryClient, binding);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(1),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select ${CONTEXT_CLOUD_ROW_ID}` }),
    );
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(
      await screen.findByText(`Delete "${CONTEXT_CLOUD_ROW_ID}"?`),
    ).toBeTruthy();
    await waitForDeleteConfirmationReady();

    act(() => onlineManager.setOnline(false));
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() => {
      const mutation = findBatchDeleteMutation(queryClient);
      expect(mutation?.state.isPaused).toBe(true);
      expect(
        mutation?.state.variables?.history?.selectedRows.get(
          CONTEXT_CLOUD_ROW_ID,
        ),
      ).toEqual({ home: "cloud", listedByPeerId: POOL_HOST_ID });
      expect(
        mutation?.state.variables?.history?.acceptedRows.get(
          CONTEXT_CLOUD_ROW_ID,
        ),
      ).toEqual({ home: "cloud", listedByPeerId: POOL_HOST_ID });
      expect(
        mutation?.state.variables?.isLocalHomedNow(CONTEXT_CLOUD_ROW_ID),
      ).toBe(false);
    });

    contextState.cloudRowIsLocalHome = true;
    const previousLocalReads = messenger.calls.filter(
      (call) => call.method === "epic.localHistory.read",
    ).length;
    await act(async () => {
      await queryClient.fetchQuery({
        ...cloudEpicTasksFirstPageQueryOptions(
          POOL_HOST_ID,
          USER_ID,
          LIST_CLOUD_TASKS_REQUEST,
        ),
        networkMode: "always",
        staleTime: 0,
      });
    });
    const refreshedLocalReads = messenger.calls
      .filter((call) => call.method === "epic.localHistory.read")
      .slice(previousLocalReads);
    expect(refreshedLocalReads.length).toBeGreaterThan(0);
    expect(
      refreshedLocalReads.some(
        (call) => call.authority.endpoint.hostId === TEAM_HOST_ID,
      ),
    ).toBe(true);
    await waitFor(() => {
      expect(
        findBatchDeleteMutation(queryClient)?.state.variables?.isLocalHomedNow(
          CONTEXT_CLOUD_ROW_ID,
        ),
      ).toBe(true);
    });
    expect(binding.hostClient.getRequestContextUserId()).toBe(USER_ID);
    act(() => {
      useAuthStore.setState({ status: "unverified" });
      expect(authority.snapshot().servingPeer).toEqual({
        kind: "computer",
        hostId: TEAM_HOST_ID,
      });
      expect(
        findBatchDeleteMutation(queryClient)?.state.variables?.isLocalHomedNow(
          CONTEXT_CLOUD_ROW_ID,
        ),
      ).toBe(true);
    });
    act(() => onlineManager.setOnline(true));
    await waitFor(() => {
      const mutation = findBatchDeleteMutation(queryClient);
      expect(mutation?.state.status).toBe("error");
      expect(mutation?.state.data).toBeUndefined();
      expect(refusal).toHaveBeenCalledWith(
        "Couldn't delete task.",
        expect.objectContaining({
          description:
            "This task was not deleted because Traycer couldn't confirm your sign-in. Try again once you're signed in.",
        }),
      );
    });

    expect(
      messenger.calls.filter((call) => call.method === "epic.batchDelete"),
    ).toEqual([]);
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
          tasks: [
            serverHistoryTaskLight(
              "racing-cloud-row",
              null,
              directOwnerPermission(),
            ),
          ],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "none",
            sort: "server",
          },
        }),
        "epic.localHistory.read": (): LocalHistoryReadResponse => ({
          ...emptyLocalHistory,
          localHomeRows: [historyTaskLight("racing-local-row", null, "local")],
          localRows: "present",
        }),
        "worktree.listAllForHost": () => ({ worktrees: [], nextCursor: null }),
        "epic.batchDelete": () => ({ results: [] }),
      },
    });
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 1 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    const authority = await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [PERSONAL_HOST_ID],
      TEAM_HOST_ID,
    );
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
    await waitForDeleteConfirmationReady();
    const confirmation = screen.getByTestId("delete-tasks-confirm");

    const scopeMatches = vi.spyOn(rowPeer, "historyActionScopeMatches");
    await act(async () => {
      authority.connectComputer(PERSONAL_HOST_ID);
      const activation = authority.activate(PERSONAL_HOST_ID);
      expect(confirmation.isConnected).toBe(true);
      scopeMatches.mockClear();
      fireEvent.click(confirmation);
      expect(scopeMatches).toHaveReturnedWith(false);
      expect(await activation).toEqual({ ok: true });
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
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-pool-partial-delete-request",
      handlers: {
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [
            serverHistoryTaskLight(
              "pool-refused-row",
              null,
              teamEditorPermission(),
            ),
            serverHistoryTaskLight(
              "pool-success-row",
              null,
              directOwnerPermission(),
            ),
          ],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "none",
            sort: "server",
          },
        }),
        "epic.localHistory.read": () => emptyLocalHistory,
        "epic.batchDelete": ({ ids }) => ({
          results: ids.map((taskId) =>
            taskId === "pool-refused-row"
              ? {
                  taskId,
                  success: false,
                  home: "cloud" as const,
                  errorMessage: OWNER_DELETE_REFUSAL(taskId),
                }
              : { taskId, success: true, home: "cloud" as const },
          ),
        }),
      },
    });
    const binding = await makeBinding(queryClient, messenger, null);
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    await mountServingPeer({ kind: "pool" }, [], null);
    const warning = vi.spyOn(toast, "warning");
    renderHistoryPanel(queryClient, binding);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(2),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    for (const id of ["pool-refused-row", "pool-success-row"])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText("Delete 2 tasks?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() => {
      const mutation = queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
      expect(mutation?.state.status).toBe("success");
      expect(warning).toHaveBeenCalledWith("Deleted 1 of 2; 1 failed.", {
        description: OWNER_DELETE_REFUSAL("pool-refused-row"),
      });
    });

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
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete")
        ?.state.data,
    ).toEqual({
      results: [
        {
          taskId: "pool-refused-row",
          success: false,
          home: "cloud",
          errorMessage: OWNER_DELETE_REFUSAL("pool-refused-row"),
        },
        { taskId: "pool-success-row", success: true, home: "cloud" },
      ],
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
          tasks: [
            historyTaskLight("personal-local-row", null, "local"),
            serverHistoryTaskLight(
              "personal-page-cloud-row",
              null,
              directOwnerPermission(),
            ),
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
            historyTaskLight("personal-local-row", null, "local"),
          ],
          localRows: "present",
        }),
        "worktree.listAllForHost": () => ({ worktrees: [], nextCursor: null }),
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
    const binding = await makeBinding(queryClient, messenger, null);
    recordNegotiatedHostManifest(PERSONAL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 1 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
    });
    await mountServingPeer(
      { kind: "computer", hostId: PERSONAL_HOST_ID },
      [],
      null,
    );
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
    expect(await screen.findByText("Delete 2 tasks?")).toBeTruthy();
    await waitForDeleteConfirmationReady();
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
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-remembered-home-delete-request",
      handlers: {
        "epic.listTasks": (): ListTasksResponse => ({
          tasks: [
            serverHistoryTaskLight(
              "accepted-cloud-row",
              null,
              directOwnerPermission(),
            ),
          ],
          hasMore: false,
          completeness: {
            cloudPage: "settled",
            facets: "server",
            localRows: "none",
            sort: "server",
          },
        }),
        "epic.localHistory.read": (): LocalHistoryReadResponse => ({
          ...emptyLocalHistory,
          localHomeRows: [
            historyTaskLight("accepted-local-row", null, "local"),
          ],
          localRows: "present",
        }),
        "worktree.listAllForHost": () => ({ worktrees: [], nextCursor: null }),
        "epic.batchDelete": ({ ids }) => ({
          results: ids.map((taskId) => ({
            taskId,
            success: true,
            home: "cloud" as const,
          })),
        }),
      },
    });
    const binding = await makeBinding(queryClient, messenger, TEAM_HOST_ID);
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 1 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    const authority = await mountServingPeer(
      { kind: "computer", hostId: TEAM_HOST_ID },
      [],
      TEAM_HOST_ID,
    );
    renderHistoryPanel(queryClient, binding);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(2),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    for (const id of ["accepted-cloud-row", "accepted-local-row"])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText("Delete 2 tasks?")).toBeTruthy();
    await waitForDeleteConfirmationReady();

    onlineManager.setOnline(false);
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() => {
      const mutation = queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
      expect(mutation?.state.isPaused).toBe(true);
    });
    expect(
      messenger.calls.filter((call) => call.method === "epic.batchDelete"),
    ).toEqual([]);
    expect(authority.publishFleet([], null).servingPeer).toEqual({
      kind: "pool",
    });
    onlineManager.setOnline(true);
    await waitFor(() => {
      const mutation = queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete");
      expect(mutation?.state.status).toBe("success");
    });

    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        })),
    ).toEqual([{ hostId: POOL_HOST_ID, ids: ["accepted-cloud-row"] }]);
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .find((entry) => entry.options.mutationKey?.[0] === "epic.batchDelete")
        ?.state.data,
    ).toEqual({
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
