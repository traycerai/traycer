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
import { markTargetAnswer } from "@traycer/protocol/host-transport/remote/rpc-types";
import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
import {
  type BatchDeleteResponse,
  type GetTaskContextsResponse,
  listTasksRequestSchema,
  setEpicPinnedRequestSchema,
  type ListTaskLight,
  type ListTasksResponse,
  type SetEpicPinnedResponse,
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
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import {
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import {
  __resetCloudEpicTasksClientsForTests,
  getCloudEpicTasksClient,
} from "@/lib/cloud-epic-tasks-query/client-registry";
import { queryClient as appQueryClient } from "@/lib/query-client";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import type {
  WorktreeCleanupOutcome,
  WorktreeCleanupRequest,
} from "@/lib/epics/run-worktree-cleanup";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { EpicsListPanel } from "@/components/epics/epics-list-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  EPIC_DELETE_HOST_UNREACHABLE_MESSAGE,
  type BatchDeleteEpicVariables,
} from "@/hooks/epic/use-epic-batch-delete-mutation";
import { toast } from "sonner";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";
import { hostQueryKeys } from "@/lib/query-keys";
import { __resetHistoryContributionsForTests } from "@/lib/history-composition/history-local-contribution";
import * as rowPeer from "@/lib/history-composition/history-row-peer";
import {
  type ComputerLocalHomeHistoryRow,
  type PagePosition,
  type TaskContextScenarioAt14,
  completeLocalHistoryRead,
  computerCloudDeleteSuccess,
  computerDeleteOutcomes,
  computerLocalDeleteSuccess,
  computerLocalHomeRow,
  computerPageWithLocalRowsAt16,
  computerWorktreeEntryAt16,
  computerWorktreePageAt17,
  directHistoryGrant,
  organizationHistoryGrant,
  computerPinAcknowledgementAt11,
  poolPinAcknowledgementAt11,
  poolEnvironmentOwnedTaskAt19,
  poolDeleteOutcomes,
  poolDeleteSuccess,
  poolListedTaskAt16,
  poolListedTaskAt17,
  poolOwnerRefusal,
  settledPoolPageAt16,
  settledPoolTailPageAt16,
  settledComputerCloudPageAt16,
  taskContextsAt14,
} from "@/lib/history-composition/test-support/history-wire-fixtures";
import { observeOwnHistoryRecordChange } from "@/hooks/home/use-optimistic-activity-history-items";
import { HOST_UNSUPPORTED_MESSAGE } from "@/lib/host-error-toast";
import { OWNER_HOST_UNREACHABLE_NOTICE } from "@/lib/owner-host-write-error-toast";

vi.mock("@/lib/host/use-worktree-delete-stream-transport", () => ({
  useWorktreeDeleteStreamTransportFactory: () => () => {
    throw new Error("unexpected worktree cleanup in History routing test");
  },
}));

const runWorktreeCleanupMock = vi.hoisted(() =>
  vi.fn<
    (
      openStreamTransport: (hostId: string) => DurableStreamTransport,
      request: WorktreeCleanupRequest,
    ) => Promise<WorktreeCleanupOutcome>
  >(),
);

vi.mock("@/lib/epics/run-worktree-cleanup", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/epics/run-worktree-cleanup")
  >()),
  runWorktreeCleanup: runWorktreeCleanupMock,
}));

const USER_ID = "history-peer-user";
const TEAM_HOST_ID = "history-team-computer";
const PERSONAL_HOST_ID = "history-personal-computer";
const emptyLocalHistory = completeLocalHistoryRead([], [], []);
const OWNER_DELETE_REFUSAL = poolOwnerRefusal;

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
  remoteHostsSnapshot: (() => ReadonlyArray<HostDirectoryEntry>) | undefined,
): Promise<HostRuntimeBinding<typeof hostRpcRegistry>> {
  const snapshot = remoteHostsSnapshot ?? (() => [teamHost, personalHost]);
  const knownHosts = snapshot();
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
      Promise.resolve({ kind: "hosts", entries: snapshot() }),
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

type HistoryPermission = NonNullable<
  NonNullable<ListTaskLight["epic"]>["permission"]
>;

function serverHistoryTaskLight(
  id: string,
  teamId: string | null,
  permission: HistoryPermission,
): ListTaskLight {
  if (teamId !== null && permission.organizationId !== teamId) {
    throw new Error("A team list row needs its matching organization grant");
  }
  return poolListedTaskAt16({
    id,
    title: id,
    grant: permission,
    pinned: false,
    updatedAt: 1,
  });
}

function directOwnerPermission(): HistoryPermission {
  return directHistoryGrant("owner", USER_ID);
}

function teamEditorPermission(): HistoryPermission {
  return organizationHistoryGrant("editor", "team-1", USER_ID);
}

function localHistoryTaskLight(
  id: string,
  recentAt: number,
): ComputerLocalHomeHistoryRow {
  return computerLocalHomeRow({
    id,
    title: id,
    recentAt,
    pinned: false,
    userId: USER_ID,
    createdAt: 1,
    updatedAt: 1,
  });
}

function settledPoolHistoryPage(
  tasks: readonly ListTaskLight[],
  hasMore: false,
  nextCursor: undefined,
): ListTasksResponse;
function settledPoolHistoryPage(
  tasks: readonly ListTaskLight[],
  hasMore: true,
  nextCursor: string,
): ListTasksResponse;
function settledPoolHistoryPage(
  tasks: readonly ListTaskLight[],
  hasMore: boolean,
  nextCursor: string | undefined,
): ListTasksResponse {
  let position: PagePosition;
  if (hasMore) {
    if (nextCursor === undefined) {
      throw new Error("A pool page with more results needs a cursor.");
    }
    position = { hasMore: true, nextCursor };
  } else {
    if (nextCursor !== undefined) {
      throw new Error("A final pool page cannot carry a cursor.");
    }
    position = { hasMore: false, nextCursor: undefined };
  }
  return settledPoolPageAt16(tasks, position, USER_ID);
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

const CONTEXT_CLOUD_ROW_ID = "context-cloud-home-row";
const CONTEXT_LOCAL_ROW_ID = "context-local-home-row";
const CONTEXT_HISTORY_BRANCH = "feature/history-peer-evidence";
const MIXED_HISTORY_IDS = [
  "personal-cloud-row",
  "team-shared-cloud-row",
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
    description: OWNER_DELETE_REFUSAL("team-shared-cloud-row"),
    expectedResults: [
      { taskId: "personal-cloud-row", success: true, home: "cloud" },
      {
        taskId: "team-shared-cloud-row",
        success: false,
        home: "cloud",
        errorMessage: OWNER_DELETE_REFUSAL("team-shared-cloud-row"),
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
    description: OWNER_DELETE_REFUSAL("team-shared-cloud-row"),
    expectedResults: [
      { taskId: "personal-cloud-row", success: true, home: "cloud" },
      {
        taskId: "team-shared-cloud-row",
        success: false,
        home: "cloud",
        errorMessage: OWNER_DELETE_REFUSAL("team-shared-cloud-row"),
      },
    ],
  },
  {
    name: "counts an unsupported computer delete as a definitive refusal",
    failingPeerIds: [TEAM_HOST_ID],
    summary: "Deleted 1 of 3; 2 failed.",
    unsupportedComputer: true,
    unknownCount: 0,
    description: `${OWNER_DELETE_REFUSAL("team-shared-cloud-row")} · ${HOST_UNSUPPORTED_MESSAGE}`,
    expectedResults: [
      { taskId: "personal-cloud-row", success: true, home: "cloud" },
      {
        taskId: "team-shared-cloud-row",
        success: false,
        home: "cloud",
        errorMessage: OWNER_DELETE_REFUSAL("team-shared-cloud-row"),
      },
      {
        taskId: "computer-local-row",
        success: false,
        errorMessage: HOST_UNSUPPORTED_MESSAGE,
      },
    ],
  },
] as const;

function receivedUnsupportedMethodError(
  requestId: string,
  method: string,
): HostRpcError {
  const error = new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    requestId,
    method,
    message: `Method '${method}' is not served by this host`,
    fatalDetails: null,
  });
  markTargetAnswer(error);
  return error;
}

function mixedHistoryMessenger(
  requestId: string,
  failingPeerIds: ReadonlyArray<string>,
  unsupportedComputer: boolean,
): MockHostMessenger<HostRpcRegistry> {
  return new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => requestId,
    handlers: {
      "epic.listTasks": (): ListTasksResponse =>
        settledPoolHistoryPage(
          [
            serverHistoryTaskLight(
              "personal-cloud-row",
              null,
              directOwnerPermission(),
            ),
            poolEnvironmentOwnedTaskAt19({
              id: "team-shared-cloud-row",
              title: "team-shared-cloud-row",
              grant: teamEditorPermission(),
              pinned: false,
              updatedAt: 1,
              createdBy: "environment-task-creator",
              ownerEnvironmentId: "environment-1",
            }),
          ],
          false,
          undefined,
        ),
      "epic.localHistory.read": () =>
        completeLocalHistoryRead(
          [localHistoryTaskLight("computer-local-row", 10)],
          [],
          [],
        ),
      "worktree.listAllForHost": () => computerWorktreePageAt17([]),
      "epic.batchDelete": ({ ids }) => {
        if (ids.includes("computer-local-row") && unsupportedComputer) {
          throw receivedUnsupportedMethodError(requestId, "epic.batchDelete");
        }
        if (
          ids.includes("computer-local-row") &&
          failingPeerIds.includes(TEAM_HOST_ID)
        )
          throw new HostTransportFailureError({
            code: "RPC_ERROR",
            requestId,
            method: "epic.batchDelete",
            message:
              "WebSocket closed before next frame (code=1006, reason='')",
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
            message: "Remote session dropped before the response arrived",
            fatalDetails: null,
          });
        if (ids.includes("computer-local-row")) {
          return computerLocalDeleteSuccess(ids);
        }
        return poolDeleteOutcomes(
          ids.filter((taskId) => taskId !== "computer-local-row"),
          ids.filter((taskId) => taskId === "team-shared-cloud-row"),
        );
      },
    },
  });
}

function contextHistoryMessenger(
  requestId: string,
  contextState: { cloudRowIsLocalHome: boolean },
  includePoolListedCloudRow: boolean,
): MockHostMessenger<HostRpcRegistry> {
  let requestIndex = 0;
  return new MockHostMessenger({
    registry: hostRpcRegistry,
    requestId: () => `${requestId}-${++requestIndex}`,
    handlers: {
      "epic.listTasks": (): ListTasksResponse =>
        settledPoolHistoryPage(
          includePoolListedCloudRow
            ? [
                serverHistoryTaskLight(
                  CONTEXT_CLOUD_ROW_ID,
                  null,
                  directOwnerPermission(),
                ),
              ]
            : [],
          false,
          undefined,
        ),
      "epic.localHistory.read": (): LocalHistoryReadResponse =>
        emptyLocalHistory,
      "worktree.listAllForHost": () =>
        computerWorktreePageAt17([
          computerWorktreeEntryAt16(
            CONTEXT_CLOUD_ROW_ID,
            CONTEXT_HISTORY_BRANCH,
          ),
          computerWorktreeEntryAt16(
            CONTEXT_LOCAL_ROW_ID,
            CONTEXT_HISTORY_BRANCH,
          ),
        ]),
      "epic.getTaskContexts": ({ taskIds }) => {
        const scenarios = taskIds.map((taskId) => {
          if (taskId === CONTEXT_LOCAL_ROW_ID) {
            return {
              kind: "local-home-found" as const,
              taskId,
              title: taskId,
              userId: USER_ID,
              recentAt: 10,
              pinned: false,
            };
          }
          if (taskId === CONTEXT_CLOUD_ROW_ID) {
            return contextState.cloudRowIsLocalHome
              ? {
                  kind: "local-home-found" as const,
                  taskId,
                  title: taskId,
                  userId: USER_ID,
                  recentAt: 10,
                  pinned: false,
                }
              : {
                  kind: "cloud-found" as const,
                  taskId,
                  title: taskId,
                  grant: organizationHistoryGrant("owner", "team-1", USER_ID),
                  recentAt: 10,
                  pinned: false,
                };
          }
          return { kind: "indeterminate" as const, taskId };
        });
        return taskContextsAt14(taskIds, scenarios);
      },
      "epic.batchDelete": ({ ids }) =>
        computerDeleteOutcomes(
          ids,
          contextState.cloudRowIsLocalHome
            ? [CONTEXT_CLOUD_ROW_ID, CONTEXT_LOCAL_ROW_ID]
            : [CONTEXT_LOCAL_ROW_ID],
        ),
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
  runWorktreeCleanupMock
    .mockReset()
    .mockResolvedValue({ removed: [], failed: [], uncertain: [] });
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
        "epic.listTasks": (): ListTasksResponse =>
          settledPoolHistoryPage(
            [
              serverHistoryTaskLight(
                "pool-page",
                null,
                directOwnerPermission(),
              ),
            ],
            false,
            undefined,
          ),
        "epic.localHistory.read": () => emptyLocalHistory,
      },
    });
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
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
            return settledPoolTailPageAt16(
              [
                serverHistoryTaskLight(
                  "crossed-peer-tail",
                  null,
                  directOwnerPermission(),
                ),
              ],
              { hasMore: false, nextCursor: undefined },
            );
          }
          firstPageCount += 1;
          return firstPageCount === 1
            ? settledPoolHistoryPage(
                [
                  serverHistoryTaskLight(
                    "pool-first",
                    null,
                    directOwnerPermission(),
                  ),
                ],
                true,
                "pool-cursor",
              )
            : settledPoolHistoryPage(
                [
                  serverHistoryTaskLight(
                    "computer-first",
                    null,
                    directOwnerPermission(),
                  ),
                ],
                false,
                undefined,
              );
        },
        "epic.localHistory.read": () => emptyLocalHistory,
      },
    });
    const binding = await makeBinding(queryClient, messenger, null, undefined);
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
      poolCursor.resolve(
        settledPoolTailPageAt16(
          [
            serverHistoryTaskLight(
              "pool-cursor-tail",
              null,
              directOwnerPermission(),
            ),
          ],
          { hasMore: true, nextCursor: "pool-next-cursor" },
        ),
      );
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
    const pinReplies: Array<Deferred<SetEpicPinnedResponse>> = [];
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-pool-pin-request",
      handlers: {
        "epic.listTasks": (): ListTasksResponse =>
          settledPoolHistoryPage(
            [
              poolListedTaskAt16({
                id: "pool-history-row",
                title: "pool-history-row",
                grant: directOwnerPermission(),
                pinned,
                updatedAt: 1,
              }),
            ],
            false,
            undefined,
          ),
        "epic.localHistory.read": () => emptyLocalHistory,
        "epic.setPinned": (params) => {
          expect(params.epicId).toBe("pool-history-row");
          pinned = params.pinned;
          const response = deferred<SetEpicPinnedResponse>();
          pinReplies.push(response);
          return response.promise;
        },
      },
    });
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
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
      tasks: [
        poolListedTaskAt16({
          id: "pool-history-row",
          title: "pool-history-row",
          grant: directOwnerPermission(),
          pinned,
          updatedAt: 1,
        }),
      ],
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
      pinReply.resolve(poolPinAcknowledgementAt11(true));
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
      unpinReply.resolve(poolPinAcknowledgementAt11(false));
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

  it("keeps a pool pin's applied state after the reply is lost and reconciles the pool page", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let pinned = false;
    let pageReads = 0;
    const requestId = "history-pool-pin-lost-reply";
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => requestId,
      handlers: {
        "epic.listTasks": (): ListTasksResponse => {
          pageReads++;
          return settledPoolHistoryPage(
            [
              poolListedTaskAt16({
                id: "pool-pin-lost-reply-row",
                title: "pool-pin-lost-reply-row",
                grant: directOwnerPermission(),
                pinned,
                updatedAt: 1,
              }),
            ],
            false,
            undefined,
          );
        },
        "epic.localHistory.read": () => emptyLocalHistory,
        "epic.setPinned": ({ pinned: nextPinned }) => {
          pinned = nextPinned;
          throw new HostTransportFailureError({
            code: "RPC_ERROR",
            requestId,
            method: "epic.setPinned",
            message: "Remote session dropped before the response arrived",
            fatalDetails: null,
          });
        },
      },
    });
    const binding = await makeBinding(queryClient, messenger, null, undefined);
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.setPinned": { major: 1, minor: 1 },
    });
    await mountServingPeer({ kind: "pool" }, [], null);
    const noticesBefore = toast.getToasts().length;
    renderHistoryPanel(queryClient, binding);
    const pin = await screen.findByTestId("epics-list-row-pin");
    fireEvent.click(pin);

    await waitFor(() => {
      expect(
        queryClient.getMutationCache().find({ mutationKey: ["epic.setPinned"] })
          ?.state.status,
      ).toBe("error");
      expect(pageReads).toBeGreaterThan(1);
      expect(pin.getAttribute("aria-pressed")).toBe("true");
      expect(
        queryClient.getQueryData<ListTasksResponse>(
          cloudEpicTasksQueryKey(
            POOL_HOST_ID,
            USER_ID,
            LIST_CLOUD_TASKS_REQUEST,
          ),
        )?.tasks[0]?.pinned,
      ).toBe(true);
      expect(
        toast
          .getToasts()
          .slice(noticesBefore)
          .filter(
            (notice) => "title" in notice && notice.title === LOST_DELETE_REPLY,
          ),
      ).toHaveLength(1);
    });
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.setPinned")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          params: setEpicPinnedRequestSchema.parse(call.params),
        })),
    ).toEqual([
      {
        hostId: POOL_HOST_ID,
        params: { epicId: "pool-pin-lost-reply-row", pinned: true },
      },
    ]);
  });

  it("routes Recent activity from a pool page to a personal computer without a list method", async () => {
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
        "epic.listTasks": (): ListTasksResponse =>
          settledPoolHistoryPage([], false, undefined),
        "epic.localHistory.read": () => emptyLocalHistory,
        "worktree.listAllForHost": () => computerWorktreePageAt17([]),
        "epic.getTaskContexts": ({ taskIds }): GetTaskContextsResponse => {
          const scenarios = taskIds.map((taskId): TaskContextScenarioAt14 => {
            if (taskId !== id) return { kind: "indeterminate", taskId };
            if (deleted) return { kind: "confirmed-absent", taskId };
            return {
              kind: "cloud-found",
              taskId,
              title: taskId,
              grant: directOwnerPermission(),
              recentAt: 10,
              pinned: false,
            };
          });
          return taskContextsAt14(taskIds, scenarios);
        },
        "epic.setPinned": ({ pinned }) =>
          computerPinAcknowledgementAt11(pinned, "cloud"),
        "epic.batchDelete": ({ ids }) => {
          deleted = ids.includes(id);
          return computerDeleteOutcomes(ids, []);
        },
      },
    });
    const binding = await makeBinding(queryClient, messenger, null, undefined);
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    recordNegotiatedHostManifest(PERSONAL_HOST_ID, {
      "epic.getTaskContexts": { major: 1, minor: 4 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.setPinned": { major: 1, minor: 1 },
      "epic.batchDelete": { major: 1, minor: 1 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
    });
    await mountServingPeer(
      { kind: "computer", hostId: PERSONAL_HOST_ID },
      [],
      null,
    );
    renderHistoryPanel(queryClient, binding);
    await waitFor(() => {
      expect(
        messenger.calls.find((call) => call.method === "epic.listTasks")
          ?.authority.endpoint.hostId,
      ).toBe(POOL_HOST_ID);
    });
    act(() => observeOwnHistoryRecordChange(USER_ID, id, Date.now()));
    const pin = await screen.findByTestId("epics-list-row-pin");
    expect(screen.getByText(id)).toBeTruthy();
    expect(
      messenger.calls.find((call) => call.method === "epic.getTaskContexts"),
    ).toMatchObject({
      authority: { endpoint: { hostId: PERSONAL_HOST_ID } },
      params: { taskIds: [id] },
    });
    fireEvent.click(pin);
    await waitFor(() => {
      expect(
        messenger.calls.find((call) => call.method === "epic.setPinned"),
      ).toMatchObject({
        authority: { endpoint: { hostId: PERSONAL_HOST_ID } },
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
        authority: { endpoint: { hostId: PERSONAL_HOST_ID } },
        params: { ids: [id] },
      });
    });
  });

  it.each([
    { order: "pool page before local context", contextFirst: false },
    { order: "local context before pool page", contextFirst: true },
  ])(
    "keeps affirmative Recent home evidence when the pool page catches up ($order)",
    async ({ contextFirst }) => {
      const id = `recent-home-catchup-${contextFirst ? "context" : "page"}`;
      const activityAt = Date.now();
      const poolCatchup = deferred<ListTasksResponse>();
      const poolCatchupStarted = deferred<void>();
      const localContext = deferred<GetTaskContextsResponse>();
      const localContextStarted = deferred<void>();
      let catchupEnabled = false;
      let localContextTaskIds: ReadonlyArray<string> = [];
      const resolvedLocalContext = (): GetTaskContextsResponse =>
        taskContextsAt14(
          localContextTaskIds,
          localContextTaskIds.map((taskId) =>
            taskId === id
              ? {
                  kind: "local-home-found" as const,
                  taskId,
                  title: id,
                  userId: USER_ID,
                  recentAt: activityAt,
                  pinned: false,
                }
              : { kind: "indeterminate" as const, taskId },
          ),
        );
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      const messenger = new MockHostMessenger({
        registry: hostRpcRegistry,
        requestId: () => `history-recent-home-catchup-${id}`,
        handlers: {
          "epic.listTasks": ():
            | ListTasksResponse
            | Promise<ListTasksResponse> => {
            if (!catchupEnabled)
              return settledPoolHistoryPage([], false, undefined);
            poolCatchupStarted.resolve();
            return poolCatchup.promise;
          },
          "epic.localHistory.read": () => emptyLocalHistory,
          "epic.getTaskContexts": ({
            taskIds,
          }): Promise<GetTaskContextsResponse> => {
            if (taskIds.includes(id)) {
              localContextTaskIds = taskIds;
              localContextStarted.resolve();
              return localContext.promise;
            }
            return Promise.resolve(
              taskContextsAt14(
                taskIds,
                taskIds.map((taskId) => ({ kind: "indeterminate", taskId })),
              ),
            );
          },
          "epic.setPinned": ({ pinned }) =>
            computerPinAcknowledgementAt11(pinned, "local"),
          "epic.batchDelete": ({ ids }) => computerLocalDeleteSuccess(ids),
          "worktree.listAllForHost": () => computerWorktreePageAt17([]),
        },
      });
      const binding = await makeBinding(
        queryClient,
        messenger,
        null,
        undefined,
      );
      recordNegotiatedHostManifest(POOL_HOST_ID, {
        "epic.listTasks": { major: 1, minor: 7 },
      });
      recordNegotiatedHostManifest(PERSONAL_HOST_ID, {
        "epic.getTaskContexts": { major: 1, minor: 4 },
        "epic.localHistory.read": { major: 1, minor: 0 },
        "epic.setPinned": { major: 1, minor: 1 },
        "epic.batchDelete": { major: 1, minor: 1 },
        "worktree.listAllForHost": { major: 1, minor: 7 },
      });
      await mountServingPeer(
        { kind: "computer", hostId: PERSONAL_HOST_ID },
        [],
        null,
      );
      renderHistoryPanel(queryClient, binding);

      const pageQueryKey = cloudEpicTasksQueryKey(
        POOL_HOST_ID,
        USER_ID,
        LIST_CLOUD_TASKS_REQUEST,
      );
      await waitFor(() => {
        expect(queryClient.getQueryState(pageQueryKey)?.status).toBe("success");
      });
      expect(
        messenger.calls.find((call) => call.method === "epic.listTasks")
          ?.authority.endpoint.hostId,
      ).toBe(POOL_HOST_ID);

      act(() => observeOwnHistoryRecordChange(USER_ID, id, activityAt));
      await localContextStarted.promise;
      if (contextFirst) {
        localContext.resolve(resolvedLocalContext());
        await screen.findByText(id);
      }

      catchupEnabled = true;
      await act(async () => {
        const refetch = queryClient.refetchQueries({ queryKey: pageQueryKey });
        await poolCatchupStarted.promise;
        poolCatchup.resolve(
          settledPoolHistoryPage(
            [
              poolListedTaskAt17({
                id,
                title: id,
                grant: directHistoryGrant("owner", USER_ID),
                pinned: false,
                recentAt: activityAt,
                updatedAt: activityAt,
              }),
            ],
            false,
            undefined,
          ),
        );
        await refetch;
      });
      if (!contextFirst) {
        localContext.resolve(resolvedLocalContext());
      }

      await waitFor(() => {
        expect(
          queryClient.getQueryData<ListTasksResponse>(pageQueryKey),
        ).toMatchObject({
          tasks: [{ epic: { light: { id } }, recentAt: activityAt }],
        });
      });
      await screen.findByText(id);
      const pin = await screen.findByRole("button", {
        name: `Pin ${id} to top`,
      });
      fireEvent.click(pin);
      await waitFor(() => {
        expect(
          messenger.calls.find((call) => call.method === "epic.setPinned"),
        ).toMatchObject({
          authority: { endpoint: { hostId: PERSONAL_HOST_ID } },
          params: { epicId: id, pinned: true },
        });
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Select history items" }),
      );
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
      fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
      await screen.findByText(`Delete "${id}"?`);
      await waitForDeleteConfirmationReady();
      fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
      await waitFor(() => {
        expect(
          messenger.calls.find((call) => call.method === "epic.batchDelete"),
        ).toMatchObject({
          authority: { endpoint: { hostId: PERSONAL_HOST_ID } },
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
      const binding = await makeBinding(
        queryClient,
        messenger,
        TEAM_HOST_ID,
        undefined,
      );
      recordNegotiatedHostManifest(TEAM_HOST_ID, {
        "epic.listTasks": { major: 1, minor: 6 },
        "epic.localHistory.read": { major: 1, minor: 0 },
        "epic.batchDelete": { major: 1, minor: 1 },
        "worktree.listAllForHost": { major: 1, minor: 7 },
      });
      recordNegotiatedHostManifest(POOL_HOST_ID, {
        "epic.listTasks": { major: 1, minor: 9 },
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
            ids: ["personal-cloud-row", "team-shared-cloud-row"],
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

  it("records a missing computer target as a definite failure beside the pool success", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let remoteHosts: ReadonlyArray<HostDirectoryEntry> = [
      teamHost,
      personalHost,
    ];
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-mixed-missing-computer-target",
      handlers: {
        "epic.listTasks": (): ListTasksResponse =>
          settledPoolHistoryPage(
            [
              serverHistoryTaskLight(
                "pool-delete-after-computer-loss",
                null,
                directOwnerPermission(),
              ),
            ],
            false,
            undefined,
          ),
        "epic.localHistory.read": () =>
          completeLocalHistoryRead(
            [localHistoryTaskLight("computer-delete-after-target-loss", 10)],
            [],
            [],
          ),
        "worktree.listAllForHost": () => computerWorktreePageAt17([]),
        "epic.batchDelete": ({ ids }) => {
          expect(ids).toEqual(["pool-delete-after-computer-loss"]);
          return poolDeleteSuccess(ids);
        },
      },
    });
    const binding = await makeBinding(
      queryClient,
      messenger,
      null,
      () => remoteHosts,
    );
    recordNegotiatedHostManifest(PERSONAL_HOST_ID, {
      "epic.localHistory.read": { major: 1, minor: 0 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    await mountServingPeer(
      { kind: "computer", hostId: PERSONAL_HOST_ID },
      [],
      null,
    );
    const warning = vi.spyOn(toast, "warning");
    renderHistoryPanel(queryClient, binding);
    await waitFor(() =>
      expect(screen.getAllByTestId("epics-list-row-card")).toHaveLength(2),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    for (const id of [
      "pool-delete-after-computer-loss",
      "computer-delete-after-target-loss",
    ])
      fireEvent.click(screen.getByRole("checkbox", { name: `Select ${id}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText("Delete 2 tasks?")).toBeTruthy();
    await waitForDeleteConfirmationReady();
    act(() => onlineManager.setOnline(false));
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() =>
      expect(findBatchDeleteMutation(queryClient)?.state.isPaused).toBe(true),
    );
    expect(
      findBatchDeleteMutation(
        queryClient,
      )?.state.variables?.history?.acceptedRows.get(
        "computer-delete-after-target-loss",
      ),
    ).toEqual({ home: "local", listedByPeerId: PERSONAL_HOST_ID });
    remoteHosts = [teamHost];
    await binding.directory.refresh();
    expect(binding.directory.findById(PERSONAL_HOST_ID)).toBeNull();
    act(() => onlineManager.setOnline(true));

    await waitFor(() => {
      expect(findBatchDeleteMutation(queryClient)?.state.status).toBe(
        "success",
      );
      expect(warning).toHaveBeenCalledWith("Deleted 1 of 2; 1 failed.", {
        description: OWNER_HOST_UNREACHABLE_NOTICE,
      });
    });
    expect(findBatchDeleteMutation(queryClient)?.state.data).toEqual({
      results: [
        {
          taskId: "pool-delete-after-computer-loss",
          success: true,
          home: "cloud",
        },
        {
          taskId: "computer-delete-after-target-loss",
          success: false,
          errorMessage: OWNER_HOST_UNREACHABLE_NOTICE,
        },
      ],
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
        ids: ["pool-delete-after-computer-loss"],
      },
    ]);
  });

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
        "epic.listTasks": (): ListTasksResponse =>
          settledPoolHistoryPage(
            [serverHistoryTaskLight(poolTaskId, null, directOwnerPermission())],
            false,
            undefined,
          ),
        "epic.localHistory.read": (): LocalHistoryReadResponse =>
          completeLocalHistoryRead(
            computerTaskPresent
              ? [localHistoryTaskLight(computerTaskId, 10)]
              : [],
            [],
            [],
          ),
        "worktree.listAllForHost": () => computerWorktreePageAt17([]),
        "epic.batchDelete": ({ ids }) => {
          if (ids.includes(poolTaskId)) {
            throw receivedUnsupportedMethodError(requestId, "epic.batchDelete");
          }
          expect(ids).toEqual([computerTaskId]);
          computerTaskPresent = false;
          return computerLocalDeleteSuccess(ids);
        },
      },
    });
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
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
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.batchDelete": { major: 1, minor: 1 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
    });
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 9 },
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
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
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

  it("routes a pool-listed local-home row's pin and delete through its serving computer", async () => {
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
        "epic.listTasks": (): ListTasksResponse =>
          settledPoolHistoryPage(
            [
              serverHistoryTaskLight(
                "pool-listed-local-home",
                null,
                directOwnerPermission(),
              ),
            ],
            false,
            undefined,
          ),
        "epic.localHistory.read": () => emptyLocalHistory,
        "worktree.listAllForHost": () =>
          computerWorktreePageAt17([
            computerWorktreeEntryAt16(
              "pool-listed-local-home",
              CONTEXT_HISTORY_BRANCH,
            ),
          ]),
        "epic.getTaskContexts": ({ taskIds }): GetTaskContextsResponse => {
          expect(taskIds).toContain("pool-listed-local-home");
          localHomeReplies.push(["pool-listed-local-home"]);
          return taskContextsAt14(
            taskIds,
            taskIds.map((taskId) =>
              taskId === "pool-listed-local-home"
                ? {
                    kind: "local-home-found" as const,
                    taskId,
                    title: taskId,
                    userId: USER_ID,
                    recentAt: 10,
                    pinned: false,
                  }
                : { kind: "indeterminate" as const, taskId },
            ),
          );
        },
        "epic.setPinned": ({ pinned }) =>
          computerPinAcknowledgementAt11(pinned, "local"),
        "epic.batchDelete": ({ ids }) => computerLocalDeleteSuccess(ids),
      },
    });
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
    recordNegotiatedHostManifest(TEAM_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.getTaskContexts": { major: 1, minor: 4 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
      "epic.setPinned": { major: 1, minor: 1 },
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
    const pin = await screen.findByTestId("epics-list-row-pin");
    expect(pin.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(pin);
    await waitFor(() => {
      expect(
        messenger.calls.find((call) => call.method === "epic.setPinned"),
      ).toMatchObject({
        authority: { endpoint: { hostId: TEAM_HOST_ID } },
        params: { epicId: "pool-listed-local-home", pinned: true },
      });
    });
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
    act(() => onlineManager.setOnline(false));
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() => {
      expect(findBatchDeleteMutation(queryClient)?.state.isPaused).toBe(true);
      expect(
        findBatchDeleteMutation(
          queryClient,
        )?.state.variables?.history?.acceptedRows.get("pool-listed-local-home"),
      ).toEqual({ home: "local", listedByPeerId: POOL_HOST_ID });
    });
    expect(
      messenger.calls.filter(
        (call) => call.method === "epic.localHistory.read",
      ),
    ).not.toHaveLength(0);
    expect(
      messenger.calls.filter((call) => call.method === "epic.batchDelete"),
    ).toEqual([]);
    act(() => onlineManager.setOnline(true));

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
    ).toEqual([{ hostId: TEAM_HOST_ID, ids: ["pool-listed-local-home"] }]);
    expect(findBatchDeleteMutation(queryClient)?.state.data).toEqual({
      results: [
        { taskId: "pool-listed-local-home", success: true, home: "local" },
      ],
    });
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
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
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
        )?.state.variables?.history?.acceptedRows.get(CONTEXT_CLOUD_ROW_ID),
      ).toEqual({
        home: undefined,
        listedByPeerId: TEAM_HOST_ID,
      });
      expect(
        findBatchDeleteMutation(
          queryClient,
        )?.state.variables?.history?.acceptedRows.get(CONTEXT_LOCAL_ROW_ID),
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

  it("uses the pool-listed row's local home when confirmation follows a refreshed contribution", async () => {
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
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
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
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select ${CONTEXT_CLOUD_ROW_ID}` }),
    );
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(
      await screen.findByText(`Delete "${CONTEXT_CLOUD_ROW_ID}"?`),
    ).toBeTruthy();
    await waitForDeleteConfirmationReady();
    contextState.cloudRowIsLocalHome = true;
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: hostQueryKeys.methodScope(
          TEAM_HOST_ID,
          "epic.getTaskContexts",
        ),
      });
    });
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.getTaskContexts")
        .some(
          (call) =>
            call.authority.endpoint.hostId === TEAM_HOST_ID &&
            (
              call.params as { readonly taskIds: ReadonlyArray<string> }
            ).taskIds.includes(CONTEXT_CLOUD_ROW_ID),
        ),
    ).toBe(true);
    const poolPage = queryClient.getQueryData<ListTasksResponse>(
      cloudEpicTasksQueryKey(POOL_HOST_ID, USER_ID, LIST_CLOUD_TASKS_REQUEST),
    );
    expect(
      poolPage?.tasks.find(
        (row) => row.epic?.light?.id === CONTEXT_CLOUD_ROW_ID,
      ),
    ).not.toHaveProperty("home");
    expect(
      screen.getByRole("heading", {
        name: `Delete "${CONTEXT_CLOUD_ROW_ID}"?`,
      }),
    ).toBeTruthy();
    await waitForDeleteConfirmationReady();

    const scopeMatches = vi.spyOn(rowPeer, "historyActionScopeMatches");
    scopeMatches.mockClear();
    act(() => onlineManager.setOnline(false));
    await waitForDeleteConfirmationReady();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    expect(scopeMatches).toHaveReturnedWith(true);
    await waitFor(() => {
      const mutation = findBatchDeleteMutation(queryClient);
      expect(mutation?.state.isPaused).toBe(true);
      expect(
        mutation?.state.variables?.history?.acceptedRows.get(
          CONTEXT_CLOUD_ROW_ID,
        ),
      ).toEqual({ home: "local", listedByPeerId: POOL_HOST_ID });
      expect(
        mutation?.state.variables?.isLocalHomedNow(CONTEXT_CLOUD_ROW_ID),
      ).toBe(true);
    });
    expect(binding.hostClient.getRequestContextUserId()).toBe(USER_ID);
    expect(authority.snapshot().servingPeer).toEqual({
      kind: "computer",
      hostId: TEAM_HOST_ID,
    });
    expect(
      findBatchDeleteMutation(queryClient)?.state.variables?.isLocalHomedNow(
        CONTEXT_CLOUD_ROW_ID,
      ),
    ).toBe(true);
    act(() => onlineManager.setOnline(true));
    await waitFor(() => {
      const mutation = findBatchDeleteMutation(queryClient);
      expect(mutation?.state).toMatchObject({ status: "success", error: null });
      expect(mutation?.state.data).toEqual({
        results: [
          { taskId: CONTEXT_CLOUD_ROW_ID, success: true, home: "local" },
        ],
      });
    });
    expect(
      messenger.calls.filter((call) => call.method === "epic.batchDelete"),
    ).toHaveLength(1);
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        })),
    ).toEqual([{ hostId: TEAM_HOST_ID, ids: [CONTEXT_CLOUD_ROW_ID] }]);
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
        "epic.listTasks": (): ListTasksResponse =>
          settledPoolHistoryPage(
            [
              serverHistoryTaskLight(
                "racing-cloud-row",
                null,
                directOwnerPermission(),
              ),
            ],
            false,
            undefined,
          ),
        "epic.localHistory.read": (): LocalHistoryReadResponse =>
          completeLocalHistoryRead(
            [localHistoryTaskLight("racing-local-row", 10)],
            [],
            [],
          ),
        "worktree.listAllForHost": () => computerWorktreePageAt17([]),
        "epic.batchDelete": () => {
          throw new Error("unexpected delete after the authority changed");
        },
      },
    });
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
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
        "epic.listTasks": (): ListTasksResponse =>
          settledPoolHistoryPage(
            [
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
            false,
            undefined,
          ),
        "epic.localHistory.read": () => emptyLocalHistory,
        "epic.batchDelete": () =>
          poolDeleteOutcomes(
            ["pool-refused-row", "pool-success-row"],
            ["pool-refused-row"],
          ),
      },
    });
    const binding = await makeBinding(queryClient, messenger, null, undefined);
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

  it("keeps a pool-only delete unknown after a plain RPC_ERROR and refreshes History", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let pageReads = 0;
    const requestId = "history-pool-delete-rpc-error";
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => requestId,
      handlers: {
        "epic.listTasks": (): ListTasksResponse => {
          pageReads++;
          return settledPoolHistoryPage(
            [
              serverHistoryTaskLight(
                "pool-delete-rpc-error-row",
                null,
                directOwnerPermission(),
              ),
            ],
            false,
            undefined,
          );
        },
        "epic.localHistory.read": () => emptyLocalHistory,
        "epic.batchDelete": () => {
          throw new HostRpcError({
            code: "RPC_ERROR",
            requestId,
            method: "epic.batchDelete",
            message: "epic.batchDelete is unavailable right now",
            fatalDetails: null,
          });
        },
      },
    });
    const binding = await makeBinding(queryClient, messenger, null, undefined);
    recordNegotiatedHostManifest(POOL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.batchDelete": { major: 1, minor: 1 },
    });
    await mountServingPeer({ kind: "pool" }, [], null);
    const noticesBefore = toast.getToasts().length;
    renderHistoryPanel(queryClient, binding);
    await screen.findByText("pool-delete-rpc-error-row");
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select pool-delete-rpc-error-row",
      }),
    );
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(
      await screen.findByText('Delete "pool-delete-rpc-error-row"?'),
    ).toBeTruthy();
    await waitForDeleteConfirmationReady();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));

    await waitFor(() => {
      expect(findBatchDeleteMutation(queryClient)?.state.status).toBe("error");
      expect(pageReads).toBeGreaterThan(1);
      expect(
        screen.getByRole("checkbox", {
          name: "Select pool-delete-rpc-error-row",
        }),
      ).toBeTruthy();
      expect(
        toast
          .getToasts()
          .slice(noticesBefore)
          .filter(
            (notice) => "title" in notice && notice.title === LOST_DELETE_REPLY,
          ),
      ).toHaveLength(1);
    });
    expect(findBatchDeleteMutation(queryClient)?.state.data).toBeUndefined();
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          params: call.params,
        })),
    ).toEqual([
      {
        hostId: POOL_HOST_ID,
        params: { ids: ["pool-delete-rpc-error-row"] },
      },
    ]);
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
        "epic.listTasks": (): ListTasksResponse =>
          computerPageWithLocalRowsAt16(
            [
              serverHistoryTaskLight(
                "personal-page-cloud-row",
                null,
                directOwnerPermission(),
              ),
            ],
            [localHistoryTaskLight("personal-local-row", 10)],
            { hasMore: false, nextCursor: undefined },
            USER_ID,
          ),
        "epic.localHistory.read": (): LocalHistoryReadResponse =>
          completeLocalHistoryRead(
            [localHistoryTaskLight("personal-local-row", 10)],
            [],
            [],
          ),
        "worktree.listAllForHost": () => computerWorktreePageAt17([]),
        "epic.batchDelete": ({ ids: requestedIds }) =>
          computerDeleteOutcomes(requestedIds, ["personal-local-row"]),
      },
    });
    const binding = await makeBinding(queryClient, messenger, null, undefined);
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

  it("routes Recent activity from a personal computer while it serves its own page", async () => {
    const recentId = "personal-own-page-recent-row";
    const contextRecentAt = 10;
    const activityAt = Date.now();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-personal-own-page-recent",
      handlers: {
        "epic.listTasks": (): ListTasksResponse =>
          settledComputerCloudPageAt16(
            [],
            { hasMore: false, nextCursor: undefined },
            USER_ID,
          ),
        "epic.localHistory.read": () => emptyLocalHistory,
        "epic.getTaskContexts": ({ taskIds }): GetTaskContextsResponse =>
          taskContextsAt14(
            taskIds,
            taskIds.map((taskId) => ({
              kind: "cloud-found" as const,
              taskId,
              title: taskId,
              grant: directOwnerPermission(),
              recentAt: contextRecentAt,
              pinned: false,
            })),
          ),
        "epic.setPinned": ({ pinned }) =>
          computerPinAcknowledgementAt11(pinned, "cloud"),
        "epic.batchDelete": ({ ids }) => computerCloudDeleteSuccess(ids),
        "worktree.listAllForHost": () => computerWorktreePageAt17([]),
      },
    });
    const binding = await makeBinding(queryClient, messenger, null, undefined);
    recordNegotiatedHostManifest(PERSONAL_HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
      "epic.localHistory.read": { major: 1, minor: 0 },
      "epic.getTaskContexts": { major: 1, minor: 4 },
      "epic.setPinned": { major: 1, minor: 1 },
      "epic.batchDelete": { major: 1, minor: 1 },
      "worktree.listAllForHost": { major: 1, minor: 7 },
    });
    await mountServingPeer(
      { kind: "computer", hostId: PERSONAL_HOST_ID },
      [],
      null,
    );
    renderHistoryPanel(queryClient, binding);
    const pageQueryKey = cloudEpicTasksQueryKey(
      PERSONAL_HOST_ID,
      USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    );
    await waitFor(() => {
      expect(
        messenger.calls.find((call) => call.method === "epic.listTasks")
          ?.authority.endpoint.hostId,
      ).toBe(PERSONAL_HOST_ID);
      const pageQueryState = queryClient.getQueryState(pageQueryKey);
      expect(pageQueryState?.error).toBeNull();
      expect(pageQueryState?.status).toBe("success");
    });

    expect(
      queryClient.getQueryData<ListTasksResponse>(pageQueryKey),
    ).toMatchObject({
      tasks: [],
      hasMore: false,
      completeness: {
        cloudPage: "settled",
        facets: "server",
        localRows: "none",
        sort: "server",
      },
    });

    act(() => observeOwnHistoryRecordChange(USER_ID, recentId, activityAt));
    const contextCall = await waitFor(() => {
      const call = messenger.calls.find(
        (call) =>
          call.method === "epic.getTaskContexts" &&
          (
            call.params as { readonly taskIds: ReadonlyArray<string> }
          ).taskIds.includes(recentId),
      );
      if (call === undefined)
        throw new Error("History context request missing");
      expect(call.authority.endpoint.hostId).toBe(PERSONAL_HOST_ID);
      const { taskIds } = call.params as {
        readonly taskIds: ReadonlyArray<string>;
      };
      const queryKey = hostQueryKeys.epicTaskContexts(
        PERSONAL_HOST_ID,
        USER_ID,
        taskIds,
      );
      const contextQueryState = queryClient.getQueryState(queryKey);
      expect(contextQueryState?.error).toBeNull();
      expect(contextQueryState?.status).toBe("success");
      return call;
    });
    const { taskIds } = contextCall.params as {
      readonly taskIds: ReadonlyArray<string>;
    };
    const contextQueryKey = hostQueryKeys.epicTaskContexts(
      PERSONAL_HOST_ID,
      USER_ID,
      taskIds,
    );
    expect(
      queryClient.getQueryData<GetTaskContextsResponse>(contextQueryKey),
    ).toMatchObject({
      tasks: {
        [recentId]: {
          status: "found",
          task: { epic: { light: { id: recentId, title: recentId } } },
        },
      },
      recentAtByTaskId: { [recentId]: contextRecentAt },
    });

    await screen.findByText(recentId);
    const pin = await screen.findByRole("button", {
      name: `Pin ${recentId} to top`,
    });
    fireEvent.click(pin);
    await waitFor(() => {
      expect(
        messenger.calls.find((call) => call.method === "epic.setPinned"),
      ).toMatchObject({
        authority: { endpoint: { hostId: PERSONAL_HOST_ID } },
        params: { epicId: recentId, pinned: true },
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select ${recentId}` }),
    );
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    await screen.findByText(`Delete "${recentId}"?`);
    await waitForDeleteConfirmationReady();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() => {
      expect(
        messenger.calls.find((call) => call.method === "epic.batchDelete"),
      ).toMatchObject({
        authority: { endpoint: { hostId: PERSONAL_HOST_ID } },
        params: { ids: [recentId] },
      });
    });
  });

  it("keeps the accepted computer worktree cleanup after its selected row leaves the page", async () => {
    const taskId = "personal-computer-row-leaves-page";
    const worktreePath = `/tmp/history-${taskId}`;
    const branch = "history-task-branch";
    const beforePage = [
      serverHistoryTaskLight(taskId, null, directOwnerPermission()),
      ...Array.from({ length: 19 }, (_, index) =>
        serverHistoryTaskLight(
          `page-before-${index}`,
          null,
          directOwnerPermission(),
        ),
      ),
    ];
    const afterPage = Array.from({ length: 20 }, (_, index) =>
      serverHistoryTaskLight(
        `page-after-${index}`,
        null,
        directOwnerPermission(),
      ),
    );
    let showSelectedTask = true;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const messenger = new MockHostMessenger({
      registry: hostRpcRegistry,
      requestId: () => "history-row-leaves-page-worktree-cleanup",
      handlers: {
        "epic.listTasks": (): ListTasksResponse =>
          settledComputerCloudPageAt16(
            showSelectedTask ? beforePage : afterPage,
            { hasMore: false, nextCursor: undefined },
            USER_ID,
          ),
        "epic.localHistory.read": () => emptyLocalHistory,
        "worktree.listAllForHost": () =>
          computerWorktreePageAt17([computerWorktreeEntryAt16(taskId, branch)]),
        "epic.batchDelete": ({ ids }) => computerCloudDeleteSuccess(ids),
      },
    });
    const binding = await makeBinding(queryClient, messenger, null, undefined);
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
    const pageQueryKey = cloudEpicTasksQueryKey(
      PERSONAL_HOST_ID,
      USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    );
    await screen.findByText(taskId);
    fireEvent.click(
      screen.getByRole("button", { name: "Select history items" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${taskId}` }));
    fireEvent.click(screen.getByTestId("epics-list-delete-selected"));
    expect(await screen.findByText(`Delete "${taskId}"?`)).toBeTruthy();
    const worktreeCheckbox = await screen.findByRole("checkbox", {
      name: `Remove worktree ${branch}`,
    });
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) =>
            call.method === "worktree.listAllForHost" &&
            call.authority.endpoint.hostId === PERSONAL_HOST_ID,
        ),
      ).toBe(true),
    );
    expect(worktreeCheckbox.getAttribute("data-state")).not.toBe("checked");

    showSelectedTask = false;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: pageQueryKey, exact: true });
    });
    await screen.findByText("page-after-0");
    expect(
      screen
        .getAllByTestId("epics-list-row-card")
        .some((row) => row.textContent.includes(taskId)),
    ).toBe(false);
    expect(
      screen.getByRole("checkbox", { name: `Remove worktree ${branch}` }),
    ).toBeTruthy();

    fireEvent.click(worktreeCheckbox);
    expect(worktreeCheckbox.getAttribute("data-state")).toBe("checked");
    await waitForDeleteConfirmationReady();
    fireEvent.click(screen.getByTestId("delete-tasks-confirm"));
    await waitFor(() =>
      expect(findBatchDeleteMutation(queryClient)?.state.status).toBe(
        "success",
      ),
    );
    await waitFor(() =>
      expect(runWorktreeCleanupMock).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          hostId: PERSONAL_HOST_ID,
          paths: [worktreePath],
          source: "task_cleanup",
          stopOwnersPaths: new Set(),
        }),
      ),
    );
    expect(
      messenger.calls
        .filter((call) => call.method === "epic.batchDelete")
        .map((call) => ({
          hostId: call.authority.endpoint.hostId,
          ids: (call.params as { readonly ids: ReadonlyArray<string> }).ids,
        })),
    ).toEqual([{ hostId: PERSONAL_HOST_ID, ids: [taskId] }]);
    expect(findBatchDeleteMutation(queryClient)?.state.variables).toMatchObject(
      {
        worktreeCleanup: {
          candidates: [{ worktreePath, ownerEpicIds: [taskId] }],
        },
      },
    );
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
        "epic.listTasks": (): ListTasksResponse =>
          settledPoolHistoryPage(
            [
              serverHistoryTaskLight(
                "accepted-cloud-row",
                null,
                directOwnerPermission(),
              ),
            ],
            false,
            undefined,
          ),
        "epic.localHistory.read": (): LocalHistoryReadResponse =>
          completeLocalHistoryRead(
            [localHistoryTaskLight("accepted-local-row", 10)],
            [],
            [],
          ),
        "worktree.listAllForHost": () => computerWorktreePageAt17([]),
        "epic.batchDelete": ({ ids }) => poolDeleteSuccess(ids),
      },
    });
    const binding = await makeBinding(
      queryClient,
      messenger,
      TEAM_HOST_ID,
      undefined,
    );
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
